// EC1 (docs/ops/EC1_DESIGN.md): Slack as a chat app through Socket Mode. A stand-in Slack
// (test/fixtures/slack/fake.mjs: the Web API and the Socket Mode WebSocket on a test CA) is reached by
// the real plugin process from plugins/slack through Sara's socket broker and its test-only loopback
// override. No Slack workspace, no real network, a fake model.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { PluginManager } from '../src/plugins/manager.ts';
import { parseManifest, permissionLines, satisfies } from '../src/plugins/manifest.ts';
import { KEY_SHAPED } from '../src/redact.ts';
import { createSaraServer } from '../src/server.ts';
import { call, makeApp, PNG, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const PKG_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const V = satisfies(PKG_VERSION, '>=2.80.0') ? PKG_VERSION : '2.80.0';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const load = (f: string): Promise<Any> => import(pathToFileURL(join(ROOT, 'plugins', 'slack', f)).href);
const { toMrkdwn, fromSlack, split } = await load('mrkdwn.mjs');
const { codeOf, diagnose, DIAGNOSES } = await load('diagnose.mjs');
const { encodeFrame, FrameReader, acceptOf } = await load('ws.mjs');
const { LIMITS } = await load('pace.mjs');
const F = await import(pathToFileURL(join(ROOT, 'test', 'fixtures', 'slack', 'fake.mjs')).href);
const { FakeSlack, BOT_TOKEN, APP_TOKEN, OWNER, COLLEAGUE, STRANGER, DM, DM_STRANGER, CHANNEL, OTHER_CHANNEL, BOT_USER } = F;

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

interface Rig {
  slack: Any;
  app: TestApp;
  pm: PluginManager;
  dir: string;
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: Record<string, Any> }>;
}

async function rig(t: TestContext, o: { tokens?: boolean; link?: boolean } = {}): Promise<Rig> {
  const slack = await new FakeSlack().start();
  const { dir, cleanup } = tempDir();
  const app = baseApp(dir);
  const auth = new OwnerAuth(dir);
  const owner = auth.newToken!;
  const lookup = async (h: string) => (h === 'slack.com' || h.endsWith('.slack.com') ? ['127.0.0.1'] : []);
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, events: app.events, scrub: (x) => app.redactor.redact(x), fence: 'node-only', saraVersion: V, netCa: slack.caPem, lookup, netTestLoopback: true, netTestPort: slack.port });
  app.pluginManager = pm;
  pm.attach('main', app);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: V, revision: null, startedAt: new Date().toISOString() } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    const { pendingFor } = await import('../src/pending.ts');
    const settle = async () => {
      await until(() => !app.store.listConversations().some((c) => pendingFor(app).busy(c.id)), 10_000);
      for (let seen = -1, i = 0; seen !== app.requests.length && i < 10; i++) {
        seen = app.requests.length;
        await pause(300);
      }
    };
    await settle();
    await pm.stopAll();
    await settle();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await slack.stop();
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
  const review = pm.stageBuiltin('slack');
  await pm.approve(review.id, { trust: true });
  await pm.setEnabled('slack', 'main', true);
  assert.ok(await until(() => pm.processOf('slack', 'main')?.state === 'ready'), 'the plugin started');
  const r: Rig = { slack, app, pm, dir, api };
  if (o.tokens !== false) {
    const res = await api('POST', '/api/plugins/slack/tokens', { companion: 'main', botToken: BOT_TOKEN, appToken: APP_TOKEN });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.ok, true, JSON.stringify(res.json));
    assert.ok(await until(() => slack.hellos > 0 && slack.live), 'Socket Mode connected');
    assert.ok(await until(() => r.pm.bridgeView('slack', 'main')?.state === 'ok'), 'the status chip says connected');
  }
  if (o.link !== false && o.tokens !== false) await link(r);
  return r;
}

const texts = (r: Rig, ch: string) => r.slack.sentTo(ch).map((p: Any) => p.text);

async function link(r: Rig) {
  const e = await r.api('POST', '/api/plugins/slack/fix', { companion: 'main', fix: 'link' });
  assert.equal(e.status, 200, JSON.stringify(e.json));
  r.slack.dm(`link ${e.json.code}`);
  assert.ok(await until(() => (r.pm.settingsView('slack', 'main').bridge?.ownerChats ?? []).includes(DM)), 'linked');
  assert.ok(await until(() => texts(r, DM).some((x: string) => /Linked/.test(x))), 'the link line went back');
}

