// Tự động hoá Facebook qua trình duyệt thật (Playwright).
// Mỗi tài khoản có 1 thư mục profile Chromium riêng trong data/profiles/<id> để giữ phiên đăng nhập.
import { chromium } from 'playwright';
import path from 'node:path';
import { PROFILE_DIR, SHOT_DIR, getSettings } from './db.js';

const FB = 'https://www.facebook.com';
const busy = new Set(); // id tài khoản đang mở trình duyệt

const RX = {
  composerProfile: /bạn đang nghĩ gì|what's on your mind/i,
  composerGroup: /bạn viết gì đi|viết gì đó|write something|tạo bài viết công khai|create a public post/i,
  // Trang (New Pages Experience): phải chuyển sang Trang thì mới đăng được với tư cách Trang
  switchPage: /^(chuyển ngay|chuyển|chuyển sang trang|switch now|switch|switch to page)$/i,
  photo: /^(ảnh\/video|photo\/video)$/i,
  next: /^(tiếp|next)$/i,
  post: /^(đăng|post)$/i,
  nextOrPost: /^(tiếp|next|đăng|post)$/i,
  posting: /đang đăng|posting/i,
  // Popup gợi ý quảng bá hiện sau khi bấm Đăng (hay gặp khi đăng lên Trang): "Bạn đang tổ chức sự kiện?",
  // "Quảng cáo bài viết?"… Bài chỉ được tạo khi chọn đăng bài gốc ("Tiếp tục" dẫn sang màn tạo quảng cáo).
  postOriginal: /^(đăng bài viết gốc|đăng bài gốc|chỉ đăng bài viết|post original(?: post)?|share original post|không phải bây giờ|not now)$/i,
  // tên GraphQL mutation tạo bài (fb_api_req_friendly_name), ví dụ ComposerStoryCreateMutation
  createMutation: /StoryCreate|PostCreate|CreatePost/i, // không khớp ComposerStoryEditMutation (sửa bài)
  commentBtn: /^(bình luận|comment|viết bình luận|leave a comment)$/i,
  commentBox: /bình luận|comment|trả lời|reply/i,
};

export class FbError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const isBusy = id => busy.has(id);

async function launch(accountId, headless) {
  return chromium.launchPersistentContext(path.join(PROFILE_DIR, String(accountId)), {
    headless,
    viewport: { width: 1280, height: 900 },
    locale: 'vi-VN',
    args: ['--disable-notifications'],
  });
}

async function withBrowser(accountId, { headless, shot } = {}, fn) {
  if (busy.has(accountId)) throw new FbError('BUSY', 'Tài khoản đang mở trình duyệt cho tác vụ khác');
  busy.add(accountId);
  const ctx = await launch(accountId, headless ?? getSettings().headless === '1').catch(e => {
    busy.delete(accountId);
    throw e;
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  try {
    return await fn(page, ctx);
  } catch (e) {
    if (shot) {
      e.shot = `${shot}.png`;
      await page.screenshot({ path: path.join(SHOT_DIR, e.shot) }).catch(() => { e.shot = null; });
    }
    throw e;
  } finally {
    await ctx.close().catch(() => {});
    busy.delete(accountId);
  }
}

async function uidFromCookies(ctx) {
  const cookies = await ctx.cookies(FB);
  return cookies.find(c => c.name === 'c_user')?.value || null;
}

async function assertLoggedIn(page) {
  const url = page.url();
  if (/checkpoint/.test(url)) throw new FbError('CHECKPOINT', 'Tài khoản bị checkpoint, cần xác minh thủ công');
  if (/\/login/.test(url) || await page.locator('input[name="email"]').first().isVisible().catch(() => false)) {
    throw new FbError('EXPIRED', 'Phiên đăng nhập đã hết hạn, hãy đăng nhập lại');
  }
}

async function goto(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  await assertLoggedIn(page);
}

// Gõ nhiều dòng: Enter trong khung đăng bài, Shift+Enter trong khung bình luận (Enter = gửi)
async function typeText(page, text, newlineKey) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.keyboard.insertText(lines[i]);
    if (i < lines.length - 1) await page.keyboard.press(newlineKey);
  }
}

