// C17 (docs/ops/C17_DESIGN.md): Hey Sara on Linux, macOS and Android. The server side (the packs per
// platform, a paired Linux helper signing in with its device token, "never in quiet hours"), and
// static checks of the three apps (permission strings, the Android foreground service, the pinned
// engine files) that can't be built or run on this PC. Real devices are owner checks.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setWakeLexiconDir } from '../src/routes/wake.ts';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { MODEL_FILES, MODEL_TAR, packFor, ANDROID_ENGINE, MAC_ENGINE, LINUX_X64 } from '../src/wake-pack.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function wav(seconds: number): Buffer {
  const data = Math.round(seconds * 16000) * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  return b;
}

async function rig(t: TestContext, at = '2026-11-02T10:00:00Z') {
  const { dir, cleanup } = tempDir();
  mkdirSync(dir, { recursive: true });
  const clock = { now: new Date(at) };
  const app = makeApp(dir, clock);
  app.companionId = 'main';
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString(), voice: { stt: 'local', tts: 'local' } as never });
  const heard: string[] = [];
  app.voice = { dir, available: { stt: true, tts: true }, voices: () => [], transcribe: async () => heard.shift() ?? '', speak: async () => ({ data: Buffer.from('RIFF0000WAVE'), type: 'audio/wav' }), reload: () => {} } as never;
  const auth = new OwnerAuth(dir, () => clock.now);
  const http = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), info: { version: '2.87.0', revision: null, startedAt: new Date().toISOString() } } as never);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(async () => {
    http.closeAllConnections?.();
    await new Promise<void>((r) => http.close(() => r()));
    app.store.close();
    cleanup();
  });
  const call = async (method: string, path: string, body?: unknown, auth?: { cookie?: string; token?: string }, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { ...headers };
    if (auth?.cookie) h.Cookie = `sara_session=${encodeURIComponent(auth.cookie)}`;
    if (auth?.token) h.Authorization = `Bearer ${auth.token}`;
    let payload: BodyInit | undefined;
    if (Buffer.isBuffer(body)) payload = new Uint8Array(body);
    else if (body !== undefined) {
      h['Content-Type'] ??= 'application/json';
      payload = JSON.stringify(body);
    }
    const r = await fetch(`${base}${path}`, { method, headers: h, ...(payload !== undefined ? { body: payload } : {}) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Any };
  };
  return { app, auth, clock, heard, call };
}

// ---------------- the packs ----------------

