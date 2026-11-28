// T65 (owner, 2026-11-28: Stacy's photo look didn't show on the Look page, the style said "illustrated",
// and there was no way to remake her set): her look now on the Look page, the current look in the closet,
// the style kept with a look, a whole rebuild from her current portrait, and a plain message when the
// picture engine can't make blink/talk frames.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { cleanMeta, LOOK_PATHS, LookBuilder, type LookDeps } from '../src/look.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const jpeg = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]);
const tagOf = (b: Buffer) => b.subarray(4).toString();

/** Grok Imagine stand-in: each edit says which picture it was made from; `hold` keeps it busy. */
function fakeImagine() {
  const from: string[] = [];
  let fail = false;
  let gate: Promise<void> | undefined;
  let open = () => {};
  const fetch = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { prompt: string; image?: { url: string } };
    if (body.image) from.push(tagOf(Buffer.from(body.image.url.split(',')[1], 'base64')));
    if (gate) await gate;
    if (fail) return new Response(JSON.stringify({ error: 'limit reached' }), { status: 429 });
    return new Response(JSON.stringify({ data: [{ b64_json: jpeg(`edit${from.length}`).toString('base64') }] }));
  };
  return {
    fetch,
    from,
    fail: (on: boolean) => (fail = on),
    hold: () => (gate = new Promise<void>((r) => (open = () => ((gate = undefined), r())))),
    release: () => open(),
  };
}

/** A photo look already on disk (as Stacy's was: made, never listed in the closet). */
function photoLook(dir: string, tag = 'stacy'): void {
  const look = join(dir, 'look');
  mkdirSync(join(look, 'sara', 'frames'), { recursive: true });
  for (const rel of LOOK_PATHS) writeFileSync(join(look, rel), jpeg(rel === 'sara-portrait.jpg' || rel === 'sara-avatar.jpg' ? tag : `old-${rel}`));
  writeFileSync(join(look, 'meta.json'), JSON.stringify({ place: 'room', style: 'photo' }));
}

test('T65 cleanMeta keeps a known art style (and only a known one); tagging a closet look keeps it', () => {
  assert.deepEqual(cleanMeta({ style: 'photo', place: 'room' }), { place: 'room', style: 'photo' });
  assert.equal(cleanMeta({ style: 'oil on velvet' }).style, undefined, 'only the known styles');
  assert.equal(cleanMeta({ style: 'constructor' } as never).style, undefined, 'never an object key');
  const { dir, cleanup } = tempDir();
  try {
    photoLook(dir);
    const look = new LookBuilder({ dataDir: dir, key: async () => 'k' });
    look.keepInCloset(new Date('2026-11-28T10:00:00Z'));
    const [s] = look.saved();
    assert.equal(s.style, 'photo');
    const next = look.setMeta(s.id, { scenarios: ['work'], wear: 'a blazer' });
    assert.equal(next.style, 'photo', 'tagging the look keeps its style');
    assert.equal(look.currentMeta().style, 'photo', 'and the current look keeps it too (later pictures stay photos)');
  } finally {
    cleanup();
  }
});

test('T65 a first look is in the closet as the current one; switching and rebuilding never duplicate', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const img = fakeImagine();
  const look = new LookBuilder({ dataDir: dir, key: async () => 'k', fetch: img.fetch as never, parallel: 4 });
  await look.build(jpeg('first'), { newFace: true, place: 'room', style: 'photo' });
  assert.equal(look.saved().length, 1, 'her only look is listed');
  assert.equal(look.currentSavedId(), look.saved()[0].id, 'as the current one');
  assert.equal(look.saved()[0].style, 'photo');
  await look.build(jpeg('second'), { place: 'cafe' });
  assert.equal(look.saved().length, 2);
  const first = look.saved().find((s) => s.id !== look.currentSavedId())!;
  look.use(first.id);
  assert.equal(look.saved().length, 2, 'switching between saved looks adds none');
  await look.rebuild();
  assert.equal(look.saved().length, 2, 'a rebuild of the same portrait adds none');
  assert.equal(look.currentSavedId(), first.id);
  // The closet copy has the rebuilt pictures (wearing it later never brings the old frames back).
  const rebuilt = readFileSync(join(dir, 'look', 'sara', 'frames', 'happy-talk.jpg'));
  assert.deepEqual(readFileSync(join(dir, 'looks', first.id, 'sara', 'frames', 'happy-talk.jpg')), rebuilt);
  assert.equal(JSON.parse(readFileSync(join(dir, 'looks', first.id, 'look.json'), 'utf8')).name, first.name, 'name kept');
  assert.ok(!existsSync(join(dir, 'look-closet-new')) && !existsSync(join(dir, 'look-closet-old')), 'scratch removed');
});

