// Phase 99 (ST4, docs/design/STAPLES.md §7.6): household boards shared by choice. Members' data
// stays in their own folders (Phase 71); a shared board lives in one shared store,
// <data>/shared/boards.db (the same board tables, a `shared_tasks` copy of the task columns, the
// activity, and `board_members (board_id, person, role owner|editor)`). Only its members see it:
// every call names the person asking and is refused (undefined → 404) when they aren't a member.
// Invited people see an invitation and must accept. Card conversations (her work) stay in the space
// of the person who assigned her; the shared card shows only the outcome and the receipts' titles.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { between, checklistOf, DEFAULT_COLUMNS, LABEL_COLORS, MAX_LABELS, ROLES, tickChecklist, type Activity, type ActivityWhat, type CardWork, type ColumnRole, type Label, type LabelColor, type Who } from './board.ts';
import type { CardSource, WorkCard } from './board-work.ts';
import { cleanLimits, type TeamLimits } from './team.ts';

const STEP = 1024;
type Row = Record<string, string | number | null>;
const json = <T>(v: unknown, d: T): T => {
  if (typeof v !== 'string' || !v) return d;
  try {
    return JSON.parse(v) as T;
  } catch {
    return d;
  }
};

export interface SharedBoard {
  id: string;
  name: string;
  kind: 'shared';
  createdBy: string;
  members: { person: string; role: 'owner' | 'editor'; status: 'member' | 'invited' }[];
  createdAt: string;
}
export interface SharedCard {
  id: string;
  ref: string;
  title: string;
  notes: string;
  status: 'open' | 'done';
  priority: 'low' | 'normal' | 'high';
  dueAt: string | null;
  doneAt: string | null;
  createdAt: string;
  boardId: string;
  columnId: number;
  position: number;
  labels: string[];
  assignee: string | null;
  work: Partial<CardWork> | null;
  limits: TeamLimits | null;
  checklist: { done: number; total: number };
  project: null;
  repeat: 'none';
}

/** What a space gets: the store, who it is, and the household's names (for \"Shared with Max and Lea\"). */
export interface SharedBoardsAccess {
  store: SharedBoardStore;
  person: string;
  people: () => { id: string; name: string }[];
  /** A card's copy for an assignee's own planner when its board is deleted. */
  copyToPlanner?: (person: string, card: { title: string; notes: string; dueAt: string | null }) => void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, project_id INTEGER, shared TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_columns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, board_id INTEGER NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
  position REAL NOT NULL, wip_limit INTEGER
);
CREATE TABLE IF NOT EXISTS board_labels (board_id INTEGER NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, PRIMARY KEY (board_id, name));
CREATE TABLE IF NOT EXISTS shared_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, board_id INTEGER NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'normal', due_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, done_at TEXT,
  column_id INTEGER, position REAL, labels TEXT NOT NULL DEFAULT '[]', assignee TEXT, work TEXT, limits TEXT,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shared_tasks_board ON shared_tasks(board_id);
