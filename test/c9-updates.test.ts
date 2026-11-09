// C9: updates that roll back on Windows and macOS. A signed update notice published with every
// release (Ed25519), the background download checked against it, the installer run silently, a
// health check, and the previous version put back when the new one doesn't come up. The Update
// button's colour rises with the release's age (web/update-check.js).
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyUpdate, macDriver, windowsDriver, type UpdateDriver, type UpdatePlan } from '../src/update-apply.ts';
import { assetKey, keyIdOf, NOTICE_KEYS, signNotice, verifyNotice, type NoticePayload } from '../src/update-notice.ts';
import { launchRunner, Updater } from '../src/updates.ts';
import { ROOT, tempDir } from './helpers.ts';

type Tone = { tone: string; required: boolean } | null;
const { updateTone } = (await import(`data:text/javascript;base64,${readFileSync(join(ROOT, 'web', 'update-check.js')).toString('base64')}`)) as { updateTone: (s: unknown, now: number) => Tone };
const pair = () => generateKeyPairSync('ed25519');
const pubB64 = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const REL = (v: string, n: string) => `https://github.com/farena-ai/sara/releases/download/v${v}/${n}`;

function payload(v: string, files: Record<string, Buffer> = {}, extra: Partial<NoticePayload> = {}): NoticePayload {
  const win = files.win ?? Buffer.from(`win ${v}`);
  const mac = files.mac ?? Buffer.from(`mac ${v}`);
  return {
    version: v,
    date: '2026-11-01T12:00:00Z',
    minSupported: '2.80.0',
    security: false,
    assets: {
      'win32-x64': { name: `Sara-Setup-${v}.exe`, url: REL(v, `Sara-Setup-${v}.exe`), sha256: sha(win), size: win.length },
      darwin: { name: `Sara-${v}.dmg`, url: REL(v, `Sara-${v}.dmg`), sha256: sha(mac), size: mac.length },
    },
    ...extra,
  };
}

// ---- the notice ----

test('notice: signed with Ed25519 and verified with the embedded key; anything else is refused', () => {
  const { publicKey, privateKey } = pair();
  const keys = { [keyIdOf(pubB64(publicKey))]: pubB64(publicKey) };
  const signed = signNotice(payload('2.87.0'), privateKey);
  const ok = verifyNotice(signed, { keys });
  assert.ok(ok.ok, ok.ok ? '' : ok.reason);
  assert.equal(ok.ok && ok.notice.version, '2.87.0');
  // Tampered payload, unsigned, another key, garbage.
  const tampered = { ...signed, payload: signed.payload!.replace('2.80.0', '1.0.0') };
  assert.match(verifyNotice(tampered, { keys }).ok ? '' : (verifyNotice(tampered, { keys }) as { reason: string }).reason, /signature/);
  assert.equal(verifyNotice({ ...signed, signature: '' }, { keys }).ok, false, 'unsigned');
  assert.equal(verifyNotice({ payload: signed.payload }, { keys }).ok, false, 'no signature at all');
  const other = pair();
  assert.equal(verifyNotice(signNotice(payload('2.87.0'), other.privateKey), { keys }).ok, false, 'signed by another key');
  assert.equal(verifyNotice('nonsense', { keys }).ok, false);
  // Older than a notice already seen: refused (no going back to a vulnerable version).
  const older = verifyNotice(signed, { keys, seen: '2.88.0' });
  assert.equal(older.ok, false);
  assert.match((older as { reason: string }).reason, /older/);
  // Asset links must be this release's GitHub download links with a real SHA-256.
  const bad = payload('2.87.0');
  bad.assets['win32-x64'].url = 'https://evil.example/Sara-Setup.exe';
  assert.equal(verifyNotice(signNotice(bad, privateKey), { keys }).ok, false, 'foreign host');
  const bad2 = payload('2.87.0');
  bad2.assets.darwin.sha256 = 'abc';
  assert.equal(verifyNotice(signNotice(bad2, privateKey), { keys }).ok, false, 'bad sha256');
  // The shipped key: one Ed25519 key, id = first 16 hex of its SHA-256.
  const ids = Object.keys(NOTICE_KEYS);
  assert.equal(ids.length >= 1, true);
  for (const id of ids) assert.equal(keyIdOf(NOTICE_KEYS[id]), id);
  assert.equal(assetKey('win32', 'x64'), 'win32-x64');
  assert.equal(assetKey('darwin', 'arm64'), 'darwin');
});

