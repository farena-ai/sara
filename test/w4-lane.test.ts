// W4.2 Memory lane (docs/MEMORY_LANE.md): yearly and trip stories from your own photos, journal,
// moments and trips, written by a model ON THIS COMPUTER only, narrated with the local voice, and
// kept sealed in the person's own space. Shareable only by an explicit share link (EC11).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OwnerAuth } from '../src/auth.ts';
import { JournalBook, journalFor } from '../src/journal.ts';
import { closeLanes, laneOf, laneOptions, lanePdf, pickPhotos, writeLaneStory, makeLaneAudio, type LanePhoto } from '../src/memory-lane.ts';
import { closePhotoLibraries, photoLibraryOf } from '../src/photo-library.ts';
import type { ChatRequest, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { createSaraServer } from '../src/server.ts';
import { setShares, ShareStore } from '../src/share.ts';
import { fakeJpeg } from './fixtures/v4-photos.ts';
import { makeApp, tempDir } from './helpers.ts';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const NOW = new Date('2026-11-18T15:00:00Z');
const LOCAL: ProviderConfig = { id: 'here', label: 'On this PC', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true };
const CLOUD: ProviderConfig = { id: 'cloud', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1' };
// Built at run time so no test file holds a realistic-looking secret.
const MARK = ['JOURNAL', 'SECRET', String(4242)].join('-');

function wav(ms = 200): Buffer {
  const n = Math.round(16 * ms);
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
  return b;
}

async function rig(t: TestContext, providers: ProviderConfig[] = [LOCAL]) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  const asked: { provider: string; req: ChatRequest }[] = [];
  app.providerFactory = (config) => ({
    config,
    listModels: async () => ['gemma4:12b'],
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      asked.push({ provider: config.id, req });
      yield { type: 'text', text: 'What a year, Alex. Lisbon in May was the highlight: the tram up the hill and the sardines.\n\nYou wrote "a quiet good day" once, and I think that says it.\n\nYou also said "we flew to the moon" which never happened.' };
    },
  });
  app.settings.update({ providers, defaultProviderId: providers[0].id, defaultModel: 'gemma4:12b', timeZone: 'America/Chicago', ownerName: 'Alex' } as never);
  // Photos: a Lisbon trip (3) in May 2026, one at home in February 2026, one in 2025.
  const photos = join(dir, 'fake-photos');
  mkdirSync(join(photos, 'Lisbon'), { recursive: true });
  writeFileSync(join(photos, 'Lisbon', 'IMG_1.jpg'), fakeJpeg({ date: '2026:05:11 10:12:00', lat: 38.7139, lon: -9.1394, tag: 'p1' }));
  writeFileSync(join(photos, 'Lisbon', 'IMG_2.jpg'), fakeJpeg({ date: '2026:05:11 16:40:00', lat: 38.7101, lon: -9.145, tag: 'p2' }));
  writeFileSync(join(photos, 'Lisbon', 'IMG_3.jpg'), fakeJpeg({ date: '2026:05:12 20:05:00', lat: 38.717, lon: -9.133, tag: 'p3' }));
  writeFileSync(join(photos, 'snow.jpg'), fakeJpeg({ date: '2026:02:03 12:00:00', lat: 41.8789, lon: -87.6359, tag: 'p4' }));
  writeFileSync(join(photos, 'old.jpg'), fakeJpeg({ date: '2025:07:04 12:00:00', lat: 41.8789, lon: -87.6359, tag: 'p5' }));
  const lib = photoLibraryOf(app);
  lib.setFolder(photos);
  await lib.scan();
  for (const p of lib.all()) {
    const cap = p.name === 'IMG_2.jpg' ? 'A yellow tram going up a steep street' : p.name === 'IMG_3.jpg' ? 'Grilled sardines on a plate' : '';
    if (cap) lib.saveDescription(p.id, { caption: cap, text: '', things: [] });
  }
  // Journal (sealed, private).
  const book = journalFor(app);
  book.add({ text: `a quiet good day ${MARK}`, mood: 'good', at: new Date('2026-05-12T23:00:00Z'), timeZone: 'America/Chicago' });
  book.add({ text: 'last year entry', mood: 'okay', at: new Date('2025-03-01T18:00:00Z'), timeZone: 'America/Chicago' });
  t.after(() => {
    closeLanes();
    closePhotoLibraries();
    JournalBook.closeFor(app.dataDir);
    setShares(undefined);
    app.store.close();
    cleanup();
  });
  return { app, dir, asked };
}

