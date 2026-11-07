// N04 Flaky Test Lab: the exact first acceptance (reproduce an intentionally intermittent fixture
// over repeated bounded runs) and the negative controls (always-pass and always-fail are not
// labelled flaky; it stops after an abort), against real `node --test` jobs in a disposable copy.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parsePlan, runJob } from '../src/plugins/exec-job.ts';
import { ROOT, tempDir } from './helpers.ts';

const LAB = new URL('../store/plugins/flaky-test-lab/lab.mjs', import.meta.url).href;
const FX = join(ROOT, 'test', 'fixtures', 'developer', 'flaky-test-lab', 'repo');
const PERM = { programs: ['node' as const], sources: ['data' as const], network: false };

async function rig(abortAfterMs?: number) {
  const { dir, cleanup } = tempDir();
  const home = join(dir, 'home');
  mkdirSync(join(home, 'projects'), { recursive: true });
  cpSync(FX, join(home, 'projects', 'cart'), { recursive: true });
  const jobs: unknown[] = [];
  const run = async (raw: Record<string, unknown>) => {
    jobs.push(raw);
    const plan = parsePlan(raw, PERM, 'node-only');
    const ctl = new AbortController();
    return { ok: true, ...(await runJob(plan, { sourceDir: join(home, ...plan.from.split('/')), cacheDir: join(dir, 'cache'), fence: 'node-only', signal: ctl.signal, ...(abortAfterMs ? { onStart: () => setTimeout(() => ctl.abort(), abortAfterMs) } : {}) })) };
  };
  const { handle } = await import(LAB);
  const call = async (args: Record<string, unknown>) => {
    const a = { project: 'cart', file: 'test/cart.test.mjs', ...args };
    const plan = JSON.parse((await handle({ operation: 'plan', ...a }, 'en', run, home)).content);
    const out = await handle({ operation: 'run', ...a, planSha: plan.planSha }, 'en', run, home);
    return { plan, r: JSON.parse(out.content), card: out.card };
  };
  return { dir, home, cleanup, call, jobs, handle, run };
}

test('N04 first acceptance: an intentionally intermittent test is reproduced as flaky over 20 bounded runs, with its seeds', async () => {
  const r = await rig();
  try {
    const { plan, r: v, card } = await r.call({ test: 'intermittent stock check', runs: 20 });
    assert.equal(plan.command, "node --test --test-reporter=tap --test-isolation=none --test-concurrency=1 '--test-name-pattern=^intermittent stock check$' .sara-flaky/runner.test.mjs");
    assert.equal(v.status, 'done');
    assert.equal(v.verdict, 'flaky');
    assert.equal(v.observed, 20);
    assert.deepEqual(v.failingSeeds, [5, 10, 15, 20]);
    assert.equal(v.failureRate, 0.2);
    assert.ok(v.failureRate95[0] > 0 && v.failureRate95[1] < 0.5, JSON.stringify(v.failureRate95));
    assert.ok(v.runs.every((x: { durationMs: unknown }) => typeof x.durationMs === 'number'));
    assert.equal(v.copyDeleted, true);
    assert.equal(r.jobs.length, 1, 'all repetitions are one approved job');
    assert.equal(card.lines[0], 'Flaky: it both passed and failed.');
  } finally {
    r.cleanup();
  }
});

test('N04 controls: always-pass and always-fail are not flaky; an abort stops it with no verdict', async () => {
  const r = await rig();
  try {
    const pass = (await r.call({ test: 'stable sum', runs: 5 })).r;
    assert.equal(pass.verdict, 'stable-pass');
    assert.equal(pass.failures, 0);
    const failing = (await r.call({ test: 'always broken', runs: 5 })).r;
    assert.equal(failing.verdict, 'consistent-failure');
    assert.equal(failing.failures, 5);
    const none = (await r.call({ test: 'no such test', runs: 3 })).r;
    assert.equal(none.status, 'not-found');
    assert.equal(none.verdict, null);
  } finally {
    r.cleanup();
  }
  const s = await rig(1500);
  try {
    const stopped = (await s.call({ test: 'slow intermittent', runs: 20 })).r;
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.verdict, null, 'mixed outcomes before the stop are not called flaky');
    assert.ok(stopped.observed < 20);
    assert.equal(stopped.copyDeleted, true);
  } finally {
    s.cleanup();
  }
});

test('N04 refusals: bad runs, paths and a changed project refuse before any job', async () => {
  const r = await rig();
  try {
    await assert.rejects(r.call({ test: 'stable sum', runs: 21 }), /runs must be a whole number from 2 to 20/);
    await assert.rejects(r.call({ test: 'stable sum', file: '../x.mjs' }), /file must be/);
    const plan = JSON.parse((await r.handle({ operation: 'plan', project: 'cart', file: 'test/cart.test.mjs', test: 'stable sum' }, 'en', r.run, r.home)).content);
    await assert.rejects(r.handle({ operation: 'run', project: 'cart', file: 'test/cart.test.mjs', test: 'stable sum', runs: 3, planSha: plan.planSha }, 'en', r.run, r.home), /The plan changed/);
    assert.equal(r.jobs.length, 0);
    assert.equal(existsSync(join(r.home, 'projects', 'cart', '.sara-flaky')), false, 'nothing written before a valid run');
  } finally {
    r.cleanup();
  }
});
