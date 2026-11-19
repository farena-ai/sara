// U5 voice fast (docs/VOICE_FIRST.md "Engines stay loaded"): long-lived hearing/voice workers with a
// fake engine binary (test/fixtures/fake-voice-worker.mjs): start on first use, reuse, serialize,
// idle stop, crash restart + crash-loop guard, memory guard, job timeout, one-shot fallback.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { cleanTalk } from '../src/talk.ts';
import { LocalVoiceEngine } from '../src/voice.ts';
import { WarmWorker } from '../src/voice-warm.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const FAKE = join(ROOT, 'test', 'fixtures', 'fake-voice-worker.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const starts = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
const wav = (n = 3200) => {
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8, 'ascii');
  return b;
};

function worker(dir: string, opts: Partial<ConstructorParameters<typeof WarmWorker>[1]> = {}, env: Record<string, string> = {}) {
  const log = join(dir, `log-${Math.random().toString(36).slice(2)}.txt`);
  const w = new WarmWorker(() => ({ cmd: process.execPath, args: [FAKE, 'stt'], env: { ...process.env, FAKE_WORKER_LOG: log, ...env } }), { idleMs: () => 60_000, ...opts });
  return { w, log };
}

test('warm worker: starts on first use, stays loaded, serializes jobs in one process', async (t) => {
  const { dir, cleanup } = tempDir();
  const { w, log } = worker(dir);
  t.after(() => (w.stop(), cleanup()));
  assert.equal(w.state, 'stopped');
  const a = await w.ask('one.wav');
  const [b, c, d] = await Promise.all([w.ask('two.wav'), w.ask('three.wav'), w.ask('four.wav')]);
  assert.match(a, /^heard one\.wav by \d+$/);
  const pid = a.split(' by ')[1];
  for (const [x, name] of [[b, 'two'], [c, 'three'], [d, 'four']] as const) assert.equal(x, `heard ${name}.wav by ${pid}`);
  assert.equal(starts(log).length, 1, 'one process for every job');
  assert.equal(w.state, 'ready');
});

test('warm worker: idle timeout stops it; the next job starts it again', async (t) => {
  const { dir, cleanup } = tempDir();
  const { w, log } = worker(dir, { idleMs: () => 150 });
  t.after(() => (w.stop(), cleanup()));
  await w.ask('a.wav');
  await sleep(500);
  assert.equal(w.state, 'stopped');
  await w.ask('b.wav');
  assert.equal(starts(log).length, 2);
});

test('warm worker: a crash fails that job, the next one restarts; three crashes pause it', async (t) => {
  const { dir, cleanup } = tempDir();
  let now = 1_000_000;
  const { w, log } = worker(dir, { now: () => now });
  t.after(() => (w.stop(), cleanup()));
  await assert.rejects(w.ask('crash.wav'), /stopped|exit/i);
  assert.match(await w.ask('ok.wav'), /^heard ok\.wav/);
  await assert.rejects(w.ask('crash.wav'));
  await assert.rejects(w.ask('crash.wav'));
  assert.equal(w.state, 'broken');
  const before = starts(log).length;
  await assert.rejects(w.ask('ok.wav'), /paused/);
  assert.equal(starts(log).length, before, 'no new process while paused');
  now += 11 * 60_000;
  assert.match(await w.ask('ok.wav'), /^heard ok\.wav/, 'tries again after the pause');
});

test('warm worker: a model that fails to load, an error answer, a slow job and low memory', async (t) => {
  const { dir, cleanup } = tempDir();
  const fail = worker(dir, {}, { FAKE_WORKER_FAIL: '1' });
  const slow = worker(dir, { jobTimeoutMs: 300 }); // "slow" never answers (the fixture), so 300 ms is always too long
  const low = worker(dir, { freeMemMb: () => 100, minFreeMb: 1024 });
  t.after(() => (fail.w.stop(), slow.w.stop(), low.w.stop(), cleanup()));
  await assert.rejects(fail.w.ask('a.wav'), /did not load/);
  await assert.rejects(slow.w.ask('bad.wav', 60_000), /no audio/, 'its own generous time: a loaded machine may take a while to answer');
  assert.equal(slow.w.state, 'ready', 'an error answer keeps the worker');
  await assert.rejects(slow.w.ask('slow.wav'), /took too long/);
  assert.equal(slow.w.state, 'stopped', 'a stuck worker is killed');
  await assert.rejects(low.w.ask('a.wav'), /memory/);
  assert.equal(starts(low.log).length, 0, 'memory guard: nothing started');
});

function engine(dir: string, warm: { idleMs: () => number } | undefined, env: Record<string, string> = {}) {
  const vdir = join(dir, 'voice');
  mkdirSync(vdir, { recursive: true });
  writeFileSync(
    join(vdir, 'voice.json'),
    JSON.stringify({
      sherpa: 'sherpa',
      stt: { kind: 'nemo-ctc', model: 'p/model.onnx', tokens: 'p/tokens.txt' },
      voices: [{ id: 'piper:hfc', label: 'Piper', kind: 'vits', model: 'v/m.onnx', tokens: 'v/t.txt', dataDir: 'v/espeak' }],
    }),
  );
  const log = join(dir, 'engine-log.txt');
  const oneShot: string[] = [];
  const e = new LocalVoiceEngine(vdir, dir, {
    runner: async (cmd, args) => {
      oneShot.push(cmd);
      if (cmd.endsWith('sherpa-onnx-offline-tts')) {
        writeFileSync(args.find((a) => a.startsWith('--output-filename='))!.split('=')[1], wav(10));
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '{"lang": "", "text": "one shot"}', stderr: '' };
    },
    ...(warm ? { warm: { ...warm, worker: [process.execPath, FAKE], env: { FAKE_WORKER_LOG: log, ...env } } } : {}),
  });
  return { e, log, oneShot };
}

