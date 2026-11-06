import express from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, ROOT, UPLOAD_DIR, SHOT_DIR, getSettings, setSettings, log, now } from './db.js';
import * as runner from './runner.js';
import * as fb from './fb.js';
import { MAX_POOL, MAX_TEMPLATE_IMAGES, maxPerTask, rotateSlice } from './images.js';
import { randomContentLabel } from './contents.js';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/shots', express.static(SHOT_DIR));

const wrap = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
};

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, f, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}${path.extname(f.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, f, cb) => cb(null, /^(image|video)\//.test(f.mimetype)),
});

// ---------- Tổng quan ----------

app.get('/api/status', wrap((req, res) => {
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM tasks GROUP BY status').all().map(r => [r.status, r.n]));
  res.json({ runner: runner.status(), counts, settings: getSettings() });
}));

app.post('/api/runner', wrap((req, res) => {
  setSettings({ runner_enabled: req.body.enabled ? '1' : '0' });
  res.json(runner.status());
}));

app.get('/api/settings', wrap((req, res) => res.json(getSettings())));
app.put('/api/settings', wrap((req, res) => res.json(setSettings(req.body || {}))));

// ---------- Tài khoản ----------

app.get('/api/accounts', wrap((req, res) => {
  const rows = db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.account_id = a.id AND t.status = 'done' AND t.finished_at >= ?) AS done_today,
      (SELECT COUNT(*) FROM tasks t WHERE t.account_id = a.id AND t.status IN ('pending','draft')) AS queued
    FROM accounts a ORDER BY a.id`).all(new Date().setHours(0, 0, 0, 0));
  const st = runner.status();
  res.json(rows.map(r => ({ ...r, busy: st.runningAccounts.includes(r.id) || fb.isBusy(r.id) })));
}));

app.post('/api/accounts', wrap((req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) throw new Error('Thiếu tên tài khoản');
  const r = db.prepare('INSERT INTO accounts(name, note, created_at) VALUES (?, ?, ?)').run(name, req.body.note || '', now());
  res.json({ id: Number(r.lastInsertRowid) });
}));

app.put('/api/accounts/:id', wrap((req, res) => {
  db.prepare('UPDATE accounts SET name = COALESCE(?, name), note = COALESCE(?, note) WHERE id = ?')
    .run(req.body.name ?? null, req.body.note ?? null, req.params.id);
  res.json({ ok: true });
}));

app.delete('/api/accounts/:id', wrap((req, res) => {
  db.prepare("DELETE FROM tasks WHERE account_id = ? AND status IN ('pending','draft','paused')").run(req.params.id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

function accountAction(id, fn) {
  const setStatus = db.prepare('UPDATE accounts SET status = ?, fb_uid = COALESCE(?, fb_uid) WHERE id = ?');
  return fn(id)
    .then(uid => { setStatus.run('ok', uid, id); log(`Đăng nhập thành công (uid ${uid})`, { accountId: id }); return uid; })
    .catch(e => {
      const prev = db.prepare('SELECT status, fb_uid FROM accounts WHERE id = ?').get(id);
      const next = e.code === 'CHECKPOINT' ? 'checkpoint'
        : e.code === 'BUSY' ? prev?.status
        : prev?.fb_uid ? 'expired' : 'new';
      setStatus.run(next || 'new', null, id);
      log(e.message, { accountId: id, level: 'error' });
      throw e;
    });
}

// Mở cửa sổ trình duyệt để người dùng tự đăng nhập (chạy nền, client poll trạng thái)
app.post('/api/accounts/:id/login', wrap((req, res) => {
  const id = +req.params.id;
  if (fb.isBusy(id)) throw new Error('Tài khoản đang bận');
  db.prepare("UPDATE accounts SET status = 'logging_in' WHERE id = ?").run(id);
  accountAction(id, fb.interactiveLogin).catch(() => {});
  res.json({ ok: true, message: 'Đã mở trình duyệt, hãy đăng nhập Facebook trong cửa sổ vừa hiện ra' });
}));

app.post('/api/accounts/:id/cookies', wrap(async (req, res) => {
  let raw = req.body.cookies;
  if (typeof raw === 'string') raw = JSON.parse(raw);
  const uid = await accountAction(+req.params.id, id => fb.importCookies(id, raw));
  res.json({ ok: true, uid });
}));

app.post('/api/accounts/:id/check', wrap(async (req, res) => {
  const uid = await accountAction(+req.params.id, fb.checkLogin);
  res.json({ ok: true, uid });
}));

// ---------- Nhóm ----------

app.get('/api/targets', wrap((req, res) => res.json(db.prepare('SELECT * FROM targets ORDER BY name').all())));

app.post('/api/targets', wrap((req, res) => {
  // nhận 1 nhóm {name,url} hoặc nhiều dòng "url | tên"
  const items = req.body.bulk
    ? String(req.body.bulk).split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const [url, name] = l.split('|').map(x => x.trim());
        return { url, name };
      })
    : [{ url: req.body.url, name: req.body.name, note: req.body.note }];
  const ins = db.prepare('INSERT OR IGNORE INTO targets(name, type, url, note, created_at) VALUES (?, ?, ?, ?, ?)');
  let added = 0;
  for (const it of items) {
    const url = normalizeFbUrl(it.url);
    if (!url) continue;
    added += Number(ins.run(it.name || url.replace(/.*\/groups\//, 'Nhóm ').replace(/\/$/, ''), 'group', url, it.note || '', now()).changes);
  }
  res.json({ added });
}));

app.put('/api/targets/:id', wrap((req, res) => {
  db.prepare('UPDATE targets SET name = COALESCE(?, name), url = COALESCE(?, url), note = COALESCE(?, note) WHERE id = ?')
    .run(req.body.name ?? null, req.body.url ? normalizeFbUrl(req.body.url) : null, req.body.note ?? null, req.params.id);
  res.json({ ok: true });
}));

app.delete('/api/targets/:id', wrap((req, res) => {
  db.prepare('DELETE FROM targets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

function normalizeFbUrl(u) {
  u = String(u || '').trim();
  if (!u) return null;
  if (/^\d+$/.test(u)) u = `https://www.facebook.com/groups/${u}`;
  if (!/^https?:\/\//.test(u)) u = `https://${u}`;
  try {
    const url = new URL(u);
    if (!/(^|\.)facebook\.com$|(^|\.)fb\.com$/.test(url.hostname)) return null;
    url.hostname = 'www.facebook.com';
    return url.toString();
  } catch { return null; }
}

// ---------- Mẫu nội dung ----------

app.get('/api/templates', wrap((req, res) => res.json(db.prepare('SELECT * FROM templates ORDER BY id DESC').all())));
app.post('/api/templates', wrap((req, res) => {
  if (!req.body.name || !req.body.content) throw new Error('Thiếu tên hoặc nội dung');
  const r = db.prepare('INSERT INTO templates(name, kind, content, created_at) VALUES (?, ?, ?, ?)')
    .run(req.body.name, req.body.kind || 'post', req.body.content, now());
  res.json({ id: Number(r.lastInsertRowid) });
}));
// Đưa mẫu về trạng thái chưa dùng (ids rỗng = tất cả)
app.post('/api/templates/reset-usage', wrap((req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(Boolean);
  const r = ids.length
    ? db.prepare(`UPDATE templates SET used = 0 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
    : db.prepare('UPDATE templates SET used = 0').run();
  res.json({ changed: Number(r.changes) });
}));

app.delete('/api/templates/:id', wrap((req, res) => {
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------- Mẫu ảnh ----------

function templateBody(b) {
  const images = Array.isArray(b.images) ? [...new Set(b.images.map(f => path.basename(String(f))))] : undefined;
  if (images && images.length > MAX_TEMPLATE_IMAGES) throw new Error(`Mỗi mẫu tối đa ${MAX_TEMPLATE_IMAGES} ảnh`);
  const max = b.default_max === undefined ? undefined : Math.max(1, Math.min(10, Math.floor(Number(b.default_max)) || 1));
  return { name: b.name === undefined ? undefined : String(b.name).trim(), images, max };
}

app.get('/api/image-templates', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM image_templates ORDER BY name').all().map(t => ({ ...t, images: JSON.parse(t.images) })));
}));

app.post('/api/image-templates', wrap((req, res) => {
  const t = templateBody(req.body || {});
  if (!t.name) throw new Error('Thiếu tên mẫu ảnh');
  const r = db.prepare('INSERT INTO image_templates(name, images, default_max, created_at) VALUES (?, ?, ?, ?)')
    .run(t.name, JSON.stringify(t.images || []), t.max ?? 3, now());
  res.json({ id: Number(r.lastInsertRowid) });
}));

app.put('/api/image-templates/:id', wrap((req, res) => {
  const t = templateBody(req.body || {});
  if (t.name === '') throw new Error('Thiếu tên mẫu ảnh');
  const r = db.prepare('UPDATE image_templates SET name = COALESCE(?, name), images = COALESCE(?, images), default_max = COALESCE(?, default_max) WHERE id = ?')
    .run(t.name ?? null, t.images ? JSON.stringify(t.images) : null, t.max ?? null, req.params.id);
  if (!r.changes) throw new Error('Không tìm thấy mẫu ảnh');
  res.json({ ok: true });
}));

app.delete('/api/image-templates/:id', wrap((req, res) => {
  db.prepare('DELETE FROM image_templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------- Upload ----------

app.post('/api/upload', upload.array('files', MAX_POOL), wrap((req, res) => {
  res.json({ files: (req.files || []).map(f => f.filename) });
}));

// ---------- Task ----------

const TASK_SELECT = `SELECT t.*, a.name AS account_name FROM tasks t LEFT JOIN accounts a ON a.id = t.account_id`;

app.get('/api/tasks', wrap((req, res) => {
  const where = [], args = [];
  if (req.query.status) { where.push('t.status = ?'); args.push(req.query.status); }
  if (req.query.kind) { where.push('t.kind = ?'); args.push(req.query.kind); }
  if (req.query.account) { where.push('t.account_id = ?'); args.push(+req.query.account); }
  if (req.query.q) {
    where.push('(t.content LIKE ? OR t.target_name LIKE ? OR t.target_url LIKE ? OR a.name LIKE ?)');
    const q = `%${req.query.q}%`;
    args.push(q, q, q, q);
  }
  if (req.query.from) { where.push('t.scheduled_at >= ?'); args.push(+req.query.from); }
  if (req.query.to) { where.push('t.scheduled_at < ?'); args.push(+req.query.to); }
  const order = { new: 't.id DESC', old: 't.id ASC', schedule: 't.scheduled_at ASC' }[req.query.sort] || 't.id DESC';
  const limit = Math.min(+req.query.limit || 500, 2000);
  const sql = `${TASK_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ${limit}`;
  res.json(db.prepare(sql).all(...args));
}));

app.get('/api/tasks/:id', wrap((req, res) => {
  const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(req.params.id);
  if (!task) throw new Error('Không tìm thấy task');
  const logs = db.prepare('SELECT * FROM logs WHERE task_id = ? ORDER BY id DESC LIMIT 100').all(req.params.id);
  res.json({ ...task, logs });
}));

app.put('/api/tasks/:id', wrap((req, res) => {
  const t = db.prepare('SELECT status FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) throw new Error('Không tìm thấy task');
  if (t.status === 'running') throw new Error('Task đang chạy, không thể sửa');
  db.prepare(`UPDATE tasks SET content = COALESCE(?, content), scheduled_at = COALESCE(?, scheduled_at),
    account_id = COALESCE(?, account_id), repeat = COALESCE(?, repeat) WHERE id = ?`)
    .run(req.body.content ?? null, req.body.scheduled_at ?? null, req.body.account_id ?? null, req.body.repeat ?? null, req.params.id);
  res.json({ ok: true });
}));

/*
 Tạo hàng loạt task.
 body: {
   kind: 'post' | 'comment',
   contents: string[],            // mỗi phần tử là 1 nội dung (spintax {a|b} được hỗ trợ)
   contentMode: 'rotate' | 'all', // mỗi đích dùng 1 nội dung xoay vòng, hay dùng tất cả nội dung
   contentSource: 'text' | 'templates', // templates = mỗi lần chạy chọn ngẫu nhiên 1 mẫu chưa dùng
   contentTemplateIds: number[],
   images: string[],              // kho ảnh: tên file đã upload
   imageMode: 'all' | 'random' | 'rotate', // dùng tất cả / bốc ngẫu nhiên mỗi lần chạy / chia luân phiên cho các task
   imageMin, imageMax: number,    // số ảnh mỗi task (random: khoảng min–max, rotate: dùng imageMax)
   imageShuffle: boolean,         // đảo thứ tự ảnh mỗi lần chạy
   imageTemplates: number[],      // id mẫu ảnh: mỗi lần chạy bốc ngẫu nhiên số ảnh mặc định của từng mẫu
   accountIds: number[],
   distribute: 'rotate' | 'all',  // mỗi đích 1 tài khoản (luân phiên) hay tất cả tài khoản
   targets: [{type:'profile'} | {type:'group', url, name} | {type:'post', url}],
   startAt: number | null,        // ms, null = ngay bây giờ
   intervalMin: number,           // giãn cách giữa các task
   repeat: 'none' | 'daily' | 'weekly',
   draft: boolean                 // true = chỉ thêm vào hàng đợi, chưa chạy
 }
*/
app.post('/api/tasks/bulk', wrap((req, res) => {
  const b = req.body || {};
  const kind = b.kind === 'comment' ? 'comment' : 'post';
  // Nguồn nội dung "templates": mỗi task 1 nội dung giữ chỗ, nội dung thật được chọn lúc chạy
  const contentTemplates = b.contentSource === 'templates' ? resolveContentTemplates(b.contentTemplateIds, kind) : [];
  const contents = contentTemplates.length
    ? [randomContentLabel(contentTemplates.length)]
    : (b.contents || []).map(c => String(c).trim()).filter(Boolean);
  const contentOpts = JSON.stringify(contentTemplates.length ? { templates: contentTemplates } : {});
  const accountIds = (b.accountIds || []).map(Number).filter(Boolean);
  const targets = (b.targets || []).map(t => {
    if (t.type === 'profile') return { type: 'profile', url: null, name: 'Trang cá nhân' };
    const url = normalizeFbUrl(t.url);
    return url ? { type: t.type === 'post' ? 'post' : 'group', url, name: t.name || url } : null;
  }).filter(Boolean);

  if (!contents.length) throw new Error('Chưa nhập nội dung');
  if (!accountIds.length) throw new Error('Chưa chọn tài khoản');
  if (!targets.length) throw new Error(kind === 'comment' ? 'Chưa nhập link bài viết' : 'Chưa chọn nơi đăng');
  if (kind === 'comment' && targets.some(t => t.type !== 'post')) throw new Error('Bình luận cần link bài viết');

  const jobs = [];
  let ar = 0, cr = 0;
  for (const target of targets) {
    const accs = b.distribute === 'all' ? accountIds : [accountIds[ar++ % accountIds.length]];
    for (const acc of accs) {
      const list = b.contentMode === 'all' ? contents : [contents[cr++ % contents.length]];
      for (const content of list) jobs.push({ target, acc, content });
    }
  }
  if (jobs.length > 2000) throw new Error(`Quá nhiều task (${jobs.length}), tối đa 2000 mỗi lần`);

  const start = Number(b.startAt) || now();
  const gap = Math.max(0, Number(b.intervalMin) || 0) * 60000;
  const repeat = ['daily', 'weekly'].includes(b.repeat) ? b.repeat : 'none';
  const pool = (b.images || []).map(f => path.basename(String(f)));
  const imagesFor = imagePlan(kind, pool, b);
  const batch = crypto.randomUUID().slice(0, 8);
  const ins = db.prepare(`INSERT INTO tasks(batch, kind, account_id, target_type, target_url, target_name, content, content_opts, images, image_opts, scheduled_at, repeat, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  db.exec('BEGIN');
  try {
    jobs.forEach((j, i) => {
      const img = imagesFor(i);
      ins.run(batch, kind, j.acc, j.target.type, j.target.url, j.target.name, j.content, contentOpts, JSON.stringify(img.images), JSON.stringify(img.opts),
        start + i * gap, repeat, b.draft ? 'draft' : 'pending', now());
    });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ created: jobs.length, batch });
}));

// [id] → [{id, name, content}] (content là bản sao dự phòng khi mẫu bị xoá)
function resolveContentTemplates(ids, kind) {
  const get = db.prepare('SELECT id, name, kind, content FROM templates WHERE id = ?');
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number))].map(id => {
    const row = get.get(id);
    if (!row) throw new Error(`Mẫu nội dung #${id} không tồn tại`);
    if (row.kind !== kind) throw new Error(`Mẫu "${row.name}" là mẫu ${row.kind === 'post' ? 'đăng bài' : 'bình luận'}`);
    return { id: row.id, name: row.name, content: row.content };
  });
  if (!list.length) throw new Error('Chưa chọn mẫu nội dung');
  return list;
}

// Trả về hàm (chỉ số task) => { images: kho ảnh lưu vào task, opts: cách chọn lúc chạy }
function imagePlan(kind, pool, b) {
  const per = maxPerTask(kind);
  const shuffle = !!b.imageShuffle;
  if (pool.length > MAX_POOL) throw new Error(`Kho ảnh tối đa ${MAX_POOL} ảnh`);
  const templates = resolveImageTemplates(b.imageTemplates, per);
  const plan = basePlan();
  const tplCount = templates.reduce((s, t) => s + Math.min(t.max, t.pool.length), 0);
  if (per > 1 && plan.count + tplCount > per) {
    throw new Error(`Mỗi bài tối đa ${per} ảnh, đang chọn ${plan.count + tplCount} ảnh (kho ${plan.count} + mẫu ${tplCount})`);
  }
  if (!templates.length) return plan.at;
  return i => {
    const r = plan.at(i);
    return { images: r.images, opts: { ...r.opts, shuffle, templates } };
  };

  function basePlan() {
    if (!pool.length) return { count: 0, at: () => ({ images: [], opts: {} }) };
    const mode = ['random', 'rotate'].includes(b.imageMode) ? b.imageMode : 'all';
    if (mode === 'all') {
      if (pool.length > per) throw new Error(`Mỗi ${kind === 'comment' ? 'bình luận' : 'bài'} tối đa ${per} ảnh, hãy chọn chế độ Ngẫu nhiên hoặc Luân phiên`);
      return { count: pool.length, at: () => ({ images: pool, opts: { shuffle } }) };
    }
    const max = Math.max(1, Math.min(per, pool.length, Math.floor(Number(b.imageMax) || 1)));
    if (mode === 'rotate') return { count: max, at: i => ({ images: rotateSlice(pool, i, max), opts: { shuffle } }) };
    const min = Math.max(0, Math.min(max, Math.floor(Number(b.imageMin) || 0)));
    return { count: max, at: () => ({ images: pool, opts: { mode: 'random', min, max, shuffle } }) };
  }
}

// [id | {id}] → [{id, name, max, pool}]: số ảnh bốc lấy theo cài đặt của mẫu,
// pool là bản sao ảnh dự phòng khi mẫu bị xoá
function resolveImageTemplates(list, per) {
  const get = db.prepare('SELECT * FROM image_templates WHERE id = ?');
  const ids = [...new Set((Array.isArray(list) ? list : []).map(x => Number(x?.id ?? x)))];
  return ids.map(id => {
    const row = get.get(id);
    if (!row) throw new Error(`Mẫu ảnh #${id} không tồn tại`);
    const pool = JSON.parse(row.images);
    if (!pool.length) throw new Error(`Mẫu ảnh "${row.name}" chưa có ảnh`);
    return { id: row.id, name: row.name, max: Math.min(per, row.default_max), pool };
  });
}

// Thao tác hàng loạt: run | run_now | pause | retry | delete
app.post('/api/tasks/action', wrap((req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean);
  if (!ids.length) throw new Error('Chưa chọn task');
  const ph = ids.map(() => '?').join(',');
  const t = now();
  const sql = {
    run: `UPDATE tasks SET status = 'pending', scheduled_at = MAX(scheduled_at, ${t}) WHERE id IN (${ph}) AND status IN ('draft','paused','error')`,
    run_now: `UPDATE tasks SET status = 'pending', scheduled_at = ${t}, attempts = 0 WHERE id IN (${ph}) AND status IN ('draft','paused','error','pending')`,
    pause: `UPDATE tasks SET status = 'paused' WHERE id IN (${ph}) AND status IN ('pending','draft')`,
    retry: `UPDATE tasks SET status = 'pending', scheduled_at = ${t}, attempts = 0 WHERE id IN (${ph}) AND status = 'error'`,
    delete: `DELETE FROM tasks WHERE id IN (${ph}) AND status != 'running'`,
  }[req.body.action];
  if (!sql) throw new Error('Thao tác không hợp lệ');
  const r = db.prepare(sql).run(...ids);
  res.json({ changed: Number(r.changes) });
}));

app.get('/api/logs', wrap((req, res) => {
  res.json(db.prepare(`SELECT l.*, a.name AS account_name FROM logs l LEFT JOIN accounts a ON a.id = l.account_id
    ORDER BY l.id DESC LIMIT ?`).all(Math.min(+req.query.limit || 200, 1000)));
}));

const PORT = +process.env.PORT || 3000;
export const server = app.listen(PORT, '127.0.0.1', () => {
  runner.start();
  console.log(`FB CRM đang chạy tại http://localhost:${PORT}`);
});
