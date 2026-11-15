// R5 (docs/PHONE_CALLS.md): phone calls in and out, ready but switched off. No number is bought by
// Sara: the owner brings a provider account (Twilio or a Twilio-compatible one), its number, and a
// public web address where the provider reaches this server. Until all of that is set AND the switch
// is on, every path explains what is missing and nothing calls anyone.
//
//  - Inbound: the provider's webhook asks how to answer. Callers on the allowlist (the owner's number,
//    the people listed on the page, the emergency contact from My details) talk with her in her own
//    voice (the existing speech stack: her hearing and her voice); everyone else is screened: she
//    takes a message and it lands in the chat (and a notification).
//  - Outbound: an errand's call step or "call X" in chat. Each call has its own approval card showing
//    the number, the script, the longest it may last and a cost estimate from the price the owner
//    typed in (no price lookups). Recording only with the setting on AND after a spoken consent line.
//  - On every call: "stop" (six languages) hangs up; the length is capped (also on the provider's
//    side with TimeLimit); the transcript and a short summary go to the errand or the chat.
//
// Audio: the provider's Media Stream (8 kHz μ-law frames) → 16 kHz WAV for her hearing; her voice
// (WAV or raw PCM) → μ-law frames back (src/phone-audio.ts). Speech turns are found by loudness.
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { cheapCall } from './cheap.ts';
import type { AppContext, ChatEvent } from './chat.ts';
import { en, trOwner } from './i18n.ts';
import { privateLocalOn } from './net-guard.ts';
import { phoneMayApprove } from './phone-actions.ts';
import { audioToUlaw, FRAME_BYTES, frameLevel, frames, ulawToWav } from './phone-audio.ts';
import { speechOf } from './speech.ts';
import { e164, PROVIDERS, sameNumber, TelephonyError, TwilioProvider, type CallInfo, type Credentials, type ProviderId, type TelephonyProvider } from './telephony.ts';
import type { WsConnection } from './ws.ts';

export const PHONE_VAULT = 'bridge:phone';
export const PHONE_LIMITS = { maxMinutesTop: 60, allowMax: 30, keep: 200, tokenMs: 120_000, transcriptKeep: 200 } as const;

export interface PhoneCallSettings {
  /** The off switch: nothing answers or calls while it is off (the default). */
  on: boolean;
  provider: ProviderId;
  /** Her number at the provider (E.164). */
  number: string;
  /** The owner's own phone: always gets through, and "call me" calls it. */
  ownerNumber: string;
  /** The https address where the provider reaches this server (a tunnel or reverse proxy). */
  publicUrl: string;
  /** People who get through to her (the rest leave a message). */
  allow: { name: string; number: string }[];
  /** Record calls (only after she says so on the call). Off by default. */
  record: boolean;
  /** Longest call, in minutes. */
  maxMinutes: number;
  /** The provider's price per minute in US dollars, as the owner typed it from their price list (for estimates only). */
  pricePerMinute: number | null;
  /** Twilio-compatible API base (another provider with the same API; tests use a fake). */
  apiBase: string;
}

export const DEFAULT_PHONE_CALLS: PhoneCallSettings = { on: false, provider: 'twilio', number: '', ownerNumber: '', publicUrl: '', allow: [], record: false, maxMinutes: 10, pricePerMinute: null, apiBase: 'https://api.twilio.com' };

/** What is missing, in plain words (English keys; the routes translate). */
export const PHONE_LINES = {
  off: en('Phone calls are switched off (Settings → Connections → Phone and notifications → Phone calls).'),
  creds: en('Add the phone provider’s account SID and auth token.'),
  number: en('Add her phone number (the number from your phone provider).'),
  url: en('Add the public https address where the provider reaches this server.'),
  voice: en('Her voice can’t make phone audio yet: use the voice on this server, an OpenAI-compatible speech API or ElevenLabs (Settings → Her → Voice).'),
  hearing: en('Turn on hearing (speech-to-text) in Settings → Her → Voice.'),
  sip: en('SIP and WebRTC are not built in yet: use a Twilio-compatible provider.'),
  privateLocal: en('Private local mode is on: phone calls go through an outside provider, so they are off.'),
  owner: en('Add your own number first.'),
  notNumber: en('That isn’t a phone number.'),
  busy: en('She is already on a call.'),
  notFound: en('Call not found.'),
} as const;

