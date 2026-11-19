// V4.3 (docs/HEALTH.md "Imports"): readers for the health exports people already have.
//
//   Apple Health   export.zip (apple_health_export/export.xml) or the bare export.xml
//   Google Takeout Fit: "Daily activity metrics.csv" (or its per-day files) + "All Sessions" sleep JSON
//   Garmin         CSV reports from Garmin Connect (steps, sleep, weight) and .fit files (monitoring,
//                  weight scale, activity heart rate), alone or zipped
//
// Each reader turns a file into daily readings of five measurements: steps, sleep (hours), heart rate
// (daily average), resting heart rate and weight (each weighing keeps its own time). The file is read
// in memory and never written anywhere; src/health-log.ts `importReadings` seals and dedupes the result.
// Pure functions: no network, no disk.
import { en } from './i18n.ts';
import { HealthError } from './health-log.ts';
import { zonedParts, zonedToUtc } from './planner.ts';
import { ReadError } from './library/read.ts';
import { openZip, type Zip } from './library/zip.ts';

export type Metric = 'steps' | 'sleep' | 'heart rate' | 'resting heart rate' | 'weight';
export const METRICS: readonly Metric[] = ['steps', 'sleep', 'heart rate', 'resting heart rate', 'weight'];
export const UNIT: Record<Metric, string> = { steps: 'steps', sleep: 'h', 'heart rate': 'bpm', 'resting heart rate': 'bpm', weight: 'kg' };
export type ImportSource = 'apple' | 'google' | 'garmin';
export interface Reading {
  metric: Metric;
  /** The person's local day (YYYY-MM-DD). */
  day: string;
  /** Weight only: when it was weighed (ISO). */
  at?: string;
  value: number;
  unit: string;
}
export interface ReadResult {
  source: ImportSource;
  readings: Reading[];
}

const NONE = en('She can read an Apple Health export (export.zip or export.xml), a Google Takeout Fit export, or Garmin CSV and .fit files. This file is none of those.');
const EMPTY = en('This file has no steps, sleep, heart rate or weight she can read.');
const z2 = (n: number) => String(n).padStart(2, '0');
const localDay = (ms: number, tz?: string) => {
  const p = zonedParts(new Date(ms), tz);
  return `${p.y}-${z2(p.mo)}-${z2(p.d)}`;
};
const round = (m: Metric, v: number) => (m === 'steps' ? Math.round(v) : m === 'heart rate' || m === 'resting heart rate' ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100);

/** Daily totals/averages, collected then turned into readings. */
class Days {
  readonly #sum = new Map<string, number>();
  readonly #avg = new Map<string, { s: number; n: number }>();
  readonly weights: Reading[] = [];
  add(m: Exclude<Metric, 'weight'>, day: string, v: number): void {
    if (!Number.isFinite(v) || v <= 0) return;
    const k = `${m}|${day}`;
    if (m === 'steps' || m === 'sleep') this.#sum.set(k, (this.#sum.get(k) ?? 0) + v);
    else {
      const a = this.#avg.get(k) ?? { s: 0, n: 0 };
      a.s += v;
      a.n++;
      this.#avg.set(k, a);
    }
  }
  /** Steps that are already a day total (a source's own sum): keep the bigger of two sources. */
  max(m: Metric, day: string, v: number): void {
    if (!Number.isFinite(v) || v <= 0) return;
    const k = `${m}|${day}`;
    this.#sum.set(k, Math.max(this.#sum.get(k) ?? 0, v));
  }
  weight(day: string, at: string, v: number, unit: string): void {
    if (!Number.isFinite(v) || v <= 0 || this.weights.some((w) => w.at === at)) return;
    this.weights.push({ metric: 'weight', day, at, value: round('weight', v), unit });
  }
  readings(): Reading[] {
    const out: Reading[] = [];
    for (const [k, v] of this.#sum) {
      const [m, day] = k.split('|') as [Metric, string];
      out.push({ metric: m, day, value: round(m, v), unit: UNIT[m] });
    }
    for (const [k, a] of this.#avg) {
      const [m, day] = k.split('|') as [Metric, string];
      out.push({ metric: m, day, value: round(m, a.s / a.n), unit: UNIT[m] });
    }
    return [...out, ...this.weights];
  }
}

