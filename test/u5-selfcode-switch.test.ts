// U5.30 (docs/SELF_CODE.md "The switch in Settings"): the owner turns server code changes on or off from
// Settings → Privacy & system → Updates → Code changes. Sara only writes a REQUEST (the updater unit's
// request word `selfcode-on` / `selfcode-off` plus switch-request.json); the root helper re-checks it and
// honors it. Turning on needs the owner's re-auth and is refused when the admin ran `sara selfcode lock`;
// turning off always works. Everything runs in temp folders (fake root, fake systemctl): no real server.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { readSwitch } from '../src/self-code-root.ts';
import { readHelper, SelfCode, setSelfCode } from '../src/self-code.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const BASH = (process.platform === 'win32' ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'] : ['/bin/bash', '/usr/bin/bash']).find((p) => existsSync(p));
const skip = BASH ? false : 'bash not found';
const fwd = (p: string) => p.replace(/\\/g, '/');
const approval = () => `ok-${randomBytes(12).toString('hex')}`;
const made: (() => void)[] = [];
test.after(() => made.forEach((f) => f()));
function tmp(): string {
  const t = tempDir();
  made.push(t.cleanup);
  return t.dir;
}

function world(dir: string, name = 'sara') {
  const app = join(dir, 'opt', name);
  const src = join(dir, 'opt', 'sara-src');
  const data = join(dir, 'var', 'lib', name);
  const status = join(dir, 'var', 'lib', `${name}-updater`);
  const etc = join(dir, 'etc', name);
  for (const d of [join(app, 'src'), join(src, 'src'), join(data, 'self-code'), etc]) mkdirSync(d, { recursive: true });
  for (const root of [app, src]) writeFileSync(join(root, 'package.json'), '{ "version": "3.0.0" }\n');
  for (const f of ['self-code-root.ts', 'self-code-rules.ts']) copyFileSync(join(ROOT, 'src', f), join(src, 'src', f));
  writeFileSync(join(etc, 'source-dir'), `${fwd(src)}\n`);
  return { dir, name, app, src, data, status, etc };
}
type World = ReturnType<typeof world>;

/** Sara's side of a switch request (what SelfCode.askSwitch writes). */
function ask(w: World, want: 'on' | 'off', o: { instance?: string; at?: Date; approval?: string } = {}): void {
  writeFileSync(join(w.data, 'self-code', 'switch-request.json'), JSON.stringify({ v: 1, instance: o.instance ?? w.name, want, approval: o.approval ?? approval(), at: (o.at ?? new Date()).toISOString() }));
  writeFileSync(join(w.data, 'update-request'), `selfcode-${want}\n`);
}

