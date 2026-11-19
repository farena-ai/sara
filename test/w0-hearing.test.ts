// ROADMAP_W W0.3 (docs/VOICE_FIRST.md "Words as you speak in six languages"): an optional free
// multilingual streaming model (NVIDIA Nemotron 3.5 streaming ASR through sherpa-onnx) shows live
// words in Spanish, French, German, Portuguese and Italian too. The model is picked by the person's
// language; English keeps the small English model; no model for a language = the whole-sentence path.
// The interpreter (either language, "auto") and meeting captions use it when installed.
// A fake engine (test/fixtures/fake-voice-worker.mjs).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { cleanTalk } from '../src/talk.ts';
import { hearLang, LocalVoiceEngine, STREAM_LANGS, streamLang } from '../src/voice.ts';
import { installItems, installVoice, MULTI_MB, MULTI_MODEL, runVoiceCli, STREAM_MODEL, voiceManifest } from '../src/voice-install.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const FAKE = join(ROOT, 'test', 'fixtures', 'fake-voice-worker.mjs');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const SHERPA_WIN = 'sherpa-onnx-v1.13.8-win-x64-shared-MD-Release';
const MULTI_DIR = MULTI_MODEL.path.slice('asr-models/'.length, -'.tar.bz2'.length);

function voiceDir(dir: string, o: { online?: boolean; multi?: boolean } = { online: true, multi: true }): string {
  const v = join(dir, 'voice');
  mkdirSync(join(v, SHERPA_WIN, 'bin'), { recursive: true });
  writeFileSync(join(v, 'voice.json'), JSON.stringify(voiceManifest(SHERPA_WIN, o)));
  return v;
}
const engine = (dir: string, v: string, log?: string) =>
  new LocalVoiceEngine(v, dir, { warm: { idleMs: () => 60_000, worker: [process.execPath, FAKE], env: log ? { FAKE_WORKER_LOG: log } : {}, minFreeMb: 0 } });
const pcm = (sec: number, value = 1000) => {
  const b = Buffer.alloc(Math.round(sec * 16000) * 2);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(value, i);
  return b;
};
const wav = (p: Buffer, rate = 16000) => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + p.length, 4); h.write('WAVE', 8, 'ascii'); h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(p.length, 40);
  return Buffer.concat([h, p]);
};

test('W0.3: the multilingual streaming model is pinned (sherpa-onnx release, SHA-256) and goes into voice.json only when installed', () => {
  assert.match(MULTI_MODEL.path, /^asr-models\/sherpa-onnx-nemotron-3\.5-asr-streaming-0\.6b-\d+ms-int8-2026-06-11\.tar\.bz2$/);
  assert.match(MULTI_MODEL.sha256, /^[0-9a-f]{64}$/);
  assert.ok(MULTI_MB > 400 && MULTI_MB < 520);
  const sh = read('deploy/install-voice.sh');
  assert.ok(sh.includes(`MULTI_DIR=${MULTI_DIR}`) && sh.includes(`"asr-models/$MULTI_DIR.tar.bz2|${MULTI_MODEL.sha256}"`), 'install-voice.sh pins the same model');
  assert.match(sh, /--languages\)/);
  assert.equal(voiceManifest(SHERPA_WIN).multi, undefined);
  const m = voiceManifest(SHERPA_WIN, { multi: true });
  assert.deepEqual(Object.keys(m.multi!).sort(), ['decoder', 'encoder', 'joiner', 'kind', 'languages', 'tokens']);
  assert.deepEqual(m.multi!.languages, ['en', 'es', 'fr', 'de', 'pt', 'it']);
  assert.ok(m.multi!.encoder.startsWith(`${MULTI_DIR}/`));
  // Only on request: never part of the plain or the English streaming install.
  assert.deepEqual(installItems('win32', 'x64', { streaming: 'languages' })!.at(-1), MULTI_MODEL);
  assert.equal(installItems('win32', 'x64', { streaming: 'add' })!.includes(MULTI_MODEL), false);
  assert.equal(installItems('win32', 'x64')!.includes(MULTI_MODEL), false);
  assert.deepEqual(installItems('win32', 'x64', { streaming: 'languages-only' })!.map((i) => i.path), [MULTI_MODEL.path]);
  // Credited with its license.
  const credits = read('docs/CREDITS.md');
  assert.match(credits, /Nemotron 3\.5 ASR Streaming/);
  assert.match(credits, /NVIDIA Open Model License/);
});

