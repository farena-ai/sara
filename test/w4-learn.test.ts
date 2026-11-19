// W4.3 (docs/LANGUAGE_PRACTICE.md): language practice on top of the U4.23 study engine, the W0.3
// multilingual hearing and the V4.2 local voices per language. Fake local hearing and voice only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn } from '../src/chat.ts';
import { langLearnFor, LEARN_LANGS, LEARN_LEVELS, PHRASES, phrasesFor, scoreSaid } from '../src/lang-learn.ts';
import { learnTalkNote } from '../src/lang-learn-note.ts';
import { createSaraServer } from '../src/server.ts';
import { studyFor } from '../src/study.ts';
import { makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function rigApp(dir: string, clock: { now: Date } = { now: new Date('2026-11-19T15:00:00Z') }): TestApp & { heard: string[]; spoke: { text: string; id: string; speed: number }[]; queue: string[] } {
  const app = makeApp(dir, clock) as TestApp & { heard: string[]; spoke: { text: string; id: string; speed: number }[]; queue: string[] };
  app.settings.update({ providers: [{ id: 'p', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', local: true, defaultModel: 'fixture' }], defaultProviderId: 'p', defaultModel: 'fixture', timeZone: 'America/Chicago' } as never);
  app.heard = [];
  app.spoke = [];
  app.queue = [];
  app.voice = {
    available: { stt: true, tts: true },
    voices: () => [{ id: 'piper:en_US-amy', label: 'Amy' }, { id: 'piper:es_ES-davefx', label: 'Dave (Spanish)' }],
    streamingReady: (l?: string) => l === 'en' || l === 'es',
    transcribe: async (_wav: Buffer, o: { lang?: string } = {}) => {
      app.heard.push(String(o.lang));
      return app.queue.shift() ?? '';
    },
    speak: async (t: string, id: string, speed = 1) => {
      app.spoke.push({ text: t, id, speed });
      return { data: Buffer.from('RIFF-fake-wav'), type: 'audio/wav' };
    },
  } as never;
  return app;
}

test('phrase bank: every sentence in all six languages, three levels, meanings in the learner\'s own language', () => {
  assert.deepEqual([...LEARN_LANGS], ['es', 'fr', 'de', 'pt', 'it', 'en']);
  assert.deepEqual([...LEARN_LEVELS], ['a1', 'a2', 'b1']);
  for (const lv of LEARN_LEVELS) assert.ok(PHRASES.filter((p) => p.level === lv).length >= 8, lv);
  for (const p of PHRASES) for (const l of LEARN_LANGS) assert.ok(p[l]?.trim(), `${p.id} ${l}`);
  assert.equal(new Set(PHRASES.map((p) => p.id)).size, PHRASES.length);
  const es = phrasesFor('es', 'a1', 'en');
  assert.equal(es[1].text, 'Me llamo Ana.');
  assert.equal(es[1].meaning, 'My name is Ana.');
  assert.equal(phrasesFor('fr', 'a1', 'de')[1].meaning, 'Ich heiße Ana.', 'meaning in the app language');
  assert.equal(phrasesFor('en', 'a1', 'en')[1].meaning, 'Me llamo Ana.', 'learning English in English: Spanish meanings');
});

test('scoreSaid: word by word, accents and case forgiven, near words marked close, gentle feedback', () => {
  const perfect = scoreSaid('¿Dónde está la estación de tren?', 'donde esta la estacion de tren');
  assert.equal(perfect.pct, 100);
  assert.ok(perfect.words.every((w) => w.mark === 'ok'));
  assert.match(perfect.feedback, /Every word/);

  const close = scoreSaid('Quisiera un café, por favor.', 'quisiera un cafe por fervor');
  assert.deepEqual(close.words.map((w) => w.mark), ['ok', 'ok', 'ok', 'ok', 'close']);
  assert.equal(close.words[4].heard, 'fervor');
  assert.ok(close.pct >= 80 && close.pct < 100);
  assert.match(close.feedback, /close/i);
  assert.deepEqual(close.params, { words: '“favor”' });

  const missed = scoreSaid('Tengo un hermano y una hermana.', 'tengo hermana');
  assert.deepEqual(missed.words.map((w) => w.mark), ['ok', 'missed', 'missed', 'missed', 'missed', 'ok']);
  assert.ok(missed.pct < 50);
  assert.match(missed.feedback, /Good try/);
  assert.doesNotMatch(missed.feedback, /wrong|bad|fail/i, 'gentle');

  assert.equal(scoreSaid('Je m\'appelle Ana.', '').pct, 0);
  assert.equal(scoreSaid('Wie viel kostet das?', 'Wie viel kostet das? Danke').pct, 100, 'extra words never cost points');
});

test('setup reuses the study engine: one set per language and level, spaced repetition from Study', () => {
  const { dir, cleanup } = tempDir();
  const app = rigApp(dir);
  try {
    const ll = langLearnFor(app);
    const v = ll.setup({ lang: 'es', level: 'a1', daily: 5 });
    assert.equal(v.prefs.lang, 'es');
    const s = studyFor(app);
    const sets = s.list();
    assert.equal(sets.length, 1);
    assert.match(sets[0].title, /español · A1/i);
    const cards = s.cards(sets[0].id);
    assert.equal(cards.length, PHRASES.filter((p) => p.level === 'a1').length);
    assert.equal(cards[1].front, 'Me llamo Ana.');
    assert.equal(cards[1].back, 'My name is Ana.');
    ll.setup({ lang: 'es', level: 'a1' });
    assert.equal(s.list().length, 1, 'same language and level: the same set');
    const today = ll.view();
    assert.equal(today.session.cards.length, 5, 'daily size');
    assert.equal(today.session.listen.length, 3);
    assert.equal(today.session.speak.length, 3);
    assert.ok(today.session.speak.every((p) => p.text && p.meaning && p.id));
    assert.deepEqual(today.local, { voice: true, hearing: true, live: true });
    // A study review (the existing route's engine) counts for the streak.
    s.review(today.session.cards[0].id, 4);
    assert.equal(ll.view().progress.streak, 1);
    // French: no local French voice or hearing here, said plainly.
    ll.setup({ lang: 'fr', level: 'a2' });
    assert.deepEqual(ll.view().local, { voice: false, hearing: false, live: false });
    assert.equal(s.list().length, 2);
  } finally {
    app.store.close();
    cleanup();
  }
});

test('progress: streak over days, words known from spoken words and learned cards', () => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-17T15:00:00Z') };
  const app = rigApp(dir, clock);
  try {
    const ll = langLearnFor(app);
    ll.setup({ lang: 'es', level: 'a1' });
    const r = ll.score('a1-2', 'me llamo ana');
    assert.equal(r.result.pct, 100);
    assert.equal(r.progress.wordsKnown, 3);
    clock.now = new Date('2026-11-18T15:00:00Z');
    ll.score('a1-6', 'cuánto cuesta');
    clock.now = new Date('2026-11-19T15:00:00Z');
    const p = ll.score('a1-6', 'cuanto');
    assert.equal(p.progress.streak, 3);
    assert.equal(p.progress.wordsKnown, 5);
    assert.equal(p.progress.saidToday, 1);
    clock.now = new Date('2026-11-21T15:00:00Z');
    assert.equal(ll.view().progress.streak, 0, 'a missed day ends the streak');
    assert.throws(() => ll.score('zz-9', 'x'), /not found/i);
  } finally {
    app.store.close();
    cleanup();
  }
});

async function rigServer(t: import('node:test').TestContext, member?: { voice: boolean }) {
  const { dir, cleanup } = tempDir();
  const app = rigApp(dir);
  const auth = new OwnerAuth(dir);
  const record = () => ({ id: 'm1', name: 'Kim', status: 'active', limits: { voice: member?.voice ?? true, pictures: false } });
  if (member) app.member = { limits: () => ({ voice: member.voice }) } as never;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(member ? { spaceId: 'm1', member: { record, apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    app.store.close();
    cleanup();
  });
  const call = async (method: string, path: string, body?: unknown, raw?: Buffer) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { Origin: base, authorization: 'Bearer ' + auth.newToken, 'content-type': raw ? 'audio/wav' : 'application/json' }, ...(raw ? { body: new Uint8Array(raw) } : body === undefined ? {} : { body: JSON.stringify(body) }) });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, type, body: (type.includes('json') ? await res.json() : await res.text()) as any };
  };
  return { app, call };
}

test('routes: setup, local voice per language, local hearing in that language, score, talk practice chat', async (t) => {
  const { app, call } = await rigServer(t);
  let r = await call('GET', '/study/lang');
  assert.equal(r.status, 200);
  assert.equal(r.body.prefs.lang, null, 'nothing picked yet');
  assert.deepEqual(r.body.langs, [...LEARN_LANGS]);
  r = await call('PUT', '/study/lang', { lang: 'es', level: 'a2', daily: 10 });
  assert.equal(r.status, 200);
  assert.equal(r.body.prefs.level, 'a2');
  assert.equal(r.body.session.speak.length, 3);
  const want = r.body.session.speak[0];

  r = await call('POST', '/study/lang/say', { text: want.text, slow: true });
  assert.equal(r.status, 200);
  assert.match(r.type, /audio\/wav/);
  assert.deepEqual(app.spoke.at(-1), { text: want.text, id: 'piper:es_ES-davefx', speed: 0.8 });

  app.queue.push(want.text.toLowerCase());
  r = await call('POST', '/study/lang/hear', undefined, Buffer.from('RIFF-fake-wav'));
  assert.equal(r.status, 200);
  assert.equal(app.heard.at(-1), 'es', 'heard in the language being learned');
  r = await call('POST', '/study/lang/score', { id: want.id, said: r.body.text });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.pct, 100);
  assert.ok(r.body.progress.wordsKnown > 0);

  const warmed: string[] = [];
  (app.voice as any).warm = async (id: string, o: { lang: string }) => (warmed.push(`${id}@${o.lang}`), true);
  assert.equal((await call('POST', '/study/lang/warm')).status, 202);
  assert.deepEqual(warmed, ['piper:es_ES-davefx@es']);
  r = await call('POST', '/study/lang/talk');
  assert.equal(r.status, 200);
  const conv = r.body.conversationId;
  assert.ok(conv);
  assert.equal((await call('POST', '/study/lang/talk')).body.conversationId, conv, 'the same practice chat next time');

  // A language with no local voice: said plainly, never a cloud voice.
  await call('PUT', '/study/lang', { lang: 'it', level: 'a1' });
  r = await call('POST', '/study/lang/say', { text: 'Ciao' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /voice/i);
  r = await call('POST', '/study/lang/hear', undefined, Buffer.from('RIFF-fake-wav'));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /hearing/i);

  // /api/voice/speak {local:true} (Talk practice) uses only the local voice for the language.
  r = await call('POST', '/voice/speak', { text: '¿Qué tal?', lang: 'es', local: true });
  assert.equal(r.status, 200);
  assert.equal(app.spoke.at(-1)!.id, 'piper:es_ES-davefx');
});