/** deploy/lib-selfcode.sh as the `sara` command sources it, with fakes for runuser/systemctl. */
function helper(w: World, cmd: string): { code: number; out: string } {
  const script = `
set -euo pipefail
NAME=${w.name}; SVC=${w.name}; APP_DIR='${fwd(w.app)}'; DATA_DIR='${fwd(w.data)}'; STATUS_DIR='${fwd(w.status)}'
SRC_FILE='${fwd(join(w.etc, 'source-dir'))}'; SC_OFF='${fwd(join(w.etc, 'selfcode-off'))}'; SC_LOCK='${fwd(join(w.etc, 'selfcode-locked'))}'; NODE_BIN='${fwd(process.execPath)}'
log() { printf '[%s] %s\\n' "$NAME" "$*"; }; warn() { log "$@" >&2; }; die() { log "$@" >&2; exit 1; }
app_version() { echo 3.0.0; }
healthy() { true; }
. deploy/lib-selfcode.sh
sc_read_user() { head -c "$2" -- "$1"; }
sc_user_rm() { rm -f -- "$1"; }
sc_restart() { true; }
sc_root_owned() { true; }
sc_mkdir() { shift; mkdir -p "$@"; }
if command -v cygpath >/dev/null; then sc_p() { cygpath -m "$1"; }; fi
${cmd}
`;
  const r = spawnSync(BASH!, ['-c', script], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}
const marker = (w: World) => JSON.parse(readFileSync(join(w.status, 'selfcode.json'), 'utf8')) as { helper: number; on: boolean; locked: boolean; by: string; at: string };
const answer = (w: World) => JSON.parse(readFileSync(join(w.status, 'selfcode', 'switch.json'), 'utf8')) as { want: string; state: string; message: string };

// ---- root's own check of the request --------------------------------------------------------------

test('U5.30: root accepts a switch request only for this instance, the asked word, an approval id and a fresh time', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const req = (o: Record<string, unknown> = {}) => JSON.stringify({ v: 1, instance: 'sara', want: 'on', approval: approval(), at: new Date(now - 60_000).toISOString(), ...o });
  assert.equal(typeof readSwitch(req(), 'sara', 'on', now), 'object');
  assert.match(readSwitch(req({ instance: 'shelton' }), 'sara', 'on', now) as string, /another Sara/);
  assert.match(readSwitch(req({ want: 'off' }), 'sara', 'on', now) as string, /does not match/);
  assert.match(readSwitch(req({ approval: 'x' }), 'sara', 'on', now) as string, /no owner approval/);
  assert.match(readSwitch(req({ at: new Date(now - 20 * 60_000).toISOString() }), 'sara', 'on', now) as string, /too old/);
  assert.match(readSwitch(req({ at: new Date(now + 10 * 60_000).toISOString() }), 'sara', 'on', now) as string, /too old|future/);
  assert.match(readSwitch('nope', 'sara', 'on', now) as string, /not valid JSON/);
  assert.match(readSwitch(req({ want: 'maybe' }), 'sara', 'maybe', now) as string, /does not do/);
});

// ---- the helper honors the request --------------------------------------------------------------

test('U5.30: selfcode-off from Settings turns the helper off (marker says the owner did it); selfcode-on turns it back on', { skip }, () => {
  const w = world(tmp());
  assert.equal(helper(w, 'sc_marker').code, 0);
  assert.equal(marker(w).on, true);
  ask(w, 'off');
  const off = helper(w, 'sc_switch_request off');
  assert.equal(off.code, 0, off.out);
  assert.equal(existsSync(join(w.etc, 'selfcode-off')), true);
  assert.deepEqual([marker(w).on, marker(w).locked, marker(w).by], [false, false, 'owner']);
  assert.equal(answer(w).state, 'done');
  assert.equal(existsSync(join(w.data, 'self-code', 'switch-request.json')), false, 'the request is used once');
  ask(w, 'on');
  const on = helper(w, 'sc_switch_request on');
  assert.equal(on.code, 0, on.out);
  assert.equal(existsSync(join(w.etc, 'selfcode-off')), false);
  assert.deepEqual([marker(w).on, marker(w).by], [true, 'owner']);
  assert.deepEqual([answer(w).want, answer(w).state], ['on', 'done']);
});

test('U5.30: when the admin locked it, ON from the page is refused and OFF still works; root re-checks the request', { skip }, () => {
  const w = world(tmp());
  helper(w, 'sc_cmd off');
  assert.equal(helper(w, 'sc_cmd lock').code, 0);
  assert.deepEqual([marker(w).on, marker(w).locked, marker(w).by], [false, true, 'admin']);
  ask(w, 'on');
  const r = helper(w, 'sc_switch_request on');
  assert.notEqual(r.code, 0);
  assert.equal(existsSync(join(w.etc, 'selfcode-off')), true, 'still off');
  assert.deepEqual([answer(w).state, marker(w).on], ['refused', false]);
  assert.match(answer(w).message, /administrator locked/);
  // Unlocked, but a request for another instance or a stale one is refused by root itself.
  helper(w, 'sc_cmd unlock');
  assert.equal(marker(w).locked, false);
  ask(w, 'on', { instance: 'other' });
  assert.notEqual(helper(w, 'sc_switch_request on').code, 0);
  assert.match(answer(w).message, /another Sara/);
  ask(w, 'on', { at: new Date(Date.now() - 3600_000) });
  assert.notEqual(helper(w, 'sc_switch_request on').code, 0);
  assert.match(answer(w).message, /too old/);
  // The word and the file must agree.
  ask(w, 'off');
  assert.notEqual(helper(w, 'sc_switch_request on').code, 0);
  assert.equal(existsSync(join(w.etc, 'selfcode-off')), true);
  // Locked and on: OFF from the page is always allowed (and needs no checkout or valid request).
  helper(w, 'sc_cmd on');
  helper(w, 'sc_cmd lock');
  rmSync(join(w.data, 'self-code', 'switch-request.json'), { force: true });
  assert.equal(helper(w, 'sc_switch_request off').code, 0);
  assert.deepEqual([marker(w).on, marker(w).locked, answer(w).state], [false, true, 'done']);
  // `sara selfcode list` says who can change it.
  assert.match(helper(w, 'sc_cmd list').out, /locked/);
});

