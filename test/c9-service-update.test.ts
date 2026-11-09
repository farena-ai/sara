// C9 for the Windows SERVICE install: Update now no longer sends people to the download page. The
// service account (NT SERVICE\Sara) leaves the signed notice and the download for the Sara Update task
// (SYSTEM, on demand; src/update-service.ts), which trusts nothing in that request: it verifies the
// notice again, copies the installer into the admin-only program folder, hashes it there, and runs the
// same install / health check / roll back steps as the per-user update.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { updaterTaskScript } from '../src/sara-windows.ts';
import { windowsDriver, type UpdateDriver, type UpdatePlan } from '../src/update-apply.ts';
import { keyIdOf, signNotice, type NoticePayload } from '../src/update-notice.ts';
import { REQUEST_FILE, serviceUpdate, TASK_FULL } from '../src/update-service.ts';
import { Updater } from '../src/updates.ts';
import { ROOT, tempDir } from './helpers.ts';

const pubB64 = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const KEYS = { [keyIdOf(pubB64(publicKey))]: pubB64(publicKey) };
const NEW = Buffer.from('new installer bytes 2.87.0');
const payload = (v: string, win: Buffer = NEW): NoticePayload => ({ version: v, date: '2026-11-09T12:00:00Z', minSupported: '2.80.0', security: false, assets: { 'win32-x64': { name: `Sara-Setup-${v}.exe`, url: `https://github.com/farena-ai/sara/releases/download/v${v}/Sara-Setup-${v}.exe`, sha256: sha(win), size: win.length } } });
const quick = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 10)));

function fakeDriver(log: string[], o: { bad?: boolean } = {}) {
  return (plan: UpdatePlan): UpdateDriver => {
    let running = plan.from;
    return {
      async install(f) { log.push(`install ${f}`); running = o.bad ? 'broken' : plan.to; },
      async restore(f) { log.push(`restore ${f}`); running = plan.from; },
      async healthy(v) { return running === v; },
    };
  };
}

/** {app} with sara.env, server/package.json and the kept installer of the installed version; her data folder. */
function install(dir: string, o: { mode?: string; keep?: boolean } = {}) {
  const app = join(dir, 'Program Files', 'Sara');
  const data = join(dir, 'ProgramData', 'Sara');
  mkdirSync(join(app, 'server'), { recursive: true });
  mkdirSync(join(data, 'updates', 'download'), { recursive: true });
  writeFileSync(join(app, 'sara.env'), `\uFEFF# Sara settings\r\nSARA_MODE=${o.mode ?? 'service'}\r\nSARA_DATA="${data}"\r\nSARA_PORT=7861\r\n`);
  writeFileSync(join(app, 'server', 'package.json'), JSON.stringify({ version: '2.86.0' }));
  if (o.keep !== false) {
    mkdirSync(join(app, 'updater', 'keep'), { recursive: true });
    writeFileSync(join(app, 'updater', 'keep', 'Sara-Setup-2.86.0.exe'), 'old installer');
  }
  return { app, data, updates: join(data, 'updates') };
}
function request(updates: string, o: { notice?: unknown; bytes?: Buffer; installer?: string } = {}) {
  const installer = o.installer ?? join(updates, 'download', 'Sara-Setup-2.87.0.exe');
  if (!o.installer) writeFileSync(installer, o.bytes ?? NEW);
  writeFileSync(join(updates, REQUEST_FILE), JSON.stringify({ notice: o.notice ?? signNotice(payload('2.87.0'), privateKey), installer }));
}

test('Sara\'s side: with the Sara Update task, Update now downloads, checks, leaves the signed request and starts the task (no download page)', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const notice = signNotice(payload('2.87.0'), privateKey);
    const f = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/update-notice.json')) return new Response(JSON.stringify(notice), { status: 200 });
      if (u.startsWith('https://api.github.com/')) return new Response(JSON.stringify({ body: '- Store tidy-up' }), { status: 200 });
      if (u.endsWith('/Sara-Setup-2.87.0.exe')) return new Response(new Uint8Array(NEW), { status: 200 });
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    let runs = 0;
    let fail = false;
    const task = { present: () => true, run: async () => { runs++; if (fail) throw new Error("Windows didn't start the Sara Update task (access denied). Nothing was installed."); } };
    const launched: string[] = [];
    const u = new Updater({ dataDir: dir, platform: 'win32', arch: 'x64', version: '2.86.0', fetch: f, noticeKeys: KEYS, env: { SARA_MODE: 'service', SARA_PORT: '7861' }, serviceTask: task, launch: async (p) => void launched.push(p), runnerNode: process.execPath });
    const st = await u.check();
    assert.deepEqual([st.state, st.auto, st.via, st.autoWhy], ['available', true, 'service-task', undefined]);
    await u.update();
    await u.settled();
    const done = u.status();
    assert.equal(done.state, 'updating', done.message);
    assert.equal(done.via, 'service-task');
    assert.match(done.message, /Windows is installing Sara 2\.87\.0 for the Sara service/);
    assert.equal(runs, 1, 'the task was started once');
    assert.deepEqual(launched, [], 'no runner from the data folder: the task runs the one in the program folder');
    const req = JSON.parse(readFileSync(join(dir, 'updates', REQUEST_FILE), 'utf8'));
    assert.deepEqual(req.notice, notice, 'the exact signed notice, for the task to verify again');
    assert.equal(sha(readFileSync(req.installer)), sha(NEW));
    assert.equal(existsSync(join(dir, 'updates', 'keep')), false, 'no previous installer from the data folder (the task keeps its own)');
    // The task can't be started: a clear failure, and no request is left behind.
    fail = true;
    const u2 = new Updater({ dataDir: join(dir, 'b'), platform: 'win32', arch: 'x64', version: '2.86.0', fetch: f, noticeKeys: KEYS, env: { SARA_MODE: 'service' }, serviceTask: task });
    mkdirSync(join(dir, 'b'));
    await u2.check();
    await u2.update();
    await u2.settled();
    assert.equal(u2.status().state, 'failed');
    assert.match(u2.status().message, /didn't start the Sara Update task/);
    assert.equal(existsSync(join(dir, 'b', 'updates', REQUEST_FILE)), false);
  } finally {
    cleanup();
  }
});

