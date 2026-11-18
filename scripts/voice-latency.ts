// U4.24 + U5 (docs/VOICE_FIRST.md): end of your words → first audio of her reply, with local hearing
// and voice from $SARA_VOICE_DIR/voice.json (sherpa-onnx), Sara's real talk turn through a local Ollama
// model, one-shot tools vs. the loaded workers (deploy/voice/sara-voice-worker).
//   SARA_VOICE_DIR=<dir> node scripts/voice-latency.ts <ollama model> [runs=5] [oneshot|warm] [voice id]
// V0.2: hearing only (no model needed), whole sentences vs. words as you speak (the streaming model):
//   SARA_VOICE_DIR=<dir> node scripts/voice-latency.ts hearing [runs=6] [voice id]
// "End → text" = the page's wait after your last word plus the hearing time: whole sentences wait
// 0.9 s of silence, then transcribe; streaming ends at the model's endpoint (at least 0.3 s), then
// finishes the stream. Word error rate against the sentence her voice read.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTurn } from '../src/chat.ts';
import { createProvider } from '../src/providers/registry.ts';
import { LocalVoiceEngine } from '../src/voice.ts';
import { makeApp, tempDir } from '../test/helpers.ts';

if (process.argv[2] === 'hearing') {
  await hearing();
  process.exit(0);
}

async function hearing(): Promise<void> {
  const runs = Number(process.argv[3] ?? 6);
  const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
  const vd = process.env.SARA_VOICE_DIR!;
  const voice = process.argv[4] ?? (JSON.parse(readFileSync(join(vd, 'voice.json'), 'utf8')) as { voices: { id: string }[] }).voices[0]!.id;
  const { dir: d, cleanup: done } = tempDir();
  const e = new LocalVoiceEngine(vd, d, { warm: { idleMs: () => 600_000 } });
  const say = ['What is a good name for a black cat?', 'How long should I boil an egg?', 'Give me one tip for sleeping better.', 'Remind me to call my sister tomorrow at noon.', 'Should I take an umbrella if it is cloudy?', 'What can I cook with rice and eggs?', 'Turn the living room lights off in ten minutes.', 'Read me the first email from Dana.'];
  const words = (x: string) => x.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
  const wer = (ref: string, hyp: string) => {
    const r = words(ref), h = words(hyp);
    const dp = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
    for (let j = 1; j <= h.length; j++) dp[0]![j] = j;
    for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
    return dp[r.length]![h.length]! / Math.max(1, r.length);
  };
  /** 16 kHz mono 16-bit PCM from a WAV (linear resampling, like the page). */
  const pcm16k = (wav: Buffer): Buffer => {
    let o = 12;
    let data: Buffer = Buffer.alloc(0);
    while (o + 8 <= wav.length) {
      const id = wav.toString('ascii', o, o + 4), n = wav.readUInt32LE(o + 4);
      if (id === 'data') { data = wav.subarray(o + 8, o + 8 + n); break; }
      o += 8 + n;
    }
    const rate = wav.readUInt32LE(24), src = data.length >> 1, len = Math.floor((src * 16000) / rate), out = Buffer.alloc(len * 2);
    for (let i = 0; i < len; i++) {
      const x = (i * rate) / 16000, i0 = Math.floor(x), i1 = Math.min(i0 + 1, src - 1);
      const a = data.readInt16LE(i0 * 2), b = data.readInt16LE(i1 * 2);
      out.writeInt16LE(Math.round(a + (b - a) * (x - i0)), i * 2);
    }
    return out;
  };
  const wavOf = (p: Buffer) => {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + p.length, 4); h.write('WAVE', 8, 'ascii'); h.write('fmt ', 12, 'ascii');
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36, 'ascii'); h.writeUInt32LE(p.length, 40);
    return Buffer.concat([h, p]);
  };
  try {
    let t = process.hrtime.bigint();
    await e.warm(voice, { streaming: true });
    const load = Math.round(ms(t));
    const out: Record<string, number | string>[] = [];
    for (let i = 0; i < runs + 1; i++) {
      const ref = say[i % say.length]!;
      const speech = pcm16k((await e.speak(ref, voice, 1)).data as Buffer);
      t = process.hrtime.bigint();
      const whole = await e.transcribe(wavOf(speech));
      const wholeMs = ms(t);
      // Streaming: real-time-sized pieces (0.25 s) while "speaking", then quiet until the endpoint.
      const id = `lat${i}`;
      const quiet = Buffer.alloc(8000);
      const pieceMs: number[] = [];
      let r = { text: '', endpoint: false };
      for (let o = 0; o < speech.length; o += 8000) {
        t = process.hrtime.bigint();
        r = await e.hear(id, speech.subarray(o, o + 8000), false);
        pieceMs.push(ms(t));
      }
      let after = 0;
      while (!r.endpoint && after < 900) {
        r = await e.hear(id, quiet, false);
        after += 250;
      }
      t = process.hrtime.bigint();
      const fin = await e.hear(id, Buffer.alloc(0), true);
      const finMs = ms(t);
      pieceMs.sort((a, b) => a - b);
      // At the endpoint the page takes the words it has (web/voice.js Call); else it finishes the stream.
      // The page's own 0.9 s silence rule wins over a later endpoint.
      const early = r.endpoint && Boolean(r.text) && after <= 900;
      const streamed = early ? r.text : fin.text;
      const streamEnd = early ? Math.max(300, after) + pieceMs[pieceMs.length >> 1]! : 900 + finMs;
      // With the whole-sentence model loaded the page ends at the endpoint, then re-hears with it.
      const bothEnd = early ? Math.max(300, after) + pieceMs[pieceMs.length >> 1]! + wholeMs : 900 + wholeMs;
      const row = { run: i === 0 ? 'warm-up' : i, said: ref, whole, streamed, wholeEndToText: Math.round(900 + wholeMs), streamEndToText: Math.round(streamEnd), streamThenWholeEndToText: Math.round(bothEnd), endpointAfter: early ? after : 'none', pieceMedian: Math.round(pieceMs[pieceMs.length >> 1]!), werWhole: +wer(ref, whole).toFixed(2), werStream: +wer(ref, streamed).toFixed(2) };
      out.push(row);
      console.log(JSON.stringify(row));
    }
    const real = out.filter((x) => x.run !== 'warm-up');
    const med = (k: string) => real.map((x) => x[k] as number).sort((a, b) => a - b)[real.length >> 1];
    const avg = (k: string) => +(real.reduce((a, x) => a + (x[k] as number), 0) / real.length).toFixed(3);
    console.log(JSON.stringify({ mode: 'hearing', load, workers: e.workerStates(), medianWholeEndToText: med('wholeEndToText'), medianStreamEndToText: med('streamEndToText'), medianStreamThenWhole: med('streamThenWholeEndToText'), endpoints: real.filter((x) => x.endpointAfter !== 'none').length, of: real.length, medianPiece: med('pieceMedian'), werWhole: avg('werWhole'), werStream: avg('werStream') }));
  } finally {
    e.stopWorkers();
    done();
  }
}

