// Phase 99 (ST4, docs/design/STAPLES.md §7): the board. A view and a worker over the planner's
// tasks, not a second to-do system: every card is a row in `tasks` (src/planner.ts), and the board
// adds where it sits (column, fractional position), its labels, who works it and what that work is
// doing. Columns have roles the worker understands (todo · doing · waiting · done · other). A task
// added in chat, by MCP's add_task or on the board shows up here; Done ⇄ status 'done'.
import type { DatabaseSync } from 'node:sqlite';
import type { PlannerStore, Task, TaskChange } from './planner.ts';
import { cleanLimits, type TeamLimits } from './team.ts';

export type ColumnRole = 'todo' | 'doing' | 'waiting' | 'done' | 'other';
export const ROLES: readonly ColumnRole[] = ['todo', 'doing', 'waiting', 'done', 'other'];
/** The four columns every project's board starts with. */
export const DEFAULT_COLUMNS: readonly { name: string; role: ColumnRole }[] = [
  { name: 'To do', role: 'todo' },
  { name: 'Doing', role: 'doing' },
  { name: 'Waiting on you', role: 'waiting' },
  { name: 'Done', role: 'done' },
];
/** Label colours: names of theme tokens (web/theme.css --lbl-*), readable in dark and light. */
export const LABEL_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];
export const MAX_LABELS = 12;
/** The Everything board: every open task grouped by project (virtual; its columns are the roles). */
export const EVERYTHING = 0;
/** Virtual column ids on the Everything board (a move lands in the card's own board's column of that role). */
export const VIRTUAL_COLUMN: Record<Exclude<ColumnRole, 'other'>, number> = { todo: -1, doing: -2, waiting: -3, done: -4 };
const STEP = 1024;

export type Who = string; // me | sara | helper:<id> | peer:<id> | webhook:<id> | member:<id>
export type ActivityWhat = 'created' | 'moved' | 'edited' | 'assigned' | 'started' | 'asked' | 'answered' | 'receipt' | 'done' | 'failed' | 'comment';

export interface Board {
  id: number;
  name: string;
  /** Built-in names the app translates ('general', 'project'). */
  kind: 'general' | 'project' | 'custom' | 'everything';
  projectId: number | null;
  shared: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Column {
  id: number;
  boardId: number;
  name: string;
  role: ColumnRole;
  position: number;
  wipLimit: number | null;
}
export interface Label {
  name: string;
  color: LabelColor;
}
/** What the work on a card is doing (`tasks.work`). */
export interface CardWork {
  kind: 'turn' | 'team';
  /** The team task id (team work). */
  id?: number;
  conversationId: string;
  startedAt: string;
  state: 'queued' | 'running' | 'waiting' | 'done' | 'stopped' | 'failed' | 'interrupted';
  /** Who assigned it (the person whose space runs it; 'me' on one's own board). */
  by?: string;
  /** The live line (the current step). */
  line?: string;
  /** Why it waits on you, and how to answer. */
  ask?: { kind: 'approval' | 'question' | 'budget' | 'failed' | 'unproven' | 'interrupted' | 'team'; text: string; approvalId?: string; tool?: string; more?: Record<string, number> };
  /** Receipts: what really happened (tool, a short line, ok/error). Titles only on shared boards. */
  receipts?: { tool: string; summary: string; status: string }[];
  used?: { tokens: number; steps: number };
  endedAt?: string;
  /** "Move to Done?": she did the work in chat on a card that isn't hers. */
  suggest?: 'done';
}
export interface Card extends Task {
  boardId: number;
  columnId: number;
  position: number;
  labels: string[];
  assignee: string | null;
  work: CardWork | null;
  limits: TeamLimits | null;
  checklist: { done: number; total: number };
}
export interface Activity {
  id: number;
  taskId: number;
  at: string;
  who: Who;
  what: ActivityWhat;
  detail: Record<string, unknown>;
}
export interface BoardView {
  board: Board;
  columns: (Column & { count: number })[];
  cards: Card[];
  labels: Label[];
}

type Row = Record<string, string | number | null>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, project_id INTEGER,
  shared TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_columns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, board_id INTEGER NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL,
  position REAL NOT NULL, wip_limit INTEGER
);
CREATE INDEX IF NOT EXISTS board_columns_board ON board_columns(board_id, position);
CREATE TABLE IF NOT EXISTS board_labels (board_id INTEGER NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, PRIMARY KEY (board_id, name));
CREATE TABLE IF NOT EXISTS card_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, at TEXT NOT NULL,
  who TEXT NOT NULL,
  what TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS card_activity_task ON card_activity(task_id, id);
