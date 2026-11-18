// S2 (docs/MEETINGS.md "Who said what"): best-effort speakers for a meeting recording, with no model
// and no network. Two ways:
//  - by channel: a recording from the desktop app is stereo, left = this computer's microphone (you),
//    right = the computer's sound (everyone on the call). Each 20 ms frame goes to the louder channel.
//  - by pauses: anything else is mixed to mono, cut at pauses (0.6 s of quiet) into turns, and the
//    turns are grouped into at most two voices by their pitch (autocorrelation; two groups only when
//    they really differ, else one voice).
// The turns are then cut out of the recording (mono WAV) and heard one by one. Never perfect: two
// similar voices stay "Speaker 1", crosstalk goes to the louder side; the person can rename labels.
// U3.13 (docs/design/U3SPEAK.md): with the speaker add-on, uploads and mono recordings are told apart
// by voice prints instead (diarizeByVoice, up to 8 speakers); without it, the pauses way above.
import { clusterVoices, segmentsOf, windowsOf, type Merge } from './speaker-cluster.ts';

export interface Pcm {
  rate: number;
  ch: Float32Array[];
}
export interface Segment {
  start: number;
  end: number;
  speaker: number;
}
export interface Diarized {
  mode: 'channel' | 'pauses';
  segments: Segment[];
  /** The voices' pitches (log Hz), to keep labels steady across the parts of one long upload. */
  centers: number[];
}

const FRAME_SEC = 0.02;
const GAP_SEC = 0.6;
const MIN_SEC = 0.3;
const MERGE_GAP_SEC = 1.5;
const MAX_SEC = 45;
const PAD_SEC = 0.15;

/** The samples of a PCM WAV (8/16/24/32-bit integer or 32-bit float), each channel scaled to -1..1. */
export function readPcm(b: Buffer): Pcm {
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt: Buffer | undefined;
  let data: Buffer | undefined;
  for (let o = 12; o + 8 <= b.length; ) {
    const id = b.toString('ascii', o, o + 4);
    const size = b.readUInt32LE(o + 4);
    const body = b.subarray(o + 8, Math.min(b.length, o + 8 + size));
    if (id === 'fmt ') fmt = body;
    if (id === 'data') data = body;
    o += 8 + size + (size % 2);
  }
  if (!fmt || !data || fmt.length < 16) throw new Error('not a WAV file');
  const tag = fmt.readUInt16LE(0);
  const channels = Math.max(1, fmt.readUInt16LE(2));
  const rate = fmt.readUInt32LE(4);
  const bits = fmt.readUInt16LE(14);
  const bytes = bits / 8;
  const float = tag === 3 || (tag === 0xfffe && bits === 32 && fmt.length >= 26 && fmt.readUInt16LE(24) === 3);
  if (![1, 3, 0xfffe].includes(tag) || ![8, 16, 24, 32].includes(bits) || rate < 4000) throw new Error('not a PCM WAV');
  const frames = Math.floor(data.length / (bytes * channels));
  const ch = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * bytes;
      ch[c][i] = float ? data.readFloatLE(o) : bits === 16 ? data.readInt16LE(o) / 32768 : bits === 8 ? (data[o] - 128) / 128 : bits === 24 ? data.readIntLE(o, 3) / 8388608 : data.readInt32LE(o) / 2147483648;
    }
  return { rate, ch };
}

/** A mono 16-bit WAV of [start, end) seconds (all channels mixed). */
export function cutWav(p: Pcm, start = 0, end = Infinity): Buffer {
  const total = p.ch[0]?.length ?? 0;
  const a = Math.max(0, Math.floor(start * p.rate));
  const z = Math.min(total, Math.ceil(Math.min(end, total / p.rate) * p.rate));
  const n = Math.max(0, z - a);
  const out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + n * 2, 4);
  out.write('WAVEfmt ', 8, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(p.rate, 24);
  out.writeUInt32LE(p.rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(n * 2, 40);
  const k = p.ch.length;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const c of p.ch) v += c[a + i];
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((v / k) * 32767))), 44 + i * 2);
  }
  return out;
}

export const pcmSeconds = (p: Pcm): number => (p.ch[0]?.length ?? 0) / p.rate;

