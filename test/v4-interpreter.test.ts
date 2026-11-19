// V4.2 (docs/design/INTERPRETER.md): the live interpreter in Talk with Sara. Fake hearing (scripted
// words) and a fake voice translate both directions; the transcript is saved.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { cleanInterpPrefs, guessSide, INTERP_LANGS, InterpreterLog, translateTurn, voiceForLang } from '../src/interpreter.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

registerHooks({ resolve: (spec, ctx, next) => (spec === './identity.js' ? next(new URL('../src/identity.ts', import.meta.url).href, ctx) : next(spec, ctx)) });
// @ts-expect-error plain browser JavaScript, no types
const web = (await import('../web/interpreter.js')) as Record<string, any>;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function rigApp(dir: string, local = true): TestApp {
  const app = makeApp(dir, { now: new Date('2026-11-18T15:00:00Z') });
  app.settings.update({ providers: [{ id: 'p', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', local, defaultModel: 'fixture' }], defaultProviderId: 'p', defaultModel: 'fixture' } as never);
  return app;
}

test('guessSide: script and small words pick the side, else the hint, else the other side of the last turn', () => {
  assert.equal(guessSide('¿Dónde está la estación de tren, por favor?', 'en', 'es'), 'es');
  assert.equal(guessSide('Where is the train station, please?', 'en', 'es'), 'en');
  assert.equal(guessSide('駅はどこですか', 'en', 'ja'), 'ja');
  assert.equal(guessSide('Где вокзал?', 'ru', 'de'), 'ru');
  assert.equal(guessSide('Okay', 'en', 'es', { hint: 'es' }), 'es', 'unclear: the hint');
  assert.equal(guessSide('Okay', 'en', 'es', { last: 'en' }), 'es', 'unclear, no hint: the other person speaks next');
  assert.equal(guessSide('Okay', 'en', 'es'), 'en');
});

test('prefs: two different known languages, cloud off by default', () => {
  assert.deepEqual(cleanInterpPrefs({}), { a: 'en', b: 'es', cloud: false });
  assert.deepEqual(cleanInterpPrefs({ a: 'fr', b: 'ja', cloud: true }), { a: 'fr', b: 'ja', cloud: true });
  assert.deepEqual(cleanInterpPrefs({ a: 'xx', b: 'en' }), { a: 'en', b: 'es', cloud: false }, 'unknown → defaults');
  assert.equal(cleanInterpPrefs({ a: 'de', b: 'de' }).b !== 'de', true, 'never the same language twice');
  assert.ok(INTERP_LANGS.length >= 16 && INTERP_LANGS.includes('en') && INTERP_LANGS.includes('zh'));
});

test('voiceForLang: a local voice that names the language, else none', () => {
  const voices = [{ id: 'piper:en_US-hfc_female', label: 'English (US) female' }, { id: 'piper:es_ES-davefx', label: 'Dave (Spanish)' }, { id: 'kokoro:ff_siwis', label: 'Siwis — French' }];
  assert.equal(voiceForLang(voices, 'es'), 'piper:es_ES-davefx');
  assert.equal(voiceForLang(voices, 'fr'), 'kokoro:ff_siwis');
  assert.equal(voiceForLang(voices, 'en'), 'piper:en_US-hfc_female');
  assert.equal(voiceForLang(voices, 'ja'), undefined);
});

test('translateTurn: local model first, both directions, the words fenced as data, nothing in her chats', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = rigApp(dir);
  t.after(() => (app.store.close(), cleanup()));
  app.script.push(text('{"from":"es","text":"Where is the train station?"}'));
  const r1 = await translateTurn(app, '¿Dónde está la estación de tren?', { a: 'en', b: 'es', cloud: false });
  assert.deepEqual(r1, { ok: true, from: 'es', to: 'en', text: 'Where is the train station?' });
  const sys = String(app.requests[0].messages[0].content);
  assert.match(sys, /English/);
  assert.match(sys, /Spanish/);
  assert.match(String(app.requests[0].messages[1].content), /DATA-\w+ start[\s\S]*Dónde está/);
  app.script.push(text('Two blocks, then left.'));
  const r2 = await translateTurn(app, 'Two blocks down, then turn left.', { a: 'en', b: 'es', cloud: false }, { last: 'es' });
  // Not JSON: the reply is the translation, the side comes from the words.
  assert.equal(r2.from, 'en');
  assert.equal(r2.to, 'es');
  assert.equal(r2.ok && r2.text, 'Two blocks, then left.');
  assert.equal(app.store.listConversations().length, 0, 'no chat was made');
  // The model may correct the side.
  app.script.push(text('```json\n{"from":"en","text":"Gracias"}\n```'));
  const r3 = await translateTurn(app, 'Thanks', { a: 'en', b: 'es', cloud: false }, { hint: 'es' });
  assert.deepEqual(r3, { ok: true, from: 'en', to: 'es', text: 'Gracias' });
});

test('translateTurn: no model on this computer and cloud off → says why, no call', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = rigApp(dir, false);
  t.after(() => (app.store.close(), cleanup()));
  const r = await translateTurn(app, 'Hola, buenos días, ¿qué tal?', { a: 'en', b: 'es', cloud: false });
  assert.equal(r.ok, false);
  assert.equal(r.from, 'es');
  assert.match(!r.ok ? r.why : '', /model on this computer/);
  assert.equal(app.requests.length, 0, 'no model call');
  app.script.push(text('{"from":"es","text":"Hello, good morning"}'));
  const c = await translateTurn(app, 'Hola, buenos días, ¿qué tal?', { a: 'en', b: 'es', cloud: true });
  assert.equal(c.ok && c.text, 'Hello, good morning', 'cloud allowed: the quick route');
});

test('InterpreterLog: one file per session, newest first, plain-text export, delete', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  let now = Date.parse('2026-11-18T15:00:00Z');
  const log = new InterpreterLog(dir, () => new Date(now));
  const s = log.start('en', 'es');
  log.add(s.id, { from: 'es', to: 'en', said: 'Hola', text: 'Hello' });
  now += 5000;
  log.add(s.id, { from: 'en', to: 'es', said: 'Thanks', text: 'Gracias' });
  log.end(s.id);
  const s2 = log.start('fr', 'de');
  assert.deepEqual(log.list().map((x) => x.id), [s2.id, s.id]);
  assert.equal(log.list()[1].count, 2);
  const txt = log.text(s.id)!;
  assert.match(txt, /Hola\n\s+→ Hello/);
  assert.match(txt, /Thanks\n\s+→ Gracias/);
  assert.ok(existsSync(join(dir, 'interpreter', `${s.id}.json`)));
  assert.equal(log.get('../x'), undefined, 'ids are checked');
  assert.equal(log.remove(s.id), true);
  assert.equal(log.get(s.id), undefined);
});

async function rigServer(t: import('node:test').TestContext, member?: { voice: boolean }) {
  const { dir, cleanup } = tempDir();
  const app = rigApp(dir);
  const auth = new OwnerAuth(dir);
  const record = () => ({ id: 'm1', name: 'Kim', status: 'active', limits: { voice: member?.voice ?? true, pictures: false } });
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(member ? { spaceId: 'm1', member: { record, apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    app.store.close();
    cleanup();
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api/talk/interpret${path}`, { method, headers: { Origin: base, authorization: 'Bearer ' + auth.newToken, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, type, body: (type.includes('json') ? await res.json() : await res.text()) as any };
  };
  return { app, dir, call };
}

test('routes: prefs, a session in both directions with fake hearing + voice, the saved transcript', async (t) => {
  const { app, dir, call } = await rigServer(t);
  assert.equal((await call('PUT', '', { a: 'en', b: 'es', cloud: false })).status, 200);
  const g = await call('GET', '');
  assert.deepEqual(g.body.prefs, { a: 'en', b: 'es', cloud: false });
  assert.ok(g.body.langs.includes('ja'));
  const st = await call('POST', '/start', { a: 'en', b: 'es' });
  const id = st.body.session.id as string;
  app.script.push(text('{"from":"es","text":"Where is the station?"}'), text('{"from":"en","text":"Dos calles más."}'));
  const t1 = await call('POST', '/turn', { id, text: '¿Dónde está la estación?' });
  assert.equal(t1.status, 200);
  assert.deepEqual([t1.body.line.from, t1.body.line.to, t1.body.line.text], ['es', 'en', 'Where is the station?']);
  const t2 = await call('POST', '/turn', { id, text: 'Two more blocks.', hint: 'en' });
  assert.deepEqual([t2.body.line.from, t2.body.line.to, t2.body.line.text], ['en', 'es', 'Dos calles más.']);
  assert.equal((await call('POST', '/end', { id })).status, 200);
  const list = await call('GET', '');
  assert.equal(list.body.sessions[0].id, id);
  assert.equal(list.body.sessions[0].count, 2);
  const full = await call('GET', `/${id}`);
  assert.equal(full.body.session.lines.length, 2);
  assert.ok(full.body.session.endedAt);
  const txt = await call('GET', `/${id}/text`);
  assert.match(txt.type, /text\/plain/);
  assert.match(txt.body, /Dónde está[\s\S]*Where is the station\?[\s\S]*Two more blocks[\s\S]*Dos calles/);
  assert.ok(readdirSync(join(dir, 'interpreter')).includes(`${id}.json`));
  assert.equal((await call('POST', '/turn', { id: 'nope', text: 'x' })).status, 404);
  assert.equal((await call('POST', '/start', { a: 'en', b: 'en' })).status, 400);
  assert.equal((await call('DELETE', `/${id}`)).status, 200);
  assert.equal((await call('GET', `/${id}`)).status, 404);
  assert.equal(app.store.listConversations().length, 0, 'never a chat turn');
});

test('routes: a member whose voice is off gets 403', async (t) => {
  const { call } = await rigServer(t, { voice: false });
  assert.equal((await call('POST', '/start', { a: 'en', b: 'es' })).status, 403);
});

test('speak in a language: Speech.speak picks the language voice; the routes pass lang through', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = rigApp(dir);
  t.after(() => (app.store.close(), cleanup()));
  const said: string[] = [];
  app.voice = { available: { stt: true, tts: true }, voices: () => [{ id: 'piper:en_US-hfc_female', label: 'English' }, { id: 'piper:es_ES-davefx', label: 'Spanish' }], speak: async (_t: string, v: string) => (said.push(v), { data: Buffer.from('RIFF'), type: 'audio/wav' }) } as never;
  app.settings.update({ voice: { stt: 'local', tts: 'local', localVoice: 'piper:en_US-hfc_female' } } as never);
  const { speechOf } = await import('../src/speech.ts');
  await speechOf(app).speak('Hola', undefined, { lang: 'es' });
  await speechOf(app).speak('Hello', undefined, { lang: 'ja' });
  await speechOf(app).speak('Hello');
  assert.deepEqual(said, ['piper:es_ES-davefx', 'piper:en_US-hfc_female', 'piper:en_US-hfc_female']);
  assert.match(read('src/routes/voice.ts'), /lang: interpLang\(body\.lang\)/);
  assert.match(read('web/voice.js'), /this\.fetchAudio\(q\.text, q\.voice, q\.lang\)/);
  assert.match(read('web/app.js'), /\.\.\.\(lang \? \{ lang \} : \{\}\)/);
});

test('web InterpreterSession: each turn heard, translated and spoken in the other language', async () => {
  const spoken: [string, string][] = [];
  const turns: unknown[] = [];
  const answers = [
    { line: { from: 'es', to: 'en', said: '¿Dónde está la estación?', text: 'Where is the station?' } },
    { line: { from: 'en', to: 'es', said: 'Two more blocks.', text: 'Dos calles más.' } },
    { line: { from: 'en', to: 'es', said: 'Goodbye', text: 'Adiós' } },
  ];
  let lines: any[] = [];
  const s = new web.InterpreterSession({
    a: 'en',
    b: 'es',
    turn: async (body: unknown) => (turns.push(body), answers.shift()),
    speak: (txt: string, lang: string) => spoken.push([txt, lang]),
    onLines: (l: any[]) => (lines = l),
  });
  await s.heard('¿Dónde está la estación?');
  s.myTurn('a');
  await s.heard('Two more blocks.');
  assert.equal(await s.heard('Goodbye'), 'sent', 'goodbye is translated, not an end');
  assert.deepEqual(spoken, [['Where is the station?', 'en'], ['Dos calles más.', 'es'], ['Adiós', 'es']]);
  assert.deepEqual((turns[1] as any).hint, 'en', 'My turn is a hint');
  assert.equal(lines.length, 3);
  assert.deepEqual(web.sideTexts(lines[0], 'en', 'es'), { en: 'Where is the station?', es: '¿Dónde está la estación?' });
  // A turn the server couldn't translate: the words are shown, nothing is spoken.
  const quiet = new web.InterpreterSession({ a: 'en', b: 'es', turn: async () => ({ line: { from: 'es', to: 'en', said: 'Hola', text: '' }, why: 'No model on this computer.' }), speak: (x: string) => spoken.push([x, '?']), onLines: () => {} });
  await quiet.heard('Hola');
  assert.equal(spoken.length, 3);
  assert.equal(quiet.lines.at(-1).why, 'No model on this computer.');
});

test('page wiring: talk.js hands utterances to the interpreter, the two-sided screen and the Settings section', () => {
  const talk = read('web/talk.js');
  assert.match(talk, /if \(interpOn\(\)\) return void \(await interpHeard\(text\)\);/);
  const html = read('web/index.html');
  for (const id of ['tm-interp', 'ti-screen', 'ti-far', 'ti-near', 'ti-lang-a', 'ti-lang-b', 'interp-prefs', 'interp-a', 'interp-b', 'interp-cloud', 'interp-start', 'interp-list']) assert.ok(html.includes(`id="${id}"`), id);
  const tips = JSON.parse(read('web/tips.json'));
  for (const id of ['interp-a', 'interp-b', 'interp-cloud', 'ti-lang-a', 'ti-lang-b']) assert.ok(tips[id] ?? tips.ids?.[id] ?? /data-tip/.test(html.slice(html.indexOf(`id="${id}"`) - 400, html.indexOf(`id="${id}"`))), `tip for ${id}`);
  assert.match(read('web/begin.css'), /\.ti-far \{[^}]*rotate\(180deg\)/);
});
