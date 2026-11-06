// Kiểm tra tính năng "Tạo & lên lịch": giao diện Studio → API → DB → bộ chạy lịch.
// Facebook được thay bằng mock nên không cần tài khoản thật.
// Chạy: npm test
import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fbcrm-test-'));
process.env.DATA_DIR = TMP;
process.env.PORT = '3311';
const BASE = 'http://127.0.0.1:3311';

// ---- Mock Facebook ----
const calls = [];
let fbImpl = async () => 'Đã đăng';
const fbError = (code, msg) => Object.assign(new Error(msg), { code });
mock.module('../src/fb.js', {
  namedExports: {
    isBusy: () => false,
    createPost: async (id, opts) => { calls.push({ fn: 'createPost', id, ...opts }); return fbImpl('post', id, opts); },
    comment: async (id, opts) => { calls.push({ fn: 'comment', id, ...opts }); return fbImpl('comment', id, opts); },
    interactiveLogin: async () => '100000',
    importCookies: async () => '100000',
    checkLogin: async () => '100000',
    FbError: Error,
  },
});

const { db, setSettings } = await import('../src/db.js');
const runner = await import('../src/runner.js');
const { server } = await import('../src/server.js');
await new Promise(r => server.listening ? r() : server.once('listening', r));

const settle = () => new Promise(r => setTimeout(r, 60));
const tasks = () => db.prepare('SELECT * FROM tasks ORDER BY id').all();
const task = id => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const MIN = 60000, DAY = 86400000;

