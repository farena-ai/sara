// N24 Documentation Doctor: the exact first acceptance (detect a broken link and a documented
// command that fails in an isolated fixture) and the negative/control (broken link and real failed
// documented command found; embedded injection never executed automatically), against real
// `node` jobs in a disposable copy (src/plugins/exec-job.ts) with the plan hash bound to the staged files.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parsePlan, runJob } from '../src/plugins/exec-job.ts';
import { ROOT, tempDir } from './helpers.ts';

const DOCTOR = new URL('../store/plugins/documentation-doctor/docs.mjs', import.meta.url).href;
const FX = join(ROOT, 'test', 'fixtures', 'developer', 'documentation-doctor', 'repo');
const PERM = { programs: ['node' as const, 'npm' as const], sources: ['data' as const], network: false };

async function rig() {
  const { dir, cleanup } = tempDir();
  const home = join(dir, 'home');
  mkdirSync(join(home, 'projects'), { recursive: true });
  cpSync(FX, join(home, 'projects', 'recipes'), { recursive: true });
  const jobs: any[] = [];
  // The host's side on this computer: the real validator and runner with the Node fence.
  const run = async (raw: Record<string, unknown>) => {
    jobs.push(raw);
    const plan = parsePlan(raw, PERM, 'node-only');
    return { ok: true, ...(await runJob(plan, { sourceDir: join(home, ...plan.from.split('/')), cacheDir: join(dir, 'cache'), fence: 'node-only', signal: new AbortController().signal })) };
  };
  const { handle } = await import(DOCTOR);
  const check = async () => JSON.parse((await handle({ operation: 'check', project: 'recipes' }, 'en', run, home)).content);
  const runCmd = async (command: string) => {
    const c = await check();
    const doc = c.commands.find((x: any) => x.command === command);
    const out = await handle({ operation: 'run', project: 'recipes', command, planSha: doc?.planSha ?? c.planSha }, 'en', run, home);
    return { r: JSON.parse(out.content), card: out.card };
  };
  return { dir, home, cleanup, check, runCmd, jobs, handle, run };
}

test('N24 first acceptance: a broken link and a documented command that fails in an isolated copy', async () => {
  const r = await rig();
  try {
    const c = await r.check();
    assert.equal(c.status, 'checked');
    assert.equal(r.jobs.length, 0, 'checking runs nothing');
    assert.deepEqual(c.links.broken.map((l: any) => [l.file, l.line, l.target, l.problem]), [
      ['README.md', 3, 'CHANGELOG.md', 'missing-file'],
      ['docs/usage.md', 5, '../README.md#deploy', 'missing-anchor'],
    ]);
    assert.equal(c.links.ok, 4, 'usage#install, api, #build, ../README.md');
    assert.deepEqual(c.links.external, [{ file: 'README.md', line: 4, target: 'https://example.com/recipes' }], 'external links are listed, not fetched');
    assert.deepEqual(c.commands.map((x: any) => [x.file, x.line, x.command, x.program]), [
      ['README.md', 9, 'node scripts/build-docs.mjs', 'node'],
      ['README.md', 10, 'node --test test/recipes.test.mjs', 'node'],
      ['README.md', 11, 'npm run docs', 'npm'],
    ]);
    const { r: d, card } = await r.runCmd('node scripts/build-docs.mjs');
    assert.equal(d.status, 'failed');
    assert.equal(d.exitCode, 1);
    assert.match(d.stderr, /docs\/index\.json is missing/);
    assert.deepEqual(d.documentedAt, { file: 'README.md', line: 9 });
    assert.equal(d.copyDeleted, true);
    assert.equal(d.fence, 'node-only');
    assert.deepEqual(d.changed, { added: [], changed: [], removed: [] });
    assert.equal(card.lines[0], 'The documented command failed.');
    assert.deepEqual(r.jobs.at(-1), { program: 'node', args: ['scripts/build-docs.mjs'], from: 'projects/recipes', timeoutS: 60, maxOutputKB: 64 });
    // Control: a documented command that works is reported as passing, with its real exit code.
    const ok = (await r.runCmd('node --test test/recipes.test.mjs')).r;
    assert.equal(ok.status, 'passed');
    assert.equal(ok.exitCode, 0);
    assert.match(ok.stdout, /pass 1/);
  } finally {
    r.cleanup();
  }
});