test('notice: the private key is never in the repository; the release script signs on publish', () => {
  assert.match(readFileSync(join(ROOT, '.gitignore'), 'utf8'), /^\.secrets\/$/m);
  const ship = readFileSync(join(ROOT, 'docs/ops/ship-release.sh'), 'utf8');
  assert.match(ship, /scripts\/update-notice\.ts sign/);
  assert.match(ship, /update-notice\.json/);
  assert.match(ship, /\.secrets\/update-notice\/notice-key\.pem/);
  assert.doesNotMatch(readFileSync(join(ROOT, 'src/update-notice.ts'), 'utf8'), /PRIVATE KEY/);
});

// ---- the button's colour ----

test('update button: grey under 2 days, accent 2-4, amber 4-7, red after 7; red at once for security; required below the minimum', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const at = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const st = (days: number, more: Record<string, unknown> = {}) => ({ state: 'available', latest: '2.87.0', releasedAt: at(days), ...more });
  assert.equal(updateTone({ state: 'current' }, now), null);
  assert.deepEqual(updateTone(st(1), now), { tone: 'grey', required: false });
  assert.deepEqual(updateTone(st(2.5), now), { tone: 'accent', required: false });
  assert.deepEqual(updateTone(st(5), now), { tone: 'amber', required: false });
  assert.deepEqual(updateTone(st(8), now), { tone: 'red', required: false });
  assert.deepEqual(updateTone(st(0.1, { security: true }), now), { tone: 'red', required: false });
  assert.deepEqual(updateTone(st(0.1, { required: true }), now), { tone: 'red', required: true });
  assert.deepEqual(updateTone({ state: 'available', latest: '2.87.0' }, now), { tone: 'grey', required: false }, 'no date (GitHub fallback): grey');
});

test('update button: in the top bar, owner only, painted from the tone, opens Settings → Updates', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const head = html.slice(html.indexOf('<header id="chat-head">'), html.indexOf('</header>', html.indexOf('<header id="chat-head">')));
  assert.match(head, /<button id="head-update" class="head-update upd-grey" type="button" data-owner-only hidden/);
  const js = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(js, /head\.className = `head-update upd-\$\{tone\.tone\}`/);
  assert.match(js, /t\('Update required'\)/);
  assert.match(js, /\$\('#head-update'\)\.addEventListener\('click', \(\) => void openSettings\('dh-updates'\)\)/);
  const css = readFileSync(join(ROOT, 'web', 'ui-tidy.css'), 'utf8');
  for (const tone of ['grey', 'accent', 'amber', 'red']) assert.match(css, new RegExp(`\\.head-update\\.upd-${tone} \\{`));
});

// ---- the runner: install, health check, roll back ----

function fakeDriver(o: { badVersion?: string; restoreFails?: boolean }): UpdateDriver & { log: string[] } {
  let running = '2.86.0';
  const log: string[] = [];
  return {
    log,
    async install(file) {
      log.push(`install ${file}`);
      const v = /(\d+\.\d+\.\d+)/.exec(file)![1];
      running = v === o.badVersion ? 'broken' : v;
    },
    async restore(prev) {
      log.push(`restore ${prev}`);
      if (o.restoreFails) throw new Error('restore failed');
      running = /(\d+\.\d+\.\d+)/.exec(prev)![1];
    },
    async healthy(v) {
      return running === v;
    },
  };
}
const plan = (dir: string, more: Partial<UpdatePlan> = {}): UpdatePlan => ({
  platform: 'win32',
  from: '2.86.0',
  to: '2.87.0',
  installer: join(dir, 'Sara-Setup-2.87.0.exe'),
  previous: join(dir, 'Sara-Setup-2.86.0.exe'),
  appDir: dir,
  port: 7860,
  timeoutMs: 400,
  resultFile: join(dir, 'update-result.json'),
  ...more,
});
const quick = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20))) };

test('runner: the new version comes up → updated; the result is written for Sara to report', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const d = fakeDriver({});
    const r = await applyUpdate(plan(dir), d, quick);
    assert.equal(r.state, 'updated');
    assert.deepEqual(d.log, [`install ${join(dir, 'Sara-Setup-2.87.0.exe')}`]);
    assert.equal(JSON.parse(readFileSync(join(dir, 'update-result.json'), 'utf8')).state, 'updated');
  } finally {
    cleanup();
  }
});

test('runner: the new version fails its health check → the previous version is put back and it says so', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const d = fakeDriver({ badVersion: '2.87.0' });
    const r = await applyUpdate(plan(dir), d, quick);
    assert.equal(r.state, 'rolledback');
    assert.match(r.message, /2\.87\.0 didn't start.*back to 2\.86\.0/);
    assert.deepEqual(d.log.map((l) => l.split(' ')[0]), ['install', 'restore']);
    const bad = await applyUpdate(plan(dir), fakeDriver({ badVersion: '2.87.0', restoreFails: true }), quick);
    assert.equal(bad.state, 'failed');
    assert.match(bad.message, /Sara-Setup-2\.86\.0\.exe/, 'tells where the previous installer is');
  } finally {
    cleanup();
  }
});

