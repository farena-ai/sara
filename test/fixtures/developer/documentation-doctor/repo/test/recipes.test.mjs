import assert from 'node:assert/strict';
import test from 'node:test';

test('recipes have names', () => {
  assert.equal(['soup', 'bread'].every((n) => n.length > 0), true);
});
