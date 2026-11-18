// rootapply (docs/SELF_CODE.md "On a Linux server"): the root helper that applies the owner's approved
// level-3 code changes on regular Linux server installs. Everything runs against a fake root in temp
// folders (fake /opt/<name>, data folder, source checkout, systemctl and health check): no real
// server, service or system folder is touched. The bash parts are skipped when no bash is found.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { check, readRequest, rules } from '../src/self-code-root.ts';
import { installInfo, makePatch, SelfCode, type CheckReport, type ModelFn } from '../src/self-code.ts';
import { ROOT, tempDir } from './helpers.ts';

const BASH = (process.platform === 'win32' ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'] : ['/bin/bash', '/usr/bin/bash']).find((p) => existsSync(p));
const skip = BASH ? false : 'bash not found';
const fwd = (p: string) => p.replace(/\\/g, '/');
/** A fake owner approval id, made at run time (never a realistic-looking secret in the source). */
const approval = () => `ok-${randomBytes(12).toString('hex')}`;
const made: (() => void)[] = [];
test.after(() => made.forEach((f) => f()));
function tmp(): string {
  const t = tempDir();
  made.push(t.cleanup);
  return t.dir;
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const GREET = ['// greeting', 'export function greet(name: string): string {', "  return 'Helo ' + name;", '}', ''].join('\n');
const TEST = ["import assert from 'node:assert/strict';", "import test from 'node:test';", "import { greet } from '../src/greet.ts';", "test('greets', () => {", "  assert.ok(greet('Al'));", "  assert.equal(typeof greet('Al'), 'string');", '});', ''].join('\n');

/** A fake server: /opt/<name> (installed copy), the root-owned checkout, her data folder, the updater folder. */
function world(dir: string, name = 'sara') {
  const app = join(dir, 'opt', name);
  const src = join(dir, 'opt', 'sara-src');
  const data = join(dir, 'var', 'lib', name);
  const status = join(dir, 'var', 'lib', `${name}-updater`);
  const etc = join(dir, 'etc', name);
  for (const d of [join(app, 'src'), join(src, 'src'), join(src, 'test'), join(data, 'self-code', 'patches'), etc]) mkdirSync(d, { recursive: true });
  for (const root of [app, src]) {
    writeFileSync(join(root, 'package.json'), '{ "version": "3.0.0" }\n');
    writeFileSync(join(root, 'src', 'greet.ts'), GREET);
    writeFileSync(join(root, 'src', 'safety.ts'), 'export const SAFE = true;\n');
  }
  writeFileSync(join(src, 'test', 'greet.test.ts'), TEST);
  // The checkout's own copy of the helper and its rules (root runs these, never the installed copy).
  for (const f of ['self-code-root.ts', 'self-code-rules.ts']) copyFileSync(join(ROOT, 'src', f), join(src, 'src', f));
  writeFileSync(join(etc, 'source-dir'), `${fwd(src)}\n`);
  return { dir, name, app, src, data, status, etc };
}
type World = ReturnType<typeof world>;

const fix = (from = 'Helo', to = 'Hello') => makePatch([{ path: 'src/greet.ts', before: GREET, after: GREET.replace(from, to) }]);

/** Sara's side of a request: the patch in her patch queue and root-request.json (what SelfCode writes). */
function ask(w: World, id: number, patch: string, o: { kind?: 'apply' | 'undo'; instance?: string; approval?: string; sha?: string } = {}): void {
  writeFileSync(join(w.data, 'self-code', 'patches', `${id}.patch`), patch);
  writeFileSync(join(w.data, 'self-code', 'root-request.json'), JSON.stringify({ v: 1, instance: o.instance ?? w.name, id, kind: o.kind ?? 'apply', approval: o.approval ?? approval(), sha256: o.sha ?? sha(patch) }));
}

/** Runs deploy/lib-selfcode.sh as the `sara` command would, with a fake systemctl and health check. */
function helper(w: World, cmd: string, o: { unhealthyIf?: string } = {}): { code: number; out: string; restarts: number } {
  const restarts = join(w.dir, 'restarts.log');
  const script = `
set -euo pipefail
NAME=${w.name}; SVC=${w.name}; APP_DIR='${fwd(w.app)}'; DATA_DIR='${fwd(w.data)}'; STATUS_DIR='${fwd(w.status)}'
SRC_FILE='${fwd(join(w.etc, 'source-dir'))}'; SC_OFF='${fwd(join(w.etc, 'selfcode-off'))}'; NODE_BIN='${fwd(process.execPath)}'
log() { printf '[%s] %s\\n' "$NAME" "$*"; }; warn() { log "$@" >&2; }; die() { log "$@" >&2; exit 1; }
app_version() { sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "$APP_DIR/package.json"; }
healthy() { ${o.unhealthyIf ? `! grep -q '${o.unhealthyIf}' "$APP_DIR/src/greet.ts"` : 'true'}; }
. deploy/lib-selfcode.sh
sc_read_user() { head -c "$2" -- "$1"; }
sc_user_rm() { rm -f -- "$1"; }
sc_restart() { echo restart >> '${fwd(restarts)}'; }
sc_root_owned() { true; }
sc_mkdir() { shift; mkdir -p "$@"; }
if command -v cygpath >/dev/null; then sc_p() { cygpath -m "$1"; }; fi
${cmd}
`;
  const r = spawnSync(BASH!, ['-c', script], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  const n = existsSync(restarts) ? readFileSync(restarts, 'utf8').split('\n').filter(Boolean).length : 0;
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`, restarts: n };
}
const result = (w: World, id: number) => JSON.parse(readFileSync(join(w.status, 'selfcode', 'results', `${id}.json`), 'utf8')) as { state: string; kind: string; message: string; approval: string };
const greet = (w: World) => readFileSync(join(w.app, 'src', 'greet.ts'), 'utf8');

// ---- The rules root checks itself ----------------------------------------------------------------

test('rootapply: the helper accepts only a well-formed request for this instance with an owner approval', () => {
  const ok = { v: 1, instance: 'sara', id: 7, kind: 'apply', approval: approval(), sha256: 'a'.repeat(64) };
  assert.equal(typeof readRequest(JSON.stringify(ok), 'sara'), 'object');
  assert.match(readRequest(JSON.stringify({ ...ok, approval: undefined }), 'sara') as string, /no owner approval/);
  assert.match(readRequest(JSON.stringify({ ...ok, approval: 'short' }), 'sara') as string, /no owner approval/);
  assert.match(readRequest(JSON.stringify({ ...ok, instance: 'shelton' }), 'sara') as string, /another Sara/);
  assert.match(readRequest(JSON.stringify({ ...ok, kind: 'shell' }), 'sara') as string, /does not do/);
  assert.match(readRequest(JSON.stringify({ ...ok, id: '7; rm -rf /' }), 'sara') as string, /change number/);
  assert.match(readRequest(JSON.stringify({ ...ok, sha256: undefined }), 'sara') as string, /which patch/);
  assert.match(readRequest('not json', 'sara') as string, /not valid JSON/);
});

test('rootapply: protected paths, test weakening, path traversal and a swapped patch are refused by root', () => {
  const w = world(tmp());
  const req = (patch: string, o: Record<string, unknown> = {}) => JSON.stringify({ v: 1, instance: 'sara', id: 3, kind: 'apply', approval: approval(), sha256: sha(patch), ...o });
  const good = fix();
  const r = check({ instance: 'sara', request: req(good), patch: good, app: w.app, src: w.src });
  assert.equal(r.ok, true);
  assert.deepEqual((r as unknown as { files: string[] }).files, ['src/greet.ts']);
  // Protected: the safety layer, the helper itself, install scripts, dependencies.
  for (const [path, what] of [['src/safety.ts', /safety layer/], ['src/self-code-root.ts', /permissions and this repair code/], ['src/self-code-rules.ts', /permissions/], ['deploy/lib-selfcode.sh', /install scripts/], ['package.json', /dependencies/]] as const) {
    const p = makePatch([{ path, before: null, after: 'x\n' }]);
    const out = check({ instance: 'sara', request: req(p), patch: p, app: w.app, src: w.src });
    assert.equal(out.ok, false, path);
    assert.match((out as { reason: string }).reason, what);
  }
  // Test weakening, judged on the checkout's own test file.
  const weak = makePatch([{ path: 'src/greet.ts', before: GREET, after: GREET.replace('Helo', 'Hello') }, { path: 'test/greet.test.ts', before: TEST, after: TEST.replace("  assert.equal(typeof greet('Al'), 'string');\n", '') }]);
  assert.match((check({ instance: 'sara', request: req(weak), patch: weak, app: w.app, src: w.src }) as { reason: string }).reason, /weakens her tests/);
  // Path traversal and absolute paths in the patch itself.
  for (const evil of ['--- a/../etc/passwd\n+++ b/../etc/passwd\n@@ -1,1 +1,1 @@\n-a\n+b\n', '--- /dev/null\n+++ b/src/../../x.ts\n@@ -0,0 +1,1 @@\n+x\n', '--- /dev/null\n+++ b//etc/cron.d/x\n@@ -0,0 +1,1 @@\n+x\n']) {
    const out = check({ instance: 'sara', request: req(evil), patch: evil, app: w.app, src: w.src });
    assert.equal(out.ok, false);
    assert.match((out as { reason: string }).reason, /not valid|outside/);
  }
  // The patch on disk is not the approved one.
  assert.match((check({ instance: 'sara', request: req(good), patch: fix('Helo', 'Howdy'), app: w.app, src: w.src }) as { reason: string }).reason, /not the one the owner approved/);
  // Another instance's request.
  assert.match((check({ instance: 'sara', request: req(good, { instance: 'shelton' }), patch: good, app: w.app, src: w.src }) as { reason: string }).reason, /another Sara/);
  // Only tests (nothing installed here) and a patch that doesn't fit.
  const onlyTest = makePatch([{ path: 'test/new.test.ts', before: null, after: TEST }]);
  assert.match((check({ instance: 'sara', request: req(onlyTest), patch: onlyTest, app: w.app, src: w.src }) as { reason: string }).reason, /nothing that is installed/);
  assert.match(rules(fix('nope', 'x').replace('Helo', 'Nope'), w.app, w.src) as string, /no longer fits|empty/);
});

// ---- The whole flow against a fake root ------------------------------------------------------------

test('rootapply: an approved change is applied to /opt/<name>, she restarts healthy, the result says Applied', { skip }, () => {
  const w = world(tmp());
  const ap = approval();
  ask(w, 5, fix(), { approval: ap });
  const r = helper(w, 'sc_marker; sc_web_request');
  assert.equal(r.code, 0, r.out);
  assert.match(greet(w), /Hello/);
  assert.equal(r.restarts, 1);
  const res = result(w, 5);
  assert.deepEqual([res.state, res.kind, res.approval], ['applied', 'apply', ap]);
  assert.ok(existsSync(join(w.status, 'selfcode', 'queue', '5.patch')), 'root keeps its own copy of the patch');
  assert.ok(!existsSync(join(w.data, 'self-code', 'root-request.json')), 'the request is used once');
  const mark = JSON.parse(readFileSync(join(w.status, 'selfcode.json'), 'utf8')) as { helper: number; on: boolean; src: string };
  assert.deepEqual([mark.helper, mark.on, mark.src], [1, true, fwd(w.src)]);
  // The checkout (shared by other instances) is never changed.
  assert.match(readFileSync(join(w.src, 'src', 'greet.ts'), 'utf8'), /Helo /);
});

test('rootapply: when she does not come back healthy the old code goes back (Rolled back)', { skip }, () => {
  const w = world(tmp());
  ask(w, 6, fix('Helo', 'BROKEN'));
  const r = helper(w, 'sc_web_request', { unhealthyIf: 'BROKEN' });
  assert.notEqual(r.code, 0);
  assert.equal(greet(w), GREET, 'the snapshot is back');
  assert.equal(r.restarts, 2);
  assert.equal(result(w, 6).state, 'rolledback');
  assert.ok(!existsSync(join(w.status, 'selfcode', 'queue', '6.patch')));
});

test('rootapply: refused requests change nothing (protected path, other instance, off switch, missing patch)', { skip }, () => {
  const w = world(tmp());
  const prot = makePatch([{ path: 'src/safety.ts', before: 'export const SAFE = true;\n', after: 'export const SAFE = false;\n' }]);
  ask(w, 7, prot);
  helper(w, 'sc_web_request || true');
  assert.equal(result(w, 7).state, 'refused');
  assert.match(result(w, 7).message, /safety layer/);
  ask(w, 8, fix(), { instance: 'shelton' });
  helper(w, 'sc_web_request || true');
  assert.match(result(w, 8).message, /another Sara/);
  ask(w, 9, fix(), { approval: '' });
  helper(w, 'sc_web_request || true');
  assert.match(result(w, 9).message, /no owner approval/);
  ask(w, 10, fix());
  writeFileSync(join(w.data, 'self-code', 'patches', '10.patch'), fix('Helo', 'Hi'));
  helper(w, 'sc_web_request || true');
  assert.match(result(w, 10).message, /not the one the owner approved/);
  // The admin's off switch: refused before anything is read.
  const off = helper(w, 'sc_cmd off');
  assert.equal(off.code, 0, off.out);
  assert.equal((JSON.parse(readFileSync(join(w.status, 'selfcode.json'), 'utf8')) as { on: boolean }).on, false);
  ask(w, 11, fix());
  helper(w, 'sc_web_request || true');
  assert.match(result(w, 11).message, /turned code changes off/);
  assert.equal(greet(w), GREET);
  const r = helper(w, 'sc_cmd on && sc_web_request');
  assert.equal(r.code, 1, 'the request was used up while off');
  assert.equal(greet(w), GREET);
  assert.equal(r.restarts, 0);
});

test('rootapply: undo from Settings and `selfcode revert` take a change out the same way; `list` shows the queue', { skip }, () => {
  const w = world(tmp());
  ask(w, 12, fix());
  helper(w, 'sc_web_request');
  assert.match(helper(w, 'sc_cmd list').out, /#12\s+applied\s+src\/greet\.ts/);
  writeFileSync(join(w.data, 'self-code', 'root-request.json'), JSON.stringify({ v: 1, instance: 'sara', id: 12, kind: 'undo', approval: approval() }));
  const r = helper(w, 'sc_web_request');
  assert.equal(r.code, 0, r.out);
  assert.equal(greet(w), GREET);
  assert.deepEqual([result(w, 12).kind, result(w, 12).state], ['undo', 'undone']);
  ask(w, 13, fix());
  helper(w, 'sc_web_request');
  assert.equal(helper(w, 'sc_cmd revert 13').code, 0);
  assert.equal(greet(w), GREET);
  assert.notEqual(helper(w, 'sc_cmd revert "13; id"').code, 0, 'only a number');
});

test('rootapply: `sara update` puts the queued changes back into the fresh copy and parks one that no longer fits', { skip }, () => {
  const w = world(tmp());
  ask(w, 20, fix());
  helper(w, 'sc_web_request');
  const other = makePatch([{ path: 'src/extra.ts', before: null, after: 'export const X = 1;\n' }]);
  ask(w, 21, other);
  helper(w, 'sc_web_request');
  // The update reinstalls a fresh copy (install.sh): her changes are gone, and the new release
  // rewrote the greeting so change #20 no longer fits.
  writeFileSync(join(w.app, 'src', 'greet.ts'), GREET.replace("  return 'Helo ' + name;", "  return `Hi ${name}`;"));
  rmSync(join(w.app, 'src', 'extra.ts'), { force: true });
  const before = helper(w, 'true').restarts;
  const r = helper(w, 'sc_reapply || true');
  assert.equal(result(w, 20).state, 'parked');
  assert.equal(result(w, 21).state, 'applied');
  assert.equal(result(w, 21).kind, 'reapply');
  assert.ok(existsSync(join(w.app, 'src', 'extra.ts')));
  assert.ok(existsSync(join(w.status, 'selfcode', 'parked', '20.patch')));
  assert.equal(r.restarts - before, 1, 'one restart for all of them');
  // A queued change she can't start with after an update: taken out and parked, she restarts without it.
  const w2 = world(tmp());
  ask(w2, 30, fix('Helo', 'BROKEN'));
  helper(w2, 'sc_web_request');
  assert.equal(result(w2, 30).state, 'applied');
  writeFileSync(join(w2.app, 'src', 'greet.ts'), GREET);
  helper(w2, 'sc_reapply || true', { unhealthyIf: 'BROKEN' });
  assert.equal(result(w2, 30).state, 'parked');
  assert.equal(greet(w2), GREET);
});

test('rootapply: the sara command and the installer wire the helper in, and the service stays read-only', () => {
  const cli = readFileSync(join(ROOT, 'deploy', 'sara'), 'utf8');
  const inst = readFileSync(join(ROOT, 'deploy', 'install.sh'), 'utf8');
  const unit = readFileSync(join(ROOT, 'deploy', 'sara.service'), 'utf8');
  assert.match(cli, /selfcode\) if load_selfcode; then sc_web_request/, 'the updater path unit hands "selfcode" requests to the helper');
  assert.match(cli, /run_install "\$SRC_DIR" && healthy; then\n\s+selfcode_reapply/, '`sara update` re-applies the queue after the fresh install');
  assert.match(cli, /selfcode\)\n\s+need_root selfcode/, '`sara selfcode` is root only');
  assert.match(cli, /for f in "\$APP_DIR\/lib-selfcode\.sh"/, 'the helper is loaded from root-owned places only');
  assert.match(inst, /install -m 644 "\$SRC_DIR\/deploy\/lib-selfcode\.sh" "\$APP_DIR\/lib-selfcode\.sh"/);
  assert.match(inst, /sc_marker/);
  // The service itself never gets write access to its code (the helper does the writing as root).
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/sara$/m);
  assert.doesNotMatch(unit, /ReadWritePaths=.*\/opt/);
});

// ---- Sara's side: level 3 on such installs, still owner-approved ----------------------------------

test('rootapply: installInfo turns level 3 on for a server install with the helper on, and says why when off', () => {
  const marker = (on: boolean) => () => ({ on, src: '/opt/sara-src' });
  const s = installInfo({ root: '/opt/sara', platform: 'linux', exists: (p) => p === '/usr/local/bin/sara', writable: () => false, helper: marker(true) });
  assert.deepEqual([s.kind, s.level3, s.mode, s.from], ['server', true, 'root-helper', '/opt/sara-src']);
  const off = installInfo({ root: '/opt/sara', platform: 'linux', exists: (p) => p === '/usr/local/bin/sara', writable: () => false, helper: marker(false) });
  assert.deepEqual([off.kind, off.level3], ['server', false]);
  assert.match(off.why!, /are off on this server.*switch above/);
  const none = installInfo({ root: '/opt/sara', platform: 'linux', exists: (p) => p === '/usr/local/bin/sara', writable: () => false, helper: () => undefined });
  assert.equal(none.level3, false);
});

test('rootapply: on a helper install Approve writes a request for root (no live change by her), and the result shows Applied', async () => {
  const dir = tmp();
  const w = world(dir);
  const db = new DatabaseSync(':memory:');
  const pass: CheckReport = { ok: true, steps: [{ name: 'related', ok: true, detail: 'passed', ms: 1 }] };
  const model: ModelFn = async () => ({ text: JSON.stringify({ summary: 'Fix the greeting', edits: [{ path: 'src/greet.ts', find: 'Helo', replace: 'Hello' }] }), usd: 0.01 });
  const rows: string[] = [];
  const sc = new SelfCode({
    root: w.app,
    dataDir: w.data,
    db,
    model,
    checks: async (wd) => (assert.ok(existsSync(join(wd, 'test', 'greet.test.ts')), 'the tests run in a copy of the checkout (it has the tests)'), pass),
    info: () => ({ kind: 'server', level3: true, root: w.app, git: false, mode: 'root-helper', from: w.src }),
    helperDir: w.status,
    instance: 'sara',
    audit: (r) => rows.push(`${r.action}:${r.outcome}`),
  });
  const c = await sc.propose('the greeting says Helo');
  assert.equal(c.status, 'proposed');
  const applied = await sc.apply(c.id);
  assert.equal(applied.status, 'applying');
  assert.equal(greet(w), GREET, 'she never changes /opt/<name> herself');
  assert.equal(readFileSync(join(w.data, 'update-request'), 'utf8').trim(), 'selfcode');
  const req = JSON.parse(readFileSync(join(w.data, 'self-code', 'root-request.json'), 'utf8')) as { instance: string; id: number; kind: string; approval: string; sha256: string };
  assert.deepEqual([req.instance, req.id, req.kind], ['sara', c.id, 'apply']);
  assert.equal(req.sha256, sha(readFileSync(join(w.data, 'self-code', 'patches', `${c.id}.patch`), 'utf8')));
  assert.match(req.approval, /^[A-Za-z0-9_-]{16,80}$/);
  // Only one request at a time (an update or another change is waiting).
  await assert.rejects(() => sc.undo(c.id), /not applied|Only an applied/);
  // Root's answer.
  mkdirSync(join(w.status, 'selfcode', 'results'), { recursive: true });
  writeFileSync(join(w.status, 'selfcode', 'results', `${c.id}.json`), JSON.stringify({ id: c.id, kind: 'apply', state: 'applied', message: 'Applied and she came back healthy.', approval: req.approval, at: new Date(Date.now() + 1000).toISOString() }));
  sc.finish();
  assert.equal(sc.get(c.id)!.status, 'applied');
  // Rolled back by root: the card says so.
  rmSync(join(w.data, 'update-request'), { force: true });
  const c2 = await sc.propose('again');
  await sc.apply(c2.id);
  writeFileSync(join(w.status, 'selfcode', 'results', `${c2.id}.json`), JSON.stringify({ id: c2.id, kind: 'apply', state: 'rolledback', message: "She didn't come back healthy", at: new Date(Date.now() + 1000).toISOString() }));
  sc.finish();
  assert.equal(sc.get(c2.id)!.status, 'rolledback');
  assert.ok(rows.includes('self-code.apply:pending'));
  // After an update, root re-applies: her own in-app re-apply defers to it.
  const before = readFileSync(join(w.app, 'src', 'greet.ts'), 'utf8');
  db.prepare("UPDATE self_code_changes SET status = 'applied' WHERE id = ?").run(c2.id);
  await sc.afterBoot();
  assert.equal(existsSync(join(w.data, 'self-code', 'work', 'reapply')), false, 'no in-app re-apply on a helper install');
  assert.equal(greet(w), before);
  // `sudo sara update` parked a change: the card says so (and an old result never counts twice).
  writeFileSync(join(w.status, 'selfcode', 'results', `${c.id}.json`), JSON.stringify({ id: c.id, kind: 'reapply', state: 'parked', message: 'Parked after the update to 3.1.0: it no longer fits src/greet.ts.', at: new Date(Date.now() + 60_000).toISOString() }));
  sc.finish();
  assert.equal(sc.get(c.id)!.status, 'parked');
  assert.match(sc.get(c.id)!.note!, /no longer fits/);
  // Undo goes to root as well.
  db.prepare("UPDATE self_code_changes SET status = 'applied', updated_at = ? WHERE id = ?").run(new Date(Date.now() + 120_000).toISOString(), c.id);
  rmSync(join(w.data, 'update-request'), { force: true });
  assert.equal((await sc.undo(c.id)).status, 'undoing');
  assert.equal((JSON.parse(readFileSync(join(w.data, 'self-code', 'root-request.json'), 'utf8')) as { kind: string }).kind, 'undo');
  await assert.rejects(() => sc.apply(c2.id), /waiting on this server|not ready/);
  // An update's re-apply answer that replaced the apply's answer before she read it still lands.
  rmSync(join(w.data, 'update-request'), { force: true });
  const c3 = await sc.propose('third');
  await sc.apply(c3.id);
  writeFileSync(join(w.status, 'selfcode', 'results', `${c3.id}.json`), JSON.stringify({ id: c3.id, kind: 'reapply', state: 'applied', message: 'Put back after the update.', at: new Date(Date.now() + 1000).toISOString() }));
  assert.equal(sc.status().changes.find((x) => x.id === c3.id)!.status, 'applied');
  db.close();
});
