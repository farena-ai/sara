// N03 Test Doctor: the exact first acceptance (run an approved failing test and identify its actual
// assertion and relevant source) and the negative controls (an expected failure stays a failure; a
// timeout and unrelated stack frames are not claimed as the root cause), against real `node --test`
// jobs in a disposable copy (src/plugins/exec-job.ts), with the plan hash bound to the staged files.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parsePlan, runJob } from '../src/plugins/exec-job.ts';
import { ROOT, tempDir } from './helpers.ts';

const DOCTOR = new URL('../store/plugins/test-doctor/doctor.mjs', import.meta.url).href;
const FX = join(ROOT, 'test', 'fixtures', 'developer', 'test-doctor', 'repo');
const PERM = { programs: ['node' as const], sources: ['data' as const], network: false };

async function rig() {
  const { dir, cleanup } = tempDir();
  const home = join(dir, 'home');
  mkdirSync(join(home, 'projects'), { recursive: true });
  cpSync(FX, join(home, 'projects', 'shop'), { recursive: true });
  const jobs: unknown[] = [];
  // The host's side: the plan is checked by the real validator and run by the real job runner.
  const run = async (raw: Record<string, unknown>) => {
    jobs.push(raw);
    const plan = parsePlan(raw, PERM, 'node-only');
    return { ok: true, ...(await runJob(plan, { sourceDir: join(home, ...plan.from.split('/')), cacheDir: join(dir, 'cache'), fence: 'node-only', signal: new AbortController().signal })) };
  };
  const { handle } = await import(DOCTOR);
  const call = async (args: Record<string, unknown>) => {
    const plan = JSON.parse((await handle({ operation: 'plan', project: 'shop', file: 'test/price.test.mjs', ...args }, 'en', run, home)).content);
    const out = await handle({ operation: 'run', project: 'shop', file: 'test/price.test.mjs', ...args, planSha: plan.planSha }, 'en', run, home);
    return { plan, r: JSON.parse(out.content), card: out.card };
  };
  return { dir, home, cleanup, call, jobs, handle, run };
}

test('N03 first acceptance: an approved failing test → its actual assertion, line and the source it calls', async () => {
  const r = await rig();
  try {
    const { plan, r: d, card } = await r.call({ test: 'total applies the discount once' });
    assert.equal(plan.status, 'planned');
    assert.equal(plan.command, "node --test --test-reporter=tap --test-isolation=none '--test-name-pattern=^total applies the discount once$' test/price.test.mjs");
    assert.equal(d.status, 'assertion-failed');
    assert.equal(d.exitCode, 1);
    assert.deepEqual({ operator: d.assertion.operator, expected: d.assertion.expected, actual: d.assertion.actual }, { operator: 'strictEqual', expected: 135, actual: 121.5 });
    assert.equal(d.assertion.file, 'test/price.test.mjs');
    assert.equal(d.assertion.line, 12);
    assert.equal(d.assertion.text, 'assert.equal(total(items, 10), 135);');
    assert.deepEqual(d.source, [{ name: 'total', file: 'src/price.mjs', line: 7, text: 'export function total(items, percent) {' }]);
    assert.ok(d.runtimeFramesIgnored >= 1, 'node:internal frames are counted, never blamed');
    assert.ok(!JSON.stringify(d.source).includes('node:'), 'no runtime frame as source');
    assert.equal(d.copyDeleted, true);
    assert.equal(card.lines[0], 'Failing assertion found.');
    assert.equal(r.jobs.length, 1, 'one job per run');
  } finally {
    r.cleanup();
  }
});

test('N03 controls: a todo (expected) failure stays a failure, a timeout gets no root cause, a passing test passes', async () => {
  const r = await rig();
  try {
    const todo = (await r.call({ test: 'rounding to cents is known broken' })).r;
    assert.equal(todo.status, 'expected-failure');
    assert.equal(todo.rootCause, null);
    assert.equal(todo.exitCode, 0, 'the runner exits 0 for todo; the doctor still does not call it passed');
    const slow = (await r.call({ test: 'slow checkout finishes' })).r;
    assert.equal(slow.status, 'timeout');
    assert.equal(slow.rootCause, null);
    assert.equal(slow.assertion, undefined);
    assert.equal(slow.source, undefined);
    const ok = (await r.call({ test: 'formats euros' })).r;
    assert.equal(ok.status, 'passed');
    const none = (await r.call({ test: 'no such test' })).r;
    assert.equal(none.status, 'not-found');
  } finally {
    r.cleanup();
  }
});

test('N03 controls: a non-assertion error is not given a root cause; a changed file or plan refuses before any job', async () => {
  const r = await rig();
  try {
    writeFileSync(join(r.home, 'projects', 'shop', 'test', 'boom.test.mjs'), "import test from 'node:test';\ntest('boom', () => { null.x; });\n");
    const boom = (await r.call({ file: 'test/boom.test.mjs', test: 'boom' })).r;
    assert.equal(boom.status, 'error');
    assert.equal(boom.rootCause, null);
    assert.equal(boom.error.name, 'TypeError');
    const before = r.jobs.length;
    const plan = JSON.parse((await r.handle({ operation: 'plan', project: 'shop', file: 'test/price.test.mjs', test: 'formats euros' }, 'en', r.run, r.home)).content);
    writeFileSync(join(r.home, 'projects', 'shop', 'src', 'format.mjs'), 'export const euros = () => "changed";\n');
    await assert.rejects(r.handle({ operation: 'run', project: 'shop', file: 'test/price.test.mjs', test: 'formats euros', planSha: plan.planSha }, 'en', r.run, r.home), /The plan changed/);
    await assert.rejects(r.handle({ operation: 'plan', project: '../x', file: 'a.mjs', test: 't' }, 'en', r.run, r.home), /project must be/);
    await assert.rejects(r.handle({ operation: 'plan', project: 'shop', file: '../../etc/passwd.js', test: 't' }, 'en', r.run, r.home), /file must be/);
    assert.equal(r.jobs.length, before, 'refusals ask for no job');
    // Sara refusing the job (or the owner declining) is "not run", never a diagnosis.
    const { handle } = await import(DOCTOR);
    const p2 = JSON.parse((await handle({ operation: 'plan', project: 'shop', file: 'test/price.test.mjs', test: 'formats euros' }, 'en', r.run, r.home)).content);
    const declined = JSON.parse((await handle({ operation: 'run', project: 'shop', file: 'test/price.test.mjs', test: 'formats euros', planSha: p2.planSha }, 'en', async () => ({ ok: false, content: 'The owner declined this. Nothing ran.' }), r.home)).content);
    assert.equal(declined.status, 'not-run');
  } finally {
    r.cleanup();
  }
});
