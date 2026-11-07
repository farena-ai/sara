// N10 Release Readiness: the exact first acceptance (run configured local release gates and block a
// deliberately failing requirement) and the negative/control (one deliberately failing gate blocks
// ready; no publish, signer, upload or CI), each gate a real `node` job in a disposable copy
// (src/plugins/exec-job.ts), the plan hash bound to the staged files and the gate profile.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parsePlan, runJob } from '../src/plugins/exec-job.ts';
import { ROOT, tempDir } from './helpers.ts';

const GATES = new URL('../store/plugins/release-readiness/gates.mjs', import.meta.url).href;
const FX = join(ROOT, 'test', 'fixtures', 'developer', 'release-readiness', 'repo');
const PERM = { programs: ['node' as const, 'npm' as const], sources: ['data' as const], network: false };

async function rig(fence: 'node-only' | 'bwrap' = 'node-only') {
  const { dir, cleanup } = tempDir();
  const home = join(dir, 'home');
  mkdirSync(join(home, 'projects'), { recursive: true });
  cpSync(FX, join(home, 'projects', 'cart'), { recursive: true });
  const jobs: any[] = [];
  const run = async (raw: Record<string, unknown>) => {
    jobs.push(raw);
    const plan = parsePlan(raw, PERM, fence);
    return { ok: true, ...(await runJob(plan, { sourceDir: join(home, ...plan.from.split('/')), cacheDir: join(dir, 'cache'), fence, signal: new AbortController().signal })) };
  };
  const { handle } = await import(GATES);
  const call = async (args: Record<string, unknown> = {}, runner: any = run) => {
    const plan = JSON.parse((await handle({ operation: 'plan', project: 'cart', ...args }, 'en', run, home)).content);
    const out = await handle({ operation: 'run', project: 'cart', ...args, planSha: plan.planSha }, 'en', runner, home);
    return { plan, r: JSON.parse(out.content), card: out.card };
  };
  return { dir, home, cleanup, call, jobs, handle, run };
}

test('N10 first acceptance: configured local gates run as approved jobs; a deliberately failing requirement blocks ready', async () => {
  const r = await rig();
  try {
    const { plan, r: d, card } = await r.call();
    assert.equal(plan.status, 'planned');
    assert.deepEqual(plan.gates.map((g: any) => [g.id, g.command]), [
      ['tests', 'node --test test/cart.test.mjs'],
      ['typecheck', 'node scripts/typecheck.mjs'],
      ['links', 'node scripts/check-links.mjs'],
    ]);
    assert.equal(r.jobs.length, 3, 'one approved job per gate');
    assert.equal(d.verdict, 'blocked');
    assert.deepEqual(d.blockedBy, [{ id: 'links', requirement: 'Every relative Markdown link resolves', status: 'failed', exitCode: 1 }]);
    assert.deepEqual(d.gates.map((g: any) => [g.id, g.status, g.exitCode]), [['tests', 'passed', 0], ['typecheck', 'passed', 0], ['links', 'failed', 1]]);
    const links = d.gates[2];
    assert.match(links.stderrTail, /README\.md:3 broken link docs\/design\.md/);
    assert.match(links.stdoutSha256, /^[0-9a-f]{64}$/);
    assert.equal(links.copyDeleted, true);
    assert.equal(links.fence, 'node-only');
    assert.match(d.gates[1].stdoutTail, /typecheck: 1 file\(s\), 0 failed/);
    assert.equal(d.profile, 'release-gates.json');
    assert.match(d.profileSha256, /^[0-9a-f]{64}$/);
    assert.equal(d.planSha, plan.planSha);
    assert.equal(card.lines[0], 'Not ready: a required gate failed.');
    // Fix the requirement in the staged project: a fresh plan now passes every gate.
    mkdirSync(join(r.home, 'projects', 'cart', 'docs'), { recursive: true });
    writeFileSync(join(r.home, 'projects', 'cart', 'docs', 'design.md'), '# Design\n');
    const ok = (await r.call()).r;
    assert.equal(ok.verdict, 'ready');
    assert.deepEqual(ok.blockedBy, []);
    assert.ok(ok.gates.every((g: any) => g.status === 'passed' && g.exitCode === 0));
  } finally {
    r.cleanup();
  }
});

