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

/**
 * U4.24 (docs/VOICE_FIRST.md): a small WebRTC-style speech check on top of the energy VAD. Every
 * ~30 ms window is judged by its zero-crossing rate: a voice sits between steady mains hum (almost no
 * crossings) and hiss/fan/keyboard noise (crossings at nearly every sample). push(frame) returns the
 * newest window's verdict (true until the first window is complete). No model, no download.
 */
export class SpeechGate {
  constructor(rate = 48000, windowMs = 30) {
    this.size = Math.max(64, Math.round((rate * windowMs) / 1000));
    this.rate = rate;
    this.n = 0;
    this.cross = 0;
    this.last = 0;
    this.voiced = true;
  }

  push(frame) {
    for (let i = 0; i < frame.length; i++) {
      const x = frame[i];
      if ((x >= 0) !== (this.last >= 0)) this.cross++;
      this.last = x;
      if (++this.n >= this.size) {
        // Crossings per second: ~100–3500 for a voice (pitch plus formants), far more for hiss.
        const hz = (this.cross / this.n) * this.rate;
        this.voiced = hz > 120 && hz < 4500;
        this.n = this.cross = 0;
      }
    }
    return this.voiced;
  }
}

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
    const item = { text, url: null, voice: this.voice ?? null, lang: this.lang ?? null, local: this.local ?? false };
    this.queue.push(item);
    this.#prefetch();
    if (!this.playing) this.#next(gen);
  }

  #prefetch() {
    for (const q of this.queue.slice(0, 2)) {
      if (!q.url) q.url = this.fetchAudio(q.text, q.voice, q.lang, q.local).then((blob) => (blob ? URL.createObjectURL(blob) : null)).catch(() => null);
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
 * V0.2 (docs/VOICE_FIRST.md "Words as you speak"): sends a live utterance to the streaming hearing
 * model in ~0.25 s pieces (16 kHz 16-bit PCM, one piece in flight at a time) while you speak.
 * post(id, bytes, end) → { text, endpoint }. `text` holds the words so far, `endpoint` is true once
 * the model heard the end of the turn. Any error marks it failed: finish() then returns null and the
 * caller sends the whole recording as before.
 */
export class StreamHearing {
  constructor(post, rate) {
    this.post = post;
    this.rate = rate;
    this.id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.buf = [];
    this.n = 0;
    this.text = '';
    this.endpoint = false;
    this.failed = false;
    this.chain = Promise.resolve();
    this.onPartial = null;
  }

  /** The pre-roll frames already recorded when the utterance started. */
  begin(frames) {
    for (const f of frames) this.add(f);
  }

  add(frame) {
    if (this.failed) return;
    this.buf.push(frame.slice());
    this.n += frame.length;
    if (this.n >= this.rate / 4 && !this.busy) this.#send(false);
  }

  #take() {
    const all = new Float32Array(this.n);
    let o = 0;
    for (const c of this.buf) {
      all.set(c, o);
      o += c.length;
    }
    this.buf = [];
    this.n = 0;
    const f = resample(all, this.rate);
    const pcm = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const x = Math.max(-1, Math.min(1, f[i]));
      pcm[i] = Math.round(x < 0 ? x * 0x8000 : x * 0x7fff);
    }
    return new Uint8Array(pcm.buffer);
  }

  #send(end) {
    const bytes = this.#take();
    this.busy = true;
    this.chain = this.chain.then(async () => {
      if (this.failed) return;
      try {
        const r = await this.post(this.id, bytes, end);
        this.text = String(r?.text ?? '');
        this.endpoint = Boolean(r?.endpoint);
        this.loaded = Boolean(r?.loaded);
        if (!end && this.text) this.onPartial?.(this.text);
      } catch {
        this.failed = true;
      } finally {
        this.busy = false;
        // Audio that came in while this piece was on its way goes next.
        if (!end && !this.failed && this.n >= this.rate / 4) this.#send(false);
      }
    });
    return this.chain;
  }

  /** Sends the rest and ends the stream: the final words, or null when streaming failed. */
  async finish() {
    await this.chain;
    if (this.failed) return null;
    await this.#send(true);
    await this.chain;
    return this.failed ? null : this.text;
  }

  cancel() {
    this.failed = true;
  }
}

/**
 * Hands-free conversation: listens continuously, detects when you start and stop talking, sends
 * what you said, and lets you interrupt her by talking over her.
 */
export class Call {
  constructor({ mic, speaker, transcribe, onUtterance, onInterrupt, onStatus, isSpeech, stream, onPartial }) {
    // U4.24: isSpeech(frame) (a SpeechGate) keeps loud non-speech from starting an utterance.
    // V0.2: stream() → a StreamHearing (or null) per utterance; onPartial(words) while you speak.
    Object.assign(this, { mic, speaker, transcribe, onUtterance, onInterrupt, onStatus, isSpeech, stream, onPartial });
    this.hearing = null;
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
    const voiced = this.isSpeech ? this.isSpeech(f) : true;
    if (level > threshold && voiced) {
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
        // V0.2: words as you speak (the pre-roll first).
        const h = this.stream?.() ?? null;
        if (h) {
          h.onPartial = (words) => this.inUtterance && this.onPartial?.(words);
          h.begin(this.mic.chunks);
        }
        this.hearing = h;
      }
    } else {
      this.hearing?.add(f);
      // V0.2: the streaming model heard the end of the turn: a shorter wait than the 0.9 s silence.
      const heardEnd = this.hearing && !this.hearing.failed && this.hearing.endpoint && this.hearing.text && this.silenceMs >= 300;
      if (heardEnd || this.silenceMs >= 900 || this.mic.chunks.length > 30 * 375) {
        this.inUtterance = false;
        this.speechMs = 0;
        const h = this.hearing;
        this.hearing = null;
        const wav = this.mic.stop(400);
        this.mic.start();
        if (wav) void this.#send(wav, h);
        else {
          h?.cancel();
          this.onStatus?.('listening');
        }
      }
    }
  }

  async #send(wav, hearing = null) {
    // Busy only while turning your words into text. Her reply isn't awaited here, so you can talk
    // over her while she answers (that interrupts her, and what you said is sent next).
    this.busy = true;
    this.onStatus?.('thinking');
    let text = '';
    try {
      // V0.2: the streaming words when they came through; else the whole recording as before.
      if (hearing && !hearing.failed && hearing.loaded) {
        // The whole-sentence model is loaded: it hears the recording again in ~0.05 s and gets more
        // words right; the streaming words were the live preview (and the fallback).
        void hearing.finish();
        text = (await this.transcribe(wav).catch(() => '')).trim() || hearing.text.trim();
      } else {
        // At the model's endpoint its words are final already: no wait for the stream to close.
        const atEnd = hearing && !hearing.failed && hearing.endpoint && hearing.text ? hearing.text : null;
        if (atEnd) void hearing.finish();
        const streamed = atEnd ?? (hearing ? await hearing.finish() : null);
        text = streamed?.trim() ? streamed.trim() : (await this.transcribe(wav)).trim();
      }
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
