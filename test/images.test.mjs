import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseImages, pickFromTemplate, pickImages, rotateSlice, shuffle } from '../src/images.js';

const pool = ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg'];

test('shuffle giữ đủ phần tử, không sửa mảng gốc', () => {
  const copy = [...pool];
  const out = shuffle(pool);
  assert.deepEqual([...out].sort(), copy);
  assert.deepEqual(pool, copy);
});

test('dùng tất cả: giữ nguyên thứ tự, hoặc đảo khi bật shuffle', () => {
  assert.deepEqual(pickImages(pool, {}), pool);
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const out = pickImages(pool, { shuffle: true });
    assert.deepEqual([...out].sort(), pool);
    seen.add(out.join());
  }
  assert.ok(seen.size > 1, 'thứ tự phải thay đổi giữa các lần');
});

test('ngẫu nhiên: số ảnh nằm trong khoảng min–max, không trùng, lấy từ kho', () => {
  const counts = new Set();
  const picked = new Set();
  for (let i = 0; i < 200; i++) {
    const out = pickImages(pool, { mode: 'random', min: 2, max: 4 });
    assert.ok(out.length >= 2 && out.length <= 4);
    assert.equal(new Set(out).size, out.length);
    // không đảo thì giữ thứ tự như trong kho
    assert.deepEqual(out, pool.filter(f => out.includes(f)));
    counts.add(out.length);
    out.forEach(f => picked.add(f));
  }
  assert.deepEqual([...counts].sort(), [2, 3, 4]);
  assert.equal(picked.size, pool.length, 'mọi ảnh đều có cơ hội được chọn');
});

test('ngẫu nhiên: max vượt kho thì giới hạn theo kho, min 0 cho phép không ảnh', () => {
  assert.equal(pickImages(['a'], { mode: 'random', min: 3, max: 9 }).length, 1);
  assert.equal(pickImages(pool, { mode: 'random', min: 0, max: 1 }, () => 0).length, 0);
  assert.deepEqual(pickImages([], { mode: 'random', min: 1, max: 3 }), []);
});

test('luân phiên: chia cụm ảnh kế tiếp và quay vòng', () => {
  assert.deepEqual([0, 1, 2].map(i => rotateSlice(pool, i, 2)), [['1.jpg', '2.jpg'], ['3.jpg', '4.jpg'], ['5.jpg', '1.jpg']]);
  assert.deepEqual([0, 1, 5].map(i => rotateSlice(pool, i, 1)), [['1.jpg'], ['2.jpg'], ['1.jpg']]);
  assert.deepEqual(rotateSlice(['a', 'b'], 0, 5), ['a', 'b']);
});

const tplA = { id: 1, name: 'A', max: 3, pool: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] };
const tplB = { id: 2, name: 'B', max: 2, pool: ['b1', 'b2', 'b3', 'b4'] };

test('mẫu ảnh: bốc đúng số ảnh tối đa của từng mẫu, ngẫu nhiên giữa các lần', () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const out = chooseImages([], { templates: [tplA, tplB] });
    assert.equal(out.length, 5);
    assert.equal(out.filter(f => f.startsWith('a')).length, 3);
    assert.equal(out.filter(f => f.startsWith('b')).length, 2);
    assert.equal(new Set(out).size, 5);
    seen.add(out.join());
  }
  assert.ok(seen.size > 10);
});

test('mẫu ảnh: mẫu ít ảnh hơn số tối đa thì lấy hết, giữ thứ tự trong mẫu', () => {
  assert.deepEqual(pickFromTemplate(['x', 'y'], 5), ['x', 'y']);
  const out = pickFromTemplate(tplA.pool, 3);
  assert.deepEqual(out, tplA.pool.filter(f => out.includes(f)));
});

test('mẫu ảnh kết hợp kho riêng, giới hạn mỗi bài', () => {
  const out = chooseImages(['k1', 'k2'], { templates: [tplA] });
  assert.deepEqual(out.slice(0, 2), ['k1', 'k2']);
  assert.ok(out.slice(2).every(f => f.startsWith('a')) && out.length === 5);
  // bình luận: chỉ 1 ảnh, lấy từ các ảnh đã bốc
  for (let i = 0; i < 20; i++) {
    const one = chooseImages([], { templates: [{ ...tplA, max: 1 }, { ...tplB, max: 1 }] }, { per: 1 });
    assert.equal(one.length, 1);
  }
  // ảnh trùng giữa kho và mẫu không bị lặp
  const dup = chooseImages(['a1'], { templates: [{ ...tplA, max: 6 }] });
  assert.equal(new Set(dup).size, dup.length);
  assert.equal(dup.length, 6);
});
