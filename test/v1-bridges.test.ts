// V1.3 (docs/design/V1BRIDGES.md): "Where do you text?" — the picker on Connections → Apps and services.
// The acceptance: picker → a configured fake Matrix homeserver (test/fixtures/matrix/hs.mjs) and a fake
// BlueBubbles (test/fixtures/imessage/bb.mjs) each round-trip a message through the real plugins; the
// picker's Check shows each plugin's own checks as plain lines; Send me a test reaches the owner's
// linked chat only; the BlueBubbles reachability probe works before the plugin is added.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { PluginManager } from '../src/plugins/manager.ts';
import { satisfies } from '../src/plugins/manifest.ts';
import { probeBlueBubbles, WHERE_APPS, whereDefaults } from '../src/plugins/where-text.ts';
import { HookManager } from '../src/webhooks.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const PKG_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const V = satisfies(PKG_VERSION, '>=2.55.2') ? PKG_VERSION : '2.55.2';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const { FakeHomeserver, HER, HER_PASSWORD, OWNER } = await import(pathToFileURL(join(ROOT, 'test', 'fixtures', 'matrix', 'hs.mjs')).href);
const bbFix = await import(pathToFileURL(join(ROOT, 'test', 'fixtures', 'imessage', 'bb.mjs')).href);
const { chatOf: mxChatOf } = await import(pathToFileURL(join(ROOT, 'plugins', 'matrix', 'sync.mjs')).href);
const { chatOf: bbChatOf } = await import(pathToFileURL(join(ROOT, 'plugins', 'imessage', 'bb.mjs')).href);
const web: Any = await import(pathToFileURL(join(ROOT, 'web', 'where-text.js')).href);

const until = async (f: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return f();
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rig {
  app: TestApp;
  pm: PluginManager;
  base: string;
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: Record<string, Any> }>;
}

async function rig(t: TestContext, o: { netCa?: string; stop?: () => Promise<unknown> } = {}): Promise<Rig> {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  app.companionId = 'main';
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex Rivera', timeZone: 'UTC', disclosureAcceptedAt: new Date().toISOString() });
  app.runTracked = async (id, content, onEvent, opts) => {
    for await (const ev of runTurn(app, id, content, undefined, opts)) onEvent(ev as ChatEvent);
  };
  const auth = new OwnerAuth(dir);
  const owner = auth.newToken!;
  const hm = new HookManager({ db: app.store.db, vault: app.vault, scrub: (s) => app.redactor.redact(s) });
  app.hooks = hm;
  hm.attach('main', app);
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, events: app.events, scrub: (x) => app.redactor.redact(x), fence: 'node-only', saraVersion: V, ...(o.netCa ? { netCa: o.netCa } : {}), lookup: async (h) => (h === 'localhost' ? ['127.0.0.1'] : []), netTestLoopback: true });
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
    await idle();
    await pause(300);
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await o.stop?.();
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
  return { app, pm, base, api };
}

/** What the picker's Set it up does on the page: add Sara's own plugin (the review card, then approve). */
async function addFromPicker(r: Rig, id: string) {
  const pick = await r.api('POST', '/api/plugins/where/pick', { app: id });
  assert.equal(pick.status, 200, JSON.stringify(pick.json));
  assert.equal(pick.json.page, `co-${id}`);
  const review = await r.api('POST', '/api/plugins/install', { builtin: pick.json.plugin });
  assert.equal(review.status, 200, JSON.stringify(review.json));
  await r.pm.approve(review.json.id, { trust: true });
  await r.pm.setEnabled(id, 'main', true);
  assert.ok(await until(() => r.pm.processOf(id, 'main')?.state === 'ready'), `${id} started`);
  return pick.json;
}

const appOf = (list: Any[], id: string) => list.find((x) => x.id === id);

// ------------------------------------------------------------------ pure pieces