test('W0.3: languages: the person\'s language picks the model (pt-BR → pt, auto for the interpreter)', () => {
  assert.deepEqual([...STREAM_LANGS], ['en', 'es', 'fr', 'de', 'pt', 'it']);
  assert.equal(streamLang('pt-BR'), 'pt');
  assert.equal(streamLang('ES'), 'es');
  assert.equal(streamLang('auto'), 'auto');
  assert.equal(streamLang('ja'), undefined);
  assert.equal(streamLang(''), undefined);
  // Talk language first, then the app language, then the browser's; 'auto' falls through.
  assert.equal(hearLang({ talkLanguage: 'fr' }), 'fr');
  assert.equal(hearLang({ talkLanguage: 'auto', language: 'de' }), 'de');
  assert.equal(hearLang({ talkLanguage: 'auto', language: 'auto', languageDetected: 'pt-BR' }), 'pt');
  assert.equal(hearLang({}), 'en');
});

test('W0.3: English keeps the English streaming model; es/fr/de/pt/it go to the multilingual one with the language set', async (t) => {
  const { dir, cleanup } = tempDir();
  const log = join(dir, 'w.log');
  const e = engine(dir, voiceDir(dir), log);
  t.after(() => (e.stopWorkers(), cleanup()));
  assert.deepEqual(e.streamLangs(), ['en', 'es', 'fr', 'de', 'pt', 'it']);
  assert.equal(e.streamingReady('es'), true);
  assert.equal(e.streamingReady('ja'), false);
  assert.deepEqual(await e.hear('s1', pcm(0.5), false), { text: 'w1 w2', endpoint: false, loaded: false });
  assert.deepEqual(await e.hear('s2', pcm(0.5), false, 'es'), { text: 'es1 es2', endpoint: false, loaded: false });
  assert.equal((await e.hear('s2', pcm(0.25), true, 'es')).text, 'es1 es2 es3');
  assert.equal((await e.hear('s3', pcm(0.25), false, 'pt-BR')).text, 'pt1');
  assert.equal((await e.hear('s4', pcm(0.25), false, 'auto')).text, 'auto1');
  const lines = readFileSync(log, 'utf8').split('\n');
  assert.equal(lines.filter((l) => l.startsWith('start online')).length, 2, 'one English and one multilingual process');
  assert.ok(lines.includes('lang s2 es') && lines.includes('lang s3 pt') && lines.includes('lang s4 auto'));
  // The English whole-sentence model is loaded: only English re-hears the recording with it.
  await e.warm(undefined);
  assert.equal((await e.hear('s5', pcm(0.25), false)).loaded, true);
  assert.equal((await e.hear('s6', pcm(0.25), false, 'it')).loaded, false, 'Parakeet is English: the Italian streaming words are sent');
  assert.equal(e.workerStates().multi, 'ready');
});

test('W0.3: fallbacks: no multilingual model → a clear error for es (whole sentences); only the multilingual one → English through it', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const en = engine(dir, voiceDir(join(dir, 'a'), { online: true }));
  t.after(() => en.stopWorkers());
  assert.equal(en.streamingReady('en'), true);
  assert.equal(en.streamingReady('es'), false);
  assert.deepEqual(en.streamLangs(), ['en']);
  await assert.rejects(en.hear('s1', pcm(0.25), false, 'es'), /streaming/i);
  const multi = engine(dir, voiceDir(join(dir, 'b'), { multi: true }));
  t.after(() => multi.stopWorkers());
  assert.equal(multi.streamingReady(), true);
  assert.equal((await multi.hear('s1', pcm(0.25), false, 'en')).text, 'en1');
  const none = engine(dir, voiceDir(join(dir, 'c'), {}));
  assert.equal(none.streamingReady('fr'), false);
  assert.deepEqual(none.streamLangs(), []);
});

