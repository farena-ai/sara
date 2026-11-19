// V2.6 (docs/UPKEEP.md): Car and house upkeep. Schedules per car (by miles or months, whichever comes
// first) and for the home (filters, gutters, smoke alarms) from a small built-in table, a service
// history typed in or taken from receipts (V2.2 Purchases already reads receipt mail and photos), a
// "book it" errand (the existing `book` template in src/errands.ts) and one Planner reminder for each
// next due date (the planner's own scheduler delivers it; no timer here). Cars come from My details
// (src/my-details.ts vehicles) or a typed name. Kept in each person's own store.db (members have their own).
import type { DatabaseSync } from 'node:sqlite';
import { addDays, daysBetween, localDay, morningOf } from './biz/store.ts';
import type { AppContext } from './chat.ts';
import { errandsFor, type Errand } from './errands.ts';
import { en, trOwner } from './i18n.ts';
import { noteNudgeReminder } from './nudges.ts';
import { purchases, type Purchase } from './money/purchases.ts';
import { looksLikeCard, looksLikeSsn, myDetailsFor } from './my-details.ts';

export type UpkeepPlace = 'car' | 'home';

export interface UpkeepRow {
  key: string;
  place: UpkeepPlace;
  title: string;
  everyMiles: number | null;
  everyMonths: number;
  /** What a "book it" errand looks for nearby (null: a do-it-yourself job). */
  service: string | null;
  why: string;
  /** Words on a receipt that mean this job was done. */
  receipt: RegExp | null;
}

/**
 * Usual intervals (general US guidance; a car's owner's manual and the person's own numbers win, and every
 * row can be changed or removed). Shown on the page with the reason.
 */
export const UPKEEP_TABLE: UpkeepRow[] = [
  { key: 'oil', place: 'car', title: en('Oil change'), everyMiles: 5000, everyMonths: 6, service: 'oil change', why: en('Most cars: every 5,000 to 7,500 miles or 6 months. Your owner’s manual wins.'), receipt: /\boil (?:change|and filter|& filter)\b|\blube\b|\bsynthetic oil\b/i },
  { key: 'tires', place: 'car', title: en('Tire rotation'), everyMiles: 6000, everyMonths: 6, service: 'tire rotation', why: en('Rotating tires every 5,000 to 7,500 miles helps them wear evenly.'), receipt: /\btire rotation\b|\brotate (?:the )?tires\b|\brotation (?:and|&) balance\b/i },
  { key: 'air-filter', place: 'car', title: en('Engine air filter'), everyMiles: 15000, everyMonths: 12, service: 'auto service', why: en('Usually every 15,000 to 30,000 miles; sooner on dusty roads.'), receipt: /\bengine (?:air )?filter\b/i },
  { key: 'cabin-filter', place: 'car', title: en('Cabin air filter'), everyMiles: 15000, everyMonths: 12, service: 'auto service', why: en('Keeps the air inside the car clean; about once a year.'), receipt: /\bcabin (?:air )?filter\b/i },
  { key: 'brakes', place: 'car', title: en('Brake check'), everyMiles: 12000, everyMonths: 12, service: 'brake service', why: en('A yearly look at pads and fluid catches wear before it gets costly.'), receipt: /\bbrake (?:pads?|service|inspection|check|job|fluid)\b/i },
  { key: 'wipers', place: 'car', title: en('Wiper blades'), everyMiles: null, everyMonths: 12, service: null, why: en('Rubber wears out in about a year, faster in sun and snow.'), receipt: /\bwiper/i },
  { key: 'battery', place: 'car', title: en('Car battery check'), everyMiles: null, everyMonths: 12, service: 'car battery test', why: en('Batteries last 3 to 5 years; many auto parts stores test them for free.'), receipt: /\b(?:car|auto) battery\b|\bbattery (?:test|replacement)\b/i },
  { key: 'hvac-filter', place: 'home', title: en('Replace the furnace/AC filter'), everyMiles: null, everyMonths: 3, service: null, why: en('Every 1 to 3 months; monthly with pets or allergies.'), receipt: /\b(?:furnace|hvac|a\/?c|air) filters?\b|\b\d{2}x\d{2}x\d\b/i },
  { key: 'gutters', place: 'home', title: en('Clean the gutters'), everyMiles: null, everyMonths: 6, service: 'gutter cleaning', why: en('Twice a year, in spring and after the leaves fall.'), receipt: /\bgutters?\b/i },
  { key: 'smoke-test', place: 'home', title: en('Test smoke and CO alarms'), everyMiles: null, everyMonths: 1, service: null, why: en('The US Fire Administration says to test them once a month.'), receipt: null },
  { key: 'smoke-batteries', place: 'home', title: en('Replace smoke alarm batteries'), everyMiles: null, everyMonths: 12, service: null, why: en('Once a year, unless the alarms have sealed 10-year batteries.'), receipt: /\bsmoke (?:alarm|detector)s?\b|\b9-?v(?:olt)? batter/i },
  { key: 'hvac-service', place: 'home', title: en('Heating and cooling tune-up'), everyMiles: null, everyMonths: 12, service: 'HVAC service', why: en('A yearly check keeps the system efficient and catches problems early.'), receipt: /\bhvac (?:tune|service|maintenance)|\bfurnace (?:tune|service|inspection|cleaning)|\ba\/?c (?:tune|service)/i },
  { key: 'water-heater', place: 'home', title: en('Flush the water heater'), everyMiles: null, everyMonths: 12, service: 'plumber', why: en('Draining the sediment once a year helps it last longer.'), receipt: /\bwater heater\b/i },
  { key: 'dryer-vent', place: 'home', title: en('Clean the dryer vent'), everyMiles: null, everyMonths: 12, service: 'dryer vent cleaning', why: en('Lint in the vent is a fire risk; clean it once a year.'), receipt: /\bdryer vent\b/i },
];

