// Her voice and hearing, shared by the app, live calls and the Telegram/Discord bridges (Phase 11).
// Uses the engines chosen in Settings → Voice. Voice notes (OGG/Opus from Telegram/Discord) need a
// hearing engine that reads them: Grok voice (xAI speech-to-text) or a speech API; the on-server
// engine reads WAV only.

import { netFetch } from './net-guard.ts';
import { localVoiceMissing, localVoiceSupported } from './platform.ts';
import { speechLanguage } from './i18n.ts';
import type { AppContext } from './chat.ts';
import { innerEnabled, vaultKeyFor } from './chat.ts';
import { PHOTO_KEY_VAULT } from './photos.ts';
import { personalize } from './identity.ts';
import { identityOf } from './persona.ts';
import { addTags, engineTags, type Expressive, forEngine, type MoodHint, moodSpeed, plainSpeech, toneInstructions, type VoiceTone } from './expressive.ts';
import { moodLabel } from './inner.ts';
import { DEFAULT_VOICE, elevenlabsSpeak, isWav, openaiSpeak, openaiTranscribe, speechText, VOICE_VAULT, VoiceError, xaiSpeak, type Audio, type VoiceSettings } from './voice.ts';

const XAI_STT = 'https://api.x.ai/v1/stt';
const OPENAI_API = /^https:\/\/api\.openai\.com(?:\/|$)/;

/** Which voice service live calls use, and who pays; or why there's none. */
export type LiveChoice =
  | { engine: 'grok' | 'openai'; how: 'xai-key' | 'grok-subscription' | 'openai-key' | 'openai-provider-key'; billedTo: string }
  | { engine: null; message: string };

/** xAI speech-to-text: reads WAV, MP3, OGG/Opus, M4A… (auto-detected). */
export async function xaiTranscribe(key: string, audio: Buffer, opts: { language?: string; keyterms?: string[]; fetchImpl?: typeof fetch } = {}): Promise<string> {
  const form = new FormData();
  if (opts.language && opts.language !== 'auto') form.append('language', opts.language.split('-')[0]);
  for (const k of opts.keyterms ?? []) form.append('keyterm', k);
  form.append('file', new Blob([new Uint8Array(audio)]), 'audio');
  const res = await (opts.fetchImpl ?? netFetch)(XAI_STT, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(60_000) });
  const j = (await res.json().catch(() => ({}))) as { text?: string; error?: string; code?: string };
  if (!res.ok) throw new VoiceError(`Grok speech-to-text: ${j.error ?? j.code ?? `HTTP ${res.status}`}`);
  return String(j.text ?? '').trim();
}

export class Speech {
  readonly #app: AppContext;

  constructor(app: AppContext) {
    this.#app = app;
  }

  settings(): VoiceSettings {
    const s = this.#app.settings.get();
    const v = s.voice ?? {};
    // Phase 53: Grok hears and speaks her talk language unless the voice page says otherwise.
    return { ...DEFAULT_VOICE, ...v, openai: { ...DEFAULT_VOICE.openai, ...v.openai }, elevenlabs: { ...DEFAULT_VOICE.elevenlabs, ...v.elevenlabs }, xai: { ...DEFAULT_VOICE.xai, ...v.xai, language: speechLanguage(s) }, openaiRealtime: { ...DEFAULT_VOICE.openaiRealtime!, ...v.openaiRealtime } };
  }

  /**
   * Phase 48: an OpenAI API key for live calls (OpenAI Realtime): the speech API key when that
   * speech API is OpenAI's, else the key of an OpenAI model provider (Settings → Models). API keys
   * only: a ChatGPT plan sign-in covers the Responses API, not the Realtime API (see live.ts).
   */
  openaiRealtimeKey(): { key: string; source: 'voice' | 'provider'; provider?: string } | undefined {
    const app = this.#app;
    const own = app.vault.get(VOICE_VAULT.openai);
    if (own && OPENAI_API.test(this.settings().openai.baseUrl)) return { key: own, source: 'voice' };
    for (const p of app.settings.get().providers) {
      if (p.kind !== 'openai-compatible' || !OPENAI_API.test(p.baseUrl)) continue;
      const key = app.vault.get(vaultKeyFor(p.id));
      if (key) return { key, source: 'provider', provider: p.label || p.id };
    }
    return undefined;
  }

