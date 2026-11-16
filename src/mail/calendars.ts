// MULTIMAIL (docs/MAIL_ACCOUNTS.md): every calendar Sara reads, from every account: each Google
// sign-in (the calendars chosen for it, else its main one), each Outlook / Microsoft 365 account
// (its main calendar) and each app-password mailbox with CalDAV turned on (iCloud, Fastmail,
// Yahoo). Today, the briefing, leave-by, the weekly review, the calendar tools and the booking
// page's free/busy read them together; each event says which account it came from.
import type { AppContext } from '../chat.ts';
import type { GoogleAccount } from '../google.ts';
import type { CalendarEventOut, MailAccountInfo } from './types.ts';

export interface CalSource {
  /** The account id ('google', 'google:2', 'ms_…', 'im_…'). */
  id: string;
  address: string;
  kind: MailAccountInfo['kind'];
  events(from: Date, to: Date, max: number, signal: AbortSignal, query?: string): Promise<CalendarEventOut[]>;
}
export type LabeledEvent = CalendarEventOut & { account?: string; accountId?: string };

type Accts = NonNullable<AppContext['mailAccounts']>;
const GCAL = 'https://www.googleapis.com/calendar/v3/calendars';
type GItem = { id: string; summary?: string; status?: string; location?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; attendees?: { email: string }[] };

/** One Google account's chosen calendars (default: its main one). */
export function googleSource(g: GoogleAccount, chosen: string[] | undefined): CalSource | undefined {
  const st = g.status();
  if (!st.connected || !st.calendar) return undefined;
  const ids = chosen ?? ['primary'];
  if (!ids.length) return undefined;
  return {
    id: g.id,
    address: st.email ?? 'Google',
    kind: 'google',
    async events(from, to, max, signal, query) {
      const all: CalendarEventOut[] = [];
      for (const cal of ids) {
        const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: String(max), ...(query ? { q: query } : {}) });
        const r = (await g.api(`${GCAL}/${cal === 'primary' ? 'primary' : encodeURIComponent(cal)}/events?${q}`, { signal })) as { items?: GItem[] };
        for (const e of r.items ?? []) {
          if (e.status === 'cancelled') continue;
          all.push({ id: e.id, title: e.summary ?? '(no title)', start: e.start?.dateTime ?? e.start?.date ?? '', ...(e.end?.dateTime || e.end?.date ? { end: e.end.dateTime ?? e.end.date } : {}), allDay: !e.start?.dateTime, ...(e.location ? { location: e.location } : {}), ...(e.attendees?.length ? { attendees: e.attendees.map((x) => x.email) } : {}) });
        }
      }
      return all;
    },
  };
}

/** Every calendar source of this person, in account order (Google first, as in the account list). */
export function calendarSources(app: { google?: AppContext['google']; mailAccounts?: AppContext['mailAccounts']; member?: unknown }): CalSource[] {
  const accts = app.mailAccounts as (Accts & Partial<Pick<Accts, 'googleAccounts' | 'chosenCalendars'>>) | undefined;
  const out: CalSource[] = [];
  const chosen = (id: string) => (typeof accts?.chosenCalendars === 'function' ? accts.chosenCalendars(id) : undefined);
  // Google's sign-in is the owner's: a member's sources never include it.
  const googles: GoogleAccount[] = app.member ? [] : typeof accts?.googleAccounts === 'function' ? accts.googleAccounts() : app.google?.status().connected ? [app.google] : [];
  for (const g of googles) {
    const s = googleSource(g, chosen(g.id));
    if (s) out.push(s);
  }
  for (const a of accts?.list() ?? []) {
    if (a.kind === 'google' || !a.calendar || a.problem) continue;
    const c = chosen(a.id);
    if (c && !c.length) continue;
    out.push({
      id: a.id,
      address: a.address,
      kind: a.kind,
      async events(from, to, max, signal, query) {
        const cal = accts!.provider(a.id).calendar;
        return cal ? (await cal.events(from, to, query, signal)).slice(0, max) : [];
      },
    });
  }
  // HANDSFREE 3a: calendars added by link (read only), labeled by the name the person gave them.
  const links = (accts as { calendarLinks?: { sources(): CalSource[] } } | undefined)?.calendarLinks;
  if (links && typeof links.sources === 'function') out.push(...links.sources());
  return out;
}

/**
 * Events from every source, sorted by start, each with its account (only when there is more than
 * one source, so a single calendar reads exactly as before). One source failing doesn't hide the
 * others; all failing throws the first error.
 */
export async function allEvents(sources: CalSource[], from: Date, to: Date, max: number, signal: AbortSignal, query?: string): Promise<{ events: LabeledEvent[]; errors: { address: string; error: string }[] }> {
  const res = await Promise.allSettled(sources.map((s) => s.events(from, to, max, signal, query)));
  const events: LabeledEvent[] = [];
  const errors: { address: string; error: string }[] = [];
  res.forEach((r, i) => {
    const s = sources[i];
    if (r.status === 'rejected') errors.push({ address: s.address, error: (r.reason as Error)?.message ?? String(r.reason) });
    else for (const e of r.value) events.push(sources.length > 1 ? { ...e, account: s.address, accountId: s.id } : e);
  });
  if (sources.length && errors.length === sources.length) throw new Error(errors[0].error);
  const key = (e: LabeledEvent) => (/^\d{4}-\d{2}-\d{2}$/.test(e.start) ? `${e.start}T00:00:00.000Z` : new Date(e.start).toISOString());
  events.sort((a, b) => key(a).localeCompare(key(b)));
  return { events: events.slice(0, max), errors };
}