/** Miles a day when the odometer readings don't say yet (about 12,000 miles a year). */
export const DEFAULT_MILES_PER_DAY = 33;

export class UpkeepError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const UPKEEP_LINES = [en('Pick which car.'), en('Give it a name, like “Replace the fridge filter”.'), en('Pick how often: months, miles or both.'), en('Upkeep task not found.'), en('Pick the date, like 2026-11-18.'), en('That odometer number is lower than the last one.'), en('Type the miles as a number, like 42000.'), en('This one is a do-it-yourself job: nothing to book.'), en('Receipt not found.')];

export interface UpkeepLog {
  id: number;
  date: string;
  miles: number | null;
  note: string;
  costCents: number | null;
  source: 'you' | 'receipt';
  purchaseId: number | null;
}

export interface UpkeepItem {
  id: number;
  place: UpkeepPlace;
  car: string | null;
  /** A table key, or `own` for a task the person added. */
  key: string;
  title: string;
  everyMiles: number | null;
  everyMonths: number | null;
  service: string | null;
  why: string | null;
  lastDate: string | null;
  lastMiles: number | null;
  next: { date: string; miles: number | null; by: 'miles' | 'months' };
  daysLeft: number;
  remind: boolean;
  reminder: { id: number; dueAt: string; status: string } | null;
  errandId: number | null;
  history: UpkeepLog[];
}

export interface UpkeepFound {
  purchaseId: number;
  key: string;
  itemId: number;
  title: string;
  car: string | null;
  item: string;
  store: string;
  date: string;
  costCents: number | null;
}

