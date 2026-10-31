// Phase 85 (harness track M10, docs/design/HARNESS_TRACK.md §3 M10): active recall triggers.
//
// Instead of only searching her memory when asked, the harness watches the run and recalls on its
// own when the situation matches something she saw before in this project:
//
//   error    a tool error or test failure whose normalised signature matches a past failure that
//            was fixed ("last time this error happened here, the fix was X");
//   command  a command whose last recorded run in this project failed;
//   file     editing a file the owner has a decision / note about (or a lesson names);
//   task     a new task close in words or meaning to one that left a lesson (rankMemories);
//   package  installing a dependency a lesson is about.
//
// 1. Run signatures (`recall_signatures`, built incrementally by the turn's afterTool hook and once
//    over older runs by a bounded backfill): failures = tool + error class + the error line with
//    paths, line numbers, hex, timestamps, ids and numbers stripped; commands (normalised);
//    files touched; packages. One row per (kind, signature, workspace, conversation) with a count,
//    the last run/step, the outcome and what resolved it.
// 2. Lessons: a failure followed later in the same run (or the next turn of the same conversation)
//    by the SAME command succeeding, with a recorded change in between, becomes a `lesson` memory
//    note quoting the error line and the change verbatim from the run record. Never invented: no
//    recorded change in between, no lesson.
// 3. Triggers: at most STEP_CAP notes per model call and TURN_CAP per turn, each with its source
//    (run, date) and the M1 bracket `[why: …; sure: …]` (left out for anything spoken aloud). They
//    go in as system notes before the next model call, never change what she does by themselves,
//    and show as "Remembered on her own" chips (step line + her panel) with "Not useful", which
//    halves that trigger's weight (recorded in `recall_feedback`).
// 4. Rules: Settings → Memory → "Recall on her own" (off / coding only (default) / everywhere);
//    never in partner chats or groups; another app's turn sees only sources M1 would show it
//    (the same `allow` predicate); private sources only in private conversations.
// Code only: no model call (§3.12).
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { type Confidence, matchedWords, queryWords, rankMemories, type RankSource, type RankedPick, stem } from './memory-rank.ts';
import type { Memory, MemoryStore } from './memory.ts';
import type { RunStore, StepView } from './runs.ts';
import { installTargets } from './security/deps.ts';

// ------------------------------------------------------------------------------------------------
// Settings and limits
// ------------------------------------------------------------------------------------------------

export type RecallMode = 'off' | 'coding' | 'everywhere';
export const RECALL_MODES: readonly RecallMode[] = ['off', 'coding', 'everywhere'];
export const DEFAULT_RECALL_MODE: RecallMode = 'coding';
export function recallMode(m: { recall?: unknown } | undefined): RecallMode {
  return RECALL_MODES.includes(m?.recall as RecallMode) ? (m!.recall as RecallMode) : DEFAULT_RECALL_MODE;
}

/** Notes per model call and per turn. */
export const STEP_CAP = 2;
export const TURN_CAP = 4;
/** A trigger fires when its base score × weight reaches this. */
export const FIRE_AT = 0.45;
/** "Not useful" multiplies the weight by this (two in a row silence an exact error match). */
export const NOT_USEFUL_FACTOR = 0.5;
export const MIN_WEIGHT = 0.05;
/** Backfill bounds (one-time job over runs recorded before this feature). */
export const BACKFILL_CHUNK = 200;
export const BACKFILL_MAX_RUNS = 5000;
/** The start of every note she gets (also how a replay recognises a recorded recall note). */
export const RECALL_MARK = 'Remembered on your own';

export type TriggerKind = 'error' | 'command' | 'file' | 'task' | 'package';
export const TRIGGER_KINDS: readonly TriggerKind[] = ['error', 'command', 'file', 'task', 'package'];
const BASE: Record<Exclude<TriggerKind, 'task'>, number> = { error: 1, command: 0.8, file: 0.8, package: 0.7 };
const PRIORITY: Record<TriggerKind, number> = { error: 0, command: 1, package: 2, file: 3, task: 4 };
/** Words in nearly every coding request and every lesson (stemmed): never evidence of a similar task. */
const GENERIC = new Set(['test', 'fail', 'fix', 'error', 'run', 'pass', 'command', 'project', 'again', 'npm', 'node', 'file', 'code', 'work', 'broken', 'break', 'please', 'help', 'check', 'look', 'make', 'red', 'green', 'build', 'issue', 'problem', 'bug'].map((w) => stem(w)));

// ------------------------------------------------------------------------------------------------
// Signatures (pure)
// ------------------------------------------------------------------------------------------------

export type SigKind = 'failure' | 'command' | 'file' | 'package';

/**
 * An error line or message with the parts that change from run to run taken out: file URLs and
 * paths (Windows and POSIX), line:column, hex and long hex ids, UUIDs, timestamps, durations,
 * numbers. Lower case, single spaces, at most 200 characters.
 */
