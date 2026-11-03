// Phase 72: smart-home presence through Home Assistant (the owner's own Home Assistant, the same
// address and token as her Home Assistant tools). Off by default, per companion. The owner picks
// the people/phones to watch (person.* or device_tracker.*) and what she reacts to:
//   arrived home · left home · bedtime (a switch or input_boolean turning on, or a time of day)
//   · lights on in the morning (a chosen light turning on inside a morning window).
// She reacts with one short line: a message on the owner's devices (a notification), an
// announcement on a chosen Home Assistant speaker (tts.speak), or both. Each kind of event fires
// at most once every few hours, never in the quiet hours of "Calls from her", and announcements
// carry the AI notice (every 3 hours). Home Assistant is polled once a minute (the bridge only has
// the REST API; no websocket client), only the chosen entities, and nothing is stored but the time
// each kind last fired. Household members have no Home Assistant in 2.0, so presence is the
// owner's only (docs/HOUSEHOLD.md).
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './fs-util.ts';
import { join } from 'node:path';
import { FOR_SPEAKER, spokenText } from './spoken.ts';
import { callRules, inQuietHours } from './calls.ts';
import { bondContext, type AppContext } from './chat.ts';
import { appLanguage, en, trOwner } from './i18n.ts';
import { complete } from './life.ts';
import { isGroupChannel } from './group.ts';
import { guard } from './log.ts';
import { netFetch } from './net-guard.ts';
import { buildSystemPrompt } from './persona.ts';
import { checkClaims } from './receipts.ts';
import { detectMinorSexualContent, disclosureDue, disclosureText, DISCLOSURE_INTERVAL_MS, isWorkChannel } from './safety.ts';
import type { Conversation } from './store.ts';
import { HOME_VAULT } from './tools/home.ts';
import { usageScope } from './usage.ts';

export type PresenceKind = 'arrive' | 'leave' | 'bedtime' | 'morning';
export const PRESENCE_KINDS: readonly PresenceKind[] = ['arrive', 'leave', 'bedtime', 'morning'];

export interface PresenceSettings {
  enabled: boolean;
  /** person.* or device_tracker.* entities (up to 10). */
  people: string[];
  arrive: boolean;
  leave: boolean;
  /** Bedtime: a switch / input_boolean turning on, or a time of day ("22:30"), or both. */
  bedtime: { on: boolean; entity?: string; time?: string };
  /** A light turning on between `from` and `to` (local time). */
  morning: { on: boolean; light?: string; from: string; to: string };
  /** How she reacts. */
  how: 'message' | 'speaker' | 'both';
  /** The speaker (media_player.*) and Home Assistant's text-to-speech entity (tts.*). */
  speaker?: { player: string; tts: string };
  /** Each kind of event at most once in this many hours. */
  gapHours: number;
}

export const DEFAULT_PRESENCE: PresenceSettings = {
  enabled: false,
  people: [],
  arrive: true,
  leave: false,
  bedtime: { on: false },
  morning: { on: false, from: '05:00', to: '11:00' },
  how: 'message',
  gapHours: 3,
};

const ENTITY = /^[a-z_]{1,40}\.[a-z0-9_]{1,120}$/;
const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;

export function presenceSettings(app: AppContext): PresenceSettings {
  const s = (app.settings.get().presence ?? {}) as Partial<PresenceSettings>;
  return { ...DEFAULT_PRESENCE, ...s, bedtime: { ...DEFAULT_PRESENCE.bedtime, ...s.bedtime }, morning: { ...DEFAULT_PRESENCE.morning, ...s.morning } };
}