function frameRms(x: Float32Array, rate: number): Float32Array {
  const step = Math.max(1, Math.round(rate * FRAME_SEC));
  const out = new Float32Array(Math.floor(x.length / step));
  for (let f = 0; f < out.length; f++) {
    let s = 0;
    for (let i = f * step; i < (f + 1) * step; i++) s += x[i] * x[i];
    out[f] = Math.sqrt(s / step);
  }
  return out;
}
/** Speech threshold: well above the quiet floor (10th percentile), never below about -44 dBFS. */
function threshold(rms: Float32Array): number {
  if (!rms.length) return 1;
  const sorted = [...rms].sort((a, b) => a - b);
  return Math.max(0.006, sorted[Math.floor(sorted.length * 0.1)] * 4);
}
/** Runs of frames with the same label (-1 = quiet), short quiet gaps inside one speaker's run bridged. */
function runs(labels: Int8Array): Segment[] {
  const out: Segment[] = [];
  const gap = Math.round(GAP_SEC / FRAME_SEC);
  let cur: { a: number; z: number; s: number } | undefined;
  for (let f = 0; f < labels.length; f++) {
    const s = labels[f];
    if (s < 0) continue;
    if (cur && cur.s === s && f - cur.z <= gap) cur.z = f + 1;
    else {
      if (cur) out.push({ start: cur.a * FRAME_SEC, end: cur.z * FRAME_SEC, speaker: cur.s });
      cur = { a: f, z: f + 1, s };
    }
  }
  if (cur) out.push({ start: cur.a * FRAME_SEC, end: cur.z * FRAME_SEC, speaker: cur.s });
  return out.filter((x) => x.end - x.start >= MIN_SEC);
}

/** The main pitch (Hz) of a stretch: autocorrelation over 40 ms windows, the median of voiced ones. */
function pitch(x: Float32Array, rate: number, start: number, end: number): number {
  const win = Math.round(rate * 0.04);
  const minLag = Math.floor(rate / 400);
  const maxLag = Math.ceil(rate / 70);
  const found: number[] = [];
  const a0 = Math.floor(start * rate);
  const z0 = Math.min(x.length - win - maxLag, Math.floor(end * rate));
  const hop = Math.max(win, Math.floor((z0 - a0) / 40));
  for (let a = a0; a < z0; a += hop) {
    let e = 0;
    for (let i = 0; i < win; i++) e += x[a + i] * x[a + i];
    if (e / win < 0.006 * 0.006) continue;
    const corr: number[] = [];
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i < win; i++) s += x[a + i] * x[a + i + lag];
      corr.push(s);
      best = Math.max(best, s);
    }
    if (best <= 0.3 * e) continue;
    // The first peak near the best one (a period's multiples correlate as well).
    const i = corr.findIndex((v, k) => v >= 0.9 * best && (k === 0 || v >= corr[k - 1]) && (k === corr.length - 1 || v >= corr[k + 1]));
    if (i >= 0) found.push(rate / (minLag + i));
  }
  if (!found.length) return 0;
  found.sort((p, q) => p - q);
  return found[Math.floor(found.length / 2)];
}

/** Two voices only when their pitches differ by 20% or more and the smaller group has 10% of turns. */
function twoVoices(logs: number[], prior: number[]): { labels: number[]; centers: number[] } {
  const voiced = logs.filter((v) => v > 0);
  const apart = Math.log(1.2);
  if (prior.length === 2) return { labels: logs.map((v) => (v > 0 && Math.abs(v - prior[1]) < Math.abs(v - prior[0]) ? 1 : 0)), centers: prior };
  if (voiced.length < 2) return { labels: logs.map(() => 0), centers: prior.length ? prior : voiced.length ? [voiced[0]] : [] };
  let c = [Math.min(...voiced), Math.max(...voiced)];
  for (let it = 0; it < 12; it++) {
    const g: number[][] = [[], []];
    for (const v of voiced) g[Math.abs(v - c[0]) <= Math.abs(v - c[1]) ? 0 : 1].push(v);
    c = g.map((xs, k) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : c[k]));
  }
  const near = (v: number) => (Math.abs(v - c[0]) <= Math.abs(v - c[1]) ? 0 : 1);
  const small = Math.min(...[0, 1].map((k) => voiced.filter((v) => near(v) === k).length));
  if (Math.abs(c[1] - c[0]) < apart || small < Math.max(1, voiced.length * 0.1)) {
    const mean = voiced.reduce((s, v) => s + v, 0) / voiced.length;
    if (prior.length === 1 && Math.abs(mean - prior[0]) >= apart) return { labels: logs.map(() => 1), centers: [prior[0], mean] };
    return { labels: logs.map(() => 0), centers: prior.length ? prior : [mean] };
  }
  // Speaker 1 is the voice heard first (or the one nearest the voice already called Speaker 1).
  let first = near(voiced[0]);
  if (prior.length === 1) first = Math.abs(c[0] - prior[0]) <= Math.abs(c[1] - prior[0]) ? 0 : 1;
  const centers = first === 0 ? c : [c[1], c[0]];
  return { labels: logs.map((v) => (v > 0 ? (near(v) === first ? 0 : 1) : 0)), centers };
}

