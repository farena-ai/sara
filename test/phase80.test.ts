// Phase 80 (harness track M5, docs/design/HARNESS_TRACK.md §2.4, §3 M5, §7 #1): the sandbox gate.
// Risky commands in coding conversations (and team helpers' runs) first run in a throwaway copy of
// the workspace; the card shows what they did and the owner applies only the diff, discards it or
// runs it for real. Read-only commands pass straight through. The copy leaves dependency folders
// and ignored files behind and respects a size cap; a git repository becomes a detached worktree.
// Nothing in the real workspace changes before Apply; writes outside the copy are blocked
// (bubblewrap / the macOS sandbox) or detected and flagged (the copy-only mode on Windows), and the
// gate never skips an approval, a 'never', the plan check (M2) or the budget (M4).
// Tests that need bubblewrap or the macOS sandbox skip cleanly without them (the Linux server has
// bubblewrap: they run there).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import type { Memory, MemoryStore } from '../src/memory.ts';
import {
  applySandbox,
  asksBeforeTry,
  checkedFindings,
  classifyCommand,
  detectIsolation,
  discardSandbox,
  dockerCommand,
  gateVerdict,
  GitIgnore,
  makeCopy,
  mergeSandboxGate,
  runInSandbox,
  SandboxGate,
  sandboxGateSettings,
  SandboxTooBig,
  shouldTry,
  sweepSandboxRuns,
  wslCommand,
  wslPath,
  type Isolation,
  type SandboxRecord,
  type SandboxResult,
} from '../src/sandbox-run.ts';
import { createSaraServer } from '../src/server.ts';
import { TeamManager } from '../src/team.ts';
import { shellTool } from '../src/tools/builtin.ts';
import { detectSandbox } from '../src/tools/sandbox.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const NOW = new Date('2026-10-30T15:00:00Z');
/** The copy-only mode (what Windows without Docker / WSL2 gets): deterministic on every platform. */
const COPY: Isolation = { driver: 'copy', isolated: false, label: 'Not isolated (test)' };
/** The same runner labelled isolated: for the pure gate decisions (auto-apply of a clean try). */
const ISOLATED_FAKE: Isolation = { driver: 'copy', isolated: true, label: 'Isolated (test stand-in)' };
const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
/** The strongest isolation this machine has for real (bubblewrap on the Linux server). */
const OS_SANDBOX = detectSandbox('auto', false);
const OS_ISOLATED = OS_SANDBOX.mode === 'bwrap' || OS_SANDBOX.mode === 'seatbelt';
const NO_OS = OS_ISOLATED ? false : `no bubblewrap / macOS sandbox here (${OS_SANDBOX.mode}); runs on the Linux server`;
const fwd = (p: string) => p.replace(/\\/g, '/');

function project(dir: string, files = 30): string {
  const ws = join(dir, 'workspaces', 'proj');
  mkdirSync(join(ws, 'src'), { recursive: true });
  for (let i = 0; i < files; i++) writeFileSync(join(ws, 'src', `f${i}.txt`), `file ${i}\n`);
  writeFileSync(join(ws, 'README.md'), '# demo\n');
  return ws;
}
const opts = (dir: string, iso: Isolation = COPY, extra: Partial<Parameters<typeof runInSandbox>[2]> = {}) => ({ cacheDir: join(dir, 'cache', 'sandbox-runs'), base: { mode: 'none' as const, network: false, detail: 'test' }, isolation: iso, timeoutMs: 60_000, signal: new AbortController().signal, ...extra });
const runsLeft = (dir: string) => (existsSync(join(dir, 'cache', 'sandbox-runs')) ? readdirSync(join(dir, 'cache', 'sandbox-runs')) : []);
/** Every file of a folder with its content (to prove a folder didn't change). */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out[abs.slice(root.length + 1).replace(/\\/g, '/')] = readFileSync(abs, 'utf8');
    }
  };
  walk(root);
  return out;
}

// ------------------------------------------------------------------------------------------------
// Classification
// ------------------------------------------------------------------------------------------------

test('classification: read-only commands pass straight through; risky ones say why', () => {
  for (const c of ['ls -la', 'cat README.md', 'git status', 'git log --oneline -5', 'git diff HEAD~1', 'grep -rn foo src', 'rg TODO', 'find . -name "*.ts"', 'wc -l src/*.ts', 'head -20 x.js | tail -5', 'pwd', 'echo "a > b"', 'node --version', 'npm ls', 'git branch', 'git branch -a', 'git remote -v', 'ls 2>/dev/null', 'cat x 2>&1 | grep y', 'sed -n 1,10p a.txt', "awk '{print $1}' a.txt", 'command -v node', 'git config --get user.name', 'cd src && ls']) {
    const r = classifyCommand(c);
    assert.equal(r.risky, false, `${c} is read-only (${r.reasons.join(',')})`);
  }
  const cases: [string, string[]][] = [
    ['echo hi > out.txt', ['writes']],
    ['rm -rf build', ['deletes']],
    ['find . -name "*.tmp" -delete', ['deletes']],
    ['npm install lodash', ['installs', 'network']],
    ['pip install requests', ['installs', 'network']],
    ['python -m pip install x', ['installs', 'network']],
    ['curl https://example.com', ['network']],
    ['node build.js', ['scripts']],
    ['npm test', ['scripts']],
    ['./run.sh', ['scripts']],
    ['python3 script.py', ['scripts']],
    ['make', ['scripts']],
    ['sed -i s/a/b/ x.txt', ['writes']],
    ['cat a | sh', ['scripts']],
    ['echo $(whoami)', ['scripts']],
    ['taskkill /F /IM node.exe', ['system']],
    ['sudo apt-get install x', ['installs', 'network', 'system']],
    ['git clean -fdx', ['deletes']],
    ['some-unknown-tool --flag', ['scripts']],
    ['ls && rm a.txt', ['deletes']],
  ];
  for (const [c, want] of cases) {
    const r = classifyCommand(c);
    assert.equal(r.risky, true, c);
    for (const w of want) assert.ok(r.reasons.includes(w as never), `${c}: ${w} in ${r.reasons.join(',')}`);
  }
  // Git's own repository commands keep the normal approval (and the M2 plan check): a copy can't hand them back.
  for (const c of ['git commit -m x', 'git push origin main', 'git checkout -b feature', 'git merge dev', 'git reset --hard HEAD~1', 'git stash']) assert.equal(classifyCommand(c).gitOnly, true, c);
  assert.notEqual(classifyCommand('npm test && git commit -am x').gitOnly, true, 'mixed with a script: tried in the copy');
});

