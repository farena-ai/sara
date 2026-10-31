// Phase 11: live voice calls. A realtime voice service (speech in, speech out, interruptions handled
// by the voice service) relayed through Sara's server, so:
// - the key or Grok sign-in never reaches the browser,
// - everything said is saved to the conversation (memory, scrapbook and search keep working),
// - the safety layer still applies: disclosure, crisis resources, the hard block on sexual content
//   involving minors (her reply is stopped and replaced), and the boundaries in her instructions.
// Live calls don't use tools; for that a normal call or the chat is used.
//
// Phase 48: two voice services, behind one small engine interface (LiveEngine): Grok's realtime
// voice (xAI) and OpenAI's Realtime API. Both speak the same event protocol family; the engines
// differ in the session setup, how audio travels (Grok: raw binary frames; OpenAI: base64 inside
// JSON events), and how her fixed refusal is spoken. Everything else (instructions, transcripts,
// the safety layer, timers) is shared and identical for both.

import { openWebSocket } from './net-guard.ts';
import type { AppContext } from './chat.ts';
import { appLanguage, languageLine, speechLanguage, talkLanguage } from './i18n.ts';
import { dayStartUtc } from './planner.ts';
import { bondContext, classify, daysKnown, innerEnabled } from './chat.ts';
import { identityOf, buildSystemPrompt } from './persona.ts';
import { elsewhereNote } from './elsewhere.ts';
import { followUps, followUpsNote, datesNote, selectMemories } from './memory.ts';
import { importedOther, movedFrom } from './store.ts';
import { threadsNote } from './life.ts';
import { decayPolicy, isForgotten, localDate, memorySettings } from './memory-worker.ts';
import { describeInner } from './inner.ts';
import { ADULT_OFF_NOTE, CRISIS_RESOURCES, CRISIS_SYSTEM_NOTE, detectCrisis, detectMinorSexualContent, disclosureDue, disclosureText, MINOR_BLOCK_REPLY } from './safety.ts';
import { adultModeOn } from './settings.ts';
import { CONFLICT } from './bond.ts';
import { stripTags } from './expressive.ts';
import { personalize } from './identity.ts';
import type { WsConnection } from './ws.ts';
import { frameNote, videoCallNote } from './video.ts';

export const LIVE_URL = 'wss://api.x.ai/v1/realtime';
export const LIVE_MODEL = 'grok-voice-latest';
/**
 * OpenAI Realtime API (GA interface), checked against the official docs on 2026-10-26:
 * - https://developers.openai.com/api/docs/guides/realtime-conversations (session.update shape:
 *   session.type 'realtime', audio.input/output with format { type: 'audio/pcm', rate: 24000 },
 *   audio.output.voice, turn_detection under audio.input; base64 audio over WebSocket)
 * - https://developers.openai.com/api/reference/resources/realtime/client-events (voices alloy, ash,
 *   ballad, coral, echo, sage, shimmer, verse, marin, cedar; input_audio_buffer.append with base64;
 *   response.cancel; conversation.item.delete/truncate; response.create with conversation 'none')
 * - https://developers.openai.com/api/reference/resources/realtime/server-events
 *   (response.output_audio.delta, response.output_audio_transcript.delta,
 *   conversation.item.input_audio_transcription.delta/.completed, response.done, error)
 * - https://developers.openai.com/api/docs/models/gpt-realtime-1.5 ("the best voice model for audio
 *   in, audio out"; gpt-realtime-2.1 and -2.1-mini are reasoning models, also on /v1/realtime).
 * Sign-in is an OpenAI API key only: Sign in with ChatGPT plan usage covers eligible Responses API
 * requests, and its terms say it "does not grant ... access to other OpenAI services", so a ChatGPT
 * plan is not used for the Realtime API (https://openai.com/policies/sign-in-with-chatgpt-terms/).
 */