type Row = Record<string, unknown>;
const stores = new WeakMap<DatabaseSync, DatabaseSync>();
function db(app: AppContext): DatabaseSync {
  const d = app.store.db;
  if (!stores.has(d)) {
    d.exec(`CREATE TABLE IF NOT EXISTS upkeep_items (id INTEGER PRIMARY KEY, place TEXT NOT NULL, car TEXT, key TEXT NOT NULL, title TEXT NOT NULL,
      every_miles INTEGER, every_months INTEGER, start_date TEXT NOT NULL, remind INTEGER NOT NULL DEFAULT 1, reminder_id INTEGER, reminder_for TEXT,
      errand_id INTEGER, created_at TEXT NOT NULL)`);
    d.exec(`CREATE TABLE IF NOT EXISTS upkeep_log (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, date TEXT NOT NULL, miles INTEGER, note TEXT NOT NULL DEFAULT '',
      cost_cents INTEGER, source TEXT NOT NULL DEFAULT 'you', purchase_id INTEGER, created_at TEXT NOT NULL)`);
    d.exec('CREATE TABLE IF NOT EXISTS upkeep_miles (id INTEGER PRIMARY KEY, car TEXT NOT NULL, date TEXT NOT NULL, miles INTEGER NOT NULL)');
    d.exec('CREATE TABLE IF NOT EXISTS upkeep_skip (purchase_id INTEGER PRIMARY KEY)');
    stores.set(d, d);
  }
  return d;
}

/** An ISO day plus n calendar months (the 31st becomes the month's last day). */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

const today = (app: AppContext) => localDay(app.now(), app.settings.get().timeZone);
const clean = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const tableRow = (key: string) => UPKEEP_TABLE.find((r) => r.key === key);

/** The person's cars: My details vehicles ("2019 Honda Civic"), then any other car name used here. */
export function carsOf(app: AppContext): string[] {
  const out: string[] = [];
  try {
    for (const v of (app.myDetails ?? myDetailsFor(app.store.db)).get().vehicles ?? []) {
      const name = [v.year, v.make, v.model].filter(Boolean).join(' ').trim();
      if (name && !out.includes(name)) out.push(name);
    }
  } catch {
    /* no details store */
  }
  for (const r of db(app).prepare("SELECT DISTINCT car FROM upkeep_items WHERE car IS NOT NULL ORDER BY id").all() as Row[]) if (!out.includes(String(r.car))) out.push(String(r.car));
  return out;
}

interface Point {
  date: string;
  miles: number;
}
/** Odometer points for a car: readings plus service logs that had the miles. */
function pointsOf(app: AppContext, car: string): Point[] {
  const d = db(app);
  const pts = (d.prepare('SELECT date, miles FROM upkeep_miles WHERE car = ?').all(car) as Row[]).map((r) => ({ date: String(r.date), miles: Number(r.miles) }));
  for (const r of d.prepare('SELECT l.date, l.miles FROM upkeep_log l JOIN upkeep_items i ON i.id = l.item_id WHERE i.car = ? AND l.miles IS NOT NULL').all(car) as Row[]) pts.push({ date: String(r.date), miles: Number(r.miles) });
  return pts.sort((a, b) => a.date.localeCompare(b.date) || a.miles - b.miles);
}

/** Miles a day from the readings of the last year (earliest to latest, at least two weeks apart). */
export function milesPerDay(pts: Point[], now: string): number {
  const recent = pts.filter((p) => daysBetween(p.date, now) <= 365);
  if (recent.length >= 2) {
    const a = recent[0];
    const b = recent.at(-1)!;
    const days = daysBetween(a.date, b.date);
    if (days >= 14 && b.miles > a.miles) return Math.min(300, Math.max(1, (b.miles - a.miles) / days));
  }
  return DEFAULT_MILES_PER_DAY;
}

/** The odometer on a day, from the nearest reading before it (or after it) at the usual pace. */
function milesOn(pts: Point[], day: string, rate: number): number {
  const before = pts.filter((p) => p.date <= day).at(-1);
  if (before) return Math.round(before.miles + rate * daysBetween(before.date, day));
  const after = pts[0];
  return Math.max(0, Math.round(after.miles - rate * daysBetween(day, after.date)));
}

