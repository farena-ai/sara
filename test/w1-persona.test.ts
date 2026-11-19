// W1.4: one personality drives her writing, voice and face. The persona store (persona.json, per
// companion / per household member) carries a `style` block; src/persona-style.ts resolves it, with
// her voice choice and the writing default, into one view that every surface reads: chat writing
// note (email drafts' sign-off), Speech (Talk, voice notes), briefing audio, the receptionist and
// her picture. These tests check each surface against the same source.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { exportCharacter } from '../src/characterfile.ts';
import { writingFor, writingNote } from '../src/humanize.ts';
import { validatePersona } from '../src/persona.ts';
import { cleanStyle, greetingKey, herVoice, personaStyle, previewOf, toneLine } from '../src/persona-style.ts';
import { receptionFor } from '../src/reception.ts';
import { createSaraServer } from '../src/server.ts';
import { Speech } from '../src/speech.ts';
import { savePersona } from '../src/studio.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function world(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-19T15:00:00Z') });
  app.settings.update({ ownerName: 'Alex', timeZone: 'UTC' } as never);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, dir };
}

test('W1.4 the persona file keeps a cleaned style block (sign-off, greeting style, face)', () => {
  const base = JSON.parse(read('persona/sara.json'));
  const p = validatePersona({ ...base, style: { signOff: '  Cheers,\n Alex ', greet: 'formal', face: 'portrait', junk: 1 } });
  assert.deepEqual(p.style, { signOff: 'Cheers,\nAlex', greet: 'formal', face: 'portrait' });
  assert.equal(validatePersona({ ...base, style: { greet: 'shouty', face: 'hologram' } }).style, undefined, 'unknown values dropped');
  assert.throws(() => validatePersona({ ...base, style: { signOff: 'x'.repeat(81) } }), /80/);
  assert.deepEqual(cleanStyle({ signOff: 'a\n\n\nb\nc' }), { signOff: 'a\nb' }, 'at most two lines');
});

test('W1.4 personaStyle: one view from the persona, her voice choice and the writing default', (t) => {
  const { app } = world(t);
  let s = personaStyle(app);
  assert.equal(s.name, app.persona.name);
  assert.equal(s.greet, 'warm', 'no way of talking picked: a warm greeting');
  assert.equal(s.humanizer, 'as-written');
  assert.equal(s.signOff, '');
  assert.equal(s.face, '');
  assert.equal(s.voice.speed, 1);
  app.settings.update({ voice: { tts: 'local', localVoice: 'piper:test', speed: 1.2 } } as never);
  writingFor(app).setStyle('natural');
  savePersona(app, validatePersona({ ...app.persona, talk: 'brief', style: { signOff: 'Best,', face: 'still' } }));
  s = personaStyle(app);
  assert.equal(s.greet, 'brief', 'a brief talker greets briefly');
  assert.deepEqual([s.voice.tts, s.voice.id, s.voice.speed], ['local', 'piper:test', 1.2]);
  assert.equal(s.humanizer, 'natural');
  assert.equal(s.signOff, 'Best,');
  assert.equal(s.face, 'still');
  assert.ok(s.textRules.length > 0 && s.textRules.length <= 4);
  assert.deepEqual(herVoice(app), s.voice);
});

test('W1.4 email drafts: the chat writing note carries her sign-off; nothing changes without one', (t) => {
  const { app } = world(t);
  assert.equal(writingNote(app), undefined, 'As written and no sign-off: no note (S11 unchanged)');
  savePersona(app, validatePersona({ ...app.persona, style: { signOff: 'Cheers,' } }));
  assert.match(writingNote(app) ?? '', /email drafts.*Cheers,/is);
  assert.doesNotMatch(writingNote(app) ?? '', /like a person/, 'as written stays as written');
  writingFor(app).setStyle('natural');
  assert.match(writingNote(app) ?? '', /like a person[\s\S]*Cheers,/);
});

test('W1.4 receptionist: greeting and tone follow her greeting style; his own greeting still wins', async (t) => {
  const { app } = world(t);
  const r = receptionFor(app);
  const T = (s: string, p: Record<string, string | number> = {}) => s.replace(/\{(\w+)\}/g, (_, k) => String(p[k] ?? ''));
  savePersona(app, validatePersona({ ...app.persona, style: { greet: 'formal' } }));
  let a = await r.ask('Hello', [], { lang: 'en', T });
  assert.equal(a.kind, 'greeting');
  assert.equal(a.reply, T(greetingKey('formal'), { name: r.business }));
  assert.match(r.prompt([], 'en'), new RegExp(toneLine('formal').replace(/[.]/g, '\\.')));
  savePersona(app, validatePersona({ ...app.persona, style: { greet: 'brief' } }));
  a = await r.ask('Hi', [], { lang: 'en', T });
  assert.equal(a.reply, T(greetingKey('brief'), { name: r.business }));
  r.store.save({ greeting: 'Welcome to the gutter shop!' });
  a = await r.ask('Hi', [], { lang: 'en', T });
  assert.equal(a.reply, 'Welcome to the gutter shop!');
});