test('C17 · the Linux x64 pack: the model, the ALSA keyword spotter and onnxruntime, pinned; arm64 not yet', () => {
  const p = packFor('linux', 'x64')!;
  assert.ok(p, 'a Linux x64 pack');
  assert.deepEqual(p.files.slice(0, 4), MODEL_FILES);
  const names = p.files.map((f) => f.name);
  assert.deepEqual(names.slice(4), ['sherpa-onnx-keyword-spotter-alsa', 'libonnxruntime.so']);
  for (const f of p.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
  assert.equal(p.tars.engine!.sha256, 'd0f96c8b65c6cd0974fada22737e337de81bc8cd2abbec2e39caf358b1eec5fc');
  assert.equal(p.tars.model, MODEL_TAR);
  assert.equal(p.download, MODEL_TAR.size + p.tars.engine!.size);
  assert.equal(LINUX_X64, 'sherpa-onnx-v1.13.8-linux-x64-shared-no-tts');
  assert.equal(packFor('linux', 'arm64'), undefined);
});

test('C17 · Mac and Android download only the model; their engine is pinned for the build, not downloaded', () => {
  for (const platform of ['mac', 'android']) {
    const p = packFor(platform, 'arm64')!;
    assert.deepEqual(p.files, MODEL_FILES, platform);
    assert.equal(p.tars.engine, undefined, platform);
    assert.equal(p.tars.model, MODEL_TAR, platform);
  }
  assert.equal(MAC_ENGINE.tar.sha256, 'bdcc7c266d355697584dd4efb9dc766e45e18e87cec1fc553002a32cfcfab9a7');
  assert.equal(ANDROID_ENGINE.tar.sha256, '2ff63469a71cb6009aa2e3ed5f4a670f8abdcbe4bb9ffd23776afc792a6b4f44');
  assert.deepEqual(Object.keys(ANDROID_ENGINE.abis).sort(), ['arm64-v8a', 'armeabi-v7a', 'x86_64']);
});

// ---------------- a paired Linux helper (device token, no cookie) ----------------

test('C17 · `sara wake` on Linux signs in with its device token: config, on, claim and a turn', async (t) => {
  const g = await rig(t);
  const { token, id } = g.auth.createDeviceToken('sara wake on Linux (desk)');
  const tok = { token };
  const cfg = await g.call('GET', '/api/wake/config?platform=linux&arch=x64', undefined, tok);
  assert.equal(cfg.status, 200, JSON.stringify(cfg.json));
  assert.equal(cfg.json.pack.platform, 'linux');
  const on = await g.call('PUT', '/api/wake/device', { on: true, platform: 'linux', label: 'Linux desk' }, tok);
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.equal(on.json.id, id);
  assert.equal(on.json.platform, 'linux');
  assert.equal(on.json.personal, false, 'a computer is a room until marked personal');
  const c = await g.call('POST', '/api/wake/claim', { label: 'W1' }, tok);
  assert.equal(c.json.ok, true, JSON.stringify(c.json));
  g.heard.push('stop');
  const turn = await g.call('POST', '/api/wake/turn', wav(1), tok, { 'Content-Type': 'audio/wav', 'X-Sara-Wake-Claim': c.json.claim, 'X-Sara-Wake-Label': 'W1' });
  assert.equal(turn.status, 200, JSON.stringify(turn.json));
  assert.equal(turn.json.ended, 'stop');
});

test('C17 · an API key or a hands token is not a wake device', async (t) => {
  const g = await rig(t);
  const api = g.auth.createApiKey('Other app');
  assert.notEqual((await g.call('GET', '/api/wake/config', undefined, { token: api.token })).status, 200);
  const hands = g.auth.createDeviceToken('Home Assistant', 'home-assistant');
  assert.notEqual((await g.call('PUT', '/api/wake/device', { on: true, platform: 'linux' }, { token: hands.token })).status, 200);
});

// ---------------- the model from her own server (phones can't unpack .tar.bz2) ----------------

test('C17 · GET /api/wake/model/<file>: only signed-in devices, only the four pinned files, only when they match', async (t) => {
  const g = await rig(t);
  const dir = join(g.app.dataDir, 'lex');
  setWakeLexiconDir(dir);
  t.after(() => setWakeLexiconDir(undefined));
  const s = g.auth.createSession('Phone');
  const dev = { cookie: s.value };
  assert.equal((await g.call('GET', '/api/wake/model/tokens.txt')).status, 401);
  const miss = await g.call('GET', '/api/wake/model/tokens.txt', undefined, dev);
  assert.equal(miss.status, 404);
  assert.equal(miss.json.missing, true);
  mkdirSync(join(dir, 'model'), { recursive: true });
  // A tokens.txt of the right size but the wrong bytes is never served.
  const pin = MODEL_FILES.find((f) => f.name === 'tokens.txt')!;
  writeFileSync(join(dir, 'model', 'tokens.txt'), Buffer.alloc(pin.size, 65));
  assert.equal((await g.call('GET', '/api/wake/model/tokens.txt', undefined, dev)).status, 404);
  assert.notEqual(createHash('sha256').update(Buffer.alloc(pin.size, 65)).digest('hex'), pin.sha256);
  for (const bad of ['..%2F..%2Fsettings.json', 'en.phone', 'wake.json']) assert.equal((await g.call('GET', `/api/wake/model/${bad}`, undefined, dev)).status, 404, bad);
});

// ---------------- never in quiet hours (when the person chooses) ----------------

test('C17 · quiet hours: off by default; on, phrases pause in the quiet hours (Talk still works), and wake again after', async (t) => {
  const g = await rig(t, '2026-11-02T23:30:00Z');
  const s = g.auth.createSession('Phone');
  const dev = { cookie: s.value };
  assert.equal((await g.call('PUT', '/api/wake/device', { on: true, platform: 'android' }, dev)).status, 200);
  const before = await g.call('GET', '/api/wake', undefined, dev);
  assert.equal(before.json.settings.quietHours, false);
  assert.equal((await g.call('GET', '/api/wake/config?platform=android', undefined, dev)).json.paused, undefined);
  assert.equal((await g.call('PUT', '/api/wake', { quietHours: true }, dev)).json.settings.quietHours, true);
  const cfg = await g.call('GET', '/api/wake/config?platform=android', undefined, dev);
  assert.equal(cfg.json.paused, 'quiet');
  assert.equal(cfg.json.on, true, 'still switched on: only paused');
  assert.ok(cfg.json.quiet && cfg.json.quiet.start === '22:00' && cfg.json.quiet.end === '08:00');
  const c = await g.call('POST', '/api/wake/claim', { label: 'W1' }, dev);
  assert.equal(c.status, 409);
  assert.equal(c.json.paused, 'quiet');
  assert.equal((await g.call('POST', '/api/wake/claim', { label: 'TALK' }, dev)).json.ok, true, 'a deliberate Talk press is not a wake word');
  g.clock.now = new Date('2026-11-03T08:30:00Z');
  assert.equal((await g.call('GET', '/api/wake/config?platform=android', undefined, dev)).json.paused, undefined);
  assert.equal((await g.call('POST', '/api/wake/claim', { label: 'W1' }, dev)).json.ok, true);
});

// ---------------- the apps (static: they are built on their own machines) ----------------

test('C17 · Android: an opt-in microphone foreground service with the on-device engine, charging/open options', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /\.WakeService"\s+android:exported="false"\s+android:foregroundServiceType="microphone"/);
  assert.match(manifest, /FOREGROUND_SERVICE_MICROPHONE/);
  const svc = read('android/app/src/main/java/com/backstagecoding/sara/WakeService.java');
  assert.match(svc, /FOREGROUND_SERVICE_TYPE_MICROPHONE/);
  assert.match(svc, /Kws\.open\(/, 'the detector runs in the service');
  assert.match(svc, /getBoolean\("on", false\)/, 'off by default');
  for (const s of ['onlyCharging', 'onlyOpen', 'ACTION_POWER_CONNECTED', 'ACTION_POWER_DISCONNECTED', 'isPowerSaveMode', 'BATTERY_PROPERTY_CAPACITY', '"quiet"']) assert.ok(svc.includes(s), s);
  assert.match(svc, /\/api\/wake\/config\?platform=android/);
  const kws = read('android/app/src/main/java/com/backstagecoding/sara/Kws.java');
  assert.match(kws, /System\.loadLibrary\("sarakws"\)/);
  for (const n of ['nativeOpen', 'nativeFeed', 'nativeClose']) assert.match(kws, new RegExp(`native \\w+ ${n}\\(`));
  for (const f of MODEL_FILES) assert.ok(kws.includes(`"${f.sha256}"`) && kws.includes(String(f.size)), `Kws.java pins ${f.name}`);
  const c = read('android/app/src/main/cpp/kws.c');
  assert.match(c, /dlopen\("libsherpa-onnx-c-api\.so"/);
  assert.match(c, /Java_com_backstagecoding_sara_Kws_nativeFeed/);
  const gradle = read('android/app/build.gradle');
  assert.match(gradle, /externalNativeBuild[\s\S]*cmake[\s\S]*src\/main\/cpp\/CMakeLists\.txt/);
  assert.match(gradle, /abiFilters 'arm64-v8a', 'armeabi-v7a', 'x86_64'/);
  const fetch = read('android/fetch-wake-libs.sh');
  assert.ok(fetch.includes(ANDROID_ENGINE.tar.sha256));
  for (const [abi, files] of Object.entries(ANDROID_ENGINE.abis)) for (const f of files) assert.ok(fetch.includes(`${abi}/${f.name}|${f.sha256}`), `${abi}/${f.name}`);
  assert.match(read('.gitignore'), /android\/app\/src\/main\/jniLibs\//);
  for (const lang of ['', '-de', '-es', '-fr', '-it', '-pt-rBR']) {
    const s = read(`android/app/src/main/res/values${lang}/strings.xml`);
    for (const k of ['hey_paused_charging', 'hey_paused_battery', 'hey_paused_open', 'hey_paused_quiet', 'hey_paused_mic', 'hey_heard_you']) assert.match(s, new RegExp(`name="${k}"`), `${lang || 'en'} ${k}`);
  }
});

test('C17 · macOS: the microphone string names Hey Sara; the engine is bundled, pinned and signed; the model is checked', () => {
  const plist = read('desktop/mac/Info.plist');
  assert.match(plist, /NSMicrophoneUsageDescription<\/key><string>[^<]*Hey Sara[^<]*on this Mac[^<]*<\/string>/);
  assert.match(read('desktop/mac/Sara.entitlements'), /com\.apple\.security\.device\.audio-input/);
  assert.doesNotMatch(read('desktop/mac/Sara.entitlements'), /disable-library-validation/);
  const sh = read('desktop/mac/build.sh');
  assert.ok(sh.includes(MAC_ENGINE.tar.sha256));
  for (const f of MAC_ENGINE.files) assert.ok(sh.includes(`${f.name}|${f.sha256}`), f.name);
  assert.match(sh, /Contents\/Frameworks/);
  assert.match(sh, /-import-objc-header Sources\/SherpaBridge\.h/);
  assert.ok(sh.includes('for f in "$APP"/Frameworks/*.dylib; do codesign "${SIGN[@]}" "$f"; done'), 'the engine is signed with the app');
  const swift = read('desktop/mac/Sources/Wake.swift');
  assert.match(swift, /dlopen\(/);
  assert.match(swift, /AVAudioEngine/);
  for (const f of MODEL_FILES) assert.ok(swift.includes(`"${f.sha256}"`), `Wake.swift pins ${f.name}`);
  assert.ok(swift.includes(MODEL_TAR.sha256));
  assert.match(read('desktop/mac/Sources/SherpaBridge.h'), /#include "sherpa-onnx\/c-api\/c-api\.h"/);
  assert.match(read('desktop/mac/Sources/QuickAsk.swift'), /case "wake":/);
});

test('C17 · Linux: `sara wake` is a user-session helper in deploy/sara; the quick-ask page asks for its own platform', () => {
  const sara = read('deploy/sara');
  assert.match(sara, /== wake \]\][\s\S]*EUID -ne 0[\s\S]*desktop\/linux\/wake\.ts/);
  assert.ok(existsSync(join(ROOT, 'desktop/linux/wake.ts')));
  const qa = read('desktop/shared/quick-ask.html');
  assert.doesNotMatch(qa, /\/api\/wake\/config\?platform=windows&arch=x64/);
  assert.match(qa, /platform=' \+ wakePlatform/);
});
