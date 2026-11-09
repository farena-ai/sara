// N01 Repository Onboarding: the exact first acceptance (map a fixture repository and reproduce its
// documented build without inventing commands) and the negative/control (an invented build command
// or a missing documented prerequisite refuses; the build receipt includes the real exit code and
// output), the build a real `node` job in a disposable copy (src/plugins/exec-job.ts) bound to a
// plan hash of the staged files. The workbench's repo_map (tools/developer-workbench) is unchanged.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parsePlan, runJob } from '../src/plugins/exec-job.ts';
import { ROOT, tempDir } from './helpers.ts';

const ONBOARD = new URL('../store/plugins/repository-onboarding/onboard.mjs', import.meta.url).href;
const FX = join(ROOT, 'test', 'fixtures', 'developer', 'repository-onboarding', 'repo');
const PERM = { programs: ['node' as const, 'npm' as const], sources: ['data' as const], network: false };

async function rig(fence: 'node-only' | 'bwrap' = 'node-only') {
  const { dir, cleanup } = tempDir();
  const home = join(dir, 'home');
  mkdirSync(join(home, 'projects'), { recursive: true });
  cpSync(FX, join(home, 'projects', 'cards'), { recursive: true });
  const jobs: any[] = [];
  const run = async (raw: Record<string, unknown>) => {
    jobs.push(raw);
    const plan = parsePlan(raw, PERM, fence);
    return { ok: true, ...(await runJob(plan, { sourceDir: join(home, ...plan.from.split('/')), cacheDir: join(dir, 'cache'), fence, signal: new AbortController().signal })) };
  };
  const { handle } = await import(ONBOARD);
  const map = async () => JSON.parse((await handle({ operation: 'map', project: 'cards' }, 'en', run, home)).content);
  const build = async (command: string, runner: any = run) => {
    const m = await map();
    const doc = m.build.commands.find((x: any) => x.command === command);
    const out = await handle({ operation: 'build', project: 'cards', command, planSha: doc?.planSha ?? 'f'.repeat(64) }, 'en', runner, home);
    return { r: JSON.parse(out.content), card: out.card };
  };
  return { dir, home, cleanup, map, build, jobs, handle, run };
}

