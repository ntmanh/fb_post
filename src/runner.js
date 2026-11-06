// Bộ lập lịch: cứ vài giây quét các task đến hạn và chạy, tôn trọng giới hạn theo tài khoản.
import path from 'node:path';
import { db, UPLOAD_DIR, getSettings, log, now } from './db.js';
import * as fb from './fb.js';
import { chooseImages, maxPerTask } from './images.js';
import { pickUnused } from './contents.js';

const running = new Set(); // account ids đang chạy task
const reservedContent = new Set(); // id mẫu nội dung đang được task chạy dở sử dụng
const DAY = 86400000;

// Spintax: {Xin chào|Chào bạn|Hi} → chọn ngẫu nhiên một phương án
export function spin(text) {
  let out = text;
  for (let i = 0; i < 20 && /\{[^{}]*\|[^{}]*\}/.test(out); i++) {
    out = out.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, g) => {
      const opts = g.split('|');
      return opts[Math.floor(Math.random() * opts.length)];
    });
  }
  return out;
}

const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function status() {
  const s = getSettings();
  const accounts = db.prepare("SELECT id FROM accounts WHERE status = 'ok'").all();
  return {
    enabled: s.runner_enabled === '1',
    runningAccounts: [...running],
    readyAccounts: accounts.filter(a => !running.has(a.id) && !fb.isBusy(a.id)).length,
    okAccounts: accounts.length,
    totalAccounts: db.prepare('SELECT COUNT(*) n FROM accounts').get().n,
  };
}

export async function tick() {
  const s = getSettings();
  if (s.runner_enabled !== '1') return;
  const maxConcurrent = Math.max(1, +s.max_concurrent || 1);
  if (running.size >= maxConcurrent) return;

  const due = db.prepare(`
    SELECT t.*, a.status AS acc_status, a.last_action_at
    FROM tasks t LEFT JOIN accounts a ON a.id = t.account_id
    WHERE t.status = 'pending' AND t.scheduled_at <= ?
    ORDER BY t.scheduled_at, t.id LIMIT 100`).all(now());

  const countToday = db.prepare("SELECT COUNT(*) n FROM tasks WHERE account_id = ? AND status = 'done' AND finished_at >= ?");
  const fail = db.prepare("UPDATE tasks SET status = 'error', error = ?, finished_at = ? WHERE id = ?");

  for (const t of due) {
    if (running.size >= maxConcurrent) break;
    if (!t.account_id) { fail.run('Task chưa gán tài khoản', now(), t.id); continue; }
    if (running.has(t.account_id) || fb.isBusy(t.account_id)) continue;
    if (t.acc_status !== 'ok') { fail.run('Tài khoản chưa đăng nhập / hết phiên', now(), t.id); continue; }
    if (t.last_action_at && now() - t.last_action_at < (+s.min_gap_seconds || 0) * 1000) continue;
    if (countToday.get(t.account_id, startOfDay()).n >= (+s.daily_limit || Infinity)) continue;

    running.add(t.account_id);
    runTask(t, s).finally(() => running.delete(t.account_id));
  }
}

