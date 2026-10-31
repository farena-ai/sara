// Phase 91 (computer use CU4b, docs/design/COMPUTER_USE.md §0 decision 3 and §11 "Done when"): the owner's
// own password managers as extra sources behind the Phase 90 autofill. Test data only: the Bitwarden and
// 1Password CLIs are test doubles (test/fixtures/fake-pm), KeePassXC is a double too and, when
// SARA_TEST_KEEPASSXC names a folder with the real keepassxc-cli, also the real one with a new test database.
// Checked: the rules (exact origin, names and states only to the server, the warning, relock default),
// detection by --version only, off until turned on, a fixture entry filling a fixture sign-in on the
// reference hands with a card, locked → the person unlocks it in the manager's own prompt, a wrong master
// password or a closed window leaves it locked, look-alike origins get nothing, Sara's own saved login first,
// relock after the task, after the idle time, on Stop and when turned off, and THE proof: no test password,
// username, master password or session key in the hands channel, model messages, run steps, the
// conversation, the local log or any file of the server's data folder, while the fixture site received it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { findBrowser } from '../src/browser.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { CU4B_OPS, HANDS_OPS, HandsHub, WAITING_OPS } from '../src/hands.ts';
import { TestVault } from '../src/hands-logins.ts';
import { commandLine, DEFAULT_RELOCK_MINUTES, entryOrigin, MANAGER_WARNING, ManagerSessions, managerViews, parseBwItems, parseKpxCsv, parseOpItem, parseOpList, pickEntry, relockMinutes, type ManagerId, type PromptRequest } from '../src/hands-managers.ts';
import { HandsRef } from '../src/hands-ref.ts';
import { RunStore, runSettings } from '../src/runs.ts';
import { createSaraServer } from '../src/server.ts';
import { createComputerTools } from '../src/tools/computer.ts';
import { writeFakeManagers } from './fixtures/fake-pm/make.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const NOW = new Date();
const browser = findBrowser();
const REAL = browser.found;
// Obviously fake test credentials, built in pieces (never real ones).
const BW_PASS = 'fake-' + 'bw-' + 'pass-' + 'Q7';
const OP_PASS = 'fake-' + 'op-' + 'pass-' + 'R8';
const KP_PASS = 'fake-' + 'kp-' + 'pass-' + 'S9';
const SAVED_PASS = 'fake-' + 'saved-' + 'pass-' + 'T1';
const LOOK_PASS = 'fake-' + 'lookalike-' + 'U2';
const USER = 'alex-' + 'pm-' + 'test';
const MASTER: Record<ManagerId, string> = { bitwarden: 'master-' + 'bw-' + 'Xx1', '1password': 'master-' + 'op-' + 'Xx2', keepassxc: 'master-' + 'kp-' + 'Xx3' };
const HOST = 'accounts.sara.test';
const OPHOST = 'login.sara.test';
const KPHOST = 'kpx.sara.test';
const SAVEDHOST = 'saved.sara.test';
const EVIL = 'accounts.sara.test.evil.test';
const SECRETS = [BW_PASS, OP_PASS, KP_PASS, SAVED_PASS, LOOK_PASS, USER, ...Object.values(MASTER)];

// ---- the fixture site: a sign-in form; POST /session records which host got which password ----
let fixture: Server;
let fixture2: Server;
let P = 0;
let Q = 0;
const received: { host: string; password: string }[] = [];
function site(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  const html = (title: string, body: string) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`);
  };
  if (req.method === 'POST' && url.pathname === '/session') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const f = new URLSearchParams(body);
      received.push({ host: String(req.headers.host ?? ''), password: f.get('password') ?? '' });
      const ok = [BW_PASS, OP_PASS, KP_PASS, SAVED_PASS].includes(f.get('password') ?? '') && f.get('username') === USER;
      html(ok ? 'Signed in' : 'Wrong', ok ? '<h1>Signed in (the right user)</h1>' : '<h1 role="alert">Wrong username or password</h1>');
    });
    return;
  }
  if (url.pathname === '/login')
    return html(
      'Sign in',
      `<h1>Sign in</h1><form method="post" action="/session">
<label>Username <input name="username" autocomplete="username"></label>
<label>Password <input type="password" name="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button></form>`,
    );
  html('Home', '<h1>Home</h1>');
}
before(async () => {
  fixture = createServer(site);
  fixture2 = createServer(site);
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => fixture2.listen(0, '127.0.0.1', r));
  P = (fixture.address() as AddressInfo).port;
  Q = (fixture2.address() as AddressInfo).port;
});
after(() => {
  fixture.close();
  fixture2.close();
});

