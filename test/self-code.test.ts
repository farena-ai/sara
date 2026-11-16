// T3 (docs/SELF_CODE.md): level 3 self-repair. She changes her own code in a separate copy, checks it,
// shows one approval card, applies it with a snapshot, health-checks the restart and goes back by
// herself; local changes are a patch queue re-applied after official updates. Every test here runs on
// a tiny fake source tree in a temp folder: the real repository is never touched.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { AuditTrail, auditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { HubState, scrubText, TicketStore, type HubSpace } from '../src/hub.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import {
  applyPatchTo,
  installInfo,
  isApplied,
  makePatch,
  makeWorkdir,
  newErrors,
  PROTECTED_PATHS,
  protectedReason,
  relatedTests,
  removeWorkdir,
  SelfCode,
  setSelfCode,
  smokeStart,
  testWeakening,
  type CheckReport,
  type ModelFn,
  type RestartPlan,
} from '../src/self-code.ts';
import { runPlan, type RunnerDriver } from '../src/self-code-runner.ts';
import { createSaraServer } from '../src/server.ts';
import { createSelfCodeTools } from '../src/tools/self-code.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const clock = { now: new Date('2026-11-16T12:00:00Z') };

/** A tiny fake source tree (her "source folder") with a package.json, src and a test. */
function fakeTree(dir: string, version = '1.0.0'): string {
  const root = join(dir, 'src-root');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fake-sara', version }) + '\n');
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'export const x = 1;\n');
  writeFileSync(join(root, 'src', 'greet.ts'), ['// greeting', 'export function greet(name: string): string {', "  return 'Helo ' + name;", '}', ''].join('\n'));
  writeFileSync(join(root, 'src', 'safety.ts'), 'export const SAFE = true;\n');
  writeFileSync(join(root, 'test', 'greet.test.ts'), ["import assert from 'node:assert/strict';", "import test from 'node:test';", "import { greet } from '../src/greet.ts';", "test('greets', () => {", "  assert.ok(greet('Al'));", "  assert.equal(typeof greet('Al'), 'string');", '});', ''].join('\n'));
  return root;
}

/** A scripted coding model: replies in order; each call costs `usd`. */
function scripted(replies: unknown[], usd = 0.01): ModelFn & { calls: number } {
  const f = (async () => {
    f.calls++;
    const r = replies[Math.min(f.calls - 1, replies.length - 1)];
    return { text: typeof r === 'string' ? r : JSON.stringify(r), usd };
  }) as unknown as ModelFn & { calls: number };
  f.calls = 0;
  return f;
}

const okChecks = async (): Promise<CheckReport> => ({ ok: true, steps: [{ name: 'typecheck', ok: true, detail: 'no errors', ms: 5 }, { name: 'related', ok: true, detail: '1 test file passed', ms: 9 }, { name: 'smoke', ok: true, detail: '/api/health answered', ms: 20 }] });
const badChecks = async (): Promise<CheckReport> => ({ ok: false, steps: [{ name: 'related', ok: false, detail: 'greet.test.ts failed', ms: 9 }] });

const FIX = { summary: 'The greeting was misspelled; it now says Hello.', edits: [{ path: 'src/greet.ts', find: "'Helo '", replace: "'Hello '" }] };

interface Env {
  dir: string;
  root: string;
  db: DatabaseSync;
  sc: SelfCode;
  plans: RestartPlan[];
  notes: string[];
  driverHealthy: { after: boolean };
}

