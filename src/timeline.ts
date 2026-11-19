// V5.1 (docs/design/ROADMAP_V.md, docs/design/V5TIMELINE.md): one timeline of what she changed.
//
// Every tool call that CHANGES something (files, settings, mail, calendar, planner, anything that
// asks first) gets a row in this space's own table. A row carries an undo when one already exists
// in Sara (the workspace snapshot taken before a file change, mail_undo / gmail_undo for mail moves,
// calendar_remove for an added event, the planner's own store and note history, the name she calls
// you) and otherwise says plainly why it can't be undone. Nothing here calls a model; reverting is
// the person's own click, so it runs the existing undo directly (no second approval card).
//
// New features register their own undo with `registerAction(tool, describe, before?)` +
// `registerRevert(type, fn)`: describe() turns a finished call into a row, before() captures what
// is needed to put things back (read before the tool runs).
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { cleanWhy, whyLines, type ActionWhy } from './action-why.ts';
import { en, trOwner } from './i18n.ts';
import type { Task } from './planner.ts';
import { toolChanges } from './tools/effects.ts';
import { workspaceDir } from './tools/workspace.ts';

export const TIMELINE_KINDS = ['files', 'settings', 'mail', 'calendar', 'planner', 'other'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/** A way back: `type` picks the reverter, the rest is its data. */
export type Undo = { type: string; [k: string]: unknown };

export interface ActionInfo {
  kind: TimelineKind;
  undo?: Undo;
  /** Why it can't be undone (an en() key the web translates). */
  never?: string;
  /** A plain line for the row (an en() key with {params}); the tool's own summary otherwise. */
  title?: string;
  params?: Record<string, string | number>;
}

export interface DescribeInput {
  app: AppContext;
  args: Record<string, unknown>;
  output: string;
  conversationId?: string;
  workspace?: string;
  snapshotId?: string;
  /** What `before` returned for this call. */
  before?: unknown;
}
export type Describe = (x: DescribeInput) => ActionInfo | null;
export type Before = (args: Record<string, unknown>, app: AppContext) => unknown;
export type Revert = (u: Undo, app: AppContext, row: TimelineRow) => Promise<string | void> | string | void;

export interface TimelineRow {
  id: number;
  at: string;
  conversationId: string | null;
  tool: string;
  kind: TimelineKind;
  summary: string;
  /** en() key + params the web shows instead of `summary` (translated). */
  title?: string;
  params?: Record<string, string | number>;
  canRevert: boolean;
  never?: string;
  revertedAt?: string;
  /** W5.5: what started it and why no card was shown, stored when it happened (undefined = an older row). */
  why?: ActionWhy;
}

export class TimelineError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Plain reasons (translated in the web).
export const NEVER = {
  sent: en("Sent messages can't be unsent."),
  noSnapshot: en("No snapshot was taken before this, so it can't be undone here."),
  device: en('This changed one device only: use Undo on its chat card on that device.'),
  undoItself: en('This was itself an undo.'),
  eventGone: en("A deleted event can't be brought back from here."),
  eventEdit: en("The earlier details of the event were not kept, so this can't be undone here."),
  noUndo: en('This kind of change has no undo yet.'),
} as const;

const DESCRIBE = new Map<string, Describe>();
const BEFORE = new Map<string, Before>();
const REVERT = new Map<string, Revert>();

/** A feature says how a finished call of its tool shows on the timeline (and, optionally, what to read first). */
export function registerAction(tool: string, describe: Describe, before?: Before): void {
  DESCRIBE.set(tool, describe);
  if (before) BEFORE.set(tool, before);
  else BEFORE.delete(tool);
}

/** How an undo of `type` is carried out. Throw TimelineError(409, …) when it can't be any more. */
export function registerRevert(type: string, fn: Revert): void {
  REVERT.set(type, fn);
}

const KEEP_DAYS = 90;
const KEEP_ROWS = 2000;
const SEND_WORDS = /(?:^|_)(?:send|reply|forward|post|publish|call|message|invite|share|pay|buy|order|tweet|dm)(?:_|$)/;
const NOTE_ID = /#(\d+)/;

function kindByName(name: string): TimelineKind {
  if (/^(?:write_file|edit_file|shell|delete_file|move_file)$/.test(name)) return 'files';
  if (/^(?:mail_|gmail_|email_)/.test(name)) return 'mail';
  if (/^calendar/.test(name)) return 'calendar';
  if (/^(?:todo|note|remind|task_|planner_)/.test(name)) return 'planner';
  if (/setting/.test(name)) return 'settings';
  return 'other';
}

interface DbRow {
  id: number;
  at: string;
  conversation_id: string | null;
  tool: string;
  kind: string;
  summary: string;
  undo: string | null;
  never: string | null;
  title: string | null;
  params: string | null;
  reverted_at: string | null;
  why?: string | null;
}

export class ActionTimeline {
  readonly db: DatabaseSync;
  readonly #now: () => Date;
  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.#now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS action_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, conversation_id TEXT, tool TEXT NOT NULL,
      kind TEXT NOT NULL, summary TEXT NOT NULL, undo TEXT, never TEXT, reverted_at TEXT, revert_note TEXT, title TEXT, params TEXT)`);
    db.exec('CREATE INDEX IF NOT EXISTS action_timeline_at ON action_timeline(at)');
    // W5.5: the row's cause + rule (small JSON). Older tables get the column; their rows stay NULL.
    const cols = db.prepare('PRAGMA table_info(action_timeline)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'why')) db.exec('ALTER TABLE action_timeline ADD COLUMN why TEXT');
  }

  record(r: { tool: string; kind: TimelineKind; summary: string; conversationId?: string | null; undo?: Undo; never?: string; title?: string; params?: Record<string, string | number>; why?: ActionWhy }): TimelineRow {
    const at = this.#now().toISOString();
    const undo = r.undo ? JSON.stringify(r.undo) : null;
    const never = r.undo ? null : (r.never ?? NEVER.noUndo);
    const params = r.title && r.params ? JSON.stringify(Object.fromEntries(Object.entries(r.params).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 120) : v]))) : null;
    const why = cleanWhy(r.why);
    const id = Number(this.db.prepare('INSERT INTO action_timeline (at, conversation_id, tool, kind, summary, undo, never, title, params, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(at, r.conversationId ?? null, r.tool, r.kind, r.summary.slice(0, 400), undo, never, r.title ?? null, params, why ? JSON.stringify(why) : null).lastInsertRowid);
    this.#prune();
    return this.get(id)!;
  }

  #prune(): void {
    const cut = new Date(this.#now().getTime() - KEEP_DAYS * 86_400_000).toISOString();
    this.db.prepare('DELETE FROM action_timeline WHERE at < ? OR id <= (SELECT MAX(id) FROM action_timeline) - ?').run(cut, KEEP_ROWS);
  }

  #row(d: DbRow): TimelineRow {
    return {
      id: Number(d.id),
      at: String(d.at),
      conversationId: d.conversation_id ?? null,
      tool: String(d.tool),
      kind: (TIMELINE_KINDS as readonly string[]).includes(d.kind) ? (d.kind as TimelineKind) : 'other',
      summary: String(d.summary),
      ...(d.title ? { title: String(d.title), params: d.params ? (JSON.parse(String(d.params)) as Record<string, string | number>) : {} } : {}),
      canRevert: Boolean(d.undo) && !d.reverted_at && REVERT.has((JSON.parse(String(d.undo)) as Undo).type),
      ...(d.never ? { never: String(d.never) } : {}),
      ...(d.reverted_at ? { revertedAt: String(d.reverted_at) } : {}),
      ...(() => {
        try {
          const w = d.why ? cleanWhy(JSON.parse(String(d.why))) : undefined;
          return w ? { why: w } : {};
        } catch {
          return {};
        }
      })(),
    };
  }

  get(id: number): TimelineRow | undefined {
    const d = this.db.prepare('SELECT * FROM action_timeline WHERE id = ?').get(id) as DbRow | undefined;
    return d ? this.#row(d) : undefined;
  }

  list(f: { kind?: string; limit?: number; before?: number } = {}): TimelineRow[] {
    const where: string[] = [];
    const vals: (string | number)[] = [];
    if (f.kind && (TIMELINE_KINDS as readonly string[]).includes(f.kind)) {
      where.push('kind = ?');
      vals.push(f.kind);
    }
    if (f.before) {
      where.push('id < ?');
      vals.push(f.before);
    }
    const limit = Math.max(1, Math.min(500, Math.trunc(f.limit ?? 100)));
    const rows = this.db.prepare(`SELECT * FROM action_timeline ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`).all(...vals) as unknown as DbRow[];
    return rows.map((d) => this.#row(d));
  }

  /** Runs the row's undo once. 404 unknown, 409 already reverted / can't be undone / the undo refused. */
  async revert(id: number, app?: AppContext): Promise<TimelineRow> {
    const d = this.db.prepare('SELECT * FROM action_timeline WHERE id = ?').get(id) as DbRow | undefined;
    if (!d) throw new TimelineError(404, en('That change is no longer on the timeline.'));
    if (d.reverted_at) throw new TimelineError(409, en('That change was already reverted.'));
    if (!d.undo) throw new TimelineError(409, d.never ?? NEVER.noUndo);
    const u = JSON.parse(d.undo) as Undo;
    const fn = REVERT.get(u.type);
    if (!fn) throw new TimelineError(409, NEVER.noUndo);
    const a = app ?? bound.get(this);
    if (!a) throw new TimelineError(409, NEVER.noUndo);
    // Claim it first so two quick clicks can't run the undo twice.
    const claimed = Number(this.db.prepare('UPDATE action_timeline SET reverted_at = ? WHERE id = ? AND reverted_at IS NULL').run(this.#now().toISOString(), id).changes);
    if (!claimed) throw new TimelineError(409, en('That change was already reverted.'));
    try {
      const note = await fn(u, a, this.#row(d));
      this.db.prepare('UPDATE action_timeline SET revert_note = ? WHERE id = ?').run(typeof note === 'string' ? note.slice(0, 400) : null, id);
    } catch (err) {
      this.db.prepare('UPDATE action_timeline SET reverted_at = NULL WHERE id = ?').run(id);
      if (err instanceof TimelineError) throw err;
      throw new TimelineError(409, (err as Error).message.replace(/^Error:\s*/, '').slice(0, 300) || NEVER.noUndo);
    }
    return this.get(id)!;
  }
}

const bound = new WeakMap<ActionTimeline, AppContext>();
const perApp = new WeakMap<object, ActionTimeline>();

/** This space's timeline (one table in its own sara.db). */
export function timelineOf(app: AppContext): ActionTimeline {
  let t = perApp.get(app.store);
  if (!t) {
    t = new ActionTimeline(app.store.db, () => app.now());
    perApp.set(app.store, t);
  }
  bound.set(t, app);
  return t;
}

/** chat.ts: read what a later Revert needs, just before the tool runs. Never throws. */
export function timelineBefore(app: AppContext, name: string, args: Record<string, unknown>): unknown {
  const b = BEFORE.get(name);
  if (!b) return undefined;
  try {
    return b(args, app);
  } catch {
    return undefined;
  }
}

/** chat.ts: a finished, successful tool call. Read-only calls are skipped. Never throws. */
export function noteAction(app: AppContext, c: { name: string; args: Record<string, unknown>; output: string; summary: string; conversationId?: string; workspace?: string; snapshotId?: string; before?: unknown; why?: ActionWhy }): TimelineRow | undefined {
  try {
    const d = DESCRIBE.get(c.name);
    let info: ActionInfo | null;
    if (d) info = d({ app, args: c.args, output: c.output, ...(c.conversationId ? { conversationId: c.conversationId } : {}), ...(c.workspace ? { workspace: c.workspace } : {}), ...(c.snapshotId ? { snapshotId: c.snapshotId } : {}), before: c.before });
    else {
      // One rule with the claim checker (src/tools/effects.ts): every tool that changes something gets a
      // row, including quiet ('auto') ones like canvas_post; tools that only read are skipped.
      const tool = app.tools.get(c.name);
      if (!tool || !toolChanges(c.name)) return undefined;
      info = { kind: kindByName(c.name), never: SEND_WORDS.test(c.name) ? NEVER.sent : NEVER.noUndo };
    }
    if (!info) return undefined;
    return timelineOf(app).record({ tool: c.name, kind: info.kind, summary: c.summary || c.name, conversationId: c.conversationId ?? null, ...(info.undo ? { undo: info.undo } : {}), ...(info.never ? { never: info.never } : {}), ...(info.title ? { title: info.title, params: info.params ?? {} } : {}), ...(c.why ? { why: c.why } : {}) });
  } catch {
    return undefined;
  }
}

// ---------- W5.5: "why did you do that?" in chat, from the stored rows only ----------

/**
 * The rows a "why did you do that?" in this chat is about: what she changed since the person's
 * previous message (newest first, up to 3). Empty = nothing recorded, so the model answers as usual.
 */
export function rowsToExplain(app: AppContext, conversationId: string, sinceIso: string | undefined): TimelineRow[] {
  try {
    const rows = timelineOf(app).db.prepare('SELECT id FROM action_timeline WHERE conversation_id = ? AND (? IS NULL OR at >= ?) ORDER BY id DESC LIMIT 3').all(conversationId, sinceIso ?? null, sinceIso ?? null) as { id: number }[];
    return rows.map((r) => timelineOf(app).get(Number(r.id))!).filter(Boolean);
  } catch {
    return [];
  }
}

/** The chat answer, built from the stored rows (translated to the person's language). */
export function whyAnswer(app: AppContext, rows: TimelineRow[]): string {
  const s = app.settings.get();
  const tz = s.timeZone;
  const T = (k: string, p?: Record<string, unknown>) => trOwner(k, s, p);
  const time = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString(typeof s.language === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(s.language) ? s.language : 'en-US', { hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
    } catch {
      return new Date(iso).toISOString().slice(11, 16);
    }
  };
  const one = (r: TimelineRow) => {
    const what = r.title ? T(r.title, r.params ?? {}) : r.summary;
    const lines = whyLines(r.why).map((l) => T(l.key, { ...(l.params ?? {}), ...(l.at ? { time: time(l.at) } : {}) }));
    return `${T(en('What I did: {what}'), { what })}\n${lines.join('\n')}`;
  };
  const head = T(en('Here is why, from my action timeline:'));
  return `${head}\n\n${rows.map(one).join('\n\n')}\n\n${T(en('Every change is listed in Settings → Privacy & system → Reports → Action timeline.'))}`;
}

// ---------- what already exists in Sara ----------

const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};
const firstId = (s: string, re: RegExp): number | undefined => num(re.exec(s)?.[1]);

// Files: the snapshot chat.ts takes before write_file / edit_file / shell (src/snapshots.ts).
for (const name of ['write_file', 'edit_file', 'shell']) {
  registerAction(name, ({ snapshotId, workspace }) => (snapshotId && workspace ? { kind: 'files', undo: { type: 'snapshot', workspace, snap: snapshotId } } : { kind: 'files', never: NEVER.noSnapshot }));
}
registerRevert('snapshot', (u, app) => {
  const ws = String(u.workspace);
  const r = app.snapshots.restore(ws, workspaceDir(app.rootDir ?? app.dataDir, ws), String(u.snap));
  return `Restored ${r.restored} files, removed ${r.removed}; the state just before is kept as snapshot ${r.safety.id}.`;
});

// Settings: the everyday settings tool (src/everyday-settings.ts). Device ones live in that browser.
registerAction('change_setting', ({ args, output }) => {
  if (String(args.setting) !== 'my_name') return { kind: 'settings', never: NEVER.device };
  const to = /is now "([^"]*)"/.exec(output)?.[1];
  if (to === undefined) return null;
  return { kind: 'settings', undo: { type: 'owner-name', from: /\(was "([^"]*)"\)/.exec(output)?.[1] ?? '', to }, title: en('Started calling you {name}'), params: { name: to } };
});
registerRevert('owner-name', (u, app) => {
  const cur = app.settings.get().ownerName?.trim() ?? '';
  if (cur !== String(u.to)) throw new TimelineError(409, en('This was changed again since, so it was left as it is.'));
  app.settings.update({ ownerName: String(u.from) });
});

// Mail moves: the organizers' own undo records (src/mail/organize.ts, src/gmail-organize.ts).
const mailResult = (output: string): string | undefined => {
  const m = /\[gmail-result (\{.*\})\]/.exec(output);
  if (!m) return undefined;
  try {
    const id = (JSON.parse(m[1]) as { id?: string }).id;
    return id ? String(id) : undefined;
  } catch {
    return undefined;
  }
};
/** "Sorted 12 emails": the organizer's own count. */
const mailTitle = (output: string): Pick<ActionInfo, 'title' | 'params'> => {
  const m = /\[gmail-result (\{.*\})\]/.exec(output);
  try {
    const r = JSON.parse(m?.[1] ?? '{}') as { done?: number; action?: string };
    return typeof r.done === 'number' ? { title: en('Sorted {count} emails'), params: { count: r.done } } : {};
  } catch {
    return {};
  }
};
registerAction('mail_organize', ({ output }) => {
  const id = mailResult(output);
  return id ? { kind: 'mail', undo: { type: 'tool', tool: 'mail_undo', args: { id } }, ...mailTitle(output) } : null;
});
registerAction('gmail_organize', ({ output }) => {
  const id = mailResult(output);
  return id ? { kind: 'mail', undo: { type: 'tool', tool: 'gmail_undo', args: { id } }, ...mailTitle(output) } : null;
});
for (const name of ['mail_undo', 'gmail_undo']) registerAction(name, () => ({ kind: 'mail', never: NEVER.undoItself }));

// Calendar: an added event is removed with calendar_remove (Google or the mailbox's calendar).
registerAction('calendar_add', ({ args, output }) => {
  const id = /\(event ([^)\s]+)\)/.exec(output)?.[1];
  if (!id) return null;
  const what = /Added “([^”]+)”/.exec(output)?.[1];
  return { kind: 'calendar', undo: { type: 'tool', tool: 'calendar_remove', args: { id, ...(typeof args.account === 'string' && args.account ? { account: args.account } : {}) } }, ...(what ? { title: en('Added “{title}” to your calendar'), params: { title: what } } : {}) };
});
registerAction('calendar_remove', () => ({ kind: 'calendar', never: NEVER.eventGone }));
registerAction('calendar_update', () => ({ kind: 'calendar', never: NEVER.eventEdit }));

/** Runs an existing undo tool directly: the Revert click is the person's OK. */
registerRevert('tool', async (u, app, row) => {
  const tool = app.tools.get(String(u.tool));
  if (!tool || (tool.isAvailable && !tool.isAvailable())) throw new TimelineError(409, en('The connection this change went through is not available now.'));
  const args = (u.args ?? {}) as Record<string, unknown>;
  const signal = AbortSignal.timeout(5 * 60_000);
  const ctx = { workspaceDir: app.dataDir, signal, sandbox: app.sandbox, ...(row.conversationId ? { conversationId: row.conversationId } : {}) };
  if (tool.prepare) {
    const p = (await tool.prepare(args, ctx)) as { refuse?: string } | undefined;
    if (p?.refuse) throw new TimelineError(409, p.refuse);
  }
  return await tool.run(args, ctx);
});

// Planner (src/planner.ts): to-dos, notes (with their history) and reminders.
const plannerOf = (app: AppContext) => {
  if (!app.planner) throw new TimelineError(409, NEVER.noUndo);
  return app.planner;
};
registerAction(
  'todo',
  ({ args, output, before }) => {
    const action = String(args.action ?? '');
    if (action === 'add') {
      const id = firstId(output, /Added task #(\d+)/);
      return id ? { kind: 'planner', undo: { type: 'task-delete', id }, title: en('Added the to-do “{title}”'), params: { title: String(args.title ?? '') } } : null;
    }
    if (action === 'done' || action === 'reopen') {
      const id = num(args.id);
      const title = /#\d+ \[[ x]\] ([^—\n(]+?)(?: \(| —|\.$|$)/m.exec(output)?.[1]?.trim() ?? `#${id}`;
      return id ? { kind: 'planner', undo: { type: 'task-status', id, status: action === 'done' ? 'open' : 'done' }, title: action === 'done' ? en('Checked off “{title}”') : en('Opened “{title}” again'), params: { title } } : null;
    }
    if (action === 'update' || action === 'delete') {
      const title = (before as Task | undefined)?.title ?? `#${String(args.id ?? '')}`;
      const line = { title: action === 'delete' ? en('Deleted the to-do “{title}”') : en('Changed the to-do “{title}”'), params: { title } };
      return before ? { kind: 'planner', undo: { type: 'task-restore', task: before }, ...line } : { kind: 'planner', never: NEVER.noUndo, ...line };
    }
    return null;
  },
  (args, app) => (['update', 'delete'].includes(String(args.action)) && num(args.id) ? app.planner?.task(num(args.id)!) : undefined),
);
registerRevert('task-delete', (u, app) => {
  if (!plannerOf(app).deleteTask(Number(u.id))) throw new TimelineError(409, en('That to-do is already gone.'));
});
registerRevert('task-status', (u, app) => {
  if (!plannerOf(app).updateTask(Number(u.id), { status: u.status === 'done' ? 'done' : 'open' })) throw new TimelineError(409, en('That to-do is already gone.'));
});
registerRevert('task-restore', (u, app) => {
  const p = plannerOf(app);
  const t = u.task as Task;
  const fields = { title: t.title, project: t.project ?? null, notes: t.notes ?? '', priority: t.priority, dueAt: t.dueAt ?? null, repeat: t.repeat };
  if (p.task(t.id)) p.updateTask(t.id, { ...fields, status: t.status });
  else {
    const made = p.addTask(fields);
    if (t.status === 'done') p.updateTask(made.id, { status: 'done' });
  }
});

