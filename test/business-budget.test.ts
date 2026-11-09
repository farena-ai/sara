import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusinessBudget } from '../src/business/budget.ts';

const bounds = { instanceAllowanceNanoUsd: 100, workspaceAllowanceNanoUsd: 100, maxConcurrent: 4, maxInputTokens: 6, maxOutputTokens: 4, inputNanoUsdPerToken: 10, outputNanoUsdPerToken: 10 };
const request = (workspaceId = randomUUID()) => ({ requestId: randomUUID(), actorId: randomUUID(), workspaceId, conversationId: randomUUID(), payloadHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) });

test('atomic lifetime reservations across workspaces exhaust one installation allowance', () => {
  const db = new DatabaseSync(':memory:'); const budget = new BusinessBudget(db);
  try {
    const a = request(); const b = request();
    assert.equal(budget.reserve(a, bounds).state, 'pending');
    assert.throws(() => budget.reserve(b, bounds), /Budget/);
    assert.equal(budget.exposure().instanceNanoUsd, 100);
    assert.equal(budget.reserve(a, bounds).existing, true);
    assert.throws(() => budget.reserve({ ...a, payloadHash: 'c'.repeat(64) }, bounds), /different/);
    assert.throws(() => budget.reserve({ ...a, actorId: randomUUID() }, bounds), /Not found/);
    budget.settle(a.requestId, { input: 2, output: 1 });
    assert.equal(budget.exposure().instanceNanoUsd, 30);
    budget.settle(a.requestId, { input: 2, output: 1 });
    assert.equal(budget.exposure().instanceNanoUsd, 30);
  } finally { db.close(); }
});

test('unknown, overflowing or dishonest pricing/usage fails closed and interrupted requests never regenerate', () => {
  for (const invalid of [undefined, NaN, Infinity, -1, 0.2, Number.MAX_SAFE_INTEGER]) {
    const db = new DatabaseSync(':memory:'); const budget = new BusinessBudget(db);
    try { assert.throws(() => budget.reserve(request(), { ...bounds, inputNanoUsdPerToken: invalid as number })); assert.equal(budget.exposure().instanceNanoUsd, 0); }
    finally { db.close(); }
  }
  for (const usage of [undefined, { input: -1, output: 1 }, { input: 1.1, output: 1 }, { input: 7, output: 1 }, { input: 1, output: Number.MAX_SAFE_INTEGER }]) {
    const db = new DatabaseSync(':memory:'); const budget = new BusinessBudget(db); const a = request();
    try {
      budget.reserve(a, bounds); budget.settle(a.requestId, usage);
      assert.equal(budget.lookup(a)?.state, 'held'); assert.equal(budget.exposure().instanceNanoUsd, 100);
      assert.throws(() => budget.reserve(request(), { ...bounds, instanceAllowanceNanoUsd: 1000 }), /paused/);
    } finally { db.close(); }
  }
  const db = new DatabaseSync(':memory:'); const first = new BusinessBudget(db); const a = request();
  first.reserve(a, bounds); const afterRestart = new BusinessBudget(db); afterRestart.interruptPending();
  assert.equal(afterRestart.reserve(a, bounds).state, 'held'); assert.equal(afterRestart.reserve(a, bounds).existing, true); db.close();
});

test('separate SQLite connections race the final instance and workspace allowance without overspending', async () => {
  for (const scope of ['instance', 'workspace'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'sara-budget-race-')); const path = join(dir, 'ledger.db'); const db = new DatabaseSync(path); db.exec('PRAGMA journal_mode=WAL');
    const budget = new BusinessBudget(db); const shared = randomUUID();
    const limits = { ...bounds, ...(scope === 'workspace' ? { instanceAllowanceNanoUsd: 1000 } : {}) };
    const workers = [0, 1].map(() => new Worker(new URL('./fixtures/business-budget-race.ts', import.meta.url), { workerData: { path, key: request(scope === 'workspace' ? shared : randomUUID()), bounds: limits } }));
    try {
      await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => { worker.once('message', message => { assert.equal(message.ready, true); resolve(); }); worker.once('error', reject); })));
      const results = workers.map(worker => new Promise<boolean>((resolve, reject) => { worker.once('message', message => resolve(message.admitted)); worker.once('error', reject); }));
      workers.forEach(worker => worker.postMessage('go'));
      assert.equal((await Promise.all(results)).filter(Boolean).length, 1); assert.equal(budget.exposure(shared).instanceNanoUsd, 100);
    } finally { await Promise.all(workers.map(worker => worker.terminate())); db.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('spending admission checks live authority inside the write lock and rolls back on its final guard', () => {
  const db = new DatabaseSync(':memory:'); const budget = new BusinessBudget(db); let checks = 0;
  try {
    assert.throws(() => budget.reserve(request(), bounds, () => { if (++checks === 2) throw new Error('Revoked'); }), /Revoked/);
    assert.equal(budget.exposure().instanceNanoUsd, 0);
  } finally { db.close(); }
});
