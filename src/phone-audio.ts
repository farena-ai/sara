// R5 (docs/PHONE_CALLS.md): phone audio without dependencies. Phone networks carry 8 kHz G.711 μ-law
// (Twilio Media Streams sends and takes base64 μ-law in 20 ms frames of 160 bytes). Her hearing wants
// WAV and her voice makes WAV (the server's own voice, an OpenAI-compatible speech API) or raw 16 kHz
// PCM (ElevenLabs): these helpers convert between them. MP3 (Grok voice) can't be decoded here.

export const PHONE_RATE = 8000;
/** 20 ms at 8 kHz: one Media Streams frame. */
export const FRAME_BYTES = 160;

/** One μ-law byte to a 16-bit sample (ITU-T G.711). */
export function ulawToPcm(u: number): number {
  const x = ~u & 0xff;
  const sign = x & 0x80;
  const exponent = (x >> 4) & 0x07;
  const mantissa = x & 0x0f;
  const s = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return sign ? -s : s;
}

/** One 16-bit sample to μ-law. */
export function pcmToUlaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function decodeUlaw(buf: Buffer): Int16Array {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = ulawToPcm(buf[i]!);
  return out;
}

export function encodeUlaw(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcmToUlaw(pcm[i]!);
  return out;
}

/** Linear resampling (good enough for speech on a phone line). */
export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to || !pcm.length) return pcm;
  const n = Math.max(1, Math.round((pcm.length * to) / from));
  const out = new Int16Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * step;
    const a = Math.floor(p);
    const b = Math.min(pcm.length - 1, a + 1);
    const f = p - a;
    out[i] = Math.round((pcm[Math.min(a, pcm.length - 1)]! * (1 - f)) + pcm[b]! * f);
  }
  return out;
}

/** Mono 16-bit PCM as a WAV file. */
export function pcmToWav(pcm: Int16Array, rate: number): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** A WAV file's samples (16-bit PCM, any rate, channels mixed down), or undefined. */
export function wavToPcm(wav: Buffer): { pcm: Int16Array; rate: number } | undefined {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  let off = 12;
  let rate = 0;
  let channels = 1;
  let bits = 16;
  let format = 1;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    let size = wav.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      format = wav.readUInt16LE(body);
      channels = wav.readUInt16LE(body + 2);
      rate = wav.readUInt32LE(body + 4);
      bits = wav.readUInt16LE(body + 14);
    } else if (id === 'data') {
      // Streamed WAVs (OpenAI) may say 0xFFFFFFFF: read to the end.
      if (size === 0xffffffff || body + size > wav.length) size = wav.length - body;
      if ((format !== 1 && format !== 0xfffe) || bits !== 16 || !rate || channels < 1) return undefined;
      const frames = Math.floor(size / (2 * channels));
      const pcm = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += wav.readInt16LE(body + (i * channels + c) * 2);
        pcm[i] = Math.round(sum / channels);
      }
      return { pcm, rate };
    }
    off = body + size + (size % 2);
  }
  return undefined;
}

/** Her voice (WAV, or raw `audio/L16;rate=N` PCM) as 8 kHz μ-law for the phone line, or undefined (MP3). */
export function audioToUlaw(audio: { data: Buffer; type: string }): Buffer | undefined {
  const raw = /^audio\/(?:L16|pcm)\b(?:.*rate=(\d+))?/i.exec(audio.type);
  if (raw) {
    const even = audio.data.subarray(0, audio.data.length - (audio.data.length % 2));
    const pcm = new Int16Array(even.length / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = even.readInt16LE(i * 2);
    return encodeUlaw(resample(pcm, Number(raw[1] ?? 16000), PHONE_RATE));
  }
  if (/^audio\/(?:basic|x-mulaw|mulaw)/i.test(audio.type)) return audio.data;
  const w = wavToPcm(audio.data);
  return w ? encodeUlaw(resample(w.pcm, w.rate, PHONE_RATE)) : undefined;
}

/** What the caller said (8 kHz μ-law) as a 16 kHz WAV for her hearing. */
export function ulawToWav(ulaw: Buffer, rate = 16000): Buffer {
  return pcmToWav(resample(decodeUlaw(ulaw), PHONE_RATE, rate), rate);
}

/** Loudness of one frame (RMS of the samples). */
export function frameLevel(ulaw: Buffer): number {
  if (!ulaw.length) return 0;
  let sum = 0;
  for (let i = 0; i < ulaw.length; i++) {
    const s = ulawToPcm(ulaw[i]!);
    sum += s * s;
  }
  return Math.sqrt(sum / ulaw.length);
}

/** Splits μ-law audio into 20 ms frames (the last one padded with silence). */
export function frames(ulaw: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < ulaw.length; i += FRAME_BYTES) {
    const f = ulaw.subarray(i, i + FRAME_BYTES);
    out.push(f.length === FRAME_BYTES ? f : Buffer.concat([f, Buffer.alloc(FRAME_BYTES - f.length, 0xff)]));
  }
  return out;
}
