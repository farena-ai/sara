// Phase 87 (computer use CU1, docs/design/COMPUTER_USE.md §10.2): the hands conformance check.
// Phase 88 (CU2) adds the acting checks (section 8): find, click (ref, text, point), type, select,
// keys, scroll, upload, downloads, the after-state, stale refs, the device's refusals (password
// fields, secret-shaped text, keys off its list, long text, file names outside Downloads/Sara), the
// input rate limit and Stop within a second.
// Phase 89 (CU3) adds the dev tunnel (section 9): the server's built-in test page opened at
// http://127.0.0.1:<port> on the device through the tunnel (storage that persists across loads, a
// live WebSocket like hot reload, a 20 KB POST, a 300 KB file intact, no page errors), the tunnel
// listed, refused as a raw op, closed by the owner (the page no longer loads), and ended by Stop.
// Phase 90 (CU4) adds saved logins (section 10): names and sites only in hello and b.logins, nothing
// saved on Cancel or without the ticked "I understand", saved with it, filled through b.login on the
// exact site only (the fixture's sign-in really works), look-alike origins (another host, another port)
// get nothing, no password typed key by key, "Use what I just typed", "Your turn" (Continue and Stop),
// removal through the owner's Settings route. The device's own window is answered by the reference's
// stand-in (--ref) or by --consent-driver "<command>": run as `<command> <step>` while each window is
// open (steps: cancel, untick, save, typed, continue), with SARA_CU4_PIECES = the test password in
// comma-separated pieces (it drives the test build's window on that computer only).
// Phase 91 (CU4b) adds the owner's password managers (section 11), with test doubles of the Bitwarden and
// 1Password CLIs and a KeePassXC (the double, or the real keepassxc-cli with a new test database) whose
// entries are for the fixture's own sites: the managers listed by name and state only, locked → b.login
// answers locked, b.unlock opens the manager's own prompt and stays locked when the person closes it or
// types a wrong master password, unlocked → filled on the exact site (the fixture's sign-in really works),
// a look-alike origin gets nothing, the order (Bitwarden, then 1Password, then KeePassXC), b.relock, Stop
// and the idle time lock them again. The person at the prompt is the reference's stand-in (--ref) or
// --unlock-driver "<command>", run as `<command> <manager> <step>` while the prompt is open (steps: type,
// wrong, close) with SARA_CU4B_PIECES = that manager's test master password in comma-separated pieces.
// Phase 92 (CU5) adds desktop look (section 12, with --desktop): d.screens, d.windows (a fixture window
// listed with its title; the fixture "KeePass" window only as hidden; no Sara window at all), d.elements of the
// fixture window (its known text; its password field marked secret, the value nowhere in the answer), d.shot of
// that window (a picture, numbered marks with their list) and of the screen area where the fixture KeePass sits
// (black there), a stale viewId refused, one picture per 500 ms. The reference hands use their fixture desktop;
// for an app give --desktop-window "<fixture title>" --desktop-text "<text in it>" --desktop-blocked-area
// x,y,w,h (the fixture KeePass window, screen pixels) and SARA_CU5_SECRET = the fixture password field's value.
// Only fixture windows and that area are pictured: never anyone's whole screen.
// Before starting an app for this, make its doubles with --make-pm <dir> (prints the folders to put in
// SARA_PM_PATH and the config folders), with the same --fixture-port / --fixture-port3 as the run.
// Runs the command set against one hands device connected to a Sara server, through the owner's
// test route (POST /api/hands/<id>/op), with a local fixture site (a console error, an HTTP 500, a
// password field, a key-shaped text, a redirect to Sara's own server, a slow page). The same script
// checks the reference hands (--ref), the Windows app and the Mac app.
//
//   node scripts/hands-conformance.ts --server http://127.0.0.1:7881 --token-file <owner token file> [--device <name or id>] [--ref] [--json out.json] [--fixture-port N] [--fixture-port2 N] [--fixture-port3 N] [--consent-driver "<command>"] [--unlock-driver "<command>"] [--idle-seconds N]
//   node scripts/hands-conformance.ts --make-pm <dir> --fixture-port N --fixture-port3 N [--real-keepassxc <folder of keepassxc-cli>]
//
// The owner token is read from a file and never printed. Exit code 0 when every check passed.
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CU1_OPS, CU3_OPS, CU4_OPS, CU4B_OPS, CU5_OPS, HANDS_OPS } from '../src/hands.ts';
import { readPng, TestDesktop } from '../src/hands-desktop.ts';
import { decodeJpeg } from '../src/jpeg.ts';
import { HandsRef } from '../src/hands-ref.ts';
import type { ConsentAnswer } from '../src/hands-logins.ts';
import { commandLine, ManagerSessions, type ManagerId, type PromptRequest } from '../src/hands-managers.ts';
import { writeFakeManagers, type FakeFixture } from '../test/fixtures/fake-pm/make.ts';

// Phase 91: the password managers' test entries and master passwords, obviously fake, built in pieces.
const PM_USER = 'conformance-' + 'pm-' + 'user';
const PM_PASS: Record<ManagerId, string> = { bitwarden: 'conf-' + 'bw-' + 'Pw1', '1password': 'conf-' + 'op-' + 'Pw2', keepassxc: 'conf-' + 'kp-' + 'Pw3' };
const PM_MASTER_PIECES: Record<ManagerId, string[]> = { bitwarden: ['conf-', 'master-', 'bw9'], '1password': ['conf-', 'master-', 'op8'], keepassxc: ['conf-', 'master-', 'kp7'] };
const PM_MASTER = (m: ManagerId) => PM_MASTER_PIECES[m].join('');
/** Each manager's entry is for its own fixture origin (so each one is the only match there). */
function pmFixture(port: number, port3: number): FakeFixture {
  return {
    bitwarden: { master: PM_MASTER('bitwarden'), items: [{ name: 'Conformance PM', uri: `http://127.0.0.1:${port}`, username: PM_USER, password: PM_PASS.bitwarden }] },
    '1password': { master: PM_MASTER('1password'), items: [{ id: 'conf0001', title: 'Conformance PM', url: `http://localhost:${port}/login`, username: PM_USER, password: PM_PASS['1password'] }] },
    keepassxc: { master: PM_MASTER('keepassxc'), entries: [{ title: 'Conformance PM', url: `http://127.0.0.1:${port3}`, username: PM_USER, password: PM_PASS.keepassxc }] },
  };
}
/** --make-pm: the doubles (and optionally a real KeePassXC test database) for an app started afterwards. */
function makePm(dir: string, port: number, port3: number, realKpx?: string): Record<string, unknown> {
  const fx = pmFixture(port, port3);
  const made = writeFakeManagers(dir, fx);
  const out: Record<string, unknown> = { ...made, search: [made.bin] };
  if (realKpx) {
    const cli = join(realKpx, process.platform === 'win32' ? 'keepassxc-cli.exe' : 'keepassxc-cli');
    const db = join(dir, 'conformance.kdbx');
    const cfg = join(dir, 'kpx-config');
    mkdirSync(cfg, { recursive: true });
    const env = { ...process.env, APPDATA: cfg, LOCALAPPDATA: cfg, XDG_CONFIG_HOME: cfg, HOME: cfg };
    rmSync(db, { force: true });
    const e = fx.keepassxc!.entries[0];
    const a = spawnSync(cli, ['db-create', '--set-password', db], { input: `${PM_MASTER('keepassxc')}\n${PM_MASTER('keepassxc')}\n`, env });
    const b = spawnSync(cli, ['add', '-u', e.username, '--url', e.url, '-p', db, e.title], { input: `${PM_MASTER('keepassxc')}\n${e.password}\n`, env });
    if (a.status !== 0 || b.status !== 0) throw new Error('could not make the KeePassXC test database');
    // The real CLI first: its folder goes before the doubles' (whose keepassxc-cli is then unused).
    rmSync(join(made.bin, process.platform === 'win32' ? 'keepassxc-cli.cmd' : 'keepassxc-cli'), { force: true });
    out.search = [made.bin, realKpx];
    out.keepassDb = db;
    out.kpxConfig = cfg;
  }
  return out;
}
if (process.argv.includes('--make-pm')) {
  const a = (k: string) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const dir = a('--make-pm')!;
  console.log(JSON.stringify(makePm(dir, Number(a('--fixture-port')), Number(a('--fixture-port3')), a('--real-keepassxc')), null, 2));
  process.exit(0);
}

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const server = (arg('--server') ?? '').replace(/\/+$/, '');
const tokenFile = arg('--token-file');
if (!server || !tokenFile) {
  console.error('Usage: node scripts/hands-conformance.ts --server http://127.0.0.1:7881 --token-file <owner token file> [--device <name or id>] [--ref] [--json out.json] [--fixture-host <ip the device can reach>] [--fixture-port N]');
  process.exit(2);
}
const owner = readFileSync(tokenFile, 'utf8').trim();
// A fake key built in pieces (never a real one): the device must mask it in what it sends back.
const FAKE_KEY = 'sk-' + 'conformance' + 'Fixture0123456789';
const PASSWORD = 'correct-' + 'horse-battery';
// Phase 90: the saved login's test password and user name, obviously fake, built in pieces.
const LOGIN_PIECES = ['conf-', 'login-', 'Pw7x'];
const LOGIN_PASSWORD = LOGIN_PIECES.join('');
const LOGIN_USER = 'conformance-' + 'user';
/** What the fixture's sign-in got (the host it was sent to and whether the password was right). */
const signIns: { host: string; right: boolean }[] = [];

