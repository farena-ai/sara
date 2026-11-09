// H_EXEC (docs/ops/H_EXEC_DESIGN.md): the plan grammar and its refusals, and real jobs in a
// disposable snapshot under the strongest fence this computer has. The PluginManager path is in
// plugin-exec-job-host.test.ts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { commandLine, JobRefused, jobFenceFor, killTree, parsePlan, runJob, type RunPermission } from '../src/plugins/exec-job.ts';
import { spawn } from 'node:child_process';
import { tempDir } from './helpers.ts';

const NODE: RunPermission = { programs: ['node'], sources: ['data'], network: false };
const refuse = (raw: unknown, re: RegExp, perm: RunPermission = NODE, fence: 'bwrap' | 'node-only' = 'node-only') =>
  assert.throws(() => parsePlan(raw, perm, fence), (e: Error) => e instanceof JobRefused && re.test(e.message), JSON.stringify(raw));

test('plan: a valid node test plan gets its defaults and an exact command line', () => {
  const p = parsePlan({ program: 'node', args: ['--test', '--test-reporter=tap', 'test/a.test.mjs'] }, NODE, 'node-only');
  assert.deepEqual(p, { program: 'node', args: ['--test', '--test-reporter=tap', 'test/a.test.mjs'], source: 'data', from: '.', cwd: '.', timeoutS: 60, cpuS: 60, maxOutputKB: 64, network: false });
  assert.equal(commandLine(p), 'node --test --test-reporter=tap test/a.test.mjs');
  assert.equal(commandLine({ ...p, args: ['s.mjs', 'two words', "it's"] }), `node s.mjs 'two words' 'it'\\''s'`);
  const q = parsePlan({ program: 'node', args: ['run.mjs', '--allow-fs-write=/', '-e', 'x'], cwd: 'pkg/sub', from: 'fixtures/repo', timeoutS: 5, maxOutputKB: 8 }, NODE, 'node-only');
  assert.deepEqual(q.args, ['run.mjs', '--allow-fs-write=/', '-e', 'x'], 'arguments after the script belong to the script');
  assert.equal(q.cwd, 'pkg/sub');
  assert.equal(q.from, 'fixtures/repo');
});

