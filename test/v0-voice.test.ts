// ROADMAP_V V0.1 + V0.2 (docs/VOICE_FIRST.md "Engines stay loaded" + "Words as you speak"):
// the loaded-engine helper ships prebuilt for Windows and Mac servers (placed next to the sherpa
// tools by the voice install), and an optional streaming (online) hearing model gives partial words
// while you speak, through the same helper. A fake engine (test/fixtures/fake-voice-worker.mjs).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { cleanTalk } from '../src/talk.ts';
import { LocalVoiceEngine, type VoiceManifest } from '../src/voice.ts';
import { installItems, installVoice, placeWorker, runVoiceCli, SHERPA_BUNDLES, shippedWorker, STREAM_MODEL, voiceManifest, workerTarget } from '../src/voice-install.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const FAKE = join(ROOT, 'test', 'fixtures', 'fake-voice-worker.mjs');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const SHERPA_WIN = 'sherpa-onnx-v1.13.8-win-x64-shared-MD-Release';

/** A voice folder with the manifest (and the streaming model when `online`), no real models. */
function voiceDir(dir: string, online = true): string {
  const v = join(dir, 'voice');
  mkdirSync(join(v, SHERPA_WIN, 'bin'), { recursive: true });
  writeFileSync(join(v, 'voice.json'), JSON.stringify(voiceManifest(SHERPA_WIN, { online })));
  return v;
}
const engine = (dir: string, v: string, idle = 60_000, log?: string) =>
  new LocalVoiceEngine(v, dir, { warm: { idleMs: () => idle, worker: [process.execPath, FAKE], env: log ? { FAKE_WORKER_LOG: log } : {}, minFreeMb: 0 } });
const pcm = (sec: number, value = 1000) => {
  const b = Buffer.alloc(Math.round(sec * 16000) * 2);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(value, i);
  return b;
};

test('V0.2: the streaming model is pinned like the others and goes into voice.json only when installed', () => {
  assert.match(STREAM_MODEL.path, /^asr-models\/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms-int8\.tar\.bz2$/);
  assert.match(STREAM_MODEL.sha256, /^[0-9a-f]{64}$/);
  // The Linux shell script pins the same file and hash.
  const sh = read('deploy/install-voice.sh');
  assert.ok(sh.includes(`STREAM_DIR=${STREAM_MODEL.path.slice('asr-models/'.length, -'.tar.bz2'.length)}`) && sh.includes(`"asr-models/$STREAM_DIR.tar.bz2|${STREAM_MODEL.sha256}"`), 'install-voice.sh pins the same streaming model');
  assert.match(sh, /--streaming\)/);
  assert.equal(voiceManifest(SHERPA_WIN).online, undefined);
  const m = voiceManifest(SHERPA_WIN, { online: true });
  assert.deepEqual(Object.keys(m.online!).sort(), ['decoder', 'encoder', 'joiner', 'kind', 'tokens']);
  assert.ok(m.online!.encoder.startsWith('sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms-int8/'));
  // Only the streaming model when the rest is there; everything plus it otherwise.
  assert.deepEqual(installItems('win32', 'x64', { streaming: 'only' })!.map((i) => i.path), [STREAM_MODEL.path]);
  assert.equal(installItems('win32', 'x64', { streaming: 'add' })!.at(-1), STREAM_MODEL);
  assert.equal(installItems('win32', 'x64')!.includes(STREAM_MODEL), false);
});

