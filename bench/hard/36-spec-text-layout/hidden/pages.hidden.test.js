import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LayoutError, renderPages, renderTable } from '../src/index.js';
import { page } from './helpers.js';

test('R37 R38: rows move to the next page whole, with their row rule', () => {
  const pages = renderPages({
    pageHeight: 8,
    rowRules: true,
    columns: [{ header: 'N', width: 2 }, { header: 'Text', width: 6 }],
    rows: [['1', 'aa'], ['2', 'bb cc dd'], ['3', 'ee'], ['4', 'ff gg hh ii jj kk ll']],
  });
  const top = ['+----+--------+', '| N  | Text   |', '+====+========+'];
  assert.deepEqual(pages, [
    page(...top, '| 1  | aa     |', '+----+--------+', '| 2  | bb cc  |', '|    | dd     |', '+----+--------+'),
    page(...top, '| 3  | ee     |', '+----+--------+'),
    page(...top, '| 4  | ff gg  |', '|    | hh ii  |', '|    | jj kk  |', '|    | ll     |', '+----+--------+'),
  ]);
});

test('R38: a row taller than a page is split; no row rule at the top of a page', () => {
  const pages = renderPages({
    pageHeight: 7,
    rowRules: true,
    columns: [{ width: 1 }, { width: 3 }],
    rows: [['a', 'x'], ['b', '1 2 3 4 5 6 7 8 9 10 11 12'], ['c', 'y']],
  });
  const r = '+---+-----+';
  assert.deepEqual(pages, [
    page(r, '| a | x   |', r),
    page(r, '| b | 1 2 |', '|   | 3 4 |', '|   | 5 6 |', '|   | 7 8 |', '|   | 9   |', r),
    page(r, '|   | 10  |', '|   | 11  |', '|   | 12  |', r, '| c | y   |', r),
  ]);
});

test('R38 R31: vertical alignment is applied before splitting', () => {
  const pages = renderPages({ pageHeight: 4, columns: [{ width: 1, valign: 'bottom' }, { width: 1 }], rows: [['x', 'a b c']] });
  assert.deepEqual(pages, [page('+---+---+', '|   | a |', '|   | b |', '+---+---+'), page('+---+---+', '| x | c |', '+---+---+')]);
});

test('R39: repeatHeader false shows the header on the first page only', () => {
  const pages = renderPages({ pageHeight: 5, repeatHeader: false, columns: [{ header: 'H', width: 3 }], rows: [['a'], ['b'], ['c'], ['d'], ['e']] });
  const r = '+-----+';
  assert.deepEqual(pages, [
    page(r, '| H   |', '+=====+', '| a   |', r),
    page(r, '| b   |', '| c   |', '| d   |', r),
    page(r, '| e   |', r),
  ]);
});

test('R39 R37: the header repeats by default', () => {
  const pages = renderPages({ pageHeight: 5, columns: [{ header: 'H', width: 3 }], rows: [['a'], ['b']] });
  assert.equal(pages.length, 2);
  assert.equal(pages[1], page('+-----+', '| H   |', '+=====+', '| b   |', '+-----+'));
});

test('R36 R37: the title takes room on the first page only', () => {
  const pages = renderPages({ title: 'T', pageHeight: 6, columns: [{ width: 3 }], rows: [['1'], ['2'], ['3'], ['4'], ['5'], ['6'], ['7']] });
  const r = '+-----+';
  assert.deepEqual(pages, [
    page('   T', '', r, '| 1   |', '| 2   |', r),
    page(r, '| 3   |', '| 4   |', '| 5   |', '| 6   |', r),
    page(r, '| 7   |', r),
  ]);
});

test('R37: a page too small for its frame is a LayoutError', () => {
  assert.throws(() => renderPages({ pageHeight: 4, columns: [{ header: 'H' }], rows: [['a']] }), LayoutError);
  assert.equal(renderPages({ pageHeight: 5, columns: [{ header: 'H' }], rows: [['a']] }).length, 1);
  assert.throws(() => renderPages({ pageHeight: 5, title: 'T', columns: [{ header: 'H' }], rows: [['a']] }), LayoutError);
});

test('R37: a table without rows is one page with its frame', () => {
  assert.deepEqual(renderPages({ pageHeight: 10, columns: [{ header: 'A' }], rows: [] }), [page('+---+', '| A |', '+===+', '+---+')]);
});

test('R37 R33 R34: pages in the none style, joined by form feeds', () => {
  const out = renderTable({ style: 'none', pageHeight: 3, columns: [{ header: 'K' }, { header: 'V' }], rows: [['a', '1'], ['b', '2'], ['c', '3']] });
  assert.equal(out, [page('K  V', '-  -', 'a  1'), page('K  V', '-  -', 'b  2'), page('K  V', '-  -', 'c  3')].join('\f'));
});

test('R27 R37: decimal metrics cover every page', () => {
  const pages = renderPages({ pageHeight: 5, columns: [{ header: 'Amt', align: 'decimal' }], rows: [['1.5'], ['100']] });
  assert.deepEqual(pages, [
    page('+-------+', '|   Amt |', '+=======+', '|   1.5 |', '+-------+'),
    page('+-------+', '|   Amt |', '+=======+', '| 100   |', '+-------+'),
  ]);
});

test('R34: renderTable is the pages joined by form feeds', () => {
  const t = { pageHeight: 3, columns: [{ width: 1 }], rows: [['a'], ['b']] };
  assert.equal(renderTable(t), renderPages(t).join('\f'));
  assert.equal(renderTable(t), '+---+\n| a |\n+---+\n\f+---+\n| b |\n+---+\n');
});