test('the task\'s side: a checked request → the copy in the program folder is installed for all users; the new installer is kept for next time', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { app, updates } = install(dir);
    request(updates);
    const log: string[] = [];
    const r = await serviceUpdate({ app, keys: KEYS, arch: 'x64', driver: fakeDriver(log), sleep: quick, timeoutMs: 200 });
    assert.equal(r?.state, 'updated', r?.message);
    assert.deepEqual(log, [`install ${join(app, 'updater', 'Sara-Setup-2.87.0.exe')}`], 'only the copy in the admin-only folder runs');
    assert.deepEqual(readdirSync(join(app, 'updater', 'keep')), ['Sara-Setup-2.87.0.exe'], 'the new installer puts this version back next time');
    assert.equal(existsSync(join(updates, REQUEST_FILE)), false, 'the request is used once');
    assert.equal(JSON.parse(readFileSync(join(updates, 'update-result.json'), 'utf8')).state, 'updated', 'Sara reads this when she starts again');
    assert.equal(await serviceUpdate({ app, keys: KEYS }), null, 'no request: nothing to do');
    // The new version doesn't come up: the kept installer of the installed version goes back.
    const b = install(join(dir, 'b'));
    request(b.updates);
    const log2: string[] = [];
    const r2 = await serviceUpdate({ app: b.app, keys: KEYS, arch: 'x64', driver: fakeDriver(log2, { bad: true }), sleep: quick, timeoutMs: 50 });
    assert.equal(r2?.state, 'rolledback');
    assert.equal(log2[1], `restore ${join(b.app, 'updater', 'keep', 'Sara-Setup-2.86.0.exe')}`);
  } finally {
    cleanup();
  }
});

