// Kiểm tra luồng đăng bài của fb.js trên trang Facebook giả (chặn request tới facebook.com).
// Mô phỏng các trường hợp gây lỗi "Không tìm thấy nút Đăng": màn "Cài đặt bài viết" tải chậm sau khi bấm Tiếp,
// nút Đăng bị vô hiệu hoá trong lúc tải ảnh.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fbcrm-fb-'));
process.env.DATA_DIR = TMP;
const { postIn } = await import('../src/fb.js');
const { db } = await import('../src/db.js');

// opts.next: có bước "Tiếp" → "Cài đặt bài viết"; opts.loadMs: thời gian màn đó tải;
// opts.disabledMs: nút Đăng bị vô hiệu hoá bao lâu; opts.postingMs: thời gian "Đang đăng…"
// Giống Facebook thật: bấm Đăng thì hộp thoại đóng, bài được gửi ở nền qua GraphQL mutation
// (route trả về sau opts.mutationMs); ảnh tải lên upload.facebook.com (route trả về sau opts.uploadMs)
const fakeFb = opts => `<!doctype html><meta charset="utf-8"><body>
<div id="composer">Bạn đang nghĩ gì?</div>
<script>
const o = ${JSON.stringify(opts)};
window.clicks = [];
function send(d) {
  d.innerHTML = '<div>Đang đăng...</div>';
  setTimeout(() => d.remove(), o.postingMs || 0);
  fetch('/api/graphql/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'av=1&fb_api_req_friendly_name=ComposerStoryCreateMutation&variables=%7B%7D' })
    .then(r => r.text()).then(() => { window.done = true; });
}
// Popup gợi ý quảng bá (Trang): bài chỉ được tạo khi bấm "Đăng bài viết gốc"; nút Đăng phía sau bị mờ
function upsell(d, b) {
  b.setAttribute('aria-disabled', 'true');
  const u = document.createElement('div');
  u.setAttribute('role', 'dialog');
  u.innerHTML = '<b>Bạn đang tổ chức sự kiện?</b><div role="button" id="orig">Đăng bài viết gốc</div><div role="button" id="cont">Tiếp tục</div>';
  setTimeout(() => document.body.append(u), o.upsellMs || 0);
  u.querySelector('#orig').onclick = () => { window.clicks.push('original'); u.remove(); send(d); };
  u.querySelector('#cont').onclick = () => window.clicks.push('continue');
}
function postButton(d) {
  const b = document.createElement('div');
  b.setAttribute('role', 'button'); b.textContent = 'Đăng';
  if (o.disabledMs) { b.setAttribute('aria-disabled', 'true'); setTimeout(() => b.removeAttribute('aria-disabled'), o.disabledMs); }
  b.onclick = () => {
    if (b.getAttribute('aria-disabled') === 'true') return window.clicks.push('disabled');
    window.clicks.push(window.uploading ? 'post-before-upload-done' : 'post');
    window.posted = document.querySelector('[role=textbox]')?.innerText ?? window.typed;
    if (o.upsell) return upsell(d, b);
    send(d);
  };
  d.append(b);
}
// Trang (New Pages Experience): tài khoản cá nhân chỉ thấy banner "Chuyển ngay", chưa có khung đăng bài.
// Bấm chuyển → Facebook đặt cookie i_user rồi tải lại; switchFails = bấm không có tác dụng
if (o.page && !document.cookie.includes('i_user=')) {
  document.body.innerHTML = '<div>Chuyển sang Trang của Shop để bắt đầu quản lý.</div><div role="button" id="sw">Chuyển ngay</div>';
  document.getElementById('sw').onclick = () => {
    if (o.switchFails) return;
    document.cookie = 'i_user=999; path=/';
    location.reload();
  };
} else composer.onclick = () => {
  const d = document.createElement('div');
  d.setAttribute('role', 'dialog');
  d.innerHTML = '<div contenteditable="true" role="textbox" aria-label="Tạo bài viết"></div><input type="file" multiple>';
  document.body.append(d);
  d.querySelector('input').onchange = () => {
    window.uploading = true;
    fetch('https://upload.facebook.com/ajax/react_composer/attachments/photo/upload', { method: 'POST', body: 'x' })
      .then(() => { window.uploading = false; window.uploaded = true; });
  };
  if (!o.next) return postButton(d);
  const n = document.createElement('div');
  n.setAttribute('role', 'button'); n.textContent = 'Tiếp';
  n.onclick = () => {
    window.clicks.push('next');
    window.typed = d.querySelector('[role=textbox]').innerText;
    d.innerHTML = '<h2>Cài đặt bài viết</h2><div class="skeleton">...</div>';
    setTimeout(() => postButton(d), o.loadMs);
  };
  d.append(n);
};
</script>`;