function toItem(app: AppContext, r: Row, now: string): UpkeepItem {
  const id = Number(r.id);
  const history = (db(app).prepare('SELECT * FROM upkeep_log WHERE item_id = ? ORDER BY date DESC, id DESC').all(id) as Row[]).map(
    (l): UpkeepLog => ({ id: Number(l.id), date: String(l.date), miles: l.miles == null ? null : Number(l.miles), note: String(l.note ?? ''), costCents: l.cost_cents == null ? null : Number(l.cost_cents), source: l.source === 'receipt' ? 'receipt' : 'you', purchaseId: l.purchase_id == null ? null : Number(l.purchase_id) }),
  );
  const key = String(r.key);
  const t = tableRow(key);
  const car = r.car == null ? null : String(r.car);
  const everyMiles = r.every_miles == null ? null : Number(r.every_miles);
  const everyMonths = r.every_months == null ? null : Number(r.every_months);
  const lastDate = history[0]?.date ?? null;
  // The miles at the last service: typed with it, else estimated from the odometer readings around it.
  const lastMiles = history[0]?.miles ?? null;
  const base = lastDate ?? String(r.start_date);
  let date = everyMonths ? addMonths(base, everyMonths) : null;
  let by: 'miles' | 'months' = 'months';
  let miles: number | null = null;
  if (everyMiles && car) {
    const pts = pointsOf(app, car);
    const rate = milesPerDay(pts, now);
    const baseMiles = lastMiles ?? (lastDate && pts.length ? milesOn(pts, lastDate, rate) : pts[0]?.miles ?? null);
    let byMiles: string;
    if (baseMiles == null) byMiles = addDays(base, Math.ceil(everyMiles / rate));
    else {
      miles = baseMiles + everyMiles;
      const latest = pts.at(-1)!;
      byMiles = miles <= latest.miles ? latest.date : addDays(latest.date, Math.ceil((miles - latest.miles) / rate));
    }
    if (!date || byMiles < date) {
      date = byMiles;
      by = 'miles';
    }
  }
  const rem = r.reminder_id ? app.planner?.reminder(Number(r.reminder_id)) : undefined;
  return {
    id,
    place: r.place === 'car' ? 'car' : 'home',
    car,
    key,
    title: String(r.title),
    everyMiles,
    everyMonths,
    service: t?.service ?? null,
    why: t?.why ?? null,
    lastDate,
    lastMiles,
    next: { date: date!, miles, by },
    daysLeft: daysBetween(now, date!),
    remind: Number(r.remind) === 1,
    reminder: rem && rem.status !== 'cancelled' ? { id: rem.id, dueAt: rem.dueAt, status: rem.status } : null,
    errandId: r.errand_id && errandsFor(app).get(Number(r.errand_id)) ? Number(r.errand_id) : null,
    history,
  };
}