// ------------------------------------------------------------------ pure pieces

test('the manifest, the review card, tips in six languages, the shared copies and the pace', () => {
  const raw = readFileSync(join(ROOT, 'plugins', 'slack', 'sara-plugin.json'), 'utf8');
  const m = parseManifest(raw, { saraVersion: V });
  assert.deepEqual(m.permissions.connect.map((c) => `${c.id}:${c.host}:${c.where}:${c.tls}:${(c.ports as number[]).join(',')}`), ['slack:domain:slack.com:public:required:443']);
  assert.equal(m.permissions.bridgeApprovals, true);
  assert.equal(m.permissions.bridgeFiles, true);
  assert.deepEqual(m.settings.map((s) => s.key), ['botToken', 'appToken', 'mirror']);
  assert.deepEqual(m.settings.filter((s) => s.type === 'secret').map((s) => s.key), ['botToken', 'appToken'], 'both tokens live in the vault');
  assert.ok(m.settings.every((s) => s.tip.length <= 260));
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    assert.ok(m.i18n[lang]?.[m.description], `${lang}: description`);
    for (const s of m.settings) assert.ok(m.i18n[lang]?.[s.label] && m.i18n[lang]?.[s.tip] && m.i18n[lang][s.tip].length <= 260, `${lang}: ${s.key}`);
  }
  const lines = permissionLines(m).map((l) => l.key);
  assert.ok(lines.includes('Connects to {domain} and its subdomains (ports {ports}, always encrypted)'));
  assert.ok(lines.includes('Shows her requests for your OK in its chats, with Allow and Deny (only you can answer)'));
  const read = (p: string, f: string) => readFileSync(join(ROOT, 'plugins', p, f), 'utf8');
  assert.equal(read('slack', 'http1.mjs'), read('whatsapp', 'http1.mjs'));
  assert.equal(read('slack', 'pace.mjs'), read('whatsapp', 'pace.mjs'));
  assert.equal(read('slack', 'sara-plugin.mjs'), readFileSync(join(ROOT, 'examples', 'plugins', 'sara-plugin.mjs'), 'utf8'));
  // Both token kinds are key-shaped (refused in ordinary settings, masked in logs).
  assert.ok(KEY_SHAPED.some((re) => re.test(BOT_TOKEN)) && KEY_SHAPED.some((re) => re.test(APP_TOKEN)));
  assert.deepEqual({ burst: LIMITS.slack.burst, everyMs: LIMITS.slack.everyMs, retry: LIMITS.slack.retry }, { burst: 3, everyMs: 1000, retry: 'server' });
});

test('the Settings page: the app manifest he pastes, and every diagnosis explained', async () => {
  // The app manifest he pastes at api.slack.com: Socket Mode on, interactivity on, /sara, the scopes.
  const page = readFileSync(join(ROOT, 'web', 'slack.js'), 'utf8');
  for (const scope of ['app_mentions:read', 'chat:write', 'im:history', 'im:read', 'im:write', 'files:read', 'files:write', 'users:read', 'channels:read', 'groups:read', 'commands', 'reactions:write']) assert.ok(page.includes(`'${scope}'`), scope);
  assert.match(page, /socket_mode_enabled: true/);
  assert.match(page, /interactivity: \{ is_enabled: true \}/);
  assert.match(page, /command: '\/sara'/);
  for (const code of Object.keys(DIAGNOSES)) assert.ok(page.includes(`${code}:`), `the card explains ${code}`);
  // The manifest object itself (rendered with a stand-in translator): valid for Slack's limits.
  (globalThis as Any).document ??= { querySelector: () => null };
  const { appManifest } = await import(pathToFileURL(join(ROOT, 'web', 'slack.js')).href).catch(() => ({ appManifest: undefined }));
  if (appManifest) {
    const m = appManifest('Sara with a very long name that Slack would refuse');
    assert.ok(m.display_information.name.length <= 35);
    assert.equal(m.settings.socket_mode_enabled, true);
    assert.deepEqual(m.settings.event_subscriptions.bot_events, ['app_mention', 'message.im']);
  }
});