test('plan: refusals are plain and nothing undeclared, escaping or authority-granting passes', () => {
  refuse(null, /must be an object/);
  refuse({ program: 'node', args: [], extra: 1 }, /Unknown plan field "extra"/);
  refuse({ program: 'python', args: [] }, /"python" isn't a program Sara can run/);
  refuse({ program: 'npm', args: ['test'] }, /doesn't declare "npm"/);
  refuse({ program: 'node', args: [], source: 'workspace' }, /doesn't declare the source "workspace"/);
  refuse({ program: 'node', args: [], network: true }, /doesn't declare network/);
  refuse({ program: 'node', args: 'x' }, /args must be a list/);
  refuse({ program: 'node', args: Array(65).fill('a') }, /at most 64 arguments/);
  refuse({ program: 'node', args: ['a\nb'] }, /line breaks or NUL/);
  refuse({ program: 'node', args: ['x'.repeat(1025)] }, /longer than 1024/);
  for (const flag of ['--allow-fs-write=/', '--permission', '--inspect', '--inspect-brk=0', '-e', '--eval=1', '-p', '--require=x', '--import=x', '--experimental-loader=x', '--no-addons', '--env-file=.env', '-r']) refuse({ program: 'node', args: [flag, 'a.mjs'] }, /isn't an allowed node option/);
  for (const bad of ['../x.mjs', '/etc/passwd', 'C:\\x.mjs', '\\\\server\\share\\x', 'a/../../x', 'a/./b', '', 'CON', 'a:b']) refuse({ program: 'node', args: [bad] }, /relative path inside|isn't an allowed node option/);
  for (const cwd of ['..', '/', 'C:/', 'a/../..', 'a\\b']) refuse({ program: 'node', args: [], cwd }, /cwd must be a relative path/);
  refuse({ program: 'node', args: [], from: '../other-plugin' }, /from must be a relative path/);
  refuse({ program: 'node', args: [], timeoutS: 0 }, /timeoutS must be a whole number from 1 to 600/);
  refuse({ program: 'node', args: [], timeoutS: 601 }, /timeoutS/);
  refuse({ program: 'node', args: [], maxOutputKB: 257 }, /maxOutputKB must be a whole number from 1 to 256/);
  refuse({ program: 'node', args: ['--test', '--test-isolation=process'] }, /needs an OS sandbox/);
  const npm: RunPermission = { programs: ['node', 'npm'], sources: ['data'], network: false };
  refuse({ program: 'npm', args: ['test'] }, /npm runs lifecycle scripts as child processes: it needs an OS sandbox/, npm, 'node-only');
  refuse({ program: 'npm', args: ['install'] }, /npm may only run "test" or "run <script>"/, npm, 'bwrap');
  refuse({ program: 'npm', args: ['run', 'a;b'] }, /isn't a script name/, npm, 'bwrap');
  assert.deepEqual(parsePlan({ program: 'npm', args: ['run', 'build', '--', '--x'] }, npm, 'bwrap').args, ['run', 'build', '--', '--x']);
});

test('fence: bubblewrap only where the shell sandbox is bubblewrap; everything else is the Node permission fence', () => {
  assert.equal(jobFenceFor({ mode: 'bwrap', network: false, detail: '' }), 'bwrap');
  assert.equal(jobFenceFor({ mode: 'seatbelt', network: false, detail: '' }), 'node-only');
  assert.equal(jobFenceFor({ mode: 'none', network: false, detail: '' }), 'node-only');
  assert.equal(jobFenceFor({ mode: 'user', network: false, detail: '' }), 'node-only');
});

function fixture(dir: string): string {
  const src = join(dir, 'staged');
  mkdirSync(join(src, 'test'), { recursive: true });
  mkdirSync(join(src, '.git', 'hooks'), { recursive: true });
  mkdirSync(join(src, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(src, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho hook\n');
  writeFileSync(join(src, '.git', 'config'), '[core]\n\tfsmonitor = evil\n');
  writeFileSync(join(src, 'node_modules', 'x', 'index.js'), 'module.exports = 1;\n');
  writeFileSync(join(src, 'sum.mjs'), 'export const sum = (a, b) => a + b;\n');
  writeFileSync(join(src, 'test', 'sum.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { writeFileSync, existsSync } from 'node:fs';\nimport { sum } from '../sum.mjs';\ntest('adds', () => assert.equal(sum(2, 2), 4));\ntest('writes a report in the copy', () => writeFileSync('report.txt', 'done'));\ntest('no git or deps in the copy', () => { assert.equal(existsSync('.git'), false); assert.equal(existsSync('node_modules'), false); });\n");
  writeFileSync(join(src, 'test', 'fail.test.mjs.off'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => assert.equal(1, 2));\n");
  return src;
}

const base = { args: [] as string[], source: 'data' as const, from: '.', cwd: '.', timeoutS: 30, cpuS: 30, maxOutputKB: 64, network: false };

test('job: a real node --test run in a disposable copy: exit code, output, changed files; the copy is deleted and the source untouched', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const src = fixture(dir);
    const before = readFileSync(join(src, 'sum.mjs'), 'utf8');
    const cache = join(dir, 'cache');
    const r = await runJob({ ...base, program: 'node', args: ['--test', '--test-reporter=tap'] }, { sourceDir: src, cacheDir: cache, fence: 'node-only', signal: new AbortController().signal });
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /# pass 3/);
    assert.deepEqual(r.changed, { added: ['report.txt'], changed: [], removed: [] });
    assert.equal(r.snapshot.files, 3, 'only sum.mjs and the two test files (no .git, no node_modules)');
    assert.equal(r.deleted, true);
    assert.equal(r.isolated, false);
    assert.match(r.fenceLabel, /not OS-sandboxed/);
    assert.deepEqual(readdirSync(cache), [], 'nothing of the run is left');
    assert.equal(existsSync(join(src, 'report.txt')), false, 'the source never sees the copy\'s writes');
    assert.equal(readFileSync(join(src, 'sum.mjs'), 'utf8'), before);
    // A failing test is a real non-zero exit, not a host error.
    writeFileSync(join(src, 'test', 'fail.test.mjs'), readFileSync(join(src, 'test', 'fail.test.mjs.off')));
    const f = await runJob({ ...base, program: 'node', args: ['--test', 'test/fail.test.mjs'] }, { sourceDir: src, cacheDir: cache, fence: 'node-only', signal: new AbortController().signal });
    assert.equal(f.exitCode, 1);
    assert.match(f.stdout, /broken/);
    assert.equal(f.timedOut, false);
  } finally {
    cleanup();
  }
});

test('job: under the Node fence a write outside the copy and a child process are denied', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const src = join(dir, 'staged');
    mkdirSync(src, { recursive: true });
    const outside = join(dir, 'outside.txt').replaceAll('\\', '/');
    writeFileSync(join(src, 'escape.mjs'), `import { writeFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nlet w = 'written';\ntry { writeFileSync(${JSON.stringify(outside)}, 'x'); } catch (e) { w = e.code; }\nlet s = 'spawned';\ntry { const r = spawnSync(process.execPath, ['-e', '1']); if (r.error) throw r.error; } catch (e) { s = e.code; }\nconsole.log(w, s);\n`);
    const r = await runJob({ ...base, program: 'node', args: ['escape.mjs'] }, { sourceDir: src, cacheDir: join(dir, 'cache'), fence: 'node-only', signal: new AbortController().signal });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /ERR_ACCESS_DENIED ERR_ACCESS_DENIED/);
    assert.equal(existsSync(outside), false);
  } finally {
    cleanup();
  }
});

test('job: output is capped per stream with the truncation stated', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const src = join(dir, 'staged');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'flood.mjs'), "process.stdout.write('x'.repeat(50_000)); process.stderr.write('e'.repeat(3000));\n");
    const r = await runJob({ ...base, program: 'node', args: ['flood.mjs'], maxOutputKB: 2 }, { sourceDir: src, cacheDir: join(dir, 'cache'), fence: 'node-only', signal: new AbortController().signal });
    assert.equal(r.stdout.length, 2048);
    assert.equal(r.stdoutTruncated, true);
    assert.equal(r.stderrTruncated, true);
    assert.equal(r.exitCode, 0);
  } finally {
    cleanup();
  }
});

test('job: the time limit kills it; an abort before the start launches nothing; an abort during the run kills it', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const src = join(dir, 'staged');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'spin.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('started.txt', 'y');\nsetInterval(() => {}, 1000);\n");
    const cache = join(dir, 'cache');
    const t0 = Date.now();
    const r = await runJob({ ...base, program: 'node', args: ['spin.mjs'], timeoutS: 1 }, { sourceDir: src, cacheDir: cache, fence: 'node-only', signal: new AbortController().signal });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 15_000);
    assert.equal(r.deleted, true);
    const gone = new AbortController();
    gone.abort();
    const n = await runJob({ ...base, program: 'node', args: ['spin.mjs'] }, { sourceDir: src, cacheDir: cache, fence: 'node-only', signal: gone.signal });
    assert.equal(n.cancelled, true);
    assert.equal(n.exitCode, null);
    assert.equal(n.started, false, 'nothing was launched');
    const stop = new AbortController();
    const p = runJob({ ...base, program: 'node', args: ['spin.mjs'] }, { sourceDir: src, cacheDir: cache, fence: 'node-only', signal: stop.signal, onStart: () => setTimeout(() => stop.abort(), 300) });
    const c = await p;
    assert.equal(c.cancelled, true);
    assert.equal(c.started, true);
    assert.equal(c.deleted, true);
    assert.deepEqual(readdirSync(cache), []);
  } finally {
    cleanup();
  }
});

const bwrapOk = process.platform === 'linux' && spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', 'true'], { timeout: 5000 }).status === 0;
test('job: bubblewrap fence on Linux: no network, only the copy writable', { skip: bwrapOk ? false : `bubblewrap is not available here (${process.platform}); the Linux path runs on Linux hosts with bwrap` }, async () => {
  const { dir, cleanup } = tempDir();
  try {
    const src = join(dir, 'staged');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'probe.mjs'), `import { writeFileSync } from 'node:fs';\nimport { connect } from 'node:net';\nlet w = 'written'; try { writeFileSync(${JSON.stringify(join(dir, 'outside.txt'))}, 'x'); } catch (e) { w = e.code; }\nconst s = connect(53, '1.1.1.1'); s.on('error', (e) => { console.log(w, 'net:' + e.code); process.exit(0); }); s.on('connect', () => { console.log(w, 'net:open'); process.exit(0); });\n`);
    const r = await runJob({ ...base, program: 'node', args: ['probe.mjs'] }, { sourceDir: src, cacheDir: join(dir, 'cache'), fence: 'bwrap', signal: new AbortController().signal });
    assert.equal(r.isolated, true);
    assert.match(r.stdout, /^(EROFS|ENOENT|EACCES) net:(ENETUNREACH|EAI_AGAIN|ECONNREFUSED)/m);
    assert.equal(existsSync(join(dir, 'outside.txt')), false);
    assert.equal(r.deleted, true);
  } finally {
    cleanup();
  }
});

