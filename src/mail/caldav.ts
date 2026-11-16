// MULTIMAIL (docs/MAIL_ACCOUNTS.md): calendars for app-password mailboxes over CalDAV (RFC 4791), with
// the same app password as the mail: iCloud, Fastmail and Yahoo. Gmail app passwords can't open
// Google Calendar (Google wants its own sign-in for that). Small and read-mostly: discovery
// (principal → calendar home → calendars), events in a time range (the server expands repeats),
// add (one VEVENT, PUT) and remove (DELETE). All HTTP through netFetch (public hosts only).
import { randomUUID } from 'node:crypto';
import { netFetch } from '../net-guard.ts';
import { zonedToUtc } from '../planner.ts';
import type { CalendarEventIn, CalendarEventOut } from './types.ts';

/** Where each provider's CalDAV starts (the same app password signs in). */
export const CALDAV_PRESETS: Record<string, string> = {
  icloud: 'https://caldav.icloud.com/',
  fastmail: 'https://caldav.fastmail.com/dav/',
  yahoo: 'https://caldav.calendar.yahoo.com/',
};
export interface CalDavCalendarInfo {
  /** The calendar's address (absolute URL). */
  id: string;
  name: string;
}
export interface CalDavConfig {
  /** Where discovery started. */
  url: string;
  user: string;
  /** The calendars found (refreshed by `discover`). */
  calendars?: CalDavCalendarInfo[];
}
type Fetch = typeof fetch;

const PROP_PRINCIPAL = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
const PROP_HOME = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>';
const PROP_CALS = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop></d:propfind>';
const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const REPORT = (from: Date, to: Date) =>
  `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data><c:expand start="${utcStamp(from)}" end="${utcStamp(to)}"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${utcStamp(from)}" end="${utcStamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;

/** Each <response> of a multistatus: its href and the inner XML. */
function responses(xml: string): { href: string; body: string }[] {
  const out: { href: string; body: string }[] = [];
  for (const m of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/g)) {
    const href = /<(?:[\w-]+:)?href\b[^>]*>([^<]+)<\/(?:[\w-]+:)?href>/.exec(m[1])?.[1]?.trim() ?? '';
    out.push({ href: decodeXml(href), body: m[1] });
  }
  return out;
}
const decodeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;/g, '\r').replace(/&amp;/g, '&');
/** The first href inside an element (current-user-principal, calendar-home-set). */
const hrefIn = (xml: string, tag: string): string | undefined => {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`).exec(xml);
  return m ? (/<(?:[\w-]+:)?href\b[^>]*>([^<]+)</.exec(m[1])?.[1]?.trim() ?? undefined) : undefined;
};

/** Unfolded ICS lines → the VEVENTs as name/params/value lists. */
export function parseIcs(text: string): { props: { name: string; params: Record<string, string>; value: string }[] }[] {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out: { props: { name: string; params: Record<string, string>; value: string }[] }[] = [];
  let cur: (typeof out)[number] | undefined;
  let depth = 0;
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      cur = { props: [] };
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (/^BEGIN:/i.test(line)) depth++;
    else if (/^END:VEVENT$/i.test(line) && depth === 0) {
      out.push(cur);
      cur = undefined;
    } else if (/^END:/i.test(line)) depth--;
    else if (depth === 0) {
      const i = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
      if (i < 0) continue;
      const [name, ...ps] = line.slice(0, i).split(';');
      const params: Record<string, string> = {};
      for (const p of ps) {
        const [k, v] = p.split('=');
        if (k) params[k.toUpperCase()] = (v ?? '').replace(/^"|"$/g, '');
      }
      cur.props.push({ name: name.toUpperCase(), params, value: line.slice(i + 1) });
    }
  }
  return out;
}
const unescapeText = (s: string) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');

/** DTSTART/DTEND → ISO time, or YYYY-MM-DD for a date. */
function icsTime(p: { params: Record<string, string>; value: string } | undefined): { at: string; allDay: boolean } | undefined {
  if (!p) return undefined;
  const v = p.value.trim();
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (d || p.params.VALUE === 'DATE') return d ? { at: `${d[1]}-${d[2]}-${d[3]}`, allDay: true } : undefined;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return undefined;
  const [y, mo, dd, h, mi, s] = m.slice(1, 7).map(Number);
  if (m[7] === 'Z') return { at: new Date(Date.UTC(y, mo - 1, dd, h, mi, s)).toISOString(), allDay: false };
  const tz = p.params.TZID;
  return { at: (tz ? new Date(zonedToUtc(y, mo, dd, h, mi, tz).getTime() + s * 1000) : new Date(Date.UTC(y, mo - 1, dd, h, mi, s))).toISOString(), allDay: false };
}

