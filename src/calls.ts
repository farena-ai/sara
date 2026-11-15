// Phase 26: Sara calls you. A "ring" goes to every place the owner is signed in (the web app, the
// Android app over its instant connection, the iPhone app through a VoIP push), and the first one to
// answer opens a live call in which she says why she called. Nobody answers: she leaves a message
// (and a voice note where her voice can make one) instead.
//
// The owner decides what may call: reminders (all, or only the ones asked as "call me"), long tasks
// finishing, the morning briefing; quiet hours and a daily limit apply to all of them except a call
// the owner asked for at a set time. One ring at a time, and never during a call.
import type { AppContext } from './chat.ts';
import { localDate } from './memory-worker.ts';

export type CallEventRule = 'call' | 'message';

export interface CallRules {
  /** Master switch: off means she never rings. */
  enabled: boolean;
  /** 'asked': only reminders set as "call me"; 'call': every reminder; 'message': never. */
  reminders: 'asked' | 'call' | 'message';
  /** A long task (job) finishing. */
  jobs: CallEventRule;
  /** The morning briefing. */
  briefing: CallEventRule;
  /** Quiet hours in the owner's time zone ("22:00" to "08:00"); empty strings switch them off. */
  quietStart: string;
  quietEnd: string;
  /** Rings per day at most (answered or not). */
  maxPerDay: number;
  /** How long it rings before it counts as missed. */
  ringSeconds: number;
}

export const DEFAULT_CALL_RULES: CallRules = {
  enabled: false,
  reminders: 'asked',
  jobs: 'message',
  briefing: 'message',
  quietStart: '22:00',
  quietEnd: '08:00',
  maxPerDay: 5,
  ringSeconds: 45,
};

export type RingKind = 'reminder' | 'scheduled' | 'job' | 'briefing' | 'test';
export type RingState = 'ringing' | 'answered' | 'missed' | 'declined' | 'cancelled';

export interface Ring {
  id: string;
  kind: RingKind;
  /** Why she's calling, in a few words ("Reminder: call the dentist"). Shown and said first. */
  reason: string;
  /** What she should cover on the call, beyond the reason (e.g. the briefing text). */
  brief?: string;
  conversationId: string;
  state: RingState;
  createdAt: string;
  expiresAt: string;
  /** Who answered (device label), once answered. */
  answeredBy?: string;
}

/** Turns a time like "22:00" into minutes after midnight, or undefined. */
function minutes(hhmm: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : undefined;
}

/** Minutes after midnight, now, in the owner's time zone. */
function localMinutes(now: Date, timeZone?: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }).formatToParts(now);
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes(); // a zone this Node doesn't know: UTC, like localDate
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

export function inQuietHours(rules: CallRules, now: Date, timeZone?: string): boolean {
  const a = minutes(rules.quietStart);
  const b = minutes(rules.quietEnd);
  if (a === undefined || b === undefined || a === b) return false;
  const t = localMinutes(now, timeZone);
  return a < b ? t >= a && t < b : t >= a || t < b;
}

export function callRules(app: AppContext): CallRules {
  const s = (app.settings.get() as { calls?: Partial<CallRules> }).calls ?? {};
  return { ...DEFAULT_CALL_RULES, ...s };
}

/** Checks a rules object from the owner (Settings → Calls from her); throws a plain message. */
export function cleanCallRules(input: Record<string, unknown>, cur: CallRules): CallRules {
  const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => {
    if (v === undefined) return d;
    if (allowed.includes(v as T)) return v as T;
    throw new Error(`Invalid value "${String(v)}"`);
  };
  const time = (v: unknown, d: string) => {
    if (v === undefined) return d;
    const s = String(v).trim();
    if (s && minutes(s) === undefined) throw new Error('Quiet hours are times like 22:00.');
    return s;
  };
  const num = (v: unknown, d: number, lo: number, hi: number) => (v === undefined ? d : Math.min(hi, Math.max(lo, Math.round(Number(v)) || d)));
  return {
    enabled: input.enabled === undefined ? cur.enabled : input.enabled === true,
    reminders: pick(input.reminders, ['asked', 'call', 'message'] as const, cur.reminders),
    jobs: pick(input.jobs, ['call', 'message'] as const, cur.jobs),
    briefing: pick(input.briefing, ['call', 'message'] as const, cur.briefing),
    quietStart: time(input.quietStart, cur.quietStart),
    quietEnd: time(input.quietEnd, cur.quietEnd),
    maxPerDay: num(input.maxPerDay, cur.maxPerDay, 1, 20),
    ringSeconds: num(input.ringSeconds, cur.ringSeconds, 15, 120),
  };
}

