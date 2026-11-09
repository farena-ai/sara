// Phase 39: Sara leads a team. For a bigger task she makes a plan, hands each part to a helper with
// one job (researcher, coder, reviewer, tester, writer, designer, or Claude Code / Grok Build),
// checks the work (a failing test goes back to the coder, a reviewer's changes too), and reports
// only what the receipts show. Helpers are not companions: no persona, no relationship, just a
// named role with its own model (Phase 38 jobs), tools and the same sandbox and approvals.
import { captureToolScope, assertCurrentScope, assertToolAdmission, ToolAdmissionError, type ToolScope } from './tool-admission.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { type AppContext, preflight, fallbackAfterMs, promptChars, OFFSERVER_TOOL, resolveChain, SlowModelError, streamWithin } from './chat.ts';
import { cardOf, checkPlan, contradictSettings, gateAct, type Contradiction } from './contradict.ts';
import { applySandbox, changesLine, discardSandbox, gateVerdict, sandboxCard, sandboxOutput, sandboxRecord, type ApplyResult, type CommandRisk, type SandboxDecision, type SandboxResult } from './sandbox-run.ts';
import { complete } from './life.ts';
import { privateLocalOn } from './net-guard.ts';
import { memorySettings } from './memory-worker.ts';
import { buildSystemPrompt, SAFETY_BOUNDARIES } from './persona.ts';
import type { ChatMessage, ToolCall } from './providers/types.ts';
import { checkClaims, correctionNote, type Receipt } from './receipts.ts';
import type { RoutePurpose } from './settings.ts';
import { ToolError, type Tool } from './tools/types.ts';
import { workspaceDir } from './tools/workspace.ts';
import { cleanBudget, usageLine, usageScope, type UsageTotals } from './usage.ts';
import { budgetCheck, type Budget, type Dimension } from './budget.ts';
import { filesNamed, RunRecorder } from './runs.ts';

export type HelperRole = 'researcher' | 'coder' | 'reviewer' | 'tester' | 'writer' | 'designer' | 'agent';

export interface HelperDef {
  id: string;
  name: string;
  role: HelperRole;
  emoji: string;
  /** One line: what this helper does (shown on the team page and to the lead when planning). */
  blurb: string;
  /** Extra instructions for every task this helper gets. */
  instructions: string;
  /** Which job's model it thinks with (Settings → Which model does what), unless `model` is set. */
  job: RoutePurpose;
  tools: string[];
  model?: { providerId: string; model: string };
  custom?: boolean;
}

/** A helper the owner made (Settings → Team): a name, a job, instructions, a model and tools. */
export interface CustomHelper {
  id: string;
  name: string;
  role: HelperRole;
  instructions?: string;
  model?: { providerId: string; model: string };
  tools?: string[];
}

const READ = ['list_dir', 'read_file', 'search'];
export const ROLES: Record<HelperRole, Omit<HelperDef, 'id' | 'name' | 'custom' | 'model'>> = {
  researcher: { role: 'researcher', emoji: '🔎', blurb: 'Looks things up on the web and in the files, and reports what it found with sources.', instructions: 'Find facts, cite where each came from (URL or file). Do not change any files.', job: 'research', tools: ['web_search', 'web_fetch', ...READ] },
  coder: { role: 'coder', emoji: '🧑‍💻', blurb: 'Writes and changes code in the workspace.', instructions: 'Make the smallest clean change that does the job. Keep the project style. Run a quick check (build or tests) if you can.', job: 'coding', tools: [...READ, 'write_file', 'edit_file', 'shell'] },
  reviewer: { role: 'reviewer', emoji: '🧐', blurb: 'Reads the changes and says what to fix. Does not change files.', instructions: 'Read the changed files. Look for bugs, missing cases, unclear names and anything that does not match the goal. Do not change files. End with exactly one line: "VERDICT: APPROVE" or "VERDICT: CHANGES NEEDED: <what to change>".', job: 'coding', tools: [...READ, 'git'] },
  tester: { role: 'tester', emoji: '🧪', blurb: 'Runs the tests and checks that it really works.', instructions: 'Run the tests (or write a small check if there are none). Do not change the code under test. Report the exact command and its result. End with exactly one line: "VERDICT: PASS" or "VERDICT: FAIL: <what failed>".', job: 'coding', tools: [...READ, 'shell', 'write_file'] },
  writer: { role: 'writer', emoji: '✍️', blurb: 'Writes docs, READMEs, notes and other text.', instructions: 'Write clearly and plainly for the reader. Keep it short.', job: 'writing', tools: [...READ, 'write_file', 'edit_file'] },
  designer: { role: 'designer', emoji: '🎨', blurb: 'Works on looks: layout, styles, wording on screens.', instructions: 'Keep it neat, tidy and easy for a beginner. Match the existing style.', job: 'writing', tools: [...READ, 'write_file', 'edit_file'] },
  agent: { role: 'agent', emoji: '🤖', blurb: 'Hands the part to Claude Code or Grok Build (your subscription) to do on its own.', instructions: 'Give the agent the whole part as one clear task.', job: 'coding', tools: ['delegate_task'] },
};

export const BUILTIN_HELPERS: HelperDef[] = [
  { id: 'researcher', name: 'Researcher', ...ROLES.researcher },
  { id: 'coder', name: 'Coder', ...ROLES.coder },
  { id: 'reviewer', name: 'Reviewer', ...ROLES.reviewer },
  { id: 'tester', name: 'Tester', ...ROLES.tester },
  { id: 'writer', name: 'Writer', ...ROLES.writer },
  { id: 'designer', name: 'Designer', ...ROLES.designer },
  { id: 'agent', name: 'Claude Code / Grok Build', ...ROLES.agent },
];

/** Built-in helpers plus the owner's own (theirs can replace a built-in by using its id). */
export function teamHelpers(app: AppContext, o: { workers?: boolean } = {}): HelperDef[] {
  const own = (app.settings.get().helpers ?? []).map((c): HelperDef => {
    const base = ROLES[c.role] ?? ROLES.coder;
    return { ...base, id: c.id, name: c.name, instructions: [base.instructions, c.instructions?.trim()].filter(Boolean).join('\n'), tools: c.tools?.length ? c.tools : base.tools, ...(c.model ? { model: c.model } : {}), custom: true };
  });
  const all = [...BUILTIN_HELPERS.filter((b) => !own.some((x) => x.id === b.id)), ...own];
  // C10: each worker that stays is one more helper (`worker-<id>`) built on one of these.
  return o.workers === false || !app.workers ? all : [...all, ...app.workers.helperDefs(all)];
}

export function cleanHelpers(v: unknown, toolNames: string[]): CustomHelper[] {
  if (!Array.isArray(v)) throw new Error('Helpers must be a list.');
  return v.slice(0, 12).map((x, i) => {
    const h = (x ?? {}) as Record<string, unknown>;
    const name = String(h.name ?? '').trim().slice(0, 40);
    if (!name) throw new Error(`Helper ${i + 1}: give it a name.`);
    const role = String(h.role ?? '') as HelperRole;
    if (!(role in ROLES)) throw new Error(`${name}: pick a job.`);
    const tools = Array.isArray(h.tools) ? h.tools.map(String).filter((t) => toolNames.includes(t)).slice(0, 30) : undefined;
    const m = h.model as { providerId?: unknown; model?: unknown } | null | undefined;
    const model = m && m.providerId && m.model ? { providerId: String(m.providerId), model: String(m.model).slice(0, 200) } : undefined;
    const id = typeof h.id === 'string' && /^[\w-]{1,40}$/.test(h.id) ? h.id : `h-${randomUUID().slice(0, 8)}`;
    return { id, name, role, ...(h.instructions ? { instructions: String(h.instructions).slice(0, 2000) } : {}), ...(model ? { model } : {}), ...(tools?.length ? { tools } : {}) };
  });
}

export interface TeamLimits {
  /** Minutes before the whole task stops. */
  minutes: number;
  /** About how many tokens the whole team may use (characters / 4). */
  tokens: number;
  /** Helper runs at most (steps, including send-backs). */
  steps: number;
  /** Phase 52: an optional dollar budget (estimated from the price table; 0/absent = none). */
  usd?: number;
}
export const DEFAULT_LIMITS: TeamLimits = { minutes: 30, tokens: 400_000, steps: 14 };
export function cleanLimits(v: unknown, base: TeamLimits = DEFAULT_LIMITS): TeamLimits {
  const l = (v ?? {}) as Partial<Record<keyof TeamLimits, unknown>>;
  const n = (x: unknown, d: number, lo: number, hi: number) => (x === undefined || x === null || x === '' ? d : Math.min(hi, Math.max(lo, Math.round(Number(x)) || d)));
  const usdRaw = l.usd === undefined ? base.usd : l.usd === null || l.usd === '' ? 0 : Number(l.usd);
  const usd = Number.isFinite(usdRaw) && Number(usdRaw) > 0 ? Math.min(10_000, Math.round(Number(usdRaw) * 100) / 100) : 0;
  return { minutes: n(l.minutes, base.minutes, 2, 240), tokens: n(l.tokens, base.tokens, 10_000, 5_000_000), steps: n(l.steps, base.steps, 2, 40), ...(usd ? { usd } : {}) };
}

/** Phase 79: a team task's limits as the one Budget (src/budget.ts), only the lines asked for. */
export function teamBudget(l: TeamLimits, lines: Dimension[] = ['tokens', 'usd', 'steps', 'minutes']): Budget {
  return {
    ...(lines.includes('tokens') ? { tokens: l.tokens } : {}),
    ...(lines.includes('usd') && l.usd ? { usd: l.usd } : {}),
    ...(lines.includes('steps') ? { steps: l.steps } : {}),
    ...(lines.includes('minutes') ? { minutes: l.minutes } : {}),
  };
}

