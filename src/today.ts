// Phase 15: the Today page. One look at the day: what's due, the calendar, mail that matters,
// how she's doing, dates coming up and anything running in the background. Each part is
// optional and quietly left out when it isn't set up or can't be reached.
//
// Phase 111 (TD1, docs/design/TODAY.md): one batched answer for the whole page. Every part is
// built in parallel with its own timeout and carries when it was read (`parts[name].at`, and
// `cached` when a cache served it). `?parts=` limits the work to the parts asked for (the live
// reloads), `?fresh=1` skips the caches. The outside sources (Google) are cached per companion
// on the app, with a generation counter per part: `todayChanged(app, part)` bumps it, clears the
// entry and tells this companion's open pages (SSE `today {part}`); a load that started before a
// change never writes its older numbers back (the stale Mail tile, §5.1).
import type { AppContext } from './chat.ts';
import { header, type GmailPart } from './google.ts';
import { expressionFor, leansPlayful, moodLabel } from './inner.ts';
import { localDate } from './memory-worker.ts';
import { dayStartUtc } from './planner.ts';
import { en } from './i18n.ts';
import { getLayout, recordMail, type TodayPrefs } from './today-layout.ts';

export interface TodayEvent {
  id: string;
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  location?: string;
}
export interface TodayMail {
  id: string;
  from: string;
  subject: string;
  /** TD1: the thread (for the Gmail link) and when it arrived. */
  threadId?: string;
  at?: string;
  /** M1: another mailbox than Gmail: its web app (the tile links there instead of Gmail). */
  webUrl?: string;
}
export interface MailOrganised {
  action: string;
  label?: string;
  count: number;
  /** The gmail_actions ids (Undo reverses each). */
  ids: string[];
}
export interface TodayPartMeta {
  at: string;
  cached?: boolean;
  stale?: boolean;
  error?: string;
}
export interface Today {
  date: string;
  greeting: string;
  greetingKey: 'late' | 'morning' | 'afternoon' | 'evening';
  owner?: string;
  /** Today in the owner's time zone, YYYY-MM-DD. */
  day: string;
  agenda: { tasks: { id: number; title: string; dueAt: string | null; overdue: boolean; project: string | null }[]; reminders: { id: number; text: string; dueAt: string }[]; doneToday?: number };
  calendar?: { events: TodayEvent[]; error?: string; leaveBy?: { eventId: string; leaveAt: string; minutes: number }[] };
  mail?: { unread: number; important: TodayMail[]; error?: string; total?: number; change?: { total: number; unread: number }; organised?: MailOrganised[]; at?: string; reconnect?: boolean; provider?: string; account?: string; webUrl?: string };
  her?: { name: string; mood: string; energy: string; expression: string; day: string | null };
  /** Phase 101 (ST6): a date about someone on a people card names them (the tile opens the card). */
  dates: { what: string; inDays: number; years: number | null; personId?: number; person?: string }[];
  jobs: { id: number; label: string; startedAt: string }[];
  /** Phase 99 (ST4): cards waiting on you (with the question) and cards she is working on. */
  board?: { waiting: { id: number; title: string; question: string; boardId: number }[]; doing: { id: number; title: string; line: string; boardId: number }[] };
  /** Phase 102 (ST7): from your webhooks (important Tell me items and "sending too much" notes, last 24 h). */
  hooks?: { id: number; hookId: string; name: string; text: string; at: string; kind: string; conversationId: string | null }[];
  /** Phase 103 (ST8): Her plans (today's reach-outs with times and reasons, goals, the shared count and budget). */
  plans?: ReturnType<import('./agenda.ts').Agenda['todayTile']>;
  /** Phase 56: models that were retired and what now uses their replacement (last 3 days). */
  models?: string[];
  /** UX 19: the same as `models`, as data (ModelNotice / RetiredUse from model-catalog.ts), for translating. */
  modelItems?: unknown[];
  /** E1: live-data watches (Watching). */
  watching?: ReturnType<import('./live-watch.ts').LiveWatches['todayTile']>;
  /** E4: My teams (next game, last result, live score), only when following a team. */
  teams?: Awaited<ReturnType<import('./sports/follow.ts').Sports['todayTile']>>;
  /** TD1: the calendar's next N days (Coming up). */
  coming?: { events: TodayEvent[]; days: number };
  /** E6: Money in (unpaid invoices) and Owe a reply (the last follow-ups check); only once used. */
  business?: import('./biz/today.ts').BusinessTile;
  /** E3: portfolio value and today's move, bills due this week, spending this month; only once used. */
  money?: import('./money/core.ts').MoneyTile;
  /** TD1: this companion's layout preferences. */
  layout?: TodayPrefs & { seenAt: string | null };
  /** TD1: every part that was built, with when it was read. */
  parts?: Record<string, TodayPartMeta>;
}