// A busy machine can make the tree kill (taskkill on Windows) fail or time out; the stop must
// still reach the job, and a job must never hold its plugin call open forever.
test('stop: on Windows the job dies at once even when the tree kill does nothing', { skip: process.platform !== 'win32' && 'the taskkill route is Windows-only' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise<void>((r) => child.once('spawn', () => r()));
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  const t0 = Date.now();
  let treeCalls = 0;
  killTree(child, () => void treeCalls++);
  await Promise.race([exited, new Promise((_, no) => setTimeout(() => no(new Error('the job was not killed')), 5_000))]);
  assert.ok(Date.now() - t0 < 2_000, 'the stop does not wait for a slow tree kill');
  assert.equal(treeCalls, 1, 'the tree kill still runs for anything the job started');
});

test('stop: with short escalation timers a timed-out job still ends promptly and its process is gone', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const src = join(dir, 'staged');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'hold.mjs'), "setInterval(() => {}, 1000);\n");
    const cache = join(dir, 'cache');
    const t0 = Date.now();
    let pid = 0;
    const r = await runJob({ ...base, program: 'node', args: ['hold.mjs'], timeoutS: 1 }, { sourceDir: src, cacheDir: cache, fence: 'node-only', signal: new AbortController().signal, stopRetryMs: 200, stopGiveUpMs: 1_500, onStart: (p) => (pid = p) });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 12_000, 'the result arrives within the stop deadline');
    assert.ok(pid > 0);
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((w) => setTimeout(w, 100)); } catch { alive = false; }
    }
    assert.equal(alive, false, 'the job process is gone');
  } finally {
    cleanup();
  }
});
