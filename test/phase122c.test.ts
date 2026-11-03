// Phase 122 part 3 (2.55.2, docs/design/BRIDGES4.md §4, §11.2): iMessage through BlueBubbles. A stand-in
// BlueBubbles Server (test/fixtures/imessage/bb.mjs, plain HTTP on 127.0.0.1) is reached by the real
// plugin process from plugins/imessage through Sara's socket broker; its unsigned webhooks ring Sara's
// real /hook/ route. No Mac, no Apple ID, no network, a fake model; fake clocks where time matters
// (the pacer, the working line) and polling (never fixed pauses) for plugin restarts.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { skipsOn } from '../src/plugins/bridge-db.ts';
import { PluginManager } from '../src/plugins/manager.ts';
import { parseManifest, permissionLines, satisfies } from '../src/plugins/manifest.ts';
import { Redactor } from '../src/redact.ts';
import { doorbellPing, HookManager } from '../src/webhooks.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const PKG_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// The iMessage plugin needs Sara 2.55.2; until the release bumps package.json the test runs as 2.55.2.
const V = satisfies(PKG_VERSION, '>=2.55.2') ? PKG_VERSION : '2.55.2';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const load = (f: string): Promise<Any> => import(pathToFileURL(join(ROOT, 'plugins', 'imessage', f)).href);
const { flatten, split, plainCommand, MORE } = await load('format.mjs');
const { codeOf, DIAGNOSES } = await load('diagnose.mjs');
const { Pacer, EVERY_MS, BURST, pollDelay } = (await load('pace.mjs')).pacing('imessage'); // PL2d: one pace.mjs, per-app limits
const { chatOf, guidOf, readInfo, accountHandles } = await load('bb.mjs');
const { FakeBlueBubbles, BB_PASSWORD, HER, OWNER, STRANGER, PARTNER, dmGuid, FIXTURE_JPEG, FIXTURE_HEIC } = await import(pathToFileURL(join(ROOT, 'test', 'fixtures', 'imessage', 'bb.mjs')).href);

const until = async (f: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return f();
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

function baseApp(dir: string): TestApp {
  const app = makeApp(dir, { now: new Date() });
  app.companionId = 'main';
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: new Date().toISOString() });
  app.runTracked = async (id, content, onEvent, opts) => {
    for await (const ev of runTurn(app, id, content, undefined, opts)) onEvent(ev as ChatEvent);
  };
  return app;
}

/** A manual clock for Sara's bridge timers (the working line): timers run only when the test moves time on. */
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
  bb: Any;
  app: TestApp;
  pm: PluginManager;
  dir: string;
  base: string;
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: Record<string, Any> }>;
  stdin: string[];
}

const ready = (r: Rig) => until(() => r.pm.processOf('imessage', 'main')?.state === 'ready');

/** Records every line Sara writes to the plugin (B2: the doorbell never carries a message's text). */
function tap(r: Rig) {
  const proc = (r.pm as Any).processOf('imessage', 'main');
  if (!proc || proc.__tapped) return;
  proc.__tapped = true;
  const send0 = proc.send.bind(proc);
  const req0 = proc.request.bind(proc);
  proc.send = (m: Any) => (r.stdin.push(JSON.stringify(m)), send0(m));
  proc.request = (type: string, body: Any, ms: number) => (r.stdin.push(JSON.stringify({ type, ...body })), req0(type, body, ms));
}

