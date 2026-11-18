// N7 (docs/WORK_AND_TEAMS.md): time tracking. Entries in the person's own store.db: a running timer
// (one at a time; starting another stops the first), or hours added afterwards (a number of hours on
// a day, or a start and end time). Each entry is rounded to 0.1 h (6 minutes, halves up) once it
// ends, and every sum adds the rounded entries, so a report, an invoice and a time sheet agree.
// Timed entries may not overlap. Billed entries carry their invoice id and are never billed again;
// voiding the invoice frees them (src/work/clients.ts → releaseBilled).
import type { DatabaseSync } from 'node:sqlite';
import { zonedParts, zonedToUtc } from '../planner.ts';

export interface TimeEntry {
  id: number;
  clientId: number | null;
  client: string;
  project: string;
  note: string;
  /** Local date YYYY-MM-DD the work counts on (a timer: the day it started). */
  day: string;
  start: string | null;
  end: string | null;
  /** Rounded to 0.1 h; null while the timer runs. */
  hours: number | null;
  running: boolean;
  /** The invoice it was billed on (null: unbilled). */
  invoiceId: number | null;
  reminderId: number | null;
  createdAt: string;
}

type Row = Record<string, unknown>;
const clip = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const pad = (n: number) => String(n).padStart(2, '0');
/** A warning goes out when a timer has run this long. */
export const LONG_TIMER_HOURS = 10;
const RESERVED = -1;