test('W1.4 Talk / voice notes: Speech speaks with the voice and speed from the same source', async (t) => {
  const { app } = world(t);
  const said: { id?: string; speed?: number }[] = [];
  (app as unknown as { voice: unknown }).voice = { available: { tts: true, stt: false }, voices: () => [{ id: 'piper:test' }], speak: async (_t: string, id?: string, speed?: number) => (said.push({ id, speed }), { data: Buffer.from('RIFF'), type: 'audio/wav' }) };
  app.settings.update({ voice: { tts: 'local', localVoice: 'piper:test', speed: 1.1, followMood: false } } as never);
  await new Speech(app as never).speak('Hello there.');
  assert.deepEqual(said.at(-1), { id: herVoice(app).id, speed: herVoice(app).speed });
});

test('W1.4 preview: the same sentence as chat text, spoken voice, email line and receptionist greeting', (t) => {
  const { app } = world(t);
  savePersona(app, validatePersona({ ...app.persona, style: { signOff: 'Cheers,', greet: 'warm' } }));
  const p = previewOf(personaStyle(app), 'The plumber comes at 3.', { owner: 'Alex', business: 'Gutter Co' });
  assert.equal(p.chat, 'The plumber comes at 3.');
  assert.equal(p.spoken.text, 'The plumber comes at 3.');
  assert.match(p.email, /^The plumber comes at 3\.\n\nCheers,\nAlex$/);
  assert.equal(p.greeting.key, greetingKey('warm'));
  assert.equal(p.greeting.params.name, 'Gutter Co');
  assert.equal(p.greeting.then, 'The plumber comes at 3.');
});

test('W1.4 character file carries the style; routes read and save it (members use their own)', async (t) => {
  const { app, dir } = world(t);
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: RequestInit = {}) => fetch(`${origin}/api${path}`, { ...init, headers: { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json' } });
  savePersona(app, validatePersona({ ...app.persona, talk: 'texting' }));
  let r = await call('/persona/style');
  assert.equal(r.status, 200);
  let v = (await r.json()) as { style: { greet: string; signOff: string }; source: { greet: string } };
  assert.equal(v.style.greet, 'casual');
  assert.equal(v.source.greet, 'talk', 'the default comes from how she talks');
  r = await call('/persona/style', { method: 'PUT', body: JSON.stringify({ signOff: 'Warmly,', greet: 'formal', face: 'portrait', humanizer: 'natural' }) });
  assert.equal(r.status, 200);
  v = (await r.json()) as typeof v;
  assert.equal(v.style.signOff, 'Warmly,');
  assert.equal(app.persona.style?.greet, 'formal', 'saved in the persona file');
  assert.equal(writingFor(app).get().style, 'natural', 'humanizer level saved in the writing default (no second store)');
  assert.equal((await call('/persona/style', { method: 'PUT', body: JSON.stringify({ greet: 'shouty' }) })).status, 400);
  r = await call('/persona/style/preview', { method: 'POST', body: JSON.stringify({ sentence: 'See you at 6.' }) });
  const pv = (await r.json()) as { chat: string; email: string };
  assert.equal(pv.chat, 'See you at 6.');
  assert.match(pv.email, /Warmly,\nAlex$/);
  assert.deepEqual(exportCharacter(app as never).persona.style, { signOff: 'Warmly,', greet: 'formal', face: 'portrait' });
});

test('W1.4 every surface reads the one source (no surface keeps its own copy)', () => {
  for (const f of ['src/speech.ts', 'src/briefing-audio.ts', 'src/reception.ts', 'src/humanize.ts', 'src/routes/her.ts']) assert.match(read(f), /from '\.{1,2}\/persona-style\.ts'/, f);
  assert.doesNotMatch(read('src/briefing-audio.ts'), /v\.localVoice, v\.speed/, 'briefing voice comes from herVoice');
  // Her picture: a device with no pick of its own shows the persona's face.
  assert.match(read('web/v4-picture.js'), /dataset\.herFace/);
  assert.match(read('web/app.js'), /addEventListener\('sara-herface'/);
  const html = read('web/index.html');
  const sec = html.slice(html.indexOf('data-page="her-character"'), html.indexOf('data-page="her-relationship"'));
  for (const id of ['hca-sentence', 'hca-signoff', 'hca-greet', 'hca-face', 'hca-human', 'hca-chat', 'hca-email', 'hca-greeting', 'hca-say']) assert.match(sec, new RegExp(`id="${id}"`), id);
  assert.match(sec, /<h3>How \{name\} comes across|<h3[^>]*>How Sara comes across/);
  for (const id of ['hca-sentence', 'hca-signoff', 'hca-greet', 'hca-face', 'hca-human']) assert.match(sec, new RegExp(`class="tip" data-tip="[^"]+">\\?</button> <(input|select) id="${id}"`), `${id} has a tip`);
  assert.match(read('web/app.js'), /pick === 'her-character' && typeof loadComesAcross === 'function'/);
});
