// Đóng gói bản chạy ngay cho Windows (không cần cài Node.js / Chromium trên máy đích).
// Chạy: npm run build  →  dist/FB-CRM-<version>-win64.zip
//
// Cấu trúc gói:
//   Start.bat              bấm đúp để chạy
//   Update.bat             cập nhật code mới nhất từ GitHub (scripts/update.mjs)
//   HUONG-DAN-CAI-DAT.txt
//   app/                   mã nguồn + node_modules (chỉ dependencies)
//   runtime/node.exe       Node.js portable (bản đang dùng để build) + npm (để Update.bat cài lại thư viện)
//   ms-playwright/         Chromium cho Playwright
//   data/                  tạo khi chạy lần đầu (database, ảnh, phiên đăng nhập)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME = `FB-CRM-${pkg.version}-win64`;
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, NAME);
const ZIP = path.join(DIST, `${NAME}.zip`);

const step = m => console.log(`\n▶ ${m}`);
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' && !path.isAbsolute(cmd), ...opts });
  if (r.status !== 0) throw new Error(`Lệnh lỗi: ${cmd} ${args.join(' ')}`);
}
const copy = (from, to) => fs.cpSync(from, to, { recursive: true });
// Notepad trên Windows đọc UTF-8 có BOM chắc chắn đúng tiếng Việt; .bat dùng CRLF
const writeText = (file, text, { bom = false } = {}) =>
  fs.writeFileSync(file, (bom ? '\uFEFF' : '') + text.replace(/\r?\n/g, '\r\n'), 'utf8');

if (process.platform !== 'win32') throw new Error('Script này đóng gói bản Windows, hãy chạy trên Windows');
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) throw new Error(`Cần Node.js ≥ 22.13 để build (đang dùng ${process.version})`);

step(`Dọn ${path.relative(ROOT, OUT)}`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(ZIP, { force: true });
fs.mkdirSync(OUT, { recursive: true });

step('Chép mã nguồn');
const APP = path.join(OUT, 'app');
for (const f of ['src', 'public', 'scripts', 'package.json', 'package-lock.json', 'README.md']) copy(path.join(ROOT, f), path.join(APP, f));
// Ghi commit đang build để Update.bat biết đã là bản mới nhất chưa (chỉ khi code khớp đúng commit đó)
const git = args => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const head = git(['rev-parse', 'HEAD']).stdout?.trim();
const dirty = git(['status', '--porcelain', '--', ...['src', 'public', 'scripts', 'package.json', 'package-lock.json']]).stdout?.trim();
if (head && !dirty) fs.writeFileSync(path.join(APP, '.commit'), head);
else console.log('  Code chưa commit hết → lần chạy Update.bat đầu tiên sẽ tải bản mới nhất trên GitHub');

step('Cài thư viện (chỉ dependencies, không gồm devDependencies)');
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline'], {
  cwd: APP,
  env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
});

step(`Chép Node.js ${process.version} portable`);
fs.mkdirSync(path.join(OUT, 'runtime'));
fs.copyFileSync(process.execPath, path.join(OUT, 'runtime', 'node.exe'));
copy(path.join(path.dirname(process.execPath), 'node_modules', 'npm'), path.join(OUT, 'runtime', 'node_modules', 'npm'));

step('Chép Chromium cho Playwright');
const BROWSERS = path.join(OUT, 'ms-playwright');
const need = JSON.parse(fs.readFileSync(path.join(APP, 'node_modules/playwright-core/browsers.json'), 'utf8')).browsers
  .filter(b => ['chromium', 'chromium-headless-shell', 'ffmpeg', 'winldd'].includes(b.name))
  .map(b => `${b.name.replace(/-/g, '_')}-${b.revision}`);