export interface CallBrokerOptions {
  now?: () => Date;
  newId?: () => string;
  /** Extra ways to ring (iPhone VoIP push, a real phone number); each gets every ring. */
  ringers?: ((ring: Ring) => void | Promise<void>)[];
  /** Is a live call going on right now? Then she doesn't ring. */
  inCall?: () => boolean;
  /** Can her voice speak the missed-call message? (Then the app shows it with a play button.) */
  canSpeak?: () => boolean;
  /** Can a live call connect at all (Grok voice set up)? If not she sends messages instead. */
  canCall?: () => boolean;
}

export type RingOutcome = { ring: Ring } | { skipped: string };

export class CallBroker {
  readonly #app: AppContext;
  readonly #o: CallBrokerOptions;
  #ring: Ring | undefined;
  #timer: NodeJS.Timeout | undefined;
  /** Rings per local day (resets on restart, which only ever allows more, never fewer). */
  #today = { day: '', count: 0 };
  readonly ringers: ((ring: Ring) => void | Promise<void>)[];
  #inCall: () => boolean;

  constructor(app: AppContext, opts: CallBrokerOptions = {}) {
    this.#app = app;
    this.#o = opts;
    this.ringers = [...(opts.ringers ?? [])];
    this.#inCall = opts.inCall ?? (() => false);
  }

  /** Set by the server: is a live call going on? */
  setInCall(fn: () => boolean): void {
    this.#inCall = fn;
  }

