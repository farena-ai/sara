// Phase 84 (harness track M9, docs/design/HARNESS_TRACK.md §3 M9): the eval loop. On real tasks
// from the owner's own history (not a synthetic benchmark), run the current settings (the control)
// and up to three variants (memory policy, model, tool set) through the M8 replay runner, score
// them in the open, and name a winner only when the evidence says so.
//
// 1. Tasks: the last N eligible turns of the owner's recorded runs (coding conversations by
//    default), frozen as the eval's task list so a re-run compares the same tasks. Eligible: a
//    finished reply (not a branch), its step 0 can be rebuilt, not a partner's chat, not private
//    unless every model of the eval is on this computer, and with something to grade it by (the
//    project's tests, the owner's later reaction, or the judge). Off-the-record turns have no run.
// 2. Variants: the control is the settings as they are now; each variant changes one or more of
//    memory fading, the model, the sandbox gate mode, the budget preset.
// 3. Runner: each (task, variant) is `replayRun(app, runId, { fromStep: 0, … })` headless, at most
//    two at once (the replay runner's own cap), in a workspace copy that is deleted afterwards.
//    Approvals asked during an eval are answered No (nobody is watching): nothing runs that would
//    have needed the owner's OK. A hard total ceiling (tokens, and $ for paid models) is shown with
//    the estimate before starting and enforced before every model call.
// 4. Scoring: per task and per pair (control vs variant), deterministic parts first: the project's
//    tests run in a sandbox copy after each variant, finished or stopped, the owner's later
//    reaction to the original reply, M6/M7 findings on changed files, tokens/steps/time/cost; an
//    optional pairwise judge (the Reviewing job) with the positions swapped and quotes required.
//    The weights are fixed and shown. Overall: wins/ties/losses and an exact two-sided sign test;
//    "no clear winner" unless p < 0.05 (divided by the number of variants).
// 5. Apply: "Use this setting" writes the variant's settings and a line in the settings history.
// The real workspace and the real conversation are never touched (replay's own guarantee).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { resolveChain, type AppContext, type BeforeModelCall, type TurnHooks } from './chat.ts';
import { turnBudgetFor, turnBudgetSettings, mergeTurnBudgets, type Budget } from './budget.ts';
import { en, fill } from './i18n.ts';
import { decayPolicy, type PickNote } from './memory-rank.ts';
import { localDate, memorySettings } from './memory-worker.ts';
import { selectMemories } from './memory.ts';
import { type RecallMode, recallMode } from './triggers.ts';
import { isCloudModelName } from './model-names.ts';
import { branchesDir, discardCopy, rebuildStep, replayRun, ReplayError, type BranchEvent, type ReplayOutcome } from './replay.ts';
import { finalAnswer } from './run-diff.ts';
import type { RunView } from './runs.ts';
import { mergeSandboxGate, runInSandbox, SANDBOX_GATE_MODES, SandboxGate, sandboxGateSettings, type SandboxGateMode } from './sandbox-run.ts';
import { detectTests } from './security/fix.ts';
import { askModel, jsonIn, walkFiles } from './security/pass.ts';
import { checkFile } from './security/rules.ts';
import { analyze } from './security/threat-graph.ts';
import { insecureDefaults } from './redteam-probes.ts';
import type { Conversation } from './store.ts';
import { ApprovalBroker } from './tools/registry.ts';
import { workspaceDir } from './tools/workspace.ts';

// ------------------------------------------------------------------------------------------------
// Choices and defaults
// ------------------------------------------------------------------------------------------------

export type EvalKind = 'coding' | 'everyday' | 'both';
export const EVAL_KINDS: readonly EvalKind[] = ['coding', 'everyday', 'both'];
export const TASK_COUNTS = [5, 10, 20, 30, 50] as const;
export const DEFAULT_TASKS = 20;
export const MAX_TASKS = 50;
export const MAX_VARIANTS = 3;
export const CONCURRENCY_CHOICES = [1, 2] as const;
export const DEFAULT_CONCURRENCY = 2;
export type MemoryPreset = 'never' | 'slow' | 'normal' | 'custom';
export const MEMORY_PRESETS: readonly MemoryPreset[] = ['never', 'slow', 'normal', 'custom'];
export const HALF_LIFE_CHOICES = [30, 60, 90, 180, 365, 730] as const;
export type BudgetPreset = 'tight' | 'roomy';
export const BUDGET_PRESETS: Record<BudgetPreset, Budget> = { tight: { tokens: 50_000, steps: 10 }, roomy: { tokens: 500_000, steps: 80 } };
/** Ceiling choices offered next to the estimate (tokens). */
export const CEILING_CHOICES = [50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000, 5_000_000] as const;
export const SCHEDULE_BUDGETS = [50_000, 100_000, 200_000, 500_000] as const;
/** Re-check monthly: OFF by default; switching it on is the owner's explicit yes (a confirm in the UI). */
export interface EvalSchedule {
  monthly: boolean;
  budgetTokens: number;
  lastRunAt?: string;
}
export const DEFAULT_SCHEDULE: EvalSchedule = { monthly: false, budgetTokens: 200_000 };
/** How the score is made (shown on the result card). Parts a task has no data for are left out and the rest scaled up. */
export const WEIGHTS = { tests: 0.35, done: 0.1, feedback: 0.1, judge: 0.15, findings: 0.1, tokens: 0.06, steps: 0.05, time: 0.04, cost: 0.05 } as const;
export type Part = keyof typeof WEIGHTS;
export const ALPHA = 0.05;
/** A task counts as a tie when the two scores are closer than this. */
export const TIE_EPSILON = 0.01;
const MIN_RUN_TOKENS = 3000;
const IDLE_MS = 20 * 60_000;
const MONTH_MS = 30 * 86_400_000;

export function evalSchedule(s: { evalSchedule?: Partial<EvalSchedule> } | undefined): EvalSchedule {
  const v = s?.evalSchedule ?? {};
  const budgetTokens = (SCHEDULE_BUDGETS as readonly number[]).includes(Number(v.budgetTokens)) ? Number(v.budgetTokens) : DEFAULT_SCHEDULE.budgetTokens;
  return { monthly: v.monthly === true, budgetTokens, ...(typeof v.lastRunAt === 'string' ? { lastRunAt: v.lastRunAt } : {}) };
}

// ------------------------------------------------------------------------------------------------
// Shapes
// ------------------------------------------------------------------------------------------------

export interface VariantSpec {
  /** 'control' or 'v1' … 'v3'. */
  id: string;
  memory?: { preset: MemoryPreset; halfLifeDays?: number };
  model?: { providerId: string; model: string };
  sandbox?: SandboxGateMode;
  budget?: BudgetPreset;
  /** Phase 85 (M10): recall on her own forced on or off for this variant (the triggers on/off measurement). */
  recall?: 'on' | 'off';
  /** Phase 97 (ST2, §5.6): this skill's body loaded up front for the task (the skill check's "with skill X"). */
  skill?: { scope: string; name: string };
}

export type FeedbackKind = 'accepted' | 'corrected' | 'replaced' | 'reported' | 'none';
export interface Feedback {
  kind: FeedbackKind;
  /** The owner's own words (the next message), when that is the signal. */
  quote?: string;
}

export interface EvalTask {
  idx: number;
  runId: number;
  conversationId: string;
  title: string;
  coding: boolean;
  private: boolean;
  workspace: string;
  userMessageId: number;
  /** The owner's message (clipped). */
  ask: string;
  /** The original answer (clipped; the feedback signal compares with it). */
  answer: string;
  tokens: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  steps: number;
  ms: number;
  model: string;
  at: string;
  feedback: Feedback;
  /** The project's test command when it has one (run in a sandbox copy after each variant). */
  tests: string | null;
}

export interface TestResult {
  command: string;
  ran: boolean;
  exitCode: number | null;
  passed?: number;
  failed?: number;
  ms: number;
  isolated: boolean;
  output: string;
  note?: string;
}

export interface EvalRunRow {
  evalId: number;
  task: number;
  variant: string;
  runId: number | null;
  status: string;
  tokens: number;
  usd: number;
  steps: number;
  ms: number;
  answer: string;
  files: { path: string; change: string }[];
  tests: TestResult | null;
  findings: number;
  findingList: { file: string; line: number; rule: string; quote: string }[];
  denied: number;
  note?: string;
}

export interface JudgeVote {
  /** From the variant's side: it won, lost, or no clear preference. */
  outcome: 'win' | 'loss' | 'tie';
  votes: { order: 'control-first' | 'variant-first'; pick: 'A' | 'B' | 'tie' | null; valid: boolean; quote?: string; why?: string; dropped?: string }[];
  model?: string;
  note?: string;
}

export type EvalStatus = 'draft' | 'running' | 'judging' | 'done' | 'stopped' | 'ceiling' | 'error' | 'interrupted';

export interface Estimate {
  tasks: number;
  runs: number;
  tokens: number;
  /** null: a paid model has no price. */
  usd: number | null;
  paid: boolean;
  minutes: number;
  judgeTokens: number;
  perVariant: { id: string; model: string; tokens: number; usd: number | null; local: boolean }[];
}

export interface Ceiling {
  tokens: number;
  usd?: number;
}