const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
const missing = need.filter(d => !fs.existsSync(path.join(cache, d)));
if (missing.length) {
  console.log(`  Không có sẵn trong ${cache}: ${missing.join(', ')} → tải về`);
  run(path.join(OUT, 'runtime', 'node.exe'), [path.join(APP, 'node_modules/playwright/cli.js'), 'install', 'chromium'], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS },
  });
}
for (const d of need) {
  if (fs.existsSync(path.join(BROWSERS, d))) continue;
  console.log(`  ${d}`);
  copy(path.join(cache, d), path.join(BROWSERS, d));
}

step('Tạo Start.bat và hướng dẫn');
writeText(path.join(OUT, 'Start.bat'), `@echo off
chcp 65001 >nul
title FB CRM Studio
cd /d "%~dp0"

rem Đổi cổng nếu 3000 đã bị phần mềm khác dùng
set PORT=3000

set "DATA_DIR=%~dp0data"
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0ms-playwright"

echo Dang khoi dong FB CRM Studio tai http://localhost:%PORT% ...
echo Giu cua so nay mo trong khi su dung. Dong cua so = tat chuong trinh.
echo.
start "" /b cmd /c "ping -n 4 127.0.0.1 >nul & start http://localhost:%PORT%"
"%~dp0runtime\\node.exe" "%~dp0app\\src\\server.js"

echo.
echo Chuong trinh da dung. Neu co loi, chup man hinh cua so nay de gui ho tro.
pause
`);
writeText(path.join(OUT, 'Update.bat'), `@echo off
chcp 65001 >nul
title FB CRM Studio - Cap nhat
cd /d "%~dp0"
set PORT=3000
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0ms-playwright"
"%~dp0runtime\\node.exe" "%~dp0app\\scripts\\update.mjs" %*
echo.
pause
`);
writeText(path.join(OUT, 'HUONG-DAN-CAI-DAT.txt'), guide(), { bom: true });

step('Nén zip');
// tar.exe của Windows (bsdtar) nén được zip và nhanh hơn Compress-Archive
run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', ZIP, '-C', DIST, NAME]);

const mb = b => `${(b / 1048576).toFixed(0)} MB`;
const dirSize = d => fs.readdirSync(d, { withFileTypes: true, recursive: true })
  .filter(e => e.isFile()).reduce((s, e) => s + fs.statSync(path.join(e.parentPath, e.name)).size, 0);
console.log(`\n✔ Xong: ${ZIP}\n  Zip ${mb(fs.statSync(ZIP).size)} · giải nén ${mb(dirSize(OUT))}`);