async function rig(t: TestContext, o: { privateApi?: boolean; setup?: boolean; link?: boolean; clock?: ManualClock; bb?: Record<string, unknown> } = {}): Promise<Rig> {
  const bb = await new FakeBlueBubbles({ privateApi: o.privateApi, ...(o.bb ?? {}) }).start();
  const { dir, cleanup } = tempDir();
  const app = baseApp(dir);
  const auth = new OwnerAuth(dir);
  const owner = auth.newToken!;
  const hm = new HookManager({ db: app.store.db, vault: app.vault, scrub: (s) => app.redactor.redact(s) });
  app.hooks = hm;
  hm.attach('main', app);
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, events: app.events, scrub: (x) => app.redactor.redact(x), fence: 'node-only', saraVersion: V, lookup: async (h) => (h === 'localhost' ? ['127.0.0.1'] : []), netTestLoopback: true, ...(o.clock ? { clock: o.clock } : {}) });
  app.pluginManager = pm;
  pm.attach('main', app);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: V, revision: null, startedAt: new Date().toISOString() } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    setPrivateLocal(false);
    const { pendingFor } = await import('../src/pending.ts');
    const idle = () => until(() => !app.store.listConversations().some((c) => pendingFor(app).busy(c.id)), 10_000);
    await idle();
    await pm.stopAll();
    // Stopping can still deliver a last event: let it finish before the store closes.
    await idle();
    await pause(300);
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await bb.stop();
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
  const review = pm.stageBuiltin('imessage');
  await pm.approve(review.id, { trust: true });
  await pm.setEnabled('imessage', 'main', true);
  const r: Rig = { bb, app, pm, dir, base, api, stdin: [] };
  assert.ok(await ready(r), 'the plugin started');
  if (o.setup !== false) await setup(r);
  if (o.link !== false && o.setup !== false) await link(r);
  return r;
}

/** Steps 4–6 through the card's routes: address, password, the doorbell (hello-world rings Sara). */
async function setup(r: Rig) {
  assert.equal((await r.api('POST', '/api/plugins/imessage/terms', { companion: 'main' })).status, 200);
  const a = await r.api('POST', '/api/plugins/imessage/address', { companion: 'main', server: `127.0.0.1:${r.bb.port}` });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.diagnosis?.code, 'NOT_SET', 'no password yet');
  const p = await r.api('POST', '/api/plugins/imessage/password', { companion: 'main', password: BB_PASSWORD });
  assert.equal(p.json.ok, true, JSON.stringify(p.json));
  assert.equal(p.json.account, String(r.bb.appleId));
  assert.ok(await ready(r));
  tap(r);
  const d = await r.api('POST', '/api/plugins/imessage/fix', { companion: 'main', fix: 'doorbell', saraAddress: r.base });
  assert.equal(d.json.ok, true, JSON.stringify(d.json));
}

async function link(r: Rig) {
  const c = await r.api('POST', '/api/plugins/imessage/fix', { companion: 'main', fix: 'link' });
  assert.match(String(c.json.code), /^\d{6}$/);
  r.bb.incoming(OWNER, `/link ${c.json.code}`);
  assert.ok(await until(() => (r.pm.settingsView('imessage', 'main').bridge?.ownerChats ?? []).includes(chatOf(dmGuid(OWNER)))), 'linked');
  assert.ok(await until(() => sent(r).some((x: string) => /Linked/.test(x))), 'the link line went back');
  assert.ok(await ready(r));
  tap(r);
}

const sent = (r: Rig, chat = dmGuid(OWNER)) => r.bb.sent.filter((x: Any) => x.chatGuid === chat).map((x: Any) => String(x.message));

// ------------------------------------------------------------------ pure pieces

