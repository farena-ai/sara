// V2.9 One-minute voice journal (docs/design/JOURNAL.md): Library → Journal. A short daily entry
// spoken (local hearing only) or typed, a mood tag, the words kept, the recording only when asked,
// "On this day" from earlier years or last month. Everything sealed in the person's own space.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { JOURNAL_MAX_SECONDS, JournalBook, cleanMood, journalFor, MOODS, streakOf } from '../src/journal.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

type App = ReturnType<typeof makeApp>;
const clock = { now: new Date('2026-11-18T20:00:00Z') };
const dirs: (() => void)[] = [];
const apps: App[] = [];
after(() => {
  for (const a of apps) {
    JournalBook.closeFor(a.dataDir);
    a.store.close();
  }
  for (const d of dirs) d();
});
// Words built at run time, so no fixture grep finds them and they can't come from anywhere else.
const SAID = ['Walked', 'the', 'dog', 'to', 'Lake', ['Qu', 'ill', 'mere'].join('')].join(' ');
const TYPED = ['Baked', ['zen', 'dra'].join(''), 'bread'].join(' ');

function space(member?: { id: string; voice?: boolean }): App {
  const { dir, cleanup } = tempDir();
  dirs.push(cleanup);
  const app = makeApp(dir, clock);
  apps.push(app);
  app.settings.update({ timeZone: 'America/Chicago', ownerName: 'Alex', providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm' } as never);
  if (member) {
    const rec = { id: member.id, name: 'Bo', status: 'active', limits: { voice: member.voice ?? true, pictures: false, models: [], messagesPerDay: 0, costPerDay: 0 } };
    (app as unknown as { member: unknown }).member = { record: () => rec, child: () => undefined, limits: () => rec.limits };
  }
  return app;
}

/** A fake hearing engine on this computer: hears `said` from any WAV it is given. */
function fakeHearing(app: App, said: string, heard: Buffer[] = []) {
  (app as unknown as { voice: unknown }).voice = {
    available: { stt: true, tts: false },
    transcribe: async (wav: Buffer) => {
      heard.push(wav);
      return said;
    },
  };
  return heard;
}

/** A silent 16 kHz mono 16-bit WAV of `seconds`. */
function wav(seconds: number): Buffer {
  const n = Math.round(16000 * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 9) * 800), 44 + i * 2);
  return b;
}

async function serve(t: { after: (f: () => unknown) => void }, app: App) {
  const auth = new OwnerAuth(app.dataDir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const call = async (path: string, o: { method?: string; json?: unknown; raw?: Buffer } = {}) => {
    const headers: Record<string, string> = { authorization: ['Bearer', token].join(' ') };
    if (o.json !== undefined) headers['content-type'] = 'application/json';
    if (o.raw) headers['content-type'] = 'audio/wav';
    const res = await fetch(`${base}${path}`, { method: o.method ?? (o.json !== undefined || o.raw ? 'POST' : 'GET'), headers, ...(o.json !== undefined ? { body: JSON.stringify(o.json) } : o.raw ? { body: new Uint8Array(o.raw) } : {}) });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, type, body: (type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())) as any };
  };
  return call;
}

test('moods, streaks and the per-space book', () => {
  assert.deepEqual([...MOODS], ['great', 'good', 'okay', 'low', 'rough']);
  assert.equal(cleanMood('good'), 'good');
  assert.equal(cleanMood('ecstatic'), null);
  assert.equal(cleanMood(undefined), null);
  assert.equal(streakOf(['2026-11-18', '2026-11-17', '2026-11-16', '2026-11-14'], '2026-11-18'), 3);
  assert.equal(streakOf(['2026-11-17', '2026-11-16'], '2026-11-18'), 2, 'a streak still counts until today ends');
  assert.equal(streakOf(['2026-11-15'], '2026-11-18'), 0);
  const app = space();
  assert.equal(journalFor(app), journalFor(app), 'one book per space folder');
});