test('T65 an engine that cannot edit pictures: complete and rebuild say so plainly', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const look = new LookBuilder({ dataDir: dir, key: async () => undefined, textEngine: () => ({ label: 'ComfyUI', make: async () => jpeg('comfy') }) });
  await look.build(jpeg('comfy'), { newFace: true, place: 'room' });
  assert.equal(look.noFramesEngine(), 'ComfyUI');
  assert.ok(look.missingFrames().length > 0);
  await assert.rejects(look.complete(), /This look won't blink or talk: ComfyUI can't make the extra frames\. Grok Imagine can\./);
  await assert.rejects(look.rebuild(), /ComfyUI can't make the extra frames/);
  assert.equal(look.status.state, 'done', 'nothing marked failed');
  assert.equal(new LookBuilder({ dataDir: dir, key: async () => 'k' }).noFramesEngine(), undefined, 'Grok Imagine makes frames');
});

async function rig(t: TestContext, mode: 'owner' | 'member' | 'demo' = 'owner', deps: Partial<LookDeps> = {}) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-28T10:00:00Z') });
  const img = fakeImagine();
  app.look = new LookBuilder({ dataDir: dir, key: async () => 'k', fetch: img.fetch as never, parallel: 4, ...deps }) as never;
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(mode === 'demo' ? { demo: true } : {}), ...(mode === 'member' ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Alex', status: 'active', limits: { voice: true, pictures: true } }), apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    img.release();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    app.store.close();
    cleanup();
  });
  const api = async (path: string, body?: unknown) => {
    const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const settled = async () => {
    for (let i = 0; i < 200; i++) {
      if (!['drafting', 'building'].includes((await api('/api/look')).body.status.state)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { app, dir, img, api, settled };
}

test('T65 /api/look: the current look is listed, with its style and what a rebuild makes', async (t) => {
  const { dir, api } = await rig(t);
  photoLook(dir);
  const v = (await api('/api/look')).body;
  assert.equal(v.custom, true);
  assert.equal(v.wearing.style, 'photo');
  assert.equal(v.saved.length, 1, 'a look made before the closet listed it');
  assert.equal(v.current, v.saved[0].id);
  assert.equal(v.rebuildCount, 35, '5 expressions + 6 × (blink + 4 mouths)');
  assert.equal(v.noFrames, null);
  assert.equal((await api('/api/look')).body.saved.length, 1, 'not listed twice');
});

test('T65 rebuild: confirmed, from her current portrait, one at a time, swapped in atomically', async (t) => {
  const { dir, img, api, settled } = await rig(t);
  photoLook(dir);
  const no = await api('/api/look/rebuild', {});
  assert.equal(no.status, 400);
  assert.match(no.body.error, /Confirm the 35 picture edits/);
  assert.equal(img.from.length, 0, 'nothing made before the click to confirm');
  img.hold();
  assert.equal((await api('/api/look/rebuild', { confirm: true })).status, 202);
  assert.equal((await api('/api/look')).body.status.state, 'building');
  assert.equal((await api('/api/look/rebuild', { confirm: true })).status, 409, 'one at a time');
  // While it is being made, her look is untouched.
  assert.equal(tagOf(readFileSync(join(dir, 'look', 'sara', 'frames', 'happy-talk.jpg'))), 'old-sara/frames/happy-talk.jpg');
  img.release();
  await settled();
  const v = (await api('/api/look')).body;
  assert.equal(v.status.state, 'done');
  assert.equal(v.status.total, 35);
  assert.ok(img.from.slice(0, 5).every((x) => x === 'stacy'), 'the expressions are made from her current portrait');
  assert.equal(tagOf(readFileSync(join(dir, 'look', 'sara-portrait.jpg'))), 'stacy', 'the same portrait');
  assert.notEqual(tagOf(readFileSync(join(dir, 'look', 'sara', 'frames', 'happy-talk.jpg'))), 'old-sara/frames/happy-talk.jpg', 'new frames');
  assert.equal(JSON.parse(readFileSync(join(dir, 'look', 'meta.json'), 'utf8')).style, 'photo', 'style kept');
  assert.equal(v.saved.length, 1, 'no duplicate in the closet');
  // A failed rebuild leaves the working look alone.
  const before = readFileSync(join(dir, 'look', 'sara', 'frames', 'sleepy-blink.jpg'));
  img.fail(true);
  assert.equal((await api('/api/look/rebuild', { confirm: true })).status, 202);
  await settled();
  assert.equal((await api('/api/look')).body.status.state, 'failed');
  assert.deepEqual(readFileSync(join(dir, 'look', 'sara', 'frames', 'sleepy-blink.jpg')), before);
  assert.ok(!existsSync(join(dir, 'look-new')));
});

test('T65 rebuild: owner only, never on the demo, and not for the default look', async (t) => {
  for (const mode of ['member', 'demo'] as const) {
    const { dir, img, api } = await rig(t, mode);
    photoLook(dir);
    assert.equal((await api('/api/look/rebuild', { confirm: true })).status, 403, mode);
    assert.equal(img.from.length, 0);
  }
  const { api } = await rig(t);
  const r = await api('/api/look/rebuild', { confirm: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /default look/);
});

test('T65 an engine that cannot make frames: the page is told, complete and rebuild explain', async (t) => {
  const { dir, api } = await rig(t, 'owner', { textEngine: () => ({ label: 'OpenAI images', make: async () => jpeg('o') }) });
  mkdirSync(join(dir, 'look'), { recursive: true });
  writeFileSync(join(dir, 'look', 'sara-portrait.jpg'), jpeg('only'));
  const v = (await api('/api/look')).body;
  assert.equal(v.noFrames, 'OpenAI images');
  assert.ok(v.missing > 0);
  for (const path of ['/api/look/complete', '/api/look/rebuild']) {
    const r = await api(path, { confirm: true });
    assert.equal(r.status, 400, path);
    assert.match(r.body.error, /This look won't blink or talk: OpenAI images can't make the extra frames\. Grok Imagine can\./);
  }
});

test('T65 the Look page: her look now, the style picker set from her look, her face drawn again', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const page = html.slice(html.indexOf('data-page="her-look"'), html.indexOf('id="look-desc"'));
  for (const id of ['look-now-img', 'look-now-made', 'look-now-moves', 'look-rebuild', 'look-rebuild-ask', 'look-rebuild-go']) assert.ok(page.includes(`id="${id}"`), `${id} at the top of the Look page`);
  assert.match(page, /src="\/sara-portrait\.jpg"/);
  const js = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  const now = js.slice(js.indexOf('function renderLookNow('), js.indexOf("$('#look-style').addEventListener"));
  assert.match(now, /w\.style/);
  assert.match(now, /styleSel\.value = w\.style/, 'the style dropdown follows her look');
  assert.match(now, /sara-portrait\.jpg\$\{state\.lookVersion/);
  assert.match(now, /Moves: blinks, moods and talking/);
  assert.match(now, /l\.noFrames/);
  const refresh = js.slice(js.indexOf('async function refreshLook('), js.indexOf('function renderLookNow('));
  assert.match(refresh, /renderLookNow\(l, busy\)/);
  const changed = js.slice(js.indexOf('function lookChanged('), js.indexOf("$('#look-draft').addEventListener"));
  assert.match(changed, /loadCompanions\(\)\.then\(\(\) => state\.lastFace && setFace\(state\.lastFace\)/, 'ownLook reloaded, her face drawn again');
  const rebuild = js.slice(js.indexOf("$('#look-rebuild').addEventListener"), js.indexOf('// Phase 21: outfits and saved looks.'));
  assert.match(rebuild, /rebuildCount/, 'the count is shown before it starts');
  assert.match(rebuild, /\/look\/rebuild', \{ method: 'POST', body: \{ confirm: true \}/);
  const complete = js.slice(js.indexOf("$('#look-complete').addEventListener"), js.indexOf("$('#look-use').addEventListener"));
  assert.match(complete, /noFrames/);
});