// ---- the fixture site ----
function fixture(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  const html = (title: string, body: string) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`);
  };
  if (url.pathname === '/api/data') {
    res.writeHead(500, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ error: 'database is down', key: FAKE_KEY }));
  }
  if (url.pathname === '/to-sara') {
    res.writeHead(302, { location: `${server}/` });
    return void res.end();
  }
  if (url.pathname === '/slow') return void setTimeout(() => html('Slow', '<p>late</p>'), 15_000);
  if (url.pathname === '/page2') return html('Second page', '<h1>Second page</h1><p>Page two text.</p>');
  // Phase 90: a sign-in form, and a button that signs in like a person (for "Use what I just typed").
  if (req.method === 'POST' && url.pathname === '/session') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const f = new URLSearchParams(body);
      const right = (f.get('password') === LOGIN_PASSWORD && f.get('username') === LOGIN_USER) || (Object.values(PM_PASS).includes(f.get('password') ?? '') && f.get('username') === PM_USER);
      signIns.push({ host: String(req.headers.host ?? ''), right });
      html(right ? 'Signed in' : 'Wrong', right ? '<h1>Signed in (the right user)</h1>' : '<h1 role="alert">Wrong username or password</h1>');
    });
    return;
  }
  if (url.pathname === '/login')
    return html(
      'Sara hands sign-in',
      `<h1>Sign in</h1><form method="post" action="/session">
<label>Username <input name="username" autocomplete="username"></label>
<label>Password <input type="password" name="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button></form>
<button type="button" id="person">Type it like a person</button>
<script>document.getElementById('person').onclick=function(){var f=document.forms[0];f.username.value=${JSON.stringify(LOGIN_USER)};f.password.value=${JSON.stringify(LOGIN_PASSWORD)};f.requestSubmit();};</script>`,
    );
  if (req.method === 'POST' && url.pathname === '/submit') {
    req.resume();
    res.writeHead(500, { 'content-type': 'text/html' });
    return void res.end('<!doctype html><title>Error</title><h1>Internal Server Error</h1><p role="alert">the form could not be saved</p>');
  }
  if (url.pathname === '/form')
    return html(
      'Sara hands form',
      `<h1>Form</h1><form method="post" action="/submit">
<label>Name <input name="name"></label>
<label>Topic <select name="topic"><option>General</option><option>Billing</option></select></label>
<label>Password <input type="password" name="pw"></label>
<label>Attachment <input type="file" name="file" onchange="document.getElementById('picked').textContent=this.files[0].name"></label>
<p id="picked">nothing picked</p>
<button type="button" onclick="var c=document.getElementById('count');c.textContent=Number(c.textContent)+1">Add one</button> <span id="count">0</span>
<a href="/slow">Slow page</a>
<div style="height:1600px"></div>
<button type="submit">Submit</button></form>`,
    );
  html(
    'Sara hands fixture',
    `<h1>Hello from the fixture</h1>
<p>Status: ready. Key on screen: ${FAKE_KEY}</p>
<form><label>Email <input type="email" name="email" value="alex@example.com"></label>
<label>Password <input type="password" name="pw" value="${PASSWORD}"></label>
<button type="button" id="go">Sign in</button></form>
<a href="/page2">Next page</a>
<script>console.error('Boom: the widget failed to load'); fetch('/api/data').catch(function () {});</script>`,
  );
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const r = await fetch(`${server}${path}`, { method, headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
}

async function main(): Promise<number> {
  const fx = createServer(fixture);
  const host = arg('--fixture-host') ?? '127.0.0.1';
  // --fixture-port: a fixed port (e.g. forwarded to another computer with ssh -R).
  await new Promise<void>((r) => fx.listen(Number(arg('--fixture-port') ?? 0), host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0', r));
  const base = `http://${host}:${(fx.address() as AddressInfo).port}`;
  // Phase 90: the same site on another port (a look-alike origin for saved logins).
  const fx2 = createServer(fixture);
  await new Promise<void>((r) => fx2.listen(Number(arg('--fixture-port2') ?? 0), host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0', r));
  const base2 = `http://${host}:${(fx2.address() as AddressInfo).port}`;
  // Phase 91: a third origin (KeePassXC's entry is for it).
  const fx3 = createServer(fixture);
  await new Promise<void>((r) => fx3.listen(Number(arg('--fixture-port3') ?? 0), host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0', r));
  const port1 = (fx.address() as AddressInfo).port;
  const port3 = (fx3.address() as AddressInfo).port;
  const base3 = `http://${host}:${port3}`;
  // The reference's stand-in for the person at the manager's own prompt.
  let pmStep: 'type' | 'wrong' | 'close' = 'type';
  const refPrompt = (req: PromptRequest) =>
    new Promise<{ stdout: string; code: number }>((resolve) => {
      const [cmd, argv, verbatim] = commandLine(req.command, req.args);
      const child = spawn(cmd, argv, { env: req.env, windowsVerbatimArguments: verbatim, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
      child.on('close', (code) => resolve({ stdout: out, code: code ?? 1 }));
      if (pmStep === 'close') child.kill();
      else child.stdin!.end(`${pmStep === 'wrong' ? 'not-' + 'it' : PM_MASTER(req.manager)}\n`);
    });
  let refPmDir = '';
  // The reference hands' stand-in for the consent window: answers as the step says.
  let refStep = '';
  const refConsent = async (): Promise<ConsentAnswer> => {
    const step = refStep;
    if (step === 'save') return { save: true, understood: true, name: 'Conformance', username: LOGIN_USER, password: LOGIN_PASSWORD };
    if (step === 'untick') return { save: true, understood: false, name: 'Conformance', username: LOGIN_USER, password: LOGIN_PASSWORD };
    if (step === 'typed') return { save: true, understood: true, useTyped: true, name: 'Conformance typed' };
    return { save: false, understood: false };
  };
  let ref: HandsRef | undefined;
  let deviceId = '';
  try {
    if (process.argv.includes('--ref')) {
      const pair = await api('POST', '/api/hands/pair', { name: 'Conformance (hands-ref)', token: owner });
      if (pair.status !== 200) throw new Error(`pairing the reference hands failed: HTTP ${pair.status} ${pair.json.error ?? ''}`);
      // Phase 91: the reference gets the doubles (in a temporary folder) and the person turns them on.
      refPmDir = mkdtempSync(join(tmpdir(), 'sara-conf-pm-'));
      const made = makePm(refPmDir, port1, port3);
      const managers = new ManagerSessions({ search: made.search as string[], env: made.env as Record<string, string>, keepassDb: String(made.keepassDb), prompt: refPrompt, relockMs: Number(arg('--idle-seconds') ?? 20) * 1000 });
      ref = new HandsRef({ server, token: String(pair.json.token), name: 'Conformance (hands-ref)', consent: refConsent, managers, ...(process.argv.includes('--desktop') ? { desktop: new TestDesktop(), optIn: { browser: true, desktop: true } } : {}) });
      await ref.start();
      for (const m of ['bitwarden', '1password', 'keepassxc'] as ManagerId[]) await ref.setManager(m, true);
      deviceId = String(pair.json.id);
      await new Promise((r) => setTimeout(r, 300));
    }
    const list = await api('GET', '/api/hands');
    if (list.status !== 200) throw new Error(`GET /api/hands: HTTP ${list.status}`);
    const want = (arg('--device') ?? '').toLowerCase();
    const devices = (list.json.devices ?? []) as Record<string, any>[];
    const dev = deviceId ? devices.find((d) => d.id === deviceId) : devices.find((d) => d.connected && (!want || d.id === want || String(d.label).toLowerCase().includes(want) || String(d.computer ?? '').toLowerCase().includes(want)));
    if (!dev) throw new Error(`no connected hands device${want ? ` matching "${want}"` : ''} (connected: ${devices.filter((d) => d.connected).map((d) => d.label).join(', ') || 'none'})`);
    deviceId = dev.id;
    console.log(`Device: ${dev.label} · ${dev.app} · ${dev.os ?? ''} · browser ${dev.browser?.name ?? '?'}\nFixture: ${base}\n`);
    const op = async (name: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => (await api('POST', `/api/hands/${deviceId}/op`, { op: name, args, ...extra })).json;

    // 1. hello
    const browserOps = HANDS_OPS.filter((o) => !(CU5_OPS as readonly string[]).includes(o));
    check('hello: connected, protocol 1, the CU1 + CU2 + CU3 + CU4 + CU4b command set, browser opt-in on', dev.connected === true && Array.isArray(dev.ops) && browserOps.every((o) => dev.ops.includes(o)) && CU1_OPS.every((o) => dev.ops.includes(o)) && dev.optIn?.browser === true, `ops: ${(dev.ops ?? []).join(' ')}`);
    check('hello: nothing beyond CU5 advertised (no scripts, no op that reads a password, no desktop input)', Array.isArray(dev.ops) && dev.ops.every((o: string) => (HANDS_OPS as readonly string[]).includes(o)) && !dev.ops.some((o: string) => /^b\.(evaluate|eval|script)|^d\.(click|type|keys|scroll|drag|launch|focus)|^p\./.test(o)), '');
    check('hello: the takeover choice and the stop shortcut', dev.takeover === 'pause' || dev.takeover === 'keep', `takeover ${dev.takeover ?? '?'}, shortcut ${dev.hotkey || '(none)'}`);
    const ping = await op('c.ping');
    check('c.ping', ping.ok === true && ping.result?.pong === true);
    const start = await op('b.start');
    check('b.start: the Sara browser runs', start.ok === true, start.ok ? `${start.result?.browser?.name ?? ''}` : start.error?.message);

    // 2. open + logs
    const opened = await op('b.open', { url: `${base}/`, thumb: 320 });
    const r = opened.result ?? {};
    check('b.open: the fixture loads (HTTP 200, its title)', opened.ok === true && r.status === 200 && r.title === 'Sara hands fixture', opened.ok ? `${r.status} ${r.title}` : opened.error?.message);
    check('b.open: counts the console error and the failed request', Number(r.consoleErrors) >= 1 && Number(r.failedRequests) >= 1, `console ${r.consoleErrors}, network ${r.failedRequests}`);
    const thumb = (opened.images ?? []).find((i: any) => i.kind === 'thumb');
    check('b.open: a step thumbnail (JPEG ≤ 320 px wide)', Boolean(thumb) && thumb.mime === 'image/jpeg' && Number(thumb.w) <= 320 && Number(thumb.bytes) > 200, thumb ? `${thumb.w}×${thumb.h}, ${thumb.bytes} bytes` : 'none');
    await new Promise((res) => setTimeout(res, 600));
    const logs = await op('b.logs', {});
    const entries = (logs.result?.entries ?? []) as Record<string, any>[];
    const consoleErr = entries.find((e) => (e.kind === 'console' || e.kind === 'exception') && /Boom: the widget failed/.test(e.text));
    const net500 = entries.find((e) => e.kind === 'network' && e.status === 500 && /\/api\/data/.test(e.url));
    check('b.logs: the console error', Boolean(consoleErr), consoleErr ? consoleErr.text : JSON.stringify(entries).slice(0, 200));
    check('b.logs: the HTTP 500 with method, address and request id', Boolean(net500?.requestId) && net500?.method === 'GET', net500 ? `${net500.method} ${net500.url} → ${net500.status}` : 'missing');
    const since = await op('b.logs', { since: logs.result?.last ?? 0 });
    check('b.logs since: only newer entries', since.ok === true && (since.result?.entries ?? []).length === 0);
    if (net500?.requestId) {
      const body = await op('b.request', { requestId: net500.requestId });
      check('b.request: the response body, text', body.ok === true && /database is down/.test(String(body.result?.body)), String(body.result?.body ?? body.error?.message).slice(0, 80));
      check('b.request: a key-shaped value in it is masked', body.ok === true && !String(body.result?.body).includes(FAKE_KEY));
    } else check('b.request: the response body, text', false, 'no request id');

    // 3. look / read
    const snap = await op('b.snapshot', {});
    const items = (snap.result?.items ?? []) as Record<string, any>[];
    const pw = items.find((i) => i.role === 'password' || i.secret);
    check('b.snapshot: numbered refs with roles (heading, fields, button, link)', snap.ok === true && items[0]?.ref === 'e1' && ['heading', 'button', 'link'].every((role) => items.some((i) => i.role === role)), `${items.length} items`);
    check('b.snapshot: the password field never shows its value', Boolean(pw) && pw!.secret === true && pw!.value === undefined && !JSON.stringify(snap).includes(PASSWORD));
    check('b.snapshot: a viewId and the page size', typeof snap.result?.viewId === 'string' && Number(snap.result?.width) > 0);
    const read = await op('b.read', {});
    const text = String(read.result?.text ?? '');
    check('b.read: the visible text', read.ok === true && /Hello from the fixture/.test(text) && /Status: ready/.test(text), text.slice(0, 60).replace(/\n/g, ' '));
    check('b.read: no password, the key masked', !text.includes(PASSWORD) && !text.includes(FAKE_KEY) && /\[hidden\]/.test(text));
    const one = await op('b.read', { ref: items.find((i) => i.role === 'heading')?.ref ?? 'e1' });
    check('b.read ref: one element', one.ok === true && /Hello from the fixture/.test(String(one.result?.text)));
    const pwRead = pw ? await op('b.read', { ref: pw.ref }) : { ok: true };
    check('b.read of the password field is refused', pwRead.ok === false && !JSON.stringify(pwRead).includes(PASSWORD), pwRead.ok ? 'it answered' : pwRead.error?.code);

    // 4. pictures
    const shot = await op('b.screenshot', { maxWidth: 800, quality: 60 });
    const img = (shot.images ?? [])[0];
    check('b.screenshot: a JPEG at most 800 px wide, with a viewId', shot.ok === true && img?.mime === 'image/jpeg' && Number(img.w) <= 800 && Number(img.bytes) > 500 && typeof shot.result?.viewId === 'string', img ? `${img.w}×${img.h}, ${img.bytes} bytes` : shot.error?.message);
    const frame = await api('GET', `/api/computer/frame/${deviceId}?after=0`);
    check('live view: a frame reached the server (memory only)', typeof frame.json.image === 'string' && frame.json.image.startsWith('data:image/jpeg'), `frame #${frame.json.n}`);

    // 5. tabs and navigation
    const tabs = await op('b.tabs');
    check('b.tabs: lists the fixture tab', tabs.ok === true && (tabs.result?.tabs ?? []).some((t: any) => String(t.url).startsWith(base)));
    const p2 = await op('b.open', { url: `${base}/page2` });
    const back = await op('b.navigate', { action: 'back' });
    check('b.navigate back', p2.ok === true && back.ok === true && back.result?.title === 'Sara hands fixture', back.ok ? back.result?.title : back.error?.message);
    const fwd = await op('b.navigate', { action: 'forward' });
    check('b.navigate forward', fwd.ok === true && fwd.result?.title === 'Second page', fwd.ok ? fwd.result?.title : fwd.error?.message);
    const reload = await op('b.navigate', { action: 'reload' });
    check('b.navigate reload', reload.ok === true);
    const nt = await op('b.open', { url: `${base}/page2`, newTab: true });
    const closed = nt.ok ? await op('b.close', { tab: nt.result?.tab }) : nt;
    check('b.open newTab + b.close', nt.ok === true && closed.ok === true);

    // 6. refused on the device
    for (const [o, a] of [['p.unlock', { manager: 'x' }], ['d.click', { x: 1, y: 1 }], ['d.type', { text: 'x' }], ['b.evaluate', { expression: '1+1' }]] as [string, Record<string, unknown>][]) {
      const x = await op(o, a);
      check(`refused on the device: ${o} (not in the command set)`, x.ok === false && x.error?.code === 'unsupported', x.ok ? 'it ran' : x.error?.code);
    }
    for (const u of [`${server}/`, `${server}/api/session`, 'file:///C:/Windows/win.ini', 'chrome://settings', 'edge://settings', 'javascript:alert(1)', 'data:text/html,hi', `http://user:pw@127.0.0.1:1/`]) {
      const x = await op('b.open', { url: u });
      check(`refused on the device: open ${u.slice(0, 40)}`, x.ok === false && x.error?.code === 'denied_local', x.ok ? 'it opened' : x.error?.code);
    }
    const mark = (await op('b.logs', {})).result?.last ?? 0;
    const redir = await op('b.open', { url: `${base}/to-sara` });
    const blockedLog = ((await op('b.logs', { since: mark })).result?.entries ?? []).find((e: any) => /blocked/i.test(String(e.error ?? '')) && String(e.url).startsWith(server));
    const loadedSara = redir.ok === true && redir.result?.status === 200 && String(redir.result?.url).startsWith(server);
    check('a redirect to Sara\u2019s own server is blocked by the device', !loadedSara && Boolean(blockedLog), loadedSara ? `loaded ${redir.result?.url}` : blockedLog ? 'blocked (in the logs)' : 'no block in the logs');

    // 7. protocol behaviour
    const fixed = `conf-${Date.now().toString(36)}`;
    const d1 = await op('c.ping', {}, { id: fixed });
    const d2 = await op('c.ping', {}, { id: fixed });
    check('duplicate request id: the same answer', d1.ok === true && JSON.stringify(d1.result) === JSON.stringify(d2.result), `${d1.result?.at} / ${d2.result?.at}`);
    const t0 = Date.now();
    const slow = await op('b.open', { url: `${base}/slow` }, { deadlineMs: 2500 });
    check('deadline: a slow page ends with timeout', slow.ok === false && /timeout|stopped/.test(String(slow.error?.code)) && Date.now() - t0 < 12_000, `${slow.error?.code} after ${Date.now() - t0} ms${slow.ok ? '' : `: ${String(slow.error?.message).slice(0, 80)}`}`);
    const alive = await op('c.ping');
    check('still answering after a timeout', alive.ok === true);

    // 8. Phase 88 (CU2): acting. Actions are spaced (the device allows 4 a second).
    const pause = (ms = 300) => new Promise((res) => setTimeout(res, ms));
    const act = async (name: string, args: Record<string, unknown> = {}) => {
      await pause();
      return op(name, args);
    };
    const fo = await op('b.open', { url: `${base}/form` });
    check('CU2: the form page opens', fo.ok === true && fo.result?.title === 'Sara hands form', fo.ok ? fo.result?.title : fo.error?.message);
    const f1 = await op('b.find', { text: 'Name', field: true });
    check('b.find: a field by its label (what it is, where, the page)', f1.ok === true && f1.result?.found === true && f1.result?.role === 'textbox' && Number(f1.result?.x) > 0 && String(f1.result?.page?.url).endsWith('/form'), f1.ok ? `${f1.result?.role} ${f1.result?.name}` : f1.error?.message);
    const ty = await act('b.type', { text: 'Name', field: true, value: 'Ada', clear: true });
    check('b.type: types into the field (a real click first), with the after-state', ty.ok === true && typeof ty.result?.state?.url === 'string' && ty.result?.navigated === false, ty.ok ? '' : ty.error?.message);
    const se = await act('b.select', { text: 'Topic', field: true, option: 'Billing' });
    check('b.select: chooses an option', se.ok === true && se.result?.selected === 'Billing', se.ok ? se.result?.selected : se.error?.message);
    const sn = await op('b.snapshot', {});
    const its = (sn.result?.items ?? []) as Record<string, any>[];
    check('the look shows what was typed and chosen', its.some((i) => i.role === 'textbox' && i.value === 'Ada') && its.some((i) => i.role === 'combobox' && i.value === 'Billing'));
    const addOne = its.find((i) => i.name === 'Add one');
    const ck = addOne ? await act('b.click', { ref: addOne.ref, expect: 'button|add one', thumb: 320 }) : { ok: false, error: { message: 'no Add one' } };
    const afterClick = String((await op('b.read', {})).result?.text ?? '');
    check('b.click by ref: a real click (the page counted it), a thumbnail', ck.ok === true && /Add one 1/.test(afterClick) && (ck.images ?? []).some((i: any) => i.kind === 'thumb'), ck.ok ? afterClick.match(/Add one \d+/)?.[0] : ck.error?.message);
    const stale = addOne ? await act('b.click', { ref: addOne.ref, expect: 'button|place order' }) : { ok: false, error: { code: 'none' } };
    check('b.click on a ref that changed: stale_view (nothing clicked)', stale.ok === false && stale.error?.code === 'stale_view', stale.ok ? 'it clicked' : stale.error?.code);
    const ft = await op('b.find', { text: 'Add one' });
    const shotNow = await op('b.screenshot', { maxWidth: 640, quality: 50 });
    const sw = Number(shotNow.result?.w) || 0;
    const sh = Number(shotNow.result?.h) || 0;
    const vw = Number(sn.result?.width) || 1;
    const vh = Number(sn.result?.height) || 1;
    const pt = await act('b.click', { x: (Number(ft.result?.x) * sw) / vw, y: (Number(ft.result?.y) * sh) / vh, w: sw, h: sh });
    check('b.click at a point of a screenshot (picture pixels mapped to the page)', pt.ok === true && /Add one 2/.test(String((await op('b.read', {})).result?.text)), pt.ok ? '' : pt.error?.message);
    const kOk = await act('b.keys', { combo: 'Shift+Tab' });
    const kBad = await act('b.keys', { combo: 'Win+R' });
    check('b.keys: keys on the list work; anything else is refused on the device', kOk.ok === true && kBad.ok === false && kBad.error?.code === 'denied_local', `${kOk.ok ? 'ok' : kOk.error?.message} / ${kBad.ok ? 'it pressed Win+R' : kBad.error?.code}`);
    const pwT = await act('b.type', { text: 'Password', field: true, value: PASSWORD });
    check('b.type into a password field is refused on the device', pwT.ok === false && pwT.error?.code === 'denied_local' && !JSON.stringify(pwT).includes(PASSWORD), pwT.ok ? 'it typed' : pwT.error?.code);
    const secT = await act('b.type', { text: 'Name', field: true, value: FAKE_KEY });
    check('b.type of key-shaped text is refused on the device', secT.ok === false && secT.error?.code === 'denied_local', secT.ok ? 'it typed' : secT.error?.code);
    const longT = await act('b.type', { text: 'Name', field: true, value: 'x'.repeat(2001) });
    check('b.type of more than 2,000 characters is refused', longT.ok === false && longT.error?.code === 'denied_local', longT.ok ? 'it typed' : longT.error?.code);
    const up = await act('b.upload', { text: 'Attachment', field: true, file: { name: 'conformance.txt', data: Buffer.from('hello from the conformance check').toString('base64') } });
    check('b.upload: a file from the server goes through Downloads/Sara into the field', up.ok === true && /conformance\.txt/.test(String((await op('b.read', {})).result?.text)), up.ok ? up.result?.name : up.error?.message);
    const upBad = await act('b.upload', { text: 'Attachment', field: true, name: '../../Windows/win.ini' });
    check('b.upload of a file outside Downloads/Sara is refused', upBad.ok === false && upBad.error?.code === 'denied_local', upBad.ok ? 'it uploaded' : upBad.error?.code);
    const dl = await op('b.downloads', {});
    check('b.downloads: lists Downloads/Sara', dl.ok === true && (dl.result?.files ?? []).some((f: any) => f.name === 'conformance.txt'), dl.ok ? `${(dl.result?.files ?? []).length} files` : dl.error?.message);
    const sc = await act('b.scroll', { dy: 600 });
    check('b.scroll: scrolls the page', sc.ok === true && Number(sc.result?.scrollY) > 0, sc.ok ? `${sc.result?.scrollY}/${sc.result?.maxY}` : sc.error?.message);
    const sub = await act('b.click', { text: 'Submit' });
    check('after-state: submitting shows the new page, its message and the failed POST', sub.ok === true && sub.result?.navigated === true && Number(sub.result?.newFailed) >= 1 && JSON.stringify(sub.result?.state ?? {}).includes('could not be saved'), sub.ok ? `navigated ${sub.result?.navigated}, new failed ${sub.result?.newFailed}` : sub.error?.message);
    await pause(1100);
    const burst = await Promise.all([1, 2, 3, 4, 5, 6].map(() => op('b.scroll', { dy: 10 })));
    check('rate limit: at most 4 actions a second on the device', burst.some((x) => x.ok === false && x.error?.code === 'rate_limited') && burst.some((x) => x.ok === true), burst.map((x) => (x.ok ? 'ok' : x.error?.code)).join(' '));
    await pause(1100);
    await op('b.open', { url: `${base}/form` });
    const slowClick = act('b.click', { text: 'Slow page' });
    await pause(900);
    const t1 = Date.now();
    await api('POST', `/api/hands/${deviceId}/stop`, {});
    const stopped = await slowClick;
    check('Stop cancels a running action within a second', stopped.ok === false && /stopped/.test(String(stopped.error?.code)) && Date.now() - t1 < 1000, `${stopped.ok ? 'it finished' : stopped.error?.code} after ${Date.now() - t1} ms`);
    const tp = Date.now();
    const live = await op('c.ping');
    check('the device is free again at once after Stop (the action really ended there)', live.ok === true && Date.now() - tp < 1500, `${Date.now() - tp} ms`);

    // 9. Phase 89 (CU3): the dev tunnel, with the server's built-in test page.
    check('CU3: the device has c.tunnel and c.untunnel', CU3_OPS.every((o) => (dev.ops ?? []).includes(o)));
    const raw = await op('c.tunnel', { tunnel: 'abcdef0123456789', port: 5173 });
    check('c.tunnel is never a raw op (only the server opens tunnels, after its port check)', raw.ok === false && raw.error?.code === 'server_only', raw.ok ? 'it opened' : raw.error?.code);
    const tt = await api('POST', `/api/hands/${deviceId}/tunnel-test`, {});
    const tv = (tt.json.tunnel ?? {}) as Record<string, any>;
    check('tunnel: the device opens a loopback port for it', tt.json.ok === true && /^http:\/\/127\.0\.0\.1:\d+$/.test(String(tv.url)) && Number(tv.localPort) >= 1024, tt.json.ok ? String(tv.url) : `${tt.json.error?.code}: ${tt.json.error?.message}`);
    if (tt.json.ok) {
      const listed = await api('GET', `/api/hands/${deviceId}/tunnels`);
      check('tunnel: listed for the owner', (listed.json.tunnels ?? []).some((x: any) => x.id === tv.id && x.kind === 'test'));
      const t1 = await op('b.open', { url: `${tv.url}/` });
      check('tunnel: the page loads at its real 127.0.0.1 address', t1.ok === true && t1.result?.title === 'Sara dev tunnel test' && t1.result?.status === 200 && String(t1.result?.url).startsWith(`${tv.url}/`), t1.ok ? `${t1.result?.status} ${t1.result?.url}` : t1.error?.message);
      let text1 = '';
      for (let i = 0; i < 40 && !/All checks passed/.test(text1); i++) {
        await pause(250);
        text1 = String((await op('b.read', {})).result?.text ?? '');
      }
      check('tunnel: storage works (localStorage at a real origin)', /Storage: works \(visit \d+\)/.test(text1), text1.match(/Storage: [^\n]*/)?.[0] ?? text1.slice(0, 80));
      check('tunnel: a WebSocket through it works (what hot reload needs)', /Live connection: works/.test(text1), text1.match(/Live connection: [^\n]*/)?.[0] ?? '');
      check('tunnel: a 20 KB POST and a 300 KB file cross it intact', /Sending data: works/.test(text1) && /Large file: arrived intact \(307200 bytes\)/.test(text1), `${text1.match(/Sending data: [^\n]*/)?.[0] ?? ''} / ${text1.match(/Large file: [^\n]*/)?.[0] ?? ''}`);
      const visits1 = Number(text1.match(/visit (\d+)/)?.[1] ?? 0);
      const t2 = await op('b.navigate', { action: 'reload' });
      let text2 = '';
      for (let i = 0; i < 40 && !/All checks passed/.test(text2); i++) {
        await pause(250);
        text2 = String((await op('b.read', {})).result?.text ?? '');
      }
      const visits2 = Number(text2.match(/visit (\d+)/)?.[1] ?? 0);
      check('tunnel: storage is kept across a reload (the same origin each time)', t2.ok === true && visits2 === visits1 + 1, `visit ${visits1} → ${visits2}`);
      const tl = await op('b.logs', {});
      check('tunnel: no console errors or failed requests on the test page', tl.ok === true && !(tl.result?.entries ?? []).some((e: any) => e.kind === 'exception' || (e.kind === 'console' && e.level === 'error') || e.kind === 'network'), JSON.stringify(tl.result?.entries ?? []).slice(0, 160));
      const del = await api('DELETE', `/api/hands/${deviceId}/tunnels/${tv.id}`);
      await pause(400);
      const after = await op('b.open', { url: `${tv.url}/` }, { deadlineMs: 15_000 });
      check('tunnel: closed by the owner, the address no longer answers', del.status === 200 && (after.ok === false || after.result?.title !== 'Sara dev tunnel test'), after.ok ? `title ${after.result?.title}` : String(after.error?.message).slice(0, 80));
      const again = await api('POST', `/api/hands/${deviceId}/tunnel-test`, {});
      await api('POST', `/api/hands/${deviceId}/stop`, {});
      await pause(400);
      const gone = await api('GET', `/api/hands/${deviceId}/tunnels`);
      check('tunnel: Stop ends the tunnels on that computer', again.json.ok === true && (gone.json.tunnels ?? []).length === 0, `${(gone.json.tunnels ?? []).length} left`);
    }

    // 10. Phase 90 (CU4): saved logins (names and sites only; the password stays on the computer)
    {
      check('CU4: the device has the saved-login ops', CU4_OPS.every((o) => (dev.ops ?? []).includes(o)));
      const onlyViews = (list: unknown) => Array.isArray(list) && (list as Record<string, unknown>[]).every((l) => typeof l.name === 'string' && Array.isArray(l.sites) && !('password' in l) && !('username' in l));
      check('CU4: hello carries the logins as names and sites only, and the vault kind', onlyViews(dev.logins) && ['dpapi', 'keychain', 'test'].includes(String(dev.vault?.kind)), `${(dev.logins ?? []).length} saved, vault ${dev.vault?.kind ?? '?'}${dev.vault?.verify ? ' (asks first)' : ''}`);
      const driver = arg('--consent-driver');
      // Runs an op that opens the device's own window while it is answered (the reference's stand-in or the driver).
      const withWindow = async (step: string, name: string, args: Record<string, unknown>) => {
        refStep = step;
        let drove: Promise<number> = Promise.resolve(0);
        if (!ref && driver) {
          drove = new Promise((resolve) => {
            const child = spawn(`${driver} ${step}`, { shell: true, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, SARA_CU4_PIECES: LOGIN_PIECES.join(','), SARA_CU4_USER: LOGIN_USER } });
            child.on('exit', (code) => resolve(code ?? 1));
          });
        }
        if (ref && step === 'continue') setTimeout(() => ref?.continueTurn(), 800);
        const [r] = await Promise.all([op(name, args, { deadlineMs: driver || ref ? 120_000 : 4000 }), drove]);
        return r;
      };
      await op('b.forgetLogin', { name: 'Conformance' });
      await op('b.forgetLogin', { name: 'Conformance typed' });
      const l0 = await op('b.logins');
      check('CU4: b.logins lists names, sites and dates only', l0.ok === true && onlyViews(l0.result?.logins), l0.ok ? `${(l0.result?.logins ?? []).length} saved` : l0.error?.message);
      const lo = await op('b.open', { url: `${base}/login` });
      const nf = await op('b.login', { name: 'Conformance' });
      check('CU4: b.login of a login that isn\u2019t saved: not found (nothing filled)', lo.ok === true && nf.ok === true && nf.result?.outcome === 'not_found', nf.ok ? nf.result?.outcome : nf.error?.message);
      if (!ref && !driver) {
        // Without a driver the window can't be answered: it must close at the deadline with nothing saved.
        const sv = await withWindow('none', 'b.saveLogin', { name: 'Conformance' });
        const after = await op('b.logins');
        check('CU4: the save window unanswered: nothing saved', sv.ok === false && !(after.result?.logins ?? []).some((l: any) => l.name === 'Conformance'), sv.ok ? JSON.stringify(sv.result) : sv.error?.code);
        console.log('      (the rest of section 10 needs --consent-driver for this device)');
      } else {
        const c1 = await withWindow('cancel', 'b.saveLogin', { name: 'Conformance' });
        const c2 = await withWindow('untick', 'b.saveLogin', { name: 'Conformance' });
        const l1 = await op('b.logins');
        check('CU4: Cancel saves nothing', c1.ok === true && c1.result?.outcome === 'cancelled', c1.ok ? c1.result?.outcome : c1.error?.message);
        check('CU4: without the ticked "I understand" nothing is saved (the device refuses)', c2.ok === true && c2.result?.outcome === 'cancelled' && !(l1.result?.logins ?? []).some((l: any) => l.name === 'Conformance'), c2.ok ? `${c2.result?.outcome}: ${c2.result?.why ?? ''}` : c2.error?.message);
        const s1 = await withWindow('save', 'b.saveLogin', { name: 'Conformance' });
        const origin = new URL(base).origin;
        check('CU4: saved with the box ticked: the name and the exact site come back, nothing else', s1.ok === true && s1.result?.outcome === 'saved' && s1.result?.name === 'Conformance' && JSON.stringify(s1.result?.sites) === JSON.stringify([origin]) && !JSON.stringify(s1).includes(LOGIN_PASSWORD) && !JSON.stringify(s1).includes(LOGIN_USER), s1.ok ? JSON.stringify(s1.result) : s1.error?.message);
        await pause(300);
        const listed = await api('GET', '/api/hands');
        const d2 = (listed.json.devices ?? []).find((d: any) => d.id === deviceId);
        check('CU4: the server learns the new login\u2019s name and site at once', (d2?.logins ?? []).some((l: any) => l.name === 'Conformance' && l.sites?.[0] === origin) && !JSON.stringify(listed.json).includes(LOGIN_PASSWORD), JSON.stringify(d2?.logins ?? []).slice(0, 120));
        const before = signIns.length;
        await op('b.open', { url: `${base}/login` });
        const f1 = await act('b.login', { name: 'Conformance', thumb: 320 });
        const read1 = await op('b.read', {});
        check('CU4: b.login fills it on its site and signs in (the site got the right password)', f1.ok === true && f1.result?.outcome === 'filled' && signIns.length === before + 1 && signIns.at(-1)?.right === true && /Signed in \(the right user\)/.test(String(read1.result?.text)), f1.ok ? `${f1.result?.outcome}, ${signIns.length - before} sign-in(s)` : f1.error?.message);
        check('CU4: the answer and its thumbnail data carry no password', !JSON.stringify(f1).includes(LOGIN_PASSWORD));
        const looks: [string, string][] = [
          ['another port', `${base2}/login`],
          ['another host name (localhost)', `${base.replace('127.0.0.1', 'localhost')}/login`],
        ];
        for (const [what, url] of looks) {
          if (url.startsWith(base)) continue;
          const o2 = await op('b.open', { url });
          const m = await act('b.login', { name: 'Conformance' });
          check(`CU4: a look-alike origin (${what}) gets nothing: site doesn\u2019t match`, o2.ok === true && m.ok === true && m.result?.outcome === 'site_mismatch' && signIns.length === before + 1, m.ok ? m.result?.outcome : m.error?.message);
        }
        await op('b.open', { url: `${base}/login` });
        await act('b.type', { text: 'Username', field: true, value: 'someone' });
        await act('b.keys', { combo: 'Tab' });
        const kx = await act('b.keys', { combo: 'x' });
        check('CU4: no typing into a password field key by key', kx.ok === false && kx.error?.code === 'denied_local', kx.ok ? 'it typed' : kx.error?.code);
        // "Use what I just typed": the person signs in once in the Sara browser.
        await op('b.open', { url: `${base}/login` });
        await act('b.click', { text: 'Type it like a person' });
        await pause(800);
        const t1 = await withWindow('typed', 'b.saveLogin', { name: 'Conformance typed' });
        await op('b.open', { url: `${base}/login` });
        const before2 = signIns.length;
        const f2 = await act('b.login', { name: 'Conformance typed' });
        check('CU4: "Use what I just typed" saves the sign-in the person typed (and it works)', t1.ok === true && t1.result?.outcome === 'saved' && f2.ok === true && f2.result?.outcome === 'filled' && signIns.length === before2 + 1 && signIns.at(-1)?.right === true, t1.ok ? `${t1.result?.outcome} / ${f2.result?.outcome ?? f2.error?.message}` : t1.error?.message);
        const yt = await withWindow('continue', 'b.yourTurn', { what: 'sign in to the fixture' });
        check('CU4: Your turn waits for Continue, then says where the browser is', yt.ok === true && yt.result?.continued === true && typeof yt.result?.url === 'string', yt.ok ? String(yt.result?.url) : yt.error?.message);
        const t0 = Date.now();
        const [ys] = await Promise.all([op('b.yourTurn', { what: 'sign in' }, { deadlineMs: 60_000 }), pause(1500).then(() => api('POST', `/api/hands/${deviceId}/stop`, {}))]);
        check('CU4: Stop ends Your turn', ys.ok === false && /stopped/.test(String(ys.error?.code)) && Date.now() - t0 < 6000, `${ys.ok ? 'it went on' : ys.error?.code} after ${Date.now() - t0} ms`);
        await pause(500);
        const g = await api('GET', `/api/hands/${deviceId}/logins`);
        check('CU4: Settings lists this computer\u2019s logins (names and sites)', g.status === 200 && onlyViews(g.json.logins) && (g.json.logins ?? []).some((l: any) => l.name === 'Conformance'), JSON.stringify(g.json.logins ?? []).slice(0, 120));
        const rm = await api('DELETE', `/api/hands/${deviceId}/logins/${encodeURIComponent('Conformance')}`);
        const rm2 = await api('DELETE', `/api/hands/${deviceId}/logins/${encodeURIComponent('Conformance typed')}`);
        const l2 = await op('b.logins');
        await op('b.open', { url: `${base}/login` });
        const gone = await op('b.login', { name: 'Conformance' });
        check('CU4: removed from Settings, removed on the device (it can\u2019t be used any more)', rm.json.removed === 1 && rm2.json.removed === 1 && !(l2.result?.logins ?? []).some((l: any) => /^Conformance/.test(l.name)) && gone.result?.outcome === 'not_found', `${rm.json.removed}/${rm2.json.removed} removed, then ${gone.result?.outcome ?? gone.error?.code}`);
      }
    }

    // 11. Phase 91 (CU4b): the owner's own password managers (test doubles / a test database only).
    {
      const pause = (ms = 300) => new Promise((res) => setTimeout(res, ms));
      const view = async () => ((await api('GET', '/api/hands')).json.devices ?? []).find((d: any) => d.id === deviceId) ?? {};
      const states = async () => Object.fromEntries(((await view()).managers ?? []).map((m: any) => [m.id, m.state])) as Record<string, string>;
      const unlockDriver = arg('--unlock-driver');
      const unlock = async (m: ManagerId, step: 'type' | 'wrong' | 'close', site: string) => {
        pmStep = step;
        let drove: Promise<number> = Promise.resolve(0);
        if (!ref && unlockDriver) {
          drove = new Promise((resolve) => {
            const child = spawn(`${unlockDriver} ${m} ${step}`, { shell: true, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, SARA_CU4B_PIECES: PM_MASTER_PIECES[m].join(',') } });
            child.on('exit', (code) => resolve(code ?? 1));
          });
        }
        const [r] = await Promise.all([op('b.unlock', { managers: [m], site }, { deadlineMs: ref || unlockDriver ? 120_000 : 5000 }), drove]);
        await pause(400);
        return r;
      };
      // The device opens at most 20 pages a minute: wait and try again when it says so.
      const openPage = async (url: string) => {
        for (let i = 0; i < 15; i++) {
          const o = await op('b.open', { url });
          if (o.ok || o.error?.code !== 'rate_limited') return o;
          await pause(5000);
        }
        return { ok: false, error: { code: 'rate_limited' } };
      };
      check('CU4b: the device has b.unlock and b.relock', CU4B_OPS.every((o) => (dev.ops ?? []).includes(o)));
      await op('b.relock', {});
      await pause(400);
      const v0 = await view();
      const ms = (v0.managers ?? []) as Record<string, unknown>[];
      check('CU4b: hello lists the managers by name and state only', ms.length === 3 && ms.every((m) => Object.keys(m).sort().join(',') === 'id,installed,name,on,state'), JSON.stringify(ms).slice(0, 200));
      const st0 = await states();
      check('CU4b: all three found (by --version), turned on there, locked', st0.bitwarden === 'locked' && st0['1password'] === 'locked' && st0.keepassxc === 'locked', JSON.stringify(st0));
      if (st0.bitwarden !== 'locked') console.log('      (turn the three test managers on in the app on that computer first)');
      else {
        const before = signIns.length;
        await openPage(`${base}/login`);
        const l1 = await act('b.login', { name: 'Conformance PM', managers: true });
        check('CU4b: locked: b.login answers locked (the managers by id), nothing filled', l1.ok === true && l1.result?.outcome === 'locked' && JSON.stringify(l1.result?.managers) === JSON.stringify(['bitwarden', '1password', 'keepassxc']) && signIns.length === before, l1.ok ? JSON.stringify(l1.result) : l1.error?.message);
        if (!ref && !unlockDriver) console.log('      (the rest of section 11 needs --unlock-driver for this device)');
        else {
          const c = await unlock('bitwarden', 'close', base);
          check('CU4b: the person closes the manager\u2019s own unlock window: still locked', (c.ok === true && c.result?.unlocked === false) || c.ok === false, c.ok ? JSON.stringify(c.result) : c.error?.code);
          const w = await unlock('bitwarden', 'wrong', base);
          check('CU4b: a wrong master password in its prompt: still locked', w.ok === true && w.result?.unlocked === false && (await states()).bitwarden === 'locked', w.ok ? JSON.stringify(w.result) : w.error?.message);
          const u = await unlock('bitwarden', 'type', base);
          check('CU4b: the person unlocks Bitwarden in its own prompt: unlocked (the server hears the state)', u.ok === true && u.result?.unlocked === true && (await states()).bitwarden === 'unlocked', u.ok ? JSON.stringify(u.result) : u.error?.message);
          await openPage(`${base}/login`);
          const f1 = await act('b.login', { name: 'Conformance PM', managers: true, thumb: 320 });
          const r1 = await op('b.read', {});
          check('CU4b: filled from Bitwarden on its exact site (the fixture got the right password)', f1.ok === true && f1.result?.outcome === 'filled' && f1.result?.source === 'bitwarden' && signIns.length === before + 1 && signIns.at(-1)?.right === true && /Signed in \(the right user\)/.test(String(r1.result?.text)), f1.ok ? JSON.stringify(f1.result) : f1.error?.message);
          const all = JSON.stringify([l1, c, w, u, f1, r1, await op('b.snapshot', {})]);
          check('CU4b: no answer, look or thumbnail carries a test password, username or master password', ![...Object.values(PM_PASS), PM_USER, ...(['bitwarden', '1password', 'keepassxc'] as ManagerId[]).map(PM_MASTER)].some((x) => all.includes(x)));
          await openPage(`${base2}/login`);
          const la = await act('b.login', { name: 'Conformance PM', managers: true });
          check('CU4b: a look-alike origin (another port; the Bitwarden CLI itself offers the entry) gets nothing', la.ok === true && la.result?.outcome !== 'filled' && signIns.length === before + 1, la.ok ? JSON.stringify(la.result) : la.error?.message);
          // 1Password for http://localhost:<port>, then KeePassXC for the third origin.
          const lh = `${base.replace('127.0.0.1', 'localhost')}/login`;
          await openPage(lh);
          const l2 = await act('b.login', { name: '', managers: true });
          const u2 = l2.result?.outcome === 'locked' ? await unlock('1password', 'type', lh) : { ok: false, error: { message: JSON.stringify(l2.result ?? l2.error) } };
          await openPage(lh);
          const f2 = await act('b.login', { name: '', managers: true });
          check('CU4b: the order: Bitwarden has nothing here, 1Password is asked (unlocked by the person), filled', JSON.stringify(l2.result?.managers) === JSON.stringify(['1password', 'keepassxc']) && u2.ok === true && f2.result?.outcome === 'filled' && f2.result?.source === '1password' && signIns.at(-1)?.right === true && signIns.length === before + 2, `${JSON.stringify(l2.result)} / ${JSON.stringify(f2.result ?? f2.error)}`);
          await openPage(`${base3}/login`);
          const l3 = await act('b.login', { name: '', managers: true });
          const u3 = l3.result?.outcome === 'locked' ? await unlock('keepassxc', 'type', base3) : { ok: false, error: { message: JSON.stringify(l3.result ?? l3.error) } };
          await openPage(`${base3}/login`);
          const f3 = await act('b.login', { name: '', managers: true });
          check('CU4b: KeePassXC (its own password prompt) fills its entry on its site', u3.ok === true && f3.result?.outcome === 'filled' && f3.result?.source === 'keepassxc' && signIns.at(-1)?.right === true && signIns.length === before + 3, `${JSON.stringify(u3.result ?? u3.error)} / ${JSON.stringify(f3.result ?? f3.error)}`);
          const rl = await op('b.relock', {});
          await pause(600);
          const st1 = await states();
          check('CU4b: b.relock (after the task) locks every manager still unlocked there (a short idle time may have locked some already)', rl.ok === true && (rl.result?.locked ?? []).includes('keepassxc') && Object.values(st1).every((x) => x === 'locked'), `${JSON.stringify(rl.result)} → ${JSON.stringify(st1)}`);
          const u4 = await unlock('1password', 'type', lh);
          await api('POST', `/api/hands/${deviceId}/stop`, {});
          await pause(1200);
          check('CU4b: Stop locks it again', u4.result?.unlocked === true && (await states())['1password'] === 'locked', `${JSON.stringify(u4.result ?? u4.error)} → ${JSON.stringify(await states())}`);
          const idle = Number(arg('--idle-seconds') ?? 0);
          if (idle > 0) {
            const u5 = await unlock('keepassxc', 'type', base3);
            const t0 = Date.now();
            let s5 = await states();
            while (s5.keepassxc === 'unlocked' && Date.now() - t0 < (idle + 30) * 1000) {
              await pause(1000);
              s5 = await states();
            }
            check(`CU4b: after ${idle} idle seconds it locks again by itself`, u5.result?.unlocked === true && s5.keepassxc === 'locked' && Date.now() - t0 >= (idle - 2) * 1000, `${JSON.stringify(u5.result ?? u5.error)}, locked after ${Math.round((Date.now() - t0) / 1000)} s`);
          } else console.log('      (idle relock: pass --idle-seconds with the device\u2019s test idle time)');
        }
      }
    }
    // 12. Phase 92 (CU5): desktop look (fixture windows and one fixture area only).
    if (process.argv.includes('--desktop')) {
      console.log('\n12. desktop look');
      const winTitle = ref ? 'Sara fixture: Notes' : (arg('--desktop-window') ?? '');
      const winText = ref ? 'Shopping list' : (arg('--desktop-text') ?? '');
      const secret = ref ? 'hunter2-fixture-secret' : (process.env.SARA_CU5_SECRET ?? '');
      const areaArg = ref ? '600,60,400,300' : (arg('--desktop-blocked-area') ?? '');
      const fresh = (await api('GET', '/api/hands')).json.devices.find((d: Record<string, any>) => d.id === deviceId) ?? dev;
      check('CU5: hello: the desktop ops and "The whole screen" on', CU5_OPS.every((o) => fresh.ops?.includes(o)) && fresh.optIn?.desktop === true, `desktop ${fresh.optIn?.desktop}, perms ${JSON.stringify(fresh.perms ?? {})}`);
      const sc = await op('d.screens');
      check('CU5: d.screens lists the screens', sc.ok === true && Array.isArray(sc.result?.screens) && sc.result.screens.length >= 1, JSON.stringify(sc.result?.screens?.map((s: Record<string, unknown>) => `${s.id} ${s.w}x${s.h}`) ?? sc.error));
      const wl = await op('d.windows');
      const wins = (wl.result?.windows ?? []) as Record<string, any>[];
      const fixtureWin = wins.find((w) => w.title === winTitle);
      check('CU5: d.windows lists the fixture window by title', wl.ok === true && Boolean(fixtureWin), wl.ok ? `${wins.length} windows` : wl.error?.code);
      check('CU5: the fixture KeePass window is only "(hidden: password manager)"', wins.some((w) => w.hidden === 'password manager' && !w.title && !w.id) && !JSON.stringify(wins).toLowerCase().includes('keepass'), '');
      check("CU5: Sara's own windows are not in the list", !wins.some((w) => /^sara$/i.test(String(w.app ?? '')) || /^TEST\b|Sara is working/i.test(String(w.title ?? ''))), wins.filter((w) => /sara/i.test(String(w.app ?? ''))).map((w) => w.title).join(', '));
      if (fixtureWin) {
        const el = await op('d.elements', { window: fixtureWin.id });
        const items = (el.result?.items ?? []) as Record<string, any>[];
        if (el.ok === false && el.error?.code === 'perm_missing') check('CU5: d.elements says the permission is missing, with the steps', /System Settings/.test(String(el.error?.message)), String(el.error?.message).slice(0, 120));
        else {
          check('CU5: d.elements reads the fixture window\u2019s text', el.ok === true && items.some((i) => String(i.name ?? i.value ?? '').includes(winText)), items.slice(0, 6).map((i) => `${i.role}:${i.name ?? ''}`).join(' | '));
          check('CU5: its password field is marked secret, with no value', items.some((i) => i.secret === true && i.value === undefined), '');
          check('CU5: the password never leaves the device (element list)', Boolean(secret) && !JSON.stringify(el).includes(secret), secret ? '' : 'set SARA_CU5_SECRET');
        }
        await pause(600);
        const ws = await op('d.shot', { window: fixtureWin.id, maxEdge: 800, marks: true });
        if (ws.ok === false && ws.error?.code === 'perm_missing') check('CU5: d.shot says the permission is missing, with the steps', /System Settings/.test(String(ws.error?.message)), String(ws.error?.message).slice(0, 120));
        else {
          check('CU5: d.shot of the fixture window: a picture and a viewId', ws.ok === true && typeof ws.result?.viewId === 'string' && Number(ws.result?.w) > 0 && Number(ws.result?.w) <= 800, JSON.stringify({ w: ws.result?.w, h: ws.result?.h, img: ws.images?.length }));
          check('CU5: marks come with their numbered list', Array.isArray(ws.result?.items) && ws.result.items.length > 0, `${ws.result?.items?.length ?? 0} items`);
          const fast = await op('d.shot', { window: fixtureWin.id });
          check('CU5: one picture per 500 ms (on the device)', fast.ok === false && fast.error?.code === 'rate_limited', fast.ok ? 'it took a second picture' : fast.error?.code);
          const stale = await op('d.elements', { window: fixtureWin.id, viewId: 'v999999' });
          check('CU5: an unknown / old viewId is stale_view', stale.ok === false && stale.error?.code === 'stale_view', stale.error?.code);
          if (areaArg) {
            await pause(600);
            const [x, y, w, h] = areaArg.split(',').map(Number);
            const as = await op('d.shot', { area: [x, y, w, h], maxEdge: 600 });
            let dark = -1;
            const data = String(((as.images ?? []) as Record<string, any>[]).find((i) => i.kind === 'shot')?.data ?? '');
            const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(data);
            if (m && m[1] === 'jpeg') {
              const img = decodeJpeg(Buffer.from(m[2], 'base64'));
              if (img) {
                let sum = 0;
                let n = 0;
                for (let yy = Math.floor(img.height * 0.2); yy < img.height * 0.8; yy += 3) for (let xx = Math.floor(img.width * 0.2); xx < img.width * 0.8; xx += 3) {
                  const i = (yy * img.width + xx) * 3;
                  sum += img.data[i] + img.data[i + 1] + img.data[i + 2];
                  n++;
                }
                dark = n ? sum / n / 3 : -1;
              }
            } else if (m && m[1] === 'png') {
              const img = readPng(Buffer.from(m[2], 'base64'));
              if (img) {
                let sum = 0;
                let n = 0;
                for (let yy = Math.floor(img.h * 0.2); yy < img.h * 0.8; yy += 3) for (let xx = Math.floor(img.w * 0.2); xx < img.w * 0.8; xx += 3) {
                  const i = (yy * img.w + xx) * 3;
                  sum += img.rgb[i] + img.rgb[i + 1] + img.rgb[i + 2];
                  n++;
                }
                dark = n ? sum / n / 3 : -1;
              }
            }
            check('CU5: the fixture KeePass area is black in the picture', as.ok === true && Number(as.result?.blackedOut) >= 1 && dark >= 0 && dark < 16, `blackedOut ${as.result?.blackedOut}, mean ${dark.toFixed?.(1) ?? dark}`);
          }
        }
      }
    }
  } catch (err) {
    check('setup', false, (err as Error).message);
  } finally {
    await ref?.stop().catch(() => {});
    if (ref && deviceId) await api('DELETE', `/api/hands/${deviceId}`).catch(() => {});
    fx.close();
    fx2.close();
    fx3.close();
    if (refPmDir) rmSync(refPmDir, { recursive: true, force: true });
  }
  const failed = checks.filter((c) => !c.ok);
  const summary = { device: deviceId, passed: checks.length - failed.length, failed: failed.length, checks };
  console.log(`\n${summary.passed}/${checks.length} checks passed${failed.length ? `; failed: ${failed.map((f) => f.name).join('; ')}` : ''}`);
  const out = arg('--json');
  if (out) writeFileSync(out, JSON.stringify(summary, null, 2));
  return failed.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message);
    process.exit(1);
  },
);