test('V0.1: the shipped helper is found by sherpa version and platform, copied next to the sherpa tools once', () => {
  const { dir, cleanup } = tempDir();
  try {
    assert.equal(workerTarget('win32', 'x64'), 'win32-x64');
    assert.equal(workerTarget('darwin', 'arm64'), 'darwin-universal');
    assert.equal(workerTarget('darwin', 'x64'), 'darwin-universal');
    assert.equal(workerTarget('win32', 'arm64'), undefined, 'no arm64 Windows build yet: one-shot path');
    assert.equal(workerTarget('linux', 'x64'), undefined, 'Linux builds it in install-voice.sh');
    const root = join(dir, 'server');
    const shipped = join(root, 'voice-helper', 'sherpa-onnx-v1.13.8', 'win32-x64', 'sara-voice-worker.exe');
    assert.equal(shippedWorker(root, SHERPA_WIN, 'win32', 'x64'), undefined);
    mkdirSync(join(shipped, '..'), { recursive: true });
    writeFileSync(shipped, 'helper-1');
    assert.equal(shippedWorker(root, SHERPA_WIN, 'win32', 'x64'), shipped);
    // Another sherpa release: the helper doesn't match its C structs, so it isn't used.
    assert.equal(shippedWorker(root, 'sherpa-onnx-v1.14.0-win-x64-shared-MD-Release', 'win32', 'x64'), undefined);
    const v = voiceDir(dir);
    const opts = { root, platform: 'win32' as const, arch: 'x64' };
    assert.equal(placeWorker(v, SHERPA_WIN, opts), 'placed');
    const bin = join(v, SHERPA_WIN, 'bin', 'sara-voice-worker.exe');
    assert.equal(readFileSync(bin, 'utf8'), 'helper-1');
    assert.equal(placeWorker(v, SHERPA_WIN, opts), 'current');
    writeFileSync(shipped, 'helper-2'); // a newer Sara ships a rebuilt helper
    assert.equal(placeWorker(v, SHERPA_WIN, opts), 'placed');
    assert.equal(readFileSync(bin, 'utf8'), 'helper-2');
    assert.equal(placeWorker(v, SHERPA_WIN, { ...opts, arch: 'arm64' }), 'none');
    // voice.json may name the bundle by its full path (a hand-made setup): placed there too.
    const abs = join(dir, 'elsewhere', SHERPA_WIN);
    mkdirSync(join(abs, 'bin'), { recursive: true });
    assert.equal(placeWorker(v, abs, opts), 'placed');
    assert.ok(existsSync(join(abs, 'bin', 'sara-voice-worker.exe')));
  } finally {
    cleanup();
  }
});

test('V0.1/V0.2: installVoice adds only the streaming model when asked, keeps the rest, places the helper', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const v = voiceDir(dir, false);
    const root = join(dir, 'server');
    const shipped = join(root, 'voice-helper', 'sherpa-onnx-v1.13.8', 'win32-x64', 'sara-voice-worker.exe');
    mkdirSync(join(shipped, '..'), { recursive: true });
    writeFileSync(shipped, 'helper');
    for (const d of ['sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8', 'kokoro-en-v0_19', 'vits-piper-en_US-hfc_female-medium']) mkdirSync(join(v, d));
    const body = Buffer.from('fake streaming tarball');
    const { createHash } = await import('node:crypto');
    const fetched: string[] = [];
    const fakeFetch = (async (url: string) => (fetched.push(String(url)), new Response(body))) as unknown as typeof fetch;
    const untar = async (_file: string, into: string) => void mkdirSync(join(into, 'sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms-int8'), { recursive: true });
    const pinned = { ...STREAM_MODEL, sha256: createHash('sha256').update(body).digest('hex') };
    const r = await installVoice(v, { platform: 'win32', arch: 'x64', fetch: fakeFetch, untar, streaming: 'only', items: [pinned], helperRoot: root });
    assert.deepEqual(r.installed, ['sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms-int8']);
    assert.equal(fetched.length, 1);
    const m = JSON.parse(readFileSync(join(v, 'voice.json'), 'utf8')) as VoiceManifest;
    assert.ok(m.online, 'voice.json now names the streaming model');
    assert.ok(m.stt && m.voices.length, 'hearing and voices kept');
    assert.ok(existsSync(join(v, SHERPA_WIN, 'bin', 'sara-voice-worker.exe')), 'helper placed');
    // A later plain install keeps the streaming model in voice.json (its folder is there).
    await installVoice(v, { platform: 'win32', arch: 'x64', fetch: fakeFetch, untar, items: [], helperRoot: root });
    assert.ok((JSON.parse(readFileSync(join(v, 'voice.json'), 'utf8')) as VoiceManifest).online);
  } finally {
    cleanup();
  }
});

