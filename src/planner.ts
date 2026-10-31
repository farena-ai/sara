// Phase 3.7: projects, tasks, notes and reminders ("managing things"). Plain SQLite tables plus
// three small tools for Sara (todo, note, remind). Times are entered in the owner's time zone.
import type { DatabaseSync } from 'node:sqlite';
import { ftsQuery } from './memory.ts';
import type { Tool } from './tools/types.ts';
import { str, ToolError } from './tools/types.ts';

export type TaskStatus = 'open' | 'done';
export type Priority = 'low' | 'normal' | 'high';
export type Repeat = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';
export const REPEATS: readonly Repeat[] = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];
const PRIORITIES: readonly Priority[] = ['low', 'normal', 'high'];

export interface Project {
  id: number;
  name: string;
  description: string;
  status: 'active' | 'archived';
  /** Default workspace for new conversations in this project (coding projects keep their files together). */
  workspace: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Task {
  id: number;
  projectId: number | null;
  project: string | null;
  title: string;
  notes: string;
  status: TaskStatus;
  priority: Priority;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  conversationId: string | null;
  /** Phase 99 (ST4): a repeating to-do; done moves it to its next time and back to To do. */
  repeat: Repeat;
}

/** Phase 99 (ST4): what changed in the tasks (the board logs and pushes it; src/board.ts). */
export type TaskChange =
  | { what: 'added'; task: Task }
  | { what: 'updated'; task: Task; before: Task }
  | { what: 'repeated'; task: Task; before: Task }
  | { what: 'deleted'; id: number };
export interface Note {
  id: number;
  projectId: number | null;
  project: string | null;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}
export interface Reminder {
  id: number;
  text: string;
  dueAt: string;
  repeat: Repeat;
  conversationId: string | null;
  status: 'pending' | 'sent' | 'cancelled';
  createdAt: string;
  sentAt: string | null;
  /** Times this reminder has fired (repeating reminders). */
  fired: number;
  /** Phase 26: the owner asked her to call (not just message) when it's due. */
  call: boolean;
  /** Phase 29: a place reminder (arriving at or leaving a saved place) instead of a time. */
  placeId: number | null;
  placeEvent: 'arrive' | 'leave' | null;
  /** The day of the month a monthly reminder is for (the 31st stays the 31st after February). */
  anchorDay: number | null;
}

/** Phase 29: a place the owner saved (from the phone's location, or an address). */
export interface Place {
  id: number;
  name: string;
  lat: number;
  lon: number;
  /** Metres around the point that count as "there". */
  radius: number;
  createdAt: string;
}

/** Place reminders have no time; this far-future value keeps them out of the time scheduler. */
export const PLACE_DUE = '9999-12-31T00:00:00.000Z';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT,
  conversation_id TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body, content='notes', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  due_at TEXT NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'none',
  conversation_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  sent_at TEXT,
  fired INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status, due_at);
CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  radius INTEGER NOT NULL DEFAULT 150,
  created_at TEXT NOT NULL
);
`;

type Row = Record<string, string | number | null>;
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

// ---------------- time ----------------

/** Offset (ms) of a time zone from UTC at a given instant. */
function tzOffsetMs(at: Date, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Wall-clock time in a zone → absolute Date (handles DST). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone?: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - tzOffsetMs(new Date(guess), timeZone);
  t = guess - tzOffsetMs(new Date(t), timeZone);
  return new Date(t);
}

/** Midnight at the start of a local day ("2026-10-26") in a zone, as an absolute Date. */
export function dayStartUtc(day: string, timeZone?: string): Date {
  const [y, mo, d] = day.split('-').map(Number);
  return zonedToUtc(y, mo, d, 0, 0, timeZone);
}

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(at: Date, timeZone?: string): { y: number; mo: number; d: number; h: number; mi: number; wd: number } {
  const off = tzOffsetMs(at, timeZone);
  const l = new Date(at.getTime() + off);
  return { y: l.getUTCFullYear(), mo: l.getUTCMonth() + 1, d: l.getUTCDate(), h: l.getUTCHours(), mi: l.getUTCMinutes(), wd: l.getUTCDay() };
}

export function formatLocal(iso: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const UNIT_MS: Record<string, number> = { minute: 60_000, min: 60_000, hour: 3_600_000, hr: 3_600_000, day: 86_400_000, week: 604_800_000 };

/**
 * Parses a time the way people (and models) write it, in the owner's zone:
 * "in 20 minutes", "in 2 hours", "2026-10-25 09:00", "2026-10-25T09:00", "2026-10-25" (9 am),
 * "tomorrow 9am", "today at 17:30", "tonight", "friday 3pm", "9:30pm", ISO with Z/offset.
 */
export function parseWhen(input: string, now: Date, timeZone?: string, opts: { dateOnlyHour?: number } = {}): Date | null {
  const raw = input.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\b(at|on)\b /g, '');
  if (!raw) return null;
  const rel = raw.match(/^in (an?|\d+(?:\.\d+)?) ?(minutes?|mins?|hours?|hrs?|days?|weeks?)$/);
  if (rel) {
    const n = rel[1].startsWith('a') ? 1 : Number(rel[1]);
    const unit = UNIT_MS[rel[2].replace(/s$/, '')];
    return new Date(now.getTime() + n * unit);
  }
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const d = new Date(input.trim());
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{1,2}):(\d{2})(?::\d{2})?)?$/);
  if (iso) {
    const [, y, mo, d, h, mi] = iso;
    return zonedToUtc(+y, +mo, +d, h ? +h : (opts.dateOnlyHour ?? 9), mi ? +mi : 0, timeZone);
  }
  const m = raw.match(/^(today|tomorrow|tonight|this evening|this afternoon|this morning|next (?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|sunday|monday|tuesday|wednesday|thursday|friday|saturday)?\s*(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?|noon|midnight)?$/);
  if (!m || (!m[1] && !m[2] && !/noon|midnight/.test(raw))) return null;
  const p = zonedParts(now, timeZone);
  let dayOffset = 0;
  let defaultHour = opts.dateOnlyHour ?? 9;
  const word = m[1] ?? '';
  if (word === 'today') dayOffset = 0;
  else if (word === 'tomorrow') dayOffset = 1;
  else if (word === 'tonight' || word === 'this evening') defaultHour = 20;
  else if (word === 'this afternoon') defaultHour = 15;
  else if (word === 'this morning') defaultHour = 9;
  else if (word) {
    const target = WEEKDAYS.indexOf(word.replace('next ', ''));
    dayOffset = (target - p.wd + 7) % 7 || 7;
  }
  let h = defaultHour;
  let mi = 0;
  if (/noon/.test(raw)) h = 12;
  else if (/midnight/.test(raw)) h = 0;
  else if (m[2]) {
    h = Number(m[2]);
    mi = m[3] ? Number(m[3]) : 0;
    const ap = m[4]?.[0];
    if (h > 23 || mi > 59) return null;
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    if (!ap && (word === 'tonight' || word === 'this evening' || word === 'this afternoon') && h < 12) h += 12;
  }
  const base = new Date(Date.UTC(p.y, p.mo - 1, p.d + dayOffset));
  let at = zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, mi, timeZone);
  // A bare time already past today means tomorrow ("remind me at 9am" said at 10am).
  if (!word && at.getTime() <= now.getTime()) {
    const t = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
    at = zonedToUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), h, mi, timeZone);
  }
  return at;
}

/** Next occurrence of a repeating reminder strictly after `after`, keeping the wall-clock time. */
export function nextOccurrence(dueIso: string, repeat: Repeat, after: Date, timeZone?: string, anchorDay?: number | null): Date | null {
  if (repeat === 'none') return null;
  const p = zonedParts(new Date(dueIso), timeZone);
  if (repeat === 'monthly' && anchorDay) p.d = Math.max(p.d, anchorDay);
  for (let i = 1; i < 2000; i++) {
    let t: Date;
    let day: number;
    if (repeat === 'monthly') {
      t = new Date(Date.UTC(p.y, p.mo - 1 + i, 1));
      day = Math.min(p.d, new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate());
    } else {
      t = new Date(Date.UTC(p.y, p.mo - 1, p.d + i * (repeat === 'weekly' ? 7 : 1)));
      day = t.getUTCDate();
      if (repeat === 'weekdays' && t.getUTCDay() % 6 === 0) continue;
    }
    const at = zonedToUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, day, p.h, p.mi, timeZone);
    if (at > after) return at;
  }
  return null;
}

// ---------------- store ----------------

export class PlannerStore {
  readonly db: DatabaseSync;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.#now = now;
    db.exec(SCHEMA);
    const cols = new Set((db.prepare('PRAGMA table_info(projects)').all() as Row[]).map((r) => String(r.name)));
    if (!cols.has('workspace')) db.exec('ALTER TABLE projects ADD COLUMN workspace TEXT');
    const rcols = new Set((db.prepare('PRAGMA table_info(reminders)').all() as Row[]).map((r) => String(r.name)));
    if (!rcols.has('call')) db.exec('ALTER TABLE reminders ADD COLUMN call INTEGER NOT NULL DEFAULT 0');
    if (!rcols.has('place_id')) db.exec('ALTER TABLE reminders ADD COLUMN place_id INTEGER');
    if (!rcols.has('place_event')) db.exec('ALTER TABLE reminders ADD COLUMN place_event TEXT');
    if (!rcols.has('anchor_day')) db.exec('ALTER TABLE reminders ADD COLUMN anchor_day INTEGER');
    // Phase 99 (ST4): repeating to-dos (the board's other columns are added by src/board.ts).
    const tcols = new Set((db.prepare('PRAGMA table_info(tasks)').all() as Row[]).map((r) => String(r.name)));
    if (!tcols.has('repeat')) db.exec("ALTER TABLE tasks ADD COLUMN repeat TEXT NOT NULL DEFAULT 'none'");
  }

  /** Phase 99: told after every task change (the board's activity and live pushes). */
  readonly listeners = new Set<(c: TaskChange) => void>();
  /** The time zone repeating to-dos keep their wall-clock time in (set by the app). */
  timeZone: () => string | undefined = () => undefined;
  #emit(c: TaskChange): void {
    for (const fn of this.listeners) {
      try {
        fn(c);
      } catch (err) {
        console.warn(`planner listener: ${(err as Error).message}`);
      }
    }
  }

  #ts(): string {
    return this.#now().toISOString();
  }

  // projects
  projects(includeArchived = false): Project[] {
    return (this.db.prepare(`SELECT * FROM projects ${includeArchived ? '' : "WHERE status = 'active'"} ORDER BY name`).all() as Row[]).map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      description: String(r.description),
      status: r.status === 'archived' ? 'archived' : 'active',
      workspace: (r.workspace as string | null) ?? null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  /** Finds a project by name (case-insensitive), creating it if needed. */
  projectId(name: string | null | undefined): number | null {
    const n = name?.trim();
    if (!n) return null;
    if (n.length > 80) throw new ToolError('Project name is too long (max 80).');
    const r = this.db.prepare('SELECT id, status FROM projects WHERE name = ?').get(n) as Row | undefined;
    if (r) {
      if (r.status === 'archived') this.db.prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?").run(this.#ts(), r.id);
      return Number(r.id);
    }
    return Number(this.db.prepare('INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)').run(n, this.#ts(), this.#ts()).lastInsertRowid);
  }

  updateProject(id: number, patch: { name?: string; description?: string; status?: 'active' | 'archived'; workspace?: string | null }): Project | undefined {
    const cur = this.projects(true).find((p) => p.id === id);
    if (!cur) return undefined;
    this.db
      .prepare('UPDATE projects SET name = ?, description = ?, status = ?, workspace = ?, updated_at = ? WHERE id = ?')
      .run(patch.name?.trim() || cur.name, patch.description ?? cur.description, patch.status ?? cur.status, patch.workspace !== undefined ? patch.workspace : cur.workspace, this.#ts(), id);
    return this.projects(true).find((p) => p.id === id);
  }

  deleteProject(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes) > 0;
  }

  // tasks
  #task(r: Row): Task {
    return {
      id: Number(r.id),
      projectId: r.project_id === null ? null : Number(r.project_id),
      project: s(r.project_name),
      title: String(r.title),
      notes: String(r.notes),
      status: r.status === 'done' ? 'done' : 'open',
      priority: (PRIORITIES.includes(r.priority as Priority) ? r.priority : 'normal') as Priority,
      dueAt: s(r.due_at),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      doneAt: s(r.done_at),
      conversationId: s(r.conversation_id),
      repeat: (REPEATS.includes(r.repeat as Repeat) ? r.repeat : 'none') as Repeat,
    };
  }

  tasks(opts: { status?: TaskStatus | 'all'; projectId?: number | null } = {}): Task[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.status && opts.status !== 'all') {
      where.push('t.status = ?');
      args.push(opts.status);
    }
    if (opts.projectId !== undefined && opts.projectId !== null) {
      where.push('t.project_id = ?');
      args.push(opts.projectId);
    }
    const sql = `SELECT t.*, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY t.status = 'done', CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.due_at IS NULL, t.due_at, t.id LIMIT 500`;
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => this.#task(r));
  }

  task(id: number): Task | undefined {
    const r = this.db.prepare('SELECT t.*, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?').get(id) as Row | undefined;
    return r ? this.#task(r) : undefined;
  }

  addTask(t: { title: string; project?: string | null; notes?: string; priority?: Priority; dueAt?: string | null; conversationId?: string | null; repeat?: Repeat }): Task {
    const ts = this.#ts();
    const id = this.db
      .prepare('INSERT INTO tasks (project_id, title, notes, priority, due_at, created_at, updated_at, conversation_id, repeat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.projectId(t.project), t.title.trim(), t.notes ?? '', t.priority ?? 'normal', t.dueAt ?? null, ts, ts, t.conversationId ?? null, REPEATS.includes(t.repeat as Repeat) ? t.repeat! : 'none').lastInsertRowid;
    const task = this.task(Number(id))!;
    this.#emit({ what: 'added', task });
    return task;
  }

  updateTask(id: number, patch: { title?: string; project?: string | null; notes?: string; priority?: Priority; dueAt?: string | null; status?: TaskStatus; repeat?: Repeat }): Task | undefined {
    const cur = this.task(id);
    if (!cur) return undefined;
    let status = patch.status ?? cur.status;
    const ts = this.#ts();
    const repeat = patch.repeat !== undefined && REPEATS.includes(patch.repeat) ? patch.repeat : cur.repeat;
    let dueAt = patch.dueAt !== undefined ? patch.dueAt : cur.dueAt;
    // Phase 99: a repeating to-do that is done comes back open at its next time (the board puts it in To do).
    let repeated = false;
    if (status === 'done' && cur.status !== 'done' && repeat !== 'none') {
      const next = nextOccurrence(dueAt ?? ts, repeat, this.#now(), this.timeZone());
      if (next) {
        status = 'open';
        dueAt = next.toISOString();
        repeated = true;
      }
    }
    this.db
      .prepare('UPDATE tasks SET project_id = ?, title = ?, notes = ?, priority = ?, due_at = ?, status = ?, done_at = ?, updated_at = ?, repeat = ? WHERE id = ?')
      .run(
        patch.project !== undefined ? this.projectId(patch.project) : cur.projectId,
        patch.title?.trim() || cur.title,
        patch.notes ?? cur.notes,
        patch.priority ?? cur.priority,
        dueAt,
        status,
        status === 'done' ? (cur.doneAt ?? ts) : null,
        ts,
        repeat,
        id,
      );
    const task = this.task(id)!;
    this.#emit(repeated ? { what: 'repeated', task, before: cur } : { what: 'updated', task, before: cur });
    return task;
  }

  deleteTask(id: number): boolean {
    const gone = Number(this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes) > 0;
    if (gone) this.#emit({ what: 'deleted', id });
    return gone;
  }

  // notes
  #note(r: Row): Note {
    return { id: Number(r.id), projectId: r.project_id === null ? null : Number(r.project_id), project: s(r.project_name), title: String(r.title), body: String(r.body), createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
  }

  notes(q?: string, limit = 200): Note[] {
    const fts = q ? ftsQuery(q) : null;
    if (q && !fts) return [];
    if (fts) {
      return (
        this.db
          .prepare('SELECT n.*, p.name AS project_name FROM notes_fts f JOIN notes n ON n.id = f.rowid LEFT JOIN projects p ON p.id = n.project_id WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts) LIMIT ?')
          .all(fts, limit) as Row[]
      ).map((r) => this.#note(r));
    }
    return (this.db.prepare('SELECT n.*, p.name AS project_name FROM notes n LEFT JOIN projects p ON p.id = n.project_id ORDER BY n.updated_at DESC LIMIT ?').all(limit) as Row[]).map((r) => this.#note(r));
  }

  note(id: number): Note | undefined {
    const r = this.db.prepare('SELECT n.*, p.name AS project_name FROM notes n LEFT JOIN projects p ON p.id = n.project_id WHERE n.id = ?').get(id) as Row | undefined;
    return r ? this.#note(r) : undefined;
  }

  saveNote(n: { id?: number; title: string; body: string; project?: string | null }): Note {
    const ts = this.#ts();
    if (n.id) {
      const cur = this.note(n.id);
      if (!cur) throw new ToolError(`No note #${n.id}.`);
      this.db.prepare('UPDATE notes SET title = ?, body = ?, project_id = ?, updated_at = ? WHERE id = ?').run(n.title || cur.title, n.body, n.project !== undefined ? this.projectId(n.project) : cur.projectId, ts, n.id);
      return this.note(n.id)!;
    }
    const id = this.db.prepare('INSERT INTO notes (project_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(this.projectId(n.project), n.title, n.body, ts, ts).lastInsertRowid;
    return this.note(Number(id))!;
  }

  deleteNote(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM notes WHERE id = ?').run(id).changes) > 0;
  }

  // reminders
  #reminder(r: Row): Reminder {
    return {
      id: Number(r.id),
      text: String(r.text),
      dueAt: String(r.due_at),
      repeat: (REPEATS.includes(r.repeat as Repeat) ? r.repeat : 'none') as Repeat,
      conversationId: s(r.conversation_id),
      status: (['pending', 'sent', 'cancelled'].includes(String(r.status)) ? r.status : 'pending') as Reminder['status'],
      createdAt: String(r.created_at),
      sentAt: s(r.sent_at),
      fired: Number(r.fired),
      call: Number(r.call ?? 0) === 1,
      placeId: r.place_id === null || r.place_id === undefined ? null : Number(r.place_id),
      placeEvent: r.place_event === 'arrive' || r.place_event === 'leave' ? r.place_event : null,
      anchorDay: r.anchor_day === null || r.anchor_day === undefined ? null : Number(r.anchor_day),
    };
  }

  reminders(opts: { status?: Reminder['status'] | 'all'; limit?: number } = {}): Reminder[] {
    const st = opts.status ?? 'pending';
    return (
      this.db
        .prepare(`SELECT * FROM reminders ${st === 'all' ? '' : 'WHERE status = ?'} ORDER BY ${st === 'pending' ? 'due_at' : 'COALESCE(sent_at, due_at) DESC'} LIMIT ?`)
        .all(...(st === 'all' ? [opts.limit ?? 200] : [st, opts.limit ?? 200])) as Row[]
    ).map((r) => this.#reminder(r));
  }

  reminder(id: number): Reminder | undefined {
    const r = this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#reminder(r) : undefined;
  }

  addReminder(r: { text: string; dueAt: string; repeat?: Repeat; conversationId?: string | null; call?: boolean; place?: { id: number; event: 'arrive' | 'leave' } }): Reminder {
    const id = this.db
      .prepare('INSERT INTO reminders (text, due_at, repeat, conversation_id, created_at, call, place_id, place_event) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.text.trim(), r.place ? PLACE_DUE : r.dueAt, r.place ? 'none' : (r.repeat ?? 'none'), r.conversationId ?? null, this.#ts(), r.call ? 1 : 0, r.place?.id ?? null, r.place?.event ?? null).lastInsertRowid;
    return this.reminder(Number(id))!;
  }

  // ---------- Phase 29: places ----------
  #place(r: Row): Place {
    return { id: Number(r.id), name: String(r.name), lat: Number(r.lat), lon: Number(r.lon), radius: Number(r.radius), createdAt: String(r.created_at) };
  }
  places(): Place[] {
    return (this.db.prepare('SELECT * FROM places ORDER BY name COLLATE NOCASE').all() as Row[]).map((r) => this.#place(r));
  }
  place(id: number): Place | undefined {
    const r = this.db.prepare('SELECT * FROM places WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#place(r) : undefined;
  }
  placeByName(name: string): Place | undefined {
    const r = this.db.prepare('SELECT * FROM places WHERE name = ? COLLATE NOCASE').get(name.trim()) as Row | undefined;
    return r ? this.#place(r) : undefined;
  }
  /** Saves a place (same name: moves it). Coordinates and radius are checked. */
  savePlace(p: { name: string; lat: number; lon: number; radius?: number }): Place {
    const name = p.name.trim();
    if (!name || name.length > 60) throw new Error('Give the place a name (up to 60 characters).');
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) throw new Error('Those coordinates are not on Earth.');
    const radius = Math.round(Math.min(2000, Math.max(75, p.radius ?? 150)));
    const lat = Math.round(p.lat * 1e6) / 1e6;
    const lon = Math.round(p.lon * 1e6) / 1e6;
    this.db
      .prepare('INSERT INTO places (name, lat, lon, radius, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, radius = excluded.radius')
      .run(name, lat, lon, radius, this.#ts());
    return this.placeByName(name)!;
  }
  /** Deletes a place and cancels its waiting reminders. */
  deletePlace(id: number): boolean {
    this.db.prepare("UPDATE reminders SET status = 'cancelled' WHERE place_id = ? AND status = 'pending'").run(id);
    return Number(this.db.prepare('DELETE FROM places WHERE id = ?').run(id).changes) > 0;
  }
  /** Places the phone should watch: those with waiting reminders, and for which events. */
  watchedPlaces(): (Place & { events: ('arrive' | 'leave')[] })[] {
    const rows = this.db.prepare("SELECT place_id, place_event FROM reminders WHERE status = 'pending' AND place_id IS NOT NULL").all() as Row[];
    const by = new Map<number, Set<'arrive' | 'leave'>>();
    for (const r of rows) {
      const ev = r.place_event === 'leave' ? 'leave' : 'arrive';
      by.set(Number(r.place_id), (by.get(Number(r.place_id)) ?? new Set()).add(ev));
    }
    return [...by].flatMap(([id, evs]) => {
      const p = this.place(id);
      return p ? [{ ...p, events: [...evs].sort() }] : [];
    });
  }
  /** Waiting reminders for arriving at / leaving a place. */
  placeReminders(placeId: number, event: 'arrive' | 'leave'): Reminder[] {
    return (this.db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND place_id = ? AND COALESCE(place_event, 'arrive') = ? ORDER BY id").all(placeId, event) as Row[]).map((r) => this.#reminder(r));
  }

  cancelReminder(id: number): boolean {
    return Number(this.db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id).changes) > 0;
  }

  dueReminders(now: Date): Reminder[] {
    return (this.db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at").all(now.toISOString()) as Row[]).map((r) => this.#reminder(r));
  }

  /** Marks a reminder delivered; repeating ones move to their next time. */
  markFired(id: number, next: Date | null, anchorDay?: number): void {
    const ts = this.#ts();
    if (next) this.db.prepare('UPDATE reminders SET due_at = ?, sent_at = ?, fired = fired + 1, anchor_day = COALESCE(?, anchor_day) WHERE id = ?').run(next.toISOString(), ts, anchorDay ?? null, id);
    else this.db.prepare("UPDATE reminders SET status = 'sent', sent_at = ?, fired = fired + 1 WHERE id = ?").run(ts, id);
  }

  /** Short overview for Sara's prompt: overdue/today tasks and the next reminders. */
  agenda(now: Date, timeZone?: string): string {
    const lines: string[] = [];
    const p = zonedParts(now, timeZone);
    const endOfDay = zonedToUtc(p.y, p.mo, p.d, 23, 59, timeZone);
    const weekAhead = new Date(endOfDay.getTime() + 7 * 86_400_000);
    const open = this.tasks({ status: 'open' });
    const due = open.filter((t) => t.dueAt && new Date(t.dueAt) <= weekAhead).slice(0, 5);
    for (const t of due) {
      const at = new Date(t.dueAt!);
      const when = at < now ? 'OVERDUE, was due' : at <= endOfDay ? 'due today' : 'due';
      lines.push(`- task #${t.id} "${t.title}"${t.project ? ` (${t.project})` : ''}: ${when} ${formatLocal(t.dueAt!, timeZone)}`);
    }
    const rest = open.length - due.length;
    if (rest > 0) lines.push(`- ${rest} other open task${rest === 1 ? '' : 's'} (use the todo tool to list them)`);
    for (const r of this.reminders({ status: 'pending', limit: 3 })) {
      const pl = r.placeId ? this.place(r.placeId) : undefined;
      lines.push(`- reminder #${r.id} "${r.text}" ${r.placeId ? `when ${r.placeEvent === 'leave' ? 'leaving' : 'arriving at'} ${pl?.name ?? 'a place'}` : `at ${formatLocal(r.dueAt, timeZone)}`}${r.repeat !== 'none' ? ` (${r.repeat})` : ''}`);
    }
    return lines.join('\n');
  }
}

// ---------------- tools ----------------

export interface PlannerToolDeps {
  planner: PlannerStore;
  now: () => Date;
  timeZone: () => string | undefined;
  /** Phase 26: are calls from her switched on? */
  callsOn?: () => boolean;
}

const idArg = (args: Record<string, unknown>): number => {
  const n = Number(args.id);
  if (!Number.isInteger(n) || n <= 0) throw new ToolError('Give the item "id" (a number from the list).');
  return n;
};

function dueArg(deps: PlannerToolDeps, v: unknown, dateOnlyHour?: number): string | null {
  if (v === undefined || v === null || v === '' || v === 'none') return null;
  const d = parseWhen(String(v), deps.now(), deps.timeZone(), { dateOnlyHour });
  if (!d) throw new ToolError(`Couldn't understand the time "${String(v)}". Use "YYYY-MM-DD HH:MM" (owner's local time), "tomorrow 9am", "friday 3pm" or "in 2 hours".`);
  return d.toISOString();
}

function taskLine(t: Task, tz?: string): string {
  return `#${t.id} [${t.status === 'done' ? 'x' : ' '}] ${t.title}${t.priority !== 'normal' ? ` (${t.priority})` : ''}${t.dueAt ? ` — due ${formatLocal(t.dueAt, tz)}` : ''}${t.notes ? ` — ${t.notes.slice(0, 120)}` : ''}`;
}

export function createPlannerTools(deps: PlannerToolDeps): Tool[] {
  const { planner } = deps;
  const todo: Tool = {
    spec: {
      name: 'todo',
      description:
        "The owner's to-do list and projects. Actions: add (title, optional project, due, priority low|normal|high, notes), list (optional project, status open|done|all), update (id + fields), done (id), reopen (id), delete (id). Due times are in the owner's local time, e.g. \"2026-10-25 17:00\", \"tomorrow 5pm\", \"friday\".",
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'update', 'done', 'reopen', 'delete'] },
          id: { type: 'number', description: 'Task id (for update/done/reopen/delete)' },
          title: { type: 'string' },
          project: { type: 'string', description: 'Project name; created if new' },
          due: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high'] },
          notes: { type: 'string' },
          status: { type: 'string', enum: ['open', 'done', 'all'] },
          repeat: { type: 'string', enum: [...REPEATS], description: 'A to-do that comes back (daily, weekdays, weekly, monthly); done moves it to its next time' },
        },
        required: ['action'],
      },
    },
    defaultPermission: 'auto',
    summarize: (a) => `todo ${String(a.action ?? '')}${a.title ? `: ${String(a.title)}` : a.id ? ` #${String(a.id)}` : ''}`,
    async run(args, ctx) {
      const tz = deps.timeZone();
      const action = str(args, 'action');
      const prio = args.priority === undefined || args.priority === '' ? undefined : String(args.priority);
      if (prio && !PRIORITIES.includes(prio as Priority)) throw new ToolError('priority must be low, normal or high.');
      switch (action) {
        case 'add': {
          const title = str(args, 'title').trim();
          if (title.length > 300) throw new ToolError('Title is too long (max 300).');
          const rep = args.repeat ? String(args.repeat) : 'none';
          if (!REPEATS.includes(rep as Repeat)) throw new ToolError(`repeat must be one of ${REPEATS.join(', ')}.`);
          const t = planner.addTask({ title, project: args.project ? String(args.project) : null, notes: args.notes ? String(args.notes) : '', priority: prio as Priority | undefined, dueAt: dueArg(deps, args.due, 17), conversationId: ctx.conversationId ?? null, repeat: rep as Repeat });
          return `Added task ${taskLine(t, tz)}${t.project ? ` in project "${t.project}"` : ''}.`;
        }
        case 'list': {
          const status = (['open', 'done', 'all'].includes(String(args.status)) ? args.status : 'open') as TaskStatus | 'all';
          let projectId: number | undefined;
          if (args.project) {
            const p = planner.projects(true).find((x) => x.name.toLowerCase() === String(args.project).toLowerCase());
            if (!p) return `No project called "${String(args.project)}". Projects: ${planner.projects().map((x) => x.name).join(', ') || 'none'}.`;
            projectId = p.id;
          }
          const list = planner.tasks({ status, projectId });
          if (!list.length) return `No ${status === 'all' ? '' : `${status} `}tasks${args.project ? ` in "${String(args.project)}"` : ''}.`;
          const groups = new Map<string, Task[]>();
          for (const t of list) groups.set(t.project ?? '(no project)', [...(groups.get(t.project ?? '(no project)') ?? []), t]);
          return [...groups].map(([name, ts]) => `${name}:\n${ts.map((t) => `  ${taskLine(t, tz)}`).join('\n')}`).join('\n');
        }
        case 'update': {
          const t = planner.updateTask(idArg(args), {
            ...(args.title ? { title: String(args.title) } : {}),
            ...(args.project !== undefined ? { project: args.project ? String(args.project) : null } : {}),
            ...(args.notes !== undefined ? { notes: String(args.notes) } : {}),
            ...(prio ? { priority: prio as Priority } : {}),
            ...(args.due !== undefined ? { dueAt: dueArg(deps, args.due, 17) } : {}),
            ...(args.repeat && REPEATS.includes(String(args.repeat) as Repeat) ? { repeat: String(args.repeat) as Repeat } : {}),
          });
          if (!t) throw new ToolError(`No task #${String(args.id)}.`);
          return `Updated ${taskLine(t, tz)}.`;
        }
        case 'done':
        case 'reopen': {
          const before = planner.task(idArg(args));
          const t = planner.updateTask(idArg(args), { status: action === 'done' ? 'done' : 'open' });
          if (!t) throw new ToolError(`No task #${String(args.id)}.`);
          if (action === 'done' && before?.status === 'open' && t.status === 'open' && t.repeat !== 'none') return `Completed ${taskLine(before, tz)}; it repeats ${t.repeat}, so it's back for ${t.dueAt ? formatLocal(t.dueAt, tz) : 'next time'}.`;
          return `${action === 'done' ? 'Completed' : 'Reopened'} ${taskLine(t, tz)}.`;
        }
        case 'delete': {
          const t = planner.task(idArg(args));
          if (!t || !planner.deleteTask(t.id)) throw new ToolError(`No task #${String(args.id)}.`);
          return `Deleted task #${t.id} "${t.title}".`;
        }
        default:
          throw new ToolError('action must be add, list, update, done, reopen or delete.');
      }
    },
  };

  const note: Tool = {
    spec: {
      name: 'note',
      description: 'Notes you keep for the owner (ideas, details, plans, lists). Actions: save (title, body, optional project; with id to replace), search (query), read (id), list, delete (id).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['save', 'search', 'read', 'list', 'delete'] },
          id: { type: 'number' },
          title: { type: 'string' },
          body: { type: 'string' },
          project: { type: 'string' },
          query: { type: 'string' },
        },
        required: ['action'],
      },
    },
    defaultPermission: 'auto',
    summarize: (a) => `note ${String(a.action ?? '')}${a.title ? `: ${String(a.title)}` : a.query ? `: ${String(a.query)}` : a.id ? ` #${String(a.id)}` : ''}`,
    async run(args) {
      const action = str(args, 'action');
      const head = (n: Note) => `#${n.id} "${n.title}"${n.project ? ` (${n.project})` : ''}, updated ${n.updatedAt.slice(0, 10)}`;
      switch (action) {
        case 'save': {
          const body = str(args, 'body');
          if (body.length > 50_000) throw new ToolError('Note is too long (max 50,000 characters).');
          const title = (args.title ? String(args.title) : body.split('\n')[0]).trim().slice(0, 120) || 'Note';
          const n = planner.saveNote({ ...(args.id ? { id: idArg(args) } : {}), title, body, ...(args.project !== undefined ? { project: args.project ? String(args.project) : null } : {}) });
          return `Saved note ${head(n)}.`;
        }
        case 'search': {
          const list = planner.notes(str(args, 'query'), 10);
          return list.length ? list.map((n) => `${head(n)}: ${n.body.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n') : 'No matching notes.';
        }
        case 'list': {
          const list = planner.notes(undefined, 50);
          return list.length ? list.map(head).join('\n') : 'No notes yet.';
        }
        case 'read': {
          const n = planner.note(idArg(args));
          if (!n) throw new ToolError(`No note #${String(args.id)}.`);
          return `${head(n)}\n\n${n.body}`;
        }
        case 'delete': {
          const n = planner.note(idArg(args));
          if (!n || !planner.deleteNote(n.id)) throw new ToolError(`No note #${String(args.id)}.`);
          return `Deleted note #${n.id} "${n.title}".`;
        }
        default:
          throw new ToolError('action must be save, search, read, list or delete.');
      }
    },
  };

  const remind: Tool = {
    spec: {
      name: 'remind',
      description:
        "Reminders that pop up in this chat at a set time, or when the owner arrives at or leaves a saved place. Actions: set (text, and either when or place; optional repeat none|daily|weekdays|weekly|monthly for timed ones; optional call=true when the owner asks you to CALL them then, e.g. \"call me at 5\"), list, cancel (id), places (the saved places). \"when\" is the owner's local time: \"2026-10-25 09:00\", \"tomorrow 9am\", \"friday 3pm\", \"in 20 minutes\". For \"when I get to the store\" use place (a saved place's name) and on=arrive (or on=leave for \"when I leave work\"). Only say a reminder is set after this tool confirms it.",
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['set', 'list', 'cancel', 'places'] },
          place: { type: 'string', description: 'A saved place name (see action=places), for "when I get to…"' },
          on: { type: 'string', enum: ['arrive', 'leave'], description: 'With place: arriving (default) or leaving' },
          text: { type: 'string', description: 'What to remind about, e.g. "call the accountant"' },
          when: { type: 'string' },
          repeat: { type: 'string', enum: [...REPEATS] },
          call: { type: 'boolean', description: 'Ring the owner (a phone call in the Sara app) instead of only a chat message.' },
          id: { type: 'number' },
        },
        required: ['action'],
      },
    },
    defaultPermission: 'auto',
    summarize: (a) => `remind ${String(a.action ?? '')}${a.text ? `: ${String(a.text)}` : a.id ? ` #${String(a.id)}` : ''}${a.when ? ` (${String(a.when)})` : ''}`,
    async run(args, ctx) {
      const tz = deps.timeZone();
      const action = str(args, 'action');
      const placesHint = () => {
        const all = planner.places();
        return all.length ? `Saved places: ${all.map((p) => p.name).join(', ')}.` : 'No places are saved yet.';
      };
      if (action === 'places') {
        const all = planner.places();
        return all.length ? `${all.map((p) => `- ${p.name}`).join('\n')}\nPlace reminders need the Sara phone app with place reminders on (Settings → Phone and notifications).` : 'No places saved yet. The owner can save one in the Sara phone app (Planner → Places → "Save where I am") or by address in Planner → Places.';
      }
      if (action === 'set') {
        const text = str(args, 'text').trim();
        if (text.length > 500) throw new ToolError('Reminder text is too long (max 500).');
        const placeName = str(args, 'place', false);
        if (placeName) {
          const place = planner.placeByName(placeName);
          if (!place) throw new ToolError(`There's no saved place called "${placeName}". ${placesHint()} New places are saved in the Sara phone app (Planner → Places → "Save where I am") or by address in Planner → Places.`);
          const event = str(args, 'on', false) === 'leave' ? 'leave' : 'arrive';
          const r = planner.addReminder({ text, dueAt: PLACE_DUE, conversationId: ctx.conversationId ?? null, call: args.call === true, place: { id: place.id, event } });
          return `Reminder #${r.id} set for when the owner ${event === 'arrive' ? 'arrives at' : 'leaves'} ${place.name}: "${r.text}". It needs the Sara phone app with place reminders switched on; the phone only tells the server "arrived at ${place.name}", never the location itself.`;
        }
        const due = dueArg(deps, str(args, 'when'));
        if (!due) throw new ToolError('Missing "when".');
        if (new Date(due).getTime() < deps.now().getTime() - 60_000) throw new ToolError(`That time (${formatLocal(due, tz)}) is in the past.`);
        const repeat = (args.repeat ? String(args.repeat) : 'none') as Repeat;
        if (!REPEATS.includes(repeat)) throw new ToolError(`repeat must be one of ${REPEATS.join(', ')}.`);
        const call = args.call === true;
        const r = planner.addReminder({ text, dueAt: due, repeat, conversationId: ctx.conversationId ?? null, call });
        const how = !call ? 'It will appear in this chat.' : deps.callsOn?.() ? 'You will call then (if not answered, it becomes a message).' : 'Calls from you are off (Settings → Voice → Calls from her), so it will come as a message; tell the owner they can switch calls on there.';
        return `Reminder #${r.id} set for ${formatLocal(r.dueAt, tz)}${repeat !== 'none' ? `, repeating ${repeat}` : ''}: "${r.text}". ${how}`;
      }
      if (action === 'list') {
        const list = planner.reminders({ status: 'pending' });
        const where = (r: Reminder) => {
          const pl = r.placeId ? planner.place(r.placeId) : undefined;
          return `when ${r.placeEvent === 'leave' ? 'leaving' : 'arriving at'} ${pl?.name ?? 'a deleted place'}`;
        };
        return list.length ? list.map((r) => `#${r.id} ${r.placeId ? where(r) : formatLocal(r.dueAt, tz)}${r.repeat !== 'none' ? ` (${r.repeat})` : ''}${r.call ? ' (call)' : ''}: ${r.text}`).join('\n') : 'No upcoming reminders.';
      }
      if (action === 'cancel') {
        const id = idArg(args);
        const r = planner.reminder(id);
        if (!r || !planner.cancelReminder(id)) throw new ToolError(`No upcoming reminder #${id}.`);
        return `Cancelled reminder #${id}: "${r.text}".`;
      }
      throw new ToolError('action must be set, list, cancel or places.');
    },
  };
  return [todo, note, remind];
}