async function serve(t: TestContext, app: ReturnType<typeof makeApp>) {
  const auth = new OwnerAuth(app.dataDir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, o: { method?: string; json?: unknown } = {}) => {
    const headers: Record<string, string> = { authorization: ['Bearer', token].join(' ') };
    if (o.json !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${origin}/api${path}`, { method: o.method ?? (o.json !== undefined ? 'POST' : 'GET'), headers, ...(o.json !== undefined ? { body: JSON.stringify(o.json) } : {}) });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, type, headers: res.headers, body: (type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())) as any };
  };
  return { call, origin };
}

const until = async (f: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('pickPhotos spreads the picks over the range and prefers photos with a caption', () => {
  const ps: LanePhoto[] = [];
  for (let d = 1; d <= 30; d++) for (let k = 0; k < 3; k++) ps.push({ ref: `lib:${d * 10 + k}`, date: `2026-06-${String(d).padStart(2, '0')}`, caption: k === 2 ? `caption ${d}` : '', place: 'Rome' });
  const got = pickPhotos(ps, 6);
  assert.equal(got.length, 6);
  assert.ok(got.every((p) => p.caption), 'a captioned photo wins in its slice');
  const days = got.map((p) => Number(p.date.slice(8)));
  assert.ok(days[0] <= 5 && days.at(-1)! >= 25, `spread over the month: ${days}`);
  assert.deepEqual([...days].sort((a, b) => a - b), days, 'in time order');
  assert.equal(pickPhotos(ps.slice(0, 2), 6).length, 2);
  assert.deepEqual(pickPhotos([], 6), []);
});

test('options: years with something in them and trips from bookings and photo albums', async (t) => {
  const { app } = await rig(t);
  const o = laneOptions(app);
  assert.deepEqual(o.years.slice(0, 2), [2026, 2025]);
  const lisbon = o.trips.find((x) => /Lisbon/.test(x.title));
  assert.ok(lisbon, JSON.stringify(o.trips));
  assert.equal(lisbon.from, '2026-05-11');
  assert.equal(lisbon.to, '2026-05-12');
  assert.equal(o.model?.local, true);
});

test('a year story is written by the model on this computer from photos, journal and moments, sealed at rest', async (t) => {
  const { app, dir, asked } = await rig(t);
  const s = await writeLaneStory(app, { kind: 'year', year: 2026 });
  assert.equal(s.title, 'My year 2026');
  assert.equal(s.how, 'local');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].provider, 'here');
  const sent = asked[0].req.messages.map((m) => m.content).join('\n');
  assert.match(sent, /Grilled sardines/);
  assert.match(sent, new RegExp(MARK), 'her own journal reaches only the local model');
  assert.doesNotMatch(sent, /last year entry/, 'only the chosen year');
  // Exact-words rule: the invented quote is dropped, the real one stays.
  assert.match(s.text, /a quiet good day/);
  assert.doesNotMatch(s.text, /moon/);
  assert.ok(s.photos.length >= 3 && s.photos.length <= 12);
  assert.ok(s.photos.every((p) => p.date.startsWith('2026')));
  // Sealed: the story's words are not in clear on disk.
  const laneDir = join(dir, 'memory-lane');
  for (const f of readdirSync(laneDir)) assert.ok(!readFileSync(join(laneDir, f)).includes('sardines'), `${f} holds clear text`);
  assert.equal(laneOf(app).list()[0].title, 'My year 2026');
});

test('photos and journal never go to a cloud model: with no local model she writes it plainly in code', async (t) => {
  const { app, asked } = await rig(t, [CLOUD]);
  assert.equal(laneOptions(app).model, null);
  const s = await writeLaneStory(app, { kind: 'year', year: 2026 });
  assert.equal(asked.length, 0, 'no model call at all');
  assert.equal(s.how, 'plain');
  assert.match(s.text, /2026/);
  assert.match(s.text, /Lisbon/);
});

test('a trip story covers only the trip days', async (t) => {
  const { app, asked } = await rig(t);
  const trip = laneOptions(app).trips.find((x) => /Lisbon/.test(x.title))!;
  const s = await writeLaneStory(app, { kind: 'trip', key: trip.key });
  assert.equal(s.kind, 'trip');
  assert.match(s.title, /Lisbon/);
  assert.equal(s.photos.length, 3);
  assert.doesNotMatch(asked[0].req.messages.at(-1)!.content, /snow|2026-02-03/);
});

test('narration uses only the voice on this computer; the PDF holds the text and the photos', async (t) => {
  const { app } = await rig(t);
  const s = await writeLaneStory(app, { kind: 'year', year: 2026 });
  await assert.rejects(makeLaneAudio(app, s.id), /voice on this computer/);
  const said: string[] = [];
  (app as any).voice = { voices: () => [{ id: 'piper:x' }], speak: async (text: string) => (said.push(text), { data: wav(), type: 'audio/wav' }) };
  const done = await makeLaneAudio(app, s.id);
  assert.equal(done.audio, true);
  assert.ok(said.join(' ').includes('Lisbon'));
  const a = laneOf(app).audio(s.id)!;
  assert.equal(a.subarray(0, 4).toString('latin1'), 'RIFF');
  const pdf = lanePdf(app, s.id);
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(pdf.includes('/Image'), 'the picked photos are in the PDF');
});

test('routes: list, write, read, photo, audio, PDF, share link, delete', async (t) => {
  const { app, dir } = await rig(t);
  setShares(new ShareStore(dir, () => NOW));
  (app as any).voice = { voices: () => [{ id: 'piper:x' }], speak: async () => ({ data: wav(), type: 'audio/wav' }) };
  const { call, origin } = await serve(t, app);
  let r = await call('/story/lane');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.stories, []);
  assert.ok(r.body.years.includes(2026));
  assert.equal(r.body.voice, true);
  assert.equal((await call('/story/lane', { json: { kind: 'year', year: 1800 } })).status, 400);
  r = await call('/story/lane', { json: { kind: 'year', year: 2026 } });
  assert.equal(r.status, 202);
  await until(async () => (await call('/story/lane')).body.stories.length === 1);
  const list = (await call('/story/lane')).body;
  assert.equal(list.running, false);
  const id = list.stories[0].id;
  r = await call(`/story/lane/${id}`);
  assert.equal(r.body.title, 'My year 2026');
  r = await call(`/story/lane/${id}/photo/1`);
  assert.equal(r.status, 200);
  assert.match(r.type, /image\/jpeg/);
  assert.equal((await call(`/story/lane/${id}/photo/99`)).status, 404);
  r = await call(`/story/lane/${id}/audio`, { json: {} });
  assert.equal(r.status, 200);
  r = await call(`/story/lane/${id}/audio`);
  assert.match(r.type, /audio\/wav/);
  r = await call(`/story/lane/${id}/pdf`);
  assert.match(r.type, /application\/pdf/);
  assert.match(String(r.headers.get('content-disposition')), /attachment/);
  // Dropping a photo from the picks.
  const first = (await call(`/story/lane/${id}`)).body.photos.length;
  r = await call(`/story/lane/${id}`, { method: 'PATCH', json: { drop: 1 } });
  assert.equal(r.body.photos.length, first - 1);
  // A share link is an explicit choice: a frozen copy with the photos, revocable.
  r = await call('/shares', { json: { lane: id, expires: '1d' } });
  assert.equal(r.status, 201);
  const page = await fetch(r.body.link);
  const html = await page.text();
  assert.match(html, /My year 2026/);
  assert.match(html, /sh-pic/);
  const srcs = [...html.matchAll(/class="sh-pic" src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.length >= 3, 'every picked photo is in the copy');
  for (const src of srcs) assert.equal((await fetch(new URL(src, r.body.link))).status, 200, `${src} loads`);
  assert.doesNotMatch(html, new RegExp(MARK), 'the journal words that were not in the story stay out');
  r = await call(`/story/lane/${id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal((await call(`/story/lane/${id}`)).status, 404);
  assert.ok(origin);
});

test('each person has their own lane: another space sees nothing', async (t) => {
  const { app } = await rig(t);
  await writeLaneStory(app, { kind: 'year', year: 2026 });
  const { dir: d2, cleanup } = tempDir();
  const other = makeApp(d2, { now: NOW });
  t.after(() => {
    other.store.close();
    cleanup();
  });
  assert.equal(laneOf(other).list().length, 0);
  assert.equal(laneOf(app).list().length, 1);
});

test('web: the Memory lane section lives in Your story with tips and no hard-coded strings', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const story = html.slice(html.indexOf('<dialog id="story"'), html.indexOf('</dialog>', html.indexOf('<dialog id="story"')));
  assert.match(story, /id="lane-pick"/);
  assert.match(story, /id="lane-write"/);
  assert.match(story, /id="lane-list"/);
  const js = readFileSync(join(ROOT, 'web', 'memory-lane.js'), 'utf8');
  assert.match(js, /export async function loadLane/);
  assert.doesNotMatch(js, /textContent = '[A-Z]/, 'strings go through t()');
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /from '\.\/memory-lane\.js'/);
});