test('the gate decision: settings, tools, coding only; Windows copy mode always asks and is labelled not isolated', () => {
  const s = sandboxGateSettings({});
  assert.equal(s.mode, 'risky', 'default: only risky commands');
  assert.equal(s.network, false, 'default: no network for tries');
  assert.deepEqual(shouldTry({ tool: 'shell', args: { command: 'ls' }, coding: true, settings: s }).try, false);
  assert.deepEqual(shouldTry({ tool: 'shell', args: { command: 'rm -rf x' }, coding: true, settings: s }).try, true);
  assert.equal(shouldTry({ tool: 'shell', args: { command: 'ls' }, coding: true, settings: { ...s, mode: 'every' } }).try, true, 'every command');
  assert.equal(shouldTry({ tool: 'shell', args: { command: 'rm -rf x' }, coding: true, settings: { ...s, mode: 'off' } }).try, false, 'off');
  assert.equal(shouldTry({ tool: 'shell', args: { command: 'rm -rf x' }, coding: false, settings: s }).try, false, 'everyday chats: unchanged');
  assert.equal(shouldTry({ tool: 'write_file', args: { path: 'x' }, coding: true, settings: s }).try, false, 'only commands');
  assert.equal(shouldTry({ tool: 'shell', args: { command: 'git push origin main' }, coding: true, settings: s }).try, false, 'git-only: normal approval');
  // §7 #1: no OS isolation → the try needs the OK first when the tool asks first, and the result always asks.
  const win = detectIsolation({ mode: 'none', network: true, detail: '' }, s, { platform: 'win32', probe: () => 1 });
  assert.equal(win.driver, 'copy');
  assert.equal(win.isolated, false);
  assert.match(win.label, /^Not isolated/);
  assert.equal(asksBeforeTry(win, 'ask'), true);
  assert.equal(asksBeforeTry(win, 'auto'), false);
  const clean = { isolation: win, verdict: 'clean', findings: [] } as unknown as SandboxResult;
  assert.deepEqual(gateVerdict(clean, 'auto'), { act: 'ask', reason: 'not isolated' }, 'Windows copy mode: always ask before applying');
  // Docker (image present) or WSL2 with bubblewrap are used when found; nothing is installed.
  const docker = detectIsolation({ mode: 'none', network: true, detail: '' }, s, { platform: 'win32', probe: (f, a) => (f === 'docker' ? 0 : a.includes('--status') ? 1 : 1) });
  assert.equal(docker.driver, 'docker');
  assert.equal(docker.isolated, true);
  const wsl = detectIsolation({ mode: 'none', network: true, detail: '' }, s, { platform: 'win32', probe: (f) => (f === 'docker' ? null : 0), exists: () => true });
  assert.equal(wsl.driver, 'wsl');
  const imageMissing = detectIsolation({ mode: 'none', network: true, detail: '' }, s, { platform: 'win32', probe: (f, a) => (f === 'docker' && a[0] === 'version' ? 0 : 1) });
  assert.equal(imageMissing.driver, 'copy', 'Docker without the image: never pulled, copy mode');
  assert.equal(imageMissing.found?.docker, true);
  // Linux / macOS: the existing shell sandbox.
  assert.equal(detectIsolation({ mode: 'bwrap', network: true, detail: '' }).driver, 'bwrap');
  assert.equal(detectIsolation({ mode: 'seatbelt', network: true, detail: '' }).driver, 'seatbelt');
  // Isolated + allowed + clean → applied by itself; findings or 'ask' → the card.
  const iso = { isolation: { driver: 'bwrap', isolated: true, label: '' }, verdict: 'clean', findings: [] } as unknown as SandboxResult;
  assert.deepEqual(gateVerdict(iso, 'auto'), { act: 'allow' });
  assert.equal(gateVerdict(iso, 'ask').act, 'ask');
  assert.equal(gateVerdict({ ...iso, verdict: 'flagged' } as SandboxResult, 'auto').act, 'ask');
});

test('Docker and WSL2 commands: only the copy mounted, no network, dependencies read-only', () => {
  const d = dockerCommand('C:\\data\\cache\\sandbox-runs\\x\\ws', 'npm test', { image: 'node:24-slim', network: false, deps: [{ src: 'C:\\ws\\node_modules', rel: 'node_modules' }] });
  assert.match(d, /^docker run --rm/);
  assert.match(d, /--network none/);
  assert.match(d, /--cap-drop ALL/);
  assert.match(d, /'C:\\data\\cache\\sandbox-runs\\x\\ws:\/workspace'/);
  assert.match(d, /'C:\\ws\\node_modules:\/workspace\/node_modules:ro'/);
  assert.doesNotMatch(dockerCommand('C:\\x', 'ls', { image: 'i', network: true }), /--network/);
  assert.equal(wslPath('C:\\Users\\Alex\\data'), '/mnt/c/Users/Alex/data');
  const w = wslCommand('C:\\data\\ws', 'npm test', { network: false, deps: [{ src: 'C:\\ws\\node_modules', rel: 'node_modules' }] });
  assert.match(w, /wsl\.exe -e bwrap/);
  assert.match(w, /--bind \/mnt\/c\/data\/ws \/workspace/);
  assert.match(w, /--ro-bind \/mnt\/c\/ws\/node_modules \/workspace\/node_modules/);
  assert.match(w, /--unshare-all/);
  assert.doesNotMatch(w, /--share-net/);
});

test('settings: defaults, clamping, unknown keys ignored', () => {
  assert.deepEqual(sandboxGateSettings({ sandboxGate: { mode: 'nope' as never, maxMB: 7 as never, timeLimitS: 9 as never } }), sandboxGateSettings({}));
  const m = mergeSandboxGate(sandboxGateSettings({}), { mode: 'every', network: true, maxMB: 2000, timeLimitS: 300, evil: 1, dockerImage: 'bad image;rm' });
  assert.equal(m.mode, 'every');
  assert.equal(m.network, true);
  assert.equal(m.maxMB, 2000);
  assert.equal(m.timeLimitS, 300);
  assert.equal(m.dockerImage, 'node:24-slim', 'an odd image name is refused');
  assert.equal('evil' in m, false);
});

// ------------------------------------------------------------------------------------------------
// The copy
// ------------------------------------------------------------------------------------------------