function env(t: TestContext, o: { model?: ModelFn; checks?: () => Promise<CheckReport>; cap?: number; version?: () => string; hub?: () => HubSpace | undefined; kind?: 'source' | 'container'; runRestart?: boolean } = {}): Env {
  const tmp = tempDir();
  const root = fakeTree(tmp.dir);
  const dataDir = join(tmp.dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'sc.db'));
  const trail = new AuditTrail(dataDir, { now: () => clock.now });
  setAuditTrail(trail);
  const plans: RestartPlan[] = [];
  const notes: string[] = [];
  const driverHealthy = { after: true };
  const sc: SelfCode = new SelfCode({
    root,
    dataDir,
    db,
    now: () => clock.now,
    info: () => (o.kind === 'container' ? { kind: 'container', level3: false, why: 'She runs from a container image here.', root, git: false, mode: 'relaunch' } : { kind: 'source', level3: true, root, git: false, mode: 'relaunch' }),
    version: o.version ?? (() => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version),
    model: o.model ?? scripted([FIX]),
    checks: o.checks ?? okChecks,
    settings: () => ({ capUsd: o.cap ?? 2, minutes: 20, permission: 'auto1', fullUntil: null }),
    notify: (text) => notes.push(text),
    ...(o.hub ? { hub: o.hub } : {}),
    // The restart: the runner's own logic in-process with a fake server (healthy or not after the change).
    restart: async (plan) => {
      plans.push(plan);
      if (o.runRestart === false) return;
      let changed = true;
      const driver: RunnerDriver = {
        waitGone: async () => {},
        start: async () => {},
        stop: async () => {
          changed = false;
        },
        probe: async () => ({ up: changed ? driverHealthy.after : true, ready: true }),
        sleep: async () => {},
      };
      await runPlan(plan, driver);
      changed = true;
    },
  });
  t.after(() => {
    setAuditTrail(undefined);
    db.close();
    setPrivateLocal(false);
    tmp.cleanup();
  });
  return { dir: tmp.dir, root, db, sc, plans, notes, driverHealthy };
}

const greet = (e: Env) => readFileSync(join(e.root, 'src', 'greet.ts'), 'utf8');
const actions = () => (auditTrail()?.list({ limit: 200 }) ?? []).map((r) => `${r.action}:${r.outcome}`);

test('T3: the protected list names every guarded area and refuses those paths (any spelling)', () => {
  const whats = PROTECTED_PATHS.map((p) => p.what).join(' | ');
  for (const w of ['safety layer', 'hard limits', 'kid mode', 'approvals', 'audit trail', 'vault', 'permissions']) assert.match(whats, new RegExp(w), w);
  for (const p of ['src/safety.ts', 'src/audit-trail.ts', 'src/vault.ts', 'src/pending.ts', 'src/family.ts', 'src/household.ts', 'src/tool-policy.ts', 'src/net-guard.ts', 'src/repair.ts', 'src/self-code.ts', 'src/self-code-runner.ts', 'src/routes/self-code.ts', 'src/tools/self-code.ts', 'src/settings.ts', 'src/budget.ts', 'test/self-code.test.ts', 'deploy/sara', 'package.json', '.secrets/x']) {
    assert.ok(protectedReason(p), `${p} must be protected`);
  }
  assert.ok(protectedReason('SRC\\Safety.ts'), 'Windows spelling and case');
  assert.ok(protectedReason('./src/../src/vault.ts'), 'dot segments');
  assert.ok(protectedReason('../outside.ts'), 'outside her folder');
  assert.ok(protectedReason('C:/Windows/x.ts'), 'absolute path');
  assert.equal(protectedReason('src/greet.ts'), undefined);
  assert.equal(protectedReason('web/app.js'), undefined);
});

test('T3: a proposal that touches the safety layer is refused before any check runs', async (t) => {
  let checked = 0;
  const e = env(t, { model: scripted([{ summary: 'Turn off a check', edits: [{ path: 'src/safety.ts', content: 'export const SAFE = false;\n' }] }]), checks: async () => (checked++, okChecks()) });
  const c = await e.sc.propose('make her less careful');
  assert.equal(c.status, 'refused');
  assert.match(c.note ?? '', /safety layer/);
  assert.equal(checked, 0);
  assert.equal(readFileSync(join(e.root, 'src', 'safety.ts'), 'utf8'), 'export const SAFE = true;\n');
  assert.ok(actions().includes('self-code.propose:refused'));
});

test('T3: changes that weaken tests are refused (deleted test file, fewer asserts, skipped tests)', async (t) => {
  const before = readFileSync(join(fakeTree(tempDir().dir), 'test', 'greet.test.ts'), 'utf8');
  assert.match(testWeakening([{ path: 'test/greet.test.ts', before, after: null }]) ?? '', /deletes/);
  assert.match(testWeakening([{ path: 'test/greet.test.ts', before, after: before.replace("  assert.equal(typeof greet('Al'), 'string');\n", '') }]) ?? '', /check/);
  assert.match(testWeakening([{ path: 'test/greet.test.ts', before, after: before.replace("test('greets'", "test.skip('greets'") }]) ?? '', /skip/);
  assert.equal(testWeakening([{ path: 'test/greet.test.ts', before, after: before + "test('more', () => assert.ok(1));\n" }]), undefined);
  assert.equal(testWeakening([{ path: 'src/greet.ts', before: 'a', after: null }]), undefined);
  const e = env(t, { model: scripted([{ summary: 'Drop a failing check', edits: [{ path: 'test/greet.test.ts', find: "  assert.equal(typeof greet('Al'), 'string');\n", replace: '' }] }]) });
  const c = await e.sc.propose('the tests fail');
  assert.equal(c.status, 'refused');
  assert.match(c.note ?? '', /test/);
});

