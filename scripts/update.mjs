// Cập nhật bản đóng gói (FB-CRM-...-win64) lên code mới nhất trên GitHub. Chạy bằng Update.bat.
//   runtime\node.exe app\scripts\update.mjs [--force]
// - Giữ nguyên data/ (database, ảnh, phiên đăng nhập).
// - Thay mã nguồn trong app/, bản cũ lưu ở app-backup/ để khôi phục nếu lỗi.
// - package-lock.json đổi → cài lại thư viện bằng npm đóng kèm trong runtime/.
// - Playwright cần Chromium bản khác → tải về ms-playwright/.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = path.dirname(APP);
const BACKUP = path.join(BASE, 'app-backup');
const COMMIT_FILE = path.join(APP, '.commit');
const FILES = ['src', 'public', 'scripts', 'package.json', 'package-lock.json', 'README.md'];
const NPM = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const PORT = process.env.PORT || 3000;
const HEADERS = { 'User-Agent': 'fb-crm-updater', Accept: 'application/vnd.github+json' };

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const exists = f => fs.existsSync(f);
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`Lệnh lỗi: ${path.basename(cmd)} ${args.join(' ')}`);
}
async function get(url) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`Không tải được ${url} (HTTP ${r.status})`);
  return r;
}
// Chỉ so sánh danh sách gói (bỏ qua khác biệt xuống dòng CRLF/LF)
const lockOf = dir => exists(path.join(dir, 'package-lock.json')) ? JSON.stringify(readJson(path.join(dir, 'package-lock.json')).packages) : '';

async function main() {
  const { repo, branch = 'main' } = readJson(path.join(APP, 'package.json')).update || {};
  if (!repo) throw new Error('package.json thiếu mục "update.repo"');

  const running = await fetch(`http://127.0.0.1:${PORT}/api/status`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
  if (running) throw new Error('Chương trình đang chạy. Hãy đóng cửa sổ Start.bat (cửa sổ đen) rồi chạy lại Update.bat.');

  console.log(`Kiểm tra bản mới trên github.com/${repo} (${branch})...`);
  const latest = await (await get(`https://api.github.com/repos/${repo}/commits/${branch}`)).json();
  const sha = latest.sha;
  const current = exists(COMMIT_FILE) ? fs.readFileSync(COMMIT_FILE, 'utf8').trim() : '';
  if (current === sha && !process.argv.includes('--force')) {
    console.log(`\nĐang dùng bản mới nhất (${sha.slice(0, 7)}). Không cần cập nhật.`);
    return;
  }
  if (current) {
    const cmp = await fetch(`https://api.github.com/repos/${repo}/compare/${current}...${sha}`, { headers: HEADERS })
      .then(r => r.ok ? r.json() : null, () => null);
    if (cmp?.commits?.length) {
      console.log(`\nCó ${cmp.commits.length} thay đổi mới:`);
      for (const c of cmp.commits) console.log(`  - ${c.commit.message.split('\n')[0]}`);
    }
  } else {
    console.log(`\nBản mới nhất: ${sha.slice(0, 7)} - ${latest.commit.message.split('\n')[0]}`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fbcrm-update-'));
  try {
    console.log('\nTải mã nguồn...');
    const zip = path.join(tmp, 'code.zip');
    fs.writeFileSync(zip, Buffer.from(await (await get(`https://codeload.github.com/${repo}/zip/${sha}`)).arrayBuffer()));
    run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-x', '-f', zip, '-C', tmp]);
    const src = fs.readdirSync(tmp, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(tmp, d.name))[0];
    if (!src || !exists(path.join(src, 'src', 'server.js'))) throw new Error('Gói tải về không đúng cấu trúc');

    const needInstall = lockOf(src) !== lockOf(APP) || !exists(path.join(APP, 'node_modules'));
    if (needInstall && !exists(NPM)) {
      throw new Error('Bản mới cần cài lại thư viện nhưng gói đang dùng không có npm đi kèm. Hãy cài gói đầy đủ (zip) mới nhất.');
    }

    console.log('Sao lưu bản cũ vào app-backup...');
    fs.rmSync(BACKUP, { recursive: true, force: true });
    fs.mkdirSync(BACKUP);
    const moved = [...FILES, ...(needInstall ? ['node_modules'] : [])].filter(f => exists(path.join(APP, f)));
    for (const f of moved) fs.renameSync(path.join(APP, f), path.join(BACKUP, f));
    try {
      console.log('Chép mã nguồn mới...');
      for (const f of FILES) if (exists(path.join(src, f))) fs.cpSync(path.join(src, f), path.join(APP, f), { recursive: true });
      if (needInstall) {
        console.log('\nThư viện thay đổi → cài lại (cần Internet, có thể mất vài phút)...');
        run(process.execPath, [NPM, 'ci', '--omit=dev', '--no-audit', '--no-fund'], {
          cwd: APP,
          env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', PATH: `${path.dirname(process.execPath)};${process.env.PATH}` },
        });
        ensureBrowsers();
      }
    } catch (e) {
      console.log('\nLỗi khi cập nhật → khôi phục bản cũ...');
      for (const f of [...FILES, 'node_modules']) {
        if (!exists(path.join(BACKUP, f))) continue;
        fs.rmSync(path.join(APP, f), { recursive: true, force: true });
        fs.renameSync(path.join(BACKUP, f), path.join(APP, f));
      }
      throw e;
    }
    fs.writeFileSync(COMMIT_FILE, sha);
    console.log(`\n✔ Đã cập nhật lên ${sha.slice(0, 7)}. Bấm đúp Start.bat để chạy.`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Playwright mới có thể cần Chromium bản khác → tải về thư mục ms-playwright của gói
function ensureBrowsers() {
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(BASE, 'ms-playwright');
  const need = readJson(path.join(APP, 'node_modules', 'playwright-core', 'browsers.json')).browsers
    .filter(b => ['chromium', 'chromium-headless-shell'].includes(b.name))
    .map(b => `${b.name.replace(/-/g, '_')}-${b.revision}`);
  if (need.every(d => exists(path.join(dir, d)))) return;
  console.log('\nTải Chromium bản mới cho Playwright...');
  run(process.execPath, [path.join(APP, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir },
  });
}

main().catch(e => {
  console.error(`\n✖ ${e.message || e}`);
  process.exitCode = 1;
});