/** Checks the owner's choices (Settings → Add-ons → Home Assistant → Presence). Throws plain words. */
export function cleanPresence(input: Record<string, unknown>, cur: PresenceSettings): PresenceSettings {
  const entity = (v: unknown, domains: string[], what: string): string | undefined => {
    const s = String(v ?? '').trim();
    if (!s) return undefined;
    if (!ENTITY.test(s) || !domains.includes(s.split('.')[0])) throw new Error(`${what} must be one of: ${domains.map((d) => `${d}.…`).join(', ')}.`);
    return s;
  };
  const time = (v: unknown, d: string | undefined, what: string): string | undefined => {
    if (v === undefined) return d;
    const s = String(v ?? '').trim();
    if (!s) return undefined;
    if (!TIME.test(s)) throw new Error(`${what} is a time like 22:30.`);
    return s.padStart(5, '0');
  };
  const people = input.people === undefined ? cur.people : (Array.isArray(input.people) ? input.people : String(input.people).split(/[\s,]+/)).map((x) => entity(x, ['person', 'device_tracker'], 'Each person')).filter((x): x is string => Boolean(x));
  if (people.length > 10) throw new Error('Up to 10 people or phones.');
  const b = (input.bedtime ?? {}) as Record<string, unknown>;
  const m = (input.morning ?? {}) as Record<string, unknown>;
  const sp = input.speaker === undefined ? cur.speaker : (input.speaker as Record<string, unknown> | null);
  const player = sp ? entity(sp.player, ['media_player'], 'The speaker') : undefined;
  const tts = sp ? entity(sp.tts, ['tts'], 'The voice') : undefined;
  const how = input.how === undefined ? cur.how : ['message', 'speaker', 'both'].includes(String(input.how)) ? (String(input.how) as PresenceSettings['how']) : cur.how;
  if (how !== 'message' && (!player || !tts)) throw new Error('Choose a speaker and a Home Assistant voice (tts) for announcements, or choose "A message".');
  const out: PresenceSettings = {
    enabled: input.enabled === undefined ? cur.enabled : input.enabled === true,
    people: [...new Set(people)],
    arrive: input.arrive === undefined ? cur.arrive : input.arrive === true,
    leave: input.leave === undefined ? cur.leave : input.leave === true,
    bedtime: {
      on: b.on === undefined ? cur.bedtime.on : b.on === true,
      ...(() => {
        const e = b.entity === undefined ? cur.bedtime.entity : entity(b.entity, ['input_boolean', 'switch', 'binary_sensor'], 'The bedtime switch');
        return e ? { entity: e } : {};
      })(),
      ...(() => {
        const t = time(b.time, cur.bedtime.time, 'Bedtime');
        return t ? { time: t } : {};
      })(),
    },
    morning: {
      on: m.on === undefined ? cur.morning.on : m.on === true,
      ...(() => {
        const l = m.light === undefined ? cur.morning.light : entity(m.light, ['light', 'switch'], 'The morning light');
        return l ? { light: l } : {};
      })(),
      from: time(m.from, cur.morning.from, 'The morning start') ?? DEFAULT_PRESENCE.morning.from,
      to: time(m.to, cur.morning.to, 'The morning end') ?? DEFAULT_PRESENCE.morning.to,
    },
    how,
    ...(player && tts ? { speaker: { player, tts } } : {}),
    gapHours: input.gapHours === undefined ? cur.gapHours : Math.min(12, Math.max(1, Math.round(Number(input.gapHours)) || cur.gapHours)),
  };
  if (out.bedtime.on && !out.bedtime.entity && !out.bedtime.time) throw new Error('For bedtime, choose a switch or a time.');
  if (out.morning.on && !out.morning.light) throw new Error('For the morning, choose a light.');
  if (out.enabled && (out.arrive || out.leave) && !out.people.length) throw new Error('Choose at least one person or phone to watch.');
  return out;
}

/** Conversations other apps and bridges talk in: her home notes never land there. */
const NOT_HERE = new Set(['api', 'mcp', 'home-assistant', 'alexa']);
/** Her own conversation with the owner (the newest ordinary one: not private, not another app's, not a group or partner chat). */
export function homeConversation(app: AppContext): Conversation | undefined {
  return app.store.listConversations().find((c) => c.mode === 'chat' && !c.partner && !c.private && !NOT_HERE.has(c.channel) && !isWorkChannel(c.channel) && !isGroupChannel(c.channel));
}

/** Minutes after midnight in the owner's time zone. */
function localMinutes(now: Date, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}
const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** Is minute `t` within [a, b) (wrapping past midnight)? */
const within = (t: number, a: number, b: number) => (a <= b ? t >= a && t < b : t >= a || t < b);

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PresenceOptions {
  fetchImpl?: FetchLike;
  /** Tests: her line without a model call. */
  write?: (kind: PresenceKind, forSpeaker: boolean) => Promise<string | undefined>;
}

export interface PresenceResult {
  kind: PresenceKind;
  fired: boolean;
  why?: string;
  text?: string;
}

interface PresenceFile {
  last: Partial<Record<PresenceKind, string>>;
  /** When the speaker last said she is an AI. */
  speakerToldAt?: string;
}

