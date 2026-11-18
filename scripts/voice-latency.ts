// U4.24 + U5 (docs/VOICE_FIRST.md): end of your words → first audio of her reply, with local hearing
// and voice from $SARA_VOICE_DIR/voice.json (sherpa-onnx), Sara's real talk turn through a local Ollama
// model, one-shot tools vs. the loaded workers (deploy/voice/sara-voice-worker).
//   SARA_VOICE_DIR=<dir> node scripts/voice-latency.ts <ollama model> [runs=5] [oneshot|warm] [voice id]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTurn } from '../src/chat.ts';
import { createProvider } from '../src/providers/registry.ts';
import { LocalVoiceEngine } from '../src/voice.ts';
import { makeApp, tempDir } from '../test/helpers.ts';

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
