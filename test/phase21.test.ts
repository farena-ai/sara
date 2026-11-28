// Phase 21: outfits, saved looks, and a whole character in one file.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { parseCharacter } from '../src/characterfile.ts';
import { LOOK_PATHS, LookBuilder } from '../src/look.ts';
import { EventHub } from '../src/events.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const jpeg = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]);
/** Grok Imagine stand-in: each picture says what it was asked for. */
const prompts: string[] = [];
const fakeImagine = async (_url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { prompt: string };
  prompts.push(body.prompt);
  return new Response(JSON.stringify({ data: [{ b64_json: jpeg(`img${prompts.length}`).toString('base64') }] }), { status: 200 });
};

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-24T12:00:00Z') };
const app = makeApp(dir, clock);
app.look = new LookBuilder({ dataDir: dir, key: async () => 'k', fetch: fakeImagine as never, parallel: 4 });
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') } as never);
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const call = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
  fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const until = async (ok: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 20));
};
const settled = () => until(async () => !['drafting', 'building'].includes((await (await call('/api/look')).json()).status.state));

test('outfits: a draft of the current look in new clothes; using it keeps the old look in Saved looks', async () => {
  // Starts from the built-in art.
  const v0 = await (await call('/api/look')).json();
  assert.equal(v0.custom, false);
  assert.ok(v0.outfits.some((o: { id: string }) => o.id === 'winter'));
  assert.equal((await call('/api/look/outfit', { outfit: '' })).status, 400);
  assert.equal((await call('/api/look/outfit', { outfit: 'winter' })).status, 202);
  await settled();
  assert.match(prompts.at(-1)!, /Only change the clothes.*winter coat and a knitted scarf/);
  assert.doesNotMatch(prompts.at(-1)!, /Keep everything identical: the same person, face, features, hair, clothes,/, 'clothes are allowed to change');
  assert.equal((await call('/api/look/build', { from: 'draft' })).status, 202);
  await settled();
  const v1 = await (await call('/api/look')).json();
  assert.equal(v1.custom, true);
  // T65: the new look is in the closet right away (as the current one); the built-in look never is.
  assert.equal(v1.saved.length, 1, 'only the new look: the built-in look is always there');
  assert.equal(v1.current, v1.saved[0].id);
  // Save it by name, then a second outfit: the first is kept.
  const saved = await (await call('/api/look/saved', { name: 'Winter' })).json();
  assert.equal(saved.saved.length, 1);
  assert.equal(saved.current, saved.saved[0].id);
  // Saving again renames instead of copying.
  assert.equal((await (await call('/api/look/saved', { name: 'Snow day' })).json()).saved[0].name, 'Snow day');
  await call('/api/look/outfit', { outfit: 'a green raincoat' });
  await settled();
  assert.match(prompts.at(-1)!, /a green raincoat/);
  const minor = await call('/api/look/outfit', { outfit: 'a school girl uniform' });
  assert.equal(minor.status, 400);
  assert.match((await minor.json()).error, /adult/);
  await call('/api/look/outfit', { outfit: 'summer' });
  await settled();
  await call('/api/look/build', { from: 'draft' });
  await settled();
  const v2 = await (await call('/api/look')).json();
  assert.equal(v2.saved.length, 2, 'the winter look was already saved: not saved twice; the summer look is listed too');
  assert.notEqual(v2.current, saved.saved[0].id, 'wearing the summer look');
  // Switch back: the unsaved summer look is saved first, so nothing is lost.
  const back = await (await call(`/api/look/saved/${saved.saved[0].id}/use`, {})).json();
  assert.equal(back.saved.length, 2);
  assert.equal(back.current, saved.saved[0].id);
  assert.match(back.saved.find((s: { id: string }) => s.id !== back.current).name, /^Look from 2026-/);
  assert.equal((await call(`/api/look/saved/${back.current}.jpg`)).status, 200);
  assert.equal((await call('/api/look/saved/zzzzzzzzzzzz/use', {})).status, 404);
  // The default-look button keeps the custom look in Saved looks.
  await call('/api/look', undefined, 'DELETE');
  const v3 = await (await call('/api/look')).json();
  assert.equal(v3.custom, false);
  assert.equal(v3.saved.length, 2);
  const other = v3.saved.find((s: { id: string; name: string }) => s.name !== 'Snow day');
  assert.equal((await call(`/api/look/saved/${other.id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await (await call('/api/look')).json()).saved.length, 1);
});

test('character file: export and load name, personality, look and voice choice; no keys; adults only', async () => {
  await call(`/api/look/saved/${(await (await call('/api/look')).json()).saved[0].id}/use`, {});
  app.settings.update({ voice: { tts: 'xai', xai: { voiceId: 'ara', language: 'en' }, openai: { baseUrl: 'https://api.openai.com/v1', sttModel: 'a', ttsModel: 'b', ttsVoice: 'nova' } } as never });
  app.vault.set('voice:xai', 'secret-key-123');
  const res = await call('/api/character/export');
  assert.match(res.headers.get('content-disposition')!, /\.sara-character\.json"/);
  const text = await res.text();
  assert.doesNotMatch(text, /secret-key-123|api\.openai\.com/, 'no keys or server addresses');
  const file = JSON.parse(text);
  assert.equal(file.format, 'sara-character');
  assert.equal(file.persona.name, app.persona.name);
  assert.equal(file.voice.xaiVoice, 'ara');
  assert.ok(Object.keys(file.look).length >= 16);
  assert.ok(Object.keys(file.look).every((k) => LOOK_PATHS.includes(k)));

  // Load a different character on top.
  const other = { ...file, persona: { ...file.persona, name: 'Juniper', summary: 'A calm gardener.' }, voice: { ...file.voice, xaiVoice: 'eve' } };
  other.look = { ...file.look, 'sara-portrait.jpg': jpeg('juniper').toString('base64') };
  const before = (await (await call('/api/look')).json()).saved.length;
  const r = await (await call('/api/character/import', { file: other, look: true, voice: false })).json();
  assert.deepEqual([r.persona.name, r.look, r.voice], ['Juniper', true, false]);
  assert.equal(app.persona.name, 'Juniper');
  assert.equal(app.settings.get().voice?.xai?.voiceId, 'ara', 'voice left alone when unticked');
  assert.deepEqual(readFileSync(join(dir, 'look', 'sara-portrait.jpg')), jpeg('juniper'));
  assert.equal((await (await call('/api/look')).json()).saved.length, before + 1, 'the previous look was already saved; the loaded one is listed as current');
  await call('/api/character/import', { file: other, look: false, voice: true });
  assert.equal(app.settings.get().voice?.xai?.voiceId, 'eve');
  assert.equal(app.vault.get('voice:xai'), 'secret-key-123');

  // Checked completely before anything changes.
  const bad = async (f: unknown, re: RegExp) => {
    const x = await call('/api/character/import', { file: f });
    assert.equal(x.status, 400);
    assert.match((await x.json()).error, re);
  };
  await bad({ hello: 1 }, /isn't a Sara character file/);
  await bad({ ...file, version: 2 }, /newer Sara/);
  await bad({ ...file, persona: { ...file.persona, age: 16 } }, /adult/);
  await bad({ ...file, persona: { ...file.persona, appearance: 'a teen with braces' } }, /adult/);
  await bad({ ...file, look: { '../../etc/passwd': jpeg('x').toString('base64') } }, /Unexpected picture/);
  await bad({ ...file, look: { 'sara-portrait.jpg': Buffer.from('<script>').toString('base64') } }, /damaged/);
  assert.equal(app.persona.name, 'Juniper', 'nothing changed by the bad files');
  assert.throws(() => parseCharacter({ ...file, look: { 'sara-avatar.jpg': file.look['sara-avatar.jpg'] } }), /no portrait/);
});

test('character file: her "Starts conversations" dial comes along (settings.proactive follows it)', async () => {
  const file = await (await call('/api/character/export')).json();
  const was = file.persona.traits?.initiative;
  const want = was === 10 ? 0 : 10;
  const next = { ...file, persona: { ...file.persona, traits: { ...(file.persona.traits ?? {}), initiative: want } } };
  const r = await call('/api/character/import', { file: next, look: false, voice: false });
  assert.equal(r.status, 200);
  assert.equal(app.persona.traits?.initiative, want);
  assert.deepEqual(
    { maxPerDay: app.settings.get().proactive?.maxPerDay, minGapHours: app.settings.get().proactive?.minGapHours },
    want === 10 ? { maxPerDay: 4, minGapHours: 3 } : { maxPerDay: 1, minGapHours: 24 },
  );
  assert.equal(JSON.parse(readFileSync(join(dir, 'persona.json'), 'utf8')).traits.initiative, want, 'saved to persona.json');
});

test('saved looks are kept out of the static files and need the owner', async () => {
  const id = (await (await call('/api/look')).json()).saved[0].id;
  assert.equal((await fetch(`${base}/api/look/saved/${id}.jpg`)).status, 401);
  assert.ok(existsSync(join(dir, 'looks', id, 'look.json')));
});

test('a finished new look is announced to open windows and replaces an older uploaded picture', async () => {
  app.events = new EventHub();
  const seen: string[] = [];
  const off = app.events.subscribe((e) => seen.push(e.type));
  try {
    // An earlier upload would otherwise keep showing instead of the new look.
    writeFileSync(join(dir, 'avatar.jpg'), jpeg('uploaded'));
    await call('/api/look/outfit', { outfit: 'winter' });
    await settled();
    assert.equal((await call('/api/look/build', { from: 'draft' })).status, 202);
    await settled();
    await until(async () => seen.includes('look'));
    assert.ok(seen.includes('look'), `events: ${seen.join(',')}`);
    assert.equal(existsSync(join(dir, 'avatar.jpg')), false, 'the uploaded picture is replaced by the new look');
  } finally {
    off();
  }
});