test('T3: the patch format round-trips (new, changed, deleted files; reverse; already applied)', (t) => {
  const tmp = tempDir();
  t.after(tmp.cleanup);
  const root = fakeTree(tmp.dir);
  const before = readFileSync(join(root, 'src', 'greet.ts'), 'utf8');
  const after = before.replace("'Helo '", "'Hello '");
  const patch = makePatch([
    { path: 'src/greet.ts', before, after },
    { path: 'src/new.ts', before: null, after: 'export const n = 1;\n' },
    { path: 'src/safety.ts', before: 'export const SAFE = true;\n', after: null },
  ]);
  assert.match(patch, /^--- a\/src\/greet\.ts$/m);
  assert.match(patch, /^-  return 'Helo ' \+ name;$/m);
  assert.match(patch, /^\+  return 'Hello ' \+ name;$/m);
  assert.equal(isApplied(root, patch), false);
  const r = applyPatchTo(root, patch);
  assert.ok(r.ok, r.conflicts.join(','));
  assert.equal(readFileSync(join(root, 'src', 'greet.ts'), 'utf8'), after);
  assert.equal(readFileSync(join(root, 'src', 'new.ts'), 'utf8'), 'export const n = 1;\n');
  assert.equal(existsSync(join(root, 'src', 'safety.ts')), false);
  assert.equal(isApplied(root, patch), true);
  assert.equal(applyPatchTo(root, patch).ok, false, 'applying twice is a conflict');
  assert.ok(applyPatchTo(root, patch, { reverse: true }).ok);
  assert.equal(readFileSync(join(root, 'src', 'greet.ts'), 'utf8'), before);
  assert.equal(existsSync(join(root, 'src', 'new.ts')), false);
  // A shifted file (lines added above) still takes the hunk.
  writeFileSync(join(root, 'src', 'greet.ts'), `// one\n// two\n${before}`);
  assert.ok(applyPatchTo(root, makePatch([{ path: 'src/greet.ts', before, after }]), { dryRun: true }).ok);
});

test('T3: install kinds: only a writable source folder gets level 3; the others say why', () => {
  const yes = (p: string) => p === '/.dockerenv';
  assert.deepEqual([installInfo({ root: '/app', platform: 'linux', exists: yes, writable: () => true }).kind, installInfo({ root: '/app', platform: 'linux', exists: yes, writable: () => true }).level3], ['container', false]);
  const server = installInfo({ root: '/opt/sara', platform: 'linux', exists: (p) => p === '/usr/local/bin/sara', writable: () => false });
  assert.equal(server.kind, 'server');
  assert.match(server.why ?? '', /read-only/);
  const win = installInfo({ root: 'C:/Users/alex/AppData/Local/Programs/Sara/app', platform: 'win32', env: { SARA_MODE: 'user' }, exists: () => false, writable: () => true });
  assert.equal(win.kind, 'desktop-windows');
  assert.match(win.why ?? '', /reinstall/);
  const mac = installInfo({ root: '/Applications/Sara.app/Contents/Resources/app', platform: 'darwin', env: {}, exists: () => false, writable: () => true });
  assert.equal(mac.kind, 'desktop-mac');
  assert.equal(mac.level3, false);
  assert.equal(installInfo({ root: '/home/linuxbrew/.linuxbrew/Cellar/sara/1/libexec', platform: 'linux', env: {}, exists: () => false, writable: () => true }).kind, 'package');
  const src = installInfo({ root: '/home/alex/sara', platform: 'linux', env: {}, exists: (p) => p.endsWith('.git'), writable: () => true });
  assert.deepEqual([src.kind, src.level3, src.git], ['source', true, true]);
  const ro = installInfo({ root: '/home/alex/sara', platform: 'linux', env: {}, exists: () => false, writable: () => false });
  assert.equal(ro.level3, false);
  assert.match(ro.why ?? '', /writ/);
  assert.equal(installInfo({ root: '/home/alex/sara', platform: 'linux', env: {}, exists: () => false, writable: () => true, execArgv: ['--watch'] }).mode, 'watch');
});

