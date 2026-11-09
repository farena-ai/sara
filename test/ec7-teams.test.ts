// EC7 (docs/ops/EC7_DESIGN.md): Microsoft Teams as a chat app through an Azure Bot. A stand-in
// Microsoft (test/fixtures/teams/fake.mjs: the token endpoint, the Bot Connector and SharePoint on a
// test CA) is reached by the real plugin process from plugins/teams through Sara's socket broker and
// its test-only loopback override; the same fake plays Teams, signing activities with its own key
// (OpenID metadata + JWKS on loopback) and POSTing them to Sara's bridge hook over real HTTP. No
// tenant, no real network, a fake model.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { test, type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { BotFrameworkAuth } from '../src/plugins/botframework-auth.ts';
import { PluginManager } from '../src/plugins/manager.ts';
import { parseManifest, permissionLines, satisfies } from '../src/plugins/manifest.ts';
import { teamsAppId, zip } from '../src/plugins/teams-package.ts';
import { credentialShape } from '../src/plugins/teams-setup.ts';
import { KEY_SHAPED } from '../src/redact.ts';
import { createSaraServer } from '../src/server.ts';
import { HookManager } from '../src/webhooks.ts';
import { call, makeApp, PNG, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const PKG_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const V = satisfies(PKG_VERSION, '>=2.82.0') ? PKG_VERSION : '2.82.0';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const load = (f: string): Promise<Any> => import(pathToFileURL(join(ROOT, 'plugins', 'teams', f)).href);
const { fromTeams, toTeams, split } = await load('format.mjs');
const { codeOf, diagnose, DIAGNOSES } = await load('diagnose.mjs');
const { card, tapOf } = await load('cards.mjs');
const { LIMITS } = await load('pace.mjs');
const F = await import(pathToFileURL(join(ROOT, 'test', 'fixtures', 'teams', 'fake.mjs')).href);
const { BotSigner, FakeTeams, APP_ID, TENANT, SECRET, OWNER, COLLEAGUE, STRANGER, DM, DM_STRANGER, CHANNEL, OTHER_CHANNEL } = F;

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
  ms: Any;
  signer: Any;
  app: TestApp;
  pm: PluginManager;
  hm: HookManager;
  dir: string;
  base: string;
  owner: string;
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: Record<string, Any> }>;
}

const MS_HOSTS = (h: string) => h === 'login.microsoftonline.com' || h === 'smba.trafficmanager.net' || h === 'sharepoint.com' || h.endsWith('.sharepoint.com');

async function rig(t: TestContext, o: { creds?: boolean; link?: boolean } = {}): Promise<Rig> {
  const signer = new BotSigner();
  await signer.startOpenId();
  const ms = await new FakeTeams(signer).start();
  const { dir, cleanup } = tempDir();
  const app = baseApp(dir);
  const auth = new OwnerAuth(dir);
  const owner = auth.newToken!;
  const lookup = async (h: string) => (MS_HOSTS(h) ? ['127.0.0.1'] : []);
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, events: app.events, scrub: (x) => app.redactor.redact(x), fence: 'node-only', saraVersion: V, netCa: ms.caPem, lookup, netTestLoopback: true, netTestPort: ms.port });
  app.pluginManager = pm;
  pm.attach('main', app);
  const hm = new HookManager({ db: app.store.db, vault: app.vault, scrub: (s) => app.redactor.redact(s), botFramework: new BotFrameworkAuth({ metadataUrl: signer.metadataUrl }) });
  app.hooks = hm;
  hm.attach('main', app);
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
    await ms.stop();
    await signer.stopOpenId();
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
  const review = pm.stageBuiltin('teams');
  await pm.approve(review.id, { trust: true });
  await pm.setEnabled('teams', 'main', true);
  assert.ok(await until(() => pm.processOf('teams', 'main')?.state === 'ready'), 'the plugin started');
  const r: Rig = { ms, signer, app, pm, hm, dir, base, owner, api };
  if (o.creds !== false) {
    const res = await api('POST', '/api/plugins/teams/credentials', { companion: 'main', appId: APP_ID, tenantId: TENANT, appPassword: SECRET });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.ok, true, JSON.stringify(res.json));
    await hookUp(r);
    assert.ok(await until(() => r.pm.bridgeView('teams', 'main')?.state === 'ok'), 'the status chip says connected');
  }
  if (o.link !== false && o.creds !== false) await link(r);
  return r;
}