const order = (rs: Reading[]) => rs.sort((a, b) => METRICS.indexOf(a.metric) - METRICS.indexOf(b.metric) || a.day.localeCompare(b.day) || (a.at ?? '').localeCompare(b.at ?? ''));

// ------------------------------------------------------------------------------------------------
// Apple Health export.xml (read straight from the bytes: real exports are often bigger than a string)
// ------------------------------------------------------------------------------------------------

const APPLE_TYPES: Record<string, Metric> = {
  HKQuantityTypeIdentifierStepCount: 'steps',
  HKQuantityTypeIdentifierHeartRate: 'heart rate',
  HKQuantityTypeIdentifierRestingHeartRate: 'resting heart rate',
  HKQuantityTypeIdentifierBodyMass: 'weight',
  HKCategoryTypeIdentifierSleepAnalysis: 'sleep',
};
/** "2026-11-01 07:30:00 -0600" → ms (the written day is the person's local day). */
const appleMs = (s: string) => Date.parse(s.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ?([+-]\d{2})(\d{2})$/, '$1T$2$3:$4'));
const decodeAttr = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e.toLowerCase() as 'amp'] ?? (e[1]?.toLowerCase() === 'x' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e[0] === '#' ? String.fromCodePoint(Number(e.slice(1))) : m));

export function readAppleXml(buf: Buffer): Reading[] {
  const days = new Days();
  const steps = new Map<string, number>(); // day|source → sum
  const sleep = new Map<string, { asleep: [number, number][]; bed: [number, number][] }>();
  const OPEN = Buffer.from('<Record ');
  let pos = 0;
  for (;;) {
    const at = buf.indexOf(OPEN, pos);
    if (at < 0) break;
    const end = buf.indexOf(0x3e, at); // '>'
    if (end < 0) break;
    pos = end + 1;
    const tag = buf.toString('utf8', at, end);
    const type = /\stype="([^"]+)"/.exec(tag)?.[1] ?? '';
    const m = APPLE_TYPES[type];
    if (!m) continue;
    const a: Record<string, string> = {};
    for (const x of tag.matchAll(/(\w+)="([^"]*)"/g)) a[x[1]] = decodeAttr(x[2]);
    const start = a.startDate ?? '';
    const stop = a.endDate ?? start;
    const day = start.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const v = Number(a.value);
    if (m === 'steps') steps.set(`${day}|${a.sourceName ?? ''}`, (steps.get(`${day}|${a.sourceName ?? ''}`) ?? 0) + (Number.isFinite(v) ? v : 0));
    else if (m === 'heart rate' || m === 'resting heart rate') days.add(m, day, v);
    else if (m === 'weight') {
      const ms = appleMs(start);
      if (Number.isNaN(ms)) continue;
      const unit = /^lb/i.test(a.unit ?? '') ? 'lb' : /^kg$/i.test(a.unit ?? '') ? 'kg' : a.unit === 'g' ? 'g' : '';
      if (!unit) continue;
      days.weight(day, new Date(ms).toISOString(), unit === 'g' ? v / 1000 : v, unit === 'g' ? 'kg' : unit);
    } else {
      const s = appleMs(start);
      const e = appleMs(stop);
      if (Number.isNaN(s) || Number.isNaN(e) || e <= s) continue;
      const night = stop.slice(0, 10);
      const n = sleep.get(night) ?? { asleep: [], bed: [] };
      if (/Asleep/i.test(a.value ?? '')) n.asleep.push([s, e]);
      else if (/InBed/i.test(a.value ?? '')) n.bed.push([s, e]);
      sleep.set(night, n);
    }
  }
  for (const [k, v] of steps) days.max('steps', k.split('|')[0], v);
  for (const [night, n] of sleep) {
    const hours = union(n.asleep.length ? n.asleep : n.bed) / 3_600_000;
    if (hours > 0) days.max('sleep', night, hours);
  }
  return days.readings();
}