test('T3: the working copy (copy mode) borrows node_modules, and removing it never deletes through the link', (t) => {
  const tmp = tempDir();
  t.after(tmp.cleanup);
  const root = fakeTree(tmp.dir);
  mkdirSync(join(root, 'tools', 'helper', 'node_modules', 'lib'), { recursive: true });
  writeFileSync(join(root, 'tools', 'helper', 'node_modules', 'lib', 'x.js'), '1\n');
  writeFileSync(join(root, 'tools', 'helper', 'index.ts'), 'export {};\n');
  const wd = join(tmp.dir, 'work');
  makeWorkdir(root, wd, { git: false });
  assert.ok(existsSync(join(wd, 'tools', 'helper', 'node_modules', 'lib', 'x.js')), 'tool dependencies reachable');
  assert.equal(readFileSync(join(wd, 'src', 'greet.ts'), 'utf8'), readFileSync(join(root, 'src', 'greet.ts'), 'utf8'));
  assert.ok(existsSync(join(wd, 'node_modules', 'dep', 'index.js')), 'dependencies reachable');
  removeWorkdir(root, wd);
  assert.equal(existsSync(wd), false);
  assert.ok(existsSync(join(root, 'node_modules', 'dep', 'index.js')), 'the real node_modules survives');
  assert.ok(existsSync(join(root, 'tools', 'helper', 'node_modules', 'lib', 'x.js')), 'and the tool ones');
});

test('T3: the typecheck counts only errors the change added (lines may move)', () => {
  const before = ['test/a.test.ts(6,22): error TS2307: Cannot find module x.', 'src/b.ts(3,1): error TS2322: old.'].join('\n');
  const after = ['test/a.test.ts(6,22): error TS2307: Cannot find module x.', 'src/b.ts(9,1): error TS2322: old.', "src/greet.ts(2,3): error TS2304: Cannot find name 'nme'."].join('\n');
  assert.deepEqual(newErrors(after, before), ["src/greet.ts(2,3): error TS2304: Cannot find name 'nme'."]);
  assert.deepEqual(newErrors(before, before), []);
});

test('T3: git worktree mode carries her uncommitted (already applied) changes into the copy', (t) => {
  const tmp = tempDir();
  t.after(tmp.cleanup);
  const root = fakeTree(tmp.dir);
  const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  git('init', '-q');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'add', '.');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  writeFileSync(join(root, 'src', 'greet.ts'), readFileSync(join(root, 'src', 'greet.ts'), 'utf8').replace('// greeting', '// greeting (local change)'));
  const wd = join(tmp.dir, 'wt');
  makeWorkdir(root, wd, { git: true });
  assert.match(readFileSync(join(wd, 'src', 'greet.ts'), 'utf8'), /local change/);
  assert.ok(existsSync(join(wd, 'node_modules', 'dep', 'index.js')));
  removeWorkdir(root, wd);
  assert.equal(existsSync(wd), false);
  assert.ok(existsSync(join(root, 'node_modules', 'dep', 'index.js')));
  assert.doesNotMatch(String(git('worktree', 'list')), /wt/);
});

test('T3: related tests are the ones that import a changed file', (t) => {
  const tmp = tempDir();
  t.after(tmp.cleanup);
  const root = fakeTree(tmp.dir);
  writeFileSync(join(root, 'test', 'other.test.ts'), "import test from 'node:test';\ntest('x', () => {});\n");
  assert.deepEqual(relatedTests(root, ['src/greet.ts']), ['test/greet.test.ts']);
  assert.deepEqual(relatedTests(root, ['test/other.test.ts']), ['test/other.test.ts']);
});

