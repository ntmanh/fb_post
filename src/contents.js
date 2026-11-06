// Chọn nội dung ngẫu nhiên từ mẫu: chỉ bốc trong các mẫu chưa dùng (used = 0),
// tránh mẫu đang được task khác giữ chỗ (reserved) nếu còn lựa chọn khác.
// Mẫu được đánh dấu đã dùng sau khi đăng thành công; dùng hết thì cả bộ được khôi phục (xem runner).
export function pickUnused(items, reserved = new Set(), rand = Math.random) {
  if (!items.length) return null;
  const unused = items.filter(i => !i.used);
  const free = unused.filter(i => !reserved.has(i.id));
  const pool = free.length ? free : unused.length ? unused : items;
  return pool[Math.floor(rand() * pool.length)];
}

export const randomContentLabel = n => `🎲 Ngẫu nhiên từ ${n} mẫu nội dung`;
