// U4.22 (docs/HEALTH.md): a private, local-only health log, each person's own.
//
// What it keeps: medicines (name, dose, times of day, supply) with dose reminders, a taken/skipped log
// and a refill estimate; appointments (prep questions, after-visit notes, an .ics file for the
// calendar); symptoms, mood, sleep and measurements (quick add by chat: "headache 6/10", "BP 128/82");
// a doctor summary for a date range (Markdown → PDF through the document maker). Never advice, never a
// diagnosis: every view, answer and PDF carries the plain banner.
//
// Privacy: the log lives in the person's own space (<space>/health-log/health.db, a member's in their
// own folder) and every record is sealed with AES-256-GCM under that space's own key (health.key,
// mode 0600); only dates and record kinds are in clear. Its words are registered with
// src/health-terms.ts so every report that leaves (support, hub, remote help, fix recipes) hides them.
// Chat lines that logged something are marked `meta.health` and stay out of memory and Ask about
// anything; the Ask "health" source only answers in a private chat with "include health" on.
// Reading tools answer only to a local model unless the person allowed a cloud model for health.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { makePdf } from './documents/pdf.ts';
import type { ImportSource, Metric, Reading } from './health-import.ts';
import { careCheckedIn, careTick } from './caregiver.ts';
import { setHealthTerms } from './health-terms.ts';
import { en, trOwner } from './i18n.ts';
import { zonedParts, zonedToUtc } from './planner.ts';

export const NOT_ADVICE = 'Your own log, not medical advice. Ask a doctor or pharmacist about anything here.';

export type EntryType = 'symptom' | 'mood' | 'sleep' | 'measure';
export interface Entry { id: number; at: string; type: EntryType; name: string; value?: number; value2?: number; scale?: number; unit?: string; note?: string; imp?: string; src?: ImportSource; batch?: number }
/** V4.3: one file imported from a watch or phone app (src/health-import.ts). */
export interface ImportBatch { id: number; at: string; source: ImportSource; file: string; added: number; updated: number; from?: string; to?: string }
export interface ImportResult { batch: number; source: ImportSource; added: number; updated: number; same: number; from?: string; to?: string }
/** V4.3: a measurement over the 30 days up to its newest value. */
export interface Trend { name: Metric; unit: string; points: { day: string; value: number }[]; last: { day: string; value: number }; avg7: number; prev7?: number; change?: number }
const TREND_METRICS: readonly Metric[] = ['steps', 'sleep', 'heart rate', 'resting heart rate', 'weight'];
const LB = 2.20462262;
export interface Med { id: number; at: string; name: string; dose: string; times: string[]; days?: number[]; supply?: number; perDose?: number; refilledOn?: string; notes?: string; active: boolean; managedBy?: 'parent' }
export type DoseStatus = 'due' | 'taken' | 'skipped';
export interface Dose { id: number; at: string; medId: number; due: string; status: DoseStatus; doneAt?: string }
export interface Appt { id: number; at: string; title: string; when: string; where?: string; questions: string[]; notes?: string }
/** `coach`: W4.4 weekly health check-in (src/health-coach.ts), off until the person turns it on. */
export interface HealthSettings { cloudOk: boolean; includeInAsk: boolean; reminders: boolean; namesInAlerts: boolean; coach: boolean }
export const HEALTH_DEFAULTS: HealthSettings = { cloudOk: false, includeInAsk: false, reminders: true, namesInAlerts: false, coach: false };
/** V5.4 (docs/design/V5CARE.md): who may see what (the person's own consent) and whom to call. */
export interface CareGrant { person: string; doses: boolean; checkins: boolean; since: string; told?: number; /** W4.4: the coach's weekly summary. */ summary?: boolean }
export interface CareContact { name: string; phone: string }
export interface CareState { grants: CareGrant[]; contacts: CareContact[] }
export const CHECKIN_STATUSES = ['ok', 'notgreat', 'help'] as const;
export type CheckinStatus = (typeof CHECKIN_STATUSES)[number];
export interface Checkin { id: number; at: string; day: string; status: CheckinStatus }

export class HealthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ------------------------------------------------------------------------------------------------
// Quick add ("headache 6/10", "BP 128/82", "slept 7.5h", "weight 172 lb")
// ------------------------------------------------------------------------------------------------

export type Quick = Omit<Entry, 'id' | 'at'>;
const num = (s: string) => Number(s.replace(',', '.'));
const MEASURES: [RegExp, string, string][] = [
  [/^(?:weight|weigh|weighed|peso|poids|gewicht)\s*:?\s*(\d{2,3}(?:[.,]\d)?)\s*(lb|lbs|kg)?$/i, 'weight', 'lb'],
  [/^(?:glucose|blood sugar|sugar|glucosa|glyc[ée]mie|blutzucker|glicose|glicemia)\s*:?\s*(\d{2,3}(?:[.,]\d)?)\s*(mg\/dl|mmol\/l)?$/i, 'glucose', 'mg/dL'],
  [/^(?:pulse|heart rate|hr|pulso|pouls|puls|polso)\s*:?\s*(\d{2,3})\s*(bpm)?$/i, 'pulse', 'bpm'],
  [/^(?:temp|temperature|fever|temperatura|fiebre|temp[ée]rature|fi[èe]vre|fieber|febre|febbre)\s*:?\s*(\d{2,3}(?:[.,]\d)?)\s*(°?f|°?c)?$/i, 'temperature', '°F'],
];