test('T3: the smoke start runs the copy on a free port and waits for /api/health', async (t) => {
  const tmp = tempDir();
  t.after(tmp.cleanup);
  const root = fakeTree(tmp.dir);
  writeFileSync(join(root, 'src', 'main.ts'), "import { createServer } from 'node:http';\ncreateServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end(q.url === '/api/health' ? '{\"ok\":true}' : '{}'); }).listen(Number(process.env.SARA_PORT), '127.0.0.1');\n");
  const good = await smokeStart(root, { timeoutMs: 20_000 });
  assert.equal(good.ok, true, good.detail);
  writeFileSync(join(root, 'src', 'main.ts'), "throw new Error('broken start');\n");
  const bad = await smokeStart(root, { timeoutMs: 8000 });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /broken start|did not answer|exited/);
});

test('T3: propose → one card (summary, diff, checks) → Approve applies with a snapshot, restarts, health ok', async (t) => {
  const e = env(t);
  const c = await e.sc.propose('She says Helo instead of Hello');
  assert.equal(c.status, 'proposed', c.note ?? '');
  assert.equal(c.summary, FIX.summary);
  assert.deepEqual(c.files, ['src/greet.ts']);
  assert.ok(c.checks?.ok);
  const card = e.sc.get(c.id)!;
  assert.match(card.diff ?? '', /\+  return 'Hello ' \+ name;/);
  assert.match(greet(e), /Helo/, 'nothing changes before Approve');
  const done = await e.sc.apply(c.id);
  assert.equal(done.status, 'applying');
  assert.equal(e.plans.length, 1);
  assert.equal(e.plans[0]!.kind, 'apply');
  e.sc.finish();
  const after = e.sc.get(c.id)!;
  assert.equal(after.status, 'applied', after.note ?? '');
  assert.match(greet(e), /'Hello '/);
  const snap = join(e.dir, 'data', 'self-code', 'snapshots', String(c.id));
  assert.match(readFileSync(join(snap, 'files', 'src', 'greet.ts'), 'utf8'), /Helo/, 'the snapshot keeps the old file');
  assert.equal(JSON.parse(readFileSync(join(snap, 'manifest.json'), 'utf8')).version, '1.0.0');
  assert.ok(existsSync(join(e.dir, 'data', 'self-code', 'patches', `${c.id}.patch`)), 'kept in the patch queue');
  const a = actions();
  for (const x of ['self-code.propose:ok', 'self-code.apply:pending', 'self-code.applied:ok']) assert.ok(a.includes(x), `${x} in ${a.join(',')}`);
});

