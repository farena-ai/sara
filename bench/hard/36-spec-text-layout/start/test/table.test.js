import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderTable } from '../src/index.js';
import { page } from './helpers.js';

test('R32: the ascii style', () => {
  const out = renderTable({
    columns: [{ header: 'Name' }, { header: 'Qty', align: 'right' }],
    rows: [['pear', 3], ['fig', 12]],
  });
  assert.equal(
    out,
    page(
      '+------+-----+',
      '| Name | Qty |',
      '+======+=====+',
      '| pear |   3 |',
      '| fig  |  12 |',
      '+------+-----+',
    ),
  );
});

test('R35: no header without header properties', () => {
  const out = renderTable({ columns: [{}, {}], rows: [['a', 'b']] });
  assert.equal(out, page('+---+---+', '| a | b |', '+---+---+'));
});

test('R33 R34: the none style has no trailing spaces', () => {
  const out = renderTable({
    style: 'none',
    columns: [{ header: 'Key' }, { header: 'Value' }],
    rows: [['a', 'one'], ['bb', '']],
  });
  assert.equal(out, page('Key  Value', '---  -----', 'a    one', 'bb'));
});

test('R9 R31: wrapped cells make the row taller', () => {
  const out = renderTable({
    columns: [{ width: 5 }, { width: 3 }],
    rows: [['one two', 'x']],
  });
  assert.equal(out, page('+-------+-----+', '| one   | x   |', '| two   |     |', '+-------+-----+'));
});