/** Minutes → hours rounded to 0.1 (6 minutes; 3 minutes rounds up). */
export function roundHours(minutes: number): number {
  return Math.max(0, Math.floor(minutes / 6 + 0.5 + 1e-9)) / 10;
}
/** Adds hours without float dust (each entry is a multiple of 0.1 or 0.25). */
export function sumHours(xs: number[]): number {
  return Math.round(xs.reduce((n, x) => n + Math.round(x * 100), 0)) / 100;
}
/** U4.29: the rounding rule (Settings → You → Business details): a step in minutes, to the nearest or up. */
export const TIME_STEPS = [6, 15, 30, 60] as const;
export const TIME_ROUNDS = ['nearest', 'up'] as const;
export interface TimeRule {
  step: number;
  round: (typeof TIME_ROUNDS)[number];
}
export const DEFAULT_RULE: TimeRule = { step: 6, round: 'nearest' };
/** Minutes → hours by a rule (the default is roundHours: 6 minutes, halves up). */
export function roundBy(minutes: number, rule: TimeRule): number {
  const step = (TIME_STEPS as readonly number[]).includes(rule.step) ? rule.step : 6;
  const n = rule.round === 'up' ? Math.ceil(Math.max(0, minutes) / step - 1e-9) : Math.floor(Math.max(0, minutes) / step + 0.5 + 1e-9);
  return Math.round(n * step * 100 / 60) / 100;
}
/** The rule saved with the business details in the same store.db (default when none). */
export function timeRuleOf(db: DatabaseSync): TimeRule {
  try {
    const r = db.prepare('SELECT json FROM biz_details WHERE id = 1').get() as { json?: string } | undefined;
    const j = r?.json ? (JSON.parse(r.json) as { timeStep?: number; timeRound?: string }) : {};
    return { step: (TIME_STEPS as readonly number[]).includes(Number(j.timeStep)) ? Number(j.timeStep) : 6, round: j.timeRound === 'up' ? 'up' : 'nearest' };
  } catch {
    return DEFAULT_RULE;
  }
}
export function localDayOf(at: Date, tz?: string): string {
  const p = zonedParts(at, tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}
/** \"9\", \"9:30\", \"0930\", \"9am\", \"2:15 pm\" → minutes after midnight. */
export function clockMinutes(s: string): number | undefined {
  const m = /^\s*(\d{1,2})(?::?(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*$/i.exec(s);
  if (!m) return undefined;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase().replace(/\./g, '');
  if (ap) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (ap === 'pm' ? 12 : 0);
  }
  return h < 24 && mi < 60 ? h * 60 + mi : undefined;
}

const toEntry = (r: Row): TimeEntry => ({
  id: Number(r.id),
  clientId: r.client_id == null ? null : Number(r.client_id),
  client: String(r.client),
  project: String(r.project),
  note: String(r.note),
  day: String(r.day),
  start: r.start == null ? null : String(r.start),
  end: r.end == null ? null : String(r.end),
  hours: r.hours == null ? null : Number(r.hours),
  running: r.start != null && r.end == null && r.hours == null,
  invoiceId: r.billed == null || Number(r.billed) === RESERVED ? null : Number(r.billed),
  reminderId: r.reminder_id == null ? null : Number(r.reminder_id),
  createdAt: String(r.created_at),
});

export class TimeStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS work_time (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER, client TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
      day TEXT NOT NULL, start TEXT, end TEXT, hours REAL, billed INTEGER, reminder_id INTEGER, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS work_time_day ON work_time(day);`);
  }

  get(id: number): TimeEntry | undefined {
    const r = this.#db.prepare('SELECT * FROM work_time WHERE id = ?').get(id) as Row | undefined;
    return r ? toEntry(r) : undefined;
  }
  running(): TimeEntry | undefined {
    const r = this.#db.prepare('SELECT * FROM work_time WHERE start IS NOT NULL AND end IS NULL AND hours IS NULL ORDER BY id DESC LIMIT 1').get() as Row | undefined;
    return r ? toEntry(r) : undefined;
  }
  /** Hours so far on the running timer (rounded like a stopped one). */
  runningHours(e: TimeEntry, at = this.#now()): number {
    return roundBy((at.getTime() - Date.parse(e.start!)) / 60_000, timeRuleOf(this.#db));
  }

  /** Starts a timer; a timer that was running stops first (returned as `stopped`). */
  start(o: { clientId?: number | null; client?: string; project?: string; note?: string }, tz?: string): { entry: TimeEntry; stopped?: TimeEntry } {
    const at = this.#now();
    const stopped = this.running() ? this.stop() : undefined;
    const id = Number(
      this.#db.prepare('INSERT INTO work_time (client_id, client, project, note, day, start, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(o.clientId ?? null, clip(o.client, 160), clip(o.project, 120), clip(o.note, 300), localDayOf(at, tz), at.toISOString(), at.toISOString()).lastInsertRowid,
    );
    return { entry: this.get(id)!, ...(stopped ? { stopped } : {}) };
  }
  setReminder(id: number, reminderId: number | null): void {
    this.#db.prepare('UPDATE work_time SET reminder_id = ? WHERE id = ?').run(reminderId, id);
  }
  /** Stops the running timer (undefined: none runs). */
  stop(): TimeEntry | undefined {
    const e = this.running();
    if (!e) return undefined;
    const at = this.#now();
    this.#db.prepare('UPDATE work_time SET end = ?, hours = ? WHERE id = ?').run(at.toISOString(), this.runningHours(e, at), e.id);
    return this.get(e.id);
  }

  /** Timed entries (and the running timer, up to now) that overlap [start, end). */
  overlaps(start: Date, end: Date, except?: number): TimeEntry[] {
    const now = this.#now().toISOString();
    return (this.#db.prepare('SELECT * FROM work_time WHERE start IS NOT NULL AND start < ? AND COALESCE(end, ?) > ? AND id != ?').all(end.toISOString(), now, start.toISOString(), except ?? -1) as Row[]).map(toEntry);
  }

  /** Adds finished work: hours on a day, or a start and end (local clock times on that day). */
  add(o: { day: string; hours?: number; start?: string; end?: string; clientId?: number | null; client?: string; project?: string; note?: string }, tz?: string): TimeEntry {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.day)) throw new Error('Give the day as YYYY-MM-DD.');
    let start: string | null = null;
    let end: string | null = null;
    let hours: number;
    if (o.start !== undefined || o.end !== undefined) {
      const a = clockMinutes(String(o.start ?? ''));
      const b = clockMinutes(String(o.end ?? ''));
      if (a === undefined || b === undefined) throw new Error('Give start and end as clock times, like 9:00 and 11:30.');
      const [y, mo, d] = o.day.split('-').map(Number) as [number, number, number];
      const s = zonedToUtc(y, mo, d, Math.floor(a / 60), a % 60, tz);
      // An end before the start runs past midnight (a night shift).
      let e = zonedToUtc(y, mo, d, Math.floor(b / 60), b % 60, tz);
      if (e.getTime() <= s.getTime()) e = new Date(e.getTime() + 86_400_000);
      const minutes = (e.getTime() - s.getTime()) / 60_000;
      if (minutes > 24 * 60) throw new Error('One entry is at most 24 hours.');
      const clash = this.overlaps(s, e);
      if (clash.length) throw new Error(`That overlaps time already logged (${clash.map((c) => `#${c.id} ${c.client || c.project || 'work'} ${c.day}`).join(', ')}). Change the times or remove that entry first.`);
      start = s.toISOString();
      end = e.toISOString();
      hours = roundBy(minutes, timeRuleOf(this.#db));
    } else {
      const h = Number(o.hours);
      if (!Number.isFinite(h) || h <= 0 || h > 24) throw new Error('Give hours between 0 and 24 (like 2 or 1.5), or a start and end time.');
      hours = roundBy(h * 60, timeRuleOf(this.#db));
      if (hours <= 0) throw new Error('That rounds to 0 hours (see the rounding rule in Settings → You → Business details).');
    }
    const id = Number(
      this.#db
        .prepare('INSERT INTO work_time (client_id, client, project, note, day, start, end, hours, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(o.clientId ?? null, clip(o.client, 160), clip(o.project, 120), clip(o.note, 300), o.day, start, end, hours, this.#now().toISOString()).lastInsertRowid,
    );
    return this.get(id)!;
  }
  remove(id: number): boolean {
    const e = this.get(id);
    if (!e) return false;
    if (e.invoiceId !== null) throw new Error(`Entry #${id} is billed on an invoice; void the invoice first.`);
    return Number(this.#db.prepare('DELETE FROM work_time WHERE id = ?').run(id).changes) > 0;
  }

  /** Entries between two local days (inclusive), oldest first; the running timer is left out. */
  list(o: { from?: string; to?: string } = {}): TimeEntry[] {
    return (this.#db.prepare('SELECT * FROM work_time WHERE day >= ? AND day <= ? AND hours IS NOT NULL ORDER BY day, COALESCE(start, created_at), id').all(o.from ?? '0000-01-01', o.to ?? '9999-12-31') as Row[]).map(toEntry);
  }
  /** Totals by client, project or day (sum of the rounded entries). */
  report(from: string, to: string, by: 'client' | 'project' | 'day' = 'client'): { groups: { key: string; hours: number; entries: number; unbilled: number }[]; hours: number; entries: TimeEntry[] } {
    const entries = this.list({ from, to });
    const keyOf = (e: TimeEntry) => (by === 'day' ? e.day : by === 'project' ? e.project || '(no project)' : e.client || '(no client)');
    const map = new Map<string, TimeEntry[]>();
    for (const e of entries) map.set(keyOf(e), [...(map.get(keyOf(e)) ?? []), e]);
    const groups = [...map.entries()].map(([key, xs]) => ({ key, hours: sumHours(xs.map((x) => x.hours!)), entries: xs.length, unbilled: sumHours(xs.filter((x) => x.invoiceId === null).map((x) => x.hours!)) }));
    groups.sort((a, b) => (by === 'day' ? a.key.localeCompare(b.key) : b.hours - a.hours || a.key.localeCompare(b.key)));
    return { groups, hours: sumHours(entries.map((e) => e.hours!)), entries };
  }
  /** Finished, unbilled entries for a client (by id or folded name), up to a day. */
  unbilled(match: (e: TimeEntry) => boolean, through = '9999-12-31'): TimeEntry[] {
    return (this.#db.prepare('SELECT * FROM work_time WHERE billed IS NULL AND hours IS NOT NULL AND hours > 0 AND day <= ? ORDER BY day, id').all(through) as Row[]).map(toEntry).filter(match);
  }
  /** Holds entries for an invoice being made: only those still unbilled (the count says how many). */
  reserve(ids: number[]): number {
    let n = 0;
    for (const id of ids) n += Number(this.#db.prepare('UPDATE work_time SET billed = ? WHERE id = ? AND billed IS NULL AND hours IS NOT NULL').run(RESERVED, id).changes);
    return n;
  }
  /** The held entries now belong to the invoice (or go back to unbilled when it wasn't made). */
  settle(ids: number[], invoiceId: number | null): void {
    for (const id of ids) this.#db.prepare('UPDATE work_time SET billed = ? WHERE id = ? AND billed = ?').run(invoiceId, id, RESERVED);
  }
  billedOn(invoiceId: number): TimeEntry[] {
    return (this.#db.prepare('SELECT * FROM work_time WHERE billed = ? ORDER BY day, id').all(invoiceId) as Row[]).map(toEntry);
  }

  /** Time sheet source (N2): tracked entries in a week as work \"events\" (hours-only entries start at 9:00). */
  asEvents(week: string[], tz?: string, title = 'work'): { title: string; start: string; end: string; allDay: boolean; id: string }[] {
    const out: { title: string; start: string; end: string; allDay: boolean; id: string }[] = [];
    const byDay = new Map<string, TimeEntry[]>();
    for (const e of this.list({ from: week[0], to: week.at(-1) })) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
    for (const [day, xs] of byDay) {
      // Timed entries keep their times; hours-only ones follow each other from 9:00 (or the last end).
      const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
      let cursor = zonedToUtc(y, mo, d, 9, 0, tz).getTime();
      for (const e of xs.filter((x) => x.start)) {
        out.push({ title, start: e.start!, end: e.end!, allDay: false, id: `time-${e.id}` });
        cursor = Math.max(cursor, Date.parse(e.end!));
      }
      for (const e of xs.filter((x) => !x.start)) {
        const s = cursor;
        cursor += Math.round(e.hours! * 60) * 60_000;
        out.push({ title, start: new Date(s).toISOString(), end: new Date(cursor).toISOString(), allDay: false, id: `time-${e.id}` });
      }
    }
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }
}

const stores = new WeakMap<DatabaseSync, TimeStore>();
export function timeStoreOf(db: DatabaseSync, now?: () => Date): TimeStore {
  let s = stores.get(db);
  if (!s) stores.set(db, (s = new TimeStore(db, now)));
  return s;
}
/** An invoice was voided: its hours are unbilled again. */
export function releaseBilled(db: DatabaseSync, invoiceId: number): number {
  timeStoreOf(db);
  return Number(db.prepare('UPDATE work_time SET billed = NULL WHERE billed = ?').run(invoiceId).changes);
}