test('N01 first acceptance: map a fixture repository and reproduce its documented build without inventing commands', async () => {
  const r = await rig();
  try {
    const m = await r.map();
    assert.equal(m.status, 'mapped');
    assert.equal(r.jobs.length, 0, 'mapping runs nothing');
    assert.equal(m.files, 8);
    assert.deepEqual(m.languages, { '.html': 1, '.json': 3, '.md': 1, '.mjs': 3 });
    assert.deepEqual(m.directories, ['data', 'scripts', 'src', 'templates', 'test']);
    assert.deepEqual(m.manifests, [{ file: 'package.json', name: 'weather-cards', version: '0.3.0', type: 'module', engines: { node: '>=22' }, scripts: { build: 'node scripts/build.mjs', test: 'node --test test/build.test.mjs' }, dependencies: 0, devDependencies: 0 }]);
    assert.deepEqual(m.lockfiles, ['package-lock.json']);
    assert.deepEqual(m.docs, ['README.md']);
    assert.deepEqual(m.prerequisites.map((p: any) => [p.line, p.kind, p.status]), [[7, 'node', 'met'], [8, 'file', 'met'], [9, 'file', 'met']]);
    assert.deepEqual(m.build.commands.map((c: any) => [c.line, c.command, c.program]), [[14, 'node scripts/build.mjs', 'node'], [20, 'npm run build', 'npm']]);
    assert.equal(m.build.commands[1].script, 'node scripts/build.mjs', 'the npm script body is shown from package.json');
    const { r: b, card } = await r.build('node scripts/build.mjs');
    assert.equal(b.status, 'built');
    assert.equal(b.exitCode, 0);
    assert.match(b.stdout, /built 3 cards/);
    assert.match(b.stdoutSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(b.changed.added, ['dist/cards.json', 'dist/index.html']);
    assert.deepEqual(b.documentedAt, { file: 'README.md', line: 14, section: 'Build' });
    assert.equal(b.copyDeleted, true);
    assert.equal(b.fence, 'node-only');
    assert.deepEqual(r.jobs, [{ program: 'node', args: ['scripts/build.mjs'], from: 'projects/cards', timeoutS: 120, maxOutputKB: 64 }], 'exactly the documented command, once');
    assert.equal(card.lines[0], 'The documented build ran and succeeded.');
  } finally {
    r.cleanup();
  }
});

test('N01 negative: an invented build command or a missing documented prerequisite refuses before any job', async () => {
  const r = await rig();
  try {
    const m = await r.map();
    for (const command of ['node scripts/deploy.mjs', 'npm run build -- --prod', 'node --test test/build.test.mjs', 'node -e 1']) {
      await assert.rejects(r.handle({ operation: 'build', project: 'cards', command, planSha: m.planSha }, 'en', r.run, r.home), /not a documented build command/);
    }
    rmSync(join(r.home, 'projects', 'cards', 'templates', 'card.html'));
    const m2 = await r.map();
    assert.deepEqual(m2.prerequisites.find((p: any) => p.line === 9), { line: 9, text: 'The template `templates/card.html`', kind: 'file', status: 'missing', detail: 'templates/card.html' });
    const doc = m2.build.commands[0];
    await assert.rejects(r.handle({ operation: 'build', project: 'cards', command: doc.command, planSha: doc.planSha }, 'en', r.run, r.home), /missing documented prerequisite: templates\/card\.html/);
    writeFileSync(join(r.home, 'projects', 'cards', 'templates', 'card.html'), '<p>{{city}}</p>\n');
    const m3 = await r.map();
    writeFileSync(join(r.home, 'projects', 'cards', 'data', 'cities.json'), '[]\n');
    await assert.rejects(r.handle({ operation: 'build', project: 'cards', command: m3.build.commands[0].command, planSha: m3.build.commands[0].planSha }, 'en', r.run, r.home), /The plan changed/);
    await assert.rejects(r.handle({ operation: 'map', project: '../x' }, 'en', r.run, r.home), /project must be/);
    assert.equal(r.jobs.length, 0, 'no job for any refusal');
  } finally {
    r.cleanup();
  }
});

test('N01 controls: a failing documented build is reported with its real exit and output; npm is held on Windows; a decline is not-built', async () => {
  const r = await rig();
  try {
    writeFileSync(join(r.home, 'projects', 'cards', 'data', 'cities.json'), '{ not json\n');
    const bad = (await r.build('node scripts/build.mjs')).r;
    assert.equal(bad.status, 'failed');
    assert.equal(bad.exitCode, 1);
    assert.match(bad.stderr, /SyntaxError/);
    const held = (await r.build('npm run build')).r;
    assert.equal(held.status, 'held');
    assert.match(held.reason, /needs an OS sandbox/);
    const declined = (await r.build('node scripts/build.mjs', async () => ({ ok: false, content: 'The owner declined this. Nothing ran.' }))).r;
    assert.equal(declined.status, 'not-run');
    assert.equal(declined.exitCode, null);
  } finally {
    r.cleanup();
  }
});

const bwrapOk = process.platform === 'linux' && (await import('node:child_process')).spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', 'true'], { timeout: 5000 }).status === 0;
test('N01 Linux: the documented npm build runs inside bubblewrap', { skip: bwrapOk ? false : `bubblewrap is not available here (${process.platform}); npm builds are held on Windows and run only on Linux hosts with bwrap` }, async () => {
  const r = await rig('bwrap');
  try {
    const b = (await r.build('npm run build')).r;
    assert.equal(b.status, 'built');
    assert.equal(b.fence, 'bwrap');
    assert.match(b.stdout, /built 3 cards/);
  } finally {
    r.cleanup();
  }
});
