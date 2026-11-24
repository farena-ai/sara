// Phase 5: voice. Speech-to-text and text-to-speech engines behind one small interface.
// - local: sherpa-onnx command-line tools + models installed by deploy/install-voice.sh
//   (Parakeet for speech-to-text, Kokoro or Piper voices). Nothing leaves the server.
// - openai: any OpenAI-compatible audio API (OpenAI, Groq, a local "speaches" server, ...), owner key.
// - elevenlabs: ElevenLabs text-to-speech, owner key.
// - xai: xAI Grok voices (POST /v1/tts), owner xAI key; expressive, fast, custom cloned voices too.
// Sara stays dependency-free: the local engine runs the CLI tools as child processes.
import { netFetch } from './net-guard.ts';
import { localVoiceMissing, localVoiceSupported } from './platform.ts';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { FOR_APP, spokenText } from './spoken.ts';
import { WarmWorker, type WarmState } from './voice-warm.ts';
import { placeWorker } from './voice-install.ts';
import { en, enf } from './i18n.ts';

export type SttEngine = 'off' | 'local' | 'openai';
export type TtsEngine = 'off' | 'local' | 'openai' | 'elevenlabs' | 'xai';

export interface VoiceSettings {
  stt: SttEngine;
  tts: TtsEngine;
  /** Local voice id from the manifest, e.g. "kokoro:1" or "piper:hfc_female". */
  localVoice: string;
  speed: number;
  openai: { baseUrl: string; sttModel: string; ttsModel: string; ttsVoice: string };
  elevenlabs: { voiceId: string; model: string };
  /** xAI Grok voice: a built-in voice id (eve, ara, …) or a custom voice id from the xAI console. */
  xai: { voiceId: string; language: string };
  /** Phase 11: calls are live (a realtime voice service, when available) or classic (your chosen voice). */
  calls?: 'live' | 'classic';
  /** Phase 48: which realtime voice live calls use ('auto': Grok if it's set up, else OpenAI). */
  live?: 'auto' | 'grok' | 'openai';
  /** Phase 48: OpenAI Realtime voice (marin, cedar, …) and model for live calls. */
  openaiRealtime?: { voiceId: string; model?: string };
  /** Telegram/Discord: answer with a voice note when the owner sends one ('voice'), always, or never. */
  noteReplies?: 'voice' | 'always' | 'never';
  /** Phase 37: laughs, sighs and whispers in Grok voice ('subtle' by default). */
  expressive?: import('./expressive.ts').Expressive;
  /** Phase 37: the voice's tone (warm/calm speak softer; bright a little quicker). */
  tone?: import('./expressive.ts').VoiceTone;
  /** Phase 37: her voice follows her mood (softer when you're down, slower late at night). */
  followMood?: boolean;
  /** Phase 69: video calls: how often she looks at your camera (seconds, 0 = when you ask) and pictures per call. */
  video?: Partial<import('./video.ts').VideoSettings>;
  /** U4.24: Talk with Sara (fillers, approve by voice, goodbye ends). */
  talk?: import('./talk.ts').TalkPrefs;
}

/**
 * M6: hearing and her voice start on the server's own engines only where those exist (Linux);
 * elsewhere they start off, so Settings doesn't offer an engine that can't work.
 */
export function defaultEngines(platform: NodeJS.Platform = process.platform): { stt: SttEngine; tts: TtsEngine } {
  return localVoiceSupported(platform) ? { stt: 'local', tts: 'local' } : { stt: 'off', tts: 'off' };
}

export const DEFAULT_VOICE: VoiceSettings = {
  ...defaultEngines(),
  localVoice: 'kokoro:1',
  speed: 1,
  openai: { baseUrl: 'https://api.openai.com/v1', sttModel: 'whisper-1', ttsModel: 'gpt-4o-mini-tts', ttsVoice: 'nova' },
  elevenlabs: { voiceId: '', model: 'eleven_multilingual_v2' },
  xai: { voiceId: 'eve', language: 'en' },
  calls: 'live',
  live: 'auto',
  openaiRealtime: { voiceId: 'marin', model: 'gpt-realtime-1.5' },
  noteReplies: 'voice',
  expressive: 'subtle',
  tone: 'natural',
  followMood: true,
  video: { lookEvery: 10, perCall: 60 },
};