export class PhoneCallError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const clip = (s: unknown, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function phoneCallSettings(app: AppContext): PhoneCallSettings {
  const s = (app.settings.get() as { phoneCalls?: Partial<PhoneCallSettings> }).phoneCalls ?? {};
  return { ...DEFAULT_PHONE_CALLS, ...s, allow: Array.isArray(s.allow) ? s.allow : [] };
}

/** Checks the page's settings; throws a plain message. */
export function cleanPhoneSettings(input: Record<string, unknown>, cur: PhoneCallSettings): PhoneCallSettings {
  const num = (v: unknown, d: string) => {
    if (v === undefined) return d;
    const s = String(v ?? '').trim();
    if (!s) return '';
    const n = e164(s);
    if (!n) throw new PhoneCallError(400, PHONE_LINES.notNumber);
    return n;
  };
  let publicUrl = cur.publicUrl;
  if (input.publicUrl !== undefined) {
    publicUrl = String(input.publicUrl ?? '').trim().replace(/\/+$/, '');
    if (publicUrl && !/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/i.test(publicUrl)) throw new PhoneCallError(400, PHONE_LINES.url);
  }
  let apiBase = cur.apiBase;
  if (input.apiBase !== undefined) {
    apiBase = String(input.apiBase ?? '').trim().replace(/\/+$/, '') || DEFAULT_PHONE_CALLS.apiBase;
    if (!/^https:\/\//i.test(apiBase) && !/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(apiBase)) throw new PhoneCallError(400, en('The provider address must start with https://'));
  }
  const allow = Array.isArray(input.allow)
    ? (input.allow as { name?: unknown; number?: unknown }[])
        .slice(0, PHONE_LIMITS.allowMax)
        .map((p) => ({ name: clip(p?.name, 60), number: e164(String(p?.number ?? '')) }))
        .filter((p) => p.number)
    : cur.allow;
  const price = input.pricePerMinute === undefined ? cur.pricePerMinute : input.pricePerMinute === null || input.pricePerMinute === '' ? null : Number(input.pricePerMinute);
  return {
    on: input.on === undefined ? cur.on : input.on === true,
    provider: PROVIDERS.includes(input.provider as ProviderId) ? (input.provider as ProviderId) : cur.provider,
    number: num(input.number, cur.number),
    ownerNumber: num(input.ownerNumber, cur.ownerNumber),
    publicUrl,
    allow,
    record: input.record === undefined ? cur.record : input.record === true,
    maxMinutes: input.maxMinutes === undefined ? cur.maxMinutes : Math.min(PHONE_LIMITS.maxMinutesTop, Math.max(1, Math.round(Number(input.maxMinutes)) || cur.maxMinutes)),
    pricePerMinute: price === null || !Number.isFinite(price) || price < 0 ? null : Math.round(price * 10000) / 10000,
    apiBase,
  };
}

// ------------------------------------------------------------------ words heard on a call

/** "stop" / "hang up" said on its own (six languages): she hangs up. */
export const STOP_RE = /^\s*(?:please\s+)?(?:stop|hang up|end (?:the )?call|that'?s all|goodbye|bye(?: bye)?|para|basta|cuelga|termina la llamada|adi[oó]s|arr[eê]te|raccroche|au revoir|stopp|halt|leg auf|auf wiedersehen|tsch[uü]ss|pare|desliga|tchau|riattacca|chiudi|arrivederci|ciao)\s*[.!]*\s*$/i;
/** "approve" / "yes, do it" and "no" said on their own (six languages), for spoken approvals. */
const YES_RE = /^\s*(?:approve|approved|yes(?:,? do it)?|ok(?:ay)?,? do it|go ahead|allow( it)?|aprueba|apruebo|s[ií],? hazlo|adelante|approuve|j'approuve|oui,? vas-y|genehmigen|genehmigt|ja,? mach(?: es)?|aprovar|aprovo|sim,? pode|approva|approvo|s[iì],? fallo|vai)\s*[.!]*\s*$/i;
const NO_RE = /^\s*(?:decline|deny|no|don'?t|cancel|rechaza|no lo hagas|refuse|non|ablehnen|nein|recusar|n[aã]o|rifiuta|annulla)\s*[.!]*\s*$/i;
export function approvalWord(text: string): 'approve' | 'decline' | null {
  const s = String(text ?? '');
  if (YES_RE.test(s)) return 'approve';
  if (NO_RE.test(s)) return 'decline';
  return null;
}

// ------------------------------------------------------------------ a call's audio and turns

export interface CallVoice {
  hear(wav: Buffer): Promise<string>;
  say(text: string): Promise<{ data: Buffer; type: string }>;
}
export interface Line {
  who: 'her' | 'them';
  text: string;
  at: string;
}
export interface BrainReply {
  say: string;
  end?: boolean;
}
export type Brain = (heard: string, transcript: Line[]) => Promise<BrainReply>;

export interface SessionOptions {
  /** Said first (after the consent line, when recording). */
  opening: string;
  /** Recording: this line is said first; recording starts only after it played. */
  consent?: string;
  startRecording?: () => Promise<void>;
  brain: Brain;
  voice: CallVoice;
  /** Her audio frames, marks and barge-in to the line. */
  sendAudio: (ulaw: Buffer) => void;
  sendMark: (name: string) => void;
  sendClear: () => void;
  hangup: () => Promise<void>;
  maxMs: number;
  now: () => Date;
  goodbye: string;
  limitLine: string;
  /** Silence after her turn before she ends the call (in frames of 20 ms). */
  idleFrames?: number;
  onEnd: (why: 'stop' | 'brain' | 'limit' | 'idle' | 'hangup' | 'error', transcript: Line[]) => void;
}

/** Speech found by loudness: a few loud frames start a turn, 0.7 s of quiet ends it. */
const VOICE_LEVEL = 600;
const START_FRAMES = 3;
const END_FRAMES = 35;
const MAX_TURN_FRAMES = 750;

export class CallSession {
  readonly transcript: Line[] = [];
  readonly #o: SessionOptions;
  #buf: Buffer[] = [];
  #voiced = 0;
  #quiet = 0;
  #inTurn = false;
  #speaking = 0;
  #marks = 0;
  #idle = 0;
  #endAfter: string | null = null;
  #consentMark: string | null = null;
  #queue: Promise<void> = Promise.resolve();
  #ended = false;
  #limit: NodeJS.Timeout | undefined;
  #fallback: NodeJS.Timeout | undefined;
  #why: Parameters<SessionOptions['onEnd']>[0] = 'hangup';

  constructor(o: SessionOptions) {
    this.#o = o;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** The call connected: the consent line (when recording), then her opening. */
  begin(): Promise<void> {
    this.#limit = setTimeout(() => void this.#run(() => this.#finish('limit', this.#o.limitLine)), this.#o.maxMs);
    this.#limit.unref?.();
    return this.#run(async () => {
      if (this.#o.consent) this.#consentMark = await this.#say(this.#o.consent);
      await this.#say(this.#o.opening);
    });
  }

  #run(f: () => Promise<void>): Promise<void> {
    this.#queue = this.#queue.then(f).catch((err: Error) => {
      console.warn(`phone call: ${err.message}`);
      void this.end('error');
    });
    return this.#queue;
  }

  /** Says a line: her voice → μ-law frames → the line, then a mark (its name comes back once played). */
  async #say(text: string): Promise<string | null> {
    if (this.#ended || !text.trim()) return null;
    const audio = await this.#o.voice.say(text);
    const ulaw = audioToUlaw(audio);
    if (!ulaw) throw new Error('her voice made audio the phone line cannot play (MP3)');
    this.transcript.push({ who: 'her', text, at: this.#o.now().toISOString() });
    for (const f of frames(ulaw)) this.#o.sendAudio(f);
    const name = `m${++this.#marks}`;
    this.#speaking++;
    this.#o.sendMark(name);
    return name;
  }

  /** The provider played a line to its end. */
  marked(name: string): void {
    this.#speaking = Math.max(0, this.#speaking - 1);
    this.#idle = 0;
    if (name === this.#consentMark && this.#o.startRecording) {
      this.#consentMark = null;
      void this.#o.startRecording().catch((err: Error) => console.warn(`phone call recording: ${err.message}`));
    }
    if (this.#endAfter && name === this.#endAfter) void this.#hangup();
  }

  /** 20 ms of the caller's audio. */
  feed(frame: Buffer): void {
    if (this.#ended) return;
    const loud = frameLevel(frame.subarray(0, FRAME_BYTES)) > VOICE_LEVEL;
    if (!this.#inTurn) {
      this.#voiced = loud ? this.#voiced + 1 : 0;
      this.#buf.push(frame);
      if (this.#buf.length > START_FRAMES + 5) this.#buf.shift();
      if (this.#voiced >= START_FRAMES) {
        this.#inTurn = true;
        this.#quiet = 0;
        // Barge-in: the caller talks over her, so what she was still saying is dropped.
        if (this.#speaking) this.#o.sendClear();
      } else if (!this.#speaking && !this.#endAfter && this.#o.idleFrames && ++this.#idle >= this.#o.idleFrames) {
        this.#idle = 0;
        void this.#run(() => this.#finish('idle', this.#o.goodbye));
      }
      return;
    }
    this.#buf.push(frame);
    this.#quiet = loud ? 0 : this.#quiet + 1;
    if (this.#quiet >= END_FRAMES || this.#buf.length >= MAX_TURN_FRAMES) {
      const turn = Buffer.concat(this.#buf);
      this.#buf = [];
      this.#inTurn = false;
      this.#voiced = 0;
      this.#idle = 0;
      void this.#run(() => this.#heard(turn));
    }
  }

  async #heard(ulaw: Buffer): Promise<void> {
    if (this.#ended || this.#endAfter) return;
    const text = (await this.#o.voice.hear(ulawToWav(ulaw)).catch(() => '')).trim();
    if (!text) return;
    this.transcript.push({ who: 'them', text, at: this.#o.now().toISOString() });
    if (STOP_RE.test(text)) return this.#finish('stop', this.#o.goodbye);
    const r = await this.#o.brain(text, this.transcript);
    if (r.end) return this.#finish('brain', r.say || this.#o.goodbye);
    await this.#say(r.say);
  }

  /** Says a last line and hangs up once it played (or after 15 s at most). */
  async #finish(why: Parameters<SessionOptions['onEnd']>[0], line: string): Promise<void> {
    if (this.#ended || this.#endAfter) return;
    this.#why = why;
    clearTimeout(this.#limit);
    const mark = await this.#say(line).catch(() => null);
    if (!mark) return void this.#hangup();
    this.#endAfter = mark;
    this.#fallback = setTimeout(() => void this.#hangup(), 15_000);
    this.#fallback.unref?.();
  }

  async #hangup(): Promise<void> {
    if (this.#ended) return;
    await this.#o.hangup().catch((err: Error) => console.warn(`phone call hang-up: ${err.message}`));
    this.end(this.#why);
  }

  /** The call is over (the provider's stop, or after hanging up). */
  end(why: Parameters<SessionOptions['onEnd']>[0] = 'hangup'): void {
    if (this.#ended) return;
    this.#ended = true;
    clearTimeout(this.#limit);
    clearTimeout(this.#fallback);
    this.#o.onEnd(this.#endAfter ? this.#why : why, this.transcript);
  }
}

// ------------------------------------------------------------------ call records

export type CallMode = 'owner' | 'contact' | 'message' | 'outbound';
export type CallStatus = 'ringing' | 'live' | 'done' | 'missed' | 'failed';
export interface PhoneCall {
  id: number;
  providerId: string | null;
  direction: 'inbound' | 'outbound';
  number: string;
  name: string | null;
  mode: CallMode;
  status: CallStatus;
  errandId: number | null;
  conversationId: string | null;
  script: string | null;
  transcript: Line[];
  summary: string | null;
  recorded: boolean;
  seconds: number | null;
  estimate: number | null;
  createdAt: string;
  endedAt: string | null;
}

export interface PhoneCallsOptions {
  /** Tests: a fake provider (else Twilio with the vault's account). */
  provider?: (creds: Credentials, s: PhoneCallSettings) => TelephonyProvider;
  /** Tests: her hearing and voice (else the app's speech stack in phone format). */
  voice?: CallVoice;
  /** Tests: what she says to a caller who isn't the owner (else the quick model). */
  otherBrain?: (call: PhoneCall) => Brain;
  /** Tests: the owner's own calls (else a real turn in the call's chat). */
  ownerBrain?: (call: PhoneCall) => Brain;
  fetchImpl?: typeof fetch;
}

type Row = Record<string, string | number | null>;

export class PhoneCalls {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #o: PhoneCallsOptions;
  readonly #tokens = new Map<string, { id: number; exp: number }>();
  readonly #live = new Map<number, CallSession>();

  constructor(app: AppContext, db: DatabaseSync = app.store.db, o: PhoneCallsOptions = {}) {
    this.#app = app;
    this.#db = db;
    this.#o = o;
    db.exec(`CREATE TABLE IF NOT EXISTS phone_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT,
  direction TEXT NOT NULL,
  number TEXT NOT NULL,
  name TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  errand_id INTEGER,
  conversation_id TEXT,
  script TEXT,
  transcript_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  recorded INTEGER NOT NULL DEFAULT 0,
  seconds INTEGER,
  estimate REAL,
  created_at TEXT NOT NULL,
  ended_at TEXT
);`);
  }

  #T(text: string, params?: Record<string, unknown>): string {
    return trOwner(text, this.#app.settings.get(), params);
  }
  settings(): PhoneCallSettings {
    return phoneCallSettings(this.#app);
  }
  save(input: Record<string, unknown>): PhoneCallSettings {
    const next = cleanPhoneSettings(input, this.settings());
    this.#app.settings.update({ phoneCalls: next } as never);
    return next;
  }

  // ---------------------------------------------------------- credentials (vault)

  creds(): Credentials | undefined {
    const raw = this.#app.vault.get(PHONE_VAULT);
    if (!raw) return undefined;
    try {
      const c = JSON.parse(raw) as Partial<Credentials>;
      return c.sid && c.token ? { sid: String(c.sid), token: String(c.token) } : undefined;
    } catch {
      return undefined;
    }
  }
  setCreds(sid: string, token: string): void {
    const s = String(sid ?? '').trim();
    const t = String(token ?? '').trim();
    if (!/^[A-Za-z0-9]{10,64}$/.test(s) || t.length < 8 || t.length > 200) throw new PhoneCallError(400, PHONE_LINES.creds);
    this.#app.vault.set(PHONE_VAULT, JSON.stringify({ sid: s, token: t }));
  }
  clearCreds(): void {
    this.#app.vault.delete(PHONE_VAULT);
  }

  #provider(): TelephonyProvider | undefined {
    const c = this.creds();
    if (!c) return undefined;
    const s = this.settings();
    if (this.#o.provider) return this.#o.provider(c, s);
    if (s.provider !== 'twilio') return undefined;
    return new TwilioProvider({ creds: c, apiBase: s.apiBase, ...(this.#o.fetchImpl ? { fetchImpl: this.#o.fetchImpl } : {}) });
  }

  /** Her voice can make phone audio (WAV or PCM), and she can hear. */
  #voiceMissing(): string[] {
    if (this.#o.voice) return [];
    const v = speechOf(this.#app).settings();
    const out: string[] = [];
    if (!(v.tts === 'local' || v.tts === 'openai' || v.tts === 'elevenlabs')) out.push(PHONE_LINES.voice);
    if (v.stt === 'off') out.push(PHONE_LINES.hearing);
    return out;
  }

  /** Everything still missing (the switch last); `configured` = all but the switch. */
  status(): { on: boolean; ready: boolean; configured: boolean; missing: string[]; hasCreds: boolean; live: number } {
    const s = this.settings();
    const missing: string[] = [];
    if (s.provider === 'sip') missing.push(PHONE_LINES.sip);
    if (!this.creds()) missing.push(PHONE_LINES.creds);
    if (!s.number) missing.push(PHONE_LINES.number);
    if (!s.publicUrl) missing.push(PHONE_LINES.url);
    missing.push(...this.#voiceMissing());
    if (privateLocalOn()) missing.push(PHONE_LINES.privateLocal);
    const configured = missing.length === 0;
    if (!s.on) missing.push(PHONE_LINES.off);
    return { on: s.on, ready: configured && s.on && !this.#app.member && !this.#app.demo, configured, missing, hasCreds: Boolean(this.creds()), live: this.#live.size };
  }
  ready(): boolean {
    return this.status().ready;
  }
  /** What's missing, as one sentence in the owner's language. */
  missingText(): string {
    return this.status().missing.map((m) => this.#T(m)).join(' ');
  }

  /** "Up to $1.30 for 10 minutes (at your price of $0.13 a minute)", or a line saying there's no price. */
  estimate(minutes = this.settings().maxMinutes): { amount: number | null; line: string } {
    const p = this.settings().pricePerMinute;
    if (p === null) return { amount: null, line: this.#T(en('No cost estimate: add your provider’s price per minute on the Phone calls settings.')) };
    const amount = Math.round(p * minutes * 100) / 100;
    return { amount, line: this.#T(en('Up to {amount} for {minutes} minutes (at your price of {price} a minute).'), { amount: `$${amount.toFixed(2)}`, minutes, price: `$${p}` }) };
  }

  /** The approval card for one outbound call: number, script, length, cost, recording. */
  card(o: { to: string; name?: string; script: string }): string {
    const s = this.settings();
    const T = (x: string, p?: Record<string, unknown>) => this.#T(x, p);
    return [
      T(en('Call {who} at {number}'), { who: o.name || o.to, number: e164(o.to) || o.to }),
      `${T(en('She says:'))} “${clip(o.script, 600)}”`,
      this.estimate().line,
      s.record ? T(en('Recording: on, after she tells them the call is recorded.')) : T(en('Recording: off.')),
      T(en('Say “stop” on the call to hang up.')),
    ].join('\n');
  }

  // ---------------------------------------------------------- records

  #row(r: Row): PhoneCall {
    let transcript: Line[] = [];
    try {
      transcript = JSON.parse(String(r.transcript_json ?? '[]')) as Line[];
    } catch {
      /* keep empty */
    }
    return {
      id: Number(r.id),
      providerId: r.provider_id ? String(r.provider_id) : null,
      direction: r.direction === 'outbound' ? 'outbound' : 'inbound',
      number: String(r.number),
      name: r.name ? String(r.name) : null,
      mode: String(r.mode) as CallMode,
      status: String(r.status) as CallStatus,
      errandId: r.errand_id === null || r.errand_id === undefined ? null : Number(r.errand_id),
      conversationId: r.conversation_id ? String(r.conversation_id) : null,
      script: r.script ? String(r.script) : null,
      transcript,
      summary: r.summary ? String(r.summary) : null,
      recorded: Number(r.recorded) === 1,
      seconds: r.seconds === null || r.seconds === undefined ? null : Number(r.seconds),
      estimate: r.estimate === null || r.estimate === undefined ? null : Number(r.estimate),
      createdAt: String(r.created_at),
      endedAt: r.ended_at ? String(r.ended_at) : null,
    };
  }
  get(id: number): PhoneCall | undefined {
    const r = this.#db.prepare('SELECT * FROM phone_calls WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#row(r) : undefined;
  }
  byProviderId(pid: string): PhoneCall | undefined {
    const r = this.#db.prepare('SELECT * FROM phone_calls WHERE provider_id = ? ORDER BY id DESC LIMIT 1').get(pid) as Row | undefined;
    return r ? this.#row(r) : undefined;
  }
  list(limit = 50): PhoneCall[] {
    return (this.#db.prepare('SELECT * FROM phone_calls ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map((r) => this.#row(r));
  }
  #insert(c: Omit<PhoneCall, 'id' | 'transcript' | 'summary' | 'seconds' | 'endedAt' | 'createdAt'>): PhoneCall {
    const iso = this.#app.now().toISOString();
    const id = Number(
      this.#db
        .prepare('INSERT INTO phone_calls (provider_id, direction, number, name, mode, status, errand_id, conversation_id, script, recorded, estimate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(c.providerId, c.direction, c.number, c.name, c.mode, c.status, c.errandId, c.conversationId, c.script, c.recorded ? 1 : 0, c.estimate, iso).lastInsertRowid,
    );
    this.#db.prepare('DELETE FROM phone_calls WHERE id <= ?').run(id - PHONE_LIMITS.keep);
    return this.get(id)!;
  }
  #set(id: number, patch: Partial<{ provider_id: string; status: CallStatus; transcript_json: string; summary: string; seconds: number; ended_at: string; conversation_id: string }>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.#db.prepare(`UPDATE phone_calls SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...(Object.values(patch) as (string | number)[]), id);
  }
  #token(id: number): string {
    const now = this.#app.now().getTime();
    for (const [k, v] of this.#tokens) if (v.exp < now) this.#tokens.delete(k);
    const t = randomBytes(18).toString('base64url');
    this.#tokens.set(t, { id, exp: now + PHONE_LIMITS.tokenMs });
    return t;
  }

  #urls(): { voice: string; status: string; stream: string } {
    const base = this.settings().publicUrl;
    return { voice: `${base}/tel/twilio/voice`, status: `${base}/tel/twilio/status`, stream: `${base.replace(/^http/i, 'ws')}/tel/twilio/stream` };
  }

  // ---------------------------------------------------------- inbound: screening

  /** Who gets through to her: the owner, the people on the page, the emergency contact. */
  screen(from: string): { through: boolean; name: string | null } {
    const s = this.settings();
    if (s.ownerNumber && sameNumber(from, s.ownerNumber)) return { through: true, name: this.#app.settings.get().ownerName?.trim() || null };
    const p = s.allow.find((a) => sameNumber(from, a.number));
    if (p) return { through: true, name: p.name || null };
    try {
      const em = this.#app.myDetails?.get().emergency;
      if (em?.phone && sameNumber(from, em.phone)) return { through: true, name: em.name ?? null };
    } catch {
      /* no details */
    }
    return { through: false, name: null };
  }

  /**
   * The provider's webhooks (no sign-in: the signature is the key). `url` is the public URL the
   * provider called (what it signed). Returns the HTTP answer.
   */
  webhook(kind: 'voice' | 'status', url: string, params: Record<string, string>, signature: string | undefined): { status: number; type: string; body: string } {
    const provider = this.#provider();
    if (!provider || this.#app.member || this.#app.demo) return { status: 404, type: 'text/plain', body: 'Not found' };
    if (!provider.verify(url, params, signature)) return { status: 403, type: 'text/plain', body: 'Forbidden' };
    const info = provider.callInfo(params);
    if (kind === 'status') {
      this.#statusUpdate(info);
      return { status: 204, type: 'text/plain', body: '' };
    }
    // Inbound calls are answered only while everything is set up and switched on.
    if (!this.ready() || this.#live.size) return { status: 200, ...provider.reject() };
    const who = this.screen(info.from);
    // Only the owner's own number reaches her with tools; the people on the list talk with her (no
    // tools, nothing private) and anyone else is screened: she takes a message.
    const mode: CallMode = sameNumber(info.from, this.settings().ownerNumber) ? 'owner' : who.through ? 'contact' : 'message';
    const call = this.#insert({ providerId: info.callId, direction: 'inbound', number: e164(info.from) || info.from, name: who.name, mode, status: 'ringing', errandId: null, conversationId: null, script: null, recorded: false, estimate: null });
    return { status: 200, ...provider.answerWithStream(this.#urls().stream, { t: this.#token(call.id) }) };
  }

  #statusUpdate(info: CallInfo): void {
    const call = info.callId ? this.byProviderId(info.callId) : undefined;
    if (!call) return;
    const st = String(info.status ?? '');
    if (this.#live.has(call.id)) return; // the stream's own end writes the record
    if (call.status === 'done' || call.status === 'missed' || call.status === 'failed') {
      if (info.seconds !== undefined) this.#set(call.id, { seconds: info.seconds });
      return;
    }
    const status: CallStatus = st === 'completed' ? 'done' : st === 'no-answer' || st === 'busy' || st === 'canceled' ? 'missed' : st === 'failed' ? 'failed' : call.status;
    if (status === call.status) return;
    this.#set(call.id, { status, ended_at: this.#app.now().toISOString(), ...(info.seconds !== undefined ? { seconds: info.seconds } : {}) });
    this.#after(this.get(call.id)!);
  }

  // ---------------------------------------------------------- outbound

  /**
   * Places a call (after its approval card). Throws with what's missing when calls aren't ready.
   * `conversationId` is where the transcript and summary go (an errand's go to the errand).
   */
  async place(o: { to: string; name?: string; script: string; errandId?: number | null; conversationId?: string | null }): Promise<PhoneCall> {
    const st = this.status();
    if (!st.ready) throw new PhoneCallError(409, this.missingText());
    const to = e164(o.to);
    if (!to) throw new PhoneCallError(400, this.#T(PHONE_LINES.notNumber));
    if (this.#live.size || this.list(5).some((c) => c.status === 'ringing' || c.status === 'live')) throw new PhoneCallError(409, this.#T(PHONE_LINES.busy));
    const s = this.settings();
    const provider = this.#provider()!;
    const call = this.#insert({ providerId: null, direction: 'outbound', number: to, name: o.name ? clip(o.name, 80) : null, mode: to === s.ownerNumber ? 'owner' : 'outbound', status: 'ringing', errandId: o.errandId ?? null, conversationId: o.conversationId ?? null, script: clip(o.script, 1200), recorded: s.record, estimate: this.estimate().amount });
    try {
      const urls = this.#urls();
      const r = await provider.place({ to, from: s.number, streamUrl: urls.stream, params: { t: this.#token(call.id) }, statusUrl: urls.status, maxSeconds: s.maxMinutes * 60 });
      this.#set(call.id, { provider_id: r.callId });
    } catch (err) {
      this.#set(call.id, { status: 'failed', ended_at: this.#app.now().toISOString(), summary: clip((err as Error).message, 300) });
      this.#after(this.get(call.id)!);
      throw new PhoneCallError(err instanceof TelephonyError ? err.status : 502, (err as Error).message);
    }
    return this.get(call.id)!;
  }

  /** Hang up a live call (the page's Hang up). */
  async hangup(id: number): Promise<boolean> {
    const call = this.get(id);
    if (!call) throw new PhoneCallError(404, this.#T(PHONE_LINES.notFound));
    const provider = this.#provider();
    if (call.providerId && provider && (call.status === 'ringing' || call.status === 'live')) await provider.hangup(call.providerId).catch(() => undefined);
    this.#live.get(id)?.end('hangup');
    if (call.status === 'ringing') {
      this.#set(id, { status: 'missed', ended_at: this.#app.now().toISOString() });
      this.#after(this.get(id)!);
    }
    return true;
  }

  // ---------------------------------------------------------- the media stream

  /** A provider's Media Stream connected (WebSocket): the first message names the call by its one-time token. */
  attach(ws: WsConnection): void {
    const provider = this.#provider();
    if (!provider || !this.ready()) return ws.close(1008, 'off');
    let session: CallSession | undefined;
    let streamId = '';
    const timer = setTimeout(() => session || ws.close(1008, 'no start'), 10_000);
    timer.unref?.();
    ws.onMessage = (data) => {
      const ev = provider.parseStream(typeof data === 'string' ? data : data.toString('utf8'));
      if (ev.type === 'start') {
        if (session) return;
        const tok = this.#tokens.get(String(ev.params.t ?? ''));
        this.#tokens.delete(String(ev.params.t ?? ''));
        const call = tok && tok.exp >= this.#app.now().getTime() ? this.get(tok.id) : undefined;
        if (!call || (call.providerId && ev.callId && call.providerId !== ev.callId)) return ws.close(1008, 'unknown call');
        clearTimeout(timer);
        streamId = ev.streamId;
        session = this.#session(call, provider, {
          sendAudio: (f) => ws.open && ws.send(provider.audioMessage(streamId, f)),
          sendMark: (n) => ws.open && ws.send(provider.markMessage(streamId, n)),
          sendClear: () => ws.open && ws.send(provider.clearMessage(streamId)),
        });
        void session.begin();
      } else if (ev.type === 'media') session?.feed(ev.audio);
      else if (ev.type === 'mark') session?.marked(ev.name);
      else if (ev.type === 'stop') session?.end('hangup');
    };
    ws.onClose = () => {
      clearTimeout(timer);
      session?.end('hangup');
    };
  }

  #session(call: PhoneCall, provider: TelephonyProvider, io: Pick<SessionOptions, 'sendAudio' | 'sendMark' | 'sendClear'>): CallSession {
    const s = this.settings();
    const T = (x: string, p?: Record<string, unknown>) => this.#T(x, p);
    const her = this.#app.persona.name || 'Sara';
    const owner = this.#app.settings.get().ownerName?.trim() || T(en('the person I work for'));
    this.#set(call.id, { status: 'live' });
    const opening =
      call.mode === 'owner'
        ? T(en('Hi {owner}, it’s {her}. What can I do?'), { owner, her })
        : call.mode === 'contact'
          ? T(en('Hi {name}, it’s {her}, {owner}’s assistant. How can I help?'), { name: call.name || '', her, owner }).replace(/\s+,/, ',')
          : call.mode === 'message'
          ? T(en('Hi, this is {her}, {owner}’s assistant. {owner} can’t take the call right now. Who’s calling, and what is it about?'), { her, owner })
          : `${T(en('Hi, this is {her}, an AI assistant calling for {owner}.'), { her, owner })} ${call.script ?? ''}`.trim();
    const recording = s.record && call.direction === 'outbound' && call.mode !== 'owner';
    const session = new CallSession({
      opening,
      ...(recording && call.providerId ? { consent: T(en('Just so you know, this call is recorded.')), startRecording: () => provider.record(call.providerId!) } : {}),
      brain: call.mode === 'owner' ? (this.#o.ownerBrain?.(call) ?? this.#ownerBrain(call)) : (this.#o.otherBrain?.(call) ?? this.#otherBrain(call)),
      voice: this.#o.voice ?? this.#voice(),
      ...io,
      hangup: async () => {
        if (call.providerId) await provider.hangup(call.providerId);
      },
      maxMs: s.maxMinutes * 60_000,
      now: () => this.#app.now(),
      goodbye: T(en('Thank you, goodbye.')),
      limitLine: T(en('I have to hang up now: the call reached its time limit. Goodbye.')),
      idleFrames: 750,
      onEnd: (why, transcript) => void this.#ended(call.id, why, transcript),
    });
    this.#live.set(call.id, session);
    return session;
  }

  #voice(): CallVoice {
    const sp = speechOf(this.#app);
    return { hear: (wav) => sp.transcribe(wav), say: (text) => sp.speak(text, undefined, { phone: true }) };
  }

  /** The owner on the phone: a real turn in the call's chat (short spoken answers, approvals by voice). */
  #ownerBrain(call: PhoneCall): Brain {
    const app = this.#app;
    const T = (x: string, p?: Record<string, unknown>) => this.#T(x, p);
    let pending: Extract<ChatEvent, { type: 'approval' }> | null = null;
    let waiter: ((r: BrainReply) => void) | null = null;
    let said = '';
    let running = false;
    const conv = (): string => {
      const id = this.get(call.id)?.conversationId;
      if (id && app.store.getConversation(id)) return id;
      const c = app.store.createConversation({ title: T(en('Phone call')), channel: 'phone-call', channelKey: String(call.id) });
      this.#set(call.id, { conversation_id: c.id });
      return c.id;
    };
    const settle = (r: BrainReply) => {
      const w = waiter;
      waiter = null;
      w?.(r);
    };
    const start = (text: string) => {
      said = '';
      running = true;
      if (!app.runTracked) return settle({ say: T(en('I can’t do that on a call here.')) });
      void app
        .runTracked(conv(), text, (ev) => {
          if (ev.type === 'token') said += ev.text;
          if (ev.type === 'approval') {
            pending = ev;
            settle({ say: T(en('That needs your OK: {what}. Say approve or no.'), { what: clip(ev.summary.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ').replace(/[.:]+$/, ''), 160) }) });
          }
        }, { phoneCall: true })
        .catch((err: Error) => (said ||= err.message))
        .finally(() => {
          running = false;
          settle({ say: clip(said, 600) || T(en('Done.')) });
        });
    };
    return (heard) =>
      new Promise<BrainReply>((resolve) => {
        waiter = resolve;
        if (pending) {
          const w = approvalWord(heard);
          if (!w) return settle({ say: T(en('Say approve or no.')) });
          if (!phoneMayApprove(pending)) return settle({ say: T(en('That one needs you at the computer: approve it there.')) });
          app.approvals.decide(pending.approvalId, w === 'approve');
          pending = null;
          return; // the turn goes on; its end (or the next card) answers
        }
        if (running) return settle({ say: T(en('One moment, I’m still on it.')) });
        start(heard);
      });
  }

  /** Anyone else: a message-taker, or the errand's script on an outbound call (no tools, nothing private). */
  #otherBrain(call: PhoneCall): Brain {
    const app = this.#app;
    const T = (x: string, p?: Record<string, unknown>) => this.#T(x, p);
    const owner = app.settings.get().ownerName?.trim() || T(en('the person I work for'));
    if (call.mode === 'message') {
      let turns = 0;
      return async () => (++turns >= 2 ? { say: T(en('Thank you, I’ll pass it on. Goodbye.')), end: true } : { say: T(en('Thanks. Anything else for {owner}?'), { owner }) });
    }
    return async (_heard, transcript) => {
      const convId = this.get(call.id)?.conversationId;
      const conv = (convId && app.store.getConversation(convId)) || { id: '', private: false, channel: 'phone-call' };
      const r = await cheapCall(app, {
        source: 'phone-call',
        purpose: 'phone-call',
        conv: conv as never,
        model: 'quick',
        maxTokens: 160,
        cap: { runs: 200 },
        timeoutMs: 20_000,
        messages: [
          { role: 'system', content: `You are ${app.persona.name || 'Sara'}, an AI assistant on a phone call for ${owner}, with someone who is not ${owner}. ${call.mode === 'contact' ? `${call.name || 'Someone'} (a person ${owner} trusts) called; answer simply and take any message for ${owner}.` : `Why you called: ${call.script ?? ''}`}\nSpeak in one or two short sentences. Share nothing about ${owner} beyond what the call needs; never give card numbers, passwords or codes. When the matter is settled or they can't help, thank them and end with the word [END].` },
          ...transcript.slice(-20).map((l) => ({ role: l.who === 'her' ? ('assistant' as const) : ('user' as const), content: l.text })),
        ],
      });
      if (!r.ok) return { say: T(en('Thank you, I’ll let {owner} know. Goodbye.'), { owner }), end: true };
      const end = /\[END\]/i.test(r.text);
      return { say: r.text.replace(/\[END\]/gi, '').trim() || T(en('Thank you, goodbye.')), end };
    };
  }

  async #summary(call: PhoneCall, transcript: Line[]): Promise<string> {
    const theirs = transcript.filter((l) => l.who === 'them').map((l) => l.text);
    if (!theirs.length) return this.#T(en('Nobody said anything on the call.'));
    const fallback = `${this.#T(en('They said:'))} ${clip(theirs.join(' '), 400)}`;
    // A message is its own summary; the owner's own call is already in the call's chat, turn by turn.
    if (call.mode === 'message' || call.mode === 'owner') return fallback;
    const conv = (call.conversationId && this.#app.store.getConversation(call.conversationId)) || { id: '', private: false, channel: 'phone-call' };
    const r = await cheapCall(this.#app, {
      source: 'phone-call',
      purpose: 'phone-call-summary',
      conv: conv as never,
      model: 'quick',
      maxTokens: 200,
      cap: { runs: 200 },
      timeoutMs: 30_000,
      messages: [
        { role: 'system', content: 'Sum up this phone call in two or three plain sentences: what was agreed, any numbers, dates or reference numbers, and what is left to do. Only what the transcript says.' },
        { role: 'user', content: transcript.map((l) => `${l.who === 'her' ? 'Sara' : 'Them'}: ${l.text}`).join('\n').slice(0, 8000) },
      ],
    }).catch(() => undefined);
    return r?.ok && r.text ? clip(r.text, 600) : fallback;
  }

  async #ended(id: number, why: string, transcript: Line[]): Promise<void> {
    this.#live.delete(id);
    const call = this.get(id);
    if (!call) return;
    const now = this.#app.now();
    const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(call.createdAt)) / 1000));
    const summary = await this.#summary(call, transcript).catch(() => '');
    this.#set(id, { status: 'done', transcript_json: JSON.stringify(transcript.slice(-PHONE_LIMITS.transcriptKeep)), summary, seconds, ended_at: now.toISOString() });
    if (why === 'error') console.warn(`phone call ${id} ended after an error`);
    this.#after(this.get(id)!);
  }

  /** A call is over: its transcript and summary go to the errand, else the chat (and a notification). */
  #after(call: PhoneCall): void {
    const T = (x: string, p?: Record<string, unknown>) => this.#T(x, p);
    try {
      if (call.errandId !== null && this.#app.errands) {
        void this.#app.errands.callDone(call.errandId, call).catch((err: Error) => console.warn(`errand call: ${err.message}`));
        return;
      }
      const who = call.name ? `${call.name} (${call.number})` : call.number;
      const title =
        call.mode === 'message'
          ? T(en('Phone message from {who}'), { who })
          : call.status === 'missed'
            ? T(en('No answer at {who}'), { who })
            : call.status === 'failed'
              ? T(en('The call to {who} didn’t go through'), { who })
              : T(en('Phone call with {who}'), { who });
      const lines = call.transcript.map((l) => `${l.who === 'her' ? this.#app.persona.name || 'Sara' : T(en('Them'))}: ${l.text}`);
      const text = [title, call.summary ?? '', lines.length ? `\n${T(en('Transcript:'))}\n${lines.join('\n').slice(0, 3000)}` : ''].filter(Boolean).join('\n');
      let convId = call.conversationId && this.#app.store.getConversation(call.conversationId) ? call.conversationId : '';
      if (!convId) {
        convId = this.#app.store.createConversation({ title: T(en('Phone calls')), channel: 'phone-call', channelKey: `call-${call.id}` }).id;
        this.#set(call.id, { conversation_id: convId });
      }
      const msg = this.#app.store.addMessage(convId, 'assistant', text, { phoneCall: { id: call.id, status: call.status } });
      this.#app.events?.publish({ type: 'message', conversationId: convId, message: msg, reason: 'proactive' });
      if (call.mode === 'message' || call.direction === 'outbound') void this.#app.push?.notifyOwner(title, clip(call.summary ?? '', 300), convId, `call-${call.id}`).catch(() => undefined);
    } catch (err) {
      console.warn(`phone call record: ${(err as Error).message}`);
    }
  }

  stop(): void {
    for (const s of this.#live.values()) s.end('hangup');
    this.#live.clear();
  }
}

export function phoneCallsFor(app: AppContext): PhoneCalls {
  app.phoneCalls ??= new PhoneCalls(app, app.store.db);
  return app.phoneCalls;
}
