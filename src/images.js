// Chọn ảnh từ kho ảnh của task.
// opts: { mode: 'all' | 'random', min, max, shuffle }
//  - all:    dùng toàn bộ kho
//  - random: mỗi lần chạy bốc ngẫu nhiên từ min đến max ảnh
//  - shuffle: đảo thứ tự ảnh trước khi đăng
// Chế độ 'rotate' được chia sẵn lúc tạo task (rotateSlice), khi chạy coi như 'all'.

export const MAX_POOL = 50;
export const MAX_TEMPLATE_IMAGES = 200;
export const maxPerTask = kind => (kind === 'comment' ? 1 : 10);

export function shuffle(arr, rand = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function pickImages(pool, opts = {}, rand = Math.random) {
  if (!pool.length) return [];
  if (opts.mode === 'random') {
    const max = Math.min(opts.max ?? pool.length, pool.length);
    const min = Math.min(opts.min ?? max, max);
    const n = min + Math.floor(rand() * (max - min + 1));
    const chosen = shuffle(pool, rand).slice(0, n);
    return opts.shuffle ? chosen : pool.filter(f => chosen.includes(f));
  }
  return opts.shuffle ? shuffle(pool, rand) : [...pool];
}

// Bốc ngẫu nhiên đúng `max` ảnh từ một mẫu (ít hơn thì lấy hết), giữ thứ tự trong mẫu
export function pickFromTemplate(pool, max, rand = Math.random) {
  const chosen = shuffle(pool, rand).slice(0, max);
  return pool.filter(f => chosen.includes(f));
}

// Ảnh cuối cùng cho 1 lần chạy: ảnh từ kho riêng của task + ảnh bốc từ các mẫu ảnh.
// opts.templates = [{ id, name, max, pool }]
export function chooseImages(pool, opts = {}, { per = 10, rand = Math.random } = {}) {
  let list = pickImages(pool, { ...opts, shuffle: false }, rand);
  for (const t of opts.templates || []) {
    const src = (t.pool || []).filter(f => !list.includes(f));
    list = list.concat(pickFromTemplate(src, t.max, rand));
  }
  if (list.length > per) list = shuffle(list, rand).slice(0, per);
  return opts.shuffle ? shuffle(list, rand) : list;
}

// Task thứ index lấy cụm `count` ảnh kế tiếp trong kho, quay vòng khi hết
export function rotateSlice(pool, index, count) {
  if (!pool.length) return [];
  count = Math.min(count, pool.length);
  return Array.from({ length: count }, (_, j) => pool[(index * count + j) % pool.length]);
}