export const VOICE_VAULT = { openai: 'voice:openai', elevenlabs: 'voice:elevenlabs', xai: 'voice:xai' } as const;

/** What deploy/install-voice.sh writes to <voiceDir>/voice.json. */
export interface VoiceManifest {
  sherpa: string;
  stt?: { kind: 'nemo-ctc'; model: string; tokens: string };
  voices: VoiceModel[];
  /** V0.2: the optional streaming hearing model (words as you speak; `sara voice install --streaming`). */
  online?: { kind: 'transducer'; encoder: string; decoder: string; joiner: string; tokens: string };
  /** W0.3: the optional multilingual streaming model (`sara voice install --languages`); the stream language is set per utterance. */
  multi?: { kind: 'transducer'; encoder: string; decoder: string; joiner: string; tokens: string; languages: string[] };
}

/** W0.3: the languages words-as-you-speak covers (Sara's six app languages). */
export const STREAM_LANGS = ['en', 'es', 'fr', 'de', 'pt', 'it'] as const;

/** W0.3: a language code as the streaming models know it ('pt-BR' → 'pt'; 'auto' = either language, the interpreter); undefined = none. */
export function streamLang(lang: string | undefined | null): string | undefined {
  const l = String(lang ?? '').trim().toLowerCase();
  if (l === 'auto') return 'auto';
  const base = l.split(/[-_]/)[0] ?? '';
  return (STREAM_LANGS as readonly string[]).includes(base) ? base : undefined;
}

/** W0.3: the language a person speaks to her: their Talk language, else the app language, else the browser's (English by default). */
export function hearLang(s: { talkLanguage?: string; language?: string; languageDetected?: string }): string {
  for (const l of [s.talkLanguage, s.language, s.languageDetected]) {
    const x = streamLang(l);
    if (x && x !== 'auto') return x;
  }
  return 'en';
}

/** W0.3: 16 kHz mono 16-bit PCM from a PCM16 WAV (first channel, linear resampling like the page). */
export function wavPcm16k(wav: Buffer): Buffer {
  let o = 12;
  let rate = 16000;
  let channels = 1;
  let data: Buffer = Buffer.alloc(0);
  while (o + 8 <= wav.length) {
    const id = wav.toString('ascii', o, o + 4);
    const n = wav.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      channels = Math.max(1, wav.readUInt16LE(o + 10));
      rate = wav.readUInt32LE(o + 12) || 16000;
    }
    if (id === 'data') {
      data = wav.subarray(o + 8, Math.min(wav.length, o + 8 + n));
      break;
    }
    o += 8 + n + (n % 2);
  }
  const src = Math.floor(data.length / (2 * channels));
  if (rate === 16000 && channels === 1) return Buffer.from(data.subarray(0, src * 2));
  const len = Math.floor((src * 16000) / rate);
  const out = Buffer.alloc(len * 2);
  const at = (i: number) => data.readInt16LE(i * 2 * channels);
  for (let i = 0; i < len; i++) {
    const x = (i * rate) / 16000;
    const i0 = Math.min(Math.floor(x), src - 1);
    const i1 = Math.min(i0 + 1, src - 1);
    out.writeInt16LE(Math.round(at(i0) + (at(i1) - at(i0)) * (x - i0)), i * 2);
  }
  return out;
}
export interface VoiceModel {
  id: string;
  label: string;
  kind: 'kokoro' | 'vits';
  model: string;
  tokens: string;
  dataDir: string;
  voices?: string;
  sid?: number;
}

export interface Audio {
  data: Buffer;
  type: string;
}

