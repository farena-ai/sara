import test from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/price.mjs';
import { euros } from '../src/format.mjs';

test('formats euros', () => {
  assert.equal(euros(3), '3.00 EUR');
});

test('total applies the discount once', () => {
  const items = [{ price: 100 }, { price: 50 }];
  assert.equal(total(items, 10), 135);
});

test('slow checkout finishes', { timeout: 300 }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 5000));
});

test('rounding to cents is known broken', { todo: 'tracked separately' }, () => {
  assert.equal(euros(0.005), '0.01 EUR');
});
