// S2 test audio: short synthetic 16 kHz WAVs made in code. "Voices" are pure tones (a low one and a
// high one) with silent pauses between turns, so the pause/pitch diarizer and the channel diarizer
// have something real to separate, and a fake hearing engine can tell which voice a piece holds by
// counting zero crossings.
export const RATE = 16000;
export type Turn = [freq: number, sec: number];

/** Samples of one turn: a tone at `freq` Hz (0 = silence). */
export function tone(freq: number, sec: number, amp = 9000): Int16Array {
  const n = Math.round(RATE * sec);
  const out = new Int16Array(n);
  if (freq > 0) for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / RATE));
  return out;
}
const concat = (xs: Int16Array[]) => {
  const out = new Int16Array(xs.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of xs) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
function wavHead(channels: number, frames: number): Buffer {
  const bytes = frames * channels * 2;
  const b = Buffer.alloc(44);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + bytes, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(bytes, 40);
  return b;
}
/** A mono WAV of turns back to back ([freq, seconds], freq 0 = a pause). */
export function monoWav(turns: Turn[]): Buffer {
  const pcm = concat(turns.map(([f, s]) => tone(f, s)));
  return Buffer.concat([wavHead(1, pcm.length), Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}
/** A stereo WAV: left = the microphone, right = the computer's sound (turns per channel, same length). */
export function stereoWav(left: Turn[], right: Turn[]): Buffer {
  const l = concat(left.map(([f, s]) => tone(f, s)));
  const r = concat(right.map(([f, s]) => tone(f, s)));
  const n = Math.max(l.length, r.length);
  const pcm = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    pcm[i * 2] = l[i] ?? 0;
    pcm[i * 2 + 1] = r[i] ?? 0;
  }
  return Buffer.concat([wavHead(2, n), Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}
/** The main pitch of a mono 16-bit WAV piece, by zero crossings (0: silence). */
export function pitchOf(wav: Buffer): number {
  const ch = wav.readUInt16LE(22);
  const n = Math.floor((wav.length - 44) / (2 * ch));
  let crossings = 0;
  let loud = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let c = 0; c < ch; c++) v += wav.readInt16LE(44 + (i * ch + c) * 2);
    if (Math.abs(v) > 300) loud++;
    if ((prev < 0 && v >= 0) || (prev >= 0 && v < 0)) crossings++;
    prev = v;
  }
  if (loud < n * 0.2) return 0;
  return crossings / 2 / (n / RATE);
}