export class VoiceError extends Error {}

// ---------------- text cleanup ----------------

/** Turns a chat reply into something that sounds right spoken aloud (the app's voice; spoken.ts). */
export function speechText(text: string): string {
  return spokenText(text, FOR_APP);
}

/** Splits text into speakable chunks (sentences, merged up to ~240 characters). */
export function speechChunks(text: string, max = 240): string[] {
  const sentences = speechText(text).match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g) ?? [];
  const out: string[] = [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length > max) {
      for (const part of s.split(/(?<=[,;:])\s+/)) {
        if (out.length && out[out.length - 1].length + part.length + 1 <= max && !/[.!?…]$/.test(out[out.length - 1])) out[out.length - 1] += ` ${part}`;
        else out.push(part.slice(0, 1000));
      }
    } else if (out.length && out[out.length - 1].length < 30 && s.length < 30) {
      out[out.length - 1] += ` ${s}`; // join very short sentences ("Hey. Yeah."); a short first chunk starts audio sooner
    } else out.push(s);
  }
  return out;
}

// ---------------- WAV ----------------

export function isWav(b: Buffer): boolean {
  return b.length > 44 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE';
}

// ---------------- local engine ----------------

type Runner = (cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultRunner: Runner = (cmd, args, env, timeoutMs) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new VoiceError(enf('Voice tools could not start ({why}). Re-run deploy/install-voice.sh.', { why: (e as NodeJS.ErrnoException).code ?? e.message })));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

/** Runs at most `n` jobs at once (voice jobs are CPU heavy). */
class Semaphore {
  #free: number;
  readonly #queue: (() => void)[] = [];
  constructor(n: number) {
    this.#free = n;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((r) => this.#queue.push(r));
    try {
      return await fn();
    } finally {
      const next = this.#queue.shift();
      if (next) next();
      else this.#free++;
    }
  }
}

/**
 * U5: keep the engines loaded (src/voice-warm.ts). `idleMs` is read on every job (0 = one-shot only);
 * `worker` replaces the command prefix of deploy/voice/sara-voice-worker (tests: a fake engine).
 */
export interface WarmConfig {
  idleMs: () => number;
  worker?: string[];
  env?: NodeJS.ProcessEnv;
  minFreeMb?: number;
  /** V0.1: where the release's prebuilt helper is (default: this server's own folder). */
  helperRoot?: string;
}

/** V0.2: the streaming worker stays at least this long after a stream, even with keep-loaded Off. */
const STREAM_IDLE_MS = 2 * 60_000;
/** V0.2: half a second of 16 kHz 16-bit audio per worker line. */
const STREAM_PIECE = 16_000;
/** V0.2: seconds of quiet after words that end a turn (measured in docs/RESULTS.md). */
const STREAM_END = '0.5';

export class LocalVoiceEngine {
  readonly dir: string;
  manifest: VoiceManifest | undefined;
  readonly #tmp: string;
  readonly #run: Runner;
  readonly #jobs: Semaphore;
  readonly #threads: number;
  readonly #warm: WarmConfig | undefined;
  readonly #workers = new Map<string, WarmWorker>();