/** The fake Teams calls the hook path Sara made (as a tunnel would forward it). */
async function hookUp(r: Rig) {
  const setup = await r.api('GET', '/api/plugins/teams/setup?companion=main');
  assert.ok(setup.json.hookPath, JSON.stringify(setup.json));
  r.ms.hookUrl = `${r.base}${setup.json.hookPath}`;
}

const texts = (r: Rig, conv: string) => r.ms.sentTo(conv).map((p: Any) => p.text ?? p.attachments?.[0]?.content?.body?.[0]?.text);

async function link(r: Rig) {
  const e = await r.api('POST', '/api/plugins/teams/fix', { companion: 'main', fix: 'link' });
  assert.equal(e.status, 200, JSON.stringify(e.json));
  assert.equal((await r.ms.dm(`link ${e.json.code}`)).status, 200);
  assert.ok(await until(() => (r.pm.settingsView('teams', 'main').bridge?.ownerChats ?? []).includes(DM)), 'linked');
  assert.ok(await until(() => texts(r, DM).some((x: string) => /Linked/.test(String(x)))), 'the link line went back');
}

// ------------------------------------------------------------------ pure pieces

test('the manifest, the review card, tips in six languages, the shared copies and the pace', () => {
  const m = parseManifest(readFileSync(join(ROOT, 'plugins', 'teams', 'sara-plugin.json'), 'utf8'), { saraVersion: V });
  assert.deepEqual(m.permissions.connect.map((c) => `${c.id}:${c.host}`), ['login:domain:login.microsoftonline.com', 'connector:domain:smba.trafficmanager.net', 'files:domain:sharepoint.com']);
  assert.ok(m.permissions.connect.every((c) => c.where === 'public' && c.tls === 'required' && (c.ports as number[]).join() === '443'));
  assert.equal(m.permissions.webhooks, 'bridge');
  assert.deepEqual(m.permissions.webhookKinds, ['botframework']);
  assert.equal(m.permissions.bridgeApprovals, true);
  assert.equal(m.permissions.bridgeFiles, true);
  assert.deepEqual(m.settings.map((s) => s.key), ['appId', 'tenantId', 'appPassword', 'mirror']);
  assert.deepEqual(m.settings.filter((s) => s.type === 'secret').map((s) => s.key), ['appPassword'], 'the secret lives in the vault');
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    assert.ok(m.i18n[lang]?.[m.description], `${lang}: description`);
    for (const s of m.settings) assert.ok(m.i18n[lang]?.[s.label] && m.i18n[lang]?.[s.tip] && m.i18n[lang][s.tip].length <= 260, `${lang}: ${s.key}`);
  }
  const lines = permissionLines(m).map((l) => l.key);
  assert.ok(lines.includes('Receives messages from Microsoft Teams at a public web address Sara gives it (Sara checks Microsoft’s signature first)'));
  assert.ok(lines.includes('Shows her requests for your OK in its chats, with Allow and Deny (only you can answer)'));
  const read = (p: string, f: string) => readFileSync(join(ROOT, 'plugins', p, f), 'utf8');
  assert.equal(read('teams', 'http1.mjs'), read('whatsapp', 'http1.mjs'));
  assert.equal(read('teams', 'pace.mjs'), read('whatsapp', 'pace.mjs'));
  assert.equal(read('teams', 'sara-plugin.mjs'), readFileSync(join(ROOT, 'examples', 'plugins', 'sara-plugin.mjs'), 'utf8'));
  assert.ok(KEY_SHAPED.some((re) => re.test(SECRET)), 'an Entra client secret is key-shaped (masked in logs)');
  assert.deepEqual({ burst: LIMITS.teams.burst, everyMs: LIMITS.teams.everyMs, retry: LIMITS.teams.retry }, { burst: 3, everyMs: 1000, retry: 'server' });
});

