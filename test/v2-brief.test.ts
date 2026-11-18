// V2.4 (docs/BRIEFING_AUDIO.md): the morning briefing as audio in the Library, a play button on
// Today, a token-scoped private podcast feed, and a weekly life review next to the planner review.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { BriefingWorker } from '../src/briefing.ts';
import { BRIEFING_COLLECTION, briefingAudios, feedTokenOk, joinWav, KEEP_AUDIO, makeBriefingAudio, newFeedToken, readWav } from '../src/briefing-audio.ts';
import { LibraryStore } from '../src/library/store.ts';
import { gatherLife, plainLife } from '../src/life-review.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

/** A tiny 16 kHz mono 16-bit WAV of `ms` milliseconds (what sherpa writes, shape-wise). */
function wav(ms: number, rate = 16000): Buffer {
  const data = Buffer.alloc(Math.round((rate * ms) / 1000) * 2, 1);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** The fake local voice engine: records what it was asked to say. */
function fakeVoice() {
  const said: string[] = [];
  return { said, engine: { voices: () => [{ id: 'kokoro:1', label: 'Test' }], available: { stt: false, tts: true }, speak: async (text: string) => (said.push(text), { data: wav(200), type: 'audio/wav' }) } };
}

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-18T13:31:00Z') }; // 07:31 in Chicago
const app = makeApp(dir, clock);
const voice = fakeVoice();
app.voice = voice.engine as never;
app.library = new LibraryStore(app.store.db, dir, () => clock.now);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
// Cloud voice picked in Settings → Voice: the briefing recording must still use the local engine.
const cloudCalls: string[] = [];
const realFetch = globalThis.fetch;
before(async () => {
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago', disclosureAcceptedAt: clock.now.toISOString(), voice: { tts: 'openai' } as never });
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const s = String(u instanceof Request ? u.url : u);
    if (/openai|elevenlabs|x\.ai/.test(s)) cloudCalls.push(s);
    return realFetch(u, init);
  }) as typeof fetch;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  globalThis.fetch = realFetch;
  server.close();
  app.store.close();
  cleanup();
});
const call = async (path: string, opts: { method?: string; body?: unknown; bearer?: string | null } = {}) => {
  const res = await realFetch(base + path, { method: opts.method ?? 'GET', headers: { ...(opts.bearer === null ? {} : { authorization: `Bearer ${opts.bearer ?? token}` }), 'content-type': 'application/json' }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return { status: res.status, type: res.headers.get('content-type') ?? '', buf: Buffer.from(await res.arrayBuffer()) };
};
const json = (r: { buf: Buffer }) => JSON.parse(r.buf.toString('utf8'));

test('WAV parts join into one valid file with a pause between them', () => {
  const one = joinWav([wav(100), wav(300)], 200);
  const p = readWav(one);
  assert.equal(p.rate, 16000);
  assert.equal(p.data.length, (1600 + 4800 + 3200) * 2);
  assert.equal(one.readUInt32LE(4), one.length - 8);
});

test('a briefing becomes a WAV in the Library (fake local voice), with its text readable', async () => {
  voice.said.length = 0;
  const text = 'Good morning, Alex! It is Wednesday. Light rain later, high of 51. On your list: call the plumber. Your dentist is at three.';
  const item = await makeBriefingAudio(app, text, '2026-11-18');
  assert.match(item.name, /^Morning briefing 2026-11-18\.wav$/);
  assert.ok(voice.said.length >= 1 && voice.said.join(' ').includes('plumber'));
  assert.deepEqual(cloudCalls, [], 'no cloud voice unless picked');
  const doc = app.library!.get(item.id)!;
  assert.equal(doc.collection, BRIEFING_COLLECTION);
  assert.equal(doc.status, 'ready');
  assert.equal(doc.learn, 'off', 'a recording is never learned into memory');
  assert.match(app.library!.passages(item.id).map((x) => x.text).join(' '), /plumber/);
  assert.ok(readWav(app.library!.file(doc)!).data.length > 0);
  // The same day again replaces it (one per day).
  const again = await makeBriefingAudio(app, 'Good morning again.', '2026-11-18');
  assert.equal(briefingAudios(app).filter((x) => x.day === '2026-11-18').length, 1);
  assert.notEqual(again.id, item.id);
});

test('only the newest recordings are kept', async () => {
  for (let i = 1; i <= KEEP_AUDIO + 2; i++) await makeBriefingAudio(app, `Morning number ${i}.`, `2026-10-${String(i).padStart(2, '0')}`);
  assert.equal(briefingAudios(app).length, KEEP_AUDIO);
  assert.equal(briefingAudios(app)[0].day, '2026-11-18');
});

test('no local voice: a clear error, never a silent cloud fallback', async () => {
  const keep = app.voice;
  app.voice = undefined;
  try {
    await assert.rejects(makeBriefingAudio(app, 'Hello there.', '2026-11-17'), /voice on this computer/);
    assert.deepEqual(cloudCalls, []);
  } finally {
    app.voice = keep;
  }
});

test('the briefing worker makes the audio after sending, when switched on', async () => {
  app.settings.update({ briefing: { enabled: true, time: '07:30', audio: true } as never });
  const conv = app.store.createConversation({});
  app.store.addMessage(conv.id, 'user', 'hi');
  app.script.push([{ type: 'text', text: 'Morning, Alex! Nothing due today, enjoy the quiet.' }]);
  const w = new BriefingWorker(app);
  const sent = await w.tick();
  assert.match(sent!, /quiet/);
  await w.audioDone;
  const top = briefingAudios(app)[0];
  assert.equal(top.day, '2026-11-18');
  assert.match(app.library!.passages(top.id).map((p) => p.text).join(' '), /quiet/);
});

test('routes: settings, list, make now, play', async () => {
  const put = await call('/api/briefing/audio', { method: 'PUT', body: { audio: true, voice: 'chosen' } });
  assert.equal(put.status, 200);
  assert.equal(json(put).settings.voice, 'chosen');
  assert.equal(app.settings.get().briefing?.enabled, true, 'the briefing switch is left alone');
  await call('/api/briefing/audio', { method: 'PUT', body: { voice: 'local' } });
  const made = await call('/api/briefing/audio/make', { method: 'POST' });
  assert.equal(made.status, 200);
  const view = json(await call('/api/briefing/audio'));
  assert.equal(view.settings.audio, true);
  assert.equal(view.settings.voice, 'local');
  assert.equal(view.localVoice, true);
  assert.equal(view.latest.id, json(made).item.id);
  assert.equal(view.feed.on, false);
  const play = await call(`/api/briefing/audio/${view.latest.id}`);
  assert.equal(play.status, 200);
  assert.equal(play.type, 'audio/wav');
  assert.equal(play.buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal((await call(`/api/briefing/audio/${view.latest.id}`, { bearer: null })).status, 401);
});

test('the private feed needs its token; a new link stops the old one; off stops all', async () => {
  assert.equal((await call('/feed/briefing/not-a-real-token-at-all-xyz', { bearer: null })).status, 404, 'feed off: nothing');
  const on = json(await call('/api/briefing/feed', { method: 'POST', body: { on: true } }));
  assert.match(on.path, /^\/feed\/briefing\/[\w-]{20,}$/);
  const feed = await call(on.path, { bearer: null });
  assert.equal(feed.status, 200);
  assert.match(feed.type, /rss\+xml/);
  const rss = feed.buf.toString('utf8');
  assert.match(rss, /<enclosure url="http:\/\/127\.0\.0\.1:\d+\/feed\/briefing\/[\w-]+\/\d+\.wav"/);
  const enc = /enclosure url="http:\/\/[^/]+(\/feed\/[^"]+)"/.exec(rss)![1];
  const file = await call(enc, { bearer: null });
  assert.equal(file.status, 200);
  assert.equal(file.type, 'audio/wav');
  // A wrong token (same length), or a guessed id under a wrong token: 404.
  const wrong = on.path.replace(/.$/, (c: string) => (c === 'a' ? 'b' : 'a'));
  assert.equal((await call(wrong, { bearer: null })).status, 404);
  assert.equal((await call(enc.replace(on.path, wrong), { bearer: null })).status, 404);
  // The token itself is never stored.
  assert.ok(!readFileSync(join(dir, 'briefing-feed.json'), 'utf8').includes(on.path.split('/').pop()));
  const view = json(await call('/api/briefing/audio'));
  assert.equal(view.feed.on, true);
  assert.equal(view.feed.path, undefined, 'the link is shown once, when made');
  const again = json(await call('/api/briefing/feed', { method: 'POST', body: { on: true } }));
  assert.equal((await call(on.path, { bearer: null })).status, 404, 'old link stopped');
  assert.equal((await call(again.path, { bearer: null })).status, 200);
  await call('/api/briefing/feed', { method: 'POST', body: { on: false } });
  assert.equal((await call(again.path, { bearer: null })).status, 404);
  assert.equal(feedTokenOk(app, newFeedToken(app).slice(1)), false);
});

test('weekly life review: people, health counts, money, moments; health stays out of a cloud note', async () => {
  const { PeopleStore } = await import('../src/people.ts');
  const { PeopleTies } = await import('../src/people-ties.ts');
  const { MomentsStore } = await import('../src/moments.ts');
  const { healthFor } = await import('../src/health-log.ts');
  const { moneyStore } = await import('../src/money/store.ts');
  app.people = new PeopleStore(app.store.db);
  const ana = app.people.create({ name: 'Ana', relation: 'friend', status: 'active' });
  const secret = app.people.create({ name: 'Zed', relation: 'friend', private: true, status: 'active' });
  app.peopleTies = new PeopleTies(app, { sources: { mail: async () => [], calendar: async () => [] } } as never);
  const db = app.store.db;
  const addContact = (id: number, channel: string, dir: string) => db.prepare('INSERT INTO person_contact (person_id, channel, dir, at, ref, label) VALUES (?, ?, ?, ?, ?, ?)').run(id, channel, dir, '2026-11-16T15:00:00Z', null, null);
  addContact(ana.id, 'chat', 'in');
  addContact(ana.id, 'mail', 'out');
  addContact(secret.id, 'chat', 'in');
  const h = healthFor(app);
  h.addEntry({ type: 'sleep', name: 'sleep', value: 7 });
  h.addEntry({ type: 'mood', name: 'mood', value: 4, scale: 5 });
  moneyStore(app).importTransactions([{ date: '2026-11-16', amountCents: -4250, description: 'GROCER', account: 'Checking', bankCategory: 'Groceries' } as never, { date: '2026-11-17', amountCents: -1200, description: 'CAFE', account: 'Checking', bankCategory: 'Eating out' } as never]);
  app.moments = new MomentsStore(app.store.db, () => clock.now);
  const f = await gatherLife(app, clock.now);
  assert.deepEqual(f.people, ['Ana (chat, mail)'], 'private cards stay out');
  assert.match(f.health!, /^2 entries \(1 mood, 1 sleep\)/);
  assert.equal(f.healthToModel, false);
  assert.match(f.money!, /spent \$54\.50 in 2 payments \(most: .*\$42\.50/);
  assert.match(plainLife(f), /Ana/);
  // Through the route: the model note has no health line, the message gets it added in code.
  app.script.push([{ type: 'text', text: 'What a week, Alex: you caught up with Ana twice and spent $54.50.' }]);
  const r = await call('/api/review/life', { method: 'POST' });
  assert.equal(r.status, 200);
  const note = JSON.stringify(app.requests.at(-1)!.messages);
  assert.match(note, /Ana \(chat, mail\)/);
  assert.doesNotMatch(note, /sleep|health log this week/i);
  const out = json(r).text;
  assert.match(out, /Health log: 2 entries/);
  const msg = app.store.messages(json(r).conversationId).at(-1)!;
  assert.equal((msg.meta as { health?: boolean }).health, true);
  // The weekly review setting carries the life switch.
  const rv = json(await call('/api/review', { method: 'PUT', body: { life: true } }));
  assert.equal(rv.life, true);
});

test('members get no podcast link (it belongs to the server owner)', async () => {
  const src = readFileSync(join(ROOT, 'src/routes/planner.ts'), 'utf8');
  assert.match(src, /feed[\s\S]{0,200}opts\.member/);
});
