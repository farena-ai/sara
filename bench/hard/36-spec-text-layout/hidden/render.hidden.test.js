import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LayoutError, renderTable } from '../src/index.js';
import { page } from './helpers.js';

const box = (w) => '+' + '-'.repeat(w + 2) + '+';

test('R6: cell objects and their text', () => {
  const out = renderTable({ columns: [{}, {}], rows: [[{ text: 42 }, {}]] });
  assert.equal(out, page('+----+---+', '| 42 |   |', '+----+---+'));
  assert.throws(() => renderTable({ columns: [{}], rows: [[{ text: true }]] }), LayoutError);
  assert.throws(() => renderTable({ columns: [{}], rows: [[{ text: { a: 1 } }]] }), LayoutError);
});

test('R2 R5 R19: marks in cells are kept with their letter and take no width', () => {
  const out = renderTable({ columns: [{}], rows: [['Café'], ['́x']] });
  assert.equal(out, page(box(4), '| Café |', '| x    |', box(4)));
});

test('R12 R13: truncated cells', () => {
  const out = renderTable({ columns: [{ width: 6, overflow: 'truncate' }], rows: [['abcdefgh'], ['ab cd']] });
  assert.equal(out, page(box(6), '| abcde… |', '| ab cd  |', box(6)));
});

test('R13 R25: a truncated wide text is padded to the width', () => {
  const out = renderTable({ columns: [{ width: 4, overflow: 'truncate' }, { width: 5, overflow: 'truncate', align: 'right' }], rows: [['中文字', 'abc defgh']] });
  assert.equal(out, page('+------+-------+', '| 中…  |  abc… |', '+------+-------+'));
});

test('R13: the ellipsis option', () => {
  const out = renderTable({ ellipsis: '...', columns: [{ width: 6, overflow: 'truncate' }], rows: [['abcdefghij']] });
  assert.equal(out, page(box(6), '| abc... |', box(6)));
});

test('R15: maxLines marks the last kept line', () => {
  const out = renderTable({ columns: [{ width: 8, maxLines: 2 }], rows: [['one two three four five']] });
  assert.equal(out, page(box(8), '| one two  |', '| three…   |', box(8)));
});

test('R15 R13: a full last line is shortened for the ellipsis', () => {
  const out = renderTable({ columns: [{ width: 7, maxLines: 1 }], rows: [['abcdefg hij']] });
  assert.equal(out, page(box(7), '| abcdef… |', box(7)));
});

test('R15: no mark when the lines fit, an empty last line gets only the ellipsis', () => {
  const out = renderTable({ columns: [{ width: 3, maxLines: 2 }, { width: 5, maxLines: 2 }], rows: [['one two', 'a\n\nb']] });
  assert.equal(out, page('+-----+-------+', '| one | a     |', '| two | …     |', '+-----+-------+'));
});

test('R15 R35: maxLines does not limit the header', () => {
  const out = renderTable({ columns: [{ header: 'aa bb cc', width: 2, maxLines: 1 }], rows: [['x']] });
  assert.equal(out, page(box(2), '| aa |', '| bb |', '| cc |', '+====+', '| x  |', box(2)));
});

test('R26: headerAlign, and decimal headers are right-aligned', () => {
  const out = renderTable({ columns: [{ header: 'H', width: 5, align: 'right', headerAlign: 'center' }, { header: 'Q', align: 'decimal', width: 4 }], rows: [['a', '1']] });
  assert.equal(out, page('+-------+------+', '|   H   |    Q |', '+=======+======+', '|     a |    1 |', '+-------+------+'));
});

test('R26 R27: a cell with its own align is not decimal-aligned and does not count', () => {
  const out = renderTable({ columns: [{ align: 'decimal' }], rows: [['1.5'], [{ text: '1000.25', align: 'left' }], ['22']] });
  assert.equal(out, page(box(7), '|     1.5 |', '| 1000.25 |', '|    22   |', box(7)));
});

test('R27: what counts as a number', () => {
  const out = renderTable({ columns: [{ align: 'decimal' }], rows: [['1.25'], ['1.'], ['+5'], [' 7 '], ['.5']] });
  assert.equal(out, page(box(4), '| 1.25 |', '|   1. |', '|   +5 |', '| 7    |', '|   .5 |', box(4)));
});

test('R28: integers only', () => {
  const out = renderTable({ columns: [{ align: 'decimal' }], rows: [['5'], ['-12'], [0]] });
  assert.equal(out, page(box(3), '|   5 |', '| -12 |', '|   0 |', box(3)));
});

test('R28: when D does not fit, numbers are plain right-aligned text', () => {
  const out = renderTable({ columns: [{ align: 'decimal', width: 5 }], rows: [['123.456'], ['1.5']] });
  assert.equal(out, page(box(5), '| 123.4 |', '|    56 |', '|   1.5 |', box(5)));
});