test('W0.3: whole recordings in es/fr/de/pt/it are heard by the multilingual model (Parakeet is English)', async (t) => {
  const { dir, cleanup } = tempDir();
  const log = join(dir, 'w.log');
  const e = engine(dir, voiceDir(dir), log);
  t.after(() => (e.stopWorkers(), cleanup()));
  // 1 s of words + 0.6 s of quiet after them (the last word gets out of the look-ahead): 6 fake words.
  assert.equal(await e.transcribe(wav(pcm(1)), { lang: 'de' }), 'de1 de2 de3 de4 de5 de6');
  assert.equal(await e.transcribe(wav(pcm(4.5), 48000), { lang: 'auto' }), 'auto1 auto2 auto3 auto4 auto5 auto6 auto7 auto8', '48 kHz is resampled to 16 kHz');
  assert.match(await e.transcribe(wav(pcm(0.5))), /^heard /, 'English: the whole-sentence model as before');
  assert.match(await e.transcribe(wav(pcm(0.5)), { lang: 'ja' }), /^heard /, 'a language it has no model for: as before');
  const en = engine(dir, voiceDir(join(dir, 'x'), { online: true }));
  t.after(() => en.stopWorkers());
  assert.match(await en.transcribe(wav(pcm(0.5)), { lang: 'es' }), /^heard /, 'no multilingual model: as before');
});

test('W0.3: routes: languages in /api/voice, ?lang= on /voice/stream, 409 for a language without a model, install {languages}', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  app.voice = engine(dir, voiceDir(dir, { online: true }));
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
  const h = { authorization: ['Bearer', token].join(' ') };
  type View = { streaming: { languages: string[]; multi: { installed: boolean; mb: number } } };
  let info = (await (await fetch(`${base}/voice`, { headers: h })).json()) as View;
  assert.deepEqual(info.streaming.languages, ['en']);
  assert.deepEqual(info.streaming.multi, { installed: false, mb: MULTI_MB });
  const es = await fetch(`${base}/voice/stream?id=t1&lang=es`, { method: 'POST', headers: { ...h, 'content-type': 'audio/L16' }, body: pcm(0.25) });
  assert.equal(es.status, 409);
  assert.equal(((await es.json()) as { fallback?: boolean }).fallback, true);
  // The multilingual model is installed (voice.json reloaded).
  writeFileSync(join(app.voice!.dir, 'voice.json'), JSON.stringify(voiceManifest(SHERPA_WIN, { online: true, multi: true })));
  app.voice!.reload();
  info = (await (await fetch(`${base}/voice`, { headers: h })).json()) as View;
  assert.deepEqual(info.streaming.languages, ['en', 'es', 'fr', 'de', 'pt', 'it']);
  assert.equal(info.streaming.multi.installed, true);
  const r = await fetch(`${base}/voice/stream?id=t2&lang=fr`, { method: 'POST', headers: { ...h, 'content-type': 'audio/L16' }, body: pcm(0.5) });
  assert.deepEqual(await r.json(), { text: 'fr1 fr2', endpoint: false, loaded: false });
  // No ?lang=: the person's language (Settings → Language).
  app.settings.update({ talkLanguage: 'it' } as never);
  const it = await fetch(`${base}/voice/stream?id=t3`, { method: 'POST', headers: { ...h, 'content-type': 'audio/L16' }, body: pcm(0.25) });
  assert.equal(((await it.json()) as { text: string }).text, 'it1');
  // Whole recordings without a hint are heard in the person's language too.
  const tr = await fetch(`${base}/voice/transcribe`, { method: 'POST', headers: { ...h, 'content-type': 'audio/wav' }, body: wav(pcm(0.5)) });
  assert.equal(((await tr.json()) as { text: string }).text, 'it1 it2 it3 it4');
  // The install button asks for the multilingual model; a member can't.
  const src = read('src/routes/voice.ts');
  assert.match(src, /languages \? \{ streaming: 'languages' \}/);
});