test('the copy leaves dependency folders and ignored files behind and respects the size cap', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ws = project(dir);
  writeFileSync(join(ws, '.gitignore'), 'dist/\n*.log\n/secret.env\ndocs/**/draft-*.md\n!keep.log\n');
  mkdirSync(join(ws, 'dist'));
  writeFileSync(join(ws, 'dist', 'bundle.js'), 'built');
  writeFileSync(join(ws, 'debug.log'), 'log');
  writeFileSync(join(ws, 'keep.log'), 'kept');
  writeFileSync(join(ws, 'secret.env'), 'X=1');
  mkdirSync(join(ws, 'docs', 'a'), { recursive: true });
  writeFileSync(join(ws, 'docs', 'a', 'draft-1.md'), 'd');
  writeFileSync(join(ws, 'docs', 'a', 'final.md'), 'f');
  for (const heavy of ['node_modules/lib', '.venv/bin', '__pycache__', 'target/debug']) {
    mkdirSync(join(ws, heavy), { recursive: true });
    writeFileSync(join(ws, heavy, 'x.bin'), 'big');
  }
  const dest = join(dir, 'copy');
  const info = makeCopy(ws, dest, { maxBytes: 10 * 1048576, preferWorktree: false });
  assert.equal(info.strategy, 'copy');
  const got = Object.keys(snapshot(dest)).sort();
  assert.ok(got.includes('src/f0.txt') && got.includes('keep.log') && got.includes('docs/a/final.md') && got.includes('.gitignore'), got.join(','));
  for (const gone of ['dist/bundle.js', 'debug.log', 'secret.env', 'docs/a/draft-1.md', 'node_modules/lib/x.bin', '.venv/bin/x.bin', '__pycache__/x.bin', 'target/debug/x.bin']) assert.ok(!got.includes(gone), `${gone} is not copied`);
  assert.deepEqual(info.heavy.sort(), ['.venv', '__pycache__', 'node_modules', 'target']);
  // The size cap: a project over it is refused (the card then offers Run for real / Discard).
  writeFileSync(join(ws, 'big.dat'), Buffer.alloc(300_000));
  assert.throws(() => makeCopy(ws, join(dir, 'copy2'), { maxBytes: 200_000, preferWorktree: false }), SandboxTooBig);
  // .gitignore matching details.
  const ig = new GitIgnore();
  ig.add('', 'build/\n*.tmp\n/root-only.txt\nlogs/**\n');
  ig.add('sub', 'local.txt\n');
  assert.equal(ig.ignored('build', true), true);
  assert.equal(ig.ignored('build', false), false, 'dir-only pattern');
  assert.equal(ig.ignored('a/b/c.tmp', false), true);
  assert.equal(ig.ignored('root-only.txt', false), true);
  assert.equal(ig.ignored('x/root-only.txt', false), false, 'anchored');
  assert.equal(ig.ignored('logs/a/b.txt', false), true);
  assert.equal(ig.ignored('sub/local.txt', false), true);
  assert.equal(ig.ignored('other/local.txt', false), false, 'a nested .gitignore only covers its folder');
});

test('a too-big workspace is not tried: nothing runs, the card says so, the copy is gone', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ws = project(dir);
  writeFileSync(join(ws, 'big.dat'), Buffer.alloc(400_000));
  const r = await runInSandbox(ws, 'echo hi > made.txt', { ...opts(dir), maxBytes: 100_000, preferWorktree: false });
  assert.equal(r.run, null);
  assert.ok(r.notRun);
  assert.equal(r.findings[0].rule, 'too-big');
  assert.equal(existsSync(join(ws, 'made.txt')), false);
  assert.deepEqual(runsLeft(dir), []);
});

test('git worktree path: a detached worktree with the uncommitted and new files; ignored ones left out; cleaned up after', { skip: HAS_GIT ? false : 'git not installed' }, async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ws = project(dir, 10);
  writeFileSync(join(ws, '.gitignore'), 'node_modules/\n*.log\n');
  const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...a], { cwd: ws, encoding: 'utf8' });
  assert.equal(g('init', '-q').status, 0);
  g('add', '.');
  assert.equal(g('commit', '-qm', 'init').status, 0);
  writeFileSync(join(ws, 'src', 'f1.txt'), 'changed but not committed\n');
  writeFileSync(join(ws, 'new.txt'), 'new, not committed\n');
  rmSync(join(ws, 'src', 'f2.txt'));
  writeFileSync(join(ws, 'debug.log'), 'ignored');
  mkdirSync(join(ws, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(ws, 'node_modules', 'x', 'i.js'), '1');
  const r = await runInSandbox(ws, 'cat src/f1.txt new.txt; ls src | wc -l; ls debug.log 2>&1; git status --porcelain', { ...opts(dir), keep: true });
  assert.equal(r.copy?.strategy, 'worktree');
  assert.match(r.run!.output, /changed but not committed/);
  assert.match(r.run!.output, /new, not committed/);
  assert.match(r.run!.output, /No such file|cannot access/, 'ignored files stay behind');
  // git in the copy sees what the real workspace shows (one change, one deletion, one new file).
  assert.match(r.run!.output, / M src\/f1\.txt/);
  assert.match(r.run!.output, / D src\/f2\.txt/);
  assert.match(r.run!.output, /\?\? new\.txt/);
  assert.match(g('worktree', 'list').stdout, /sandbox-runs/);
  discardSandbox(r);
  assert.doesNotMatch(g('worktree', 'list').stdout, /sandbox-runs/, 'the worktree registration is gone');
  assert.deepEqual(runsLeft(dir), []);
  // The real workspace is as it was.
  assert.equal(readFileSync(join(ws, 'src', 'f1.txt'), 'utf8'), 'changed but not committed\n');
});

// ------------------------------------------------------------------------------------------------
// What the try observes
// ------------------------------------------------------------------------------------------------

test('a command that deletes files only affects the copy (and a mass delete is flagged)', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ws = project(dir, 40);
  const before = snapshot(ws);
  const r = await runInSandbox(ws, 'rm -f src/*.txt && echo gone', { ...opts(dir), preferWorktree: false });
  assert.equal(r.run?.exitCode, 0);
  assert.equal(r.changes.removed.length, 40);
  assert.ok(r.findings.some((f) => f.rule === 'mass-delete' && f.severity === 'high' && f.count === 40));
  assert.equal(r.verdict, 'flagged');
  assert.deepEqual(snapshot(ws), before, 'the real workspace is untouched');
  assert.deepEqual(runsLeft(dir), [], 'the copy is deleted afterwards');
});

