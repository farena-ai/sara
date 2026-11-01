// Phase 113: the hub client (src/hub.ts, src/routes/hub.ts): the anonymous daily check-in (exact
// keys, never sent from the demo / private local mode / offline / off / a member / tests by
// default, the jittered and saved schedule), notices shown once as plain text, Report a problem with
// the 428 proof-of-work retry, diagnostics scrubbing, My reports, and /bug and /idea. Every network
// call goes to a fake hub on this computer (node:http, an ephemeral port).
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OwnerAuth } from '../src/auth.ts';
import { parseCommand, runCommand, type BridgeAdapter } from '../src/bridges/commands.ts';
import { MEMBER_ROUTES } from '../src/household.ts';
import { buildPing, cleanNotice, detectChannel, HubPinger, HubState, modelKind, PING_KEYS, pingBlocked, powOk, scrubText, settingsShape, solvePow, TicketStore, type HubFacts, type HubSpace } from '../src/hub.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { RunStore } from '../src/runs.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, readBody, ROOT, tempDir } from './helpers.ts';

const FACTS: HubFacts = { version: '2.46.0', channel: 'source', os: 'linux', arch: 'x64', lang: 'en', companions: 2, members: 1, bridges: ['telegram'], features: ['plugins', 'mcp'], model: 'both' };

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown> | null;
}