export function normalizeMessage(text: string): string {
  return text
    .replace(/file:\/\/\/?[^\s'"()<>]+/gi, '<path>')
    .replace(/\b[A-Za-z]:[\\/][^\s'"()<>:]*(?::\d+)*/g, '<path>')
    .replace(/(?:^|(?<=[\s('"=]))(?:\.{1,2}[\\/]|[\\/])?(?:[\w.@+-]+[\\/])+[\w.@+-]*(?::\d+)*/g, '<path>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, '<time>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\b/g, '<time>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, '<hex>')
    .replace(/\(\s*\d+(?:\.\d+)?\s*m?s\s*\)/g, '')
    .replace(/([\w>)\]])(?::\d+)+\b/g, '$1')
    .replace(/\b(line|col|column|row)\s+\d+/gi, '$1 <n>')
    .replace(/\b\d+(?:\.\d+)?(?=[a-z%]|\b)/gi, '<n>')
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Error line shapes, most telling first. Each gives the class and where the message starts. */
const ERROR_SHAPES: { re: RegExp; cls: (m: RegExpExecArray) => string }[] = [
  { re: /\b([A-Z][A-Za-z]*(?:Error|Exception))\b(?:\s*\[[A-Z_]+\])?:\s*\S/, cls: (m) => m[1] },
  { re: /\berror\s+(TS\d{3,5})\s*:/i, cls: (m) => m[1].toUpperCase() },
  { re: /\b(E[A-Z]{3,})\b[:,]/, cls: (m) => m[1] },
  { re: /^\s*(?:npm|pnpm|yarn)\s+(?:ERR!|error)\s+\S/i, cls: () => 'npm' },
  { re: /^\s*(?:error|fatal)(?:\[\w+\])?:\s*\S/i, cls: () => 'Error' },
  { re: /^\s*(?:FAIL|FAILED|✖|✗|×|not ok)\b\s*\S/, cls: () => 'TestFailure' },
  { re: /\b(?:Traceback \(most recent call last\))/, cls: () => 'Traceback' },
];

/** The most telling error line of a tool's output (scrubbed text), with its class. */
export function errorLine(output: string): { line: string; cls: string } | undefined {
  const lines = output.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() && !/^\[(?:exit code|timed out)/.test(l.trim()));
  for (const shape of ERROR_SHAPES) {
    for (let i = 0; i < lines.length; i++) {
      const m = shape.re.exec(lines[i]);
      if (!m) continue;
      let line = lines[i].trim();
      // "Expected values to be strictly equal:" says little alone: the next line belongs to it.
      if (/:$/.test(line) && lines[i + 1]?.trim()) line = `${line} ${lines[i + 1].trim()}`;
      return { line: line.slice(0, 300), cls: shape.cls(m) };
    }
  }
  const last = lines.at(-1)?.trim();
  return last ? { line: last.slice(0, 300), cls: 'exit' } : undefined;
}

/** Did this tool step fail (an error status, or a shell command with a non-zero exit / a time-out)? */
export function stepFailed(tool: string, status: string, output: string): boolean {
  if (status === 'error') return true;
  if (status !== 'ok') return false;
  if (tool === 'shell') {
    // (A command run for real after a sandbox try starts with one line about the try.)
    const m = /^\[(?:exit code (\S+?)[,\]]|(timed out)\b)/.exec(output.trimStart().replace(/^\[tried in a sandbox copy first[^\n]*\n/, ''));
    if (!m) return false;
    return Boolean(m[2]) || (m[1] !== '0' && m[1] !== 'none');
  }
  return false;
}

/** A command with what changes between runs taken out (`cd x &&`, output filters, paths, numbers). */
export function normalizeCommand(command: string): string {
  let c = command.replace(/\s+/g, ' ').trim();
  c = c.replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '');
  c = c.replace(/\s*\d?>&\d\b/g, '').replace(/\s*\|\s*(?:tail|head|grep|less|more|cat|tee)\b.*$/, '');
  return c
    .split(' ')
    .map((tok) => (/[\\/]/.test(tok) && !/^-/.test(tok) ? '<path>' : /^\d+$/.test(tok) ? '<n>' : tok))
    .join(' ')
    .toLowerCase()
    .slice(0, 160);
}

/** A workspace-relative path as one key (forward slashes, no leading ./, lower case). */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/{2,}/g, '/').toLowerCase().slice(0, 300);
}

/** Packages an error line names ("Cannot find module 'x'", "No module named 'x'"). */
export function packagesInError(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/Cannot find (?:module|package) ['"]((?:@[\w.-]+\/)?[\w.-]+)[^'"]*['"]/g)) if (!m[1].startsWith('.')) out.push(`npm/${m[1].toLowerCase()}`);
  for (const m of line.matchAll(/No module named ['"]?([\w]+)/g)) out.push(`pypi/${m[1].toLowerCase()}`);
  return out;
}

export const sigOf = (kind: SigKind, key: string) => createHash('sha256').update(`${kind}\n${key}`).digest('hex').slice(0, 16);

export interface Signature {
  kind: SigKind;
  key: string;
  sig: string;
  /** The verbatim (scrubbed) text it came from: the error line, the command, the path. */
  quote: string;
  cls?: string;
}

export interface ToolEvent {
  tool: string;
  args: Record<string, unknown>;
  status: string;
  output: string;
  callId?: string;
  messageId?: number;
}

const FILE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch']);
const pathOf = (args: Record<string, unknown>) => (typeof args.path === 'string' ? args.path : typeof args.file === 'string' ? args.file : '');

/** Every signature of one tool step: its failure (if it failed), its command, its files, its packages. */
export function signaturesOf(t: ToolEvent): Signature[] {
  const out: Signature[] = [];
  const failed = stepFailed(t.tool, t.status, t.output);
  if (failed) {
    const e = errorLine(t.output.replace(/^\[[^\]]*\]\n?/, ''));
    if (e) {
      const key = `${t.tool}|${e.cls}|${normalizeMessage(e.line)}`;
      out.push({ kind: 'failure', key, sig: sigOf('failure', key), quote: e.line, cls: e.cls });
      for (const p of packagesInError(e.line)) out.push({ kind: 'package', key: p, sig: sigOf('package', p), quote: e.line });
    }
  }
  if (t.tool === 'shell' && typeof t.args.command === 'string' && t.args.command.trim()) {
    const key = normalizeCommand(t.args.command);
    if (key) out.push({ kind: 'command', key, sig: sigOf('command', key), quote: t.args.command.slice(0, 300) });
    try {
      for (const p of installTargets(t.args.command)) {
        const k = `${p.ecosystem}/${p.name.toLowerCase()}`;
        if (!out.some((x) => x.kind === 'package' && x.key === k)) out.push({ kind: 'package', key: k, sig: sigOf('package', k), quote: t.args.command.slice(0, 300) });
      }
    } catch {
      /* not an install */
    }
  }
  if (FILE_TOOLS.has(t.tool) && t.status === 'ok') {
    const p = pathOf(t.args);
    if (p) {
      const key = normalizePath(p);
      out.push({ kind: 'file', key, sig: sigOf('file', key), quote: p.slice(0, 300) });
    }
  }
  return out;
}

/** A recorded change that can be quoted as a fix (a file edit / write, or a command that worked). */
export function fixQuote(t: ToolEvent): string | undefined {
  if (t.status !== 'ok') return undefined;
  const clipQ = (s: string, n = 140) => {
    const one = s.replace(/\s+/g, ' ').trim();
    return one.length > n ? `${one.slice(0, n - 1)}…` : one;
  };
  if (t.tool === 'edit_file' && typeof t.args.old_string === 'string' && typeof t.args.new_string === 'string') return `edited ${pathOf(t.args)}: “${clipQ(t.args.old_string)}” → “${clipQ(t.args.new_string)}”`;
  if (t.tool === 'write_file' && pathOf(t.args)) return `rewrote ${pathOf(t.args)}`;
  if (t.tool === 'apply_patch' && pathOf(t.args)) return `patched ${pathOf(t.args)}`;
  if (t.tool === 'shell' && typeof t.args.command === 'string' && !stepFailed('shell', 'ok', t.output)) {
    try {
      if (installTargets(t.args.command).length) return `ran \`${clipQ(t.args.command, 120)}\``;
    } catch {
      /* not an install */
    }
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------------
// The index
// ------------------------------------------------------------------------------------------------

type Row = Record<string, string | number | null>;

export interface SigRow {
  id: number;
  sig: string;
  kind: SigKind;
  key: string;
  workspace: string;
  conversationId: string;
  runId: number | null;
  step: number | null;
  toolId: string | null;
  tool: string | null;
  quote: string;
  outcome: 'fail' | 'ok';
  link: string | null;
  resolvedBy: { runId: number | null; step: number; quote: string; lessonId?: number } | null;
  lessonId: number | null;
  isPrivate: boolean;
  apps: boolean;
  firstSeen: string;
  lastSeen: string;
  count: number;
}

export interface LessonRow {
  memoryId: number;
  workspace: string;
  sig: string;
  conversationId: string;
  failRun: number | null;
  failStep: number | null;
  fixRun: number | null;
  fixStep: number | null;
  command: string;
  errorQuote: string;
  fixQuote: string;
  packages: string[];
  files: string[];
  createdAt: string;
}

/** Where a step happened (for writing and for the rules). */
export interface StepContext {
  conversationId: string;
  workspace: string;
  runId: number | null;
  step: number;
  /** The source conversation is private (only private conversations see it). */
  isPrivate: boolean;
  /** M1's rule for other apps: would another app see notes from this conversation? */
  apps: boolean;
}

const parse = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

export class RecallIndex {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  /** The index's clock (the app's), so a lesson's date matches the rest of the run. */
  nowIso(): string {
    return this.#now().toISOString();
  }

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS recall_signatures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sig TEXT NOT NULL,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      workspace TEXT NOT NULL DEFAULT '',
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      run_id INTEGER,
      step INTEGER,
      tool_id TEXT,
      tool TEXT,
      quote TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL,
      link TEXT,
      resolved_by TEXT,
      lesson_id INTEGER,
      private INTEGER NOT NULL DEFAULT 0,
      apps INTEGER NOT NULL DEFAULT 1,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      UNIQUE (kind, sig, workspace, conversation_id)
    );
    CREATE INDEX IF NOT EXISTS recall_sig_ws ON recall_signatures(workspace, kind, sig);
    CREATE INDEX IF NOT EXISTS recall_sig_run ON recall_signatures(run_id);
    CREATE TABLE IF NOT EXISTS recall_lessons (
      memory_id INTEGER PRIMARY KEY,
      workspace TEXT NOT NULL DEFAULT '',
      sig TEXT NOT NULL,
      conversation_id TEXT,
      fail_run INTEGER,
      fail_step INTEGER,
      fix_run INTEGER,
      fix_step INTEGER,
      command TEXT NOT NULL DEFAULT '',
      error_quote TEXT NOT NULL,
      fix_quote TEXT NOT NULL,
      packages TEXT,
      files TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS recall_lessons_ws ON recall_lessons(workspace, sig);
    CREATE TABLE IF NOT EXISTS recall_weights (
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      fired INTEGER NOT NULL DEFAULT 0,
      not_useful INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (kind, ref)
    );
    CREATE TABLE IF NOT EXISTS recall_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      verdict TEXT NOT NULL,
      conversation_id TEXT,
      run_id INTEGER,
      message_id INTEGER,
      weight_before REAL,
      weight_after REAL
    );
    CREATE TABLE IF NOT EXISTS recall_meta (key TEXT PRIMARY KEY, value TEXT);`);
  }

  #row(r: Row): SigRow {
    return {
      id: Number(r.id),
      sig: String(r.sig),
      kind: String(r.kind) as SigKind,
      key: String(r.key),
      workspace: String(r.workspace),
      conversationId: String(r.conversation_id),
      runId: r.run_id === null ? null : Number(r.run_id),
      step: r.step === null ? null : Number(r.step),
      toolId: (r.tool_id as string | null) ?? null,
      tool: (r.tool as string | null) ?? null,
      quote: String(r.quote ?? ''),
      outcome: String(r.outcome) === 'ok' ? 'ok' : 'fail',
      link: (r.link as string | null) ?? null,
      resolvedBy: parse(r.resolved_by, null),
      lessonId: r.lesson_id === null || r.lesson_id === undefined ? null : Number(r.lesson_id),
      isPrivate: Boolean(r.private),
      apps: Boolean(r.apps),
      firstSeen: String(r.first_seen),
      lastSeen: String(r.last_seen),
      count: Number(r.count),
    };
  }

  /** One occurrence of a signature (upsert: count + 1, the newest run/step/outcome). */
  record(s: Signature, ctx: StepContext, o: { outcome: 'fail' | 'ok'; tool: string; toolId?: string; link?: string | null; at?: string }): void {
    const at = o.at ?? this.#now().toISOString();
    this.#db
      .prepare(
        `INSERT INTO recall_signatures (sig, kind, key, workspace, conversation_id, run_id, step, tool_id, tool, quote, outcome, link, private, apps, first_seen, last_seen, count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (kind, sig, workspace, conversation_id) DO UPDATE SET run_id = excluded.run_id, step = excluded.step, tool_id = excluded.tool_id, tool = excluded.tool, quote = excluded.quote, outcome = excluded.outcome, link = COALESCE(excluded.link, CASE WHEN excluded.outcome = 'ok' THEN link ELSE NULL END), last_seen = excluded.last_seen, count = count + 1, private = excluded.private, apps = excluded.apps`,
      )
      .run(s.sig, s.kind, s.key.slice(0, 400), ctx.workspace, ctx.conversationId, ctx.runId, ctx.step, o.toolId ?? null, o.tool, s.quote.slice(0, 300), o.outcome, o.link ?? null, ctx.isPrivate ? 1 : 0, ctx.apps ? 1 : 0, at, at);
  }

  /** The rows of one signature in a workspace (every conversation), newest first. */
  find(kind: SigKind, sig: string, workspace: string): SigRow[] {
    return (this.#db.prepare('SELECT * FROM recall_signatures WHERE workspace = ? AND kind = ? AND sig = ? ORDER BY last_seen DESC, id DESC LIMIT 50').all(workspace, kind, sig) as Row[]).map((r) => this.#row(r));
  }

  /** One conversation's row of a signature. */
  findIn(kind: SigKind, sig: string, workspace: string, conversationId: string): SigRow | undefined {
    const r = this.#db.prepare('SELECT * FROM recall_signatures WHERE workspace = ? AND kind = ? AND sig = ? AND conversation_id = ?').get(workspace, kind, sig, conversationId) as Row | undefined;
    return r ? this.#row(r) : undefined;
  }

  resolve(kind: SigKind, sig: string, workspace: string, conversationId: string, by: SigRow['resolvedBy'], lessonId: number | null): void {
    this.#db.prepare('UPDATE recall_signatures SET resolved_by = ?, lesson_id = COALESCE(?, lesson_id) WHERE workspace = ? AND kind = ? AND sig = ? AND conversation_id = ?').run(JSON.stringify(by), lessonId, workspace, kind, sig, conversationId);
  }

  count(): number {
    return Number((this.#db.prepare('SELECT COUNT(*) AS n FROM recall_signatures').get() as Row).n);
  }

  list(opts: { workspace?: string; kind?: SigKind; limit?: number } = {}): SigRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.workspace !== undefined) (where.push('workspace = ?'), args.push(opts.workspace));
    if (opts.kind) (where.push('kind = ?'), args.push(opts.kind));
    args.push(Math.max(1, Math.min(1000, opts.limit ?? 200)));
    return (this.#db.prepare(`SELECT * FROM recall_signatures ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_seen DESC, id DESC LIMIT ?`).all(...args) as Row[]).map((r) => this.#row(r));
  }

  // ---- lessons ----
  addLesson(l: LessonRow): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO recall_lessons (memory_id, workspace, sig, conversation_id, fail_run, fail_step, fix_run, fix_step, command, error_quote, fix_quote, packages, files, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(l.memoryId, l.workspace, l.sig, l.conversationId, l.failRun, l.failStep, l.fixRun, l.fixStep, l.command, l.errorQuote, l.fixQuote, JSON.stringify(l.packages), JSON.stringify(l.files), l.createdAt);
  }

  #lesson(r: Row): LessonRow {
    return {
      memoryId: Number(r.memory_id),
      workspace: String(r.workspace),
      sig: String(r.sig),
      conversationId: String(r.conversation_id ?? ''),
      failRun: r.fail_run === null ? null : Number(r.fail_run),
      failStep: r.fail_step === null ? null : Number(r.fail_step),
      fixRun: r.fix_run === null ? null : Number(r.fix_run),
      fixStep: r.fix_step === null ? null : Number(r.fix_step),
      command: String(r.command ?? ''),
      errorQuote: String(r.error_quote),
      fixQuote: String(r.fix_quote),
      packages: parse(r.packages, []),
      files: parse(r.files, []),
      createdAt: String(r.created_at),
    };
  }

  lesson(memoryId: number): LessonRow | undefined {
    const r = this.#db.prepare('SELECT * FROM recall_lessons WHERE memory_id = ?').get(memoryId) as Row | undefined;
    return r ? this.#lesson(r) : undefined;
  }

  lessonsFor(workspace: string, sig: string): LessonRow[] {
    return (this.#db.prepare('SELECT * FROM recall_lessons WHERE workspace = ? AND sig = ? ORDER BY created_at DESC LIMIT 10').all(workspace, sig) as Row[]).map((r) => this.#lesson(r));
  }

  lessonsWithPackage(pkg: string): LessonRow[] {
    return (this.#db.prepare("SELECT * FROM recall_lessons WHERE packages LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 20").all(`%"${pkg.replace(/[\\%_]/g, (c) => `\\${c}`)}"%`) as Row[]).map((r) => this.#lesson(r)).filter((l) => l.packages.includes(pkg));
  }

  lessons(limit = 200): LessonRow[] {
    return (this.#db.prepare('SELECT * FROM recall_lessons ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map((r) => this.#lesson(r));
  }

  // ---- weights and feedback ----
  weight(kind: TriggerKind, ref: string): number {
    const r = this.#db.prepare('SELECT weight FROM recall_weights WHERE kind = ? AND ref = ?').get(kind, ref) as Row | undefined;
    return r ? Number(r.weight) : 1;
  }

  fired(kind: TriggerKind, ref: string): void {
    this.#db.prepare('INSERT INTO recall_weights (kind, ref, fired, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT (kind, ref) DO UPDATE SET fired = fired + 1, updated_at = excluded.updated_at').run(kind, ref, this.#now().toISOString());
  }

  /** "Not useful": halves the weight of that trigger (never below MIN_WEIGHT) and records why. */
  feedback(kind: TriggerKind, ref: string, verdict: 'not-useful', where: { conversationId?: string | null; runId?: number | null; messageId?: number | null } = {}): { before: number; after: number } {
    const before = this.weight(kind, ref);
    const after = Math.max(MIN_WEIGHT, Math.round(before * NOT_USEFUL_FACTOR * 1000) / 1000);
    const at = this.#now().toISOString();
    this.#db.prepare('INSERT INTO recall_weights (kind, ref, weight, not_useful, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT (kind, ref) DO UPDATE SET weight = excluded.weight, not_useful = not_useful + 1, updated_at = excluded.updated_at').run(kind, ref, after, at);
    this.#db.prepare('INSERT INTO recall_feedback (at, kind, ref, verdict, conversation_id, run_id, message_id, weight_before, weight_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(at, kind, ref, verdict, where.conversationId ?? null, where.runId ?? null, where.messageId ?? null, before, after);
    return { before, after };
  }

  feedbackRows(limit = 50): { at: string; kind: string; ref: string; verdict: string; weightBefore: number; weightAfter: number }[] {
    return (this.#db.prepare('SELECT * FROM recall_feedback ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map((r) => ({ at: String(r.at), kind: String(r.kind), ref: String(r.ref), verdict: String(r.verdict), weightBefore: Number(r.weight_before), weightAfter: Number(r.weight_after) }));
  }

  // ---- meta (the backfill cursor) ----
  meta(key: string): string | undefined {
    const r = this.#db.prepare('SELECT value FROM recall_meta WHERE key = ?').get(key) as Row | undefined;
    return r ? String(r.value) : undefined;
  }
  setMeta(key: string, value: string): void {
    this.#db.prepare('INSERT INTO recall_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** The run before `runId` in a conversation (the "next turn" rule), not a branch. */
  previousRun(conversationId: string, runId: number | null): number | null {
    try {
      const r = this.#db.prepare('SELECT id FROM runs WHERE conversation_id = ? AND id < ? AND parent_run_id IS NULL ORDER BY id DESC LIMIT 1').get(conversationId, runId ?? Number.MAX_SAFE_INTEGER) as Row | undefined;
      return r ? Number(r.id) : null;
    } catch {
      return null;
    }
  }

  /** Runs to backfill: turns with a conversation, not branches, after `after` up to `upTo`. */
  runsToBackfill(after: number, upTo: number, limit: number): { id: number; conversationId: string; startedAt: string }[] {
    try {
      return (this.#db.prepare("SELECT id, conversation_id, started_at FROM runs WHERE id > ? AND id <= ? AND kind = 'turn' AND conversation_id IS NOT NULL AND parent_run_id IS NULL ORDER BY id LIMIT ?").all(after, upTo, limit) as Row[]).map((r) => ({ id: Number(r.id), conversationId: String(r.conversation_id), startedAt: String(r.started_at) }));
    } catch {
      return [];
    }
  }
  maxRunId(): number {
    try {
      return Number((this.#db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM runs').get() as Row).n);
    } catch {
      return 0;
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Watching a run: signatures + lessons (writes)
// ------------------------------------------------------------------------------------------------

/** One tool step as the watcher keeps it for the turn (order = time). */
interface Seen extends ToolEvent {
  step: number;
  failed: boolean;
  sigs: Signature[];
}

export interface LessonDeps {
  memory?: MemoryStore;
  /** Local day for a note's happenedOn. */
  today: () => string;
  runs?: RunStore;
  /** Lessons are written (not in replays, off, or with memory off). */
  lessons: boolean;
}

/** The text of a lesson note, from recorded evidence only. */
export function lessonText(command: string, errorQuote: string, fixes: string[], workspace: string): string {
  const fix = fixes.slice(0, 3).join('; ');
  return `In the ${workspace || 'main'} project, \`${command.replace(/\s+/g, ' ').trim().slice(0, 120)}\` failed with “${errorQuote.replace(/\s+/g, ' ').trim().slice(0, 200)}”. What fixed it: ${fix}; then the same command passed.`;
}

/**
 * The per-turn watcher: records every tool step's signatures and, when a failed command passes
 * later with recorded changes in between (this turn, or the previous turn of the conversation),
 * writes one lesson note. Returns the lesson note's id when one was written.
 */
export class RunWatcher {
  readonly index: RecallIndex;
  readonly ctx: Omit<StepContext, 'step'>;
  readonly deps: LessonDeps;
  readonly seen: Seen[] = [];
  /** Lessons written in this turn. */
  readonly written: number[] = [];

  constructor(index: RecallIndex, ctx: Omit<StepContext, 'step'>, deps: LessonDeps) {
    this.index = index;
    this.ctx = ctx;
    this.deps = deps;
  }

  /** One finished tool step. `write` false: look only (replays). */
  observe(step: number, t: ToolEvent, write = true, at?: string): { sigs: Signature[]; failed: boolean; lessonId?: number } {
    const sigs = signaturesOf(t);
    const failed = stepFailed(t.tool, t.status, t.output);
    const seen: Seen = { ...t, step, failed, sigs };
    let lessonId: number | undefined;
    if (write) {
      const cx = { ...this.ctx, step };
      const fail = sigs.find((s) => s.kind === 'failure');
      // The command's resolution is worked out BEFORE its row is overwritten with this outcome.
      const cmd = sigs.find((s) => s.kind === 'command');
      if (cmd && !failed && t.status === 'ok') lessonId = this.#resolve(cmd, step, t, at);
      for (const s of sigs) {
        try {
          this.index.record(s, cx, { outcome: s.kind === 'failure' || (s.kind === 'command' && failed) || (s.kind === 'package' && failed) ? 'fail' : 'ok', tool: t.tool, ...(t.callId ? { toolId: t.callId } : {}), link: s.kind === 'command' && fail ? fail.sig : null, ...(at ? { at } : {}) });
        } catch (err) {
          console.warn(`recall index: ${(err as Error).message}`);
        }
      }
    }
    this.seen.push(seen);
    return { sigs, failed, ...(lessonId ? { lessonId } : {}) };
  }

  #resolve(cmd: Signature, step: number, t: ToolEvent, at?: string): number | undefined {
    // 1. This turn: the latest failure of the same command, and the changes since.
    // (The latest run of the same command; if that one passed, there is nothing open to resolve.)
    const j = this.seen.findLastIndex((x) => x.sigs.some((s) => s.kind === 'command' && s.sig === cmd.sig));
    if (j >= 0 && !this.seen[j].failed) return undefined;
    const i = j;
    let failQuote: string | undefined;
    let failSig: string | undefined;
    let failRun = this.ctx.runId;
    let failStep: number | null = null;
    let between: ToolEvent[] = [];
    if (i >= 0) {
      const f = this.seen[i];
      const fs = f.sigs.find((s) => s.kind === 'failure');
      if (!fs) return undefined;
      failQuote = fs.quote;
      failSig = fs.sig;
      failStep = f.step;
      between = this.seen.slice(i + 1);
    } else {
      // 2. The previous turn of this conversation ended with this command failing.
      const row = this.index.findIn('command', cmd.sig, this.ctx.workspace, this.ctx.conversationId);
      const prev = this.index.previousRun(this.ctx.conversationId, this.ctx.runId);
      if (!row || row.outcome !== 'fail' || !row.link || prev === null || row.runId !== prev) return undefined;
      const fr = this.index.findIn('failure', row.link, this.ctx.workspace, this.ctx.conversationId);
      if (!fr) return undefined;
      failQuote = fr.quote;
      failSig = fr.sig;
      failRun = prev;
      failStep = row.step;
      // What the previous run did after the failing call, then this turn so far.
      const steps: StepView[] = this.deps.runs?.steps(prev) ?? [];
      let after = false;
      for (const s of steps) {
        for (const x of s.tools) {
          if (after) between.push({ tool: x.name, args: x.args, status: x.status, output: x.output });
          if (x.id === row.toolId) after = true;
        }
      }
      between.push(...this.seen);
    }
    if (!failSig || !failQuote) return undefined;
    const fixes = [...new Set(between.map((x) => fixQuote(x)).filter((x): x is string => Boolean(x)))];
    // No recorded change between the failure and the pass: no evidence of a fix, no lesson.
    if (!fixes.length) {
      this.index.resolve('failure', failSig, this.ctx.workspace, this.ctx.conversationId, { runId: this.ctx.runId, step, quote: '(passed again with no recorded change)' }, null);
      return undefined;
    }
    let lessonId: number | null = null;
    const mem = this.deps.memory;
    if (this.deps.lessons && mem) {
      // One lesson per error in a project: an existing one (still in memory) is kept.
      const have = this.index.lessonsFor(this.ctx.workspace, failSig).find((l) => {
        const m = mem.get(l.memoryId);
        return m && m.supersededBy === null;
      });
      if (have) lessonId = have.memoryId;
      else {
        const command = typeof t.args.command === 'string' ? t.args.command : cmd.quote;
        const files = [...new Set(between.filter((x) => FILE_TOOLS.has(x.tool) && x.status === 'ok').map((x) => pathOf(x.args)).filter(Boolean))].slice(0, 10);
        const pkgs = [...new Set(between.flatMap((x) => signaturesOf(x).filter((s) => s.kind === 'package').map((s) => s.key)).concat(packagesInError(failQuote)))].slice(0, 10);
        const note = mem.add({
          kind: 'lesson',
          content: lessonText(command, failQuote, fixes, this.ctx.workspace),
          conversationId: this.ctx.conversationId,
          sourceMessageId: t.messageId ?? null,
          happenedOn: this.deps.today(),
          evidence: `error: “${failQuote.slice(0, 300)}” · fix: ${fixes.slice(0, 3).join('; ').slice(0, 600)}`,
        });
        lessonId = note.id;
        this.index.addLesson({ memoryId: note.id, workspace: this.ctx.workspace, sig: failSig, conversationId: this.ctx.conversationId, failRun, failStep, fixRun: this.ctx.runId, fixStep: step, command: command.slice(0, 300), errorQuote: failQuote.slice(0, 300), fixQuote: fixes.slice(0, 3).join('; ').slice(0, 600), packages: pkgs, files, createdAt: at ?? this.index.nowIso() });
        this.written.push(note.id);
      }
    }
    this.index.resolve('failure', failSig, this.ctx.workspace, this.ctx.conversationId, { runId: this.ctx.runId, step, quote: fixes.slice(0, 3).join('; ').slice(0, 600), ...(lessonId ? { lessonId } : {}) }, lessonId);
    return lessonId ?? undefined;
  }
}

/**
 * The one-time backfill over runs recorded before this feature (bounded: BACKFILL_CHUNK runs per
 * call, BACKFILL_MAX_RUNS in all, only runs up to the newest one when it first ran; newer runs are
 * watched live). Returns how many runs it read and whether it is done.
 */
export function backfill(index: RecallIndex, runs: RunStore, conv: (id: string) => { workspace: string; private: boolean; apps: boolean; partner: boolean } | undefined, deps: Omit<LessonDeps, 'runs'>, limit = BACKFILL_CHUNK): { processed: number; done: boolean } {
  let target = Number(index.meta('backfill_target') ?? NaN);
  if (!Number.isFinite(target)) {
    target = index.maxRunId();
    index.setMeta('backfill_target', String(target));
  }
  const cursor = Number(index.meta('backfill_cursor') ?? 0);
  const total = Number(index.meta('backfill_count') ?? 0);
  if (index.meta('backfill_done') === '1') return { processed: 0, done: true };
  const room = Math.max(0, Math.min(limit, BACKFILL_MAX_RUNS - total));
  const list = room ? index.runsToBackfill(cursor, target, room) : [];
  let last = cursor;
  for (const r of list) {
    last = r.id;
    const c = conv(r.conversationId);
    if (!c || c.partner) continue;
    const w = new RunWatcher(index, { conversationId: r.conversationId, workspace: c.workspace, runId: r.id, isPrivate: c.private, apps: c.apps }, { ...deps, runs });
    for (const s of runs.steps(r.id)) for (const t of s.tools) w.observe(s.idx, { tool: t.name, args: t.args, status: t.status, output: t.output, callId: t.id, ...(t.messageId ? { messageId: t.messageId } : {}) }, true, s.at);
  }
  index.setMeta('backfill_cursor', String(last));
  index.setMeta('backfill_count', String(total + list.length));
  const done = list.length < room || !room || last >= target;
  if (done) index.setMeta('backfill_done', '1');
  return { processed: list.length, done };
}

// ------------------------------------------------------------------------------------------------
// Triggers (reads)
// ------------------------------------------------------------------------------------------------

/** One recall note as shown (chip, panel) and kept on the reply (`meta.recall`). */
export interface RecallItem {
  /** `kind:ref`, unique in a turn. */
  id: string;
  kind: TriggerKind;
  /** What the weight belongs to: `lesson:<memory id>`, `sig:<signature>`, `note:<memory id>`. */
  ref: string;
  /** What she was told, without the bracket. */
  text: string;
  why: string;
  sure: Confidence;
  source: { runId: number | null; date: string; workspace: string; memoryId?: number; conversationId?: string };
  step?: number;
  feedback?: 'not-useful';
}

/** The bracket after a recall note: the M1 format (`[why: …; sure: …]`). */
export const recallBracket = (it: Pick<RecallItem, 'why' | 'sure'>) => `[why: ${it.why}; sure: ${it.sure}]`;

/** The system note she gets. `notes: false` (spoken aloud): no bracket. */
export function recallNote(it: RecallItem, notes = true): string {
  return `${RECALL_MARK} (from your own run history, ${it.source.date}${it.source.runId ? `, run ${it.source.runId}` : ''}; check it still fits before relying on it): ${it.text}${notes ? ` ${recallBracket(it)}` : ''}`;
}

export interface TriggerScope {
  /** Where she is now. */
  conversationId: string;
  workspace: string;
  runId: number | null;
  private: boolean;
  /** M1's rule for another app's turn (`appSafe` in chat.ts); unset = the owner's own chat. */
  allow?: (m: { conversationId: string | null }) => boolean;
}

const day = (iso: string) => iso.slice(0, 10);

/** Reads the index for one situation; every method returns candidate items (not yet capped). */
export class TriggerMatcher {
  readonly index: RecallIndex;
  readonly memory?: MemoryStore;
  readonly scope: TriggerScope;
  /** Conversation flags for a source (the real store; a branch's scratch store knows only its own). */
  readonly conv: (id: string) => { private: boolean } | undefined;

  constructor(index: RecallIndex, memory: MemoryStore | undefined, scope: TriggerScope, conv: (id: string) => { private: boolean } | undefined) {
    this.index = index;
    this.memory = memory;
    this.scope = scope;
    this.conv = conv;
  }

  /** May a note from this conversation come up here? (private only in private; other apps: M1's rule.) */
  allowed(src: { conversationId: string | null; isPrivate?: boolean; apps?: boolean }): boolean {
    if (!src.conversationId) return !this.scope.allow || this.scope.allow({ conversationId: null });
    const c = this.conv(src.conversationId);
    const priv = c ? c.private : Boolean(src.isPrivate);
    if (priv && !this.scope.private) return false;
    if (this.scope.allow) return c ? this.scope.allow({ conversationId: src.conversationId }) : src.apps !== false;
    return true;
  }

  #lessonOk(l: LessonRow): Memory | undefined {
    const m = this.memory?.get(l.memoryId);
    if (!m || m.supersededBy !== null || m.kind !== 'lesson') return undefined;
    if (l.fixRun !== null && l.fixRun === this.scope.runId) return undefined; // learned in this very run
    return this.allowed({ conversationId: m.conversationId }) ? m : undefined;
  }

  #fire(kind: TriggerKind, ref: string, base: number): number | undefined {
    const score = base * this.index.weight(kind, ref);
    return score >= FIRE_AT ? score : undefined;
  }

  /** A failure with a fix recorded earlier in this project. */
  onError(failure: Signature): RecallItem[] {
    for (const l of this.index.lessonsFor(this.scope.workspace, failure.sig)) {
      const m = this.#lessonOk(l);
      if (!m) continue;
      const ref = `lesson:${l.memoryId}`;
      if (this.#fire('error', ref, BASE.error) === undefined) continue;
      return [{ id: `error:${ref}`, kind: 'error', ref, text: `Last time this error came up in this project (“${l.errorQuote.slice(0, 160)}”), what fixed it was: ${l.fixQuote.slice(0, 300)}; then \`${l.command.slice(0, 80)}\` passed.`, why: `same error signature (${failure.cls ?? 'error'}) in this project`, sure: 'high', source: { runId: l.fixRun, date: day(l.createdAt), workspace: l.workspace, memoryId: l.memoryId, conversationId: l.conversationId } }];
    }
    return [];
  }

  /** A command whose last recorded run in this project (another run) failed. */
  onCommand(cmd: Signature): RecallItem[] {
    const rows = this.index.find('command', cmd.sig, this.scope.workspace).filter((r) => r.runId !== this.scope.runId && this.allowed(r));
    const last = rows[0];
    if (!last || last.outcome !== 'fail') return [];
    const ref = `sig:${cmd.sig}`;
    if (this.#fire('command', ref, BASE.command) === undefined) return [];
    const fr = last.link ? this.index.findIn('failure', last.link, this.scope.workspace, last.conversationId) : undefined;
    return [{ id: `command:${ref}`, kind: 'command', ref, text: `\`${cmd.quote.slice(0, 100)}\` failed the last time it ran in this project${fr ? ` (“${fr.quote.slice(0, 160)}”)` : ''}${fr?.resolvedBy?.quote && fr.resolvedBy.lessonId ? `; what fixed it then: ${fr.resolvedBy.quote.slice(0, 240)}` : ''}.`, why: `this command failed here before${last.count > 1 ? ` (${last.count} times)` : ''}`, sure: last.count > 1 ? 'high' : 'medium', source: { runId: last.runId, date: day(last.lastSeen), workspace: last.workspace, conversationId: last.conversationId } }];
  }

  /**
   * A file she is about to change that one of the owner's notes (a decision, a fact) names literally.
   * Lessons stay out: they come back on their own error, task or package (a lesson about another
   * error in the same file was the eval's main false trigger).
   */
  onFile(path: string): RecallItem[] {
    if (!this.memory) return [];
    const norm = normalizePath(path);
    const base = norm.split('/').pop() ?? norm;
    if (!base || base.length < 3) return [];
    const names = (s: string) => {
      const low = s.toLowerCase().replace(/\\/g, '/');
      // The whole relative path, or the file name standing alone (not a longer name ending in it).
      return low.includes(norm) || new RegExp(`(^|[^\\w.-])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(low);
    };
    const picks = rankMemories(this.memory, { query: `${path} ${base.replace(/\.\w+$/, '')}`, conversationId: this.scope.conversationId, oldestHistoryId: Number.MAX_SAFE_INTEGER, standing: false, kinds: ['decision', 'fact'], allow: (m) => this.allowed({ conversationId: m.conversationId }) });
    const out: RecallItem[] = [];
    for (const p of picks) {
      const m = p.memory;
      if (!names(`${m.content} ${m.evidence ?? ''}`)) continue;
      const ref = `note:${m.id}`;
      if (this.#fire('file', ref, BASE.file) === undefined) continue;
      out.push({ id: `file:${ref}`, kind: 'file', ref, text: `${m.kind === 'decision' ? 'You and the owner decided something' : 'You have a note'} about ${base}: “${m.content.replace(/\s+/g, ' ').slice(0, 260)}”.`, why: `names ${base}${m.kind === 'decision' ? ' (decided together)' : ''}`, sure: 'high', source: { runId: null, date: m.happenedOn, workspace: this.scope.workspace, memoryId: m.id, ...(m.conversationId ? { conversationId: m.conversationId } : {}) } });
      if (out.length >= 2) break;
    }
    return out;
  }

  /** A dependency a lesson is about (any project: a gotcha travels with the package). */
  onPackage(pkg: Signature): RecallItem[] {
    for (const l of this.index.lessonsWithPackage(pkg.key)) {
      const m = this.#lessonOk(l);
      if (!m) continue;
      const ref = `lesson:${l.memoryId}`;
      if (this.#fire('package', ref, BASE.package) === undefined) continue;
      const here = l.workspace === this.scope.workspace;
      return [{ id: `package:${ref}`, kind: 'package', ref, text: `${pkg.key.split('/').slice(1).join('/')} came up in a lesson${here ? ' in this project' : ` in the ${l.workspace} project`}: \`${l.command.slice(0, 80)}\` failed with “${l.errorQuote.slice(0, 160)}”, fixed by ${l.fixQuote.slice(0, 200)}.`, why: `package ${pkg.key}${here ? '' : ' (another project)'}`, sure: here ? 'high' : 'medium', source: { runId: l.fixRun, date: day(l.createdAt), workspace: l.workspace, memoryId: l.memoryId, conversationId: l.conversationId } }];
    }
    return [];
  }

  /** A new task close in words (≥ 2 meaningful words) or meaning (≥ 0.7) to one that left a lesson in this project. */
  onTask(text: string, related: { memory: Memory; score: number }[] = []): RecallItem[] {
    if (!this.memory) return [];
    const mem = this.memory;
    // Only lessons are searched (so 10,000 other notes can't crowd them out of the top results).
    const src: RankSource = {
      search: (q, limit) => mem.list({ q, kind: 'lesson', limit: limit ?? 12 }).map((m) => ({ memory: m, matched: matchedWords(queryWords(q), m.content) })),
      list: (o) => mem.list(o),
      openPromises: () => [],
      pinnedNotes: () => [],
      recentlyUsed: () => [],
      get: (id) => mem.get(id),
    };
    const picks = rankMemories(src, { query: text, conversationId: this.scope.conversationId, oldestHistoryId: Number.MAX_SAFE_INTEGER, related: related.filter((r) => r.memory.kind === 'lesson'), standing: false, kinds: ['lesson'], allow: (m) => this.allowed({ conversationId: m.conversationId }) });
    const out: RecallItem[] = [];
    // Words every lesson shares ("`npm test` failed … fixed … passed") prove nothing: only words of
    // its own error, change, files and command count (so "the tests fail, fix them" alone never fires).
    const asked = queryWords(text).filter((w) => !GENERIC.has(stem(w)));
    for (const p of picks as RankedPick[]) {
      const l = this.index.lesson(p.memoryId);
      if (!l || l.workspace !== this.scope.workspace || !this.#lessonOk(l)) continue;
      const own = matchedWords(asked, `${l.errorQuote} ${l.fixQuote} ${l.files.join(' ')} ${l.command} ${l.packages.join(' ')}`);
      const strong = (!p.fuzzy && own.length >= 2) || (p.meaning ?? 0) >= 0.7;
      if (!strong) continue;
      const ref = `lesson:${l.memoryId}`;
      if (this.#fire('task', ref, Math.min(1, Math.max(p.score, own.length >= 2 ? 0.6 : 0))) === undefined) continue;
      const why = [own.length >= 2 ? `words ${own.slice(0, 4).map((w) => `"${w}"`).join(', ')}` : '', p.meaning !== null ? 'meaning' : ''].filter(Boolean).join(' + ');
      out.push({ id: `task:${ref}`, kind: 'task', ref, text: `A similar task here left a lesson: ${p.memory.content.replace(/\s+/g, ' ').slice(0, 320)}`, why: `${why}; a lesson in this project`, sure: p.confidence, source: { runId: l.fixRun, date: day(l.createdAt), workspace: l.workspace, memoryId: l.memoryId, conversationId: l.conversationId } });
      if (out.length >= 2) break;
    }
    return out;
  }
}

/** Caps and order: at most STEP_CAP per call, TURN_CAP per turn, one per ref, most telling first. */
export class RecallQueue {
  readonly pending: RecallItem[] = [];
  readonly given: RecallItem[] = [];
  readonly #refs = new Set<string>();

  add(items: RecallItem[]): void {
    for (const it of items) {
      if (this.#refs.has(it.ref) || this.pending.some((p) => p.ref === it.ref)) continue;
      this.pending.push(it);
    }
  }

  /** The notes for the next model call. */
  take(step: number): RecallItem[] {
    const room = Math.min(STEP_CAP, TURN_CAP - this.given.length);
    if (room <= 0) {
      this.pending.length = 0;
      return [];
    }
    this.pending.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
    const out = this.pending.splice(0, room).map((it) => ({ ...it, step }));
    for (const it of out) {
      this.#refs.add(it.ref);
      this.given.push(it);
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------------
// The turn's hooks (src/chat.ts joins them with the others)
// ------------------------------------------------------------------------------------------------

export interface RecallHookInit {
  index: RecallIndex;
  memory?: MemoryStore;
  runs?: RunStore;
  /** Where she is (the rules) and what to write (conversation, workspace, run, flags). */
  scope: TriggerScope;
  source: Omit<StepContext, 'step'>;
  /** Index writes (never on a replay). */
  write: boolean;
  /** Lesson notes (the switch isn't Off, memory is on, not a replay). */
  lessons: boolean;
  /** Triggers on (the switch and the kind of conversation, or an eval variant). */
  fire: boolean;
  /** The bracket after each note (false for anything spoken aloud). */
  notes: boolean;
  /** The owner's message (the task trigger). */
  text: string;
  /** Notes close in meaning to the message (the turn's own embedding search, reused). */
  related?: () => Promise<{ memory: Memory; score: number }[]> | { memory: Memory; score: number }[];
  today: () => string;
  conv: (id: string) => { private: boolean } | undefined;
  /** The items of a step go on that step's saved message (`meta.recall`). */
  saveMeta: (messageId: number, items: RecallItem[]) => void;
  /** M1 hook: a lesson that helped (the command passed after it came up) counts as used. */
  markUsed?: (ids: number[]) => void;
}

/** The recall side of the turn: watch every tool step, queue matching notes, give them to the next call. */
export function recallHooks(init: RecallHookInit): import('./chat.ts').TurnHooks & { queue: RecallQueue; watcher: RunWatcher; timings: number[] } {
  const queue = new RecallQueue();
  const watcher = new RunWatcher(init.index, init.source, { memory: init.memory, runs: init.runs, today: init.today, lessons: init.lessons });
  const matcher = new TriggerMatcher(init.index, init.memory, init.scope, init.conv);
  const byStep = new Map<number, RecallItem[]>();
  const filesSeen = new Set<string>();
  const timings: number[] = [];
  let taskDone = false;
  const safe = <T>(f: () => T, fallback: T): T => {
    try {
      return f();
    } catch (err) {
      console.warn(`recall: ${(err as Error).message}`);
      return fallback;
    }
  };
  return {
    queue,
    watcher,
    timings,
    async beforeModelCall(c) {
      if (!init.fire) return;
      if (!taskDone) {
        taskDone = true;
        const related = init.related ? await Promise.resolve(init.related()).catch(() => []) : [];
        queue.add(safe(() => matcher.onTask(init.text, related), []));
      }
      const items = queue.take(c.step);
      if (!items.length) return;
      for (const it of items) safe(() => init.index.fired(it.kind, it.ref), undefined);
      byStep.set(c.step, [...(byStep.get(c.step) ?? []), ...items]);
      return { notes: items.map((it) => recallNote(it, init.notes)), recall: items.map((item) => ({ type: 'recall' as const, item })) };
    },
    beforeTool(c) {
      if (!init.fire) return;
      const t0 = performance.now();
      const sigs = signaturesOf({ tool: c.call.name, args: c.args, status: 'ok', output: '' });
      for (const s of sigs) {
        if (s.kind === 'command') queue.add(safe(() => matcher.onCommand(s), []));
        else if (s.kind === 'package') queue.add(safe(() => matcher.onPackage(s), []));
        else if (s.kind === 'file' && !filesSeen.has(s.key)) {
          filesSeen.add(s.key);
          queue.add(safe(() => matcher.onFile(s.quote), []));
        }
      }
      timings.push(performance.now() - t0);
    },
    afterTool(c) {
      const t0 = performance.now();
      const r = safe(() => watcher.observe(c.step, { tool: c.call.name, args: c.args, status: c.status, output: c.output, callId: c.call.id, messageId: c.messageId }, init.write), { sigs: [], failed: false });
      if (init.fire && r.failed) {
        const f = r.sigs.find((s) => s.kind === 'failure');
        if (f) queue.add(safe(() => matcher.onError(f), []));
      }
      // A lesson that came up and then the command it is about passed: it helped (M1 use mark).
      if (!r.failed && c.call.name === 'shell' && init.markUsed) {
        const cmd = r.sigs.find((s) => s.kind === 'command');
        const helped = queue.given.filter((it) => it.source.memoryId && (it.kind === 'error' || it.kind === 'task' || it.kind === 'command')).flatMap((it) => {
          const l = init.index.lesson(it.source.memoryId!);
          return l && cmd && normalizeCommand(l.command) === cmd.key ? [l.memoryId] : [];
        });
        if (helped.length) safe(() => init.markUsed!(helped), undefined);
      }
      timings.push(performance.now() - t0);
    },
    afterReply(c) {
      const items = byStep.get(c.step);
      if (items?.length) safe(() => init.saveMeta(c.messageId, items), undefined);
    },
  };
}