export class PresenceWorker {
  readonly #app: AppContext;
  readonly #fetch: FetchLike;
  readonly #write?: PresenceOptions['write'];
  /** Last state seen per entity (memory only; the first look only learns). */
  readonly #seen = new Map<string, string>();
  #lastMinute: number | undefined;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  /** What happened lately (Settings shows it). */
  readonly log: { at: string; kind: PresenceKind; fired: boolean; why?: string }[] = [];

  constructor(app: AppContext, o: PresenceOptions = {}) {
    this.#app = app;
    this.#fetch = o.fetchImpl ?? netFetch;
    if (o.write) this.#write = o.write;
  }

  start(intervalMs = 60_000): void {
    this.#timer = setInterval(() => guard('presence', () => this.tick()), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #file(): string {
    return join(this.#app.dataDir, 'presence.json');
  }
  #read(): PresenceFile {
    try {
      return existsSync(this.#file()) ? (JSON.parse(readFileSync(this.#file(), 'utf8')) as PresenceFile) : { last: {} };
    } catch {
      return { last: {} };
    }
  }
  #save(f: PresenceFile): void {
    writeFileAtomic(this.#file(), JSON.stringify(f), 0o600);
  }

  async #ha<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const base = this.#app.settings.get().home?.url;
    const token = this.#app.vault.get(HOME_VAULT);
    if (!base || !token) throw new Error('Home Assistant is not connected.');
    const res = await this.#fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Home Assistant said ${res.status}.`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** The entities this companion watches. */
  #watched(p: PresenceSettings): string[] {
    const out = new Set<string>();
    if (p.arrive || p.leave || p.bedtime.time) for (const e of p.people) out.add(e);
    if (p.bedtime.on && p.bedtime.entity) out.add(p.bedtime.entity);
    if (p.morning.on && p.morning.light) out.add(p.morning.light);
    return [...out];
  }

