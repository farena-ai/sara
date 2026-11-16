// HANDSFREE 3a (docs/CALENDAR_LINKS.md): "Add a calendar by link". The easiest calendar: the private
// iCal address a calendar app publishes (Google Calendar → Settings → your calendar → Integrate calendar
// → "Secret address in iCal format"; Outlook → Settings → Shared calendars → Publish a calendar → ICS;
// iCloud → Calendar → share → Public Calendar). Read only. The address is a secret (anyone with it can
// read the calendar), so it lives in the vault; only its name and when it was last read are in a plain
// file (vault strings are redacted everywhere). Read again when older than 15 minutes (on demand and on
// the reminder tick); recurring events (RRULE daily/weekly/monthly/yearly, COUNT/UNTIL/INTERVAL/BYDAY,
// EXDATE) are expanded here, since a published calendar isn't a CalDAV server that expands them.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { en } from './i18n.ts';
import { eventsFromIcs, parseIcs } from './mail/caldav.ts';
import type { CalSource } from './mail/calendars.ts';
import type { CalendarEventOut } from './mail/types.ts';
import { netFetch } from './net-guard.ts';

export const CAL_LINK = { max: 10, refreshMs: 15 * 60_000, maxBytes: 5_000_000, maxEvents: 5000 } as const;
export const CAL_LINK_LINES = [en('Give the calendar a name.'), en('That is not a calendar link. Copy the address that ends in .ics (or starts with webcal://).'), en('You have the most calendar links this keeps.'), en('That calendar link didn’t answer like a calendar.'), en('Calendar link not found.')];

export interface CalLinkInfo {
  id: string;
  name: string;
  /** The host only (\"calendar.google.com\"), for the list: never the secret path. */
  host: string;
  addedAt: string;
  lastRead?: string;
  events?: number;
  problem?: string;
}

export class CalLinkError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Vaultish {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
}

/** webcal:// → https://; only http(s) addresses on public hosts (netFetch refuses the rest). */
export function linkUrl(raw: string): URL {
  const s = String(raw ?? '').trim().replace(/^webcals?:\/\//i, 'https://');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new CalLinkError(400, 'That is not a calendar link. Copy the address that ends in .ics (or starts with webcal://).');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new CalLinkError(400, 'That is not a calendar link. Copy the address that ends in .ics (or starts with webcal://).');
  if (u.username || u.password) throw new CalLinkError(400, 'That is not a calendar link. Copy the address that ends in .ics (or starts with webcal://).');
  return u;
}

// ---------------------------------------------------------------- recurring events
const DAY = 86_400_000;
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
function icsDate(v: string): Date | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(v.trim());
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))) : undefined;
}
/**
 * The starts of one recurring event inside [from, to): the first start (as eventsFromIcs read it) moved by
 * the rule in whole days or months, so the wall-clock time in UTC stays (close enough for Today; a DST change
 * moves a repeating event by an hour at most).
 */
export function expandRule(first: Date, rule: string, from: Date, to: Date, exdates: Set<number> = new Set(), cap = 400): Date[] {
  const r: Record<string, string> = {};
  for (const part of rule.split(';')) {
    const [k, v] = part.split('=');
    if (k && v) r[k.toUpperCase()] = v.toUpperCase();
  }
  const freq = r.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return first >= from && first < to ? [first] : [];
  const interval = Math.max(1, Math.min(1000, Number(r.INTERVAL) || 1));
  const count = r.COUNT ? Math.max(1, Math.min(5000, Number(r.COUNT))) : Infinity;
  const until = r.UNTIL ? icsDate(r.UNTIL) : undefined;
  const byDay = freq === 'WEEKLY' && r.BYDAY ? r.BYDAY.split(',').map((d) => WD.indexOf(d.replace(/^[+-]?\d+/, ''))).filter((d) => d >= 0) : [];
  const out: Date[] = [];
  let n = 0;
  const take = (d: Date): boolean => {
    if (until && d > until) return false;
    if (n >= count) return false;
    n++;
    if (d >= from && d < to && !exdates.has(d.getTime())) out.push(d);
    return d < to && out.length < cap;
  };
  if (freq === 'DAILY' || (freq === 'WEEKLY' && !byDay.length)) {
    const step = (freq === 'DAILY' ? 1 : 7) * interval * DAY;
    // Skip ahead without counting when there is no COUNT (COUNT needs every occurrence counted).
    let k = count === Infinity && from > first ? Math.max(0, Math.floor((from.getTime() - first.getTime()) / step) - 1) : 0;
    n = k;
    for (; k < 100_000; k++) if (!take(new Date(first.getTime() + k * step))) break;
    return out;
  }
  if (freq === 'WEEKLY') {
    const weekStart = new Date(first.getTime() - first.getUTCDay() * DAY);
    let w = count === Infinity && from > first ? Math.max(0, Math.floor((from.getTime() - weekStart.getTime()) / (7 * interval * DAY)) - 1) : 0;
    for (; w < 20_000; w++) {
      const base = weekStart.getTime() + w * 7 * interval * DAY;
      let go = true;
      for (const d of [...byDay].sort((a, b) => a - b)) {
        const at = new Date(base + d * DAY + (first.getTime() - weekStart.getTime()) % DAY);
        if (at < first) continue;
        if (!take(at)) {
          go = false;
          break;
        }
      }
      if (!go) break;
    }
    return out;
  }
  for (let k = 0; k < 5000; k++) {
    const d = new Date(first);
    if (freq === 'MONTHLY') d.setUTCMonth(first.getUTCMonth() + k * interval);
    else d.setUTCFullYear(first.getUTCFullYear() + k * interval);
    if (d.getUTCDate() !== first.getUTCDate()) continue; // Jan 31 → no Feb 31
    if (!take(d)) break;
  }
  return out;
}