test('the manifest, the review card, tips in six languages, B4 copies, the doorbell parser and the redactor', () => {
  const raw = readFileSync(join(ROOT, 'plugins', 'imessage', 'sara-plugin.json'), 'utf8');
  const m = parseManifest(raw, { saraVersion: V });
  assert.equal(m.sara, '>=2.55.2');
  assert.equal(m.permissions.webhooks, 'bridge');
  assert.deepEqual(m.permissions.webhookKinds, ['url']);
  assert.equal(m.permissions.doorbell, true);
  assert.deepEqual(m.permissions.connect.map((c) => `${c.id}:${c.where}:${c.tls}:${c.ports}`), ['bb:local:optional:setting']);
  assert.ok(permissionLines(m).some((l) => l.id === 'webhooks:doorbell'));
  assert.deepEqual(m.settings.map((s) => s.key), ['server', 'onOtherMachine', 'password', 'readReceipts', 'mirror', 'pollSeconds', 'https']);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) for (const s of m.settings) assert.ok(m.i18n[lang]?.[s.label] && m.i18n[lang]?.[s.tip] && m.i18n[lang][s.tip].length <= 260 && s.tip.length <= 260, `${lang}: ${s.key}`);
  // B1: an unsigned hook needs the doorbell rule; WhatsApp's string form still means `meta`.
  const j = JSON.parse(raw);
  assert.throws(() => parseManifest(JSON.stringify({ ...j, permissions: { ...j.permissions, webhooks: { bridge: ['url'] } } }), { saraVersion: V }), /doorbell/);
  const wa = parseManifest(readFileSync(join(ROOT, 'plugins', 'whatsapp', 'sara-plugin.json'), 'utf8'), { saraVersion: V });
  assert.deepEqual([wa.permissions.webhookKinds, wa.permissions.doorbell], [['meta'], false]);
  // B4: every http1.mjs and sara-plugin.mjs copy is the same file.
  const read = (p: string, f: string) => readFileSync(join(ROOT, 'plugins', p, f), 'utf8');
  assert.equal(read('imessage', 'http1.mjs'), read('whatsapp', 'http1.mjs'));
  assert.equal(read('imessage', 'sara-plugin.mjs'), readFileSync(join(ROOT, 'examples', 'plugins', 'sara-plugin.mjs'), 'utf8'));
  // B2: a doorbell carries the event and ids, never the text.
  const ping = doorbellPing(Buffer.from(JSON.stringify({ type: 'new-message', data: { guid: 'p:0/ABC-1', text: 'secret words', handle: { address: OWNER } } })));
  assert.deepEqual(ping, { event: 'new-message', ids: ['p:0/ABC-1'] });
  assert.deepEqual(doorbellPing(Buffer.from('{"type":"x y","data":{}}')).event, '');
  assert.deepEqual(doorbellPing(Buffer.from(JSON.stringify({ type: 'new-message', data: { guid: '<script>' } }))).ids, []);
  // §9.1: the password in a URL query is cut, whatever its length.
  const red = new Redactor(() => []);
  assert.equal(red.redact('GET /api/v1/ping?guid=abc&x=1'), 'GET /api/v1/ping?guid=[REDACTED]&x=1');
  assert.equal(red.redact('http://mac:1234/api/v1/message/query?password=hunter2'), 'http://mac:1234/api/v1/message/query?password=[REDACTED]');
});

test('the plugin parts: plain text, parts, smart dashes, chat ids, server/info, error codes, the pacer', async () => {
  assert.equal(flatten('# Plan\n**Bold** and `code`\n- one\n- two\n[docs](https://x.test)\n| a | b |\n|---|---|\n| 1 | 2 |'), 'Plan\nBold and code\n• one\n• two\ndocs: https://x.test\na — b\n1 — 2');
  const long = split('word '.repeat(3000));
  assert.equal(long.length, 4);
  assert.ok(long.every((p: string) => p.length <= 2000));
  assert.ok(long[3].endsWith(MORE));
  assert.equal(plainCommand('/model \u2014list \u201cfast\u201d'), '/model --list "fast"');
  assert.equal(plainCommand('he said \u2014 fine'), 'he said \u2014 fine');
  assert.equal(chatOf('iMessage;-;+15550001111'), 'iMessage:-:+15550001111');
  assert.equal(guidOf('iMessage:+:chat123'), 'iMessage;+;chat123');
  assert.deepEqual(readInfo({ server_version: '1.9.9', os_version: '15.1', private_api: true, helper_connected: false, detected_imessage: 'A@B.C' }), { version: '1.9.9', os: '15.1', privateApi: false, account: 'a@b.c', signedIn: true });
  assert.deepEqual(accountHandles({ apple_id: 'x@y.z', vetted_aliases: [{ Alias: '+1555' }, { Alias: 'X@Y.Z' }] }), ['x@y.z', '+1555']);
  assert.equal(codeOf({ status: 401 }), 'BB_PASSWORD');
  assert.equal(codeOf({ message: 'ECONNREFUSED 127.0.0.1:1234' }), 'BB_UNREACHABLE');
  assert.equal(codeOf({ message: 'net.open: x (192.168.1.5): it is on your home network; switch on …' }), 'NETWORK_SWITCH');
  // The card's words (web/imessage.js) cover every code diagnose() knows.
  const card = readFileSync(join(ROOT, 'web', 'imessage.js'), 'utf8');
  for (const code of Object.keys(DIAGNOSES)) assert.ok(card.includes(`${code}:`), `the card explains ${code}`);
  // The pacer (fake clock): 10 at once → ≤ 4 at once, then ≤ 1 every 2 s, in order.
  let now = 0;
  const pacer = new Pacer({ now: () => now, sleep: async (ms: number) => void (now += ms) });
  const at: number[] = [];
  const order: number[] = [];
  await Promise.all(Array.from({ length: 10 }, (_, i) => pacer.send('c', async () => void (at.push(now), order.push(i)))));
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(at.filter((x) => x === 0).length, BURST);
  for (let i = BURST; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= EVERY_MS - 1, `gap ${i}`);
  // Over 150 an hour → held.
  const p2 = new Pacer({ now: () => now, sleep: async (ms: number) => void (now += ms) });
  p2.sent = Array.from({ length: 150 }, () => now);
  await assert.rejects(p2.send('c', async () => undefined), /hourly/);
  // Polling (§4.3): 5 s while a chat with him is active, 30 s idle, 60 s with a working doorbell.
  assert.deepEqual([pollDelay({ doorbell: false, active: true }), pollDelay({ doorbell: false, active: false }), pollDelay({ doorbell: true, active: true })], [5000, 30000, 60000]);
});

