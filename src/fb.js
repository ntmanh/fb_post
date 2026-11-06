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
  photo: /^(ảnh\/video|photo\/video)$/i,
  next: /^(tiếp|next)$/i,
  post: /^(đăng|post)$/i,
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

export async function createPost(accountId, { targetType, url, content, images = [] }, { shot, log = () => {} } = {}) {
  return withBrowser(accountId, { shot }, async page => {
    const dest = targetType === 'group' ? url : `${FB}/me`;
    log(`Mở ${dest}`);
    await goto(page, dest);

    const trigger = page.getByText(targetType === 'group' ? RX.composerGroup : RX.composerProfile).first();
    await trigger.waitFor({ timeout: 20000 }).catch(() => {
      throw new FbError('NO_COMPOSER', 'Không tìm thấy khung tạo bài viết (có thể bạn chưa tham gia nhóm hoặc nhóm không cho đăng)');
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
      await page.waitForTimeout(3000 + images.length * 2000);
    }

    const next = await firstVisible(dialog.getByRole('button', { name: RX.next }));
    if (next) {
      await next.click();
      await page.waitForTimeout(1500);
    }
    const postBtn = await firstVisible(page.locator('div[role="dialog"]').getByRole('button', { name: RX.post }));
    if (!postBtn) throw new FbError('NO_POST_BUTTON', 'Không tìm thấy nút Đăng');
    await postBtn.click();
    log('Đã bấm Đăng, chờ hoàn tất');

    await dialog.waitFor({ state: 'hidden', timeout: 120000 }).catch(() => {
      throw new FbError('POST_TIMEOUT', 'Bài viết chưa được gửi sau 2 phút');
    });
    await page.waitForTimeout(2500);
    const pending = await page.getByText(/chờ phê duyệt|pending approval|đang chờ duyệt/i).first().isVisible().catch(() => false);
    return pending ? 'Đã gửi, đang chờ quản trị viên nhóm duyệt' : 'Đã đăng';
  });
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
  return withBrowser(accountId, { shot }, async page => {
    log(`Mở bài viết ${url}`);
    await goto(page, url);

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
