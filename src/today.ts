// Phase 15: the Today page. One look at the day: what's due, the calendar, mail that matters,
// how she's doing, dates coming up and anything running in the background. Each part is
// optional and quietly left out when it isn't set up or can't be reached.
import type { AppContext } from './chat.ts';
import { header, type GmailPart } from './google.ts';
import { expressionFor, leansPlayful, moodLabel } from './inner.ts';
import { localDate } from './memory-worker.ts';
import { dayStartUtc } from './planner.ts';
import { en } from './i18n.ts';

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
}
export interface Today {
  date: string;
  greeting: string;
  greetingKey: 'late' | 'morning' | 'afternoon' | 'evening';
  owner?: string;
  /** Today in the owner's time zone, YYYY-MM-DD. */
  day: string;
  agenda: { tasks: { id: number; title: string; dueAt: string | null; overdue: boolean; project: string | null }[]; reminders: { id: number; text: string; dueAt: string }[] };
  calendar?: { events: TodayEvent[]; error?: string };
  mail?: { unread: number; important: TodayMail[]; error?: string };
  her?: { name: string; mood: string; energy: string; expression: string; day: string | null };
  dates: { what: string; inDays: number; years: number | null }[];
  jobs: { id: number; label: string; startedAt: string }[];
  /** Phase 99 (ST4): cards waiting on you (with the question) and cards she is working on. */
  board?: { waiting: { id: number; title: string; question: string; boardId: number }[]; doing: { id: number; title: string; line: string; boardId: number }[] };
  /** Phase 56: models that were retired and what now uses their replacement (last 3 days). */
  models?: string[];
  /** UX 19: the same as `models`, as data (ModelNotice / RetiredUse from model-catalog.ts), for translating. */
  modelItems?: unknown[];
}

const CACHE_MS = 2 * 60_000;
let cache: { at: number; key: string; calendar?: Today['calendar']; mail?: Today['mail'] } | undefined;

/** After she changes the mailbox (archive, mark read, labels…): the next Today asks Gmail again. */
export function forgetTodayMail(): void {
  cache = undefined;
}

/** Midnight to midnight in the owner's time zone, as UTC instants. */
function dayBounds(now: Date, timeZone?: string): { start: Date; end: Date } {
  const day = localDate(now.toISOString(), timeZone);
  const start = dayStartUtc(day, timeZone);
  // The next local midnight (23 or 25 hours on clock-change days).
  const next = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { start, end: dayStartUtc(next, timeZone) };
}

export async function calendarToday(app: AppContext, now: Date, tz?: string): Promise<Today['calendar']> {
  const g = app.google;
  if (!g?.status().calendar) return undefined;
  const { start, end } = dayBounds(now, tz);
  try {
    const q = new URLSearchParams({ timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '25' });
    const r = (await g.api(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { signal: AbortSignal.timeout(8000) })) as {
      items?: { id: string; summary?: string; location?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }[];
    };
    return {
      events: (r.items ?? []).map((e) => ({
        id: e.id,
        title: e.summary ?? en('(no title)'),
        start: e.start?.dateTime ?? e.start?.date ?? '',
        ...(e.end?.dateTime || e.end?.date ? { end: e.end.dateTime ?? e.end.date } : {}),
        allDay: !e.start?.dateTime,
        ...(e.location ? { location: e.location } : {}),
      })),
    };
  } catch (err) {
    return { events: [], error: (err as Error).message };
  }
}