// ------------------------------------------------------------------ the real plugin against the stand-in

test('setup ✓ step by step, the doorbell (ids only), an owner text and a photo answered, forged and own rings skipped, the password nowhere', async (t) => {
  const r = await rig(t, { link: false });
  let st = await r.api('GET', '/api/plugins/imessage/setup?companion=main');
  assert.deepEqual(st.json.steps.map((s: Any) => `${s.id}:${s.ok}`), ['appleid:true', 'macuser:true', 'messages:true', 'install:true', 'server:true', 'doorbell:true', 'hello:false', 'test:false']);
  assert.equal(st.json.doorbell, 'ok');
  assert.equal(st.json.server.privateApi, false);
  assert.ok(r.bb.webhooks.length === 1 && r.bb.webhooks[0].url.startsWith(`${r.base}/hook/h`), 'the doorbell is registered in BlueBubbles');
  await link(r);
  // An owner text: the ring carries the whole message, the plugin gets only {event, ids}, fetches it, answers.
  r.app.script.push(text('Hello from your companion.'));
  const secretWords = 'the quick brown fox at noon';
  const g = r.bb.incoming(OWNER, `hi there, ${secretWords}`);
  assert.ok(await until(() => sent(r).includes('Hello from your companion.')), 'her answer arrived');
  assert.ok(r.bb.requests.some((x: Any) => x.method === 'GET' && x.path === `/api/v1/message/${encodeURIComponent(g)}`), 'fetched with the password');
  assert.ok(r.stdin.some((l) => l.includes('"ping"') && l.includes(g)), 'woken with the id');
  assert.ok(!r.stdin.some((l) => l.includes(secretWords) && l.includes('bridge.webhook')), "the doorbell line never carries the message's text");
  const conv = r.app.store.listConversations().find((c) => c.channel === 'plugin-imessage');
  assert.ok(conv && !conv.partner);
  assert.equal(sent(r).filter((x: string) => x === 'Hello from your companion.').length, 1, 'answered once (the catch-up does not answer it again)');
  // A photo (JPEG) reaches the model.
  r.app.script.push(text('A tiny picture.'));
  r.bb.incoming(OWNER, '', { attachments: [{ name: 'IMG_0001.jpeg', mime: 'image/jpeg', bytes: FIXTURE_JPEG }] });
  assert.ok(await until(() => sent(r).includes('A tiny picture.')), 'the photo was answered');
  assert.ok(r.app.requests.at(-1)!.messages.some((m: Any) => (m.images ?? []).length > 0), 'the model got the picture');
  // A forged ring (made-up guid) → unknown-id, no turn; her own message rung → from-me.
  const turns = r.app.requests.length;
  await r.bb.forge('p:0/MADE-UP-1');
  const mineGuid = r.bb.sent.at(-1).guid;
  await r.bb.ringAll('new-message', { guid: mineGuid });
  const day = new Date().toISOString().slice(0, 10);
  assert.ok(await until(() => (skipsOn(r.app.store.db, 'plugin-imessage', day)['unknown-id'] ?? 0) >= 1 && (skipsOn(r.app.store.db, 'plugin-imessage', day)['from-me'] ?? 0) >= 1), JSON.stringify(skipsOn(r.app.store.db, 'plugin-imessage', day)));
  assert.equal(r.app.requests.length, turns, 'no turn from a forged ring');
  assert.ok(!r.stdin.some((l) => l.includes('FORGED TEXT')), 'the forged text never reached the plugin');
  // A stranger: one hello line, then nothing.
  r.bb.incoming(STRANGER, 'hey who is this');
  assert.ok(await until(() => sent(r, dmGuid(STRANGER)).length === 1));
  assert.match(sent(r, dmGuid(STRANGER))[0], /AI companion/);
  r.bb.incoming(STRANGER, 'hello??');
  await until(() => (skipsOn(r.app.store.db, 'plugin-imessage', day).stranger ?? 0) >= 2);
  assert.equal(sent(r, dmGuid(STRANGER)).length, 1, 'one hello only');
  assert.equal(r.app.requests.length, turns, 'no turn for a stranger');
  // The hook's log has no bodies; Test is all ✓; the password is in no file of the data folder.
  const hook = r.app.hooks!.bridgeHookFor('imessage', 'main')!;
  const rows = r.app.hooks!.store.deliveries(hook.id, 50);
  assert.ok(rows.length >= 3 && rows.every((x: Any) => x.body === null), 'no bodies in the delivery log');
  const tst = await r.api('POST', '/api/plugins/imessage/check', { companion: 'main', step: 'test' });
  assert.equal(tst.json.ok, true, JSON.stringify(tst.json.steps));
  assert.ok(tst.json.steps.some((s: Any) => s.label === 'BlueBubbles rings Sara' && s.ok), 'the doorbell counts as working (not polling)');
  st = await r.api('GET', '/api/plugins/imessage/setup?companion=main');
  assert.ok(st.json.steps.every((s: Any) => s.ok), JSON.stringify(st.json.steps));
  assert.ok(!JSON.stringify(st.json).includes(BB_PASSWORD));
  for (const f of walk(r.dir)) assert.ok(!readFileSync(f).includes(Buffer.from(BB_PASSWORD)), `the password is not in ${f}`);
});

