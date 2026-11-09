// EC19 test audio: short 16 kHz mono WAV clips made in code. Each clip is one constant sample value
// (its marker), so a fake hearing engine can map a clip, or a piece cut from a recording, to words.
/** A 16 kHz mono 16-bit WAV of `sec` seconds; every sample is `value` (the clip's marker). */
export function clip(value: number, sec = 1): Buffer {
  const n = Math.round(16000 * sec);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(value, 44 + i * 2);
  return b;
}
/** Several clips back to back in one WAV (a "recording"). */
export const recording = (parts: [number, number][]) => {
  const pcm = Buffer.concat(parts.map(([v, s]) => clip(v, s).subarray(44)));
  const head = Buffer.from(clip(0, 0).subarray(0, 44));
  head.writeUInt32LE(36 + pcm.length, 4);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
};