async function runTask(t, s) {
  db.prepare("UPDATE tasks SET status = 'running', attempts = attempts + 1, started_at = ?, error = NULL, shot = NULL WHERE id = ?")
    .run(now(), t.id);
  const opts = { taskId: t.id, accountId: t.account_id };
  const picked = pickContent(t);
  const content = spin(picked.content);
  db.prepare('UPDATE tasks SET used_content = ? WHERE id = ?').run(content, t.id);
  if (picked.name) log(`Chọn mẫu nội dung "${picked.name}"`, opts);
  const imageOpts = JSON.parse(t.image_opts || '{}');
  // mẫu ảnh còn tồn tại → dùng ảnh và số ảnh hiện tại của mẫu, đã bị xoá → dùng bản sao lúc tạo task
  const getImageTemplate = db.prepare('SELECT images, default_max FROM image_templates WHERE id = ?');
  imageOpts.templates = (imageOpts.templates || []).map(tp => {
    const row = getImageTemplate.get(tp.id);
    return row ? { ...tp, max: row.default_max, pool: JSON.parse(row.images) } : tp;
  });
  const chosen = chooseImages(JSON.parse(t.images || '[]'), imageOpts, { per: maxPerTask(t.kind) });
  const images = chosen.map(f => path.join(UPLOAD_DIR, path.basename(f)));
  db.prepare('UPDATE tasks SET used_images = ? WHERE id = ?').run(JSON.stringify(chosen), t.id);
  const ctx = { shot: `task-${t.id}-${now()}`, log: m => log(m, opts) };
  log(`Bắt đầu (lần ${t.attempts + 1})${chosen.length ? ` · dùng ${chosen.length} ảnh: ${chosen.join(', ')}` : ''}`, opts);

  try {
    const result = t.kind === 'comment'
      ? await fb.comment(t.account_id, { url: t.target_url, content, images }, ctx)
      : await fb.createPost(t.account_id, { targetType: t.target_type, url: t.target_url, content, images }, ctx);

    db.prepare("UPDATE tasks SET status = 'done', result = ?, finished_at = ? WHERE id = ?").run(result, now(), t.id);
    log(result, opts);
    if (picked.live) markContentUsed(picked, opts);

    if (t.repeat !== 'none') {
      const step = t.repeat === 'weekly' ? 7 * DAY : DAY;
      let next = t.scheduled_at + step;
      while (next <= now()) next += step;
      db.prepare(`INSERT INTO tasks(batch, kind, account_id, target_type, target_url, target_name, content, content_opts, images, image_opts, scheduled_at, repeat, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(t.batch, t.kind, t.account_id, t.target_type, t.target_url, t.target_name, t.content, t.content_opts, t.images, t.image_opts, next, t.repeat, now());
      log(`Đã tạo lần lặp kế tiếp lúc ${new Date(next).toLocaleString('vi-VN')}`, opts);
    }
  } catch (e) {
    const msg = e.message || String(e);
    log(msg, { ...opts, level: 'error' });
    if (e.code === 'EXPIRED' || e.code === 'CHECKPOINT') {
      db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(e.code === 'EXPIRED' ? 'expired' : 'checkpoint', t.account_id);
    }
    const retryable = !['EXPIRED', 'CHECKPOINT', 'BUSY'].includes(e.code) && t.attempts + 1 < (+s.max_attempts || 1);
    if (retryable) {
      db.prepare("UPDATE tasks SET status = 'pending', error = ?, shot = ?, scheduled_at = ? WHERE id = ?")
        .run(msg, e.shot || null, now() + 5 * 60000, t.id);
      log('Sẽ thử lại sau 5 phút', opts);
    } else {
      db.prepare("UPDATE tasks SET status = 'error', error = ?, shot = ?, finished_at = ? WHERE id = ?")
        .run(msg, e.shot || null, now(), t.id);
    }
  } finally {
    if (picked.live) reservedContent.delete(picked.id);
    db.prepare('UPDATE accounts SET last_action_at = ? WHERE id = ?').run(now(), t.account_id);
  }
}

// Nội dung cho 1 lần chạy. Task "ngẫu nhiên từ mẫu" bốc 1 mẫu chưa dùng trong bộ mẫu còn tồn tại
// (mẫu bị xoá hết thì dùng bản sao lúc tạo task) và giữ chỗ trong bộ nhớ để task chạy song song không bốc trùng.
function pickContent(t) {
  const snap = JSON.parse(t.content_opts || '{}').templates || [];
  if (!snap.length) return { content: t.content };
  const get = db.prepare('SELECT id, name, content, used FROM templates WHERE id = ?');
  const live = snap.map(s => get.get(s.id)).filter(Boolean);
  if (!live.length) return { ...pickUnused(snap), live: false };
  const choice = pickUnused(live, reservedContent);
  reservedContent.add(choice.id);
  return { ...choice, live: true, setIds: live.map(r => r.id) };
}

// Đăng thành công → đánh dấu mẫu đã dùng; cả bộ mẫu của task đã dùng hết → khôi phục về chưa dùng
function markContentUsed(picked, opts) {
  db.prepare('UPDATE templates SET used = 1, use_count = use_count + 1, last_used_at = ? WHERE id = ?').run(now(), picked.id);
  const ph = picked.setIds.map(() => '?').join(',');
  const left = db.prepare(`SELECT COUNT(*) n FROM templates WHERE id IN (${ph}) AND used = 0`).get(...picked.setIds).n;
  if (!left) {
    db.prepare(`UPDATE templates SET used = 0 WHERE id IN (${ph})`).run(...picked.setIds);
    log(`Đã dùng hết ${picked.setIds.length} mẫu nội dung → khôi phục trạng thái chưa dùng`, opts);
  } else {
    log(`Đánh dấu mẫu "${picked.name}" đã dùng (còn ${left} mẫu chưa dùng)`, opts);
  }
}

export function start() {
  // Task đang chạy dở khi server tắt → đưa về hàng chờ
  db.prepare("UPDATE tasks SET status = 'pending' WHERE status = 'running'").run();
  db.prepare("UPDATE accounts SET status = 'new' WHERE status = 'logging_in'").run();
  setInterval(() => tick().catch(e => console.error('[runner]', e)), 5000).unref();
}