  /**
   * Phase 48: which voice service a live call uses, per Settings → Voice → "Live calls with":
   * 'auto' takes Grok when it's set up, else OpenAI; an explicit choice is kept (no silent switch).
   */
  liveChoice(): LiveChoice {
    const want = this.settings().live ?? 'auto';
    const grok = this.hasXai();
    const oa = this.openaiRealtimeKey();
    const grokHow = (): LiveChoice => {
      const how = this.#app.vault.get(VOICE_VAULT.xai) ? 'xai-key' : this.grokSignedIn() ? 'grok-subscription' : 'xai-key';
      return { engine: 'grok', how, billedTo: how === 'grok-subscription' ? 'your Grok subscription (weekly usage)' : 'your xAI API account' };
    };
    const oaHow = (k: NonNullable<typeof oa>): LiveChoice => ({ engine: 'openai', how: k.source === 'voice' ? 'openai-key' : 'openai-provider-key', billedTo: k.source === 'voice' ? 'your OpenAI API account (the speech API key)' : `your OpenAI API account (the key of the "${k.provider}" model provider)` });
    if (want === 'grok') return grok ? grokHow() : { engine: null, message: 'Live calls are set to Grok voice: sign in to Grok (Settings → Models → Subscriptions) or add an xAI key (Settings → Voice).' };
    if (want === 'openai') return oa ? oaHow(oa) : { engine: null, message: 'Live calls are set to OpenAI: add an OpenAI API key in Settings → Voice (or an OpenAI model provider in Settings → Models).' };
    if (grok) return grokHow();
    if (oa) return oaHow(oa);
    return { engine: null, message: 'Live calls need Grok voice or OpenAI: sign in to Grok (Settings → Models → Subscriptions), or add an xAI or OpenAI API key (Settings → Voice).' };
  }

  /** The key or sign-in for the chosen live voice service (renews a Grok sign-in if needed). */
  async liveKey(engine: 'grok' | 'openai'): Promise<string | undefined> {
    return engine === 'openai' ? this.openaiRealtimeKey()?.key : this.xaiKey();
  }

  grokSignedIn(): boolean {
    return this.#app.subscriptions?.grokStatus().signedIn ?? false;
  }

  /** An xAI key saved elsewhere in Sara (pictures, or an xAI model provider). */
  xaiKeySync(): string | undefined {
    const p = this.#app.settings.get().providers.find((x) => /api\.x\.ai/.test(x.baseUrl));
    return this.#app.vault.get(PHOTO_KEY_VAULT) || (p ? this.#app.vault.get(vaultKeyFor(p.id)) : undefined);
  }

  /**
   * Grok voice: a key saved for voice, else the Grok subscription sign-in (voice is in its weekly
   * usage pool), else the pictures key or an xAI model provider's key.
   */
  async xaiKey(): Promise<string | undefined> {
    const app = this.#app;
    return app.vault.get(VOICE_VAULT.xai) || (this.grokSignedIn() ? await app.subscriptions!.grokAccessToken() : undefined) || this.xaiKeySync();
  }

