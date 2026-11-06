// ================= Helpers =================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = ms => ms ? new Date(ms).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '–';
const fmtTime = ms => new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
const lines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
const splitContents = s => String(s || '').split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
const isVideo = f => /\.(mp4|mov|webm|mkv|avi)$/i.test(f);
const toLocalInput = ms => { const d = new Date(ms - new Date().getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

async function api(url, method = 'GET', body) {
  const opts = { method };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers = { 'Content-Type': 'application/json' }; }
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4500);
}

const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, 'error'); } };

function modal(title, body, okText = 'Lưu') {
  const dlg = $('#modal');
  $('#modalBody').innerHTML = `<h2>${title}</h2>${body}
    <div class="modal-actions"><button class="btn" value="cancel" formnovalidate>Huỷ</button><button class="btn gold" value="ok">${okText}</button></div>`;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(res => dlg.addEventListener('close', () =>
    res(dlg.returnValue === 'ok' ? Object.fromEntries(new FormData($('#modalBody'))) : null), { once: true }));
}
const confirmBox = (msg, ok = 'Đồng ý') => modal('Xác nhận', `<p>${msg}</p>`, ok);

const ST = { draft: 'Chưa chạy', pending: 'Chờ chạy', running: 'Đang chạy', done: 'Xong', error: 'Lỗi', paused: 'Tạm dừng' };
const ACC_ST = { new: 'Chưa đăng nhập', logging_in: 'Đang đăng nhập…', ok: 'Hoạt động', expired: 'Hết phiên', checkpoint: 'Checkpoint' };
const ACC_CLS = { ok: 'done', logging_in: 'running', new: 'draft', expired: 'error', checkpoint: 'error' };
const REPEAT = { none: '', daily: '↻ hằng ngày', weekly: '↻ hằng tuần' };
const statusChip = s => `<span class="status st-${s}"><b class="dot"></b>${ST[s] || s}</span>`;

// ================= State =================
const S = {
  view: 'studio',
  accounts: [], targets: [], templates: [], imageTemplates: [], tasks: [], status: null,
  selected: new Set(), active: null, activeSig: '', listSig: '',
  filter: { q: '', status: '', kind: '', sort: 'new' },
  calRange: 7,
  form: {
    kind: 'post', text: '', postUrls: '', groupUrls: '',
    contentSource: 'text', contentTplIds: new Set(), // 'templates' = ngẫu nhiên từ mẫu nội dung chưa dùng
    toProfile: true, toGroups: false, groupIds: new Set(),
    images: [], imageMode: 'all', imageMin: 1, imageMax: 3, imageShuffle: false,
    imgTpls: new Set(), // id mẫu ảnh đã chọn (theo thứ tự chọn)
    accountIds: new Set(),
    contentMode: 'all', distribute: 'rotate',
    when: 'now', at: '', interval: 0, repeat: 'none',
  },
};

async function loadBase() {
  [S.accounts, S.targets, S.templates, S.imageTemplates] = await Promise.all([
    api('/api/accounts'), api('/api/targets'), api('/api/templates'), api('/api/image-templates'),
  ]);
}

// ================= Topbar =================
async function refreshStatus() {
  S.status = await api('/api/status');
  const { runner, counts } = S.status;
  const pill = $('#accPill');
  pill.querySelector('span').textContent = runner.enabled
    ? `Tài khoản: ${runner.readyAccounts}/${runner.okAccounts} rảnh`
    : 'Bộ chạy đang dừng';
  pill.style.color = runner.enabled ? 'var(--green)' : 'var(--red)';
  $('#queuePill').textContent = `Chờ ${counts.pending || 0} · Đang chạy ${counts.running || 0} · Lỗi ${counts.error || 0}`;
  $('#btnResume').classList.toggle('gold', !runner.enabled);
}
$('#btnResume').onclick = guard(async () => { await api('/api/runner', 'POST', { enabled: true }); toast('Đã bật bộ chạy'); refreshStatus(); });
$('#btnStopAll').onclick = guard(async () => { await api('/api/runner', 'POST', { enabled: false }); toast('Đã dừng bộ chạy (task đang chạy sẽ hoàn tất)'); refreshStatus(); });

// ================= Studio =================
const seg = (name, opts, val) =>
  `<div class="chips">${Object.entries(opts).map(([k, l]) => `<button type="button" class="chip ${String(val) === k ? 'on' : ''}" data-seg="${name}" data-val="${k}">${l}</button>`).join('')}</div>`;
const sw = (name, label, on, extra = '') =>
  `<label class="switch"><input type="checkbox" data-sw="${name}" ${on ? 'checked' : ''}><span class="knob"></span><span>${label} <small class="muted">${extra}</small></span></label>`;

function buildTargets() {
  const f = S.form;
  if (f.kind === 'comment') return lines(f.postUrls).map(url => ({ type: 'post', url }));
  const t = [];
  if (f.toProfile) t.push({ type: 'profile' });
  if (f.toGroups) {
    for (const g of S.targets) if (f.groupIds.has(g.id)) t.push({ type: 'group', url: g.url, name: g.name });
    for (const url of lines(f.groupUrls)) t.push({ type: 'group', url });
  }
  return t;
}

function estimate() {
  const f = S.form;
  const fromTpl = f.contentSource === 'templates';
  const nt = buildTargets().length, na = f.accountIds.size;
  const nc = fromTpl ? Math.min(1, f.contentTplIds.size) : splitContents(f.text).length;
  if (!nt || !na || !nc) return 0;
  return nt * (f.distribute === 'all' ? na : 1) * (!fromTpl && f.contentMode === 'all' ? nc : 1);
}

const MAX_POOL = 50;
const imgPerTask = () => (S.form.kind === 'comment' ? 1 : 10);

// "Dùng tất cả" chỉ hợp lệ khi kho ảnh không vượt giới hạn mỗi bài
function imageMode() {
  const f = S.form;
  if (f.images.length <= 1) return 'all';
  return f.imageMode === 'all' && f.images.length > imgPerTask() ? 'random' : f.imageMode;
}

function imageHint(mode, n, per) {
  const max = Math.max(1, Math.min(S.form.imageMax, per, n));
  const min = Math.min(S.form.imageMin, max);
  const order = S.form.imageShuffle && per > 1 ? ', thứ tự đảo ngẫu nhiên' : '';
  if (mode === 'all') return `Mỗi bài dùng cả ${n} ảnh${order}.`;
  if (mode === 'random') return per === 1
    ? `Mỗi bình luận tự bốc 1 ảnh ngẫu nhiên trong ${n} ảnh (bốc lại ở mỗi lần chạy).`
    : `Mỗi lần đăng tự bốc ${min === max ? max : `${min}–${max}`} ảnh ngẫu nhiên trong ${n} ảnh${order}.`;
  return `Task 1 dùng ảnh 1${max > 1 ? `–${max}` : ''}, task 2 dùng ảnh ${max + 1}${max > 1 ? `–${2 * max}` : ''}… quay vòng khi hết kho${order}.`;
}

// Số ảnh tối đa lấy từ kho riêng mỗi lần đăng
function manualImageCount() {
  const n = S.form.images.length;
  if (!n) return 0;
  return imageMode() === 'all' ? n : Math.max(1, Math.min(S.form.imageMax, imgPerTask(), n));
}

// theo thứ tự người dùng chọn
const selectedImageTemplates = () => [...S.form.imgTpls.keys()].map(id => S.imageTemplates.find(t => t.id === id)).filter(Boolean);