test('the picker list covers every chat app page and plugin, in one order; defaults are plain', () => {
  const ids = WHERE_APPS.map((a) => a.id);
  assert.deepEqual(ids, ['imessage', 'whatsapp', 'signal', 'telegram', 'discord', 'matrix', 'slack', 'teams', 'email']);
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  for (const a of WHERE_APPS) {
    assert.ok(html.includes(`data-page="${a.page}"`), `${a.page} is a real page`);
    if (a.plugin) assert.ok(readFileSync(join(ROOT, 'plugins', a.plugin, 'sara-plugin.json'), 'utf8').includes(`"id": "${a.plugin}"`), `${a.plugin} is a built-in plugin`);
  }
  assert.deepEqual(whereDefaults('matrix', { ownerName: 'Alex Rivera' }), { mxid: '@sara-alex:matrix.org' });
  assert.deepEqual(whereDefaults('matrix', { ownerName: 'Zoë' }), { mxid: '@sara-zoe:matrix.org' });
  assert.deepEqual(whereDefaults('matrix', { ownerName: '' }), { mxid: '@sara-me:matrix.org' });
  assert.deepEqual(whereDefaults('matrix', { ownerName: 'Alex', mxid: '@her:example.org' }), { mxid: '@her:example.org' });
  assert.deepEqual(whereDefaults('imessage', {}), { server: '127.0.0.1:1234' });
  assert.deepEqual(whereDefaults('imessage', { server: '192.168.1.20:1234' }), { server: '192.168.1.20:1234' });
  assert.deepEqual(whereDefaults('signal', {}), { address: '127.0.0.1:7583' });
  assert.deepEqual(whereDefaults('slack', {}), {});
});

test('the web model: the phone switch marks the easiest fits first, every app keeps a page', () => {
  const apps = WHERE_APPS.map((a) => ({ id: a.id, page: a.page }));
  const iphone = web.whereModel(apps, 'iphone');
  assert.equal(iphone.length, apps.length);
  assert.equal(iphone[0].id, 'imessage');
  assert.ok(iphone.find((x: Any) => x.id === 'imessage').easy);
  assert.ok(!iphone.find((x: Any) => x.id === 'teams').easy);
  const android = web.whereModel(apps, 'android');
  assert.ok(!android.find((x: Any) => x.id === 'imessage').easy, 'no iMessage on Android');
  assert.ok(android.find((x: Any) => x.id === 'imessage').note, 'it says why');
  assert.ok(android[0].easy);
  assert.equal(web.whereModel(apps, '').length, apps.length);
  for (const x of iphone) assert.ok(x.label && x.need, `${x.id} has a label and a need line`);
  // A set-up app's state reads from the server row first, then the tile's facts.
  assert.equal(web.whereState({ installed: true, linked: true, running: true }), 'on');
  assert.equal(web.whereState({ installed: true, linked: false, running: true }), 'started');
  assert.equal(web.whereState({ installed: false }, { state: 'on' }), 'on');
  assert.equal(web.whereState({ installed: false }), 'off');
});

test('BlueBubbles reachability: reached (even without the password), down, not BlueBubbles, not local, a bad address', async (t) => {
  const bb = await new bbFix.FakeBlueBubbles().start();
  const other = createServer((_q, s) => s.writeHead(404, { 'content-type': 'text/html' }).end('<h1>nope</h1>'));
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await bb.stop();
    await new Promise<void>((r) => other.close(() => r()));
  });
  const ok = await probeBlueBubbles(`127.0.0.1:${bb.port}`);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.ok(bb.requests.some((x: Any) => x.path === '/api/v1/ping' && !x.authed), 'one ping, no password sent');
  assert.equal(bb.requests.length, 1);
  assert.equal((await probeBlueBubbles(`http://localhost:${bb.port}/`)).ok, true, 'a pasted URL works too');
  assert.equal((await probeBlueBubbles(`127.0.0.1:${(other.address() as AddressInfo).port}`)).code, 'NOT_BB');
  bb.down = true;
  assert.equal((await probeBlueBubbles(`127.0.0.1:${bb.port}`)).code, 'DOWN');
  assert.equal((await probeBlueBubbles('8.8.8.8:1234', { onOtherMachine: true })).code, 'NOT_LOCAL');
  assert.equal((await probeBlueBubbles('192.168.1.20:1234')).code, 'NOT_LOCAL', 'the home network needs the switch');
  assert.equal((await probeBlueBubbles('not an address')).code, 'BAD_ADDRESS');
  assert.equal((await probeBlueBubbles('')).code, 'BAD_ADDRESS');
});

// ------------------------------------------------------------------ the acceptance round trips