test('diagnoses: wrong password (BB_PASSWORD), the home-network switch (NETWORK_SWITCH), signed out, unreachable', async (t) => {
  const r = await rig(t, { setup: false });
  await r.api('POST', '/api/plugins/imessage/address', { companion: 'main', server: `127.0.0.1:${r.bb.port}` });
  const bad = await r.api('POST', '/api/plugins/imessage/password', { companion: 'main', password: 'not-the-password-123' });
  assert.equal(bad.json.diagnosis?.code, 'BB_PASSWORD', JSON.stringify(bad.json));
  let st = await r.api('GET', '/api/plugins/imessage/setup?companion=main');
  assert.equal(st.json.steps.find((s: Any) => s.id === 'install').diagnosis?.code, 'BB_PASSWORD');
  assert.equal(st.json.steps.find((s: Any) => s.id === 'doorbell').ok, false, 'no doorbell and no polling chosen yet');
  assert.ok(!JSON.stringify(bad.json).includes('not-the-password-123'), 'the wrong password is not echoed');
  const lan = await r.api('POST', '/api/plugins/imessage/address', { companion: 'main', server: '192.168.1.77:1234' });
  assert.equal(lan.json.diagnosis?.code, 'NETWORK_SWITCH', JSON.stringify(lan.json));
  r.bb.signedIn = false;
  await r.api('POST', '/api/plugins/imessage/address', { companion: 'main', server: `127.0.0.1:${r.bb.port}`, onOtherMachine: false });
  const out = await r.api('POST', '/api/plugins/imessage/password', { companion: 'main', password: BB_PASSWORD });
  assert.equal(out.json.diagnosis?.code, 'MESSAGES_SIGNED_OUT');
  r.bb.signedIn = true;
  const dead = await r.api('POST', '/api/plugins/imessage/address', { companion: 'main', server: '127.0.0.1:9' });
  assert.equal(dead.json.diagnosis?.code, 'BB_UNREACHABLE', JSON.stringify(dead.json));
  st = await r.api('GET', '/api/plugins/imessage/setup?companion=main');
  assert.equal(st.json.steps.find((s: Any) => s.id === 'server').diagnosis?.code, 'BB_UNREACHABLE');
  // The plugin's own log never has the password (it rides in the URL).
  const logs = JSON.stringify(r.app.store.db.prepare('SELECT * FROM plugin_log').all());
  assert.ok(!logs.includes(BB_PASSWORD) && !logs.includes('not-the-password-123'));
});