export interface Said {
  key: string;
  params?: Record<string, string | number>;
  text: string;
}
const said = (key: string, params?: Record<string, string | number>): Said => ({ key, ...(params ? { params } : {}), text: params ? fill(key, params) : key });

export interface VariantResult {
  id: string;
  pairs: number;
  mean: number;
  controlMean: number;
  /** (variant − control) / control, in percent. */
  pct: number;
  wins: number;
  ties: number;
  losses: number;
  p: number;
  significant: boolean;
  verdict: 'better' | 'worse' | 'unclear';
}

export interface TaskResult {
  idx: number;
  title: string;
  control: { runId: number | null; score: number | null; parts: Partial<Record<Part, number>> };
  variants: Record<string, { runId: number | null; score: number | null; parts: Partial<Record<Part, number>>; delta: number | null; outcome: 'win' | 'loss' | 'tie' | 'missing'; judge?: JudgeVote }>;
}

export interface EvalResult {
  weights: typeof WEIGHTS;
  alpha: number;
  variants: VariantResult[];
  winner: string | null;
  headline: Said;
  tasks: TaskResult[];
}

export interface EvalView {
  id: number;
  title: string;
  kind: EvalKind;
  status: EvalStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  tasks: EvalTask[];
  skipped: Record<string, number>;
  variants: VariantSpec[];
  options: { judge: boolean; concurrency: number; scheduled?: boolean };
  estimate: Estimate;
  ceiling: Ceiling;
  progress: { done: number; total: number; tokens: number; usd: number; running: number; ceilingHit?: boolean; note?: string };
  result: EvalResult | null;
  applied: { variant: string; at: string; historyId?: number; kept?: boolean } | null;
  fromEval: number | null;
}

type Row = Record<string, string | number | null | Uint8Array>;
const j = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ------------------------------------------------------------------------------------------------
// The tables (each companion's sara.db; migrations only add)
// ------------------------------------------------------------------------------------------------