test('copy-only mode (Windows): a write outside the copy is detected and flagged (watched folders + canary)', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ws = project(dir);
  const outside = join(dirname(ws), 'escaped.txt');
  const r = await runInSandbox(ws, `echo pwned > '${fwd(outside)}'; echo pwned > ../canary-hit.txt; echo ok`, { ...opts(dir), preferWorktree: false });
  const f = r.findings.find((x) => x.rule === 'write-outside');
  assert.ok(f, JSON.stringify(r.findings));
  assert.equal(f.severity, 'high');
  assert.ok(f.files!.some((p) => p.endsWith('escaped.txt')), f.files!.join(','));
  assert.ok(f.files!.some((p) => p.endsWith('canary-hit.txt')), 'a write beside the copy is caught too');
  assert.ok(r.findings.some((x) => x.rule === 'not-isolated'), 'labelled not isolated');
  rmSync(outside, { force: true });
});

test('copy-only mode: a change to the REAL workspace while it runs is detected (before/after watch of the real files)', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ws = project(dir);
  const r = await runInSandbox(ws, `echo tampered >> '${fwd(join(ws, 'README.md'))}'`, { ...opts(dir), preferWorktree: false });
  const f = r.findings.find((x) => x.rule === 'write-outside');
  assert.ok(f?.files?.includes('README.md'), JSON.stringify(r.findings));
});

test('processes left running are found, stopped and flagged', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ws = project(dir, 2);
  const r = await runInSandbox(ws, 'sleep 45 > /dev/null 2>&1 & echo started', { ...opts(dir), preferWorktree: false });
  const f = r.findings.find((x) => x.rule === 'process-left');
  assert.ok(f, JSON.stringify(r.findings));
  assert.ok((f.count ?? 0) >= 1);
  assert.equal(f.severity, 'high');
});

test('a try that runs past its time limit is stopped and flagged', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ws = project(dir, 2);
  const r = await runInSandbox(ws, 'sleep 20', { ...opts(dir), timeoutMs: 1500, preferWorktree: false });
  assert.equal(r.run?.timedOut, true);
  assert.ok(r.findings.some((x) => x.rule === 'timeout'));
});

test('git hooks and shell settings files written in the copy are flagged and never applied', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ws = project(dir, 2);
  mkdirSync(join(ws, '.git', 'hooks'), { recursive: true });
  const r = await runInSandbox(ws, "mkdir -p .git/hooks && printf '#!/bin/sh\\necho hi\\n' > .git/hooks/pre-commit && echo 'alias ls=rm' > .bashrc && echo ok > ok.txt", { ...opts(dir), keep: true, preferWorktree: false });
  assert.ok(r.findings.some((f) => f.rule === 'git-hooks' && f.files?.includes('.git/hooks/pre-commit')), JSON.stringify(r.findings));
  assert.ok(r.findings.some((f) => f.rule === 'home-files' && f.files?.includes('.bashrc')));
  const a = await applySandbox(r);
  assert.ok(a.refused.includes('.git/hooks/pre-commit'));
  assert.equal(existsSync(join(ws, '.git', 'hooks', 'pre-commit')), false, 'the hook never reaches the real repository');
  assert.ok(a.written.includes('ok.txt'));
});

test('findings that quote output must quote a real line (the "no theater" rule)', () => {
  const f = { source: 'sandbox' as const, severity: 'medium' as const, rule: 'network' as const, title: 't', advice: 'a', status: 'open' as const };
  assert.equal(checkedFindings([{ ...f, quote: 'Could not resolve host: x' }], 'curl: (6) Could not resolve host: x\n').length, 1);
  assert.equal(checkedFindings([{ ...f, quote: 'made up' }], 'curl: (6) Could not resolve host: x\n').length, 0);
});

// ------------------------------------------------------------------------------------------------
// Apply / Discard
// ------------------------------------------------------------------------------------------------

test('Apply writes exactly the diff (and leaves alone a file changed meanwhile); Discard leaves the workspace untouched', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ws = project(dir, 10);
  const untouchedBefore = statSync(join(ws, 'src', 'f5.txt')).mtimeMs;
  const cmd = 'echo added > added.txt && echo more >> src/f1.txt && rm src/f2.txt && echo also >> src/f3.txt';
  // Discard first.
  const before = snapshot(ws);
  const d = await runInSandbox(ws, cmd, { ...opts(dir), keep: true, preferWorktree: false });
  assert.deepEqual(d.changes.added.map((c) => c.path), ['added.txt']);
  assert.deepEqual(d.changes.changed.map((c) => c.path), ['src/f1.txt', 'src/f3.txt']);
  assert.deepEqual(d.changes.removed.map((c) => c.path), ['src/f2.txt']);
  discardSandbox(d);
  assert.deepEqual(snapshot(ws), before, 'Discard: nothing changed');
  assert.deepEqual(runsLeft(dir), []);
  // Apply.
  const r = await runInSandbox(ws, cmd, { ...opts(dir), keep: true, preferWorktree: false });
  // The owner edits f3 by hand while the card is open: it must be left alone.
  await new Promise((res) => setTimeout(res, 30));
  writeFileSync(join(ws, 'src', 'f3.txt'), 'edited by hand meanwhile\n');
  const a = await applySandbox(r);
  assert.deepEqual(a.written.sort(), ['added.txt', 'src/f1.txt']);
  assert.deepEqual(a.removed, ['src/f2.txt']);
  assert.deepEqual(a.conflicts, ['src/f3.txt']);
  assert.equal(readFileSync(join(ws, 'added.txt'), 'utf8').trim(), 'added');
  assert.equal(readFileSync(join(ws, 'src', 'f1.txt'), 'utf8').replace(/\r/g, ''), 'file 1\nmore\n');
  assert.equal(existsSync(join(ws, 'src', 'f2.txt')), false);
  assert.equal(readFileSync(join(ws, 'src', 'f3.txt'), 'utf8'), 'edited by hand meanwhile\n');
  assert.equal(statSync(join(ws, 'src', 'f5.txt')).mtimeMs, untouchedBefore, 'files outside the diff are not rewritten');
  // The rest is exactly as before (+ the diff).
  const after = snapshot(ws);
  for (const [k, v] of Object.entries(before)) if (!['src/f1.txt', 'src/f2.txt', 'src/f3.txt'].includes(k)) assert.equal(after[k], v, k);
  assert.deepEqual(runsLeft(dir), [], 'the copy goes after Apply');
  await assert.rejects(applySandbox(r), /no longer there/, 'a try can only be applied once');
});