test('V0.2: `sara voice install --streaming`, and the Linux hint', async () => {
  const out: string[] = [];
  let asked: unknown;
  const code = await runVoiceCli(['install', '--streaming'], { platform: 'win32', voiceDir: 'x', log: (s) => out.push(s), install: (async (_d: string, o: { streaming?: string }) => ((asked = o.streaming), { installed: ['s'], manifest: voiceManifest(SHERPA_WIN) })) as never });
  assert.equal(code, 0);
  assert.equal(asked, 'add');
  const lin: string[] = [];
  await runVoiceCli(['install', '--streaming'], { platform: 'linux', voiceDir: 'x', log: (s) => lin.push(s) });
  assert.match(lin.join('\n'), /install-voice\.sh --streaming/);
});

test('V0.2: streaming hearing: partial words, endpoint, final text, pieces of at most half a second', async (t) => {
  const { dir, cleanup } = tempDir();
  const log = join(dir, 'w.log');
  const v = voiceDir(dir);
  const e = engine(dir, v, 60_000, log);
  t.after(() => (e.stopWorkers(), cleanup()));
  assert.equal(e.streamingReady(), true);
  const a = await e.hear('s1', pcm(0.5), false);
  assert.deepEqual(a, { text: 'w1 w2', endpoint: false, loaded: false });
  const b = await e.hear('s1', pcm(1.2), false); // split into 0.5 + 0.5 + 0.2 s pieces
  assert.equal(b.text, 'w1 w2 w3 w4 w5 w6');
  const pieces = readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('piece s1')).map((l) => Number(l.split(' ')[2]));
  assert.ok(pieces.every((n) => n <= 16000), `pieces ${pieces}`);
  const quiet = await e.hear('s1', pcm(0.3, 0), false);
  assert.equal(quiet.endpoint, true, 'trailing silence is an endpoint');
  const fin = await e.hear('s1', Buffer.alloc(0), true);
  assert.deepEqual(fin, { text: 'w1 w2 w3 w4 w5 w6 w7 w8', endpoint: true, loaded: false });
  // With the whole-sentence model loaded, the page re-hears the recording with it.
  await e.warm(undefined);
  assert.equal((await e.hear('s9', pcm(0.25), false)).loaded, true);
  assert.equal(e.workerStates().online, 'ready');
  assert.equal(readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('start online')).length, 1, 'one process');
});

test('V0.2: no streaming model, no helper or a bad id: a clear error (the page falls back to whole sentences)', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const plain = new LocalVoiceEngine(voiceDir(join(dir, 'a'), true), dir, { warm: { idleMs: () => 60_000 } });
  assert.equal(plain.streamingReady(), false, 'no sara-voice-worker in the sherpa bin');
  await assert.rejects(plain.hear('s1', pcm(0.2), false), /streaming/i);
  const noModel = engine(dir, voiceDir(join(dir, 'b'), false));
  assert.equal(noModel.streamingReady(), false);
  const e = engine(dir, voiceDir(join(dir, 'c'), true));
  t.after(() => e.stopWorkers());
  await assert.rejects(e.hear('bad id!', pcm(0.2), false), /stream/i);
  // Keep-loaded Off still streams (a stream needs a resident process), for a short idle time.
  const off = engine(dir, voiceDir(join(dir, 'd'), true), 0);
  t.after(() => off.stopWorkers());
  assert.equal(off.streamingReady(), true);
  assert.equal((await off.hear('s2', pcm(0.25), false)).text, 'w1');
});