/** Bridges short gaps between turns of one speaker and caps each turn at MAX_SEC. */
function tidy(segs: Segment[], total: number): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker && s.start - last.end < MERGE_GAP_SEC && s.end - last.start <= MAX_SEC) last.end = s.end;
    else out.push({ ...s });
  }
  const capped: Segment[] = [];
  for (const s of out)
    for (let a = s.start; a < s.end; a += MAX_SEC) capped.push({ start: a, end: Math.min(s.end, a + MAX_SEC), speaker: s.speaker });
  return capped.map((s) => ({ start: Math.max(0, s.start - PAD_SEC), end: Math.min(total, s.end + PAD_SEC), speaker: s.speaker }));
}

/** All channels mixed to one. */
function monoOf(p: Pcm): Float32Array {
  if (p.ch.length === 1) return p.ch[0];
  const m = new Float32Array(p.ch[0].length);
  for (const c of p.ch) for (let i = 0; i < m.length; i++) m[i] += c[i] / p.ch.length;
  return m;
}
/** Speech turns, pause to pause (0.6 s of quiet), of the mixed recording. */
export function speechTurns(p: Pcm): { mono: Float32Array; turns: Segment[] } {
  const mono = monoOf(p);
  const rms = frameRms(mono, p.rate);
  const thr = threshold(rms);
  const labels = new Int8Array(rms.length).fill(-1);
  for (let f = 0; f < labels.length; f++) if (rms[f] > thr) labels[f] = 0;
  return { mono, turns: runs(labels) };
}
/** The samples at 16 kHz (linear interpolation; what voice-print models expect). */
export function to16k(x: Float32Array, rate: number): Float32Array {
  if (rate === 16000) return x;
  const n = Math.floor((x.length * 16000) / rate);
  const out = new Float32Array(n);
  const step = rate / 16000;
  for (let i = 0; i < n; i++) {
    const at = i * step;
    const a = Math.floor(at);
    const f = at - a;
    out[i] = x[a] * (1 - f) + (x[Math.min(x.length - 1, a + 1)] ?? 0) * f;
  }
  return out;
}

export interface VoiceDiarized {
  mode: 'voices';
  segments: Segment[];
  /** Each speaker's voice print (unit length), kept so later parts of one upload keep the numbers. */
  centers: number[][];
  /** Voices kept as one (sounded alike, or more than 8 speakers), for the notice. */
  merges: Merge[];
}
/** Most windows per part (a 10-minute part of nonstop talk at the normal step is about 800). */
const MAX_WINDOWS = 1200;

/**
 * U3.13: speakers by voice print. Turns (pauses) are cut into 1.5 s windows, each gets a voice print
 * from the add-on, the prints are grouped (src/speaker-cluster.ts), and a change of voice inside a
 * turn starts a new segment. Throws when the add-on fails (the caller falls back to diarize()).
 */
export async function diarizeByVoice(p: Pcm, prints: (samples: Float32Array, windows: [number, number][]) => Promise<number[][]>, prior: number[][] = []): Promise<VoiceDiarized> {
  const total = pcmSeconds(p);
  const { mono, turns } = speechTurns(p);
  if (!turns.length) return { mode: 'voices', segments: [], centers: prior, merges: [] };
  const speech = turns.reduce((s, t) => s + t.end - t.start, 0);
  const hop = Math.max(0.75, speech / MAX_WINDOWS);
  const all = windowsOf(turns, Math.max(1.5, hop * 2), hop);
  const got = await prints(to16k(mono, p.rate), all.map((w) => [w.start, w.end]));
  const keep = all.map((_, i) => i).filter((i) => (got[i]?.length ?? 0) > 0);
  if (!keep.length) throw new Error('No voice prints.');
  const windows = keep.map((i) => all[i]);
  const c = clusterVoices(keep.map((i) => got[i]), windows, prior);
  return { mode: 'voices', segments: tidy(segmentsOf(windows, c.labels), total), centers: c.centers, merges: c.merges };
}

export function diarize(p: Pcm, opts: { byChannel: boolean; centers?: number[] }): Diarized {
  const total = pcmSeconds(p);
  if (opts.byChannel && p.ch.length >= 2) {
    const rms = p.ch.slice(0, 2).map((c) => frameRms(c, p.rate));
    const thr = rms.map(threshold);
    const labels = new Int8Array(rms[0].length).fill(-1);
    for (let f = 0; f < labels.length; f++) {
      const on = [rms[0][f] > thr[0], rms[1][f] > thr[1]];
      if (on[0] || on[1]) labels[f] = on[0] && on[1] ? (rms[0][f] >= rms[1][f] ? 0 : 1) : on[0] ? 0 : 1;
    }
    return { mode: 'channel', segments: tidy(runs(labels), total), centers: [] };
  }
  const { mono, turns } = speechTurns(p);
  const logs = turns.map((s) => {
    const hz = pitch(mono, p.rate, s.start, s.end);
    return hz > 0 ? Math.log(hz) : 0;
  });
  const { labels: who, centers } = twoVoices(logs, opts.centers ?? []);
  return { mode: 'pauses', segments: tidy(turns.map((s, i) => ({ ...s, speaker: who[i] })), total), centers };
}