test('Apply records the M3 workspace manifest before and after', { skip: HAS_GIT ? false : 'git not installed' }, async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ws = project(dir, 3);
  const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...a], { cwd: ws, encoding: 'utf8' });
  g('init', '-q');
  g('add', '.');
  g('commit', '-qm', 'init');
  const r = await runInSandbox(ws, 'echo x >> src/f0.txt', { ...opts(dir), keep: true });
  const a = await applySandbox(r);
  assert.ok(a.refBefore?.head && a.refAfter?.head, 'HEAD recorded');
  assert.deepEqual(a.refBefore?.dirty, []);
  assert.deepEqual(a.refAfter?.dirty?.map((d) => d.path), ['src/f0.txt']);
});

test('startup sweep: copies left by a restart are removed (worktrees pruned)', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const cache = join(dir, 'cache', 'sandbox-runs');
  mkdirSync(join(cache, 'old-1', 'ws'), { recursive: true });
  writeFileSync(join(cache, 'old-1', 'ws', 'x'), 'x');
  assert.equal(sweepSandboxRuns(cache), 1);
  assert.deepEqual(readdirSync(cache), []);
});

// ------------------------------------------------------------------------------------------------
// The OS sandbox (bubblewrap / macOS): skipped without one
// ------------------------------------------------------------------------------------------------

test('isolated: a write outside the copy is blocked, and flagged when the sandbox refuses it', { skip: NO_OS }, async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ws = project(dir, 2);
  const iso = detectIsolation(OS_SANDBOX);
  const outside = join(dirname(ws), 'escaped.txt');
  const r = await runInSandbox(ws, `echo pwned > '${outside}' 2>&1; echo pwned > /etc/sara-sandbox-test 2>&1; echo pwned > "$HOME/../escape2.txt" 2>&1; echo done`, { ...opts(dir, iso), base: { ...OS_SANDBOX, dataDir: dir } });
  assert.equal(existsSync(outside), false, 'nothing was written outside the copy');
  assert.equal(existsSync('/etc/sara-sandbox-test'), false);
  assert.equal(existsSync(join(dir, 'cache', 'sandbox-runs', 'escape2.txt')), false);
  assert.ok(r.findings.some((f) => f.rule === 'outside-blocked'), JSON.stringify(r.findings));
  assert.ok(!r.findings.some((f) => f.rule === 'not-isolated'));
});

test('isolated: no network inside (a loopback server outside is unreachable)', { skip: NO_OS }, async (t) => {
  const { dir, cleanup } = tempDir();
  let hits = 0;
  const server = createServer((_q, s) => {
    hits++;
    s.end('hello');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    cleanup();
  });
  const port = (server.address() as AddressInfo).port;
  const ws = project(dir, 2);
  const iso = detectIsolation(OS_SANDBOX);
  const r = await runInSandbox(ws, `node -e "fetch('http://127.0.0.1:${port}/').then(()=>console.log('REACHED')).catch((e)=>console.log('connect ECONNREFUSED', e.cause?.code))" || (command -v curl >/dev/null && curl -sS http://127.0.0.1:${port}/ 2>&1) || echo no-client`, { ...opts(dir, iso), base: { ...OS_SANDBOX, dataDir: dir } });
  assert.doesNotMatch(r.run!.output, /REACHED|hello/);
  assert.equal(hits, 0);
});

test('isolated: a background process is gone after the try and flagged', { skip: NO_OS }, async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ws = project(dir, 2);
  const iso = detectIsolation(OS_SANDBOX);
  const r = await runInSandbox(ws, 'sleep 60 > /dev/null 2>&1 & echo started', { ...opts(dir, iso), base: { ...OS_SANDBOX, dataDir: dir } });
  assert.ok(r.findings.some((f) => f.rule === 'process-left'), JSON.stringify(r.findings));
  const ps = spawnSync('sh', ['-c', 'ps -eo args | grep -c "^sleep 60$" || true'], { encoding: 'utf8' });
  assert.equal(ps.stdout.trim(), '0', 'the sleep is gone');
});

// ------------------------------------------------------------------------------------------------
// In a turn: the gate at the approval point
// ------------------------------------------------------------------------------------------------

function setup(t: { after: (fn: () => void) => void }, o: { iso?: Isolation; shell?: 'auto' | 'ask' | 'never'; gate?: boolean } = {}): { app: TestApp; dir: string; ws: string; conv: { id: string } } {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.tools.add(shellTool);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago', disclosureAcceptedAt: NOW.toISOString(), toolPermissions: { shell: o.shell ?? 'auto' } });
  if (o.gate !== false) app.sandboxGate = new SandboxGate(join(dir, 'cache', 'sandbox-runs'), app.sandbox, () => sandboxGateSettings(app.settings.get()), () => o.iso ?? COPY);
  const conv = app.store.createConversation({ mode: 'coding' });
  const ws = workspaceDir(dir, conv.workspace);
  for (let i = 0; i < 5; i++) writeFileSync(join(ws, `n${i}.txt`), `n${i}\n`);
  return { app, dir, ws, conv };
}
type Approval = Extract<ChatEvent, { type: 'approval' }>;
async function drain(gen: AsyncGenerator<ChatEvent>, onApproval?: (ev: Approval) => void): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) {
    out.push(ev);
    if (ev.type === 'approval') onApproval?.(ev);
  }
  return out;
}
const toolMsgs = (app: TestApp, id: string) => app.store.messages(id).filter((m) => m.role === 'tool');