export class EvalStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS evals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      tasks TEXT NOT NULL,
      skipped TEXT,
      variants TEXT NOT NULL,
      options TEXT,
      estimate TEXT,
      ceiling TEXT,
      progress TEXT,
      result TEXT,
      applied TEXT,
      from_eval INTEGER
    );
    CREATE TABLE IF NOT EXISTS eval_runs (
      eval_id INTEGER NOT NULL REFERENCES evals(id) ON DELETE CASCADE,
      task INTEGER NOT NULL,
      variant TEXT NOT NULL,
      run_id INTEGER,
      status TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      usd REAL NOT NULL DEFAULT 0,
      steps INTEGER NOT NULL DEFAULT 0,
      ms INTEGER NOT NULL DEFAULT 0,
      answer TEXT,
      files TEXT,
      tests TEXT,
      findings INTEGER NOT NULL DEFAULT 0,
      finding_list TEXT,
      denied INTEGER NOT NULL DEFAULT 0,
      judge TEXT,
      note TEXT,
      PRIMARY KEY (eval_id, task, variant)
    );
    CREATE INDEX IF NOT EXISTS eval_runs_run ON eval_runs(run_id);
    CREATE TABLE IF NOT EXISTS settings_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      source TEXT NOT NULL,
      ref INTEGER,
      what TEXT NOT NULL,
      changes TEXT NOT NULL
    );`);
    try {
      db.prepare("UPDATE evals SET status = 'interrupted', ended_at = COALESCE(ended_at, ?) WHERE status IN ('running', 'judging')").run(now().toISOString());
    } catch {
      /* read-only copy */
    }
  }

  create(e: { title: string; kind: EvalKind; tasks: EvalTask[]; skipped: Record<string, number>; variants: VariantSpec[]; options: EvalView['options']; estimate: Estimate; ceiling: Ceiling; fromEval?: number | null }): number {
    const r = this.#db
      .prepare('INSERT INTO evals (title, kind, status, created_at, tasks, skipped, variants, options, estimate, ceiling, progress, from_eval) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.title, e.kind, 'draft', this.#now().toISOString(), j(e.tasks), j(e.skipped), j(e.variants), j(e.options), j(e.estimate), j(e.ceiling), j({ done: 0, total: e.tasks.length * e.variants.length, tokens: 0, usd: 0, running: 0 }), e.fromEval ?? null);
    return Number(r.lastInsertRowid);
  }

  #view(r: Row): EvalView {
    return {
      id: Number(r.id),
      title: String(r.title),
      kind: String(r.kind) as EvalKind,
      status: String(r.status) as EvalStatus,
      createdAt: String(r.created_at),
      startedAt: r.started_at ? String(r.started_at) : null,
      endedAt: r.ended_at ? String(r.ended_at) : null,
      tasks: parse(r.tasks, [] as EvalTask[]),
      skipped: parse(r.skipped, {} as Record<string, number>),
      variants: parse(r.variants, [] as VariantSpec[]),
      options: parse(r.options, { judge: false, concurrency: DEFAULT_CONCURRENCY }),
      estimate: parse(r.estimate, { tasks: 0, runs: 0, tokens: 0, usd: 0, paid: false, minutes: 0, judgeTokens: 0, perVariant: [] } as Estimate),
      ceiling: parse(r.ceiling, { tokens: 0 } as Ceiling),
      progress: parse(r.progress, { done: 0, total: 0, tokens: 0, usd: 0, running: 0 }),
      result: parse(r.result, null as EvalResult | null),
      applied: parse(r.applied, null as EvalView['applied']),
      fromEval: r.from_eval === null || r.from_eval === undefined ? null : Number(r.from_eval),
    };
  }

  get(id: number): EvalView | undefined {
    const r = this.#db.prepare('SELECT * FROM evals WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#view(r) : undefined;
  }

  list(limit = 50): EvalView[] {
    return (this.#db.prepare('SELECT * FROM evals ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(200, limit))) as Row[]).map((r) => this.#view(r));
  }

  patch(id: number, p: { status?: EvalStatus; startedAt?: string; endedAt?: string; progress?: EvalView['progress']; result?: EvalResult | null; applied?: EvalView['applied']; ceiling?: Ceiling; options?: EvalView['options'] }): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const put = (col: string, v: string | number | null) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (p.status) put('status', p.status);
    if (p.startedAt) put('started_at', p.startedAt);
    if (p.endedAt) put('ended_at', p.endedAt);
    if (p.progress) put('progress', j(p.progress));
    if (p.result !== undefined) put('result', j(p.result));
    if (p.applied !== undefined) put('applied', j(p.applied));
    if (p.ceiling) put('ceiling', j(p.ceiling));
    if (p.options) put('options', j(p.options));
    if (!sets.length) return;
    this.#db.prepare(`UPDATE evals SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  delete(id: number): boolean {
    return Number(this.#db.prepare("DELETE FROM evals WHERE id = ? AND status NOT IN ('running', 'judging')").run(id).changes) > 0;
  }

  putRun(r: EvalRunRow): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO eval_runs (eval_id, task, variant, run_id, status, tokens, usd, steps, ms, answer, files, tests, findings, finding_list, denied, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.evalId, r.task, r.variant, r.runId, r.status, r.tokens, r.usd, r.steps, r.ms, r.answer, j(r.files), j(r.tests), r.findings, j(r.findingList), r.denied, r.note ?? null);
  }

  putJudge(evalId: number, task: number, variant: string, vote: JudgeVote): void {
    this.#db.prepare('UPDATE eval_runs SET judge = ? WHERE eval_id = ? AND task = ? AND variant = ?').run(j(vote), evalId, task, variant);
  }

  runs(evalId: number): (EvalRunRow & { judge: JudgeVote | null })[] {
    return (this.#db.prepare('SELECT * FROM eval_runs WHERE eval_id = ? ORDER BY task, variant').all(evalId) as Row[]).map((r) => ({
      evalId: Number(r.eval_id),
      task: Number(r.task),
      variant: String(r.variant),
      runId: r.run_id === null ? null : Number(r.run_id),
      status: String(r.status),
      tokens: Number(r.tokens),
      usd: Number(r.usd),
      steps: Number(r.steps),
      ms: Number(r.ms),
      answer: String(r.answer ?? ''),
      files: parse(r.files, [] as EvalRunRow['files']),
      tests: parse(r.tests, null as TestResult | null),
      findings: Number(r.findings),
      findingList: parse(r.finding_list, [] as EvalRunRow['findingList']),
      denied: Number(r.denied),
      ...(r.note ? { note: String(r.note) } : {}),
      judge: parse(r.judge, null as JudgeVote | null),
    }));
  }

  /** The settings history (DECISIONS-like audit of what an eval changed). */
  addHistory(h: { source: string; ref: number | null; what: string; changes: { key: string; before: unknown; after: unknown }[] }): number {
    return Number(this.#db.prepare('INSERT INTO settings_history (at, source, ref, what, changes) VALUES (?, ?, ?, ?, ?)').run(this.#now().toISOString(), h.source, h.ref, h.what, j(h.changes)).lastInsertRowid);
  }

  history(limit = 50): { id: number; at: string; source: string; ref: number | null; what: string; changes: { key: string; before: unknown; after: unknown }[] }[] {
    return (this.#db.prepare('SELECT * FROM settings_history ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map((r) => ({ id: Number(r.id), at: String(r.at), source: String(r.source), ref: r.ref === null ? null : Number(r.ref), what: String(r.what), changes: parse(r.changes, []) }));
  }
}

// ------------------------------------------------------------------------------------------------
// Task picking
// ------------------------------------------------------------------------------------------------

export const CORRECTION = /^\s*(no\b|nope|nah\b|that'?s (wrong|not (it|right|what))|this is wrong|wrong\b|not what i|doesn'?t work|didn'?t work|it (still )?(fails|failed|breaks|broke|crashes)|still (fails|failing|broken|wrong|not)|you broke|undo|revert|that broke|tests? (still )?fail)/i;
const ACCEPT = /^\s*(thanks|thank you|thx|perfect|great\b|works\b|it works|that works|that worked|nice\b|awesome|looks good|lgtm|ok,? (great|good|thanks)|ship it|exactly|cool,? thanks|yes,? (that|this) (works|is it))/i;

/** What the owner did after the original reply: the strongest recorded signal. */
export function feedbackOf(app: AppContext, run: RunView): Feedback {
  const conv = run.conversationId;
  if (!conv || !run.replyMessageId) return { kind: 'none' };
  try {
    if (app.reports?.list().some((r) => r.messageId === run.replyMessageId)) return { kind: 'reported' };
  } catch {
    /* no reports here */
  }
  const after = app.store.messages(conv).filter((m) => m.id > run.replyMessageId!);
  if (after.some((m) => m.role === 'assistant' && (m.meta?.rerun as { fromRun?: number } | undefined)?.fromRun === run.id)) return { kind: 'replaced' };
  const next = after.find((m) => m.role === 'user');
  if (!next) return { kind: 'none' };
  // Only the owner's next message (before her next reply), and only a clear start.
  const text = next.content.trim();
  if (CORRECTION.test(text)) return { kind: 'corrected', quote: clip(text.replace(/\s+/g, ' '), 160) };
  if (ACCEPT.test(text)) return { kind: 'accepted', quote: clip(text.replace(/\s+/g, ' '), 160) };
  return { kind: 'none' };
}

/** Is a model on this computer (a private conversation may only use those)? */
export function isLocalModel(app: AppContext, m: { providerId: string; model: string }): boolean {
  const p = app.settings.get().providers.find((x) => x.id === m.providerId);
  return Boolean(p?.local) && !isCloudModelName(m.model);
}

/** The model a conversation would use now (the control). */
export function currentModel(app: AppContext, conv: Conversation): { providerId: string; model: string } | undefined {
  try {
    const c = resolveChain(app, conv, 'turn')[0];
    return c ? { providerId: c.provider.config.id, model: c.model } : undefined;
  } catch {
    return undefined;
  }
}

export interface Picked {
  tasks: EvalTask[];
  skipped: Record<string, number>;
}

/**
 * The last `count` eligible turns, newest first, frozen as tasks. Reasons for leaving a turn out
 * are counted (shown with the estimate).
 */
export function pickTasks(app: AppContext, opts: { kind: EvalKind; count: number; variants: VariantSpec[]; judge: boolean }): Picked {
  const runs = app.runs;
  if (!runs) throw new ReplayError(404, en('Run history is not available here.'));
  const count = Math.max(1, Math.min(MAX_TASKS, Math.round(opts.count) || DEFAULT_TASKS));
  const allLocalVariants = opts.variants.every((v) => !v.model || isLocalModel(app, v.model));
  const skipped: Record<string, number> = {};
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };
  const tasks: EvalTask[] = [];
  const seen = new Set<number>();
  let before: number | undefined;
  for (let page = 0; page < 20 && tasks.length < count; page++) {
    const list = runs.list({ limit: 200, ...(before ? { before } : {}) });
    if (!list.length) break;
    before = list.at(-1)!.id;
    for (const run of list) {
      if (tasks.length >= count) break;
      if (run.kind !== 'turn' || !run.conversationId) continue;
      if (run.parentRunId) continue; // branches and earlier eval runs
      if (run.status !== 'ok' && run.status !== 'budget') {
        skip('unfinished');
        continue;
      }
      if (!run.userMessageId || !run.replyMessageId || seen.has(run.userMessageId)) {
        skip('no reply');
        continue;
      }
      const conv = app.store.getConversation(run.conversationId);
      if (!conv) continue;
      const coding = conv.mode === 'coding';
      if ((opts.kind === 'coding' && !coding) || (opts.kind === 'everyday' && coding)) continue;
      const r = taskOfRun(app, run, { allLocalVariants, judge: opts.judge, seen, idx: tasks.length });
      if (typeof r === 'string') skip(r);
      else tasks.push(r);
    }
  }
  return { tasks, skipped };
}

/** One recorded run as a frozen task, or why it can't be one. */
function taskOfRun(app: AppContext, run: RunView, o: { allLocalVariants: boolean; judge: boolean; seen: Set<number>; idx: number }): EvalTask | string {
  const runs = app.runs!;
  if (run.status !== 'ok' && run.status !== 'budget') return 'unfinished';
  if (!run.userMessageId || !run.replyMessageId || o.seen.has(run.userMessageId)) return 'no reply';
  const conv = run.conversationId ? app.store.getConversation(run.conversationId) : undefined;
  if (!conv) return 'cannot rebuild';
  const coding = conv.mode === 'coding';
  if (conv.partner) return 'someone else';
  if (conv.private) {
    const ctl = currentModel(app, conv);
    if (!o.allLocalVariants || !ctl || !isLocalModel(app, ctl)) return 'private';
  }
  let rebuilt;
  try {
    rebuilt = rebuildStep(app, run.id, 0);
  } catch {
    return 'cannot rebuild';
  }
  if (!rebuilt.userMessage) return 'cannot rebuild';
  const feedback = feedbackOf(app, run);
  let tests: string | null = null;
  if (coding) {
    try {
      tests = detectTests(workspaceDir(app.rootDir ?? app.dataDir, conv.workspace)) ?? null;
    } catch {
      tests = null;
    }
  }
  if (!tests && feedback.kind === 'none' && !o.judge) return 'nothing to grade';
  o.seen.add(run.userMessageId);
  return {
    idx: o.idx,
    runId: run.id,
    conversationId: conv.id,
    title: clip(run.title || rebuilt.userMessage.content.replace(/\s+/g, ' ').trim(), 120),
    coding,
    private: conv.private,
    workspace: conv.workspace,
    userMessageId: run.userMessageId,
    ask: clip(rebuilt.userMessage.content, 2000),
    answer: clip(finalAnswer(run, app.store, (id) => runs.runMessages(id)), 4000),
    tokens: run.tokensIn + run.tokensOut,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    usd: run.usd,
    steps: run.steps,
    ms: run.ms,
    model: String(run.policy?.model ?? rebuilt.model.model ?? ''),
    at: run.startedAt,
    feedback,
    tests,
  };
}

/**
 * Phase 97 (ST2, §5.6): the given runs as frozen tasks (a skill check's own examples and similar
 * past tasks), in order, at most `max`; the reasons for leaving one out are counted.
 */
export function tasksFromRuns(app: AppContext, runIds: number[], opts: { variants: VariantSpec[]; judge: boolean; max?: number }): Picked {
  const runs = app.runs;
  if (!runs) throw new ReplayError(404, en('Run history is not available here.'));
  const allLocalVariants = opts.variants.every((v) => !v.model || isLocalModel(app, v.model));
  const skipped: Record<string, number> = {};
  const tasks: EvalTask[] = [];
  const seen = new Set<number>();
  for (const id of [...new Set(runIds)]) {
    if (tasks.length >= (opts.max ?? 5)) break;
    const run = runs.get(id);
    if (!run || run.kind !== 'turn' || run.parentRunId) {
      skipped['cannot rebuild'] = (skipped['cannot rebuild'] ?? 0) + 1;
      continue;
    }
    const r = taskOfRun(app, run, { allLocalVariants, judge: opts.judge, seen, idx: tasks.length });
    if (typeof r === 'string') skipped[r] = (skipped[r] ?? 0) + 1;
    else tasks.push(r);
  }
  return { tasks, skipped };
}

// ------------------------------------------------------------------------------------------------
// Variants
// ------------------------------------------------------------------------------------------------

/** A variant from the request body, checked against the pick-lists (undefined fields = as now). */
export function cleanVariant(app: AppContext, raw: unknown, id: string): VariantSpec {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: VariantSpec = { id };
  const mem = v.memory && typeof v.memory === 'object' ? (v.memory as Record<string, unknown>) : undefined;
  if (mem && MEMORY_PRESETS.includes(mem.preset as MemoryPreset)) {
    out.memory = { preset: mem.preset as MemoryPreset };
    if (mem.preset === 'custom') out.memory.halfLifeDays = (HALF_LIFE_CHOICES as readonly number[]).includes(Number(mem.halfLifeDays)) ? Number(mem.halfLifeDays) : 90;
  }
  const model = v.model && typeof v.model === 'object' ? (v.model as Record<string, unknown>) : undefined;
  if (model && typeof model.providerId === 'string' && typeof model.model === 'string' && model.model.trim()) {
    if (!app.settings.get().providers.some((p) => p.id === model.providerId)) throw new ReplayError(400, en("That model's provider isn't set up: pick another model."));
    out.model = { providerId: model.providerId, model: model.model.trim().slice(0, 200) };
  }
  if (SANDBOX_GATE_MODES.includes(v.sandbox as SandboxGateMode)) out.sandbox = v.sandbox as SandboxGateMode;
  if (v.budget === 'tight' || v.budget === 'roomy') out.budget = v.budget;
  if (v.recall === 'on' || v.recall === 'off') out.recall = v.recall;
  return out;
}

const changes = (v: VariantSpec) => Boolean(v.memory || v.model || v.sandbox || v.budget || v.recall || v.skill);

/** The variant in words (English; the page words it itself from the fields). */
export function variantWords(v: VariantSpec): string {
  if (v.id === 'control') return 'Your settings now';
  const bits: string[] = [];
  if (v.memory) bits.push(v.memory.preset === 'custom' ? `fading: half-life ${v.memory.halfLifeDays} days` : `fading: ${v.memory.preset}`);
  if (v.model) bits.push(`model: ${v.model.model}`);
  if (v.sandbox) bits.push(`sandbox tries: ${v.sandbox}`);
  if (v.budget) bits.push(`budget: ${v.budget}`);
  if (v.recall) bits.push(`recall on her own: ${v.recall}`);
  if (v.skill) bits.push(`with the skill ${v.skill.name}`);
  return bits.join(' · ');
}

/** The memory notes a policy would pick for the task's message (an edit of the recorded picks). */
function memoryEdit(app: AppContext, task: EvalTask, v: VariantSpec, recorded: PickNote[]): { include: number[]; exclude: number[] } | undefined {
  if (!v.memory || !app.memory) return undefined;
  const cfg = memorySettings(app);
  const policy = decayPolicy({ ...cfg, fade: v.memory.preset, decay: { ...(cfg.decay ?? {}), ...(v.memory.halfLifeDays ? { halfLifeDays: v.memory.halfLifeDays } : {}) } });
  const s = app.settings.get();
  const inj = selectMemories(app.memory, { userText: task.ask, conversationId: task.conversationId, oldestHistoryId: 0, budgetChars: cfg.injectBudgetChars, policy, today: localDate(app.now().toISOString(), s.timeZone) });
  const had = new Set(recorded.map((p) => p.id));
  const now = new Set(inj.ids);
  return { include: inj.ids.filter((id) => !had.has(id)), exclude: [...had].filter((id) => !now.has(id)) };
}

/** Approvals during an eval: nobody is watching, so every one is answered No (counted). */
class DenyAll extends ApprovalBroker {
  denied = 0;
  override request(): { id: string; decision: Promise<boolean> } {
    this.denied++;
    return { id: randomUUID(), decision: Promise.resolve(false) };
  }
}

// ------------------------------------------------------------------------------------------------
// Grading helpers (pure)
// ------------------------------------------------------------------------------------------------

/** Two-sided exact sign test: the chance of a split at least this uneven if neither side is better. */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  // Sum of C(n, i) / 2^n for i ≤ k, in logs so 50 tasks don't overflow.
  let logC = 0;
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    sum += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, Math.round(2 * sum * 1e12) / 1e12);
}