/** Events of one published calendar inside [from, to), recurring ones expanded, moved occurrences replaced. */
export function linkEvents(ics: string, id: string, from: Date, to: Date, max = 500): CalendarEventOut[] {
  const parsed = parseIcs(ics);
  const base = eventsFromIcs(ics, id);
  const out: CalendarEventOut[] = [];
  // RECURRENCE-ID overrides (a moved or changed occurrence) replace the rule's one at that time.
  const overridden = new Set<string>();
  parsed.forEach((ev, i) => {
    const uid = ev.props.find((p) => p.name === 'UID')?.value ?? '';
    const rid = ev.props.find((p) => p.name === 'RECURRENCE-ID');
    if (rid && base[i]) overridden.add(`${uid}|${icsDate(rid.value)?.getTime() ?? rid.value}`);
  });
  // eventsFromIcs skips cancelled ones, so the two lists are matched by position only when nothing was skipped.
  const usable = parsed.filter((ev) => !/^CANCELLED$/i.test(ev.props.find((p) => p.name === 'STATUS')?.value ?? '') && ev.props.some((p) => p.name === 'DTSTART'));
  usable.forEach((ev, i) => {
    const e = base[i];
    if (!e) return;
    const uid = ev.props.find((p) => p.name === 'UID')?.value ?? `${i}`;
    const rule = ev.props.find((p) => p.name === 'RRULE')?.value;
    const isOverride = ev.props.some((p) => p.name === 'RECURRENCE-ID');
    const start = new Date(e.allDay ? `${e.start}T00:00:00.000Z` : e.start);
    const len = e.end ? new Date(e.allDay ? `${e.end}T00:00:00.000Z` : e.end).getTime() - start.getTime() : 0;
    const emit = (at: Date) => {
      const s = e.allDay ? at.toISOString().slice(0, 10) : at.toISOString();
      const end = len > 0 ? (e.allDay ? new Date(at.getTime() + len).toISOString().slice(0, 10) : new Date(at.getTime() + len).toISOString()) : undefined;
      out.push({ ...e, id: `${id}#${uid}#${at.getTime()}`, start: s, ...(end ? { end } : {}) });
    };
    if (!rule || isOverride) {
      const endAt = start.getTime() + Math.max(len, 1);
      if (endAt > from.getTime() && start < to) emit(start);
      return;
    }
    const ex = new Set<number>();
    for (const p of ev.props.filter((x) => x.name === 'EXDATE')) for (const v of p.value.split(',')) {
      const d = icsDate(v);
      if (d) ex.add(d.getTime());
    }
    // An EXDATE in local time (TZID) matches by day: keep it simple and compare dates only for those.
    const exDays = new Set([...ex].map((t) => new Date(t).toISOString().slice(0, 10)));
    for (const at of expandRule(start, rule, new Date(from.getTime() - Math.max(len, 0)), to)) {
      if (overridden.has(`${uid}|${at.getTime()}`)) continue;
      if (ex.has(at.getTime()) || (ev.props.some((x) => x.name === 'EXDATE' && x.params.TZID) && exDays.has(at.toISOString().slice(0, 10)))) continue;
      emit(at);
    }
  });
  const key = (e: CalendarEventOut) => (e.allDay ? `${e.start}T00:00:00.000Z` : e.start);
  return out.sort((a, b) => key(a).localeCompare(key(b))).slice(0, max);
}

// ---------------------------------------------------------------- the store
export class CalendarLinks {
  readonly #cache = new Map<string, { at: number; text: string }>();
  readonly #inflight = new Map<string, Promise<string>>();
  now = (): number => Date.now();
  fetch: (url: string, init: RequestInit) => Promise<Response> = (u, i) => netFetch(u, i);