/** One quick-add line as an entry, or undefined when it is not one. */
export function parseQuick(raw: string): Quick | undefined {
  const s = String(raw ?? '').trim().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
  if (!s || s.length > 80) return undefined;
  let m = /^(?:bp|blood pressure|pa|presi[oó]n|tension|blutdruck|rr|press[aã]o|pressione)\s*:?\s*(\d{2,3})\s*\/\s*(\d{2,3})(?:\s*mmhg)?$/i.exec(s);
  if (m) return { type: 'measure', name: 'blood pressure', value: Number(m[1]), value2: Number(m[2]), unit: 'mmHg' };
  m = /^(?:slept|sleep|dorm[ií]|sue[ñn]o|sommeil|dormi|schlaf|geschlafen|sono|dormito)\s*:?\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:h|hr|hrs|hours?)?$/i.exec(s);
  if (m) return { type: 'sleep', name: 'sleep', value: num(m[1]), unit: 'h' };
  m = /^(?:mood|[áa]nimo|humeur|stimmung|humor|umore)\s*:?\s*(\d{1,2})(?:\s*\/\s*10)?$/i.exec(s);
  if (m && Number(m[1]) <= 10) return { type: 'mood', name: 'mood', value: Number(m[1]), scale: 10 };
  for (const [re, name, unit] of MEASURES) {
    m = re.exec(s);
    if (m) {
      const u = m[2] ? (/mg/i.test(m[2]) ? 'mg/dL' : /mmol/i.test(m[2]) ? 'mmol/L' : /c$/i.test(m[2]) ? '°C' : /f$/i.test(m[2]) ? '°F' : m[2].toLowerCase().replace('lbs', 'lb')) : unit;
      return { type: 'measure', name, value: num(m[1]), unit: u };
    }
  }
  // A symptom: a few words and a 0–10 score ("headache 6/10", "back pain: 4/10").
  m = /^([\p{L}][\p{L}' -]{1,40}?)\s*:?\s*(\d{1,2})\s*\/\s*10$/iu.exec(s);
  if (m && Number(m[2]) <= 10 && !/\b(at|on|by|until|from|meet|call|a las|le|um|alle|às)\b/i.test(m[1])) return { type: 'symptom', name: m[1].trim().toLowerCase(), value: Number(m[2]), scale: 10 };
  return undefined;
}

export { healthMessage, withoutHealth } from './health-terms.ts';

// ------------------------------------------------------------------------------------------------
// The store
// ------------------------------------------------------------------------------------------------

const OPEN = new Map<string, HealthLog>();
const day = 86_400_000;
const hhmm = (t: string) => /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t ?? '').trim());

export interface HealthBind {
  tz?: () => string | undefined;
  now?: () => Date;
  notify?: (title: string, body: string) => void;
  lang?: (s: string) => string;
  /** V5.4: after a daily check-in (caregiver notices, src/caregiver.ts). */
  checkedIn?: (status: CheckinStatus) => void;
}

export class HealthLog {
  readonly dir: string;
  readonly #db: DatabaseSync;
  readonly #key: Buffer;
  bind: HealthBind = {};

  private constructor(spaceDir: string) {
    this.dir = join(spaceDir, 'health-log');
    mkdirSync(this.dir, { recursive: true });
    const kf = join(this.dir, 'health.key');
    if (!existsSync(kf)) writeFileSync(kf, randomBytes(32).toString('base64'), { mode: 0o600 });
    try {
      chmodSync(kf, 0o600);
    } catch {
      /* not on this system */
    }
    this.#key = Buffer.from(readFileSync(kf, 'utf8').trim(), 'base64');
    this.#db = new DatabaseSync(join(this.dir, 'health.db'));
    this.#db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, at TEXT NOT NULL, data BLOB NOT NULL); CREATE INDEX IF NOT EXISTS items_kind_at ON items (kind, at);');
    this.#terms();
  }

  /** The log in a space folder (one instance per folder in this process). */
  static open(spaceDir: string): HealthLog {
    let h = OPEN.get(spaceDir);
    if (!h) OPEN.set(spaceDir, (h = new HealthLog(spaceDir)));
    return h;
  }
  /** Whether this person has a health log at all (nothing is created by looking). */
  static exists(app: AppContext): boolean {
    const dir = spaceDir(app);
    return OPEN.has(dir) || existsSync(join(dir, 'health-log', 'health.db'));
  }
  static closeFor(spaceDir: string): void {
    const h = OPEN.get(spaceDir);
    if (!h) return;
    OPEN.delete(spaceDir);
    setHealthTerms(spaceDir, []);
    try {
      h.#db.close();
    } catch {
      /* closed */
    }
  }

