// R6 (docs/WORK_APPS.md): a public booking page per person, /book/<slug>. Off until the person turns
// it on (Settings → You → Business details → Booking page). They set weekly availability windows, the
// meeting length, a buffer, a daily maximum, how far ahead and how much notice. Free time comes from
// their connected calendars (Google, Outlook / Microsoft 365) and their planner, minus the requests
// already made here. A visitor picks a slot and leaves a name, email and note; with "ask me" the
// person confirms it first (Settings, or the push notice), with "auto" it is confirmed at once. A
// confirmed booking becomes a calendar event and the visitor gets a confirmation email from the
// person's own mailbox. Each space's own (a household member's page is theirs); never the demo.
import { createHmac, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../chat.ts';
import { rawEmail } from '../google.ts';
import { en } from '../i18n.ts';
import { zonedParts, zonedToUtc } from '../planner.ts';

export interface BookingWindow {
  /** 0 = Sunday … 6 = Saturday */
  day: number;
  /** HH:MM, local time */
  start: string;
  end: string;
}
export interface BookingSettings {
  on: boolean;
  slug: string;
  title: string;
  /** Minutes */
  duration: number;
  /** Minutes kept free before and after every meeting */
  buffer: number;
  maxPerDay: number;
  windows: BookingWindow[];
  approval: 'auto' | 'ask';
  daysAhead: number;
  minNoticeHours: number;
  /** A line for visitors on the page (where, how). */
  note: string;
  /** Which calendar gets the events: 'google', a Microsoft account id, or '' (the first one connected). */
  calendar: string;
}
export const DEFAULT_BOOKING: BookingSettings = {
  on: false,
  slug: '',
  title: 'Meeting',
  duration: 30,
  buffer: 10,
  maxPerDay: 4,
  windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' })),
  approval: 'ask',
  daysAhead: 14,
  minNoticeHours: 4,
  note: '',
  calendar: '',
};
export const DURATIONS = [15, 20, 30, 45, 60, 90] as const;
export type RequestStatus = 'pending' | 'confirmed' | 'declined';
export interface BookingRequest {
  id: number;
  start: string;
  end: string;
  name: string;
  email: string;
  note: string;
  status: RequestStatus;
  eventId: string | null;
  /** What happened with the calendar and the email (shown to the person). */
  outcome: string;
  createdAt: string;
}
export interface Busy {
  start: Date;
  end: Date;
  /** A request made on this page (counts toward the daily maximum). */
  booking?: boolean;
}

export class BookingError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const int = (v: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : d);
const clean = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
export const slugify = (v: unknown): string =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
export const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;

/** Every free start time: windows in the person's time zone, cut by busy time ± the buffer. */
export function freeSlots(s: BookingSettings, busy: Busy[], now: Date, tz?: string): Date[] {
  const out: Date[] = [];
  const dur = s.duration * 60_000;
  const buf = s.buffer * 60_000;
  const earliest = now.getTime() + s.minNoticeHours * 3600_000;
  const today = zonedParts(now, tz);
  for (let i = 0; i < s.daysAhead; i++) {
    const day = new Date(Date.UTC(today.y, today.mo - 1, today.d + i, 12));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const dayStart = zonedToUtc(y, mo, d, 0, 0, tz).getTime();
    const dayEnd = zonedToUtc(y, mo, d + 1, 0, 0, tz).getTime();
    let count = busy.filter((b) => b.booking && b.start.getTime() >= dayStart && b.start.getTime() < dayEnd).length;
    const windows = s.windows.filter((w) => w.day === day.getUTCDay()).sort((a, b) => mins(a.start) - mins(b.start));
    for (const w of windows) {
      const ws = zonedToUtc(y, mo, d, Number(w.start.slice(0, 2)), Number(w.start.slice(3, 5)), tz).getTime();
      const we = zonedToUtc(y, mo, d, Number(w.end.slice(0, 2)), Number(w.end.slice(3, 5)), tz).getTime();
      let t = ws;
      while (t + dur <= we && count < s.maxPerDay) {
        if (t < earliest) {
          t = Math.max(t + 15 * 60_000, Math.ceil(earliest / (15 * 60_000)) * 15 * 60_000);
          continue;
        }
        const clash = busy.filter((b) => t < b.end.getTime() + buf && t + dur + buf > b.start.getTime());
        if (clash.length) {
          t = Math.max(...clash.map((b) => b.end.getTime() + buf));
          continue;
        }
        out.push(new Date(t));
        count++;
        t += dur + buf;
      }
    }
  }
  return out;
}

type Row = Record<string, unknown>;
const toRequest = (r: Row): BookingRequest => ({
  id: Number(r.id),
  start: String(r.start),
  end: String(r.end_at),
  name: String(r.name),
  email: String(r.email),
  note: String(r.note ?? ''),
  status: String(r.status) as RequestStatus,
  eventId: r.event_id === null || r.event_id === undefined ? null : String(r.event_id),
  outcome: String(r.outcome ?? ''),
  createdAt: String(r.created_at),
});

export class BookingStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS booking_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS booking_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, start TEXT NOT NULL, end_at TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, event_id TEXT, outcome TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS booking_requests_start ON booking_requests(start);`);
  }
  #get(key: string): string | undefined {
    const r = this.#db.prepare('SELECT value FROM booking_state WHERE key = ?').get(key) as Row | undefined;
    return r ? String(r.value) : undefined;
  }
  #set(key: string, value: string): void {
    this.#db.prepare('INSERT INTO booking_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  settings(): BookingSettings {
    try {
      return { ...DEFAULT_BOOKING, ...(JSON.parse(this.#get('settings') ?? '{}') as Partial<BookingSettings>) };
    } catch {
      return { ...DEFAULT_BOOKING };
    }
  }
  /** Saves a change (only known fields, each checked). */
  save(input: Record<string, unknown>): BookingSettings {
    const s = this.settings();
    if (typeof input.on === 'boolean') s.on = input.on;
    if (input.slug !== undefined) s.slug = slugify(input.slug);
    if (input.title !== undefined) s.title = clean(input.title, 80) || DEFAULT_BOOKING.title;
    if (input.note !== undefined) s.note = clean(input.note, 300);
    if (input.duration !== undefined) s.duration = int(input.duration, 10, 240, s.duration);
    if (input.buffer !== undefined) s.buffer = int(input.buffer, 0, 120, s.buffer);
    if (input.maxPerDay !== undefined) s.maxPerDay = int(input.maxPerDay, 1, 20, s.maxPerDay);
    if (input.daysAhead !== undefined) s.daysAhead = int(input.daysAhead, 1, 60, s.daysAhead);
    if (input.minNoticeHours !== undefined) s.minNoticeHours = int(input.minNoticeHours, 0, 168, s.minNoticeHours);
    if (input.approval === 'auto' || input.approval === 'ask') s.approval = input.approval;
    if (typeof input.calendar === 'string') s.calendar = clean(input.calendar, 40);
    if (input.windows !== undefined) {
      if (!Array.isArray(input.windows) || input.windows.length > 30) throw new BookingError(en('Availability is a list of days with start and end times.'));
      s.windows = input.windows.map((w) => {
        const o = (w ?? {}) as Record<string, unknown>;
        const day = Number(o.day);
        const start = String(o.start ?? '');
        const end = String(o.end ?? '');
        if (!Number.isInteger(day) || day < 0 || day > 6 || !HHMM.test(start) || !HHMM.test(end) || mins(end) <= mins(start)) throw new BookingError(en('Each time window needs a day and a start before its end, like 09:00 to 17:00.'));
        return { day, start, end };
      });
    }
    if (s.on && s.slug.length < 3) throw new BookingError(en('Pick a page name of at least 3 letters or digits.'));
    if (s.on && !s.windows.length) throw new BookingError(en('Add at least one time window first.'));
    this.#set('settings', JSON.stringify(s));
    return s;
  }
  /** The key that signs the page's time token (made once). */
  secret(): string {
    let k = this.#get('secret');
    if (!k) this.#set('secret', (k = randomBytes(24).toString('base64url')));
    return k;
  }
  requests(o: { from?: string } = {}): BookingRequest[] {
    const rows = o.from ? this.#db.prepare('SELECT * FROM booking_requests WHERE end_at >= ? ORDER BY start').all(o.from) : this.#db.prepare('SELECT * FROM booking_requests ORDER BY start DESC LIMIT 200').all();
    return (rows as Row[]).map(toRequest);
  }
  request(id: number): BookingRequest | undefined {
    const r = this.#db.prepare('SELECT * FROM booking_requests WHERE id = ?').get(id) as Row | undefined;
    return r ? toRequest(r) : undefined;
  }
  add(r: { start: string; end: string; name: string; email: string; note: string }, now: Date): BookingRequest {
    const x = this.#db.prepare('INSERT INTO booking_requests (start, end_at, name, email, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.start, r.end, r.name, r.email, r.note, 'pending', now.toISOString());
    return this.request(Number(x.lastInsertRowid))!;
  }
  set(id: number, patch: { status?: RequestStatus; eventId?: string | null; outcome?: string }): BookingRequest | undefined {
    const cur = this.request(id);
    if (!cur) return undefined;
    this.#db.prepare('UPDATE booking_requests SET status = ?, event_id = ?, outcome = ? WHERE id = ?').run(patch.status ?? cur.status, patch.eventId === undefined ? cur.eventId : patch.eventId, patch.outcome ?? cur.outcome, id);
    return this.request(id);
  }
  pendingToday(now: Date): number {
    const r = this.#db.prepare("SELECT COUNT(*) AS n FROM booking_requests WHERE status = 'pending' AND created_at >= ?").get(new Date(now.getTime() - 86_400_000).toISOString()) as Row;
    return Number(r.n);
  }
}

export interface BookingEvent {
  title: string;
  start: Date;
  end: Date;
  guests: string[];
  notes: string;
}
export interface BookingDeps {
  /** Busy time from the calendars and the planner (requests on this page are added on top). */
  busy?: (from: Date, to: Date) => Promise<Busy[]>;
  addEvent?: (e: BookingEvent) => Promise<{ id: string; readBack: boolean }>;
  sendMail?: (m: { to: string; subject: string; body: string }) => Promise<string>;
  notify?: (title: string, text: string) => Promise<void>;
  /** A form sent faster than this after the page was shown is a bot (default 2 s). */
  minFormMs?: number;
}

const LIVE = new Set<Booking>();

/** Wall-clock "YYYY-MM-DDTHH:MM" in a time zone (calendar APIs take it with the zone). */
const wall = (d: Date, tz?: string) => {
  const p = zonedParts(d, tz);
  const z = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${z(p.mo)}-${z(p.d)}T${z(p.h)}:${z(p.mi)}`;
};
export const whenText = (iso: string, tz: string | undefined, lang = 'en-US') => new Date(iso).toLocaleString(lang, { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

/** One person's booking page (their space's database). */
export class Booking {
  readonly store: BookingStore;
  readonly #app: AppContext;
  #deps: BookingDeps = {};
  constructor(app: AppContext, db: DatabaseSync) {
    this.#app = app;
    this.store = new BookingStore(db);
    LIVE.add(this);
  }
  /** Tests (and the live-ish check) swap the calendar, the mail and the bot timing. */
  setDeps(d: BookingDeps): void {
    this.#deps = { ...this.#deps, ...d };
  }
  get minFormMs(): number {
    return this.#deps.minFormMs ?? 2000;
  }
  get tz(): string | undefined {
    return this.#app.settings.get().timeZone;
  }
  get ownerName(): string {
    return this.#app.settings.get().ownerName || '';
  }
  get lang(): string | undefined {
    return (this.#app.settings.get() as { language?: string }).language;
  }
  alive(): boolean {
    try {
      this.store.settings();
      return true;
    } catch {
      LIVE.delete(this);
      return false;
    }
  }

  /** Where the events go and where the emails come from (for the Settings section). */
  connections(): { calendars: { id: string; label: string }[]; mailbox: string | null } {
    const cals: { id: string; label: string }[] = [];
    const g = this.#app.google?.status();
    if (g?.connected && g.calendar) cals.push({ id: 'google', label: g.email ? `Google (${g.email})` : 'Google Calendar' });
    for (const a of this.#app.mailAccounts?.list() ?? []) if (a.kind === 'microsoft' && a.calendar && !a.problem) cals.push({ id: a.id, label: `Outlook (${a.address})` });
    const mailbox = g?.connected && g.gmail ? (g.email ?? 'Gmail') : (this.#app.mailAccounts?.list().find((a) => a.kind !== 'google' && !a.problem)?.address ?? null);
    return { calendars: cals, mailbox };
  }

  async #calendarBusy(from: Date, to: Date): Promise<Busy[]> {
    if (this.#deps.busy) return this.#deps.busy(from, to);
    const out: Busy[] = [];
    const g = this.#app.google;
    if (g?.status().calendar) {
      const r = (await g.api('https://www.googleapis.com/calendar/v3/freeBusy', { method: 'POST', body: { timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: 'primary' }] } }).catch(() => ({}))) as { calendars?: { primary?: { busy?: { start: string; end: string }[] } } };
      for (const b of r.calendars?.primary?.busy ?? []) out.push({ start: new Date(b.start), end: new Date(b.end) });
    }
    const accts = this.#app.mailAccounts;
    for (const a of accts?.list() ?? []) {
      if (a.kind !== 'microsoft' || !a.calendar || a.problem) continue;
      const evs = await accts!.provider(a.id).calendar?.events(from, to, undefined).catch(() => []);
      for (const e of evs ?? []) if (!e.allDay && e.end) out.push({ start: new Date(e.start), end: new Date(e.end) });
    }
    // The planner: a task due at a set time keeps that half hour free.
    for (const t of this.#app.planner?.tasks({ status: 'open' }) ?? []) {
      if (!t.dueAt) continue;
      const at = new Date(t.dueAt);
      const p = zonedParts(at, this.tz);
      if (p.h === 0 && p.mi === 0) continue;
      if (at >= from && at <= to) out.push({ start: at, end: new Date(at.getTime() + 30 * 60_000) });
    }
    return out;
  }

  /** Free slots now (calendars + planner + this page's own requests). */
  async slots(now = this.#app.now()): Promise<Date[]> {
    const s = this.store.settings();
    const to = new Date(now.getTime() + (s.daysAhead + 1) * 86_400_000);
    const own = this.store.requests({ from: now.toISOString() }).filter((r) => r.status !== 'declined').map((r) => ({ start: new Date(r.start), end: new Date(r.end), booking: true }));
    const cal = await this.#calendarBusy(now, to).catch(() => [] as Busy[]);
    return freeSlots(s, [...cal, ...own], now, this.tz);
  }

  /** The page's signed time token: when it was shown. */
  token(now = Date.now()): string {
    const sig = createHmac('sha256', this.store.secret()).update(`${this.store.settings().slug}.${now}`).digest('base64url').slice(0, 22);
    return `${now}.${sig}`;
  }
  /** True when the token is real and the form took a human amount of time (≤ 2 h). */
  tokenOk(t: string, now = Date.now()): boolean {
    const [at, sig] = String(t ?? '').split('.');
    const n = Number(at);
    if (!Number.isFinite(n) || !sig) return false;
    const want = createHmac('sha256', this.store.secret()).update(`${this.store.settings().slug}.${n}`).digest('base64url').slice(0, 22);
    return want === sig && now - n >= this.minFormMs && now - n <= 2 * 3600_000;
  }

  /** A visitor's request (already past the honeypot and the rate limit). */
  async request(v: { slot: string; name: string; email: string; note: string }): Promise<BookingRequest> {
    const s = this.store.settings();
    const name = clean(v.name, 80);
    const email = clean(v.email, 200).toLowerCase();
    const note = String(v.note ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 1000);
    if (!name || !EMAIL.test(email)) throw new BookingError(en('Please give your name and a working email address.'));
    const start = new Date(String(v.slot ?? ''));
    if (Number.isNaN(start.getTime())) throw new BookingError(en('Please pick a time.'));
    if (this.store.pendingToday(this.#app.now()) >= 20) throw new BookingError(en('This page has too many open requests right now. Please try again tomorrow.'), 429);
    const free = await this.slots();
    if (!free.some((d) => d.getTime() === start.getTime())) throw new BookingError(en('Sorry, that time was just taken. Please pick another one.'), 409);
    const end = new Date(start.getTime() + s.duration * 60_000);
    const r = this.store.add({ start: start.toISOString(), end: end.toISOString(), name, email, note }, this.#app.now());
    if (s.approval === 'auto') return this.confirm(r.id);
    const notify = this.#deps.notify ?? ((title: string, text: string) => this.#app.push?.notifyOwner(title, text, '', `booking-${r.id}`) ?? Promise.resolve());
    await notify(`Booking request: ${name}`, `${whenText(r.start, this.tz)}${note ? ` · ${note.slice(0, 120)}` : ''}. Confirm it in Settings → Business details → Booking page.`).catch(() => undefined);
    return r;
  }

  async #addEvent(e: BookingEvent): Promise<{ id: string; readBack: boolean }> {
    if (this.#deps.addEvent) return this.#deps.addEvent(e);
    const s = this.store.settings();
    const { calendars } = this.connections();
    const target = calendars.find((c) => c.id === s.calendar) ?? calendars[0];
    if (!target) throw new BookingError(en('No calendar is connected (Settings → Email and calendar, or Gmail and Calendar).'), 409);
    const tz = this.tz ?? 'UTC';
    if (target.id === 'google') {
      const g = this.#app.google!;
      const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
      const ev = (await g.api(`${CAL}?sendUpdates=none`, { method: 'POST', body: { summary: e.title, description: e.notes, start: { dateTime: `${wall(e.start, tz)}:00`, timeZone: tz }, end: { dateTime: `${wall(e.end, tz)}:00`, timeZone: tz }, attendees: e.guests.map((email) => ({ email })) } })) as { id?: string };
      const back = ev.id ? ((await g.api(`${CAL}/${ev.id}`).catch(() => undefined)) as { id?: string } | undefined) : undefined;
      return { id: String(ev.id ?? ''), readBack: back?.id === ev.id };
    }
    const cal = this.#app.mailAccounts!.provider(target.id).calendar;
    if (!cal) throw new BookingError(en('That calendar can no longer be reached.'), 409);
    const ev = await cal.add({ title: e.title, start: wall(e.start, tz), end: wall(e.end, tz), allDay: false, notes: e.notes, guests: e.guests, timeZone: tz });
    return { id: ev.id, readBack: Boolean(ev.id) };
  }

  async #sendMail(m: { to: string; subject: string; body: string }): Promise<string> {
    if (this.#deps.sendMail) return this.#deps.sendMail(m);
    const g = this.#app.google;
    if (g?.status().gmail) {
      const r = (await g.api('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', body: { raw: rawEmail(m) } })) as { id?: string };
      return `sent from Gmail (email ${r.id ?? '?'})`;
    }
    const a = this.#app.mailAccounts?.list().find((x) => x.kind !== 'google' && !x.problem);
    if (!a) throw new BookingError(en('No mailbox is connected to send the confirmation from.'), 409);
    const id = await this.#app.mailAccounts!.provider(a.id).send({ to: m.to, subject: m.subject, body: m.body });
    return `sent from ${a.address} (email ${id})`;
  }

  /** The person confirmed (or "auto"): the calendar event, then the visitor's email. */
  async confirm(id: number): Promise<BookingRequest> {
    const r = this.store.request(id);
    if (!r) throw new BookingError(en('There is no such booking request.'), 404);
    if (r.status === 'confirmed') return r;
    const s = this.store.settings();
    const who = this.ownerName || 'me';
    const ev = await this.#addEvent({ title: `${s.title}: ${r.name}`, start: new Date(r.start), end: new Date(r.end), guests: [r.email], notes: `Booked on the booking page by ${r.name} <${r.email}>.${r.note ? `\n\n${r.note}` : ''}` });
    let mail: string;
    try {
      mail = await this.#sendMail({ to: r.email, subject: `Confirmed: ${s.title} with ${who}, ${whenText(r.start, this.tz)}`, body: `Hi ${r.name},\n\nYour ${s.title.toLowerCase()} with ${who} is confirmed for ${whenText(r.start, this.tz)} (${s.duration} minutes).${s.note ? `\n\n${s.note}` : ''}\n\nIf you can't make it, just reply to this email.\n\n${who}` });
    } catch (err) {
      mail = `the confirmation email was not sent (${(err as Error).message.slice(0, 120)})`;
    }
    return this.store.set(id, { status: 'confirmed', eventId: ev.id, outcome: `Event ${ev.id}${ev.readBack ? ' (read back from the calendar)' : ''}; ${mail}.` })!;
  }

  async decline(id: number): Promise<BookingRequest> {
    const r = this.store.request(id);
    if (!r) throw new BookingError(en('There is no such booking request.'), 404);
    if (r.status !== 'pending') throw new BookingError(en('Only a request that is still waiting can be declined.'), 409);
    const s = this.store.settings();
    const who = this.ownerName || 'me';
    let mail: string;
    try {
      mail = await this.#sendMail({ to: r.email, subject: `${s.title} with ${who}: please pick another time`, body: `Hi ${r.name},\n\nSorry, ${whenText(r.start, this.tz)} doesn't work after all. Please pick another time on the booking page.\n\n${who}` });
    } catch (err) {
      mail = `no email was sent (${(err as Error).message.slice(0, 120)})`;
    }
    return this.store.set(id, { status: 'declined', outcome: mail })!;
  }
}

const OF = new WeakMap<DatabaseSync, Booking>();
/** This space's booking page (its first companion's database, like the business store). */
export function bookingFor(app: AppContext): Booking {
  let db = app.store.db;
  try {
    db = app.companions?.main?.app?.store.db ?? db;
  } catch {
    /* tests, the demo */
  }
  let b = OF.get(db);
  if (!b) OF.set(db, (b = new Booking(app.companions?.main?.app ?? app, db)));
  return b;
}
/** The live page with this name (any space on this server), when it is switched on. */
export function bookingBySlug(slug: string): Booking | undefined {
  for (const b of [...LIVE]) {
    if (!b.alive()) continue;
    const s = b.store.settings();
    if (s.on && s.slug === slug) return b;
  }
  return undefined;
}
/** Another space already uses this page name. */
export function slugTaken(slug: string, mine: Booking): boolean {
  for (const b of [...LIVE]) if (b !== mine && b.alive() && b.store.settings().slug === slug) return true;
  return false;
}
