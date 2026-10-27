import test from 'node:test';
import assert from 'node:assert/strict';
import { read } from 'text-kit';

test('patched line lookup preserves Unicode, blank lines, line boundaries, and EOF positions', () => {
  const reader = read('a\n日本語\n\nlast');
  for (const [offset, line, column] of [
    [0, 1, 1], [1, 1, 2], [2, 2, 1], [4, 2, 3],
    [5, 2, 4], [6, 3, 1], [7, 4, 1], [10, 4, 4], [11, 4, 5],
  ]) {
    const point = { offset, line, column };
    assert.deepEqual(reader.toPoint(offset), point);
    assert.equal(reader.toIndex({ line, column }), offset);
  }
  assert.deepEqual(read('').toPoint(0), { offset: 0, line: 1, column: 1 });
});

test('range readers share positions but retain independent cursors and bounds', () => {
  const reader = read('one\ntwo\nthree');
  const first = reader.read({ start: 0, end: 3 });
  const second = reader.read({ start: 4, end: 7 });
  assert.equal(first.eat('line').value, 'one');
  assert.equal(first.getChar(), undefined);
  assert.equal(second.getChar(), 't');
  assert.deepEqual(second.now(), { line: 2, column: 1, offset: 4 });
  assert.equal(reader.getChar(), 'o');
  assert.equal(second.eat('line').value, 'two');
  assert.equal(second.getChar(), undefined);
});