function imageTemplateHint() {
  const f = S.form, per = imgPerTask();
  const sel = selectedImageTemplates();
  if (per === 1) return `Mỗi bình luận chọn ngẫu nhiên 1 ảnh từ ${sel.length} mẫu đã chọn.`;
  const parts = sel.map(t => `${tplImageCount(t)} ảnh từ "${esc(t.name)}"`);
  const manual = manualImageCount();
  if (manual) parts.unshift(`${manual} ảnh từ kho`);
  const total = manual + sel.reduce((s, t) => s + tplImageCount(t), 0);
  const over = total > per;
  return `Mỗi lần đăng bốc ngẫu nhiên ${parts.join(' + ')} = <b style="color:${over ? 'var(--red)' : 'var(--text)'}">${total}/${per} ảnh</b>${over ? ' · vượt giới hạn, hãy bỏ bớt mẫu hoặc giảm số ảnh trong trang Mẫu ảnh' : ''}.`;
}

// số ảnh bốc từ mẫu = cài đặt "mặc định bốc mỗi bài" của mẫu (ít ảnh hơn thì lấy hết)
const tplImageCount = t => Math.min(t.default_max, t.images.length);

function imageTemplateSection() {
  const f = S.form, per = imgPerTask();
  if (!S.imageTemplates.length) {
    return `<label class="lbl">Mẫu ảnh</label><p class="hint">Chưa có mẫu ảnh. Tạo ở mục <a href="#" data-goto="imageTemplates">Mẫu ảnh</a>.</p>`;
  }
  const sel = selectedImageTemplates();
  return `
    <label class="lbl">Mẫu ảnh <small>(số ảnh bốc mỗi mẫu cài trong trang <a href="#" data-goto="imageTemplates">Mẫu ảnh</a>)</small></label>
    <div class="chips">${S.imageTemplates.map(t => `<button type="button" class="chip ${f.imgTpls.has(t.id) ? 'on' : ''}" data-imgtpl="${t.id}" ${t.images.length ? '' : 'disabled'}>
      ${esc(t.name)} <small class="muted">${per > 1 ? `bốc ${tplImageCount(t)}/${t.images.length}` : t.images.length}</small></button>`).join('')}</div>
    ${sel.length ? `<p class="hint" id="tplHint">${imageTemplateHint()}</p>` : ''}`;
}

function contentTemplateSection(tpl) {
  const f = S.form;
  if (!tpl.length) {
    return `<p class="hint">Chưa có mẫu ${f.kind === 'post' ? 'đăng bài' : 'bình luận'}. Tạo ở mục <a href="#" data-goto="templates">Mẫu nội dung</a> hoặc nhập nội dung rồi bấm "Lưu làm mẫu".</p>`;
  }
  const sel = tpl.filter(t => f.contentTplIds.has(t.id));
  const unused = sel.filter(t => !t.used).length;
  return `
    <div class="row" style="margin:8px 0 6px"><span class="muted grow">Chọn các mẫu để bốc ngẫu nhiên</span>
      <button type="button" class="btn sm" id="ctplAll">${sel.length === tpl.length ? 'Bỏ chọn' : 'Chọn tất cả'}</button></div>
    <div class="chips">${tpl.map(t => `<button type="button" class="chip ${f.contentTplIds.has(t.id) ? 'on' : ''}" data-ctpl="${t.id}" title="${esc(t.content.slice(0, 200))}">
      ${esc(t.name)} <small class="muted">${t.used ? 'đã dùng' : 'chưa dùng'}</small></button>`).join('')}</div>
    <p class="hint">${sel.length
      ? `Mỗi lần đăng chọn ngẫu nhiên 1 mẫu chưa dùng trong ${sel.length} mẫu (còn ${unused} mẫu chưa dùng). Đăng xong mẫu được đánh dấu đã dùng; dùng hết thì tự khôi phục về chưa dùng. Spintax trong mẫu vẫn được áp dụng.`
      : 'Chưa chọn mẫu nào'}</p>`;
}