function reset({ runner: on = '0', gap = '0', limit = '20', concurrent = '2', attempts = '2' } = {}) {
  db.exec('DELETE FROM tasks; DELETE FROM logs; DELETE FROM targets; DELETE FROM accounts; DELETE FROM image_templates; DELETE FROM templates; DELETE FROM sqlite_sequence;');
  setSettings({ runner_enabled: on, min_gap_seconds: gap, daily_limit: limit, max_concurrent: concurrent, max_attempts: attempts });
  calls.length = 0;
  fbImpl = async () => 'Đã đăng';
}
function addAccount(name, status = 'ok') {
  return Number(db.prepare('INSERT INTO accounts(name, status, created_at) VALUES (?, ?, ?)').run(name, status, Date.now()).lastInsertRowid);
}
function addImageTemplate(name, images, defaultMax = 3) {
  return Number(db.prepare('INSERT INTO image_templates(name, images, default_max, created_at) VALUES (?, ?, ?, ?)')
    .run(name, JSON.stringify(images), defaultMax, Date.now()).lastInsertRowid);
}
function addContentTemplate(name, content, kind = 'post', used = 0) {
  return Number(db.prepare('INSERT INTO templates(name, kind, content, used, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, kind, content, used, Date.now()).lastInsertRowid);
}
const usedFlag = id => db.prepare('SELECT used FROM templates WHERE id = ?').get(id).used;
const useCount = id => db.prepare('SELECT use_count FROM templates WHERE id = ?').get(id).use_count;
function addTask(over = {}) {
  const t = { kind: 'post', account_id: 1, target_type: 'profile', target_url: null, target_name: 'Trang cá nhân',
    content: 'Nội dung', images: '[]', scheduled_at: Date.now() - 1000, repeat: 'none', status: 'pending', ...over };
  return Number(db.prepare(`INSERT INTO tasks(kind, account_id, target_type, target_url, target_name, content, images, scheduled_at, repeat, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t.kind, t.account_id, t.target_type, t.target_url, t.target_name, t.content, t.images,
    t.scheduled_at, t.repeat, t.status, Date.now()).lastInsertRowid);
}
async function runTick() { await runner.tick(); await settle(); }

after(() => {
  server.close();
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// =====================================================================
describe('Giao diện Studio: Tạo & lên lịch', () => {
  let browser, page;
  const pageErrors = [];

  before(async () => {
    browser = await chromium.launch();
  });
  after(() => browser?.close());

  beforeEach(async () => {
    reset();
    addAccount('Nick A');
    addAccount('Nick B');
    addAccount('Nick hết phiên', 'expired');
    db.prepare("INSERT INTO targets(name, type, url, created_at) VALUES ('Nhóm Test', 'group', 'https://www.facebook.com/groups/111/', ?)").run(Date.now());
    page?.close();
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.goto(BASE);
    await page.waitForSelector('#formArea textarea[data-field="text"]');
  });

  const toast = async text => (await page.locator('.toast', { hasText: text }).first().waitFor({ timeout: 5000 }), true);

  test('hẹn giờ + giãn cách + lặp lại: trang cá nhân & nhóm, tất cả nội dung', async () => {
    await page.locator('label.switch:has(input[data-sw="toGroups"])').click();
    await page.click('[data-grp="1"]');
    await page.fill('textarea[data-field="text"]', 'Bài số 1\ndòng 2\n\nBài số 2 {A|B}');
    await page.click('[data-acc="1"]');
    await page.click('[data-seg="when"][data-val="at"]');

    const d = new Date(Date.now() + DAY);
    const at = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T09:00`;
    await page.fill('input[data-field="at"]', at);
    await page.fill('input[data-field="interval"]', '30');
    await page.click('[data-seg="repeat"][data-val="daily"]');

    assert.match(await page.textContent('#estimate'), /Sẽ tạo 4 task/);
    await page.click('#btnCreate');
    assert.ok(await toast('Đã tạo 4 task'));

    const start = new Date(at).getTime();
    const rows = tasks();
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map(r => r.scheduled_at - start), [0, 30 * MIN, 60 * MIN, 90 * MIN]);
    assert.deepEqual(rows.map(r => r.target_type), ['profile', 'profile', 'group', 'group']);
    assert.deepEqual(rows.map(r => r.content), ['Bài số 1\ndòng 2', 'Bài số 2 {A|B}', 'Bài số 1\ndòng 2', 'Bài số 2 {A|B}']);
    assert.ok(rows.every(r => r.status === 'pending' && r.repeat === 'daily' && r.account_id === 1 && r.kind === 'post'));
    assert.equal(rows[2].target_name, 'Nhóm Test');

    // form được xoá nội dung và danh sách task cập nhật
    assert.equal(await page.inputValue('textarea[data-field="text"]'), '');
    await page.waitForFunction(() => document.querySelectorAll('#taskList .task').length === 4);
  });

  test('chạy ngay + luân phiên 2 tài khoản cho bình luận (xoay vòng nội dung)', async () => {
    await page.click('.tab[data-kind="comment"]');
    await page.fill('textarea[data-field="postUrls"]', 'https://facebook.com/groups/1/posts/10\nhttps://www.facebook.com/x/posts/20\nwww.facebook.com/groups/1/posts/30');
    await page.fill('textarea[data-field="text"]', 'Hay quá\n\nCảm ơn bạn');
    await page.click('[data-acc="1"]');
    await page.click('[data-acc="2"]');
    assert.match(await page.textContent('#estimate'), /Sẽ tạo 3 task/);

    const before = Date.now();
    await page.click('#btnCreate');
    assert.ok(await toast('Đã tạo 3 task'));
    const rows = tasks();
    assert.deepEqual(rows.map(r => r.account_id), [1, 2, 1]);
    assert.deepEqual(rows.map(r => r.content), ['Hay quá', 'Cảm ơn bạn', 'Hay quá']);
    assert.ok(rows.every(r => r.kind === 'comment' && r.target_type === 'post' && r.target_url.startsWith('https://www.facebook.com/')));
    assert.ok(rows.every(r => r.scheduled_at >= before - 1000 && r.scheduled_at <= Date.now()));
  });

  test('"Chỉ thêm vào hàng đợi" tạo task chưa chạy, bấm "Chạy" chuyển sang chờ chạy', async () => {
    await page.fill('textarea[data-field="text"]', 'Nháp');
    await page.click('[data-acc="1"]');
    await page.click('#btnDraft');
    assert.ok(await toast('chưa chạy'));
    assert.equal(tasks()[0].status, 'draft');

    await page.waitForSelector('#taskList .task');
    await page.click('#selDraft');
    await page.click('[data-bulk="run"]');
    assert.ok(await toast('Đã cập nhật 1 task'));
    assert.equal(tasks()[0].status, 'pending');
  });

  // PNG 1x1 hợp lệ để upload thử
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const pngFiles = n => Array.from({ length: n }, (_, i) => ({ name: `anh${i + 1}.png`, mimeType: 'image/png', buffer: PNG }));
  async function uploadImages(n) {
    await page.setInputFiles('#imgInput', pngFiles(n));
    await page.waitForFunction(k => document.querySelectorAll('#formArea .thumb img').length === k, n);
    return page.$$eval('#formArea .thumb img', els => els.map(e => e.getAttribute('src').replace('/uploads/', '')));
  }

  test('ảnh luân phiên: mỗi bài lấy cụm ảnh kế tiếp trong kho', async () => {
    await page.fill('textarea[data-field="text"]', 'A\n\nB\n\nC');
    await page.click('[data-acc="1"]');
    const pool = await uploadImages(5);
    assert.match(await page.textContent('#formArea'), /Kho ảnh \/ video\s*\(5\/50/);

    await page.click('[data-seg="imageMode"][data-val="rotate"]');
    await page.fill('input[data-field="imageMax"]', '2');
    await page.press('input[data-field="imageMax"]', 'Tab');
    await page.locator('#formArea .hint', { hasText: 'Task 1 dùng ảnh 1–2, task 2 dùng ảnh 3–4' }).waitFor();

    await page.click('#btnCreate');
    assert.ok(await toast('Đã tạo 3 task'));
    assert.deepEqual(tasks().map(t => JSON.parse(t.images)), [[pool[0], pool[1]], [pool[2], pool[3]], [pool[4], pool[0]]]);
    assert.ok(tasks().every(t => JSON.parse(t.image_opts).shuffle === false));
    assert.equal(await page.locator('#formArea .thumb img').count(), 0, 'kho ảnh được xoá sau khi tạo');
  });

  test('ảnh ngẫu nhiên + đảo thứ tự cho bài đăng, bình luận tự bốc 1 ảnh', async () => {
    await page.fill('textarea[data-field="text"]', 'Bài');
    await page.click('[data-acc="1"]');
    const pool = await uploadImages(4);
    await page.click('[data-seg="imageMode"][data-val="random"]');
    await page.fill('input[data-field="imageMin"]', '2');
    await page.fill('input[data-field="imageMax"]', '3');
    await page.press('input[data-field="imageMax"]', 'Tab');
    await page.locator('label.switch:has(input[data-sw="imageShuffle"])').click();
    await page.locator('#formArea .hint', { hasText: 'bốc 2–3 ảnh ngẫu nhiên trong 4 ảnh, thứ tự đảo ngẫu nhiên' }).waitFor();
    await page.click('#btnCreate');
    assert.ok(await toast('Đã tạo 1 task'));
    let t = tasks()[0];
    assert.deepEqual(JSON.parse(t.images), pool);
    assert.deepEqual(JSON.parse(t.image_opts), { mode: 'random', min: 2, max: 3, shuffle: true });

    // Bình luận: kho nhiều ảnh → không có "Dùng tất cả", mỗi bình luận 1 ảnh
    await page.click('.tab[data-kind="comment"]');
    await page.fill('textarea[data-field="postUrls"]', 'https://www.facebook.com/p/1');
    await page.fill('textarea[data-field="text"]', 'Đẹp quá');
    await uploadImages(3);
    assert.equal(await page.locator('[data-seg="imageMode"][data-val="all"]').count(), 0);
    await page.locator('#formArea .hint', { hasText: 'Mỗi bình luận tự bốc 1 ảnh ngẫu nhiên trong 3 ảnh' }).waitFor();
    await page.click('#btnCreate');
    assert.ok(await toast('Đã tạo 1 task'));
    t = tasks()[1];
    assert.equal(JSON.parse(t.images).length, 3);
    assert.deepEqual(JSON.parse(t.image_opts), { mode: 'random', min: 1, max: 1, shuffle: false });
  });

  test('trang Mẫu ảnh: tạo mẫu bằng upload, sửa, dùng để đăng bài', async () => {
    await page.click('[data-view="imageTemplates"]');
    await page.click('[data-eact="new"]');
    await page.fill('[data-e="name"]', 'Ảnh sản phẩm');
    await page.fill('[data-e="default_max"]', '2');
    await page.setInputFiles('#tplImgInput', pngFiles(4));
    await page.waitForFunction(() => document.querySelectorAll('#tplEditor .thumb img').length === 4);
    await page.click('[data-eact="save"]');
    assert.ok(await toast('Đã lưu mẫu ảnh'));

    let row = db.prepare('SELECT * FROM image_templates').get();
    assert.equal(row.name, 'Ảnh sản phẩm');
    assert.equal(row.default_max, 2);
    assert.equal(JSON.parse(row.images).length, 4);

    // sửa: xoá 1 ảnh
    await page.click('.tpl-card [data-cact="edit"]');
    await page.click('#tplEditor [data-erm="0"]');
    await page.click('[data-eact="save"]');
    await page.locator('.tpl-card', { hasText: '3 ảnh' }).waitFor();
    row = db.prepare('SELECT * FROM image_templates').get();
    assert.equal(JSON.parse(row.images).length, 3);

    // dùng để đăng bài → về Studio với mẫu đã chọn, số ảnh theo cài đặt của mẫu
    await page.click('.tpl-card [data-cact="use"]');
    await page.waitForSelector(`[data-imgtpl="${row.id}"].on`);
    assert.match(await page.textContent('#tplHint'), /2 ảnh từ "Ảnh sản phẩm" = 2\/10 ảnh/);
  });

  test('đăng bài: chỉ chọn mẫu ảnh, số ảnh lấy theo cài đặt của mẫu', async () => {
    const a = addImageTemplate('Sản phẩm', Array.from({ length: 12 }, (_, i) => `a${i}.jpg`), 3);
    const b = addImageTemplate('Feedback', ['b1.jpg', 'b2.jpg', 'b3.jpg'], 2);
    const big = addImageTemplate('Bộ lớn', Array.from({ length: 12 }, (_, i) => `c${i}.jpg`), 8);
    await page.reload();
    await page.waitForSelector('[data-imgtpl]');
    await page.fill('textarea[data-field="text"]', 'Bài có ảnh mẫu');
    await page.click('[data-acc="1"]');
    assert.match(await page.textContent(`[data-imgtpl="${a}"]`), /bốc 3\/12/);
    await page.click(`[data-imgtpl="${a}"]`);
    await page.click(`[data-imgtpl="${b}"]`);
    assert.equal(await page.locator('#formArea [data-tplmax]').count(), 0, 'không có ô nhập số ảnh');
    assert.match(await page.textContent('#tplHint'), /3 ảnh từ "Sản phẩm" \+ 2 ảnh từ "Feedback" = 5\/10 ảnh/);

    // chọn thêm mẫu làm vượt 10 ảnh → cảnh báo, server từ chối
    await page.click(`[data-imgtpl="${big}"]`);
    assert.match(await page.textContent('#tplHint'), /13\/10 ảnh.*vượt giới hạn/);
    await page.click('#btnCreate');
    assert.ok(await toast('Mỗi bài tối đa 10 ảnh'));
    assert.equal(tasks().length, 0);

    await page.click(`[data-imgtpl="${big}"]`);
    await page.click('#btnCreate');
    assert.ok(await toast('Đã tạo 1 task'));
    const opts = JSON.parse(tasks()[0].image_opts);
    assert.deepEqual(opts.templates.map(t => [t.id, t.name, t.max, t.pool.length]), [[a, 'Sản phẩm', 3, 12], [b, 'Feedback', 2, 3]]);
    // lựa chọn mẫu được giữ lại cho lần tạo kế tiếp
    assert.equal(await page.locator('[data-imgtpl].on').count(), 2);
  });

  test('nội dung ngẫu nhiên từ mẫu: chọn mẫu, tạo task, trạng thái đã dùng ở trang Mẫu nội dung', async () => {
    const a = addContentTemplate('Mẫu A', 'Nội dung A');
    const b = addContentTemplate('Mẫu B', 'Nội dung B', 'post', 1);
    addContentTemplate('Mẫu bình luận', 'Hay', 'comment');
    await page.reload();
    await page.waitForSelector('[data-seg="contentSource"]');
    await page.click('[data-seg="contentSource"][data-val="templates"]');
    assert.equal(await page.locator('textarea[data-field="text"]').count(), 0, 'ẩn ô tự nhập');
    assert.equal(await page.locator('[data-ctpl]').count(), 2, 'chỉ hiện mẫu đăng bài');
    assert.match(await page.textContent(`[data-ctpl="${a}"]`), /chưa dùng/);
    assert.match(await page.textContent(`[data-ctpl="${b}"]`), /đã dùng/);

    await page.click('#ctplAll');
    await page.locator('#formArea .hint', { hasText: 'chọn ngẫu nhiên 1 mẫu chưa dùng trong 2 mẫu (còn 1 mẫu chưa dùng)' }).waitFor();
    await page.locator('label.switch:has(input[data-sw="toGroups"])').click();
    await page.click('[data-grp="1"]');
    await page.click('[data-acc="1"]');
    assert.match(await page.textContent('#estimate'), /Sẽ tạo 2 task/);
    await page.click('#btnCreate');
    assert.ok(await toast('Đã tạo 2 task'));

    const rows = tasks();
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.match(r.content, /Ngẫu nhiên từ 2 mẫu/);
      assert.deepEqual(JSON.parse(r.content_opts).templates.map(t => [t.id, t.content]).sort(), [[a, 'Nội dung A'], [b, 'Nội dung B']]);
    }

    // sang tab bình luận: mẫu đăng bài bị bỏ chọn, chỉ còn mẫu bình luận
    await page.click('.tab[data-kind="comment"]');
    assert.equal(await page.locator('[data-ctpl].on').count(), 0);
    assert.equal(await page.locator('[data-ctpl]').count(), 1);

    await page.click('[data-view="templates"]');
    const rowB = page.locator(`tr[data-id="${b}"]`);
    await rowB.locator('text=Đã dùng').waitFor();
    await rowB.locator('[data-reset]').click();
    await rowB.locator('text=Chưa dùng').waitFor();
    assert.equal(usedFlag(b), 0);
  });

  test('báo lỗi khi thiếu dữ liệu, tài khoản hết phiên không chọn được', async () => {
    await page.click('#btnCreate');
    assert.ok(await toast('Chưa nhập nội dung'));
    await page.fill('textarea[data-field="text"]', 'abc');
    await page.click('#btnCreate');
    assert.ok(await toast('Chưa chọn tài khoản'));
    assert.ok(await page.isDisabled('[data-acc="3"]'));
    await page.click('[data-acc="1"]');
    await page.locator('label.switch:has(input[data-sw="toProfile"])').click();
    await page.click('#btnCreate');
    assert.ok(await toast('Chưa chọn nơi đăng'));
    assert.equal(tasks().length, 0);
    assert.deepEqual(pageErrors, []);
  });
});