test('picker → Matrix on a fake homeserver: defaults, set up, a message both ways, plain checks, Send me a test to him only', async (t) => {
  const hs = await new FakeHomeserver().start();
  const r = await rig(t, { netCa: hs.caPem, stop: () => hs.stop() });
  let w = await r.api('GET', '/api/plugins/where');
  assert.equal(w.status, 200, JSON.stringify(w.json));
  const mx0 = appOf(w.json.apps, 'matrix');
  assert.deepEqual({ installed: mx0.installed, available: mx0.available, page: mx0.page }, { installed: false, available: true, page: 'co-matrix' });
  assert.deepEqual(mx0.defaults, { mxid: '@sara-alex:matrix.org' });
  assert.equal((await r.api('POST', '/api/plugins/where/check', { app: 'matrix' })).json.steps[0].label, 'Not added yet');
  const picked = await addFromPicker(r, 'matrix');
  assert.deepEqual(picked.defaults, { mxid: '@sara-alex:matrix.org' });
  // Her account lives on the stand-in server (the page lets him change the suggested ID).
  await r.pm.putSettings('matrix', 'main', { mxid: HER, homeserver: `localhost:${hs.port}` });
  assert.ok(await until(() => r.pm.processOf('matrix', 'main')?.state === 'ready'));
  const login = await r.api('POST', '/api/plugins/matrix/login', { companion: 'main', mxid: HER, password: HER_PASSWORD });
  assert.equal(login.json.ok, true, JSON.stringify(login.json));
  // Not linked yet: Send me a test refuses, and nothing was sent to anyone.
  const early = await r.api('POST', '/api/plugins/where/send-test', { app: 'matrix' });
  assert.equal(early.json.ok, false);
  assert.equal(early.json.code, 'NOT_LINKED');
  const e = await r.api('POST', '/api/plugins/matrix/fix', { companion: 'main', fix: 'expect' });
  const room = hs.invite(OWNER, { name: 'Sara' });
  assert.ok(await until(() => hs.rooms.get(room).members.has(HER)), 'she joined his room');
  await pause(300);
  hs.text(room, OWNER, `/link ${e.json.code}`);
  assert.ok(await until(() => (r.pm.settingsView('matrix', 'main').bridge?.ownerChats ?? []).includes(mxChatOf(room))), 'linked');
  const bodies = () => hs.sentTo(room).map((x: Any) => String(x.content.body ?? ''));
  // The round trip: his message in, her answer out.
  r.app.script.push(text('Hi Alex, Matrix works.'));
  hs.text(room, OWNER, 'hello from Element');
  assert.ok(await until(() => bodies().includes('Hi Alex, Matrix works.')), 'her answer arrived in his room');
  // The picker sees it set up and linked; Check shows the plugin's own checks as plain lines.
  w = await r.api('GET', '/api/plugins/where');
  const mx = appOf(w.json.apps, 'matrix');
  assert.deepEqual({ installed: mx.installed, on: mx.on, linked: mx.linked, canSendTest: mx.canSendTest }, { installed: true, on: true, linked: true, canSendTest: true });
  const check = await r.api('POST', '/api/plugins/where/check', { app: 'matrix' });
  assert.equal(check.json.ok, true, JSON.stringify(check.json));
  assert.ok(check.json.steps.length >= 2 && check.json.steps.every((s: Any) => typeof s.label === 'string' && s.ok === true));
  assert.equal(check.json.steps.at(-1).label, 'Your chat is linked');
  // Send me a test: exactly one message, into his linked room.
  const before = hs.sentTo(room).length;
  const turns = r.app.requests.length;
  const sendt = await r.api('POST', '/api/plugins/where/send-test', { app: 'matrix' });
  assert.equal(sendt.json.ok, true, JSON.stringify(sendt.json));
  assert.ok(await until(() => bodies().some((b: string) => /^Test from Sara/.test(b))));
  assert.equal(hs.sentTo(room).length, before + 1);
  await pause(300);
  assert.equal(r.app.requests.length, turns, 'the test message is not a model turn');
});

