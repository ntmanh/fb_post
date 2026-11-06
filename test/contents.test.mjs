import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickUnused } from '../src/contents.js';

test('chỉ bốc trong các mẫu chưa dùng, ngẫu nhiên giữa chúng', () => {
  const items = [{ id: 1, used: 1 }, { id: 2, used: 0 }, { id: 3, used: 0 }];
  const seen = new Set(Array.from({ length: 100 }, () => pickUnused(items).id));
  assert.deepEqual([...seen].sort(), [2, 3]);
});

test('tránh mẫu đang được task khác giữ chỗ nếu còn mẫu chưa dùng khác', () => {
  const items = [{ id: 1, used: 0 }, { id: 2, used: 0 }];
  for (let i = 0; i < 20; i++) assert.equal(pickUnused(items, new Set([1])).id, 2);
  // mọi mẫu chưa dùng đều bị giữ chỗ → vẫn bốc trong số chưa dùng
  assert.equal(pickUnused([{ id: 1, used: 0 }, { id: 2, used: 1 }], new Set([1])).id, 1);
});

test('tất cả đã dùng thì bốc trong toàn bộ, danh sách rỗng trả về null', () => {
  assert.ok([1, 2].includes(pickUnused([{ id: 1, used: 1 }, { id: 2, used: 1 }]).id));
  assert.equal(pickUnused([{ id: 5, content: 'bản sao' }]).id, 5);
  assert.equal(pickUnused([]), null);
});
