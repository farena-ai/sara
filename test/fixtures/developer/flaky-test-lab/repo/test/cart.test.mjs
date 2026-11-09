import test from 'node:test';
import assert from 'node:assert/strict';

// The seed Flaky Test Lab sets while this module loads (1 when run directly).
const seed = globalThis.SARA_FLAKY_SEED ?? 1;

test('stable sum', () => {
  assert.equal(1 + 1, 2);
});

test('always broken', () => {
  assert.equal(1 + 1, 3);
});

// Intermittent on purpose: fails for seeds 5, 10, 15 and 20.
test('intermittent stock check', () => {
  assert.notEqual(seed % 5, 0, `stock race with seed ${seed}`);
});

test('slow intermittent', async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.notEqual(seed % 2, 0);
});
