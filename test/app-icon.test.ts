// Ownicon: the companion's own app icon, made on the server (src/app-icon.ts): every size the apps
// use, a .ico, an ETag that changes with her look and name, a monogram for a renamed companion
// without a picture (never Sara's face), per companion on a multi-companion server, Sara's own art
// while signed out, and the web app's manifest / favicon / notification icon pointing at it.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { appFaceOf } from '../src/app-face.ts';
import { appIconInfo, appIconPng, decodePng, encodePngRgba, initialOf } from '../src/app-icon.ts';
import { OwnerAuth } from '../src/auth.ts';
import { CompanionManager, CompanionSettings, LinkedToolRegistry, MAIN_ID, type Companion } from '../src/companions.ts';
import { defaultLookFile, defaultLookFor } from '../src/default-look.ts';
import { LookBuilder } from '../src/look.ts';
import { createSaraServer, pickCompanion } from '../src/server.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

const WEB = join(ROOT, 'web');
const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-16T12:00:00Z') };
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const companions = new CompanionManager(dir);
const mainApp = makeApp(dir, clock);
const lookFor = (app: TestApp) => new LookBuilder({ dataDir: app.dataDir, key: async () => undefined, builtin: (rel) => defaultLookFile(WEB, rel, defaultLookFor(app.settings.get().defaultLook, app.persona.pronouns)) }) as never;

function build(id: string, cdir: string): Companion {
  const app: TestApp = id === MAIN_ID ? mainApp : makeApp(cdir, clock);
  if (id !== MAIN_ID) {
    app.settings = new CompanionSettings(cdir, mainApp.settings);
    app.tools = new LinkedToolRegistry(mainApp.tools);
    app.persona = { ...mainApp.persona, name: 'Mia', pronouns: 'she' };
  }
  app.look = lookFor(app);
  app.rootDir = dir;
  app.companionId = id;
  app.companions = companions;
  return { id, app, server: createSaraServer({ app, auth, webDir: WEB, companions }), start() {}, async stop() {} };
}
companions.build = build;
companions.add(build(MAIN_ID, dir));
const miaDir = join(dir, 'companions-test', 'mia');
mkdirSync(miaDir, { recursive: true });
companions.add(build('mia', miaDir));
const front: Server = createServer((req, res) => void pickCompanion(companions, req).server.emit('request', req, res));
let base = '';
before(async () => {
  mainApp.settings.update({ disclosureAcceptedAt: clock.now.toISOString(), setupDone: true } as never);
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
});
after(() => {
  front.close();
  for (const c of companions.all()) c.app.store.close();
  cleanup();
});

const get = async (path: string, opts: { signedIn?: boolean; companion?: string; etag?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (opts.signedIn !== false) headers.authorization = `Bearer ${token}`;
  if (opts.companion) headers['x-sara-companion'] = opts.companion;
  if (opts.etag) headers['if-none-match'] = opts.etag;
  const r = await fetch(base + path, { headers });
  return { status: r.status, etag: r.headers.get('etag') ?? '', kind: r.headers.get('x-sara-icon') ?? '', type: r.headers.get('content-type') ?? '', body: Buffer.from(await r.arrayBuffer()) };
};
const png = (b: Buffer) => {
  const d = decodePng(b);
  assert.ok(d, 'a PNG we can read back');
  return d!;
};
const pixel = (img: { w: number; px: Uint8Array }, x: number, y: number) => [...img.px.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 4)];
const rename = (name: string, pronouns = 'she') => {
  mainApp.persona = { ...mainApp.persona, name, pronouns } as never;
};