test('routes: a member whose voice is off gets 403 for hearing and voice', async (t) => {
  const { call } = await rigServer(t, { voice: false });
  await call('PUT', '/study/lang', { lang: 'es', level: 'a1' });
  assert.equal((await call('POST', '/study/lang/say', { text: 'Hola' })).status, 403);
  assert.equal((await call('POST', '/study/lang/hear', undefined, Buffer.from('RIFF'))).status, 403);
  assert.equal((await call('GET', '/study/lang')).status, 200, 'cards and progress still work');
});

test('talk practice: her system prompt gets the language and level only in the practice chat', async () => {
  const { dir, cleanup } = tempDir();
  const app = rigApp(dir);
  try {
    const ll = langLearnFor(app);
    ll.setup({ lang: 'de', level: 'a1' });
    const id = ll.talkConversation();
    assert.match(learnTalkNote(app, { id }) ?? '', /German.*A1|A1.*German/s);
    assert.equal(learnTalkNote(app, { id: 'other' }), undefined);
    app.script.push(text('Hallo! Wie heißt du?'));
    for await (const _ of runTurn(app, id, 'Hallo')) void _;
    const sys = app.requests.at(-1)!.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
    assert.match(sys, /Language practice/);
    assert.match(sys, /German/);
    assert.match(sys, /gentl/i);
    const other = app.store.createConversation({ title: 'x' } as never);
    app.script.push(text('ok'));
    for await (const _ of runTurn(app, other.id, 'hi')) void _;
    assert.doesNotMatch(app.requests.at(-1)!.messages.map((m) => String(m.content)).join('\n'), /Language practice/);
  } finally {
    app.store.close();
    cleanup();
  }
});

test('web: Library page, Talk practice hears and speaks the language locally, strings translated', () => {
  const html = read('web/index.html');
  assert.match(html, /<section id="lib-lang" hidden>/);
  assert.match(html, /id="lib-lang-open"/);
  for (const id of ['ll-lang', 'll-level', 'll-daily']) assert.match(html, new RegExp(`data-tip="[^"]+">\\?</button>\\s*<select id="${id}"`), id);
  const talk = read('web/talk.js');
  assert.match(talk, /learnLang/);
  assert.match(talk, /\/api\/study\/lang\/hear\?lang=/);
  assert.match(read('web/voice.js'), /local: this\.local/);
  assert.match(read('web/app.js'), /local \? \{ local: true \}/);
  const web = read('web/lang-learn.js');
  assert.match(web, /StreamHearing/);
  assert.doesNotMatch(web, /\/api\/voice\/transcribe/, 'never the cloud-capable hearing route');
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const tr = read(`web/i18n/${lang}.json`);
    for (const key of ['Learn a language', 'Every word was right. Lovely!', 'Practice talking']) assert.ok(tr.includes(`"${key}":`), `${lang}: ${key}`);
  }
});