`;

/** The board's columns on `tasks` (additive; old rows keep NULLs and land in To do / Done by status). */
export function migrateBoard(db: DatabaseSync): void {
  db.exec(SCHEMA);
  const cols = new Set((db.prepare('PRAGMA table_info(tasks)').all() as Row[]).map((r) => String(r.name)));
  const add = (name: string, def: string) => {
    if (!cols.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${def}`);
  };
  add('board_id', 'INTEGER');
  add('column_id', 'INTEGER');
  add('position', 'REAL');
  add('labels', "TEXT NOT NULL DEFAULT '[]'");
  add('assignee', 'TEXT');
  add('work', 'TEXT');
  add('limits', 'TEXT');
  // Kept apart from `boards.kind` in the design's SQL: a board with a project is the project's board.
  const bcols = new Set((db.prepare('PRAGMA table_info(boards)').all() as Row[]).map((r) => String(r.name)));
  if (!bcols.has('kind')) db.exec("ALTER TABLE boards ADD COLUMN kind TEXT NOT NULL DEFAULT 'custom'");
}

/** Lines of a `- [ ]` / `- [x]` checklist in the notes. */
export function checklistOf(notes: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const line of notes.split('\n')) {
    const m = /^\s*[-*] \[( |x|X)\]\s/.exec(line);
    if (!m) continue;
    total++;
    if (m[1] !== ' ') done++;
  }
  return { done, total };
}
/** Ticks (or unticks) the nth checklist line in the notes. */
export function tickChecklist(notes: string, index: number, done: boolean): string | undefined {
  let n = -1;
  let hit = false;
  const lines = notes.split('\n').map((line) => {
    if (!/^\s*[-*] \[( |x|X)\]\s/.test(line)) return line;
    n++;
    if (n !== index) return line;
    hit = true;
    return line.replace(/\[( |x|X)\]/, done ? '[x]' : '[ ]');
  });
  return hit ? lines.join('\n') : undefined;
}

/** A position between two neighbours (either may be missing); undefined when there's no room left. */
export function between(prev: number | undefined, next: number | undefined): number | undefined {
  if (prev === undefined && next === undefined) return STEP;
  if (prev === undefined) return next! - STEP;
  if (next === undefined) return prev + STEP;
  const mid = (prev + next) / 2;
  return mid > prev && mid < next && next - prev > 1e-9 ? mid : undefined;
}

function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/** One board store per planner (several companions sharing a planner share it). */
const STORES = new WeakMap<PlannerStore, BoardStore>();
export function boardFor(planner: PlannerStore): BoardStore {
  let b = STORES.get(planner);
  if (!b) STORES.set(planner, (b = new BoardStore(planner)));
  return b;
}

export class BoardStore {
  readonly planner: PlannerStore;
  readonly db: DatabaseSync;
  /** Told after a board change (the server pushes `{type:'board'}` to the open tabs). */
  readonly listeners = new Set<(ev: { boardId: number; taskId?: number; what: string }) => void>();
  /** Who the next planner change is from (set around board and tool calls; default 'me'). */
  #who: Who = 'me';
  #quiet = 0;

  constructor(planner: PlannerStore) {
    this.planner = planner;
    this.db = planner.db;
    migrateBoard(this.db);
    planner.listeners.add((c) => this.#onTask(c));
  }

  #now(): string {
    return new Date().toISOString();
  }

  /** Runs fn with `who` as the author of the planner changes it makes. */
  as<T>(who: Who, fn: () => T): T {
    const was = this.#who;
    this.#who = who;
    try {
      return fn();
    } finally {
      this.#who = was;
    }
  }