test('turn: a risky command runs in the copy first; the card shows it; nothing changes before Apply; Apply writes the diff', async (t) => {
  const { app, dir, ws, conv } = setup(t);
  app.script.push([call('c1', 'shell', { command: 'rm n1.txt n2.txt && echo hello > made.txt' })], text('Done.'));
  let card: Approval['sandbox'];
  let wsAtCard: Record<string, string> = {};
  const evs = await drain(runTurn(app, conv.id, 'clean up'), (ev) => {
    card = ev.sandbox;
    wsAtCard = snapshot(ws);
    app.approvals.decide(ev.approvalId, true, 'apply');
  });
  assert.ok(evs.some((e) => e.type === 'sandbox_running'));
  assert.ok(card, 'the Ran in a sandbox card');
  assert.equal(card!.isolated, false);
  assert.deepEqual(card!.counts, { added: 1, changed: 0, removed: 2 });
  assert.ok(card!.findings.some((f) => f.rule === 'not-isolated'));
  assert.ok(existsSync(join(ws, 'n1.txt')) || wsAtCard['n1.txt'], 'while the card was open, the workspace was untouched');
  assert.equal(wsAtCard['made.txt'], undefined);
  assert.equal(wsAtCard['n1.txt'], 'n1\n');
  // After Apply.
  assert.equal(existsSync(join(ws, 'n1.txt')), false);
  assert.equal(readFileSync(join(ws, 'made.txt'), 'utf8').trim(), 'hello');
  const tm = toolMsgs(app, conv.id)[0];
  assert.equal(tm.meta?.status, 'ok');
  assert.match(tm.content, /ran in a sandbox copy \(not isolated\)/);
  assert.match(tm.content, /The owner applied it: 1 file written, 2 files removed/);
  const rec = tm.meta?.sandbox as SandboxRecord;
  assert.equal(rec.decision, 'applied');
  assert.ok(evs.some((e) => e.type === 'sandbox' && e.record.decision === 'applied'));
  assert.deepEqual(runsLeft(dir), []);
});

test('turn: Discard leaves the workspace untouched; she is told it was discarded', async (t) => {
  const { app, dir, ws, conv } = setup(t);
  const before = snapshot(ws);
  app.script.push([call('c1', 'shell', { command: 'rm -f n*.txt' })], text('OK.'));
  await drain(runTurn(app, conv.id, 'delete them'), (ev) => app.approvals.decide(ev.approvalId, false, 'discard'));
  assert.deepEqual(snapshot(ws), before);
  const tm = toolMsgs(app, conv.id)[0];
  assert.equal(tm.meta?.status, 'denied');
  assert.match(tm.content, /discarded this try: nothing changed/);
  assert.equal((tm.meta?.sandbox as SandboxRecord).decision, 'discarded');
  assert.deepEqual(runsLeft(dir), []);
  // A plain Deny (bridges, older apps) is a discard too; a plain Allow applies.
  app.script.push([call('c2', 'shell', { command: 'echo y > y.txt' })], text('OK.'));
  await drain(runTurn(app, conv.id, 'again'), (ev) => app.approvals.decide(ev.approvalId, true));
  assert.equal(readFileSync(join(ws, 'y.txt'), 'utf8').trim(), 'y');
});

test('turn: Run for real is an explicit choice on the card; the command then runs in the real workspace', async (t) => {
  const { app, ws, conv } = setup(t);
  app.script.push([call('c1', 'shell', { command: 'echo real > real.txt' })], text('OK.'));
  let asked = 0;
  const evs = await drain(runTurn(app, conv.id, 'do it'), (ev) => {
    asked++;
    assert.equal(existsSync(join(ws, 'real.txt')), false, 'nothing ran for real before the choice');
    app.approvals.decide(ev.approvalId, true, 'real');
  });
  assert.equal(asked, 1);
  assert.ok(evs.some((e) => e.type === 'tool_running'));
  assert.equal(readFileSync(join(ws, 'real.txt'), 'utf8').trim(), 'real');
  const tm = toolMsgs(app, conv.id)[0];
  assert.match(tm.content, /tried in a sandbox copy first: 1 added; the owner chose to run it for real/);
  assert.equal((tm.meta?.sandbox as SandboxRecord).decision, 'ran');
});