  constructor(dir: string, dataDir: string, opts: { runner?: Runner; parallel?: number; threads?: number; warm?: WarmConfig } = {}) {
    this.dir = dir;
    const file = join(dir, 'voice.json');
    this.manifest = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as VoiceManifest) : undefined;
    this.#tmp = join(dataDir, 'tmp', 'voice');
    this.#run = opts.runner ?? defaultRunner;
    this.#jobs = new Semaphore(opts.parallel ?? 2);
    // Two jobs at once (the next sentence is made while one plays), half the cores between them.
    this.#threads = opts.threads ?? Math.min(4, Math.max(2, Math.floor(availableParallelism() / 4)));
    this.#warm = opts.warm;
  }

  // ---- U5: loaded workers (one for hearing, one per voice; at most two voices kept) ----

  /** The worker command prefix, or undefined when keep-loaded is off or the helper isn't installed. */
  #workerCmd(streaming = false): string[] | undefined {
    if (!this.#warm || !this.manifest) return undefined;
    if (this.#warm.idleMs() <= 0 && !streaming) {
      for (const [k, w] of this.#workers) if (k !== 'online' && k !== 'multi') (w.stop(), this.#workers.delete(k)); // switched off: free the memory now
      return undefined;
    }
    if (this.#warm.worker) return this.#warm.worker;
    const bin = this.#bin('sara-voice-worker');
    if (!existsSync(bin) && !this.#placed) {
      // V0.1: Windows and Mac servers get the release's prebuilt helper, copied in once.
      this.#placed = true;
      try {
        placeWorker(this.dir, this.manifest.sherpa, { root: this.#warm.helperRoot });
      } catch {
        // one-shot tools then
      }
    }
    return existsSync(this.#bin('sara-voice-worker')) ? [this.#bin('sara-voice-worker')] : undefined;
  }
  #placed = false;

  #worker(key: string, args: string[]): WarmWorker | undefined {
    const streaming = key === 'online' || key === 'multi';
    const cmd = this.#workerCmd(streaming);
    if (!cmd) return undefined;
    let w = this.#workers.get(key);
    if (!w) {
      const voices = [...this.#workers.keys()].filter((k) => k.startsWith('tts:'));
      if (key.startsWith('tts:') && voices.length >= 2) {
        this.#workers.get(voices[0])!.stop();
        this.#workers.delete(voices[0]);
      }
      const warm = this.#warm!;
      const idleMs = streaming ? () => Math.max(warm.idleMs(), STREAM_IDLE_MS) : warm.idleMs;
      w = new WarmWorker(() => ({ cmd: cmd[0], args: [...cmd.slice(1), ...args], env: { ...this.#env(), ...warm.env } }), { idleMs, ...(warm.minFreeMb !== undefined ? { minFreeMb: warm.minFreeMb } : {}) });
      this.#workers.set(key, w);
    }
    return w;
  }

  #sttWorker(): WarmWorker | undefined {
    const stt = this.manifest?.stt;
    return stt ? this.#worker('stt', ['stt', this.#abs(stt.model), this.#abs(stt.tokens), String(this.#threads)]) : undefined;
  }

  #ttsWorker(v: VoiceModel): WarmWorker | undefined {
    return this.#worker(`tts:${v.id}`, ['tts', v.kind === 'kokoro' ? 'kokoro' : 'vits', this.#abs(v.model), this.#abs(v.tokens), this.#abs(v.dataDir), v.voices ? this.#abs(v.voices) : '-', String(this.#threads)]);
  }

  #onlineWorker(): WarmWorker | undefined {
    const o = this.manifest?.online;
    // Rule 2: this much quiet after words is the end of the turn (the page waits 0.9 s without it).
    return o ? this.#worker('online', ['online', this.#abs(o.encoder), this.#abs(o.decoder), this.#abs(o.joiner), this.#abs(o.tokens), String(this.#threads), process.env.SARA_TEST_STREAM_END ?? STREAM_END]) : undefined;
  }

  #multiWorker(): WarmWorker | undefined {
    const o = this.manifest?.multi;
    return o ? this.#worker('multi', ['online', this.#abs(o.encoder), this.#abs(o.decoder), this.#abs(o.joiner), this.#abs(o.tokens), String(this.#threads), process.env.SARA_TEST_STREAM_END ?? STREAM_END]) : undefined;
  }

  /**
   * W0.3: which streaming model hears a language: English keeps the small English model; es/fr/de/pt/it
   * (and 'auto', either language) the multilingual one with its language set. Undefined = none here.
   */
  #streamFor(lang?: string): { key: 'online' | 'multi'; lang?: string } | undefined {
    const l = lang === undefined ? 'en' : streamLang(lang);
    if (!l) return undefined;
    if (l === 'en' && this.manifest?.online) return { key: 'online' };
    if (this.manifest?.multi && (l === 'auto' || this.manifest.multi.languages.includes(l))) return { key: 'multi', lang: l };
    return undefined;
  }

  /** W0.3: the languages words-as-you-speak hears here (none without a streaming model). */
  streamLangs(): string[] {
    return STREAM_LANGS.filter((l) => this.#streamFor(l));
  }

  /** V0.2: true when words-as-you-speak hearing can run here (model installed and the helper present); W0.3: for `lang`. */
  streamingReady(lang?: string): boolean {
    const any = lang === undefined && (this.manifest?.online || this.manifest?.multi);
    return Boolean((any || this.#streamFor(lang)) && this.#workerCmd(true));
  }

  /**
   * V0.2: feeds one piece of a live utterance (16 kHz mono 16-bit PCM) to the streaming model; `end`
   * finishes it. Returns the words so far and whether the model heard the end of the turn. Throws a
   * VoiceError on any trouble (the page then sends the whole recording as before).
   */
  async hear(id: string, pcm: Buffer, end: boolean, lang?: string): Promise<{ text: string; endpoint: boolean; loaded: boolean }> {
    if (!/^[\w-]{1,40}$/.test(id)) throw new VoiceError('Bad stream id.');
    // W0.3: no lang = English (V0.2), or the multilingual model when it's the only one.
    const pick = this.#streamFor(lang) ?? (lang === undefined && this.manifest?.multi ? { key: 'multi' as const, lang: 'en' } : undefined);
    const w = pick?.key === 'multi' ? this.#multiWorker() : pick ? this.#onlineWorker() : undefined;
    if (!w || !pick) throw new VoiceError(lang && pick === undefined && this.manifest?.online ? en('Streaming hearing for this language is not installed here.') : en('Streaming hearing is not installed here.'));
    // The helper sets a new stream's language from "<id>@<lang>" (an older helper keeps it as the id: auto).
    const sid = pick.lang ? `${id}@${pick.lang}` : id;
    let last = '0 ';
    try {
      const n = pcm.length - (pcm.length % 2);
      const pieces = Math.max(1, Math.ceil(n / STREAM_PIECE));
      for (let i = 0; i < pieces; i++) {
        const b64 = pcm.subarray(i * STREAM_PIECE, Math.min(n, (i + 1) * STREAM_PIECE)).toString('base64') || '-';
        last = await w.ask(`${end && i === pieces - 1 ? 'e' : 'a'} ${sid} ${b64}`, 15_000);
      }
    } catch (err) {
      throw new VoiceError(enf('Streaming hearing failed ({why}).', { why: (err as Error).message }));
    }
    const m = /^([01]) ?([\s\S]*)$/.exec(last);
    // `loaded`: the whole-sentence model is in memory, so the page re-hears the recording with it
    // (~0.05 s, more accurate than the streaming words; docs/RESULTS.md) and shows these only as partials.
    // W0.3: the whole-sentence model is English: other languages keep the streaming words.
    return { text: (m?.[2] ?? '').trim(), endpoint: m?.[1] === '1', loaded: pick.key === 'online' && this.#workers.get('stt')?.state === 'ready' };
  }

  /** Loads hearing and the voice now (Talk opened). Never throws; true when something is loading. */
  async warm(voiceId?: string, opts: { streaming?: boolean; lang?: string } = {}): Promise<boolean> {
    const v = this.manifest?.voices.find((x) => x.id === voiceId) ?? this.manifest?.voices[0];
    // W0.3: Talk in another language loads the multilingual streaming model instead.
    const s = opts.streaming ? this.#streamFor(opts.lang) : undefined;
    const ws = [this.#sttWorker(), v ? this.#ttsWorker(v) : undefined, s?.key === 'multi' ? this.#multiWorker() : opts.streaming && this.manifest?.online ? this.#onlineWorker() : undefined].filter((w): w is WarmWorker => Boolean(w));
    await Promise.all(ws.map((w) => w.start().catch(() => undefined)));
    return ws.length > 0;
  }

  workerStates(): Record<string, WarmState> {
    return Object.fromEntries([...this.#workers].map(([k, w]) => [k, w.state]));
  }

  stopWorkers(): void {
    for (const w of this.#workers.values()) w.stop();
    this.#workers.clear();
  }

  /** Phase 126 part C: reads voice.json again (after `sara voice install` or the Settings button). */
  reload(): void {
    const file = join(this.dir, 'voice.json');
    this.manifest = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as VoiceManifest) : undefined;
  }

  get available(): { stt: boolean; tts: boolean } {
    return { stt: Boolean(this.manifest?.stt), tts: Boolean(this.manifest?.voices.length) };
  }

  voices(): { id: string; label: string }[] {
    // Piper (vits) voices start talking several times sooner on a small CPU; Kokoro sounds more natural.
    return (this.manifest?.voices ?? []).map((v) => ({ id: v.id, label: v.kind === 'vits' && !/fast/i.test(v.label) ? `${v.label} (fastest)` : v.label, kind: v.kind }));
  }

  #abs = (p: string) => (p.startsWith('/') || /^[A-Za-z]:/.test(p) ? p : join(this.dir, p));
  // Phase 126 part C: on Windows the tools are .exe files with their DLLs beside them (bin/); on a Mac the libraries are in lib/.
  #bin = (name: string) => {
    const plain = join(this.#abs(this.manifest!.sherpa), 'bin', name);
    return process.platform === 'win32' && existsSync(`${plain}.exe`) ? `${plain}.exe` : plain;
  };
  #env = (): NodeJS.ProcessEnv => {
    const lib = join(this.#abs(this.manifest!.sherpa), 'lib');
    if (process.platform === 'win32') return { PATH: `${join(this.#abs(this.manifest!.sherpa), 'bin')};${lib};${process.env.PATH ?? ''}`, SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', TEMP: this.#tmp, TMP: this.#tmp, USERPROFILE: this.#tmp };
    return { PATH: process.env.PATH ?? '/usr/bin:/bin', LD_LIBRARY_PATH: lib, ...(process.platform === 'darwin' ? { DYLD_LIBRARY_PATH: lib } : {}), HOME: this.#tmp };
  };

  #tmpFile(ext: string): string {
    mkdirSync(this.#tmp, { recursive: true, mode: 0o700 });
    return join(this.#tmp, `${randomUUID()}.${ext}`);
  }

  async transcribe(wav: Buffer, opts: { lang?: string } = {}): Promise<string> {
    // W0.3: a recording in es/fr/de/pt/it (or 'auto') goes to the multilingual model when it's here:
    // the whole-sentence model (Parakeet) hears English only. Any trouble: the path below, as before.
    const l = streamLang(opts.lang);
    if (l && l !== 'en' && isWav(wav) && this.#streamFor(l)?.key === 'multi' && this.#workerCmd(true)) {
      try {
        // 0.6 s of quiet after the words lets the last one out of the model's 560 ms look-ahead.
        return (await this.hear(`w${randomUUID().replace(/-/g, '').slice(0, 20)}`, Buffer.concat([wavPcm16k(wav), Buffer.alloc(19_200)]), true, l)).text;
      } catch {
        // the whole-sentence model then
      }
    }
    const stt = this.manifest?.stt;
    if (!stt) throw new VoiceError(localVoiceSupported() ? en('Local speech-to-text is not installed (run deploy/install-voice.sh).') : `${localVoiceMissing()}.`);
    if (!isWav(wav)) throw new VoiceError(en('Expected a WAV recording.'));
    const file = this.#tmpFile('wav');
    writeFileSync(file, wav, { mode: 0o600 });
    try {
      const w = this.#sttWorker();
      if (w) {
        try {
          return (await w.ask(file)).trim();
        } catch {
          // U5: any worker trouble: the one-shot tool below
        }
      }
      const r = await this.#jobs.run(() =>
        this.#run(this.#bin('sherpa-onnx-offline'), [`--nemo-ctc-model=${this.#abs(stt.model)}`, `--tokens=${this.#abs(stt.tokens)}`, `--num-threads=${this.#threads}`, file], this.#env(), 60_000),
      );
      // The CLI prints one JSON object per file with a "text" field (stdout or stderr by version).
      const m = `${r.stdout}\n${r.stderr}`.match(/\{"lang"[\s\S]*?"text":\s*"((?:[^"\\]|\\.)*)"/);
      if (r.code !== 0 || !m) throw new VoiceError(enf('Speech-to-text failed (exit {code}).', { code: String(r.code) }));
      return (JSON.parse(`"${m[1]}"`) as string).trim();
    } finally {
      rmSync(file, { force: true });
    }
  }

  async speak(text: string, voiceId: string, speed = 1): Promise<Audio> {
    const v = this.manifest?.voices.find((x) => x.id === voiceId) ?? this.manifest?.voices[0];
    if (!v) throw new VoiceError(localVoiceSupported() ? en('No local voice is installed (run deploy/install-voice.sh).') : `${localVoiceMissing()}.`);
    const out = this.#tmpFile('wav');
    const args =
      v.kind === 'kokoro'
        ? [`--kokoro-model=${this.#abs(v.model)}`, `--kokoro-voices=${this.#abs(v.voices!)}`, `--kokoro-tokens=${this.#abs(v.tokens)}`, `--kokoro-data-dir=${this.#abs(v.dataDir)}`, `--sid=${v.sid ?? 0}`]
        : [`--vits-model=${this.#abs(v.model)}`, `--vits-tokens=${this.#abs(v.tokens)}`, `--vits-data-dir=${this.#abs(v.dataDir)}`];
    // Speed: sherpa takes a length scale (inverse of speed).
    const clamped = Math.min(1.6, Math.max(0.6, speed));
    const lengthScale = (1 / clamped).toFixed(2);
    args.push(`--num-threads=${this.#threads}`, `--output-filename=${out}`, v.kind === 'kokoro' ? `--kokoro-length-scale=${lengthScale}` : `--vits-length-scale=${lengthScale}`, text);
    try {
      const w = this.#ttsWorker(v);
      if (w) {
        try {
          await w.ask(`${v.kind === 'kokoro' ? (v.sid ?? 0) : 0}\t${clamped.toFixed(2)}\t${out}\t${text.replace(/[\t\r\n]+/g, ' ')}`);
          if (existsSync(out)) return { data: readFileSync(out), type: 'audio/wav' };
        } catch {
          // U5: any worker trouble: the one-shot tool below
        }
      }
      const r = await this.#jobs.run(() => this.#run(this.#bin('sherpa-onnx-offline-tts'), args, this.#env(), 120_000));
      if (r.code !== 0 || !existsSync(out)) throw new VoiceError(enf('Text-to-speech failed (exit {code}).', { code: String(r.code) }));
      return { data: readFileSync(out), type: 'audio/wav' };
    } finally {
      rmSync(out, { force: true });
    }
  }
}

// ---------------- cloud engines (owner keys) ----------------

export async function openaiTranscribe(cfg: VoiceSettings['openai'], key: string | undefined, wav: Buffer, language?: string): Promise<string> {
  if (!key) throw new VoiceError(en('Add the speech API key in Settings → Voice.'));
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', cfg.sttModel);
  // Phase 53: a language hint (ISO 639-1, e.g. "de") helps short clips; 'auto' lets the service guess.
  if (language && language !== 'auto') form.append('language', language.split('-')[0]);
  const res = await netFetch(`${cfg.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new VoiceError(enf('Speech-to-text API error {status}: {detail}', { status: res.status, detail: (await res.text()).slice(0, 200) }));
  const j = (await res.json()) as { text?: string };
  return String(j.text ?? '').trim();
}

/** R5: `format: 'wav'` for phone calls (the phone line needs PCM; MP3 can't be decoded without a dependency). */
export async function openaiSpeak(cfg: VoiceSettings['openai'], key: string | undefined, text: string, speed: number, instructions?: string, format: 'mp3' | 'wav' = 'mp3'): Promise<Audio> {
  if (!key) throw new VoiceError(en('Add the speech API key in Settings → Voice.'));
  const res = await netFetch(`${cfg.baseUrl.replace(/\/+$/, '')}/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    // gpt-4o-mini-tts takes delivery instructions (Phase 37: tone and mood); older models don't.
    body: JSON.stringify({ model: cfg.ttsModel, voice: cfg.ttsVoice, input: text, response_format: format, speed, ...(instructions && /gpt-4o/.test(cfg.ttsModel) ? { instructions } : {}) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new VoiceError(enf('Text-to-speech API error {status}: {detail}', { status: res.status, detail: (await res.text()).slice(0, 200) }));
  return { data: Buffer.from(await res.arrayBuffer()), type: format === 'wav' ? 'audio/wav' : 'audio/mpeg' };
}

export async function elevenlabsSpeak(cfg: VoiceSettings['elevenlabs'], key: string | undefined, text: string, format: 'mp3' | 'pcm' = 'mp3'): Promise<Audio> {
  if (!key) throw new VoiceError(en('Add the ElevenLabs key in Settings → Voice.'));
  if (!cfg.voiceId) throw new VoiceError(en('Choose an ElevenLabs voice id in Settings → Voice.'));
  const res = await netFetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}?output_format=${format === 'pcm' ? 'pcm_16000' : 'mp3_44100_128'}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: cfg.model }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new VoiceError(enf('ElevenLabs error {status}: {detail}', { status: res.status, detail: (await res.text()).slice(0, 200) }));
  return { data: Buffer.from(await res.arrayBuffer()), type: format === 'pcm' ? 'audio/L16;rate=16000' : 'audio/mpeg' };
}

const XAI = 'https://api.x.ai/v1';

export async function xaiSpeak(cfg: VoiceSettings['xai'], key: string | undefined, text: string, speed: number, fetchImpl: typeof fetch = netFetch): Promise<Audio> {
  if (!key) throw new VoiceError(en('Add your xAI key in Settings → Sara → Voice.'));
  const res = await fetchImpl(`${XAI}/tts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice_id: cfg.voiceId || 'eve', language: cfg.language || 'en', ...(speed !== 1 ? { speed: Math.min(1.5, Math.max(0.7, speed)) } : {}) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new VoiceError(enf('Grok voice error {status}: {detail}', { status: res.status, detail: (await res.text()).slice(0, 200) }));
  return { data: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type')?.startsWith('audio/') ? res.headers.get('content-type')! : 'audio/mpeg' };
}

/** Built-in and custom Grok voices on the owner's xAI account. */
export async function xaiVoices(key: string, fetchImpl: typeof fetch = netFetch): Promise<{ id: string; label: string }[]> {
  const get = async (path: string) => {
    const res = await fetchImpl(`${XAI}${path}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return [];
    const j = (await res.json()) as { voices?: { voice_id?: string; id?: string; name?: string; description?: string }[]; data?: { voice_id?: string; id?: string; name?: string }[] };
    return (j.voices ?? j.data ?? []).map((v) => ({ id: String(v.voice_id ?? v.id ?? ''), label: String(v.name ?? v.voice_id ?? v.id ?? '') })).filter((v) => v.id);
  };
  const [builtIn, custom] = await Promise.all([get('/tts/voices'), get('/custom-voices').catch(() => [])]);
  return [...builtIn, ...custom.map((v) => ({ ...v, label: `${v.label} (your voice)` }))];
}
