// Phase 122 part 2 (2.55.1, docs/design/BRIDGES4.md §6, §11.1): Matrix as a chat app through her own
// Matrix account. A stand-in homeserver (test/fixtures/matrix/hs.mjs: HTTPS on a test CA) is reached by
// the real plugin process from plugins/matrix through Sara's socket broker and its test-only loopback
// override (`netTestLoopback`, honoured under `node --test` alone). No Matrix account, no real network,
// a fake model. Fake clocks wherever time matters (the pacer, typing, the long-poll).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { skipsOn } from '../src/plugins/bridge-db.ts';
import { allowListed, linkLine, PluginManager } from '../src/plugins/manager.ts';
import { parseManifest, satisfies } from '../src/plugins/manifest.ts';
import { addressAllowed, isTailnetAddress, PluginSockets, TAILNET_OFF } from '../src/plugins/net.ts';
import { KEY_SHAPED } from '../src/redact.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const PKG_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// The Matrix plugin needs Sara 2.55.1; until the release bumps package.json the test runs as 2.55.1.
const V = satisfies(PKG_VERSION, '>=2.55.1') ? PKG_VERSION : '2.55.1';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const load = (f: string): Promise<Any> => import(pathToFileURL(join(ROOT, 'plugins', 'matrix', f)).href);
const { toMatrix } = await load('html.mjs');
const { readSync, kindOf, stripFallback, chatOf, roomOf } = await load('sync.mjs');
const { codeOf, DIAGNOSES } = await load('diagnose.mjs');
const { Pacer, EVERY_MS, Typing, TYPING_EVERY_MS, retryAfterMs } = await load('pace.mjs');
const { Http1 } = await load('http1.mjs');
const { serverOf, baseHost, MatrixError } = await load('cs.mjs');
const { FakeHomeserver, HER, HER_PASSWORD, OWNER, STRANGER, PARTNER } = await import(pathToFileURL(join(ROOT, 'test', 'fixtures', 'matrix', 'hs.mjs')).href);

const until = async (f: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return f();
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function baseApp(dir: string): TestApp {
  const app = makeApp(dir, { now: new Date() });
  app.companionId = 'main';
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: new Date().toISOString() });
  app.runTracked = async (id, content, onEvent, opts) => {
    for await (const ev of runTurn(app, id, content, undefined, opts)) onEvent(ev as ChatEvent);
  };
  return app;
}

/** A manual clock for Sara's bridge timers (the progress message): timers run only when the test moves time on. */
class ManualClock {
  t = 0;
  #timers: { at: number; fn: () => void; id: number }[] = [];
  #id = 0;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#id;
    this.#timers.push({ at: this.t + Math.max(0, ms), fn, id });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.#timers = this.#timers.filter((x) => x.id !== h);
  }
  async advance(ms: number, step = 1000): Promise<void> {
    const end = this.t + ms;
    while (this.t < end) {
      this.t = Math.min(end, this.t + step);
      for (const due of this.#timers.filter((x) => x.at <= this.t).sort((a, b) => a.at - b.at)) {
        this.#timers = this.#timers.filter((x) => x !== due);
        due.fn();
        await pause(2);
      }
    }
  }
}

interface Rig {
  hs: Any;
  app: TestApp;
  pm: PluginManager;
  dir: string;
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: Record<string, Any> }>;
  room: string;
}

