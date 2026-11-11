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
  /**
   * Phase 108 (CH2): a channel's own project ('channel:telegram', 'channel:discord',
   * 'channel:plugin-signal'); null for the owner's projects. Renamable and hideable, never archived.
   */
  builtin: string | null;
  /** Phase 108: taken out of the sidebar ("Hidden projects" brings it back); its sessions stay searchable. */
  hidden: boolean;
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
  /** Phase 119 (RECALL §4.11): 'mention' = a "when it comes up" reminder (no time, no place); null = time or place. */
  trigger: 'mention' | null;
  /** Its keys as JSON (src/mentions.ts MentionData). */
  mention: string | null;
  /** Every time (with a gap) instead of once. */
  each: boolean;
  expiresAt: string | null;
  /** Why it ended: 'raised' | 'expired' | 'forgot'. */
  ended: string | null;
  /** When it may come up again ('every time': after the gap; 'ask': null until Keep it). */
  armedAt: string | null;
}

/** Phase 119: one time a "when it comes up" reminder came up (RECALL §4.11). */
export interface ReminderFire {
  id: number;
  reminderId: number;
  conversationId: string;
  messageId: number;
  replyId: number | null;
  why: string;
  raised: 'her' | 'app';
  answer: 'done' | 'again' | 'forget' | null;
  at: string;
}

/** 3.4.2: why a note version was kept: the change that came after it. */
export type NoteVersionReason = 'edit' | 'replace' | 'add' | 'restore' | 'delete';

/** 3.4.2: a note as it was before one change. */
export interface NoteVersion {
  id: number;
  noteId: number;
  title: string;
  body: string;
  projectId: number | null;
  /** When the change came (the version was current until then). */
  at: string;
  reason: NoteVersionReason;
}

/** 3.4.2: a deleted note's last version is kept this long (like the skills trash), then cleared. */
export const NOTE_TRASH_DAYS = 30;
/** Versions kept per note (the oldest go first); a note's current text is never touched by this. */
export const NOTE_VERSIONS_KEPT = 100;
/** The longest a note can be (tool, API and adds). */
export const NOTE_MAX = 50_000;