test('picker → iMessage on a fake BlueBubbles: probe from the page, set up, a text both ways, plain checks, Send me a test', async (t) => {
  const bb = await new bbFix.FakeBlueBubbles().start();
  const r = await rig(t, { stop: () => bb.stop() });
  // Reachability from the page, before the plugin is added.
  const probe = await r.api('POST', '/api/plugins/where/probe', { app: 'imessage', address: `127.0.0.1:${bb.port}` });
  assert.equal(probe.status, 200);
  assert.equal(probe.json.ok, true, JSON.stringify(probe.json));
  assert.equal((await r.api('POST', '/api/plugins/where/probe', { app: 'imessage', address: '203.0.113.9:1234', onOtherMachine: true })).json.code, 'NOT_LOCAL');
  assert.equal((await r.api('POST', '/api/plugins/where/probe', { app: 'matrix', address: 'x' })).status, 400);
  const picked = await addFromPicker(r, 'imessage');
  assert.deepEqual(picked.defaults, { server: '127.0.0.1:1234' });
  await r.api('POST', '/api/plugins/imessage/terms', { companion: 'main' });
  await r.api('POST', '/api/plugins/imessage/address', { companion: 'main', server: `127.0.0.1:${bb.port}` });
  const p = await r.api('POST', '/api/plugins/imessage/password', { companion: 'main', password: bbFix.BB_PASSWORD });
  assert.equal(p.json.ok, true, JSON.stringify(p.json));
  assert.ok(await until(() => r.pm.processOf('imessage', 'main')?.state === 'ready'));
  const d = await r.api('POST', '/api/plugins/imessage/fix', { companion: 'main', fix: 'doorbell', saraAddress: r.base });
  assert.equal(d.json.ok, true, JSON.stringify(d.json));
  assert.deepEqual(appOf((await r.api('GET', '/api/plugins/where')).json.apps, 'imessage').defaults, { server: `127.0.0.1:${bb.port}` }, 'the saved address is the default now');
  const c = await r.api('POST', '/api/plugins/imessage/fix', { companion: 'main', fix: 'link' });
  bb.incoming(bbFix.OWNER, `/link ${c.json.code}`);
  const chat = bbChatOf(bbFix.dmGuid(bbFix.OWNER));
  assert.ok(await until(() => (r.pm.settingsView('imessage', 'main').bridge?.ownerChats ?? []).includes(chat)), 'linked');
  const sent = () => bb.sent.filter((x: Any) => x.chatGuid === bbFix.dmGuid(bbFix.OWNER)).map((x: Any) => String(x.message));
  assert.ok(await until(() => r.pm.processOf('imessage', 'main')?.state === 'ready'));
  r.app.script.push(text('Hi Alex, iMessage works.'));
  bb.incoming(bbFix.OWNER, 'hello from my iPhone');
  assert.ok(await until(() => sent().includes('Hi Alex, iMessage works.')), 'her answer reached his iPhone chat');
  const im = appOf((await r.api('GET', '/api/plugins/where')).json.apps, 'imessage');
  assert.deepEqual({ installed: im.installed, linked: im.linked, canSendTest: im.canSendTest }, { installed: true, linked: true, canSendTest: true });
  const check = await r.api('POST', '/api/plugins/where/check', { app: 'imessage' });
  assert.equal(check.json.ok, true, JSON.stringify(check.json));
  const before = bb.sent.length;
  const st = await r.api('POST', '/api/plugins/where/send-test', { app: 'imessage' });
  assert.equal(st.json.ok, true, JSON.stringify(st.json));
  assert.ok(await until(() => sent().some((m: string) => /^Test from Sara/.test(m))));
  assert.equal(bb.sent.length, before + 1, 'one message, to him only');
});

test('routes: owner only, unknown apps refused, a chat app without a plugin opens its page, apps that cannot send a test say so', async (t) => {
  const r = await rig(t);
  assert.equal((await r.api('POST', '/api/plugins/where/pick', { app: 'nope' })).status, 400);
  const tg = await r.api('POST', '/api/plugins/where/pick', { app: 'telegram' });
  assert.deepEqual({ page: tg.json.page, plugin: tg.json.plugin }, { page: 'co-telegram', plugin: null });
  assert.equal((await r.api('POST', '/api/plugins/where/send-test', { app: 'slack' })).json.code, 'NO_TEST_MESSAGE');
  assert.equal((await r.api('POST', '/api/plugins/where/check', { app: 'telegram' })).status, 400);
  const res = await fetch(`${r.base}/api/plugins/where`);
  assert.equal(res.status, 401);
});