async function rig(t: TestContext, o: { login?: boolean; link?: boolean; history?: boolean; clock?: ManualClock } = {}): Promise<Rig> {
  const hs = await new FakeHomeserver().start();
  const { dir, cleanup } = tempDir();
  const app = baseApp(dir);
  const auth = new OwnerAuth(dir);
  const owner = auth.newToken!;
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, events: app.events, scrub: (x) => app.redactor.redact(x), fence: 'node-only', saraVersion: V, netCa: hs.caPem, lookup: async (h) => (h === 'localhost' ? ['127.0.0.1'] : []), netTestLoopback: true, ...(o.clock ? { clock: o.clock } : {}) });
  app.pluginManager = pm;
  pm.attach('main', app);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: V, revision: null, startedAt: new Date().toISOString() } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    const { pendingFor } = await import('../src/pending.ts');
    await until(() => !app.store.listConversations().some((c) => pendingFor(app).busy(c.id)), 10_000);
    for (let seen = -1, i = 0; seen !== app.requests.length && i < 10; i++) {
      seen = app.requests.length;
      await pause(300);
    }
    await pm.stopAll();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await hs.stop();
    app.store.close();
    cleanup();
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${owner}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const txt = await res.text();
    let json: Record<string, Any> = {};
    try {
      json = JSON.parse(txt);
    } catch {
      json = { text: txt };
    }
    return { status: res.status, json };
  };
  const review = pm.stageBuiltin('matrix');
  await pm.approve(review.id, { trust: true });
  // Her homeserver is the stand-in on this computer (the test-only override connects to its port).
  await pm.putSettings('matrix', 'main', { mxid: HER, homeserver: `localhost:${hs.port}` });
  await pm.setEnabled('matrix', 'main', true);
  assert.ok(await until(() => pm.processOf('matrix', 'main')?.state === 'ready'), 'the plugin started');
  const r: Rig = { hs, app, pm, dir, api, room: '' };
  if (o.history) {
    // A room he made before Sara ever synced, with an old message in it.
    r.room = hs.room({ name: 'Sara', members: [OWNER, HER] });
    hs.text(r.room, OWNER, 'an old message from last week');
  }
  if (o.login !== false) {
    const res = await api('POST', '/api/plugins/matrix/login', { companion: 'main', mxid: HER, password: HER_PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.ok, true, JSON.stringify(res.json));
    assert.ok(await until(() => hs.requests.some((x: Any) => x.path === '/_matrix/client/v3/sync')), 'the sync loop runs');
  }
  if (o.link !== false && o.login !== false) await link(r);
  return r;
}

const sentBodies = (r: Rig, room = r.room) => r.hs.sentTo(room).map((x: Any) => String(x.content.body ?? ''));

async function link(r: Rig) {
  const e = await r.api('POST', '/api/plugins/matrix/fix', { companion: 'main', fix: 'expect' });
  assert.equal(e.status, 200, JSON.stringify(e.json));
  r.room = r.hs.invite(OWNER, { name: 'Sara' });
  assert.ok(await until(() => r.hs.rooms.get(r.room).members.has(HER)), 'she joined his room during setup');
  await pause(300);
  r.hs.text(r.room, OWNER, `/link ${e.json.code}`);
  assert.ok(await until(() => (r.pm.settingsView('matrix', 'main').bridge?.ownerChats ?? []).includes(chatOf(r.room))), 'linked');
  assert.ok(await until(() => sentBodies(r).some((x: string) => /Linked/.test(x))), 'the link line went back');
}

// ------------------------------------------------------------------ pure pieces

test('the manifest, the review card, tips in six languages, B4 copies and the redactor', () => {
  const m = parseManifest(readFileSync(join(ROOT, 'plugins', 'matrix', 'sara-plugin.json'), 'utf8'), { saraVersion: V });
  assert.equal(m.sara, '>=2.55.1');
  assert.deepEqual(m.permissions.connect.map((c) => `${c.id}:${c.where}:${c.tls}:${c.ports === 'setting' ? 'setting' : c.ports.join(',')}`), ['hs:public:required:443,8448', 'hs-local:local:optional:setting']);
  assert.deepEqual(m.settings.map((s) => s.key), ['mxid', 'homeserver', 'onOtherMachine', 'token', 'typing', 'readReceipts', 'mirror']);
  assert.ok(m.settings.every((s) => s.tip.length <= 260));
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) for (const s of m.settings) assert.ok(m.i18n[lang]?.[s.label] && m.i18n[lang]?.[s.tip] && m.i18n[lang][s.tip].length <= 260, `${lang}: ${s.key}`);
  assert.throws(() => parseManifest(JSON.stringify({ ...JSON.parse(readFileSync(join(ROOT, 'plugins', 'matrix', 'sara-plugin.json'), 'utf8')), permissions: { connect: [{ id: 'x', host: 'setting:homeserver', ports: [443], where: 'public', tls: 'optional' }], settings: true } }), { saraVersion: V }), /only allowed to a program on this computer/);
  // B4: every http1.mjs and sara-plugin.mjs copy is the same file.
  const read = (p: string, f: string) => readFileSync(join(ROOT, 'plugins', p, f), 'utf8');
  assert.equal(read('matrix', 'http1.mjs'), read('whatsapp', 'http1.mjs'));
  assert.equal(read('matrix', 'sara-plugin.mjs'), readFileSync(join(ROOT, 'examples', 'plugins', 'sara-plugin.mjs'), 'utf8'));
  // §9.1: a Matrix token is key-shaped (refused in ordinary settings, masked in logs).
  assert.ok(KEY_SHAPED.some((re) => re.test(`syt_${'a'.repeat(30)}`)));
});