test('R28 R25: the decimal block is right-aligned in a wider column', () => {
  const out = renderTable({ columns: [{ header: 'Amount', align: 'decimal' }], rows: [['1.5'], ['10']] });
  assert.equal(out, page(box(6), '| Amount |', '+========+', '|    1.5 |', '|   10   |', box(6)));
});

test('R29: short rows are filled, long rows and bad spans are errors', () => {
  assert.equal(renderTable({ columns: [{}, {}], rows: [['a']] }), page('+---+---+', '| a |   |', '+---+---+'));
  assert.throws(() => renderTable({ columns: [{}, {}], rows: [['a', 'b', 'c']] }), LayoutError);
  assert.throws(() => renderTable({ columns: [{}, {}], rows: [['a', { text: 'b', span: 2 }]] }), LayoutError);
  assert.throws(() => renderTable({ columns: [{}, {}], rows: [[{ text: 'b', span: 0 }]] }), LayoutError);
  assert.throws(() => renderTable({ columns: [{}, {}], rows: [[{ text: 'b', span: 1.5 }]] }), LayoutError);
});

test('R30: span widths in both styles', () => {
  const t = { columns: [{ width: 3 }, { width: 4 }], rows: [[{ text: 'abcdefghij', span: 2 }], ['a', 'b']] };
  assert.equal(renderTable(t), page('+-----+------+', '| abcdefghij |', '| a   | b    |', '+-----+------+'));
  assert.equal(renderTable({ ...t, style: 'none' }), page('abcdefghi', 'j', 'a    b'));
});

test('R30: a span uses the first column\'s overflow and alignment', () => {
  const out = renderTable({ columns: [{ width: 3, align: 'right', overflow: 'truncate' }, { width: 3 }], rows: [[{ text: 'abcdefghijkl', span: 2 }], ['a', 'b']] });
  assert.equal(out, page('+-----+-----+', '| abcdefgh… |', '|   a | b   |', '+-----+-----+'));
});

test('R30 R27: a span starting in a decimal column is right-aligned and not a number', () => {
  const out = renderTable({ columns: [{ align: 'decimal' }, { width: 2 }], rows: [['1.5'], [{ text: '7', span: 2 }]] });
  assert.equal(out, page('+-----+----+', '| 1.5 |    |', '|        7 |', '+-----+----+'));
});

test('R31: top, middle and bottom', () => {
  const out = renderTable({ columns: [{ width: 1 }, { width: 1, valign: 'middle' }, { width: 1, valign: 'bottom' }], rows: [['a b c d', 'x', 'y']] });
  assert.equal(out, page('+---+---+---+', '| a |   |   |', '| b | x |   |', '| c |   |   |', '| d |   | y |', '+---+---+---+'));
});

test('R31 R35: header cells are always top-aligned', () => {
  const out = renderTable({ columns: [{ header: 'a b', width: 1, valign: 'bottom' }, { header: 'z', width: 1, valign: 'bottom' }], rows: [] });
  assert.equal(out, page('+---+---+', '| a | z |', '| b |   |', '+===+===+', '+---+---+'));
});

test('R32: rowRules in the ascii style', () => {
  const out = renderTable({ rowRules: true, columns: [{ header: 'K' }], rows: [['a'], ['b']] });
  assert.equal(out, page('+---+', '| K |', '+===+', '| a |', '+---+', '| b |', '+---+'));
});

test('R33 R34: rowRules in the none style are empty lines; trailing spaces go', () => {
  const out = renderTable({ style: 'none', rowRules: true, columns: [{ header: 'K', width: 5 }, { header: 'V', width: 5 }], rows: [['a', ''], ['b', 'c']] });
  assert.equal(out, page('K      V', '-----  -----', 'a', '', 'b      c'));
});

test('R35: an empty header string still makes a header', () => {
  const out = renderTable({ columns: [{ header: '' }, {}], rows: [['x', 'y']] });
  assert.equal(out, page('+---+---+', '|   |   |', '+===+===+', '| x | y |', '+---+---+'));
});

test('R36 R34: the title is centered and trimmed in the ascii style', () => {
  assert.equal(renderTable({ title: 'Report', columns: [{ width: 10 }], rows: [['x']] }), page('    Report', '', box(10), '| x          |', box(10)));
  assert.equal(renderTable({ title: 'Abc', columns: [{ width: 10 }], rows: [] }), page('     Abc', '', box(10), box(10)));
  assert.equal(renderTable({ title: '売上', columns: [{ width: 10 }], rows: [] }).split('\n')[0], '     売上');
});

test('R36: the title is flattened and truncated to the line width', () => {
  assert.equal(renderTable({ title: 'A very long title indeed', columns: [{ width: 6 }], rows: [] }).split('\n')[0], 'A very lo…');
  assert.equal(renderTable({ title: '  Q1\n\nreport ', columns: [{ width: 10 }], rows: [] }).split('\n')[0], '  Q1 report');
  assert.equal(renderTable({ title: 'T', style: 'none', columns: [{ width: 4 }, { width: 4 }], rows: [] }), page('    T', ''));
});