async function firstVisible(locator) {
  const n = await locator.count();
  for (let i = 0; i < n; i++) {
    const el = locator.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

const buttonLabel = async el => ((await el.getAttribute('aria-label').catch(() => null)) || (await el.innerText().catch(() => ''))).trim();

// Chờ tới khi có nút (trong hộp thoại) khớp tên, đang hiện và bấm được; timeout 0 = kiểm tra 1 lần
async function waitDialogButton(page, name, timeout) {
  const end = Date.now() + timeout;
  for (;;) {
    const btns = page.locator('div[role="dialog"]').getByRole('button', { name });
    const n = await btns.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = btns.nth(i);
      if (await el.isVisible().catch(() => false) && await el.getAttribute('aria-disabled').catch(() => null) !== 'true') return el;
    }
    if (Date.now() >= end) return null;
    await page.waitForTimeout(500);
  }
}

// Popup gợi ý quảng bá sau khi bấm Đăng → bấm "Đăng bài viết gốc" để Facebook tạo bài
async function skipUpsell(page, log) {
  const dialogs = page.locator('div[role="dialog"]');
  const btn = await firstVisible(dialogs.getByRole('button', { name: RX.postOriginal }))
    || await firstVisible(dialogs.getByRole('link', { name: RX.postOriginal }));
  if (!btn) return false;
  const label = await buttonLabel(btn);
  await btn.click();
  log(`Facebook hiện gợi ý quảng bá, đã bấm "${label}"`);
  await page.waitForTimeout(1000);
  return true;
}

// Sau khi bấm Đăng: chờ tới khi không còn nút Đăng/Tiếp và không còn hộp thoại "Đang đăng…"
async function waitPosted(page, timeout, log) {
  const end = Date.now() + timeout;
  const dialogs = page.locator('div[role="dialog"]');
  while (Date.now() < end) {
    if (await skipUpsell(page, log)) continue;
    const busy = await firstVisible(dialogs.getByRole('button', { name: RX.nextOrPost }))
      || await firstVisible(dialogs.filter({ hasText: RX.posting }));
    if (!busy) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

// ---------- Đăng nhập ----------

// Mở trình duyệt có giao diện để người dùng tự đăng nhập; tự đóng khi phát hiện đã đăng nhập.
export async function interactiveLogin(accountId, { timeoutMs = 5 * 60 * 1000 } = {}) {
  return withBrowser(accountId, { headless: false }, async (page, ctx) => {
    await page.goto(FB, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (page.isClosed()) break;
      const uid = await uidFromCookies(ctx);
      if (uid && !/login|checkpoint|two_step/.test(page.url())) {
        await page.waitForTimeout(2000);
        return uid;
      }
      await page.waitForTimeout(1500).catch(() => {});
    }
    throw new FbError('LOGIN_TIMEOUT', 'Hết thời gian chờ đăng nhập');
  });
}

// Nhập cookie xuất từ extension (Cookie-Editor / EditThisCookie) dạng JSON array
export async function importCookies(accountId, raw) {
  const list = (Array.isArray(raw) ? raw : raw?.cookies || []).map(c => {
    const sameSite = { no_restriction: 'None', none: 'None', lax: 'Lax', strict: 'Strict' }[String(c.sameSite || '').toLowerCase()] || 'Lax';
    return {
      name: c.name,
      value: String(c.value),
      domain: c.domain || '.facebook.com',
      path: c.path || '/',
      expires: Math.floor(c.expirationDate || c.expires || Date.now() / 1000 + 86400 * 90),
      httpOnly: !!c.httpOnly,
      secure: c.secure ?? true,
      sameSite,
    };
  }).filter(c => c.name && c.value);
  if (!list.length) throw new FbError('BAD_COOKIE', 'Cookie không hợp lệ');
  return withBrowser(accountId, { headless: true }, async (page, ctx) => {
    await ctx.addCookies(list);
    await goto(page, FB);
    const uid = await uidFromCookies(ctx);
    if (!uid) throw new FbError('EXPIRED', 'Cookie không đăng nhập được');
    return uid;
  });
}

export async function checkLogin(accountId) {
  return withBrowser(accountId, { headless: true }, async (page, ctx) => {
    await goto(page, FB);
    const uid = await uidFromCookies(ctx);
    if (!uid) throw new FbError('EXPIRED', 'Chưa đăng nhập');
    return uid;
  });
}

// ---------- Đăng bài ----------

// Cookie i_user = Trang mà phiên đang "đóng vai". Xoá đi để quay về trang cá nhân,
// tránh task sau (trang cá nhân / nhóm / bình luận) bị đăng nhầm dưới tên Trang.
const actAsSelf = ctx => ctx.clearCookies({ name: 'i_user' }).catch(() => {});

// Chốt chặn cho task trang cá nhân / nhóm / bình luận: phiên vẫn đang ở quyền Trang thì dừng, không đăng nhầm tên Trang
async function assertActingAsSelf(page) {
  if ((await page.context().cookies(FB)).some(c => c.name === 'i_user')) {
    throw new FbError('ACTING_AS_PAGE', 'Phiên đang ở quyền Trang, không tự chuyển về trang cá nhân được nên dừng để tránh đăng nhầm dưới tên Trang. Vào Tài khoản > Đăng nhập, chuyển về trang cá nhân thủ công rồi chạy lại.');
  }
}

// Banner "Chuyển sang Trang của … để bắt đầu quản lý. [Chuyển ngay]"
async function findSwitchButton(page) {
  return await firstVisible(page.getByRole('button', { name: RX.switchPage }))
    || await firstVisible(page.getByRole('link', { name: RX.switchPage }))
    || await firstVisible(page.getByText(/^(chuyển ngay|switch now)$/i));
}

// Mở Trang; nếu có nút "Chuyển ngay" thì bấm để chuyển sang quyền Trang rồi mở lại Trang
async function openPageAsAdmin(page, url, log) {
  await goto(page, url);
  const btn = await findSwitchButton(page);
  if (!btn) return log('Không thấy nút "Chuyển ngay" (Trang kiểu cũ hoặc tài khoản không có quyền quản trị)');
  log('Bấm "Chuyển ngay" để chuyển sang quyền Trang');
  await btn.click();
  await page.waitForTimeout(2000);
  // một số tài khoản có thêm hộp thoại xác nhận "Chuyển sang <Trang>?"
  const confirm = await firstVisible(page.locator('div[role="dialog"]').getByRole('button', { name: RX.switchPage }));
  if (confirm) await confirm.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(4000);
  await goto(page, url);
  if (await findSwitchButton(page)) {
    throw new FbError('SWITCH_FAILED', 'Không chuyển được sang quyền Trang (nút "Chuyển ngay" vẫn còn). Kiểm tra tài khoản có quyền quản trị Trang');
  }
  log('Đã chuyển sang quyền Trang');
}

export async function createPost(accountId, { targetType, url, content, images = [] }, { shot, log = () => {} } = {}) {
  return withBrowser(accountId, { shot }, async (page, ctx) => {
    await actAsSelf(ctx);
    try {
      return await postIn(page, { targetType, url, content, images }, log);
    } finally {
      if (targetType === 'page') await actAsSelf(ctx);
    }
  });
}

// export để test với trang Facebook giả (test/fb.test.mjs)
export async function postIn(page, opts, log) {
  const net = netWatch(page);
  try {
    return await composeAndPost(page, opts, log, net);
  } finally {
    net.stop();
  }
}

async function composeAndPost(page, { targetType, url, content, images }, log, net) {
  const dest = targetType === 'profile' ? `${FB}/me` : url;
  log(`Mở ${dest}`);
  if (targetType === 'page') await openPageAsAdmin(page, dest, log);
  else {
    await goto(page, dest);
    await assertActingAsSelf(page);
  }

  const trigger = page.getByText(targetType === 'group' ? RX.composerGroup : RX.composerProfile).first();
  await trigger.waitFor({ timeout: 20000 }).catch(() => {
    throw new FbError('NO_COMPOSER', targetType === 'page'
      ? 'Không tìm thấy khung tạo bài viết trên Trang (tài khoản cần là quản trị viên hoặc có quyền đăng bài của Trang)'
      : 'Không tìm thấy khung tạo bài viết (có thể bạn chưa tham gia nhóm hoặc nhóm không cho đăng)');
  });
  await trigger.click();

  const dialog = page.locator('div[role="dialog"]').filter({ has: page.locator('div[contenteditable="true"][role="textbox"]') }).last();
  await dialog.waitFor({ timeout: 20000 });
  const box = dialog.locator('div[contenteditable="true"][role="textbox"]').first();
  await box.click();
  await typeText(page, content, 'Enter');
  log('Đã nhập nội dung');

  if (images.length) {
    let input = dialog.locator('input[type="file"]').first();
    if (!await input.count()) {
      await dialog.getByRole('button', { name: RX.photo }).first().click().catch(() => {});
      await page.waitForTimeout(1200);
      input = dialog.locator('input[type="file"]').first();
    }
    if (!await input.count()) input = page.locator('input[type="file"][accept*="image"]').last();
    await input.setInputFiles(images);
    log(`Đang tải ${images.length} ảnh/video`);
    // Nút Đăng bấm được ngay cả khi ảnh chưa tải xong → phải chờ request tải ảnh kết thúc
    await page.waitForTimeout(2000);
    if (!await net.uploadsDone(60000 + images.length * 20000)) {
      throw new FbError('UPLOAD_TIMEOUT', 'Ảnh/video tải lên Facebook quá lâu, chưa đăng');
    }
    await page.waitForTimeout(1500);
    log('Đã tải xong ảnh/video');
  }

  // Có tài khoản (chế độ chuyên nghiệp, Trang) bấm "Tiếp" sang màn "Cài đặt bài viết" rồi mới có nút "Đăng".
  // Màn đó tải chậm, và nút bị vô hiệu hoá khi ảnh còn đang tải lên, nên phải chờ nút bấm được.
  let btn = await waitDialogButton(page, RX.nextOrPost, 30000 + images.length * 5000);
  if (btn && RX.next.test(await buttonLabel(btn))) {
    await btn.click();
    log('Đã bấm Tiếp, chờ màn Cài đặt bài viết');
    btn = await waitDialogButton(page, RX.post, 30000);
  }
  if (!btn) throw new FbError('NO_POST_BUTTON', 'Không tìm thấy nút Đăng (hoặc nút vẫn bị vô hiệu hoá sau thời gian chờ)');
  net.markPosted();
  await btn.click();
  log('Đã bấm Đăng, chờ Facebook xác nhận');

  // Hộp thoại đóng ngay nhưng Facebook vẫn gửi bài ở nền: đóng trình duyệt lúc này là mất bài.
  // Chờ request tạo bài (GraphQL mutation) trả về rồi mới coi là xong.
  let created = null;
  for (const end = Date.now() + 90000; !created && Date.now() < end;) {
    created = await net.waitCreated(1000);
    if (!created) await skipUpsell(page, log);
  }
  let note = '';
  if (created) {
    const err = createError(created);
    if (err) throw new FbError('POST_FAILED', `Facebook từ chối bài viết: ${err}`);
    log(`Facebook đã xác nhận tạo bài (${created.name})`);
  } else {
    log(`Chưa thấy xác nhận tạo bài từ Facebook, chờ thêm cho chắc. Request sau khi bấm Đăng: ${net.namesAfterPost().slice(0, 15).join(', ') || '(không có)'}`);
    note = ' (chưa xác nhận được, hãy kiểm tra lại trên Facebook)';
  }
  if (!await waitPosted(page, created ? 30000 : 120000, log) && !created) {
    throw new FbError('POST_TIMEOUT', 'Bài viết chưa được gửi sau 2 phút');
  }
  await net.uploadsDone(30000);
  await page.waitForTimeout(created ? 3000 : 15000);
  if (targetType === 'page') return `Đã đăng lên Trang${note}`;
  const pending = await page.getByText(/chờ phê duyệt|pending approval|đang chờ duyệt/i).first().isVisible().catch(() => false);
  return (pending ? 'Đã gửi, đang chờ quản trị viên nhóm duyệt' : 'Đã đăng') + note;
}

// Phản hồi mutation tạo bài có lỗi và không có bài nào được tạo → trả về thông báo lỗi
function createError({ status, body }) {
  if (status >= 400) return `HTTP ${status}`;
  if (/"errors"\s*:\s*\[/.test(body) && !/"(story|story_id|post_id)"\s*:/.test(body)) {
    return /"(?:description|message|summary)"\s*:\s*"([^"]{1,200})"/.exec(body)?.[1] || 'lỗi không rõ';
  }
  return null;
}

// Theo dõi request của trang: ảnh đang tải lên, và mutation tạo bài sau khi bấm Đăng
function netWatch(page) {
  const uploads = new Set(), names = [], created = [];
  let postedAt = Infinity;
  const friendly = req => {
    if (req.method() !== 'POST' || !/\/api\/graphql/.test(req.url())) return null;
    const m = /(?:^|&)fb_api_req_friendly_name=([^&]+)/.exec(req.postData() || '');
    return m ? decodeURIComponent(m[1]) : null;
  };
  const onReq = req => {
    if (req.method() === 'POST' && /upload\.facebook\.com|\/upload\//.test(req.url())) uploads.add(req);
    const name = friendly(req);
    if (name && Date.now() >= postedAt) names.push(name);
  };
  const onEnd = req => { uploads.delete(req); };
  const onRes = async res => {
    const name = friendly(res.request());
    if (name && Date.now() >= postedAt && RX.createMutation.test(name)) {
      created.push({ name, status: res.status(), body: await res.text().catch(() => '') });
    }
  };
  page.on('request', onReq);
  page.on('requestfinished', onEnd);
  page.on('requestfailed', onEnd);
  page.on('response', onRes);
  const until = async (ok, timeout) => {
    const end = Date.now() + timeout;
    while (!ok() && Date.now() < end) await page.waitForTimeout(500);
    return ok();
  };
  return {
    markPosted() { postedAt = Date.now(); },
    namesAfterPost: () => names,
    uploadsDone: timeout => until(() => !uploads.size, timeout),
    waitCreated: async timeout => (await until(() => created.length > 0, timeout)) ? created[0] : null,
    stop() {
      page.off('request', onReq);
      page.off('requestfinished', onEnd);
      page.off('requestfailed', onEnd);
      page.off('response', onRes);
    },
  };
}

// ---------- Bình luận ----------

async function findCommentBox(page) {
  const all = page.locator('div[contenteditable="true"][role="textbox"]');
  const n = await all.count();
  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    const label = (await el.getAttribute('aria-label').catch(() => '')) || '';
    if (RX.commentBox.test(label) && await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

export async function comment(accountId, { url, content, images = [] }, { shot, log = () => {} } = {}) {
  return withBrowser(accountId, { shot }, async (page, ctx) => {
    await actAsSelf(ctx);
    log(`Mở bài viết ${url}`);
    await goto(page, url);
    await assertActingAsSelf(page);

    let box = await findCommentBox(page);
    if (!box) {
      const btn = await firstVisible(page.getByRole('button', { name: RX.commentBtn }));
      if (btn) {
        await btn.click();
        await page.waitForTimeout(2000);
        box = await findCommentBox(page);
      }
    }
    if (!box) throw new FbError('NO_COMMENT_BOX', 'Không tìm thấy ô bình luận (bài viết có thể đã tắt bình luận hoặc không có quyền xem)');

    await box.scrollIntoViewIfNeeded();
    await box.click();
    await typeText(page, content, 'Shift+Enter');
    log('Đã nhập bình luận');

    if (images.length) {
      const input = box.locator('xpath=ancestor::form[1]//input[@type="file"]').first();
      if (await input.count()) {
        await input.setInputFiles(images[0]);
        log('Đang tải ảnh bình luận');
        await page.waitForTimeout(4000);
      } else {
        log('Không tìm thấy nút đính kèm ảnh, chỉ gửi chữ');
      }
    }

    await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);
    const left = (await box.innerText().catch(() => '')).trim();
    if (left && content.includes(left.slice(0, 30))) {
      throw new FbError('COMMENT_NOT_SENT', 'Bình luận chưa được gửi');
    }
    return 'Đã bình luận';
  });
}
