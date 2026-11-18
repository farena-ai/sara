// U3.13 test audio: synthetic "voices" made in code, each a pitch (f0) with harmonics shaped by
// three formant resonances (like a held vowel) plus a little pitch wobble and noise, so two takes
// of one voice are alike but never identical. A fake voice-print maker (log energy in 32 bands,
// 80-4000 Hz) stands in for the add-on's model: it reads the audio, it doesn't know the answer.
export const RATE = 16000;
export interface Voice {
  f0: number;
  formants: [number, number, number];
}
/** Eight clearly different voices (low and high pitches, different vowel colors). */
export const VOICES: Voice[] = [
  { f0: 105, formants: [700, 1220, 2600] },
  { f0: 210, formants: [310, 2790, 3300] },
  { f0: 150, formants: [450, 900, 2400] },
  { f0: 260, formants: [850, 1600, 2900] },
  { f0: 125, formants: [300, 870, 2240] },
  { f0: 185, formants: [550, 1900, 2500] },
  { f0: 90, formants: [600, 1700, 3400] },
  { f0: 300, formants: [380, 1300, 2100] },
];

/** Deterministic noise (tests repeat exactly). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}
/** `sec` seconds of one voice (index into VOICES); -1 = quiet. */
export function speak(v: number, sec: number, seed = 1): Float32Array {
  const n = Math.round(RATE * sec);
  const out = new Float32Array(n);
  if (v < 0) return out;
  const voice = VOICES[v];
  const r = rng(seed * 31 + v);
  const amps: number[] = [];
  for (let h = 1; h * voice.f0 < 4000; h++) {
    const f = h * voice.f0;
    // Resonance gain at each harmonic: sum of three bell curves (bandwidth ~ 90-160 Hz).
    const g = voice.formants.reduce((s, F, k) => s + Math.exp(-(((f - F) / (90 + 35 * k)) ** 2)) / (k + 1), 0.02);
    amps.push(g / Math.sqrt(h));
  }
  const norm = 0.25 / amps.reduce((s, a) => s + a, 0);
  let phase = 0;
  const wobble = 0.03 * r();
  for (let i = 0; i < n; i++) {
    const f0 = voice.f0 * (1 + wobble + 0.02 * Math.sin((2 * Math.PI * 4 * i) / RATE));
    phase += (2 * Math.PI * f0) / RATE;
    let s = 0;
    for (let h = 0; h < amps.length; h++) s += amps[h] * Math.sin((h + 1) * phase);
    out[i] = s * norm * 3 + 0.004 * r();
  }
  return out;
}
export type Turn = [voice: number, sec: number];
/** A mono 16-bit WAV of turns back to back ([voice, seconds], voice -1 = a pause). */
export function voicesWav(turns: Turn[], seed = 1): Buffer {
  const parts = turns.map(([v, s], i) => speak(v, s, seed + i));
  const n = parts.reduce((s, p) => s + p.length, 0);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(n * 2, 40);
  let o = 44;
  for (const p of parts)
    for (const x of p) {
      b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x * 32767))), o);
      o += 2;
    }
  return b;
}

/**
 * The fake add-on's voice print: log energy in 32 log-spaced bands (DFT of 512-sample frames),
 * centered on the average of a few reference voices (real voice-print models are centered too).
 */
export function fakePrint(x: Float32Array): number[] {
  center ??= mean([0, 1, 2, 3, 4, 5, 6, 7].map((v) => bandPrint(speak(v, 0.5, 99))));
  const p = bandPrint(x);
  return p.map((v, i) => v - center![i]);
}
let center: number[] | undefined;
const mean = (vs: number[][]) => vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length);
const N = 512;
const edges = Array.from({ length: 33 }, (_, k) => 80 * (4000 / 80) ** (k / 32));
const bandOf = Array.from({ length: N / 2 }, (_, k) => edges.findIndex((edge, i) => i < 32 && (k * RATE) / N >= edge && (k * RATE) / N < edges[i + 1]));
const cosT = Array.from({ length: N / 2 }, (_, k) => Float32Array.from({ length: N }, (_, i) => (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)) * Math.cos((2 * Math.PI * k * i) / N)));
const sinT = Array.from({ length: N / 2 }, (_, k) => Float32Array.from({ length: N }, (_, i) => (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)) * Math.sin((2 * Math.PI * k * i) / N)));
function bandPrint(x: Float32Array): number[] {
  const bands = 32;
  const e = new Array<number>(bands).fill(1e-9);
  for (let a = 0; a + N <= x.length; a += N * 2) {
    for (let k = 1; k < N / 2; k++) {
      const band = bandOf[k];
      if (band < 0) continue;
      let re = 0;
      let im = 0;
      const c = cosT[k];
      const sn = sinT[k];
      for (let i = 0; i < N; i++) {
        re += x[a + i] * c[i];
        im -= x[a + i] * sn[i];
      }
      e[band] += re * re + im * im;
    }
  }
  const logs = e.map((v) => Math.log(v));
  const m = logs.reduce((s, v) => s + v, 0) / bands;
  return logs.map((v) => v - m);
}
/** A fake speaker engine (the add-on's interface) that makes prints with fakePrint. */
export function fakeEngine(state: 'ready' | 'missing' | 'installing' | 'failed' = 'ready') {
  const calls = { ensure: 0, prints: 0, remove: 0 };
  const engine = {
    state,
    fail: false,
    status: () => ({ state: engine.state, mb: 40 }),
    ensure: () => {
      calls.ensure++;
      if (engine.state === 'missing') engine.state = 'installing';
    },
    remove: () => {
      calls.remove++;
      engine.state = 'missing';
    },
    prints: async (samples: Float32Array, windows: [number, number][]) => {
      calls.prints++;
      if (engine.fail) throw new Error('The speaker add-on stopped (test).');
      return windows.map(([a, b]) => fakePrint(samples.subarray(Math.floor(a * RATE), Math.ceil(b * RATE))));
    },
    calls,
  };
  return engine;
}
