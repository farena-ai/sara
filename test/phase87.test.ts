// Phase 87 (computer use CU1, docs/design/COMPUTER_USE.md §11 "Done when"): the hands channel and
// its auth (pairing needs a fresh confirmation, cookies and other tokens refused, renew, revoke),
// the opt-in (off by default on the device), the command set (anything else refused on the device
// in the reference hands), look / read / navigate / screenshot / console + network logs through the
// reference hands against a local fixture page (a console error and an HTTP 500), live view events,
// run steps with thumbnails, budgets, one task per computer, cancel on Stop, deadlines, reconnect,
// duplicate ids, owner-only + the member switch, never on the demo / other apps / groups, private
// local mode keeping pictures on local models, the localhost-job rule and "ask once per site", the
// install card for web-only users, the shared page agent, and the page (settings, tips, translations).
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { findBrowser, pageAgentSource, PAGE_AGENT_PATH } from '../src/browser.ts';
import { cardFor } from '../src/cards.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { isLoopback, namedSites, navigationVerdict } from '../src/computer-policy.ts';
import { CU1_OPS, HandsHub, packBinary, parseBinary } from '../src/hands.ts';
import { addressAllowed, HandsRef, maskSecrets } from '../src/hands-ref.ts';
import { MEMBER_ROUTES, OWNER_SETTINGS } from '../src/household.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { RunStore, runSettings } from '../src/runs.ts';
import { createSaraServer } from '../src/server.ts';
import { createComputerTools, NO_COMPUTER } from '../src/tools/computer.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { connectWebSocket } from '../src/ws.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const NOW = new Date();
const browser = findBrowser();
const REAL = browser.found;