interface Env {
  app: TestApp;
  auth: OwnerAuth;
  token: string;
  server: Server;
  base: string;
  hub: HandsHub;
  dir: string;
  close: () => Promise<void>;
}
async function env(): Promise<Env> {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const hub = new HandsHub({ events: app.events!, known: () => auth.devices().filter((d) => d.kind === 'hands') });
  app.hands = hub;
  app.runs = new RunStore(app.store.db, () => NOW);
  app.runs.settings = () => runSettings(app.settings.get());
  app.settings.update({ disclosureAcceptedAt: NOW.toISOString(), providers: [{ id: 'cloud', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1' }], defaultProviderId: 'cloud', defaultModel: 'fake-large' });
  for (const t of createComputerTools(app)) app.tools.add(t);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    app,
    auth,
    token,
    server,
    base,
    hub,
    dir,
    close: async () => {
      hub.closeAll();
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      app.store.close();
      cleanup();
    },
  };
}
async function api(e: Env, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any>; text: string }> {
  const r = await fetch(e.base + path, { method, headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const t = await r.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(t) as Record<string, any>;
  } catch {
    /* not json */
  }
  return { status: r.status, json, text: t };
}
const until = async (fn: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 30));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function allFiles(dir: string): string {
  let out = '';
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) out += allFiles(p);
    else if (st.size < 64 * 1024 * 1024) out += readFileSync(p).toString('latin1');
  }
  return out;
}

/** The doubles, in a scratch folder of this test. */
function doubles(dir: string, port: number) {
  return writeFakeManagers(join(dir, 'pm'), {
    bitwarden: {
      master: MASTER.bitwarden,
      items: [
        { name: 'Accounts', uri: `http://${HOST}:${port}`, username: USER, password: BW_PASS },
        // Same host, another site of it: Bitwarden's own loose matching returns it for any port; Sara never fills it there.
        { name: 'Look-alike', uri: `http://${HOST}:1`, username: USER, password: LOOK_PASS },
      ],
    },
    '1password': { master: MASTER['1password'], items: [{ id: 'k3xq7abc', title: 'Login site', url: `http://${OPHOST}:${port}/login`, username: USER, password: OP_PASS }] },
    keepassxc: { master: MASTER.keepassxc, entries: [{ title: 'KPX site', url: `http://${KPHOST}:${port}`, username: USER, password: KP_PASS }] },
  });
}

/** The person at the computer, typing into the manager's own prompt (or closing it / typing it wrong). */
function person() {
  const seen: { stdout: string; title: string }[] = [];
  let answer: 'type' | 'close' | 'wrong' = 'type';
  const prompt = (req: PromptRequest) =>
    new Promise<{ stdout: string; code: number }>((resolve) => {
      const [cmd, argv, verbatim] = commandLine(req.command, req.args);
      const child = spawn(cmd, argv, { env: req.env, windowsVerbatimArguments: verbatim, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
      child.on('close', (code) => {
        seen.push({ stdout: out, title: req.title });
        resolve({ stdout: out, code: code ?? 1 });
      });
      if (answer === 'close') child.kill();
      else child.stdin!.end(`${answer === 'wrong' ? 'not-the-' + 'master' : MASTER[req.manager]}\n`);
    });
  return { prompt, seen, set: (a: 'type' | 'close' | 'wrong') => (answer = a) };
}

// ------------------------------------------------------------------------------------------------

test('the rules: exact origin only, names and states only to the server, the warning, relock default 15, the protocol', () => {
  const entries = [
    { title: 'GitHub', urls: ['https://github.com/login'], username: 'a', password: 'b' },
    { title: 'Bare', urls: ['example.test'], username: 'a', password: 'c' },
  ];
  assert.equal(pickEntry(entries, 'https://github.com/session')?.title, 'GitHub');
  for (const bad of ['https://github.com.evil.test/login', 'http://github.com/login', 'https://github.com:8443/', 'https://www.github.com/', 'https://user:pw@github.com/', 'about:blank']) assert.equal(pickEntry(entries, bad), undefined, bad);
  // A bare address in a manager means https (as the managers do).
  assert.equal(entryOrigin('example.test'), 'https://example.test');
  assert.equal(pickEntry(entries, 'https://example.test/a')?.title, 'Bare');
  assert.equal(pickEntry(entries, 'http://example.test/a'), undefined);
  // Several for one site: the one named wins.
  assert.equal(pickEntry([...entries, { title: 'Work', urls: ['https://github.com'], username: 'w', password: 'x' }], 'https://github.com', 'work')?.title, 'Work');
  // What the server keeps of a device's managers: known ids and states, never anything else.
  const views = managerViews([{ id: 'bitwarden', installed: true, on: true, state: 'unlocked', session: 'abc', items: [{ password: BW_PASS }] }, { id: 'evilpass', installed: true, on: true }, { id: '1password', installed: false, on: true, state: 'unlocked' }, { id: 'keepassxc', installed: true, on: false, state: 'unlocked' }]);
  assert.deepEqual(views, [
    { id: 'bitwarden', name: 'Bitwarden', installed: true, on: true, state: 'unlocked' },
    { id: '1password', name: '1Password', installed: false, on: false, state: 'missing' },
    { id: 'keepassxc', name: 'KeePassXC', installed: true, on: false, state: 'off' },
  ]);
  assert.equal(JSON.stringify(views).includes(BW_PASS), false);
  assert.equal(DEFAULT_RELOCK_MINUTES, 15);
  assert.equal(relockMinutes(undefined), 15);
  assert.equal(relockMinutes(30), 30);
  assert.equal(relockMinutes(2), 15);
  assert.match(MANAGER_WARNING, /You unlock \{manager\} yourself, in its own window/);
  assert.match(MANAGER_WARNING, /never sees or keeps your master password/);
  assert.match(MANAGER_WARNING, /never leave this computer/);
  assert.ok(CU4B_OPS.every((o) => (HANDS_OPS as readonly string[]).includes(o)));
  assert.ok(WAITING_OPS.has('b.unlock'));
  // The documented output shapes the devices read.
  assert.deepEqual(parseBwItems(JSON.stringify([{ type: 1, name: 'A', login: { uris: [{ uri: 'https://a.test' }], username: 'u', password: 'p' } }, { type: 2, name: 'note' }])), [{ title: 'A', urls: ['https://a.test'], username: 'u', password: 'p' }]);
  assert.deepEqual(parseOpList(JSON.stringify([{ id: 'abc123', title: 'A', urls: [{ href: 'https://a.test' }] }, { id: 'bad id!' }])), [{ id: 'abc123', title: 'A', urls: ['https://a.test'] }]);
  assert.deepEqual(parseOpItem(JSON.stringify({ fields: [{ purpose: 'USERNAME', value: 'u' }, { purpose: 'PASSWORD', value: 'p' }] })), { username: 'u', password: 'p' });
  assert.deepEqual(parseKpxCsv('"Group","Title","Username","Password","URL"\r\n"G","A ""x""","u","p,1","https://a.test"\r\n"G","No site","u","p",""\r\n'), [{ title: 'A "x"', urls: ['https://a.test'], username: 'u', password: 'p,1' }]);
});

test('detection: only --version runs; each manager is off until turned on; unlock is the person\u2019s, in its own prompt; a wrong password or a closed window stays locked; idle, Stop-style lockAll and turning off lock again', async (t) => {
  const { dir, cleanup } = tempDir();
  try {
    const f = doubles(dir, 7000);
    // The test doubles are small launch scripts in the temp folder; where it is mounted noexec (the
    // release server's /tmp) they can't run, so the managers would look missing for a reason that
    // isn't Sara's.
    if (process.platform !== 'win32' && spawnSync(join(f.bin, 'bw'), ['--version']).error) {
      t.skip('the temp folder does not allow running programs (noexec), so the test doubles cannot start');
      return;
    }
    const who = person();
    const changes: string[] = [];
    const pm = new ManagerSessions({ search: [f.bin], env: f.env, keepassDb: f.keepassDb!, prompt: who.prompt, relockMs: 600, onChange: () => changes.push('x') });
    await pm.detect();
    assert.deepEqual(pm.ran, ['bw --version', 'op --version', 'keepassxc-cli --version'], 'detection runs --version only');
    assert.deepEqual(pm.views().map((v) => [v.id, v.installed, v.state]), [['bitwarden', true, 'off'], ['1password', true, 'off'], ['keepassxc', true, 'off']]);
    // Off: nothing is looked up, and it can't be unlocked.
    assert.deepEqual(await pm.lookup(`http://${HOST}:7000/login`), { locked: [] });
    await assert.rejects(pm.unlock('bitwarden', 'http://x'), /off for Sara/);
    await pm.setOn('bitwarden', true);
    assert.deepEqual((await pm.lookup(`http://${HOST}:7000/login`)).locked, ['bitwarden']);
    // A wrong master password, then a closed window: still locked.
    who.set('wrong');
    assert.equal(await pm.unlock('bitwarden', `http://${HOST}:7000`), false);
    who.set('close');
    assert.equal(await pm.unlock('bitwarden', `http://${HOST}:7000`), false);
    assert.equal(pm.unlocked('bitwarden'), false);
    // The third prompt in 10 minutes is the last one.
    who.set('type');
    assert.equal(await pm.unlock('bitwarden', `http://${HOST}:7000`), true);
    assert.match(who.seen.at(-1)!.title, /^Unlock Bitwarden for Sara: sign in to http:\/\/accounts\.sara\.test:7000 \(close this window to say no\)$/);
    const r = await pm.lookup(`http://${HOST}:7000/login`);
    assert.equal(r.source, 'bitwarden');
    assert.equal(r.entry?.password, BW_PASS);
    // Idle: it locks again by itself (bw lock ran).
    await until(() => !pm.unlocked('bitwarden'), 5000);
    assert.ok(pm.ran.includes('bw lock'));
    await until(() => /bw lock/.test(readFileSync(join(f.env.BITWARDENCLI_APPDATA_DIR, 'calls.log'), 'utf8')), 8000);
    assert.deepEqual(JSON.parse(readFileSync(join(f.env.BITWARDENCLI_APPDATA_DIR, 'state.json'), 'utf8')).sessions, [], 'the double holds no session any more');
    await assert.rejects(pm.unlock('bitwarden', 'http://x'), /3 times in 10 minutes/);
    // 1Password and KeePassXC: unlock, use, lockAll (Stop), turn off.
    await pm.setOn('1password', true);
    await pm.setOn('keepassxc', true);
    assert.equal(await pm.unlock('1password', `http://${OPHOST}:7000`), true);
    assert.equal(await pm.unlock('keepassxc', `http://${KPHOST}:7000`), true);
    assert.equal((await pm.lookup(`http://${OPHOST}:7000/login`)).entry?.password, OP_PASS);
    assert.equal((await pm.lookup(`http://${KPHOST}:7000/login`)).entry?.password, KP_PASS);
    assert.deepEqual(await pm.lockAll('stopped'), ['1password', 'keepassxc']);
    assert.ok(pm.ran.includes('op signout'));
    assert.equal(await pm.unlock('keepassxc', 'http://x'), true);
    await pm.setOn('keepassxc', false);
    assert.equal(pm.views().find((v) => v.id === 'keepassxc')!.state, 'off');
    assert.equal(pm.unlocked('keepassxc'), false, 'turning it off forgets its session');
    assert.ok(changes.length >= 6, 'the device hears about every change');
    // No command line ever carried a password, a master password or a session.
    const lines = pm.ran.join('\n');
    for (const s of [...SECRETS, ...who.seen.map((x) => x.stdout.trim()).filter(Boolean)]) assert.equal(lines.includes(s), false, 'a command line had a secret');
  } finally {
    cleanup();
  }
});

test('the real KeePassXC CLI with a new test database (SARA_TEST_KEEPASSXC)', { skip: !process.env.SARA_TEST_KEEPASSXC && 'set SARA_TEST_KEEPASSXC to the folder of keepassxc-cli' }, async () => {
  const { dir, cleanup } = tempDir();
  try {
    const cli = join(String(process.env.SARA_TEST_KEEPASSXC), process.platform === 'win32' ? 'keepassxc-cli.exe' : 'keepassxc-cli');
    const db = join(dir, 'sara-test.kdbx');
    const cfg = join(dir, 'kpx-config');
    mkdirSync(cfg, { recursive: true });
    const env = { ...process.env, APPDATA: cfg, LOCALAPPDATA: cfg, XDG_CONFIG_HOME: cfg, HOME: cfg };
    assert.equal(spawnSync(cli, ['db-create', '--set-password', db], { input: `${MASTER.keepassxc}\n${MASTER.keepassxc}\n`, env }).status, 0);
    assert.equal(spawnSync(cli, ['add', '-u', USER, '--url', `http://${KPHOST}:7000`, '-p', db, 'KPX site'], { input: `${MASTER.keepassxc}\n${KP_PASS}\n`, env }).status, 0);
    const who = person();
    const pm = new ManagerSessions({ search: [String(process.env.SARA_TEST_KEEPASSXC)], on: ['keepassxc'], keepassDb: db, env, prompt: who.prompt });
    await pm.detect();
    assert.equal(pm.views().find((v) => v.id === 'keepassxc')!.installed, true);
    who.set('wrong');
    assert.equal(await pm.unlock('keepassxc', `http://${KPHOST}:7000`), false);
    who.set('type');
    assert.equal(await pm.unlock('keepassxc', `http://${KPHOST}:7000`), true);
    assert.equal((await pm.lookup(`http://${KPHOST}:7000/login`)).entry?.password, KP_PASS);
    assert.equal((await pm.lookup(`http://${KPHOST}:7001/login`)).entry, undefined);
    await pm.lockAll('test');
    assert.deepEqual((await pm.lookup(`http://${KPHOST}:7000/login`)).locked, ['keepassxc']);
  } finally {
    cleanup();
  }
});

test('the reference hands: a manager entry fills a fixture sign-in with a card; locked asks the person to unlock; look-alikes get nothing; saved logins first; relock after the task, on Stop, idle and turned off; nothing secret leaves the computer', { skip: !REAL && 'no Chromium-family browser here' }, async () => {
  const e = await env();
  const pair = await api(e, 'POST', '/api/hands/pair', { name: 'Test PC', token: e.token });
  assert.equal(pair.status, 200, pair.text);
  const { token, id } = pair.json as { token: string; id: string };
  const pmDir = tempDir();
  const f = doubles(pmDir.dir, P);
  const who = person();
  const pm = new ManagerSessions({ search: [f.bin], env: f.env, keepassDb: f.keepassDb!, prompt: who.prompt, relockMs: 15 * 60_000 });
  const serverOrigin = new URL(e.base).origin;
  const vault = new TestVault([{ name: 'Saved one', sites: [`http://${SAVEDHOST}:${P}`], username: USER, password: SAVED_PASS, server: serverOrigin, created: NOW.toISOString() }]);
  const logFile = join(pmDir.dir, 'hands-log.txt');
  const ref = new HandsRef({ server: e.base, token, name: 'Test PC', info: browser, vault, managers: pm, logFile, recordWire: true, browserArgs: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1, MAP ${OPHOST} 127.0.0.1, MAP ${KPHOST} 127.0.0.1, MAP ${SAVEDHOST} 127.0.0.1, MAP ${EVIL} 127.0.0.1`] });
  const turn = async (conv: string, owner: string, decide: (ev: Extract<ChatEvent, { type: 'approval' }>) => boolean = () => true) => {
    const evs: ChatEvent[] = [];
    for await (const ev of runTurn(e.app, conv, owner)) {
      evs.push(ev);
      if (ev.type === 'approval') e.app.approvals.decide(ev.approvalId, decide(ev));
    }
    return { evs, cards: evs.filter((x): x is Extract<ChatEvent, { type: 'approval' }> => x.type === 'approval'), results: evs.filter((x): x is Extract<ChatEvent, { type: 'tool_result' }> => x.type === 'tool_result') };
  };
  const state = (m: ManagerId) => e.hub.devices().find((d) => d.id === id)?.managers?.find((x) => x.id === m)?.state;
  const op = async (name: string, args: Record<string, unknown> = {}) => {
    await sleep(260);
    return e.hub.request(id, name, args).then((r) => r.result, (err: Error & { code?: string }) => ({ error: err.code, message: err.message }) as Record<string, any>);
  };
  try {
    await ref.start();
    await until(() => Boolean(e.hub.hello(id)), 10_000);
    assert.ok(CU4B_OPS.every((o) => e.hub.hello(id)!.ops!.includes(o)));
    assert.deepEqual(e.hub.hello(id)!.managers!.map((m) => `${m.id}:${m.state}`), ['bitwarden:off', '1password:off', 'keepassxc:off'], 'found, and off until turned on');
    assert.equal(e.hub.hello(id)!.relockMinutes, 15);
    const conv = e.app.store.createConversation({ title: 'Managers', mode: 'coding' }).id;
    received.length = 0;

    // 0. All off: no saved login by that name and no manager: refused before any card.
    e.app.script.push([call('a1', 'pc_browser_open', { url: `http://${HOST}:${P}/login` })], [call('a2', 'pc_browser_login', { login: 'Accounts' })], text('No.'));
    const t0 = await turn(conv, `sign me in at http://${HOST}:${P}/login`);
    assert.equal(t0.cards.length, 0);
    assert.match(t0.results[1].output, /No saved login called “Accounts”/);

    // The owner turns Bitwarden, 1Password and KeePassXC on in the app (after the warning).
    await ref.setManager('bitwarden', true);
    await ref.setManager('1password', true);
    await ref.setManager('keepassxc', true);
    await until(() => state('bitwarden') === 'locked' && state('keepassxc') === 'locked');
    const devText = (await api(e, 'GET', '/api/hands')).text;
    assert.match(devText, /"managers":\[\{"id":"bitwarden","name":"Bitwarden","installed":true,"on":true,"state":"locked"\}/);

    // 1. Locked: a card, then the person is asked to unlock it in its own prompt; filled; relocked after the task.
    e.app.script.push([call('b0', 'pc_devices', {})], [call('b1', 'pc_browser_open', { url: `http://${HOST}:${P}/login` })], [call('b2', 'pc_browser_login', { login: 'Accounts' })], [call('b3', 'pc_browser_look', {})], text('Signed in.'));
    const t1 = await turn(conv, `sign me in at http://${HOST}:${P}/login`);
    assert.match(t1.results[0].output, /the owner's password managers there: Bitwarden \(locked\), 1Password \(locked\), KeePassXC \(locked\)/);
    assert.equal(t1.cards.length, 1, 'one card for the sign-in');
    const card = t1.cards[0].computer!;
    assert.equal(card.action, 'login');
    assert.deepEqual(card.managers, ['Bitwarden', '1Password', 'KeePassXC']);
    assert.deepEqual(card.choices, ['once']);
    assert.match(t1.cards[0].summary, /sign in to accounts\.sara\.test:\d+ with your password manager \(Bitwarden, 1Password, KeePassXC\)/);
    assert.match(t1.results[2].output, /Filled the login from the owner’s Bitwarden on Test PC and pressed Enter/);
    assert.match(t1.results[3].output, /Signed in \(the right user\)/);
    assert.equal(ref.seen.filter((o) => o === 'b.unlock').length, 1, 'locked → the person was asked to unlock');
    assert.equal(who.seen.length, 1);
    assert.deepEqual(received.map((r) => [r.host, r.password]), [[`${HOST}:${P}`, BW_PASS]], 'the real site got the Bitwarden password (positive control)');
    await until(() => state('bitwarden') === 'locked');
    assert.ok(ref.seen.includes('b.relock'), 'after the task the server asked the computer to lock again');
    assert.ok(pm.ran.includes('bw lock'));

    // 2. Don't on the card: nothing unlocks, nothing fills.
    e.app.script.push([call('c1', 'pc_browser_login', { login: 'Accounts' })], text('OK.'));
    const t2 = await turn(conv, 'sign in again', () => false);
    assert.equal(t2.results[0].status, 'denied');
    assert.equal(who.seen.length, 1);
    assert.equal(received.length, 1);

    // 3. The person closes the unlock window: still locked, nothing filled, no retry.
    who.set('close');
    e.app.script.push([call('d1', 'pc_browser_login', { login: 'Accounts' })], text('It stays locked.'));
    const t3 = await turn(conv, 'sign in again please');
    assert.match(t3.results[0].output, /Bitwarden, 1Password, KeePassXC|Bitwarden/);
    assert.match(t3.results[0].output, /still locked .*never ask for a master password/);
    assert.equal(received.length, 1);
    who.set('type');

    // 4. Look-alikes get nothing on the device (Bitwarden's own loose matching offers its entries).
    for (const m of ['bitwarden', '1password', 'keepassxc'] as ManagerId[]) assert.equal(await pm.unlock(m, 'http://x'), true);
    for (const url of [`http://${HOST}:${Q}/login`, `http://${EVIL}:${P}/login`, `http://127.0.0.1:${P}/login`, `https://${HOST}:${P}/login`]) {
      if (url.startsWith('https')) continue; // nothing listens for https; the origin rule is checked above
      await op('b.open', { url });
      const r = await op('b.login', { name: 'Accounts', managers: true });
      assert.equal(r.outcome, 'not_found', url);
      assert.equal(JSON.stringify(r).includes(BW_PASS) || JSON.stringify(r).includes(LOOK_PASS), false);
    }
    assert.equal(received.length, 1, 'no look-alike got a sign-in');

    // 5. 1Password and KeePassXC for their own sites (unlocked now), and Sara's own saved login first.
    for (const [host, pass, source] of [[OPHOST, OP_PASS, '1password'], [KPHOST, KP_PASS, 'keepassxc']] as const) {
      await op('b.open', { url: `http://${host}:${P}/login` });
      const r = await op('b.login', { name: '', managers: true });
      assert.equal(r.outcome, 'filled', host);
      assert.equal(r.source, source);
      await until(() => received.at(-1)?.password === pass);
    }
    await op('b.open', { url: `http://${SAVEDHOST}:${P}/login` });
    const sv = await op('b.login', { name: 'whatever', managers: true });
    assert.equal(sv.source, 'saved', 'Sara\u2019s own saved login comes first');
    await until(() => received.at(-1)?.password === SAVED_PASS);
    const n = received.length;

    // 6. Stop (from the chat or Settings) locks them again on the computer.
    await api(e, 'POST', `/api/hands/${id}/stop`, {});
    await until(() => ['bitwarden', '1password', 'keepassxc'].every((m) => state(m as ManagerId) === 'locked'));
    assert.equal(pm.unlocked('bitwarden') || pm.unlocked('1password') || pm.unlocked('keepassxc'), false);
    // Locked on the device: b.login answers locked (names only).
    await op('b.open', { url: `http://${HOST}:${P}/login` });
    const lk = await op('b.login', { name: 'Accounts', managers: true });
    assert.deepEqual([lk.outcome, lk.managers], ['locked', ['bitwarden', '1password', 'keepassxc']]);
    // Stop on the computer itself, and "Lock now" from Settings.
    assert.equal(await pm.unlock('1password', 'http://x'), true);
    ref.pressStop();
    await until(() => !pm.unlocked('1password'));
    assert.equal(await pm.unlock('keepassxc', 'http://x'), true);
    await until(() => state('keepassxc') === 'unlocked');
    const ln = await api(e, 'POST', `/api/hands/${id}/relock`, {});
    assert.deepEqual([ln.json.ok, ln.json.locked], [true, ['keepassxc']]);

    // 7. Idle: locks again by itself after the idle time.
    pm.opts.relockMs = 500;
    assert.equal(await pm.unlock('keepassxc', 'http://x'), true);
    await until(() => state('keepassxc') === 'unlocked');
    await until(() => state('keepassxc') === 'locked', 6000);

    // 8. Turned off in the app: its session is forgotten, the server hears it, and it's never asked.
    pm.opts.relockMs = 15 * 60_000;
    assert.equal(await pm.unlock('1password', 'http://x'), true);
    await until(() => state('1password') === 'unlocked');
    await ref.setManager('1password', false);
    await until(() => state('1password') === 'off');
    assert.equal(pm.unlocked('1password'), false);
    assert.ok(pm.ran.filter((x) => x === 'op signout').length >= 3);
    await op('b.open', { url: `http://${OPHOST}:${P}/login` });
    const offR = await op('b.login', { name: '', managers: true });
    assert.deepEqual([offR.outcome, offR.managers], ['locked', ['bitwarden', 'keepassxc']], '1Password is no longer asked');
    assert.equal(received.length, n);
    await ref.setManager('bitwarden', false);
    await ref.setManager('keepassxc', false);
    await until(() => state('keepassxc') === 'off' && state('bitwarden') === 'off');
    e.app.script.push([call('h1', 'pc_browser_login', { login: 'Accounts' })], text('No.'));
    const t8 = await turn(conv, 'sign in once more');
    assert.equal(t8.cards.length, 0, 'every manager off: no card, as without managers');

    // THE PROOF. The fixture site got the passwords (above) but never: the hands channel (every frame
    // both ways), a model message, a run step, the conversation, the local log, the device's command
    // lines or any file of the server's data folder; nor the master passwords or the session keys.
    const sessions = who.seen.map((x) => x.stdout.trim()).filter((x) => x.length >= 8);
    assert.ok(sessions.length >= 4, 'the person unlocked several times');
    const wire = ref.wire.join('\n');
    assert.ok(wire.includes('"op":"b.login"') && wire.includes('"op":"b.unlock"') && wire.includes('"op":"b.relock"') && wire.length > 10_000, 'the capture saw the traffic');
    const files = allFiles(e.dir);
    assert.ok(files.length > 10_000);
    const places: [string, string][] = [
      ['the hands channel', wire],
      ['the model messages', JSON.stringify(e.app.requests)],
      ['the run steps', JSON.stringify(e.app.runs!.list({ conversationId: conv }).map((r) => e.app.runs!.steps(r.id)))],
      ['the conversation', JSON.stringify(e.app.store.messages(conv))],
      ['the server data folder', files],
      ['the local log', readFileSync(logFile, 'utf8')],
      ['the CLI command lines', pm.ran.join('\n')],
    ];
    for (const [where, haystack] of places) for (const s of [...SECRETS, ...sessions]) assert.equal(haystack.includes(s), false, `${where} has a secret (${s.slice(0, 6)}…)`);
    assert.match(readFileSync(logFile, 'utf8'), /signed in with Bitwarden/);
  } finally {
    await ref.stop();
    await e.close();
    pmDir.cleanup();
  }
});

test('the page, the apps and the conformance script know password managers', () => {
  const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
  const html = web('index.html');
  for (const id of ['cu-pm', 'cu-pm-list', 'cu-pm-relock']) assert.match(html, new RegExp(`id="${id}"`), id);
  const page = html.slice(html.indexOf('data-page="co-computer"'), html.indexOf('</section>', html.indexOf('data-page="co-computer"')));
  assert.ok(!/style=/.test(page));
  assert.match(page, /id="cu-pm-relock"[\s\S]{0,400}class="tip"/);
  assert.match(page, /Password managers <button type="button" class="tip"/);
  const app = web('app.js');
  assert.match(app, /wants to sign in to \{site\} with your password manager \(\{managers\}\)/);
  assert.match(app, /pmSet/);
  assert.match(app, /\/relock/);
  assert.match(web('sw.js'), /caches\.open\('sara-shell-v25'\)/);
  assert.match(web('sw.js'), /Phase 90 had caches\.open\('sara-shell-v24'\)/);
  assert.match(web('help.html'), /password manager/i);
  for (const f of ['desktop/windows/src/hands.cpp', 'desktop/mac/Sources/Hands.swift']) {
    const code = readFileSync(join(ROOT, f), 'utf8');
    for (const o of CU4B_OPS) assert.ok(code.includes(`"${o}"`), `${f}: ${o}`);
    for (const c of ['unlock', '--raw', 'list', 'items', '--url', 'signin', 'signout', 'export', 'csv', '--version']) assert.ok(code.includes(`"${c}"`), `${f}: ${c}`);
    assert.ok(code.includes('You unlock {manager} yourself, in its own window'), `${f}: the warning`);
    assert.ok(code.includes('SARA_PM_PATH'), `${f}: test runs look only in the test doubles' folder`);
  }
  const conf = readFileSync(join(ROOT, 'scripts', 'hands-conformance.ts'), 'utf8');
  assert.match(conf, /CU4b/);
  assert.match(conf, /--unlock-driver/);
  assert.ok(existsSync(join(ROOT, 'test', 'fixtures', 'fake-pm', 'fake-pm.mjs')));
});