  /** One look at Home Assistant; returns what fired (or was held back). */
  async tick(): Promise<PresenceResult[]> {
    const p = presenceSettings(this.#app);
    if (!p.enabled || this.#running) return [];
    this.#running = true;
    try {
      const now = this.#app.now();
      const states = new Map<string, string>();
      for (const id of this.#watched(p)) {
        const st = await this.#ha<{ state?: string }>(`/api/states/${id}`).catch(() => undefined);
        if (st?.state !== undefined) states.set(id, String(st.state));
      }
      const events: PresenceKind[] = [];
      const was = (id: string) => this.#seen.get(id);
      const known = (v: string | undefined) => v !== undefined && v !== 'unavailable' && v !== 'unknown';
      for (const id of p.people) {
        const before = was(id);
        const after = states.get(id);
        if (!known(before) || !known(after) || before === after) continue;
        if (p.arrive && after === 'home') events.push('arrive');
        if (p.leave && before === 'home') events.push('leave');
      }
      if (p.bedtime.on && p.bedtime.entity) {
        if (was(p.bedtime.entity) === 'off' && states.get(p.bedtime.entity) === 'on') events.push('bedtime');
      }
      const tz = this.#app.settings.get().timeZone;
      const minute = localMinutes(now, tz);
      if (p.bedtime.on && p.bedtime.time && this.#lastMinute !== undefined) {
        const t = mins(p.bedtime.time);
        const crossed = this.#lastMinute <= minute ? this.#lastMinute < t && t <= minute : this.#lastMinute < t || t <= minute;
        // Only when someone is home (or no one is watched).
        const someoneHome = !p.people.length || p.people.some((id) => states.get(id) === 'home');
        if (crossed && someoneHome) events.push('bedtime');
      }
      if (p.morning.on && p.morning.light) {
        const l = p.morning.light;
        if (was(l) === 'off' && states.get(l) === 'on' && within(minute, mins(p.morning.from), mins(p.morning.to))) events.push('morning');
      }
      for (const [k, v] of states) this.#seen.set(k, v);
      this.#lastMinute = minute;
      const out: PresenceResult[] = [];
      for (const kind of [...new Set(events)]) out.push(await this.fire(kind, p));
      return out;
    } finally {
      this.#running = false;
    }
  }

  /** She reacts to one event, if the rate limit and quiet hours allow it (`test` skips both). */
  async fire(kind: PresenceKind, p: PresenceSettings = presenceSettings(this.#app), test = false): Promise<PresenceResult> {
    const app = this.#app;
    const now = app.now();
    const f = this.#read();
    const note = (r: PresenceResult) => {
      this.log.unshift({ at: now.toISOString(), kind, fired: r.fired, ...(r.why ? { why: r.why } : {}) });
      this.log.length = Math.min(this.log.length, 20);
      return r;
    };
    if (!test) {
      const last = f.last[kind] ? Date.parse(f.last[kind]!) : 0;
      if (now.getTime() - last < p.gapHours * 3_600_000) return note({ kind, fired: false, why: 'rate limit' });
      if (inQuietHours(callRules(app), now, app.settings.get().timeZone)) return note({ kind, fired: false, why: 'quiet hours' });
    }
    const speaker = p.how !== 'message' && p.speaker ? p.speaker : undefined;
    const message = p.how !== 'speaker' || !speaker;
    const conv = homeConversation(app);
    if (message && !conv) return note({ kind, fired: false, why: 'no conversation yet' });
    let text = (await usageScope.run({ purpose: 'presence' }, () => (this.#write ?? ((k, s) => this.#compose(k, s)))(kind, Boolean(speaker))).catch(() => undefined))?.trim();
    // The same honesty and safety rules as any line she sends: else a plain greeting.
    if (!text || text.length > 300 || /^skip\b/i.test(text) || checkClaims(text, []).length || detectMinorSexualContent(text, { fromHer: true })) text = trOwner(FALLBACK[kind], app.settings.get());
    f.last[kind] = now.toISOString();
    if (message && conv) {
      if (disclosureDue(app.store.lastDisclosureAt(), now)) {
        const d = disclosureText(app.persona.name, appLanguage(app.settings.get()));
        const n = app.store.addMessage(conv.id, 'notice', `disclosure:${d}`);
        app.events?.publish({ type: 'message', conversationId: conv.id, message: { ...n, content: d, meta: { kind: 'disclosure' } }, reason: 'proactive' });
      }
      const msg = app.store.addMessage(conv.id, 'assistant', app.redactor.redact(text), { presence: { kind } });
      app.events?.publish({ type: 'message', conversationId: conv.id, message: msg, reason: 'proactive' });
    }
    if (speaker) {
      // A speaker in a room: the AI notice first, every 3 hours.
      const told = f.speakerToldAt ? Date.parse(f.speakerToldAt) : 0;
      const intro = now.getTime() - told >= DISCLOSURE_INTERVAL_MS ? `${disclosureText(app.persona.name, appLanguage(app.settings.get())).split(/(?<=[.!?。])\s/)[0]} ` : '';
      try {
        await this.#ha('/api/services/tts/speak', { method: 'POST', body: { entity_id: speaker.tts, media_player_entity_id: speaker.player, message: spokenText(`${intro}${text}`, { ...FOR_SPEAKER, max: 400 }) } });
        if (intro) f.speakerToldAt = now.toISOString();
      } catch (err) {
        this.#save(f);
        return note({ kind, fired: Boolean(message), why: `speaker: ${(err as Error).message}`, text });
      }
    }
    this.#save(f);
    return note({ kind, fired: true, text });
  }

  /** Her one line for the event (the quick model, her character, short). */
  async #compose(kind: PresenceKind, forSpeaker: boolean): Promise<string | undefined> {
    const app = this.#app;
    const conv = homeConversation(app) ?? app.store.listConversations()[0];
    if (!conv) return undefined;
    const s = app.settings.get();
    const owner = s.ownerName?.trim() || 'the owner';
    const system = buildSystemPrompt(app.persona, { now: app.now(), timeZone: s.timeZone, ownerName: s.ownerName, ...bondContext(app) });
    const what = { arrive: `${owner} just got home`, leave: `${owner} just left home`, bedtime: `it's ${owner}'s bedtime`, morning: `${owner} just switched the lights on this morning` }[kind];
    const room = forSpeaker ? ' It will be read aloud by a speaker in their home, where others may hear: keep it non-sexual, leave private details out, no emoji.' : '';
    const note = `[Note from the app, not from ${owner}: Home Assistant says ${what}. Write the one short line you'd say right now (one sentence, at most 20 words), warm and natural, in your own voice. Don't mention Home Assistant, sensors or this note.${room} Write only the line.]`;
    return complete(app, conv, [{ role: 'system', content: system }, { role: 'user', content: note }], 80, 'quick');
  }
}

/** Plain lines when her model can't be reached (the owner's language through trOwner). */
const FALLBACK: Record<PresenceKind, string> = {
  arrive: en('Welcome home!'),
  leave: en('Have a good time out there.'),
  bedtime: en("It's getting late. Sleep well."),
  morning: en('Good morning! The lights are on, the day can start.'),
};