test('"On this day" shows the same day in earlier years, else last month', () => {
  const app = space();
  const book = journalFor(app);
  const tz = 'America/Chicago';
  book.add({ text: 'Last month', mood: 'okay', at: new Date('2026-10-18T18:00:00Z'), timeZone: tz });
  let otd = book.onThisDay(clock.now, tz);
  assert.equal(otd?.kind, 'month');
  assert.deepEqual(otd?.items.map((e) => e.text), ['Last month']);
  book.add({ text: 'Two years ago', mood: 'great', at: new Date('2024-11-18T18:00:00Z'), timeZone: tz });
  book.add({ text: 'A year ago', mood: 'low', at: new Date('2025-11-18T18:00:00Z'), timeZone: tz });
  book.add({ text: 'Not the day', at: new Date('2025-11-19T18:00:00Z'), timeZone: tz });
  otd = book.onThisDay(clock.now, tz);
  assert.equal(otd?.kind, 'year');
  assert.deepEqual(otd?.items.map((e) => [e.text, e.years]), [['A year ago', 1], ['Two years ago', 2]]);
  // The day is the person's own day: 2026-11-19 02:00 UTC is still the 18th in Chicago.
  const late = book.add({ text: 'late', at: new Date('2026-11-19T02:00:00Z'), timeZone: tz });
  assert.equal(late.day, '2026-11-18');
});

test('V2.9 acceptance: a fake hearing engine saves an entry; it never appears outside the owner\'s space', async (t) => {
  const owner = space();
  const heard = fakeHearing(owner, ` ${SAID} `);
  const api = await serve(t, owner);

  // Nothing yet: the page learns hearing is here and the recording is not kept by default.
  let home = await api('/library/journal');
  assert.equal(home.status, 200);
  assert.deepEqual(home.body.entries, []);
  assert.equal(home.body.hearing, true);
  assert.equal(home.body.prefs.keepAudio, false);
  assert.equal(home.body.today, false);
  assert.equal(home.body.maxSeconds, JOURNAL_MAX_SECONDS);

  // Spoken: the words are kept, the recording is not (not asked).
  const said = await api('/library/journal?mood=good', { raw: wav(4) });
  assert.equal(said.status, 201, JSON.stringify(said.body));
  assert.equal(said.body.entry.text, SAID);
  assert.equal(said.body.entry.mood, 'good');
  assert.equal(said.body.entry.audio, false);
  assert.equal(said.body.entry.seconds, 4);
  assert.equal(said.body.entry.spoken, true);
  assert.equal(heard.length, 1, 'heard once, by the engine on this computer');
  assert.equal((await api(`/library/journal/${said.body.entry.id}/audio`)).status, 404);

  // Spoken with "keep the recording": it plays back as a real WAV.
  const kept = await api('/library/journal?mood=great&keep=1', { raw: wav(2) });
  assert.equal(kept.status, 201);
  assert.equal(kept.body.entry.audio, true);
  const audio = await api(`/library/journal/${kept.body.entry.id}/audio`);
  assert.equal(audio.status, 200);
  assert.equal(audio.type, 'audio/wav');
  assert.equal(audio.body.subarray(0, 4).toString('latin1'), 'RIFF');

  // Typed instead, then fixed: edit the words and the mood; then one is deleted.
  const typed = await api('/library/journal', { json: { text: TYPED, mood: 'rough' } });
  assert.equal(typed.status, 201);
  assert.equal(typed.body.entry.spoken, false);
  const fixed = await api(`/library/journal/${typed.body.entry.id}`, { method: 'PATCH', json: { text: `${TYPED}!`, mood: 'okay' } });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.entry.text, `${TYPED}!`);
  assert.equal(fixed.body.entry.mood, 'okay');
  assert.equal(fixed.body.entry.edited, true);
  assert.equal((await api(`/library/journal/${typed.body.entry.id}`, { method: 'DELETE' })).status, 200);

  home = await api('/library/journal');
  assert.deepEqual(home.body.entries.map((e: { text: string }) => e.text), [SAID, SAID]);
  assert.equal(home.body.today, true);
  assert.equal(home.body.streak, 1);

  // Refusals: too long, not a WAV, empty words, a bad mood.
  assert.equal((await api('/library/journal', { raw: wav(JOURNAL_MAX_SECONDS + 20) })).status, 413);
  assert.equal((await api('/library/journal', { raw: Buffer.from('not a recording at all, just text') })).status, 400);
  assert.equal((await api('/library/journal', { json: { text: '   ' } })).status, 400);
  assert.equal((await api('/library/journal', { json: { text: 'x', mood: 'ecstatic' } })).status, 400);

  // Remember "keep the recording" for next time.
  assert.equal((await api('/library/journal/prefs', { method: 'PUT', json: { keepAudio: true } })).body.prefs.keepAudio, true);
  assert.equal((await api('/library/journal')).body.prefs.keepAudio, true);

  // Private: sealed on disk (no words, no WAV header), in the owner's own folder only.
  const dir = join(owner.dataDir, 'journal');
  assert.ok(existsSync(join(dir, 'journal.db')));
  for (const f of readdirSync(dir)) {
    const raw = readFileSync(join(dir, f));
    assert.ok(!raw.includes(Buffer.from(['Lake', 'Qu'].join(' '))), `${f} holds no words in clear`);
    assert.ok(!raw.includes(Buffer.from('WAVEfmt')), `${f} holds no recording in clear`);
  }
  // Not in chats, not in memory: nothing about it reached her conversations or what she remembers.
  const word = ['Qu', 'ill', 'mere'].join('');
  for (const c of owner.store.listConversations()) for (const m of owner.store.messages(c.id)) assert.ok(!String(m.content).includes(word));
  assert.ok(!JSON.stringify(owner.memory?.listAll() ?? []).includes(word));
  assert.ok(!readFileSync(join(owner.dataDir, 'sara.db')).includes(Buffer.from(word)), 'the chat database never sees it');

  // A household member's server: their own empty journal, never the owner's entries.
  const bo = space({ id: 'm1' });
  fakeHearing(bo, 'mine');
  const boApi = await serve(t, bo);
  const boHome = await boApi('/library/journal');
  assert.equal(boHome.status, 200);
  assert.deepEqual(boHome.body.entries, []);
  assert.equal((await boApi(`/library/journal/${said.body.entry.id}`, { method: 'PATCH', json: { text: 'x' } })).status, 404);
  assert.equal((await boApi(`/library/journal/${kept.body.entry.id}/audio`)).status, 404);
});