const wordSet = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []).slice(0, 2000));
/** Word overlap of two answers (Jaccard, 0–1). */
export function similarity(a: string, b: string): number {
  const A = wordSet(a);
  const B = wordSet(b);
  if (!A.size && !B.size) return 1;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both || 1);
}

/** The share a run gets for a "lower is better" number against the other run of the pair. */
const rel = (x: number, other: number) => (x <= 0 ? 1 : Math.min(x, Math.max(0, other)) / x);

export interface ScoreInput {
  status: string;
  tokens: number;
  usd: number;
  steps: number;
  ms: number;
  answer: string;
  tests: TestResult | null;
  findings: number;
}

/** The two sides of one task's pair, part by part (0–1 each). */
export function pairParts(task: Pick<EvalTask, 'feedback' | 'answer'>, c: ScoreInput, v: ScoreInput, judge?: JudgeVote['outcome']): { control: Partial<Record<Part, number>>; variant: Partial<Record<Part, number>> } {
  const side = (x: ScoreInput, o: ScoreInput, jv?: number): Partial<Record<Part, number>> => {
    const p: Partial<Record<Part, number>> = {};
    if (x.tests?.ran && o.tests?.ran) p.tests = x.tests.passed !== undefined && x.tests.failed !== undefined && x.tests.passed + x.tests.failed > 0 ? x.tests.passed / (x.tests.passed + x.tests.failed) : x.tests.exitCode === 0 ? 1 : 0;
    p.done = x.status === 'ok' ? 1 : x.status === 'budget' ? 0.5 : 0;
    if (task.feedback.kind !== 'none' && task.answer) {
      const sim = similarity(x.answer, task.answer);
      p.feedback = task.feedback.kind === 'accepted' ? sim : 1 - sim;
    }
    if (jv !== undefined) p.judge = jv;
    p.findings = 1 / (1 + Math.max(0, x.findings));
    p.tokens = rel(x.tokens, o.tokens);
    p.steps = rel(x.steps, o.steps);
    p.time = rel(x.ms, o.ms);
    if (x.usd > 0 || o.usd > 0) p.cost = rel(x.usd, o.usd);
    return p;
  };
  const jv = judge === 'win' ? 1 : judge === 'loss' ? 0 : judge === 'tie' ? 0.5 : undefined;
  return { control: side(c, v, jv === undefined ? undefined : 1 - jv), variant: side(v, c, jv) };
}

/** The weighted score (0–1) over the parts present (their weights scaled to add up to 1). */
export function weighted(parts: Partial<Record<Part, number>>, weights: Record<Part, number> = WEIGHTS): number {
  let w = 0;
  let s = 0;
  for (const [k, v] of Object.entries(parts) as [Part, number][]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    w += weights[k];
    s += weights[k] * v;
  }
  return w > 0 ? s / w : 0;
}

