import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LayoutError, columnWidths } from '../src/index.js';

test('R19: auto columns take their natural width', () => {
  const widths = columnWidths({
    columns: [{ header: 'Name' }, { header: 'City' }],
    rows: [['Ann', 'Rotterdam'], ['Bartholomew', 'Ely']],
  });
  assert.deepEqual(widths, [11, 9]);
});

test('R19: the widest paragraph counts, not the whole text', () => {
  assert.deepEqual(columnWidths({ columns: [{}], rows: [['first line\nsecond']] }), [10]);
});

test('R18: min and max clamp auto columns', () => {
  const widths = columnWidths({
    columns: [{ min: 6 }, { max: 4 }, { width: 3, min: 5 }],
    rows: [['ab', 'abcdefgh', 'x']],
  });
  assert.deepEqual(widths, [6, 4, 3]);
});

test('R16: invalid columns are a LayoutError', () => {
  assert.throws(() => columnWidths({ columns: [{ width: 3, flex: 1 }], rows: [] }), LayoutError);
  assert.throws(() => columnWidths({ columns: [{ width: 0 }], rows: [] }), LayoutError);
  assert.throws(() => columnWidths({ columns: [{ min: 5, max: 4 }], rows: [] }), LayoutError);
  assert.throws(() => columnWidths({ columns: [{ percent: 60 }, { percent: 41 }], width: 50, rows: [] }), LayoutError);
});