/** Every part `GET /api/today?parts=` knows. */
export const TODAY_PARTS = ['day', 'coming', 'mail', 'her', 'board', 'hooks', 'plans', 'models', 'weather', 'home', 'memories', 'moments', 'work', 'usage', 'projects', 'needs', 'away', 'rooms', 'business', 'watching', 'money', 'teams', 'layout'] as const;
export type TodayPartName = (typeof TODAY_PARTS)[number];

const CACHE_MS = 2 * 60_000;
/** A cached copy younger than this answers at once (and is refreshed in the background, §8.1). */
const SERVE_STALE_MS = 15 * 60_000;

interface Entry {
  key: string;
  at: number;
  started: number;
  value: unknown;
}
/** Per companion (held on the app): the cached outside parts and each part's generation. */
export class TodayState {
  readonly gen = new Map<string, number>();
  readonly cache = new Map<string, Entry>();
  readonly inflight = new Map<string, Promise<unknown>>();
  /** Counts of source calls (tests check that `?parts=` limits the work). */
  readonly calls = new Map<string, number>();
}
const allStates = new Set<TodayState>();

export function todayState(app: AppContext): TodayState {
  if (!app.todayState) {
    app.todayState = new TodayState();
    allStates.add(app.todayState);
  }
  return app.todayState;
}

/**
 * Something on Today changed (B7): the part's cache is cleared, its generation bumped (so a load
 * already on its way doesn't write the old numbers back) and this companion's open pages reload it.
 */
export function todayChanged(app: AppContext, part: TodayPartName | string): void {
  const st = todayState(app);
  st.gen.set(part, (st.gen.get(part) ?? 0) + 1);
  st.cache.delete(part);
  app.events?.publish({ type: 'today', part });
}

/** The organizer's hook (main.ts and the tests): every recorded change and each 500 messages of a long run. */
export const gmailTodayHook = (app: AppContext) => (): void => todayChanged(app, 'mail');

/** After she changes the mailbox: kept for older callers; clears every companion's mail. */
export function forgetTodayMail(): void {
  for (const s of allStates) {
    s.gen.set('mail', (s.gen.get('mail') ?? 0) + 1);
    s.cache.delete('mail');
  }
}

/** Forget cached Google parts (tests, and after signing in/out). With an app: that companion only, and its pages are told. */
export function clearTodayCache(app?: AppContext): void {
  if (app) {
    for (const p of ['day', 'coming', 'mail']) todayChanged(app, p);
    return;
  }
  for (const s of allStates) {
    for (const p of ['day', 'coming', 'mail']) s.gen.set(p, (s.gen.get(p) ?? 0) + 1);
    s.cache.clear();
  }
}

const countCall = (app: AppContext, what: string) => {
  const st = todayState(app);
  st.calls.set(what, (st.calls.get(what) ?? 0) + 1);
};

/**
 * A cached outside part (§5.2, §8.1). Fresh enough: from the cache. Older but under 15 minutes:
 * from the cache at once, refreshed in the background (the page hears SSE `today`). Otherwise read.
 * A read writes the cache only when no change landed meanwhile (same generation) and no newer read
 * already wrote it; otherwise its result is returned once, marked stale.
 */