test('his own Apple ID: OWN_APPLE_ID and the plugin refuses to run', async (t) => {
  const r = await rig(t, { bb: { appleId: 'alex@example.com', aliases: ['alex@example.com', OWNER] } });
  // Linked from OWNER, and the Apple ID on the Mac owns that number: the next start refuses.
  const c = await r.api('POST', '/api/plugins/imessage/check', { companion: 'main', step: 'server' });
  assert.equal(c.json.diagnosis?.code, 'OWN_APPLE_ID', JSON.stringify(c.json));
  await r.pm.setEnabled('imessage', 'main', false);
  await r.pm.setEnabled('imessage', 'main', true);
  assert.ok(await ready(r));
  assert.ok(await until(() => r.pm.bridgeView('imessage', 'main').state === 'error'), 'the chip says so');
  const polls = r.bb.requests.filter((x: Any) => x.path === '/api/v1/message/query').length;
  r.bb.incoming(OWNER, 'are you reading my chats?', { ring: false });
  await r.bb.ringAll('new-message', { guid: r.bb.messages.at(-1).guid });
  await pause(800);
  assert.equal(r.bb.requests.filter((x: Any) => x.path === '/api/v1/message/query').length, polls, 'no polling');
  assert.ok(!sent(r).some((x: string) => /reading/.test(x)) && !r.app.requests.some((q) => JSON.stringify(q.messages).includes('are you reading')), 'nothing read');
  const st = await r.api('GET', '/api/plugins/imessage/setup?companion=main');
  assert.equal(st.json.refused, 'OWN_APPLE_ID');
  assert.equal(st.json.steps.find((s: Any) => s.id === 'appleid').diagnosis?.code, 'OWN_APPLE_ID');
});

test('catching up after downtime: missed messages taken once, in order; a 25-hour-old one filed; private local mode pauses', async (t) => {
  const r = await rig(t);
  await r.pm.setEnabled('imessage', 'main', false);
  // Sara was away for 26 hours: the last message she saw is that old.
  r.pm.store.kvSet('imessage', 'main', 'lastSeen', JSON.stringify(Date.now() - 26 * 3600_000));
  r.bb.incoming(OWNER, 'old news', { ring: false, agoMs: 25 * 3600_000 });
  r.bb.incoming(OWNER, 'first while you were away', { ring: false, agoMs: 7 * 3600_000 });
  r.bb.incoming(OWNER, 'second while you were away', { ring: false, agoMs: 60_000 });
  r.app.script.push(text('Answer one.'), text('Answer two.'));
  await r.pm.setEnabled('imessage', 'main', true);
  assert.ok(await ready(r));
  assert.ok(await until(() => sent(r).includes('Answer two.')), 'both answered');
  const asked = r.app.requests.map((q) => JSON.stringify(q.messages));
  const i1 = asked.findIndex((x) => x.includes('first while you were away'));
  const i2 = asked.findIndex((x) => x.includes('second while you were away'));
  assert.ok(i1 >= 0 && i2 > i1, 'in order');
  assert.match(asked[i1], /while I was offline/, 'a 7-hour-old message gets the "while I was away" note');
  assert.ok(!asked.some((x) => x.includes('old news')), 'the 25-hour-old one is not answered');
  const day = new Date().toISOString().slice(0, 10);
  assert.ok((skipsOn(r.app.store.db, 'plugin-imessage', day).old ?? 0) >= 1);
  await pause(600);
  assert.equal(sent(r).filter((x: string) => x === 'Answer one.').length, 1, 'taken once');
  // Private local mode: the socket is refused; nothing is lost, the catch-up delivers after.
  setPrivateLocal(true);
  const c = await r.api('POST', '/api/plugins/imessage/check', { companion: 'main', step: 'server' });
  assert.equal(c.json.diagnosis?.code, 'PRIVATE_LOCAL');
  setPrivateLocal(false);
});