const fmtP = (p: number) => (p < 0.001 ? '<0.001' : p < 0.01 ? p.toFixed(3) : p.toFixed(2));
const fmtPct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x))}%`;

/** Scores every pair, the sign test per variant, and the headline (no winner unless significant). */
export function scoreEval(ev: Pick<EvalView, 'tasks' | 'variants' | 'kind'>, rows: (EvalRunRow & { judge?: JudgeVote | null })[]): EvalResult {
  const others = ev.variants.filter((v) => v.id !== 'control');
  const alpha = ALPHA / Math.max(1, others.length);
  const at = (task: number, variant: string) => rows.find((r) => r.task === task && r.variant === variant);
  const usable = (r?: EvalRunRow) => Boolean(r && r.runId && r.status !== 'error' && r.status !== 'stopped' && r.status !== 'skipped');
  const tasks: TaskResult[] = ev.tasks.map((t) => {
    const c = at(t.idx, 'control');
    const out: TaskResult = { idx: t.idx, title: t.title, control: { runId: c?.runId ?? null, score: null, parts: {} }, variants: {} };
    for (const v of others) {
      const r = at(t.idx, v.id);
      if (!usable(c) || !usable(r)) {
        out.variants[v.id] = { runId: r?.runId ?? null, score: null, parts: {}, delta: null, outcome: 'missing' };
        continue;
      }
      const parts = pairParts(t, c!, r!, r!.judge?.outcome);
      const sv = weighted(parts.variant);
      const sc = weighted(parts.control);
      // The control's score is shown against the first variant (each pair has its own relative parts).
      if (out.control.score === null) out.control = { runId: c!.runId, score: sc, parts: parts.control };
      const delta = sv - sc;
      out.variants[v.id] = { runId: r!.runId, score: sv, parts: parts.variant, delta, outcome: Math.abs(delta) < TIE_EPSILON ? 'tie' : delta > 0 ? 'win' : 'loss', ...(r!.judge ? { judge: r!.judge } : {}) };
    }
    return out;
  });
  const variants: VariantResult[] = others.map((v) => {
    let wins = 0;
    let ties = 0;
    let losses = 0;
    let sumV = 0;
    let sumC = 0;
    let pairs = 0;
    for (const t of tasks) {
      const x = t.variants[v.id];
      if (!x || x.outcome === 'missing' || x.score === null || x.delta === null) continue;
      pairs++;
      sumV += x.score;
      sumC += x.score - x.delta;
      if (x.outcome === 'win') wins++;
      else if (x.outcome === 'loss') losses++;
      else ties++;
    }
    const mean = pairs ? sumV / pairs : 0;
    const controlMean = pairs ? sumC / pairs : 0;
    const p = signTest(wins, losses);
    const significant = pairs > 0 && wins + losses > 0 && p < alpha;
    return { id: v.id, pairs, mean, controlMean, pct: controlMean > 0 ? ((mean - controlMean) / controlMean) * 100 : 0, wins, ties, losses, p, significant, verdict: significant ? (wins > losses ? 'better' : 'worse') : 'unclear' };
  });
  const better = variants.filter((v) => v.verdict === 'better').sort((a, b) => b.pct - a.pct || a.p - b.p);
  const what = ev.kind === 'coding' ? 'coding tasks' : ev.kind === 'everyday' ? 'everyday chats' : 'tasks';
  let winner: string | null = null;
  let headline: Said;
  if (better.length) {
    const w = better[0];
    winner = w.id;
    headline = said(what === 'coding tasks' ? en('{pct} on {n} of your coding tasks (wins {w}, ties {t}, losses {l}; p={p})') : what === 'everyday chats' ? en('{pct} on {n} of your everyday chats (wins {w}, ties {t}, losses {l}; p={p})') : en('{pct} on {n} of your tasks (wins {w}, ties {t}, losses {l}; p={p})'), { pct: fmtPct(w.pct), n: w.pairs, w: w.wins, t: w.ties, l: w.losses, p: fmtP(w.p) });
  } else if (variants.length && variants.every((v) => v.verdict === 'worse')) {
    winner = 'control';
    const v = variants.sort((a, b) => b.p - a.p)[0];
    headline = said(en('Your settings now win on {n} tasks: no variant did better (closest: wins {w}, ties {t}, losses {l}; p={p}).'), { n: v.pairs, w: v.wins, t: v.ties, l: v.losses, p: fmtP(v.p) });
  } else {
    const v = [...variants].sort((a, b) => a.p - b.p)[0];
    headline = v && v.pairs ? said(en('No clear winner on {n} tasks (closest: {pct}, wins {w}, ties {t}, losses {l}; p={p}). Keep your settings, or try more tasks.'), { n: v.pairs, pct: fmtPct(v.pct), w: v.wins, t: v.ties, l: v.losses, p: fmtP(v.p) }) : said(en('No clear winner: no task finished in both runs.'));
  }
  return { weights: WEIGHTS, alpha, variants, winner, headline, tasks };
}

/** Pass/fail counts from a test runner's output (node --test, jest/vitest, pytest, go, cargo). */
export function testCounts(out: string): { passed?: number; failed?: number } {
  const num = (re: RegExp) => {
    const m = re.exec(out);
    return m ? Number(m[1]) : undefined;
  };
  const nodePass = num(/^ℹ pass (\d+)/m) ?? num(/^# pass (\d+)/m);
  const nodeFail = num(/^ℹ fail (\d+)/m) ?? num(/^# fail (\d+)/m);
  if (nodePass !== undefined || nodeFail !== undefined) return { passed: nodePass ?? 0, failed: nodeFail ?? 0 };
  const passed = num(/(\d+) passed/);
  const failed = num(/(\d+) failed/);
  if (passed !== undefined || failed !== undefined) return { passed: passed ?? 0, failed: failed ?? 0 };
  return {};
}

// ------------------------------------------------------------------------------------------------
// The runner
// ------------------------------------------------------------------------------------------------

const JUDGE_SYSTEM = `You compare two answers (A and B) an assistant gave to the same request, to say which one does the job better: correct, complete, follows the request, honest about what was done.
Answer ONLY JSON: {"better": "A" | "B" | "tie", "quote": "<exact words copied from the answer you picked that show why>", "why": "<one short sentence>"}.
The quote must be copied character for character from the answer you picked (at least 3 words). If neither is clearly better, answer "tie" with an empty quote.`;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** One judge answer checked: a pick must quote the picked answer verbatim (≥ 3 words), else it is dropped. */
export function checkVote(text: string, a: string, b: string): { pick: 'A' | 'B' | 'tie' | null; valid: boolean; quote?: string; why?: string; dropped?: string } {
  const j0 = jsonIn(text) as Record<string, unknown> | undefined;
  if (!j0 || typeof j0 !== 'object') return { pick: null, valid: false, dropped: 'no JSON' };
  const pick = String(j0.better ?? '').trim().toUpperCase();
  const why = clip(String(j0.why ?? ''), 240);
  const quote = String(j0.quote ?? '');
  if (pick === 'TIE') return { pick: 'tie', valid: true, why };
  if (pick !== 'A' && pick !== 'B') return { pick: null, valid: false, dropped: 'no pick' };
  const q = norm(quote);
  if (q.split(' ').filter(Boolean).length < 3) return { pick, valid: false, why, dropped: 'no quote' };
  if (!norm(pick === 'A' ? a : b).includes(q)) return { pick, valid: false, quote: clip(quote, 200), why, dropped: 'quote not in the answer' };
  return { pick, valid: true, quote: clip(quote, 200), why };
}

/** Two votes (positions swapped) into one outcome from the variant's side. */
export function judgeOutcome(first: ReturnType<typeof checkVote>, second: ReturnType<typeof checkVote>): JudgeVote['outcome'] {
  // First: A = control, B = variant. Second: A = variant, B = control.
  const v1 = !first.valid || first.pick === 'tie' ? 'tie' : first.pick === 'B' ? 'win' : 'loss';
  const v2 = !second.valid || second.pick === 'tie' ? 'tie' : second.pick === 'A' ? 'win' : 'loss';
  return v1 === v2 ? v1 : 'tie';
}

export interface CreateInput {
  kind?: unknown;
  count?: unknown;
  variants?: unknown;
  judge?: unknown;
  concurrency?: unknown;
  from?: unknown;
  title?: unknown;
}

interface Live {
  controller: AbortController;
  spentTokens: number;
  spentUsd: number;
  running: Map<number, number>;
  ceilingHit: boolean;
}

export class Evals {
  readonly store: EvalStore;
  readonly #app: AppContext;
  readonly #live = new Map<number, Live>();
  /** Tests (and the scheduler) wait on this. */
  work: Promise<void> | undefined;
  /** Injectable for tests: when the owner was last active (ms since epoch). */
  lastActivity: () => number;

  constructor(app: AppContext, store?: EvalStore) {
    this.#app = app;
    this.store = store ?? new EvalStore(app.store.db, app.now);
    this.lastActivity = () => {
      const r = app.store.db.prepare('SELECT MAX(created_at) AS t FROM messages').get() as { t: string | null } | undefined;
      return r?.t ? Date.parse(r.t) : 0;
    };
    // Runs an eval made are kept with it (retention never drops them while the eval exists).
    if (app.runs) app.runs.keepAlso = 'SELECT run_id FROM eval_runs WHERE run_id IS NOT NULL';
  }

  running(id: number): boolean {
    return this.#live.has(id);
  }

  /** The models an eval may pick (configured providers; local first). */
  models(): { providerId: string; model: string; label: string; local: boolean }[] {
    const s = this.#app.settings.get();
    const out: { providerId: string; model: string; label: string; local: boolean }[] = [];
    const add = (providerId?: string | null, model?: string | null) => {
      if (!providerId || !model) return;
      const p = s.providers.find((x) => x.id === providerId);
      if (!p || out.some((x) => x.providerId === providerId && x.model === model)) return;
      out.push({ providerId, model, label: `${model} · ${p.label}`, local: Boolean(p.local) && !isCloudModelName(model) });
    };
    add(s.defaultProviderId, s.defaultModel);
    for (const r of Object.values(s.routes ?? {})) if (r && typeof r === 'object' && 'providerId' in r) add(r.providerId, r.model);
    for (const p of s.providers) {
      add(p.id, p.defaultModel);
      for (const m of this.#app.modelCatalog?.view(p.id).models.slice(0, 200) ?? []) add(p.id, m);
    }
    return out.sort((a, b) => Number(b.local) - Number(a.local)).slice(0, 150);
  }

  /** Picks and freezes the tasks, checks the variants, and returns the estimate (status draft). */
  create(body: CreateInput): EvalView {
    const app = this.#app;
    const from = body.from !== undefined ? this.store.get(Number(body.from)) : undefined;
    if (body.from !== undefined && !from) throw new ReplayError(404, en('No such eval.'));
    const kind: EvalKind = from ? from.kind : EVAL_KINDS.includes(body.kind as EvalKind) ? (body.kind as EvalKind) : 'coding';
    const judge = from ? from.options.judge : body.judge === true;
    const concurrency = (CONCURRENCY_CHOICES as readonly number[]).includes(Number(body.concurrency)) ? Number(body.concurrency) : from ? from.options.concurrency : DEFAULT_CONCURRENCY;
    let variants: VariantSpec[];
    if (from) variants = from.variants;
    else {
      const raw = Array.isArray(body.variants) ? body.variants.slice(0, MAX_VARIANTS) : [];
      variants = [{ id: 'control' }, ...raw.map((v, i) => cleanVariant(app, v, `v${i + 1}`))];
      if (variants.length < 2) throw new ReplayError(400, en('Add at least one variant to compare with your settings now.'));
      for (const v of variants.slice(1)) if (!changes(v)) throw new ReplayError(400, en('Each variant must change at least one thing.'));
    }
    let picked: Picked;
    if (from) {
      // A re-run compares the same frozen tasks (those whose runs still exist and rebuild).
      const tasks: EvalTask[] = [];
      const skipped: Record<string, number> = {};
      for (const t of from.tasks) {
        try {
          rebuildStep(app, t.runId, 0);
          tasks.push({ ...t, idx: tasks.length });
        } catch {
          skipped['cannot rebuild'] = (skipped['cannot rebuild'] ?? 0) + 1;
        }
      }
      picked = { tasks, skipped };
    } else picked = pickTasks(app, { kind, count: Number(body.count ?? DEFAULT_TASKS), variants, judge });
    if (!picked.tasks.length) throw new ReplayError(409, en('No eligible tasks yet: Sara needs finished replies with something to grade them by (tests, your reaction, or the judge).'));
    const estimate = this.estimate(picked.tasks, variants, judge, concurrency);
    const ceiling: Ceiling = { tokens: ceilingFor(estimate.tokens), ...(estimate.paid ? { usd: Math.max(0.01, Math.round((estimate.usd ?? 1) * 1.5 * 100) / 100) } : {}) };
    const title = typeof body.title === 'string' && body.title.trim() ? clip(body.title.trim(), 120) : from ? from.title : variants.slice(1).map(variantWords).join(' / ');
    const id = this.store.create({ title, kind, tasks: picked.tasks, skipped: picked.skipped, variants, options: { judge, concurrency }, estimate, ceiling, fromEval: from?.id ?? null });
    return this.store.get(id)!;
  }

  /**
   * Phase 97 (ST2, §5.6): a draft eval on tasks picked by the caller (the skill check), with the
   * variants as given (the control may carry the budget preset too). The ceiling is the estimate's
   * default, never more than `maxTokens`.
   */
  createWith(input: { title: string; kind: EvalKind; picked: Picked; variants: VariantSpec[]; judge: boolean; maxTokens?: number }): EvalView {
    if (!input.picked.tasks.length) throw new ReplayError(409, en('No eligible tasks yet: Sara needs finished replies with something to grade them by (tests, your reaction, or the judge).'));
    if (input.variants[0]?.id !== 'control' || input.variants.length < 2) throw new ReplayError(400, en('Add at least one variant to compare with your settings now.'));
    const concurrency = 1;
    const estimate = this.estimate(input.picked.tasks, input.variants, input.judge, concurrency);
    const tokens = Math.min(ceilingFor(estimate.tokens), input.maxTokens ?? Number.MAX_SAFE_INTEGER);
    const ceiling: Ceiling = { tokens: Math.max(1000, tokens), ...(estimate.paid ? { usd: Math.max(0.01, Math.round((estimate.usd ?? 1) * 1.5 * 100) / 100) } : {}) };
    const id = this.store.create({ title: clip(input.title, 120), kind: input.kind, tasks: input.picked.tasks, skipped: input.picked.skipped, variants: input.variants, options: { judge: input.judge, concurrency }, estimate, ceiling, fromEval: null });
    return this.store.get(id)!;
  }

  /** Tokens, $ and minutes up front: each task's original run, once per variant (+ the judge). */
  estimate(tasks: EvalTask[], variants: VariantSpec[], judge: boolean, concurrency: number): Estimate {
    const app = this.#app;
    const s = app.settings.get();
    const per = variants.map((v) => ({ id: v.id, model: '', tokens: 0, usd: 0 as number | null, local: true }));
    let ms = 0;
    for (const t of tasks) {
      const conv = app.store.getConversation(t.conversationId);
      const tin = t.tokensIn || (t.coding ? 18_000 : 3000);
      const tout = t.tokensOut || (t.coding ? 2000 : 400);
      variants.forEach((v, i) => {
        const m = v.model ?? (conv ? currentModel(app, conv) : undefined);
        const cfg = m ? s.providers.find((p) => p.id === m.providerId) : undefined;
        const local = m ? isLocalModel(app, m) : true;
        per[i].model = m?.model ?? per[i].model;
        per[i].local &&= local;
        per[i].tokens += tin + tout;
        if (!local && cfg && m && per[i].usd !== null) {
          const price = app.runs?.priceCall(cfg, m.model, { input: tin, output: tout });
          per[i].usd = price === null || price === undefined ? null : (per[i].usd as number) + price;
        }
      });
      ms += (t.ms || 60_000) * variants.length;
    }
    const judgeTokens = judge ? tasks.reduce((n, t) => n + 2 * (variants.length - 1) * Math.ceil((JUDGE_SYSTEM.length + t.ask.length + 2 * Math.max(400, t.answer.length)) / 3.5 + 300), 0) : 0;
    const tokens = per.reduce((n, p) => n + p.tokens, 0) + judgeTokens;
    const paid = per.some((p) => !p.local);
    const usd = per.some((p) => p.usd === null) ? null : Math.round(per.reduce((n, p) => n + (p.usd ?? 0), 0) * 10000) / 10000;
    return { tasks: tasks.length, runs: tasks.length * variants.length, tokens, usd, paid, minutes: Math.max(1, Math.round(ms / Math.max(1, concurrency) / 60_000)), judgeTokens, perVariant: per };
  }

  /** Starts a draft eval (the owner confirmed the estimate and the ceiling). */
  start(id: number, opts: { ceiling?: Partial<Ceiling> } = {}): EvalView {
    const ev = this.store.get(id);
    if (!ev) throw new ReplayError(404, en('No such eval.'));
    if (ev.status !== 'draft') throw new ReplayError(409, en('This eval has already run. Run it again to compare the same tasks.'));
    if (this.#live.size) throw new ReplayError(409, en('Another eval is running. Wait for it or stop it.'));
    const ceiling: Ceiling = { ...ev.ceiling };
    if (opts.ceiling?.tokens !== undefined) {
      const t = Math.round(Number(opts.ceiling.tokens));
      if (!Number.isFinite(t) || t < 1000 || t > 50_000_000) throw new ReplayError(400, en('The ceiling must be between 1,000 and 50,000,000 tokens.'));
      ceiling.tokens = t;
    }
    if (opts.ceiling?.usd !== undefined) {
      const u = Number(opts.ceiling.usd);
      if (!Number.isFinite(u) || u < 0 || u > 1000) throw new ReplayError(400, en('The $ ceiling must be between 0 and 1,000.'));
      ceiling.usd = u;
    }
    const live: Live = { controller: new AbortController(), spentTokens: 0, spentUsd: 0, running: new Map(), ceilingHit: false };
    this.#live.set(id, live);
    this.store.patch(id, { status: 'running', startedAt: this.#app.now().toISOString(), ceiling });
    this.work = this.#run(id, live).finally(() => this.#live.delete(id));
    return this.store.get(id)!;
  }

  stop(id: number): boolean {
    const live = this.#live.get(id);
    if (!live) return false;
    live.controller.abort(new Error('stopped'));
    return true;
  }

  #publish(id: number): void {
    const ev = this.store.get(id);
    if (ev) this.#app.events?.publish({ type: 'eval', id, status: ev.status, progress: ev.progress });
  }

  #progress(id: number, live: Live, done: number, total: number, note?: string): void {
    this.store.patch(id, { progress: { done, total, tokens: live.spentTokens, usd: Math.round(live.spentUsd * 10000) / 10000, running: live.running.size, ...(live.ceilingHit ? { ceilingHit: true } : {}), ...(note ? { note } : {}) } });
    this.#publish(id);
  }

  /** Tokens spent so far: finished runs plus the steps of the running ones. */
  #liveSpent(live: Live): { tokens: number; usd: number } {
    let tokens = live.spentTokens;
    let usd = live.spentUsd;
    for (const runId of live.running.values()) {
      if (!runId) continue;
      for (const s of this.#app.runs?.steps(runId) ?? []) {
        tokens += s.tokensIn + s.tokensOut;
        usd += s.usd;
      }
    }
    return { tokens, usd };
  }

  async #run(id: number, live: Live): Promise<void> {
    const app = this.#app;
    const ev = this.store.get(id)!;
    const signal = live.controller.signal;
    // Interleaved by task (control first), so a stop or the ceiling leaves whole pairs.
    const queue: { task: EvalTask; v: VariantSpec }[] = [];
    for (const t of ev.tasks) for (const v of ev.variants) queue.push({ task: t, v });
    const total = queue.length;
    let done = 0;
    let status: EvalStatus = 'done';
    const active = new Set<Promise<void>>();
    let slot = 0;
    try {
      while ((queue.length || active.size) && !signal.aborted) {
        while (queue.length && active.size < ev.options.concurrency && !signal.aborted) {
          const spent = this.#liveSpent(live);
          const remaining = ev.ceiling.tokens - spent.tokens;
          const reserved = [...live.running.keys()].length * MIN_RUN_TOKENS;
          if (remaining - reserved < MIN_RUN_TOKENS || (ev.ceiling.usd !== undefined && ev.ceiling.usd > 0 && spent.usd >= ev.ceiling.usd)) {
            if (!active.size) live.ceilingHit = true;
            break;
          }
          const job = queue.shift()!;
          const key = ++slot;
          live.running.set(key, 0);
          const p: Promise<void> = this.#job(ev, job.task, job.v, live, key, remaining - reserved)
            .then((row) => {
              this.store.putRun(row);
              live.spentTokens += row.tokens;
              live.spentUsd += row.usd;
            })
            .catch((err) => {
              this.store.putRun({ evalId: id, task: job.task.idx, variant: job.v.id, runId: null, status: 'error', tokens: 0, usd: 0, steps: 0, ms: 0, answer: '', files: [], tests: null, findings: 0, findingList: [], denied: 0, note: clip((err as Error).message, 300) });
            })
            .finally(() => {
              live.running.delete(key);
              active.delete(p);
              done++;
              this.#progress(id, live, done, total);
            });
          active.add(p);
          this.#progress(id, live, done, total);
        }
        if (live.ceilingHit && !active.size) break;
        if (active.size) await Promise.race(active);
        else if (queue.length) {
          // Out of room for the next run while nothing is running: that is the ceiling.
          live.ceilingHit = true;
          break;
        }
      }
      await Promise.allSettled([...active]);
      if (signal.aborted) status = 'stopped';
      else if (live.ceilingHit) status = 'ceiling';
      // The judge (optional): after the runs, one pair at a time, inside the same ceiling.
      if (ev.options.judge && !signal.aborted) {
        this.store.patch(id, { status: 'judging' });
        this.#publish(id);
        await this.#judgeAll(ev, live, signal);
        if (live.ceilingHit && status === 'done') status = 'ceiling';
      }
    } catch (err) {
      status = 'error';
      this.#progress(id, live, done, total, clip((err as Error).message, 300));
    }
    const rows = this.store.runs(id);
    const result = scoreEval(ev, rows);
    this.store.patch(id, { status: signal.aborted ? 'stopped' : status, endedAt: app.now().toISOString(), result });
    this.#progress(id, live, done, total);
  }

  /** The app the replay runs on for one variant: approvals answered No, its sandbox gate mode. */
  #appFor(v: VariantSpec, deny: DenyAll): AppContext {
    const app = this.#app;
    const over: Partial<AppContext> = { approvals: deny };
    if (v.sandbox && app.sandboxGate) {
      const real = app.sandboxGate;
      over.sandboxGate = new SandboxGate(real.cacheDir, app.sandbox, () => ({ ...real.settings(), mode: v.sandbox! }), () => real.isolation());
    }
    return new Proxy(app, { get: (t, k: string) => (k in over ? over[k as keyof AppContext] : t[k as keyof AppContext]) }) as AppContext;
  }

  async #job(ev: EvalView, task: EvalTask, v: VariantSpec, live: Live, key: number, room: number): Promise<EvalRunRow> {
    const app = this.#app;
    const signal = live.controller.signal;
    const base: EvalRunRow = { evalId: ev.id, task: task.idx, variant: v.id, runId: null, status: 'error', tokens: 0, usd: 0, steps: 0, ms: 0, answer: '', files: [], tests: null, findings: 0, findingList: [], denied: 0 };
    const conv = app.store.getConversation(task.conversationId);
    if (!conv) return { ...base, status: 'skipped', note: 'The conversation is gone.' };
    const model = v.model ?? currentModel(app, conv);
    if (!model) return { ...base, status: 'skipped', note: 'No model is set for this conversation.' };
    if (conv.private && !isLocalModel(app, model)) return { ...base, status: 'skipped', note: 'Private conversation: local models only.' };
    // The budget of this run: the variant's preset (or the owner's default), never more than the
    // room left under the eval's ceiling.
    const s = app.settings.get();
    const preset = v.budget ? BUDGET_PRESETS[v.budget] : turnBudgetFor(turnBudgetSettings(s), conv.mode === 'coding' ? 'coding' : 'chat');
    const budget: Budget = { ...(preset ?? {}), tokens: Math.max(MIN_RUN_TOKENS, Math.min(preset?.tokens ?? Number.MAX_SAFE_INTEGER, room)) };
    let edits: { memory?: { include: number[]; exclude: number[] } } = {};
    if (v.memory) {
      try {
        const r = rebuildStep(app, task.runId, 0);
        const m = memoryEdit(app, task, v, r.picks);
        if (m && (m.include.length || m.exclude.length)) edits = { memory: m };
      } catch {
        /* replayed with the recorded notes */
      }
    }
    // The hard ceiling before every model call (the run's own budget is the first line).
    const hooks: TurnHooks = {
      beforeModelCall: (_c: BeforeModelCall) => {
        const spent = this.#liveSpent(live);
        if (spent.tokens >= ev.ceiling.tokens || (ev.ceiling.usd !== undefined && ev.ceiling.usd > 0 && spent.usd >= ev.ceiling.usd)) {
          live.ceilingHit = true;
          return { stop: true };
        }
        return undefined;
      },
    };
    // Phase 97: "with skill X loaded": its body rides along as the app's note, as when it is loaded up front.
    let notes: string[] | undefined;
    if (v.skill) {
      const sk = app.skills?.get(v.skill.scope, v.skill.name);
      if (!sk) return { ...base, status: 'skipped', note: 'The skill is gone.' };
      try {
        notes = [`[Note from the app: a skill that fits this message was loaded for you; follow it where it fits:]\n${app.skills!.activation(sk)}`];
      } catch (err) {
        return { ...base, status: 'skipped', note: clip((err as Error).message, 300) };
      }
    }
    const deny = new DenyAll();
    const appV = this.#appFor(v, deny);
    const onEvent = (e: BranchEvent) => {
      if (e.type === 'branch') live.running.set(key, e.runId);
    };
    let outcome: ReplayOutcome | undefined;
    const t0 = Date.now();
    for (let tries = 0; ; tries++) {
      try {
        outcome = await replayRun(appV, task.runId, { fromStep: 0, model, budget, ...(notes ? { notes } : {}), ...(edits.memory ? { edits } : {}), ...(v.recall ? { recall: v.recall === 'on' } : {}), sandbox: { keep: true }, signal, hooks, onEvent });
        break;
      } catch (err) {
        // Two branches already (the owner's own, by hand): wait for a slot.
        if (err instanceof ReplayError && err.status === 409 && /Two branches/.test(err.key) && tries < 900 && !signal.aborted) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        if (edits.memory && err instanceof ReplayError && tries === 0) {
          edits = {};
          continue;
        }
        throw err;
      }
    }
    const runs = app.runs!;
    const run = runs.get(outcome.runId);
    runs.setBranch(outcome.runId, { eval: { id: ev.id, task: task.idx, variant: v.id } });
    const copy = join(branchesDir(app), String(outcome.runId), 'ws');
    let tests: TestResult | null = null;
    let findings: { n: number; list: EvalRunRow['findingList'] } = { n: 0, list: [] };
    try {
      if (existsSync(copy)) {
        if (task.tests && !signal.aborted) tests = await this.#tests(copy, task.tests, signal);
        findings = countFindings(copy, outcome.files);
      }
    } finally {
      try {
        discardCopy(app, outcome.runId);
      } catch {
        /* gone already */
      }
    }
    return {
      ...base,
      runId: outcome.runId,
      status: outcome.status,
      tokens: outcome.tokens,
      usd: outcome.usd,
      steps: outcome.steps,
      ms: run?.ms || Date.now() - t0,
      answer: clip(outcome.answer, 8000),
      files: outcome.files.map((f) => ({ path: f.path, change: f.change })),
      tests,
      findings: findings.n,
      findingList: findings.list,
      denied: deny.denied,
    };
  }

  /** The project's tests in an M5 sandbox copy of the variant's copy (no network). */
  async #tests(dir: string, cmd: string, signal: AbortSignal): Promise<TestResult> {
    const app = this.#app;
    const gate = app.sandboxGate;
    if (!gate) return { command: cmd, ran: false, exitCode: null, ms: 0, isolated: false, output: '', note: 'No sandbox here to run the tests in.' };
    const iso = gate.isolation();
    const g = gate.settings();
    try {
      const r = await runInSandbox(dir, cmd, { cacheDir: gate.cacheDir, base: app.sandbox, isolation: iso, network: false, timeoutMs: g.timeLimitS * 1000, signal, maxBytes: g.maxMB * 1048576, keep: false, dockerImage: g.dockerImage, preferWorktree: false });
      const out = r.run?.output ?? r.notRun ?? '';
      return { command: cmd, ran: Boolean(r.run), exitCode: r.run?.exitCode ?? null, ...(r.run ? testCounts(out) : {}), ms: r.run?.ms ?? 0, isolated: iso.isolated, output: out.length > 2000 ? `…${out.slice(-2000)}` : out, ...(r.notRun ? { note: r.notRun } : {}) };
    } catch (err) {
      return { command: cmd, ran: false, exitCode: null, ms: 0, isolated: false, output: '', note: clip((err as Error).message, 300) };
    }
  }

  async #judgeAll(ev: EvalView, live: Live, signal: AbortSignal): Promise<void> {
    const app = this.#app;
    const rows = this.store.runs(ev.id);
    for (const t of ev.tasks) {
      const c = rows.find((r) => r.task === t.idx && r.variant === 'control');
      for (const v of ev.variants.filter((x) => x.id !== 'control')) {
        if (signal.aborted) return;
        const r = rows.find((x) => x.task === t.idx && x.variant === v.id);
        if (!c?.runId || !r?.runId || !c.answer.trim() || !r.answer.trim()) continue;
        const spent = this.#liveSpent(live);
        if (spent.tokens >= ev.ceiling.tokens) {
          live.ceilingHit = true;
          return;
        }
        const conv = app.store.getConversation(t.conversationId);
        if (!conv) continue;
        let chain: ReturnType<typeof resolveChain>;
        try {
          chain = resolveChain(app, conv, 'review');
        } catch {
          chain = [];
        }
        if (conv.private) chain = chain.filter((x) => x.provider.config.local && !isCloudModelName(x.model));
        if (!chain.length) {
          this.store.putJudge(ev.id, t.idx, v.id, { outcome: 'tie', votes: [], note: 'No Reviewing model for this conversation.' });
          continue;
        }
        const ask = (a: string, b: string) => [
          { role: 'system' as const, content: JUDGE_SYSTEM },
          { role: 'user' as const, content: `The request:\n${clip(t.ask, 1500)}\n\nAnswer A:\n${clip(a, 4000)}\n\nAnswer B:\n${clip(b, 4000)}` },
        ];
        const votes: JudgeVote['votes'] = [];
        const checked: ReturnType<typeof checkVote>[] = [];
        let model: string | undefined;
        for (const order of ['control-first', 'variant-first'] as const) {
          const [a, b] = order === 'control-first' ? [c.answer, r.answer] : [r.answer, c.answer];
          const msgs = ask(a, b);
          try {
            const out = await askModel(chain, msgs, 400, signal);
            model = out.model;
            live.spentTokens += Math.ceil((msgs[0].content.length + msgs[1].content.length + out.text.length) / 3.5);
            const k = checkVote(out.text, a, b);
            checked.push(k);
            votes.push({ order, ...k });
          } catch (err) {
            const k = { pick: null, valid: false, dropped: clip((err as Error).message, 120) } as const;
            checked.push(k);
            votes.push({ order, ...k });
          }
        }
        this.store.putJudge(ev.id, t.idx, v.id, { outcome: judgeOutcome(checked[0], checked[1]), votes, ...(model ? { model } : {}) });
      }
    }
  }

  /** "Use this setting": writes the variant's settings and a line in the settings history. "Keep mine" records the choice only. */
  apply(id: number, choice: { variant?: string; keep?: boolean }): { applied: EvalView['applied']; changes: { key: string; before: unknown; after: unknown }[] } {
    const app = this.#app;
    const ev = this.store.get(id);
    if (!ev) throw new ReplayError(404, en('No such eval.'));
    if (this.#live.has(id) || ev.status === 'draft') throw new ReplayError(409, en('This eval has no result yet.'));
    const at = app.now().toISOString();
    if (choice.keep) {
      const historyId = this.store.addHistory({ source: 'eval', ref: id, what: `Eval #${id}: kept the settings as they are`, changes: [] });
      const applied = { variant: 'control', at, historyId, kept: true };
      this.store.patch(id, { applied });
      return { applied, changes: [] };
    }
    const v = ev.variants.find((x) => x.id === choice.variant && x.id !== 'control');
    if (!v) throw new ReplayError(400, en('Pick one of the variants of this eval.'));
    const s = app.settings.get();
    const list: { key: string; before: unknown; after: unknown }[] = [];
    const patch: Record<string, unknown> = {};
    if (v.memory) {
      const before = s.memory ?? {};
      const after = { ...before, fade: v.memory.preset, ...(v.memory.preset === 'custom' ? { decay: { ...(before.decay ?? {}), halfLifeDays: v.memory.halfLifeDays } } : {}) };
      patch.memory = after;
      list.push({ key: 'memory.fade', before: { fade: before.fade ?? 'never', halfLifeDays: before.decay?.halfLifeDays ?? null }, after: { fade: after.fade, halfLifeDays: v.memory.halfLifeDays ?? null } });
    }
    if (v.model) {
      const routes = { ...(s.routes ?? {}) };
      for (const job of ev.kind === 'everyday' ? (['chat'] as const) : ev.kind === 'coding' ? (['coding'] as const) : (['coding', 'chat'] as const)) {
        const before = routes[job];
        routes[job] = { ...(before?.fallbacks ? { fallbacks: before.fallbacks } : {}), providerId: v.model.providerId, model: v.model.model };
        list.push({ key: `routes.${job}`, before: before ? { providerId: before.providerId, model: before.model } : null, after: v.model });
      }
      patch.routes = routes;
    }
    if (v.sandbox) {
      const cur = sandboxGateSettings(s);
      patch.sandboxGate = mergeSandboxGate(cur, { mode: v.sandbox });
      list.push({ key: 'sandboxGate.mode', before: cur.mode, after: v.sandbox });
    }
    if (v.budget) {
      const cur = turnBudgetSettings(s);
      const b = BUDGET_PRESETS[v.budget];
      const side = ev.kind === 'everyday' ? 'chat' : 'coding';
      patch.turnBudgets = mergeTurnBudgets(cur, { [side]: { on: true, tokens: b.tokens, steps: b.steps } });
      list.push({ key: `turnBudgets.${side}`, before: { on: cur[side].on, tokens: cur[side].tokens, steps: cur[side].steps }, after: { on: true, tokens: b.tokens, steps: b.steps } });
    }
    if (v.recall) {
      // Phase 85: "on" keeps it to coding unless the eval was on everyday chats too.
      const mem = memorySettings(app);
      const before = recallMode(mem);
      const after: RecallMode = v.recall === 'off' ? 'off' : ev.kind === 'coding' ? (before === 'everywhere' ? 'everywhere' : 'coding') : 'everywhere';
      patch.memory = { ...mem, ...((patch.memory as object | undefined) ?? {}), recall: after };
      list.push({ key: 'memory.recall', before, after });
    }
    app.settings.update(patch as Parameters<AppContext['settings']['update']>[0]);
    const historyId = this.store.addHistory({ source: 'eval', ref: id, what: `Eval #${id}: used ${variantWords(v)}`, changes: list });
    const applied = { variant: v.id, at, historyId };
    this.store.patch(id, { applied });
    return { applied, changes: list };
  }

  /**
   * "Re-check monthly" (OFF unless the owner switched it on): once a month, only when nobody has
   * talked to her for 20 minutes and no eval is running, the newest finished eval is run again on
   * fresh tasks with the same variants, inside the schedule's token budget. Returns the new id.
   */
  tick(): number | undefined {
    const app = this.#app;
    const sch = evalSchedule(app.settings.get());
    if (!sch.monthly || this.#live.size) return undefined;
    const now = app.now().getTime();
    if (sch.lastRunAt && now - Date.parse(sch.lastRunAt) < MONTH_MS) return undefined;
    if (now - this.lastActivity() < IDLE_MS) return undefined;
    const last = this.store.list(20).find((e) => e.status === 'done' || e.status === 'ceiling');
    if (!last) return undefined;
    app.settings.update({ evalSchedule: { ...sch, lastRunAt: new Date(now).toISOString() } });
    try {
      const ev = this.create({ kind: last.kind, count: last.tasks.length, variants: last.variants.slice(1), judge: last.options.judge, concurrency: last.options.concurrency, title: `${last.title} (monthly)` });
      this.store.patch(ev.id, { ceiling: { tokens: Math.min(sch.budgetTokens, ev.ceiling.tokens), ...(ev.ceiling.usd !== undefined ? { usd: ev.ceiling.usd } : {}) }, options: { ...ev.options, scheduled: true } });
      this.start(ev.id);
      return ev.id;
    } catch (err) {
      console.warn(`evals: the monthly re-check didn't start: ${(err as Error).message}`);
      return undefined;
    }
  }
}