export async function cachedPart<T>(app: AppContext, part: string, key: string, load: () => Promise<T>, opts: { fresh?: boolean; ttl?: number } = {}): Promise<{ value: T; at: number; cached?: boolean; stale?: boolean }> {
  const st = todayState(app);
  const ttl = opts.ttl ?? CACHE_MS;
  const now = app.now().getTime();
  const e = st.cache.get(part);
  const read = async (): Promise<{ value: T; at: number; stale?: boolean }> => {
    const g = st.gen.get(part) ?? 0;
    const started = app.now().getTime();
    const value = await load();
    const at = app.now().getTime();
    if ((st.gen.get(part) ?? 0) !== g) return { value, at: started, stale: true };
    const cur = st.cache.get(part);
    if (cur && cur.key === key && cur.started > started) return { value: cur.value as T, at: cur.at };
    st.cache.set(part, { key, at, started, value });
    return { value, at };
  };
  if (!opts.fresh && e && e.key === key) {
    if (now - e.at < ttl) return { value: e.value as T, at: e.at, cached: true };
    if (now - e.at < SERVE_STALE_MS) {
      if (!st.inflight.has(part)) {
        const p = read()
          .then((r) => {
            if (!r.stale) app.events?.publish({ type: 'today', part });
          })
          .catch(() => {})
          .finally(() => st.inflight.delete(part));
        st.inflight.set(part, p);
      }
      return { value: e.value as T, at: e.at, cached: true };
    }
  }
  return read();
}

/** Midnight to midnight in the owner's time zone, as UTC instants. */
export function dayBounds(now: Date, timeZone?: string): { start: Date; end: Date } {
  const day = localDate(now.toISOString(), timeZone);
  const start = dayStartUtc(day, timeZone);
  // The next local midnight (23 or 25 hours on clock-change days).
  const next = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { start, end: dayStartUtc(next, timeZone) };
}

type CalItem = { id: string; summary?: string; location?: string; status?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } };
const toEvent = (e: CalItem): TodayEvent => ({
  id: e.id,
  title: e.summary ?? en('(no title)'),
  start: e.start?.dateTime ?? e.start?.date ?? '',
  ...(e.end?.dateTime || e.end?.date ? { end: e.end.dateTime ?? e.end.date } : {}),
  allDay: !e.start?.dateTime,
  ...(e.location ? { location: e.location } : {}),
});

/** M1: an Outlook calendar is used when its mailbox is the default, or when Google's calendar isn't connected. */
function msCalendar(app: AppContext): import('./mail/types.ts').MailAccountInfo | undefined {
  const ok = (a?: import('./mail/types.ts').MailAccountInfo) => (a && a.kind === 'microsoft' && a.calendar && !a.problem ? a : undefined);
  const def = ok(app.mailAccounts?.default());
  if (def) return def;
  return app.google?.status().calendar ? undefined : app.mailAccounts?.list().find((a) => ok(a));
}
/** Whether Today and the briefing have a calendar (Google's or Outlook's). */
export const hasCalendar = (app: AppContext): boolean => Boolean(msCalendar(app) || app.google?.status().calendar);
const calendarKey = (app: AppContext): string => msCalendar(app)?.address ?? app.google?.status().email ?? '';

/**
 * M1: events between two times from the calendar Sara uses everywhere (the default mailbox's
 * Outlook calendar, else Google's): Today, the briefing, leave-by reminders and the weekly review.
 */
export async function calendarEvents(app: AppContext, from: Date, to: Date, max: number, timeoutMs = 8000): Promise<TodayEvent[]> {
  return calendarBetween(app, from, to, max, timeoutMs);
}

async function calendarBetween(app: AppContext, from: Date, to: Date, max: number, timeoutMs = 8000): Promise<TodayEvent[]> {
  countCall(app, 'calendar');
  const ms = msCalendar(app);
  if (ms) {
    const list = await app.mailAccounts!.provider(ms.id).calendar!.events(from, to, undefined, AbortSignal.timeout(timeoutMs));
    return list.slice(0, max).map((e) => ({ id: e.id, title: e.title, start: e.start, ...(e.end ? { end: e.end } : {}), allDay: e.allDay, ...(e.location ? { location: e.location } : {}) }));
  }
  const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: String(max) });
  const r = (await app.google!.api(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { signal: AbortSignal.timeout(timeoutMs) })) as { items?: CalItem[] };
  return (r.items ?? []).filter((e) => e.status !== 'cancelled').map(toEvent);
}