// =====================================================================
describe('Bộ chạy lịch', () => {
  beforeEach(() => { reset({ runner: '1' }); addAccount('Nick A'); });

  test('chạy task đến hạn, bỏ qua task tương lai / nháp / tạm dừng', async () => {
    const due = addTask({ content: 'Xin {chào|hello}', images: '["a.jpg"]' });
    const future = addTask({ scheduled_at: Date.now() + 10 * MIN });
    const draft = addTask({ status: 'draft' });
    const paused = addTask({ status: 'paused' });
    await runTick();

    assert.equal(task(due).status, 'done');
    assert.equal(task(due).result, 'Đã đăng');
    assert.equal(calls.length, 1);
    assert.match(calls[0].content, /^Xin (chào|hello)$/);
    assert.ok(calls[0].images[0].endsWith(path.join('uploads', 'a.jpg')));
    for (const id of [future, draft, paused]) assert.notEqual(task(id).status, 'done');
    assert.ok(db.prepare('SELECT last_action_at FROM accounts WHERE id = 1').get().last_action_at);
  });

  test('gọi đúng hàm theo loại task (đăng nhóm / bình luận)', async () => {
    addTask({ target_type: 'group', target_url: 'https://www.facebook.com/groups/1/' });
    await runTick();
    setSettings({ min_gap_seconds: '0' });
    addTask({ kind: 'comment', target_type: 'post', target_url: 'https://www.facebook.com/p/1' });
    await runTick();
    assert.deepEqual(calls.map(c => [c.fn, c.targetType ?? null, c.url]), [
      ['createPost', 'group', 'https://www.facebook.com/groups/1/'],
      ['comment', null, 'https://www.facebook.com/p/1'],
    ]);
  });

  test('tôn trọng khoảng nghỉ tối thiểu giữa 2 thao tác cùng tài khoản', async () => {
    setSettings({ min_gap_seconds: '120' });
    const a = addTask(), b = addTask();
    await runTick();
    await runTick();
    assert.equal(task(a).status, 'done');
    assert.equal(task(b).status, 'pending');
    db.prepare('UPDATE accounts SET last_action_at = ?').run(Date.now() - 121000);
    await runTick();
    assert.equal(task(b).status, 'done');
  });

  test('giới hạn số tài khoản chạy song song', async () => {
    addAccount('Nick B'); addAccount('Nick C');
    let release;
    const gate = new Promise(r => { release = r; });
    fbImpl = () => gate;
    const ids = [1, 2, 3].map(acc => addTask({ account_id: acc }));
    await runTick();
    assert.deepEqual(ids.map(id => task(id).status), ['running', 'running', 'pending']);
    release('Đã đăng');
    await settle();
    await runTick();
    assert.deepEqual(ids.map(id => task(id).status), ['done', 'done', 'done']);
  });

  test('giới hạn thao tác / ngày', async () => {
    setSettings({ daily_limit: '1' });
    const a = addTask(), b = addTask();
    await runTick(); await runTick();
    assert.equal(task(a).status, 'done');
    assert.equal(task(b).status, 'pending');
  });

  test('lặp hằng ngày / hằng tuần tạo lần chạy kế tiếp đúng giờ', async () => {
    addAccount('Nick B');
    const base = Date.now() - 1000;
    addTask({ repeat: 'daily', scheduled_at: base });
    addTask({ repeat: 'weekly', scheduled_at: base, account_id: 2 });
    await runTick();
    const next = tasks().filter(t => t.status === 'pending');
    assert.equal(next.length, 2);
    assert.equal(next.find(t => t.repeat === 'daily').scheduled_at, base + DAY);
    assert.equal(next.find(t => t.repeat === 'weekly').scheduled_at, base + 7 * DAY);
  });

  test('task lặp bị trễ nhiều ngày không tạo lịch trong quá khứ', async () => {
    addTask({ repeat: 'daily', scheduled_at: Date.now() - 3.5 * DAY });
    await runTick();
    const next = tasks().find(t => t.status === 'pending');
    assert.ok(next.scheduled_at > Date.now() && next.scheduled_at < Date.now() + DAY);
  });

  test('lỗi tạm thời: thử lại sau 5 phút, hết lượt thì báo lỗi', async () => {
    fbImpl = async () => { throw fbError('NO_POST_BUTTON', 'Không tìm thấy nút Đăng'); };
    const id = addTask();
    await runTick();
    let t = task(id);
    assert.equal(t.status, 'pending');
    assert.equal(t.attempts, 1);
    assert.ok(t.scheduled_at > Date.now() + 4 * MIN);

    db.prepare('UPDATE tasks SET scheduled_at = ? WHERE id = ?').run(Date.now() - 1, id);
    await runTick();
    t = task(id);
    assert.equal(t.status, 'error');
    assert.equal(t.attempts, 2);
    assert.equal(t.error, 'Không tìm thấy nút Đăng');
  });

  test('hết phiên: đánh dấu tài khoản, không thử lại, các task khác của tài khoản báo lỗi', async () => {
    fbImpl = async () => { throw fbError('EXPIRED', 'Phiên đăng nhập đã hết hạn'); };
    const a = addTask(), b = addTask();
    await runTick();
    assert.equal(task(a).status, 'error');
    assert.equal(db.prepare('SELECT status FROM accounts WHERE id = 1').get().status, 'expired');
    await runTick();
    assert.equal(task(b).status, 'error');
    assert.match(task(b).error, /chưa đăng nhập|hết phiên/);
    assert.equal(calls.length, 1);
  });

  test('ảnh ngẫu nhiên được bốc lại mỗi lần chạy và lưu ảnh đã dùng', async () => {
    const pool = ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg'];
    const opts = JSON.stringify({ mode: 'random', min: 2, max: 3, shuffle: true });
    const id = addTask({ images: JSON.stringify(pool), repeat: 'daily' });
    db.prepare('UPDATE tasks SET image_opts = ? WHERE id = ?').run(opts, id);
    await runTick();

    const sent = calls[0].images.map(p => path.basename(p));
    assert.ok(sent.length >= 2 && sent.length <= 3);
    assert.ok(sent.every(f => pool.includes(f)));
    assert.deepEqual(JSON.parse(task(id).used_images), sent);
    assert.match(db.prepare('SELECT message FROM logs WHERE task_id = ? ORDER BY id LIMIT 1').get(id).message, /dùng \d ảnh/);
    // lần lặp kế tiếp giữ nguyên kho ảnh và cách chọn
    const next = tasks().find(t => t.status === 'pending');
    assert.equal(next.images, JSON.stringify(pool));
    assert.equal(next.image_opts, opts);
  });

  test('mẫu ảnh: bốc theo số ảnh của mẫu, dùng cài đặt mới khi mẫu được sửa, bản sao khi mẫu bị xoá', async () => {
    const a = addImageTemplate('A', ['a1', 'a2', 'a3', 'a4'], 2);
    const b = addImageTemplate('B', ['b1', 'b2', 'b3'], 1);
    const opts = { templates: [{ id: a, name: 'A', max: 2, pool: ['a1', 'a2', 'a3', 'a4'] }, { id: b, name: 'B', max: 1, pool: ['b1', 'b2', 'b3'] }] };
    const mk = () => { const id = addTask(); db.prepare('UPDATE tasks SET image_opts = ? WHERE id = ?').run(JSON.stringify(opts), id); return id; };
    const sent = () => calls.at(-1).images.map(p => path.basename(p));

    mk(); await runTick();
    assert.equal(sent().filter(f => f.startsWith('a')).length, 2);
    assert.equal(sent().filter(f => f.startsWith('b')).length, 1);

    // sửa mẫu A: ảnh mới và số ảnh bốc mới
    db.prepare('UPDATE image_templates SET images = ?, default_max = 3 WHERE id = ?').run(JSON.stringify(['n1', 'n2', 'n3', 'n4']), a);
    mk(); await runTick();
    assert.equal(sent().filter(f => f.startsWith('n')).length, 3, 'dùng ảnh và số ảnh hiện tại của mẫu');

    db.prepare('DELETE FROM image_templates WHERE id = ?').run(a);
    mk(); await runTick();
    assert.equal(sent().filter(f => f.startsWith('a')).length, 2, 'mẫu bị xoá → dùng bản sao');
    assert.equal(calls.length, 3);
  });

  test('nội dung từ mẫu: đăng xong đánh dấu đã dùng, dùng hết thì khôi phục chưa dùng', async () => {
    const ids = [addContentTemplate('A', 'Nội dung A {1|2}'), addContentTemplate('B', 'Nội dung B'), addContentTemplate('C', 'Nội dung C')];
    const opts = JSON.stringify({ templates: ids.map(id => ({ id, name: '', content: 'bản sao' })) });
    const mk = (over = {}) => { const id = addTask(over); db.prepare('UPDATE tasks SET content_opts = ? WHERE id = ?').run(opts, id); return id; };
    const nameOf = content => content.replace(/^Nội dung /, '').replace(/ [12]$/, '');

    const first = mk(); await runTick();
    const u1 = nameOf(calls[0].content);
    assert.deepEqual(ids.map(usedFlag), ['A', 'B', 'C'].map(n => (n === u1 ? 1 : 0)), 'chỉ mẫu vừa đăng được đánh dấu');
    assert.equal(task(first).used_content, calls[0].content);
    assert.match(db.prepare("SELECT message FROM logs WHERE message LIKE 'Đánh dấu mẫu%' LIMIT 1").get().message, /còn 2 mẫu chưa dùng/);

    mk(); await runTick();
    const u2 = nameOf(calls[1].content);
    assert.notEqual(u2, u1, 'không bốc lại mẫu đã dùng');
    assert.equal(ids.map(usedFlag).filter(Boolean).length, 2);

    mk(); await runTick();
    const u3 = nameOf(calls[2].content);
    assert.deepEqual([u1, u2, u3].sort(), ['A', 'B', 'C'], 'mỗi mẫu dùng đúng 1 lần');
    assert.deepEqual(ids.map(usedFlag), [0, 0, 0], 'dùng hết → khôi phục chưa dùng');
    assert.deepEqual(ids.map(useCount), [1, 1, 1]);
    assert.ok(db.prepare("SELECT 1 FROM logs WHERE message LIKE 'Đã dùng hết 3 mẫu%'").get());
  });

  test('nội dung từ mẫu: đăng lỗi không đánh dấu, task chạy song song không bốc trùng, mẫu bị xoá dùng bản sao', async () => {
    addAccount('Nick B');
    const a = addContentTemplate('A', 'Nội dung A');
    const b = addContentTemplate('B', 'Nội dung B');
    const opts = JSON.stringify({ templates: [{ id: a, name: 'A', content: 'Bản sao A' }, { id: b, name: 'B', content: 'Bản sao B' }] });
    const mk = (over = {}) => { const id = addTask(over); db.prepare('UPDATE tasks SET content_opts = ? WHERE id = ?').run(opts, id); return id; };

    fbImpl = async () => { throw fbError('NO_POST_BUTTON', 'lỗi'); };
    setSettings({ max_attempts: '1' });
    mk(); await runTick();
    assert.deepEqual([usedFlag(a), usedFlag(b)], [0, 0]);

    // 2 tài khoản chạy cùng lúc → 2 mẫu khác nhau
    let release;
    const gate = new Promise(r => { release = r; });
    fbImpl = () => gate;
    mk({ repeat: 'daily' }); mk({ account_id: 2 });
    await runTick();
    const running = calls.slice(-2).map(c => c.content);
    assert.deepEqual([...running].sort(), ['Nội dung A', 'Nội dung B']);
    release('Đã đăng'); await settle();
    const next = tasks().find(t => t.status === 'pending' && t.repeat === 'daily');
    assert.equal(next.content_opts, opts, 'task lặp giữ nguồn mẫu');

    fbImpl = async () => 'Đã đăng';
    db.prepare('DELETE FROM templates').run();
    db.prepare("UPDATE tasks SET status = 'paused' WHERE status = 'pending'").run();
    mk(); await runTick();
    assert.match(calls.at(-1).content, /^Bản sao [AB]$/);
  });

  test('bộ chạy tắt thì không chạy gì', async () => {
    setSettings({ runner_enabled: '0' });
    const id = addTask();
    await runTick();
    assert.equal(task(id).status, 'pending');
    assert.equal(calls.length, 0);
  });
});

