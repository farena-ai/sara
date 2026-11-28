import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveConfig } from '../src/config.js';
import { afterFailure, backoffDelay } from '../src/retry/backoff.js';

test('backoff doubles from backoffBaseMs and stops at backoffMaxMs', () => {
  const config = resolveConfig({ backoffBaseMs: 100, backoffMaxMs: 1000 });
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, config)), [100, 200, 400, 800, 1000, 1000]);
});

test('jitter only depends on the id and the attempt', () => {
  const config = resolveConfig({ jitterMs: 50 });
  const a = backoffDelay(2, config, 'evt-1');
  assert.equal(backoffDelay(2, config, 'evt-1'), a);
  assert.ok(a >= 200 && a <= 250);
});

test('the maxAttempts-th failure dead-letters', () => {
  const config = resolveConfig({ maxAttempts: 3 });
  assert.deepEqual(afterFailure({ id: 'x', attempts: 0 }, 1000, config), { kind: 'retry', attempts: 1, dueAt: 1100 });
  assert.deepEqual(afterFailure({ id: 'x', attempts: 1 }, 1100, config), { kind: 'retry', attempts: 2, dueAt: 1300 });
  assert.deepEqual(afterFailure({ id: 'x', attempts: 2 }, 1300, config), { kind: 'dead', attempts: 3 });
});

test('bad settings are refused', () => {
  assert.throws(() => resolveConfig({ batchSize: 0 }), /batchSize/);
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown setting/);
});