  #emit(boardId: number, what: string, taskId?: number): void {
    for (const fn of this.listeners) {
      try {
        fn({ boardId, what, ...(taskId !== undefined ? { taskId } : {}) });
      } catch {
        /* a listener's problem */
      }
    }
  }

  // ---------------- planner changes → activity ----------------

  #onTask(c: TaskChange): void {
    if (this.#quiet) return;
    if (c.what === 'deleted') {
      this.db.prepare('DELETE FROM card_activity WHERE task_id = ?').run(c.id);
      return this.#emit(EVERYTHING, 'deleted', c.id);
    }
    const board = this.boardOf(c.task);
    if (c.what === 'added') this.log(c.task.id, this.#who, 'created', {});
    else if (c.what === 'repeated') {
      // Back to To do for its next time (the position is kept: the top of To do would be a surprise).
      this.db.prepare('UPDATE tasks SET column_id = NULL WHERE id = ?').run(c.task.id);
      this.log(c.task.id, this.#who, 'done', { repeat: c.task.repeat, next: c.task.dueAt });
    } else if (c.before.status !== c.task.status) this.log(c.task.id, this.#who, c.task.status === 'done' ? 'done' : 'moved', c.task.status === 'done' ? {} : { to: 'todo' });
    else if (c.before.title !== c.task.title || c.before.notes !== c.task.notes || c.before.dueAt !== c.task.dueAt || c.before.priority !== c.task.priority || c.before.projectId !== c.task.projectId) this.log(c.task.id, this.#who, 'edited', {});
    this.#emit(board.id, c.what, c.task.id);
  }

  // ---------------- activity ----------------

  log(taskId: number, who: Who, what: ActivityWhat, detail: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO card_activity (task_id, at, who, what, detail) VALUES (?, ?, ?, ?, ?)').run(taskId, this.#now(), who, what, JSON.stringify(detail).slice(0, 4000));
  }
  activity(taskId: number, limit = 200): Activity[] {
    return (this.db.prepare('SELECT * FROM (SELECT * FROM card_activity WHERE task_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(taskId, limit) as Row[]).map((r) => ({
      id: Number(r.id),
      taskId: Number(r.task_id),
      at: String(r.at),
      who: String(r.who),
      what: String(r.what) as ActivityWhat,
      detail: json<Record<string, unknown>>(r.detail, {}),
    }));
  }

  // ---------------- boards ----------------

  #board(r: Row): Board {
    return { id: Number(r.id), name: String(r.name), kind: (['general', 'project', 'custom'].includes(String(r.kind)) ? r.kind : 'custom') as Board['kind'], projectId: r.project_id === null ? null : Number(r.project_id), shared: r.shared === null ? null : String(r.shared), createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
  }

  #create(name: string, kind: Board['kind'], projectId: number | null): Board {
    const ts = this.#now();
    const id = Number(this.db.prepare('INSERT INTO boards (name, project_id, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(name, projectId, kind, ts, ts).lastInsertRowid);
    DEFAULT_COLUMNS.forEach((c, i) => this.db.prepare('INSERT INTO board_columns (board_id, name, role, position) VALUES (?, ?, ?, ?)').run(id, c.name, c.role, (i + 1) * STEP));
    return this.board(id)!;
  }

  board(id: number): Board | undefined {
    if (id === EVERYTHING) return { id: EVERYTHING, name: 'Everything', kind: 'everything', projectId: null, shared: null, createdAt: '', updatedAt: '' };
    const r = this.db.prepare('SELECT * FROM boards WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#board(r) : undefined;
  }

  /** The board for tasks without a project (made on first use). */
  general(): Board {
    const r = this.db.prepare("SELECT * FROM boards WHERE kind = 'general' ORDER BY id LIMIT 1").get() as Row | undefined;
    return r ? this.#board(r) : this.#create('To-dos', 'general', null);
  }

  /** A project's default board (made on first open). */
  forProject(projectId: number): Board {
    const r = this.db.prepare("SELECT * FROM boards WHERE kind = 'project' AND project_id = ? ORDER BY id LIMIT 1").get(projectId) as Row | undefined;
    if (r) return this.#board(r);
    const p = this.planner.projects(true).find((x) => x.id === projectId);
    return this.#create(p?.name ?? 'Project', 'project', projectId);
  }

  /** Every board: the general one, each active project's, the owner's own; Everything is listed first by the routes. */
  boards(): Board[] {
    this.general();
    for (const p of this.planner.projects()) this.forProject(p.id);
    const archived = new Set(this.planner.projects(true).filter((p) => p.status === 'archived').map((p) => p.id));
    return (this.db.prepare("SELECT * FROM boards ORDER BY CASE kind WHEN 'general' THEN 0 WHEN 'project' THEN 1 ELSE 2 END, name COLLATE NOCASE").all() as Row[])
      .map((r) => this.#board(r))
      .filter((b) => b.projectId === null || (!archived.has(b.projectId) && this.planner.projects(true).some((p) => p.id === b.projectId)));
  }

  createBoard(name: string): Board {
    const n = name.replace(/\s+/g, ' ').trim();
    if (!n || n.length > 80) throw new Error('Give the board a name (up to 80 characters).');
    const b = this.#create(n, 'custom', null);
    this.#emit(b.id, 'board');
    return b;
  }

  renameBoard(id: number, name: string): Board | undefined {
    const b = this.board(id);
    if (!b || id === EVERYTHING) return undefined;
    const n = name.replace(/\s+/g, ' ').trim();
    if (!n || n.length > 80) throw new Error('Give the board a name (up to 80 characters).');
    this.db.prepare('UPDATE boards SET name = ?, updated_at = ? WHERE id = ?').run(n, this.#now(), id);
    this.#emit(id, 'board');
    return this.board(id);
  }

  /** Deletes a board of your own (its cards go back to their project's board). Project and general boards stay. */
  deleteBoard(id: number): boolean {
    const b = this.board(id);
    if (!b || b.kind !== 'custom') return false;
    this.db.prepare('UPDATE tasks SET board_id = NULL, column_id = NULL WHERE board_id = ?').run(id);
    this.db.prepare('DELETE FROM board_columns WHERE board_id = ?').run(id);
    this.db.prepare('DELETE FROM board_labels WHERE board_id = ?').run(id);
    this.db.prepare('DELETE FROM boards WHERE id = ?').run(id);
    this.#emit(EVERYTHING, 'board');
    return true;
  }

  // ---------------- columns ----------------

  #column(r: Row): Column {
    return { id: Number(r.id), boardId: Number(r.board_id), name: String(r.name), role: (ROLES.includes(r.role as ColumnRole) ? r.role : 'other') as ColumnRole, position: Number(r.position), wipLimit: r.wip_limit === null ? null : Number(r.wip_limit) };
  }
  columns(boardId: number): Column[] {
    if (boardId === EVERYTHING) return DEFAULT_COLUMNS.map((c, i) => ({ id: VIRTUAL_COLUMN[c.role as Exclude<ColumnRole, 'other'>], boardId: EVERYTHING, name: c.name, role: c.role, position: i, wipLimit: null }));
    return (this.db.prepare('SELECT * FROM board_columns WHERE board_id = ? ORDER BY position, id').all(boardId) as Row[]).map((r) => this.#column(r));
  }
  column(id: number): Column | undefined {
    const r = this.db.prepare('SELECT * FROM board_columns WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#column(r) : undefined;
  }
  /** The first column of a role on a board (todo when there's none of that role). */
  roleColumn(boardId: number, role: ColumnRole): Column {
    const cols = this.columns(boardId);
    return cols.find((c) => c.role === role) ?? cols.find((c) => c.role === 'todo') ?? cols[0];
  }
  addColumn(boardId: number, name: string, role: ColumnRole = 'other', wipLimit: number | null = null): Column {
    const b = this.board(boardId);
    if (!b || boardId === EVERYTHING) throw new Error('No such board.');
    const n = name.replace(/\s+/g, ' ').trim();
    if (!n || n.length > 40) throw new Error('Give the column a name (up to 40 characters).');
    if (!ROLES.includes(role)) throw new Error('Pick what the column is for.');
    const cols = this.columns(boardId);
    if (cols.length >= 12) throw new Error('A board has at most 12 columns.');
    // A new column goes before Done (or at the end).
    const done = cols.findIndex((c) => c.role === 'done');
    const pos = done >= 0 ? (between(cols[done - 1]?.position, cols[done].position) ?? cols[done].position - 1) : (cols.at(-1)?.position ?? 0) + STEP;
    const id = Number(this.db.prepare('INSERT INTO board_columns (board_id, name, role, position, wip_limit) VALUES (?, ?, ?, ?, ?)').run(boardId, n, role, pos, cleanWip(wipLimit)).lastInsertRowid);
    this.#emit(boardId, 'columns');
    return this.column(id)!;
  }
  updateColumn(id: number, patch: { name?: string; wipLimit?: number | null; position?: number }): Column | undefined {
    const c = this.column(id);
    if (!c) return undefined;
    const n = patch.name === undefined ? c.name : patch.name.replace(/\s+/g, ' ').trim();
    if (!n || n.length > 40) throw new Error('Give the column a name (up to 40 characters).');
    this.db.prepare('UPDATE board_columns SET name = ?, wip_limit = ?, position = ? WHERE id = ?').run(n, patch.wipLimit === undefined ? c.wipLimit : cleanWip(patch.wipLimit), Number.isFinite(patch.position) ? Number(patch.position) : c.position, id);
    this.#emit(c.boardId, 'columns');
    return this.column(id);
  }

  // ---------------- labels ----------------

  labels(boardId: number): Label[] {
    return (this.db.prepare('SELECT name, color FROM board_labels WHERE board_id = ? ORDER BY rowid').all(boardId) as Row[]).map((r) => ({ name: String(r.name), color: (LABEL_COLORS.includes(r.color as LabelColor) ? r.color : 'gray') as LabelColor }));
  }
  setLabels(boardId: number, labels: unknown): Label[] {
    if (!Array.isArray(labels)) throw new Error('Labels must be a list.');
    const seen = new Set<string>();
    const clean: Label[] = [];
    for (const l of labels as { name?: unknown; color?: unknown }[]) {
      const name = String(l?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      clean.push({ name, color: LABEL_COLORS.includes(l?.color as LabelColor) ? (l.color as LabelColor) : 'gray' });
    }
    if (clean.length > MAX_LABELS) throw new Error('A board has at most 12 labels.');
    this.db.prepare('DELETE FROM board_labels WHERE board_id = ?').run(boardId);
    for (const l of clean) this.db.prepare('INSERT INTO board_labels (board_id, name, color) VALUES (?, ?, ?)').run(boardId, l.name, l.color);
    this.#emit(boardId, 'labels');
    return clean;
  }

  // ---------------- cards ----------------

  /** The board a task sits on: its own board, else its project's, else the general one. */
  boardOf(t: Task | { projectId: number | null; id: number }): Board {
    const r = this.db.prepare('SELECT board_id FROM tasks WHERE id = ?').get(t.id) as Row | undefined;
    const own = r?.board_id === null || r?.board_id === undefined ? undefined : this.board(Number(r.board_id));
    if (own) return own;
    return t.projectId !== null ? this.forProject(t.projectId) : this.general();
  }

  #raw(id: number): Row | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
  }

  /** A task as a card on its own board (column by status when it has none). */
  card(id: number): Card | undefined {
    const t = this.planner.task(id);
    if (!t) return undefined;
    const b = this.boardOf(t);
    return this.#asCard(t, this.#raw(id)!, b.id, this.columns(b.id));
  }

  #asCard(t: Task, r: Row, boardId: number, cols: Column[]): Card {
    const byId = new Map(cols.map((c) => [c.id, c]));
    const own = r.column_id === null ? undefined : byId.get(Number(r.column_id));
    const role = (x: ColumnRole) => cols.find((c) => c.role === x) ?? cols[0];
    // Status wins: done in chat moves it to Done; reopened in chat moves it back to To do.
    let col = own;
    if (t.status === 'done') col = own?.role === 'done' ? own : role('done');
    else if (!own || own.role === 'done') col = role('todo');
    return {
      ...t,
      boardId,
      columnId: col!.id,
      position: r.position === null ? STEP * 1e6 + t.id : Number(r.position),
      labels: json<string[]>(r.labels, []),
      assignee: r.assignee === null ? null : String(r.assignee),
      work: json<CardWork | null>(r.work, null),
      limits: r.limits ? cleanLimits(json(r.limits, {})) : null,
      checklist: checklistOf(t.notes),
    };
  }

  /** A board with its columns and cards in order. Done shows the latest 50. */
  view(boardId: number): BoardView | undefined {
    const board = this.board(boardId);
    if (!board) return undefined;
    if (boardId === EVERYTHING) return this.#everything();
    const cols = this.columns(boardId);
    const tasks = this.planner.tasks({ status: 'all' }).filter((t) => this.boardOf(t).id === boardId);
    const cards = tasks.map((t) => this.#asCard(t, this.#raw(t.id)!, boardId, cols));
    return this.#finish(board, cols, cards, this.labels(boardId));
  }

  #finish(board: Board, cols: Column[], cards: Card[], labels: Label[]): BoardView {
    cards.sort((a, b) => a.position - b.position || a.id - b.id);
    const doneIds = new Set(cols.filter((c) => c.role === 'done').map((c) => c.id));
    const done = cards.filter((c) => doneIds.has(c.columnId)).sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '')).slice(0, 50);
    const keep = new Set(done.map((c) => c.id));
    const shown = cards.filter((c) => !doneIds.has(c.columnId) || keep.has(c.id));
    return { board, columns: cols.map((c) => ({ ...c, count: shown.filter((x) => x.columnId === c.id).length })), cards: shown, labels };
  }

  #everything(): BoardView {
    const cols = this.columns(EVERYTHING);
    const cards: Card[] = [];
    const labels = new Map<string, Label>();
    for (const t of this.planner.tasks({ status: 'all' })) {
      const b = this.boardOf(t);
      const own = this.#asCard(t, this.#raw(t.id)!, b.id, this.columns(b.id));
      const role = this.column(own.columnId)?.role ?? 'todo';
      cards.push({ ...own, columnId: VIRTUAL_COLUMN[role === 'other' ? 'doing' : role] });
      for (const l of this.labels(b.id)) if (!labels.has(l.name)) labels.set(l.name, l);
    }
    return this.#finish(this.board(EVERYTHING)!, cols, cards, [...labels.values()]);
  }

  /** Adds a card (a task) to a board, in a column (default To do), at the bottom. */
  addCard(boardId: number, c: { title: string; notes?: string; dueAt?: string | null; columnId?: number; labels?: string[]; priority?: Task['priority']; conversationId?: string | null }, who: Who = 'me'): Card {
    const b = this.board(boardId);
    if (!b || boardId === EVERYTHING) throw new Error('No such board.');
    const title = c.title.replace(/\s+/g, ' ').trim();
    if (!title || title.length > 300) throw new Error('Task title must be 1-300 characters');
    const project = b.projectId !== null ? this.planner.projects(true).find((p) => p.id === b.projectId)?.name ?? null : null;
    const col = c.columnId !== undefined ? this.columns(boardId).find((x) => x.id === c.columnId) : this.roleColumn(boardId, 'todo');
    if (!col) throw new Error('No such column on this board.');
    const t = this.as(who, () => this.planner.addTask({ title, project, notes: c.notes ?? '', dueAt: c.dueAt ?? null, priority: c.priority, conversationId: c.conversationId ?? null }));
    const last = this.#ordered(boardId, col.id).at(-1);
    this.db.prepare('UPDATE tasks SET board_id = ?, column_id = ?, position = ?, labels = ? WHERE id = ?').run(b.kind === 'custom' ? boardId : null, col.id, (last?.position ?? 0) + STEP, JSON.stringify(this.#cleanLabels(boardId, c.labels ?? [])), t.id);
    if (col.role === 'done') this.as(who, () => this.planner.updateTask(t.id, { status: 'done' }));
    this.#emit(boardId, 'card', t.id);
    return this.card(t.id)!;
  }

  #cleanLabels(boardId: number, labels: unknown): string[] {
    const known = new Map(this.labels(boardId).map((l) => [l.name.toLowerCase(), l.name]));
    const out: string[] = [];
    for (const l of Array.isArray(labels) ? labels : []) {
      const name = known.get(String(l).trim().toLowerCase());
      if (name && !out.includes(name)) out.push(name);
    }
    return out.slice(0, MAX_LABELS);
  }

  /** Cards of one column in board order (null positions last, by id). */
  #ordered(boardId: number, columnId: number, except?: number): Card[] {
    const v = this.view(boardId);
    return (v?.cards ?? []).filter((c) => c.columnId === columnId && c.id !== except);
  }

  /** Gives every card in a column a stored, evenly spaced position (when some have none, or no room is left). */
  #normalize(boardId: number, columnId: number, except?: number): Card[] {
    const list = this.#ordered(boardId, columnId, except);
    list.forEach((c, i) => {
      c.position = (i + 1) * STEP;
      this.db.prepare('UPDATE tasks SET position = ? WHERE id = ?').run(c.position, c.id);
    });
    return list;
  }

  /**
   * Moves a card to a column, after the card `after` (the one above it) and/or before `before` (the
   * one below it); neither = the bottom. Writes one row (last write wins per card). Moving to Done
   * completes the task; out of Done reopens it. A virtual column (the Everything board) means that
   * role on the card's own board.
   */
  move(taskId: number, columnId: number, opts: { before?: number | null; after?: number | null; who?: Who } = {}): Card {
    const t = this.planner.task(taskId);
    if (!t) throw new Error('Task not found');
    const home = this.boardOf(t);
    const virtualRole = (Object.entries(VIRTUAL_COLUMN).find(([, v]) => v === columnId)?.[0] as ColumnRole | undefined) ?? undefined;
    const col = virtualRole ? this.roleColumn(home.id, virtualRole) : this.column(columnId);
    if (!col) throw new Error('No such column.');
    if (col.boardId !== home.id) throw new Error('That column is on another board.');
    const who = opts.who ?? 'me';
    const before = this.card(taskId)!;
    const fromCol = this.column(before.columnId);
    let list = this.#ordered(home.id, col.id, taskId);
    if (list.some((c) => c.position >= STEP * 1e6)) list = this.#normalize(home.id, col.id, taskId);
    const idx = (id: number | null | undefined) => (id === null || id === undefined ? -1 : list.findIndex((c) => c.id === id));
    // The neighbour ids may be stale (another tab moved them): use whichever is still there.
    let at = idx(opts.after) >= 0 ? idx(opts.after) + 1 : idx(opts.before) >= 0 ? idx(opts.before) : list.length;
    let pos = between(list[at - 1]?.position, list[at]?.position);
    if (pos === undefined) {
      list = this.#normalize(home.id, col.id, taskId);
      pos = between(list[at - 1]?.position, list[at]?.position)!;
    }
    this.db.prepare('UPDATE tasks SET column_id = ?, position = ? WHERE id = ?').run(col.id, pos, taskId);
    this.#quiet++;
    try {
      if (col.role === 'done' && t.status !== 'done') this.as(who, () => this.planner.updateTask(taskId, { status: 'done' }));
      else if (col.role !== 'done' && t.status === 'done') this.as(who, () => this.planner.updateTask(taskId, { status: 'open' }));
    } finally {
      this.#quiet--;
    }
    const now = this.planner.task(taskId)!;
    if (now.repeat !== 'none' && col.role === 'done' && now.status === 'open') {
      // A repeating card: done, and back in To do for its next time.
      this.db.prepare('UPDATE tasks SET column_id = NULL WHERE id = ?').run(taskId);
      this.log(taskId, who, 'done', { repeat: now.repeat, next: now.dueAt });
    } else if (fromCol?.id !== col.id) this.log(taskId, who, col.role === 'done' ? 'done' : 'moved', { from: fromCol?.name ?? null, to: col.name, role: col.role });
    this.#emit(home.id, 'moved', taskId);
    return this.card(taskId)!;
  }

  /** Moves a card to the first column of a role on its own board (the worker: Doing, Waiting, Done). */
  moveToRole(taskId: number, role: ColumnRole, who: Who): Card {
    const t = this.planner.task(taskId);
    if (!t) throw new Error('Task not found');
    const col = this.roleColumn(this.boardOf(t).id, role);
    const cur = this.card(taskId)!;
    if (cur.columnId === col.id) return cur;
    return this.move(taskId, col.id, { who });
  }

  /** Where a card sits now: "position 2 of 5" for the aria-live line. */
  place(taskId: number, boardId?: number): { column: string; index: number; of: number } | undefined {
    const c = this.card(taskId);
    if (!c) return undefined;
    const b = boardId ?? c.boardId;
    const v = this.view(b);
    const colId = b === EVERYTHING ? v?.cards.find((x) => x.id === taskId)?.columnId : c.columnId;
    const list = (v?.cards ?? []).filter((x) => x.columnId === colId);
    const column = v?.columns.find((x) => x.id === colId)?.name ?? '';
    return { column, index: list.findIndex((x) => x.id === taskId) + 1, of: list.length };
  }

  setCard(taskId: number, patch: { labels?: unknown; limits?: unknown; boardId?: number | null }, who: Who = 'me'): Card {
    const c = this.card(taskId);
    if (!c) throw new Error('Task not found');
    if (patch.labels !== undefined) this.db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(JSON.stringify(this.#cleanLabels(c.boardId, patch.labels)), taskId);
    if (patch.limits !== undefined) this.db.prepare('UPDATE tasks SET limits = ? WHERE id = ?').run(patch.limits === null ? null : JSON.stringify(cleanLimits(patch.limits)), taskId);
    this.log(taskId, who, 'edited', { ...(patch.labels !== undefined ? { labels: true } : {}), ...(patch.limits !== undefined ? { limits: true } : {}) });
    this.#emit(c.boardId, 'card', taskId);
    return this.card(taskId)!;
  }

  setAssignee(taskId: number, assignee: string | null, who: Who): void {
    this.db.prepare('UPDATE tasks SET assignee = ? WHERE id = ?').run(assignee, taskId);
    this.log(taskId, who, 'assigned', { to: assignee });
    this.#emit(this.card(taskId)?.boardId ?? EVERYTHING, 'assigned', taskId);
  }

  setWork(taskId: number, work: CardWork | null): void {
    this.db.prepare('UPDATE tasks SET work = ? WHERE id = ?').run(work ? JSON.stringify(work) : null, taskId);
    this.#emit(this.card(taskId)?.boardId ?? EVERYTHING, 'work', taskId);
  }

  /** Cards with work in a state (the worker's queue and restarts). */
  withWork(states: CardWork['state'][]): Card[] {
    const rows = this.db.prepare('SELECT id FROM tasks WHERE work IS NOT NULL').all() as Row[];
    return rows.map((r) => this.card(Number(r.id))).filter((c): c is Card => Boolean(c?.work && states.includes(c.work.state)));
  }

  /** The card whose work runs in a conversation. */
  byConversation(conversationId: string): Card | undefined {
    const rows = this.db.prepare("SELECT id FROM tasks WHERE work IS NOT NULL AND work LIKE ?").all(`%${conversationId.replace(/[%_]/g, '')}%`) as Row[];
    return rows.map((r) => this.card(Number(r.id))).find((c) => c?.work?.conversationId === conversationId);
  }

  comment(taskId: number, who: Who, text: string): void {
    const c = this.card(taskId);
    if (!c) throw new Error('Task not found');
    const tx = text.replace(/\r/g, '').trim().slice(0, 2000);
    if (!tx) throw new Error('Write something.');
    this.log(taskId, who, 'comment', { text: tx });
    this.#emit(c.boardId, 'comment', taskId);
  }

  tick(taskId: number, index: number, done: boolean, who: Who = 'me'): Card {
    const t = this.planner.task(taskId);
    if (!t) throw new Error('Task not found');
    const notes = tickChecklist(t.notes, index, done);
    if (notes === undefined) throw new Error('No such checklist line.');
    this.as(who, () => this.planner.updateTask(taskId, { notes }));
    return this.card(taskId)!;
  }

  /** Cards waiting on you and cards she's working on (Today's Needs you and Doing). */
  today(): { waiting: { id: number; title: string; question: string; boardId: number }[]; doing: { id: number; title: string; line: string; boardId: number }[] } {
    const cards = this.withWork(['waiting', 'running', 'queued']);
    return {
      waiting: cards.filter((c) => c.work!.state === 'waiting').slice(0, 8).map((c) => ({ id: c.id, title: c.title, question: c.work!.ask?.text ?? '', boardId: c.boardId })),
      doing: cards.filter((c) => c.work!.state !== 'waiting').slice(0, 8).map((c) => ({ id: c.id, title: c.title, line: c.work!.state === 'queued' ? 'Queued' : (c.work!.line ?? ''), boardId: c.boardId })),
    };
  }
}

function cleanWip(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || Number(v) === 0) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1 || n > 50) throw new Error('A limit is a number from 1 to 50 (or none).');
  return n;
}