  #now(): Date {
    return this.bind.now?.() ?? new Date();
  }
  #seal(v: unknown): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#key, iv);
    const body = Buffer.concat([c.update(JSON.stringify(v), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }
  #open<T>(b: Uint8Array): T {
    const buf = Buffer.from(b);
    const d = createDecipheriv('aes-256-gcm', this.#key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')) as T;
  }
  #rows<T extends { id: number; at: string }>(kind: string, from?: string, to?: string): T[] {
    const rows = this.#db.prepare(`SELECT id, at, data FROM items WHERE kind = ?${from ? ' AND at >= ?' : ''}${to ? ' AND at < ?' : ''} ORDER BY at DESC, id DESC`).all(kind, ...(from ? [from] : []), ...(to ? [to] : [])) as { id: number; at: string; data: Uint8Array }[];
    return rows.map((r) => ({ ...this.#open<Omit<T, 'id' | 'at'>>(r.data), id: Number(r.id), at: r.at }) as T);
  }
  #get<T extends { id: number; at: string }>(kind: string, id: number): T | undefined {
    const r = this.#db.prepare('SELECT id, at, data FROM items WHERE kind = ? AND id = ?').get(kind, id) as { id: number; at: string; data: Uint8Array } | undefined;
    return r ? ({ ...this.#open<Omit<T, 'id' | 'at'>>(r.data), id: Number(r.id), at: r.at } as T) : undefined;
  }
  #add<T>(kind: string, at: string, data: Omit<T, 'id' | 'at'>): number {
    return Number(this.#db.prepare('INSERT INTO items (kind, at, data) VALUES (?, ?, ?)').run(kind, at, this.#seal(data)).lastInsertRowid);
  }
  #put(kind: string, id: number, at: string, data: object): void {
    const { id: _i, at: _a, ...rest } = data as Record<string, unknown>;
    this.#db.prepare('UPDATE items SET at = ?, data = ? WHERE kind = ? AND id = ?').run(at, this.#seal(rest), kind, id);
  }
  #del(kind: string, id: number): boolean {
    return Number(this.#db.prepare('DELETE FROM items WHERE kind = ? AND id = ?').run(kind, id).changes) > 0;
  }
  /** The words reports must hide (medicine names, symptom names, appointment titles). */
  #terms(): void {
    setHealthTerms(this.dir, [...this.meds(true).map((m) => m.name), ...this.entries({}).filter((e) => e.type === 'symptom').map((e) => e.name), ...this.appts().map((a) => a.title)]);
  }

  // ---------------------------------------------------------------- settings
  settings(): HealthSettings {
    const r = this.#db.prepare("SELECT data FROM items WHERE kind = 'settings' LIMIT 1").get() as { data: Uint8Array } | undefined;
    return { ...HEALTH_DEFAULTS, ...(r ? this.#open<Partial<HealthSettings>>(r.data) : {}) };
  }
  setSettings(p: Partial<HealthSettings>): HealthSettings {
    const next = { ...this.settings() };
    for (const k of Object.keys(HEALTH_DEFAULTS) as (keyof HealthSettings)[]) if (typeof p[k] === 'boolean') next[k] = p[k]!;
    this.#db.prepare("DELETE FROM items WHERE kind = 'settings'").run();
    this.#add('settings', this.#now().toISOString(), next);
    return next;
  }

  // ---------------------------------------------------------------- medicines
  meds(all = false): Med[] {
    return this.#rows<Med>('med').filter((m) => all || m.active).sort((a, b) => a.name.localeCompare(b.name));
  }
  med(id: number): Med | undefined {
    return this.#get<Med>('med', id);
  }
  addMed(d: { name: string; dose?: string; times?: string[]; days?: number[]; supply?: number; perDose?: number; refilledOn?: string; notes?: string; managedBy?: 'parent' }): Med {
    const name = String(d.name ?? '').trim().slice(0, 80);
    if (!name) throw new HealthError(400, en('Give the medicine a name.'));
    const med = { ...cleanMed(d), name, active: true };
    const id = this.#add<Med>('med', this.#now().toISOString(), med);
    this.#terms();
    return this.med(id)!;
  }
  updateMed(id: number, p: Partial<Omit<Med, 'id' | 'at'>>): Med {
    const m = this.med(id);
    if (!m) throw new HealthError(404, en('Medicine not found.'));
    const next = { ...m, ...cleanMed({ ...m, ...p }), ...(typeof p.name === 'string' && p.name.trim() ? { name: p.name.trim().slice(0, 80) } : {}), ...(typeof p.active === 'boolean' ? { active: p.active } : {}) };
    this.#put('med', id, m.at, next);
    this.#terms();
    return this.med(id)!;
  }
  removeMed(id: number): boolean {
    const ok = this.#del('med', id);
    for (const d of this.doses({ medId: id })) this.#del('dose', d.id);
    this.#terms();
    return ok;
  }

  // ---------------------------------------------------------------- doses
  doses(f: { medId?: number; status?: DoseStatus; from?: string; to?: string } = {}): Dose[] {
    return this.#rows<Dose>('dose', f.from, f.to).filter((d) => (f.medId === undefined || d.medId === f.medId) && (!f.status || d.status === f.status));
  }
  markDose(id: number, status: 'taken' | 'skipped'): Dose {
    const d = this.#get<Dose>('dose', id);
    if (!d) throw new HealthError(404, en('Dose not found.'));
    this.#put('dose', id, d.at, { ...d, status, doneAt: this.#now().toISOString() });
    return this.#get<Dose>('dose', id)!;
  }
  /** A dose taken or skipped now (not from a reminder). */
  logDose(medId: number, status: 'taken' | 'skipped'): Dose {
    if (!this.med(medId)) throw new HealthError(404, en('Medicine not found.'));
    const now = this.#now().toISOString();
    // A reminder still open for it is the one answered.
    const open = this.doses({ medId, status: 'due' }).at(-1);
    if (open) return this.markDose(open.id, status);
    return this.#get<Dose>('dose', this.#add<Dose>('dose', now, { medId, due: now, status, doneAt: now }))!;
  }
  /** On the reminder tick: a reminder for each dose time that came up (once each). */
  due(now: Date = this.#now()): number {
    if (!this.settings().reminders) return 0;
    const tz = this.bind.tz?.();
    let made = 0;
    const known = new Set(this.doses({ from: new Date(now.getTime() - 2 * day).toISOString() }).map((d) => `${d.medId}@${d.due}`));
    const p = zonedParts(now, tz);
    for (const m of this.meds()) {
      for (const t of m.times) {
        const hm = hhmm(t);
        if (!hm) continue;
        const at = zonedToUtc(p.y, p.mo, p.d, Number(hm[1]), Number(hm[2]), tz);
        if (m.days?.length && !m.days.includes(p.wd)) continue;
        // Came up in the last six hours, after the medicine was added.
        if (at > now || now.getTime() - at.getTime() > 6 * 3_600_000 || at.getTime() < Date.parse(m.at) - 60_000) continue;
        const key = `${m.id}@${at.toISOString()}`;
        if (known.has(key)) continue;
        this.#add<Dose>('dose', at.toISOString(), { medId: m.id, due: at.toISOString(), status: 'due' });
        known.add(key);
        made++;
        const L = this.bind.lang ?? ((s: string) => s);
        this.bind.notify?.(L('Health'), this.settings().namesInAlerts ? `${L('Time for your medicine:')} ${m.name}${m.dose ? ` ${m.dose}` : ''}` : L('Time for a dose. Open Health to mark it taken.'));
      }
    }
    return made;
  }
  /** How long the supply lasts (taken doses since the last refill count against it). */
  refill(medId: number): { left: number; perDay: number; daysLeft: number; date: string; soon: boolean } | undefined {
    const m = this.med(medId);
    if (!m || typeof m.supply !== 'number') return undefined;
    const per = m.perDose ?? 1;
    const perDay = (m.times.length || 1) * per * (m.days?.length ? m.days.length / 7 : 1);
    const since = m.refilledOn ? new Date(`${m.refilledOn}T00:00:00Z`).toISOString() : m.at;
    const used = this.doses({ medId, status: 'taken', from: since }).length * per;
    const left = Math.max(0, m.supply - used);
    const daysLeft = Math.floor(left / perDay);
    return { left, perDay, daysLeft, date: new Date(this.#now().getTime() + daysLeft * day).toISOString().slice(0, 10), soon: daysLeft <= 7 };
  }

  // ---------------------------------------------------------------- appointments
  appts(): Appt[] {
    return this.#rows<Appt>('appt').sort((a, b) => a.when.localeCompare(b.when));
  }
  addAppt(d: { title: string; when: string; where?: string; questions?: string[] }): Appt {
    const title = String(d.title ?? '').trim().slice(0, 120);
    if (!title) throw new HealthError(400, en('Give the appointment a name.'));
    if (isNaN(Date.parse(d.when))) throw new HealthError(400, en('Pick a date and time.'));
    const id = this.#add<Appt>('appt', this.#now().toISOString(), { title, when: new Date(d.when).toISOString(), ...(d.where ? { where: String(d.where).slice(0, 200) } : {}), questions: (d.questions ?? []).map((q) => String(q).trim().slice(0, 300)).filter(Boolean).slice(0, 30) });
    this.#terms();
    return this.#get<Appt>('appt', id)!;
  }
  updateAppt(id: number, p: { title?: string; when?: string; where?: string; notes?: string; addQuestion?: string; questions?: string[] }): Appt {
    const a = this.#get<Appt>('appt', id);
    if (!a) throw new HealthError(404, en('Appointment not found.'));
    const next: Appt = { ...a };
    if (p.title?.trim()) next.title = p.title.trim().slice(0, 120);
    if (p.when && !isNaN(Date.parse(p.when))) next.when = new Date(p.when).toISOString();
    if (typeof p.where === 'string') next.where = p.where.slice(0, 200);
    if (typeof p.notes === 'string') next.notes = p.notes.slice(0, 4000);
    if (Array.isArray(p.questions)) next.questions = p.questions.map((q) => String(q).trim().slice(0, 300)).filter(Boolean).slice(0, 30);
    if (p.addQuestion?.trim()) next.questions = [...next.questions, p.addQuestion.trim().slice(0, 300)].slice(0, 30);
    this.#put('appt', id, a.at, next);
    this.#terms();
    return this.#get<Appt>('appt', id)!;
  }
  removeAppt(id: number): boolean {
    const ok = this.#del('appt', id);
    this.#terms();
    return ok;
  }
  /** An .ics file for the person's calendar (they add it; nothing is sent anywhere). */
  ics(id: number): string {
    const a = this.#get<Appt>('appt', id);
    if (!a) throw new HealthError(404, en('Appointment not found.'));
    const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const esc = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
    const end = new Date(Date.parse(a.when) + 3_600_000).toISOString();
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sara//Health//EN', 'BEGIN:VEVENT', `UID:health-${a.id}-${stamp(a.at)}@sara`, `DTSTAMP:${stamp(this.#now().toISOString())}`, `DTSTART:${stamp(a.when)}`, `DTEND:${stamp(end)}`, `SUMMARY:${esc(a.title)}`, ...(a.where ? [`LOCATION:${esc(a.where)}`] : []), ...(a.questions.length ? [`DESCRIPTION:${esc(a.questions.map((q) => `- ${q}`).join('\n'))}`] : []), 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  }

  // ---------------------------------------------------------------- symptoms, mood, sleep, measurements
  /** `manual`: only what the person logged by hand (no imported device days). */
  entries(f: { type?: EntryType; name?: string; from?: string; to?: string; limit?: number; manual?: boolean }): Entry[] {
    return this.#rows<Entry>('entry', f.from, f.to)
      .filter((e) => (!f.type || e.type === f.type) && (!f.name || e.name === f.name) && (!f.manual || !e.imp))
      .slice(0, f.limit ?? 2000);
  }
  addEntry(d: Quick & { at?: string }): Entry {
    const type = (['symptom', 'mood', 'sleep', 'measure'] as const).includes(d.type) ? d.type : 'symptom';
    const name = String(d.name ?? '').trim().toLowerCase().slice(0, 60);
    if (!name) throw new HealthError(400, en('Say what you are logging.'));
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined);
    const at = d.at && !isNaN(Date.parse(d.at)) ? new Date(d.at).toISOString() : this.#now().toISOString();
    const data: Omit<Entry, 'id' | 'at'> = { type, name };
    for (const [k, v] of [['value', n(d.value)], ['value2', n(d.value2)], ['scale', n(d.scale)]] as const) if (v !== undefined) (data as Record<string, unknown>)[k] = v;
    if (d.unit) data.unit = String(d.unit).slice(0, 12);
    if (d.note) data.note = String(d.note).slice(0, 1000);
    const id = this.#add<Entry>('entry', at, data);
    if (type === 'symptom') this.#terms();
    return this.#get<Entry>('entry', id)!;
  }
  removeEntry(id: number): boolean {
    const ok = this.#del('entry', id);
    this.#terms();
    return ok;
  }
  /** Points for a simple chart: one name over the last days (oldest first). */
  series(name: string, days = 30): { at: string; value: number; value2?: number }[] {
    const from = new Date(this.#now().getTime() - days * day).toISOString();
    return this.entries({ name, from })
      .filter((e) => typeof e.value === 'number')
      .reverse()
      .map((e) => ({ at: e.at, value: e.value!, ...(typeof e.value2 === 'number' ? { value2: e.value2 } : {}) }));
  }

  /** Words searched by Ask about anything (only from a private chat, with "include health" on). */
  search(words: string[]): { title: string; quote: string; when: string; kind: string }[] {
    const hit = (s: string) => words.some((w) => s.toLowerCase().includes(w));
    const out: { title: string; quote: string; when: string; kind: string }[] = [];
    for (const m of this.meds(true)) if (hit(`${m.name} ${m.dose} ${m.notes ?? ''}`)) out.push({ title: m.name, quote: `${m.name} ${m.dose} · ${m.times.join(', ')}`, when: m.at, kind: 'med' });
    for (const a of this.appts()) if (hit(`${a.title} ${a.where ?? ''} ${a.notes ?? ''} ${a.questions.join(' ')}`)) out.push({ title: a.title, quote: a.notes || a.questions.join('; ') || a.title, when: a.when, kind: 'appt' });
    for (const e of this.entries({ limit: 500, manual: true })) if (hit(`${e.name} ${e.note ?? ''}`)) out.push({ title: e.name, quote: entryText(e), when: e.at, kind: 'entry' });
    return out.slice(0, 20);
  }

  // ---------------------------------------------------------------- V4.3 imports from watches and phone apps
  /**
   * Readings from src/health-import.ts into sealed entries. One entry per measurement and day (a
   * weight per weighing): a day already there is left alone, unless the same app now says something
   * else (a day that was still going when the first export was made), so importing the same file
   * again adds nothing. Weight follows the unit the person already uses.
   */
  importReadings(rs: Reading[], source: ImportSource, file: string): ImportResult {
    const all = this.#rows<Entry>('entry');
    const have = new Map<string, Entry>();
    for (const e of all) if (e.imp) have.set(e.imp, e);
    let wUnit = all.find((e) => e.name === 'weight' && (e.unit === 'lb' || e.unit === 'kg'))?.unit;
    const now = this.#now().toISOString();
    let added = 0;
    let updated = 0;
    let same = 0;
    const days: string[] = [];
    this.#db.exec('BEGIN');
    try {
      const batch = this.#add<ImportBatch>('import', now, { source, file: String(file ?? '').slice(0, 120), added: 0, updated: 0 });
      for (const r of rs) {
        let value = r.value;
        let unit = r.unit;
        if (r.metric === 'weight') {
          wUnit ??= unit;
          if (unit !== wUnit && (unit === 'kg' || unit === 'lb')) {
            value = Math.round((unit === 'kg' ? value * LB : value / LB) * 10) / 10;
            unit = wUnit;
          }
        }
        const at = r.metric === 'weight' && r.at ? r.at : `${r.day}T12:00:00.000Z`;
        const key = r.metric === 'weight' ? `weight@${at.slice(0, 16)}` : `${r.metric}@${r.day}`;
        const ex = have.get(key);
        if (ex) {
          if (ex.src !== source || Math.abs((ex.value ?? 0) - value) < 0.01) same++;
          else {
            this.#put('entry', ex.id, ex.at, { ...ex, value });
            updated++;
            days.push(r.day);
          }
          continue;
        }
        const e: Omit<Entry, 'id' | 'at'> = { type: r.metric === 'sleep' ? 'sleep' : 'measure', name: r.metric, value, unit, imp: key, src: source, batch };
        have.set(key, { ...e, id: this.#add<Entry>('entry', at, e), at });
        added++;
        days.push(r.day);
      }
      days.sort();
      const range = days.length ? { from: days[0], to: days.at(-1)! } : {};
      if (added + updated) this.#put('import', batch, now, { source, file: String(file ?? '').slice(0, 120), added, updated, ...range });
      else this.#del('import', batch);
      this.#db.exec('COMMIT');
      return { batch: added + updated ? batch : 0, source, added, updated, same, ...range };
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }
  imports(): ImportBatch[] {
    return this.#rows<ImportBatch>('import');
  }
  /** Undo one import: its entries go (days it only updated keep the newer value). */
  removeImport(id: number): number {
    if (!this.#get<ImportBatch>('import', id)) throw new HealthError(404, en('That import is not in Health.'));
    let n = 0;
    this.#db.exec('BEGIN');
    try {
      for (const e of this.#rows<Entry>('entry')) if (e.batch === id && this.#del('entry', e.id)) n++;
      this.#del('import', id);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return n;
  }
  /** Steps, sleep, heart rate, resting heart rate and weight over the 30 days up to each one's newest day. */
  trends(): Trend[] {
    const tz = this.bind.tz?.();
    const dayOf = (e: Entry) => {
      if (e.imp && e.name !== 'weight') return e.imp.slice(e.imp.indexOf('@') + 1);
      const p = zonedParts(new Date(e.at), tz);
      return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    };
    const rows = this.#rows<Entry>('entry').filter((e) => typeof e.value === 'number' && (TREND_METRICS as readonly string[]).includes(e.name));
    const out: Trend[] = [];
    for (const m of TREND_METRICS) {
      const byDay = new Map<string, number>();
      let unit = '';
      for (const e of rows) {
        if (e.name !== m) continue;
        unit ||= e.unit ?? '';
        const d = dayOf(e);
        if (!byDay.has(d)) byDay.set(d, e.value!); // rows come newest first: the day's latest value
      }
      if (!byDay.size) continue;
      const daysAll = [...byDay.keys()].sort();
      const lastDay = daysAll.at(-1)!;
      const t0 = Date.parse(`${lastDay}T00:00:00Z`);
      const ago = (d: string) => Math.round((t0 - Date.parse(`${d}T00:00:00Z`)) / day);
      const points = daysAll.filter((d) => ago(d) < 30).map((d) => ({ day: d, value: byDay.get(d)! }));
      const r = (x: number) => (m === 'steps' ? Math.round(x) : Math.round(x * 10) / 10);
      const mean = (xs: number[]) => (xs.length ? r(xs.reduce((a, b) => a + b, 0) / xs.length) : undefined);
      const avg7 = mean(points.filter((p) => ago(p.day) < 7).map((p) => p.value))!;
      const prev7 = mean(points.filter((p) => ago(p.day) >= 7 && ago(p.day) < 14).map((p) => p.value));
      out.push({ name: m, unit, points, last: points.at(-1)!, avg7, ...(prev7 ? { prev7, change: Math.round(((avg7 - prev7) / prev7) * 100) } : {}) });
    }
    return out;
  }

  // ---------------------------------------------------------------- doctor summary
  summaryMarkdown(from: string, to: string, who = ''): string {
    const a = new Date(`${from}T00:00:00Z`).toISOString();
    const b = new Date(Date.parse(`${to}T00:00:00Z`) + day).toISOString();
    const L = this.bind.lang ?? ((s: string) => s);
    // Times in the person's own zone ("2026-11-17 08:05").
    const local = (iso: string) => {
      const p = zonedParts(new Date(iso), this.bind.tz?.());
      const z = (n: number) => String(n).padStart(2, '0');
      return `${p.y}-${z(p.mo)}-${z(p.d)} ${z(p.h)}:${z(p.mi)}`;
    };
    const lines: string[] = [`# ${L('Health summary')}${who ? ` · ${who}` : ''}`, '', `${from} – ${to}`, '', `> ${L(NOT_ADVICE)}`, ''];
    const meds = this.meds();
    lines.push(`## ${L('Medicines')}`, '');
    if (!meds.length) lines.push(L('None listed.'), '');
    for (const m of meds) {
      const ds = this.doses({ medId: m.id, from: a, to: b });
      const taken = ds.filter((d) => d.status === 'taken').length;
      const skipped = ds.filter((d) => d.status === 'skipped').length;
      lines.push(`- **${m.name}** ${m.dose} · ${m.times.join(', ')} · ${L('taken')} ${taken}, ${L('skipped')} ${skipped}`);
    }
    lines.push('');
    const all = this.entries({ from: a, to: b }).reverse();
    const es = all.filter((e) => !e.imp);
    const dev = all.filter((e) => e.imp && typeof e.value === 'number');
    if (dev.length) {
      // V4.3: device days as one line per measurement, not a row per day.
      lines.push(`## ${L(en('From your devices'))}`, '', `| ${L('What')} | ${L(en('Days'))} | ${L(en('Average'))} | ${L(en('Lowest'))} | ${L(en('Highest'))} | ${L(en('Unit'))} |`, '|---|---|---|---|---|---|');
      for (const m of TREND_METRICS) {
        const v = dev.filter((e) => e.name === m).map((e) => e.value!);
        if (!v.length) continue;
        const r = (x: number) => (m === 'steps' ? Math.round(x) : Math.round(x * 10) / 10);
        lines.push(`| ${m} | ${v.length} | ${r(v.reduce((x, y) => x + y, 0) / v.length)} | ${r(Math.min(...v))} | ${r(Math.max(...v))} | ${dev.find((e) => e.name === m)?.unit ?? ''} |`);
      }
      lines.push('');
    }
    for (const [type, title] of [['measure', 'Measurements'], ['symptom', 'Symptoms'], ['mood', 'Mood'], ['sleep', 'Sleep']] as const) {
      const list = es.filter((e) => e.type === type);
      if (!list.length) continue;
      lines.push(`## ${L(title)}`, '', `| ${L('Date')} | ${L('What')} | ${L('Value')} |`, '|---|---|---|');
      for (const e of list) lines.push(`| ${local(e.at)} | ${e.name} | ${entryValue(e)}${e.note ? ` (${e.note.replace(/\|/g, '/')})` : ''} |`);
      lines.push('');
    }
    const ap = this.appts().filter((x) => x.when >= a && x.when < b);
    if (ap.length) {
      lines.push(`## ${L('Appointments')}`, '');
      for (const x of ap) {
        lines.push(`- **${x.title}** ${local(x.when)}${x.where ? ` · ${x.where}` : ''}`);
        for (const q of x.questions) lines.push(`  - ${q}`);
        if (x.notes) lines.push(`  - ${L('After the visit:')} ${x.notes}`);
      }
      lines.push('');
    }
    lines.push(`_${L(NOT_ADVICE)}_`);
    return lines.join('\n');
  }
  summaryPdf(from: string, to: string, who = ''): Buffer {
    return makePdf({ format: 'pdf', title: (this.bind.lang ?? ((s: string) => s))('Health summary'), template: 'report', content: this.summaryMarkdown(from, to, who) }, () => undefined);
  }

  // ---------------------------------------------------------------- W4.4 coach state (goals, check-in slot)
  coachState<T>(): T | undefined {
    const r = this.#db.prepare("SELECT data FROM items WHERE kind = 'coach' LIMIT 1").get() as { data: Uint8Array } | undefined;
    return r ? this.#open<T>(r.data) : undefined;
  }
  setCoachState(v: object): void {
    this.#db.prepare("DELETE FROM items WHERE kind = 'coach'").run();
    this.#add('coach', this.#now().toISOString(), v as never);
  }

  // ---------------------------------------------------------------- V5.4 caregivers and check-ins
  /** The person's own consent list and the family they call (sealed like every record). */
  care(): CareState {
    const r = this.#db.prepare("SELECT data FROM items WHERE kind = 'care' LIMIT 1").get() as { data: Uint8Array } | undefined;
    const c = r ? this.#open<Partial<CareState>>(r.data) : {};
    return { grants: Array.isArray(c.grants) ? c.grants : [], contacts: Array.isArray(c.contacts) ? c.contacts : [] };
  }
  setCare(next: CareState): CareState {
    this.#db.prepare("DELETE FROM items WHERE kind = 'care'").run();
    this.#add('care', this.#now().toISOString(), { grants: next.grants, contacts: next.contacts });
    return this.care();
  }
  /** Withdraws one caregiver's consent (everything they saw is hidden on their next look). */
  removeCareGrant(person: string): boolean {
    const c = this.care();
    const grants = c.grants.filter((g) => g.person !== person);
    if (grants.length === c.grants.length) return false;
    this.setCare({ ...c, grants });
    return true;
  }
  /** Today's date where the person lives. */
  today(now: Date = this.#now()): string {
    const p = zonedParts(now, this.bind.tz?.());
    return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  }
  /** The daily check-in: one per day, the latest answer counts. */
  checkIn(status: CheckinStatus): Checkin {
    if (!CHECKIN_STATUSES.includes(status)) throw new HealthError(400, en('Pick a check-in answer.'));
    const now = this.#now();
    const dayKey = this.today(now);
    for (const c of this.checkins(3)) if (c.day === dayKey) this.#del('checkin', c.id);
    const id = this.#add<Checkin>('checkin', now.toISOString(), { day: dayKey, status });
    this.bind.checkedIn?.(status);
    return this.#get<Checkin>('checkin', id)!;
  }
  checkins(days = 14): Checkin[] {
    return this.#rows<Checkin>('checkin', new Date(this.#now().getTime() - days * day).toISOString());
  }

  /** What a parent sees of a child's log: medicines and doses only. */
  parentView(): { meds: (Med & { refill?: ReturnType<HealthLog['refill']> })[]; doses: Dose[] } {
    return { meds: this.meds(true).map((m) => ({ ...m, refill: this.refill(m.id) })), doses: this.doses({ from: new Date(this.#now().getTime() - 14 * day).toISOString() }) };
  }
}

function cleanMed(d: Partial<Med>): Omit<Med, 'id' | 'at' | 'name' | 'active'> {
  const times = (Array.isArray(d.times) ? d.times : []).map((t) => String(t).trim()).filter((t) => hhmm(t)).map((t) => t.padStart(5, '0')).slice(0, 8);
  const out: Omit<Med, 'id' | 'at' | 'name' | 'active'> = { dose: String(d.dose ?? '').trim().slice(0, 60), times };
  if (Array.isArray(d.days)) out.days = [...new Set(d.days.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort();
  if (typeof d.supply === 'number' && d.supply >= 0) out.supply = Math.round(d.supply);
  if (typeof d.perDose === 'number' && d.perDose > 0) out.perDose = d.perDose;
  if (typeof d.refilledOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.refilledOn)) out.refilledOn = d.refilledOn;
  if (typeof d.notes === 'string' && d.notes.trim()) out.notes = d.notes.trim().slice(0, 500);
  if (d.managedBy === 'parent') out.managedBy = 'parent';
  return out;
}

export function entryValue(e: Pick<Entry, 'value' | 'value2' | 'scale' | 'unit'>): string {
  if (typeof e.value !== 'number') return '';
  if (typeof e.value2 === 'number') return `${e.value}/${e.value2}${e.unit ? ` ${e.unit}` : ''}`;
  if (e.scale) return `${e.value}/${e.scale}`;
  return `${e.value}${e.unit ? ` ${e.unit}` : ''}`;
}
export function entryText(e: Entry): string {
  return `${e.name} ${entryValue(e)}`.trim();
}

// ------------------------------------------------------------------------------------------------
// Per space
// ------------------------------------------------------------------------------------------------

/** The person's own folder: a member's space, or the owner's data folder (shared by her companions). */
function spaceDir(app: AppContext): string {
  if (app.member) return app.dataDir;
  return app.family?.spaceDirOf?.('owner') ?? app.dataDir;
}

/** This person's health log, bound to their clock, time zone, language and phone notices. */
export function healthFor(app: AppContext): HealthLog {
  const h = HealthLog.open(spaceDir(app));
  h.bind = {
    now: () => app.now(),
    tz: () => app.settings.get().timeZone || undefined,
    lang: (s) => trOwner(s, app.settings.get()),
    notify: (title, body) => void app.push?.notifyOwner(title, body, '', 'health-dose').catch(() => undefined),
    checkedIn: (status) => careCheckedIn(app, status),
  };
  return h;
}

/** A child's log as their parent manages it (medicines and reminders only). */
export function kidHealth(app: AppContext, kidId: string): HealthLog {
  const f = app.family;
  if (!f || !f.store.isParent(f.person)) throw new HealthError(403, en("Only a parent can manage a child's medicines."));
  const kid = f.people().find((p) => p.id === kidId);
  if (!kid?.child) throw new HealthError(404, en('That person is not a child in this household.'));
  const dir = f.spaceDirOf?.(kidId);
  if (!dir) throw new HealthError(404, en('That person is not a child in this household.'));
  const h = HealthLog.open(dir);
  if (!h.bind.now) h.bind = { now: () => app.now(), tz: () => f.tz() };
  return h;
}

/** A chat turn's model may read the log: a local model, or a cloud model the person allowed. */
export function healthModelOk(app: AppContext, modelLocal: boolean | undefined): boolean {
  return modelLocal === true || healthFor(app).settings().cloudOk;
}

/** On the reminder tick (src/reminders.ts): dose reminders, only where a health log exists. */
export function healthTick(app: AppContext, now: Date): void {
  try {
    if (HealthLog.exists(app)) {
      healthFor(app).due(now);
      careTick(app, now);
    }
  } catch {
    /* a broken log never stops the tick */
  }
}