test('linking lines, @server allow entries and B3 (the tailnet under "my network")', async () => {
  assert.equal(linkLine('/link 123456', 'Sara')?.[1], '123456');
  assert.equal(linkLine('Sara link 123456', 'Sara')?.[1], '123456');
  assert.equal(linkLine('sara, link 123456', 'Sara')?.[1], '123456');
  assert.equal(linkLine('Sarah link 123456', 'Sara'), null);
  const cfg = { ownerChats: [], others: true, allow: ['@family.test'] };
  assert.equal(allowListed(cfg, '@mia:family.test', 'x', true), true);
  assert.equal(allowListed(cfg, '@mia:evil.test', 'x', true), false);
  assert.equal(allowListed({ ...cfg, allow: ['@mia:family.test'] }, '@mia:family.test', 'x', true), true);
  assert.ok(isTailnetAddress('100.100.1.2') && isTailnetAddress('fd7a:115c:a1e0::5') && !isTailnetAddress('100.63.0.1'));
  assert.equal(addressAllowed('100.100.1.2', 'local', true, true), undefined, 'on a tailnet with the switch: allowed');
  assert.equal(addressAllowed('100.100.1.2', 'local', true, false), TAILNET_OFF);
  assert.match(addressAllowed('100.100.1.2', 'local', false, true)!, /switch on/);
  assert.match(addressAllowed('100.100.1.2', 'public', true, true)!, /public server/, 'the public endpoint never reaches a tailnet address');
  assert.match(addressAllowed('192.168.1.5', 'public', true, true)!, /public server/);
  // Through the broker: tailnet down → refused with TAILNET_OFF.
  const ep = { id: 'hs-local', host: 'setting:homeserver', ports: 'setting' as const, where: 'local' as const, tls: 'optional' as const };
  const logs: string[] = [];
  const mk = (tailnet: boolean) => new PluginSockets({ endpoints: [ep], settings: () => ({ homeserver: '100.100.1.2:8008', onOtherMachine: true }), send: () => true, backlog: () => 0, log: (_k, t) => logs.push(t), tailnet: () => tailnet });
  const down = mk(false);
  await assert.rejects(down.open({ endpoint: 'hs-local' }), /TAILNET_OFF/);
  down.dispose();
});