/** Total time covered by intervals (overlaps counted once). */
function union(iv: [number, number][]): number {
  let total = 0;
  let cur: [number, number] | undefined;
  for (const [s, e] of [...iv].sort((x, y) => x[0] - y[0])) {
    if (!cur || s > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [s, e];
    } else cur[1] = Math.max(cur[1], e);
  }
  return total + (cur ? cur[1] - cur[0] : 0);
}

// ------------------------------------------------------------------------------------------------
// CSV (Google Fit daily metrics, Garmin Connect reports)
// ------------------------------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const s = text.replace(/^\uFEFF/, '');
  const first = s.slice(0, s.indexOf('\n') < 0 ? s.length : s.indexOf('\n'));
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : first.includes('\t') && !first.includes(',') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      row.push(cell.trim());
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell.trim());
      if (row.some((x) => x)) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell.trim());
  if (row.some((x) => x)) rows.push(row);
  return rows;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ymd = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${z2(m)}-${z2(d)}` : undefined);
/** A day from the date formats exports use (ISO, 11/05/2026, Nov 5, 2026, 5 Nov 2026, 05.11.2026). */
export function parseDay(raw: string): string | undefined {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return ymd(+m[3], +m[1], +m[2]);
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (m) return ymd(+m[3], +m[2], +m[1]);
  m = /^(?:\w{3},? )?([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/.exec(s);
  if (m && MONTHS.includes(m[1].toLowerCase())) return ymd(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  m = /^(\d{1,2}) ([A-Za-z]{3})[a-z]*\.? (\d{4})/.exec(s);
  if (m && MONTHS.includes(m[2].toLowerCase())) return ymd(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  return undefined;
}
/** "7:02 AM" / "19:05" after a date, or alone. */
const timeOf = (s: string) => {
  const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?\s*$/i.exec(s.trim());
  if (!m) return undefined;
  let h = Number(m[1]);
  if (m[3]) h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0);
  return h < 24 ? { h, mi: Number(m[2]) } : undefined;
};
/** "9,876" → 9876, "78,2" → 78.2, "175.2 lbs" → 175.2, "--" → NaN. */
export function numberOf(raw: string): number {
  let s = raw.trim().replace(/[^\d.,-]+$/g, '').replace(/^[^\d-]+/, '');
  if (!s || s === '-' || s === '--') return Number.NaN;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : Number.NaN;
}
/** Sleep length in hours: "7h 32min", "7:32", "452" minutes, "7.5". */
function hoursOf(raw: string, header: string): number {
  const s = raw.trim().toLowerCase();
  let m = /^(\d{1,2})\s*h(?:ours?|rs?)?\s*(?:(\d{1,2})\s*m(?:in(?:utes?)?)?)?$/.exec(s);
  if (m) return Number(m[1]) + Number(m[2] ?? 0) / 60;
  m = /^(\d{1,2})\s*m(?:in)?$/.exec(s);
  if (m) return Number(m[1]) / 60;
  m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (m) return Number(m[1]) + Number(m[2]) / 60;
  const n = numberOf(s);
  if (/\(ms\)|millis/.test(header)) return n / 3_600_000;
  if (/\(min|minutes/.test(header) || n > 24) return n / 60;
  return n;
}

type Col = Metric | 'date' | undefined;
function colKind(h: string, sleepFile: boolean, stepsFile: boolean): Col {
  const s = h.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^(date|day|calendar date|time|start|start time|date\/time|timestamp|datum|fecha)$/.test(s)) return 'date';
  if (/\b(max|min|maximum|minimum|goal|change|need|score|bmi|fat|calories|distance|speed|points|move minutes|heart minutes|battery|quality|bedtime|wake)\b/.test(s)) return undefined;
  if (/resting/.test(s) && /heart|\bhr\b|pulse/.test(s)) return 'resting heart rate';
  if (/^(total )?steps?$|step count|^steps? \(/.test(s) || (stepsFile && /^actual$/.test(s))) return 'steps';
  if (/heart rate|\bhr\b|pulse/.test(s)) return 'heart rate';
  if (/weight/.test(s)) return 'weight';
  if (/^(total )?sleep( time| duration)?( \(.*\))?$|time asleep|^asleep$/.test(s) || (sleepFile && /^(total )?duration\b/.test(s))) return 'sleep';
  return undefined;
}

/** One CSV file into the day collector (`fileDay`: Google's per-day files have no date column). */
function readCsv(text: string, name: string, days: Days, tz?: string): void {
  const rows = parseCsv(text);
  if (rows.length < 2) return;
  const head = rows[0];
  const base = name.toLowerCase().split('/').pop() ?? '';
  const sleepFile = /sleep/.test(base) || head.some((h) => /bedtime|wake time/i.test(h));
  const kinds = head.map((h) => colKind(h, sleepFile, /step/.test(base)));
  const dateCol = kinds.indexOf('date');
  const fileDay = parseDay(base.replace(/\.csv$/, ''));
  if (dateCol < 0 && !fileDay) return;
  let lastDay: string | undefined;
  for (const row of rows.slice(1)) {
    let day = dateCol < 0 ? fileDay : parseDay(row[dateCol] ?? '');
    const time = dateCol < 0 ? undefined : timeOf(row[dateCol] ?? '');
    if (!day && time && lastDay) day = lastDay; // Garmin weight: a date row, then its times
    if (!day) continue;
    lastDay = day;
    kinds.forEach((k, i) => {
      if (!k || k === 'date') return;
      const cell = row[i] ?? '';
      if (k === 'weight') {
        const v = numberOf(cell);
        const unit = /lb/i.test(cell) || /\(lbs?\)|\blbs?\b/i.test(head[i]) ? 'lb' : 'kg';
        const [y, mo, d] = day!.split('-').map(Number);
        const at = time ? zonedToUtc(y, mo, d, time.h, time.mi, tz).toISOString() : `${day}T12:00:00.000Z`;
        days.weight(day!, at, v, unit);
      } else if (k === 'sleep') days.add('sleep', day!, hoursOf(cell, head[i].toLowerCase()));
      else days.add(k, day!, numberOf(cell));
    });
  }
}

/** Google Fit "All Sessions" JSON: sleep sessions count for the local day she woke up. */
function readGoogleSession(text: string, days: Days, tz?: string): boolean {
  let j: { fitnessActivity?: string; startTime?: string; endTime?: string; startTimeMillis?: string; endTimeMillis?: string };
  try {
    j = JSON.parse(text);
  } catch {
    return false;
  }
  if (!j || typeof j !== 'object' || typeof j.fitnessActivity !== 'string') return false;
  if (!/^sleep/i.test(j.fitnessActivity)) return true;
  const s = j.startTime ? Date.parse(j.startTime) : Number(j.startTimeMillis);
  const e = j.endTime ? Date.parse(j.endTime) : Number(j.endTimeMillis);
  if (Number.isFinite(s) && Number.isFinite(e) && e > s) days.add('sleep', localDay(e, tz), (e - s) / 3_600_000);
  return true;
}

// ------------------------------------------------------------------------------------------------
// FIT (Garmin's binary format): monitoring, weight scale and activity heart rate
// ------------------------------------------------------------------------------------------------

const FIT_EPOCH = 631_065_600; // 1989-12-31T00:00:00Z in Unix seconds
interface FitField { num: number; size: number; base: number }
interface FitDef { global: number; little: boolean; fields: FitField[]; devBytes: number }
const INVALID: Record<number, number> = { 0x00: 0xff, 0x01: 0x7f, 0x02: 0xff, 0x83: 0x7fff, 0x84: 0xffff, 0x85: 0x7fffffff, 0x86: 0xffffffff, 0x0a: 0, 0x8b: 0, 0x8c: 0 };

export const isFit = (b: Buffer) => b.length >= 14 && b.toString('latin1', 8, 12) === '.FIT';

/** Readings from one .fit file (monitoring steps and heart rate, weight scale, record heart rate). */
export function readFit(buf: Buffer, tz?: string, days = new Days()): Reading[] {
  if (!isFit(buf)) throw new HealthError(400, NONE);
  const hs = buf[0];
  const end = Math.min(buf.length, hs + buf.readUInt32LE(4));
  const defs = new Map<number, FitDef>();
  const steps = new Map<string, number>(); // day|activity → cumulative max
  let p = hs;
  let last = 0;
  const value = (d: FitDef, f: FitField, o: number): number | undefined => {
    if (![1, 2, 4].includes(f.size) || o + f.size > end) return undefined;
    const v = f.size === 1 ? buf.readUInt8(o) : f.size === 2 ? (d.little ? buf.readUInt16LE(o) : buf.readUInt16BE(o)) : d.little ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
    const inv = INVALID[f.base];
    return inv !== undefined && v === inv ? undefined : v;
  };
  try {
    while (p < end) {
      const h = buf[p++];
      if (h & 0x40 && !(h & 0x80)) {
        const little = buf[p + 1] === 0;
        const global = little ? buf.readUInt16LE(p + 2) : buf.readUInt16BE(p + 2);
        const n = buf[p + 4];
        p += 5;
        const fields: FitField[] = [];
        for (let i = 0; i < n; i++, p += 3) fields.push({ num: buf[p], size: buf[p + 1], base: buf[p + 2] });
        let devBytes = 0;
        if (h & 0x20) {
          const nd = buf[p++];
          for (let i = 0; i < nd; i++, p += 3) devBytes += buf[p + 1];
        }
        defs.set(h & 0x0f, { global, little, fields, devBytes });
        continue;
      }
      const compressed = (h & 0x80) !== 0;
      const def = defs.get(compressed ? (h >> 5) & 0x03 : h & 0x0f);
      if (!def) break;
      const got: Record<number, number | undefined> = {};
      for (const f of def.fields) {
        got[f.num] = value(def, f, p);
        p += f.size;
      }
      p += def.devBytes;
      if (got[253] !== undefined) last = got[253]!;
      else if (compressed && last) {
        const off = h & 0x1f;
        last += (off - (last & 0x1f)) & 0x1f;
      } else if (got[26] !== undefined && last) last += (got[26]! - (last & 0xffff)) & 0xffff; // timestamp_16
      if (!last) continue;
      const ms = (last + FIT_EPOCH) * 1000;
      const day = localDay(ms, tz);
      if (def.global === 55) {
        // monitoring: cycles (3) are steps when walking (6) or running (1), cumulative through the day
        const act = got[5];
        if (got[3] !== undefined && (act === 6 || act === 1)) steps.set(`${day}|${act}`, Math.max(steps.get(`${day}|${act}`) ?? 0, got[3]!));
        if (got[27] !== undefined) days.add('heart rate', day, got[27]!);
      } else if (def.global === 20 && got[3] !== undefined) days.add('heart rate', day, got[3]!);
      else if (def.global === 30 && got[0] !== undefined) days.weight(day, new Date(ms).toISOString(), got[0]! / 100, 'kg');
    }
  } catch {
    /* a cut-off file: keep what was read */
  }
  const perDay = new Map<string, number>();
  for (const [k, v] of steps) perDay.set(k.split('|')[0], (perDay.get(k.split('|')[0]) ?? 0) + v);
  for (const [d, v] of perDay) days.max('steps', d, v);
  return order(days.readings());
}

// ------------------------------------------------------------------------------------------------
// The entry point
// ------------------------------------------------------------------------------------------------

const ZIP_LIMITS = { maxEntries: 200_000, maxEntryBytes: 1_500_000_000, maxTotalBytes: 2_000_000_000, maxRatio: 400 };
const isZip = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const text = (b: Buffer) => b.toString('utf8').replace(/^\uFEFF/, '');
const looksGoogleCsv = (name: string, t: string) => /daily (activity|aggregations)|takeout|\/fit\//i.test(name) || /move minutes count|heart points/i.test(t.slice(0, 400));
const looksApple = (b: Buffer) => b.subarray(0, 4096).includes('<HealthData') || b.indexOf('<Record type="HK') >= 0;

/** Reads one uploaded file (a zip or a single export file). Throws HealthError(400) with a plain reason. */
export async function readHealthExport(name: string, buf: Buffer, opts: { tz?: string } = {}): Promise<ReadResult> {
  const tz = opts.tz;
  const lower = String(name ?? '').toLowerCase();
  let out: ReadResult | undefined;
  try {
    if (isZip(buf)) out = readZip(openZip(buf, ZIP_LIMITS), tz);
    else if (isFit(buf)) out = { source: 'garmin', readings: readFit(buf, tz) };
    else if (looksApple(buf)) out = { source: 'apple', readings: readAppleXml(buf) };
    else if (/\.json$/.test(lower) || buf[0] === 0x7b) {
      const days = new Days();
      if (readGoogleSession(text(buf), days, tz)) out = { source: 'google', readings: days.readings() };
    } else if (/\.csv$/.test(lower) || (!/\.\w{1,5}$/.test(lower) && /^[^\n]*[,;][^\n]*\n/.test(text(buf.subarray(0, 2000))))) {
      const t = text(buf);
      const days = new Days();
      readCsv(t, lower, days, tz);
      out = { source: looksGoogleCsv(lower, t) ? 'google' : 'garmin', readings: days.readings() };
    }
  } catch (err) {
    if (err instanceof HealthError) throw err;
    if (err instanceof ReadError) throw new HealthError(400, err.message);
    throw new HealthError(400, NONE);
  }
  if (!out) throw new HealthError(400, NONE);
  if (!out.readings.length) throw new HealthError(400, EMPTY);
  return { source: out.source, readings: order(out.readings) };
}

function readZip(zip: Zip, tz?: string): ReadResult | undefined {
  const names = [...zip.entries.keys()];
  const apple = names.find((n) => /(^|\/)export\.xml$/i.test(n));
  if (apple) return { source: 'apple', readings: readAppleXml(zip.read(apple)) };
  const days = new Days();
  const google = names.some((n) => /(^|\/)fit\//i.test(n));
  const summary = names.find((n) => /daily activity metrics\.csv$|daily aggregations\.csv$/i.test(n));
  let seen = false;
  for (const n of names) {
    const base = n.split('/').pop() ?? '';
    if (/\.fit$/i.test(n)) {
      const b = zip.read(n);
      if (isFit(b)) {
        readFit(b, tz, days);
        seen = true;
      }
    } else if (/\.csv$/i.test(n)) {
      // Google's per-day files repeat the summary: read them only when there is no summary.
      if (google && summary && n !== summary) continue;
      readCsv(zip.text(n) ?? '', n, days, tz);
      seen = true;
    } else if (google && /\.json$/i.test(base) && /all sessions\//i.test(n)) {
      readGoogleSession(zip.text(n) ?? '', days, tz);
      seen = true;
    }
  }
  if (!seen) return undefined;
  return { source: google ? 'google' : 'garmin', readings: days.readings() };
}