export type TaskStatus = 'planning' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'limit' | 'interrupted';

/** Phase 40: a coding workflow (plan → build → test → pull request) on top of a team task. */
export interface Workflow {
  /** Stop at the checkpoints (the plan; opening the pull request) for your OK. */
  checkpoints: boolean;
  /** Commit to a new branch, push it and open a pull request at the end (then review it). */
  pr: boolean;
  /** The repository's folder in the workspace ('.' = the workspace). */
  repoPath?: string;
  /** The GitHub issue this came from. */
  issue?: { repo: string; number: number; title: string; url: string };
  /** Checkpoints already answered (so a restart doesn't ask again). */
  passed?: string[];
  /** The pull request, once open. */
  prUrl?: string;
}
export interface Checkpoint {
  kind: 'plan' | 'pr';
  text: string;
  at: string;
}
export type StepStatus = 'waiting' | 'running' | 'done' | 'failed' | 'stopped' | 'skipped';

export interface TeamStep {
  id: number;
  taskId: number;
  idx: number;
  helper: string;
  title: string;
  instructions: string;
  status: StepStatus;
  /** Why this step exists, when the lead added it (a send-back). */
  because: string | null;
  report: string | null;
  receipts: Receipt[];
  /** Sentences in the helper's report that its receipts don't back (left out of her report). */
  unverified: string[];
  tokens: number;
  startedAt: string | null;
  endedAt: string | null;
}

export interface TeamTask {
  id: number;
  conversationId: string;
  workspace: string;
  goal: string;
  status: TaskStatus;
  limits: TeamLimits;
  tokens: number;
  undo: string | null;
  report: string | null;
  createdAt: string;
  endedAt: string | null;
  steps: TeamStep[];
  workflow: Workflow | null;
  checkpoint: Checkpoint | null;
}

export interface PendingApproval {
  id: string;
  stepId: number;
  helper: string;
  tool: string;
  summary: string;
  /** Phase 77: the call goes against a decision (the card's extra section). */
  contradiction?: import('./contradict.ts').ContradictionCard;
  /** Phase 80: the helper's command ran in a sandbox copy first (Apply / Discard / Run for real). */
  sandbox?: import('./sandbox-run.ts').SandboxCard;
}

const MAX_HELPER_ROUNDS = 25;
const MAX_FIXES = 2;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const est = (x: unknown) => Math.ceil((typeof x === 'string' ? x.length : JSON.stringify(x).length) / 4);

/** The last line starting with "VERDICT:" in a report. */
export function verdict(report: string | null): { ok: boolean; detail: string } | undefined {
  const line = [...(report ?? '').matchAll(/^\s*\**VERDICT:\**\s*(.+)$/gim)].at(-1)?.[1]?.trim();
  if (!line) return undefined;
  if (/^(APPROVE|PASS)/i.test(line)) return { ok: true, detail: line };
  return { ok: false, detail: line.replace(/^(CHANGES NEEDED|FAIL(ED)?)\s*:?\s*/i, '') };
}

/** Did the tester's last command fail? (Its receipts are the truth, whatever it says.) */
export function lastRunFailed(receipts: Receipt[]): Receipt | undefined {
  const last = receipts.filter((r) => r.name === 'shell').at(-1);
  if (!last) return undefined;
  return last.status !== 'ok' || !/^\[exit code 0[,\]]/.test(last.output) ? last : undefined;
}

/** What the receipts show, in plain lines (files, commands and their exit codes, commits). */
export function receiptLines(steps: TeamStep[], names: Map<string, string>): string[] {
  const out: string[] = [];
  const files = new Set<string>();
  for (const s of steps) {
    for (const r of s.receipts) {
      if (r.status !== 'ok') continue;
      if ((r.name === 'write_file' || r.name === 'edit_file') && r.args.path) files.add(String(r.args.path));
    }
  }
  if (files.size) out.push(`Files written or changed: ${[...files].join(', ')}`);
  for (const s of steps) {
    for (const r of s.receipts) {
      if (r.name === 'shell') {
        const code = /^\[(exit code \w+|timed out[^,\]]*)/.exec(r.output)?.[1] ?? r.status;
        out.push(`${names.get(s.helper) ?? s.helper} ran \`${clip(String(r.args.command ?? ''), 120)}\`: ${r.status === 'denied' ? 'not allowed' : code}`);
      } else if (r.name === 'git_commit' && r.status === 'ok') out.push(`${names.get(s.helper) ?? s.helper} committed: ${clip(String(r.args.message ?? '').split('\n')[0], 100)}${r.args.new_branch ? ` (branch ${r.args.new_branch})` : ''}`);
      else if (r.name === 'git_push' && r.status === 'ok') out.push(`${names.get(s.helper) ?? s.helper} pushed ${String(r.args.branch ?? 'the branch')}`);
      else if (r.name === 'github_open_pr' && r.status === 'ok') out.push(`${names.get(s.helper) ?? s.helper} opened ${/https:\/\/github\.com\/\S+\/pull\/\d+/.exec(r.output)?.[0] ?? 'a pull request'}`);
      else if (r.name === 'review_code' && r.status === 'ok') out.push(`${names.get(s.helper) ?? s.helper} reviewed the pull request: ${/Verdict: ([^.]+)\./.exec(r.output)?.[1] ?? 'see the review'}${(r.output.match(/^- /gm) ?? []).length ? ` (${(r.output.match(/^- /gm) ?? []).length} comments, ${(r.output.match(/\[must\]/g) ?? []).length} must-fix)` : ''}`);
      else if (r.name === 'github_post_review' && r.status === 'ok') out.push(`${names.get(s.helper) ?? s.helper} posted the review on the pull request`);
      else if (r.name === 'delegate_task') out.push(`${names.get(s.helper) ?? s.helper} handed a part to ${r.args.agent === 'grok' ? 'Grok Build' : 'Claude Code'}: ${r.status}`);
    }
  }
  return out;
}

type Row = Record<string, string | number | null>;

export class TeamManager {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #runs = new Map<number, { ctl: AbortController; step?: { id: number; ctl: AbortController }; inbox: Map<number, string[]>; approvals: Map<string, PendingApproval>; done: Promise<TeamTask>; answer?: (d: 'go' | 'skip' | 'stop') => void; rec: RunRecorder; scope: ToolScope }>();
  /** Tasks that were running when the server stopped (picked up again by resumeInterrupted). */
  readonly #resumable: number[] = [];

  constructor(app: AppContext, db: DatabaseSync) {
    this.#app = app;
    this.#db = db;
    db.exec(`
CREATE TABLE IF NOT EXISTS team_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  limits TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  undo TEXT,
  report TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS team_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  helper TEXT NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  status TEXT NOT NULL,
  because TEXT,
  report TEXT,
  receipts TEXT NOT NULL DEFAULT '[]',
  unverified TEXT NOT NULL DEFAULT '[]',
  tokens INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS team_steps_task ON team_steps(task_id, idx);
CREATE TABLE IF NOT EXISTS team_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  step_id INTEGER,
  at TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_log_task ON team_log(task_id, id);
`);
    const cols = new Set((db.prepare('PRAGMA table_info(team_tasks)').all() as { name: string }[]).map((c) => c.name));
    if (!cols.has('workflow')) db.exec('ALTER TABLE team_tasks ADD COLUMN workflow TEXT');
    if (!cols.has('checkpoint')) db.exec('ALTER TABLE team_tasks ADD COLUMN checkpoint TEXT');
    // Tasks that were running when the server stopped: the part a helper was doing is redone, and
    // the task is picked up again (resumeInterrupted) from there.
    const live = db.prepare("SELECT id FROM team_tasks WHERE status IN ('planning', 'running', 'waiting')").all() as { id: number }[];
    for (const r of live) {
      // Keep in-flight receipts and state until explicit owner recovery.
      db.prepare("UPDATE team_tasks SET status = 'interrupted' WHERE id = ?").run(r.id);
      this.#resumable.push(r.id);
    }
  }