test('V0.2: Talk prefs: hearing is "whole" unless set to "streaming"', () => {
  assert.equal(cleanTalk({}).hearing, 'whole');
  assert.equal(cleanTalk({ hearing: 'streaming' }).hearing, 'streaming');
  assert.equal(cleanTalk({ hearing: 'loud' }).hearing, 'whole');
});

test('V0.2: routes: /api/voice says what streaming can do; /api/voice/stream hears, or 409 so the page falls back', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  const v = voiceDir(dir);
  app.voice = engine(dir, v);
  app.settings.update({ voice: { ...(app.settings.get().voice ?? {}), stt: 'local', tts: 'local', talk: cleanTalk({ hearing: 'streaming' }) } as never });
  const auth = new OwnerAuth(app.dataDir);
  const token = `${auth.newToken}`;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    app.voice?.stopWorkers();
    await new Promise((r) => server.close(r));
    app.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const h = { authorization: `Bearer ${token}` };
  const info = (await (await fetch(`${base}/voice`, { headers: h })).json()) as { streaming: { installed: boolean; ready: boolean; on: boolean } };
  assert.equal(info.streaming.installed, true);
  assert.equal(info.streaming.ready, true);
  assert.equal(info.streaming.on, true);
  const r1 = await fetch(`${base}/voice/stream?id=t1`, { method: 'POST', headers: { ...h, 'content-type': 'audio/L16' }, body: pcm(0.5) });
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { text: 'w1 w2', endpoint: false, loaded: false });
  const r2 = await fetch(`${base}/voice/stream?id=t1&end=1`, { method: 'POST', headers: { ...h, 'content-type': 'audio/L16' }, body: pcm(0.25) });
  assert.deepEqual(await r2.json(), { text: 'w1 w2 w3', endpoint: true, loaded: false });
  // Whole sentences chosen: 409 with fallback, nothing heard.
  app.settings.update({ voice: { ...(app.settings.get().voice ?? {}), talk: cleanTalk({ hearing: 'whole' }) } as never });
  const r3 = await fetch(`${base}/voice/stream?id=t2`, { method: 'POST', headers: { ...h, 'content-type': 'audio/L16' }, body: pcm(0.25) });
  assert.equal(r3.status, 409);
  assert.equal(((await r3.json()) as { fallback?: boolean }).fallback, true);
  // The pref saves through the normal Voice PUT.
  const put = await fetch(`${base}/voice`, { method: 'PUT', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ talk: { hearing: 'streaming' } }) });
  assert.equal(put.status, 200);
  assert.equal(cleanTalk(app.settings.get().voice?.talk).hearing, 'streaming');
});

test('V0.1: release builds: Windows installer and Mac app build and ship the helper against the pinned sherpa', () => {
  const win = read('desktop/windows/build-voice-helper.sh');
  assert.ok(win.includes(SHERPA_BUNDLES['win32-x64'].sha256), 'Windows build pins the same sherpa bundle');
  assert.match(win, /vcvars64\.bat/);
  assert.match(win, /cl \/nologo \/O2 \/MD/);
  const inst = read('desktop/windows/build-installer.sh');
  assert.match(inst, /build-voice-helper\.sh" "\$STAGE\/server\/voice-helper"/);
  const mac = read('desktop/mac/build.sh');
  assert.ok(mac.includes(SHERPA_BUNDLES['darwin-any'].sha256), 'Mac build pins the same sherpa bundle as the voice install');
  assert.match(mac, /clang .*-arch arm64 -arch x86_64 .*sara-voice-worker\.c/);
  assert.match(mac, /voice-helper\/sherpa-onnx-v1\.13\.8\/darwin-universal\/sara-voice-worker/);
  assert.match(mac, /-rpath,@executable_path\/\.\.\/lib/);
  const c = read('deploy/voice/sara-voice-worker.c');
  assert.match(c, /SherpaOnnxCreateOnlineRecognizer/);
  assert.match(c, /strcmp\(argv\[1\], "online"\)/);
});