test('T3: Approve applies, the restart is not healthy → the snapshot goes back and she reports it', async (t) => {
  const e = env(t);
  e.driverHealthy.after = false;
  const c = await e.sc.propose('She says Helo instead of Hello');
  await e.sc.apply(c.id);
  e.sc.finish();
  const after = e.sc.get(c.id)!;
  assert.equal(after.status, 'rolledback');
  assert.match(after.note ?? '', /didn't start|went back/);
  assert.match(greet(e), /Helo/, 'the old file is back');
  assert.ok(e.notes.some((n) => /went back/.test(n)), 'the owner is told');
  assert.ok(actions().includes('self-code.applied:failed'));
});

test('T3: Undo puts an applied change back through the same restart and health check', async (t) => {
  const e = env(t);
  const c = await e.sc.propose('She says Helo instead of Hello');
  await e.sc.apply(c.id);
  e.sc.finish();
  await e.sc.undo(c.id);
  e.sc.finish();
  assert.equal(e.sc.get(c.id)!.status, 'undone');
  assert.match(greet(e), /Helo/);
  assert.ok(actions().includes('self-code.undo:pending'));
});

test('T3: after an official update the patch queue is re-applied (checked first, then restarted)', async (t) => {
  let ver = '1.0.0';
  let checks = 0;
  const e = env(t, { version: () => ver, checks: async () => (checks++, okChecks()) });
  const c = await e.sc.propose('She says Helo instead of Hello');
  await e.sc.apply(c.id);
  e.sc.finish();
  await e.sc.afterBoot();
  assert.equal(e.plans.length, 1, 'nothing to do while the change is in place');
  // The update replaces her files with the new release (a new line elsewhere, the old typo back).
  ver = '1.1.0';
  writeFileSync(join(e.root, 'src', 'greet.ts'), ['// greeting', '// new in 1.1', 'export function greet(name: string): string {', "  return 'Helo ' + name;", '}', ''].join('\n'));
  const before = checks;
  await e.sc.afterBoot();
  assert.ok(checks > before, 'tested in a separate copy first');
  assert.equal(e.plans.at(-1)!.kind, 'reapply');
  e.sc.finish();
  assert.equal(e.sc.get(c.id)!.status, 'applied');
  assert.match(greet(e), /new in 1\.1[\s\S]*'Hello '/);
  assert.equal(e.sc.get(c.id)!.baseVersion, '1.1.0');
});

test('T3: a queued patch that no longer applies (or fails the tests) after an update is parked and the owner told', async (t) => {
  let ver = '1.0.0';
  let failing = false;
  const e = env(t, { version: () => ver, checks: async () => (failing ? badChecks() : okChecks()) });
  const c = await e.sc.propose('She says Helo instead of Hello');
  await e.sc.apply(c.id);
  e.sc.finish();
  ver = '1.1.0';
  writeFileSync(join(e.root, 'src', 'greet.ts'), ['export const greet = (n: string) => `Hi ${n}`;', ''].join('\n'));
  await e.sc.afterBoot();
  assert.equal(e.sc.get(c.id)!.status, 'parked');
  assert.match(e.sc.get(c.id)!.note ?? '', /no longer fits/);
  assert.ok(e.notes.some((n) => /parked/i.test(n)));
  assert.ok(actions().includes('self-code.park:refused'));
  // Second case: it applies, but the tests fail on the new version.
  const e2 = env(t, { version: () => ver, checks: async () => (failing ? badChecks() : okChecks()) });
  ver = '1.0.0';
  const c2 = await e2.sc.propose('She says Helo instead of Hello');
  await e2.sc.apply(c2.id);
  e2.sc.finish();
  ver = '1.2.0';
  failing = true;
  writeFileSync(join(e2.root, 'src', 'greet.ts'), readFileSync(join(e2.root, 'src', 'greet.ts'), 'utf8').replace("'Hello '", "'Helo '"));
  await e2.sc.afterBoot();
  assert.equal(e2.sc.get(c2.id)!.status, 'parked');
  assert.match(e2.sc.get(c2.id)!.note ?? '', /tests/);
  assert.match(readFileSync(join(e2.root, 'src', 'greet.ts'), 'utf8'), /Helo/, 'the live files are left as the update made them');
});

test('T3: the per-repair cost cap stops the coding model', async (t) => {
  const model = scripted([{ read: ['src/greet.ts'] }], 0.9);
  const e = env(t, { model, cap: 2 });
  const c = await e.sc.propose('look around forever');
  assert.equal(c.status, 'stopped');
  assert.match(c.note ?? '', /\$2\.00/);
  assert.ok(model.calls <= 3, `calls: ${model.calls}`);
  assert.ok((c.costUsd ?? 0) <= 2, `spent ${c.costUsd}`);
});

test('T3: failing checks go back to the model (twice at most), then the proposal fails without an Approve', async (t) => {
  const model = scripted([FIX, { summary: 'still broken', edits: [{ path: 'src/greet.ts', find: '// greeting', replace: '// greeting!' }] }, { summary: 'x', edits: [{ path: 'src/greet.ts', find: '// greeting!', replace: '// greeting?' }] }]);
  const e = env(t, { model, checks: badChecks });
  const c = await e.sc.propose('fix it');
  assert.equal(c.status, 'failed');
  await assert.rejects(() => e.sc.apply(c.id), /ready|prepared/);
});

test('T3: private local mode uses local models only; elsewhere-than-source says why and offers a report', async (t) => {
  const e = env(t, { kind: 'container' });
  assert.equal(e.sc.status().available, false);
  assert.match(e.sc.status().why ?? '', /container/);
  await assert.rejects(() => e.sc.propose('fix it'), /container/);
  setPrivateLocal(true);
  const e2 = env(t, { model: async () => ({ text: '{}', usd: 0, local: false }) });
  const c = await e2.sc.propose('fix it');
  assert.equal(c.status, 'refused');
  assert.match(c.note ?? '', /local models only/);
});

test('T3: "Send this fix to the Sara developers" is off by default, previews exactly what is sent, and scrubs it', async (t) => {
  const seen: Record<string, unknown>[] = [];
  const hubSrv = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen.push(JSON.parse(b));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ticket: 'SR-12', token: 'a'.repeat(32) }));
    });
  });
  await new Promise<void>((r) => hubSrv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => hubSrv.close(() => r())));
  const base = `http://127.0.0.1:${(hubSrv.address() as AddressInfo).port}/sara/hub`;
  const tmp = tempDir();
  const hdb = new DatabaseSync(join(tmp.dir, 'hub.db'));
  const state = new HubState(tmp.dir);
  state.update({ powBits: 8 });
  t.after(() => {
    hdb.close();
    tmp.cleanup();
  });
  // Private details built at run time (never realistic-looking secrets in the source).
  const key = ['sk', 'test', 'Z'.repeat(8) + '9'.repeat(16)].join('_');
  const mail = ['alex', 'example.org'].join('@');
  const home = join(homedir(), 'private-notes');
  const hub: HubSpace = { state, base, member: false, demo: false, tickets: new TicketStore(hdb), facts: () => ({ version: '1.0.0', channel: 'source', os: 'linux', arch: 'x64', lang: 'en', companions: 1, members: 0, bridges: [], features: [], model: 'cloud' }), blocked: () => undefined, scrub: (s) => scrubText(s, (x) => x, { homes: [homedir()] }) };
  const fix = { summary: `Fixed the greeting (asked by ${mail})`, edits: [{ path: 'src/greet.ts', find: "'Helo '", replace: `'Hello ' /* ${key} ${home} */` }] };
  const e = env(t, { model: scripted([fix]), hub: () => hub });
  const c = await e.sc.propose(`Mail ${mail} says the greeting is wrong; my key is ${key}`);
  assert.equal(c.status, 'proposed', c.note ?? '');
  assert.equal(c.ticket ?? null, null, 'nothing is sent by default');
  assert.equal(seen.length, 0);
  const preview = e.sc.reportPreview(c.id);
  const shown = JSON.stringify(preview);
  for (const secret of [key, mail, home]) assert.ok(!shown.includes(secret), `preview leaks ${secret}`);
  assert.match(shown, /Hello/);
  const r = await e.sc.report(c.id);
  assert.equal(r.ticket, 'SR-12');
  assert.equal(seen.length, 1);
  const sent = { ...seen[0] } as Record<string, unknown>;
  for (const k of ['v', 'id', 'pow']) delete sent[k];
  assert.deepEqual(sent, preview, 'exactly what the preview showed');
  assert.equal(e.sc.get(c.id)!.ticket, 'SR-12');
  assert.ok(actions().includes('self-code.report:ok'));
});