function items(app: AppContext): UpkeepItem[] {
  const now = today(app);
  return (db(app).prepare('SELECT * FROM upkeep_items ORDER BY id').all() as Row[]).map((r) => toItem(app, r, now));
}
function item(app: AppContext, id: number): UpkeepItem {
  const r = db(app).prepare('SELECT * FROM upkeep_items WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new UpkeepError(404, en('Upkeep task not found.'));
  return toItem(app, r, today(app));
}

/** Receipts (V2.2 Purchases) that look like a job on the list, not logged or skipped yet. */
function foundOf(app: AppContext, list: UpkeepItem[]): UpkeepFound[] {
  if (!list.length) return [];
  let all: Purchase[] = [];
  try {
    all = purchases(app);
  } catch {
    return [];
  }
  const d = db(app);
  const used = new Set((d.prepare('SELECT purchase_id FROM upkeep_log WHERE purchase_id IS NOT NULL UNION SELECT purchase_id FROM upkeep_skip').all() as Row[]).map((r) => Number(r.purchase_id)));
  const now = today(app);
  const out: UpkeepFound[] = [];
  for (const p of all) {
    if (used.has(p.id) || daysBetween(p.date, now) > 400) continue;
    const text = `${p.item} ${p.store}`;
    const row = UPKEEP_TABLE.find((t) => t.receipt?.test(text));
    const it = row && list.find((i) => i.key === row.key);
    if (!row || !it) continue;
    out.push({ purchaseId: p.id, key: row.key, itemId: it.id, title: it.title, car: it.car, item: p.item, store: p.store, date: p.date, costCents: p.priceCents });
  }
  return out;
}

export function upkeepList(app: AppContext) {
  const list = items(app).sort((a, b) => a.next.date.localeCompare(b.next.date) || a.id - b.id);
  const odometer: Record<string, { miles: number; date: string; perDay: number }> = {};
  const now = today(app);
  for (const car of carsOf(app)) {
    const pts = pointsOf(app, car);
    const last = pts.at(-1);
    if (last) odometer[car] = { miles: last.miles, date: last.date, perDay: Math.round(milesPerDay(pts, now)) };
  }
  return {
    cars: carsOf(app),
    items: list,
    found: foundOf(app, list),
    odometer,
    table: UPKEEP_TABLE.map(({ key, place, title, everyMiles, everyMonths, service, why }) => ({ key, place, title, everyMiles, everyMonths, service: service !== null, why })),
  };
}

const usDay = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${iso}T12:00:00Z`));

/** One pending Planner reminder for the next due date (moved when the date moves; none when off). */
function syncReminder(app: AppContext, id: number): void {
  const d = db(app);
  const r = d.prepare('SELECT * FROM upkeep_items WHERE id = ?').get(id) as Row | undefined;
  const planner = app.planner;
  if (!r || !planner) return;
  const it = toItem(app, r, today(app));
  const cur = r.reminder_id ? planner.reminder(Number(r.reminder_id)) : undefined;
  const live = cur && cur.status !== 'cancelled' ? cur : undefined;
  if (!it.remind) {
    if (live?.status === 'pending') planner.cancelReminder(live.id);
    d.prepare('UPDATE upkeep_items SET reminder_id = NULL, reminder_for = NULL WHERE id = ?').run(id);
    return;
  }
  // Already set (or already delivered) for this date: nothing to do.
  if (live && r.reminder_for === it.next.date) return;
  if (live?.status === 'pending') planner.cancelReminder(live.id);
  const tz = app.settings.get().timeZone;
  let due = morningOf(it.next.date, tz);
  if (due.getTime() <= app.now().getTime()) due = morningOf(addDays(today(app), 1), tz);
  const s = app.settings.get();
  const name = it.key === 'own' ? it.title : trOwner(it.title, s);
  const what = it.car ? `${name} (${it.car})` : name;
  const text = it.next.by === 'miles' && it.next.miles
    ? trOwner(en('{what} is due around {miles} miles (about {date}). Log it or book it in Settings → You → My details → Car and house upkeep.'), s, { what, miles: it.next.miles.toLocaleString('en-US'), date: usDay(it.next.date) })
    : trOwner(en('{what} is due {date}. Log it or book it in Settings → You → My details → Car and house upkeep.'), s, { what, date: usDay(it.next.date) });
  const rem = planner.addReminder({ text, dueAt: due.toISOString() });
  noteNudgeReminder(app, rem.id, 'upkeep', 0.55, it.key.startsWith('smoke') ? 'safety' : 'normal');
  d.prepare('UPDATE upkeep_items SET reminder_id = ?, reminder_for = ? WHERE id = ?').run(rem.id, it.next.date, id);
}

function syncCar(app: AppContext, car: string): void {
  for (const r of db(app).prepare('SELECT id FROM upkeep_items WHERE car = ? AND every_miles IS NOT NULL').all(car) as Row[]) syncReminder(app, Number(r.id));
}

function dayArg(app: AppContext, v: unknown): string {
  if (v == null || v === '') return today(app);
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T12:00:00Z`)) || new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) !== s || s > addDays(today(app), 1)) throw new UpkeepError(400, en('Pick the date, like 2026-11-18.'));
  return s;
}
function milesArg(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,\s]/g, '').replace(/mi(?:les)?$/i, ''));
  if (!Number.isFinite(n) || n < 0 || n > 2_000_000) throw new UpkeepError(400, en('Type the miles as a number, like 42000.'));
  return Math.round(n);
}
function intIn(v: unknown, lo: number, hi: number): number | null | undefined {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
}

export interface UpkeepResult {
  ok: boolean;
  added?: number;
  item?: UpkeepItem;
  errand?: Errand;
}

export type UpkeepVerb = 'setup' | 'add' | 'log' | 'miles' | 'remind' | 'book' | 'remove' | 'skip';
export const UPKEEP_VERBS: UpkeepVerb[] = ['setup', 'add', 'log', 'miles', 'remind', 'book', 'remove', 'skip'];

