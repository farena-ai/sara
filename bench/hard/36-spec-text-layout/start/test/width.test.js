import assert from 'node:assert/strict';
import { test } from 'node:test';
import { charWidth, textWidth } from '../src/index.js';

test('R1: widths from the table', () => {
  assert.equal(charWidth(0x41), 1);
  assert.equal(charWidth(0x4e2d), 2);
  assert.equal(charWidth(0xac00), 2);
  assert.equal(charWidth(0x0301), 0);
  assert.equal(charWidth(0x00e9), 1);
  assert.equal(charWidth(0x3000), 2);
  assert.equal(charWidth(0x303f), 1);
});

test('R3: text width is the sum', () => {
  assert.equal(textWidth('abc'), 3);
  assert.equal(textWidth('中文'), 4);
  assert.equal(textWidth('é'), 1);
  assert.equal(textWidth(''), 0);
});