registerAction(
  'note',
  ({ app, args, output, before }) => {
    const action = String(args.action ?? '');
    const b = before as { id?: number; top?: number; existed: boolean } | undefined;
    if (action === 'delete') {
      const id = num(args.id);
      const v = id ? app.planner?.deletedNotes().find((x) => x.noteId === id) : undefined;
      const line = { title: en('Deleted the note “{title}”'), params: { title: v?.title ?? `#${String(id ?? '')}` } };
      return v ? { kind: 'planner', undo: { type: 'note-restore', id, version: v.id }, ...line } : { kind: 'planner', never: NEVER.noUndo, ...line };
    }
    if (!['add', 'save', 'restore'].includes(action)) return null;
    const id = num(args.id) ?? firstId(output, NOTE_ID);
    if (!id) return null;
    const line = { title: b?.existed ? en('Changed the note “{title}”') : en('Made the note “{title}”'), params: { title: app.planner?.note(id)?.title ?? `#${id}` } };
    if (!b?.existed) return { kind: 'planner', undo: { type: 'note-delete', id }, ...line };
    const top = app.planner?.noteVersions(id)[0]?.id;
    return top && top !== b.top ? { kind: 'planner', undo: { type: 'note-restore', id, version: top }, ...line } : { kind: 'planner', never: NEVER.noUndo, ...line };
  },
  (args, app) => {
    const id = num(args.id) ?? (typeof args.title === 'string' ? app.planner?.noteByTitle(args.title)?.id : undefined);
    const n = id ? app.planner?.note(id) : undefined;
    return n ? { id: n.id, existed: true, top: app.planner?.noteVersions(n.id)[0]?.id } : { existed: false };
  },
);
registerRevert('note-restore', (u, app) => {
  plannerOf(app).restoreNoteVersion(Number(u.id), Number(u.version));
});
registerRevert('note-delete', (u, app) => {
  if (!plannerOf(app).deleteNote(Number(u.id))) throw new TimelineError(409, en('That note is already gone.'));
  return 'Deleted the note (kept in its history for 30 days).';
});

