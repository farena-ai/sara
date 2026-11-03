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
      reject(new VoiceError(`Voice tools could not start (${(e as NodeJS.ErrnoException).code ?? e.message}). Re-run deploy/install-voice.sh.`));
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

export class LocalVoiceEngine {
  readonly dir: string;
  manifest: VoiceManifest | undefined;
  readonly #tmp: string;
  readonly #run: Runner;
  readonly #jobs: Semaphore;
  readonly #threads: number;

  constructor(dir: string, dataDir: string, opts: { runner?: Runner; parallel?: number; threads?: number } = {}) {
    this.dir = dir;
    const file = join(dir, 'voice.json');
    this.manifest = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as VoiceManifest) : undefined;
    this.#tmp = join(dataDir, 'tmp', 'voice');
    this.#run = opts.runner ?? defaultRunner;
    this.#jobs = new Semaphore(opts.parallel ?? 2);
    // Two jobs at once (the next sentence is made while one plays), half the cores between them.
    this.#threads = opts.threads ?? Math.min(4, Math.max(2, Math.floor(availableParallelism() / 4)));
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
    if (process.platform === 'win32') return { PATH: `${join(this.#abs(this.manifest!.sherpa), 'bin')};${process.env.PATH ?? ''}`, SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', TEMP: this.#tmp, TMP: this.#tmp, USERPROFILE: this.#tmp };
    return { PATH: process.env.PATH ?? '/usr/bin:/bin', LD_LIBRARY_PATH: lib, ...(process.platform === 'darwin' ? { DYLD_LIBRARY_PATH: lib } : {}), HOME: this.#tmp };
  };

  #tmpFile(ext: string): string {
    mkdirSync(this.#tmp, { recursive: true, mode: 0o700 });
    return join(this.#tmp, `${randomUUID()}.${ext}`);
  }

  async transcribe(wav: Buffer): Promise<string> {
    const stt = this.manifest?.stt;
    if (!stt) throw new VoiceError(localVoiceSupported() ? 'Local speech-to-text is not installed (run deploy/install-voice.sh).' : `${localVoiceMissing()}.`);
    if (!isWav(wav)) throw new VoiceError('Expected a WAV recording.');
    const file = this.#tmpFile('wav');
    writeFileSync(file, wav, { mode: 0o600 });
    try {
      const r = await this.#jobs.run(() =>
        this.#run(this.#bin('sherpa-onnx-offline'), [`--nemo-ctc-model=${this.#abs(stt.model)}`, `--tokens=${this.#abs(stt.tokens)}`, `--num-threads=${this.#threads}`, file], this.#env(), 60_000),
      );
      // The CLI prints one JSON object per file with a "text" field (stdout or stderr by version).
      const m = `${r.stdout}\n${r.stderr}`.match(/\{"lang"[\s\S]*?"text":\s*"((?:[^"\\]|\\.)*)"/);
      if (r.code !== 0 || !m) throw new VoiceError(`Speech-to-text failed (exit ${r.code}).`);
      return (JSON.parse(`"${m[1]}"`) as string).trim();
    } finally {
      rmSync(file, { force: true });
    }
  }

  async speak(text: string, voiceId: string, speed = 1): Promise<Audio> {
    const v = this.manifest?.voices.find((x) => x.id === voiceId) ?? this.manifest?.voices[0];
    if (!v) throw new VoiceError(localVoiceSupported() ? 'No local voice is installed (run deploy/install-voice.sh).' : `${localVoiceMissing()}.`);
    const out = this.#tmpFile('wav');
    const args =
      v.kind === 'kokoro'
        ? [`--kokoro-model=${this.#abs(v.model)}`, `--kokoro-voices=${this.#abs(v.voices!)}`, `--kokoro-tokens=${this.#abs(v.tokens)}`, `--kokoro-data-dir=${this.#abs(v.dataDir)}`, `--sid=${v.sid ?? 0}`]
        : [`--vits-model=${this.#abs(v.model)}`, `--vits-tokens=${this.#abs(v.tokens)}`, `--vits-data-dir=${this.#abs(v.dataDir)}`];
    // Speed: sherpa takes a length scale (inverse of speed).
    const lengthScale = (1 / Math.min(1.6, Math.max(0.6, speed))).toFixed(2);
    args.push(`--num-threads=${this.#threads}`, `--output-filename=${out}`, v.kind === 'kokoro' ? `--kokoro-length-scale=${lengthScale}` : `--vits-length-scale=${lengthScale}`, text);
    try {
      const r = await this.#jobs.run(() => this.#run(this.#bin('sherpa-onnx-offline-tts'), args, this.#env(), 120_000));
      if (r.code !== 0 || !existsSync(out)) throw new VoiceError(`Text-to-speech failed (exit ${r.code}).`);
      return { data: readFileSync(out), type: 'audio/wav' };
    } finally {
      rmSync(out, { force: true });
    }
  }
}

// ---------------- cloud engines (owner keys) ----------------

export async function openaiTranscribe(cfg: VoiceSettings['openai'], key: string | undefined, wav: Buffer, language?: string): Promise<string> {
  if (!key) throw new VoiceError('Add the speech API key in Settings → Voice.');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', cfg.sttModel);
  // Phase 53: a language hint (ISO 639-1, e.g. "de") helps short clips; 'auto' lets the service guess.
  if (language && language !== 'auto') form.append('language', language.split('-')[0]);
  const res = await netFetch(`${cfg.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new VoiceError(`Speech-to-text API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { text?: string };
  return String(j.text ?? '').trim();
}

export async function openaiSpeak(cfg: VoiceSettings['openai'], key: string | undefined, text: string, speed: number, instructions?: string): Promise<Audio> {
  if (!key) throw new VoiceError('Add the speech API key in Settings → Voice.');
  const res = await netFetch(`${cfg.baseUrl.replace(/\/+$/, '')}/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    // gpt-4o-mini-tts takes delivery instructions (Phase 37: tone and mood); older models don't.
    body: JSON.stringify({ model: cfg.ttsModel, voice: cfg.ttsVoice, input: text, response_format: 'mp3', speed, ...(instructions && /gpt-4o/.test(cfg.ttsModel) ? { instructions } : {}) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new VoiceError(`Text-to-speech API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { data: Buffer.from(await res.arrayBuffer()), type: 'audio/mpeg' };
}

export async function elevenlabsSpeak(cfg: VoiceSettings['elevenlabs'], key: string | undefined, text: string): Promise<Audio> {
  if (!key) throw new VoiceError('Add the ElevenLabs key in Settings → Voice.');
  if (!cfg.voiceId) throw new VoiceError('Choose an ElevenLabs voice id in Settings → Voice.');
  const res = await netFetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: cfg.model }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new VoiceError(`ElevenLabs error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { data: Buffer.from(await res.arrayBuffer()), type: 'audio/mpeg' };
}

const XAI = 'https://api.x.ai/v1';

export async function xaiSpeak(cfg: VoiceSettings['xai'], key: string | undefined, text: string, speed: number, fetchImpl: typeof fetch = netFetch): Promise<Audio> {
  if (!key) throw new VoiceError('Add your xAI key in Settings → Her → Voice.');
  const res = await fetchImpl(`${XAI}/tts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice_id: cfg.voiceId || 'eve', language: cfg.language || 'en', ...(speed !== 1 ? { speed: Math.min(1.5, Math.max(0.7, speed)) } : {}) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new VoiceError(`Grok voice error ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
