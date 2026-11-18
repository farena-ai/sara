// ROADMAP_V V0.2: Talk's streaming hearing in the page (web/voice.js StreamHearing + Call): partial
// words while you speak, the recognizer's endpoint ends the turn sooner, and any trouble falls back
// to the whole-sentence transcribe. A fake microphone and a fake /api/voice/stream.
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error plain browser module
import { Call, StreamHearing } from '../web/voice.js';

const RATE = 16000;
const FRAME = 160; // 10 ms

function fakeMic() {
  return {
    ctx: { sampleRate: RATE },
    chunks: [] as Float32Array[],
    onFrame: null as null | ((f: Float32Array, level: number) => void),
    async open() {},
    start() {
      this.chunks = [];
    },
    stop() {
      const n = this.chunks.length;
      this.chunks = [];
      return n > 20 ? 'WAV' : null;
    },
    trim() {},
    close() {},
  };
}

/** Speaks for `talkMs`, then stays quiet until the utterance is sent (or `maxQuietMs`). Returns ms of quiet used. */
async function drive(mic: ReturnType<typeof fakeMic>, talkMs: number, done: () => boolean, maxQuietMs = 2000): Promise<number> {
  const frame = (v: number) => {
    const f = new Float32Array(FRAME).fill(v);
    mic.chunks.push(f);
    mic.onFrame?.(f, Math.abs(v));
  };
  for (let t = 0; t < talkMs; t += 10) {
    frame(t % 20 ? 0.1 : -0.1);
    await new Promise((r) => setImmediate(r));
  }
  let quiet = 0;
  while (!done() && quiet < maxQuietMs) {
    frame(0);
    quiet += 10;
    await new Promise((r) => setImmediate(r));
  }
  return quiet;
}

const speaker = { speaking: false, stop() {} };

test('V0.2 page: partial words while you speak, the endpoint ends the turn sooner, the stream text is sent', async () => {
  const mic = fakeMic();
  const posts: { bytes: number; end: boolean }[] = [];
  const partials: string[] = [];
  let heard = '';
  let whole = 0;
  const post = async (_id: string, pcm: Uint8Array, end: boolean) => {
    posts.push({ bytes: pcm.length, end });
    const n = posts.length;
    // Endpoint once the speaker has been quiet a little (the fourth piece on).
    return { text: n === 1 ? 'hello' : 'hello there', endpoint: end || n >= 4 };
  };
  const call = new Call({ mic, speaker, transcribe: async () => (whole++, 'WHOLE'), onUtterance: async (t: string) => void (heard = t), onStatus: () => {}, stream: () => new StreamHearing(post, RATE), onPartial: (t: string) => partials.push(t) });
  await call.start();
  const quiet = await drive(mic, 800, () => Boolean(heard));
  for (let i = 0; i < 20 && !heard; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(heard, 'hello there');
  assert.equal(whole, 0, 'no whole-sentence transcribe');
  assert.ok(partials.includes('hello'), `partials ${partials}`);
  assert.ok(quiet < 900, `ended after ${quiet} ms of quiet (the whole-sentence path waits 900)`);
  assert.ok(posts.every((p) => p.bytes <= RATE * 2 * 0.6), 'pieces stay small');
  assert.equal(posts.at(-1)!.end, true);
});

test('V0.2 page: a failing stream falls back to the whole-sentence transcribe; no stream is the old path', async () => {
  for (const stream of [() => new StreamHearing(async () => { throw new Error('409'); }, RATE), undefined]) {
    const mic = fakeMic();
    let heard = '';
    const call = new Call({ mic, speaker, transcribe: async () => 'WHOLE', onUtterance: async (t: string) => void (heard = t), onStatus: () => {}, stream, onPartial: () => {} });
    await call.start();
    const quiet = await drive(mic, 600, () => Boolean(heard));
    for (let i = 0; i < 20 && !heard; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(heard, 'WHOLE');
    assert.ok(quiet >= 900, 'waits the usual silence without an endpoint');
  }
});

test('V0.2 page: StreamHearing sends 16-bit PCM at 16 kHz in order, one piece at a time', async () => {
  const seen: number[][] = [];
  let inFlight = 0;
  let most = 0;
  const h = new StreamHearing(async (_id: string, pcm: Uint8Array, end: boolean) => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    const v = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
    seen.push([v.length, v[0], end ? 1 : 0]);
    return { text: `n${seen.length}`, endpoint: end };
  }, 48000);
  h.begin([new Float32Array(4800).fill(0.5)]);
  for (let i = 0; i < 30; i++) h.add(new Float32Array(480).fill(0.5));
  const text = await h.finish();
  assert.equal(most, 1, 'never two pieces at once');
  assert.equal(seen.at(-1)![2], 1);
  assert.equal(seen.reduce((a, s) => a + s[0], 0), (4800 + 30 * 480) / 3, '48 kHz → 16 kHz');
  assert.equal(seen[0][1], Math.round(0.5 * 0x7fff));
  assert.equal(text, `n${seen.length}`);
});

test('V0.2 page: with the whole-sentence model loaded, the turn still ends at the endpoint but its words are used', async () => {
  const mic = fakeMic();
  let heard = '';
  let n = 0;
  const post = async () => ({ text: 'helo their', endpoint: ++n >= 4, loaded: true });
  const call = new Call({ mic, speaker, transcribe: async () => 'hello there', onUtterance: async (t: string) => void (heard = t), onStatus: () => {}, stream: () => new StreamHearing(post, RATE), onPartial: () => {} });
  await call.start();
  const quiet = await drive(mic, 800, () => Boolean(heard));
  for (let i = 0; i < 20 && !heard; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(heard, 'hello there');
  assert.ok(quiet < 900, `ended after ${quiet} ms of quiet`);
});