test('runner (macOS seam): verifies the signature, keeps the old app, swaps it in and restarts the agent', async () => {
  const calls: string[] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'hdiutil' && args[0] === 'attach') return '/dev/disk9\t\t/Volumes/Sara-u';
    if (cmd === 'codesign' && args[0] === '-dv') return 'TeamIdentifier=ABCDE12345';
    return '';
  };
  const fs = { copied: [] as string[], copy: async (a: string, b: string) => void fs.copied.push(`${a} -> ${b}`), remove: async (_p: string) => {}, rename: async (a: string, b: string) => void fs.copied.push(`${a} => ${b}`) };
  const d = macDriver({ appDir: '/Applications/Sara.app', keepDir: '/Users/o/Sara/updates/keep', port: 7860, uid: 501, run, fs, health: async () => true, version: async () => '2.87.0' });
  await d.install('/Users/o/Sara/updates/Sara-2.87.0.dmg');
  assert.ok(calls.some((c) => c.startsWith('codesign --verify --deep --strict /Volumes/Sara-u/Sara.app')), calls.join('\n'));
  assert.ok(calls.some((c) => c === 'launchctl kickstart -k gui/501/com.backstagecoding.sara.server'));
  assert.ok(calls.some((c) => c.startsWith('hdiutil detach')));
  assert.ok(fs.copied.some((c) => c === '/Applications/Sara.app -> /Users/o/Sara/updates/keep/Sara.app'), 'the old app is kept');
  // A different Developer ID team on the new app: refused before anything is replaced.
  const other = macDriver({ appDir: '/Applications/Sara.app', keepDir: '/k', port: 7860, uid: 501, fs, health: async () => true, version: async () => '', run: async (c, a) => (c === 'hdiutil' && a[0] === 'attach' ? '/dev/x\t\t/Volumes/S' : c === 'codesign' && a[0] === '-dv' ? (a.at(-1)!.startsWith('/Volumes') ? 'TeamIdentifier=ZZZ' : 'TeamIdentifier=ABC') : '') });
  await assert.rejects(other.install('/x/Sara-2.87.0.dmg'), /signed by someone else/);
});

// ---- Sara's side: the check reads the notice, Update downloads and verifies ----

function noticeServer(o: { notice?: unknown; files: Record<string, Buffer>; gh?: unknown }) {
  const fetched: string[] = [];
  const f = (async (url: string | URL | Request) => {
    const u = String(url);
    fetched.push(u);
    if (u.endsWith('/update-notice.json')) return o.notice === undefined ? new Response('no', { status: 404 }) : new Response(JSON.stringify(o.notice), { status: 200 });
    if (u.startsWith('https://api.github.com/')) return new Response(JSON.stringify(o.gh ?? { tag_name: 'v2.87.0', html_url: 'https://github.com/farena-ai/sara/releases/tag/v2.87.0' }), { status: 200 });
    const name = u.split('/').pop()!;
    if (o.files[name]) return new Response(new Uint8Array(o.files[name]), { status: 200 });
    if (name === 'SHA256SUMS') return new Response(Object.entries(o.files).map(([n, b]) => `${sha(b)}  ${n}`).join('\n'), { status: 200 });
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
  return { f, fetched };
}

test('Updater: a valid notice → available with its date, security flag and the minimum; Update runs here', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { publicKey, privateKey } = pair();
    const keys = { [keyIdOf(pubB64(publicKey))]: pubB64(publicKey) };
    const n = noticeServer({ notice: signNotice(payload('2.87.0', {}, { security: true, minSupported: '2.87.0' }), privateKey), files: {} });
    const u = new Updater({ dataDir: dir, platform: 'win32', arch: 'x64', version: '2.86.0', fetch: n.f, noticeKeys: keys, env: { SARA_MODE: 'user' } });
    const st = await u.check(new Date('2026-11-02T12:00:00Z'));
    assert.equal(n.fetched[0], 'https://github.com/farena-ai/sara/releases/latest/download/update-notice.json');
    assert.deepEqual([st.state, st.latest, st.security, st.required, st.releasedAt, st.auto], ['available', '2.87.0', true, true, '2026-11-01T12:00:00Z', true]);
    // Seen: an older notice later is refused and the check falls back to GitHub (no automatic install).
    const old = noticeServer({ notice: signNotice(payload('2.86.5'), privateKey), files: {}, gh: { tag_name: 'v2.86.5' } });
    const u2 = new Updater({ dataDir: dir, platform: 'win32', arch: 'x64', version: '2.86.0', fetch: old.f, noticeKeys: keys, env: { SARA_MODE: 'user' } });
    const st2 = await u2.check();
    assert.equal(st2.auto, false);
    assert.equal(st2.trusted, false);
    // Service install: needs an administrator, so the download page stays the way.
    const svc = new Updater({ dataDir: join(dir, 's'), platform: 'win32', arch: 'x64', version: '2.86.0', fetch: n.f, noticeKeys: keys, env: { SARA_MODE: 'service' } });
    mkdirSync(join(dir, 's'));
    assert.equal((await svc.check()).auto, false);
  } finally {
    cleanup();
  }
});