export async function mailToday(app: AppContext): Promise<Today['mail']> {
  const g = app.google;
  if (!g?.status().gmail) return undefined;
  const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
  try {
    const signal = AbortSignal.timeout(8000);
    const [unread, important] = (await Promise.all([
      g.api(`${base}/labels/INBOX`, { signal }),
      g.api(`${base}/messages?${new URLSearchParams({ q: 'is:unread is:important in:inbox newer_than:3d', maxResults: '5' })}`, { signal }),
    ])) as [{ messagesUnread?: number }, { messages?: { id: string }[] }];
    const metas = await Promise.all(
      (important.messages ?? []).map((m) => g.api(`${base}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, { signal }) as Promise<{ id: string; payload?: GmailPart }>),
    );
    return {
      unread: unread.messagesUnread ?? 0,
      important: metas.map((m) => ({ id: m.id, from: header(m.payload, 'From').replace(/\s*<[^>]+>$/, '').replace(/^"|"$/g, ''), subject: header(m.payload, 'Subject') || en('(no subject)') })),
    };
  } catch (err) {
    return { unread: 0, important: [], error: (err as Error).message };
  }
}

export async function buildToday(app: AppContext, opts: { fresh?: boolean } = {}): Promise<Today> {
  const now = app.now();
  const s = app.settings.get();
  const tz = s.timeZone;
  const today = localDate(now.toISOString(), tz);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
  const owner = s.ownerName?.trim();
  const greetingKey = hour < 5 ? 'late' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const greeting = `${{ late: 'Up late', morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening' }[greetingKey]}${owner ? `, ${owner}` : ''}`;

  // To-dos due today or overdue (and undated high-priority ones), reminders in the next 24 hours.
  const endOfDay = dayBounds(now, tz).end.getTime();
  const tasks = (app.planner?.tasks({ status: 'open' }) ?? [])
    .filter((t) => (t.dueAt ? Date.parse(t.dueAt) < endOfDay : t.priority === 'high'))
    .sort((a, b) => (a.dueAt ?? '9').localeCompare(b.dueAt ?? '9'))
    .slice(0, 12)
    .map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt, overdue: Boolean(t.dueAt && Date.parse(t.dueAt) < now.getTime()), project: t.project }));
  const reminders = (app.planner?.reminders({ status: 'pending' }) ?? [])
    .filter((r) => Date.parse(r.dueAt) < now.getTime() + 86_400_000)
    .slice(0, 8)
    .map((r) => ({ id: r.id, text: r.text, dueAt: r.dueAt }));

  // Google parts are cached for a couple of minutes (opening Today shouldn't wait on Google twice).
  const key = `${today}|${app.google?.status().email ?? ''}`;
  if (opts.fresh || !cache || cache.key !== key || Date.now() - cache.at > CACHE_MS) {
    const [calendar, mail] = await Promise.all([calendarToday(app, now, tz), mailToday(app)]);
    cache = { at: Date.now(), key, calendar, mail };
  }

  let her: Today['her'];
  if (app.inner && s.persona?.innerLife !== false) {
    const st = app.inner.get(now);
    const ml = moodLabel(st, now, tz);
    her = { name: app.persona.name, mood: ml.mood, energy: ml.energy, expression: expressionFor(st, now, tz, leansPlayful(app.persona.traits)), day: app.life?.get(today) ?? null };
  }
  const memCfg = app.memory && app.settings.get().memory?.enabled !== false;
  const dates = memCfg ? app.memory!.upcoming(today, 14).map((u) => ({ what: u.memory.content, inDays: u.inDays, years: u.years })) : [];

  return {
    date: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(now),
    greeting,
    // H3: the app words it in the owner's language (English text above stays for older clients).
    greetingKey,
    ...(owner ? { owner } : {}),
    day: today,
    agenda: { tasks, reminders },
    ...(cache.calendar ? { calendar: cache.calendar } : {}),
    ...(cache.mail ? { mail: cache.mail } : {}),
    ...(her ? { her } : {}),
    dates,
    jobs: (app.jobs?.running() ?? []).map((j) => ({ id: j.id, label: j.label, startedAt: j.startedAt })),
    ...(app.board ? (() => {
      const b = app.board.today();
      return b.waiting.length || b.doing.length ? { board: b } : {};
    })() : {}),
    ...(app.modelCatalog ? (() => {
      const items = [...app.modelCatalog.notices(3), ...app.modelCatalog.retiredInUse()].slice(0, 5);
      return items.length ? { models: items.map((x) => x.text), modelItems: items } : {};
    })() : {}),
  };
}

/** Forget cached Google parts (tests, and after signing in/out). */
export function clearTodayCache(): void {
  cache = undefined;
}