const MODEL = process.argv[2] ?? 'qwen3.5:9b';
const RUNS = Number(process.argv[3] ?? 5);
const MODE = process.argv[4] ?? 'warm';
const vdir = process.env.SARA_VOICE_DIR;
if (!vdir) throw new Error('Set SARA_VOICE_DIR to a folder with voice.json (sara voice install or deploy/install-voice.sh).');
const VOICE = process.argv[5] ?? (JSON.parse(readFileSync(join(vdir, 'voice.json'), 'utf8')) as { voices: { id: string }[] }).voices[0]!.id;
const { dir, cleanup } = tempDir();
const eng = new LocalVoiceEngine(vdir, dir, MODE === 'warm' ? { warm: { idleMs: () => 600_000 } } : {});
if (MODE === 'warm') await eng.warm(VOICE);
const app = makeApp(dir, { get now() { return new Date(); } } as never);
app.providerFactory = createProvider;
app.settings.update({ providers: [{ id: 'ollama', kind: 'openai-compatible', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: MODEL, needsKey: false }], defaultProviderId: 'ollama', defaultModel: MODEL, ownerName: 'Alex', disclosureAcceptedAt: new Date().toISOString() } as never);

const questions = ['What is a good name for a black cat?', 'How long should I boil an egg?', 'Give me one tip for sleeping better.', 'What is the capital of Portugal?', 'Should I take an umbrella if it is cloudy?', 'What can I cook with rice and eggs?'];
const SENT = /^[\s\S]*[.!?…](?=["')\]]?\s)["')\]]?/;
const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
const rows: Record<string, number | string>[] = [];
try {
  // The question as audio (her own voice reads it; 22 kHz WAV as a mic would give after resampling).
  for (let i = 0; i < RUNS + 1; i++) {
    const q = questions[i % questions.length]!;
    const wav = (await eng.speak(q, VOICE, 1)).data as Buffer;
    let t = process.hrtime.bigint();
    const heard = await eng.transcribe(wav);
    const stt = ms(t);
    const conv = app.store.createConversation({ title: 'latency' });
    t = process.hrtime.bigint();
    let text = '';
    let first = '';
    let firstAt = 0;
    let tokenAt = 0;
    for await (const ev of runTurn(app, conv.id, heard || q, new AbortController().signal, { talk: true })) {
      if ((ev as { type: string }).type === 'token') {
        if (!tokenAt) tokenAt = ms(t);
        text += (ev as { text: string }).text;
        const m = text.match(SENT);
        if (!first && m && m[0].trim().length >= 12) {
          first = m[0].trim();
          firstAt = ms(t);
        }
      }
    }
    if (!first) {
      first = text.trim();
      firstAt = ms(t);
    }
    t = process.hrtime.bigint();
    await eng.speak(first, VOICE, 1);
    const tts = ms(t);
    const row = { mode: MODE, run: i === 0 ? 'warm-up' : i, heard, stt: Math.round(stt), firstToken: Math.round(tokenAt), firstSentence: Math.round(firstAt), tts: Math.round(tts), total: Math.round(stt + firstAt + tts), sentence: first.slice(0, 80) };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  const real = rows.filter((r) => r.run !== 'warm-up').map((r) => r.total as number).sort((a, b) => a - b);
  console.log(JSON.stringify({ mode: MODE, workers: eng.workerStates(), model: MODEL, median: real[Math.floor(real.length / 2)], best: real[0], worst: real.at(-1) }));
} finally {
  eng.stopWorkers();
  app.store.close();
  cleanup();
}