test('U5.30: the updater unit passes the two new words to the helper (deploy/sara web-request)', () => {
  const sara = readFileSync(join(ROOT, 'deploy', 'sara'), 'utf8');
  assert.match(sara, /tr -cd 'a-z-'/);
  assert.match(sara, /selfcode-on\) .*sc_switch_request on/);
  assert.match(sara, /selfcode-off\) .*sc_switch_request off/);
  assert.match(sara, /sara selfcode lock \| unlock/);
  assert.match(readFileSync(join(ROOT, 'deploy', 'lib-selfcode.sh'), 'utf8'), /selfcode list \| revert <id> \| off \| on \| lock \| unlock/);
});

// ---- Sara's side --------------------------------------------------------------------------------

function selfCode(w: World, db: DatabaseSync, rows: string[] = []) {
  return new SelfCode({ root: w.app, dataDir: w.data, db, info: () => ({ kind: 'server', level3: true, root: w.app, git: false, mode: 'root-helper', from: w.src }), helperDir: w.status, instance: 'sara', audit: (r) => rows.push(`${r.action}:${r.outcome}`) });
}
const writeMarker = (w: World, m: Record<string, unknown>) => {
  mkdirSync(w.status, { recursive: true });
  writeFileSync(join(w.status, 'selfcode.json'), JSON.stringify({ helper: 1, src: w.src, ...m }));
};