test('the plugin parts: Teams text in, escape-first Markdown out, cards, error codes, credential shapes', () => {
  assert.equal(fromTeams('<at>Sara</at> what is &lt;this&gt; &amp; <a href="https://x.example">that</a>?<br>ok', ['<at>Sara</at>']), 'what is <this> & that (https://x.example)?\nok');
  assert.equal(fromTeams('hi <at>Mia</at>', ['Sara']), 'hi @Mia');
  assert.equal(toTeams('**Done** <b>x</b> & [ok](https://e.example) [bad](javascript:alert(1))'), '**Done** &lt;b&gt;x&lt;/b&gt; &amp; [ok](https://e.example) bad');
  assert.equal(toTeams('# Title'), '**Title**');
  assert.deepEqual(split('a'.repeat(25), 10), ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  const c = card('She wants to: write a file', [{ id: 'ap:x1:1', label: 'Allow' }, { id: 'ap:x1:0', label: 'Deny' }]);
  assert.equal(c.contentType, 'application/vnd.microsoft.card.adaptive');
  assert.deepEqual(c.content.actions.map((a: Any) => [a.type, a.title, a.style, a.data.sara]), [['Action.Submit', 'Allow', 'positive', 'ap:x1:1'], ['Action.Submit', 'Deny', 'destructive', 'ap:x1:0']]);
  assert.equal(tapOf({ value: { sara: 'ap:x1:1' } }), 'ap:x1:1');
  assert.equal(tapOf({ value: 'nope' }), '');
  assert.equal(codeOf({ aad: 'AADSTS7000215' }), 'SECRET_WRONG');
  assert.equal(codeOf({ aad: 'AADSTS7000222' }), 'SECRET_EXPIRED');
  assert.equal(codeOf({ aad: 'AADSTS700016' }), 'APP_ID_WRONG');
  assert.equal(codeOf({ aad: 'AADSTS90002' }), 'TENANT_WRONG');
  assert.equal(codeOf({ status: 429 }), 'RATE_LIMITED');
  assert.equal(codeOf({ status: 403 }), 'FORBIDDEN');
  assert.equal(codeOf({ message: 'net.open refused: private local mode is on' }), 'PRIVATE_LOCAL');
  assert.equal(codeOf({ message: "login.microsoftonline.com couldn't be found" }), 'CANT_REACH');
  assert.equal(diagnose('UNKNOWN', `oops Bearer eyJabc.def.ghi ${SECRET}`, {}, SECRET).detail.includes(SECRET), false, 'a secret never shows in a detail');
  assert.equal(credentialShape('nope', '', SECRET, false), 'APP_ID_SHAPE');
  assert.equal(credentialShape(APP_ID, 'not a tenant!', SECRET, false), 'TENANT_SHAPE');
  assert.equal(credentialShape(APP_ID, TENANT, '0f1e2d3c-4b5a-4968-8776-655443322110', false), 'SECRET_SHAPE', 'the Secret ID pasted as the secret');
  assert.equal(credentialShape(APP_ID, TENANT, '', false), 'NOT_SET');
  assert.equal(credentialShape(APP_ID, TENANT, '', true), undefined, 'the saved secret is kept');
  assert.equal(credentialShape(APP_ID, 'contoso.onmicrosoft.com', SECRET, false), undefined);
});

test('the Settings page explains every diagnosis and states both address cases plainly', () => {
  const page = readFileSync(join(ROOT, 'web', 'teams.js'), 'utf8');
  for (const c of Object.keys(DIAGNOSES)) assert.ok(page.includes(`${c}:`), `the card explains ${c}`);
  assert.match(page, /Sara has a public https address, so nothing else is needed here\./);
  assert.match(page, /No public address: Teams can't reach this computer\./);
  assert.match(page, /app-package/);
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /data-page="co-teams"/);
  assert.match(readFileSync(join(ROOT, 'web', 'help.html'), 'utf8'), /<h2 id="teams">Microsoft Teams<\/h2>/);
});

test('the app package: a zip with manifest.json and both icons, a stable app id per bot', () => {
  const z = zip([{ name: 'a.txt', data: Buffer.from('hello') }]);
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  assert.equal(z.subarray(30 + 5, 30 + 10).toString(), 'hello', 'stored, not compressed');
  assert.equal(teamsAppId(APP_ID, 'main'), teamsAppId(APP_ID.toUpperCase(), 'main'));
  assert.notEqual(teamsAppId(APP_ID, 'main'), teamsAppId(APP_ID, 'other'));
  assert.match(teamsAppId(APP_ID, 'main'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

/** Reads a stored zip back: name → bytes (and checks every CRC). */
function unzip(buf: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const size = buf.readUInt32LE(at + 18);
    const n = buf.readUInt16LE(at + 26);
    const name = buf.subarray(at + 30, at + 30 + n).toString('latin1');
    out[name] = buf.subarray(at + 30 + n, at + 30 + n + size);
    at += 30 + n + size;
  }
  return out;
}
const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];

// ------------------------------------------------------------------ against the stand-in Microsoft

test('credentials: shapes in plain words, a refused secret is not kept, the hook checks Microsoft\'s signature, the package downloads', async (t) => {
  const r = await rig(t, { creds: false });
  const post = (appId: string, tenantId: string, appPassword: string) => r.api('POST', '/api/plugins/teams/credentials', { companion: 'main', appId, tenantId, appPassword });
  assert.equal((await post('nope', TENANT, SECRET)).json.diagnosis?.code, 'APP_ID_SHAPE');
  assert.equal((await post(APP_ID, TENANT, '0f1e2d3c-4b5a-4968-8776-655443322110')).json.diagnosis?.code, 'SECRET_SHAPE');
  assert.equal(r.ms.tokenCalls.length, 0, 'shape checks call nobody');
  let res = await post(APP_ID, TENANT, 'abc8Q~WrongWrongWrongWrongWrongWrong_123');
  assert.equal(res.json.diagnosis?.code, 'SECRET_WRONG', JSON.stringify(res.json));
  assert.match(res.json.diagnosis.title, /did not accept that client secret/);
  assert.equal(r.pm.settingsView('teams', 'main').settings.find((s) => s.key === 'appPassword')?.set, false, 'a refused secret is not kept');
  res = await post(APP_ID, '0e0e0e0e-0000-4000-8000-000000000000', SECRET);
  assert.equal(res.json.diagnosis?.code, 'TENANT_WRONG');
  res = await post(APP_ID, TENANT, SECRET);
  assert.equal(res.json.ok, true, JSON.stringify(res.json));
  assert.deepEqual(r.ms.tokenCalls.at(-1), { tenant: TENANT, clientId: APP_ID, scope: 'https://api.botframework.com/.default', grant: 'client_credentials' });
  // No public address: the card says so (and still shows the path a tunnel must forward).
  let setup = await r.api('GET', '/api/plugins/teams/setup?companion=main');
  assert.equal(setup.json.endpoint, null);
  assert.equal(setup.json.steps.find((s: Any) => s.id === 'door').diagnosis?.code, 'NO_DOOR');
  assert.match(setup.json.hookPath, /^\/hook\/h[0-9a-f]{12}\.[A-Za-z0-9_-]+$/);
  assert.ok(!JSON.stringify(setup.json).includes(SECRET), 'the secret never comes back to the page');
  // A tunnel: the endpoint to paste in the Azure Bot.
  assert.equal((await r.api('POST', '/api/plugins/teams/door-url', { companion: 'main', url: 'http://plain.example' })).status, 400);
  await r.api('POST', '/api/plugins/teams/door-url', { companion: 'main', url: 'https://sara-tunnel.example/anything' });
  setup = await r.api('GET', '/api/plugins/teams/setup?companion=main');
  assert.equal(setup.json.endpoint, `https://sara-tunnel.example${setup.json.hookPath}`);
  assert.equal((await r.api('POST', '/api/plugins/teams/check', { companion: 'main', step: 'endpoint' })).json.diagnosis?.code, 'NOT_CALLED');
  // Forged and unsigned calls are refused before the plugin sees them; a signed one counts as "Microsoft called".
  await hookUp(r);
  assert.equal(await r.ms.deliver(r.ms.activity({ text: 'hi' }), { token: '' }), 401);
  assert.equal(await r.ms.deliver(r.ms.activity({ text: 'hi' }), { token: r.signer.token({ aud: APP_ID }, { forge: true }) }), 401);
  assert.equal(await r.ms.deliver(r.ms.activity({ text: 'hi' }), { token: r.signer.token({ aud: 'another-bot' }) }), 401);
  assert.equal(r.app.store.listConversations().filter((c) => c.channel === 'plugin-teams').length, 0, 'nothing reached her');
  assert.equal((await r.ms.dm('hello?', { from: STRANGER, conv: DM_STRANGER })).status, 200);
  assert.equal((await r.api('POST', '/api/plugins/teams/check', { companion: 'main', step: 'endpoint' })).json.ok, true);
  // The stranger gets one line, then nothing.
  assert.ok(await until(() => texts(r, DM_STRANGER).length === 1));
  await r.ms.dm('hello??', { from: STRANGER, conv: DM_STRANGER });
  await pause(500);
  assert.equal(texts(r, DM_STRANGER).length, 1);
  // The app package: manifest.json with her bot, both icons at Teams' sizes.
  assert.equal((await fetch(`${r.base}/api/plugins/teams/app-package?companion=main`)).status, 401, 'owner only');
  assert.equal((await fetch(`${r.base}/api/plugins/teams/app-package?companion=main`, { headers: { authorization: `Bearer ${r.owner}` } })).status, 200);
  setup = await r.api('GET', '/api/plugins/teams/setup?companion=main');
  assert.ok(setup.json.steps.find((s: Any) => s.id === 'package').ok, 'downloaded and Microsoft has called');
});

test('the package zip itself (owner download)', async (t) => {
  const r = await rig(t, { link: false });
  const res = await fetch(`${r.base}/api/plugins/teams/app-package?companion=main`, { headers: { authorization: `Bearer ${r.owner}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(String(res.headers.get('content-disposition')), /sara-teams\.zip/);
  const bytes = Buffer.from(await res.arrayBuffer());
  const files = unzip(bytes);
  assert.deepEqual(Object.keys(files).sort(), ['color.png', 'manifest.json', 'outline.png']);
  const m = JSON.parse(files['manifest.json'].toString('utf8'));
  assert.equal(m.manifestVersion, '1.17');
  assert.equal(m.bots[0].botId, APP_ID);
  assert.deepEqual(m.bots[0].scopes, ['personal', 'team', 'groupChat']);
  assert.equal(m.bots[0].supportsFiles, true);
  assert.ok(m.name.short.length <= 30 && m.description.short.length <= 80);
  assert.equal(m.id, teamsAppId(APP_ID, 'main'));
  assert.deepEqual(pngSize(files['color.png']), [192, 192]);
  assert.deepEqual(pngSize(files['outline.png']), [32, 32]);
  // The outline is white on transparent (Teams' rule): every pixel is transparent or white.
  const idat = files['outline.png'].subarray(41, files['outline.png'].length - 12 - 4);
  const px = inflateSync(idat);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const i = y * 129 + 1 + x * 4;
      assert.ok(px[i + 3] === 0 || (px[i] === 255 && px[i + 1] === 255 && px[i + 2] === 255), `pixel ${x},${y}`);
    }
});

test('personal chat turn, channel mention on/off answered in its thread, a room turn has no tools', async (t) => {
  const r = await rig(t);
  r.app.script.push(text('Hi Alex.'));
  await r.ms.dm('hello');
  assert.ok(await until(() => texts(r, DM).includes('Hi Alex.')), 'answered in her personal chat');
  assert.equal(r.ms.sentTo(DM).find((p: Any) => p.text === 'Hi Alex.').textFormat, 'markdown');
  // A channel nobody switched on: ignored (nothing sent), but it now shows on the card.
  await r.ms.mention('are you here?');
  await pause(600);
  assert.equal(r.ms.sentTo(CHANNEL).length, 0, 'not switched on: silent');
  const setup = await r.api('GET', '/api/plugins/teams/setup?companion=main');
  assert.deepEqual(setup.json.channels.map((c: Any) => [c.id, c.name, c.on]), [[CHANNEL, 'General', false]]);
  const g = await r.api('POST', '/api/plugins/teams/group', { companion: 'main', chat: CHANNEL, on: true });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  r.app.script.push(text('Hello, channel.'));
  const m = await r.ms.mention('say hi', { from: COLLEAGUE });
  assert.ok(await until(() => r.ms.sentTo(CHANNEL).some((p: Any) => p.text === 'Hello, channel.')));
  assert.equal(r.ms.sentTo(CHANNEL).find((p: Any) => p.text === 'Hello, channel.').conv, m.conv, "answered in the mention's thread");
  assert.equal((r.app.requests.at(-1)!.tools ?? []).length, 0, 'a room turn has no tools');
  assert.ok(!JSON.stringify(r.app.requests.at(-1)!.messages).includes('<at>'), 'her own mention is not in what the model read');
  await r.ms.mention('anyone?', { channel: OTHER_CHANNEL });
  await pause(400);
  assert.equal(r.ms.sentTo(OTHER_CHANNEL).length, 0, 'other channels stay off');
  // A replayed activity (same id) is handled once.
  const before = r.app.requests.length;
  const a = r.ms.activity({ text: 'once', id: 'dup-1' });
  r.app.script.push(text('Once.'));
  await r.ms.deliver(a);
  await r.ms.deliver(a);
  assert.ok(await until(() => texts(r, DM).includes('Once.')));
  await pause(400);
  assert.equal(r.app.requests.length, before + 1, 'the same activity twice is one turn');
});

test('approvals as an Adaptive Card: someone else is refused, his Allow lets the tool run and the card says so; a late tap says so', async (t) => {
  const r = await rig(t);
  r.app.settings.update({ toolPermissions: { write_file: 'ask' } });
  r.app.script.push([call('w', 'write_file', { path: 'd.txt', content: 'x' })], text('Done, saved.'));
  await r.ms.dm('save a file');
  const cardPost = () => r.ms.sentTo(DM).find((p: Any) => (p.attachments ?? []).some((a: Any) => (a.content?.actions ?? []).some((x: Any) => String(x.data?.sara).startsWith('ap:'))));
  assert.ok(await until(() => Boolean(cardPost())), 'Allow / Deny posted in her personal chat');
  const c = cardPost();
  const ac = c.attachments[0].content;
  assert.match(ac.body[0].text, /She wants to/);
  const [allow, deny] = ac.actions;
  assert.deepEqual([allow.title, deny.title], ['Allow', 'Deny']);
  assert.match(allow.data.sara, /^ap:[\w-]+:1$/);
  // Someone else's tap (a forged activity in his chat) changes nothing and is told so.
  await r.ms.tap(allow.data.sara, { from: COLLEAGUE, replyToId: c.id });
  assert.ok(await until(() => texts(r, DM).some((x: string) => /Only the owner/.test(String(x)))), 'refused in plain words');
  assert.equal(r.app.approvals.pendingFor(r.app.store.listConversations().find((x) => x.channel === 'plugin-teams')!.id).length, 1, 'still waiting');
  await r.ms.tap(allow.data.sara, { replyToId: c.id });
  assert.ok(await until(() => r.ms.updates.some((u: Any) => u.id === c.id && /Allowed\./.test(u.attachments[0].content.body[0].text) && !u.attachments[0].content.actions)), 'the card now says Allowed., no buttons');
  assert.ok(await until(() => texts(r, DM).includes('Done, saved.')), 'the tool ran and she answered');
  await r.ms.tap(allow.data.sara, { replyToId: c.id });
  assert.ok(await until(() => texts(r, DM).some((x: string) => /no longer waiting/.test(String(x)))));
});

test("files both ways: his OneDrive file and pasted picture reach the model; a stranger's is never fetched; hers goes to his OneDrive after his Allow", async (t) => {
  const r = await rig(t);
  const png = Buffer.from(PNG, 'base64');
  r.app.script.push(text('A tiny picture.'));
  await r.ms.dm('look', { attachments: [r.ms.addFile('pic.png', 'image/png', png, { inline: true })] });
  assert.ok(await until(() => texts(r, DM).includes('A tiny picture.')), 'answered');
  assert.equal(r.ms.downloads.length, 1);
  assert.ok(r.ms.downloads[0].host === 'smba.trafficmanager.net' && r.ms.downloads[0].bearer, 'an inline picture is fetched from the Connector with the bot token');
  assert.ok(r.app.requests.at(-1)!.messages.some((m: Any) => (m.images ?? []).length > 0), 'the model got the picture');
  r.app.script.push(text('Got the file.'));
  await r.ms.dm('', { attachments: [r.ms.addFile('notes.png', 'image/png', png)] });
  assert.ok(await until(() => texts(r, DM).includes('Got the file.')));
  assert.equal(r.ms.downloads.length, 2);
  assert.ok(r.ms.downloads[1].host.endsWith('.sharepoint.com') && !r.ms.downloads[1].bearer, 'a OneDrive file comes from its pre-signed link, no bot token sent there');
  await r.ms.dm('see this', { from: STRANGER, conv: DM_STRANGER, attachments: [r.ms.addFile('x.png', 'image/png', png, { inline: true })] });
  await pause(600);
  assert.equal(r.ms.downloads.length, 2, "a stranger's file is never downloaded");
  // Her file out: a consent card; his Allow → the bytes go to his OneDrive in chunks, then a file card.
  const run = (r.pm as Any).processOf('teams', 'main');
  run.send({ v: 1, type: 'bridge.send', bridge: 'teams', chatId: DM, text: 'Here it is', files: [{ fileId: 'f1', name: 'out.png', mime: 'image/png', size: png.length }] });
  run.send({ v: 1, type: 'bridge.file', bridge: 'teams', chatId: DM, fileId: 'f1', seq: 0, last: true, data: png.toString('base64') });
  const consentPost = () => r.ms.sentTo(DM).find((p: Any) => p.attachments?.[0]?.contentType === 'application/vnd.microsoft.teams.card.file.consent');
  assert.ok(await until(() => Boolean(consentPost())), 'the consent card');
  assert.ok(texts(r, DM).includes('Here it is'));
  const cc = consentPost().attachments[0];
  assert.equal(cc.content.sizeInBytes, png.length);
  // Someone else answering the card is ignored.
  const fileId = cc.content.acceptContext.fileId;
  const other = await r.ms.consentAnswer(fileId, 'accept', { from: COLLEAGUE });
  assert.equal(other.status, 200);
  await pause(400);
  assert.equal(r.ms.uploaded(other.upload), undefined, 'not his: nothing uploaded');
  const mine = await r.ms.consentAnswer(fileId, 'accept');
  assert.ok(await until(() => Buffer.compare(r.ms.uploaded(mine.upload) ?? Buffer.alloc(0), png) === 0), 'the same bytes in his OneDrive');
  assert.ok(await until(() => r.ms.sentTo(DM).some((p: Any) => p.attachments?.[0]?.contentType === 'application/vnd.microsoft.teams.card.file.info')), 'the file card in the chat');
  // In a channel she can't send files: she says so instead of failing silently.
  await r.api('POST', '/api/plugins/teams/group', { companion: 'main', chat: CHANNEL, on: true });
  r.app.script.push(text('hi'));
  await r.ms.mention('hi');
  assert.ok(await until(() => r.ms.sentTo(CHANNEL).length > 0));
  run.send({ v: 1, type: 'bridge.send', bridge: 'teams', chatId: CHANNEL, text: 'Chart', files: [{ fileId: 'f2', name: 'c.png', mime: 'image/png', size: png.length }] });
  run.send({ v: 1, type: 'bridge.file', bridge: 'teams', chatId: CHANNEL, fileId: 'f2', seq: 0, last: true, data: png.toString('base64') });
  await pause(800);
  assert.ok(!r.ms.sentTo(CHANNEL).some((p: Any) => p.attachments?.[0]?.contentType === 'application/vnd.microsoft.teams.card.file.consent'), 'no consent card in a channel');
});

test('the progress card: edited in place with ⏹; his ⏹ stops the turn; the ✅ summary drops the button', async (t) => {
  const r = await rig(t);
  let stopped = false;
  r.app.stopTurn = () => ((stopped = true), true);
  r.app.script.push(text('ok'));
  await r.ms.dm('start something');
  assert.ok(await until(() => texts(r, DM).includes('ok')));
  const run = (r.pm as Any).processOf('teams', 'main');
  run.send({ v: 1, type: 'bridge.send', bridge: 'teams', chatId: DM, ref: 'p-9', text: 'Working… step 1' });
  const prog = () => r.ms.sentTo(DM).find((p: Any) => /step 1/.test(String(p.attachments?.[0]?.content?.body?.[0]?.text)));
  assert.ok(await until(() => Boolean(prog())), 'the progress card is up');
  assert.equal(prog().attachments[0].content.actions[0].data.sara, 'st:p-9');
  run.send({ v: 1, type: 'bridge.edit', bridge: 'teams', chatId: DM, ref: 'p-9', text: 'Working… step 2' });
  assert.ok(await until(() => r.ms.updates.some((u: Any) => u.id === prog().id && /step 2/.test(u.attachments[0].content.body[0].text) && u.attachments[0].content.actions?.length === 1)), 'edited in place, ⏹ kept');
  await r.ms.tap('st:p-9', { replyToId: prog().id });
  assert.ok(await until(() => stopped), '⏹ stopped the turn');
  run.send({ v: 1, type: 'bridge.edit', bridge: 'teams', chatId: DM, ref: 'p-9', text: '✅ Done: 2 steps' });
  assert.ok(await until(() => r.ms.updates.some((u: Any) => /Done/.test(u.attachments[0].content.body[0].text) && !u.attachments[0].content.actions)), 'the summary has no button');
});

test('pace and token errors: a 429 is waited out; a 401 refetches the token; an expired secret stops in plain words; removal leaves no secret or hook', async (t) => {
  const r = await rig(t);
  r.ms.errors.push({ kind: 'connector', status: 429, retryAfter: 1, once: true });
  r.app.script.push(text('After the wait.'));
  await r.ms.dm('one');
  assert.ok(await until(() => texts(r, DM).includes('After the wait.')), 'sent after Retry-After');
  assert.ok(r.ms.requests.filter((x: Any) => x.host === 'smba.trafficmanager.net' && x.method === 'POST').length >= 2);
  // A token that stops being accepted (401 at the Connector) is fetched again once, and the message still goes.
  r.ms.tokens.clear();
  r.app.script.push(text('New token.'));
  await r.ms.dm('two');
  assert.ok(await until(() => texts(r, DM).includes('New token.')), 'a fresh token after a 401');
  // The secret expires: the next token fails, the status says so in plain words.
  r.ms.expired = true;
  r.ms.tokens.clear();
  const check = await r.api('POST', '/api/plugins/teams/check', { companion: 'main', step: 'credentials' });
  assert.equal(check.json.diagnosis?.code, 'SECRET_EXPIRED');
  assert.match(check.json.diagnosis.title, /expired/);
  r.app.script.push(text('never sent'));
  await r.ms.dm('three');
  assert.ok(await until(() => r.pm.bridgeView('teams', 'main')?.state === 'error'), 'error state');
  assert.match(String(r.pm.bridgeView('teams', 'main')?.detail), /client secret has expired/);
  // Removing the plugin deletes the secret and the hook.
  assert.ok(r.app.vault.get('plugin:teams:appPassword'));
  const del = await r.api('DELETE', '/api/plugins/teams');
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.equal(r.app.vault.get('plugin:teams:appPassword'), undefined);
  assert.equal(r.hm.bridgeHookFor('teams', 'main'), undefined, 'the hook went with it');
  assert.equal(await r.ms.deliver(r.ms.activity({ text: 'still there?' })), 404);
});