export function upkeepAction(app: AppContext, action: UpkeepVerb, args: Record<string, unknown>): UpkeepResult {
  const d = db(app);
  const now = today(app);
  const stamp = app.now().toISOString();
  if (action === 'setup') {
    const place: UpkeepPlace = args.place === 'car' ? 'car' : 'home';
    const car = place === 'car' ? clean(args.car, 60) : null;
    if (place === 'car' && !car) throw new UpkeepError(400, en('Pick which car.'));
    let added = 0;
    for (const t of UPKEEP_TABLE.filter((x) => x.place === place)) {
      const has = d.prepare('SELECT 1 FROM upkeep_items WHERE key = ? AND place = ? AND car IS ?').get(t.key, place, car);
      if (has) continue;
      const id = Number(d.prepare('INSERT INTO upkeep_items (place, car, key, title, every_miles, every_months, start_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(place, car, t.key, t.title, t.everyMiles, t.everyMonths, now, stamp).lastInsertRowid);
      syncReminder(app, id);
      added++;
    }
    return { ok: true, added };
  }
  if (action === 'add') {
    const place: UpkeepPlace = args.place === 'car' ? 'car' : 'home';
    const car = place === 'car' ? clean(args.car, 60) : null;
    if (place === 'car' && !car) throw new UpkeepError(400, en('Pick which car.'));
    const title = clean(args.title, 80);
    if (!title || looksLikeCard(title) || looksLikeSsn(title)) throw new UpkeepError(400, en('Give it a name, like “Replace the fridge filter”.'));
    const months = intIn(args.everyMonths, 1, 60);
    const miles = place === 'car' ? intIn(args.everyMiles, 100, 100_000) : null;
    if (months === undefined || miles === undefined || (!months && !miles)) throw new UpkeepError(400, en('Pick how often: months, miles or both.'));
    const id = Number(d.prepare('INSERT INTO upkeep_items (place, car, key, title, every_miles, every_months, start_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(place, car, 'own', title, miles, months, now, stamp).lastInsertRowid);
    if (args.lastDate) d.prepare('INSERT INTO upkeep_log (item_id, date, miles, created_at) VALUES (?, ?, ?, ?)').run(id, dayArg(app, args.lastDate), milesArg(args.lastMiles), stamp);
    syncReminder(app, id);
    return { ok: true, item: item(app, id) };
  }
  if (action === 'skip') {
    const pid = Number(args.purchaseId);
    if (!Number.isInteger(pid)) throw new UpkeepError(404, en('Receipt not found.'));
    d.prepare('INSERT OR IGNORE INTO upkeep_skip (purchase_id) VALUES (?)').run(pid);
    return { ok: true };
  }
  if (action === 'miles') {
    const car = clean(args.car, 60);
    if (!car) throw new UpkeepError(400, en('Pick which car.'));
    const miles = milesArg(args.miles);
    if (miles == null) throw new UpkeepError(400, en('Type the miles as a number, like 42000.'));
    const date = dayArg(app, args.date);
    const last = pointsOf(app, car).filter((p) => p.date <= date).at(-1);
    if (last && miles < last.miles) throw new UpkeepError(400, en('That odometer number is lower than the last one.'));
    d.prepare('INSERT INTO upkeep_miles (car, date, miles) VALUES (?, ?, ?)').run(car, date, miles);
    syncCar(app, car);
    return { ok: true };
  }
  const id = Number(args.id);
  const it = item(app, Number.isInteger(id) ? id : -1);
  if (action === 'log') {
    let date: string;
    let miles = milesArg(args.miles);
    let note = clean(args.note, 200);
    let cost: number | null = null;
    let source: 'you' | 'receipt' = 'you';
    let pid: number | null = null;
    if (args.purchaseId != null && args.purchaseId !== '') {
      const p = (() => {
        try {
          return purchases(app).find((x) => x.id === Number(args.purchaseId));
        } catch {
          return undefined;
        }
      })();
      if (!p) throw new UpkeepError(404, en('Receipt not found.'));
      date = p.date;
      cost = p.priceCents;
      note ||= p.store;
      source = 'receipt';
      pid = p.id;
    } else {
      date = dayArg(app, args.date);
      const c = args.cost == null || args.cost === '' ? null : Math.round(Number(String(args.cost).replace(/[$,\s]/g, '')) * 100);
      cost = c != null && Number.isFinite(c) && c >= 0 ? c : null;
    }
    if (miles != null && it.car) {
      const before = pointsOf(app, it.car).filter((p) => p.date <= date).at(-1);
      if (before && miles < before.miles) throw new UpkeepError(400, en('That odometer number is lower than the last one.'));
    } else if (!it.car) miles = null;
    d.prepare('INSERT INTO upkeep_log (item_id, date, miles, note, cost_cents, source, purchase_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(it.id, date, miles, note, cost, source, pid, stamp);
    if (it.car && miles != null) syncCar(app, it.car);
    syncReminder(app, it.id);
    return { ok: true, item: item(app, it.id) };
  }
  if (action === 'remind') {
    d.prepare('UPDATE upkeep_items SET remind = ? WHERE id = ?').run(args.on === false ? 0 : 1, it.id);
    syncReminder(app, it.id);
    return { ok: true, item: item(app, it.id) };
  }
  if (action === 'book') {
    if (!it.service) throw new UpkeepError(400, en('This one is a do-it-yourself job: nothing to book.'));
    const forWhat = it.car ? ` for my ${it.car}` : '';
    const e = errandsFor(app).start({ goal: `Book ${it.service.toLowerCase().startsWith('hvac') ? it.service : it.service.toLowerCase()}${forWhat} (due ${usDay(it.next.date)})`.slice(0, 200), template: 'book', deadline: it.next.date < now ? undefined : it.next.date, facts: { service: it.service, ...(it.car ? { car: it.car } : {}) } }, { by: 'page' });
    d.prepare('UPDATE upkeep_items SET errand_id = ? WHERE id = ?').run(e.id, it.id);
    return { ok: true, item: item(app, it.id), errand: e };
  }
  if (action === 'remove') {
    if (it.reminder?.status === 'pending') app.planner?.cancelReminder(it.reminder.id);
    d.prepare('DELETE FROM upkeep_log WHERE item_id = ?').run(it.id);
    d.prepare('DELETE FROM upkeep_items WHERE id = ?').run(it.id);
    return { ok: true };
  }
  throw new UpkeepError(400, en('Upkeep task not found.'));
}

const STOP = new Set(['the', 'and', 'for', 'my', 'our', 'with', 'did', 'done', 'got', 'had', 'today', 'yesterday', 'this', 'that', 'was', 'were', 'just', 'new', 'all']);
/** The best item for a few words ("furnace filter", "oil change on the Civic"). */
export function findUpkeep(app: AppContext, words: string): UpkeepItem | undefined {
  const ws = (words.toLowerCase().match(/[\p{L}\d]{3,}/gu) ?? []).filter((w) => !STOP.has(w));
  let best: { it: UpkeepItem; n: number } | undefined;
  for (const it of items(app)) {
    const hay = `${it.title} ${it.key} ${it.car ?? ''} ${it.service ?? ''}`.toLowerCase();
    const n = ws.filter((w) => hay.includes(w)).length;
    if (n && (!best || n > best.n)) best = { it, n };
  }
  return best?.it;
}

/** One line for chat: "#3 Oil change (2019 Honda Civic): due 2027-05-18 or at 45,000 miles, last done 2026-11-18". */
export function upkeepLine(it: UpkeepItem): string {
  const due = it.next.miles ? `due ${it.next.date} or at ${it.next.miles.toLocaleString('en-US')} miles` : `due ${it.next.date}`;
  return `#${it.id} ${it.title}${it.car ? ` (${it.car})` : ''}: ${due}${it.daysLeft < 0 ? ` (${-it.daysLeft} days overdue)` : ''}, last done ${it.lastDate ?? 'not logged yet'}`;
}
