// Computer use with Sara on a remote server (the hosted case: a friend's Sara at sara.example.com and
// the Sara app for Windows or Mac on their own computer). Over a real non-loopback address: the app's
// "Let Sara use this computer" asks the owner's OK on another device (shown in the prompt and Today's
// Needs you, never a silent wait), then the computer connects within seconds and pc_devices lists it.
// A web server in front of Sara that drops the WebSocket upgrade (the root cause on a hosted Sara:
// Apache passed only /api/live/) is said plainly: 426 to the app, "blocked" in the device list, in
// pc_devices and its card. The no-computer card offers "I already have the app → Connect it". The apps
// show their state in plain words and reconnect after sleep and network changes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { cardFor } from '../src/cards.ts';
import { planFor } from '../src/lean.ts';
import { CU1_OPS, HandsHub, PROXY_BLOCKED_MESSAGE } from '../src/hands.ts';
import { createSaraServer } from '../src/server.ts';
import { createComputerTools, NO_COMPUTER } from '../src/tools/computer.ts';
import { connectWebSocket } from '../src/ws.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const lan = Object.values(networkInterfaces())
  .flat()
  .find((x) => x && x.family === 'IPv4' && !x.internal)?.address;

const { dir, cleanup } = tempDir();
const clock = { now: new Date() };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const hub = new HandsHub({ events: app.events!, known: () => auth.devices().filter((d) => d.kind === 'hands') });
app.hands = hub;
for (const t of createComputerTools(app)) app.tools.add(t);
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
let proxy: Server;
let proxyBase = '';
before(async () => {
  app.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString(), deviceApproval: { on: true } } as never);
  await new Promise<void>((r) => server.listen(0, '0.0.0.0', r));
  const port = (server.address() as AddressInfo).port;
  base = `http://${lan ?? '127.0.0.1'}:${port}`;
  // A reverse proxy like Apache with only "/api/live/" set up for WebSockets: every other request,
  // the hands upgrade too, goes on as a plain HTTP request (Upgrade and Connection are hop-by-hop).
  proxy = createServer((req: IncomingMessage, res) => {
    const headers = { ...req.headers, 'x-forwarded-for': '198.51.100.7' };
    delete headers.upgrade;
    delete headers.connection;
    const up = httpRequest({ host: '127.0.0.1', port, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    req.pipe(up);
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyBase = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});
after(() => {
  hub.closeAll();
  proxy.close();
  server.close();
  server.closeAllConnections?.();
  app.store.close();
  cleanup();
});

async function call(path: string, o: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; at?: string } = {}) {
  const r = await fetch((o.at ?? base) + path, { method: o.method ?? 'GET', headers: { ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', ...(o.headers ?? {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const set = r.headers.get('set-cookie');
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any>, cookie: set ? set.split(';')[0] : undefined };
}
const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const pcDevices = () => app.tools.get('pc_devices')!.run({}, { workspaceDir: dir, signal: new AbortController().signal, sandbox: app.sandbox, conversationId: 'x' } as never) as Promise<string>;

let phone = '';
let desktop = '';
let handsToken = '';
let handsId = '';

test('over a non-loopback address the app counts as another device: pairing waits for the OK, which shows where the owner is', { skip: !lan && 'no non-loopback IPv4 address on this computer' }, async () => {
  // The owner's phone signs in first (nothing to approve it from yet), then the Sara app on Windows.
  const first = await call('/api/login', { method: 'POST', body: { token } });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  phone = first.cookie!;
  const second = await call('/api/login', { method: 'POST', body: { token }, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) SaraDesktop/3.3.0' } });
  assert.equal(second.status, 202);
  desktop = second.cookie!;
  assert.equal((await call(`/api/device-approvals/${second.json.pendingApproval.code}`, { method: 'POST', body: { approve: true }, cookie: phone })).json.state, 'approved');

  // "Let Sara use this computer" in the app: a sensitive action from a remote device.
  const ask = await call('/api/hands/pair', { method: 'POST', body: { name: 'Alex Laptop' }, cookie: desktop });
  assert.equal(ask.status, 428, 'never a silent wait: the app gets a code to show at once');
  assert.equal(ask.json.approval.action, 'hands');
  assert.match(ask.json.approval.code, /^[A-Z0-9]{5}$/);
  // Where the owner is: the prompt on her other devices and Today's Needs you (never the code).
  const open = await call('/api/device-approvals', { cookie: phone });
  assert.deepEqual(open.json.requests.map((r: { action: string }) => r.action), ['hands']);
  assert.match(open.json.requests[0].what, /use a computer/);
  assert.equal(JSON.stringify(open.json).includes(ask.json.approval.code), false, 'the code is only on the asking device');
  const today = await call('/api/today?parts=needs', { cookie: phone });
  assert.equal(today.json.needs.devices.length, 1);
  assert.equal(today.json.needs.devices[0].action, 'hands');
  assert.equal(JSON.stringify(today.json.needs).includes(ask.json.approval.code), false);
  // The asking app can't approve itself; the phone does, with the code the app shows.
  assert.equal((await call(`/api/device-approvals/${ask.json.approval.code}`, { method: 'POST', body: { approve: true }, cookie: desktop })).status, 403);
  assert.equal((await call(`/api/device-approvals/${ask.json.approval.code}`, { method: 'POST', body: { approve: true }, cookie: phone })).json.state, 'approved');
  assert.equal((await call(`/api/device-approvals/${ask.json.approval.code}/status`, { cookie: desktop })).json.state, 'approved');
  const paired = await call('/api/hands/pair', { method: 'POST', body: { name: 'Alex Laptop' }, cookie: desktop });
  assert.equal(paired.status, 200, JSON.stringify(paired.json));
  handsToken = paired.json.token;
  handsId = paired.json.id;
  assert.equal((await call('/api/today?parts=needs', { cookie: phone })).json.needs.devices.length, 0, 'answered: gone from Needs you');

  // The app's hands connect over the same address; the server sees it within seconds.
  const t0 = Date.now();
  const ws = await connectWebSocket(`${base.replace('http', 'ws')}/api/hands`, { headers: { Authorization: `Bearer ${handsToken}` } });
  ws.send(JSON.stringify({ t: 'hello', v: 1, app: 'Sara for Windows', computer: 'Alex Laptop', optIn: { browser: true, desktop: true }, ops: [...CU1_OPS, 'd.windows', 'd.shot'] }));
  await until(() => hub.devices().some((d) => d.id === handsId && d.connected && d.app?.startsWith('Sara')));
  assert.ok(Date.now() - t0 < 5000);
  const said = await pcDevices();
  assert.match(said, /Computers you can use:\n- "Alex Laptop"/);
  assert.match(said, /the owner's own screen, windows and browser tabs: you may look \(pc_my_tabs/);
  ws.close();
  await until(() => !hub.connected(handsId));
});

test('a web server in front of Sara that drops the WebSocket upgrade: 426 to the app, and said in pc_devices, its card and the device list', async () => {
  if (!handsToken) {
    const r = auth.createHandsToken("Sara's hands on Alex Laptop");
    handsToken = r.token;
    handsId = r.id;
  }
  // Through the Apache-like proxy the upgrade arrives as a plain GET with the hands token.
  await assert.rejects(connectWebSocket(`${proxyBase.replace('http', 'ws')}/api/hands`, { headers: { Authorization: `Bearer ${handsToken}` } }));
  const plain = await call('/api/hands', { at: proxyBase, headers: { authorization: `Bearer ${handsToken}` } });
  assert.equal(plain.status, 426);
  assert.equal(plain.json.code, 'proxy_no_websocket');
  assert.match(plain.json.error, /web server in front of this Sara/);
  // A made-up hands token learns nothing (the usual sign-in answer).
  assert.equal((await call('/api/hands', { at: proxyBase, headers: { authorization: 'Bearer sara_hands.nope.nope' } })).status, 401);
  const dev = hub.devices().find((d) => d.id === handsId)!;
  assert.equal(dev.connected, false);
  assert.equal(dev.blocked?.why, 'proxy');
  const said = await pcDevices();
  assert.ok(said.startsWith(NO_COMPUTER));
  assert.match(said, /"Alex Laptop" is signed in and trying to connect right now/);
  assert.ok(said.includes(PROXY_BLOCKED_MESSAGE));
  assert.deepEqual(cardFor({ name: 'pc_devices', args: {}, output: said, status: 'ok' } as never), { kind: 'hands-install', url: 'https://github.com/farena-ai/sara/releases/latest', blocked: 'proxy', computer: 'Alex Laptop' });
  // Fixed proxy (or straight to Sara): it connects and "blocked" is gone.
  const ws = await connectWebSocket(`${base.replace('http', 'ws')}/api/hands`, { headers: { Authorization: `Bearer ${handsToken}` } });
  ws.send(JSON.stringify({ t: 'hello', v: 1, app: 'fake', optIn: { browser: true, desktop: false }, ops: [...CU1_OPS] }));
  await until(() => hub.connected(handsId) && Boolean(hub.hello(handsId)));
  assert.equal(hub.devices().find((d) => d.id === handsId)!.blocked, undefined);
  ws.close();
  await until(() => !hub.connected(handsId));
});

test('no computer: pc_devices says how to connect the app you already have, and the card offers "Connect it" and the download', async () => {
  for (const d of auth.devices().filter((x) => x.kind === 'hands')) auth.signOut(d.id);
  hub.forgetMissing();
  const said = await pcDevices();
  assert.ok(said.startsWith(NO_COMPUTER));
  assert.match(said, /If the owner already has the Sara app on that computer: open it there, check it is signed in to this Sara, then Settings → Computer use → switch on "Let Sara use this computer"/);
  assert.match(said, /Connected: Sara can use this computer/);
  assert.deepEqual(cardFor({ name: 'pc_devices', args: {}, output: said, status: 'ok' } as never), { kind: 'hands-install', url: 'https://github.com/farena-ai/sara/releases/latest' });
  const cards = readFileSync(join(ROOT, 'web/result-cards.js'), 'utf8');
  assert.match(cards, /I already have the app \\u2192 Connect it/);
  assert.match(cards, /openSettingsPage\('co-computer'\)/);
  assert.match(cards, /c\.blocked === 'proxy'/);
});

test('the apps: plain states (Connected / Not connected: why / Try again), the proxy reason, reconnect after sleep and network changes', () => {
  const page = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
  for (const s of ["t('Connected: Sara can use this computer.')", "t('Not connected: {why}', { why })", "d.call('handsRetry')", 'dev?.blocked?.why']) assert.ok(page.includes(s), s);
  assert.match(readFileSync(join(ROOT, 'web/index.html'), 'utf8'), /id="cu-retry"[^>]*hidden>Try again</);
  assert.match(readFileSync(join(ROOT, 'web/device-approval.js'), 'utf8'), /Waiting for your OK on Sara…/);
  const win = readFileSync(join(ROOT, 'desktop/windows/src/main.cpp'), 'utf8');
  assert.match(win, /case WM_POWERBROADCAST:[\s\S]{0,200}PBT_APMRESUMEAUTOMATIC[\s\S]{0,80}reconnectNow\(true\)/);
  assert.match(win, /NotifyIpInterfaceChange/);
  assert.match(win, /WTS_SESSION_UNLOCK && !sarahands::connected\(\)\) sarahands::reconnectNow\(false\)/);
  assert.match(win, /kind == L"handsRetry"/);
  const hands = readFileSync(join(ROOT, 'desktop/windows/src/hands.cpp'), 'utf8');
  assert.match(hands, /code == "proxy_no_websocket" \|\| status == 426/);
  assert.match(hands, /void reconnectNow\(bool dropOpen\)/);
  const mac = readFileSync(join(ROOT, 'desktop/mac/Sources/Hands.swift'), 'utf8');
  assert.match(mac, /case 426: lastError = "the web server in front of this Sara/);
  assert.match(mac, /func reconnectNow\(dropOpen: Bool\)/);
  const macMain = readFileSync(join(ROOT, 'desktop/mac/Sources/main.swift'), 'utf8');
  assert.match(macMain, /NSWorkspace\.didWakeNotification[^\n]*reconnectNow\(dropOpen: true\)/);
  assert.match(macMain, /NWPathMonitor/);
  assert.match(macMain, /case "handsRetry":/);
});

test('the shipped proxy setups pass computer use through', () => {
  const apache = readFileSync(join(ROOT, 'deploy/apache-proxy.conf'), 'utf8');
  assert.match(apache, /^ProxyPass "\/" "http:\/\/127\.0\.0\.1:7860\/"[^\n]* upgrade=websocket$/m);
  const install = readFileSync(join(ROOT, 'docs/INSTALL.md'), 'utf8');
  assert.match(install, /ProxyPass "\/" "http:\/\/127\.0\.0\.1:7860\/"[^\n]* upgrade=websocket/);
  assert.match(install, /### Behind a proxy: computer use needs WebSockets/);
  assert.match(install, /proxy_set_header Upgrade \$http_upgrade;/);
});

test('her browser tabs vs the owner\u2019s own: the tools say which to use', () => {
  const tabs = app.tools.get('pc_browser_tabs')!.spec.description;
  // 3.4.x: her own window is hers; the owner's own tabs are pc_my_tabs (every tab, read only).
  assert.match(tabs, /Sara\u2019s OWN browser window/);
  assert.match(tabs, /It is NOT the owner's own browser: for "look at my tabs \/ my browser \/ what I have open" use pc_my_tabs/);
  assert.match(app.tools.get('pc_my_tabs')!.spec.description, /The OWNER'S OWN browser tabs/);
});

test('"look at my browser tabs" loads her computer tools (the owner\u2019s own computer), not only her testing browser', () => {
  const conv = app.store.createConversation({ title: 'Tabs' });
  for (const text of ['look at my browser tabs', 'what tabs do I have open in my browser?', 'mira mis pestañas', 'regarde mes onglets', 'can you see my screen?']) {
    const plan = planFor(app, conv, text);
    for (const name of ['pc_devices', 'pc_windows', 'pc_look']) assert.ok(plan.isOffered(name), `${text}: ${name}`);
  }
});