test('Updater: no notice (or an unsigned one) → GitHub latest as before, download page only', async () => {
  const { dir, cleanup } = tempDir();
  try {
    for (const notice of [undefined, { payload: '{"version":"2.87.0"}' }]) {
      const n = noticeServer({ notice, files: {} });
      const u = new Updater({ dataDir: dir, platform: 'darwin', version: '2.86.0', fetch: n.f, noticeKeys: {} });
      const st = await u.check();
      assert.deepEqual([st.state, st.latest, st.auto, st.trusted], ['available', '2.87.0', false, false]);
      assert.ok(n.fetched.includes('https://api.github.com/repos/farena-ai/sara/releases/latest'));
    }
  } finally {
    cleanup();
  }
});

test('Updater.update: downloads in the background, checks SHA-256 from the notice, keeps the previous installer, starts the runner', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { publicKey, privateKey } = pair();
    const keys = { [keyIdOf(pubB64(publicKey))]: pubB64(publicKey) };
    const win = Buffer.from('new installer bytes');
    const prev = Buffer.from('old installer bytes');
    const n = noticeServer({ notice: signNotice(payload('2.87.0', { win }), privateKey), files: { 'Sara-Setup-2.87.0.exe': win, 'Sara-Setup-2.86.0.exe': prev } });
    const launched: string[] = [];
    const u = new Updater({ dataDir: dir, platform: 'win32', arch: 'x64', version: '2.86.0', fetch: n.f, noticeKeys: keys, env: { SARA_MODE: 'user', SARA_PORT: '7999' }, appDir: join(dir, 'app'), launch: async (p) => void launched.push(p), runnerNode: process.execPath });
    await u.check();
    const st = await u.update();
    assert.equal(st.state, 'downloading');
    await u.settled();
    const done = u.status();
    assert.equal(done.state, 'updating', done.message);
    assert.equal(launched.length, 1);
    const p = JSON.parse(readFileSync(launched[0], 'utf8')) as UpdatePlan;
    assert.deepEqual([p.from, p.to, p.port, p.platform], ['2.86.0', '2.87.0', 7999, 'win32']);
    assert.equal(sha(readFileSync(p.installer)), sha(win));
    assert.equal(sha(readFileSync(p.previous)), sha(prev), 'the previous installer, checked against its release SHA256SUMS');
    assert.ok(existsSync(join(dir, 'updates', 'runner', 'update-apply.ts')), 'the runner runs from a copy outside the install folder');
    // A wrong download: refused, nothing launched.
    const evil = noticeServer({ notice: signNotice(payload('2.87.0', { win }), privateKey), files: { 'Sara-Setup-2.87.0.exe': Buffer.from('tampered'), 'Sara-Setup-2.86.0.exe': prev } });
    const u2 = new Updater({ dataDir: join(dir, 'b'), platform: 'win32', arch: 'x64', version: '2.86.0', fetch: evil.f, noticeKeys: keys, env: { SARA_MODE: 'user' }, appDir: dir, launch: async (pp) => void launched.push(pp), runnerNode: process.execPath });
    mkdirSync(join(dir, 'b'));
    await u2.check();
    await u2.update();
    await u2.settled();
    assert.equal(u2.status().state, 'failed');
    assert.match(u2.status().message, /didn't match/);
    assert.equal(launched.length, 1);
    // After the restart: the runner's result is what Settings shows.
    writeFileSync(join(dir, 'updates', 'update-result.json'), JSON.stringify({ state: 'rolledback', message: "Sara 2.87.0 didn't start within 3 minutes, so she went back to 2.86.0.", at: new Date().toISOString(), to: '2.87.0' }));
    const again = new Updater({ dataDir: dir, platform: 'win32', arch: 'x64', version: '2.86.0', fetch: n.f, noticeKeys: keys, env: { SARA_MODE: 'user' } });
    assert.equal(again.status().state, 'rolledback');
  } finally {
    cleanup();
  }
});

