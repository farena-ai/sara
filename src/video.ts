// Phase 69: video calls. A video call is a normal call (live or classic) with her moving portrait
// shown large in the app; that part needs nothing from the server. What the server does here is the
// owner's optional camera: still pictures (JPEG, downscaled in the app) that she may look at.
//
// Rules, all enforced here and not only in the app:
// - Off unless the owner turns the camera on; a picture is sent only while it's on.
// - Nothing is written to disk: the newest picture is kept in memory for a short while (classic
//   calls take it with the next thing you say), then dropped; live calls pass it straight on.
// - Pictures go only to the model that answers on this call, and only if it can look at pictures;
//   otherwise the camera is a self-view and the app says so.
// - Refused in the demo, in group and partner chats, when "Nothing leaves this computer" is on and
//   the model isn't on this computer, in private conversations with a cloud model, and for an hour
//   after a safety block (the minors check) in that conversation.
// - At most one picture every few seconds (the owner's setting, never under MIN_GAP_MS) and a
//   per-call cap.

import type { ProviderConfig } from './providers/types.ts';
import { netFetch } from './net-guard.ts';
import { onThisComputer } from './private-local.ts';
import { isCloudModelName } from './model-names.ts';

/** How often she looks (seconds); 0 = only when you ask ("Look at this"). */
export const LOOK_EVERY = [0, 5, 10, 20, 30] as const;
/** Pictures per call. */
export const PER_CALL = [20, 40, 60, 120] as const;
export interface VideoSettings {
  lookEvery: (typeof LOOK_EVERY)[number];
  perCall: (typeof PER_CALL)[number];
}
export const DEFAULT_VIDEO: VideoSettings = { lookEvery: 10, perCall: 60 };

/** A picture from the app is about 512 px wide; anything much larger is refused. */
export const FRAME_MAX_BYTES = 400_000;
export const FRAME_MAX_SIDE = 1024;
/** Never more often than this, even when asked. */
export const MIN_GAP_MS = 3_000;
/** A classic call uses a picture only if it is this fresh. */
export const FRAME_FRESH_MS = 30_000;
/** After a safety block in a conversation, its camera stays off this long. */
export const SAFETY_PAUSE_MS = 60 * 60_000;
/** A video session nobody sent anything to for this long is forgotten. */
export const SESSION_IDLE_MS = 15 * 60_000;

export class VideoError extends Error {
  readonly status: number;
  readonly params?: Record<string, string | number>;
  constructor(status: number, message: string, params?: Record<string, string | number>) {
    super(message);
    this.status = status;
    if (params) this.params = params;
  }
}

/** The owner's video settings (Settings → Voice), with defaults. */
export function videoSettings(v?: Partial<VideoSettings> | null): VideoSettings {
  const every = (LOOK_EVERY as readonly number[]).includes(Number(v?.lookEvery)) ? (Number(v?.lookEvery) as VideoSettings['lookEvery']) : DEFAULT_VIDEO.lookEvery;
  const cap = (PER_CALL as readonly number[]).includes(Number(v?.perCall)) ? (Number(v?.perCall) as VideoSettings['perCall']) : DEFAULT_VIDEO.perCall;
  return { lookEvery: every, perCall: cap };
}

/** Checks a settings update (from the voice settings PUT); unknown values are refused, not guessed. */
export function parseVideoSettings(body: unknown, cur: VideoSettings): VideoSettings {
  if (body === undefined) return cur;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new VideoError(400, 'Invalid value "{value}"', { value: String(body) });
  const b = body as Record<string, unknown>;
  const pick = <T extends number>(v: unknown, allowed: readonly T[], d: T): T => {
    if (v === undefined) return d;
    const n = Number(v);
    if (typeof v === 'boolean' || !allowed.includes(n as T)) throw new VideoError(400, 'Invalid value "{value}"', { value: String(v) });
    return n as T;
  };
  return { lookEvery: pick(b.lookEvery, LOOK_EVERY, cur.lookEvery), perCall: pick(b.perCall, PER_CALL, cur.perCall) };
}