/** Lowercase words only, for matching a note by a close title ("Frank's medical records" ~ "medical records"). */
export function noteTitleKey(s: string): string {
  return s.toLowerCase().replace(/['’]s\b/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
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
-- 3.4.2: the version of a note before each change (edit, replace, add, restore, delete), so nothing
-- is lost. No foreign key: a deleted note's last version stays for NOTE_TRASH_DAYS so it can come back.
CREATE TABLE IF NOT EXISTS note_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  project_id INTEGER,
  at TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS note_versions_note ON note_versions(note_id, id);
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
    // Phase 108 (CH2): channel projects (docs/design/CHATS.md §5.3). Older versions ignore both columns.
    if (!cols.has('builtin')) db.exec('ALTER TABLE projects ADD COLUMN builtin TEXT');
    if (!cols.has('hidden')) db.exec('ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS projects_builtin ON projects(builtin) WHERE builtin IS NOT NULL');
    const rcols = new Set((db.prepare('PRAGMA table_info(reminders)').all() as Row[]).map((r) => String(r.name)));
    if (!rcols.has('call')) db.exec('ALTER TABLE reminders ADD COLUMN call INTEGER NOT NULL DEFAULT 0');
    if (!rcols.has('place_id')) db.exec('ALTER TABLE reminders ADD COLUMN place_id INTEGER');
    if (!rcols.has('place_event')) db.exec('ALTER TABLE reminders ADD COLUMN place_event TEXT');
    if (!rcols.has('anchor_day')) db.exec('ALTER TABLE reminders ADD COLUMN anchor_day INTEGER');
    // Phase 119 (RECALL §4.11): "when it comes up" reminders on the same row, and each time one came up.
    for (const [c, type] of [['trigger', 'TEXT'], ['mention', 'TEXT'], ['each', 'INTEGER NOT NULL DEFAULT 0'], ['expires_at', 'TEXT'], ['ended', 'TEXT'], ['armed_at', 'TEXT']] as const) if (!rcols.has(c)) db.exec(`ALTER TABLE reminders ADD COLUMN ${c} ${type}`);
    db.exec(`CREATE INDEX IF NOT EXISTS reminders_mention ON reminders(trigger, status) WHERE trigger IS NOT NULL;
CREATE TABLE IF NOT EXISTS reminder_fires (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_id INTEGER NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  reply_id INTEGER,
  why TEXT NOT NULL,
  raised TEXT NOT NULL,
  answer TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reminder_fires_r ON reminder_fires(reminder_id, at);`);
    // Phase 99 (ST4): repeating to-dos (the board's other columns are added by src/board.ts).
    const tcols = new Set((db.prepare('PRAGMA table_info(tasks)').all() as Row[]).map((r) => String(r.name)));
    if (!tcols.has('repeat')) db.exec("ALTER TABLE tasks ADD COLUMN repeat TEXT NOT NULL DEFAULT 'none'");
    // 3.4.2: old deleted-note copies are cleared when notes are deleted or the deleted list is read,
    // not here (the clock may not be ready while the app is still being put together).
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
      builtin: (r.builtin as string | null | undefined) ?? null,
      hidden: Number(r.hidden ?? 0) === 1,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  /** Phase 108 (CH2): the channel project with this builtin key, if it exists. */
  builtinProject(key: string): Project | undefined {
    return this.projects(true).find((p) => p.builtin === key);
  }

  /**
   * Phase 108: creates a channel's project. A name the owner already uses is never taken over:
   * the builtin is then "<name> chats" (and a number after that, if even that is taken).
   */
  createBuiltinProject(key: string, name: string): Project {
    const have = this.builtinProject(key);
    if (have) return have;
    const taken = (n: string) => Boolean(this.db.prepare('SELECT 1 FROM projects WHERE name = ?').get(n));
    let pick = name;
    if (taken(pick)) pick = `${name} chats`;
    for (let i = 2; taken(pick) && i < 100; i++) pick = `${name} chats ${i}`;
    const ts = this.#ts();
    this.db.prepare('INSERT INTO projects (name, created_at, updated_at, builtin) VALUES (?, ?, ?, ?)').run(pick, ts, ts, key);
    return this.builtinProject(key)!;
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

  updateProject(id: number, patch: { name?: string; description?: string; status?: 'active' | 'archived'; workspace?: string | null; hidden?: boolean }): Project | undefined {
    const cur = this.projects(true).find((p) => p.id === id);
    if (!cur) return undefined;
    this.db
      .prepare('UPDATE projects SET name = ?, description = ?, status = ?, workspace = ?, hidden = ?, updated_at = ? WHERE id = ?')
      .run(patch.name?.trim() || cur.name, patch.description ?? cur.description, patch.status ?? cur.status, patch.workspace !== undefined ? patch.workspace : cur.workspace, (patch.hidden ?? cur.hidden) ? 1 : 0, this.#ts(), id);
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

  saveNote(n: { id?: number; title: string; body: string; project?: string | null }, reason: NoteVersionReason = 'edit'): Note {
    const ts = this.#ts();
    if (n.id) {
      const cur = this.note(n.id);
      if (!cur) throw new ToolError(`No note #${n.id}.`);
      const title = n.title || cur.title;
      const projectId = n.project !== undefined ? this.projectId(n.project) : cur.projectId;
      if (title === cur.title && n.body === cur.body && projectId === cur.projectId) return cur;
      this.#keepVersion(cur, reason);
      this.db.prepare('UPDATE notes SET title = ?, body = ?, project_id = ?, updated_at = ? WHERE id = ?').run(title, n.body, projectId, ts, n.id);
      return this.note(n.id)!;
    }
    const id = this.db.prepare('INSERT INTO notes (project_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(this.projectId(n.project), n.title, n.body, ts, ts).lastInsertRowid;
    return this.note(Number(id))!;
  }

  /**
   * 3.4.2: add a dated section to the end of a note, never touching what is already there. Finds
   * the note by id, else by the same or a close title (the most recently changed one), else makes
   * a new note with that title.
   */
  addToNote(a: { id?: number; title?: string; text: string; heading: string; project?: string | null }): { note: Note; created: boolean } {
    const text = a.text.trim();
    if (!text) throw new ToolError('Give the "text" to add.');
    const section = `${a.heading}\n${text}`;
    const cur = a.id ? this.note(a.id) : a.title ? this.noteByTitle(a.title) : undefined;
    if (a.id && !cur) throw new ToolError(`No note #${a.id}.`);
    if (!cur) {
      const title = (a.title ?? text.split('\n')[0]).trim().slice(0, 120) || 'Note';
      if (section.length > NOTE_MAX) throw new ToolError(`That is too long for one note (max ${NOTE_MAX.toLocaleString('en-US')} characters).`);
      return { note: this.saveNote({ title, body: section, ...(a.project !== undefined ? { project: a.project } : {}) }), created: true };
    }
    const body = cur.body.trim() ? `${cur.body.trimEnd()}\n\n${section}` : section;
    if (body.length > NOTE_MAX) throw new ToolError(`Note #${cur.id} is full (max ${NOTE_MAX.toLocaleString('en-US')} characters). Nothing was changed: add this to a new note, e.g. "${cur.title.slice(0, 60)} (part 2)".`);
    return { note: this.saveNote({ id: cur.id, title: cur.title, body }, 'add'), created: false };
  }

  /** 3.4.2: the note with this title (any case), else the newest whose title contains it or is contained in it. */
  noteByTitle(title: string): Note | undefined {
    const key = noteTitleKey(title);
    if (!key) return undefined;
    const all = this.notes(undefined, 1000);
    const exact = all.find((n) => noteTitleKey(n.title) === key);
    if (exact) return exact;
    if (key.length < 4) return undefined;
    return all.find((n) => {
      const k = noteTitleKey(n.title);
      return k.length >= 4 && (k.includes(key) || key.includes(k));
    });
  }

  #keepVersion(cur: Note, reason: NoteVersionReason): void {
    this.db.prepare('INSERT INTO note_versions (note_id, title, body, project_id, at, reason) VALUES (?, ?, ?, ?, ?, ?)').run(cur.id, cur.title, cur.body, cur.projectId, this.#ts(), reason);
    this.db.prepare('DELETE FROM note_versions WHERE note_id = ? AND id NOT IN (SELECT id FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT ?)').run(cur.id, cur.id, NOTE_VERSIONS_KEPT);
  }

  /** 3.4.2: a note's earlier versions, newest first (a deleted note's too, for NOTE_TRASH_DAYS). */
  noteVersions(noteId: number): NoteVersion[] {
    return (this.db.prepare('SELECT * FROM note_versions WHERE note_id = ? ORDER BY id DESC').all(noteId) as Row[]).map((r) => ({
      id: Number(r.id),
      noteId: Number(r.note_id),
      title: String(r.title),
      body: String(r.body),
      projectId: r.project_id === null ? null : Number(r.project_id),
      at: String(r.at),
      reason: String(r.reason) as NoteVersionReason,
    }));
  }

  /** 3.4.2: notes deleted in the last NOTE_TRASH_DAYS (their last version), newest first. */
  deletedNotes(): NoteVersion[] {
    this.pruneNoteVersions();
    const rows = this.db.prepare("SELECT v.id FROM note_versions v WHERE v.reason = 'delete' AND v.note_id NOT IN (SELECT id FROM notes) AND v.id = (SELECT MAX(id) FROM note_versions w WHERE w.note_id = v.note_id) ORDER BY v.id DESC").all() as Row[];
    return rows.map((r) => this.#version(Number(r.id))!);
  }

  #version(id: number): NoteVersion | undefined {
    const r = this.db.prepare('SELECT note_id FROM note_versions WHERE id = ?').get(id) as Row | undefined;
    return r ? this.noteVersions(Number(r.note_id)).find((v) => v.id === id) : undefined;
  }

  /** 3.4.2: bring a version back (the current text is kept as a version first). A deleted note comes back with its id. */
  restoreNoteVersion(noteId: number, versionId: number): Note {
    const v = this.noteVersions(noteId).find((x) => x.id === versionId);
    if (!v) throw new ToolError(`No version ${versionId} of note #${noteId}.`);
    const cur = this.note(noteId);
    if (cur) {
      this.#keepVersion(cur, 'restore');
      this.db.prepare('UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ?').run(v.title, v.body, this.#ts(), noteId);
    } else {
      const project = v.projectId !== null && this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(v.projectId) ? v.projectId : null;
      const ts = this.#ts();
      this.db.prepare('INSERT INTO notes (id, project_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(noteId, project, v.title, v.body, ts, ts);
    }
    return this.note(noteId)!;
  }

  /** 3.4.2: clear the kept copies of notes deleted more than NOTE_TRASH_DAYS ago. */
  pruneNoteVersions(): number {
    const cutoff = new Date(this.#now().getTime() - NOTE_TRASH_DAYS * 86_400_000).toISOString();
    const gone = this.db.prepare("SELECT DISTINCT note_id FROM note_versions v WHERE note_id NOT IN (SELECT id FROM notes) AND (SELECT MAX(at) FROM note_versions w WHERE w.note_id = v.note_id AND w.reason = 'delete') < ?").all(cutoff) as Row[];
    for (const r of gone) this.db.prepare('DELETE FROM note_versions WHERE note_id = ?').run(r.note_id);
    return gone.length;
  }

  deleteNote(id: number): boolean {
    const cur = this.note(id);
    if (!cur) return false;
    this.#keepVersion(cur, 'delete');
    const gone = Number(this.db.prepare('DELETE FROM notes WHERE id = ?').run(id).changes) > 0;
    this.pruneNoteVersions();
    return gone;
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
      trigger: r.trigger === 'mention' ? 'mention' : null,
      mention: s(r.mention),
      each: Number(r.each ?? 0) === 1,
      expiresAt: s(r.expires_at),
      ended: s(r.ended),
      armedAt: s(r.armed_at),
    };
  }

  reminders(opts: { status?: Reminder['status'] | 'all'; limit?: number; kind?: 'mention' | 'timed' | 'all' } = {}): Reminder[] {
    const st = opts.status ?? 'pending';
    // Phase 119: `kind` 'timed' = time and place reminders only (her prompt, Today, other apps); 'mention' = the third kind.
    const kind = opts.kind === 'mention' ? "trigger = 'mention'" : opts.kind === 'timed' ? 'trigger IS NULL' : '';
    const where = [st === 'all' ? '' : 'status = ?', kind].filter(Boolean).join(' AND ');
    return (
      this.db
        .prepare(`SELECT * FROM reminders ${where ? `WHERE ${where}` : ''} ORDER BY ${st === 'pending' ? 'due_at, id' : 'COALESCE(sent_at, due_at) DESC'} LIMIT ?`)
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
    return Number(this.db.prepare("UPDATE reminders SET status = 'cancelled', ended = CASE WHEN trigger = 'mention' THEN 'forgot' ELSE ended END WHERE id = ? AND status = 'pending'").run(id).changes) > 0;
  }

  // ---------- Phase 119 (RECALL §4): "when it comes up" reminders ----------
  /** A new one: armed now (or not until Keep it, with `armed: false`). */
  addMention(r: { text: string; mention: string; conversationId?: string | null; each?: boolean; expiresAt?: string | null; armed?: boolean }): Reminder {
    const ts = this.#ts();
    const id = this.db
      .prepare("INSERT INTO reminders (text, due_at, repeat, conversation_id, created_at, trigger, mention, each, expires_at, armed_at) VALUES (?, ?, 'none', ?, ?, 'mention', ?, ?, ?, ?)")
      .run(r.text.trim(), PLACE_DUE, r.conversationId ?? null, ts, r.mention, r.each ? 1 : 0, r.expiresAt ?? null, r.armed === false ? null : ts).lastInsertRowid;
    return this.reminder(Number(id))!;
  }
  /** Every mention reminder (newest first), or only the pending ones. */
  mentionReminders(o: { armedOnly?: boolean; status?: 'pending' | 'all' } = {}): Reminder[] {
    const rows = this.db.prepare(`SELECT * FROM reminders WHERE trigger = 'mention' ${o.status === 'all' ? '' : "AND status = 'pending'"} ${o.armedOnly ? 'AND armed_at IS NOT NULL' : ''} ORDER BY id`).all() as Row[];
    return rows.map((r) => this.#reminder(r));
  }
  /** Armed now (not resting after a fire, not waiting for Keep it, not expired), oldest set first. */
  armedMentions(now: Date): Reminder[] {
    const t = now.toISOString();
    return (this.db.prepare("SELECT * FROM reminders WHERE trigger = 'mention' AND status = 'pending' AND armed_at IS NOT NULL AND armed_at <= ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY id").all(t, t) as Row[]).map((r) => this.#reminder(r));
  }
  countArmed(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE trigger = 'mention' AND status = 'pending'").get() as Row).n);
  }
  /** Ones nobody mentioned before their end date end quietly. */
  expireMentions(now: Date): number {
    return Number(this.db.prepare("UPDATE reminders SET status = 'cancelled', ended = 'expired', sent_at = ? WHERE trigger = 'mention' AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?").run(now.toISOString(), now.toISOString()).changes);
  }
  endMention(id: number, why: 'raised' | 'expired' | 'forgot'): boolean {
    return Number(this.db.prepare(`UPDATE reminders SET status = ?, ended = ?, sent_at = COALESCE(sent_at, ?) WHERE id = ? AND trigger = 'mention' AND status = 'pending'`).run(why === 'raised' ? 'sent' : 'cancelled', why, this.#ts(), id).changes) > 0;
  }
  updateMention(id: number, p: { text?: string; mention?: string; each?: boolean; expiresAt?: string | null }): Reminder | undefined {
    const cur = this.reminder(id);
    if (!cur || cur.trigger !== 'mention') return undefined;
    this.db.prepare('UPDATE reminders SET text = ?, mention = ?, each = ?, expires_at = ? WHERE id = ?').run((p.text ?? cur.text).trim(), p.mention ?? cur.mention, (p.each ?? cur.each) ? 1 : 0, p.expiresAt === undefined ? cur.expiresAt : p.expiresAt, id);
    return this.reminder(id);
  }
  /** It came up: once → done; every time → resting until `nextArmed` (null = that was the last). */
  markMentionRaised(id: number, nextArmed: Date | null, now: Date): void {
    if (nextArmed) this.db.prepare('UPDATE reminders SET fired = fired + 1, sent_at = ?, armed_at = ? WHERE id = ?').run(now.toISOString(), nextArmed.toISOString(), id);
    else this.db.prepare("UPDATE reminders SET fired = fired + 1, sent_at = ?, status = 'sent', ended = 'raised' WHERE id = ?").run(now.toISOString(), id);
  }
  /** *Again next time* and *Keep it*: armed now (a done or forgotten one comes back). */
  rearmMention(id: number, now: Date): Reminder | undefined {
    this.db.prepare("UPDATE reminders SET status = 'pending', ended = NULL, armed_at = ?, fired = CASE WHEN each = 1 THEN 0 ELSE fired END WHERE id = ? AND trigger = 'mention'").run(now.toISOString(), id);
    return this.reminder(id);
  }
  #fire(r: Row): ReminderFire {
    return { id: Number(r.id), reminderId: Number(r.reminder_id), conversationId: String(r.conversation_id), messageId: Number(r.message_id), replyId: r.reply_id === null ? null : Number(r.reply_id), why: String(r.why), raised: r.raised === 'app' ? 'app' : 'her', answer: (['done', 'again', 'forget'].includes(String(r.answer)) ? r.answer : null) as ReminderFire['answer'], at: String(r.at) };
  }
  addFire(f: { reminderId: number; conversationId: string; messageId: number; replyId: number | null; why: string; raised: 'her' | 'app'; at: string }): number {
    return Number(this.db.prepare('INSERT INTO reminder_fires (reminder_id, conversation_id, message_id, reply_id, why, raised, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(f.reminderId, f.conversationId, f.messageId, f.replyId, f.why, f.raised, f.at).lastInsertRowid);
  }
  fire(id: number): ReminderFire | undefined {
    const r = this.db.prepare('SELECT * FROM reminder_fires WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#fire(r) : undefined;
  }
  fires(reminderId: number): ReminderFire[] {
    return (this.db.prepare('SELECT * FROM reminder_fires WHERE reminder_id = ? ORDER BY id').all(reminderId) as Row[]).map((r) => this.#fire(r));
  }
  setFireAnswer(id: number, answer: 'done' | 'again' | 'forget'): void {
    this.db.prepare('UPDATE reminder_fires SET answer = ? WHERE id = ?').run(answer, id);
  }
  /** How many came up since `iso` (the per-day cap). */
  firesSince(iso: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM reminder_fires WHERE at >= ?').get(iso) as Row).n);
  }
  /** *Forget this conversation*: the reminders set there and their fires go. */
  forgetMentionsOf(conversationId: string): number {
    this.db.prepare('DELETE FROM reminder_fires WHERE conversation_id = ?').run(conversationId);
    return Number(this.db.prepare("UPDATE reminders SET status = 'cancelled', ended = 'forgot' WHERE trigger = 'mention' AND status = 'pending' AND conversation_id = ?").run(conversationId).changes);
  }

  dueReminders(now: Date): Reminder[] {
    // Phase 119: "when it comes up" reminders are never due (they ride in her reply instead).
    return (this.db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND trigger IS NULL AND due_at <= ? ORDER BY due_at").all(now.toISOString()) as Row[]).map((r) => this.#reminder(r));
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
    // Phase 119 (RECALL §4.4 path 1): "when it comes up" reminders never go in here (it reaches every turn with tools).
    for (const r of this.reminders({ status: 'pending', limit: 3, kind: 'timed' })) {
      const pl = r.placeId ? this.place(r.placeId) : undefined;
      lines.push(`- reminder #${r.id} "${r.text}" ${r.placeId ? `when ${r.placeEvent === 'leave' ? 'leaving' : 'arriving at'} ${pl?.name ?? 'a place'}` : `at ${formatLocal(r.dueAt, timeZone)}`}${r.repeat !== 'none' ? ` (${r.repeat})` : ''}`);
    }
    return lines.join('\n');
  }
}

// ---------------- tools ----------------

/** 3.4.2: the non-empty lines of a note's old text that are gone from the new text. */
function lostLines(oldBody: string, newBody: string): string[] {
  if (!oldBody.trim() || newBody.includes(oldBody.trim())) return [];
  return oldBody.split('\n').map((l) => l.trim()).filter((l) => l && !newBody.includes(l));
}

/** 3.4.2: how many characters of a note's old text a new text would drop. */
export function erasedChars(oldBody: string, newBody: string): number {
  return lostLines(oldBody, newBody).reduce((n, l) => n + l.length, 0);
}

/** 3.4.2: the share (0-1) of a note's old text that a new text keeps, line by line. */
export function keptShare(oldBody: string, newBody: string): number {
  const total = oldBody.split('\n').reduce((n, l) => n + l.trim().length, 0);
  return total ? 1 - erasedChars(oldBody, newBody) / total : 1;
}

export interface PlannerToolDeps {
  planner: PlannerStore;
  now: () => Date;
  timeZone: () => string | undefined;
  /** Phase 26: are calls from her switched on? */
  callsOn?: () => boolean;
  /** Phase 119: "when it comes up" reminders (src/mentions.ts mentionToolDeps; needs People and the chats). */
  mentions?: () => import('./mentions.ts').MentionToolDeps | undefined;
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
      description:
        "Notes you keep for the owner (ideas, details, plans, lists, records like health results). Actions: add (id or title, text): adds a dated entry to the end of a note and never touches what is already in it; it finds the note by id or by its title (or a close one) and makes it if there is none. Keep adding to a note as the owner shares more: use add, never save with id. One add per thing they share is fine; then tell them the note number. If a note lost things, rebuild it from the chat with add. save (title, body, optional project): a new note; with id it rewrites the whole note (it is refused if it would erase text already there, unless you read it first and send the whole new text with replace: true). search (query), read (id), list, history (id: its earlier versions; no id: notes deleted in the last 30 days), restore (id, version: brings a version or a deleted note back), delete (id; kept 30 days).",
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'save', 'search', 'read', 'list', 'history', 'restore', 'delete'] },
          id: { type: 'number' },
          title: { type: 'string' },
          text: { type: 'string', description: 'add: what to add (the whole thing the owner shared, word for word).' },
          body: { type: 'string', description: 'save: the whole text of the note.' },
          replace: { type: 'boolean', description: 'save with id: true only after reading the note, to really rewrite it.' },
          version: { type: 'number', description: 'restore: the version number from history.' },
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
      const size = (n: Note) => `${n.body.length.toLocaleString('en-US')} characters`;
      const project = args.project !== undefined ? { project: args.project ? String(args.project) : null } : {};
      switch (action) {
        case 'add': {
          const text = args.text ?? args.body;
          if (typeof text !== 'string' || !text.trim()) throw new ToolError('Give the "text" to add (and the note "id" or "title").');
          if (!args.id && !(typeof args.title === 'string' && args.title.trim())) throw new ToolError('Give the note "id" or its "title" (a new note is made when no note has that title).');
          const p = zonedParts(deps.now(), deps.timeZone());
          const pad = (x: number) => String(x).padStart(2, '0');
          const heading = `— ${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
          const { note: n, created } = planner.addToNote({ ...(args.id ? { id: idArg(args) } : {}), ...(args.title ? { title: String(args.title) } : {}), text, heading, ...project });
          return `Saved note ${head(n)}. ${created ? 'Made this new note with the entry' : 'Added the entry at the end; everything already in it is kept'} (now ${size(n)}). Tell the owner it is in note #${n.id}.`;
        }
        case 'save': {
          const body = str(args, 'body');
          if (body.length > NOTE_MAX) throw new ToolError(`Note is too long (max ${NOTE_MAX.toLocaleString('en-US')} characters).`);
          const given = typeof args.title === 'string' ? args.title.trim() : '';
          if (args.id) {
            const id = idArg(args);
            const cur = planner.note(id);
            if (!cur) throw new ToolError(`No note #${id}.`);
            const lost = erasedChars(cur.body, body);
            const replace = args.replace === true || args.replace === 'true';
            if (!replace && lost > 0 && keptShare(cur.body, body) < 0.9) {
              throw new ToolError(`This would erase ${lost.toLocaleString('en-US')} characters already in note #${id}. To add, use action add. To really rewrite it, read it first and send the whole new text with replace: true.`);
            }
            // On an update the title changes only when one is given and short (a body sentence never becomes the title).
            const title = given && given.length <= 80 ? given : cur.title;
            const n = planner.saveNote({ id, title, body, ...project }, lost > 0 ? 'replace' : 'edit');
            return `Saved note ${head(n)}.${lost > 0 ? ' The earlier text is kept in its history.' : ''}`;
          }
          const title = (given || body.split('\n')[0]).trim().slice(0, 120) || 'Note';
          const n = planner.saveNote({ title, body, ...project });
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
        case 'history': {
          const tz = deps.timeZone();
          if (!args.id) {
            const gone = planner.deletedNotes();
            return gone.length ? `Notes deleted in the last ${NOTE_TRASH_DAYS} days (restore with id and version):\n${gone.map((v) => `#${v.noteId} "${v.title}" (version ${v.id}), deleted ${formatLocal(v.at, tz)}`).join('\n')}` : `No notes were deleted in the last ${NOTE_TRASH_DAYS} days.`;
          }
          const id = idArg(args);
          const list = planner.noteVersions(id);
          if (!list.length) return planner.note(id) ? `Note #${id} has no earlier versions (versions are kept from Sara 3.4.2 on).` : `No note #${id}.`;
          const why: Record<NoteVersionReason, string> = { edit: 'an edit', replace: 'a rewrite', add: 'an add', restore: 'a restore', delete: 'delete' };
          return `Earlier versions of note #${id} (newest first; restore with id and version):\n${list.map((v) => `version ${v.id}: "${v.title}", ${v.body.length.toLocaleString('en-US')} characters, until ${why[v.reason]} on ${formatLocal(v.at, tz)}: ${v.body.replace(/\s+/g, ' ').slice(0, 100)}`).join('\n')}`;
        }
        case 'restore': {
          const id = idArg(args);
          const version = Number(args.version);
          if (!Number.isInteger(version) || version <= 0) throw new ToolError('Give the "version" number from history.');
          const n = planner.restoreNoteVersion(id, version);
          return `Restored note #${n.id} "${n.title}" to version ${version} (now ${size(n)}). The text it had just before is kept in its history.`;
        }
        case 'delete': {
          const n = planner.note(idArg(args));
          if (!n || !planner.deleteNote(n.id)) throw new ToolError(`No note #${String(args.id)}.`);
          return `Deleted note #${n.id} "${n.title}". A copy is kept for ${NOTE_TRASH_DAYS} days: history shows it and restore brings it back.`;
        }
        default:
          throw new ToolError('action must be add, save, search, read, list, history, restore or delete.');
      }
    },
  };

  const remind: Tool = {
    spec: {
      name: 'remind',
      description:
        "Reminders that pop up in this chat at a set time, or when the owner arrives at or leaves a saved place. Actions: set (text, and either when or place; optional repeat none|daily|weekdays|weekly|monthly for timed ones; optional call=true when the owner asks you to CALL them then, e.g. \"call me at 5\"), list, cancel (id), places (the saved places). \"when\" is the owner's local time: \"2026-10-25 09:00\", \"tomorrow 9am\", \"friday 3pm\", \"in 20 minutes\". For \"when I get to the store\" use place (a saved place's name) and on=arrive (or on=leave for \"when I leave work\"). For 'next time I mention X' or 'when Dan comes up', use on=mention with person (someone he knows) or topic (a few words), and text; never guess a trigger he didn't say. Only say a reminder is set after this tool confirms it.",
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['set', 'list', 'cancel', 'places'] },
          place: { type: 'string', description: 'A saved place name (see action=places), for "when I get to…"' },
          on: { type: 'string', enum: ['arrive', 'leave', 'mention'], description: 'With place: arriving (default) or leaving. mention: when a person or topic comes up in what the owner says' },
          person: { type: 'string', description: 'With on=mention: the person (a name he uses)' },
          topic: { type: 'string', description: 'With on=mention: a few words for the topic, e.g. "Jeff\'s wedding"' },
          also: { type: 'array', items: { type: 'string' }, description: 'With on=mention: up to 5 other ways he says it' },
          each: { type: 'boolean', description: 'With on=mention: every time it comes up (default: only the next time)' },
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
        // Phase 119: "when it comes up" (a person or a topic in his own message, in his own chats).
        if (str(args, 'on', false) === 'mention') {
          const m = deps.mentions?.();
          if (!m) throw new ToolError('When-it-comes-up reminders are not available here.');
          try {
            return m.set(args, ctx.conversationId);
          } catch (err) {
            throw new ToolError((err as Error).message);
          }
        }
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
        const list = planner.reminders({ status: 'pending', kind: 'timed' });
        // Phase 119 (RECALL §4.4 path 2): "when it comes up" ones only in his own chats.
        const ml = deps.mentions?.()?.list(ctx.conversationId) ?? { lines: [], hidden: 0 };
        const more = [...(ml.lines.length ? ['When it comes up:', ...ml.lines.map((l) => `  ${l}`)] : []), ...(ml.hidden ? [`And ${ml.hidden} "when it comes up" reminder${ml.hidden === 1 ? '' : 's'}, which I keep for our own chats.`] : [])].join('\n');
        const where = (r: Reminder) => {
          const pl = r.placeId ? planner.place(r.placeId) : undefined;
          return `when ${r.placeEvent === 'leave' ? 'leaving' : 'arriving at'} ${pl?.name ?? 'a deleted place'}`;
        };
        const timed = list.length ? list.map((r) => `#${r.id} ${r.placeId ? where(r) : formatLocal(r.dueAt, tz)}${r.repeat !== 'none' ? ` (${r.repeat})` : ''}${r.call ? ' (call)' : ''}: ${r.text}`).join('\n') : more ? '' : 'No upcoming reminders.';
        return [timed, more].filter(Boolean).join('\n');
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