function renderForm() {
  const f = S.form;
  for (const id of f.contentTplIds) if (!S.templates.some(t => t.id === id && t.kind === f.kind)) f.contentTplIds.delete(id);
  for (const id of f.imgTpls.keys()) if (!S.imageTemplates.some(t => t.id === id)) f.imgTpls.delete(id);
  const okAccounts = S.accounts.filter(a => a.status === 'ok');
  const tpl = S.templates.filter(t => t.kind === f.kind);
  const per = imgPerTask();
  const mode = imageMode();
  const n = f.images.length;

  const imgOptions = n > 1 ? `
    <label class="lbl">Cách chọn ảnh</label>
    ${seg('imageMode', { ...(n <= per ? { all: 'Dùng tất cả' } : {}), random: 'Ngẫu nhiên', rotate: 'Luân phiên' }, mode)}
    ${per > 1 && mode === 'random' ? `<div class="row" style="margin-top:8px"><span class="grow">Mỗi lần đăng bốc</span>
      <input type="number" min="0" max="${Math.min(per, n)}" class="input" data-field="imageMin" value="${f.imageMin}" style="width:70px"><span class="muted">–</span>
      <input type="number" min="1" max="${Math.min(per, n)}" class="input" data-field="imageMax" value="${f.imageMax}" style="width:70px"><span class="muted">ảnh</span></div>` : ''}
    ${per > 1 && mode === 'rotate' ? `<div class="row" style="margin-top:8px"><span class="grow">Mỗi bài lấy</span>
      <input type="number" min="1" max="${Math.min(per, n)}" class="input" data-field="imageMax" value="${f.imageMax}" style="width:70px"><span class="muted">ảnh kế tiếp</span></div>` : ''}
    ${per > 1 ? sw('imageShuffle', 'Đảo thứ tự ảnh', f.imageShuffle, '(ngẫu nhiên mỗi lần đăng)') : ''}
    <p class="hint">${imageHint(mode, n, per)}</p>` : '';

  const where = f.kind === 'post' ? `
    <label class="lbl">Nơi đăng</label>
    ${sw('toProfile', 'Trang cá nhân', f.toProfile, '(tường của tài khoản)')}
    ${sw('toGroups', 'Nhóm', f.toGroups, `(${f.groupIds.size + lines(f.groupUrls).length} nhóm)`)}
    ${f.toGroups ? `
      <div class="row" style="margin:6px 0"><span class="muted grow">Nhóm đã lưu</span>
        <button type="button" class="btn sm" id="grpAll">${f.groupIds.size === S.targets.length && S.targets.length ? 'Bỏ chọn' : 'Chọn tất cả'}</button></div>
      <div class="chips">${S.targets.map(g => `<button type="button" class="chip ${f.groupIds.has(g.id) ? 'on' : ''}" data-grp="${g.id}" title="${esc(g.url)}">${esc(g.name)}</button>`).join('') || '<span class="hint">Chưa có nhóm nào — thêm ở mục Nhóm hoặc dán link bên dưới</span>'}</div>
      <textarea class="input" data-field="groupUrls" style="min-height:70px;margin-top:8px" placeholder="Link nhóm khác, mỗi dòng 1 link">${esc(f.groupUrls)}</textarea>` : ''}
  ` : `
    <label class="lbl">Link bài viết cần bình luận <small>(mỗi dòng 1 link)</small></label>
    <textarea class="input" data-field="postUrls" style="min-height:90px" placeholder="https://www.facebook.com/groups/.../posts/...">${esc(f.postUrls)}</textarea>
  `;

  $('#formArea').innerHTML = `
    ${where}
    <label class="lbl">${f.kind === 'post' ? 'Nội dung bài viết' : 'Nội dung bình luận'}</label>
    ${seg('contentSource', { text: 'Tự nhập', templates: 'Ngẫu nhiên từ mẫu' }, f.contentSource)}
    ${f.contentSource === 'templates' ? contentTemplateSection(tpl) : `
    <p class="hint">${splitContents(f.text).length} nội dung</p>
    <textarea class="input" data-field="text" placeholder="Mỗi nội dung cách nhau 1 dòng trống.&#10;Hỗ trợ spintax: {Chào|Xin chào} cả nhà">${esc(f.text)}</textarea>
    <div class="row" style="margin-top:8px">
      <select class="input grow" id="tplPick"><option value="">Chèn mẫu nội dung…</option>${tpl.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
      <button type="button" class="btn" id="tplSave">Lưu làm mẫu</button>
    </div>
    <label class="lbl">Mỗi ${f.kind === 'post' ? 'nơi đăng' : 'bài viết'} dùng</label>
    ${seg('contentMode', { rotate: 'Xoay vòng 1 nội dung', all: 'Tất cả nội dung' }, f.contentMode)}`}

    <div class="row"><label class="lbl grow">${f.kind === 'post' ? 'Kho ảnh / video' : 'Kho ảnh'} <small>(${n}/${MAX_POOL} · mỗi ${f.kind === 'post' ? 'bài' : 'bình luận'} tối đa ${per})</small></label>
      ${n ? `<button type="button" class="btn sm" id="imgClear" style="margin-top:8px">Xoá hết</button>` : ''}</div>
    <div class="thumbs">
      ${f.images.map((img, i) => `<div class="thumb">${isVideo(img) ? `<video src="/uploads/${img}" muted></video>` : `<img src="/uploads/${img}">`}<span class="idx">${i + 1}</span><button type="button" data-rmimg="${i}">✕</button></div>`).join('')}
      ${n < MAX_POOL ? `<label class="thumb add">+ Ảnh<input type="file" id="imgInput" hidden multiple accept="image/*${f.kind === 'post' ? ',video/*' : ''}"></label>` : ''}
    </div>
    ${imgOptions}
    ${imageTemplateSection()}

    <label class="lbl">Tài khoản <small>(${f.accountIds.size} đã chọn)</small></label>
    <div class="chips">
      ${S.accounts.map(a => `<button type="button" class="chip ${f.accountIds.has(a.id) ? 'on' : ''} ${a.status !== 'ok' ? 'off' : ''}" data-acc="${a.id}" ${a.status !== 'ok' ? 'disabled' : ''} title="${ACC_ST[a.status]}">
        <b class="dot" style="color:${a.status === 'ok' ? 'var(--green)' : 'var(--red)'}"></b>${esc(a.name)}</button>`).join('') || '<span class="hint">Chưa có tài khoản — thêm ở mục Tài khoản</span>'}
      ${okAccounts.length > 1 ? `<button type="button" class="chip" id="accAll">Tất cả</button>` : ''}
    </div>
    ${f.accountIds.size > 1 ? `<label class="lbl">Phân bổ tài khoản</label>${seg('distribute', { rotate: 'Luân phiên', all: 'Mọi tài khoản đều chạy' }, f.distribute)}` : ''}

    <label class="lbl">Thời gian</label>
    ${seg('when', { now: 'Chạy ngay', at: 'Hẹn giờ' }, f.when)}
    ${f.when === 'at' ? `<input type="datetime-local" class="input" data-field="at" value="${esc(f.at || toLocalInput(Date.now() + 3600000))}" style="margin-top:8px">` : ''}
    <div class="row" style="margin-top:10px">
      <span class="grow">Giãn cách giữa các task</span>
      <input type="number" min="0" class="input" data-field="interval" value="${f.interval}" style="width:90px"><span class="muted">phút</span>
    </div>
    <label class="lbl">Lặp lại</label>
    ${seg('repeat', { none: 'Không', daily: 'Hằng ngày', weekly: 'Hằng tuần' }, f.repeat)}
    <p class="hint" id="estimate">Sẽ tạo <b>${estimate()}</b> task</p>
  `;
}

function syncField(el) {
  const k = el.dataset.field;
  S.form[k] = ['interval', 'imageMin', 'imageMax'].includes(k) ? Math.max(0, +el.value || 0) : el.value;
  $('#estimate').innerHTML = `Sẽ tạo <b>${estimate()}</b> task`;
}

function bindForm() {
  const area = $('#formArea');
  area.addEventListener('input', e => {
    if (e.target.dataset.field) syncField(e.target);
  });
  area.addEventListener('change', guard(async e => {
    const t = e.target;
    if (t.dataset.sw) { S.form[t.dataset.sw] = t.checked; renderForm(); }
    if (['imageMin', 'imageMax'].includes(t.dataset.field)) renderForm();
    if (t.id === 'tplPick' && t.value) {
      const tp = S.templates.find(x => x.id === +t.value);
      S.form.text = S.form.text.trim() ? `${S.form.text.trim()}\n\n${tp.content}` : tp.content;
      renderForm();
    }
    if (t.id === 'imgInput' && t.files.length) {
      const fd = new FormData();
      const max = MAX_POOL - S.form.images.length;
      [...t.files].slice(0, max).forEach(file => fd.append('files', file));
      const r = await api('/api/upload', 'POST', fd);
      S.form.images.push(...r.files);
      renderForm();
    }
  }));
  area.addEventListener('click', guard(async e => {
    const link = e.target.closest('[data-goto]');
    if (link) { e.preventDefault(); return go(link.dataset.goto); }
    const b = e.target.closest('button');
    if (!b) return;
    const f = S.form;
    if (b.dataset.seg) { f[b.dataset.seg] = b.dataset.val; if (b.dataset.seg === 'when' && f.when === 'at' && !f.at) f.at = toLocalInput(Date.now() + 3600000); }
    else if (b.dataset.grp) { const id = +b.dataset.grp; f.groupIds.has(id) ? f.groupIds.delete(id) : f.groupIds.add(id); }
    else if (b.dataset.acc) { const id = +b.dataset.acc; f.accountIds.has(id) ? f.accountIds.delete(id) : f.accountIds.add(id); }
    else if (b.dataset.ctpl) { const id = +b.dataset.ctpl; f.contentTplIds.has(id) ? f.contentTplIds.delete(id) : f.contentTplIds.add(id); }
    else if (b.id === 'ctplAll') {
      const ids = S.templates.filter(t => t.kind === f.kind).map(t => t.id);
      f.contentTplIds = f.contentTplIds.size === ids.length ? new Set() : new Set(ids);
    }
    else if (b.dataset.imgtpl) { const id = +b.dataset.imgtpl; f.imgTpls.has(id) ? f.imgTpls.delete(id) : f.imgTpls.add(id); }
    else if (b.dataset.rmimg) f.images.splice(+b.dataset.rmimg, 1);
    else if (b.id === 'imgClear') f.images = [];
    else if (b.id === 'grpAll') f.groupIds = f.groupIds.size === S.targets.length ? new Set() : new Set(S.targets.map(g => g.id));
    else if (b.id === 'accAll') f.accountIds = new Set(S.accounts.filter(a => a.status === 'ok').map(a => a.id));
    else if (b.id === 'tplSave') {
      if (!f.text.trim()) throw new Error('Chưa có nội dung để lưu');
      const r = await modal('Lưu mẫu nội dung', `<label class="lbl">Tên mẫu</label><input class="input" name="name" required autofocus>`);
      if (!r) return;
      await api('/api/templates', 'POST', { name: r.name, kind: f.kind, content: f.text.trim() });
      S.templates = await api('/api/templates');
      toast('Đã lưu mẫu');
    } else return;
    renderForm();
  }));
}

async function submitForm(draft) {
  const f = S.form;
  const startAt = f.when === 'at' ? new Date(f.at).getTime() : null;
  if (f.when === 'at' && !startAt) throw new Error('Chưa chọn thời gian hẹn');
  const r = await api('/api/tasks/bulk', 'POST', {
    kind: f.kind, contents: splitContents(f.text), contentMode: f.contentMode, images: f.images,
    contentSource: f.contentSource, contentTemplateIds: [...f.contentTplIds],
    imageMode: imageMode(), imageMin: f.imageMin, imageMax: f.imageMax, imageShuffle: f.imageShuffle && imgPerTask() > 1,
    imageTemplates: [...f.imgTpls],
    accountIds: [...f.accountIds], distribute: f.distribute, targets: buildTargets(),
    startAt, intervalMin: f.interval, repeat: f.repeat, draft,
  });
  toast(`Đã tạo ${r.created} task${draft ? ' (chưa chạy)' : ''}`);
  f.text = ''; f.images = [];
  renderForm();
  S.listSig = '';
  await refreshTasks();
}

function taskRow(t) {
  const imgs = JSON.parse(t.images || '[]');
  if (!imgs.length) imgs.push(...(JSON.parse(t.image_opts || '{}').templates?.[0]?.pool || []).slice(0, 1));
  const ic = imgs.length && !isVideo(imgs[0]) ? `<img src="/uploads/${imgs[0]}" loading="lazy">` : (t.kind === 'post' ? '📝' : '💬');
  const title = `${t.kind === 'post' ? 'Đăng' : 'Bình luận'} · ${t.target_name || t.target_url || ''}`;
  return `<div class="task ${S.active === t.id ? 'active' : ''}" data-id="${t.id}">
    <input type="checkbox" data-check="${t.id}" ${S.selected.has(t.id) ? 'checked' : ''}>
    <div class="ic">${ic}</div>
    <div style="min-width:0">
      <div class="title">${esc(title)}</div>
      <div class="meta">${esc(t.account_name || '—')} · ${fmt(t.scheduled_at)} ${REPEAT[t.repeat] ? '· ' + REPEAT[t.repeat] : ''} · ${esc(t.content.slice(0, 80))}</div>
    </div>
    ${statusChip(t.status)}
  </div>`;
}

async function refreshTasks() {
  const q = new URLSearchParams(Object.entries(S.filter).filter(([, v]) => v));
  S.tasks = await api(`/api/tasks?${q}`);
  const ids = new Set(S.tasks.map(t => t.id));
  for (const id of S.selected) if (!ids.has(id)) S.selected.delete(id);
  const sig = JSON.stringify(S.tasks.map(t => [t.id, t.status, t.scheduled_at])) + [...S.selected] + S.active;
  if (sig !== S.listSig) {
    S.listSig = sig;
    $('#taskList').innerHTML = S.tasks.map(taskRow).join('') || '<div class="empty">Chưa có task nào</div>';
  }
  $('#taskCount').textContent = `${S.tasks.length} task${S.selected.size ? ` · đã chọn ${S.selected.size}` : ''}`;
  $('#selAll').checked = S.tasks.length > 0 && S.selected.size === S.tasks.length;
  if (S.active) await renderDetail();
}

const thumbs = list => `<div class="thumbs">${list.map(i => `<div class="thumb">${isVideo(i) ? `<video src="/uploads/${i}" muted></video>` : `<img src="/uploads/${i}">`}</div>`).join('')}</div>`;

function imageOptsLabel(o) {
  const parts = [o.mode === 'random' ? `bốc ngẫu nhiên ${o.min === o.max ? o.max : `${o.min}–${o.max}`} ảnh` : 'dùng tất cả'];
  if (o.shuffle) parts.push('đảo thứ tự');
  return parts.join(' · ');
}

async function renderDetail(force) {
  const el = $('#detail');
  if (!el) return;
  if (!S.active) { el.innerHTML = '<div class="empty">Chọn một task để xem chi tiết</div>'; return; }
  let t;
  try { t = await api(`/api/tasks/${S.active}`); } catch { S.active = null; return renderDetail(); }
  const sig = `${t.id}|${t.status}|${t.attempts}|${t.logs.length}|${t.scheduled_at}|${t.content}`;
  if (!force && sig === S.activeSig) return;
  S.activeSig = sig;
  const imgs = JSON.parse(t.images || '[]');
  const used = JSON.parse(t.used_images || 'null');
  const imgOpts = JSON.parse(t.image_opts || '{}');
  const ctpls = JSON.parse(t.content_opts || '{}').templates || [];
  el.innerHTML = `
    <div class="row" style="justify-content:space-between;flex-wrap:wrap">
      ${statusChip(t.status)}
      <span class="muted">#${t.id} · ${t.kind === 'post' ? 'Đăng bài' : 'Bình luận'} · lần thử ${t.attempts}</span>
    </div>
    <h3>Nơi chạy</h3>
    <div>${t.target_url ? `<a href="${esc(t.target_url)}" target="_blank" rel="noopener">${esc(t.target_name || t.target_url)}</a>` : esc(t.target_name)}</div>
    <div class="muted">Tài khoản: ${esc(t.account_name || '—')}</div>
    <div class="muted">Lịch: ${fmt(t.scheduled_at)} ${REPEAT[t.repeat] ? '· ' + REPEAT[t.repeat] : ''}</div>
    ${t.finished_at ? `<div class="muted">Hoàn tất: ${fmt(t.finished_at)}</div>` : ''}
    <h3>Nội dung</h3>
    ${ctpls.length
      ? `<div>Ngẫu nhiên từ ${ctpls.length} mẫu, ưu tiên mẫu chưa dùng:</div><div class="chips" style="margin-top:6px">${ctpls.map(c => {
          const live = S.templates.find(x => x.id === c.id);
          return `<span class="chip" title="${esc((live?.content || c.content).slice(0, 200))}">${esc(live?.name || c.name)} <small class="muted">${live ? (live.used ? 'đã dùng' : 'chưa dùng') : 'đã xoá'}</small></span>`;
        }).join('')}</div>`
      : `<div class="content">${esc(t.content)}</div>`}
    ${t.used_content && (ctpls.length || t.used_content !== t.content) ? `<h3>Nội dung đã đăng lần gần nhất</h3><div class="content">${esc(t.used_content)}</div>` : ''}
    ${imgs.length ? `<h3>Kho ảnh <small class="muted">(${imgs.length} ảnh · ${imageOptsLabel(imgOpts)})</small></h3>${thumbs(imgs)}` : ''}
    ${imgOpts.templates?.length ? `<h3>Mẫu ảnh</h3>${imgOpts.templates.map(tp => {
      const live = S.imageTemplates.find(x => x.id === tp.id);
      return `<div class="tpl-row"><span class="grow">${esc(live?.name || tp.name)}${live ? '' : ' <small class="muted">(đã xoá, dùng bản sao)</small>'}</span><span class="muted">bốc ${live ? Math.min(live.default_max, live.images.length) : tp.max} ảnh</span></div>`;
    }).join('')}` : ''}
    ${used?.length ? `<h3>Ảnh đã dùng lần chạy gần nhất</h3>${thumbs(used)}` : ''}
    ${t.result ? `<h3>Kết quả</h3><div>${esc(t.result)}</div>` : ''}
    ${t.error ? `<h3>Lỗi</h3><div class="err">${esc(t.error)}</div>` : ''}
    ${t.shot ? `<h3>Ảnh chụp màn hình lúc lỗi</h3><a href="/shots/${t.shot}" target="_blank"><img class="shot" src="/shots/${t.shot}"></a>` : ''}
    <div class="row" style="flex-wrap:wrap;margin-top:14px">
      ${t.status !== 'running' ? `<button class="btn sm" data-dact="run_now">Chạy ngay</button>` : ''}
      ${['pending', 'draft'].includes(t.status) ? `<button class="btn sm" data-dact="pause">Dừng</button>` : ''}
      ${t.status !== 'running' ? `<button class="btn sm" data-dact="edit">Sửa</button><button class="btn sm danger-text" data-dact="delete">Xoá</button>` : ''}
    </div>
    <h3>Nhật ký</h3>
    ${t.logs.map(l => `<div class="logline ${l.level}"><time>${fmtTime(l.created_at)}</time>${esc(l.message)}</div>`).join('') || '<div class="muted">—</div>'}
  `;
  el.onclick = guard(async e => {
    const act = e.target.closest('[data-dact]')?.dataset.dact;
    if (!act) return;
    if (act === 'edit') return editTask(t);
    if (act === 'delete' && !await confirmBox('Xoá task này?', 'Xoá')) return;
    await api('/api/tasks/action', 'POST', { ids: [t.id], action: act });
    if (act === 'delete') S.active = null;
    S.listSig = '';
    await refreshTasks();
    renderDetail(true);
  });
}

async function editTask(t) {
  const r = await modal(`Sửa task #${t.id}`, `
    ${JSON.parse(t.content_opts || '{}').templates?.length
      ? '<p class="hint">Nội dung được chọn ngẫu nhiên từ mẫu lúc chạy.</p>'
      : `<label class="lbl">Nội dung</label><textarea class="input" name="content">${esc(t.content)}</textarea>`}
    <label class="lbl">Thời gian chạy</label><input type="datetime-local" class="input" name="at" value="${toLocalInput(t.scheduled_at)}">
    <label class="lbl">Tài khoản</label><select class="input" name="account_id">${S.accounts.map(a => `<option value="${a.id}" ${a.id === t.account_id ? 'selected' : ''}>${esc(a.name)} (${ACC_ST[a.status]})</option>`).join('')}</select>
    <label class="lbl">Lặp lại</label><select class="input" name="repeat">${Object.entries({ none: 'Không', daily: 'Hằng ngày', weekly: 'Hằng tuần' }).map(([k, v]) => `<option value="${k}" ${t.repeat === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`);
  if (!r) return;
  await api(`/api/tasks/${t.id}`, 'PUT', { content: r.content ?? null, scheduled_at: new Date(r.at).getTime(), account_id: +r.account_id, repeat: r.repeat });
  toast('Đã cập nhật');
  S.listSig = '';
  await refreshTasks();
  renderDetail(true);
}

const views = {};

views.studio = {
  title: 'Studio',
  render() {
    $('#view').innerHTML = `
      <div class="studio">
        <div class="panel">
          <div class="tabs">
            <button class="tab ${S.form.kind === 'post' ? 'active' : ''}" data-kind="post">Đăng bài</button>
            <button class="tab ${S.form.kind === 'comment' ? 'active' : ''}" data-kind="comment">Bình luận</button>
          </div>
          <div class="form-scroll" id="formArea"></div>
          <div class="form-actions">
            <button class="btn primary" id="btnCreate">Tạo & lên lịch</button>
            <button class="btn ghost" id="btnDraft">Chỉ thêm vào hàng đợi</button>
          </div>
        </div>
        <div class="panel">
          <div class="list-head">
            <div class="row">
              <input class="input grow" id="fq" placeholder="Tìm nội dung, nhóm, tài khoản…" value="${esc(S.filter.q)}">
              <select class="input" id="fstatus" style="width:auto"><option value="">Mọi trạng thái</option>${Object.entries(ST).map(([k, v]) => `<option value="${k}" ${S.filter.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
            </div>
            <div class="row" style="flex-wrap:wrap">
              <button class="btn sm" id="selErr">Chọn lỗi</button>
              <button class="btn sm" id="selDraft">Chọn chưa chạy</button>
              <span class="grow"></span>
              <select class="input" id="fkind" style="width:auto"><option value="">Tất cả loại</option><option value="post" ${S.filter.kind === 'post' ? 'selected' : ''}>Đăng bài</option><option value="comment" ${S.filter.kind === 'comment' ? 'selected' : ''}>Bình luận</option></select>
            </div>
            <div class="row">
              <label class="row" style="cursor:pointer"><input type="checkbox" id="selAll"><span id="taskCount">0 task</span></label>
              <span class="grow"></span>
              <select class="input" id="fsort" style="width:auto">
                ${Object.entries({ new: 'Mới nhất', old: 'Cũ nhất', schedule: 'Theo lịch chạy' }).map(([k, v]) => `<option value="${k}" ${S.filter.sort === k ? 'selected' : ''}>${v}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="task-list" id="taskList"></div>
          <div class="bulk-bar">
            <button class="btn sm" data-bulk="run">Chạy</button>
            <button class="btn sm" data-bulk="run_now">Chạy ngay</button>
            <button class="btn sm" data-bulk="pause">Dừng</button>
            <button class="btn sm danger-text" data-bulk="delete">Xoá</button>
            <button class="btn sm" data-bulk="retry">Chạy lại lỗi</button>
          </div>
        </div>
        <div class="panel detail-panel detail" id="detail"></div>
      </div>`;
    S.listSig = ''; S.activeSig = '';
    renderForm();
    bindForm();

    $$('.tab').forEach(b => b.onclick = () => {
      S.form.kind = b.dataset.kind;
      S.form.contentMode = S.form.kind === 'post' ? 'all' : 'rotate';
      $$('.tab').forEach(x => x.classList.toggle('active', x === b));
      renderForm();
    });
    $('#btnCreate').onclick = guard(() => submitForm(false));
    $('#btnDraft').onclick = guard(() => submitForm(true));

    let qTimer;
    $('#fq').oninput = e => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.filter.q = e.target.value; refreshTasks(); }, 300); };
    $('#fstatus').onchange = e => { S.filter.status = e.target.value; refreshTasks(); };
    $('#fkind').onchange = e => { S.filter.kind = e.target.value; refreshTasks(); };
    $('#fsort').onchange = e => { S.filter.sort = e.target.value; refreshTasks(); };
    const selectWhere = fn => { S.selected = new Set(S.tasks.filter(fn).map(t => t.id)); S.listSig = ''; refreshTasks(); };
    $('#selErr').onclick = () => selectWhere(t => t.status === 'error');
    $('#selDraft').onclick = () => selectWhere(t => ['draft', 'paused'].includes(t.status));
    $('#selAll').onchange = e => selectWhere(() => e.target.checked);

    $('#taskList').onclick = e => {
      const cb = e.target.closest('[data-check]');
      if (cb) {
        const id = +cb.dataset.check;
        cb.checked ? S.selected.add(id) : S.selected.delete(id);
        $('#taskCount').textContent = `${S.tasks.length} task${S.selected.size ? ` · đã chọn ${S.selected.size}` : ''}`;
        return;
      }
      const row = e.target.closest('.task');
      if (!row) return;
      S.active = +row.dataset.id;
      $$('.task').forEach(r => r.classList.toggle('active', r === row));
      renderDetail(true);
    };
    $$('[data-bulk]').forEach(b => b.onclick = guard(async () => {
      const action = b.dataset.bulk;
      let ids = [...S.selected];
      if (action === 'retry' && !ids.length) ids = S.tasks.filter(t => t.status === 'error').map(t => t.id);
      if (!ids.length) throw new Error('Chưa chọn task');
      if (action === 'delete' && !await confirmBox(`Xoá ${ids.length} task đã chọn?`, 'Xoá')) return;
      const r = await api('/api/tasks/action', 'POST', { ids, action });
      toast(`Đã cập nhật ${r.changed} task`);
      if (action === 'delete') S.selected.clear();
      S.listSig = '';
      refreshTasks();
    }));
    renderDetail();
    return refreshTasks();
  },
  refresh: refreshTasks,
};

// ================= Lịch chạy =================
views.calendar = {
  title: 'Lịch chạy',
  async render() {
    const from = new Date().setHours(0, 0, 0, 0);
    const to = from + S.calRange * 86400000;
    const tasks = await api(`/api/tasks?sort=schedule&from=${from}&to=${to}&limit=2000`);
    const c = S.status?.counts || {};
    const byDay = {};
    for (const t of tasks) {
      const key = new Date(t.scheduled_at).toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
      (byDay[key] ||= []).push(t);
    }
    $('#view').innerHTML = `
      <div class="stats">
        <div class="stat"><b>${c.pending || 0}</b><span>Chờ chạy</span></div>
        <div class="stat"><b>${c.running || 0}</b><span>Đang chạy</span></div>
        <div class="stat"><b>${c.done || 0}</b><span>Đã xong</span></div>
        <div class="stat"><b style="color:var(--red)">${c.error || 0}</b><span>Lỗi</span></div>
        <div class="stat"><b>${(c.draft || 0) + (c.paused || 0)}</b><span>Chưa chạy / tạm dừng</span></div>
      </div>
      <div class="toolbar">${seg('calRange', { 1: 'Hôm nay', 7: '7 ngày', 30: '30 ngày' }, S.calRange)}<span class="grow"></span><span class="muted">${tasks.length} task</span></div>
      ${Object.entries(byDay).map(([day, list]) => `
        <div class="cal-day"><h3>${day} · ${list.length} task</h3>
          ${list.map(t => `<div class="cal-item" data-id="${t.id}">
            <span class="time">${fmtTime(t.scheduled_at)}</span>
            <span class="muted kind">${t.kind === 'post' ? '📝 Đăng bài' : '💬 Bình luận'}</span>
            <span class="txt">${esc(t.target_name || t.target_url)} · <span class="muted">${esc(t.account_name || '')} · ${esc(t.content.slice(0, 100))}</span> ${REPEAT[t.repeat] ? `<span class="muted">${REPEAT[t.repeat]}</span>` : ''}</span>
            ${statusChip(t.status)}
          </div>`).join('')}
        </div>`).join('') || '<div class="empty">Không có lịch nào trong khoảng này</div>'}`;
    $('#view').onclick = e => {
      const b = e.target.closest('[data-seg="calRange"]');
      if (b) { S.calRange = +b.dataset.val; return views.calendar.render(); }
      const it = e.target.closest('.cal-item');
      if (it) { S.active = +it.dataset.id; go('studio'); }
    };
  },
};

// ================= Tài khoản =================
views.accounts = {
  title: 'Tài khoản Facebook',
  async render() {
    S.accounts = await api('/api/accounts');
    const limit = S.status?.settings?.daily_limit || '–';
    $('#view').innerHTML = `
      <div class="panel">
        <div class="toolbar">
          <div class="grow muted">Đăng nhập bằng cách mở cửa sổ trình duyệt và tự đăng nhập Facebook (an toàn nhất), hoặc nhập cookie JSON. Phiên được lưu riêng cho từng tài khoản trong <code>data/profiles</code>.</div>
          <button class="btn gold" id="addAcc">+ Thêm tài khoản</button>
        </div>
        <div style="overflow-x:auto"><table class="table">
          <thead><tr><th>Tên</th><th>UID</th><th>Trạng thái</th><th>Hôm nay</th><th>Hàng chờ</th><th>Ghi chú</th><th></th></tr></thead>
          <tbody>${S.accounts.map(a => `<tr data-id="${a.id}">
            <td><b>${esc(a.name)}</b></td>
            <td class="muted">${a.fb_uid ? `<a href="https://www.facebook.com/${a.fb_uid}" target="_blank" rel="noopener">${a.fb_uid}</a>` : '–'}</td>
            <td><span class="status st-${ACC_CLS[a.status]}"><b class="dot"></b>${ACC_ST[a.status]}${a.busy ? ' · bận' : ''}</span></td>
            <td>${a.done_today}/${limit}</td>
            <td>${a.queued}</td>
            <td class="muted">${esc(a.note)}</td>
            <td><div class="row">
              <button class="btn sm gold" data-act="login">Đăng nhập</button>
              <button class="btn sm" data-act="cookies">Nhập cookie</button>
              <button class="btn sm" data-act="check">Kiểm tra</button>
              <button class="btn sm" data-act="edit">Sửa</button>
              <button class="btn sm danger-text" data-act="delete">Xoá</button>
            </div></td></tr>`).join('') || '<tr><td colspan="7" class="empty">Chưa có tài khoản</td></tr>'}</tbody>
        </table></div>
      </div>`;
    $('#addAcc').onclick = guard(async () => {
      const r = await modal('Thêm tài khoản', `<label class="lbl">Tên gợi nhớ</label><input class="input" name="name" required autofocus placeholder="VD: Nick bán hàng 1">
        <label class="lbl">Ghi chú</label><input class="input" name="note">`);
      if (!r) return;
      await api('/api/accounts', 'POST', r);
      toast('Đã thêm. Bấm "Đăng nhập" để kết nối Facebook');
      views.accounts.render();
    });
    $('#view').querySelector('tbody').onclick = guard(async e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      const a = S.accounts.find(x => x.id === +e.target.closest('tr').dataset.id);
      if (act === 'login') {
        const r = await api(`/api/accounts/${a.id}/login`, 'POST');
        toast(r.message);
      } else if (act === 'cookies') {
        const r = await modal(`Nhập cookie · ${esc(a.name)}`, `<p class="muted">Dán cookie dạng JSON array (xuất từ extension Cookie-Editor / EditThisCookie khi đang ở facebook.com).</p>
          <textarea class="input" name="cookies" required placeholder='[{"name":"c_user","value":"...","domain":".facebook.com"}, ...]'></textarea>`, 'Nhập');
        if (!r) return;
        toast('Đang kiểm tra cookie…');
        const res = await api(`/api/accounts/${a.id}/cookies`, 'POST', { cookies: r.cookies });
        toast(`Đăng nhập thành công · UID ${res.uid}`);
      } else if (act === 'check') {
        toast('Đang kiểm tra phiên đăng nhập…');
        const res = await api(`/api/accounts/${a.id}/check`, 'POST').catch(err => { views.accounts.render(); throw err; });
        toast(`Phiên còn hiệu lực · UID ${res.uid}`);
      } else if (act === 'edit') {
        const r = await modal('Sửa tài khoản', `<label class="lbl">Tên</label><input class="input" name="name" value="${esc(a.name)}" required>
          <label class="lbl">Ghi chú</label><input class="input" name="note" value="${esc(a.note)}">`);
        if (!r) return;
        await api(`/api/accounts/${a.id}`, 'PUT', r);
      } else if (act === 'delete') {
        if (!await confirmBox(`Xoá tài khoản "${esc(a.name)}"? Các task chưa chạy của tài khoản này cũng bị xoá.`, 'Xoá')) return;
        await api(`/api/accounts/${a.id}`, 'DELETE');
        S.form.accountIds.delete(a.id);
      }
      views.accounts.render();
    });
  },
  async refresh() {
    const prev = JSON.stringify(S.accounts.map(a => [a.status, a.busy, a.done_today, a.queued]));
    const next = await api('/api/accounts');
    if (JSON.stringify(next.map(a => [a.status, a.busy, a.done_today, a.queued])) !== prev && !$('#modal').open) views.accounts.render();
  },
};

// ================= Nhóm =================
views.groups = {
  title: 'Nhóm Facebook',
  q: '',
  async render() {
    S.targets = await api('/api/targets');
    const q = this.q.toLowerCase();
    const list = S.targets.filter(g => !q || g.name.toLowerCase().includes(q) || g.url.toLowerCase().includes(q));
    $('#view').innerHTML = `
      <div class="panel">
        <div class="toolbar">
          <input class="input grow" id="gq" placeholder="Tìm nhóm…" value="${esc(this.q)}" style="max-width:320px">
          <span class="grow"></span>
          <button class="btn" id="bulkGrp">Nhập nhiều</button>
          <button class="btn gold" id="addGrp">+ Thêm nhóm</button>
        </div>
        <div style="overflow-x:auto"><table class="table">
          <thead><tr><th>Tên nhóm</th><th>Link</th><th>Ghi chú</th><th></th></tr></thead>
          <tbody>${list.map(g => `<tr data-id="${g.id}">
            <td><b>${esc(g.name)}</b></td>
            <td><a href="${esc(g.url)}" target="_blank" rel="noopener">${esc(g.url)}</a></td>
            <td class="muted">${esc(g.note)}</td>
            <td><div class="row">
              <button class="btn sm gold" data-act="post">Đăng vào nhóm</button>
              <button class="btn sm" data-act="edit">Sửa</button>
              <button class="btn sm danger-text" data-act="delete">Xoá</button>
            </div></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Chưa có nhóm</td></tr>'}</tbody>
        </table></div>
        <p class="hint">Tài khoản phải là thành viên của nhóm thì mới đăng được. Nhóm có kiểm duyệt sẽ ở trạng thái "chờ duyệt" sau khi đăng.</p>
      </div>`;
    $('#gq').oninput = e => { this.q = e.target.value; clearTimeout(this.t); this.t = setTimeout(() => { this.render().then(() => { const i = $('#gq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 250); };
    $('#addGrp').onclick = guard(async () => {
      const r = await modal('Thêm nhóm', `<label class="lbl">Link nhóm hoặc ID</label><input class="input" name="url" required placeholder="https://www.facebook.com/groups/...">
        <label class="lbl">Tên nhóm</label><input class="input" name="name"><label class="lbl">Ghi chú</label><input class="input" name="note">`);
      if (!r) return;
      const res = await api('/api/targets', 'POST', r);
      toast(res.added ? 'Đã thêm nhóm' : 'Link không hợp lệ hoặc đã tồn tại', res.added ? 'ok' : 'error');
      this.render();
    });
    $('#bulkGrp').onclick = guard(async () => {
      const r = await modal('Nhập nhiều nhóm', `<p class="muted">Mỗi dòng: <code>link | tên nhóm</code> (tên có thể bỏ trống)</p><textarea class="input" name="bulk" required></textarea>`, 'Nhập');
      if (!r) return;
      const res = await api('/api/targets', 'POST', r);
      toast(`Đã thêm ${res.added} nhóm`);
      this.render();
    });
    $('#view').querySelector('tbody').onclick = guard(async e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      const g = S.targets.find(x => x.id === +e.target.closest('tr').dataset.id);
      if (act === 'post') {
        Object.assign(S.form, { kind: 'post', toGroups: true, toProfile: false, groupIds: new Set([g.id]), contentMode: 'all' });
        return go('studio');
      }
      if (act === 'edit') {
        const r = await modal('Sửa nhóm', `<label class="lbl">Tên</label><input class="input" name="name" value="${esc(g.name)}" required>
          <label class="lbl">Link</label><input class="input" name="url" value="${esc(g.url)}" required>
          <label class="lbl">Ghi chú</label><input class="input" name="note" value="${esc(g.note)}">`);
        if (!r) return;
        await api(`/api/targets/${g.id}`, 'PUT', r);
      }
      if (act === 'delete') {
        if (!await confirmBox(`Xoá nhóm "${esc(g.name)}" khỏi danh sách?`, 'Xoá')) return;
        await api(`/api/targets/${g.id}`, 'DELETE');
        S.form.groupIds.delete(g.id);
      }
      this.render();
    });
  },
};

// ================= Mẫu nội dung =================
views.templates = {
  title: 'Mẫu nội dung',
  async render() {
    S.templates = await api('/api/templates');
    $('#view').innerHTML = `
      <div class="panel">
        <div class="toolbar"><span class="grow muted">Mẫu dùng nhanh khi tạo bài / bình luận, hoặc để hệ thống bốc ngẫu nhiên mẫu chưa dùng (chọn "Ngẫu nhiên từ mẫu" trong Studio). Hỗ trợ spintax <code>{a|b|c}</code>.</span>
          <button class="btn" id="resetUse">Đặt lại tất cả về chưa dùng</button><button class="btn gold" id="addTpl">+ Thêm mẫu</button></div>
        <table class="table"><thead><tr><th>Tên</th><th>Loại</th><th>Nội dung</th><th>Trạng thái</th><th></th></tr></thead>
        <tbody>${S.templates.map(t => `<tr data-id="${t.id}"><td><b>${esc(t.name)}</b></td><td>${t.kind === 'post' ? 'Đăng bài' : 'Bình luận'}</td>
          <td class="muted" style="white-space:pre-wrap;max-width:600px">${esc(t.content.slice(0, 300))}</td>
          <td style="white-space:nowrap">${t.used ? '<span class="status st-done"><b class="dot"></b>Đã dùng</span>' : '<span class="status st-draft"><b class="dot"></b>Chưa dùng</span>'}
            ${t.use_count ? `<div class="hint">Đã đăng ${t.use_count} lần · ${fmt(t.last_used_at)}</div>` : ''}</td>
          <td><div class="row">${t.used ? `<button class="btn sm" data-reset="${t.id}">Đặt lại</button>` : ''}<button class="btn sm danger-text" data-del="${t.id}">Xoá</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Chưa có mẫu</td></tr>'}</tbody></table>
      </div>`;
    $('#addTpl').onclick = guard(async () => {
      const r = await modal('Thêm mẫu', `<label class="lbl">Tên mẫu</label><input class="input" name="name" required>
        <label class="lbl">Loại</label><select class="input" name="kind"><option value="post">Đăng bài</option><option value="comment">Bình luận</option></select>
        <label class="lbl">Nội dung</label><textarea class="input" name="content" required></textarea>`);
      if (!r) return;
      await api('/api/templates', 'POST', r);
      this.render();
    });
    $('#resetUse').onclick = guard(async () => {
      if (!await confirmBox('Đưa tất cả mẫu về trạng thái chưa dùng?')) return;
      await api('/api/templates/reset-usage', 'POST', {});
      this.render();
    });
    $('#view').querySelector('tbody').onclick = guard(async e => {
      const { del, reset } = e.target.dataset;
      if (reset) await api('/api/templates/reset-usage', 'POST', { ids: [+reset] });
      else if (!del || !await confirmBox('Xoá mẫu này?', 'Xoá')) return;
      else await api(`/api/templates/${del}`, 'DELETE');
      this.render();
    });
  },
};

// ================= Mẫu ảnh =================
views.imageTemplates = {
  title: 'Mẫu ảnh',
  editing: null, // { id?, name, default_max, images[] }
  async render() {
    S.imageTemplates = await api('/api/image-templates');
    const e = this.editing;
    const small = (list, limit) => `<div class="thumbs sm">${list.slice(0, limit).map(i => `<div class="thumb">${isVideo(i) ? `<video src="/uploads/${i}" muted></video>` : `<img src="/uploads/${i}" loading="lazy">`}</div>`).join('')}
      ${list.length > limit ? `<div class="thumb more">+${list.length - limit}</div>` : ''}</div>`;

    $('#view').innerHTML = `
      ${e ? `
      <div class="panel" id="tplEditor" style="margin-bottom:16px">
        <h3 style="margin:0 0 4px">${e.id ? 'Sửa mẫu ảnh' : 'Tạo mẫu ảnh'}</h3>
        <div class="row" style="flex-wrap:wrap;gap:12px">
          <div class="grow" style="min-width:220px"><label class="lbl">Tên mẫu</label><input class="input" data-e="name" value="${esc(e.name)}" placeholder="VD: Ảnh sản phẩm, Feedback khách"></div>
          <div><label class="lbl">Số ảnh bốc mỗi bài</label><div class="row"><input type="number" min="1" max="10" class="input" data-e="default_max" value="${e.default_max}" style="width:80px"><span class="muted">ảnh</span></div></div>
        </div>
        <div class="row"><label class="lbl grow">Ảnh trong mẫu <small>(${e.images.length}/200)</small></label>
          ${e.images.length ? `<button type="button" class="btn sm" data-eact="clear" style="margin-top:8px">Xoá hết</button>` : ''}</div>
        <div class="thumbs">
          ${e.images.map((img, i) => `<div class="thumb">${isVideo(img) ? `<video src="/uploads/${img}" muted></video>` : `<img src="/uploads/${img}">`}<span class="idx">${i + 1}</span><button type="button" data-erm="${i}">✕</button></div>`).join('')}
          ${e.images.length < 200 ? `<label class="thumb add">+ Ảnh<input type="file" id="tplImgInput" hidden multiple accept="image/*,video/*"></label>` : ''}
        </div>
        <div class="modal-actions">
          <button class="btn" data-eact="cancel">Huỷ</button>
          <button class="btn gold" data-eact="save">Lưu mẫu</button>
        </div>
      </div>` : ''}
      <div class="toolbar">
        <span class="grow muted">Mẫu ảnh là bộ ảnh lưu sẵn. Đặt số ảnh bốc mỗi bài cho từng mẫu ở đây; khi đăng bài chỉ cần chọn các mẫu, mỗi lần đăng hệ thống bốc ngẫu nhiên đúng số ảnh đó. Sửa mẫu (ảnh hoặc số ảnh) thì các bài đã lên lịch dùng cài đặt mới.</span>
        ${e ? '' : '<button class="btn gold" data-eact="new">+ Tạo mẫu ảnh</button>'}
      </div>
      <div class="tpl-grid">
        ${S.imageTemplates.map(t => `<div class="panel tpl-card" data-id="${t.id}">
          <div class="row"><b class="grow">${esc(t.name)}</b><span class="muted">${t.images.length} ảnh</span></div>
          <div class="muted" style="font-size:13px;margin-bottom:8px">Bốc ${t.default_max} ảnh / bài</div>
          ${t.images.length ? small(t.images, 11) : '<p class="hint">Chưa có ảnh</p>'}
          <div class="row" style="margin-top:12px;flex-wrap:wrap">
            <button class="btn sm gold" data-cact="use" ${t.images.length ? '' : 'disabled'}>Dùng để đăng bài</button>
            <button class="btn sm" data-cact="edit">Sửa</button>
            <button class="btn sm danger-text" data-cact="delete">Xoá</button>
          </div>
        </div>`).join('') || (e ? '' : '<div class="empty">Chưa có mẫu ảnh nào</div>')}
      </div>`;

    $('#view').oninput = ev => {
      const k = ev.target.dataset.e;
      if (k && this.editing) this.editing[k] = k === 'default_max' ? Math.max(1, Math.min(10, +ev.target.value || 1)) : ev.target.value;
    };
    $('#view').onchange = guard(async ev => {
      if (ev.target.id !== 'tplImgInput' || !ev.target.files.length) return;
      const files = [...ev.target.files].slice(0, 200 - this.editing.images.length);
      for (let i = 0; i < files.length; i += 50) {
        const fd = new FormData();
        files.slice(i, i + 50).forEach(f => fd.append('files', f));
        this.editing.images.push(...(await api('/api/upload', 'POST', fd)).files);
      }
      this.render();
    });
    $('#view').onclick = guard(async ev => {
      const b = ev.target.closest('button');
      if (!b) return;
      const e2 = this.editing;
      const card = S.imageTemplates.find(t => t.id === +b.closest('.tpl-card')?.dataset.id);
      if (b.dataset.erm) e2.images.splice(+b.dataset.erm, 1);
      else if (b.dataset.eact === 'clear') e2.images = [];
      else if (b.dataset.eact === 'new') this.editing = { name: '', default_max: 3, images: [] };
      else if (b.dataset.eact === 'cancel') this.editing = null;
      else if (b.dataset.eact === 'save') {
        if (!e2.name.trim()) throw new Error('Chưa nhập tên mẫu');
        const body = { name: e2.name, default_max: e2.default_max, images: e2.images };
        if (e2.id) await api(`/api/image-templates/${e2.id}`, 'PUT', body);
        else await api('/api/image-templates', 'POST', body);
        toast('Đã lưu mẫu ảnh');
        this.editing = null;
      }
      else if (b.dataset.cact === 'edit') { this.editing = { id: card.id, name: card.name, default_max: card.default_max, images: [...card.images] }; scrollTo(0, 0); }
      else if (b.dataset.cact === 'delete') {
        if (!await confirmBox(`Xoá mẫu ảnh "${esc(card.name)}"? Các bài đã lên lịch vẫn dùng bản sao ảnh của mẫu.`, 'Xoá')) return;
        await api(`/api/image-templates/${card.id}`, 'DELETE');
      }
      else if (b.dataset.cact === 'use') {
        Object.assign(S.form, { kind: 'post', contentMode: 'all' });
        S.form.imgTpls.add(card.id);
        return go('studio');
      }
      else return;
      this.render();
    });
  },
};

// ================= Nhật ký =================
views.logs = {
  title: 'Nhật ký hoạt động',
  async render() {
    const logs = await api('/api/logs?limit=300');
    $('#view').innerHTML = `<div class="panel"><table class="table">
      <thead><tr><th>Thời gian</th><th>Tài khoản</th><th>Task</th><th>Nội dung</th></tr></thead>
      <tbody>${logs.map(l => `<tr><td class="muted" style="white-space:nowrap">${fmt(l.created_at)}</td><td>${esc(l.account_name || '–')}</td>
        <td>${l.task_id ? `<a href="#" data-task="${l.task_id}">#${l.task_id}</a>` : '–'}</td>
        <td style="${l.level === 'error' ? 'color:var(--red)' : ''}">${esc(l.message)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Chưa có nhật ký</td></tr>'}</tbody>
    </table></div>`;
    $('#view').onclick = e => {
      const id = e.target.dataset.task;
      if (id) { e.preventDefault(); S.active = +id; go('studio'); }
    };
  },
  refresh() { return this.render(); },
};

// ================= Cài đặt =================
views.settings = {
  title: 'Cài đặt',
  async render() {
    const s = await api('/api/settings');
    const num = (k, label, hint, unit = '') => `<label class="lbl">${label}</label>
      <div class="row"><input type="number" min="0" class="input" name="${k}" value="${esc(s[k])}" style="max-width:160px"><span class="muted">${unit}</span></div><p class="hint">${hint}</p>`;
    $('#view').innerHTML = `
      <form class="panel" id="setForm" style="max-width:640px">
        <label class="switch"><input type="checkbox" name="runner_enabled" ${s.runner_enabled === '1' ? 'checked' : ''}><span class="knob"></span><span>Bật bộ chạy lịch tự động</span></label>
        <label class="switch"><input type="checkbox" name="headless" ${s.headless === '1' ? 'checked' : ''}><span class="knob"></span><span>Chạy ẩn trình duyệt <small class="muted">(tắt để xem trực tiếp thao tác — nên tắt khi mới dùng)</small></span></label>
        ${num('max_concurrent', 'Số tài khoản chạy song song', 'Mỗi tài khoản mở 1 trình duyệt riêng, tốn ~300MB RAM.', 'tài khoản')}
        ${num('min_gap_seconds', 'Khoảng nghỉ tối thiểu giữa 2 thao tác của cùng tài khoản', 'Thao tác quá dày dễ bị Facebook hạn chế tính năng. Khuyến nghị ≥ 120 giây.', 'giây')}
        ${num('daily_limit', 'Giới hạn thao tác / tài khoản / ngày', 'Vượt giới hạn thì task sẽ chờ sang ngày hôm sau.', 'lần')}
        ${num('max_attempts', 'Số lần thử tối đa khi lỗi', 'Tự thử lại sau 5 phút (trừ lỗi hết phiên / checkpoint).', 'lần')}
        <div class="modal-actions"><button class="btn gold">Lưu cài đặt</button></div>
      </form>`;
    $('#setForm').onsubmit = guard(async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = Object.fromEntries(fd);
      body.runner_enabled = fd.has('runner_enabled') ? '1' : '0';
      body.headless = fd.has('headless') ? '1' : '0';
      await api('/api/settings', 'PUT', body);
      toast('Đã lưu cài đặt');
      refreshStatus();
    });
  },
};

// ================= Router =================
async function go(view) {
  S.view = view;
  $$('.nav').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#viewTitle').textContent = views[view].title;
  $('#view').onclick = $('#view').oninput = $('#view').onchange = null;
  if (view === 'studio') await loadBase().catch(() => {});
  await guard(() => views[view].render())();
}
$$('.nav').forEach(b => b.onclick = () => go(b.dataset.view));

setInterval(async () => {
  try {
    await refreshStatus();
    if (!$('#modal').open) await views[S.view].refresh?.call(views[S.view]);
  } catch { /* server tạm mất kết nối */ }
}, 4000);

(async () => {
  await refreshStatus().catch(e => toast(e.message, 'error'));
  await go('studio');
})();
