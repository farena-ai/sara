import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LayoutError, renderTable } from '../src/index.js';

test('R6: numbers and empty values', () => {
  const out = renderTable({ columns: [{}, {}, {}], rows: [[1.5, null, undefined]] });
  assert.equal(out, '+-----+---+---+\n| 1.5 |   |   |\n+-----+---+---+\n');
});

test('R6: other cell values are a LayoutError', () => {
  assert.throws(() => renderTable({ columns: [{}], rows: [[true]] }), LayoutError);
  assert.throws(() => renderTable({ columns: [{}], rows: [[['a']]] }), LayoutError);
});

test('unknown style is a LayoutError', () => {
  assert.throws(() => renderTable({ style: 'fancy', columns: [{}], rows: [] }), LayoutError);
});