test('N10 negative: one failing gate blocks ready; a typecheck failure is a real failure; no publish, signer, upload or CI gate is accepted', async () => {
  const r = await rig();
  try {
    mkdirSync(join(r.home, 'projects', 'cart', 'docs'), { recursive: true });
    writeFileSync(join(r.home, 'projects', 'cart', 'docs', 'design.md'), '# Design\n');
    writeFileSync(join(r.home, 'projects', 'cart', 'src', 'broken.ts'), 'enum Color { Red }\n');
    const d = (await r.call()).r;
    assert.equal(d.verdict, 'blocked');
    assert.deepEqual(d.blockedBy.map((b: any) => b.id), ['typecheck']);
    assert.match(d.gates[1].stderrTail, /broken\.ts/);
    const before = r.jobs.length;
    await assert.rejects(r.handle({ operation: 'plan', project: 'cart', profile: 'release-gates-publish.json' }, 'en', r.run, r.home), /publish, sign, upload, deploy or CI/);
    writeFileSync(join(r.home, 'projects', 'cart', 'gates-sign.json'), JSON.stringify({ version: 1, gates: [{ id: 'tests', requirement: 'x', program: 'node', args: ['scripts/sign-release.mjs'] }] }));
    await assert.rejects(r.handle({ operation: 'plan', project: 'cart', profile: 'gates-sign.json' }, 'en', r.run, r.home), /publish, sign, upload, deploy or CI/);
    writeFileSync(join(r.home, 'projects', 'cart', 'gates-shell.json'), JSON.stringify({ version: 1, gates: [{ id: 'sh', requirement: 'x', program: 'bash', args: ['-c', 'true'] }] }));
    await assert.rejects(r.handle({ operation: 'plan', project: 'cart', profile: 'gates-shell.json' }, 'en', r.run, r.home), /program must be node or npm/);
    await assert.rejects(r.handle({ operation: 'plan', project: 'cart', profile: '../x.json' }, 'en', r.run, r.home), /profile must be/);
    const plan = JSON.parse((await r.handle({ operation: 'plan', project: 'cart' }, 'en', r.run, r.home)).content);
    writeFileSync(join(r.home, 'projects', 'cart', 'CHANGES.md'), '# Changes\n\nedited\n');
    await assert.rejects(r.handle({ operation: 'run', project: 'cart', planSha: plan.planSha }, 'en', r.run, r.home), /The plan changed/);
    assert.equal(r.jobs.length, before, 'refused profiles ask for no job');
    assert.equal(existsSync(join(r.home, 'projects', 'cart', 'PUBLISHED.txt')), false);
  } finally {
    r.cleanup();
  }
});

test('N10 held on Windows and declined jobs: never ready without every gate actually passing', async () => {
  const r = await rig();
  try {
    const npm = (await r.call({ profile: 'release-gates-npm.json' })).r;
    assert.equal(npm.verdict, 'blocked', 'a real failure blocks even beside a held gate');
    assert.equal(npm.gates[0].status, 'held');
    assert.match(npm.gates[0].reason, /needs an OS sandbox/);
    assert.equal(npm.gates[1].status, 'failed', 'the other gates still run and report');
    assert.deepEqual(npm.blockedBy.map((b: any) => b.id), ['links']);
    mkdirSync(join(r.home, 'projects', 'cart', 'docs'), { recursive: true });
    writeFileSync(join(r.home, 'projects', 'cart', 'docs', 'design.md'), '# Design\n');
    const held = (await r.call({ profile: 'release-gates-npm.json' })).r;
    assert.equal(held.verdict, 'incomplete', 'a held gate is never counted as passed');
    let n = 0;
    const declined = (await r.call({}, async (raw: any) => (++n === 2 ? { ok: false, content: 'The owner declined this. Nothing ran.' } : r.run(raw)))).r;
    assert.equal(declined.verdict, 'incomplete');
    assert.equal(declined.gates[1].status, 'not-run');
  } finally {
    r.cleanup();
  }
});

const bwrapOk = process.platform === 'linux' && (await import('node:child_process')).spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', 'true'], { timeout: 5000 }).status === 0;
test('N10 Linux: the npm test gate runs inside bubblewrap and counts toward ready', { skip: bwrapOk ? false : `bubblewrap is not available here (${process.platform}); npm gates are held on Windows and run only on Linux hosts with bwrap` }, async () => {
  const r = await rig('bwrap');
  try {
    mkdirSync(join(r.home, 'projects', 'cart', 'docs'), { recursive: true });
    writeFileSync(join(r.home, 'projects', 'cart', 'docs', 'design.md'), '# Design\n');
    const d = (await r.call({ profile: 'release-gates-npm.json' })).r;
    assert.equal(d.gates[0].fence, 'bwrap');
    assert.equal(d.gates[0].status, 'passed');
    assert.equal(d.verdict, 'ready');
  } finally {
    r.cleanup();
  }
});