function guide() {
  return `FB CRM Studio ${pkg.version} - HƯỚNG DẪN CÀI ĐẶT (Windows)
================================================================

Gói này đã có sẵn Node.js và trình duyệt Chromium. Máy mới KHÔNG cần cài thêm
phần mềm nào, chỉ cần có Internet để vào Facebook.

YÊU CẦU
-------
- Windows 10 hoặc 11, bản 64-bit.
- RAM trống khoảng 1 GB (mỗi tài khoản chạy song song mở 1 trình duyệt, ~300 MB).
- Ổ đĩa trống khoảng 1.5 GB.

CÀI ĐẶT
-------
1. Chép file ${NAME}.zip sang máy mới.
2. Chuột phải file zip > "Extract All..." (Giải nén tất cả).
   Nên giải nén vào thư mục ngắn, ví dụ:  D:\\FB-CRM
   (Đường dẫn quá dài hoặc giải nén vào Desktop/OneDrive có thể gây lỗi.)
   KHÔNG chạy trực tiếp bên trong file zip.
3. Mở thư mục vừa giải nén, bấm đúp "Start.bat".
   - Nếu Windows hiện "Windows protected your PC": bấm "More info" > "Run anyway".
4. Một cửa sổ đen hiện ra, sau vài giây trình duyệt tự mở trang
   http://localhost:3000. Nếu không tự mở, hãy tự gõ địa chỉ đó vào trình duyệt.

Giữ cửa sổ đen mở trong suốt lúc dùng. Đóng cửa sổ đó = tắt chương trình
(các task đã lên lịch sẽ chạy tiếp khi mở lại Start.bat).

BẮT ĐẦU SỬ DỤNG
---------------
1. Tài khoản > "+ Thêm tài khoản" > "Đăng nhập": cửa sổ Chromium hiện ra, tự
   đăng nhập Facebook (kể cả mã 2FA). Cửa sổ tự đóng khi đăng nhập xong.
2. Nhóm / Trang: thêm link các nhóm đã tham gia, các Trang (Fanpage) đang quản trị.
3. Studio: soạn nội dung, chọn nơi đăng, tài khoản, thời gian > "Tạo & lên lịch".
Khi mới dùng nên vào Cài đặt, TẮT "Chạy ẩn trình duyệt" để xem trực tiếp thao tác.

DỮ LIỆU
-------
Mọi dữ liệu nằm trong thư mục "data" cạnh Start.bat:
  data\\crm.db      tài khoản, task, nhóm, Trang, mẫu nội dung
  data\\uploads     ảnh/video đã tải lên
  data\\profiles    phiên đăng nhập Facebook. BẢO MẬT NHƯ MẬT KHẨU, không gửi cho người khác.
Sao lưu = chép cả thư mục "data" ra chỗ khác (khi đã tắt chương trình).

Chuyển dữ liệu từ máy cũ (không bắt buộc):
  Tắt chương trình ở cả 2 máy, chép thư mục "data" của máy cũ vào cạnh Start.bat
  của máy mới. Task, nhóm, Trang, mẫu và ảnh được giữ nguyên. Phiên đăng nhập
  Facebook thường KHÔNG dùng được sang máy khác (Windows mã hoá cookie theo
  từng máy), nên cần bấm "Đăng nhập" hoặc "Nhập cookie" lại cho từng tài khoản.
  Lưu ý: data của bản chạy từ mã nguồn nằm ở <thư mục dự án>\\data.

CẬP NHẬT PHIÊN BẢN MỚI
----------------------
1. Tắt chương trình (đóng cửa sổ đen của Start.bat).
2. Bấm đúp "Update.bat". Chương trình tự tải code mới nhất từ GitHub, liệt kê
   các thay đổi, cài lại thư viện nếu cần. Dữ liệu trong "data" giữ nguyên.
   Nếu báo "Đang dùng bản mới nhất" thì không có gì cần cập nhật.
3. Bấm đúp "Start.bat" để chạy lại.
Bản cũ được lưu ở thư mục "app-backup". Nếu cập nhật lỗi giữa chừng, chương
trình tự khôi phục bản cũ.
Nếu Update.bat báo cần cài gói đầy đủ: giải nén gói zip mới ra thư mục mới, chép
thư mục "data" của bản cũ sang rồi chạy Start.bat của bản mới.

XỬ LÝ SỰ CỐ
-----------
- Cửa sổ đen báo "EADDRINUSE": cổng 3000 đang bị phần mềm khác dùng. Chuột phải
  Start.bat > Edit, đổi dòng "set PORT=3000" thành số khác (ví dụ 3100), lưu lại
  rồi mở http://localhost:3100.
- Trang web không mở được: kiểm tra cửa sổ đen còn mở và không báo lỗi.
- Task báo "Không tìm thấy khung tạo bài viết / nút Đăng": Facebook vừa đổi giao
  diện. Xem ảnh chụp màn hình lỗi trong chi tiết task và báo cho người hỗ trợ.
- Tài khoản báo "Hết phiên" / "Checkpoint": vào Facebook xác minh thủ công rồi bấm
  "Đăng nhập" lại.
- Phần mềm diệt virus chặn node.exe hoặc chrome.exe: thêm thư mục FB-CRM vào
  danh sách loại trừ (exclusion).

LƯU Ý
-----
Chương trình điều khiển trình duyệt thật để thao tác Facebook. Tự động hoá có thể
vi phạm Điều khoản của Facebook và tài khoản có thể bị hạn chế nếu thao tác dày
đặc. Hãy giữ giới hạn thấp (Cài đặt) và không đăng nội dung spam.
`;
}