  #now(): Date {
    return this.#o.now?.() ?? this.#app.now();
  }

  get current(): Ring | undefined {
    return this.#ring?.state === 'ringing' ? { ...this.#ring } : undefined;
  }

  /** Whether an event of this kind should ring (rules only; the caller falls back to a message). */
  wants(kind: RingKind, asked = false): boolean {
    const r = callRules(this.#app);
    if (!r.enabled) return false;
    if (this.#o.canCall && !this.#o.canCall()) return false;
    if (kind === 'test' || kind === 'scheduled') return true;
    if (kind === 'reminder') return r.reminders === 'call' || (r.reminders === 'asked' && asked);
    if (kind === 'job') return r.jobs === 'call';
    if (kind === 'briefing') return r.briefing === 'call';
    return false;
  }

  /**
   * Rings, if the rules allow it now. `kind: 'scheduled'` (a call the owner asked for at a set
   * time) and 'test' skip quiet hours; every kind counts toward the daily limit except 'test'.
   */
  ring(input: { kind: RingKind; reason: string; brief?: string; conversationId: string }): RingOutcome {
    const rules = callRules(this.#app);
    const now = this.#now();
    const tz = this.#app.settings.get().timeZone;
    if (input.kind !== 'test' && !rules.enabled) return { skipped: 'Calls from her are off.' };
    if (this.#o.canCall && !this.#o.canCall()) return { skipped: 'Calls need Grok voice: sign in to Grok (Settings → Models & usage → Providers and plans → Subscriptions) or add an xAI key (Settings → Voice).' };
    if (this.#ring?.state === 'ringing') return { skipped: 'She is already ringing.' };
    if (this.#inCall()) return { skipped: 'You are on a call.' };
    if (input.kind !== 'test' && input.kind !== 'scheduled' && inQuietHours(rules, now, tz)) return { skipped: 'Quiet hours.' };
    const day = localDate(now, tz);
    if (this.#today.day !== day) this.#today = { day, count: 0 };
    if (input.kind !== 'test' && this.#today.count >= rules.maxPerDay) return { skipped: `She already called ${rules.maxPerDay} times today.` };
    if (input.kind !== 'test') this.#today.count++;
    const ring: Ring = {
      id: this.#o.newId?.() ?? crypto.randomUUID(),
      kind: input.kind,
      reason: input.reason.trim().slice(0, 300),
      ...(input.brief ? { brief: input.brief.slice(0, 4000) } : {}),
      conversationId: input.conversationId,
      state: 'ringing',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + rules.ringSeconds * 1000).toISOString(),
    };
    this.#ring = ring;
    this.#publish();
    for (const r of this.ringers) void Promise.resolve(r({ ...ring })).catch(() => {});
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#missed(ring.id), rules.ringSeconds * 1000);
    this.#timer.unref?.();
    return { ring: { ...ring } };
  }

  /** The first device to answer gets the call; the others stop ringing. */
  answer(id: string, by = 'a device'): Ring | undefined {
    const r = this.#ring;
    if (!r || r.id !== id || r.state !== 'ringing') return undefined;
    clearTimeout(this.#timer);
    r.state = 'answered';
    r.answeredBy = by;
    this.#app.store.addMessage(r.conversationId, 'notice', `call:${r.reason}`, { call: { id: r.id, kind: r.kind, state: 'answered' } });
    this.#publish();
    return { ...r };
  }

  /** Declined: she sends it as a message instead. */
  decline(id: string): Ring | undefined {
    const r = this.#ring;
    if (!r || r.id !== id || r.state !== 'ringing') return undefined;
    clearTimeout(this.#timer);
    r.state = 'declined';
    this.#publish();
    this.#leaveMessage(r, `${r.reason}`);
    return { ...r };
  }

  /** Stops a ring without a message (e.g. the owner cancelled a test call). */
  cancel(id: string): boolean {
    const r = this.#ring;
    if (!r || r.id !== id || r.state !== 'ringing') return false;
    clearTimeout(this.#timer);
    r.state = 'cancelled';
    this.#publish();
    return true;
  }

  #missed(id: string): void {
    const r = this.#ring;
    if (!r || r.id !== id || r.state !== 'ringing') return;
    r.state = 'missed';
    this.#publish();
    this.#leaveMessage(r, `I tried to call you. ${r.reason}`);
  }

  #leaveMessage(r: Ring, text: string): void {
    if (r.kind === 'test') return;
    const { store } = this.#app;
    const meta: Record<string, unknown> = { call: { id: r.id, kind: r.kind, state: r.state }, ...(r.kind === 'reminder' || r.kind === 'scheduled' ? { reminder: { ring: r.id } } : {}) };
    if (this.#o.canSpeak?.()) meta.voiceNote = true;
    if (!store.getConversation(r.conversationId)) return;
    const msg = store.addMessage(r.conversationId, 'assistant', text, meta);
    this.#app.events?.publish({ type: 'message', conversationId: r.conversationId, message: msg, reason: r.kind === 'reminder' || r.kind === 'scheduled' ? 'reminder' : 'proactive' });
  }

  #publish(): void {
    const r = this.#ring;
    if (r) this.#app.events?.publish({ type: 'ring', ring: { ...r } });
  }

  stop(): void {
    clearTimeout(this.#timer);
  }
}

/** What she's told at the start of a call she placed. */
export function openingNote(ring: Ring, owner: string): string {
  return [
    `[You just called ${owner} and they picked up. Why you called: ${ring.reason}.`,
    ring.brief ? `What to go over:\n${ring.brief}\n` : '',
    'Greet them briefly by name, say why you called in a sentence or two, then talk with them. Keep it natural and short, like a phone call.]',
  ]
    .filter(Boolean)
    .join(' ');
}