test('the task trusts nothing in the request: tampered download, foreign or older notice, a file outside the download folder, not a service install', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const cases: [string, (u: string, app: string) => void, RegExp][] = [
      ['tampered', (u) => request(u, { bytes: Buffer.from('evil') }), /didn't match the signed update notice/],
      ['foreign notice', (u) => request(u, { notice: signNotice(payload('2.87.0'), generateKeyPairSync('ed25519').privateKey) }), /notice didn't check out/],
      ['unsigned', (u) => request(u, { notice: { payload: JSON.stringify(payload('2.87.0')) } }), /notice didn't check out/],
      ['older', (u) => request(u, { notice: signNotice(payload('2.85.0'), privateKey) }), /not newer than 2\.86\.0/],
      ['outside', (u, app) => {
        const evil = join(app, '..', 'evil.exe');
        writeFileSync(evil, NEW);
        request(u, { installer: evil });
      }, /isn't the one Sara downloaded/],
    ];
    for (const [name, make, why] of cases) {
      const { app, updates } = install(join(dir, name.replace(/\W/g, '')));
      make(updates, app);
      const log: string[] = [];
      const r = await serviceUpdate({ app, keys: KEYS, arch: 'x64', driver: fakeDriver(log), sleep: quick, timeoutMs: 50 });
      assert.equal(r?.state, 'refused', name);
      assert.match(r!.message, why, name);
      assert.match(r!.message, /Nothing was installed/);
      assert.deepEqual(log, [], `${name}: nothing ran`);
      assert.equal(existsSync(join(app, 'updater', 'Sara-Setup-2.87.0.exe')), false, `${name}: nothing staged`);
      assert.equal(JSON.parse(readFileSync(join(updates, 'update-result.json'), 'utf8')).state, 'failed', `${name}: Settings says why`);
    }
    const user = install(join(dir, 'user'), { mode: 'user' });
    request(user.updates);
    assert.match((await serviceUpdate({ app: user.app, keys: KEYS }))!.message, /not installed as a Windows service/);
    // --dry-run: says what it would do and changes nothing.
    const dry = install(join(dir, 'dry'));
    request(dry.updates);
    const d = await serviceUpdate({ app: dry.app, keys: KEYS, arch: 'x64', dryRun: true });
    assert.equal(d?.state, 'dry-run');
    assert.match(d!.message, /Would install Sara 2\.87\.0 .*going back with .*Sara-Setup-2\.86\.0\.exe/);
    assert.ok(existsSync(join(dry.updates, REQUEST_FILE)));
    assert.equal(existsSync(join(dry.app, 'updater', 'Sara-Setup-2.87.0.exe')), false);
  } finally {
    cleanup();
  }
});

test('the installer runs silently for all users as the service (not /CURRENTUSER)', async () => {
  const calls: string[][] = [];
  const d = windowsDriver({ appDir: 'C:\\Program Files\\Sara', port: 7860, resultFile: 'C:\\ProgramData\\Sara\\updates\\update-result.json' }, async (cmd, args) => (calls.push([cmd, ...args]), ''), 'all');
  await d.install('C:\\Program Files\\Sara\\updater\\Sara-Setup-2.87.0.exe');
  assert.deepEqual(calls[0]!.slice(1, 6), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/ALLUSERS', '/MODE=service']);
  assert.ok(!calls[0]!.includes('/CURRENTUSER'));
});

test('the Sara Update task: SYSTEM, on demand, the runner from the program folder; the service may read and start it, nothing more; Setup sets it up and removes it', () => {
  const app = 'C:\\Program Files\\Sara';
  const s = updaterTaskScript('install', { app });
  assert.equal(TASK_FULL, '\\Sara\\Update');
  assert.match(s, /-Execute 'C:\\Program Files\\Sara\\node\\node\.exe'/);
  assert.match(s, /"C:\\Program Files\\Sara\\server\\src\\update-service\.ts"/);
  assert.match(s, /New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest/);
  assert.match(s, /-TaskPath '\\Sara\\' -TaskName 'Update'/);
  assert.match(s, /NTAccount\('NT SERVICE\\Sara'\)/);
  assert.match(s, /SetSecurityDescriptor\("D:P\(A;;FA;;;SY\)\(A;;FA;;;BA\)\(A;;GRGX;;;\$sid\)", 0\)/, 'full control only for SYSTEM and Administrators; read + run for the service');
  assert.doesNotMatch(s, /New-ScheduledTaskTrigger/, 'no schedule: only when Sara asks');
  assert.doesNotMatch(s, /nssm/i);
  assert.match(updaterTaskScript('remove', { app }), /Unregister-ScheduledTask -TaskPath '\\Sara\\' -TaskName 'Update' -Confirm:\$false/);
  const iss = readFileSync(join(ROOT, 'desktop', 'windows', 'installer', 'sara.iss'), 'utf8');
  const post = iss.slice(iss.indexOf("'--install-service'"));
  assert.ok(post.indexOf("' updater-task install'") > 0, 'Setup sets up the task right after the service');
  assert.match(iss, /FileCopy\(ExpandConstant\('\{srcexe\}'\), App \+ '\\updater\\keep\\Sara-Setup-\{#AppVersion\}\.exe'/, 'and keeps itself for going back');
  assert.match(iss, /' updater-task remove'/, 'uninstall removes it');
  assert.match(iss, /Type: filesandordirs; Name: "\{app\}\\updater"/);
});

// A real task on this PC, only with administrator rights (SYSTEM tasks and their permissions need them):
// registered under a throwaway folder, started by the current user through its permissions, removed.
const admin = process.platform === 'win32' && spawnSync('net', ['session'], { windowsHide: true }).status === 0;
test('Windows for real: the task is registered as SYSTEM, the granted account can start it, and it is removed again', { skip: !admin && 'needs an elevated Windows shell' }, async () => {
  const { dir, cleanup } = tempDir();
  const folder = `SaraTest${process.pid}`;
  const me = spawnSync('whoami', [], { encoding: 'utf8' }).stdout.trim();
  const marker = join(dir, 'ran.txt');
  const ps = (script: string) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
  const o = { app: dir, folder, account: me, command: 'cmd.exe', args: `/c echo ran> "${marker}"` };
  try {
    const r = ps(updaterTaskScript('install', o));
    assert.match(`${r.stdout}${r.stderr}`, /TASK=ok/);
    assert.equal(spawnSync('schtasks', ['/run', '/tn', `\\${folder}\\Update`]).status, 0);
    for (let i = 0; i < 40 && !existsSync(marker); i++) await new Promise((x) => setTimeout(x, 250));
    assert.ok(existsSync(marker), 'the task ran');
  } finally {
    ps(updaterTaskScript('remove', o));
    assert.notEqual(spawnSync('schtasks', ['/query', '/tn', `\\${folder}\\Update`]).status, 0, 'removed');
    rmSync(marker, { force: true });
    cleanup();
  }
});