/** The default hard ceiling: the estimate and half again, rounded up to a choice. */
export function ceilingFor(tokens: number): number {
  const want = Math.ceil(tokens * 1.5);
  return CEILING_CHOICES.find((c) => c >= want) ?? Math.ceil(want / 1_000_000) * 1_000_000;
}

/** M6 code checks and M7 threats on the files a variant changed (lower is better). */
export function countFindings(dir: string, files: { path: string; change: string }[]): { n: number; list: EvalRunRow['findingList'] } {
  const changed = new Set(files.filter((f) => f.change !== 'removed').map((f) => f.path));
  if (!changed.size) return { n: 0, list: [] };
  const read = (rel: string): string | undefined => {
    try {
      const p = join(dir, ...rel.split('/'));
      if (statSync(p).size > 512 * 1024) return undefined;
      const b = readFileSync(p);
      return b.includes(0) ? undefined : b.toString('utf8');
    } catch {
      return undefined;
    }
  };
  const list: EvalRunRow['findingList'] = [];
  for (const f of changed) {
    const text = read(f);
    if (text === undefined) continue;
    for (const x of checkFile(f, text)) list.push({ file: f, line: x.line ?? 0, rule: String(x.rule), quote: clip(String(x.quote ?? ''), 160) });
  }
  try {
    const a = analyze(walkFiles(dir, 8, 400), read);
    for (const h of a.hits) if (changed.has(h.sink.file) || h.path.some((s) => changed.has(s.file))) list.push({ file: h.sink.file, line: h.sink.line, rule: `threat:${h.kind}`, quote: clip(h.sink.quote, 160) });
  } catch {
    /* the map is best effort */
  }
  // Phase 86 (M11): red-team mode's insecure-default probes on the changed files (code only: the
  // eval doesn't start apps; full red-team runs are their own runs, kind 'redteam').
  for (const x of insecureDefaults([...changed], read)) list.push({ file: x.file ?? '', line: x.line ?? 0, rule: x.rule, quote: clip(String(x.quote ?? ''), 160) });
  return { n: list.length, list: list.slice(0, 30) };
}
