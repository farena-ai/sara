import assert from 'node:assert/strict';
import test from 'node:test';
import { total } from '../src/cart.ts';

test('total applies the discount once', () => {
  assert.equal(total([{ price: 50, qty: 3 }], 10), 135);
});
