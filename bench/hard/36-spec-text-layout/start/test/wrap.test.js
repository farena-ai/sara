import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wrapText } from '../src/index.js';

test('R9: greedy filling', () => {
  assert.deepEqual(wrapText('one two three four', 9), ['one two', 'three', 'four']);
  assert.deepEqual(wrapText('one two three four', 13), ['one two three', 'four']);
  assert.deepEqual(wrapText('a b c', 5), ['a b c']);
});

test('R7: paragraphs', () => {
  assert.deepEqual(wrapText('one\ntwo', 20), ['one', 'two']);
  assert.deepEqual(wrapText('one\r\ntwo', 20), ['one', 'two']);
  assert.deepEqual(wrapText('', 5), ['']);
});

test('R8: spaces between words collapse', () => {
  assert.deepEqual(wrapText('a   b', 10), ['a b']);
  assert.deepEqual(wrapText('  lead and trail  ', 30), ['lead and trail']);
});

test('R9: wide characters count double', () => {
  assert.deepEqual(wrapText('中文 中文', 5), ['中文', '中文']);
  assert.deepEqual(wrapText('中文 ab', 7), ['中文 ab']);
});
