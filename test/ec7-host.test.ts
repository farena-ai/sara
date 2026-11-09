// EC7 (docs/ops/EC7_DESIGN.md "Inbound"): the host side of the Teams bridge. Microsoft POSTs every
// activity to the bot's messaging endpoint, Sara's bridge hook of the new kind `botframework`; Sara
// checks the Bot Framework JWT (OpenID metadata → JWKS, RS256, issuer, audience = the App ID, time,
// the key's channel endorsement, the serviceUrl claim) before the plugin sees a byte.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { setPrivateLocal } from '../src/net-guard.ts';
import { BotFrameworkAuth, BF_ISSUER, serviceUrlAllowed } from '../src/plugins/botframework-auth.ts';
import { parseManifest, permissionLines } from '../src/plugins/manifest.ts';
import { HookManager } from '../src/webhooks.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const { BotSigner } = await import(pathToFileURL(join(ROOT, 'test', 'fixtures', 'teams', 'fake.mjs')).href);
const APP_ID = '11111111-2222-4333-8444-555555555555';
const SERVICE = 'https://smba.trafficmanager.net/amer/';
const activity = (o: Record<string, unknown> = {}) => ({ type: 'message', id: `a${Math.random().toString(36).slice(2)}`, channelId: 'msteams', serviceUrl: SERVICE, from: { id: '29:x', aadObjectId: 'aad' }, conversation: { id: 'a:1', conversationType: 'personal' }, recipient: { id: `28:${APP_ID}` }, text: 'hi', ...o });

async function signer(t: TestContext): Promise<{ s: Any; auth: (o?: Record<string, unknown>) => BotFrameworkAuth; fetches: () => number }> {
  const s = new BotSigner();
  const srv = await s.startOpenId();
  t.after(() => s.stopOpenId());
  return { s, auth: (o = {}) => new BotFrameworkAuth({ metadataUrl: srv.metadataUrl, ...o }), fetches: () => s.jwksFetches };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

test('EC7: a good Bot Framework token passes; every rule refuses its own way', async (t) => {
  const { s, auth } = await signer(t);
  const a = auth();
  const act = activity();
  const good = s.token({ aud: APP_ID, serviceUrl: SERVICE });
  assert.deepEqual(await a.check(`Bearer ${good}`, act, APP_ID), { ok: true });
  const no = async (header: string | undefined, why: RegExp, act2 = act) => {
    const r = await a.check(header, act2, APP_ID);
    assert.equal(r.ok, false, String(header).slice(0, 40));
    assert.match(String((r as { why: string }).why), why);
  };
  await no(undefined, /no Authorization/);
  await no(`Basic ${good}`, /no Authorization/);
  await no(`Bearer ${s.token({ aud: 'someone-else', serviceUrl: SERVICE })}`, /audience/);
  await no(`Bearer ${s.token({ aud: APP_ID, iss: 'https://evil.example', serviceUrl: SERVICE })}`, /issuer/);
  await no(`Bearer ${s.token({ aud: APP_ID, serviceUrl: SERVICE, exp: Math.floor(Date.now() / 1000) - 600 })}`, /expired/);
  await no(`Bearer ${s.token({ aud: APP_ID, serviceUrl: SERVICE, nbf: Math.floor(Date.now() / 1000) + 900 })}`, /expired/);
  await no(`Bearer ${s.token({ aud: APP_ID, serviceUrl: 'https://smba.trafficmanager.net/emea/' })}`, /serviceUrl/);
  await no(`Bearer ${s.token({ aud: APP_ID, serviceUrl: SERVICE }, { alg: 'HS256' })}`, /algorithm/);
  await no(`Bearer ${s.token({ aud: APP_ID, serviceUrl: SERVICE }, { forge: true })}`, /signature/);
  await no(`Bearer ${good.slice(0, -4)}`, /signature|token/);
  await no(`Bearer ${s.token({ aud: APP_ID, serviceUrl: SERVICE }, { kid: 'nobody' })}`, /unknown key/);
  // The key is endorsed for msteams only: an activity from another channel is refused.
  await no(`Bearer ${good}`, /endorse/, activity({ channelId: 'webchat' }));
  // An activity that says it comes from a connector Sara does not know.
  await no(`Bearer ${s.token({ aud: APP_ID, serviceUrl: 'https://evil.example/' })}`, /serviceUrl/, activity({ serviceUrl: 'https://evil.example/' }));
});

test('EC7: key rotation refetches the keys once; forged kids cannot hammer Microsoft', async (t) => {
  const { s, auth, fetches } = await signer(t);
  let now = Date.now();
  const a = auth({ now: () => now });
  assert.equal((await a.check(`Bearer ${s.token({ aud: APP_ID, serviceUrl: SERVICE })}`, activity(), APP_ID)).ok, true);
  const before = fetches();
  s.rotate();
  assert.equal((await a.check(`Bearer ${s.token({ aud: APP_ID, serviceUrl: SERVICE })}`, activity(), APP_ID)).ok, true, 'the new key is fetched');
  assert.equal(fetches(), before + 1);
  for (let i = 0; i < 5; i++) await a.check(`Bearer ${s.token({ aud: APP_ID, serviceUrl: SERVICE }, { kid: `forged${i}` })}`, activity(), APP_ID);
  assert.ok(fetches() <= before + 2, `at most one more fetch in 30 s (${fetches() - before})`);
  now += 31_000;
  await a.check(`Bearer ${s.token({ aud: APP_ID, serviceUrl: SERVICE }, { kid: 'forged-late' })}`, activity(), APP_ID);
  assert.ok(fetches() <= before + 3);
});

test('EC7: only the public Bot Connector address is a serviceUrl', () => {
  for (const ok of ['https://smba.trafficmanager.net/amer/', 'https://smba.trafficmanager.net/emea/', 'https://smba.trafficmanager.net/teams/']) assert.equal(serviceUrlAllowed(ok), true, ok);
  for (const bad of ['http://smba.trafficmanager.net/amer/', 'https://smba.trafficmanager.net.evil.com/', 'https://evil.trafficmanager.net/', 'https://user@smba.trafficmanager.net/', '', 'nonsense']) assert.equal(serviceUrlAllowed(bad), false, bad);
  assert.equal(BF_ISSUER, 'https://api.botframework.com');
});

test('EC7: a botframework bridge hook parses in the manifest and says so on the review card', () => {
  const base = { manifest: 1, id: 'chat-t', name: 'Chat T', version: '1.0.0', description: 'A chat app.', main: 'main.mjs' };
  const m = parseManifest(JSON.stringify({ ...base, permissions: { bridges: ['t'], webhooks: { bridge: ['botframework'] } } }), { saraVersion: '9.0.0' });
  assert.equal(m.permissions.webhooks, 'bridge');
  assert.deepEqual(m.permissions.webhookKinds, ['botframework']);
  assert.ok(permissionLines(m).some((l) => l.id === 'webhooks:botframework' && l.key === 'Receives messages from Microsoft Teams at a public web address Sara gives it (Sara checks Microsoft’s signature first)' && l.risk === 'high'));
  // Read back (the parsed form) means the same.
  const again = parseManifest(JSON.stringify({ ...base, permissions: { ...m.permissions } }), { saraVersion: '9.0.0' });
  assert.deepEqual(again.permissions.webhookKinds, ['botframework']);
  const k = 'Receives messages from Microsoft Teams at a public web address Sara gives it (Sara checks Microsoft’s signature first)';
  assert.ok(readFileSync(join(ROOT, 'web', 'plugins.js'), 'utf8').includes(`'${k}'`));
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) assert.ok((JSON.parse(readFileSync(join(ROOT, 'web', 'i18n', `${lang}.json`), 'utf8')) as Record<string, string>)[k], lang);
});