  #step(r: Row): TeamStep {
    return {
      id: Number(r.id),
      taskId: Number(r.task_id),
      idx: Number(r.idx),
      helper: String(r.helper),
      title: String(r.title),
      instructions: String(r.instructions),
      status: String(r.status) as StepStatus,
      because: r.because === null ? null : String(r.because),
      report: r.report === null ? null : String(r.report),
      receipts: JSON.parse(String(r.receipts)) as Receipt[],
      unverified: JSON.parse(String(r.unverified)) as string[],
      tokens: Number(r.tokens),
      startedAt: r.started_at === null ? null : String(r.started_at),
      endedAt: r.ended_at === null ? null : String(r.ended_at),
    };
  }

  get(id: number): TeamTask | undefined {
    const r = this.#db.prepare('SELECT * FROM team_tasks WHERE id = ?').get(id) as Row | undefined;
    if (!r) return undefined;
    const steps = (this.#db.prepare('SELECT * FROM team_steps WHERE task_id = ? ORDER BY idx, id').all(id) as Row[]).map((s) => this.#step(s));
    return {
      id: Number(r.id),
      conversationId: String(r.conversation_id),
      workspace: String(r.workspace),
      goal: String(r.goal),
      status: String(r.status) as TaskStatus,
      limits: JSON.parse(String(r.limits)) as TeamLimits,
      tokens: Number(r.tokens),
      undo: r.undo === null ? null : String(r.undo),
      report: r.report === null ? null : String(r.report),
      createdAt: String(r.created_at),
      endedAt: r.ended_at === null ? null : String(r.ended_at),
      steps,
      workflow: r.workflow ? (JSON.parse(String(r.workflow)) as Workflow) : null,
      checkpoint: r.checkpoint ? (JSON.parse(String(r.checkpoint)) as Checkpoint) : null,
    };
  }

  list(limit = 20): TeamTask[] {
    return (this.#db.prepare('SELECT id FROM team_tasks ORDER BY id DESC LIMIT ?').all(limit) as { id: number }[]).map((r) => this.get(r.id)!);
  }

  log(taskId: number, limit = 200): { id: number; stepId: number | null; at: string; text: string }[] {
    return (this.#db.prepare('SELECT * FROM (SELECT * FROM team_log WHERE task_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(taskId, limit) as Row[]).map((r) => ({ id: Number(r.id), stepId: r.step_id === null ? null : Number(r.step_id), at: String(r.at), text: String(r.text) }));
  }

  approvals(taskId: number): PendingApproval[] {
    return [...(this.#runs.get(taskId)?.approvals.values() ?? [])];
  }

  /** 3.0.3: conversations where a team task waits at a checkpoint for the person's OK. */
  waitingConversations(): string[] {
    return (this.#db.prepare("SELECT DISTINCT conversation_id AS c FROM team_tasks WHERE status = 'waiting'").all() as { c: string }[]).map((r) => String(r.c));
  }

  running(): TeamTask[] {
    return [...this.#runs.keys()].map((id) => this.get(id)!).filter(Boolean);
  }

  #note(taskId: number, stepId: number | null, text: string): void {
    this.#db.prepare('INSERT INTO team_log (task_id, step_id, at, text) VALUES (?, ?, ?, ?)').run(taskId, stepId, this.#app.now().toISOString(), this.#app.redactor.redact(clip(text, 2000)));
    this.#publish(taskId);
  }

  #publish(taskId: number): void {
    const t = this.get(taskId);
    if (t) this.#app.events?.publish({ type: 'team', task: { id: t.id, status: t.status, conversationId: t.conversationId, approvals: this.approvals(t.id).length } });
  }

  #setTask(id: number, patch: Partial<{ status: TaskStatus; report: string; undo: string; ended_at: string; workflow: string; checkpoint: string | null }>): void {
    for (const [k, v] of Object.entries(patch)) this.#db.prepare(`UPDATE team_tasks SET ${k} = ? WHERE id = ?`).run(v ?? null, id);
    this.#publish(id);
  }

  #addTokens(task: TeamTask, step: TeamStep, n: number): void {
    task.tokens += n;
    step.tokens += n;
    this.#db.prepare('UPDATE team_tasks SET tokens = ? WHERE id = ?').run(task.tokens, task.id);
    this.#db.prepare('UPDATE team_steps SET tokens = ? WHERE id = ?').run(step.tokens, step.id);
  }

  #saveStep(s: TeamStep): void {
    this.#db
      .prepare('UPDATE team_steps SET status = ?, report = ?, receipts = ?, unverified = ?, started_at = ?, ended_at = ? WHERE id = ?')
      .run(s.status, s.report, JSON.stringify(s.receipts.map((r) => ({ ...r, output: clip(r.output, 4000) }))), JSON.stringify(s.unverified), s.startedAt, s.endedAt, s.id);
    this.#publish(s.taskId);
  }

  /** Adds a step after position `after` (or at the end), moving the later ones down. */
  #insertStep(taskId: number, after: number | null, helper: string, title: string, instructions: string, because: string | null): void {
    const idx = after === null ? Number((this.#db.prepare('SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM team_steps WHERE task_id = ?').get(taskId) as { n: number }).n) : after + 1;
    if (after !== null) this.#db.prepare('UPDATE team_steps SET idx = idx + 1 WHERE task_id = ? AND idx >= ?').run(taskId, idx);
    this.#db.prepare("INSERT INTO team_steps (task_id, idx, helper, title, instructions, status, because) VALUES (?, ?, ?, ?, ?, 'waiting', ?)").run(taskId, idx, helper, clip(title, 160), clip(instructions, 6000), because);
  }

  /** Starts a task in the background. */
  start(conversationId: string, goal: string, opts: { limits?: Partial<TeamLimits>; plan?: { helper: string; title: string; instructions: string }[]; workflow?: Workflow } = {}): TeamTask {
    const conv = this.#app.store.getConversation(conversationId);
    if (!conv) throw new Error('No such conversation.');
    if (conv.partner) throw new Error('Not in a chat with someone else.');
    const g = goal.trim();
    if (g.length < 8 || g.length > 6000) throw new Error('Describe the task in 8 to 6000 characters.');
    if (this.#runs.size >= 2) throw new Error('Two team tasks are already running. Wait for one to finish, or stop one on the Team page.');
    const limits = cleanLimits(opts.limits, cleanLimits(this.#app.settings.get().teamLimits));
    const r = this.#db.prepare("INSERT INTO team_tasks (conversation_id, workspace, goal, status, limits, created_at) VALUES (?, ?, ?, 'planning', ?, ?)").run(conv.id, conv.workspace, g, JSON.stringify(limits), this.#app.now().toISOString());
    const id = Number(r.lastInsertRowid);
    if (opts.workflow) this.#db.prepare('UPDATE team_tasks SET workflow = ? WHERE id = ?').run(JSON.stringify(opts.workflow), id);
    this.#launch(id, opts.plan);
    return this.get(id)!;
  }

  #launch(id: number, plan?: { helper: string; title: string; instructions: string }[]): void {
    const task = this.get(id);
    const conv = task?.conversationId;
    // Phase 78: each launch of a team task is a run (each helper's move a step). The usage scope
    // (AsyncLocalStorage, as before) carries the recorder to every model call in it.
    const rec = this.#app.runs && conv && this.#app.store.getConversation(conv) ? new RunRecorder(this.#app.runs, { kind: 'team', conversationId: conv, teamTaskId: id, title: clip(task?.goal ?? '', 120), budget: task?.limits }) : RunRecorder.none();
    const original = conv ? this.#app.store.getConversation(conv) : undefined;
    if (!original || !task) throw new Error('The original conversation is unavailable.');
    const scope = captureToolScope(original, task.workspace, privateLocalOn());
    const run = { scope, ctl: new AbortController(), inbox: new Map<number, string[]>(), approvals: new Map<string, PendingApproval>(), done: Promise.resolve(undefined as unknown as TeamTask), rec };
    this.#runs.set(id, run);
    // Phase 52: every model call in the run counts toward it (the usage meter and its budget).
    run.done = usageScope
      .run({ purpose: 'team', teamTaskId: id, ...(conv ? { conversationId: conv } : {}), ...(rec.on ? { runId: rec.id, onCall: (c) => rec.modelCall(c) } : {}) }, () => this.#run(id, plan))
      .then(
        (t) => {
          rec.close(t.status === 'done' ? 'ok' : t.status === 'limit' ? 'limit' : t.status === 'stopped' ? 'stopped' : 'error');
          return t;
        },
        (err) => {
          rec.close('error');
          throw err;
        },
      )
      .finally(() => this.#runs.delete(id));
  }

  /** Phase 52: what the run has used so far (real token counts where the models report them). */
  usage(id: number): (UsageTotals & { line: string }) | undefined {
    const u = this.#app.usage?.forTeam(id);
    return u ? { ...u, line: usageLine(u) } : undefined;
  }

  /**
   * Phase 52: a task stopped at a limit carries on from the part it was on, with more room:
   * by default the same token / dollar budget again, plus a few more helper runs.
   */
  continueWithMore(id: number, more: { tokens?: unknown; usd?: unknown } = {}): TeamTask {
    const t = this.get(id);
    if (!t || this.#runs.has(id)) throw new Error('No such task, or it is still running.');
    if (t.status !== 'limit') throw new Error('Only a task that stopped at a limit can continue with more budget.');
    if (this.#runs.size >= 2) throw new Error('Two team tasks are already running. Wait for one to finish, or stop one on the Team page.');
    const add = cleanBudget(more);
    const l = t.limits;
    const limits: TeamLimits = {
      minutes: l.minutes,
      tokens: Math.min(50_000_000, l.tokens + (add.tokens ?? (add.usd ? 0 : l.tokens))),
      steps: Math.min(80, l.steps + 6),
      ...(l.usd || add.usd ? { usd: Math.round(((l.usd ?? 0) + (add.usd ?? (add.tokens ? 0 : (l.usd ?? 0)))) * 100) / 100 } : {}),
    };
    this.#db.prepare("UPDATE team_tasks SET limits = ?, status = 'running', ended_at = NULL WHERE id = ?").run(JSON.stringify(limits), id);
    this.#note(id, null, `Continuing with more budget: about ${limits.tokens.toLocaleString('en-US')} tokens${limits.usd ? `, $${limits.usd.toFixed(2)}` : ''}, ${limits.steps} helper runs.`);
    this.#launch(id);
    return this.get(id)!;
  }

  /** The limit a task is at (or about to pass with its next call of about `next` tokens). */
  #overLimit(task: TeamTask, next = 0): string | undefined {
    // Real counts of every call in the run (the plan too) where the models report them.
    // Phase 79: checked through the one Budget (src/budget.ts); the team's own words stay.
    const u = this.#app.usage?.forTeam(task.id);
    const used = Math.max(task.tokens, u?.tokens ?? 0);
    const chk = budgetCheck(teamBudget(task.limits, ['tokens', 'usd']), { tokens: used, usd: u?.usd ?? 0 }, { next: { tokens: next } });
    if (chk.reached === 'tokens') return `the spending limit (about ${task.limits.tokens.toLocaleString('en-US')} tokens)`;
    if (chk.reached === 'usd') return `the budget of $${(task.limits.usd ?? 0).toFixed(2)}`;
    return undefined;
  }

  /** Compatibility shim: startup never launches interrupted work. */
  resumeInterrupted(): number[] { return []; }

  resume(id: number, acknowledgeUnknown: boolean): TeamTask {
    const app = this.#app;
    const task = this.get(id);
    if (!task || task.status !== 'interrupted' || this.#runs.has(id)) throw new Error('Only an interrupted task can resume.');
    if (!acknowledgeUnknown) throw new Error('Acknowledge that unfinished steps may already have had effects.');
    const conv = app.store.getConversation(task.conversationId);
    if (!conv || conv.partner || conv.workspace !== task.workspace || app.member) throw new Error('The original conversation or workspace is unavailable.');
    const lastUser = app.store.messages(conv.id).filter(m => m.role === 'user').at(-1)?.content ?? '';
    if (preflight(lastUser).crisis || preflight(lastUser).minor) throw new Error('Recovery is held for the current conversation safety state.');
    if (task.workflow?.pr && (conv.private || privateLocalOn())) throw new Error('Pull-request recovery is held while this conversation is private.');
    if (this.#runs.size >= 2 || app.isBusy?.(conv.id)) throw new Error('Wait for current work to finish.');
    const teamTool = app.tools.get('team_task');
    if (!teamTool || teamTool.isAvailable?.() === false || app.tools.permission('team_task', app.settings.get().toolPermissions) === 'never') throw new Error('Team work is disabled by current policy.');
    if (this.#overLimit(task) || task.steps.filter(s => s.status === 'done').length >= task.limits.steps) throw new Error('The original task has reached its limits.');
    const helpers = new Map(teamHelpers(app).map(h => [h.id,h]));
    for (const step of task.steps.filter(s => s.status === 'running' || s.status === 'waiting')) {
      const helper = helpers.get(step.helper);
      if (step.helper !== 'lead' && (!helper || helper.role === 'agent' && app.tools.get('delegate_task')?.isAvailable?.() === false)) throw new Error('An unfinished helper is unavailable under current settings.');
    }
    if (task.workflow?.pr && task.steps.some(s => s.helper === 'lead')) throw new Error('The interrupted pull-request step needs manual reconciliation; automatic replay is unavailable.');
    const workflow = task.workflow ? { ...task.workflow, checkpoints: true, passed: [] } : null;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.#db.prepare("UPDATE team_tasks SET status='running', checkpoint=NULL, ended_at=NULL, workflow=? WHERE id=? AND status='interrupted'").run(workflow ? JSON.stringify(workflow) : null,id);
      if (!changed.changes) throw new Error('Task recovery state changed; refresh before resuming.');
      this.#db.prepare("UPDATE team_steps SET status='waiting' WHERE task_id=? AND status='running'").run(id);
      this.#db.exec('COMMIT');
    } catch(err) { this.#db.exec('ROLLBACK'); throw err; }
    this.#note(id,null,'Owner acknowledged unfinished effects. Current approvals apply.');
    this.#launch(id);
    return this.get(id)!;
  }

  /** Answers the checkpoint a workflow is waiting at: go on, go on without asking again, or stop. */
  answer(id: number, decision: 'go' | 'skip' | 'stop'): boolean {
    const run = this.#runs.get(id);
    if (!run?.answer) return false;
    run.answer(decision);
    return true;
  }

  async #checkpoint(id: number, kind: Checkpoint['kind'], text: string): Promise<void> {
    const t = this.get(id)!;
    const wf = t.workflow;
    if (!wf || !wf.checkpoints || wf.passed?.includes(kind)) return;
    const run = this.#runs.get(id)!;
    this.#setTask(id, { status: 'waiting', checkpoint: JSON.stringify({ kind, text, at: this.#app.now().toISOString() }) });
    this.#note(id, null, kind === 'plan' ? 'Waiting for your OK on the plan.' : 'Waiting for your OK to open the pull request.');
    const d = await new Promise<'go' | 'skip' | 'stop'>((resolve, reject) => {
      run.answer = resolve;
      run.ctl.signal.addEventListener('abort', () => reject(run.ctl.signal.reason), { once: true });
    }).finally(() => (run.answer = undefined));
    if (d === 'stop') {
      this.#note(id, null, 'You stopped it at the checkpoint.');
      run.ctl.abort(new Error('stopped'));
      throw run.ctl.signal.reason;
    }
    const now = this.get(id)!.workflow!;
    const next: Workflow = { ...now, passed: [...(now.passed ?? []), kind], ...(d === 'skip' ? { checkpoints: false } : {}) };
    this.#setTask(id, { status: 'running', checkpoint: null, workflow: JSON.stringify(next) });
    this.#note(id, null, d === 'skip' ? 'Go on, without asking again.' : 'You said go on.');
  }

  /** Resolves when the task ends (tests, and the tool's "wait"). */
  async finished(id: number): Promise<TeamTask> {
    await this.#runs.get(id)?.done;
    return this.get(id)!;
  }

  stop(id: number): boolean {
    const run = this.#runs.get(id);
    if (!run) return false;
    this.#note(id, null, 'Stopped by you.');
    run.ctl.abort(new Error('stopped'));
    return true;
  }

  /** Stops one helper; the lead goes on with the next part. */
  stopStep(id: number, stepId: number): boolean {
    const run = this.#runs.get(id);
    if (!run?.step || run.step.id !== stepId) return false;
    this.#note(id, stepId, 'You stopped this helper.');
    run.step.ctl.abort(new Error('step stopped'));
    return true;
  }

  /** Redirects a waiting or running helper: the message reaches it before its next move. */
  message(id: number, stepId: number, text: string): boolean {
    const run = this.#runs.get(id);
    const step = this.get(id)?.steps.find((s) => s.id === stepId);
    if (!run || !step || (step.status !== 'running' && step.status !== 'waiting')) return false;
    const t = text.trim().slice(0, 2000);
    if (!t) return false;
    run.inbox.set(stepId, [...(run.inbox.get(stepId) ?? []), t]);
    this.#note(id, stepId, `Your message: ${t}`);
    return true;
  }

  async #run(id: number, given?: { helper: string; title: string; instructions: string }[]): Promise<TeamTask> {
    const app = this.#app;
    const run = this.#runs.get(id)!;
    const started = Date.now();
    const task = this.get(id)!;
    const helpers = teamHelpers(app);
    const byId = new Map(helpers.map((h) => [h.id, h]));
    const wsDir = workspaceDir(app.rootDir ?? app.dataDir, task.workspace);
    let outcome: TaskStatus = 'done';
    let reason = '';
    try {
      assertCurrentScope(app, run.scope, run.ctl.signal, task.workspace, privateLocalOn());
      // An undo point for the whole task.
      if (!task.undo) try {
        this.#setTask(id, { undo: app.snapshots.take(task.workspace, wsDir, `before team task #${id}: ${clip(task.goal, 100)}`, task.conversationId).id });
      } catch (err) {
        this.#note(id, null, `No undo point: ${(err as Error).message}`);
      }
      if (!task.steps.length) {
        const plan = given ?? (await this.#plan(task, helpers, wsDir, run.ctl.signal));
        for (const p of plan) this.#insertStep(id, null, p.helper, p.title, p.instructions, null);
        this.#note(id, null, `Plan: ${plan.map((p, i) => `${i + 1}. ${byId.get(p.helper)?.name ?? p.helper}: ${p.title}`).join(' · ')}`);
      }
      this.#setTask(id, { status: 'running' });
      // Phase 40: a workflow stops here for your OK on the plan.
      const planned = this.get(id)!.steps;
      await this.#checkpoint(id, 'plan', planned.map((s, i) => `${i + 1}. ${byId.get(s.helper)?.name ?? s.helper}: ${s.title}`).join('\n'));
      let fixes = planned.filter((s) => s.because?.endsWith('found a failure')).length;
      let reviews = planned.filter((s) => s.because?.endsWith('asked for changes')).length;
      let runs = planned.filter((s) => s.status !== 'waiting' && s.status !== 'skipped').length;
      for (let i = 0; ; i++) {
        const cur = this.get(id)!;
        const step = cur.steps.find((s) => s.idx === i);
        if (!step) break;
        if (step.status !== 'waiting') continue; // done before a restart
        if (step.helper === 'lead') {
          // Her own pull request part, cut off by a restart: it runs again after the parts.
          this.#db.prepare("UPDATE team_steps SET status = 'skipped' WHERE id = ?").run(step.id);
          continue;
        }
        if (run.ctl.signal.aborted) throw run.ctl.signal.reason;
        if (budgetCheck(teamBudget(cur.limits, ['minutes']), { tokens: 0, usd: 0, ms: Date.now() - started }).reached) throw new LimitError(`the time limit (${cur.limits.minutes} minutes)`);
        const over = this.#overLimit(cur);
        if (over) throw new LimitError(over);
        if (budgetCheck(teamBudget(cur.limits, ['steps']), { tokens: 0, usd: 0, steps: runs++ }, { next: { steps: 1 } }).reached) throw new LimitError(`the limit of ${cur.limits.steps} helper runs`);
        const helper = byId.get(step.helper);
        if (!helper) {
          step.status = 'skipped';
          step.report = `No helper called "${step.helper}".`;
          this.#saveStep(step);
          continue;
        }
        assertCurrentScope(app, run.scope, run.ctl.signal, task.workspace, privateLocalOn());
        await this.#runHelper(cur, step, helper, wsDir, started);
        if ((step.status as StepStatus) !== 'done') continue; // (set by #runHelper)
        // The lead checks the work: a failing run goes back to the coder, then gets tested again.
        const coder = helpers.find((h) => h.role === 'coder')?.id ?? 'coder';
        if (helper.role === 'tester') {
          const failed = lastRunFailed(step.receipts);
          const v = verdict(step.report);
          if (failed || (v && !v.ok)) {
            if (fixes >= MAX_FIXES) {
              this.#note(id, step.id, `Still failing after ${MAX_FIXES} fixes; reporting it as it is.`);
              outcome = 'failed';
              reason = 'the tests still fail';
              continue;
            }
            fixes++;
            const what = failed ? `The command \`${clip(String(failed.args.command ?? ''), 200)}\` failed:\n${clip(failed.output, 3000)}` : `The tester says: ${v!.detail}`;
            this.#note(id, step.id, `Sent back to the coder (fix ${fixes} of ${MAX_FIXES}).`);
            this.#insertStep(id, step.idx, coder, 'Fix what the tester found', `${what}\n\nFix the code so this passes (change the tests only if they are clearly wrong). The goal: ${task.goal}`, `${helper.name} found a failure`);
            this.#insertStep(id, step.idx + 1, step.helper, step.title.startsWith('Test again') ? step.title : `Test again: ${step.title}`, step.instructions, 'after the fix');
          }
        } else if (helper.role === 'reviewer') {
          const v = verdict(step.report);
          if (v && !v.ok) {
            if (reviews >= 1) {
              this.#note(id, step.id, 'The reviewer still has notes; they are in the report.');
              continue;
            }
            reviews++;
            this.#note(id, step.id, 'Sent back to the coder with the review.');
            this.#insertStep(id, step.idx, coder, 'Make the review changes', `The reviewer asks for these changes:\n${v.detail}\n\nMake them. The goal: ${task.goal}`, `${helper.name} asked for changes`);
            const tester = helpers.find((h) => h.role === 'tester');
            if (tester && this.get(id)!.steps.some((s) => s.helper === tester.id)) this.#insertStep(id, step.idx + 1, tester.id, 'Test again after the review changes', 'Run the tests again and report the exact command and result. End with "VERDICT: PASS" or "VERDICT: FAIL: <what failed>".', 'after the review changes');
            this.#insertStep(id, step.idx + (tester ? 2 : 1), step.helper, 'Review again', step.instructions, 'after the changes');
          }
        }
      }
      // Phase 40: the workflow's pull request (after your OK), then her review of it.
      const wf = this.get(id)!.workflow;
      if (wf?.pr && outcome === 'done' && !wf.prUrl) {
        await this.#checkpoint(id, 'pr', `Open a pull request with these changes${wf.issue ? ` (closes ${wf.issue.repo}#${wf.issue.number})` : ''}?`);
        try {
          assertCurrentScope(app, run.scope, run.ctl.signal, task.workspace, privateLocalOn());
        } catch (err) {
          if (!(err instanceof ToolAdmissionError) || run.ctl.signal.aborted) throw err;
          const current = app.store.getConversation(task.conversationId);
          const reason = current?.private || privateLocalOn() ? 'Pull-request publication is held by the current conversation privacy policy.' : err.message;
          // Keep completed helpers intact and expose the held publication in the existing step UI.
          this.#insertStep(id, null, 'lead', 'Pull-request publication held', 'Publication requires the original conversation context.', reason);
          const held = this.get(id)!.steps.at(-1)!;
          held.status = 'failed';
          held.report = reason;
          held.endedAt = app.now().toISOString();
          held.receipts = [{ name: 'github_open_pr', status: 'denied', args: {}, output: reason }];
          this.#saveStep(held);
          run.rec.tool({ id: 'pr-held', name: 'github_open_pr', summary: 'Pull-request publication held', args: {}, status: 'denied', output: reason, ms: 0, approval: 'denied' });
          throw new ToolAdmissionError(reason);
        }
        await this.#pullRequest(this.get(id)!, wsDir, byId);
      }
    } catch (err) {
      if (err instanceof LimitError) {
        outcome = 'limit';
        reason = err.message;
        this.#note(id, null, `Stopped at ${err.message}.`);
      } else if (run.ctl.signal.aborted) {
        outcome = 'stopped';
        reason = 'you stopped it';
      } else {
        outcome = 'failed';
        reason = (err as Error).message;
        this.#note(id, null, `Failed: ${reason}`);
      }
      // Phase 52: at a limit the parts left wait (Continue with more budget picks them up).
      if (outcome !== 'limit') for (const s of this.get(id)!.steps) if (s.status === 'waiting') this.#db.prepare("UPDATE team_steps SET status = 'skipped' WHERE id = ?").run(s.id);
    }
    const report = await this.#report(this.get(id)!, outcome, reason, byId);
    this.#setTask(id, { status: outcome, report, ended_at: app.now().toISOString() });
    return this.get(id)!;
  }

  /**
   * Phase 40: commit to a new branch, push it, open the pull request (closing the issue it came
   * from), then review it and post the review. Each move is a receipt on her own "lead" part.
   */
  async #pullRequest(task: TeamTask, wsDir: string, byId: Map<string, HelperDef>): Promise<void> {
    const app = this.#app;
    const run = this.#runs.get(task.id)!;
    const currentScope = () => {
      assertCurrentScope(app, run.scope, run.ctl.signal, task.workspace, privateLocalOn());
      if (run.scope.conversation.private || privateLocalOn()) throw new ToolAdmissionError('Pull-request publication is held by the current conversation privacy policy.');
    };
    currentScope();
    const wf = task.workflow!;
    const repoPath = wf.repoPath && wf.repoPath !== '.' ? wf.repoPath : undefined;
    this.#insertStep(task.id, null, 'lead', 'Open the pull request', 'Commit, push, open the pull request, review it.', null);
    const step = this.get(task.id)!.steps.at(-1)!;
    step.status = 'running';
    step.startedAt = app.now().toISOString();
    this.#saveStep(step);
    const receipts: Receipt[] = [];
    const ctx = { workspaceDir: wsDir, signal: run.ctl.signal, sandbox: { ...app.sandbox, network: app.settings.get().shellNetwork ?? true }, conversationId: task.conversationId, companionName: app.persona.name };
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
      currentScope();
      const tool = app.tools.get(name);
      if (!tool || (tool.isAvailable && !tool.isAvailable())) throw new Error(`The ${name} tool isn't available${name.startsWith('github') ? ' (connect GitHub in Settings → Coding → GitHub)' : ''}.`);
      if (app.tools.permission(name, app.settings.get().toolPermissions) === 'never') throw new Error(`The ${name} tool is switched off in Settings.`);
      this.#note(task.id, step.id, `${app.persona.name}: ${app.redactor.redact(tool.summarize(args))}`);
      const t0 = Date.now();
      try {
        assertToolAdmission(app, run.scope, tool, run.ctl.signal, { workspace: task.workspace, privateLocal: privateLocalOn(), offServer: OFFSERVER_TOOL(name), network: ctx.sandbox.network });
        const out = app.redactor.redact(await tool.run(args, ctx));
        receipts.push({ name, status: 'ok', args, output: out });
        run.rec.tool({ id: `pr-${name}`, name, summary: app.redactor.redact(tool.summarize(args)), args: app.redactor.redactValue(args), status: 'ok', output: out, ms: Date.now() - t0, approval: 'allowed' });
        return out;
      } catch (err) {
        const denied = err instanceof ToolAdmissionError;
        receipts.push({ name, status: denied ? 'denied' : 'error', args, output: `Error: ${(err as Error).message}` });
        run.rec.tool({ id: `pr-${name}`, name, summary: app.redactor.redact(tool.summarize(args)), args: app.redactor.redactValue(args), status: denied ? 'denied' : 'error', output: app.redactor.redact(`Error: ${(err as Error).message}`), ms: Date.now() - t0, approval: denied ? 'denied' : 'allowed' });
        throw err;
      } finally {
        step.receipts = receipts;
        this.#saveStep(step);
      }
    };
    try {
      const slug = (wf.issue?.title ?? task.goal).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'change';
      const branch = `sara/${task.id}-${slug}`;
      const title = clip(wf.issue ? `${wf.issue.title} (#${wf.issue.number})` : task.goal.split('\n')[0], 72);
      await call('git_commit', { message: `${title}\n\n${wf.issue ? `Closes #${wf.issue.number}.\n\n` : ''}Made by ${app.persona.name}'s team (team task #${task.id}).`, new_branch: branch, ...(repoPath ? { path: repoPath } : {}) });
      await call('git_push', { branch, ...(repoPath ? { path: repoPath } : {}) });
      const done = this.get(task.id)!.steps.filter((s) => s.status === 'done' && s.helper !== 'lead');
      const lastTest = done.filter((s) => byId.get(s.helper)?.role === 'tester').at(-1);
      const testRun = lastTest?.receipts.filter((r) => r.name === 'shell').at(-1);
      const body = [
        wf.issue ? `Closes #${wf.issue.number}.` : '',
        `**Task:** ${clip(task.goal, 1500)}`,
        `**What the team did:**\n${done.map((s) => `- ${byId.get(s.helper)?.name ?? s.helper}: ${s.title}`).join('\n')}`,
        testRun ? `**Tests:** \`${clip(String(testRun.args.command ?? ''), 120)}\` → ${/^\[(exit code \w+)/.exec(testRun.output)?.[1] ?? testRun.status}` : '',
        `Made by ${app.persona.name}'s team in Sara (team task #${task.id}).`,
      ]
        .filter(Boolean)
        .join('\n\n');
      const opened = await call('github_open_pr', { title, body, head: branch, ...(repoPath ? { path: repoPath } : {}) });
      const url = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(opened);
      if (!url) throw new Error(`Couldn't read the pull request from: ${clip(opened, 200)}`);
      this.#setTask(task.id, { workflow: JSON.stringify({ ...this.get(task.id)!.workflow, prUrl: url[0] }) });
      // Her review of the pull request, posted on it.
      let reviewCompleted = false;
      try {
        const { getDiff, reviewDiff, formatReview, postReview } = await import('./codereview.ts');
        currentScope();
        const conv = run.scope.conversation;
        const d = await getDiff(app, ctx, { kind: 'pr', number: Number(url[2]), repo: url[1] }, repoPath);
        currentScope();
        const review = await reviewDiff(app, conv, d.diff, d.label);
        receipts.push({ name: 'review_code', status: 'ok', args: { target: 'pr', number: Number(url[2]) }, output: formatReview(review) });
        reviewCompleted = true;
        currentScope();
        const posted = await postReview(app, url[1], Number(url[2]), review, run.ctl.signal);
        receipts.push({ name: 'github_post_review', status: 'ok', args: { number: Number(url[2]) }, output: `Posted: ${posted}` });
      } catch (err) {
        receipts.push({ name: reviewCompleted ? 'github_post_review' : 'review_code', status: err instanceof ToolAdmissionError ? 'denied' : 'error', args: {}, output: `Error: ${(err as Error).message}` });
        this.#note(task.id, step.id, `The review couldn't be posted: ${(err as Error).message}`);
        if (err instanceof ToolAdmissionError) throw err;
      }
      step.status = 'done';
      step.report = `Opened ${url[0]} from ${branch}.`;
    } catch (err) {
      step.status = 'failed';
      step.report = `Failed: ${(err as Error).message}`;
      this.#note(task.id, step.id, step.report);
      throw new Error(`the pull request: ${(err as Error).message}`);
    } finally {
      step.receipts = receipts;
      step.endedAt = app.now().toISOString();
      this.#saveStep(step);
    }
  }

  /** The lead's plan: 2 to 8 parts, each for one helper. */
  async #plan(task: TeamTask, helpers: HelperDef[], wsDir: string, signal: AbortSignal): Promise<{ helper: string; title: string; instructions: string }[]> {
    const app = this.#app;
    let files = '';
    try {
      const { readdirSync } = await import('node:fs');
      files = readdirSync(wsDir, { withFileTypes: true })
        .filter((d) => !d.name.startsWith('.'))
        .slice(0, 60)
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
        .join(', ');
    } catch {
      files = '(empty)';
    }
    const usable = helpers.filter((h) => h.role !== 'agent' || app.tools.get('delegate_task')?.isAvailable?.() !== false);
    const prompt = `You lead a small team that does work in a workspace folder. The task from ${app.settings.get().ownerName?.trim() || 'the owner'}:\n"""${task.goal}"""\n\nFiles in the workspace: ${files || '(empty)'}\n\nYour helpers (use their ids):\n${usable.map((h) => `- ${h.id}: ${h.name}. ${h.blurb}`).join('\n')}\n\nSplit the task into 2 to 6 parts, in order, each done by ONE helper. Usual shape for code: coder writes it (with tests), tester runs the tests, reviewer reads it. Only the helpers the task needs. Each part's instructions must stand alone: the helper sees only them (and short reports from the parts before). Be concrete: file names, what "done" means.\nReturn ONLY JSON: {"steps":[{"helper":"<id>","title":"<short>","instructions":"<what to do>"}]}`;
    const run = this.#runs.get(task.id)!;
    assertCurrentScope(app, run.scope, signal, task.workspace, privateLocalOn());
    const conv = run.scope.conversation;
    let text = '';
    try {
      text = await complete(app, { ...conv, providerId: null, model: null }, [{ role: 'user', content: prompt }], 1500, 'planning');
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      this.#note(task.id, null, `Planning model failed (${(err as Error).message}); using the standard plan.`);
    }
    const ids = new Set(usable.map((h) => h.id));
    try {
      const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { steps?: { helper?: string; title?: string; instructions?: string }[] };
      const steps = (j.steps ?? []).filter((s) => s.helper && ids.has(s.helper) && s.instructions).slice(0, 8).map((s) => ({ helper: s.helper!, title: String(s.title ?? s.helper).slice(0, 160), instructions: String(s.instructions) }));
      if (steps.length) return steps;
    } catch {
      /* fall through to the standard plan */
    }
    return [
      { helper: 'coder', title: 'Do the task', instructions: `${task.goal}\n\nWrite tests for it if the project has tests.` },
      { helper: 'tester', title: 'Run the tests', instructions: 'Run the project tests and report the exact command and result.' },
      { helper: 'reviewer', title: 'Review the changes', instructions: `Review the changes made for: ${task.goal}` },
    ];
  }

  async #runHelper(task: TeamTask, step: TeamStep, helper: HelperDef, wsDir: string, started: number): Promise<void> {
    const app = this.#app;
    const run = this.#runs.get(task.id)!;
    const ctl = new AbortController();
    const onTask = () => ctl.abort(run.ctl.signal.reason);
    run.ctl.signal.addEventListener('abort', onTask, { once: true });
    run.step = { id: step.id, ctl };
    step.status = 'running';
    step.startedAt = app.now().toISOString();
    this.#saveStep(step);
    this.#note(task.id, step.id, `${helper.emoji} ${helper.name} started: ${step.title}`);
    const conv = app.store.getConversation(task.conversationId)!;
    const s = app.settings.get();
    const owner = s.ownerName?.trim() || 'the owner';
    try {
      const chain = resolveChain(app, { ...conv, providerId: helper.model?.providerId ?? null, model: helper.model?.model ?? null, mode: 'coding' }, helper.job);
      let ci = 0;
      const tools = app.tools.enabled(s.toolPermissions).filter((t) => helper.tools.includes(t.spec.name) && !(conv.private && OFFSERVER_TOOL(t.spec.name)));
      const before = this.get(task.id)!.steps.filter((x) => x.idx < step.idx && x.report);
      const system = [
        `You are ${helper.name}, the ${helper.role} on a small team led by ${app.persona.name}, working for ${owner}. You are a helper, not a companion: no persona, no small talk, no feelings. Do your one part, with your tools, in the workspace folder.`,
        `Your job: ${helper.blurb}\n${helper.instructions}`,
        `The whole task (for context): ${task.goal}`,
        'Rules: use tools to do real work; never say you did something a tool did not do. Paths are relative to the workspace. When your part is done, stop calling tools and reply with a short report: what you did (files, commands and their results), and anything left.',
        ...SAFETY_BOUNDARIES,
      ].join('\n\n');
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: `${before.length ? `What the team did so far:\n${before.map((x) => `- ${x.helper}: ${clip(x.report ?? '', 600)}`).join('\n')}\n\n` : ''}Your part: ${step.title}\n${step.instructions}` },
      ];
      const receipts: Receipt[] = [...step.receipts];
      let corrected = false;
      for (let round = 0; round < MAX_HELPER_ROUNDS; round++) {
        assertCurrentScope(app, run.scope, ctl.signal, task.workspace, privateLocalOn());
        if (ctl.signal.aborted) throw ctl.signal.reason;
        if (budgetCheck(teamBudget(task.limits, ['minutes']), { tokens: 0, usd: 0, ms: Date.now() - started }).reached) throw new LimitError(`the time limit (${task.limits.minutes} minutes)`);
        // Phase 52: stop before a call that would go past the budget (its input is counted roughly).
        const over = this.#overLimit(task, est(messages));
        if (over) throw new LimitError(over);
        for (const m of run.inbox.get(step.id) ?? []) messages.push({ role: 'user', content: `[Message from ${owner}, who leads this with ${app.persona.name}: ${m}]` });
        run.inbox.delete(step.id);
        let reply = '';
        const calls: ToolCall[] = [];
        const { provider, model } = chain[ci];
        // Phase 78: one step per helper move (its model call and the tools it asked for).
        run.rec.startStep({ label: `${helper.name}: ${clip(step.title, 120)}`, model, provider: provider.config.label, system: app.redactor.redact(system), memoryPicks: [] });
        const scope = usageScope.getStore();
        const was = { tokens: scope?.tokens ?? 0, reported: scope?.reported ?? 0 };
        try {
          for await (const ev of streamWithin((sig) => provider.stream({ model, messages, tools: tools.map((t) => t.spec), signal: sig, temperature: 0.3 }), ctl.signal, fallbackAfterMs(app, { provider, promptChars: promptChars(messages) }))) {
            if (ev.type === 'text') reply += ev.text;
            else if (ev.type === 'tool_call') calls.push(ev.call);
          }
        } catch (err) {
          if (!reply && !calls.length && !ctl.signal.aborted && ci < chain.length - 1) {
            ci++;
            this.#note(task.id, step.id, `${provider.config.label} (${model}) ${err instanceof SlowModelError ? `gave ${err.message}` : `failed: ${clip((err as Error).message, 120)}`}, so ${chain[ci].provider.config.label} (${chain[ci].model}) took over.`);
            round--;
            continue;
          }
          throw err;
        }
        // Real token counts when the model reported them, else the rough estimate (characters / 4).
        this.#addTokens(task, step, scope && (scope.reported ?? 0) > was.reported ? (scope.tokens ?? 0) - was.tokens : est(messages) + est(reply) + est(calls));
        if (!calls.length) {
          // The helper's claims are checked against its own receipts before the lead repeats them.
          const claims = checkClaims(reply, receipts);
          if (claims.length && !corrected) {
            corrected = true;
            this.#note(task.id, step.id, `Claims without receipts (${claims.map((c) => c.kind).join(', ')}); asked ${helper.name} to correct itself.`);
            messages.push({ role: 'assistant', content: reply }, { role: 'user', content: correctionNote(claims) });
            continue;
          }
          step.unverified = claims.map((c) => c.sentence);
          step.report = app.redactor.redact(reply.trim() || '(no report)');
          step.receipts = receipts;
          step.status = 'done';
          break;
        }
        messages.push({ role: 'assistant', content: reply, toolCalls: calls });
        for (const call of calls) {
          const out = await this.#tool(task, step, helper, tools, call, wsDir, ctl.signal);
          receipts.push(out.receipt);
          step.receipts = receipts;
          this.#saveStep(step);
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: clip(out.receipt.output, 12_000) });
          assertCurrentScope(app, run.scope, ctl.signal, task.workspace, privateLocalOn());
          if (ctl.signal.aborted) throw ctl.signal.reason;
        }
      }
      if (step.status !== 'done') {
        step.status = 'done';
        step.report = `(stopped after ${MAX_HELPER_ROUNDS} moves without a final report)`;
        step.receipts = receipts;
      }
    } catch (err) {
      step.endedAt = app.now().toISOString();
      if (ctl.signal.aborted && !run.ctl.signal.aborted) {
        step.status = 'stopped';
        this.#saveStep(step);
        return; // only this helper was stopped: the lead goes on
      }
      if (err instanceof LimitError && !run.ctl.signal.aborted) {
        // Phase 52: this part runs again if the owner continues with more budget.
        Object.assign(step, { status: 'waiting', report: null, startedAt: null, endedAt: null });
        this.#saveStep(step);
        throw err;
      }
      step.status = run.ctl.signal.aborted ? 'stopped' : 'failed';
      step.report = step.report ?? `Failed: ${(err as Error).message}`;
      this.#saveStep(step);
      throw err;
    } finally {
      run.ctl.signal.removeEventListener('abort', onTask);
      run.step = undefined;
    }
    step.endedAt = app.now().toISOString();
    this.#saveStep(step);
    this.#note(task.id, step.id, `${helper.emoji} ${helper.name} finished: ${clip(step.report ?? '', 200)}`);
  }

  /** One tool call for a helper: same permissions, approvals and private rules as her own. */
  async #tool(task: TeamTask, step: TeamStep, helper: HelperDef, tools: Tool[], call: ToolCall, wsDir: string, signal: AbortSignal): Promise<{ receipt: Receipt }> {
    const app = this.#app;
    const run = this.#runs.get(task.id)!;
    const tool = tools.find(t => t.spec.name === call.name) ?? app.tools.get(call.name);
    const summary = app.redactor.redact(tool?.summarize(call.arguments) ?? call.name);
    const network = run.scope.conversation.private || privateLocalOn() ? false : (app.settings.get().shellNetwork ?? true);
    let permission: import('./tools/types.ts').Permission = 'never';
    let admissionFailure: ToolAdmissionError | undefined;
    let explicitlyApproved = false;
    const currentAdmission = () => tool ? assertToolAdmission(app, run.scope, tool, signal, { workspace: task.workspace, privateLocal: privateLocalOn(), offServer: OFFSERVER_TOOL(call.name), network }) : 'never';
    try { permission = currentAdmission(); } catch (err) { if (!(err instanceof ToolAdmissionError)) throw err; admissionFailure = err; }
    const admit = () => {
      const fresh = currentAdmission();
      if (fresh === 'ask' && permission === 'auto' && !explicitlyApproved) throw new ToolAdmissionError('The current tool policy requires a new approval. Please request this action again.');
    };
    let status: Receipt['status'] = 'ok';
    const t0 = Date.now();
    let asked = false;
    let stopSeen: Contradiction | undefined;
    // Phase 80: the sandbox try (if any) and what the owner chose.
    let tried: SandboxResult | undefined;
    let triedRisk: CommandRisk | undefined;
    let triedDecision: SandboxDecision | undefined;
    let triedApplied: ApplyResult | undefined;
    let output = '';
    if (admissionFailure) {
      status = 'denied';
      output = admissionFailure.message;
    } else if (!tool || !tools.some((t) => t.spec.name === call.name)) {
      status = 'denied';
      output = `${helper.name} doesn't have the ${call.name} tool.`;
    } else if (permission === 'never') {
      status = 'denied';
      output = `The owner has disabled the ${call.name} tool.`;
    } else {
      try {
        admit();
        // Phase 77: helpers' calls are checked against the owner's decisions like hers (team work is
        // coding work: a clear conflict stops with the approval; fuzzy ones are noted in the log).
        // The tests-first rule is left to her own turns: a helper's run doesn't carry the turn's receipts.
        let stopFor: Contradiction | undefined;
        const cset = contradictSettings(app.settings.get());
        if (cset.on && app.memory && memorySettings(app).enabled) {
          try {
            const found = checkPlan(app.memory, { tool: call.name, args: call.arguments, callId: call.id, summary, conversationId: task.conversationId, workspaceDir: wsDir, skipShapes: ['tests-first'], now: app.now() });
            const act = gateAct(found, { settings: cset, work: true, group: false });
            stopFor = act === 'stop' ? found.find((c) => c.clear) : undefined;
            if (stopFor) stopFor.act = 'stop';
            else if (found.length) this.#note(task.id, step.id, `This may go against what you decided: "${found[0].note}"`);
          } catch (err) {
            console.warn(`plan check (team): ${(err as Error).message}`);
          }
        }
        // Phase 80 (harness M5): helpers' risky commands try a throwaway copy first, like hers.
        const gate = app.sandboxGate?.plan({ tool: call.name, args: call.arguments, coding: true, permission: permission === 'ask' ? 'ask' : 'auto', workspaceDir: wsDir, network, ...(app.persona.name && app.persona.name !== 'Sara' ? { gitName: app.persona.name } : {}) });
        const firstCard = Boolean(stopFor) || (permission === 'ask' && (!gate || gate.askFirst));
        let allowed = (permission === 'auto' && !stopFor) || (!firstCard && Boolean(gate));
        stopSeen = stopFor;
        if (firstCard) {
          asked = true;
          const { id, decision } = app.approvals.request(task.conversationId, signal);
          const shown = stopFor ? `${summary} (goes against what you decided: "${stopFor.note}")` : gate ? `${summary} (tried in a throwaway copy first${gate.isolation.isolated ? '' : ', not isolated on this computer'})` : summary;
          run.approvals.set(id, { id, stepId: step.id, helper: helper.name, tool: call.name, summary: shown, ...(stopFor ? { contradiction: cardOf(stopFor) } : {}) });
          this.#note(task.id, step.id, `Waiting for your OK: ${shown}`);
          allowed = await decision;
          explicitlyApproved = allowed;
          const how = app.approvals.takeHow(id);
          run.approvals.delete(id);
          admit();
          if (stopFor) {
            stopFor.answer = allowed ? 'override' : how === 'update' ? 'update' : 'deny';
            stopFor.status = allowed ? 'overridden' : how === 'update' ? 'update' : 'declined';
            if (allowed) app.memory?.markUsed([stopFor.memoryId], app.now().toISOString().slice(0, 10));
          }
          this.#note(task.id, step.id, allowed ? (stopFor ? 'You said do it anyway.' : 'You said yes.') : 'Not allowed.');
        }
        let decided: SandboxDecision | undefined;
        let applied: ApplyResult | undefined;
        if (allowed && gate) {
          this.#note(task.id, step.id, `${helper.name} tries it in a throwaway copy first: ${summary}`);
          try {
            admit();
            tried = await gate.run(signal);
            triedRisk = gate.risk;
            admit();
          } catch (err) {
            if (err instanceof ToolAdmissionError) throw err;
            console.warn(`sandbox try (team): ${(err as Error).message}`);
          }
          if (tried) {
            const verdict = gateVerdict(tried, permission === 'ask' && !firstCard ? 'ask' : 'auto');
            if (signal.aborted) decided = 'cancelled';
            else if (verdict.act === 'allow') decided = 'auto-applied';
            else {
              asked = true;
              const { id, decision } = app.approvals.request(task.conversationId, signal);
              const shown = `${summary} (ran in a sandbox: ${changesLine(tried.changes)}${tried.findings.filter((f) => f.severity !== 'info' && f.severity !== 'low').map((f) => `; ${f.title}`).join('')}. Allow applies it.)`;
              run.approvals.set(id, { id, stepId: step.id, helper: helper.name, tool: call.name, summary: shown, sandbox: sandboxCard(tried, gate.risk) });
              this.#note(task.id, step.id, `Waiting for your OK: ${shown}`);
              const ok = await decision;
              explicitlyApproved = ok;
              const how = app.approvals.takeHow(id);
              run.approvals.delete(id);
              admit();
              decided = !ok ? (signal.aborted ? 'cancelled' : 'discarded') : how === 'real' ? 'ran' : 'applied';
              this.#note(task.id, step.id, decided === 'discarded' ? 'You discarded the sandbox try.' : decided === 'ran' ? 'You said run it for real.' : decided === 'applied' ? 'You applied the sandbox try.' : 'Cancelled.');
            }
            if (decided === 'applied' || decided === 'auto-applied') {
              try {
                admit();
                applied = await applySandbox(tried, admit);
              } catch (err) {
                if (err instanceof ToolAdmissionError) throw err;
                decided = 'cancelled';
                status = 'error';
                output = `Error: ${(err as Error).message}`;
              }
            } else discardSandbox(tried);
            triedDecision = decided;
            triedApplied = applied;
            if (decided !== 'ran') allowed = false;
          } else if (permission === 'ask' && !firstCard) {
            asked = true;
            const { id, decision } = app.approvals.request(task.conversationId, signal);
            run.approvals.set(id, { id, stepId: step.id, helper: helper.name, tool: call.name, summary });
            allowed = await decision;
            explicitlyApproved = allowed;
            app.approvals.takeHow(id);
            run.approvals.delete(id);
            admit();
          }
        }
        if (tried && decided && decided !== 'ran') {
          if (status !== 'error') {
            if (decided !== 'applied' && decided !== 'auto-applied') status = 'denied';
            output = sandboxOutput(tried, decided, applied);
          }
        } else if (!allowed) {
          status = 'denied';
          output = signal.aborted ? 'Cancelled.' : stopFor ? `The owner declined this action: it goes against what they decided: "${stopFor.note}".` : 'The owner declined this action.';
        } else {
          admit();
          this.#note(task.id, step.id, `${helper.name}: ${summary}`);
          try {
            output = await tool.run(call.arguments, { workspaceDir: wsDir, signal, sandbox: { ...app.sandbox, network }, conversationId: task.conversationId, companionName: app.persona.name });
            // Claude Code / Grok Build run as a background job: wait for its report.
            if (call.name === 'delegate_task') output = await this.#awaitJob(output, signal);
            if (tried && decided === 'ran') output = `[tried in a sandbox copy first: ${changesLine(tried.changes)}; the owner chose to run it for real]\n${output}`;
          } catch (err) {
            status = 'error';
            output = `Error: ${err instanceof ToolError ? err.message : (err as Error).message}`;
          }
        }
      } catch (err) {
        if (!(err instanceof ToolAdmissionError)) throw err;
        if (tried) { discardSandbox(tried); triedDecision = 'cancelled'; }
        status = 'denied';
        output = err.message;
      }
    }
    output = app.redactor.redact(output);
    const sbRecord = tried && triedRisk && triedDecision ? sandboxRecord(tried, triedRisk, triedDecision, triedApplied) : undefined;
    run.rec.tool({ id: call.id, name: call.name, summary, args: app.redactor.redactValue(call.arguments), status, output, ms: Date.now() - t0, approval: asked ? (status === 'denied' ? 'denied' : 'allowed') : status === 'denied' ? 'refused' : 'auto', files: filesNamed(call.name, call.arguments), ...(stopSeen ? { contradictions: [stopSeen] } : {}), ...(sbRecord ? { sandbox: sbRecord } : {}) });
    if (sbRecord?.decision === 'discarded') run.rec.stopped('gate');
    return { receipt: { name: call.name, status, args: call.arguments, output } };
  }

  async #awaitJob(started: string, signal: AbortSignal): Promise<string> {
    const id = Number(/background job #(\d+)/.exec(started)?.[1]);
    if (!id || !this.#app.jobs) return started;
    while (!signal.aborted) {
      const j = this.#app.jobs.get(id);
      if (!j || j.status !== 'running') {
        const files = (j?.result?.files ?? {}) as { added?: string[]; changed?: string[]; removed?: string[] };
        return `Job #${id} ${j?.status ?? 'gone'} (exit code ${j?.exitCode ?? 'none'}). Files added: ${(files.added ?? []).join(', ') || 'none'}; changed: ${(files.changed ?? []).join(', ') || 'none'}; removed: ${(files.removed ?? []).join(', ') || 'none'}.\nIts report: ${String(j?.result?.summary ?? j?.tail ?? '')}`;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    this.#app.jobs.stop(id);
    return `Job #${id} stopped.`;
  }

  /** Her report in the conversation: her words, from the facts only, plus what the receipts show. */
  async #report(task: TeamTask, outcome: TaskStatus, reason: string, byId: Map<string, HelperDef>): Promise<string> {
    const app = this.#app;
    const conv = app.store.getConversation(task.conversationId);
    const names = new Map([...byId].map(([k, h]) => [k, h.name]));
    names.set('lead', app.persona.name);
    const receipts = receiptLines(task.steps, names);
    const outcomeText = { waiting: 'waiting for the owner', done: 'finished', failed: `finished with problems (${reason})`, stopped: 'stopped by the owner', limit: `stopped at ${reason}`, interrupted: 'interrupted', planning: 'not started', running: 'still running' }[outcome];
    const facts = [
      `Task: ${task.goal}`,
      `Outcome: ${outcomeText}.`,
      'Parts:',
      ...task.steps.map((s) => `- ${names.get(s.helper) ?? s.helper}, "${s.title}"${s.because ? ` (${s.because})` : ''}: ${s.status}.${s.report ? ` Report: ${clip(removeSentences(s.report, s.unverified), 700)}` : ''}${s.unverified.length ? ' (Some claims in this report had no receipts and were left out.)' : ''}`),
      'What the receipts show:',
      ...(receipts.length ? receipts.map((r) => `- ${r}`) : ['- (no files changed, no commands run)']),
      task.undo ? 'An undo point was made before the task started.' : '',
    ].filter(Boolean);
    const plain = [`Team task ${outcomeText}: ${task.goal}`, ...receipts.map((r) => `• ${r}`)].join('\n');
    let text = '';
    if (conv && outcome !== 'stopped') {
      try {
        const active = this.#runs.get(task.id);
        if (active) assertCurrentScope(app, active.scope, active.ctl.signal, task.workspace, privateLocalOn());
        const s = app.settings.get();
        const owner = s.ownerName?.trim() || 'the owner';
        const system = buildSystemPrompt(app.persona, { now: app.now(), timeZone: s.timeZone, ownerName: s.ownerName });
        text = (await complete(app, conv, [{ role: 'system', content: system }, { role: 'user', content: `[Note from the app, not from ${owner}: your team finished a task you led. Tell ${owner} how it went in a short message: what got done, what the tests and the review showed, and anything left or failing. Use ONLY these facts; never add work that isn't in them. Don't paste the list of receipts (the app adds it).\n${facts.join('\n')}]` }], 600, 'quick')).trim();
      } catch {
        text = '';
      }
      // Her words are held to the same receipts as the helpers'.
      const all = task.steps.flatMap((s) => s.receipts);
      if (text && checkClaims(text, all).length) text = '';
    }
    const body = `${text || plain}\n\nWhat actually happened:\n${receipts.length ? receipts.map((r) => `• ${r}`).join('\n') : '• No files changed and no commands ran.'}${outcome === 'limit' ? `\n\nI stopped at ${reason} so it doesn't go past it. The parts left are waiting: press "Continue with more budget" to carry on.` : ''}`;
    if (conv) {
      const msg = app.store.addMessage(conv.id, 'assistant', app.redactor.redact(body), { team: { id: task.id, status: outcome } });
      app.events?.publish({ type: 'message', conversationId: conv.id, message: msg, reason: 'job' });
    }
    return body;
  }
}

class LimitError extends Error {}

/** A report without the sentences that had no receipts. */
function removeSentences(report: string, bad: string[]): string {
  let out = report;
  for (const s of bad) out = out.replace(s, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

/** Sara's tools: start a team task, and check on one. */
export function createTeamTools(app: () => AppContext): Tool[] {
  const start: Tool = {
    defaultPermission: 'ask',
    spec: {
      name: 'team_task',
      description:
        'Lead a team on a bigger, multi-part job (e.g. build a feature with tests and a review, research and write a report). You plan it, helpers (researcher, coder, tester, reviewer, writer, designer, Claude Code / Grok Build) do the parts, failures go back for fixes, and you report what the receipts show when it ends. Runs in the background; you get the report here. For small things, do them yourself instead.',
      parameters: { type: 'object', properties: { goal: { type: 'string', description: 'The whole task, clearly: what to build or find, where, and what "done" means.' }, minutes: { type: 'integer', description: 'Time limit in minutes (default from settings, max 240).' } }, required: ['goal'] },
    },
    isAvailable: () => Boolean(app().team),
    summarize: (a) => `Team task: ${clip(String(a.goal ?? ''), 160)}`,
    async run(args, ctx) {
      const a = app();
      if (!a.team || !ctx.conversationId) throw new ToolError('Teams need a conversation.');
      const t = a.team.start(ctx.conversationId, String(args.goal ?? ''), args.minutes ? { limits: { minutes: Number(args.minutes) } } : {});
      return `Team task #${t.id} started (limits: ${t.limits.minutes} minutes, about ${t.limits.tokens.toLocaleString('en-US')} tokens). It runs in the background; the plan and progress are on the Team page, and your report will come here when it ends. Don't describe results before then.`;
    },
  };
  const status: Tool = {
    defaultPermission: 'auto',
    spec: { name: 'team_status', description: 'Check on a team task: its parts, who is doing what, and the latest log lines.', parameters: { type: 'object', properties: { task_id: { type: 'integer', description: 'Default: the latest task.' } } } },
    isAvailable: () => Boolean(app().team),
    summarize: (a) => `Checking team task${a.task_id ? ` #${a.task_id}` : ''}`,
    async run(args) {
      const a = app();
      const t = args.task_id ? a.team!.get(Number(args.task_id)) : a.team!.list(1)[0];
      if (!t) throw new ToolError('No team task yet.');
      const names = new Map(teamHelpers(a).map((h) => [h.id, h.name]));
      return [`Team task #${t.id} (${t.status}): ${t.goal}`, ...t.steps.map((s) => `${s.idx + 1}. ${names.get(s.helper) ?? s.helper}: ${s.title} [${s.status}]`), 'Latest:', ...a.team!.log(t.id, 6).map((l) => `- ${l.text}`)].join('\n');
    },
  };
  return [start, status];
}