registerAction(
  'remind',
  ({ args, output, before }) => {
    const action = String(args.action ?? '');
    if (action === 'set') {
      const id = firstId(output, /Reminder #(\d+)/);
      return id ? { kind: 'planner', undo: { type: 'reminder-cancel', id }, title: en('Set a reminder: “{text}”'), params: { text: String(args.text ?? '') } } : null;
    }
    if (action === 'cancel') {
      const line = { title: en('Cancelled the reminder “{text}”'), params: { text: (before as { text?: string } | undefined)?.text ?? `#${String(args.id ?? '')}` } };
      return before ? { kind: 'planner', undo: { type: 'reminder-add', reminder: before }, ...line } : { kind: 'planner', never: NEVER.noUndo, ...line };
    }
    return null;
  },
  (args, app) => (String(args.action) === 'cancel' && num(args.id) ? app.planner?.reminder(num(args.id)!) : undefined),
);
registerRevert('reminder-cancel', (u, app) => {
  if (!plannerOf(app).cancelReminder(Number(u.id))) throw new TimelineError(409, en('That reminder already went off or was cancelled.'));
});
registerRevert('reminder-add', (u, app) => {
  const r = u.reminder as { text: string; dueAt: string; repeat?: string; conversationId?: string | null };
  if (Date.parse(r.dueAt) <= app.now().getTime()) throw new TimelineError(409, en('Its time has passed, so it was not set again.'));
  plannerOf(app).addReminder({ text: r.text, dueAt: r.dueAt, ...(r.repeat ? { repeat: r.repeat as never } : {}), conversationId: r.conversationId ?? null });
});