test('the plugin parts: escape-first mrkdwn, Slack text in, error codes, WebSocket frames', () => {
  assert.equal(toMrkdwn('**Done** <b>x</b> & `a<b`'), '*Done* &lt;b&gt;x&lt;/b&gt; &amp; `a&lt;b`');
  assert.equal(toMrkdwn('[docs](https://example.com/a) and [bad](javascript:alert(1))'), '<https://example.com/a|docs> and bad');
  assert.equal(toMrkdwn('# Title\n- one\n- two'), '*Title*\n• one\n• two');
  assert.equal(toMrkdwn('<!channel> hi @here'), '&lt;!channel&gt; hi @here', 'she never pings a whole channel');
  assert.equal(fromSlack(`<@${BOT_USER}> what is &lt;this&gt; &amp; <https://x.example|that> in <#C1|general>?`, BOT_USER), 'what is <this> & that (https://x.example) in #general?');
  assert.equal(fromSlack('hi <@U0MIA|mia>', BOT_USER), 'hi @mia');
  assert.deepEqual(split('a'.repeat(25), 10), ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  assert.equal(codeOf({ error: 'invalid_auth' }), 'TOKEN_WRONG');
  assert.equal(codeOf({ error: 'not_authed' }), 'TOKEN_WRONG');
  assert.equal(codeOf({ error: 'token_revoked' }), 'TOKEN_GONE');
  assert.equal(codeOf({ error: 'account_inactive' }), 'TOKEN_GONE');
  assert.equal(codeOf({ error: 'missing_scope', needed: 'files:write' }), 'MISSING_SCOPE');
  assert.equal(codeOf({ error: 'ratelimited', status: 429 }), 'RATE_LIMITED');
  assert.equal(codeOf({ error: 'not_in_channel' }), 'NOT_IN_CHANNEL');
  assert.equal(codeOf({ message: 'net.open refused: private local mode is on' }), 'PRIVATE_LOCAL');
  assert.equal(codeOf({ message: "slack.com couldn't be found" }), 'CANT_REACH');
  assert.match(diagnose('TOKEN_GONE').title, /ended/);
  assert.equal(diagnose('UNKNOWN', `oops ${BOT_TOKEN}`).detail?.includes('xoxb-'), false, 'a token never shows in a detail');
  // Frames: masked from the client, any size; a server frame read back.
  const f = encodeFrame(1, Buffer.from('hello'), true);
  assert.equal(f[1] & 0x80, 0x80, 'client frames are masked');
  const big = encodeFrame(1, Buffer.alloc(70_000, 97), false);
  const rd = new FrameReader();
  const got: Any[] = [];
  rd.push(big.subarray(0, 100), (x: Any) => got.push(x));
  rd.push(big.subarray(100), (x: Any) => got.push(x));
  assert.equal(got.length, 1);
  assert.equal(got[0].payload.length, 70_000);
  assert.equal(acceptOf('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'RFC 6455 §1.3 example');
});

// ------------------------------------------------------------------ against the stand-in Slack

test('tokens: wrong shapes and swapped boxes in plain words; a refused token is not kept; Socket Mode off; then connected over Socket Mode', async (t) => {
  const r = await rig(t, { tokens: false });
  const post = (botToken: string, appToken: string) => r.api('POST', '/api/plugins/slack/tokens', { companion: 'main', botToken, appToken });
  let res = await post('hello', APP_TOKEN);
  assert.equal(res.json.diagnosis?.code, 'BOT_TOKEN_SHAPE');
  res = await post(APP_TOKEN, BOT_TOKEN);
  assert.equal(res.json.diagnosis?.code, 'TOKENS_SWAPPED');
  res = await post(BOT_TOKEN, 'xoxp-123-user-token');
  assert.equal(res.json.diagnosis?.code, 'APP_TOKEN_SHAPE');
  assert.equal(r.slack.requests.length, 0, 'shape checks call nobody');
  res = await post('xoxb-0000-wrong-token-here', APP_TOKEN);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.diagnosis.code, 'TOKEN_WRONG');
  assert.match(res.json.diagnosis.title, /Slack did not accept/);
  assert.equal(r.pm.settingsView('slack', 'main').settings.find((s) => s.key === 'botToken')?.set, false, 'a refused bot token is not kept');
  r.slack.socketMode = false;
  res = await post(BOT_TOKEN, APP_TOKEN);
  assert.equal(res.json.diagnosis?.code, 'SOCKET_OFF', JSON.stringify(res.json));
  r.slack.socketMode = true;
  res = await post(BOT_TOKEN, APP_TOKEN);
  assert.equal(res.json.ok, true, JSON.stringify(res.json));
  assert.equal(res.json.team, 'Fake Team');
  // The settings change restarted the plugin: wait for its own connection (not one from before).
  const proc = r.pm.processOf('slack', 'main');
  assert.ok(await until(() => r.pm.processOf('slack', 'main') === proc && r.pm.bridgeView('slack', 'main')?.state === 'ok' && Boolean(r.slack.live)), 'hello');
  await pause(300);
  // Acks: every envelope is acknowledged by its id; tokens never travel to the WebSocket host.
  r.slack.dm('anyone there?', { user: STRANGER, channel: DM_STRANGER });
  const id = r.slack.lastEnvelope;
  assert.ok(await until(() => r.slack.acks.has(id)), 'acked');
  assert.ok(r.slack.conns.every((c: Any) => !c.unmasked), 'every client frame was masked');
  assert.ok(r.slack.requests.filter((x: Any) => x.method === 'apps.connections.open').every((x: Any) => x.kind === 'app'), 'apps.connections.open uses the app token');
  assert.ok(r.slack.requests.filter((x: Any) => x.method === 'chat.postMessage').every((x: Any) => x.kind === 'bot'), 'messages use the bot token');
  // The stranger gets one line, then nothing.
  assert.ok(await until(() => texts(r, DM_STRANGER).length === 1));
  r.slack.dm('hello??', { user: STRANGER, channel: DM_STRANGER });
  await pause(500);
  assert.equal(texts(r, DM_STRANGER).length, 1);
  const view = await r.api('GET', '/api/plugins/slack/setup?companion=main');
  assert.equal(view.json.team, 'Fake Team');
  assert.ok(!JSON.stringify(view.json).includes('xoxb-') && !JSON.stringify(view.json).includes('xapp-'), 'tokens never come back to the page');
});

test('DM turn, thread as its own session, mention in an allowed channel only, /sara commands', async (t) => {
  const r = await rig(t);
  r.app.script.push(text('Hi Alex.'));
  r.slack.dm('hello');
  assert.ok(await until(() => texts(r, DM).includes('Hi Alex.')), 'answered in the DM');
  // A reply in a thread under her message is its own session, answered in that thread.
  const root = r.slack.sentTo(DM).find((p: Any) => p.text === 'Hi Alex.').ts;
  r.app.script.push(text('In the thread.'));
  r.slack.dm('about that', { thread_ts: root });
  assert.ok(await until(() => r.slack.sentTo(DM).some((p: Any) => p.text === 'In the thread.')));
  assert.equal(r.slack.sentTo(DM).find((p: Any) => p.text === 'In the thread.').thread_ts, root);
  const convs = r.app.store.listConversations().filter((c) => c.channel === 'plugin-slack');
  assert.equal(convs.length, 2, 'the thread is a session of its own');
  // A channel nobody switched on: ignored (counted, nothing sent).
  r.slack.mention('are you here?');
  await pause(600);
  assert.equal(r.slack.sentTo(CHANNEL).length, 0, 'not switched on: silent');
  // Switched on (*Answer here*): a mention is answered in its thread, as a room (no tools).
  const g = await r.api('POST', '/api/plugins/slack/group', { companion: 'main', chat: CHANNEL, on: true });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  r.app.script.push(text('Hello, channel.'));
  const ts = r.slack.mention('say hi');
  assert.ok(await until(() => r.slack.sentTo(CHANNEL).some((p: Any) => p.text === 'Hello, channel.')));
  assert.equal(r.slack.sentTo(CHANNEL).find((p: Any) => p.text === 'Hello, channel.').thread_ts, ts, 'answered in the mention\'s thread');
  assert.equal((r.app.requests.at(-1)!.tools ?? []).length, 0, 'a room turn has no tools');
  r.slack.mention('anyone?', { channel: OTHER_CHANNEL });
  await pause(400);
  assert.equal(r.slack.sentTo(OTHER_CHANNEL).length, 0, 'other channels stay off');
  // /sara new → the shared /new command (a fresh session), answered in the DM.
  const before = r.app.store.listConversations().filter((c) => c.channel === 'plugin-slack').length;
  const env = r.slack.slash('new');
  assert.ok(await until(() => r.slack.acks.has(env)), 'the slash command is acked');
  assert.ok(await until(() => r.app.store.listConversations().filter((c) => c.channel === 'plugin-slack').length > before), '/sara new started a session');
});

test('approvals as buttons: someone else is refused, his Allow lets the tool run; a late tap says so', async (t) => {
  const r = await rig(t);
  await r.api('POST', '/api/plugins/slack/group', { companion: 'main', chat: CHANNEL, on: true });
  r.app.settings.update({ toolPermissions: { write_file: 'ask' } });
  r.app.script.push([call('w', 'write_file', { path: 'd.txt', content: 'x' })], text('Done, saved.'));
  r.slack.dm('save a file');
  const card = () => r.slack.sentTo(DM).find((p: Any) => (p.blocks ?? []).some((b: Any) => b.type === 'actions' && b.elements.some((e: Any) => String(e.action_id).startsWith('ap:'))));
  assert.ok(await until(() => Boolean(card())), 'Allow / Deny posted in the DM');
  const c = card();
  assert.match(c.text, /She wants to/);
  const [allow, deny] = c.blocks.find((b: Any) => b.type === 'actions').elements;
  assert.deepEqual([allow.text.text, deny.text.text], ['Allow', 'Deny']);
  assert.match(allow.action_id, /^ap:[\w-]+:1$/);
  // Someone else's tap (here in his DM, as a forged payload) changes nothing and is told so privately.
  r.slack.click(allow.action_id, { user: COLLEAGUE, ts: c.ts });
  assert.ok(await until(() => r.slack.ephemeral.some((e: Any) => e.user === COLLEAGUE && /Only the owner/.test(e.text))), 'refused in plain words');
  assert.equal(r.app.approvals.pendingFor(r.app.store.listConversations().find((x) => x.channel === 'plugin-slack')!.id).length, 1, 'still waiting');
  // His Allow: the buttons become "Allowed." and the turn finishes.
  r.slack.click(allow.action_id, { user: OWNER, ts: c.ts });
  assert.ok(await until(() => r.slack.updates.some((u: Any) => u.ts === c.ts && /Allowed\./.test(u.text) && !(u.blocks ?? []).some((b: Any) => b.type === 'actions'))), 'buttons replaced by Allowed.');
  assert.ok(await until(() => texts(r, DM).includes('Done, saved.')), 'the tool ran and she answered');
  // The same button again: no longer waiting.
  r.slack.click(allow.action_id, { user: OWNER, ts: c.ts });
  assert.ok(await until(() => r.slack.ephemeral.some((e: Any) => e.user === OWNER && /no longer waiting/.test(e.text))));
});

test('files both ways: his picture downloaded with the bearer reaches the model; a stranger\'s is never fetched; hers goes up with the external upload', async (t) => {
  const r = await rig(t);
  const png = Buffer.from(PNG, 'base64');
  const f = r.slack.addFile('pic.png', 'image/png', png);
  r.app.script.push(text('A tiny picture.'));
  r.slack.dm('look', { files: [f] });
  assert.ok(await until(() => texts(r, DM).includes('A tiny picture.')), 'answered');
  assert.equal(r.slack.downloads.length, 1);
  assert.ok(r.slack.downloads.every((d: Any) => d.bearer && d.host.startsWith('files.slack.com')), 'downloaded from files.slack.com with the bot token');
  assert.ok(r.app.requests.at(-1)!.messages.some((m: Any) => (m.images ?? []).length > 0), 'the model got the picture');
  const g = r.slack.addFile('x.png', 'image/png', png);
  r.slack.dm('see this', { user: STRANGER, channel: DM_STRANGER, files: [g] });
  await pause(600);
  assert.equal(r.slack.downloads.length, 1, 'a stranger\'s file is never downloaded');
  // Her picture out: getUploadURLExternal → the bytes → completeUploadExternal in his DM.
  const pngPath = join(r.dir, 'out.png');
  writeFileSync(pngPath, png);
  const run = (r.pm as Any).processOf('slack', 'main');
  run.send({ v: 1, type: 'bridge.send', bridge: 'slack', chatId: DM, text: 'Here it is', files: [{ fileId: 'f1', name: 'out.png', mime: 'image/png', size: png.length }] });
  run.send({ v: 1, type: 'bridge.file', bridge: 'slack', chatId: DM, fileId: 'f1', seq: 0, last: true, data: png.toString('base64') });
  assert.ok(await until(() => r.slack.uploads.length === 1), 'uploaded');
  const up = r.slack.uploads[0];
  assert.equal(up.channel, DM);
  assert.equal(up.comment, 'Here it is');
  assert.deepEqual(Buffer.compare(up.bytes, png), 0, 'the same bytes');
});

test('the progress message: one message with ⏹, edited in place; his ⏹ stops the turn; the ✅ summary drops the button', async (t) => {
  const r = await rig(t);
  let stopped = false;
  r.app.stopTurn = () => ((stopped = true), true);
  r.app.script.push(text('ok'));
  r.slack.dm('start something');
  assert.ok(await until(() => texts(r, DM).includes('ok')));
  const run = (r.pm as Any).processOf('slack', 'main');
  // A slow Slack (as under load): the post is recorded at once but answered 1.5 s later. An edit that
  // arrives before the answer must wait for the post's ts, not be dropped (the flake's root cause).
  r.slack.slow.set('chat.postMessage', 1500);
  run.send({ v: 1, type: 'bridge.send', bridge: 'slack', chatId: DM, ref: 'p-9', text: 'Working… step 1' });
  const prog = () => r.slack.sentTo(DM).find((p: Any) => /step 1/.test(p.text));
  assert.ok(await until(() => Boolean(prog())), 'the progress message is up');
  r.slack.slow.delete('chat.postMessage');
  assert.equal(prog().blocks.find((b: Any) => b.type === 'actions').elements[0].action_id, 'st:p-9');
  run.send({ v: 1, type: 'bridge.edit', bridge: 'slack', chatId: DM, ref: 'p-9', text: 'Working… step 2' });
  assert.ok(await until(() => r.slack.updates.some((u: Any) => u.ts === prog().ts && /step 2/.test(u.text) && u.blocks.some((b: Any) => b.type === 'actions'))), 'edited in place, ⏹ kept');
  r.slack.click('st:p-9', { user: OWNER, ts: prog().ts });
  assert.ok(await until(() => stopped), '⏹ stopped the turn');
  run.send({ v: 1, type: 'bridge.edit', bridge: 'slack', chatId: DM, ref: 'p-9', text: '✅ Done: 2 steps' });
  assert.ok(await until(() => r.slack.updates.some((u: Any) => /Done/.test(u.text) && !u.blocks.some((b: Any) => b.type === 'actions'))), 'the summary has no button');
});

test('pace and reconnects: a 429 is waited out; a dropped socket and a disconnect both reconnect; a revoked token stops in plain words; removal leaves no token', async (t) => {
  const r = await rig(t);
  r.slack.errors.push({ method: 'chat.postMessage', error: 'ratelimited', status: 429, retryAfter: 1, once: true });
  r.app.script.push(text('After the wait.'));
  r.slack.dm('one');
  assert.ok(await until(() => texts(r, DM).includes('After the wait.')), 'sent after Retry-After');
  assert.equal(r.slack.requests.filter((x: Any) => x.method === 'chat.postMessage').length >= 2, true);
  // A network blip: the socket drops; she opens a new one and still answers.
  const opens = r.slack.opens;
  r.slack.drop();
  assert.ok(await until(() => r.slack.opens > opens && Boolean(r.slack.live)), 'reconnected after a drop');
  r.app.script.push(text('Still here.'));
  r.slack.dm('you there?');
  assert.ok(await until(() => texts(r, DM).includes('Still here.')));
  // Slack's own refresh: `disconnect` → a fresh URL at once.
  const opens2 = r.slack.opens;
  r.slack.disconnect('refresh_requested');
  assert.ok(await until(() => r.slack.opens > opens2 && Boolean(r.slack.live)), 'reconnected after disconnect');
  // Pings are answered.
  r.slack.ping();
  await pause(200);
  // A revoked token: the status says so in plain words and the loop stops (no hot loop).
  r.slack.revoked.add(BOT_TOKEN);
  r.slack.revoked.add(APP_TOKEN);
  r.slack.drop();
  assert.ok(await until(() => r.pm.bridgeView('slack', 'main')?.state === 'error'), 'error state');
  assert.match(String(r.pm.bridgeView('slack', 'main')?.detail), /Slack ended her token/);
  const n = r.slack.requests.length;
  await pause(1500);
  assert.ok(r.slack.requests.length - n <= 1, 'no reconnect loop on a revoked token');
  const setup = await r.api('GET', '/api/plugins/slack/setup?companion=main');
  assert.equal(setup.json.steps.find((s: Any) => s.id === 'tokens').diagnosis?.code, 'TOKEN_GONE');
  // Removing the plugin deletes both tokens from the vault.
  assert.ok(r.app.vault.get('plugin:slack:botToken'));
  await r.pm.remove('slack');
  assert.equal(r.app.vault.get('plugin:slack:botToken'), undefined);
  assert.equal(r.app.vault.get('plugin:slack:appToken'), undefined);
});
