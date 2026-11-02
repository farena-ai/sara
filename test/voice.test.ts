// Phase 5: voice engines (local CLI runner faked), text cleanup, API, settings, keys write-only.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { defaultEngines, LocalVoiceEngine, speechChunks, speechText, xaiSpeak, xaiVoices } from '../src/voice.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const wav = (n = 3200) => {
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8, 'ascii');
  return b;
};

function engine(dir: string) {
  const vdir = join(dir, 'voice');
  mkdirSync(vdir, { recursive: true });
  writeFileSync(
    join(vdir, 'voice.json'),
    JSON.stringify({
      sherpa: 'sherpa',
      stt: { kind: 'nemo-ctc', model: 'p/model.onnx', tokens: 'p/tokens.txt' },
      voices: [
        { id: 'kokoro:1', label: 'Bella (US), natural', kind: 'kokoro', model: 'k/model.onnx', voices: 'k/voices.bin', tokens: 'k/tokens.txt', dataDir: 'k/espeak', sid: 1 },
        { id: 'piper:hfc', label: 'Piper', kind: 'vits', model: 'v/m.onnx', tokens: 'v/t.txt', dataDir: 'v/espeak' },
      ],
    }),
  );
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const e = new LocalVoiceEngine(vdir, dir, {
    runner: async (cmd, args, env) => {
      calls.push({ cmd, args, env });
      if (cmd.endsWith('sherpa-onnx-offline-tts')) {
        const out = args.find((a) => a.startsWith('--output-filename='))!.split('=')[1];
        writeFileSync(out, wav(10));
        return { code: 0, stdout: '', stderr: 'Saved' };
      }
      return { code: 0, stdout: '{"lang": "", "emotion": "", "event": "", "text": "Hey Sara, \\"quote\\" test.", "timestamps": []}', stderr: '' };
    },
  });
  return { e, calls, vdir };
}

test('speech text: markdown, code, links and emoji are made speakable; chunks merge short sentences', () => {
  assert.equal(speechText('**Done!** See `app.ts` and [the docs](https://x.y/z) 🎉\n```js\nconst a = 1;\n```\n- one\n- two'), 'Done! See app.ts and the docs (I put the code in the chat.) one two');
  assert.equal(speechText('Go to https://example.com now'), 'Go to a link now');
  assert.deepEqual(speechChunks('Hey. Yeah. So I finally watered the ferns, and I think they forgive me. Want coffee?'), ['Hey. Yeah.', 'So I finally watered the ferns, and I think they forgive me.', 'Want coffee?']);
  assert.ok(speechChunks('a'.repeat(50) + ', ' + 'b'.repeat(300) + '.').every((c) => c.length <= 1000));
});

test('local engine: runs sherpa tools with safe argv, parses the transcript, cleans temp files', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const { e, calls, vdir } = engine(dir);
  assert.deepEqual(e.available, { stt: true, tts: true });
  assert.deepEqual(e.voices().map((v) => v.id), ['kokoro:1', 'piper:hfc']);
  assert.equal(await e.transcribe(wav()), 'Hey Sara, "quote" test.');
  const stt = calls[0];
  assert.equal(stt.cmd, join(vdir, 'sherpa', 'bin', 'sherpa-onnx-offline'));
  // 2.59: on Windows the DLLs sit beside the tools in bin/ and are found through PATH.
  if (process.platform === 'win32') assert.ok(String(stt.env.PATH).startsWith(join(vdir, 'sherpa', 'bin')));
  else assert.equal(stt.env.LD_LIBRARY_PATH, join(vdir, 'sherpa', 'lib'));
  // Linux: PATH, LD_LIBRARY_PATH, HOME. Windows: PATH, SystemRoot, TEMP, TMP, USERPROFILE (no secrets either way).
  assert.ok(!('SARA_MASTER_KEY' in stt.env) && Object.keys(stt.env).length === (process.platform === 'win32' ? 5 : 3), 'minimal environment');
  await assert.rejects(e.transcribe(Buffer.from('not audio')), /Expected a WAV/);

  const evil = '"; rm -rf / #$(whoami)';
  const a = await e.speak(evil, 'kokoro:1', 1.25);
  assert.equal(a.type, 'audio/wav');
  const tts = calls.at(-1)!;
  assert.equal(tts.args.at(-1), evil, 'text is one argv element, never a shell string');
  assert.ok(tts.args.includes('--sid=1') && tts.args.includes('--kokoro-length-scale=0.80'));
  await e.speak('hi', 'piper:hfc');
  assert.ok(calls.at(-1)!.args.some((x) => x.startsWith('--vits-model=')));
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(join(dir, 'tmp', 'voice')), [], 'temp files removed');
});