async function hookRig(t: TestContext, auth: BotFrameworkAuth): Promise<{ post: (body: unknown, headers?: Record<string, string>) => Promise<{ status: number; text: string }>; hm: HookManager; id: string }> {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  const hm = new HookManager({ db: app.store.db, vault: app.vault, scrub: (x) => x, botFramework: auth });
  hm.attach('main', app);
  const r = hm.ensureBridgeHook('teams', 'main', APP_ID, 'botframework');
  const server: Server = createServer((req, res) => void hm.receive(req, res, r.path.slice(6), '203.0.113.9'));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((ok) => server.close(() => ok()));
    app.store.close();
    cleanup();
  });
  const port = (server.address() as AddressInfo).port;
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/x`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  };
  return { post, hm, id: r.hook.id };
}

test('EC7: the hook refuses an unsigned or forged call (401, logged), and a good one reaches the plugin step', async (t) => {
  const { s, auth } = await signer(t);
  const { post, hm, id } = await hookRig(t, auth());
  assert.equal(hm.bridgeHookFor('teams', 'main')?.verify, 'botframework');
  assert.equal((await post(activity())).status, 401);
  assert.equal((await post(activity(), { authorization: `Bearer ${s.token({ aud: APP_ID, serviceUrl: SERVICE }, { forge: true })}` })).status, 401);
  assert.equal(hm.bridgeState(id).badSignatures, 2);
  // Signed: past the check; no plugin manager here, so "not now" (Teams tries again).
  const ok = await post(activity(), { authorization: `Bearer ${s.token({ aud: APP_ID, serviceUrl: SERVICE })}` });
  assert.equal(ok.status, 503, ok.text);
  // A meta handshake (GET) is not a thing for this kind.
  // Private local mode: nothing is fetched or read.
  setPrivateLocal(true);
  try {
    const before = s.jwksFetches + s.metadataFetches;
    assert.equal((await post(activity(), { authorization: `Bearer ${s.token({ aud: APP_ID, serviceUrl: SERVICE })}` })).status, 503);
    assert.equal(s.jwksFetches + s.metadataFetches, before);
  } finally {
    setPrivateLocal(false);
  }
});

test('EC7: the botframework kind is never offered for a hand-made webhook', async (t) => {
  const { auth } = await signer(t);
  const { hm } = await hookRig(t, auth());
  assert.equal(hm.create({ name: 'mine', verify: 'botframework' }).hook.verify, 'standard');
});
