// Voice in the browser: microphone capture (16 kHz mono WAV), Sara's voice (sentence-by-sentence
// playback while she is still writing), and hands-free call mode with interruption.

/** Encodes mono Float32 samples as 16-bit PCM WAV. */
export function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Linear-interpolation resampler to 16 kHz. */
export function resample(samples, from, to = 16000) {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    out[i] = samples[i0] + (samples[i1] - samples[i0]) * (x - i0);
  }
  return out;
}

const rms = (f) => {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return Math.sqrt(s / f.length);
};

/** Microphone capture. onFrame(frame, level) is called for every ~3 ms block. */
export class Mic {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.chunks = [];
    this.recording = false;
    this.onFrame = null;
  }

  async open() {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule('/recorder-worklet.js');
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'sara-recorder');
    this.node.port.onmessage = (e) => {
      const f = e.data;
      if (this.recording) this.chunks.push(f);
      const level = rms(f);
      this.onFrame?.(f, level);
      // V4b: her orb's waveform follows the open mic (web/orb.js), at most ~30 times a second.
      const now = Date.now();
      if (now - (this.levelAt ?? 0) > 33) {
        this.levelAt = now;
        globalThis.dispatchEvent?.(new CustomEvent('sara-mic-level', { detail: level }));
      }
    };
    src.connect(this.node);
  }

  start() {
    this.chunks = [];
    this.recording = true;
  }

  /** Stops recording; returns a 16 kHz WAV blob (or null if too short). */
  stop(minMs = 300) {
    this.recording = false;
    const n = this.chunks.reduce((a, c) => a + c.length, 0);
    if (!this.ctx || n < (this.ctx.sampleRate * minMs) / 1000) return null;
    const all = new Float32Array(n);
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    this.chunks = [];
    return encodeWav(resample(all, this.ctx.sampleRate), 16000);
  }

  /** Keeps only the last `ms` of audio (pre-roll while waiting for speech). */
  trim(ms) {
    if (!this.ctx) return;
    const keep = (this.ctx.sampleRate * ms) / 1000;
    let total = this.chunks.reduce((a, c) => a + c.length, 0);
    while (this.chunks.length > 1 && total - this.chunks[0].length >= keep) total -= this.chunks.shift().length;
  }

  close() {
    this.recording = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.ctx = this.stream = this.node = null;
  }
}

/**
 * Sara's voice. feed() streamed text; complete sentences are synthesized (2 in flight) and played
 * in order. Code blocks are not read out.
 */