test('N24 negative: embedded injection is never executed; undocumented or shell-syntax commands refuse before any job', async () => {
  const r = await rig();
  try {
    const c = await r.check();
    assert.deepEqual(c.unsupported.map((x: any) => [x.line, x.reason]), [[12, 'shell-syntax']]);
    assert.ok(!c.commands.some((x: any) => /steal/.test(x.command)), 'inline code and HTML comments are not documented commands');
    for (const command of ['node scripts/steal.mjs', 'node scripts/build-docs.mjs && node scripts/steal.mjs', 'node -e 1']) {
      await assert.rejects(r.handle({ operation: 'run', project: 'recipes', command, planSha: c.planSha }, 'en', r.run, r.home), /not a runnable documented command/);
    }
    // A changed file invalidates the plan.
    const before = c.commands[0].planSha;
    writeFileSync(join(r.home, 'projects', 'recipes', 'docs', 'api.md'), '# API\n\nchanged\n');
    await assert.rejects(r.handle({ operation: 'run', project: 'recipes', command: 'node scripts/build-docs.mjs', planSha: before }, 'en', r.run, r.home), /The plan changed/);
    await assert.rejects(r.handle({ operation: 'check', project: '../x' }, 'en', r.run, r.home), /project must be/);
    assert.equal(r.jobs.length, 0, 'no job for any of these');
    assert.equal(existsSync(join(r.home, 'projects', 'recipes', 'STOLEN.txt')), false);
  } finally {
    r.cleanup();
  }
});

test('N24 held on Windows: a documented npm command needs bubblewrap; the refusal is reported as held, never as a result', async () => {
  const r = await rig();
  try {
    const d = (await r.runCmd('npm run docs')).r;
    assert.equal(d.status, 'held');
    assert.match(d.reason, /needs an OS sandbox/);
    assert.equal(d.exitCode, null);
    // An owner who declines is not-run, never failed/passed.
    const c = await r.check();
    const doc = c.commands.find((x: any) => x.command === 'node scripts/build-docs.mjs');
    const declined = JSON.parse((await r.handle({ operation: 'run', project: 'recipes', command: doc.command, planSha: doc.planSha }, 'en', async () => ({ ok: false, content: 'The owner declined this. Nothing ran.' }), r.home)).content);
    assert.equal(declined.status, 'not-run');
  } finally {
    r.cleanup();
  }
});

const bwrapOk = process.platform === 'linux' && (await import('node:child_process')).spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', 'true'], { timeout: 5000 }).status === 0;
test('N24 Linux: the documented npm command runs inside bubblewrap and its real failure is reported', { skip: bwrapOk ? false : `bubblewrap is not available here (${process.platform}); npm jobs are held on Windows and run only on Linux hosts with bwrap` }, async () => {
  const { dir, cleanup } = tempDir();
  try {
    const home = join(dir, 'home');
    cpSync(FX, join(home, 'projects', 'recipes'), { recursive: true });
    const run = async (raw: Record<string, unknown>) => {
      const plan = parsePlan(raw, PERM, 'bwrap');
      return { ok: true, ...(await runJob(plan, { sourceDir: join(home, ...plan.from.split('/')), cacheDir: join(dir, 'cache'), fence: 'bwrap', signal: new AbortController().signal })) };
    };
    const { handle } = await import(DOCTOR);
    const c = JSON.parse((await handle({ operation: 'check', project: 'recipes' }, 'en', run, home)).content);
    const doc = c.commands.find((x: any) => x.command === 'npm run docs');
    const d = JSON.parse((await handle({ operation: 'run', project: 'recipes', command: 'npm run docs', planSha: doc.planSha }, 'en', run, home)).content);
    assert.equal(d.status, 'failed');
    assert.equal(d.fence, 'bwrap');
    assert.match(d.stderr, /docs\/index\.json is missing/);
  } finally {
    cleanup();
  }
});