  /** Grok voice is usable (key or sign-in), without renewing anything. */
  hasXai(): boolean {
    return Boolean(this.#app.vault.get(VOICE_VAULT.xai) || this.grokSignedIn() || this.xaiKeySync());
  }

  /** Her voice with the chosen engine. */
  async speak(text: string, voiceId?: string, opts: { expressive?: Expressive; tone?: VoiceTone } = {}): Promise<Audio> {
    const v = this.settings();
    const plain = speechText(plainSpeech(text)).slice(0, 1200);
    if (!plain) throw new VoiceError('Nothing to say');
    if (v.tts === 'off') throw new VoiceError(personalize('Her voice is off (Settings → Voice).', identityOf(this.#app.persona)));
    // Phase 37: her mood colours her voice (softer when you're down), and Grok voice gets speech tags.
    const mood = v.followMood === false ? {} : this.mood();
    const tone = opts.tone ?? v.tone ?? 'natural';
    const level = opts.expressive ?? v.expressive ?? 'subtle';
    const speed = moodSpeed(v.speed, mood, tone);
    if (v.tts === 'openai') return openaiSpeak(v.openai, this.#app.vault.get(VOICE_VAULT.openai), plain, speed, toneInstructions(mood, tone, level));
    // R2d: an engine gets only the tags its provider documents (expressive.ts engineTags), else plain words.
    if (v.tts === 'elevenlabs') return elevenlabsSpeak(v.elevenlabs, this.#app.vault.get(VOICE_VAULT.elevenlabs), engineTags('elevenlabs', v.elevenlabs.model) ? forEngine(tagged(text, level, mood, tone), 'elevenlabs', v.elevenlabs.model).slice(0, 1400) : plain);
    if (v.tts === 'xai') return xaiSpeak(v.xai, await this.xaiKey().catch((e: Error) => { throw new VoiceError(e.message); }), forEngine(tagged(text, level, mood, tone), 'xai').slice(0, 1400), speed);
    if (!this.#app.voice) throw new VoiceError(localVoiceSupported() ? 'The voice on this server is not installed (deploy/install-voice.sh).' : `${localVoiceMissing()}.`);
    return this.#app.voice.speak(plain, voiceId ?? v.localVoice, speed);
  }

  /** How she feels right now, for her voice. */
  mood(): MoodHint {
    const app = this.#app;
    if (!app.inner || !innerEnabled(app)) return {};
    const now = app.now();
    const st = app.inner.get(now);
    const { mood, energy } = moodLabel(st, now, app.settings.get().timeZone);
    return { soft: mood === 'worried about you' || mood === 'a bit hurt' || mood === 'down', sleepy: energy === 'sleepy', bright: mood === 'happy' };
  }

  /** She can send voice notes: her voice comes out as MP3 (Telegram and Discord play it). */
  canSendNotes(): boolean {
    const t = this.settings().tts;
    return t === 'xai' || t === 'openai' || t === 'elevenlabs';
  }

  /** Telegram/Discord: answer this message with a voice note? */
  replyWithVoice(ownerSentVoice: boolean): boolean {
    const mode = this.settings().noteReplies ?? 'voice';
    return this.canSendNotes() && (mode === 'always' || (mode === 'voice' && ownerSentVoice));
  }

  /** Downloads a voice note (size-limited) and transcribes it. */
  async hearNote(url: string, headers: Record<string, string> = {}, maxBytes = 20 * 1024 * 1024): Promise<string> {
    if (!this.canHearNotes()) throw new VoiceError('voice notes need Grok voice or a speech API (Settings → Voice).');
    const res = await netFetch(url, { headers, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new VoiceError(`download failed (HTTP ${res.status})`);
    if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw new VoiceError('that voice note is too long for me.');
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length > maxBytes) throw new VoiceError('that voice note is too long for me.');
    return (await this.transcribe(audio)).trim();
  }

  /** What the owner said, from WAV (the app) or a voice note (OGG/Opus, MP3, M4A). */
  async transcribe(audio: Buffer): Promise<string> {
    const v = this.settings();
    if (v.stt === 'off') throw new VoiceError('Speech-to-text is off (Settings → Voice).');
    if (v.stt === 'openai') return openaiTranscribe(v.openai, this.#app.vault.get(VOICE_VAULT.openai), audio, v.xai.language);
    if (isWav(audio) && this.#app.voice) return this.#app.voice.transcribe(audio);
    // Voice notes: the on-server engine reads WAV only, so Grok voice hears them when available.
    if (this.hasXai()) {
      const key = await this.xaiKey().catch(() => undefined);
      if (key) return xaiTranscribe(key, audio, { language: v.xai.language, keyterms: [this.#app.persona.name, this.#app.settings.get().ownerName?.trim() ?? ''].filter(Boolean) });
    }
    if (isWav(audio)) throw new VoiceError(localVoiceSupported() ? 'Hearing on this server is not installed (deploy/install-voice.sh).' : `${localVoiceMissing()}.`);
    throw new VoiceError('To hear voice notes, turn on Grok voice (sign in to Grok) or a speech API in Settings → Voice.');
  }

  /** She can understand voice notes (not just WAV from the app). */
  canHearNotes(): boolean {
    const v = this.settings();
    return v.stt === 'openai' || (v.stt !== 'off' && this.hasXai());
  }
}

/** The app's Speech (created on first use). */
export function speechOf(app: AppContext): Speech {
  return (app.speech ??= new Speech(app));
}

/** Grok voice text: tags added, markdown cleaned, tags kept intact through the cleanup. */
export function tagged(text: string, level: Expressive, mood: MoodHint, tone: VoiceTone): string {
  const tags: string[] = [];
  const keep = addTags(text, level, mood, tone).replace(/\[(?:laugh|chuckle|sigh|breath|pause)\]|<\/?(?:whisper|soft|laugh-speak)>/g, (m) => `\uE000${tags.push(m) - 1}\uE001`);
  return speechText(keep).replace(/\uE000(\d+)\uE001/g, (_m, i: string) => tags[Number(i)]);
}
