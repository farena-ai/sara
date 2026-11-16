// Phase 36: avatar studio (closet, scenarios, dressing automatically, face lock, one change at a time,
// places, new expressions, pictures that match what she wears, adults-only looks).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { expressionFor, leansPlayful } from '../src/inner.ts';
import { isAdultOutfit, LookBuilder, olderExpression } from '../src/look.ts';
import { createPhotoTools } from '../src/photos.ts';
import { createSaraServer } from '../src/server.ts';
import { activeScenarios, cleanWardrobe, createWardrobeTool, DEFAULT_WARDROBE, pickLook, WardrobeWorker } from '../src/wardrobe.ts';
import { makeApp, ROOT, tempDir, text } from './helpers.ts';

const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(tag)]);
const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-26T15:00:00Z') }; // Monday 10:00 in Chicago
const app = makeApp(dir, clock);
const calls: { path: string; prompt: string; images: number }[] = [];
const fake = async (url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { prompt: string; image?: unknown; images?: unknown[] };
  calls.push({ path: new URL(url).pathname, prompt: body.prompt, images: body.images?.length ?? (body.image ? 1 : 0) });
  return new Response(JSON.stringify({ data: [{ b64_json: png(`img${calls.length}`).toString('base64') }] }));
};
app.look = new LookBuilder({ dataDir: dir, key: async () => 'tok', fetch: fake as never, faceLock: () => app.settings.get().faceLock !== false, parallel: 8 });
app.wardrobe = new WardrobeWorker(app, (async () => new Response('{}')) as never);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago', disclosureAcceptedAt: clock.now.toISOString() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const call = (path: string, method = 'GET', body?: unknown, ua?: string) =>
  fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(ua ? { 'user-agent': ua } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
const waitIdle = async () => {
  for (let i = 0; i < 200 && ['drafting', 'building'].includes(app.look!.status.state); i++) await new Promise((r) => setTimeout(r, 10));
};

test('scenarios: time, day, weather, holidays, own dates and a picked one, most specific first', () => {
  const w = { ...DEFAULT_WARDROBE, custom: [{ id: 'own-beach-trip', label: 'Beach trip', from: '07-01', to: '07-14' }] };
  const at = (iso: string) => activeScenarios(new Date(iso), 'America/Chicago', w);
  assert.deepEqual(at('2026-10-26T15:00:00Z'), ['halloween', 'work', 'home'], 'Monday 10:00, Halloween week');
  assert.deepEqual(at('2026-11-06T01:00:00Z'), ['home'], 'Thursday 19:00: at home');
  assert.deepEqual(at('2026-11-07T01:00:00Z'), ['out', 'home'], 'Friday 19:00');
  assert.deepEqual(at('2026-11-08T06:00:00Z'), ['sleep', 'home'], 'midnight');
  assert.deepEqual(at('2026-07-04T17:00:00Z'), ['own-beach-trip', 'home'], 'own dates (a Saturday)');
  assert.deepEqual(at('2026-12-24T18:00:00Z'), ['winter-holidays', 'work', 'home']);
  assert.deepEqual(activeScenarios(new Date('2026-11-04T18:00:00Z'), 'America/Chicago', w, { tempC: 3, code: 61 }), ['rain', 'cold', 'work', 'home']);
  assert.deepEqual(activeScenarios(new Date('2026-11-04T18:00:00Z'), 'America/Chicago', { ...w, manual: { scenario: 'date', until: '2026-11-04T20:00:00Z' } })[0], 'date');
  assert.throws(() => cleanWardrobe({ custom: [{ id: '', label: 'x', from: '7-1', to: '07-14' }] }, DEFAULT_WARDROBE), /month-day/);
  assert.equal(cleanWardrobe({ custom: [{ id: 'work', label: 'Game night' }] }, DEFAULT_WARDROBE).custom[0].id, 'own-game-night', 'own ids never clash with built-ins');
});

test('pickLook: the first scenario with a look wins; adults-only looks only with Adult mode', () => {
  const saved = [
    { id: 'a', name: 'Office', savedAt: '', scenarios: ['work'] },
    { id: 'b', name: 'Cozy', savedAt: '', scenarios: ['home', 'sleep'] },
    { id: 'c', name: 'Night in', savedAt: '', scenarios: ['sleep'], adult: true },
  ];
  assert.equal(pickLook(saved, ['halloween', 'work', 'home'], false)?.look.name, 'Office');
  assert.equal(pickLook(saved, ['sleep', 'home'], false)?.look.name, 'Cozy');
  assert.equal(pickLook(saved, ['sleep', 'home'], true)?.look.name, 'Cozy', 'saved order breaks ties');
  assert.equal(pickLook([saved[2], saved[1]], ['sleep'], true)?.look.name, 'Night in');
  assert.equal(pickLook([saved[2]], ['sleep'], false), undefined);
  assert.ok(isAdultOutfit('black lingerie') && !isAdultOutfit('a cozy sweater'));
});

test('new look → face locked; outfits, places and one-change edits send the locked face; meta travels with the look', async () => {
  await app.look!.draft('a woman in her 30s with long dark hair', 'illustrated');
  await app.look!.build(app.look!.draftBytes()!);
  assert.ok(existsSync(app.look!.faceFile), 'face locked from the first picture');
  const face = readFileSync(app.look!.faceFile);
  assert.equal(app.look!.missingFrames().length, 0, 'hurt and playful made too');
  assert.ok(existsSync(join(dir, 'look', 'sara', 'portrait-hurt.jpg')) && existsSync(join(dir, 'look', 'sara', 'frames', 'playful-ee.jpg')));
  const n = calls.length;
  // Outfit + place via the server.
  let r = await call('/api/look/outfit', 'POST', { outfit: 'work', place: 'office' });
  assert.equal(r.status, 202);
  await waitIdle();
  const c = calls[n];
  assert.equal(c.images, 2, 'the locked face goes along');
  assert.match(c.prompt, /Only change the clothes and the background \(a bright modern office/);
  assert.match(c.prompt, /face in the second picture/);
  assert.match(app.look!.draftMeta().wear ?? '', /smart for work/);
  assert.equal(app.look!.draftMeta().place, 'office');
  r = await call('/api/look/build', 'POST', {});
  assert.equal(r.status, 202);
  await waitIdle();
  assert.equal(app.look!.status.state, 'done');
  assert.deepEqual(readFileSync(app.look!.faceFile), face, 'an outfit never replaces the locked face');
  assert.equal(app.look!.currentMeta().place, 'office');
  // One change at a time.
  r = await call('/api/look/tweak', 'POST', { part: 'glasses', value: 'round glasses' });
  assert.equal(r.status, 202);
  await waitIdle();
  assert.match(calls.at(-1)!.prompt, /Only change glasses: round glasses/);
  assert.equal(calls.at(-1)!.images, 2);
  assert.equal((await call('/api/look/tweak', 'POST', { part: 'tail', value: 'x' })).status, 400);
  // Face lock off: one picture only.
  await call('/api/look/face-lock', 'PUT', { on: false });
  await call('/api/look/place', 'POST', { place: 'beach' });
  await waitIdle();
  assert.equal(calls.at(-1)!.images, 1);
  await call('/api/look/face-lock', 'PUT', { on: true });
});

test('closet: tag looks, dress automatically, her own change, and she knows what she wears', async () => {
  const look = app.look!;
  // Current look is "Office" (from the last test, built from the draft). Save it, make two more.
  look.save('Office', clock.now);
  const office = look.currentSavedId()!;
  await call(`/api/look/saved/${office}/meta`, 'PUT', { scenarios: ['work'] });
  await look.outfit(readFileSync(look.fileFor('sara-portrait.jpg')!), 'cozy', { place: 'room' });
  await look.build(look.draftBytes()!);
  look.save('Cozy', clock.now);
  const cozy = look.currentSavedId()!;
  look.setMeta(cozy, { scenarios: ['home', 'sleep'] });
  await look.outfit(readFileSync(look.fileFor('sara-portrait.jpg')!), 'date', { place: 'city' });
  await look.build(look.draftBytes()!);
  look.save('Date night', clock.now);
  const date = look.currentSavedId()!;
  look.setMeta(date, { scenarios: ['date'] });
  // Off: nothing changes.
  assert.equal(await app.wardrobe!.tick(), undefined);
  // On: Monday 10:00 → Office.
  let v = await (await call('/api/look/wardrobe', 'PUT', { auto: true })).json();
  assert.equal(v.current, office);
  assert.deepEqual(v.active, ['halloween', 'work', 'home']);
  assert.equal(v.pick.name, 'Office');
  // Evening (not Fri/Sat) → home → Cozy.
  clock.now = new Date('2026-10-27T01:00:00Z');
  assert.equal(await app.wardrobe!.tick(), 'Cozy');
  // She changes herself: date night for 4 hours.
  const tool = createWardrobeTool(() => app);
  const out = await tool.run({ scenario: 'date' }, { signal: new AbortController().signal } as never);
  assert.match(String(out), /"Date night" look/);
  assert.equal(look.currentSavedId(), date);
  assert.equal(await app.wardrobe!.tick(), undefined, 'the picked scenario holds');
  // She knows what she's wearing.
  const conv = app.store.createConversation();
  app.script.push(text('A little dressed up tonight.'));
  for await (const _ of runTurn(app, conv.id, 'what are you wearing?')) void _;
  const sys = String(app.requests.at(-1)!.messages[0].content);
  assert.match(sys, /In your picture right now you're wearing date night \(a stylish date-night outfit/);
  assert.match(sys, /you're at the city at night \(your "Date night" look\)/);
  // After it ends, back to the time of day.
  clock.now = new Date('2026-10-27T06:00:00Z');
  assert.equal(await app.wardrobe!.tick(), 'Cozy', 'midnight → sleep → Cozy');
  // Unknown scenario / look names are plain errors for her.
  await assert.rejects(tool.run({ look: 'Spacesuit' }, {} as never), /No saved look called "Spacesuit"/);
  // A look saved before Phase 36 shows the nearest older expression.
  assert.equal(olderExpression('sara/frames/hurt-talk.jpg'), 'sara/frames/caring-talk.jpg');
  rmSync(join(dir, 'look', 'sara', 'portrait-hurt.jpg'));
  assert.equal(look.fileFor('sara/portrait-hurt.jpg'), join(dir, 'look', 'sara', 'portrait-caring.jpg'));
  await look.complete();
  assert.ok(existsSync(join(dir, 'look', 'sara', 'portrait-hurt.jpg')), 'complete() makes the missing expression');
  await call('/api/look/wardrobe', 'PUT', { auto: false });
});

test('adults-only looks: need Adult mode, never listed in the apps, and she changes out when it goes off', async () => {
  const look = app.look!;
  assert.equal((await call('/api/look/outfit', 'POST', { outfit: 'black lace lingerie' })).status, 400);
  app.settings.update({ adultMode: { on: true, confirmedAt: clock.now.toISOString() } });
  assert.equal((await call('/api/look/outfit', 'POST', { outfit: 'black lace lingerie' }, 'Mozilla/5.0 SaraPhone/1')).status, 400, 'not from the phone app');
  assert.equal((await call('/api/look/outfit', 'POST', { outfit: 'black lace lingerie', place: 'bedroom' })).status, 202);
  await waitIdle();
  assert.equal(look.draftMeta().adult, true);
  await call('/api/look/build', 'POST', {});
  await waitIdle();
  look.save('Night in', clock.now);
  const adultId = look.currentSavedId()!;
  assert.equal(look.saved().find((s) => s.id === adultId)?.adult, true);
  assert.ok((await (await call('/api/look')).json()).saved.some((s: { id: string }) => s.id === adultId));
  assert.ok(!(await (await call('/api/look', 'GET', undefined, 'SaraPhone/1 (iPhone)')).json()).saved.some((s: { id: string }) => s.id === adultId), 'hidden in the phone apps');
  assert.ok((await (await call('/api/look', 'GET', undefined, 'SaraDesktop/1 (Windows)')).json()).saved.some((s: { id: string }) => s.id === adultId), 'the desktop apps list it like a browser');
  // Adult mode off → she changes into a non-adult look by herself, and the look can't be worn.
  app.settings.update({ adultMode: { on: false } });
  const to = await app.wardrobe!.tick();
  assert.ok(to && to !== 'Night in');
  assert.ok(!look.currentMeta().adult);
  assert.equal((await call(`/api/look/saved/${adultId}/use`, 'POST', {})).status, 404);
  assert.ok(!(await (await call('/api/look')).json()).saved.some((s: { id: string }) => s.id === adultId));
});

test('pictures she sends: her current outfit and place, her locked face, her own expressions', async () => {
  const sent: { prompt: string; images?: unknown[] }[] = [];
  const jpeg = readFileSync(join(ROOT, 'web', 'sara', 'portrait-caring.jpg'));
  const tools = createPhotoTools({
    webDir: join(ROOT, 'web'),
    uploads: app.uploads!,
    settings: app.settings,
    vault: app.vault,
    xaiProviderKey: () => 'k',
    customPortrait: () => undefined,
    lookFile: (rel) => app.look!.fileFor(rel),
    wearing: () => ({ wear: 'a cozy sweater', place: 'her cozy room at home' }),
    faceRef: () => app.look!.faceRef(),
    fetch: (async (_u: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ data: [{ b64_json: jpeg.toString('base64') }] }));
    }) as never,
  });
  app.settings.update({ photos: { mode: 'new' } });
  const take = tools.find((t) => t.spec.name === 'take_photo')!;
  let attached = '';
  await take.run({ scene: 'reading on the sofa' }, { attachImage: (id: string) => (attached = id) } as never);
  assert.match(sent[0].prompt, /Unless the scene says otherwise, she is wearing a cozy sweater and is at her cozy room at home/);
  assert.equal(sent[0].images?.length, 2, 'her look + her locked face');
  assert.ok(attached);
  const share = tools.find((t) => t.spec.name === 'share_photo')!;
  writeFileSync(join(dir, 'look', 'sara', 'portrait-playful.jpg'), jpeg);
  await share.run({ picture: 'playful' }, { attachImage: (id: string) => (attached = id) } as never);
  assert.ok(app.uploads!.get(attached), "her own look's playful picture");
});

test('expressions: hurt after a fight, playful when she leans playful and is happy', () => {
  const st = { valence: 0.7, closeness: 0.5, concern: 0, irritation: 0, tension: 0, tensionAbout: null, tensionAt: null, causes: [], updatedAt: '', lastOwnerAt: null, lastProactiveAt: null, proactiveDay: null, proactiveCount: 0 };
  const noon = new Date('2026-10-26T17:00:00Z');
  assert.equal(expressionFor(st, noon, 'America/Chicago', leansPlayful({ teasing: 8 })), 'playful');
  assert.equal(expressionFor(st, noon, 'America/Chicago', leansPlayful({ teasing: 5 })), 'happy');
  assert.equal(expressionFor({ ...st, tension: 0.6 }, noon, 'America/Chicago'), 'hurt');
});

test('exit check: 5 outfits switch by themselves across scenarios (time, day, weather)', async () => {
  const { dir: d2, cleanup: c2 } = tempDir();
  try {
    const clock2 = { now: new Date('2026-11-02T16:00:00Z') };
    const app2 = makeApp(d2, clock2);
    app2.settings.update({ timeZone: 'America/Chicago', briefing: { place: { name: 'Chicago', lat: 41.9, lon: -87.6 } }, wardrobe: { auto: true } });
    app2.look = new LookBuilder({ dataDir: d2, key: async () => 'tok', fetch: fake as never, parallel: 8 });
    let rain = false;
    app2.wardrobe = new WardrobeWorker(app2, (async () => new Response(JSON.stringify({ current: { temperature_2m: 15, weather_code: rain ? 63 : 1 } }))) as never);
    const names: [string, string][] = [['Office', 'work'], ['Cozy', 'home'], ['Bed', 'sleep'], ['Night out', 'out'], ['Raincoat', 'rain']];
    for (const [name, sc] of names) {
      await app2.look.build(png(name), { wear: name.toLowerCase() });
      app2.look.save(name, clock2.now);
      app2.look.setMeta(app2.look.currentSavedId()!, { scenarios: [sc] });
    }
    const at = async (iso: string) => {
      clock2.now = new Date(iso);
      await app2.wardrobe!.tick();
      return app2.look!.saved().find((s) => s.id === app2.look!.currentSavedId())?.name;
    };
    assert.equal(await at('2026-11-02T16:00:00Z'), 'Office', 'Monday 10:00');
    assert.equal(await at('2026-11-03T02:00:00Z'), 'Cozy', 'Monday 20:00');
    assert.equal(await at('2026-11-03T08:00:00Z'), 'Bed', 'Tuesday 02:00');
    assert.equal(await at('2026-11-07T02:00:00Z'), 'Night out', 'Friday 20:00');
    rain = true;
    assert.equal(await at('2026-11-11T18:00:00Z'), 'Raincoat', 'Wednesday noon, raining (weather read hourly)');
    app2.store.close();
  } finally {
    // Windows sometimes holds the folder a moment longer; a leftover temp folder is harmless.
    try {
      c2();
    } catch {
      /* ignore */
    }
  }
});