test('basic mode: no typing/react/edit calls; a steer gets a line; groups by name; partners get the AI notice; HEIC and her PDF', async (t) => {
  const clock = new ManualClock();
  const r = await rig(t, { clock });
  // A long turn: the working line at 20 s ends "Send /stop to stop."; a steer gets a text line.
  let open: () => void = () => undefined;
  const gate = new Promise<void>((res) => (open = res));
  const realRun = r.app.runTracked!;
  r.app.runTracked = async (id, content, onEvent, opts) => {
    if (!/long job/.test(String(content))) return realRun(id, content, onEvent, opts);
    // As runTurn does: the turn is live, so a message from him now steers it.
    const { pendingFor } = await import('../src/pending.ts');
    pendingFor(r.app).turnStarted(id);
    onEvent({ type: 'tool_call', id: 'c1', name: 'web_search', args: { query: 'pnpm' } } as unknown as ChatEvent);
    await gate;
    pendingFor(r.app).turnEnded(id);
    onEvent({ type: 'token', text: 'All done.' } as ChatEvent);
  };
  r.bb.incoming(OWNER, 'a long job please');
  await pause(400);
  await clock.advance(25_000);
  assert.ok(await until(() => sent(r).some((x: string) => /Send \/stop to stop\.$/.test(x))), `the working line: ${sent(r).join(' | ')}`);
  r.bb.incoming(OWNER, 'use pnpm instead');
  assert.ok(await until(() => sent(r).some((x: string) => /Got it, I'll use that at the next step/.test(x))), `a steer gets a line: ${sent(r).join(' | ')}`);
  open();
  assert.ok(await until(() => sent(r).includes('All done.')));
  assert.equal(r.bb.typing.length + r.bb.reacts.length + r.bb.edits.length, 0, 'no Private API calls in basic mode');
  assert.ok(r.bb.sent.every((x: Any) => x.method === 'apple-script' && x.tempGuid), 'AppleScript sends with a tempGuid');
  // Groups: without her name → not answered; "Sara, …" → answered (as a room, quoting him in text).
  const group = 'iMessage;+;chat777';
  await r.pm.putSettings('imessage', 'main', {}, { ...r.pm.settingsView('imessage', 'main').bridge, others: true, allow: [PARTNER] } as Any);
  assert.ok(await ready(r));
  // The steer above became a queued turn of its own: let it finish before counting (no fixed pause).
  const { pendingFor } = await import('../src/pending.ts');
  assert.ok(await until(() => !r.app.store.listConversations().some((c) => pendingFor(r.app).busy(c.id))), 'the queued turn finished');
  let seen = -1;
  while (seen !== r.app.requests.length) {
    seen = r.app.requests.length;
    await until(() => r.app.requests.length !== seen, 500);
  }
  const before = r.app.requests.length;
  r.bb.incoming(PARTNER, 'dinner at 7?', { chat: group, title: 'Family', members: [OWNER, PARTNER] });
  await pause(700);
  assert.equal(r.app.requests.length, before, 'a group message without her name is not answered');
  r.app.script.push(text('Seven works.'));
  r.bb.incoming(PARTNER, 'Sara, does 7 work?', { chat: group, title: 'Family', members: [OWNER, PARTNER] });
  assert.ok(await until(() => sent(r, group).some((x: string) => x.includes('Seven works.'))), 'answered when named');
  assert.ok(!(r.app.requests.at(-1)!.tools ?? []).length, 'no tools for someone else in a group');
  // A partner's DM: the AI notice first, no tools.
  r.app.script.push(text('Hi Mia!'));
  r.bb.incoming(PARTNER, 'hello');
  assert.ok(await until(() => sent(r, dmGuid(PARTNER)).includes('Hi Mia!')));
  const bodies = sent(r, dmGuid(PARTNER));
  assert.ok(bodies.indexOf('Hi Mia!') > 0 && /AI/.test(bodies[0]), `the AI notice first: ${bodies.join(' | ')}`);
  assert.ok(!(r.app.requests.at(-1)!.tools ?? []).length, 'no tools offered');
  // A HEIC photo BlueBubbles doesn't convert: the HEIC line once.
  r.bb.incoming(OWNER, '', { attachments: [{ name: 'IMG_0002.HEIC', mime: 'image/heic', bytes: FIXTURE_HEIC }] });
  assert.ok(await until(() => sent(r).some((x: string) => /HEIC/.test(x))));
  r.bb.incoming(OWNER, '', { attachments: [{ name: 'IMG_0003.HEIC', mime: 'image/heic', bytes: FIXTURE_HEIC }] });
  await pause(800);
  assert.equal(sent(r).filter((x: string) => /HEIC/.test(x)).length, 1, 'said once');
  // Her PDF out: one multipart message/attachment.
  const run = (r.pm as Any).processOf('imessage', 'main');
  const pdf = Buffer.from('%PDF-1.4\n%sara\n');
  run.send({ v: 1, type: 'bridge.send', bridge: 'imessage', chatId: chatOf(dmGuid(OWNER)), text: '', files: [{ fileId: 'f1', name: 'notes.pdf', mime: 'application/pdf', size: pdf.length }] });
  run.send({ v: 1, type: 'bridge.file', bridge: 'imessage', chatId: chatOf(dmGuid(OWNER)), fileId: 'f1', seq: 0, last: true, data: pdf.toString('base64') });
  assert.ok(await until(() => r.bb.files.some((f: Any) => f.name === 'notes.pdf' && f.chatGuid === dmGuid(OWNER))), 'one multipart attachment');
});

test('Private API mode: typing on and off, a ‼ tapback on a steer, replies quoted with selectedMessageGuid, read receipts only for him', async (t) => {
  const r = await rig(t, { privateApi: true });
  await r.pm.putSettings('imessage', 'main', { readReceipts: true });
  assert.ok(await ready(r));
  let open: () => void = () => undefined;
  const gate = new Promise<void>((res) => (open = res));
  const realRun = r.app.runTracked!;
  r.app.runTracked = async (id, content, onEvent, opts) => {
    if (!/long job/.test(String(content))) return realRun(id, content, onEvent, opts);
    await gate;
    onEvent({ type: 'token', text: 'Finished.' } as ChatEvent);
  };
  r.bb.incoming(OWNER, 'a long job please');
  assert.ok(await until(() => r.bb.typing.some((x: Any) => x.on && x.chat === dmGuid(OWNER))), 'typing on');
  const steer = r.bb.incoming(OWNER, 'use pnpm instead');
  assert.ok(await until(() => r.bb.reacts.some((x: Any) => x.selectedMessageGuid === steer && x.reaction === 'emphasize')), 'a tapback on the steer');
  open();
  assert.ok(await until(() => sent(r).includes('Finished.')));
  assert.ok(await until(() => r.bb.typing.at(-1)?.on === false), 'typing off with the reply');
  assert.ok(r.bb.reads.includes(dmGuid(OWNER)), 'a read receipt in his chat');
  assert.ok(r.bb.sent.filter((x: Any) => x.chatGuid === dmGuid(OWNER)).every((x: Any) => x.method === 'private-api'));
  // A group answer quotes his message with selectedMessageGuid.
  const group = 'iMessage;+;chat888';
  r.app.script.push(text('On it.'));
  const q = r.bb.incoming(OWNER, 'Sara, what time is it?', { chat: group, title: 'Work', members: [OWNER, PARTNER] });
  assert.ok(await until(() => sent(r, group).includes('On it.')));
  assert.equal(r.bb.sent.find((x: Any) => x.chatGuid === group && x.message === 'On it.').selectedMessageGuid, q);
  assert.ok(!r.bb.reads.includes(group), 'no read receipts outside his chat');
});