test('engine: hearing and her voice go through the loaded workers; warm() loads them ahead', async (t) => {
  const { dir, cleanup } = tempDir();
  let idle = 60_000;
  const { e, log, oneShot } = engine(dir, { idleMs: () => idle });
  t.after(() => (e.stopWorkers(), cleanup()));
  await e.warm('piper:hfc');
  assert.deepEqual(starts(log).map((l) => l.split(' ')[1]).sort(), ['stt', 'tts']);
  assert.match(await e.transcribe(wav()), /^heard .+\.wav by \d+$/);
  const a = await e.speak('Hello there.', 'piper:hfc');
  assert.equal(a.type, 'audio/wav');
  assert.equal(a.data.toString('ascii', 0, 4), 'RIFF');
  await e.speak('Second sentence.', 'piper:hfc');
  assert.equal(starts(log).length, 2, 'no reload per call');
  assert.deepEqual(oneShot, [], 'the one-shot tools were not run');
  assert.deepEqual(e.workerStates(), { stt: 'ready', 'tts:piper:hfc': 'ready' });
  idle = 0; // the owner switches keep-loaded off: the next job frees the loaded engines and runs one-shot
  assert.equal(await e.transcribe(wav()), 'one shot');
  assert.deepEqual(e.workerStates(), {});
  idle = 60_000;
  await e.warm('piper:hfc');
  e.stopWorkers();
  assert.deepEqual(e.workerStates(), {});
});

test('engine: any worker error falls back to the one-shot tools; keep-loaded off uses them only', async (t) => {
  const { dir, cleanup } = tempDir();
  const broken = engine(dir, { idleMs: () => 60_000 }, { FAKE_WORKER_FAIL: '1' });
  t.after(() => (broken.e.stopWorkers(), cleanup()));
  assert.equal(await broken.e.transcribe(wav()), 'one shot');
  assert.equal((await broken.e.speak('bad words', 'piper:hfc')).type, 'audio/wav');
  assert.equal(broken.oneShot.length, 2);
  const { dir: d2, cleanup: c2 } = tempDir();
  t.after(c2);
  const off = engine(d2, { idleMs: () => 0 });
  assert.equal(await off.e.transcribe(wav()), 'one shot');
  await off.e.warm('piper:hfc');
  assert.equal(starts(off.log).length, 0, 'keep loaded off: no worker');
  const none = engine(d2, undefined);
  assert.equal(await none.e.transcribe(wav()), 'one shot', 'no worker binary: one shot');
});

test('talk prefs: keep loaded minutes (default 10; 0, 10, 30, 60 only)', () => {
  assert.equal(cleanTalk({}).keepLoaded, 10);
  assert.equal(cleanTalk({ keepLoaded: 0 }).keepLoaded, 0);
  assert.equal(cleanTalk({ keepLoaded: 60 }).keepLoaded, 60);
  assert.equal(cleanTalk({ keepLoaded: 7 }).keepLoaded, 10);
  assert.equal(cleanTalk({ keepLoaded: '30' }).keepLoaded, 30);
});

test('POST /api/voice/warm loads the local engines (Talk opened); keepLoaded saves with talk prefs', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  const eng = engine(dir, { idleMs: () => 60_000 });
  app.voice = eng.e;
  const auth = new OwnerAuth(app.dataDir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => (eng.e.stopWorkers(), server.close(), app.store.close(), cleanup()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const H = { authorization: ['Bearer', auth.newToken].join(' '), 'content-type': 'application/json' };
  const put = await fetch(`${base}/voice`, { method: 'PUT', headers: H, body: JSON.stringify({ stt: 'local', tts: 'local', localVoice: 'piper:hfc', talk: { keepLoaded: 30 } }) });
  assert.equal(put.status, 200);
  assert.equal(app.settings.get().voice?.talk?.keepLoaded, 30);
  assert.equal(app.settings.get().voice?.talk?.fillers, true, 'other talk prefs kept');
  const w = await fetch(`${base}/voice/warm`, { method: 'POST', headers: H, body: '{}' });
  assert.equal(w.status, 202);
  assert.deepEqual(await w.json(), { warming: true });
  // The warm-up runs after the 202: wait for both workers to say ready (two process starts can take
  // many seconds on a loaded machine; a fixed 2.5 s window flaked), then check which ones started.
  const end = Date.now() + 60_000;
  while (Date.now() < end && Object.values(eng.e.workerStates()).filter((x) => x === 'ready').length < 2) await sleep(25);
  assert.deepEqual(starts(eng.log).map((l) => l.split(' ')[1]).sort(), ['stt', 'tts']);
});