test('every size the apps use, square PNGs, rounded corners; a .ico with 16…256 frames', async () => {
  rename('Hank');
  for (const s of [16, 24, 32, 48, 64, 256]) {
    const r = await get(`/app-icon.png?s=${s}`);
    assert.equal(r.status, 200);
    assert.equal(r.type, 'image/png');
    const img = png(r.body);
    assert.deepEqual([img.w, img.h], [s, s], `size ${s}`);
    assert.ok(pixel(img, 0, 0)[3] < 128, 'a rounded corner is see-through');
    assert.equal(pixel(img, s >> 1, 1)[3], 255);
  }
  assert.equal(png((await get('/app-icon.png?s=30')).body).w, 32, 'other sizes snap up');
  assert.equal(png((await get('/app-icon.png?s=9999')).body).w, 512);
  const sq = png((await get('/app-icon.png?s=180&shape=square')).body);
  assert.equal(pixel(sq, 0, 0)[3], 255, 'square (apple-touch-icon): no see-through corners');
  const ico = await get('/app-icon.ico');
  assert.equal(ico.type, 'image/x-icon');
  const n = ico.body.readUInt16LE(4);
  assert.equal(ico.body.readUInt16LE(2), 1);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + 16 * i;
    const len = ico.body.readUInt32LE(e + 8), at = ico.body.readUInt32LE(e + 12);
    const frame = png(ico.body.subarray(at, at + len));
    sizes.push(frame.w);
    assert.equal(ico.body[e] || 256, frame.w);
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
});

test('renamed with Sara\'s default look: a monogram with her initial, never Sara\'s face', async () => {
  rename('Hank');
  const face = (await (await fetch(`${base}/api/session`, { headers: { authorization: `Bearer ${token}` } })).json()) as { face: { kind: string; src: string; icon: string; iconVersion: string } };
  assert.equal(face.face.kind, 'initial');
  assert.equal(face.face.icon, '/app-icon.png');
  assert.match(face.face.src, /^\/app-icon\.png/);
  assert.ok(face.face.iconVersion);
  const r = await get('/app-icon.png?s=256');
  assert.equal(r.kind, 'initial');
  const sara = await get('/app-icon.png?s=256', { signedIn: false });
  assert.equal(sara.kind, 'builtin');
  assert.notDeepEqual(r.body, sara.body);
  // The theme's accent gradient behind a white letter.
  const img = png(r.body);
  const bg = pixel(img, 30, 30);
  assert.ok(bg[0] > 180 && bg[2] > 90 && bg[3] === 255, `accent background ${bg}`);
  let white = 0;
  for (let i = 0; i < img.px.length; i += 4) if (img.px[i] > 245 && img.px[i + 1] > 245 && img.px[i + 2] > 245) white++;
  assert.ok(white > 1500, `the letter is drawn (${white} white pixels)`);
  // Another name, another letter.
  rename('Zoe');
  assert.notDeepEqual((await get('/app-icon.png?s=256')).body, r.body);
  assert.equal(initialOf('Élodie'), 'E');
  assert.equal(initialOf('  hank'), 'H');
  assert.equal(initialOf('さくら'), '', 'no drawable letter: a neutral sparkle');
  rename('さくら');
  assert.equal((await get('/app-icon.png?s=64')).kind, 'initial');
});

test('ETag: 304 until her name or look changes; Sara with her own look keeps her app icon', async () => {
  rename('Hank');
  const a = await get('/app-icon.png?s=64');
  assert.equal((await get('/app-icon.png?s=64', { etag: a.etag })).status, 304);
  assert.notEqual((await get('/app-icon.png?s=32')).etag, a.etag, 'one ETag per size');
  rename('Hannah');
  const b = await get('/app-icon.png?s=64', { etag: a.etag });
  assert.equal(b.status, 200, 'a rename changes it');
  rename('Sara');
  const s = await get('/app-icon.png?s=64');
  assert.equal(s.kind, 'builtin');
  assert.equal(appFaceOf({ ...mainApp, companionId: MAIN_ID }).kind, 'builtin');
  // A he default look: his face.
  rename('Fred', 'he');
  const he = await get('/app-icon.png?s=64');
  assert.equal(he.kind, 'face');
  rename('Hank');
});