describe('fb.js: đăng bài trên trang Facebook giả', () => {
  let browser;
  before(async () => { browser = await chromium.launch(); });
  after(async () => {
    await browser?.close();
    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  const DONE = '{"data":{"story_create":{"story":{"id":"123"}}}}';
  async function run(opts, { targetType = 'profile', url, cookies = [], images = [] } = {}) {
    const ctx = await browser.newContext();
    if (cookies.length) await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    const later = (ms, fn) => new Promise(res => setTimeout(() => res(fn()), ms || 0));
    await page.route('https://upload.facebook.com/**', r => later(opts.uploadMs, () => r.fulfill({ body: '{}' })));
    await page.route('https://www.facebook.com/**', r => r.request().method() === 'POST'
      ? later(opts.mutationMs, () => r.fulfill({ contentType: 'application/json', body: opts.mutationBody || DONE }))
      : r.fulfill({ contentType: 'text/html; charset=utf-8', body: fakeFb(opts) }));
    const logs = [];
    try {
      const result = await postIn(page, { targetType, url, content: 'Dòng 1\nDòng 2', images }, m => logs.push(m));
      const state = await page.evaluate(() => ({ clicks: window.clicks, posted: window.posted, done: !!window.done, uploaded: !!window.uploaded }));
      return { result, logs, ...state, iUser: (await ctx.cookies('https://www.facebook.com')).find(c => c.name === 'i_user')?.value };
    } finally {
      await ctx.close();
    }
  }
  const SHOP = 'https://www.facebook.com/shoptest';

  test('bấm Tiếp → màn "Cài đặt bài viết" tải chậm 3 giây → vẫn tìm được nút Đăng', async () => {
    const r = await run({ next: true, loadMs: 3000, postingMs: 1500 });
    assert.equal(r.result, 'Đã đăng');
    assert.deepEqual(r.clicks, ['next', 'post']);
    assert.equal(r.posted, 'Dòng 1\nDòng 2');
    assert.ok(r.done, 'chờ tới khi đăng xong mới trả kết quả');
    assert.ok(r.logs.includes('Đã bấm Tiếp, chờ màn Cài đặt bài viết'));
  });

  test('nút Đăng bị vô hiệu hoá 2 giây (đang tải ảnh) → chờ tới khi bấm được', async () => {
    const r = await run({ next: false, disabledMs: 2000, postingMs: 500 });
    assert.equal(r.result, 'Đã đăng');
    assert.deepEqual(r.clicks, ['post'], 'không bấm khi nút còn bị vô hiệu hoá');
    assert.ok(r.done);
  });

  test('hộp thoại đóng ngay nhưng Facebook xác nhận chậm 4 giây → chờ xác nhận rồi mới xong', async () => {
    const r = await run({ mutationMs: 4000 });
    assert.ok(r.done, 'không trả kết quả (và đóng trình duyệt) khi bài còn đang gửi');
    assert.equal(r.result, 'Đã đăng');
    assert.ok(r.logs.includes('Facebook đã xác nhận tạo bài (ComposerStoryCreateMutation)'));
  });

  test('ảnh tải lên chậm 4 giây → chờ tải xong rồi mới bấm Đăng', async () => {
    const img = path.join(TMP, 'a.png');
    fs.writeFileSync(img, Buffer.from('89504e470d0a1a0a', 'hex'));
    const r = await run({ uploadMs: 4000 }, { images: [img] });
    assert.deepEqual(r.clicks, ['post'], 'không bấm Đăng khi ảnh chưa tải xong');
    assert.ok(r.uploaded && r.done);
    assert.ok(r.logs.includes('Đã tải xong ảnh/video'));
  });

  test('Facebook trả lỗi khi tạo bài → báo lỗi, không coi là đã đăng', async () => {
    const body = '{"errors":[{"message":"Bạn tạm thời bị chặn","severity":"CRITICAL"}],"data":null}';
    await assert.rejects(run({ mutationBody: body }), e => e.code === 'POST_FAILED' && /tạm thời bị chặn/.test(e.message));
  });

  test('Trang: bấm "Chuyển ngay" sang quyền Trang rồi mới đăng', async () => {
    const r = await run({ page: true, postingMs: 300 }, { targetType: 'page', url: SHOP });
    assert.equal(r.result, 'Đã đăng lên Trang');
    assert.equal(r.iUser, '999', 'đã chuyển sang quyền Trang');
    assert.deepEqual(r.clicks, ['post']);
    assert.ok(r.logs.includes('Đã chuyển sang quyền Trang'));
  });

  test('Trang: bấm Đăng hiện popup "Bạn đang tổ chức sự kiện?" → bấm "Đăng bài viết gốc"', async () => {
    const r = await run({ page: true, next: true, loadMs: 300, upsell: true, upsellMs: 1500 }, { targetType: 'page', url: SHOP });
    assert.equal(r.result, 'Đã đăng lên Trang');
    assert.deepEqual(r.clicks, ['next', 'post', 'original'], 'không bấm "Tiếp tục" (sang màn quảng cáo)');
    assert.ok(r.done);
    assert.ok(r.logs.includes('Facebook hiện gợi ý quảng bá, đã bấm "Đăng bài viết gốc"'));
  });

  test('Trang: bấm "Chuyển ngay" không có tác dụng → báo lỗi, không đăng', async () => {
    await assert.rejects(run({ page: true, switchFails: true }, { targetType: 'page', url: SHOP }), e => e.code === 'SWITCH_FAILED');
  });

  test('trang cá nhân / nhóm: phiên còn ở quyền Trang → dừng, không đăng nhầm tên Trang', async () => {
    const cookies = [{ name: 'i_user', value: '999', domain: '.facebook.com', path: '/' }];
    await assert.rejects(run({}, { cookies }), e => e.code === 'ACTING_AS_PAGE');
    await assert.rejects(run({}, { targetType: 'group', url: 'https://www.facebook.com/groups/1/', cookies }), e => e.code === 'ACTING_AS_PAGE');
  });
});