test('W0.3: `sara voice install --languages` asks for the multilingual model; Linux gets the script hint', async () => {
  let asked: unknown;
  const out: string[] = [];
  const code = await runVoiceCli(['install', '--languages'], { platform: 'win32', voiceDir: 'x', log: (s) => out.push(s), install: (async (_d: string, o: { streaming?: string }) => ((asked = o.streaming), { installed: ['m'], manifest: voiceManifest(SHERPA_WIN) })) as never });
  assert.equal(code, 0);
  assert.equal(asked, 'languages');
  const lin: string[] = [];
  await runVoiceCli(['install', '--languages'], { platform: 'linux', voiceDir: 'x', log: (s) => lin.push(s) });
  assert.match(lin.join('\n'), /install-voice\.sh --languages/);
});

test('W0.3: installVoice adds only the multilingual model when the rest is there', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const v = voiceDir(dir, { online: true });
    for (const d of ['sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8', 'kokoro-en-v0_19', 'vits-piper-en_US-hfc_female-medium', STREAM_MODEL.path.slice(11, -8), SHERPA_WIN]) mkdirSync(join(v, d), { recursive: true });
    const body = Buffer.from('fake multilingual tarball');
    const { createHash } = await import('node:crypto');
    const fetched: string[] = [];
    const fakeFetch = (async (url: string) => (fetched.push(String(url)), new Response(body))) as unknown as typeof fetch;
    const untar = async (_file: string, into: string) => void mkdirSync(join(into, MULTI_DIR), { recursive: true });
    const r = await installVoice(v, { platform: 'win32', arch: 'x64', fetch: fakeFetch, untar, streaming: 'languages', items: [{ ...MULTI_MODEL, sha256: createHash('sha256').update(body).digest('hex') }] });
    assert.deepEqual(r.installed, [MULTI_DIR]);
    assert.equal(fetched.length, 1);
    assert.ok(r.manifest.multi && r.manifest.online && r.manifest.stt, 'both streaming models and hearing in voice.json');
  } finally {
    cleanup();
  }
});

test('W0.3: the helper sets the stream language; the page sends it; the interpreter streams with "auto"; Settings offers the download', () => {
  const c = read('deploy/voice/sara-voice-worker.c');
  assert.match(c, /SherpaOnnxOnlineStreamSetOption\(slots\[free\]\.s, "language", lang\)/);
  // Measured: without ~0.6 s of quiet before the words, Nemotron drops the first word or two.
  assert.match(c, /SherpaOnnxOnlineStreamAcceptWaveform\(slots\[free\]\.s, 16000, lead, 16000\)/);
  const talk = read('web/talk.js');
  assert.match(talk, /&lang=\$\{encodeURIComponent\(lang\)\}/);
  assert.match(talk, /interpOn\(\) \? \(st\.languages\?\.length > 1 \? new StreamHearing\(\(id, b, e\) => postStream\(id, b, e, 'auto'\)/);
  const html = read('web/index.html');
  assert.match(html, /<button id="talk-langs-get" type="button" class="ghost">/);
  assert.match(html, /id="talk-langs-row"[^>]*>[^\n]*class="tip" data-tip="[^"]{20,180}"/);
  const wake = read('web/wake.js');
  assert.match(wake, /export function renderLangsInstall\(v\)/);
  assert.match(wake, /body: \{ languages: true \}/);
  const meet = read('src/meetings.ts');
  assert.match(meet, /transcribe\(audio, \{ lang: hearLang\(this\.#app\.settings\.get\(\)\) \}\)/);
});
