import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LayoutError, columnWidths, renderTable } from '../src/index.js';

test('R16: more invalid columns', () => {
  for (const column of [{ percent: 0 }, { percent: 2.5 }, { percent: 101 }, { flex: 1.5 }, { flex: 0 }, { maxLines: 0 }, { percent: 10, flex: 1 }]) {
    assert.throws(() => columnWidths({ width: 40, columns: [column], rows: [] }), LayoutError, JSON.stringify(column));
  }
});

test('R17 R21: flex shares fill the budget exactly', () => {
  assert.deepEqual(columnWidths({ width: 40, columns: [{ flex: 1 }, { flex: 1 }, { flex: 1 }], rows: [] }), [10, 10, 10]);
  assert.deepEqual(columnWidths({ width: 41, columns: [{ flex: 1 }, { flex: 1 }, { flex: 1 }], rows: [] }), [11, 10, 10]);
  const out = renderTable({ width: 30, columns: [{ flex: 1 }, { flex: 1 }], rows: [['a', 'b']] });
  for (const line of out.split('\n').filter(Boolean)) assert.equal(line.length, 30);
});

test('R21: leftover units go to the largest remainders, ties to the left', () => {
  assert.deepEqual(columnWidths({ width: 33, columns: [{ flex: 3 }, { flex: 2 }, { flex: 2 }], rows: [] }), [10, 7, 6]);
});

test('R17: the budget of the none style', () => {
  assert.deepEqual(columnWidths({ width: 20, style: 'none', columns: [{ flex: 1 }, { flex: 1 }, { flex: 1 }], rows: [] }), [6, 5, 5]);
});

test('R20: percent columns round down', () => {
  assert.deepEqual(columnWidths({ width: 50, columns: [{ percent: 33 }, { percent: 33 }, { flex: 1 }], rows: [] }), [13, 13, 14]);
});

test('R20 R18: percent columns are clamped', () => {
  assert.deepEqual(columnWidths({ width: 30, columns: [{ percent: 1 }, { percent: 50, max: 5 }, { flex: 1 }], rows: [] }), [1, 5, 14]);
});

test('R22: width freed by a max goes to the other flex columns', () => {
  assert.deepEqual(columnWidths({ width: 27, columns: [{ flex: 1, max: 3 }, { flex: 1 }], rows: [] }), [3, 17]);
});

test('R22: rounds of max then min', () => {
  const widths = columnWidths({ width: 61, columns: [{ flex: 1, max: 5 }, { flex: 1 }, { flex: 2, min: 30 }, { width: 4 }], rows: [] });
  assert.deepEqual(widths, [5, 9, 30, 4]);
});

test('R22: width no flex column can take is left unused', () => {
  const t = { width: 27, columns: [{ flex: 1, max: 3 }, { flex: 1, max: 4 }], rows: [['a', 'b']] };
  assert.deepEqual(columnWidths(t), [3, 4]);
  assert.equal(renderTable(t).split('\n')[0], '+-----+------+');
});

test('R18 R22: min defaults to 1 for flex columns', () => {
  assert.deepEqual(columnWidths({ width: 17, columns: [{ width: 5 }, { flex: 1 }, { flex: 5 }], rows: [] }), [5, 1, 1]);
});

test('R23: shrinking takes the widest, rightmost first', () => {
  const t = { width: 25, columns: [{}, {}, {}], rows: [['aaaaaaaa', 'bbbbbbbb', 'cc']] };
  assert.deepEqual(columnWidths(t), [7, 6, 2]);
});

test('R23 R18: shrinking stops at min and never touches fixed columns', () => {
  const t = { width: 24, columns: [{ width: 6 }, { min: 5 }, {}], rows: [['x', 'abcdefgh', 'abcdefgh']] };
  assert.deepEqual(columnWidths(t), [6, 5, 3]);
});

test('R23: a table that cannot fit is a LayoutError', () => {
  assert.throws(() => columnWidths({ width: 12, columns: [{ width: 5 }, { width: 5 }], rows: [] }), LayoutError);
  assert.throws(() => columnWidths({ width: 14, columns: [{ width: 5 }, { min: 4 }], rows: [] }), LayoutError);
});

test('R20 R23: percent columns can be shrunk', () => {
  assert.deepEqual(columnWidths({ width: 30, columns: [{ percent: 100 }, {}], rows: [['', 'abcdef']] }), [17, 6]);
});

test('R21 R23: auto columns take the room first, flex columns keep their min', () => {
  assert.deepEqual(columnWidths({ width: 20, columns: [{}, { flex: 1 }], rows: [['abcdefghijklmnop', 'x']] }), [12, 1]);
});

test('R24: without a width, flex is auto and percent is an error', () => {
  assert.deepEqual(columnWidths({ columns: [{ flex: 1 }, { flex: 3, max: 2 }], rows: [['abc', 'abcdef']] }), [3, 2]);
  assert.throws(() => columnWidths({ columns: [{ percent: 50 }], rows: [] }), LayoutError);
});

test('R19: truncate columns measure the flattened text, spans do not count', () => {
  assert.deepEqual(columnWidths({ columns: [{ overflow: 'truncate' }, {}], rows: [['ab\ncd', 'ab\ncd']] }), [5, 2]);
  assert.deepEqual(columnWidths({ columns: [{}, {}], rows: [[{ text: 'very long spanning text', span: 2 }], ['a', 'b']] }), [1, 1]);
  assert.deepEqual(columnWidths({ columns: [{ header: 'Long\nH' }, {}], rows: [['  a    b  ', 'x\ty']] }), [4, 3]);
});

test('R19 R27: a decimal column is at least D wide', () => {
  assert.deepEqual(columnWidths({ columns: [{ align: 'decimal' }], rows: [['12.5'], ['3'], ['-100']] }), [6]);
});