export class Speaker {
  constructor(fetchAudio) {
    this.fetchAudio = fetchAudio;
    this.queue = [];
    this.audio = new Audio();
    this.pending = '';
    this.full = '';
    this.playing = false;
    this.gen = 0;
    this.onState = null;
    this.audio.addEventListener('ended', () => this.#next());
    this.audio.addEventListener('error', () => this.#next());
  }

  get speaking() {
    return this.playing || this.queue.length > 0;
  }

  feed(text) {
    this.full += text;
    this.pending += text;
    // Hold everything while a code fence is open; finished code blocks are not read out.
    if ((this.pending.match(/```/g) ?? []).length % 2 === 1) return;
    this.pending = this.pending.replace(/```[\s\S]*?```/g, ' I put the code in the chat. ');
    const m = this.pending.match(/^[\s\S]*[.!?…](?=["')\]]?\s)["')\]]?/);
    if (m && m[0].trim().length >= 12) {
      this.#enqueue(m[0]);
      this.pending = this.pending.slice(m[0].length);
    }
  }

  flush() {
    if (this.pending.trim()) this.#enqueue(this.pending);
    this.pending = '';
    this.full = '';
  }

  /** Speak a whole text now (replaces anything queued). */
  say(text) {
    this.stop();
    this.feed(text);
    this.flush();
  }

  stop() {
    this.gen++;
    for (const q of this.queue) q.url?.then((u) => u && URL.revokeObjectURL(u));
    this.queue = [];
    this.pending = '';
    this.full = '';
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.playing = false;
    this.onState?.(false);
  }

  #enqueue(text) {
    const gen = this.gen;
    // Phase 66: in a group chat each line is spoken in the voice of the companion who said it.
    const item = { text, url: null, voice: this.voice ?? null };
    this.queue.push(item);
    this.#prefetch();
    if (!this.playing) this.#next(gen);
  }

  #prefetch() {
    for (const q of this.queue.slice(0, 2)) {
      if (!q.url) q.url = this.fetchAudio(q.text, q.voice).then((blob) => (blob ? URL.createObjectURL(blob) : null)).catch(() => null);
    }
  }

  async #next(gen = this.gen) {
    const item = this.queue.shift();
    if (!item) {
      this.playing = false;
      this.onState?.(false);
      return;
    }
    this.playing = true;
    this.onState?.(true);
    this.#prefetch();
    const url = await item.url;
    if (gen !== this.gen) return;
    if (!url) return this.#next(gen);
    this.audio.src = url;
    this.audio.play().catch(() => this.#next(gen));
  }
}

/**
 * Hands-free conversation: listens continuously, detects when you start and stop talking, sends
 * what you said, and lets you interrupt her by talking over her.
 */
export class Call {
  constructor({ mic, speaker, transcribe, onUtterance, onInterrupt, onStatus }) {
    Object.assign(this, { mic, speaker, transcribe, onUtterance, onInterrupt, onStatus });
    this.active = false;
    this.floor = 0.008;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.inUtterance = false;
    this.busy = false;
    /** Phase 69: muted: the microphone is ignored until unmuted. */
    this.muted = false;
  }

  async start() {
    await this.mic.open();
    this.active = true;
    this.mic.start();
    this.mic.onFrame = (f, level) => this.#frame(f, level);
    this.onStatus?.('listening');
  }

  stop() {
    this.active = false;
    this.mic.onFrame = null;
    this.mic.close();
    this.onStatus?.('off');
  }

  #frame(f, level) {
    if (!this.active || this.busy) return;
    if (this.muted) {
      this.speechMs = 0;
      this.mic.trim(400);
      return;
    }
    const ms = (f.length / this.mic.ctx.sampleRate) * 1000;
    // Track background noise when quiet.
    if (!this.inUtterance && level < this.floor * 2) this.floor = this.floor * 0.995 + level * 0.005;
    const talkingOver = this.speaker.speaking;
    const threshold = Math.max(0.012, this.floor * 3) * (talkingOver ? 2.2 : 1);
    if (level > threshold) {
      this.speechMs += ms;
      this.silenceMs = 0;
    } else {
      this.silenceMs += ms;
      if (this.silenceMs > 200) this.speechMs = 0;
    }
    if (!this.inUtterance) {
      this.mic.trim(400); // pre-roll
      if (this.speechMs >= (talkingOver ? 350 : 160)) {
        this.inUtterance = true;
        if (talkingOver) {
          this.speaker.stop();
          this.onInterrupt?.();
        }
        this.onStatus?.('hearing');
      }
    } else if (this.silenceMs >= 900 || this.mic.chunks.length > 30 * 375) {
      this.inUtterance = false;
      this.speechMs = 0;
      const wav = this.mic.stop(400);
      this.mic.start();
      if (wav) void this.#send(wav);
      else this.onStatus?.('listening');
    }
  }

  async #send(wav) {
    // Busy only while turning your words into text. Her reply isn't awaited here, so you can talk
    // over her while she answers (that interrupts her, and what you said is sent next).
    this.busy = true;
    this.onStatus?.('thinking');
    let text = '';
    try {
      text = (await this.transcribe(wav)).trim();
    } catch {
      text = '';
    } finally {
      this.busy = false;
      this.mic.chunks = [];
    }
    if (!text) {
      if (this.active) this.onStatus?.('listening');
      return;
    }
    try {
      await this.onUtterance(text);
    } finally {
      if (this.active && !this.inUtterance) this.onStatus?.('listening');
    }
  }
}