test('U5.30: SelfCode shows the switch state and writes a request (never the switch itself)', () => {
  const w = world(tmp());
  const db = new DatabaseSync(':memory:');
  const rows: string[] = [];
  const sc = selfCode(w, db, rows);
  assert.equal(sc.helper(), undefined, 'no marker: no switch');
  writeMarker(w, { on: true, locked: false, by: 'admin', at: '2026-11-18T10:00:00.000Z' });
  assert.deepEqual(readHelper(w.status), { on: true, src: w.src, locked: false, by: 'admin', at: '2026-11-18T10:00:00.000Z' });
  assert.deepEqual(sc.status().helper, { on: true, locked: false, by: 'admin', at: '2026-11-18T10:00:00.000Z', pending: null, last: null });
  const v = sc.askSwitch(false);
  assert.equal(v.pending, 'off');
  assert.equal(readFileSync(join(w.data, 'update-request'), 'utf8').trim(), 'selfcode-off');
  const rq = JSON.parse(readFileSync(join(w.data, 'self-code', 'switch-request.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual([rq.v, rq.instance, rq.want], [1, 'sara', 'off']);
  assert.match(String(rq.approval), /^[A-Za-z0-9_-]{16,80}$/);
  assert.equal(readHelper(w.status)!.on, true, 'she never flips it herself');
  assert.throws(() => sc.askSwitch(true), /waiting/);
  assert.ok(rows.includes('self-code.switch:pending'));
  // Root answered.
  rmSync(join(w.data, 'update-request'));
  rmSync(join(w.data, 'self-code', 'switch-request.json'));
  writeMarker(w, { on: false, locked: true, by: 'admin', at: '2026-11-18T11:00:00.000Z' });
  mkdirSync(join(w.status, 'selfcode'), { recursive: true });
  writeFileSync(join(w.status, 'selfcode', 'switch.json'), JSON.stringify({ want: 'off', state: 'done', message: 'Turned off from Settings.', at: '2026-11-18T11:00:00.000Z' }));
  const h = sc.helper()!;
  assert.deepEqual([h.on, h.locked, h.pending, h.last?.state], [false, true, null, 'done']);
  // Locked: ON is refused before anything is written.
  assert.throws(() => sc.askSwitch(true), /administrator locked/);
  assert.equal(existsSync(join(w.data, 'update-request')), false);
  db.close();
});

async function serve(t: test.TestContext, w: World) {
  const t2 = tempDir();
  const app = makeApp(t2.dir, { get now() { return new Date(); } });
  const db = new DatabaseSync(':memory:');
  setSelfCode(app, selfCode(w, db));
  const auth = new OwnerAuth(t2.dir, () => new Date());
  const tok = auth.newToken!;
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (body: unknown) => fetch(`${base}/api/self-code/helper`, { method: 'POST', headers: { authorization: ['Bearer', tok].join(' '), origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  t.after(async () => {
    await new Promise<void>((ok) => srv.close(() => ok()));
    app.store.close();
    db.close();
    t2.cleanup();
  });
  return { app, auth, post, tok };
}

test('U5.30: POST /api/self-code/helper: OFF needs nothing, ON needs re-auth (typed ON, else the passkey / two-step proof)', async (t) => {
  const w = world(tmp());
  writeMarker(w, { on: true, locked: false, by: 'admin', at: '2026-11-18T10:00:00.000Z' });
  const s = await serve(t, w);
  const off = await s.post({ on: false });
  assert.equal(off.status, 200);
  assert.equal(((await off.json()) as { helper: { pending: string } }).helper.pending, 'off');
  rmSync(join(w.data, 'update-request'));
  rmSync(join(w.data, 'self-code', 'switch-request.json'));
  writeMarker(w, { on: false, locked: false, by: 'owner', at: '2026-11-18T10:05:00.000Z' });
  // No passkey and no two-step: the owner types the confirmation word.
  const bare = await s.post({ on: true });
  assert.equal(bare.status, 403);
  assert.equal(((await bare.json()) as { confirm: string }).confirm, 'typed');
  assert.equal(existsSync(join(w.data, 'update-request')), false);
  assert.equal((await s.post({ on: true, typed: 'yes' })).status, 403);
  const ok = await s.post({ on: true, typed: ' on ' });
  assert.equal(ok.status, 200);
  assert.equal(readFileSync(join(w.data, 'update-request'), 'utf8').trim(), 'selfcode-on');
  rmSync(join(w.data, 'update-request'));
  rmSync(join(w.data, 'self-code', 'switch-request.json'));
  // A passkey is set up: typing is no longer enough; she wants the passkey (or the owner token / code).
  (s.auth as unknown as { passkeys(): unknown[] }).passkeys = () => [{ id: 'pk-test', label: 'Test' }];
  const typed = await s.post({ on: true, typed: 'ON' });
  assert.equal(typed.status, 403);
  assert.equal(((await typed.json()) as { confirm: string }).confirm, 'token');
  assert.equal(existsSync(join(w.data, 'update-request')), false);
  assert.equal((await s.post({ on: true, token: s.tok })).status, 200);
  // Locked by the admin: refused even with the right proof.
  rmSync(join(w.data, 'update-request'));
  rmSync(join(w.data, 'self-code', 'switch-request.json'));
  writeMarker(w, { on: false, locked: true, by: 'admin', at: '2026-11-18T10:09:00.000Z' });
  const locked = await s.post({ on: true, token: s.tok });
  assert.equal(locked.status, 409);
  assert.match(((await locked.json()) as { error: string }).error, /administrator locked/);
});
