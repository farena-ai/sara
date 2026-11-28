import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignText, charWidth, clusters, normalizeText, textWidth, truncateText, wrapText } from '../src/index.js';

test('R1: code points outside the BMP and the range ends', () => {
  assert.equal(charWidth(0x1f600), 2);
  assert.equal(charWidth(0x1f650), 1);
  assert.equal(charWidth(0x1f9ff), 2);
  assert.equal(charWidth(0xfe2f), 0);
  assert.equal(charWidth(0x20d0), 0);
  assert.equal(charWidth(0x115f), 2);
  assert.equal(charWidth(0x1160), 1);
  assert.equal(textWidth('\u{1F600}a'), 3);
});

test('R2: clusters join width-0 code points to the one before', () => {
  assert.deepEqual(clusters('éx'), ['é', 'x']);
  assert.deepEqual(clusters('́a'), ['́', 'a']);
  assert.deepEqual(clusters('\u{1F600}⃐b'), ['\u{1F600}⃐', 'b']);
  assert.deepEqual(clusters('á̂中'), ['á̂', '中']);
});

test('R3 R2: width of text with marks and wide characters', () => {
  assert.equal(textWidth('á̂中'), 3);
  assert.equal(textWidth('\u{1F600}\u{1F600}'), 4);
});

test('R4: line breaks and tabs', () => {
  assert.equal(normalizeText('a\r\nb\rc\td'), 'a\nb\nc d');
  assert.deepEqual(wrapText('a\rb', 5), ['a', 'b']);
  assert.deepEqual(wrapText('a\tb', 3), ['a b']);
});

test('R5: orphan marks are removed', () => {
  assert.equal(normalizeText('́a ́̂b\ñc'), 'a b\nc');
  assert.deepEqual(wrapText('x ́y', 5), ['x y']);
  assert.equal(normalizeText('é'), 'é');
});

test('R7: empty and blank paragraphs give one empty line each', () => {
  assert.deepEqual(wrapText('a\n\n   \nb', 5), ['a', '', '', 'b']);
  assert.deepEqual(wrapText('\n', 5), ['', '']);
});

test('R8: only U+0020 separates words', () => {
  assert.deepEqual(wrapText('a   b', 10), ['a   b']);
  assert.deepEqual(wrapText('a b c', 3), ['a b', 'c']);
});

test('R9: a word fits when the line is exactly full', () => {
  assert.deepEqual(wrapText('abc de f', 6), ['abc de', 'f']);
  assert.deepEqual(wrapText('中文 中 a', 6), ['中文', '中 a']);
});

test('R10: a long word starts a new line and its last piece takes the next words', () => {
  assert.deepEqual(wrapText('ab abcdefghij c', 4), ['ab', 'abcd', 'efgh', 'ij c']);
  assert.deepEqual(wrapText('abcdefgh', 4), ['abcd', 'efgh']);
});

test('R10 R2: breaking never splits a cluster', () => {
  assert.deepEqual(wrapText('aé̂iou', 2), ['aé̂', 'io', 'u']);
});

test('R10 R1: breaking by code point, wide characters do not fit in one column', () => {
  assert.deepEqual(wrapText('\u{1F600}\u{1F600}\u{1F600}', 5), ['\u{1F600}\u{1F600}', '\u{1F600}']);
  assert.deepEqual(wrapText('a中文', 2), ['a', '中', '文']);
});

test('R11: a cluster wider than the width becomes "?"', () => {
  assert.deepEqual(wrapText('中x', 1), ['?', 'x']);
  assert.deepEqual(wrapText('ab 中', 1), ['a', 'b', '?']);
});

test('R12: text that fits is flattened and shown without an ellipsis', () => {
  assert.equal(truncateText('short', 10), 'short');
  assert.equal(truncateText('a\nb   c', 10), 'a b c');
  assert.equal(truncateText('abcde', 5), 'abcde');
  assert.equal(truncateText('  ab\n\ncd  ', 5), 'ab cd');
});

test('R13: ellipsis after the longest prefix, trailing spaces removed', () => {
  assert.equal(truncateText('abc defgh', 5), 'abc…');
  assert.equal(truncateText('中文字', 4), '中…');
  assert.equal(truncateText('abcdef', 5, '..'), 'abc..');
});

test('R13 R2: truncation keeps clusters whole', () => {
  assert.equal(truncateText('xééé', 3), 'xé…');
});

test('R14: the ellipsis alone when there is no room', () => {
  assert.equal(truncateText('abcdef', 1), '…');
  assert.equal(truncateText('abcdef', 3, '...'), '...');
  assert.equal(truncateText('abcdef', 2, '中x'), '中');
});

test('R25: centering puts the odd space on the right', () => {
  assert.equal(alignText('ab', 5, 'center'), ' ab  ');
  assert.equal(alignText('中', 5, 'center'), ' 中  ');
  assert.equal(alignText('abcd', 6, 'center'), ' abcd ');
  assert.equal(alignText('ab', 4, 'right'), '  ab');
});
