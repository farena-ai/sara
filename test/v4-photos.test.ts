// V4.1 Photo library search (docs/PHOTO_LIBRARY.md): index a folder the owner picks, on this
// computer only: places from EXIF GPS (an offline city table), captions and the text in each photo
// from a picture model ON THIS COMPUTER, people the owner names, search by words, made-for-you
// albums shown in Our moments. Acceptance: fake images with fake captions/EXIF are found by place
// and text; nothing leaves (no cloud model is ever sent a photo, no network code in the module).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { closePhotoLibraries, describeNext, photoLibraryTick, madeAlbums, parseDescription, photoLibraryOf, photoReader, placeName, readExif } from '../src/photo-library.ts';
import { createSaraServer } from '../src/server.ts';
import type { ChatRequest, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { fakeJpeg, fakePng } from './fixtures/v4-photos.ts';
import { makeApp, tempDir } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const NOW = new Date('2026-11-18T15:00:00Z');

const LOCAL: ProviderConfig = { id: 'here', label: 'On this PC', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true };
const CLOUD: ProviderConfig = { id: 'cloud', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1' };

/** What the fake picture model "sees" in each test picture (keyed by the tag inside the JPEG). */
const SEES: Record<string, string> = {
  beach1: '{"caption":"Two people on a sunny beach with yellow umbrellas","text":"","things":["beach","umbrella","sea"]}',
  beach2: '{"caption":"A tram going up a steep street","text":"28 Prazeres","things":["tram","street"]}',
  beach3: '{"caption":"Grilled sardines on a plate","text":"","things":["food","fish"]}',
  receipt: '{"caption":"A paper receipt on a desk","text":"CORNER CAFE\\nTotal 42.50\\nThank you","things":["receipt"]}',
  png: '{"caption":"A screenshot of a calendar app","text":"Dentist Tuesday 3 PM","things":["screenshot"]}',
};

function rig(t: TestContext, providers: ProviderConfig[] = [LOCAL], vision: { providerId: string; model: string } = { providerId: 'here', model: 'gemma4:12b' }) {
  const { dir, cleanup } = tempDir();
  const clock = { now: NOW };
  const app = makeApp(dir, clock);
  const asked: { provider: string; req: ChatRequest }[] = [];
  app.providerFactory = (config) => ({
    config,
    listModels: async () => ['gemma4:12b'],
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      asked.push({ provider: config.id, req });
      const last = req.messages.at(-1) as { images?: { data: string }[] } | undefined;
      const img = last?.images?.[0];
      const bytes = img ? Buffer.from(img.data, 'base64').toString('latin1') : '';
      const key = Object.keys(SEES).find((k) => bytes.includes(k)) ?? (bytes.startsWith('\x89PNG') ? 'png' : '');
      yield { type: 'text', text: key ? SEES[key] : '{"caption":"A photo","text":"","things":[]}' };
    },
  });
  app.settings.update({ providers: providers, defaultProviderId: providers[0].id, defaultModel: vision.model, routes: { vision }, timeZone: 'America/Chicago', ownerName: 'Alex' } as never);
  const photos = join(dir, 'fake-photos');
  mkdirSync(join(photos, 'Trips', 'Lisbon'), { recursive: true });
  mkdirSync(join(photos, '.thumbnails'), { recursive: true });
  // Three photos in Lisbon over two days (a trip), a receipt in Chicago, a screenshot without EXIF.
  writeFileSync(join(photos, 'Trips', 'Lisbon', 'IMG_0001.jpg'), fakeJpeg({ date: '2024:05:11 10:12:00', lat: 38.7139, lon: -9.1394, make: 'FakeCam', model: 'F1', tag: 'beach1' }));
  writeFileSync(join(photos, 'Trips', 'Lisbon', 'IMG_0002.jpg'), fakeJpeg({ date: '2024:05:11 16:40:00', lat: 38.7101, lon: -9.1450, bigEndian: true, tag: 'beach2' }));
  writeFileSync(join(photos, 'Trips', 'Lisbon', 'IMG_0003.JPG'), fakeJpeg({ date: '2024:05:12 20:05:00', lat: 38.7170, lon: -9.1330, tag: 'beach3' }));
  writeFileSync(join(photos, 'receipt.jpg'), fakeJpeg({ date: '2025:02:03 12:00:00', lat: 41.8789, lon: -87.6359, tag: 'receipt' }));
  writeFileSync(join(photos, 'Screenshot 2025-03-04.png'), fakePng());
  writeFileSync(join(photos, '.thumbnails', 'skip.jpg'), fakeJpeg({ tag: 'hidden' }));
  writeFileSync(join(photos, 'notes.txt'), 'not a photo');
  t.after(() => {
    closePhotoLibraries();
    app.store.close();
    cleanup();
  });
  return { app, dir, photos, asked, clock };
}

test('V4.1 EXIF: date, camera and GPS from both byte orders; junk is no EXIF', () => {
  const a = readExif(fakeJpeg({ date: '2024:05:11 10:12:00', lat: 38.7139, lon: -9.1394, make: 'FakeCam', model: 'F1' }));
  assert.equal(a.takenAt, '2024-05-11T10:12:00');
  assert.equal(a.camera, 'FakeCam F1');
  assert.ok(Math.abs(a.lat! - 38.7139) < 0.001 && Math.abs(a.lon! + 9.1394) < 0.001, JSON.stringify(a));
  const b = readExif(fakeJpeg({ date: '2023:12:31 23:59:59', lat: -33.86, lon: 151.21, bigEndian: true }));
  assert.equal(b.takenAt, '2023-12-31T23:59:59');
  assert.ok(b.lat! < -33 && b.lon! > 151);
  assert.deepEqual(readExif(fakePng()), {});
  assert.deepEqual(readExif(Buffer.from('not a picture at all')), {});
  // A truncated APP1 never throws.
  assert.deepEqual(readExif(fakeJpeg({ date: '2024:01:01 00:00:00' }).subarray(0, 30)), {});
});

test('V4.1 places: offline city names, a named place wins nearby, the open sea has no name', () => {
  assert.deepEqual(placeName(38.7139, -9.1394), { place: 'Lisbon', country: 'Portugal' });
  assert.deepEqual(placeName(41.8789, -87.6359), { place: 'Chicago', country: 'United States' });
  assert.deepEqual(placeName(41.8789, -87.6359, [{ name: 'Home', lat: 41.88, lon: -87.636, radiusKm: 1 }]), { place: 'Home', country: 'United States' });
  assert.deepEqual(placeName(0, -30), { place: '', country: '' });
});

test('V4.1 describe answers: JSON or loose lines become caption, text and things', () => {
  assert.deepEqual(parseDescription('```json\n{"caption":"A dog","text":"STOP","things":["dog","sign"]}\n```'), { caption: 'A dog', text: 'STOP', things: ['dog', 'sign'] });
  assert.deepEqual(parseDescription('A cat asleep on a sofa.'), { caption: 'A cat asleep on a sofa.', text: '', things: [] });
});

test('V4.1 acceptance: a fake folder is indexed on this computer and found by place, text, date and people', async (t) => {
  const { app, photos, asked } = rig(t);
  const lib = photoLibraryOf(app);
  lib.setFolder(photos);
  const first = await lib.scan();
  assert.deepEqual({ added: first.added, removed: first.removed }, { added: 5, removed: 0 }, 'hidden folders and non-photos are skipped');
  // Places and dates come from EXIF before any model looked.
  assert.deepEqual(lib.search('lisbon').map((p) => p.name).sort(), ['IMG_0001.jpg', 'IMG_0002.jpg', 'IMG_0003.JPG']);
  assert.deepEqual(lib.search('portugal 2024').length, 3);
  assert.deepEqual(lib.search('chicago').map((p) => p.name), ['receipt.jpg']);
  assert.equal(lib.search('may 2024').length, 3);
  // The picture model on this computer writes captions and copies the text in each photo.
  assert.equal(photoReader(app)?.model, 'gemma4:12b');
  let n = 0;
  while ((await describeNext(app, 2)) > 0) n++;
  assert.ok(n >= 3);
  assert.equal(lib.status().described, 5);
  assert.ok(asked.every((a) => a.provider === 'here'));
  assert.deepEqual(lib.search('total 42.50').map((p) => p.name), ['receipt.jpg'], 'found by the text in the photo');
  assert.deepEqual(lib.search('corner cafe').map((p) => p.name), ['receipt.jpg']);
  assert.deepEqual(lib.search('dentist').map((p) => p.name), ['Screenshot 2025-03-04.png']);
  assert.deepEqual(lib.search('umbrellas').map((p) => p.name), ['IMG_0001.jpg'], 'plural/singular and caption words');
  assert.deepEqual(lib.search('tram lisbon').map((p) => p.name), ['IMG_0002.jpg'], 'every word must match, across fields');
  assert.equal(lib.search('zebra').length, 0);
  // People you name.
  const beach = lib.search('beach')[0];
  lib.setPeople(beach.id, ['Maria', 'Alex']);
  assert.deepEqual(lib.search('maria').map((p) => p.id), [beach.id]);
  assert.deepEqual(lib.people(), [{ name: 'Alex', count: 1 }, { name: 'Maria', count: 1 }]);
  lib.renamePerson('Maria', 'Maria Silva');
  assert.deepEqual(lib.search('silva').map((p) => p.id), [beach.id]);
  // Made-for-you albums: the trip (3+ photos at one place within a few days) and each named person.
  const albums = madeAlbums(lib, 'America/Chicago');
  const trip = albums.find((a) => a.kind === 'trip');
  assert.ok(trip, JSON.stringify(albums));
  assert.equal(trip.title, 'Lisbon, May 2024');
  assert.equal(trip.ids.length, 3);
  assert.ok(albums.some((a) => a.kind === 'person' && a.title === 'Maria Silva'));
  // A second scan adds nothing; a removed file leaves the index, a changed one is looked at again.
  assert.equal((await lib.scan()).added, 0);
  rmSync(join(photos, 'receipt.jpg'));
  const p2 = join(photos, 'Trips', 'Lisbon', 'IMG_0003.JPG');
  writeFileSync(p2, fakeJpeg({ date: '2024:05:12 20:05:00', lat: 38.717, lon: -9.133, tag: 'beach3-edited' }));
  utimesSync(p2, new Date('2026-01-01'), new Date('2026-01-01'));
  const again = await lib.scan();
  assert.deepEqual({ added: again.added, changed: again.changed, removed: again.removed }, { added: 0, changed: 1, removed: 1 });
  assert.equal(lib.search('total').length, 0);
  assert.equal(lib.status().waiting, 1);
});

test('V4.1 nothing leaves: with only a cloud picture model no photo is ever sent; the module has no network code', async (t) => {
  const { app, photos, asked } = rig(t, [CLOUD], { providerId: 'cloud', model: 'gpt-vision' });
  const lib = photoLibraryOf(app);
  lib.setFolder(photos);
  await lib.scan();
  assert.equal(photoReader(app), null);
  assert.equal(await describeNext(app, 5), 0);
  assert.equal(asked.length, 0, 'the cloud model was never asked');
  assert.equal(lib.status().reader, null);
  assert.equal(lib.search('lisbon').length, 3, 'places still work without any model');
  // A cloud model name served through a local Ollama (":cloud") is not on this computer either.
  app.settings.update({ providers: [LOCAL], routes: { vision: { providerId: 'here', model: 'gemma4:31b-cloud' } } } as never);
  assert.equal(photoReader(app), null);
  const src = read('src/photo-library.ts') + read('src/routes/photo-library.ts') + read('src/photo-places.ts');
  assert.doesNotMatch(src, /\bfetch\(|netFetch|node:https|node:net\b|node:dgram|WebSocket|\.request\(/);
});

test('V4.1 tick: never creates the index by itself; looks through the folder, then describes a couple of photos', async (t) => {
  const { app, dir, photos } = rig(t);
  photoLibraryTick(app);
  assert.equal(existsSync(join(dir, 'photo-library')), false);
  const lib = photoLibraryOf(app);
  lib.setFolder(photos);
  photoLibraryTick(app);
  assert.equal(lib.scanning, true);
  await lib.scan();
  assert.equal(lib.status().total, 5);
  photoLibraryTick(app);
  assert.equal(lib.describing, true);
  while (lib.describing) await new Promise((r) => setTimeout(r, 5));
  assert.equal(lib.status().described, 2);
});

test('V4.1 routes: owner picks a folder, scans, searches and opens a photo; never a file outside the folder', async (t) => {
  const { app, dir, photos } = rig(t);
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/moments/folder`;
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, type: res.headers.get('content-type') ?? '', json: res.headers.get('content-type')?.includes('json') ? ((await res.json()) as Record<string, any>) : null, res };
  };
  const s0 = await call('');
  assert.equal(s0.status, 200);
  assert.equal(s0.json!.folder, null);
  assert.equal((await call('', 'PUT', { folder: join(dir, 'nope') })).status, 400);
  assert.equal((await call('', 'PUT', { folder: 'relative/path' })).status, 400);
  const set = await call('', 'PUT', { folder: photos });
  assert.equal(set.status, 200);
  assert.equal(set.json!.folder, photos);
  const sc = await call('/scan', 'POST', {});
  assert.equal(sc.status, 200);
  assert.equal(sc.json!.added, 5);
  const found = await call('/search?q=lisbon');
  assert.equal(found.json!.items.length, 3);
  const one = found.json!.items[0];
  assert.equal(one.place, 'Lisbon');
  assert.equal(typeof one.path, 'undefined', 'the page never gets file paths');
  const pic = await call(`/photo/${one.id}`);
  assert.equal(pic.status, 200);
  assert.equal(pic.type, 'image/jpeg');
  assert.equal((await call('/photo/9999')).status, 404);
  assert.equal((await call('/photo/..%2F..%2Fsara.db')).status, 404);
  assert.equal((await call(`/${one.id}/people`, 'PUT', { people: ['Maria'] })).status, 200);
  assert.equal((await call('/search?q=maria')).json!.items.length, 1);
  const albums = await call('/albums');
  assert.ok(albums.json!.albums.some((a: { title: string }) => a.title === 'Lisbon, May 2024'));
  assert.equal((await call('/places', 'POST', { name: 'Home', lat: 41.88, lon: -87.636, radiusKm: 1 })).status, 200);
  assert.ok((await call('/search?q=home')).json!.items.length >= 1, 'a named place renames photos near it');
  // A household member never reaches the owner's disk.
  app.member = { id: 'm1' } as never;
  assert.equal((await call('')).status, 403);
  delete (app as { member?: unknown }).member;
  const off = await call('', 'DELETE');
  assert.equal(off.status, 200);
  assert.equal((await call('')).json!.total, 0, 'Forget the index drops every row; the photos stay');
  assert.ok(readFileSync(join(photos, 'receipt.jpg')).length > 0);
});

test('V4.1 web: a section in Our moments, a Settings section with tips, strings in every language', () => {
  const html = read('web/index.html');
  for (const id of ['mo-photos', 'mo-ph-q', 'mo-ph-results', 'mo-ph-albums', 'lib-photos-folder', 'lib-photos-scan', 'lib-photos-forget'])
    assert.match(html, new RegExp(`id="${id}"`), id);
  const tips = JSON.parse(read('web/tips.json')) as { tips: Record<string, unknown> } & Record<string, unknown>;
  const all = JSON.stringify(tips);
  assert.match(all, /"lib-photos-folder"/);
  const js = read('web/photo-folder.js');
  assert.match(js, /api\('\/moments\/folder/);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) assert.match(read(`web/i18n/${lang}.json`), /"Search your photos"/, lang);
});
