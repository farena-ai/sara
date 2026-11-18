// V2.3 (docs/design/V2HOME.md): Home Assistant in one click, scenes by voice.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { test, type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { decodeMdns, discoverHome, mdnsQuery, setHomeDiscoverDeps } from '../src/home-discover.ts';
import { homeTapOnly, matchSpoken, voicePickable } from '../src/home-voice.ts';
import { voiceMayApprove } from '../src/phone-actions.ts';
import { createSaraServer } from '../src/server.ts';
import { HOME_VAULT } from '../src/tools/home.ts';
import { haAnswer, startFakeHa } from './fixtures/fake-ha.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

registerHooks({ resolve: (spec, ctx, next) => (spec === './identity.js' ? next(new URL('../src/identity.ts', import.meta.url).href, ctx) : next(spec, ctx)) });

async function serve(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-18T20:00:00Z') });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: '2026-11-18T19:00:00Z' });
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') } as never);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const ha = await startFakeHa();
  setHomeDiscoverDeps({ to: { host: '127.0.0.1', port: ha.mdnsPort }, timeoutMs: 600 });
  t.after(async () => {
    setHomeDiscoverDeps();
    await ha.close();
    await new Promise<void>((r) => server.close(() => r()));
    app.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { app, call, ha };
}

async function turn(app: ReturnType<typeof makeApp>, words: string, opts: Record<string, unknown>) {
  const conv = app.store.createConversation({ title: 'Talk' });
  let said = '';
  for await (const ev of runTurn(app, conv.id, words, new AbortController().signal, opts as never)) if (ev.type === 'token') said += ev.text;
  return said;
}

test('V2.3 mDNS: the question asks for Home Assistant; a real answer decodes to an address, name and version', () => {
  const q = mdnsQuery(7);
  assert.equal(q.readUInt16BE(0), 7);
  assert.equal(q.readUInt16BE(4), 1, 'one question');
  assert.ok(q.includes(Buffer.from('_home-assistant')), 'asks for _home-assistant._tcp.local');
  assert.equal(q.readUInt16BE(q.length - 2), 0x8001, 'asks for a unicast reply');
  const found = decodeMdns(haAnswer(7, { instance: 'Our House', ip: '192.168.1.20', port: 8123, txt: { location_name: 'Our House', version: '2026.11.1', internal_url: 'http://homeassistant.local:8123' } }));
  assert.deepEqual(found, [{ url: 'http://192.168.1.20:8123', name: 'Our House', version: '2026.11.1', alt: 'http://homeassistant.local:8123' }]);
  assert.deepEqual(decodeMdns(Buffer.from([1, 2, 3])), [], 'garbage is nothing, not a throw');
});

test('V2.3 discover: the fake Home Assistant on the network is found in one question', async (t) => {
  const ha = await startFakeHa({ locationName: 'Test Home' });
  t.after(() => ha.close());
  const found = await discoverHome({ to: { host: '127.0.0.1', port: ha.mdnsPort }, timeoutMs: 600 });
  assert.equal(found.length, 1);
  assert.equal(found[0].url, ha.url);
  assert.equal(found[0].name, 'Test Home');
  assert.deepEqual(ha.questions, ['_home-assistant._tcp.local']);
  assert.deepEqual(await discoverHome({ to: { host: '127.0.0.1', port: 9 }, timeoutMs: 200 }), [], 'nobody answering = none found');
});

test('V2.3 routes: found → test token (not saved) → save → scenes listed → a scene picked for voice', async (t) => {
  const { app, call, ha } = await serve(t);
  const d = await call('GET', '/home/discover');
  assert.equal(d.status, 200);
  assert.equal(d.json.found[0].url, ha.url);

  const bad = await call('POST', '/home/test', { url: ha.url, token: 'wrong-token-but-long-enough-xx' });
  assert.equal(bad.json.ok, false);
  assert.match(bad.json.error, /refused the token/);
  const good = await call('POST', '/home/test', { url: ha.url, token: ha.token });
  assert.equal(good.json.ok, true);
  assert.equal(good.json.name, 'Test Home');
  assert.equal(good.json.scenes, 3);
  assert.equal(good.json.scripts, 2);
  assert.equal(app.vault.get(HOME_VAULT), undefined, 'testing saves nothing');
  assert.equal(app.settings.get().home, undefined);

  assert.equal((await call('PUT', '/home', { url: ha.url, token: ha.token })).status, 200);
  const saved = await call('POST', '/home/test', { url: ha.url });
  assert.equal(saved.json.ok, true, 'an empty token tests the saved one');

  const v = await call('GET', '/home/voice');
  assert.equal(v.status, 200);
  const movie = v.json.items.find((x: any) => x.id === 'scene.movie_night');
  assert.deepEqual({ say: movie.say, on: movie.on, pickable: movie.pickable }, { say: 'Movie night', on: false, pickable: true });
  const lock = v.json.items.find((x: any) => x.id === 'scene.unlock_front_door');
  assert.equal(lock.pickable, false, 'a lock scene is never offered for voice');
  assert.ok(!v.json.items.some((x: any) => x.id.startsWith('light.')), 'only scenes and scripts');

  const put = await call('PUT', '/home/voice', { items: [{ id: 'scene.movie_night', say: 'Movie night' }, { id: 'script.bedtime', say: 'Good night' }] });
  assert.equal(put.status, 200);
  assert.deepEqual(app.settings.get().home?.voice, [{ id: 'scene.movie_night', say: 'Movie night' }, { id: 'script.bedtime', say: 'Good night' }]);
  const refuse = await call('PUT', '/home/voice', { items: [{ id: 'script.disarm_alarm', say: 'Disarm' }] });
  assert.equal(refuse.status, 400, 'alarms and locks are refused');
  assert.equal((await call('PUT', '/home', { url: ha.url })).status, 200);
  assert.equal(app.settings.get().home?.voice?.length, 2, 'saving the address again keeps the voice list');
});

test('V2.3 voice: a spoken "Hey Sara, movie night" runs the scene at once (no model call); typed words do not', async (t) => {
  const { app, call, ha } = await serve(t);
  await call('PUT', '/home', { url: ha.url, token: ha.token });
  await call('PUT', '/home/voice', { items: [{ id: 'scene.movie_night', say: 'Movie night' }, { id: 'script.bedtime', say: 'Good night' }] });
  const before = app.providerCalls;
  const said = await turn(app, 'Hey Sara, movie night.', { talk: true });
  assert.match(said, /Movie night is on/);
  assert.equal(app.providerCalls, before, 'no model call');
  assert.deepEqual(ha.calls.at(-1), { path: '/api/services/scene/turn_on', body: { entity_id: 'scene.movie_night' } });
  assert.match(await turn(app, 'good night please', { car: true }), /Good night is on/);
  assert.equal(ha.calls.at(-1)?.path, '/api/services/script/turn_on');

  const n = ha.calls.length;
  app.script.push(text('Sounds fun!'));
  assert.equal(await turn(app, 'movie night', {}), 'Sounds fun!', 'typed text goes to her as usual');
  app.script.push(text('Okay.'));
  await turn(app, 'what should we watch on movie night tonight', { talk: true });
  assert.equal(ha.calls.length, n, 'a sentence that only mentions it runs nothing');
});

test('V2.3 matching, picking and the tap-only rule for locks and alarms', () => {
  const list = [{ id: 'scene.movie_night', say: 'Movie night' }, { id: 'scene.cafe', say: 'Café time' }];
  for (const s of ['movie night', 'Hey Sara, movie night!', 'start movie night', 'run movie night please', 'okay sara turn on movie night', 'Movie Night.']) assert.equal(matchSpoken(s, list)?.id, 'scene.movie_night', s);
  assert.equal(matchSpoken('cafe time', list)?.id, 'scene.cafe', 'accents fold');
  for (const s of ['is it movie night', 'movie night was great', 'night', '']) assert.equal(matchSpoken(s, list), undefined, s);
  assert.equal(voicePickable('scene.movie_night', 'Movie night'), true);
  assert.equal(voicePickable('scene.unlock_front_door', 'Unlock front door'), false);
  assert.equal(voicePickable('script.x', 'Disarm alarm'), false);
  assert.equal(voicePickable('light.kitchen', 'Kitchen'), false, 'only scenes and scripts');

  assert.equal(homeTapOnly({ name: 'home_control', args: { entity_id: 'lock.front_door', action: 'unlock' } }), true);
  assert.equal(homeTapOnly({ name: 'home_control', args: { entity_id: 'alarm_control_panel.home', action: 'turn_off' } }), true);
  assert.equal(homeTapOnly({ name: 'home_control', args: { entity_id: 'script.disarm_alarm', action: 'run' } }), true);
  assert.equal(homeTapOnly({ name: 'home_control', args: { entity_id: 'light.kitchen', action: 'turn_on' } }), false);
  assert.equal(voiceMayApprove({ name: 'home_control', args: { entity_id: 'lock.front_door', action: 'unlock' } } as never), false, 'a spoken yes never unlocks');
  assert.equal(voiceMayApprove({ name: 'home_control', args: { entity_id: 'light.kitchen', action: 'turn_on' } } as never), true);
});

test('V2.3 web: talk.js mirrors the tap-only rule; the page has Find, Test token and Say it to start', async () => {
  // @ts-expect-error plain browser JavaScript, no types
  const talk = (await import('../web/talk.js')) as Record<string, any>;
  for (const ev of [{ name: 'home_control', args: { entity_id: 'lock.front_door', action: 'unlock' } }, { name: 'home_control', args: { entity_id: 'light.kitchen', action: 'turn_on' } }, { name: 'home_control', args: { entity_id: 'cover.garage_door', action: 'open' } }]) {
    assert.equal(talk.voiceMayAnswer(ev), voiceMayApprove(ev as never), JSON.stringify(ev));
  }
  const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
  for (const id of ['ha-find', 'ha-test', 'ha-voice-list', 'ha-voice-save']) assert.match(html, new RegExp(`id="${id}"`), id);
});