export function eventsFromIcs(text: string, href: string): CalendarEventOut[] {
  const out: CalendarEventOut[] = [];
  for (const ev of parseIcs(text)) {
    const get = (n: string) => ev.props.find((x) => x.name === n);
    if (/^CANCELLED$/i.test(get('STATUS')?.value ?? '')) continue;
    const start = icsTime(get('DTSTART'));
    if (!start) continue;
    const end = icsTime(get('DTEND'));
    const rid = get('RECURRENCE-ID')?.value;
    const attendees = ev.props.filter((x) => x.name === 'ATTENDEE').map((x) => x.value.replace(/^mailto:/i, '')).filter(Boolean);
    out.push({
      id: rid ? `${href}#${rid}` : href,
      title: unescapeText(get('SUMMARY')?.value ?? '') || '(no title)',
      start: start.at,
      ...(end ? { end: end.at } : {}),
      allDay: start.allDay,
      ...(get('LOCATION')?.value ? { location: unescapeText(get('LOCATION')!.value) } : {}),
      ...(attendees.length ? { attendees } : {}),
    });
  }
  return out;
}

/** One VEVENT for a new event (wall times in the owner's zone, or all-day dates). */
export function icsFor(e: CalendarEventIn, uid: string, now = new Date()): string {
  const wall = (v: string) => v.replace(/[-:]/g, '').slice(0, 13) + '00';
  const date = (v: string) => v.replace(/-/g, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sara//Calendar//EN', 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utcStamp(now)}`];
  if (e.allDay) lines.push(`DTSTART;VALUE=DATE:${date(e.start)}`, ...(e.end ? [`DTEND;VALUE=DATE:${date(e.end)}`] : []));
  else lines.push(`DTSTART;TZID=${e.timeZone}:${wall(e.start)}`, ...(e.end ? [`DTEND;TZID=${e.timeZone}:${wall(e.end)}`] : []));
  lines.push(`SUMMARY:${escapeText(e.title)}`);
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
  if (e.notes) lines.push(`DESCRIPTION:${escapeText(e.notes)}`);
  for (const g of e.guests) lines.push(`ATTENDEE;RSVP=TRUE:mailto:${g.replace(/[\r\n:;]/g, '')}`);
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.join('\r\n');
}

export class CalDav {
  readonly #cfg: CalDavConfig;
  readonly #password: () => string | undefined;
  readonly #fetch: Fetch;
  /** The calendars to read (ids); undefined: every calendar found. */
  readonly #chosen: () => string[] | undefined;

  constructor(cfg: CalDavConfig, password: () => string | undefined, opts: { fetch?: Fetch; chosen?: () => string[] | undefined } = {}) {
    this.#cfg = cfg;
    this.#password = password;
    this.#fetch = opts.fetch ?? netFetch;
    this.#chosen = opts.chosen ?? (() => undefined);
  }

  async #req(method: string, url: string, body?: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<{ status: number; text: string; url: string }> {
    const pass = this.#password();
    if (!pass) throw new Error('The app password for this mailbox is missing. Add the account again in Settings → Email and calendar.');
    let target = url;
    // Follow redirects by hand (well-known → the real DAV root; iCloud → the user's partition).
    for (let i = 0; i < 4; i++) {
      const r = await this.#fetch(target, { method, redirect: 'manual', headers: { authorization: `Basic ${Buffer.from(`${this.#cfg.user}:${pass}`).toString('base64')}`, ...(body ? { 'content-type': method === 'PUT' ? 'text/calendar; charset=utf-8' : 'application/xml; charset=utf-8' } : {}), ...headers }, ...(body ? { body } : {}), signal: signal ?? AbortSignal.timeout(20_000) });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        target = new URL(r.headers.get('location')!, target).toString();
        continue;
      }
      const text = await r.text().catch(() => '');
      if (r.status === 401 || r.status === 403) throw new Error('The calendar server did not accept the app password.');
      if (r.status >= 400) throw new Error(`The calendar server answered ${r.status}.`);
      return { status: r.status, text, url: target };
    }
    throw new Error('The calendar server sent Sara around in circles.');
  }

  /** Finds the calendars (the Turn on calendar button): principal → home → each calendar. */
  async discover(signal?: AbortSignal): Promise<CalDavCalendarInfo[]> {
    const p = await this.#req('PROPFIND', this.#cfg.url, PROP_PRINCIPAL, { depth: '0' }, signal);
    const principal = new URL(hrefIn(p.text, 'current-user-principal') ?? p.url, p.url).toString();
    const h = await this.#req('PROPFIND', principal, PROP_HOME, { depth: '0' }, signal);
    const homeHref = hrefIn(h.text, 'calendar-home-set');
    if (!homeHref) throw new Error('This account has no calendars Sara can find.');
    const home = new URL(homeHref, h.url).toString();
    const c = await this.#req('PROPFIND', home, PROP_CALS, { depth: '1' }, signal);
    const cals: CalDavCalendarInfo[] = [];
    for (const r of responses(c.text)) {
      if (!/<(?:[\w-]+:)?calendar\s*\/>/.test(r.body)) continue;
      const comps = /supported-calendar-component-set[\s\S]*?<\/(?:[\w-]+:)?supported-calendar-component-set>/.exec(r.body)?.[0];
      if (comps && !/name="VEVENT"/i.test(comps)) continue;
      const name = decodeXml(/<(?:[\w-]+:)?displayname\b[^>]*>([^<]*)</.exec(r.body)?.[1]?.trim() ?? '');
      cals.push({ id: new URL(r.href, c.url).toString(), name: name || (r.href.split('/').filter(Boolean).pop() ?? 'Calendar') });
    }
    if (!cals.length) throw new Error('This account has no calendars Sara can find.');
    this.#cfg.calendars = cals;
    return cals;
  }

  calendars(): CalDavCalendarInfo[] {
    return this.#cfg.calendars ?? [];
  }
  #reading(): CalDavCalendarInfo[] {
    const want = this.#chosen();
    const all = this.calendars();
    return want ? all.filter((c) => want.includes(c.id)) : all;
  }

  async events(from: Date, to: Date, query: string | undefined, signal?: AbortSignal): Promise<CalendarEventOut[]> {
    const out: CalendarEventOut[] = [];
    for (const cal of this.#reading()) {
      const r = await this.#req('REPORT', cal.id, REPORT(from, to), { depth: '1' }, signal);
      for (const x of responses(r.text)) {
        const data = /<(?:[\w-]+:)?calendar-data\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?calendar-data>/.exec(x.body)?.[1];
        if (!data) continue;
        const ics = decodeXml(data.replace(/^<!\[CDATA\[|\]\]>$/g, ''));
        for (const e of eventsFromIcs(ics, new URL(x.href, r.url).toString())) out.push(e);
      }
    }
    const q = query?.trim().toLowerCase();
    return out.filter((e) => !q || `${e.title} ${e.location ?? ''}`.toLowerCase().includes(q)).sort((a, b) => a.start.localeCompare(b.start));
  }

  /** Adds an event to `calendar` (an id from `calendars()`; default: the first chosen one). */
  async add(e: CalendarEventIn, signal?: AbortSignal, calendar?: string): Promise<CalendarEventOut> {
    const cal = this.calendars().find((c) => c.id === calendar) ?? this.#reading()[0] ?? this.calendars()[0];
    if (!cal) throw new Error('This account has no calendars Sara can find.');
    const uid = `${randomUUID()}@sara`;
    const href = new URL(`${encodeURIComponent(uid)}.ics`, cal.id.endsWith('/') ? cal.id : `${cal.id}/`).toString();
    await this.#req('PUT', href, icsFor(e, uid), { 'if-none-match': '*' }, signal);
    return { id: href, title: e.title, start: e.start, ...(e.end ? { end: e.end } : {}), allDay: e.allDay, ...(e.location ? { location: e.location } : {}) };
  }
  async update(): Promise<CalendarEventOut> {
    throw new Error('Changing an event works for Outlook calendars. For this calendar, remove it and add it again.');
  }
  async remove(id: string, signal?: AbortSignal): Promise<void> {
    const href = id.split('#')[0];
    const known = this.calendars().some((c) => href.startsWith(c.id.endsWith('/') ? c.id : `${c.id}/`));
    if (!known) throw new Error('That event is not on one of this account\'s calendars.');
    await this.#req('DELETE', href, undefined, {}, signal);
  }
}