test("turn: never stays never (no try); 'ask' without isolation asks BEFORE the try; read-only commands pass straight through", async (t) => {
  // never
  const a = setup(t, { shell: 'never' });
  a.app.script.push([call('c1', 'shell', { command: 'rm -rf *' })], text('OK.'));
  const evs = await drain(runTurn(a.app, a.conv.id, 'x'), () => assert.fail('no card for a tool that is off'));
  assert.ok(!evs.some((e) => e.type === 'sandbox_running'));
  assert.match(toolMsgs(a.app, a.conv.id)[0].content, /disabled the shell tool|isn't available here/);
  assert.equal(toolMsgs(a.app, a.conv.id)[0].meta?.status, 'denied');
  assert.deepEqual(runsLeft(a.dir), []);
  // ask, not isolated: the first card (with the "tried in a copy first" note); Deny → nothing at all ran.
  const b = setup(t, { shell: 'ask' });
  b.app.script.push([call('c1', 'shell', { command: 'echo x > x.txt' })], text('OK.'));
  const cards: Approval[] = [];
  const evs2 = await drain(runTurn(b.app, b.conv.id, 'x'), (ev) => {
    cards.push(ev);
    b.app.approvals.decide(ev.approvalId, false);
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].sandboxFirst?.isolated, false, 'the normal approval, noting the copy is not isolated');
  assert.equal(cards[0].sandbox, undefined);
  assert.ok(!evs2.some((e) => e.type === 'sandbox_running'), 'declined before anything ran');
  assert.equal(existsSync(join(b.ws, 'x.txt')), false);
  // ask, not isolated, allowed → the try → the sandbox card (two cards).
  b.app.script.push([call('c2', 'shell', { command: 'echo x > x.txt' })], text('OK.'));
  const kinds: string[] = [];
  await drain(runTurn(b.app, b.conv.id, 'x'), (ev) => {
    kinds.push(ev.sandbox ? 'sandbox' : ev.sandboxFirst ? 'first' : 'plain');
    b.app.approvals.decide(ev.approvalId, true, ev.sandbox ? 'apply' : undefined);
  });
  assert.deepEqual(kinds, ['first', 'sandbox']);
  assert.equal(readFileSync(join(b.ws, 'x.txt'), 'utf8').trim(), 'x');
  // Read-only: straight through (auto → no card at all).
  const c = setup(t, { shell: 'auto' });
  c.app.script.push([call('c1', 'shell', { command: 'ls' })], text('OK.'));
  const evs3 = await drain(runTurn(c.app, c.conv.id, 'x'), () => assert.fail('no card for ls'));
  assert.ok(!evs3.some((e) => e.type === 'sandbox_running'));
  assert.match(toolMsgs(c.app, c.conv.id)[0].content, /n0\.txt/);
  // The gate switched off: the old behaviour exactly (auto runs at once, for real).
  const d = setup(t, { shell: 'auto' });
  d.app.settings.update({ sandboxGate: { mode: 'off' } });
  d.app.script.push([call('c1', 'shell', { command: 'echo z > z.txt' })], text('OK.'));
  await drain(runTurn(d.app, d.conv.id, 'x'), () => assert.fail('no card'));
  assert.equal(readFileSync(join(d.ws, 'z.txt'), 'utf8').trim(), 'z');
  // An everyday chat: unchanged.
  const e = setup(t, { shell: 'auto' });
  const chat = e.app.store.createConversation({});
  e.app.script.push([call('c1', 'shell', { command: 'echo w > w.txt' })], text('OK.'));
  const evs4 = await drain(runTurn(e.app, chat.id, 'x'), () => assert.fail('no card'));
  assert.ok(!evs4.some((x) => x.type === 'sandbox_running'));
});

test('turn: isolated + allowed + clean → applied by itself (recorded); with a finding → the card', async (t) => {
  const { app, ws, conv } = setup(t, { iso: ISOLATED_FAKE });
  app.script.push([call('c1', 'shell', { command: 'echo a > a.txt' })], text('OK.'));
  const evs = await drain(runTurn(app, conv.id, 'x'), () => assert.fail('a clean isolated try of an allowed tool needs no card'));
  assert.equal(readFileSync(join(ws, 'a.txt'), 'utf8').trim(), 'a');
  const rec = evs.find((e) => e.type === 'sandbox') as Extract<ChatEvent, { type: 'sandbox' }>;
  assert.equal(rec.record.decision, 'auto-applied');
  assert.match(toolMsgs(app, conv.id)[0].content, /Applied by itself/);
  // A mass delete is a finding: the card, even though the tool is allowed.
  for (let i = 0; i < 25; i++) writeFileSync(join(ws, `m${i}.txt`), 'm');
  app.script.push([call('c2', 'shell', { command: 'rm -f m*.txt' })], text('OK.'));
  let card: Approval['sandbox'];
  await drain(runTurn(app, conv.id, 'x'), (ev) => {
    card = ev.sandbox;
    app.approvals.decide(ev.approvalId, false, 'discard');
  });
  assert.ok(card?.findings.some((f) => f.rule === 'mass-delete'));
  assert.equal(existsSync(join(ws, 'm0.txt')), true);
});

test('turn: the plan check (M2) still stops first; deny → nothing tried; override → the try, then its card', async (t) => {
  const { app, dir, ws, conv } = setup(t);
  const mem = app.memory as MemoryStore;
  mem.add({ kind: 'decision' as Memory['kind'], content: "Alex doesn't want Sara to touch the infra/ folder.", evidence: null, conversationId: null, sourceMessageId: null, happenedOn: '2026-10-12' });
  mkdirSync(join(ws, 'infra', 'old'), { recursive: true });
  writeFileSync(join(ws, 'infra', 'old', 'main.tf'), 'x');
  app.script.push([call('c1', 'shell', { command: 'rm -rf infra/old' })], text('OK.'));
  const cards: Approval[] = [];
  const evs = await drain(runTurn(app, conv.id, 'clean infra'), (ev) => {
    cards.push(ev);
    app.approvals.decide(ev.approvalId, false, 'deny');
  });
  assert.equal(cards.length, 1);
  assert.ok(cards[0].contradiction, 'the contradiction card');
  assert.ok(!evs.some((e) => e.type === 'sandbox_running'), 'nothing tried after a no');
  assert.deepEqual(runsLeft(dir), []);
  assert.ok(existsSync(join(ws, 'infra', 'old', 'main.tf')));
  // Override → the try → the sandbox card → discard: still untouched.
  app.script.push([call('c2', 'shell', { command: 'rm -rf infra/old' })], text('OK.'));
  const kinds: string[] = [];
  await drain(runTurn(app, conv.id, 'clean infra'), (ev) => {
    kinds.push(ev.contradiction ? 'contradiction' : ev.sandbox ? 'sandbox' : 'plain');
    app.approvals.decide(ev.approvalId, !ev.sandbox, ev.sandbox ? 'discard' : 'override');
  });
  assert.deepEqual(kinds, ['contradiction', 'sandbox']);
  assert.ok(existsSync(join(ws, 'infra', 'old', 'main.tf')));
});

test('turn: budgets still stop the turn with the gate on; the run step keeps the sandbox record', async (t) => {
  const { app, conv } = setup(t, { iso: ISOLATED_FAKE });
  const { RunStore, runSettings } = await import('../src/runs.ts');
  const runs = new RunStore(app.store.db, () => NOW);
  runs.settings = () => runSettings(app.settings.get());
  app.runs = runs;
  app.settings.update({ turnBudgets: { coding: { on: true, tokens: 200_000, steps: 3, usd: 0, minutes: 0 } } });
  app.script.push([call('s1', 'shell', { command: 'echo 1 > one.txt' })], [call('s2', 'shell', { command: 'echo 2 > two.txt' })], [...text('Wrapping up.'), call('s3', 'shell', { command: 'echo 3 > three.txt' })]);
  const evs = await drain(runTurn(app, conv.id, 'go'), (ev) => app.approvals.decide(ev.approvalId, true, 'apply'));
  assert.ok(evs.some((e) => e.type === 'budget' && e.state.stage === 'reached'), 'the budget stop still fires');
  assert.equal(runs.list({ conversationId: conv.id })[0].status, 'budget');
  const run = runs.get(runs.list({ conversationId: conv.id })[0].id)!;
  const steps = runs.steps(run.id);
  const tools = steps.flatMap((s) => s.tools);
  assert.ok(tools.some((x) => (x.sandbox as SandboxRecord | undefined)?.decision === 'auto-applied'), 'the run step keeps the sandbox record');
});

test('team helpers: their risky commands are tried in the copy; the team card applies / discards', async (t) => {
  const { app, ws, conv } = setup(t);
  app.team = new TeamManager(app, app.store.db);
  app.script.push([call('h1', 'shell', { command: 'echo team > team.txt' })], text('Wrote team.txt. VERDICT: PASS'), text('Report.'));
  const task = app.team.start(conv.id, 'Make team.txt.', { plan: [{ helper: 'coder', title: 'Make it', instructions: 'Make team.txt.' }] });
  for (let i = 0; i < 300 && !app.team.approvals(task.id).length; i++) await new Promise((r) => setTimeout(r, 20));
  const [pending] = app.team.approvals(task.id);
  assert.ok(pending?.sandbox, 'the helper\'s approval carries the sandbox card');
  assert.equal(pending.sandbox!.counts.added, 1);
  assert.equal(existsSync(join(ws, 'team.txt')), false, 'not in the workspace before Apply');
  app.approvals.decide(pending.id, true, 'apply');
  const done = await app.team.finished(task.id);
  assert.equal(readFileSync(join(ws, 'team.txt'), 'utf8').trim(), 'team');
  assert.equal(done.steps[0].receipts[0].status, 'ok');
  assert.match(done.steps[0].receipts[0].output, /The owner applied it/);
});

// ------------------------------------------------------------------------------------------------
// Settings, routes, UI files
// ------------------------------------------------------------------------------------------------

test('routes: GET/PUT /api/sandbox (owner settings, isolation shown); approvals take apply / discard / real', async (t) => {
  const { app, dir } = setup(t);
  const auth = new OwnerAuth(dir, () => NOW);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const H = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' };
  const api = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: H, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const g = await (await api('/api/sandbox')).json();
  assert.equal(g.mode, 'risky');
  assert.equal(g.network, false);
  assert.deepEqual(g.choices.mode, ['off', 'risky', 'every']);
  assert.equal(g.isolation.isolated, false);
  assert.equal(g.isolation.driver, 'copy');
  const p = await (await api('/api/sandbox', 'PUT', { mode: 'every', network: true, maxMB: 2000, timeLimitS: 300 })).json();
  assert.equal(p.mode, 'every');
  assert.equal(app.settings.get().sandboxGate?.maxMB, 2000);
  const bad = await (await api('/api/sandbox', 'PUT', { mode: 'sometimes' })).json();
  assert.equal(bad.mode, 'every', 'an unknown mode keeps the saved one');
  assert.equal((await api('/api/sandbox', 'DELETE')).status, 405);
  // The approval route takes the card's answers.
  for (const how of ['apply', 'discard', 'real']) {
    const { id, decision } = app.approvals.request('c', new AbortController().signal);
    assert.equal((await api(`/api/approvals/${id}`, 'POST', { approved: how !== 'discard', how })).status, 200);
    assert.equal(await decision, how !== 'discard');
    assert.equal(app.approvals.takeHow(id), how);
  }
  // Discard never runs, whatever `approved` says; Apply / Run for real are a yes.
  const x = app.approvals.request('c', new AbortController().signal);
  app.approvals.decide(x.id, true, 'discard');
  assert.equal(await x.decision, false);
});

test('UI: tips (≤ 260 characters, guide anchor), translations, icon, help, service worker cache', () => {
  const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
  const tips = JSON.parse(web('tips.json')).tips as Record<string, [string, string]>;
  const help = web('help.html');
  for (const id of ['sbx-mode', 'sbx-network', 'sbx-size', 'sbx-time', 'sbx-recheck']) {
    assert.ok(tips[id], id);
    assert.ok(tips[id][0].length <= 260, `${id} tip too long`);
    assert.ok(help.includes(`id="${tips[id][1]}"`), `guide section ${tips[id][1]}`);
    assert.ok(web('index.html').includes(`id="${id}"`), id);
  }
  assert.match(help, /href="#sandbox"/);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const d = JSON.parse(web(`i18n/${lang}.json`)) as Record<string, string>;
    for (const k of ['Ran in a sandbox', 'Apply to my workspace', 'Run for real', 'Try commands in a sandbox first', 'Not isolated']) {
      assert.ok(d[k], `${lang}: ${k}`);
      assert.notEqual(d[k], k, `${lang}: ${k} is translated`);
    }
  }
  assert.match(web('icons.js'), /\n {2}sandbox: '/);
  assert.match(web('sw.js'), /caches\.open\('sara-shell-v13'\)/);
  assert.match(web('sw.js'), /sara-shell-v12 from Phase 79/);
  const view = web('sandbox-view.js');
  assert.doesNotMatch(view, /style=|\.style\./, 'no inline styles (theme tokens in CSS)');
  assert.match(web('ui-tidy.css'), /\.sbx \{[^}]*var\(--surface-2\)/);
  assert.doesNotMatch(web('ui-tidy.css').slice(web('ui-tidy.css').indexOf('Phase 80')), /#[0-9a-f]{3,6}\b/i, 'theme tokens only');
});

// ------------------------------------------------------------------------------------------------
// Performance
// ------------------------------------------------------------------------------------------------

test('performance: a 2,000-file repository is copied, run and compared in seconds (reported)', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const ws = join(dir, 'workspaces', 'big');
  for (let d = 0; d < 40; d++) {
    mkdirSync(join(ws, 'src', `m${d}`), { recursive: true });
    for (let i = 0; i < 50; i++) writeFileSync(join(ws, 'src', `m${d}`, `f${i}.js`), `export const v${i} = ${i};\n`.repeat(15));
  }
  const report: string[] = [];
  const timeOne = async (label: string, preferWorktree: boolean) => {
    const t0 = Date.now();
    const r = await runInSandbox(ws, 'echo x > out.txt', { ...opts(dir), preferWorktree });
    const total = Date.now() - t0;
    report.push(`${label}: ${r.copy?.files} files copied in ${r.copy?.ms} ms (${r.copy?.strategy}); whole try ${total} ms (run ${r.run?.ms} ms)`);
    assert.equal(r.copy?.files, preferWorktree && HAS_GIT ? 2000 : 2000);
    assert.deepEqual(r.changes.added.map((c) => c.path), ['out.txt']);
    return { copyMs: r.copy!.ms, total };
  };
  const plain = await timeOne('filtered copy', false);
  if (HAS_GIT) {
    const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...a], { cwd: ws });
    g('init', '-q');
    g('add', '.');
    g('commit', '-qm', 'init');
    await timeOne('git worktree', true);
  }
  for (const line of report) t.diagnostic(line);
  console.log(`[phase80 perf] ${report.join(' | ')}`);
  assert.ok(plain.copyMs < 20_000, `copying 2,000 files took ${plain.copyMs} ms`);
  assert.ok(plain.total < 60_000);
});

test('Windows: a faked process list never stops a process that was already running', { skip: process.platform !== 'win32' }, async () => {
  const { bornSince } = await import('../src/sandbox-run.ts');
  // This test's own runner and its parent were running long before "now".
  assert.deepEqual(await bornSince([process.pid, process.ppid], Date.now()), []);
  const { spawn } = await import('node:child_process');
  const before = Date.now();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(await bornSince([child.pid!], before), [child.pid]);
    assert.deepEqual(await bornSince([child.pid!], Date.now() + 60_000), [], 'started before the try: never');
  } finally {
    child.kill();
  }
});