test('an uploaded picture becomes the icon (cropped square), and a new one changes the version', async () => {
  rename('Hank');
  const w = 120, h = 160;
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i += 4) [px[i], px[i + 1], px[i + 2], px[i + 3]] = [20, 160, 90, 255];
  writeFileSync(join(dir, 'avatar.png'), encodePngRgba({ w, h, px }));
  try {
    const v1 = appIconInfo(mainApp).version;
    const r = await get('/app-icon.png?s=256');
    assert.equal(r.kind, 'face');
    const c = pixel(png(r.body), 128, 128);
    assert.ok(Math.abs(c[0] - 20) < 3 && Math.abs(c[1] - 160) < 3 && Math.abs(c[2] - 90) < 3, `her picture's colour ${c}`);
    for (let i = 0; i < px.length; i += 4) px[i] = 200;
    writeFileSync(join(dir, 'avatar.png'), encodePngRgba({ w, h, px }));
    const t = new Date(Date.now() + 5000);
    (await import('node:fs')).utimesSync(join(dir, 'avatar.png'), t, t);
    assert.notEqual(appIconInfo(mainApp).version, v1);
    // A picture we can't read (WebP) gives the monogram, not a broken icon.
    rmSync(join(dir, 'avatar.png'));
    writeFileSync(join(dir, 'avatar.webp'), Buffer.from('RIFF\0\0\0\0WEBPVP8 '));
    assert.equal((await get('/app-icon.png?s=48')).kind, 'initial');
  } finally {
    for (const f of ['avatar.png', 'avatar.webp']) rmSync(join(dir, f), { force: true });
  }
});

test('per companion: each one\'s own icon on one server; signed out shows nobody\'s', async () => {
  rename('Hank');
  const hank = await get('/app-icon.png?s=128');
  const mia = await get('/app-icon.png?s=128', { companion: 'mia' });
  assert.equal(mia.kind, 'initial');
  assert.notDeepEqual(mia.body, hank.body, 'M, not H');
  assert.equal(appIconPng(companions.get('mia')!.app as never, WEB, 128).etag, mia.etag);
  const out = await get('/app-icon.png?s=128', { signedIn: false, companion: 'mia' });
  assert.equal(out.kind, 'builtin', 'the sign-in page shows Sara\'s own art, nothing about her');
  assert.deepEqual(out.body, (await get('/app-icon.png?s=128', { signedIn: false })).body);
});

test('the installed web app: manifest icons are hers while signed in, Sara\'s art for the sign-in page', async () => {
  rename('Hank');
  const m = (await (await fetch(`${base}/manifest.webmanifest`, { headers: { authorization: `Bearer ${token}` } })).json()) as { name: string; icons: { src: string; purpose?: string }[] };
  assert.equal(m.name, 'Hank');
  assert.deepEqual(m.icons.map((i) => i.src), ['/app-icon.png?s=192', '/app-icon.png?s=512', '/app-icon.png?s=512&shape=maskable']);
  const pub = (await (await fetch(`${base}/manifest.webmanifest`)).json()) as { icons: { src: string }[] };
  assert.ok(pub.icons.every((i) => !i.src.startsWith('/app-icon')));
  const mask = png((await get('/app-icon.png?s=512&shape=maskable')).body);
  assert.equal(pixel(mask, 0, 0)[3], 255, 'maskable: full bleed');
});

test('static: favicon, apple-touch-icon and the notification icon point at /app-icon.png', () => {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8');
  assert.match(html, /<link rel="icon" href="\/app-icon\.png\?s=64"/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/app-icon\.png\?s=180&amp;shape=square">/);
  const sw = readFileSync(join(WEB, 'sw.js'), 'utf8');
  assert.match(sw, /icon: '\/app-icon\.png\?s=192'/);
  // The offline page keeps a cached file (the worker can't make icons without the server).
  assert.match(sw, /'\/icon-192\.png'/);
});