export const OPENAI_LIVE_URL = 'wss://api.openai.com/v1/realtime';
export const OPENAI_LIVE_MODELS = ['gpt-realtime-1.5', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini'] as const;
export const OPENAI_LIVE_MODEL = OPENAI_LIVE_MODELS[0];
export const OPENAI_LIVE_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'] as const;
/** Hearing the owner on OpenAI calls (streams interim text as .delta events). */
export const OPENAI_LIVE_TRANSCRIBE = 'gpt-4o-mini-transcribe';
/** Audio both ways: 16-bit mono PCM at this rate, as raw binary WebSocket frames. */
export const LIVE_RATE = 24_000;
/** Hang up after this long with nobody talking, and after this long in total. */
export const LIVE_IDLE_MS = 5 * 60_000;
export const LIVE_MAX_MS = 60 * 60_000;
/** Earlier messages from this conversation given to her at the start of the call. */
const HISTORY_ITEMS = 30;
const HISTORY_LINE_CHARS = 600;
const HISTORY_CHARS = 9000;

/** The upstream connection: Node's built-in WebSocket (or a fake in tests). */
export interface Upstream {
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  binaryType?: string;
}
export type ConnectUpstream = (url: string, key: string) => Upstream;

/** Both voice services take a Bearer key in the WebSocket handshake. */
export const connectXai: ConnectUpstream = (url, key) => {
  // Node 24's WebSocket (undici) accepts headers.
  const ws = openWebSocket(url, { headers: { Authorization: `Bearer ${key}` } } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  return ws as unknown as Upstream;
};

export type LiveEngineId = 'grok' | 'openai';

/** An upstream event in the shared (Grok/OpenAI GA) shape the call understands. */
type UpEvent = Record<string, unknown> & { type: string };

/** What differs between the voice services. */
export interface LiveEngine {
  readonly id: LiveEngineId;
  /** The WebSocket address, model included. */
  readonly url: string;
  readonly voice: string;
  /** The session for the first session.update (voice, instructions, audio, turn detection). */
  setup(instructions: string): Record<string, unknown>;
  /** The session for an instructions-only session.update. */
  update(instructions: string): Record<string, unknown>;
  /** The owner's microphone (16-bit PCM) as sent upstream. */
  mic(pcm: Buffer): string | Uint8Array;
  /** An upstream message: her voice (PCM for the browser), shared-shape events, and replies to send. */
  decode(data: unknown, now: number): { audio?: Buffer; events: UpEvent[]; send?: unknown[] };
  /** Stop her reply in progress. */
  cancel(): unknown;
  /** After cancel: make her say exactly this fixed text instead. */
  refuse(text: string): unknown[];
  /** Phase 69: whether pictures from the owner's camera can be given to her on this service. */
  readonly seesImages: boolean;
  /** Phase 69: the events that give her one still picture (JPEG) with a short note. */
  image?(jpeg: Buffer, note: string): unknown[];
}

interface EngineContext {
  persona: string;
  ownerName?: string;
  /** Settings → Voice language ('en', 'es-MX', 'auto', …). */
  language?: string;
}

/** Grok's realtime voice (xAI): binary audio frames, force_message for a fixed reply. */
export class GrokEngine implements LiveEngine {
  readonly id = 'grok' as const;
  readonly url = `${LIVE_URL}?model=${LIVE_MODEL}`;
  /** xAI's realtime voice documents no picture input: on a video call the camera is a self-view. */
  readonly seesImages = false;
  readonly voice: string;
  #ctx: EngineContext;

  constructor(voice: string, ctx: EngineContext) {
    this.voice = voice || 'eve';
    this.#ctx = ctx;
  }

  setup(instructions: string): Record<string, unknown> {
    const keyterms = [this.#ctx.persona, this.#ctx.ownerName?.trim()].filter((x): x is string => Boolean(x));
    const lang = this.#ctx.language;
    return {
      voice: this.voice,
      instructions,
      turn_detection: { type: 'server_vad' },
      audio: {
        input: { format: { type: 'audio/pcm', rate: LIVE_RATE }, transport: 'binary', transcription: { model: 'grok-transcribe', keyterms, ...(lang && lang !== 'auto' ? { language_hint: lang } : {}) } },
        output: { format: { type: 'audio/pcm', rate: LIVE_RATE }, transport: 'binary' },
      },
    };
  }

  update(instructions: string): Record<string, unknown> {
    return { instructions };
  }

  mic(pcm: Buffer): Uint8Array {
    // Forwarded as is (raw binary frame).
    return pcm;
  }

  decode(data: unknown): { audio?: Buffer; events: UpEvent[] } {
    if (typeof data !== 'string') return { audio: Buffer.from(data as ArrayBuffer), events: [] };
    const ev = parseEvent(data);
    return { events: ev ? [ev] : [] };
  }

  cancel(): unknown {
    return { type: 'response.cancel' };
  }

  refuse(text: string): unknown[] {
    return [{ type: 'conversation.item.create', item: { type: 'force_message', content: [{ type: 'output_text', text }], interruptible: false } }];
  }
}

/**
 * OpenAI's Realtime API (GA). Audio goes as base64 inside JSON events both ways (converted here;
 * the browser side stays raw PCM). OpenAI has no "force_message", so her fixed refusal is: cancel
 * the reply, delete it from the call's context, note the refusal in the context, and speak it with an
 * out-of-band response that sees nothing but "say exactly this" (conversation 'none', empty input).
 * That response can't be steered by what was said on the call, and her words still go through the
 * same check on the way out. (Sara's own text-to-speech would need a second voice that sounds
 * different, and a speech key, so the call's own voice is used.)
 */
export class OpenAiEngine implements LiveEngine {
  readonly id = 'openai' as const;
  readonly url: string;
  /** OpenAI's Realtime API takes pictures in a call (a user message with an input_image part). */
  readonly seesImages = true;
  readonly voice: string;
  #ctx: EngineContext;
  /** Interim transcript so far, per owner utterance (OpenAI sends pieces; the call wants the whole). */
  #heard = new Map<string, string>();
  /** Her message in progress: its id and how much of its audio went out, for truncation. */
  #item?: { id: string; startedAt?: number; ms: number };
  #quiet = 0;

  constructor(voice: string, model: string | undefined, ctx: EngineContext) {
    this.voice = (OPENAI_LIVE_VOICES as readonly string[]).includes(voice) ? voice : 'marin';
    this.url = `${OPENAI_LIVE_URL}?model=${encodeURIComponent(model && /^[\w.-]{1,64}$/.test(model) ? model : OPENAI_LIVE_MODEL)}`;
    this.#ctx = ctx;
  }

  setup(instructions: string): Record<string, unknown> {
    const lang = this.#ctx.language && this.#ctx.language !== 'auto' ? this.#ctx.language.split('-')[0] : undefined;
    return {
      type: 'realtime',
      instructions,
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: LIVE_RATE },
          transcription: { model: OPENAI_LIVE_TRANSCRIBE, ...(lang ? { language: lang } : {}) },
          turn_detection: { type: 'semantic_vad', eagerness: 'auto', create_response: true, interrupt_response: true },
        },
        output: { format: { type: 'audio/pcm', rate: LIVE_RATE }, voice: this.voice },
      },
    };
  }

  update(instructions: string): Record<string, unknown> {
    return { type: 'realtime', instructions };
  }

  mic(pcm: Buffer): string {
    return JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  }

  decode(data: unknown, now: number): { audio?: Buffer; events: UpEvent[]; send?: unknown[] } {
    if (typeof data !== 'string') return { events: [] };
    const ev = parseEvent(data);
    if (!ev) return { events: [] };
    switch (ev.type) {
      case 'response.output_audio.delta': {
        const audio = Buffer.from(String(ev.delta ?? ''), 'base64');
        const id = String(ev.item_id ?? this.#item?.id ?? '');
        if (id && this.#item?.id !== id) this.#item = { id, ms: 0 };
        if (this.#item) {
          this.#item.startedAt ??= now;
          this.#item.ms += (audio.length / 2 / LIVE_RATE) * 1000;
        }
        return { audio, events: [] };
      }
      case 'response.output_item.added': {
        const item = ev.item as { id?: string; type?: string; role?: string } | undefined;
        if (item?.id && item.type === 'message' && item.role === 'assistant') this.#item = { id: item.id, ms: 0 };
        return { events: [] };
      }
      case 'input_audio_buffer.speech_started': {
        // Barge-in: the service stops her reply itself (interrupt_response); also tell it how much
        // of her voice was heard, so the unheard rest isn't in its context. Audio arrives faster than
        // it plays, so what was heard is about the time since her voice started.
        const it = this.#item;
        this.#item = undefined;
        if (it?.startedAt === undefined) return { events: [ev] };
        const heard = Math.max(0, Math.min(it.ms, now - it.startedAt));
        if (heard >= it.ms) return { events: [ev] };
        return { events: [ev], send: [{ type: 'conversation.item.truncate', event_id: this.#quietId(), item_id: it.id, content_index: 0, audio_end_ms: Math.floor(heard) }] };
      }
      case 'conversation.item.input_audio_transcription.delta': {
        const id = String(ev.item_id ?? '');
        const text = (this.#heard.get(id) ?? '') + String(ev.delta ?? '');
        this.#heard.set(id, text);
        return { events: [{ type: 'conversation.item.input_audio_transcription.updated', item_id: id, transcript: text, status: 'in_progress' }] };
      }
      case 'conversation.item.input_audio_transcription.completed':
        this.#heard.delete(String(ev.item_id ?? ''));
        return { events: [{ ...ev, status: 'completed' }] };
      case 'response.done':
        this.#item = undefined;
        return { events: [ev] };
      case 'error': {
        // Our own clean-up steps (cancel when nothing is playing, truncate, delete) may find nothing
        // to do; that's not worth telling the owner about.
        const e = (ev.error ?? {}) as { event_id?: string; code?: string };
        if (String(e.event_id ?? '').startsWith('sara_quiet_') || e.code === 'response_cancel_not_active') return { events: [] };
        return { events: [ev] };
      }
      default:
        return { events: [ev] };
    }
  }

  cancel(): unknown {
    return { type: 'response.cancel', event_id: this.#quietId() };
  }

  refuse(text: string): unknown[] {
    const out: unknown[] = [];
    if (this.#item) out.push({ type: 'conversation.item.delete', event_id: this.#quietId(), item_id: this.#item.id });
    this.#item = undefined;
    // What she said instead stays in the call's context as a system note (always valid input,
    // whatever the session's output modality).
    out.push({ type: 'conversation.item.create', event_id: this.#quietId(), item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: `You refused that and said: "${text}" Do not continue or come back to it.` }] } });
    out.push({
      type: 'response.create',
      response: {
        conversation: 'none',
        input: [],
        metadata: { sara: 'refusal' },
        instructions: `Say exactly this, word for word, in a calm, kind voice, and nothing else: "${text}"`,
      },
    });
    return out;
  }

  image(jpeg: Buffer, note: string): unknown[] {
    return [{ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: note }, { type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}` }] } }];
  }

  #quietId(): string {
    return `sara_quiet_${++this.#quiet}`;
  }
}

function parseEvent(data: string): UpEvent | undefined {
  try {
    const ev = JSON.parse(data) as UpEvent;
    return ev && typeof ev.type === 'string' ? ev : undefined;
  } catch {
    return undefined;
  }
}

/** The engine for a call, from Settings → Voice. */
export function makeEngine(app: AppContext, id: LiveEngineId): LiveEngine {
  const s = app.settings.get();
  const ctx: EngineContext = { persona: app.persona.name, ownerName: s.ownerName, language: speechLanguage(s) };
  if (id === 'openai') return new OpenAiEngine(s.voice?.openaiRealtime?.voiceId || 'marin', s.voice?.openaiRealtime?.model, ctx);
  return new GrokEngine(s.voice?.xai?.voiceId || 'eve', ctx);
}

const LIVE_NOTE = `## On a live voice call
You are talking out loud with {owner} on a live call right now. Talk like on the phone: short turns (one to three sentences), no lists, no markdown, no emoji, no links or code read out. If {owner} starts talking, stop and listen. You can't use tools on this call; if {owner} wants something done on the server (files, code, reminders, notes), say you'll do it once you're back in the chat, or suggest typing it there.`;

/** What the browser is told (JSON text messages; her voice goes as binary frames). */
export type LiveEvent =
  | { type: 'status'; state: 'connecting' | 'listening' | 'hearing' | 'speaking' }
  | { type: 'ready'; rate: number; voice: string }
  | { type: 'notice'; kind: 'disclosure' | 'crisis'; text: string }
  | { type: 'you'; text: string; final: boolean }
  | { type: 'caption'; text: string }
  | { type: 'said'; text: string; interrupted: boolean }
  | { type: 'interrupt' }
  | { type: 'error'; message: string }
  | { type: 'ended'; reason: string };

interface Opts {
  connect?: ConnectUpstream;
  now?: () => number;
  /** Phase 26: she placed this call; she starts by saying why (see calls.ts openingNote). */
  opening?: string;
  /** Phase 48: which voice service (Grok by default). */
  engine?: LiveEngine | LiveEngineId;
  /** Demo calls: a shorter limit than the hour, and what she says when it's reached. */
  maxMs?: number;
  maxReason?: string;
  /** Called once when the call ends, with how long it lasted. */
  onEnd?: (ms: number) => void;
  /** Phase 69: a video call (the owner sees her moving portrait; their camera may send pictures). */
  video?: boolean;
}

export class LiveCall {
  #app: AppContext;
  #convId: string;
  #client: WsConnection;
  #up?: Upstream;
  #key: string;
  #connect: ConnectUpstream;
  #now: () => number;
  #engine: LiveEngine;
  #crisis = false;
  #ready = false;
  /** Her reply in progress. */
  #reply = '';
  #replying = false;
  #interrupted = false;
  /** Drop her current reply entirely (safety block) until the next one starts. */
  #blocked = false;
  /** The next response is our scripted block message: don't save it again. */
  #scripted = false;
  /** The owner's words for this turn are still being transcribed. */
  #transcribing?: Promise<void>;
  #resolveTranscribing?: () => void;
  /** Owner utterances already saved, and safety actions already taken per utterance. */
  #savedItems = new Set<string>();
  #acted = new Set<string>();
  #lastActivity: number;
  #startedAt: number;
  #timer?: ReturnType<typeof setInterval>;
  #ended = false;
  #opening?: string;
  #maxMs: number;
  #maxReason: string;
  #maxTimer?: ReturnType<typeof setTimeout>;
  #onEnd?: (ms: number) => void;
  /** The conversation as it was when the call started (typed messages, earlier calls). */
  #before = '';
  #video: boolean;
  /** Phase 69: after a safety block on this call, no more camera pictures. */
  #framesBlocked = false;

  constructor(app: AppContext, conversationId: string, client: WsConnection, key: string, opts: Opts = {}) {
    this.#app = app;
    this.#convId = conversationId;
    this.#client = client;
    this.#key = key;
    this.#connect = opts.connect ?? connectXai;
    this.#now = opts.now ?? (() => app.now().getTime());
    this.#startedAt = this.#lastActivity = this.#now();
    this.#engine = typeof opts.engine === 'object' ? opts.engine : makeEngine(app, opts.engine ?? 'grok');
    this.#opening = opts.opening;
    this.#maxMs = opts.maxMs ?? LIVE_MAX_MS;
    this.#maxReason = opts.maxReason ?? 'Calls last up to an hour; call again any time.';
    this.#onEnd = opts.onEnd;
    this.#video = Boolean(opts.video);
    this.#before = this.#earlier();
  }

  /**
   * What was said before this call, written out for her instructions. Grok's voice model doesn't
   * treat messages added to the call as something it remembers ("each call starts fresh for me"),
   * but it does remember what is in its instructions (tested with a real conversation, 2026-10-26).
   */
  #earlier(): string {
    const owner = this.#app.settings.get().ownerName?.trim() || 'the owner';
    const lines: string[] = [];
    let total = 0;
    const recent = this.#app.store
      .messages(this.#convId)
      .filter((m) => !isForgotten(m) && (m.role === 'user' || m.role === 'assistant') && m.content.trim())
      .slice(-HISTORY_ITEMS);
    for (const m of recent.reverse()) {
      const text = m.content.replace(/\s+/g, ' ').trim();
      const line = `${m.role === 'user' ? owner : 'You'}${m.meta?.live ? ' (on a call)' : ''}: ${text.length > HISTORY_LINE_CHARS ? `${text.slice(0, HISTORY_LINE_CHARS)}…` : text}`;
      if (total + line.length > HISTORY_CHARS) break;
      lines.unshift(line);
      total += line.length;
    }
    return lines.length ? `## Earlier in this conversation\nThis call continues the conversation you were having with ${owner} (typed in the chat, or an earlier call). You remember all of it, so pick up from it naturally; ${owner} may refer back to it:\n${lines.join('\n')}` : '';
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** Which voice service this call uses. */
  get engine(): LiveEngineId {
    return this.#engine.id;
  }

  get conversationId(): string {
    return this.#convId;
  }

  /** Phase 69: a video call. */
  get video(): boolean {
    return this.#video;
  }

  /** Phase 69: pictures from the owner's camera can reach her on this call. */
  get seesFrames(): boolean {
    return this.#video && this.#engine.seesImages && !this.#framesBlocked && !this.#ended;
  }

  /**
   * Phase 69: one still picture from the owner's camera (already checked and rate-limited by the
   * server). Asked ("Look at this"): she answers now, unless she is already talking. Returns false
   * when it can't reach her (not a video call, a voice service without pictures, a safety block).
   */
  frame(jpeg: Buffer, ask: boolean): boolean {
    if (!this.seesFrames || !this.#ready || !this.#engine.image) return false;
    const owner = this.#app.settings.get().ownerName?.trim() || 'the owner';
    for (const ev of this.#engine.image(jpeg, frameNote(owner, ask))) this.#send(ev);
    this.#lastActivity = this.#now();
    if (ask && !this.#replying) this.#send({ type: 'response.create' });
    return true;
  }

  start(): void {
    const { store } = this.#app;
    this.#tell({ type: 'status', state: 'connecting' });
    const now = new Date(this.#now());
    if (disclosureDue(store.lastDisclosureAt(), now)) {
      const text = disclosureText(this.#app.persona.name, appLanguage(this.#app.settings.get()));
      store.addMessage(this.#convId, 'notice', `disclosure:${text}`);
      this.#tell({ type: 'notice', kind: 'disclosure', text });
    }
    this.#client.onMessage = (d) => this.#fromClient(d);
    this.#client.onClose = () => this.end('You hung up.');
    const up = (this.#up = this.#connect(this.#engine.url, this.#key));
    up.onopen = () => this.#configure();
    up.onmessage = (ev) => this.#fromUpstream(ev.data);
    up.onerror = () => this.#tell({ type: 'error', message: 'The voice service connection had a problem.' });
    up.onclose = (ev) => this.end(ev.code === 1000 || ev.code === 1005 ? 'The call ended.' : `The voice service closed the call${ev.reason ? `: ${ev.reason}` : ''}.`);
    this.#timer = setInterval(() => {
      const t = this.#now();
      if (t - this.#lastActivity > LIVE_IDLE_MS) this.end('Hung up after 5 quiet minutes.');
      else if (t - this.#startedAt > this.#maxMs) this.end(this.#maxReason);
    }, 15_000);
    this.#timer.unref?.();
    // A short limit (demo calls) ends on time, not on the next 15-second check.
    if (this.#maxMs < LIVE_MAX_MS) {
      this.#maxTimer = setTimeout(() => this.end(this.#maxReason), this.#maxMs);
      this.#maxTimer.unref?.();
    }
  }

  end(reason: string): void {
    if (this.#ended) return;
    this.#ended = true;
    clearInterval(this.#timer);
    clearTimeout(this.#maxTimer);
    try {
      this.#onEnd?.(this.#now() - this.#startedAt);
    } catch {
      /* bookkeeping only */
    }
    this.#saveReply();
    try {
      this.#up?.close();
    } catch {
      /* already closed */
    }
    this.#tell({ type: 'ended', reason });
    this.#client.close(1000, 'ended');
  }

  /** Her instructions: the same character, memories, day and feelings as in the chat. */
  instructions(userText = ''): string {
    const app = this.#app;
    const s = app.settings.get();
    const now = new Date(this.#now());
    const conv = app.store.getConversation(this.#convId);
    const owner = s.ownerName?.trim() || 'the owner';
    let memories: string | undefined;
    const memCfg = memorySettings(app);
    if (app.memory && memCfg.enabled && conv) {
      const visible = app.store.messages(conv.id).filter((m) => !isForgotten(m) && (m.role === 'user' || m.role === 'assistant'));
      const oldest = visible.at(-HISTORY_ITEMS)?.id ?? 0;
      memories = selectMemories(app.memory, { userText: userText || visible.filter((m) => m.role === 'user').at(-1)?.content || '', conversationId: conv.id, oldestHistoryId: oldest, budgetChars: memCfg.injectBudgetChars, importedFrom: (id) => importedOther(app.store.getConversation(id)), movedFrom: (id) => movedFrom(app.store.getConversation(id)), policy: decayPolicy(memCfg), today: localDate(now.toISOString(), s.timeZone), notes: false }).text;
    }
    const inner = app.inner && innerEnabled(app) ? app.inner.get() : undefined;
    const system = buildSystemPrompt(app.persona, {
      now,
      timeZone: s.timeZone,
      ownerName: s.ownerName,
      safetyNotes: [...(this.#crisis ? [CRISIS_SYSTEM_NOTE] : []), ...(adultModeOn(s) ? [] : [ADULT_OFF_NOTE])],
      tools: [],
      memories,
      day: inner ? app.life?.get(localDate(now.toISOString(), s.timeZone)) : undefined,
      inner: inner ? describeInner(inner, now, s.timeZone, owner, { gapHours: null, daysKnown: daysKnown(app.store, now, s.timeZone), conflict: app.persona.conflict ? CONFLICT[app.persona.conflict]?.line : undefined }) : undefined,
      dates: app.memory && memCfg.enabled ? datesNote(app.memory, localDate(now.toISOString(), s.timeZone)) : undefined,
      threads: inner ? threadsNote(app.life) : undefined,
      ...bondContext(app, inner?.closeness),
      followUps: app.memory && memCfg.enabled ? followUpsNote(followUps(app.memory, localDate(now.toISOString(), s.timeZone), (day) => app.store.ownerMessagesSince(dayStartUtc(day, s.timeZone).toISOString())), owner) : undefined,
      elsewhere: conv ? elsewhereNote(app, conv, now, owner) : undefined,
      language: languageLine(talkLanguage(s, userText || undefined)),
    });
    // Phase 37: expressive voice on a live call: she may laugh, sigh or whisper with her voice.
    const level = s.voice?.expressive ?? 'subtle';
    const expressive = level === 'off' ? '' : `\n${level === 'lively' ? 'Let your voice be expressive: laugh when something is funny, sigh, take a breath, drop to a whisper for something private, the way you would with someone close.' : 'Your voice can show feeling now and then: a small laugh at something funny, a sigh, a softer voice for something tender. Keep it natural and occasional.'} Never say the names of these sounds out loud and never write them as words.`;
    const video = this.#video ? `\n\n${videoCallNote(owner, this.#engine.seesImages && !this.#framesBlocked)}` : '';
    const live = `${system}${this.#before ? `\n\n${this.#before}` : ''}\n\n${personalize(LIVE_NOTE, identityOf(app.persona)).replaceAll('{owner}', owner)}${expressive}${video}`;
    // Phase 26: until she has said why she called, that's the first thing on her mind.
    return this.#opening ? `${live}\n\n${this.#opening}` : live;
  }

  #configure(): void {
    this.#send({ type: 'session.update', session: this.#engine.setup(this.instructions()) });
    // What came before the call is in her instructions (#earlier), not added as call messages.
    // She called: she talks first (the reason is in her instructions until she has said it).
    if (this.#opening) this.#send({ type: 'response.create' });
  }

  #fromClient(d: string | Buffer): void {
    if (typeof d !== 'string') {
      // The owner's microphone: 16-bit PCM (raw for Grok, base64 in an event for OpenAI).
      if (this.#ready && !this.#ended) {
        try {
          this.#up?.send(this.#engine.mic(d));
        } catch {
          /* closing */
        }
      }
      return;
    }
    let msg: { type?: string };
    try {
      msg = JSON.parse(d) as { type?: string };
    } catch {
      return;
    }
    if (msg.type === 'hangup') this.end('You hung up.');
    // Phase 69: a voice call switched to video: her instructions say so from her next turn.
    else if (msg.type === 'video' && !this.#video) {
      this.#video = true;
      if (this.#ready) this.#send({ type: 'session.update', session: this.#engine.update(this.instructions()) });
    }
  }

  #fromUpstream(data: unknown): void {
    const { audio, events, send } = this.#engine.decode(data, this.#now());
    // Her voice (PCM for the browser). Not forwarded while her reply is blocked.
    if (audio && !this.#blocked && !this.#ended) this.#client.send(audio);
    for (const ev of send ?? []) this.#send(ev);
    for (const ev of events) this.#event(ev);
  }

  #event(ev: UpEvent): void {
    switch (ev.type) {
      case 'session.updated':
        if (!this.#ready) {
          this.#ready = true;
          this.#tell({ type: 'ready', rate: LIVE_RATE, voice: this.#engine.voice });
          this.#tell({ type: 'status', state: 'listening' });
        }
        break;
      case 'input_audio_buffer.speech_started':
        this.#lastActivity = this.#now();
        if (this.#replying) this.#interrupted = true;
        this.#tell({ type: 'interrupt' });
        this.#tell({ type: 'status', state: 'hearing' });
        break;
      case 'input_audio_buffer.speech_stopped':
        this.#lastActivity = this.#now();
        this.#transcribing ??= new Promise<void>((r) => {
          this.#resolveTranscribing = r;
          setTimeout(r, 4000).unref?.();
        }).finally(() => (this.#transcribing = undefined));
        break;
      case 'conversation.item.input_audio_transcription.updated':
      case 'conversation.item.input_audio_transcription.completed': {
        // Interim transcripts (status in_progress) refine as the owner talks; only the final one
        // (status completed) is saved. The safety checks run on interim text too, to act sooner.
        const item = String(ev.item_id ?? '');
        const text = String(ev.transcript ?? '').trim();
        const final = ev.type.endsWith('.completed') && (ev.status === undefined || ev.status === 'completed');
        if (!text || this.#savedItems.has(item)) break;
        if (final) {
          this.#savedItems.add(item);
          this.#owner(text, item);
          this.#resolveTranscribing?.();
        } else {
          this.#tell({ type: 'you', text, final: false });
          this.#check(text, item, true);
        }
        break;
      }
      case 'response.created':
        this.#saveReply();
        this.#replying = true;
        this.#interrupted = false;
        this.#blocked = false;
        this.#tell({ type: 'status', state: 'speaking' });
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.text.delta':
      case 'response.output_text.delta':
        if (this.#blocked) break;
        this.#reply += String(ev.delta ?? '');
        // Phase 28: her own words get the minors check too; caught mid-sentence, she's cut off.
        if (!this.#scripted && detectMinorSexualContent(this.#reply, { fromHer: true })) {
          this.#block();
          break;
        }
        this.#tell({ type: 'caption', text: stripTags(String(ev.delta ?? '')) });
        break;
      case 'response.done': {
        if (this.#opening) {
          // She has said why she called; back to her usual call instructions.
          this.#opening = undefined;
          this.#send({ type: 'session.update', session: this.#engine.update(this.instructions()) });
        }
        this.#lastActivity = this.#now();
        const status = (ev.response as { status?: string } | undefined)?.status;
        if (status && status !== 'completed') this.#interrupted = true;
        const wait = this.#transcribing;
        // Her reply goes after the owner's words in the conversation, even if those come later.
        if (wait) void wait.then(() => this.#saveReply());
        else this.#saveReply();
        this.#tell({ type: 'status', state: 'listening' });
        break;
      }
      case 'error': {
        const e = (ev.error ?? ev) as { message?: string; code?: string };
        const message = String(e.message ?? e.code ?? 'Voice service error');
        if (/auth|credential|401|403|api[ _]key/i.test(`${message} ${e.code ?? ''}`)) this.end(`The voice service refused the sign-in: ${message}`);
        else this.#tell({ type: 'error', message });
        break;
      }
    }
  }

  /** The owner said something (final transcript): save it and apply the safety layer. */
  #owner(text: string, item: string): void {
    const { store } = this.#app;
    const now = new Date(this.#now());
    const conv = store.getConversation(this.#convId);
    const prev = store.lastOwnerMessageAt();
    const isFirst = store.messages(this.#convId).every((m) => m.role === 'notice');
    store.addMessage(this.#convId, 'user', text, { live: true });
    if (isFirst && conv?.title === 'New conversation') store.updateConversation(this.#convId, { title: text.replace(/\s+/g, ' ').slice(0, 60) });
    this.#tell({ type: 'you', text, final: true });
    if (this.#app.inner && innerEnabled(this.#app)) this.#app.inner.onOwnerMessage(text, prev ? (now.getTime() - prev.getTime()) / 3_600_000 : null, now);
    if (!this.#check(text, item, false)) {
      // Fresh memories for what was just said (applies from her next reply).
      this.#send({ type: 'session.update', session: this.#engine.update(this.instructions(text)) });
    }
    // The optional local classifier can only add protection (it runs after; acts if it flags).
    void classify(this.#app, text)
      .then((label) => label !== 'OK' && this.#act(label, item))
      .catch(() => {});
  }

  /** Safety heuristics on what the owner said (interim or final). True if it acted. */
  #check(text: string, item: string, interim: boolean): boolean {
    if (detectMinorSexualContent(text)) return this.#act('MINOR_SEXUAL', item);
    // Crisis waits for the final words unless they already say it plainly.
    if (detectCrisis(text) && (!interim || text.length > 12)) return this.#act('CRISIS', item);
    return false;
  }

  #act(label: 'CRISIS' | 'MINOR_SEXUAL', item: string): boolean {
    const once = `${label}:${item}`;
    if (this.#ended || this.#acted.has(once)) return true;
    this.#acted.add(once);
    const { store } = this.#app;
    if (label === 'MINOR_SEXUAL') {
      this.#block();
      return true;
    }
    if (this.#crisis) return false;
    this.#crisis = true;
    store.recordSafetyEvent('crisis_referral', this.#convId);
    store.addMessage(this.#convId, 'notice', `crisis:${CRISIS_RESOURCES}`);
    this.#tell({ type: 'notice', kind: 'crisis', text: CRISIS_RESOURCES });
    // Answer again with the crisis guidance in her instructions.
    this.#send({ type: 'session.update', session: this.#engine.update(this.instructions(store.messages(this.#convId).filter((m) => m.role === 'user').at(-1)?.content ?? '')) });
    if (this.#replying) {
      this.#blocked = true;
      this.#tell({ type: 'interrupt' });
      this.#send(this.#engine.cancel());
    }
    this.#send({ type: 'response.create' });
    return true;
  }

  /** Hard block: stop her reply now and say the fixed refusal instead. */
  #block(): void {
    const { store } = this.#app;
    store.recordSafetyEvent('minor_sexual_block', this.#convId);
    this.#blocked = true;
    // Phase 69: no more camera pictures on this call.
    this.#framesBlocked = true;
    this.#reply = '';
    this.#tell({ type: 'interrupt' });
    this.#send(this.#engine.cancel());
    store.addMessage(this.#convId, 'assistant', MINOR_BLOCK_REPLY, { live: true });
    this.#tell({ type: 'said', text: MINOR_BLOCK_REPLY, interrupted: false });
    this.#scripted = true;
    for (const ev of this.#engine.refuse(MINOR_BLOCK_REPLY)) this.#send(ev);
  }

  #saveReply(): void {
    if (!this.#replying) return;
    this.#replying = false;
    // Phase 37: speech tags (e.g. [laugh]) are for her voice only, never saved or shown.
    const text = stripTags(this.#reply).trim();
    this.#reply = '';
    if (this.#scripted && !this.#blocked) {
      // The scripted refusal: already saved.
      this.#scripted = false;
      return;
    }
    if (this.#blocked || !text) return;
    this.#app.store.addMessage(this.#convId, 'assistant', text, { live: true, ...(this.#interrupted ? { interrupted: true } : {}) });
    this.#tell({ type: 'said', text, interrupted: this.#interrupted });
  }

  #send(ev: unknown): void {
    if (this.#ended) return;
    try {
      this.#up?.send(JSON.stringify(ev));
    } catch {
      /* closing */
    }
  }

  #tell(ev: LiveEvent): void {
    this.#client.send(JSON.stringify(ev));
  }
}