// ---- a fixture web app: a console error and an HTTP 500, a password field, a slow page ----
let fixture: Server;
let fx = '';
const PASSWORD = 'tr0ub4dor-' + 'and-3';
before(async () => {
  fixture = createServer((req, res) => {
    if (req.url === '/api/items') {
      res.writeHead(500, { 'content-type': 'application/json' });
      return void res.end('{"error":"items table is missing"}');
    }
    if (req.url === '/slow') return void setTimeout(() => res.end('late'), 20_000);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Shop</title><h1>Your cart</h1><p>3 items</p><label>Password <input type="password" value="${PASSWORD}"></label><a href="/other">Other</a><script>console.error('TypeError: cart.total is not a function'); fetch('/api/items');</script>`);
  });
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  fx = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
});
after(() => fixture.close());

interface Env {
  app: TestApp;
  auth: OwnerAuth;
  token: string;
  server: Server;
  base: string;
  hub: HandsHub;
  close: () => Promise<void>;
}

async function env(opts: { demo?: boolean; member?: boolean; members?: boolean } = {}): Promise<Env> {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const hub = new HandsHub({ events: app.events!, allowed: opts.member ? () => app.settings.get().computerUse?.members === true : () => true, known: () => auth.devices().filter((d) => d.kind === 'hands') });
  if (!opts.demo) app.hands = hub;
  app.runs = new RunStore(app.store.db, () => NOW);
  app.runs.settings = () => runSettings(app.settings.get());
  app.settings.update({
    disclosureAcceptedAt: NOW.toISOString(),
    providers: [{ id: 'cloud', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1' }],
    defaultProviderId: 'cloud',
    defaultModel: 'fake-large',
    ...(opts.members ? { computerUse: { members: true } } : {}),
  });
  for (const t of createComputerTools(app)) app.tools.add(t);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(opts.demo ? { demo: true } : {}), ...(opts.member ? { member: { record: () => ({ id: 'm1', name: 'Ana', status: 'active', createdAt: NOW.toISOString(), limits: { models: [], messagesPerDay: 0, costPerDay: 0, voice: false, pictures: false } }) as never, apps: () => [app], deleteSelf: async () => {} } } : {}) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    app,
    auth,
    token,
    server,
    base,
    hub,
    close: async () => {
      hub.closeAll();
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      app.store.close();
      cleanup();
    },
  };
}

async function api(e: Env, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, any> }> {
  const r = await fetch(e.base + path, { method, headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
}

/** The status of a WebSocket upgrade to /api/hands with these headers. */
function upgradeStatus(base: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const u = new URL('/api/hands', base);
    const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', ...headers } });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}

async function pair(e: Env, name = 'Test PC'): Promise<{ token: string; id: string }> {
  const r = await api(e, 'POST', '/api/hands/pair', { name, token: e.token });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { token: r.json.token, id: r.json.id };
}

const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A fake hands device speaking the protocol by hand (no browser): for protocol-level checks. */
async function fakeDevice(e: Env, token: string, hello: Record<string, unknown> = {}, onReq?: (m: Record<string, any>, send: (x: unknown) => void, bin: (h: Record<string, unknown>, d: Buffer) => void) => void) {
  const ws = await connectWebSocket(`${e.base.replace('http', 'ws')}/api/hands`, { headers: { Authorization: `Bearer ${token}` } });
  const got: Record<string, any>[] = [];
  const send = (x: unknown) => ws.send(JSON.stringify(x));
  const bin = (h: Record<string, unknown>, d: Buffer) => ws.send(packBinary(h, d));
  ws.onMessage = (d) => {
    const m = JSON.parse(String(d)) as Record<string, any>;
    got.push(m);
    onReq?.(m, send, bin);
  };
  send({ t: 'hello', v: 1, app: 'fake 1', optIn: { browser: true, desktop: false }, ops: [...CU1_OPS], ...hello });
  return { ws, got, send };
}

const ctxFor = (app: TestApp, conversationId: string, over: Partial<ToolContext> = {}): ToolContext => ({ workspaceDir: app.dataDir, signal: new AbortController().signal, sandbox: app.sandbox, conversationId, ...over });
const tool = (app: TestApp, name: string): Tool => app.tools.get(name)!;
async function drain(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// ------------------------------------------------------------------------------------------------

test('pairing needs a fresh confirmation; the hands token is its own kind, listed, and opens nothing else', async () => {
  const e = await env();
  try {
    const no = await api(e, 'POST', '/api/hands/pair', { name: 'Laptop' });
    assert.equal(no.status, 403, 'a session (or the token as a header) alone is not enough');
    assert.equal(no.json.confirm, 'token');
    const { token, id } = await pair(e, 'Laptop');
    assert.match(token, /^sara_hands\.[\w-]+\.[\w-]+$/);
    const devs = await api(e, 'GET', '/api/devices');
    const d = (devs.json.devices as { id: string; kind: string; label: string }[]).find((x) => x.id === id)!;
    assert.equal(d.kind, 'hands');
    assert.equal(d.label, "Sara's hands on Laptop");
    // Only the hands channel takes it: not the app's API, not /v1, not with the other prefix.
    assert.equal((await api(e, 'GET', '/api/conversations', undefined, { authorization: `Bearer ${token}` })).status, 401);
    assert.equal((await api(e, 'GET', '/api/session', undefined, { authorization: `Bearer ${token}` })).json.authenticated, false);
    assert.equal((await api(e, 'GET', '/api/conversations', undefined, { authorization: `Bearer ${token.replace('sara_hands.', 'sara_dev.')}` })).status, 401);
    assert.notEqual((await fetch(`${e.base}/v1/models`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    // A device-code app (terminal, VS Code) can't make hands.
    const app2 = e.auth.createDeviceToken('Terminal');
    assert.equal((await api(e, 'POST', '/api/hands/pair', { name: 'x', token: e.token }, { authorization: `Bearer ${app2.token}` })).status, 403);
    // Renewing gives a new secret; the old one stops.
    const ren = await api(e, 'POST', '/api/hands/renew', { token });
    assert.equal(ren.status, 200);
    assert.equal(ren.json.id, id);
    assert.equal(e.auth.handsTokenId(token), undefined);
    assert.equal(e.auth.handsTokenId(ren.json.token), id);
  } finally {
    await e.close();
  }
});

test('the /api/hands WebSocket: only a hands token in a header; cookies, Origin, other tokens refused; revoke closes it', async () => {
  const e = await env();
  try {
    const { token, id } = await pair(e);
    const session = e.auth.createSession('Browser').value;
    assert.equal(await upgradeStatus(e.base, {}), 401);
    assert.equal(await upgradeStatus(e.base, { Authorization: `Bearer ${e.token}` }), 401, 'the owner token is not a hands token');
    assert.equal(await upgradeStatus(e.base, { Authorization: `Bearer ${e.auth.createDeviceToken('T').token}` }), 401);
    assert.equal(await upgradeStatus(e.base, { Cookie: `sara_session=${encodeURIComponent(session)}` }), 403, 'cookies are refused');
    assert.equal(await upgradeStatus(e.base, { Authorization: `Bearer ${token}`, Cookie: `sara_session=${encodeURIComponent(session)}` }), 403, 'even with a token');
    assert.equal(await upgradeStatus(e.base, { Authorization: `Bearer ${token}`, Origin: e.base }), 403, 'a web page always sends Origin');
    assert.equal(await upgradeStatus(e.base, { Authorization: `Bearer ${token}` }), 101);
    const dev = await fakeDevice(e, token);
    await until(() => e.hub.devices().some((d) => d.id === id && d.connected && d.app === 'fake 1'));
    let closed = false;
    dev.ws.onClose = () => (closed = true);
    assert.equal((await api(e, 'DELETE', `/api/hands/${id}`)).status, 200);
    await until(() => closed);
    assert.equal(await upgradeStatus(e.base, { Authorization: `Bearer ${token}` }), 401, 'a signed-out computer is refused');
  } finally {
    await e.close();
  }
});

test('protocol: hello, req/res with pictures, duplicate ids, deadlines, cancel on Stop, a second connection replaces the first', async () => {
  const e = await env();
  try {
    const { token, id } = await pair(e);
    let slowId = '';
    const cancels: string[] = [];
    const dev = await fakeDevice(e, token, {}, (m, send, bin) => {
      if (m.t === 'cancel') cancels.push(m.id ?? 'all');
      if (m.t !== 'req') return;
      if (m.op === 'c.ping') return send({ t: 'res', id: m.id, ok: true, result: { pong: true } });
      if (m.op === 'b.screenshot') {
        bin({ id: m.id, kind: 'shot', mime: 'image/jpeg', w: 2, h: 1 }, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        bin({ frame: 1, mime: 'image/jpeg', w: 2, h: 1 }, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        return send({ t: 'res', id: m.id, ok: true, result: { w: 2, h: 1 } });
      }
      if (m.op === 'b.open') return void (slowId = m.id); // never answers
      send({ t: 'res', id: m.id, ok: false, error: { code: 'unsupported', message: 'no' } });
    });
    await until(() => Boolean(e.hub.hello(id)));
    assert.equal(e.hub.hello(id)!.app, 'fake 1');
    assert.deepEqual((await e.hub.request(id, 'c.ping')).result, { pong: true });
    const events: unknown[] = [];
    const off = e.app.events!.subscribe((ev) => ev.type === 'computer' && events.push(ev));
    const shot = await e.hub.request(id, 'b.screenshot');
    assert.equal(shot.images[0].mime, 'image/jpeg');
    await until(() => events.some((x) => (x as { frame?: number }).frame === 1));
    assert.ok(e.hub.frame(id, 0), 'the live-view frame is kept in memory');
    off();
    await assert.rejects(e.hub.request(id, 'b.click'), (err: Error & { code?: string }) => err.code === 'unsupported');
    // Deadline: no answer → timeout (and the device is told to cancel).
    await assert.rejects(e.hub.request(id, 'b.open', { url: fx }, { deadlineMs: 1000 }), (err: Error & { code?: string }) => err.code === 'timeout');
    await until(() => cancels.includes(slowId));
    // Stop (the turn's signal): cancelled on the device at once.
    const ac = new AbortController();
    const p = e.hub.request(id, 'b.open', { url: fx }, { signal: ac.signal });
    await until(() => Boolean(slowId) && dev.got.some((m) => m.t === 'req' && m.op === 'b.open' && !cancels.includes(m.id)));
    const pendingId = dev.got.filter((m) => m.t === 'req' && m.op === 'b.open').at(-1)!.id;
    ac.abort();
    await assert.rejects(p, (err: Error & { code?: string }) => err.code === 'stopped');
    await until(() => cancels.includes(pendingId));
    // A second connection for the same computer replaces the first.
    let firstClosed = false;
    dev.ws.onClose = () => (firstClosed = true);
    const dev2 = await fakeDevice(e, token, { app: 'fake 2' });
    await until(() => firstClosed && e.hub.hello(id)?.app === 'fake 2');
    dev2.ws.close();
  } finally {
    await e.close();
  }
});

test('opt-in is off by default on the device: the server refuses browser ops and her tools stay hidden', async () => {
  const e = await env();
  try {
    const { token, id } = await pair(e);
    const dev = await fakeDevice(e, token, { optIn: { browser: false, desktop: false } });
    await until(() => Boolean(e.hub.hello(id)));
    await assert.rejects(e.hub.request(id, 'b.open', { url: fx }), (err: Error & { code?: string }) => err.code === 'denied_local');
    assert.equal(tool(e.app, 'pc_browser_open').isAvailable!(), false);
    assert.equal(tool(e.app, 'pc_devices').isAvailable!(), true);
    // The reference hands refuse it on the device too (optIn false), whatever the server sends.
    dev.ws.close();
  } finally {
    await e.close();
  }
});

test('the reference hands: look, read, navigate, screenshot and logs against a fixture app; anything else refused on the device', { skip: !REAL && 'no Chromium-family browser here' }, async () => {
  const e = await env();
  const { token, id } = await pair(e);
  const ref = new HandsRef({ server: e.base, token, name: 'Test PC', info: browser });
  try {
    await ref.start();
    await until(() => Boolean(e.hub.hello(id)), 10_000);
    const r = (op: string, args: Record<string, unknown> = {}) => e.hub.request(id, op, args);
    const opened = await r('b.open', { url: `${fx}/`, thumb: 320 });
    assert.equal(opened.result.title, 'Shop');
    assert.equal(opened.result.status, 200);
    assert.ok(opened.images.some((i) => i.kind === 'thumb' && i.mime === 'image/jpeg' && (i.w ?? 999) <= 320));
    await new Promise((res) => setTimeout(res, 400));
    const logs = await r('b.logs');
    const entries = logs.result.entries as Record<string, unknown>[];
    assert.ok(entries.some((x) => /cart\.total is not a function/.test(String(x.text))), JSON.stringify(entries));
    const e500 = entries.find((x) => x.kind === 'network' && x.status === 500)!;
    assert.match(String(e500.url), /\/api\/items$/);
    assert.match(String((await r('b.request', { requestId: e500.requestId })).result.body), /items table is missing/);
    const snap = await r('b.snapshot');
    assert.ok(!JSON.stringify(snap.result).includes(PASSWORD), 'the password never leaves the page');
    assert.ok((snap.result.items as { secret?: boolean }[]).some((i) => i.secret));
    assert.match(String((await r('b.read')).result.text), /3 items/);
    assert.equal((await r('b.screenshot', { maxWidth: 640 })).images[0].mime, 'image/jpeg');
    assert.equal((await r('b.navigate', { action: 'reload' })).result.title, 'Shop');
    // Phase 88 (CU2) added b.click / b.type to the command set; logins, scripts and the desktop stay out.
    for (const op of ['p.unlock', 'd.click', 'd.shot', 'b.evaluate']) await assert.rejects(r(op), (err: Error & { code?: string }) => err.code === 'unsupported', op);
    await assert.rejects(r('b.open', { url: `${e.base}/` }), (err: Error & { code?: string }) => err.code === 'denied_local');
    await assert.rejects(r('b.open', { url: 'file:///etc/passwd' }), (err: Error & { code?: string }) => err.code === 'denied_local');
    // Reconnect: a dropped connection comes back by itself.
    const before = ref.connects;
    ref.dropConnection();
    await until(() => ref.connects > before && e.hub.connected(id), 8000);
  } finally {
    await ref.stop();
    await e.close();
  }
});

test('her tools through a turn: open → logs → look; run steps keep thumbnails; live-view events; the error is reported', { skip: !REAL && 'no Chromium-family browser here' }, async () => {
  const e = await env();
  const { token, id } = await pair(e);
  const ref = new HandsRef({ server: e.base, token, name: 'Test PC', info: browser });
  try {
    await ref.start();
    await until(() => Boolean(e.hub.hello(id)), 10_000);
    const conv = e.app.store.createConversation({ title: 'Debug', mode: 'coding' });
    const frames: unknown[] = [];
    const off = e.app.events!.subscribe((ev) => ev.type === 'computer' && ev.frame && frames.push(ev));
    e.app.script.push([call('c1', 'pc_devices', {})], [call('c2', 'pc_browser_open', { url: `${fx}/` })], [call('c3', 'pc_browser_logs', {})], [call('c4', 'pc_browser_look', {})], text('The page logs TypeError: cart.total is not a function, and GET /api/items returns 500.'));
    const evs: ChatEvent[] = [];
    for await (const ev of runTurn(e.app, conv.id, `my shop at ${fx}/ is broken, can you look at it on my computer?`)) {
      evs.push(ev);
      if (ev.type === 'approval') e.app.approvals.decide(ev.approvalId, false);
    }
    off();
    assert.ok(!evs.some((x) => x.type === 'approval'), 'a site the owner named opens without a card');
    const results = evs.filter((x): x is Extract<ChatEvent, { type: 'tool_result' }> => x.type === 'tool_result');
    assert.deepEqual(results.map((x) => x.status), ['ok', 'ok', 'ok', 'ok'], JSON.stringify(results.map((x) => x.output)));
    assert.match(results[1].output, /Opened .* in the Sara browser on Test PC \(HTTP 200\)\. Title: Shop/);
    assert.match(results[2].output, /cart\.total is not a function/);
    assert.match(results[2].output, /GET .*\/api\/items → HTTP 500/);
    assert.match(results[3].output, /e1 heading "Your cart"/);
    assert.match(results[3].output, /password field: value hidden/);
    assert.ok(!results[3].output.includes(PASSWORD));
    assert.equal(results[1].card?.kind, 'computer');
    const thumb = (results[1].card as { thumb?: string }).thumb!;
    assert.match(thumb, /^[0-9a-f]{64}$/);
    // The run record: tool steps with the thumbnail, served to the owner.
    const run = e.app.runs!.list({ conversationId: conv.id })[0];
    const steps = e.app.runs!.steps(run.id);
    const openStep = steps.flatMap((s) => s.tools).find((t) => t.name === 'pc_browser_open')!;
    assert.deepEqual(openStep.thumbs, [thumb]);
    const img = await fetch(`${e.base}/api/computer/thumb/${thumb}`, { headers: { authorization: `Bearer ${e.token}` } });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    await until(() => frames.length > 0, 3000);
    const fr = await api(e, 'GET', `/api/computer/frame/${id}?after=0`);
    assert.match(String(fr.json.image), /^data:image\/jpeg;base64,/);
    // Her answer is in the reply.
    assert.match(String(e.app.store.messages(conv.id).filter((m) => m.role === 'assistant').at(-1)?.content), /cart\.total is not a function/);
  } finally {
    await ref.stop();
    await e.close();
  }
});

test('navigation rules: localhost of her job without a card, an unknown site asks once per task, private keeps to localhost', async () => {
  const facts = { ownerText: 'please check https://shop.example.com and docs.example.org', granted: new Set<string>(), localOnly: false, jobPort: (p: number) => p === 5173 };
  assert.equal(navigationVerdict('http://localhost:5173/', facts).act, 'allow');
  assert.equal(navigationVerdict('http://127.0.0.1:5173/x', facts).act, 'allow');
  assert.equal(navigationVerdict('http://localhost:8080/', facts).act, 'ask');
  assert.equal(navigationVerdict('https://shop.example.com/cart', facts).act, 'allow');
  assert.equal(navigationVerdict('https://docs.example.org/', facts).act, 'allow');
  assert.equal(navigationVerdict('https://evil.example.net/', facts).act, 'ask');
  assert.equal(navigationVerdict('https://evil.example.net/', { ...facts, granted: new Set(['evil.example.net']) }).act, 'allow');
  assert.equal(navigationVerdict('file:///C:/x', facts).act, 'block');
  assert.equal(navigationVerdict('https://a:b@shop.example.com/', facts).act, 'block');
  assert.equal(navigationVerdict('https://shop.example.com/', { ...facts, localOnly: true }).act, 'block');
  assert.equal(navigationVerdict('http://localhost:5173/', { ...facts, localOnly: true }).act, 'allow');
  assert.ok(isLoopback('127.0.0.9') && !isLoopback('10.0.0.1'));
  assert.ok(namedSites('see localhost:3000 and https://x.dev/a').has('localhost:3000'));

  // Through a turn: an unknown site asks once (the card), the same site again in this task doesn't.
  const e = await env();
  try {
    const { token, id } = await pair(e);
    const opened: string[] = [];
    await fakeDevice(e, token, {}, (m, send) => {
      if (m.t !== 'req') return;
      if (m.op === 'b.open') opened.push(String(m.args.url));
      send({ t: 'res', id: m.id, ok: true, result: { tab: 't1', url: m.args?.url ?? '', title: 'Page', status: 200 } });
    });
    await until(() => Boolean(e.hub.hello(id)));
    const conv = e.app.store.createConversation({ title: 'x', mode: 'chat' });
    e.app.script.push([call('a1', 'pc_browser_open', { url: 'https://unknown.example.net/' })], [call('a2', 'pc_browser_open', { url: 'https://unknown.example.net/page2' })], text('done'));
    const gen = runTurn(e.app, conv.id, 'look something up for me');
    const evs: ChatEvent[] = [];
    let approvals = 0;
    for await (const ev of gen) {
      evs.push(ev);
      if (ev.type === 'approval') {
        approvals++;
        assert.match(ev.summary, /unknown\.example\.net/);
        e.app.approvals.decide(ev.approvalId, true);
      }
    }
    assert.equal(approvals, 1, 'asked once per site per task');
    assert.deepEqual(opened, ['https://unknown.example.net/', 'https://unknown.example.net/page2']);
    // A private conversation: only localhost; a site is refused before any card.
    const priv = e.app.store.createConversation({ title: 'p', mode: 'chat', private: true });
    e.app.settings.update({ providers: [{ id: 'loc', label: 'Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true }], defaultProviderId: 'loc' });
    e.app.script.push([call('p1', 'pc_browser_open', { url: 'https://shop.example.com/' })], text('ok'));
    const pevs = await drain(runTurn(e.app, priv.id, 'open https://shop.example.com'));
    assert.ok(!pevs.some((x) => x.type === 'approval'));
    const pres = pevs.find((x): x is Extract<ChatEvent, { type: 'tool_result' }> => x.type === 'tool_result' && x.name === 'pc_browser_open');
    assert.match(String(pres?.output), /Private: only addresses on this computer/);
  } finally {
    await e.close();
  }
});

test('pictures: private local mode and "local models only" keep screenshots away from a cloud model', async () => {
  const e = await env();
  try {
    const { token, id } = await pair(e);
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    await fakeDevice(e, token, {}, (m, send, bin) => {
      if (m.t !== 'req') return;
      if (m.op === 'b.screenshot') bin({ id: m.id, kind: 'shot', mime: 'image/jpeg', w: 4, h: 3 }, JPEG);
      send({ t: 'res', id: m.id, ok: true, result: m.op === 'b.snapshot' ? { title: 'T', url: 'http://localhost:1/', items: [{ ref: 'e1', role: 'button', name: 'Go' }], total: 1 } : { w: 4, h: 3 } });
    });
    await until(() => Boolean(e.hub.hello(id)));
    const conv = e.app.store.createConversation({ title: 'x', mode: 'chat' });
    const look = tool(e.app, 'pc_browser_look');
    const run = async (over: Partial<ToolContext>) => {
      const shown: string[] = [];
      const proof: string[] = [];
      const out = await look.run({ screenshot: true }, ctxFor(e.app, conv.id, { showModel: (x) => shown.push(x), attachProof: (x) => proof.push(x), canSee: true, ...over }));
      return { out, shown, proof };
    };
    const cloud = await run({ modelLocal: false });
    assert.equal(cloud.shown.length, 1, 'normally the picture goes to the model in use (owner decision 4)');
    setPrivateLocal(true);
    try {
      const pl = await run({ modelLocal: false });
      assert.equal(pl.shown.length, 0, 'private local mode: no pixels to a model that is not local');
      assert.match(pl.out, /private local mode/);
      assert.equal(pl.proof.length, 1, 'the owner still gets it on her reply');
      assert.equal((await run({ modelLocal: true })).shown.length, 1, 'a local model may see it');
    } finally {
      setPrivateLocal(false);
    }
    // The computer's own "Screenshots only to models on this computer".
    const dev2 = await pair(e, 'Strict PC');
    await fakeDevice(e, dev2.token, { localOnly: true, app: 'strict' }, (m, send, bin) => {
      if (m.t !== 'req') return;
      if (m.op === 'b.screenshot') bin({ id: m.id, kind: 'shot', mime: 'image/jpeg', w: 4, h: 3 }, JPEG);
      send({ t: 'res', id: m.id, ok: true, result: m.op === 'b.snapshot' ? { title: 'T', url: 'x', items: [], total: 0 } : { w: 4, h: 3 } });
    });
    await until(() => e.hub.hello(dev2.id)?.app === 'strict');
    const shown: string[] = [];
    const out = await look.run({ screenshot: true, computer: 'Strict' }, ctxFor(e.app, conv.id, { showModel: (x) => shown.push(x), canSee: true, modelLocal: false }));
    assert.equal(shown.length, 0);
    assert.match(out, /only to local models/);
  } finally {
    await e.close();
  }
});

test('budgets, one task per computer, Stop pressed on the computer', async () => {
  const e = await env();
  try {
    const { token, id } = await pair(e);
    const dev = await fakeDevice(e, token, {}, (m, send) => {
      if (m.t === 'req' && m.op === 'b.tabs') send({ t: 'res', id: m.id, ok: true, result: { tabs: [] } });
    });
    await until(() => Boolean(e.hub.hello(id)));
    const a = e.app.store.createConversation({ title: 'a', mode: 'chat' });
    const b = e.app.store.createConversation({ title: 'b', mode: 'chat' });
    e.app.store.addMessage(a.id, 'user', 'look at my tabs');
    const tabs = tool(e.app, 'pc_browser_tabs');
    e.hub.budget = { steps: 2, minutes: 15 };
    await tabs.run({}, ctxFor(e.app, a.id));
    await assert.rejects(tabs.run({}, ctxFor(e.app, b.id)), /using Test PC for another conversation/);
    await tabs.run({}, ctxFor(e.app, a.id));
    await assert.rejects(tabs.run({}, ctxFor(e.app, a.id)), /computer budget/);
    // A new owner message is a new task with its own budget.
    e.app.store.addMessage(a.id, 'user', 'and again');
    await tabs.run({}, ctxFor(e.app, a.id));
    // Stop on the computer: the conversation's lease ends and the server hears it.
    const stops: unknown[] = [];
    const off = e.app.events!.subscribe((ev) => ev.type === 'computer' && ev.stopped && stops.push(ev));
    dev.send({ t: 'ev', kind: 'stopped', by: 'user' });
    await until(() => stops.length === 1);
    off();
    assert.equal(e.hub.usedBy(id), undefined);
  } finally {
    await e.close();
  }
});

test('never for other apps, groups, work channels, partners or the demo; members only with the owner switch', async () => {
  const e = await env();
  try {
    const { token, id } = await pair(e);
    await fakeDevice(e, token);
    await until(() => Boolean(e.hub.hello(id)));
    const names = () => (e.app.requests.at(-1)?.tools ?? []).map((t) => t.name);
    const conv = e.app.store.createConversation({ title: 'x', mode: 'chat' });
    await drain(runTurn(e.app, conv.id, 'hi'));
    assert.ok(names().includes('pc_browser_open') && names().includes('pc_devices'), names().join(','));
    await drain(runTurn(e.app, conv.id, 'hi', undefined, { externalApp: true }));
    assert.ok(!names().some((n) => n.startsWith('pc_')), 'other apps (/v1, MCP, Home Assistant)');
    for (const channel of ['api', 'mcp', 'home-assistant', 'alexa']) {
      const c = e.app.store.createConversation({ title: channel, mode: 'chat', channel });
      await drain(runTurn(e.app, c.id, 'hi'));
      assert.ok(!names().some((n) => n.startsWith('pc_')), channel);
    }
  } finally {
    await e.close();
  }
  // The demo: no hands at all.
  const d = await env({ demo: true });
  try {
    assert.equal(await upgradeStatus(d.base, { Authorization: 'Bearer sara_hands.x.y' }), 404);
    assert.equal(tool(d.app, 'pc_devices').isAvailable!(), false);
  } finally {
    await d.close();
  }
  // A member's space: 403 ownerOnly until the owner switches it on, then their own computers.
  const m = await env({ member: true });
  try {
    for (const [method, path] of [['GET', '/api/hands'], ['POST', '/api/hands/pair'], ['GET', '/api/computer'], ['GET', '/api/computer/frame/x']]) {
      const r = await api(m, method, path, method === 'POST' ? { token: m.token } : undefined);
      assert.equal(r.status, 403, path);
      assert.equal(r.json.ownerOnly, true, path);
    }
    assert.equal(tool(m.app, 'pc_devices').isAvailable!(), false);
    m.app.settings.update({ computerUse: { members: true } });
    assert.equal((await api(m, 'GET', '/api/hands')).status, 200);
    assert.equal((await api(m, 'PUT', '/api/computer', { members: false })).status, 403, 'the switch is the owner\u2019s');
    assert.equal(tool(m.app, 'pc_devices').isAvailable!(), true);
  } finally {
    await m.close();
  }
  assert.ok(MEMBER_ROUTES.has('hands') && MEMBER_ROUTES.has('computer'));
  assert.ok(OWNER_SETTINGS.includes('computerUse'));
});

test('the owner switch for members (off by default) and the install card for web-only users', async () => {
  const e = await env();
  try {
    assert.deepEqual((await api(e, 'GET', '/api/computer')).json.members, false);
    assert.equal((await api(e, 'PUT', '/api/computer', { members: 'yes' })).status, 400);
    assert.equal((await api(e, 'PUT', '/api/computer', { members: true })).json.members, true);
    const conv = e.app.store.createConversation({ title: 'x', mode: 'chat' });
    const out = await tool(e.app, 'pc_devices').run({}, ctxFor(e.app, conv.id));
    assert.ok(out.startsWith(NO_COMPUTER));
    assert.match(out, /install/);
    assert.deepEqual(cardFor({ name: 'pc_devices', args: {}, status: 'ok', output: out }), { kind: 'hands-install', url: 'https://github.com/farena-ai/sara/releases/latest' });
    assert.equal(tool(e.app, 'pc_browser_open').isAvailable!(), false, 'without a computer only pc_devices is offered');
    assert.equal((await api(e, 'GET', '/api/hands')).json.downloadUrl, 'https://github.com/farena-ai/sara/releases/latest');
  } finally {
    await e.close();
  }
});

test('one page agent for every browser; the device rules and masking', () => {
  const src = readFileSync(PAGE_AGENT_PATH, 'utf8');
  assert.equal(pageAgentSource(), src.trim());
  assert.ok(!/;\s*$/.test(src.trim()), 'one expression (callers append .call(...))');
  const browserTs = readFileSync(join(ROOT, 'src', 'browser.ts'), 'utf8');
  assert.ok(!/FIND_SCRIPT|READ_SCRIPT|CHECK_SCRIPT/.test(browserTs), 'the testing browser uses the shared page agent');
  for (const f of ['desktop/windows/src/sara.rc', 'desktop/mac/build.sh']) assert.match(readFileSync(join(ROOT, f), 'utf8'), /page-agent\.js/, f);
  // Evaluate the agent in a tiny fake DOM-less sandbox: the API shape.
  const agent = new Function(`return (\n${src.trim()}\n)`)() as { version: number; call: (n: string, a: unknown) => unknown };
  assert.equal(agent.version, 1);
  assert.deepEqual(agent.call('nope', {}), { error: 'unknown page-agent function' });
  assert.equal(maskSecrets(`key ${'sk-' + 'abcdefghijklmnop1234'} and ${'sara_hands.' + 'abc.def'}`), 'key [hidden] and [hidden]');
  assert.equal(addressAllowed('http://127.0.0.1:7881/preview/0123456789abcdef0123456789abcdef/', 'http://127.0.0.1:7881').ok, true);
  assert.equal(addressAllowed('http://127.0.0.1:7881/api/x', 'http://127.0.0.1:7881').ok, false);
  const bin = packBinary({ id: 'x', mime: 'image/jpeg' }, Buffer.from([1, 2, 3]));
  assert.deepEqual(parseBinary(bin)?.header, { id: 'x', mime: 'image/jpeg' });
  assert.equal(parseBinary(Buffer.from([0, 0, 0, 200, 1]))?.header, undefined);
});

test('the page: Computer use settings with tips, the explainer, the live view, cards and a fresh cache', () => {
  const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
  const html = web('index.html');
  assert.match(html, /data-page="co-computer"/);
  for (const id of ['cu-optin', 'cu-localonly', 'cu-members', 'cu-explain', 'cu-live', 'cu-live-stop', 'cu-get-link']) assert.match(html, new RegExp(`id="${id}"`), id);
  const page = html.slice(html.indexOf('data-page="co-computer"'), html.indexOf('</section>', html.indexOf('data-page="co-computer"')));
  // Every switch has a ? tip (Phase 88 added tips to lists too).
  const switches = page.match(/<label[^>]*>\s*<input [^>]*type="checkbox"[\s\S]*?<\/label>/g) ?? [];
  assert.ok(switches.length >= 3 && switches.every((l) => /class="tip"/.test(l)), 'every switch has a ? tip');
  assert.ok(!/style=/.test(page));
  const app = web('app.js');
  assert.match(app, /'handsPair'/);
  assert.match(app, /addEventListener\('computer'/);
  assert.match(web('result-cards.js'), /'hands-install': handsInstall/);
  assert.match(web('sw.js'), /caches\.open\('sara-shell-v21'\)[\s\S]*sara-shell-v20 from Phase 86/);
});