// ---- the real Windows path on this PC: the runner process with scripted fake installers ----

test('Windows driver for real: a process outside Sara runs the installers, health-checks and rolls back', { skip: process.platform !== 'win32' }, async () => {
  const { dir, cleanup } = tempDir();
  const health = createServer((req, res) => res.end(req.url === '/api/health' ? '{"ok":true}' : ''));
  await new Promise<void>((r) => health.listen(0, '127.0.0.1', r));
  try {
    const port = (health.address() as AddressInfo).port;
    const app = join(dir, 'app');
    mkdirSync(join(app, 'server'), { recursive: true });
    writeFileSync(join(app, 'server', 'package.json'), '{"version": "2.86.0"}');
    // Scripted installers: they write the version the real installer would put in place ("broken" = won't start).
    const fake = (v: string, writes: string) => {
      const f = join(dir, `Sara-Setup-${v}.cmd`);
      writeFileSync(f, `@echo off\r\necho %* > "${join(dir, `args-${v}.txt`)}"\r\n> "${join(app, 'server', 'package.json')}" echo {"version": "${writes}"}\r\n`);
      return f;
    };
    const plan2: UpdatePlan = { platform: 'win32', from: '2.86.0', to: '2.87.0', installer: fake('2.87.0', '2.87.0'), previous: fake('2.86.0', '2.86.0'), appDir: app, port, timeoutMs: 3000, resultFile: join(dir, 'result.json') };
    const good = await applyUpdate(plan2, windowsDriver(plan2), {});
    assert.equal(good.state, 'updated', good.message);
    assert.match(readFileSync(join(dir, 'args-2.87.0.txt'), 'utf8'), /\/VERYSILENT \/SUPPRESSMSGBOXES \/NORESTART \/CURRENTUSER/);
    const plan3: UpdatePlan = { ...plan2, from: '2.87.0', to: '2.88.0', installer: fake('2.88.0', 'broken'), previous: plan2.installer };
    const bad = await applyUpdate(plan3, windowsDriver(plan3), {});
    assert.equal(bad.state, 'rolledback', bad.message);
    assert.match(readFileSync(join(app, 'server', 'package.json'), 'utf8'), /2\.87\.0/, 'the previous version is back');
  } finally {
    health.close();
    cleanup();
  }
});

test('Windows for real: the runner starts through WMI (outside Sara\'s job), runs alone from its plan and reports', { skip: process.platform !== 'win32' }, async () => {
  const { dir, cleanup } = tempDir();
  const health = createServer((req, res) => res.end(req.url === '/api/health' ? '{"ok":true}' : ''));
  await new Promise<void>((r) => health.listen(0, '127.0.0.1', r));
  try {
    const app = join(dir, 'app');
    mkdirSync(join(app, 'server'), { recursive: true });
    writeFileSync(join(app, 'server', 'package.json'), '{"version": "2.86.0"}');
    const fake = (v: string) => {
      const f = join(dir, `Sara-Setup-${v}.cmd`);
      writeFileSync(f, `@echo off\r\n> "${join(app, 'server', 'package.json')}" echo {"version": "${v}"}\r\n`);
      return f;
    };
    const runner = join(dir, 'runner');
    mkdirSync(runner);
    writeFileSync(join(runner, 'update-apply.ts'), readFileSync(join(ROOT, 'src', 'update-apply.ts')));
    const plan: UpdatePlan = { platform: 'win32', from: '2.86.0', to: '2.87.0', installer: fake('2.87.0'), previous: fake('2.86.0'), appDir: app, port: (health.address() as AddressInfo).port, timeoutMs: 5000, resultFile: join(dir, 'updates', 'update-result.json'), keepDir: join(dir, 'keep') };
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
    await launchRunner(process.execPath, join(runner, 'update-apply.ts'), join(dir, 'plan.json'));
    let r: { state?: string } = {};
    for (let i = 0; i < 100 && r.state !== 'updated'; i++) {
      await new Promise((res) => setTimeout(res, 200));
      try {
        r = JSON.parse(readFileSync(plan.resultFile, 'utf8'));
      } catch {
        /* not yet */
      }
    }
    assert.equal(r.state, 'updated');
    assert.ok(existsSync(join(dir, 'keep', 'Sara-Setup-2.87.0.cmd')), 'the new installer is kept for the next rollback');
  } finally {
    health.close();
    await new Promise((res) => setTimeout(res, 500));
    cleanup();
  }
});