CREATE TABLE IF NOT EXISTS card_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, at TEXT NOT NULL, who TEXT NOT NULL, what TEXT NOT NULL, detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_members (
  board_id INTEGER NOT NULL, person TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'invited',
  invited_by TEXT, at TEXT NOT NULL, PRIMARY KEY (board_id, person)
);
`;

const bid = (id: string | number): number | undefined => {
  const m = /^s(\d{1,12})$/.exec(String(id));
  return m ? Number(m[1]) : undefined;
};

export class SharedBoardStore {
  readonly db: DatabaseSync;
  /** Told after a change: which board, and whose spaces should hear about it. */
  readonly listeners = new Set<(ev: { boardId: string; people: string[]; what: string }) => void>();

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  #now(): string {
    return new Date().toISOString();
  }
  #emit(boardId: number, what: string, extra: string[] = []): void {
    const people = [...new Set([...this.#members(boardId).map((m) => m.person), ...extra])];
    for (const fn of this.listeners) {
      try {
        fn({ boardId: `s${boardId}`, people, what });
      } catch {
        /* a listener's problem */
      }
    }
  }

  // ---------------- membership ----------------

  #members(boardId: number): SharedBoard['members'] {
    return (this.db.prepare('SELECT person, role, status FROM board_members WHERE board_id = ? ORDER BY at, person').all(boardId) as Row[]).map((r) => ({ person: String(r.person), role: r.role === 'owner' ? 'owner' : 'editor', status: r.status === 'member' ? 'member' : 'invited' }));
  }
  /** The person's role on a board they've accepted (undefined: not a member → 404 for them). */
  role(person: string, boardId: string | number): 'owner' | 'editor' | undefined {
    const n = typeof boardId === 'number' ? boardId : bid(boardId);
    if (n === undefined) return undefined;
    const r = this.db.prepare("SELECT role FROM board_members WHERE board_id = ? AND person = ? AND status = 'member'").get(n, person) as Row | undefined;
    return r ? (r.role === 'owner' ? 'owner' : 'editor') : undefined;
  }
  #board(r: Row): SharedBoard {
    return { id: `s${Number(r.id)}`, name: String(r.name), kind: 'shared', createdBy: String(r.shared ?? ''), members: this.#members(Number(r.id)), createdAt: String(r.created_at) };
  }
  board(person: string, id: string): SharedBoard | undefined {
    const n = bid(id);
    if (n === undefined || !this.role(person, n)) return undefined;
    const r = this.db.prepare('SELECT * FROM boards WHERE id = ?').get(n) as Row | undefined;
    return r ? this.#board(r) : undefined;
  }
  boardsFor(person: string): SharedBoard[] {
    return (this.db.prepare("SELECT b.* FROM boards b JOIN board_members m ON m.board_id = b.id WHERE m.person = ? AND m.status = 'member' ORDER BY b.name COLLATE NOCASE").all(person) as Row[]).map((r) => this.#board(r));
  }
  invitesFor(person: string): { boardId: string; name: string; from: string }[] {
    return (this.db.prepare("SELECT b.id, b.name, m.invited_by FROM boards b JOIN board_members m ON m.board_id = b.id WHERE m.person = ? AND m.status = 'invited' ORDER BY m.at").all(person) as Row[]).map((r) => ({ boardId: `s${Number(r.id)}`, name: String(r.name), from: String(r.invited_by ?? '') }));
  }

  create(person: string, name: string, people: string[], known: string[]): SharedBoard {
    const n = name.replace(/\s+/g, ' ').trim();
    if (!n || n.length > 80) throw new Error('Give the board a name (up to 80 characters).');
    const ts = this.#now();
    const id = Number(this.db.prepare('INSERT INTO boards (name, shared, created_at, updated_at) VALUES (?, ?, ?, ?)').run(n, person, ts, ts).lastInsertRowid);
    DEFAULT_COLUMNS.forEach((c, i) => this.db.prepare('INSERT INTO board_columns (board_id, name, role, position) VALUES (?, ?, ?, ?)').run(id, c.name, c.role, (i + 1) * STEP));
    this.db.prepare("INSERT INTO board_members (board_id, person, role, status, invited_by, at) VALUES (?, ?, 'owner', 'member', ?, ?)").run(id, person, person, ts);
    this.#invite(id, person, people, known);
    this.#emit(id, 'board');
    return this.board(person, `s${id}`)!;
  }
  #invite(boardId: number, from: string, people: string[], known: string[]): void {
    for (const p of [...new Set(people.map(String))]) {
      if (p === from || !known.includes(p)) continue;
      this.db.prepare("INSERT OR IGNORE INTO board_members (board_id, person, role, status, invited_by, at) VALUES (?, ?, 'editor', 'invited', ?, ?)").run(boardId, p, from, this.#now());
    }
  }
  /** Invites more people (members of the board only; the household's ids only). */
  share(person: string, id: string, people: string[], known: string[]): SharedBoard | undefined {
    const n = bid(id);
    if (n === undefined || !this.role(person, n)) return undefined;
    this.#invite(n, person, people, known);
    this.#emit(n, 'members', people.filter((p) => known.includes(p)));
    return this.board(person, id);
  }
  accept(person: string, id: string): boolean {
    const n = bid(id);
    if (n === undefined) return false;
    const ok = Number(this.db.prepare("UPDATE board_members SET status = 'member', at = ? WHERE board_id = ? AND person = ? AND status = 'invited'").run(this.#now(), n, person).changes) > 0;
    if (ok) this.#emit(n, 'members');
    return ok;
  }
  decline(person: string, id: string): boolean {
    const n = bid(id);
    if (n === undefined) return false;
    const ok = Number(this.db.prepare("DELETE FROM board_members WHERE board_id = ? AND person = ? AND status = 'invited'").run(n, person).changes) > 0;
    if (ok) this.#emit(n, 'members', [person]);
    return ok;
  }
  /** Leaving removes access (the creator deletes the board instead). */
  leave(person: string, id: string): boolean {
    const n = bid(id);
    if (n === undefined || this.role(person, n) !== 'editor') return false;
    this.db.prepare('DELETE FROM board_members WHERE board_id = ? AND person = ?').run(n, person);
    this.#emit(n, 'members', [person]);
    return true;
  }
  /** The creator deletes the board; assignees get a copy of their open cards in their own planner. */
  remove(person: string, id: string, copy?: SharedBoardsAccess['copyToPlanner']): boolean {
    const n = bid(id);
    if (n === undefined || this.role(person, n) !== 'owner') return false;
    const people = this.#members(n).map((m) => m.person);
    for (const r of this.db.prepare("SELECT * FROM shared_tasks WHERE board_id = ? AND status = 'open' AND assignee IS NOT NULL").all(n) as Row[]) {
      const a = String(r.assignee);
      const who = a === 'me' ? String(r.created_by) : a.startsWith('member:') ? a.slice(7) : a === 'sara' ? String(json<CardWork | null>(r.work, null)?.by ?? '') : '';
      if (who && people.includes(who)) copy?.(who, { title: String(r.title), notes: String(r.notes), dueAt: r.due_at === null ? null : String(r.due_at) });
    }
    const ids = (this.db.prepare('SELECT id FROM shared_tasks WHERE board_id = ?').all(n) as Row[]).map((r) => Number(r.id));
    for (const t of ids) this.db.prepare('DELETE FROM card_activity WHERE task_id = ?').run(t);
    for (const tbl of ['shared_tasks', 'board_columns', 'board_labels', 'board_members']) this.db.prepare(`DELETE FROM ${tbl} WHERE board_id = ?`).run(n);
    this.db.prepare('DELETE FROM boards WHERE id = ?').run(n);
    for (const fn of this.listeners) fn({ boardId: id, people, what: 'deleted' });
    return true;
  }

  // ---------------- columns and labels ----------------

  columns(boardId: number): { id: number; boardId: string; name: string; role: ColumnRole; position: number; wipLimit: number | null }[] {
    return (this.db.prepare('SELECT * FROM board_columns WHERE board_id = ? ORDER BY position, id').all(boardId) as Row[]).map((r) => ({ id: Number(r.id), boardId: `s${boardId}`, name: String(r.name), role: (ROLES.includes(r.role as ColumnRole) ? r.role : 'other') as ColumnRole, position: Number(r.position), wipLimit: r.wip_limit === null ? null : Number(r.wip_limit) }));
  }
  #colBoard(columnId: number): number | undefined {
    const r = this.db.prepare('SELECT board_id FROM board_columns WHERE id = ?').get(columnId) as Row | undefined;
    return r ? Number(r.board_id) : undefined;
  }
  addColumn(person: string, id: string, name: string, role: ColumnRole, wip: number | null): boolean {
    const n = bid(id);
    if (n === undefined || !this.role(person, n)) return false;
    const nm = name.replace(/\s+/g, ' ').trim();
    if (!nm || nm.length > 40 || !ROLES.includes(role)) throw new Error('Give the column a name (up to 40 characters).');
    const cols = this.columns(n);
    if (cols.length >= 12) throw new Error('A board has at most 12 columns.');
    const done = cols.findIndex((c) => c.role === 'done');
    const pos = done >= 0 ? (between(cols[done - 1]?.position, cols[done].position) ?? cols[done].position - 1) : (cols.at(-1)?.position ?? 0) + STEP;
    this.db.prepare('INSERT INTO board_columns (board_id, name, role, position, wip_limit) VALUES (?, ?, ?, ?, ?)').run(n, nm, role, pos, wip);
    this.#emit(n, 'columns');
    return true;
  }
  updateColumn(person: string, columnId: number, patch: { name?: string; wipLimit?: number | null }): boolean {
    const n = this.#colBoard(columnId);
    if (n === undefined || !this.role(person, n)) return false;
    if (patch.name !== undefined) {
      const nm = patch.name.replace(/\s+/g, ' ').trim();
      if (!nm || nm.length > 40) throw new Error('Give the column a name (up to 40 characters).');
      this.db.prepare('UPDATE board_columns SET name = ? WHERE id = ?').run(nm, columnId);
    }
    if (patch.wipLimit !== undefined) this.db.prepare('UPDATE board_columns SET wip_limit = ? WHERE id = ?').run(patch.wipLimit, columnId);
    this.#emit(n, 'columns');
    return true;
  }
  labels(boardId: number): Label[] {
    return (this.db.prepare('SELECT name, color FROM board_labels WHERE board_id = ? ORDER BY rowid').all(boardId) as Row[]).map((r) => ({ name: String(r.name), color: (LABEL_COLORS.includes(r.color as LabelColor) ? r.color : 'gray') as LabelColor }));
  }
  setLabels(person: string, id: string, labels: unknown): Label[] | undefined {
    const n = bid(id);
    if (n === undefined || !this.role(person, n)) return undefined;
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
    this.db.prepare('DELETE FROM board_labels WHERE board_id = ?').run(n);
    for (const l of clean) this.db.prepare('INSERT INTO board_labels (board_id, name, color) VALUES (?, ?, ?)').run(n, l.name, l.color);
    this.#emit(n, 'labels');
    return clean;
  }
  rename(person: string, id: string, name: string): boolean {
    const n = bid(id);
    if (n === undefined || this.role(person, n) !== 'owner') return false;
    const nm = name.replace(/\s+/g, ' ').trim();
    if (!nm || nm.length > 80) throw new Error('Give the board a name (up to 80 characters).');
    this.db.prepare('UPDATE boards SET name = ?, updated_at = ? WHERE id = ?').run(nm, this.#now(), n);
    this.#emit(n, 'board');
    return true;
  }

  // ---------------- cards ----------------

  #raw(taskId: number): Row | undefined {
    return this.db.prepare('SELECT * FROM shared_tasks WHERE id = ?').get(taskId) as Row | undefined;
  }
  /** A card's board, when the person may see it. */
  #mine(person: string, ref: string): { r: Row; board: number } | undefined {
    const n = bid(ref);
    if (n === undefined) return undefined;
    const r = this.#raw(n);
    if (!r || !this.role(person, Number(r.board_id))) return undefined;
    return { r, board: Number(r.board_id) };
  }
  #card(r: Row, person: string | null, cols: ReturnType<SharedBoardStore['columns']>): SharedCard {
    const done = cols.find((c) => c.role === 'done') ?? cols[0];
    const todo = cols.find((c) => c.role === 'todo') ?? cols[0];
    const own = r.column_id === null ? undefined : cols.find((c) => c.id === Number(r.column_id));
    let col = own;
    if (r.status === 'done') col = own?.role === 'done' ? own : done;
    else if (!own || own.role === 'done') col = todo;
    const work = json<CardWork | null>(r.work, null);
    // Her work belongs to the person who assigned her: the others see only the outcome.
    const shown: Partial<CardWork> | null = !work ? null : person === null || (work.by ?? '') === person ? work : { kind: work.kind, state: work.state, by: work.by, ...(work.endedAt ? { endedAt: work.endedAt } : {}), receipts: (work.receipts ?? []).map((x) => ({ tool: x.tool, summary: x.summary.slice(0, 80), status: x.status })) };
    const id = Number(r.id);
    return {
      id: `s${id}`,
      ref: `s${id}`,
      title: String(r.title),
      notes: String(r.notes),
      status: r.status === 'done' ? 'done' : 'open',
      priority: (['low', 'normal', 'high'].includes(String(r.priority)) ? r.priority : 'normal') as SharedCard['priority'],
      dueAt: r.due_at === null ? null : String(r.due_at),
      doneAt: r.done_at === null ? null : String(r.done_at),
      createdAt: String(r.created_at),
      boardId: `s${Number(r.board_id)}`,
      columnId: col!.id,
      position: r.position === null ? STEP * 1e6 + id : Number(r.position),
      labels: json<string[]>(r.labels, []),
      assignee: r.assignee === null ? null : String(r.assignee),
      work: shown,
      limits: r.limits ? cleanLimits(json(r.limits, {})) : null,
      checklist: checklistOf(String(r.notes)),
      project: null,
      repeat: 'none',
    };
  }
  card(person: string, ref: string): SharedCard | undefined {
    const m = this.#mine(person, ref);
    return m ? this.#card(m.r, person, this.columns(m.board)) : undefined;
  }
  view(person: string, id: string): { board: SharedBoard; columns: (ReturnType<SharedBoardStore['columns']>[number] & { count: number })[]; cards: SharedCard[]; labels: Label[] } | undefined {
    const board = this.board(person, id);
    if (!board) return undefined;
    const n = bid(id)!;
    const cols = this.columns(n);
    const cards = (this.db.prepare('SELECT * FROM shared_tasks WHERE board_id = ?').all(n) as Row[]).map((r) => this.#card(r, person, cols));
    cards.sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
    return { board, columns: cols.map((c) => ({ ...c, count: cards.filter((x) => x.columnId === c.id).length })), cards, labels: this.labels(n) };
  }

  log(taskId: number, who: Who, what: ActivityWhat, detail: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO card_activity (task_id, at, who, what, detail) VALUES (?, ?, ?, ?, ?)').run(taskId, this.#now(), who, what, JSON.stringify(detail).slice(0, 4000));
  }
  activity(person: string, ref: string): Activity[] | undefined {
    const m = this.#mine(person, ref);
    if (!m) return undefined;
    return (this.db.prepare('SELECT * FROM card_activity WHERE task_id = ? ORDER BY id DESC LIMIT 200').all(Number(m.r.id)) as Row[]).reverse().map((r) => {
      const detail = json<Record<string, unknown>>(r.detail, {});
      // A conversation id belongs to the person whose work it is.
      if (detail.conversationId && String(r.who) !== `member:${person}` && String(r.who) !== 'sara') delete detail.conversationId;
      delete detail.conversationId;
      return { id: Number(r.id), taskId: Number(r.task_id), at: String(r.at), who: String(r.who), what: String(r.what) as ActivityWhat, detail };
    });
  }

  addCard(person: string, id: string, c: { title: string; notes?: string; dueAt?: string | null; columnId?: number; labels?: string[] }): SharedCard | undefined {
    const n = bid(id);
    if (n === undefined || !this.role(person, n)) return undefined;
    const title = c.title.replace(/\s+/g, ' ').trim();
    if (!title || title.length > 300) throw new Error('Task title must be 1-300 characters');
    const cols = this.columns(n);
    const col = c.columnId !== undefined ? cols.find((x) => x.id === c.columnId) : (cols.find((x) => x.role === 'todo') ?? cols[0]);
    if (!col) throw new Error('No such column on this board.');
    const last = (this.db.prepare('SELECT MAX(position) AS p FROM shared_tasks WHERE board_id = ? AND column_id = ?').get(n, col.id) as Row).p;
    const ts = this.#now();
    const known = new Set(this.labels(n).map((l) => l.name));
    const tid = Number(
      this.db
        .prepare('INSERT INTO shared_tasks (board_id, title, notes, status, due_at, created_at, updated_at, done_at, column_id, position, labels, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(n, title, (c.notes ?? '').slice(0, 20_000), col.role === 'done' ? 'done' : 'open', c.dueAt ?? null, ts, ts, col.role === 'done' ? ts : null, col.id, (last === null ? 0 : Number(last)) + STEP, JSON.stringify((c.labels ?? []).filter((l) => known.has(l)).slice(0, MAX_LABELS)), person).lastInsertRowid,
    );
    this.log(tid, `member:${person}`, 'created', {});
    this.#emit(n, 'card');
    return this.card(person, `s${tid}`);
  }

  update(person: string, ref: string, patch: { title?: string; notes?: string; dueAt?: string | null; status?: 'open' | 'done'; priority?: string }): SharedCard | undefined {
    const m = this.#mine(person, ref);
    if (!m) return undefined;
    const r = m.r;
    const title = patch.title === undefined ? String(r.title) : patch.title.replace(/\s+/g, ' ').trim();
    if (!title || title.length > 300) throw new Error('Task title must be 1-300 characters');
    const status = patch.status ?? String(r.status);
    const ts = this.#now();
    this.db.prepare('UPDATE shared_tasks SET title = ?, notes = ?, due_at = ?, status = ?, done_at = ?, priority = ?, updated_at = ? WHERE id = ?').run(title, patch.notes === undefined ? String(r.notes) : patch.notes.slice(0, 20_000), patch.dueAt === undefined ? r.due_at : patch.dueAt, status, status === 'done' ? (r.done_at ?? ts) : null, ['low', 'normal', 'high'].includes(String(patch.priority)) ? String(patch.priority) : String(r.priority), ts, Number(r.id));
    this.log(Number(r.id), `member:${person}`, status !== r.status ? (status === 'done' ? 'done' : 'moved') : 'edited', {});
    this.#emit(m.board, 'card');
    return this.card(person, ref);
  }
  deleteCard(person: string, ref: string): boolean {
    const m = this.#mine(person, ref);
    if (!m) return false;
    this.db.prepare('DELETE FROM shared_tasks WHERE id = ?').run(Number(m.r.id));
    this.db.prepare('DELETE FROM card_activity WHERE task_id = ?').run(Number(m.r.id));
    this.#emit(m.board, 'card');
    return true;
  }

  move(person: string, ref: string, columnId: number, opts: { before?: string | number | null; after?: string | number | null; who?: Who } = {}): SharedCard | undefined {
    const m = this.#mine(person, ref);
    if (!m) return undefined;
    const cols = this.columns(m.board);
    const col = cols.find((c) => c.id === columnId);
    if (!col) throw new Error('No such column.');
    const tid = Number(m.r.id);
    const before = this.#card(m.r, person, cols);
    const others = (this.db.prepare('SELECT * FROM shared_tasks WHERE board_id = ? AND id != ?').all(m.board, tid) as Row[]).map((r) => this.#card(r, person, cols)).filter((c) => c.columnId === col.id);
    others.sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
    const refOf = (x: string | number | null | undefined) => (x === null || x === undefined ? '' : /^s/.test(String(x)) ? String(x) : `s${x}`);
    const idx = (x: string | number | null | undefined) => others.findIndex((c) => c.ref === refOf(x));
    const at = idx(opts.after) >= 0 ? idx(opts.after) + 1 : idx(opts.before) >= 0 ? idx(opts.before) : others.length;
    let pos = between(others[at - 1]?.position, others[at]?.position);
    if (pos === undefined || others.some((c) => c.position >= STEP * 1e6)) {
      others.forEach((c, i) => {
        c.position = (i + 1) * STEP;
        this.db.prepare('UPDATE shared_tasks SET position = ? WHERE id = ?').run(c.position, Number(c.ref.slice(1)));
      });
      pos = between(others[at - 1]?.position, others[at]?.position)!;
    }
    const ts = this.#now();
    const status = col.role === 'done' ? 'done' : 'open';
    this.db.prepare('UPDATE shared_tasks SET column_id = ?, position = ?, status = ?, done_at = ?, updated_at = ? WHERE id = ?').run(col.id, pos, status, status === 'done' ? (m.r.done_at ?? ts) : null, ts, tid);
    if (before.columnId !== col.id) this.log(tid, opts.who ?? `member:${person}`, col.role === 'done' ? 'done' : 'moved', { to: col.name, role: col.role });
    this.#emit(m.board, 'moved');
    return this.card(person, ref);
  }

  setCard(person: string, ref: string, patch: { labels?: unknown; limits?: unknown }): SharedCard | undefined {
    const m = this.#mine(person, ref);
    if (!m) return undefined;
    const tid = Number(m.r.id);
    if (patch.labels !== undefined) {
      const known = new Set(this.labels(m.board).map((l) => l.name));
      this.db.prepare('UPDATE shared_tasks SET labels = ? WHERE id = ?').run(JSON.stringify((Array.isArray(patch.labels) ? patch.labels : []).map(String).filter((l) => known.has(l)).slice(0, MAX_LABELS)), tid);
    }
    if (patch.limits !== undefined) this.db.prepare('UPDATE shared_tasks SET limits = ? WHERE id = ?').run(patch.limits === null ? null : JSON.stringify(cleanLimits(patch.limits)), tid);
    this.#emit(m.board, 'card');
    return this.card(person, ref);
  }
  comment(person: string, ref: string, who: Who, text: string): boolean {
    const m = this.#mine(person, ref);
    if (!m) return false;
    const tx = text.replace(/\r/g, '').trim().slice(0, 2000);
    if (!tx) throw new Error('Write something.');
    this.log(Number(m.r.id), who, 'comment', { text: tx });
    this.#emit(m.board, 'comment');
    return true;
  }
  tick(person: string, ref: string, index: number, done: boolean): SharedCard | undefined {
    const m = this.#mine(person, ref);
    if (!m) return undefined;
    const notes = tickChecklist(String(m.r.notes), index, done);
    if (notes === undefined) throw new Error('No such checklist line.');
    return this.update(person, ref, { notes });
  }

  /** The card worker's view of this person's shared cards (only work they assigned runs in their space). */
  source(person: string): CardSource {
    const wc = (id: number): WorkCard | undefined => {
      const r = this.#raw(id);
      if (!r || !this.role(person, Number(r.board_id))) return undefined;
      const cols = this.columns(Number(r.board_id));
      const c = this.#card(r, null, cols);
      return { ref: `s${id}`, title: c.title, notes: c.notes, labels: c.labels, project: null, projectId: null, dueAt: c.dueAt, assignee: c.assignee, work: json<CardWork | null>(r.work, null), limits: c.limits, order: [Number(r.board_id), cols.find((x) => x.id === c.columnId)?.position ?? 0, c.position] };
    };
    return {
      prefix: 's',
      get: wc,
      setWork: (id, w) => {
        const r = this.#raw(id);
        if (!r || !this.role(person, Number(r.board_id))) return;
        this.db.prepare('UPDATE shared_tasks SET work = ? WHERE id = ?').run(w ? JSON.stringify(w) : null, id);
        this.#emit(Number(r.board_id), 'work');
      },
      setAssignee: (id, a, who) => {
        const r = this.#raw(id);
        if (!r || !this.role(person, Number(r.board_id))) return;
        this.db.prepare('UPDATE shared_tasks SET assignee = ? WHERE id = ?').run(a, id);
        this.log(id, who === 'me' ? `member:${person}` : who, 'assigned', { to: a });
        this.#emit(Number(r.board_id), 'assigned');
      },
      toRole: (id, role, who) => {
        const r = this.#raw(id);
        if (!r) return;
        const col = this.columns(Number(r.board_id)).find((c) => c.role === role);
        if (col) this.move(person, `s${id}`, col.id, { who: who === 'me' ? `member:${person}` : who });
      },
      log: (id, who, what, detail) => this.log(id, who === 'me' ? `member:${person}` : who, what, detail),
      withWork: (states) => (this.db.prepare('SELECT id FROM shared_tasks WHERE work IS NOT NULL').all() as Row[]).map((r) => wc(Number(r.id))).filter((c): c is WorkCard => Boolean(c?.work && states.includes(c.work.state) && (c.work.by ?? '') === person)),
    };
  }
}