/** A fake hub: records every request; `answer` decides the reply. */
async function fakeHub(t: TestContext, answer: (r: Seen) => { status?: number; json: unknown }) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const r: Seen = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null };
    seen.push(r);
    const a = answer(r);
    res.writeHead(a.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(a.json));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return { seen, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/sara/hub` };
}

function setup(t: TestContext, base: string, o: { member?: boolean; demo?: boolean; logLines?: string[] } = {}) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-01T12:00:00Z') });
  const state = new HubState(dir);
  state.update({ noticeShownAt: '2026-11-01T11:00:00Z' });
  const db = new DatabaseSync(join(dir, 'hub-test.db'));
  t.after(() => {
    db.close();
    app.store.close();
    setPrivateLocal(false);
    cleanup();
  });
  const hub: HubSpace = {
    state,
    base,
    member: o.member === true,
    demo: o.demo === true,
    tickets: new TicketStore(db),
    facts: () => FACTS,
    blocked: () => (o.member ? 'member' : pingBlocked({ demo: o.demo, on: state.get().on, noticeShown: Boolean(state.get().noticeShownAt), base })),
    scrub: (s) => scrubText(s, (x) => app.redactor.redact(x), { homes: [homedir()], dirs: [dir] }),
    ...(o.member ? {} : { logLines: () => (o.logLines ?? ['Sara is listening']).join('\n') }),
  };
  app.hub = hub;
  return { app, dir, hub, state };
}

async function serve(t: TestContext, app: ReturnType<typeof makeApp>, dir: string, extra: Record<string, unknown> = {}) {
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...extra });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
}

test('the check-in body has exactly the contract keys and only listed values (no names, paths, URLs, model names)', () => {
  const p = buildPing('0123456789abcdef0123456789abcdef', FACTS);
  assert.deepEqual(Object.keys(p), [...PING_KEYS]);
  assert.deepEqual([...PING_KEYS], ['v', 'id', 'version', 'channel', 'os', 'arch', 'lang', 'companions', 'members', 'bridges', 'features', 'model']);
  // Whatever main.ts hands over, nothing outside the lists gets in.
  const bad = buildPing('Alex', {
    version: '2.46.0 (C:\\Users\\alex)',
    channel: 'https://evil.example' as never,
    os: 'Alex-PC' as never,
    arch: 'x64',
    lang: 'klingon',
    companions: 4000,
    members: -3,
    bridges: ['telegram', 'https://hook.example/x', 'Alex'],
    features: ['plugins', 'gpt-4o-mini', '/home/alex/project', 'llama3:70b'],
    model: 'gpt-4o' as never,
  });
  assert.deepEqual(Object.keys(bad), [...PING_KEYS]);
  const text = JSON.stringify(bad);
  for (const leak of [/alex/i, /https?:/, /[\\/]home|Users/, /gpt|llama/, /klingon|evil/]) assert.doesNotMatch(text, leak);
  assert.equal(bad.companions, 99);
  assert.equal(bad.members, 0);
  assert.deepEqual(bad.features, ['plugins']);
  assert.equal(bad.model, 'none');
  assert.equal(bad.id, '0'.repeat(32));
  // Helpers that feed it.
  assert.equal(modelKind([{ baseUrl: 'http://127.0.0.1:11434' }, { baseUrl: 'https://api.openai.com/v1' }]), 'both');
  assert.equal(modelKind([{ baseUrl: 'http://192.168.1.20:11434' }]), 'local');
  assert.equal(modelKind([]), 'none');
  assert.equal(detectChannel({ env: {}, platform: 'linux', root: '/opt/sara', exists: () => false }), 'source');
  assert.equal(detectChannel({ env: { SARA_DATA: '/data' }, platform: 'linux', root: '/app', exists: () => false }), 'docker');
  assert.equal(detectChannel({ env: {}, platform: 'linux', root: '/opt/sara', exists: (p) => p === '/usr/local/bin/sara' }), 'installer');
  assert.equal(detectChannel({ env: { SARA_INSTALLED: '1' }, platform: 'win32', root: 'C:\\Program Files\\Sara\\app', exists: () => false }), 'installer');
  assert.equal(detectChannel({ env: { SARA_INSTALLED: '1' }, platform: 'darwin', root: '/Applications/Sara.app/Contents/Resources/app', exists: () => false }), 'desktop-app');
  assert.equal(detectChannel({ env: {}, platform: 'darwin', root: '/opt/homebrew/Cellar/sara/2.46.0/libexec', exists: () => false }), 'homebrew');
  assert.equal(detectChannel({ env: {}, platform: 'win32', root: 'C:\\Users\\x\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Sara', exists: () => false }), 'winget');
  assert.equal(detectChannel({ env: { SARA_HUB_CHANNEL: 'docker' }, platform: 'linux', root: '/x', exists: () => false }), 'docker');
});

test('never sent: demo, member, private local mode (and so offline), off, tests by default, before the notice', (t) => {
  const real = 'https://backstagecoding.com/sara/hub';
  const local = 'http://127.0.0.1:7886/sara/hub';
  const base = { on: true, noticeShown: true };
  t.after(() => setPrivateLocal(false));
  assert.equal(pingBlocked({ ...base, demo: true, base: local, env: {} }), 'demo');
  assert.equal(pingBlocked({ ...base, base: local, env: { SARA_DEMO: '1' } }), 'demo');
  assert.equal(pingBlocked({ ...base, member: true, base: local, env: {} }), 'member');
  assert.equal(pingBlocked({ ...base, on: false, base: local, env: {} }), 'off');
  assert.equal(pingBlocked({ ...base, base: real, env: { NODE_TEST_CONTEXT: 'child-v8' } }), 'tests', 'tests never reach the real hub');
  assert.equal(pingBlocked({ ...base, base: local, env: { NODE_TEST_CONTEXT: 'child-v8' } }), undefined, 'a local fake hub is fine');
  assert.equal(pingBlocked({ ...base, noticeShown: false, base: local, env: {} }), 'notice');
  assert.equal(pingBlocked({ ...base, base: real, env: {} }), undefined);
  setPrivateLocal(true);
  assert.equal(pingBlocked({ ...base, base: local, env: {} }), 'private', 'private local mode blocks it even for a hub on this computer');
  assert.equal(pingBlocked({ ...base, base: real, env: {} }), 'private');
});

test('the schedule: 10–60 min after start, then about a day, `next` honoured, backoff, saved across restarts; blocked pings never reach the hub', async (t) => {
  let reply: { status?: number; json: unknown } = { json: { ok: true } };
  const hubSrv = await fakeHub(t, () => reply);
  const { dir, state } = setup(t, hubSrv.base);
  let now = Date.parse('2026-11-01T12:00:00Z');
  const timers: number[] = [];
  let on = true;
  const mk = (rand: number) =>
    new HubPinger({ state, facts: () => FACTS, blocked: () => (on ? undefined : 'off'), base: hubSrv.base, now: () => now, random: () => rand, setTimer: (_fn, ms) => timers.push(ms), clearTimer: () => undefined });
  const p = mk(0.5);
  p.start();
  assert.equal(timers.at(-1), 35 * 60_000, '10 + 0.5 × 50 minutes');
  assert.equal(JSON.parse(readFileSync(join(dir, 'hub.json'), 'utf8')).nextAt, new Date(now + 35 * 60_000).toISOString(), 'saved');
  for (const r of [0, 0.999]) {
    const q = mk(r);
    timers.length = 0;
    state.update({ nextAt: null });
    q.start();
    assert.ok(timers[0] >= 10 * 60_000 && timers[0] <= 60 * 60_000, String(timers[0]));
  }
  now += 35 * 60_000;
  let r = await p.tick();
  assert.equal(r.sent, true);
  assert.equal(hubSrv.seen.length, 1);
  const got = hubSrv.seen[0];
  assert.equal(got.path, '/sara/hub/v1/ping');
  assert.equal(got.headers['x-sara-hub'], '1');
  assert.equal(got.headers.cookie, undefined);
  assert.deepEqual(Object.keys(got.body!), [...PING_KEYS]);
  assert.equal(state.get().lastSentAt, new Date(now).toISOString());
  assert.equal(timers.at(-1), 24 * 3600_000, 'random 0.5 → exactly a day');
  const day0 = mk(0).day();
  const day1 = mk(1).day();
  assert.equal(day0, 22 * 3600_000);
  assert.equal(day1, 26 * 3600_000);
  // The hub's `next` wins (clamped to at least an hour).
  reply = { json: { ok: true, next: 7200 } };
  r = await p.tick();
  assert.equal(timers.at(-1), 7200_000);
  reply = { json: { ok: true, next: 5 } };
  await p.tick();
  assert.equal(timers.at(-1), 3600_000);
  // Errors back off: 30 min, then 1 h (± 20 %; random 0.5 → exact).
  reply = { status: 503, json: { ok: false, error: 'busy' } };
  r = await p.tick();
  assert.equal(r.sent, false);
  assert.equal(timers.at(-1), 30 * 60_000);
  await p.tick();
  assert.equal(timers.at(-1), 60 * 60_000);
  assert.equal(state.get().failures, 2);
  reply = { json: { ok: true } };
  await p.tick();
  assert.equal(state.get().failures, 0);
  // A restart keeps the saved time when it is later than the 10–60 minute first wait.
  const saved = Date.parse(state.get().nextAt!);
  const again = new HubPinger({ state: new HubState(dir), facts: () => FACTS, blocked: () => undefined, base: hubSrv.base, now: () => now, random: () => 0.5, setTimer: (_f, ms) => timers.push(ms), clearTimer: () => undefined });
  again.start();
  assert.equal(timers.at(-1), saved - now);
  // Off: nothing reaches the hub, and it looks again in about a day.
  const before = hubSrv.seen.length;
  on = false;
  r = await p.tick();
  assert.equal(r.blocked, 'off');
  assert.equal(hubSrv.seen.length, before);
});

test('a notice from the hub is shown once, as plain text, capped; the routes show and forget it', async (t) => {
  const evil = `<img src=x onerror="alert(1)">Update\u0007 ${'x'.repeat(600)}`;
  const hubSrv = await fakeHub(t, () => ({ json: { ok: true, notice: { id: 'n-1', text: evil, level: 'update', url: 'javascript:alert(1)' } } }));
  const { app, dir, state } = setup(t, hubSrv.base);
  const p = new HubPinger({ state, facts: () => FACTS, blocked: () => undefined, base: hubSrv.base, setTimer: () => 0, clearTimer: () => undefined });
  await p.tick();
  const b = state.get().banner!;
  assert.equal(b.id, 'n-1');
  assert.equal(b.level, 'update');
  assert.ok(b.text.length <= 280);
  assert.doesNotMatch(b.text, /\u0007/);
  assert.equal(b.url, undefined, 'only https links');
  assert.equal(cleanNotice({ id: 'x', text: 'hi', url: 'https://example.com/notes' })!.url, 'https://example.com/notes');
  const api = await serve(t, app, dir);
  let r = await api('GET', '/hub');
  assert.equal(r.json.banner.id, 'n-1');
  r = await api('POST', '/hub/notice', { id: 'n-1' });
  assert.equal(r.json.banner, null);
  await p.tick();
  assert.equal(state.get().banner, null, 'the same notice never comes back');
  // The page shows it with textContent only.
  const js = readFileSync(join(ROOT, 'web', 'hub.js'), 'utf8');
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(js, /hub-banner-text'\)\.textContent = /);
});

test('the routes: the switch, the first-run notice, Show what’s sent, Reset the install ID; members and the demo', async (t) => {
  const hubSrv = await fakeHub(t, () => ({ json: { ok: true } }));
  const { app, dir, state } = setup(t, hubSrv.base);
  state.update({ noticeShownAt: null });
  const api = await serve(t, app, dir);
  let r = await api('GET', '/hub');
  assert.equal(r.status, 200);
  assert.equal(r.json.on, true, 'on by default');
  assert.equal(r.json.firstRun, true);
  assert.equal(r.json.blocked, 'notice');
  r = await api('POST', '/hub/first-run', { action: 'shown' });
  assert.equal(r.json.blocked, null);
  r = await api('GET', '/hub/preview');
  assert.deepEqual(Object.keys(r.json.payload), [...PING_KEYS]);
  assert.equal(r.json.payload.id, state.get().id);
  const old = state.get().id;
  r = await api('POST', '/hub/reset-id', {});
  assert.notEqual(r.json.installId, old);
  assert.match(r.json.installId, /^[0-9a-f]{32}$/);
  r = await api('POST', '/hub/first-run', { action: 'off' });
  assert.equal(r.json.on, false);
  assert.equal(r.json.firstRun, false);
  assert.equal(r.json.blocked, 'off');
  r = await api('PUT', '/hub', { on: true });
  assert.equal(r.json.on, true);
  assert.equal(hubSrv.seen.length, 0, 'nothing in these routes calls the hub');
  // The demo refuses the whole family.
  const demo = await serve(t, app, dir, { demo: true });
  assert.notEqual((await demo('GET', '/hub')).status, 200);
  assert.notEqual((await demo('POST', '/hub/tickets', { title: 'x' })).status, 201);
});

test('a member: their own reports, never the check-in settings', async (t) => {
  const hubSrv = await fakeHub(t, (r) => (r.path.endsWith('/v1/tickets') ? { json: { ok: true, ticket: 'SARA-7', token: 'b'.repeat(32) } } : { json: { ok: true } }));
  const { app, dir, hub } = setup(t, hubSrv.base, { member: true });
  hub.state.update({ powBits: 8 });
  assert.ok(MEMBER_ROUTES.has('hub'));
  const api = await serve(t, app, dir);
  assert.equal((await api('GET', '/hub')).json.member, true);
  for (const [m, p, b] of [['PUT', '/hub', { on: false }], ['GET', '/hub/preview', undefined], ['POST', '/hub/reset-id', {}], ['POST', '/hub/first-run', { action: 'dismiss' }]] as const) {
    const r = await api(m, p, b);
    assert.equal(r.status, 403, p);
    assert.equal(r.json.ownerOnly, true);
  }
  const d = await api('POST', '/hub/diagnostics', {});
  assert.equal(d.json.diagnostics.log, undefined, "a member never gets the server's log");
  const r = await api('POST', '/hub/tickets', { kind: 'bug', title: 'The planner froze' });
  assert.equal(r.status, 201);
  assert.equal((await api('GET', '/hub/tickets')).json.tickets[0].ticket, 'SARA-7');
  assert.equal(hubSrv.seen.filter((x) => x.path.endsWith('/v1/ping')).length, 0, 'members never ping');
});

test('a ticket: proof of work, the 428 retry at the bits the hub asks for, stored for My reports; refused in private mode', async (t) => {
  let need = 10;
  let first = true;
  const hubSrv = await fakeHub(t, (r) => {
    if (r.path !== '/sara/hub/v1/tickets') return { status: 404, json: { ok: false } };
    const b = r.body!;
    const pow = b.pow as { nonce: string; bits: number };
    if (first) {
      first = false;
      return { status: 428, json: { ok: false, error: 'pow', bits: need } };
    }
    if (pow.bits < need || !powOk(String(b.id), String(b.title), pow.nonce, pow.bits)) return { status: 428, json: { ok: false, error: 'pow', bits: need } };
    return { json: { ok: true, ticket: 'SARA-1234', token: 'a'.repeat(32) } };
  });
  const { app, dir, state } = setup(t, hubSrv.base);
  state.update({ powBits: 8 });
  const api = await serve(t, app, dir);
  assert.equal((await api('POST', '/hub/tickets', { kind: 'bug', title: '' })).status, 400);
  assert.equal((await api('POST', '/hub/tickets', { kind: 'bug', title: 'x', contact: 'not an email' })).status, 400);
  const r = await api('POST', '/hub/tickets', { kind: 'idea', title: 'A dark planner', body: 'Please', contact: 'alex@example.com' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.ticket, 'SARA-1234');
  const sent = hubSrv.seen.filter((x) => x.path.endsWith('/v1/tickets'));
  assert.equal(sent.length, 2, 'one 428, one retry');
  assert.equal((sent[1].body!.pow as { bits: number }).bits, 10);
  assert.equal(state.get().powBits, 10, 'remembered for the next one');
  assert.deepEqual(Object.keys(sent[1].body!).sort(), ['body', 'contact', 'id', 'kind', 'lang', 'os', 'pow', 'title', 'v', 'version']);
  assert.equal(sent[1].body!.id, state.get().id);
  const mine = (await api('GET', '/hub/tickets')).json.tickets;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].token, undefined, 'the reply token never goes to the page');
  // The chunked solver finds an 18-bit answer without blocking (the default difficulty).
  const nonce = await solvePow('0'.repeat(32), 'title', 12);
  assert.ok(powOk('0'.repeat(32), 'title', nonce, 12));
  need = 30;
  setPrivateLocal(true);
  const before = hubSrv.seen.length;
  const p = await api('POST', '/hub/tickets', { kind: 'bug', title: 'Offline' });
  assert.equal(p.status, 409);
  assert.equal(hubSrv.seen.length, before, 'nothing left in private local mode');
});

test('diagnostics are built here, scrubbed (planted secrets, emails, home paths, addresses), and scrubbed again on the way out', async (t) => {
  const stripe = 'sk_' + 'live_' + '51HfakeKEYabcdefghij1234';
  const openai = 'sk-' + 'proj-' + 'Q'.repeat(12) + '9'.repeat(12);
  const vaultValue = 'vault' + '-secret-' + 'Z9y8X7w6';
  const mail = 'alex' + '@' + 'example.com';
  const home = join(homedir(), 'secret-project', 'notes.txt');
  const lines = [`boom with ${stripe}`, `key ${openai}`, `mailing ${mail}`, `reading ${home}`, 'C:\\Users\\alexander\\Desktop\\x.txt', '/home/alexander/x.txt', 'peer 203.0.113.9 said hi', `vault ${vaultValue}`, 'Authorization: Bearer ' + 'abcdefghijklmnopqrstuvwxyz0123'];
  const hubSrv = await fakeHub(t, () => ({ json: { ok: true, ticket: 'SARA-9', token: 'c'.repeat(32) } }));
  const { app, dir, state } = setup(t, hubSrv.base, { logLines: lines });
  state.update({ powBits: 8 });
  app.vault.set('provider:test', vaultValue);
  app.settings.update({ ownerName: 'Alex', timeZone: 'Europe/Berlin' });
  const conv = app.store.createConversation();
  // The failing turn's steps: tool names and statuses only (never the command or its output).
  app.runs = new RunStore(app.store.db);
  const runId = app.runs.open({ kind: 'turn', conversationId: conv.id });
  app.runs.writeStep(runId, 0, { model: 'fake-small' }, '2026-11-01T12:00:00Z', null, { calls: [], tools: [{ id: 'c1', name: 'shell', summary: `cat ${home}`, args: { cmd: `cat ${home}` }, status: 'error', output: stripe, outputChars: 40, ms: 3 }], files: [], contradictions: [] });
  const api = await serve(t, app, dir);
  const d = (await api('POST', '/hub/diagnostics', { error: `TypeError at ${home}: ${stripe}`, conversationId: conv.id })).json.diagnostics;
  const all = JSON.stringify(d);
  for (const leak of [stripe, openai, vaultValue, mail, 'secret-project', 'alexander', '203.0.113.9', 'abcdefghijklmnopqrstuvwxyz0123', 'Alex', 'Europe/Berlin']) assert.ok(!all.includes(leak), `leaked ${leak}`);
  assert.match(d.system, /^Sara 2\.46\.0/);
  assert.deepEqual(d.steps, [{ tool: 'shell', status: 'error' }]);
  assert.ok(!all.includes('fake-small'), 'no model names');
  assert.equal(d.settingsShape.ownerName, true, 'which keys are set, never their values');
  assert.match(d.log, /\[REDACTED\]/);
  assert.match(d.log, /\[email\]/);
  assert.equal(settingsShape({ telegram: { enabled: false }, providers: [1, 2], name: 'x' }).providers, 2);
  // A tampered page sends the raw text back: the server scrubs it again.
  const r = await api('POST', '/hub/tickets', { kind: 'bug', title: 'Crash', body: `my key is ${stripe}`, diagnostics: { log: lines.join('\n'), error: `at ${home}`, steps: [{ tool: 'shell<script>', status: 'error' }], settingsShape: { ownerName: 'Alex' } } });
  assert.equal(r.status, 201);
  const arrived = JSON.stringify(hubSrv.seen.at(-1)!.body);
  for (const leak of [stripe, openai, vaultValue, mail, 'secret-project', 'alexander', '203.0.113.9', '<script>', 'Alex']) assert.ok(!arrived.includes(leak), `arrived with ${leak}`);
});

test('My reports: polled with the stored token when opened, replies shown as plain text; the reporter answers', async (t) => {
  const tok = 'd'.repeat(32);
  const replies = [{ at: '2026-11-01T13:00:00Z', from: 'team', text: 'Thanks <b>Alex</b>\u0000, fixed!' }];
  const hubSrv = await fakeHub(t, (r) => {
    if (r.path.endsWith('/v1/tickets')) return { json: { ok: true, ticket: 'SARA-55', token: tok } };
    if (r.path.startsWith('/sara/hub/v1/tickets/SARA-55?')) return { json: { ok: true, ticket: 'SARA-55', kind: 'bug', title: 'x', status: 'fixed', fixedIn: '2.46.1', replies } };
    if (r.path === '/sara/hub/v1/tickets/SARA-55/reply') {
      replies.push({ at: '2026-11-01T14:00:00Z', from: 'you', text: String(r.body!.text) });
      return { json: { ok: true } };
    }
    return { status: 404, json: { ok: false } };
  });
  const { app, dir, state } = setup(t, hubSrv.base);
  state.update({ powBits: 8 });
  const api = await serve(t, app, dir);
  await api('POST', '/hub/tickets', { kind: 'bug', title: 'Late reminders' });
  const polled = hubSrv.seen.length;
  let r = await api('GET', '/hub/tickets');
  assert.equal(hubSrv.seen.length, polled, 'listing reads only what is stored');
  r = await api('POST', '/hub/tickets/refresh', {});
  const g = hubSrv.seen.at(-1)!;
  assert.match(g.path, new RegExp(`token=${tok}`));
  const tk = r.json.tickets[0];
  assert.equal(tk.status, 'fixed');
  assert.equal(tk.fixedIn, '2.46.1');
  assert.equal(tk.replies[0].text, 'Thanks <b>Alex</b>, fixed!', 'kept as text (the page shows it with textContent)');
  r = await api('POST', '/hub/tickets/SARA-55/reply', { text: 'Works now, thanks' });
  assert.equal(r.status, 200);
  assert.equal(r.json.tickets[0].replies.at(-1).from, 'you');
  assert.equal((await api('POST', '/hub/tickets/SARA-99/reply', { text: 'x' })).status, 404);
});

test('/bug and /idea: the web app opens the sheet; chat apps link to it or file a quick report after the OK', async (t) => {
  const hubSrv = await fakeHub(t, () => ({ json: { ok: true, ticket: 'SARA-77', token: 'e'.repeat(32) } }));
  const { app, state } = setup(t, hubSrv.base);
  state.update({ powBits: 8 });
  const conv = app.store.createConversation();
  const adapter: BridgeAdapter = { currentSession: () => conv, startSession: () => conv, stopTurn: () => false, clearQueue: () => 0, appLink: 'https://sara.example' };
  const cmd = (text: string) => parseCommand(text, { herName: 'Sara', namePrefix: false })!;
  assert.equal(cmd('/bug the planner froze').name, 'bug');
  assert.equal(cmd('/idea').name, 'idea');
  let r = await runCommand({ app, bridge: 'web', place: 'owner-dm', who: 'owner', lang: 'en', cmd: cmd('/bug the planner froze'), adapter });
  assert.deepEqual(r.report, { kind: 'bug', text: 'the planner froze' });
  r = await runCommand({ app, bridge: 'telegram', place: 'owner-dm', who: 'owner', lang: 'en', cmd: cmd('/idea'), adapter });
  assert.match(r.text, /https:\/\/sara\.example\/#report=idea/);
  assert.equal(r.approval, undefined);
  r = await runCommand({ app, bridge: 'telegram', place: 'owner-dm', who: 'owner', lang: 'es', cmd: cmd('/bug reminders come late'), adapter });
  assert.ok(r.approval, 'asks first');
  assert.equal(hubSrv.seen.length, 0, 'nothing sent before the OK');
  app.approvals.decide(r.approval!.id, true);
  const said = await r.approval!.done;
  assert.match(said, /SARA-77/);
  const body = hubSrv.seen.at(-1)!.body!;
  assert.equal(body.title, 'reminders come late');
  assert.equal(body.diagnostics, undefined, 'quick reports carry no diagnostics');
  assert.equal(app.hub!.tickets.list()[0].ticket, 'SARA-77');
  r = await runCommand({ app, bridge: 'telegram', place: 'owner-dm', who: 'owner', lang: 'en', cmd: cmd('/bug nope'), adapter });
  app.approvals.decide(r.approval!.id, false);
  assert.match(await r.approval!.done, /nothing was sent/);
  r = await runCommand({ app, bridge: 'telegram', place: 'partner-dm', who: 'person', lang: 'en', cmd: cmd('/bug hi'), adapter });
  assert.equal(r.refused, true, 'only the owner');
});

test('the page: the notice text, Privacy page, report sheet and My reports (tips ≤ 260, no inline style, 44 px, sw bumped, help)', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.ok(html.includes("Sara sends one small anonymous check-in a day so we can support you and plan features: the version, the kind of computer (Windows, Mac or Linux) and which features are switched on. We don&#39;t keep your IP address, your name, your chats or anything about your system beyond that."));
  for (const id of ['hub-first', 'hub-first-show', 'hub-first-off', 'hub-banner', 'hub-on', 'hub-show', 'hub-reset', 'hub-preview', 'hub-report', 'hub-kind', 'hub-title', 'hub-body', 'hub-email', 'hub-diag-add', 'hub-mine', 'help-report', 'help-suggest', 'help-mine']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /data-page="dh-privacy"[^>]*data-owner-only/);
  const part = html.slice(html.indexOf('id="hub-first"'), html.indexOf('id="update-note"')) + html.slice(html.indexOf('data-page="dh-privacy"'), html.indexOf('data-page="dh-reports"')) + html.slice(html.indexOf('id="hub-report"'), html.indexOf('Phase 88: the one-time'));
  assert.doesNotMatch(part, /style="/);
  for (const m of part.matchAll(/data-tip="([^"]*)"/g)) assert.ok(m[1].length <= 260, m[1].slice(0, 40));
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const d = JSON.parse(readFileSync(join(ROOT, 'web', 'i18n', `${lang}.json`), 'utf8')) as Record<string, string>;
    for (const m of part.matchAll(/data-tip="([^"]*)"/g)) {
      const k = m[1].replace(/&quot;/g, '"');
      assert.ok(d[k] && d[k].length <= 260, `${lang}: ${k.slice(0, 40)}`);
    }
  }
  const css = readFileSync(join(ROOT, 'web', 'hub.css'), 'utf8');
  assert.match(css, /min-height: 44px/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b/i, 'theme tokens only');
  assert.match(html, /href="\/hub\.css"/);
  assert.match(readFileSync(join(ROOT, 'web', 'sw.js'), 'utf8'), /caches\.open\('sara-shell-v47'\)/);
  const help = readFileSync(join(ROOT, 'web', 'help.html'), 'utf8');
  assert.match(help, /<h2 id="support">/);
  const tips = JSON.parse(readFileSync(join(ROOT, 'web', 'tips.json'), 'utf8')) as { pages: Record<string, unknown> };
  assert.ok(tips.pages['dh-privacy']);
});