test('voice API: settings, keys write-only, transcribe + speak through the configured engine', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-24T20:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.voice = engine(dir).e;
  const auth = new OwnerAuth(app.dataDir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const auth_ = { authorization: `Bearer ${auth.newToken}` };
  const H = { ...auth_, 'content-type': 'application/json' };

  const g = await (await fetch(`${base}/voice`, { headers: H })).json();
  // M6: the server's own engines are the default only where local voice exists (Linux).
  assert.equal(g.settings.stt, defaultEngines().stt);
  assert.deepEqual(g.local, { stt: true, tts: true });
  assert.equal(g.voices.length, 2);
  const put = await fetch(`${base}/voice`, { method: 'PUT', headers: H, body: JSON.stringify({ stt: 'local', tts: 'local', localVoice: 'piper:hfc', speed: 9, openaiKey: 'sk-voice-secret-123456789' }) });
  assert.equal((await put.json()).speed, 1.6);
  const g2 = await (await fetch(`${base}/voice`, { headers: H })).json();
  assert.equal(g2.keys.openai, true);
  assert.ok(!JSON.stringify(g2).includes('sk-voice-secret'), 'key never returned');
  assert.equal((await fetch(`${base}/voice`, { method: 'PUT', headers: H, body: JSON.stringify({ tts: 'bogus' }) })).status, 400);

  const tr = await fetch(`${base}/voice/transcribe`, { method: 'POST', headers: { ...auth_, 'content-type': 'audio/wav' }, body: wav() });
  assert.equal((await tr.json()).text, 'Hey Sara, "quote" test.');
  const sp = await fetch(`${base}/voice/speak`, { method: 'POST', headers: H, body: JSON.stringify({ text: '**Hello** there' }) });
  assert.equal(sp.headers.get('content-type'), 'audio/wav');
  assert.ok((await sp.arrayBuffer()).byteLength > 44);
  assert.equal((await fetch(`${base}/voice/speak`, { method: 'POST', headers: H, body: JSON.stringify({ text: '```x```' }) })).status, 200, 'code-only becomes a spoken note');
  assert.equal((await fetch(`${base}/voice/speak`, { method: 'POST', headers: H, body: JSON.stringify({ text: '   ' }) })).status, 400);
  await fetch(`${base}/voice`, { method: 'PUT', headers: H, body: JSON.stringify({ stt: 'off' }) });
  assert.equal((await fetch(`${base}/voice/transcribe`, { method: 'POST', headers: { ...auth_, 'content-type': 'audio/wav' }, body: wav() })).status, 400);
  assert.equal((await fetch(`${base}/voice/transcribe`, { method: 'POST', body: wav() })).status, 401, 'auth required');
  // Media from blob: URLs is allowed by the CSP (for playback).
  assert.match((await fetch(`${base}/health`)).headers.get('content-security-policy') ?? '', /media-src 'self' blob:/);
});

test('Grok voice: POST /v1/tts with voice, language and clamped speed; lists built-in and custom voices', async () => {
  const calls: { url: string; body?: Record<string, unknown>; auth?: string }[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as Record<string, string>)?.authorization });
    if (url.endsWith('/tts')) return new Response(Buffer.from('ID3fake-mp3'), { headers: { 'content-type': 'audio/mpeg' } });
    if (url.endsWith('/tts/voices')) return Response.json({ voices: [{ voice_id: 'eve', name: 'Eve' }, { voice_id: 'ara', name: 'Ara' }] });
    return Response.json({ voices: [{ voice_id: 'cv_123', name: 'Sara clone' }] });
  }) as typeof fetch;
  await assert.rejects(xaiSpeak({ voiceId: 'eve', language: 'en' }, undefined, 'hi', 1, fake), /Add your xAI key/);
  const a = await xaiSpeak({ voiceId: 'ara', language: 'en' }, 'xai-k', 'Hey you.', 2, fake);
  assert.equal(a.type, 'audio/mpeg');
  assert.equal(a.data.toString(), 'ID3fake-mp3');
  assert.equal(calls[0].url, 'https://api.x.ai/v1/tts');
  assert.equal(calls[0].auth, 'Bearer xai-k');
  assert.deepEqual(calls[0].body, { text: 'Hey you.', voice_id: 'ara', language: 'en', speed: 1.5 });
  const v = await xaiVoices('xai-k', fake);
  assert.deepEqual(v.map((x) => x.id), ['eve', 'ara', 'cv_123']);
  assert.match(v[2].label, /your voice/);
});

test('M6: voice starts off where the server has no local voice (Windows, Mac), on the server engines on Linux', () => {
  assert.deepEqual(defaultEngines('win32'), { stt: 'off', tts: 'off' });
  assert.deepEqual(defaultEngines('darwin'), { stt: 'off', tts: 'off' });
  assert.deepEqual(defaultEngines('linux'), { stt: 'local', tts: 'local' });
});
