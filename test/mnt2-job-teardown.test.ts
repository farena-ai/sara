// MNT2: stopping background jobs must end their process even when the stop comes before the spawn,
// and a caller can wait until a stopped job has written its last row (no 'database is not open').
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { JobManager } from '../src/jobs.ts';
import { runCommand } from '../src/tools/sandbox.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { makeApp, tempDir } from './helpers.ts';

const SERVE = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`;

test('mnt2: a command stopped before its process starts is killed, not left running until its timeout', { timeout: 180_000 }, async () => {
  const { dir, cleanup } = tempDir();
  try {
    const ac = new AbortController(); ac.abort();
    const t0 = Date.now();
    // Its timeout is far away: before the fix it ran until then. (On a busy Windows PC one taskkill
    // can take 15–20 s, so the bound is generous.)
    const r = await runCommand(SERVE, dir, { mode: 'none', network: true, detail: 'tests' }, { timeoutMs: 600_000, signal: ac.signal });
    assert.ok(Date.now() - t0 < 120_000, `took ${Date.now() - t0} ms`);
    assert.equal(r.timedOut, false);
  } finally { cleanup(); }
});

test('mnt2: stopAll resolves only after every stopped job has finished writing', { timeout: 180_000 }, async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-07T12:00:00Z') });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: '2026-11-07T12:00:00Z' });
  app.jobs = new JobManager(app, app.store.db);
  const conv = app.store.createConversation();
  mkdirSync(workspaceDir(dir, conv.workspace), { recursive: true });
  try {
    const started = [0, 1].map(() => app.jobs!.start({ conversationId: conv.id, workspace: conv.workspace, label: 'serve', command: SERVE, timeoutMs: 600_000 }));
    // Stop at once: one of them may not have spawned yet.
    const waited = app.jobs.stopAll(150_000);
    assert.ok(waited && typeof (waited as Promise<void>).then === 'function', 'stopAll returns a promise to wait on');
    await waited;
    let settled = 0;
    for (const s of started) void s.done.then(() => settled++);
    await new Promise(r => setImmediate(r));
    assert.equal(settled, 2, 'every job promise had settled when stopAll resolved');
    assert.deepEqual(app.jobs.running(), []);
    for (const s of started) assert.equal(app.jobs.get(s.job.id)?.status, 'stopped');
  } finally { app.store.close(); cleanup(); }
});