/** Width and height of a baseline or progressive JPEG (from its SOF marker), or null if it isn't one. */
export function jpegSize(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    // Fill bytes and markers without a length.
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end, or image data before any size
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (len < 2) return null;
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > buf.length) return null;
      const height = (buf[i + 5] << 8) | buf[i + 6];
      const width = (buf[i + 7] << 8) | buf[i + 8];
      return width && height ? { width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

/** Checks one picture from the app: a JPEG, not too big. Throws VideoError. */
export function checkFrame(buf: Uint8Array): { width: number; height: number } {
  if (!buf.length) throw new VideoError(400, 'Send a JPEG picture.');
  if (buf.length > FRAME_MAX_BYTES) throw new VideoError(413, 'The picture is too big: send at most {side} pixels on a side.', { side: FRAME_MAX_SIDE });
  const size = jpegSize(buf);
  if (!size) throw new VideoError(415, 'Send a JPEG picture.');
  if (size.width > FRAME_MAX_SIDE || size.height > FRAME_MAX_SIDE) throw new VideoError(413, 'The picture is too big: send at most {side} pixels on a side.', { side: FRAME_MAX_SIDE });
  return size;
}

/** Per call: how often and how many pictures. */
export class FrameGate {
  readonly settings: VideoSettings;
  used = 0;
  #last = -Infinity;
  constructor(settings: VideoSettings) {
    this.settings = settings;
  }

  /** Smallest gap between two pictures: the owner's setting, never under MIN_GAP_MS; asking is allowed every MIN_GAP_MS. */
  gapMs(ask: boolean): number {
    return ask || this.settings.lookEvery === 0 ? MIN_GAP_MS : Math.max(MIN_GAP_MS, this.settings.lookEvery * 1000 - 500);
  }

  /** May a picture go now? Counts it if so; throws VideoError otherwise. */
  take(now: number, ask: boolean): { used: number; left: number } {
    if (!ask && this.settings.lookEvery === 0) throw new VideoError(409, 'She only looks when you ask (Settings → Voice).');
    if (this.used >= this.settings.perCall) throw new VideoError(429, 'She already looked {n} times on this call (the limit in Settings → Voice).', { n: this.settings.perCall });
    const gap = this.gapMs(ask);
    if (now - this.#last < gap) throw new VideoError(429, 'Too soon: she looks at most every {seconds} seconds.', { seconds: Math.round(gap / 1000) });
    this.#last = now;
    this.used++;
    return { used: this.used, left: this.settings.perCall - this.used };
  }
}

/** Where the pictures of a call would go. */
export type CameraTarget =
  | { kind: 'live'; engine: 'grok' | 'openai' }
  | { kind: 'classic'; provider?: Pick<ProviderConfig, 'kind' | 'baseUrl' | 'label' | 'local'>; model?: string; sees?: boolean; error?: string }
  | { kind: 'none' };

/** What the app shows next to the camera button. `sees` false = self-view only (with the reason). */
export interface CameraState {
  /** Pictures may be sent (the camera button sends them to her). */
  allowed: boolean;
  /** She can look at them (false: the camera is a self-view only). */
  sees: boolean;
  /** Why not, in English (a template when `params` is set; the app translates it). */
  message?: string;
  params?: Record<string, string | number>;
  /** Who would see the pictures, for the privacy line under the camera. */
  goesTo?: string;
}

export interface CameraContext {
  demo?: boolean;
  group?: boolean;
  partner?: boolean;
  /** A private conversation (only hardware the owner controls). */
  privateConv?: boolean;
  /** "Nothing leaves this computer" is on. */
  privateLocal: boolean;
  /** When the last safety block in this conversation was (ms). */
  lastBlockAt?: number;
  now: number;
  target: CameraTarget;
}

const isCloudLive = (t: CameraTarget) => t.kind === 'live';

/** Whether the owner's camera may send pictures on this call, and whether she can see them. */
export function cameraState(c: CameraContext): CameraState {
  const no = (message: string, params?: Record<string, string | number>): CameraState => ({ allowed: false, sees: false, message, ...(params ? { params } : {}) });
  if (c.demo) return no('The camera is off on the demo server.');
  if (c.group) return no('Video calls aren’t available in group chats.');
  if (c.partner) return no('The camera only works in your own conversations with her.');
  if (c.lastBlockAt !== undefined && c.now - c.lastBlockAt < SAFETY_PAUSE_MS) return no('The camera is paused in this conversation after a safety block.');
  const t = c.target;
  if (t.kind === 'none') return no('Start the call first.');
  const cloud = isCloudLive(t) || (t.kind === 'classic' && Boolean(t.provider) && !onThisComputer({ kind: t.provider!.kind, baseUrl: t.provider!.baseUrl }, t.model));
  if (c.privateLocal && cloud) return no('“Nothing leaves this computer” is on, so camera pictures can only go to a model on this computer.');
  if (c.privateConv && (isCloudLive(t) || (t.kind === 'classic' && t.provider && (!t.provider.local || isCloudModelName(t.model ?? ''))))) return no('The camera is off in private conversations with a model that isn’t on your own hardware.');
  if (t.kind === 'live') {
    // Checked against the services' documentation: OpenAI's Realtime API takes pictures in a call
    // (input_image); Grok's realtime voice doesn't document picture input, so it's a self-view.
    if (t.engine === 'grok') return { allowed: false, sees: false, message: 'Grok voice can’t look at pictures on calls, so your camera is only shown to you.' };
    return { allowed: true, sees: true, goesTo: 'OpenAI (the live call’s voice service)' };
  }
  if (t.error) return no(t.error);
  const name = t.model ?? t.provider?.label ?? 'This model';
  if (!t.sees) return { allowed: false, sees: false, message: '{model} can’t look at pictures (or the app can’t tell that it can), so your camera is only shown to you. Pick a model that can for “Looking at pictures” in Settings → Models & usage → Which model does what.', params: { model: name } };
  return { allowed: true, sees: true, goesTo: `${t.provider?.label ?? 'the model'} (${name})` };
}

/** Names of models known to look at pictures (when the provider can't say). */
const SEES_RE = /(gpt-4o|gpt-4\.1|gpt-5|\bo3\b|\bo4|claude-(3|sonnet|opus|haiku)|claude-.*-[45]|gemini|grok-4|grok-2-vision|grok-vision|llava|bakllava|moondream|minicpm-v|[-.:]vl\b|-vl[-:.]|vision|gemma[34]|qwen[23]\.?\d*-?vl|qwen3\.[5-9]|pixtral|mistral-small-?3|llama-?4|llama3\.2-vision|kimi-k2\.5|kimi-vl)/i;
/** Known text-only names win over the list above ("gpt-4o-mini-transcribe", embeddings). */
const BLIND_RE = /(embed|transcribe|whisper|tts|audio|realtime|instruct-text|coder(?!.*vl))/i;

export function modelSeesByName(model: string | undefined): boolean {
  if (!model) return false;
  return SEES_RE.test(model) && !BLIND_RE.test(model);
}

const seesCache = new Map<string, { at: number; sees: boolean | undefined }>();

/**
 * Asks an Ollama server whether a model takes pictures (its /api/tags lists `capabilities`, with
 * "vision" for models that do). Undefined when it can't be asked. Cached for ten minutes.
 */
export async function ollamaSees(baseUrl: string, model: string, now = Date.now(), fetchFn: typeof fetch = netFetch as typeof fetch): Promise<boolean | undefined> {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const key = `${root}|${model}`;
  const hit = seesCache.get(key);
  if (hit && now - hit.at < 10 * 60_000) return hit.sees;
  let sees: boolean | undefined;
  try {
    const res = await fetchFn(`${root}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = (await res.json()) as { models?: { name?: string; model?: string; capabilities?: string[] }[] };
      const want = model.includes(':') ? model : `${model}:latest`;
      const m = data.models?.find((x) => x.name === model || x.model === model || x.name === want || x.model === want);
      if (m && Array.isArray(m.capabilities)) sees = m.capabilities.includes('vision');
    }
  } catch {
    sees = undefined;
  }
  seesCache.set(key, { at: now, sees });
  return sees;
}

/** Does this provider's model take pictures? Ollama is asked; otherwise known model names. */
export async function modelSees(config: Pick<ProviderConfig, 'kind' | 'baseUrl'>, model: string, now = Date.now(), fetchFn?: typeof fetch): Promise<boolean> {
  // Subscription command-line agents (Claude Code, Grok CLI) get text only through Sara.
  if (config.kind === 'claude-code' || config.kind === 'grok-cli') return false;
  if (config.kind === 'openai-compatible' && /:11434\b|ollama/i.test(config.baseUrl)) {
    const asked = await ollamaSees(config.baseUrl, model, now, fetchFn);
    if (asked !== undefined) return asked;
  }
  return modelSeesByName(model);
}

/** One video call on the server: its limits and (classic calls) the newest picture, in memory only. */
export interface VideoSession {
  gate: FrameGate;
  startedAt: number;
  lastAt: number;
  /** Classic calls: the newest picture, taken with the next thing the owner says. */
  frame?: { data: Buffer; at: number; ask: boolean };
}

/** The video calls going on, by conversation. Nothing here is saved anywhere. */
export class VideoSessions {
  #s = new Map<string, VideoSession>();

  start(conversationId: string, settings: VideoSettings, now: number): VideoSession {
    this.#prune(now);
    const s: VideoSession = { gate: new FrameGate(settings), startedAt: now, lastAt: now };
    this.#s.set(conversationId, s);
    return s;
  }

  get(conversationId: string, now: number): VideoSession | undefined {
    this.#prune(now);
    return this.#s.get(conversationId);
  }

  end(conversationId: string): boolean {
    return this.#s.delete(conversationId);
  }

  /** Classic calls: keep the newest picture (replacing the one before). */
  keep(conversationId: string, data: Buffer, now: number, ask: boolean): void {
    const s = this.#s.get(conversationId);
    if (!s) return;
    s.frame = { data, at: now, ask };
    s.lastAt = now;
  }

  /**
   * Classic calls: the newest picture while it is fresh. It is not used up: with the camera on, every
   * message until the next picture goes with the current view (otherwise a second sentence a few
   * seconds later would reach her with no picture, and she'd say she can't see you while the screen
   * says she can). An old picture is forgotten.
   */
  take(conversationId: string, now: number): Buffer | undefined {
    const s = this.#s.get(conversationId);
    const f = s?.frame;
    if (!s || !f) return undefined;
    if (now - f.at > FRAME_FRESH_MS) {
      s.frame = undefined;
      return undefined;
    }
    return f.data;
  }

  /** Forgets every picture of a conversation (a safety block, the call ended). */
  drop(conversationId: string): void {
    const s = this.#s.get(conversationId);
    if (s) s.frame = undefined;
  }

  get size(): number {
    return this.#s.size;
  }

  #prune(now: number): void {
    for (const [id, s] of this.#s) if (now - s.lastAt > SESSION_IDLE_MS) this.#s.delete(id);
  }
}

/** The note that goes with a picture to the model (classic calls and live calls). */
export function frameNote(owner: string, ask: boolean): string {
  return ask
    ? `[Note from the app: on your video call, ${owner} turned their camera toward something and asked you to look. This is a still picture from their camera, just now. Say what you actually see; if it's unclear, say so.]`
    : `[Note from the app: on your video call, ${owner}'s camera is on. This is a still picture from it, just now. You don't have to mention it; react to it only if it fits, and never claim to see more than is in it.]`;
}

/** A classic video call without a picture this turn (camera off, or she can't see it). */
export function noFrameNote(owner: string): string {
  return `[Note from the app: this was said on a video call. ${owner} sees your animated picture, but no picture from their camera reached you, so you can't see them right now. If they ask, say so plainly (they can turn their camera on, if the model you run on can look at pictures).]`;
}

/** Added to her call instructions on a video call. */
export function videoCallNote(owner: string, sees: boolean): string {
  return `## On a video call
This is a video call: ${owner} sees your animated picture (your current look) while you talk. ${
    sees
      ? `If ${owner} turns their camera on, you get a still picture from it now and then, marked as coming from their camera. Only talk about what is really in a picture you were sent; if you haven't been sent one, you can't see them, so say so instead of guessing.`
      : `You can't see ${owner}'s camera on this call (no pictures reach you). If ${owner} asks whether you can see them, say honestly that you can't.`
  }`;
}