export async function calendarToday(app: AppContext, now: Date, tz?: string): Promise<Today['calendar']> {
  if (!hasCalendar(app)) return undefined;
  const { start, end } = dayBounds(now, tz);
  try {
    return { events: await calendarBetween(app, start, end, 25) };
  } catch (err) {
    return { events: [], error: (err as Error).message };
  }
}

/** Coming up (§4.3): the calendar from tomorrow for `days` days (10 at most). */
export async function comingEvents(app: AppContext, now: Date, tz: string | undefined, days: number): Promise<TodayEvent[] | undefined> {
  if (!hasCalendar(app)) return undefined;
  const { end } = dayBounds(now, tz);
  try {
    return await calendarBetween(app, end, new Date(end.getTime() + days * 86_400_000), 10);
  } catch {
    return undefined;
  }
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Mail 2.0 (§5.3): inbox total and unread, important unread with time and thread, what she organised today. */
export async function mailToday(app: AppContext): Promise<Today['mail']> {
  // M1: the default mailbox (Gmail when it is the default: exactly as before).
  const def = app.mailAccounts?.default();
  if (def && def.kind !== 'google') return otherMailToday(app, def);
  // Gmail's sign-in is the owner's only: a member's Today never reads it, even if one were attached.
  const g = app.member ? undefined : app.google;
  if (!g?.status().gmail) return undefined;
  try {
    countCall(app, 'gmail');
    const signal = AbortSignal.timeout(8000);
    const [inbox, important] = (await Promise.all([
      g.api(`${GMAIL}/labels/INBOX`, { signal }),
      g.api(`${GMAIL}/messages?${new URLSearchParams({ q: 'is:unread is:important in:inbox newer_than:3d', maxResults: '5' })}`, { signal }),
    ])) as [{ messagesUnread?: number; messagesTotal?: number }, { messages?: { id: string }[] }];
    const metas = await Promise.all(
      (important.messages ?? []).map((m) => g.api(`${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, { signal }) as Promise<{ id: string; threadId?: string; internalDate?: string; payload?: GmailPart }>),
    );
    return {
      unread: inbox.messagesUnread ?? 0,
      ...(typeof inbox.messagesTotal === 'number' ? { total: inbox.messagesTotal } : {}),
      important: metas.map((m) => ({
        id: m.id,
        from: header(m.payload, 'From').replace(/\s*<[^>]+>$/, '').replace(/^"|"$/g, ''),
        subject: header(m.payload, 'Subject') || en('(no subject)'),
        ...(m.threadId ? { threadId: m.threadId } : {}),
        ...(m.internalDate && Number.isFinite(Number(m.internalDate)) ? { at: new Date(Number(m.internalDate)).toISOString() } : {}),
      })),
    };
  } catch (err) {
    return { unread: 0, important: [], error: (err as Error).message };
  }
}

/** M1: Today's Mail for an Outlook or IMAP default mailbox: the same shape as Gmail's. */
async function otherMailToday(app: AppContext, a: import('./mail/types.ts').MailAccountInfo): Promise<Today['mail']> {
  const head = { provider: a.kind === 'microsoft' ? 'Outlook' : 'Mail', account: a.address };
  if (a.problem) return { unread: 0, important: [], error: a.problem, ...head };
  try {
    countCall(app, 'mail');
    const p = app.mailAccounts!.provider(a.id);
    const signal = AbortSignal.timeout(8000);
    const webUrl = p.webLink?.('') ?? undefined;
    const [c, imp] = await Promise.all([p.inboxCounts(signal), p.important(5, signal)]);
    return {
      unread: c.unread,
      total: c.total,
      important: imp.map((m) => ({ id: m.id, from: m.from.replace(/\s*<[^>]+>$/, '').replace(/^"|"$/g, ''), subject: m.subject || en('(no subject)'), ...(m.date ? { at: m.date } : {}), ...(webUrl ? { webUrl } : {}) })),
      ...head,
      ...(webUrl ? { webUrl } : {}),
    };
  } catch (err) {
    return { unread: 0, important: [], error: (err as Error).message, ...head };
  }
}

/** The mail cache key: this companion, the local day and the mailbox (§5.2). */
export const mailKey = (app: AppContext, day: string): string => `${app.companionId ?? 'main'}|${day}|${mailAddress(app)}`;
const mailAddress = (app: AppContext): string => {
  const def = app.mailAccounts?.default();
  return def && def.kind !== 'google' ? def.address : (app.google?.status().email ?? '');
};

/** What the route adds (it knows the request): weather, moments, approvals, the demo and the phone apps. */
export interface TodayExtras {
  demo?: boolean;
  phoneApp?: boolean;
  /** Each extra part's loader (src/routes/planner.ts, src/today-parts.ts). */
  loaders?: Partial<Record<TodayPartName, (ctx: PartCtx) => Promise<unknown> | unknown>>;
}
export interface PartCtx {
  app: AppContext;
  now: Date;
  tz: string | undefined;
  day: string;
  fresh: boolean;
  prefs: TodayPrefs;
  member: boolean;
  demo: boolean;
  phoneApp: boolean;
  /** The parts built so far this request (needs reads mail and plans). */
  out: Today;
}

const TIMEOUTS: Partial<Record<TodayPartName, number>> = { day: 9000, coming: 9000, mail: 9000, weather: 9000, home: 9000, projects: 6000 };

function withTimeout<T>(p: Promise<T>, ms: number | undefined): Promise<T> {
  if (!ms) return p;
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<T>((_r, reject) => (timer = setTimeout(() => reject(new Error('Timed out')), ms)))]).finally(() => clearTimeout(timer));
}

export async function buildToday(app: AppContext, opts: { fresh?: boolean; parts?: readonly string[] } & TodayExtras = {}): Promise<Today> {
  const now = app.now();
  const s = app.settings.get();
  const tz = s.timeZone;
  const today = localDate(now.toISOString(), tz);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
  const owner = s.ownerName?.trim();
  const greetingKey = hour < 5 ? 'late' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const greeting = `${{ late: 'Up late', morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening' }[greetingKey]}${owner ? `, ${owner}` : ''}`;
  const want = new Set<string>(opts.parts?.length ? opts.parts.filter((p) => (TODAY_PARTS as readonly string[]).includes(p)) : TODAY_PARTS);
  const fresh = Boolean(opts.fresh);
  const member = Boolean(app.member);
  const demo = Boolean(opts.demo);
  const layout = getLayout(app);
  const prefs = layout.prefs;

  // To-dos due today or overdue (and undated high-priority ones), reminders in the next 24 hours.
  const endOfDay = dayBounds(now, tz).end.getTime();
  const tasks = (app.planner?.tasks({ status: 'open' }) ?? [])
    .filter((t) => (t.dueAt ? Date.parse(t.dueAt) < endOfDay : t.priority === 'high'))
    .sort((a, b) => (a.dueAt ?? '9').localeCompare(b.dueAt ?? '9'))
    .slice(0, 12)
    .map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt, overdue: Boolean(t.dueAt && Date.parse(t.dueAt) < now.getTime()), project: t.project }));
  // Phase 119: "when it comes up" reminders have no time and never show on Today (or MCP get_today).
  const reminders = (app.planner?.reminders({ status: 'pending', kind: 'timed' }) ?? [])
    .filter((r) => Date.parse(r.dueAt) < now.getTime() + 86_400_000)
    .slice(0, 8)
    .map((r) => ({ id: r.id, text: r.text, dueAt: r.dueAt }));

  const out: Today = {
    date: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(now),
    greeting,
    // H3: the app words it in the owner's language (English text above stays for older clients).
    greetingKey,
    ...(owner ? { owner } : {}),
    day: today,
    agenda: { tasks, reminders, doneToday: (app.planner?.tasks({ status: 'all' }) ?? []).filter((t) => t.status === 'done' && t.doneAt && localDate(t.doneAt, tz) === today).length },
    dates: [],
    jobs: (app.jobs?.running() ?? []).map((j) => ({ id: j.id, label: j.label, startedAt: j.startedAt })),
    parts: {},
  };
  const meta = (name: string, m: Partial<TodayPartMeta> = {}) => (out.parts![name] = { at: new Date(m.at ?? app.now().toISOString()).toISOString(), ...(m.cached ? { cached: true } : {}), ...(m.stale ? { stale: true } : {}), ...(m.error ? { error: m.error } : {}) });
  const ctx: PartCtx = { app, now, tz, day: today, fresh, prefs, member, demo, phoneApp: Boolean(opts.phoneApp), out };

  const builders: Partial<Record<TodayPartName, () => Promise<void> | void>> = {
    day: async () => {
      if (!hasCalendar(app)) return void meta('day');
      const r = await cachedPart(app, 'day', `${app.companionId ?? 'main'}|${today}|${calendarKey(app)}`, () => calendarToday(app, now, tz), { fresh });
      if (r.value) {
        const cal = r.value as NonNullable<Today['calendar']>;
        const leaveBy = demo ? [] : await (app.leaveBy?.planFor?.(cal.events) ?? Promise.resolve([])).catch(() => []);
        out.calendar = { ...cal, ...(leaveBy.length ? { leaveBy } : {}) };
      }
      meta('day', { at: new Date(r.at).toISOString(), cached: r.cached, stale: r.stale, error: (r.value as Today['calendar'])?.error });
    },
    coming: async () => {
      out.dates = comingDates(app, today, prefs.comingDays);
      if (hasCalendar(app) && !demo) {
        const r = await cachedPart(app, 'coming', `${app.companionId ?? 'main'}|${today}|${prefs.comingDays}|${calendarKey(app)}`, () => comingEvents(app, now, tz, prefs.comingDays), { fresh });
        if (r.value) out.coming = { events: r.value as TodayEvent[], days: prefs.comingDays };
        return void meta('coming', { at: new Date(r.at).toISOString(), cached: r.cached, stale: r.stale });
      }
      meta('coming');
    },
    mail: async () => {
      // Subjects and senders are this person's own: the owner's mailboxes, or a member's own (their
      // app only ever holds their own accounts; no Gmail sign-in for members). Never the demo.
      if (demo || !(app.google?.status().gmail || app.mailAccounts?.hasOthers())) return;
      const r = await cachedPart(app, 'mail', mailKey(app, today), () => mailToday(app), { fresh });
      const m = r.value as Today['mail'];
      if (!m) return;
      const email = mailAddress(app);
      const change = !m.error && typeof m.total === 'number' ? recordMail(app, email, m.total, m.unread) : undefined;
      const organised = m.provider ? [] : (app.gmail?.organisedSince(dayBounds(now, tz).start.toISOString()) ?? []);
      out.mail = { ...m, ...(change ? { change } : {}), organised, at: new Date(r.at).toISOString(), ...(m.error && /gmail\.modify|insufficient|scope/i.test(m.error) ? { reconnect: true } : {}) };
      meta('mail', { at: new Date(r.at).toISOString(), cached: r.cached, stale: r.stale, error: m.error });
    },
    her: () => {
      if (app.inner && s.persona?.innerLife !== false) {
        const st = app.inner.get(now);
        const ml = moodLabel(st, now, tz);
        out.her = { name: app.persona.name, mood: ml.mood, energy: ml.energy, expression: expressionFor(st, now, tz, leansPlayful(app.persona.traits)), day: app.life?.get(today) ?? null };
      }
      meta('her');
    },
    board: () => {
      if (app.board) {
        const b = app.board.today();
        if (b.waiting.length || b.doing.length) out.board = b;
      }
      meta('board');
    },
    hooks: () => {
      if (member) return;
      if (app.hooks) {
        const items = app.hooks.today();
        if (items.length) out.hooks = items;
      }
      meta('hooks');
    },
    plans: () => {
      const tile = app.agenda?.todayTile();
      if (tile) out.plans = tile;
      meta('plans');
    },
    models: () => {
      if (app.modelCatalog) {
        const items = [...app.modelCatalog.notices(3), ...app.modelCatalog.retiredInUse()].slice(0, 5);
        if (items.length) {
          out.models = items.map((x) => x.text);
          out.modelItems = items;
        }
      }
      meta('models');
    },
    watching: () => {
      // E1: the person's "tell me when" watches on live data (their own space's).
      const tile = demo ? undefined : app.liveWatches?.todayTile();
      if (tile) out.watching = tile;
      meta('watching');
    },
    teams: async () => {
      // E4: My teams (ESPN, cached 10 minutes in the data sources); nothing when no team is followed.
      if (!demo && app.sports?.list().length) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tile = await Promise.race([app.sports.todayTile().catch(() => undefined), new Promise<undefined>((res) => {
          timer = setTimeout(() => res(undefined), 8000);
        })]);
        clearTimeout(timer);
        if (tile) out.teams = tile;
      }
      meta('teams');
    },
    layout: () => {
      out.layout = { ...prefs, seenAt: layout.seenAt };
      // A member's own prefs never carry the owner-only tiles' settings (Home picks, Rooms).
      if (member) {
        delete (out.layout as Partial<TodayPrefs>).home;
        delete (out.layout as Partial<TodayPrefs>).rooms;
        delete (out.layout as Partial<TodayPrefs>).awayRooms;
      }
      meta('layout');
    },
  };
  // The parts the route and src/today-parts.ts add (weather, home, memories, moments, work, usage, projects, needs, away, rooms).
  for (const [name, load] of Object.entries(opts.loaders ?? {}) as [TodayPartName, (c: PartCtx) => unknown][]) {
    builders[name] ??= async () => {
      const v = await load(ctx);
      if (v === undefined) return;
      const val = v as { at?: string; cached?: boolean };
      (out as unknown as Record<string, unknown>)[name] = v;
      meta(name, { ...(val && typeof val === 'object' && typeof val.at === 'string' ? { at: val.at } : {}), ...(val && typeof val === 'object' && val.cached ? { cached: true } : {}) });
    };
  }
  // Needs you reads mail and plans: it goes after them.
  const first = [...want].filter((p) => p !== 'needs' && p !== 'away' && builders[p as TodayPartName]);
  const run = async (p: string) => {
    try {
      await withTimeout(Promise.resolve(builders[p as TodayPartName]!()), TIMEOUTS[p as TodayPartName]);
    } catch (err) {
      out.parts![p] = { at: app.now().toISOString(), error: (err as Error).message.slice(0, 200) };
    }
  };
  await Promise.allSettled(first.map(run));
  await Promise.allSettled(['needs', 'away'].filter((p) => want.has(p) && builders[p as TodayPartName]).map(run));
  if (!want.has('coming')) delete (out as Partial<Today>).dates;
  if (!want.has('day')) delete (out as Partial<Today>).agenda;
  return out;
}

/** Memory dates and People birthdays for the next `days` days (sensitive notes never show here). */
export function comingDates(app: AppContext, today: string, days: number): Today['dates'] {
  const memCfg = app.memory && app.settings.get().memory?.enabled !== false;
  // Phase 101: each date about a person names them; birthdays set on cards (not already a date
  // note) join in, once; sensitive notes never show here.
  const people = memCfg ? app.people : undefined;
  const dates: Today['dates'] = memCfg
    ? app.memory!
        .upcoming(today, days)
        .filter((u) => !people?.sensitiveMemory(u.memory.id))
        .map((u) => {
          const p = people?.personOfMemory(u.memory.id);
          return { what: u.memory.content, inDays: u.inDays, years: u.years, ...(p && p.status === 'active' ? { personId: p.id, person: p.name } : {}) };
        })
    : [];
  if (people) {
    for (const b of people.birthdays(today, days)) dates.push({ what: `${b.person.name}'s birthday`, inDays: b.inDays, years: null, personId: b.person.id, person: b.person.name });
    dates.sort((a, b) => a.inDays - b.inDays);
  }
  return dates;
}