test('only hearing on this computer: no local engine (or voice off for a member) means type it instead', async (t) => {
  const app = space();
  // A cloud speech service is set up, but the journal never sends a recording to it.
  app.settings.update({ voice: { stt: 'openai' } } as never);
  const api = await serve(t, app);
  const home = await api('/library/journal');
  assert.equal(home.body.hearing, false);
  const r = await api('/library/journal', { raw: wav(2) });
  assert.equal(r.status, 409);
  assert.equal(r.body.typeInstead, true);
  assert.equal((await api('/library/journal', { json: { text: TYPED } })).status, 201);

  const bo = space({ id: 'm2', voice: false });
  fakeHearing(bo, 'never heard');
  const boApi = await serve(t, bo);
  assert.equal((await boApi('/library/journal')).body.hearing, false);
  assert.equal((await boApi('/library/journal', { raw: wav(2) })).status, 409);
});

test('the Library view is wired: opener, view, strings through t(), hidden on Library home', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  for (const id of ['lib-journal-open', 'lib-journal', 'jr-back', 'jr-record', 'jr-keep', 'jr-text', 'jr-save', 'jr-list', 'jr-otd']) assert.ok(html.includes(`id="${id}"`), id);
  const lib = readFileSync(join(ROOT, 'web', 'library.js'), 'utf8');
  assert.match(lib, /#lib-journal/);
  const js = readFileSync(join(ROOT, 'web', 'journal.js'), 'utf8');
  assert.match(js, /export function openJournal/);
  assert.match(js, /\/library\/journal/);
  assert.ok(!/fetch\(['"`]\/api\/voice\/transcribe/.test(js), 'never the general hearing route (it may use a cloud service)');
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /journal: \(\) => void openJournal\(\)/);
});