  readonly vault: Vaultish;
  readonly file: string;
  constructor(vault: Vaultish, file: string) {
    this.vault = vault;
    this.file = file;
  }

  list(): CalLinkInfo[] {
    if (!existsSync(this.file)) return [];
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as { links?: CalLinkInfo[] };
      return Array.isArray(v.links) ? v.links.filter((l) => l && typeof l.id === 'string' && typeof l.name === 'string') : [];
    } catch {
      return [];
    }
  }
  #save(links: CalLinkInfo[]): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ links }, null, 1));
    renameSync(tmp, this.file);
  }
  #patch(id: string, p: Partial<CalLinkInfo>): void {
    const links = this.list();
    const i = links.findIndex((l) => l.id === id);
    if (i < 0) return;
    links[i] = { ...links[i], ...p };
    if (p.problem === undefined && 'problem' in p) delete links[i].problem;
    this.#save(links);
  }

  /** Reads the link once (it must answer like a calendar) and keeps it. */
  async add(name: string, raw: string, signal?: AbortSignal): Promise<CalLinkInfo> {
    const label = String(name ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60);
    if (!label) throw new CalLinkError(400, 'Give the calendar a name.');
    const u = linkUrl(raw);
    const links = this.list();
    if (links.length >= CAL_LINK.max) throw new CalLinkError(400, 'You have the most calendar links this keeps.');
    const text = await this.#read(u.toString(), signal);
    const id = `cl_${randomUUID().slice(0, 8)}`;
    this.vault.set(`calendar-link:${id}`, u.toString());
    this.#cache.set(id, { at: this.now(), text });
    const info: CalLinkInfo = { id, name: label, host: u.hostname.toLowerCase(), addedAt: new Date(this.now()).toISOString(), lastRead: new Date(this.now()).toISOString(), events: parseIcs(text).length };
    this.#save([...links, info]);
    return info;
  }

  remove(id: string): boolean {
    const links = this.list();
    if (!links.some((l) => l.id === id)) return false;
    this.vault.delete(`calendar-link:${id}`);
    this.#cache.delete(id);
    this.#save(links.filter((l) => l.id !== id));
    return true;
  }

  async #read(url: string, signal?: AbortSignal): Promise<string> {
    let r: Response;
    try {
      r = await this.fetch(url, { headers: { accept: 'text/calendar, text/plain;q=0.5' }, redirect: 'follow', ...(signal ? { signal } : {}) });
    } catch {
      throw new CalLinkError(502, 'That calendar link didn’t answer like a calendar.');
    }
    if (!r.ok) throw new CalLinkError(502, 'That calendar link didn’t answer like a calendar.');
    const text = (await r.text()).slice(0, CAL_LINK.maxBytes);
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new CalLinkError(502, 'That calendar link didn’t answer like a calendar.');
    return text;
  }

  /** The calendar's text, read again when older than 15 minutes (a failed read keeps the last good copy). */
  async text(id: string, signal?: AbortSignal, force = false): Promise<string | undefined> {
    const have = this.#cache.get(id);
    if (have && !force && this.now() - have.at < CAL_LINK.refreshMs) return have.text;
    const url = this.vault.get(`calendar-link:${id}`);
    if (!url) return have?.text;
    let p = this.#inflight.get(id);
    if (!p) {
      p = this.#read(url, signal);
      this.#inflight.set(id, p);
    }
    try {
      const text = await p;
      this.#cache.set(id, { at: this.now(), text });
      this.#patch(id, { lastRead: new Date(this.now()).toISOString(), events: parseIcs(text).length, problem: undefined });
      return text;
    } catch (err) {
      this.#patch(id, { problem: (err as Error).message });
      if (have) return have.text;
      throw err;
    } finally {
      this.#inflight.delete(id);
    }
  }

  /** The reminder tick: links not read in 15 minutes are read again in the background. */
  tick(): void {
    for (const l of this.list()) {
      const have = this.#cache.get(l.id);
      if (have && this.now() - have.at < CAL_LINK.refreshMs) continue;
      void this.text(l.id).catch(() => {});
    }
  }

  /** One read-only calendar source per link, labeled by its name (src/mail/calendars.ts). */
  sources(): CalSource[] {
    return this.list().map((l) => ({
      id: l.id,
      address: l.name,
      kind: 'link' as never,
      events: async (from: Date, to: Date, max: number, signal: AbortSignal, query?: string) => {
        const text = await this.text(l.id, signal);
        if (!text) return [];
        const all = linkEvents(text, l.id, from, to, query ? CAL_LINK.maxEvents : max);
        const q = query?.toLowerCase();
        return (q ? all.filter((e) => `${e.title} ${e.location ?? ''}`.toLowerCase().includes(q)) : all).slice(0, max);
      },
    }));
  }
}