test('T3: household members and kid mode are refused (routes 403, no tool); the owner gets the view', async (t) => {
  for (const who of ['owner', 'member', 'kid'] as const) {
    const tmp = tempDir();
    const app = makeApp(tmp.dir, clock);
    const e = env(t);
    setSelfCode(app, e.sc);
    const auth = new OwnerAuth(tmp.dir, () => clock.now);
    const tok = auth.newToken!;
    const record = () => ({ id: 'mem0000001', name: 'Mo', status: 'active', child: who === 'kid', limits: { voice: false, pictures: false } });
    const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(who !== 'owner' ? { spaceId: 'mem0000001', member: { record: () => record() as never, apps: () => [app], deleteSelf: async () => {} } } : {}) });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const h = { authorization: `Bearer ${tok}`, origin: base, 'content-type': 'application/json' };
    try {
      const g = await fetch(`${base}/api/self-code`, { headers: h });
      const p = await fetch(`${base}/api/self-code`, { method: 'POST', headers: h, body: JSON.stringify({ request: 'fix the greeting' }) });
      if (who === 'owner') {
        assert.equal(g.status, 200);
        const v = (await g.json()) as { available: boolean; cap: number };
        assert.equal(v.available, true);
        assert.equal(v.cap, 2);
        assert.equal(p.status, 202);
      } else {
        assert.equal(g.status, 403, who);
        assert.equal(p.status, 403, who);
        assert.equal(((await g.json()) as { ownerOnly?: boolean }).ownerOnly, true);
      }
    } finally {
      await new Promise<void>((ok) => srv.close(() => ok()));
      await e.sc.idle();
      app.store.close();
      tmp.cleanup();
    }
  }
  // The chat tool: always asks, and is not offered where there is no self-code (members, kids, demo).
  const tools = createSelfCodeTools(() => undefined);
  assert.equal(tools[0]!.spec.name, 'self_code_fix');
  assert.equal(tools[0]!.defaultPermission, 'ask');
  assert.equal(tools[0]!.isAvailable?.(), false);
});