// =====================================================================
describe('API tạo task hàng loạt', () => {
  beforeEach(() => { reset(); addAccount('A'); addAccount('B'); });
  const bulk = body => fetch(`${BASE}/api/tasks/bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json() }));

  test('mọi tài khoản đều chạy × tất cả nội dung', async () => {
    const r = await bulk({ kind: 'post', contents: ['x', 'y'], contentMode: 'all', distribute: 'all', accountIds: [1, 2],
      targets: [{ type: 'profile' }], intervalMin: 5, startAt: Date.now() + DAY });
    assert.equal(r.body.created, 4);
    assert.deepEqual(tasks().map(t => [t.account_id, t.content]), [[1, 'x'], [1, 'y'], [2, 'x'], [2, 'y']]);
  });

  test('chế độ ảnh: "tất cả" quá 10 ảnh bị từ chối, "ngẫu nhiên" tự giới hạn số ảnh', async () => {
    const pool = Array.from({ length: 12 }, (_, i) => `${i}.jpg`);
    const base = { kind: 'post', contents: ['x'], accountIds: [1], targets: [{ type: 'profile' }], images: pool };
    let r = await bulk({ ...base, imageMode: 'all' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /tối đa 10 ảnh/);
    r = await bulk({ ...base, imageMode: 'random', imageMin: 5, imageMax: 99 });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(tasks()[0].image_opts), { mode: 'random', min: 5, max: 10, shuffle: false });
    r = await bulk({ ...base, images: Array(51).fill('a.jpg'), imageMode: 'random' });
    assert.match(r.body.error, /tối đa 50/);
  });

  test('API mẫu ảnh: CRUD, kiểm tra mẫu không tồn tại / rỗng, bình luận giới hạn 1 ảnh mỗi mẫu', async () => {
    const call = (url, method, body) => fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
      .then(async r => ({ status: r.status, body: await r.json() }));
    let r = await call('/api/image-templates', 'POST', { name: 'Mẫu 1', images: ['x.jpg', 'x.jpg', '../../y.jpg'], default_max: 50 });
    const id = r.body.id;
    let [tpl] = (await call('/api/image-templates', 'GET')).body;
    assert.deepEqual(tpl.images, ['x.jpg', 'y.jpg'], 'bỏ trùng và chặn đường dẫn');
    assert.equal(tpl.default_max, 10);
    await call(`/api/image-templates/${id}`, 'PUT', { name: 'Mẫu đổi tên' });
    [tpl] = (await call('/api/image-templates', 'GET')).body;
    assert.equal(tpl.name, 'Mẫu đổi tên');
    assert.equal(tpl.images.length, 2);

    const empty = (await call('/api/image-templates', 'POST', { name: 'Rỗng' })).body.id;
    const base = { contents: ['x'], accountIds: [1] };
    r = await bulk({ ...base, kind: 'post', targets: [{ type: 'profile' }], imageTemplates: [{ id: 999, max: 1 }] });
    assert.match(r.body.error, /không tồn tại/);
    r = await bulk({ ...base, kind: 'post', targets: [{ type: 'profile' }], imageTemplates: [{ id: empty, max: 1 }] });
    assert.match(r.body.error, /chưa có ảnh/);
    r = await bulk({ ...base, kind: 'comment', targets: [{ type: 'post', url: 'https://www.facebook.com/p/1' }], imageTemplates: [{ id, max: 5 }] });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(tasks()[0].image_opts).templates[0].max, 1);

    await call(`/api/image-templates/${id}`, 'DELETE');
    assert.equal((await call('/api/image-templates', 'GET')).body.length, 1);
  });

  test('API nội dung từ mẫu: kiểm tra mẫu, loại mẫu, đặt lại trạng thái chưa dùng', async () => {
    const p = addContentTemplate('P', 'post', 'post', 1);
    const c = addContentTemplate('C', 'cmt', 'comment', 1);
    const base = { kind: 'post', accountIds: [1, 2], distribute: 'all', targets: [{ type: 'profile' }], contentSource: 'templates' };
    let r = await bulk({ ...base, contentTemplateIds: [] });
    assert.match(r.body.error, /Chưa chọn mẫu nội dung/);
    r = await bulk({ ...base, contentTemplateIds: [c] });
    assert.match(r.body.error, /mẫu bình luận/);
    r = await bulk({ ...base, contentTemplateIds: [999] });
    assert.match(r.body.error, /không tồn tại/);
    r = await bulk({ ...base, contentTemplateIds: [p, p], contents: ['bị bỏ qua'] });
    assert.equal(r.body.created, 2, 'mỗi tài khoản × nơi đăng 1 task');
    assert.equal(JSON.parse(tasks()[0].content_opts).templates.length, 1);

    const reset = ids => fetch(`${BASE}/api/templates/reset-usage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }).then(x => x.json());
    await reset([p]);
    assert.deepEqual([usedFlag(p), usedFlag(c)], [0, 1]);
    await reset([]);
    assert.equal(usedFlag(c), 0);
  });

  test('từ chối link không phải Facebook và bình luận không có link bài viết', async () => {
    let r = await bulk({ kind: 'post', contents: ['x'], accountIds: [1], targets: [{ type: 'group', url: 'https://evil.com/groups/1' }] });
    assert.equal(r.status, 400);
    r = await bulk({ kind: 'comment', contents: ['x'], accountIds: [1], targets: [{ type: 'profile' }] });
    assert.equal(r.status, 400);
    assert.equal(tasks().length, 0);
  });
});