test('the plugin parts: escape-first HTML, sync reading, error codes, the pacer, typing, the long-poll', async (t) => {
  const h = toMatrix('**Done** <script>alert(1)</script> <img src=x onerror=alert(1)>\n- a\n- `b`');
  assert.equal(h.format, 'org.matrix.custom.html');
  assert.match(h.formatted_body, /<strong>Done<\/strong>/);
  assert.match(h.formatted_body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(h.formatted_body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(h.formatted_body, /<script|<img/);
  assert.match(h.formatted_body, /<ul><li>a<\/li><li><code>b<\/code><\/li><\/ul>/);
  assert.equal(toMatrix('plain words').formatted_body, undefined);
  assert.match(toMatrix('[docs](javascript:alert(1))').formatted_body ?? '', /^(?!.*href="javascript)/);
  assert.equal(stripFallback('> <@alex:hs.test> earlier\n\nthe answer'), 'the answer');
  assert.equal(chatOf('!abc:hs.test'), 'abc:hs.test');
  assert.equal(roomOf('abc:hs.test'), '!abc:hs.test');
  assert.equal(serverOf('@sara-frank:matrix.org'), 'matrix.org');
  assert.equal(serverOf('not an id'), '');
  assert.equal(baseHost('https://matrix-client.matrix.org'), 'matrix-client.matrix.org');
  const s = readSync({ next_batch: 's2', rooms: { invite: { '!e:x': { invite_state: { events: [{ type: 'm.room.member', state_key: HER, sender: OWNER, content: { membership: 'invite' } }, { type: 'm.room.encryption', state_key: '', content: {} }] } } }, join: { '!r:x': { state: { events: [{ type: 'm.room.member', state_key: OWNER, content: { membership: 'join' } }] }, timeline: { events: [{ type: 'm.room.message', event_id: '$1', sender: OWNER, content: { msgtype: 'm.text', body: 'hi', 'm.mentions': { user_ids: [HER] } } }] } } } } }, HER);
  assert.equal(s.invites[0].encrypted, true);
  assert.equal(s.invites[0].inviter, OWNER);
  assert.deepEqual(kindOf(s.rooms[0].events[0]).mentions, [HER]);
  assert.equal(kindOf({ type: 'm.room.encrypted', content: {} }).kind, 'encrypted');
  assert.equal(kindOf({ type: 'm.room.message', content: { msgtype: 'm.audio', url: 'mxc://x/abc', 'org.matrix.msc3245.voice': {} } }).voice, true);
  assert.equal(kindOf({ type: 'm.reaction', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$p', key: '⏹' } } }).key, '⏹');
  assert.equal(codeOf({ errcode: 'M_UNKNOWN_TOKEN', status: 401 }), 'TOKEN_GONE');
  assert.equal(codeOf({ errcode: 'M_LIMIT_EXCEEDED', status: 429 }), 'RATE_LIMITED');
  assert.equal(codeOf({ errcode: 'M_FORBIDDEN', status: 403, login: true }), 'LOGIN_WRONG');
  assert.equal(codeOf({ message: `x (${TAILNET_OFF})` }), 'TAILNET_OFF');
  assert.equal(new MatrixError(429, { errcode: 'M_LIMIT_EXCEEDED' }, { 'retry-after': '2' }).retryMs, 2000);
  assert.equal(retryAfterMs({}, { retry_after_ms: 1500 }), 1500);
  assert.equal(retryAfterMs({}, {}), 5000);
  // The card's words (web/matrix.js) cover every code diagnose() knows.
  const card = readFileSync(join(ROOT, 'web', 'matrix.js'), 'utf8');
  for (const code of Object.keys(DIAGNOSES)) assert.ok(card.includes(`${code}:`), `the card explains ${code}`);
  // The pacer (fake clock): 10 at once → ≤ 5 at once, then ≤ 1 a second, in order.
  let now = 0;
  const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
  const pacer = new Pacer(clock);
  const at: number[] = [];
  const order: number[] = [];
  await Promise.all(Array.from({ length: 10 }, (_, i) => pacer.send('!r', async () => void (at.push(now), order.push(i)))));
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(at.filter((x) => x === 0).length, 5);
  for (let i = 5; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= EVERY_MS - 1, `gap ${i}`);
  // One 429 with Retry-After: 2 → waits 2 s and sends the same message again; order kept.
  now = 0;
  const p2 = new Pacer(clock);
  const tries: number[] = [];
  const got: string[] = [];
  let failOnce = true;
  await Promise.all(['a', 'b'].map((x) => p2.send('!r', async () => {
    tries.push(now);
    if (x === 'a' && failOnce) {
      failOnce = false;
      throw new MatrixError(429, { errcode: 'M_LIMIT_EXCEEDED' }, { 'retry-after': '2' });
    }
    got.push(x);
  }, (e: Any) => e.retryMs)));
  assert.deepEqual(got, ['a', 'b']);
  assert.equal(tries[1] - tries[0], 2000);
  // Typing across a 70-s turn: on at once, renewed every 25 s, off at the end (fake clock).
  let tnow = 0;
  const timers: { every: number; next: number; fn: () => void; id: number }[] = [];
  const tclock = { setInterval: (fn: () => void, every: number) => (timers.push({ every, next: tnow + every, fn, id: timers.length + 1 }), timers.length), clearInterval: (id: number) => timers.splice(timers.findIndex((x) => x.id === id), 1) };
  const puts: [number, boolean][] = [];
  const typing = new Typing(async (_room: string, on: boolean) => void puts.push([tnow, on]), tclock);
  typing.on('!r');
  for (tnow = 0; tnow <= 70_000; tnow += 1000) for (const x of timers) if (tnow >= x.next) (x.next += x.every), x.fn();
  typing.off('!r');
  assert.equal(TYPING_EVERY_MS, 25_000);
  assert.deepEqual(puts.map(([at2, on]) => `${at2}:${on}`), ['0:true', '25000:true', '50000:true', '71000:false']);
  // B4: a 40-s long-poll isn't cut at the default 30 s (mocked timers, a fake socket).
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let onData: (b: Buffer) => void = () => undefined;
  const fakeSara = { net: { open: async () => ({ write: async () => undefined, close: async () => undefined, onData: (f: (b: Buffer) => void) => void (onData = f), onClose: () => undefined }) } };
  const h1 = new Http1(fakeSara, 'hs', 'hs.test');
  let settled = '';
  const p = h1.request('GET', '/_matrix/client/v3/sync?since=s1&timeout=30000', {}, undefined, { timeoutMs: 40_000 }).then((r: Any) => (settled = `ok ${r.status}`), (e: Error) => (settled = e.message));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  t.mock.timers.tick(35_000);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(settled, '', 'still waiting after 35 s');
  onData(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}'));
  await p;
  assert.equal(settled, 'ok 200');
  t.mock.timers.reset();
});

// ------------------------------------------------------------------ the real plugin against the stand-in

test('login: one /login with "Sara (bot)", the token in the vault, the password nowhere; then setup, link and an owner turn', async (t) => {
  const r = await rig(t, { link: false, history: true });
  const logins = r.hs.requests.filter((x: Any) => x.method === 'POST' && x.path === '/_matrix/client/v3/login');
  assert.equal(logins.length, 1);
  assert.equal(logins[0].body.initial_device_display_name, 'Sara (bot)');
  assert.equal(logins[0].body.refresh_token, undefined, 'no refresh token asked for');
  const token = r.app.vault.get('plugin:matrix:token');
  assert.match(String(token), /^syt_/);
  assert.equal(r.hs.displayName, 'Sara (AI)', 'her display name says AI');
  // The password appears in no log, table, settings file or plugin data.
  const db = r.app.store.db;
  const dump = JSON.stringify([db.prepare('SELECT * FROM plugin_log').all?.() ?? [], r.app.settings.get(), r.pm.settingsView('matrix', 'main')]);
  assert.ok(!dump.includes(HER_PASSWORD), 'the password is not kept');
  const { readdirSync } = await import('node:fs');
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const f of walk(r.dir)) assert.ok(!readFileSync(f).includes(Buffer.from(HER_PASSWORD)), `not in ${f}`);
  // The setup state: steps 1–2 ✓, room not yet.
  let st = await r.api('GET', '/api/plugins/matrix/setup?companion=main');
  assert.deepEqual(st.json.steps.map((s: Any) => `${s.id}:${s.ok}`), ['account:true', 'login:true', 'room:true', 'hello:false', 'test:false']);
  // The room from before her first sync: its old message is history, never answered.
  await pause(500);
  assert.equal(r.app.requests.length, 0, 'history in the first batch is not answered');
  // Step 3–4: link with the name form (Element eats unknown /commands).
  const e = await r.api('POST', '/api/plugins/matrix/fix', { companion: 'main', fix: 'expect' });
  const dmRoom = r.hs.invite(OWNER, { name: 'Sara' });
  assert.ok(await until(() => r.hs.rooms.get(dmRoom).members.has(HER)), 'she joined his invite');
  await pause(200);
  r.hs.text(dmRoom, OWNER, `Sara link ${e.json.code}`);
  assert.ok(await until(() => (r.pm.settingsView('matrix', 'main').bridge?.ownerChats ?? []).includes(chatOf(dmRoom))), 'linked by the name form');
  r.room = dmRoom;
  // An owner message → one turn on plugin-matrix in the Matrix project, typing, a receipt.
  r.app.script.push(text('Hello from your companion.'));
  const ev = r.hs.text(dmRoom, OWNER, 'hi there');
  assert.ok(await until(() => sentBodies(r).includes('Hello from your companion.')), 'her answer arrived');
  const conv = r.app.store.listConversations().find((c) => c.channel === 'plugin-matrix');
  assert.ok(conv && !conv.partner);
  assert.ok(r.hs.typing.some((x: Any) => x.room === dmRoom && x.typing) && r.hs.typing.at(-1).typing === false, 'typing on, then off');
  assert.ok(r.hs.receipts.some((x: Any) => x.event === ev), 'a read receipt on his message');
  // Her own events in sync never start a turn.
  const turns = r.app.requests.length;
  await pause(600);
  assert.equal(r.app.requests.length, turns);
  st = await r.api('GET', '/api/plugins/matrix/setup?companion=main');
  assert.equal(st.json.steps.find((s: Any) => s.id === 'hello').ok, true);
  const tst = await r.api('POST', '/api/plugins/matrix/check', { companion: 'main', step: 'test' });
  assert.equal(tst.json.ok, true, JSON.stringify(tst.json.steps));
});

test('invites: his joined, a stranger declined (stranger-invite), an encrypted one explained and left (ENCRYPTED_ROOM)', async (t) => {
  const r = await rig(t);
  const strange = r.hs.invite(STRANGER, { name: 'Free crypto' });
  const secret = r.hs.invite(OWNER, { name: 'Private', encrypted: true });
  assert.ok(await until(() => (r.hs.left ?? []).includes(strange) && (r.hs.left ?? []).includes(secret)), 'both left');
  assert.ok(!r.hs.rooms.get(strange).members.has(HER), 'never joined the stranger');
  const lines = sentBodies(r, secret);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /can't read encrypted rooms yet/);
  const day = new Date().toISOString().slice(0, 10);
  const skips = skipsOn(r.app.store.db, 'plugin-matrix', day);
  assert.ok((skips['stranger-invite'] ?? 0) >= 1 && (skips.encrypted ?? 0) >= 1, JSON.stringify(skips));
  // His linked room switched to encryption later: one line, then silence.
  r.hs.encrypt(r.room);
  assert.ok(await until(() => sentBodies(r).some((x: string) => /can't read encrypted rooms/.test(x))));
  r.hs.say(r.room, OWNER, { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'xyz' }, 'm.room.encrypted');
  await pause(500);
  assert.equal(sentBodies(r).filter((x: string) => /encrypted/.test(x)).length, 1, 'said once');
  const st = await r.api('GET', '/api/plugins/matrix/setup?companion=main');
  assert.ok(st.json.rooms.some((x: Any) => x.encrypted && x.place === 'encrypted'));
});

test('rooms and partners: no mention → not answered; a mention → room; @server partners get the AI notice and no tools', async (t) => {
  const r = await rig(t);
  const group = r.hs.invite(OWNER, { name: 'Family', members: [PARTNER] });
  assert.ok(await until(() => r.hs.rooms.get(group).members.has(HER)));
  r.hs.join(group, PARTNER);
  await pause(300);
  const before = r.app.requests.length;
  r.hs.text(group, PARTNER, 'dinner at 7?');
  await pause(700);
  assert.equal(r.app.requests.length, before, 'a room message without a mention is not answered');
  r.app.script.push(text('Seven works.'));
  r.hs.text(group, PARTNER, 'Sara, does 7 work?', { 'm.mentions': { user_ids: [HER] } });
  assert.ok(await until(() => sentBodies(r, group).includes('Seven works.')), 'answered when addressed');
  const reply = r.hs.sentTo(group).find((x: Any) => x.content.body === 'Seven works.');
  assert.ok(reply.content['m.relates_to']?.['m.in_reply_to']?.event_id, 'room answers quote the message');
  const req = r.app.requests.at(-1)!;
  assert.ok(!(req.tools ?? []).length, 'no tools for someone else in a room');
  // A partner DM: others on, `@family.test` allowed.
  await r.pm.putSettings('matrix', 'main', {}, { ownerChats: [chatOf(r.room)], others: true, allow: ['@family.test'] });
  assert.ok(await until(() => r.pm.processOf('matrix', 'main')?.state === 'ready'));
  const pdm = r.hs.invite(PARTNER, { name: 'Mia' });
  assert.ok(await until(() => r.hs.rooms.get(pdm).members.has(HER)), 'a listed partner\'s invite is joined');
  await pause(300);
  r.app.script.push(text('Hi Mia!'));
  r.hs.text(pdm, PARTNER, 'hello');
  assert.ok(await until(() => sentBodies(r, pdm).includes('Hi Mia!')));
  const bodies = sentBodies(r, pdm);
  assert.ok(bodies.indexOf('Hi Mia!') > 0 && /AI/.test(bodies[0]), `the AI notice first: ${bodies.join(' | ')}`);
  assert.ok(!(r.app.requests.at(-1)!.tools ?? []).length, 'no tools offered');
  assert.ok(!r.hs.typing.some((x: Any) => x.room === pdm), 'no typing for partners');
});

test('media: his picture downloaded with the bearer reaches the model; her picture goes up as m.image; too big → MEDIA_TOO_BIG', async (t) => {
  const r = await rig(t);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000020000000308060000009d0a1c8a0000000d4944415478da63f8ffff3f0300060a020295e5bd400000000049454e44ae426082', 'hex');
  const uri = r.hs.putMedia(png, 'image/png');
  r.app.script.push(text('A tiny picture.'));
  r.hs.say(r.room, OWNER, { msgtype: 'm.image', body: 'pic.png', url: uri, info: { mimetype: 'image/png', size: png.length } });
  assert.ok(await until(() => sentBodies(r).includes('A tiny picture.')), 'answered');
  assert.ok((r.hs.downloads ?? []).every((x: Any) => x.bearer) && r.hs.downloads.length === 1, 'authenticated media with the bearer');
  const last = r.app.requests.at(-1)!;
  assert.ok(last.messages.some((m: Any) => (m.images ?? []).length > 0), 'the model got the picture');
  const { codeOf: c2, diagnose } = await load('diagnose.mjs');
  assert.equal(c2({ errcode: 'M_TOO_LARGE', status: 413 }), 'MEDIA_TOO_BIG');
  assert.match(diagnose('MEDIA_TOO_BIG').title, /bigger than her server allows/);
});

test('bad tokens and logins: TOKEN_GONE stops the sync and tells him once; NO_PASSWORD_LOGIN; wrong password; a pasted token; log out', async (t) => {
  const r = await rig(t, { link: false });
  // Her login ends (someone logged that session out).
  r.hs.tokens.clear();
  r.hs.text(r.hs.room({ members: [OWNER, HER] }), OWNER, 'wake');
  assert.ok(await until(() => r.pm.bridgeView('matrix', 'main').state === 'error'), 'the chip says so');
  const st = await r.api('GET', '/api/plugins/matrix/setup?companion=main');
  assert.equal(st.json.steps.find((s: Any) => s.id === 'login').diagnosis?.code, 'TOKEN_GONE');
  const syncs = r.hs.requests.filter((x: Any) => x.path.endsWith('/sync')).length;
  await pause(800);
  assert.equal(r.hs.requests.filter((x: Any) => x.path.endsWith('/sync')).length, syncs, 'the sync stopped');
  const notes = r.app.store.listConversations().flatMap((c) => r.app.store.messages(c.id)).filter((m) => /her login ended/i.test(m.content));
  assert.ok(notes.length <= 1, 'told once');
  // A wrong password, then a server without the password flow.
  const bad = await r.api('POST', '/api/plugins/matrix/login', { companion: 'main', mxid: HER, password: 'nope' });
  assert.equal(bad.json.diagnosis?.code, 'LOGIN_WRONG');
  r.hs.passwordFlow = false;
  const none = await r.api('POST', '/api/plugins/matrix/login', { companion: 'main', mxid: HER, password: HER_PASSWORD });
  assert.equal(none.json.diagnosis?.code, 'NO_PASSWORD_LOGIN');
  // A pasted token works.
  const tok = `syt_pasted_${'p'.repeat(24)}`;
  r.hs.tokens.set(tok, { user: HER, device: 'PASTED' });
  const pasted = await r.api('POST', '/api/plugins/matrix/token', { companion: 'main', mxid: HER, token: tok });
  assert.equal(pasted.json.ok, true, JSON.stringify(pasted.json));
  // Log her out: /logout at the server, the vault entries gone.
  const out = await r.api('POST', '/api/plugins/matrix/fix', { companion: 'main', fix: 'logout' });
  assert.equal(out.json.ok, true);
  assert.equal(r.hs.logouts, 1);
  assert.equal(r.app.vault.get('plugin:matrix:token'), undefined);
});

test('progress, Stop by reaction and steering: one edited progress event, ⏹ stops, a 👀 on a steer, her picture out as m.image', async (t) => {
  const clock = new ManualClock();
  const r = await rig(t, { clock });
  // A long turn under the test's control: tool steps, then the answer when the gate opens.
  let open: () => void = () => undefined;
  const gate = new Promise<void>((res) => (open = res));
  let stopped = false;
  const realRun = r.app.runTracked!;
  r.app.stopTurn = () => ((stopped = true), open(), true);
  r.app.runTracked = async (id, content, onEvent, opts) => {
    if (!/long job/.test(String(content))) return realRun(id, content, onEvent, opts);
    for (let i = 0; i < 4; i++) onEvent({ type: 'tool_call', id: `c${i}`, name: 'web_search', args: { query: `step ${i}` } } as unknown as ChatEvent);
    await gate;
    onEvent({ type: 'token', text: stopped ? 'Stopped.' : 'All done.' } as ChatEvent);
  };
  r.hs.text(r.room, OWNER, 'a long job please');
  await pause(300);
  await clock.advance(180_000);
  assert.ok(await until(() => r.hs.sentTo(r.room).some((x: Any) => /React ⏹ to stop/.test(x.content.body))), 'the progress message is up');
  const prog = r.hs.sentTo(r.room).find((x: Any) => /React ⏹ to stop/.test(x.content.body));
  const edits = () => r.hs.sentTo(r.room).filter((x: Any) => x.content['m.relates_to']?.rel_type === 'm.replace');
  assert.ok(edits().every((e: Any) => e.content['m.relates_to'].event_id === prog.event_id && e.content.body.startsWith('* ') && e.content['m.new_content']));
  assert.ok(edits().length <= 30, `${edits().length} edits`);
  // His ⏹ on the progress event stops the turn.
  r.hs.say(r.room, OWNER, { 'm.relates_to': { rel_type: 'm.annotation', event_id: prog.event_id, key: '⏹' } }, 'm.reaction');
  assert.ok(await until(() => stopped), 'the reaction stopped the turn');
  assert.ok(await until(() => r.hs.sentTo(r.room).some((x: Any) => x.content.body === 'Stopped.')), 'the final answer is a new event');
  await clock.advance(10_000);
  assert.ok(await until(() => edits().some((e: Any) => /Done/.test(e.content['m.new_content'].body))), 'the last edit is the Done summary');
  // A steer while she works: a 👀 annotation on it.
  let open2: () => void = () => undefined;
  const gate2 = new Promise<void>((res) => (open2 = res));
  r.app.runTracked = async (id, content, onEvent) => {
    if (/second long job/.test(String(content))) await gate2;
    onEvent({ type: 'token', text: 'ok' } as ChatEvent);
    void id;
  };
  r.hs.text(r.room, OWNER, 'a second long job');
  await pause(400);
  const steer = r.hs.text(r.room, OWNER, 'use pnpm instead');
  assert.ok(await until(() => r.hs.sentTo(r.room, 'm.reaction').some((x: Any) => x.content['m.relates_to'].event_id === steer && x.content['m.relates_to'].key === '👀')), 'a 👀 on the steer');
  open2();
  // Her picture out: an upload, then m.image with info (w, h, mimetype, size).
  const pngPath = join(r.dir, 'out.png');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(pngPath, Buffer.from('89504e470d0a1a0a0000000d49484452000000020000000308060000009d0a1c8a0000000d4944415478da63f8ffff3f0300060a020295e5bd400000000049454e44ae426082', 'hex'));
  const run = (r.pm as Any).processOf('matrix', 'main');
  run.send({ v: 1, type: 'bridge.send', bridge: 'matrix', chatId: chatOf(r.room), text: '', files: [{ fileId: 'f1', name: 'out.png', mime: 'image/png', size: 69 }] });
  run.send({ v: 1, type: 'bridge.file', bridge: 'matrix', chatId: chatOf(r.room), fileId: 'f1', seq: 0, last: true, data: readFileSync(pngPath).toString('base64') });
  assert.ok(await until(() => r.hs.sentTo(r.room).some((x: Any) => x.content.msgtype === 'm.image')), 'm.image sent');
  const img = r.hs.sentTo(r.room).find((x: Any) => x.content.msgtype === 'm.image');
  assert.match(img.content.url, /^mxc:\/\//);
  assert.deepEqual([img.content.info.w, img.content.info.h, img.content.info.mimetype], [2, 3, 'image/png']);
});

test('pace in the plugin: a 429 with Retry-After is waited out and the order kept; a dropped sync resumes', async (t) => {
  const r = await rig(t);
  r.hs.fail(/^PUT .*\/send\/m\.room\.message\//, 429, 'M_LIMIT_EXCEEDED', { retryAfter: 1 });
  const run = (r.pm as Any).processOf('matrix', 'main');
  for (const x of ['one', 'two', 'three']) run.send({ v: 1, type: 'bridge.send', bridge: 'matrix', chatId: chatOf(r.room), text: x });
  assert.ok(await until(() => ['one', 'two', 'three'].every((x) => sentBodies(r).includes(x)), 15_000), 'all three sent after the wait');
  const order = sentBodies(r).filter((x: string) => ['one', 'two', 'three'].includes(x));
  assert.deepEqual(order, ['one', 'two', 'three']);
  // The connection drops mid-sync: the loop comes back and nothing is lost.
  r.hs.dropSync = 1;
  await pause(200);
  r.app.script.push(text('Still here.'));
  r.hs.text(r.room, OWNER, 'are you there?');
  assert.ok(await until(() => sentBodies(r).includes('Still here.'), 15_000), 'answered after the drop');
});
