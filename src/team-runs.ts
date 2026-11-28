// S8 (docs/AGENT_TEAMS.md): agent teams. A team run is one big job split between helpers that work
// in parallel where their parts don't depend on each other. It builds on what Sara already had:
// the team's helpers and budgets (src/team.ts), model routing (resolveChain: Auto by default, local
// models only in private), tool admission, receipts and claim checks (src/receipts.ts), run records
// (src/runs.ts), usage metering and make_document (src/documents/make.ts).
//
// The flow: she proposes a plan (roles with a model, a tool allowlist and a budget each; steps with
// dependencies; one deliverable) → the person edits it and approves it ONCE → helpers run (at most 3
// at a time), writing findings with sources to a shared scratchpad → the checker checks the draft
// against the findings and the receipts and sends fixes back (2 rounds at most) → one deliverable
// (a document or a message) → every action outside reading and writing drafts (sending, posting,
// buying, computer use) was queued during the run and waits for ONE final approval card.
//
// Table (additive, the space's own store.db): team_runs (one row per run; plan, steps, scratchpad,
// checks, actions and log as JSON).
import type { DatabaseSync } from 'node:sqlite';
import { type AppContext, fallbackAfterMs, OFFSERVER_TOOL, promptChars, resolveChain, streamWithin } from './chat.ts';
import { makeDocument } from './documents/make.ts';
import { FORMATS, type DocFormat } from './documents/spec.ts';
import { en } from './i18n.ts';
import { complete } from './life.ts';
import { privateLocalOn } from './net-guard.ts';
import { interruptible } from './pending.ts';
import { SAFETY_BOUNDARIES } from './persona.ts';
import { TeamRecipes } from './team-recipes.ts';
import { onThisComputer } from './private-local.ts';
import type { ChatMessage, ToolCall } from './providers/types.ts';
import { checkClaims, type Receipt } from './receipts.ts';
import { RunRecorder } from './runs.ts';
import type { RoutePurpose } from './settings.ts';
import { assertToolAdmission, captureToolScope, ToolAdmissionError, type ToolScope } from './tool-admission.ts';
import type { ToolSpec } from './providers/types.ts';
import type { Tool } from './tools/types.ts';
import { workspaceDir, workspacesBase } from './tools/workspace.ts';
import { usageScope, type UsageScope } from './usage.ts';

export const TEAM_RUN = { maxRoles: 6, maxSteps: 10, parallel: 3, maxCheckRounds: 2, maxMoves: 12, maxLive: 2 } as const;
export type RoleKind = 'researcher' | 'drafter' | 'checker' | 'custom';
export interface RoleBudget {
  tokens: number;
  minutes: number;
  /** Dollars (estimated from the price table); 0 = none. */
  usd: number;
}
export interface RunRole {
  id: string;
  name: string;
  kind: RoleKind;
  instructions: string;
  /** 'auto' = the job's usual model (Settings → Which model does what). */
  model: 'auto' | { providerId: string; model: string };
  tools: string[];
  /** Computer use (pc_* tools) only when the person ticks it; its actions still wait for the final OK. */
  computer: boolean;
  budget: RoleBudget;
}
export interface RunStepPlan {
  id: string;
  role: string;
  title: string;
  instructions: string;
  after: string[];
}
export interface RunPlan {
  goal: string;
  roles: RunRole[];
  steps: RunStepPlan[];
  deliver: { kind: 'document' | 'message'; format: DocFormat; title: string };
  /** The whole run's budget (the roles' budgets added up), shown up front. */
  limits: RoleBudget;
}
export type RunStatus = 'proposed' | 'running' | 'paused' | 'waiting' | 'done' | 'failed' | 'stopped' | 'limit' | 'interrupted';
export type StepState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped' | 'stopped';
export interface RunStep extends RunStepPlan {
  status: StepState;
  report: string | null;
  receipts: Receipt[];
  tokens: number;
  usd: number;
  /** How many times it ran (fix rounds add one). */
  runs: number;
  startedAt: string | null;
  endedAt: string | null;
}
export interface Finding {
  n: number;
  step: string;
  role: string;
  text: string;
  source: string;
  at: string;
}
export interface CheckRound {
  round: number;
  ok: boolean;
  fixes: string[];
  /** Still not right after the last round: said in the deliverable, not hidden. */
  open: boolean;
}
export interface QueuedAction {
  n: number;
  step: string;
  role: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  status: 'queued' | 'done' | 'skipped' | 'denied' | 'error';
  output: string | null;
}
export interface TeamRun {
  id: number;
  conversationId: string;
  goal: string;
  status: RunStatus;
  plan: RunPlan;
  steps: RunStep[];
  notes: Finding[];
  checks: CheckRound[];
  actions: QueuedAction[];
  log: { at: string; text: string }[];
  result: { kind: 'document'; docId: number; title: string; format: DocFormat } | { kind: 'message'; messageId: number } | null;
  tokens: number;
  usd: number;
  runId: number | null;
  error: string | null;
  createdAt: string;
  endedAt: string | null;
}

export class TeamRunError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
class LimitError extends Error {}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const est = (x: unknown) => Math.ceil((typeof x === 'string' ? x.length : JSON.stringify(x ?? '').length) / 4);
const KINDS: RoleKind[] = ['researcher', 'drafter', 'checker', 'custom'];
const JOB: Record<RoleKind, RoutePurpose> = { researcher: 'research', drafter: 'writing', checker: 'writing', custom: 'writing' };
const DEFAULT_TOOLS: Record<RoleKind, string[]> = {
  researcher: ['web_search', 'web_fetch', 'read_file', 'list_dir', 'search', 'search_library', 'library', 'ask_everything'],
  drafter: ['read_file', 'list_dir', 'write_file', 'edit_file'],
  checker: ['read_file', 'list_dir', 'web_fetch', 'search_library'],
  custom: ['read_file', 'list_dir'],
};
const DEFAULT_BUDGET: Record<RoleKind, RoleBudget> = {
  researcher: { tokens: 80_000, minutes: 10, usd: 0 },
  drafter: { tokens: 60_000, minutes: 10, usd: 0 },
  checker: { tokens: 30_000, minutes: 5, usd: 0 },
  custom: { tokens: 40_000, minutes: 10, usd: 0 },
};
/** Writing drafts: run during the run (the plan's approval covers them). */
const DRAFT_TOOLS = new Set(['write_file', 'edit_file', 'add_note', 'update_note']);

/**
 * Tools a helper on a team run never gets, even when the person adds them by hand: commands and
 * agents (anything that runs code), sign-ins and saved logins, settings, her character and memory
 * deletion, other teams or crews, live phone calls and deletes.
 */
export function HARD_LIMIT_TOOL(name: string, tool?: Pick<Tool, 'runsCommands'>): boolean {
  if (tool?.runsCommands) return true;
  return /^(shell|ssh_|start_job|delegate_task|team_|crew|worktree_|uv$|preview_start|change_setting|tune_personality|fact_forget|delete_|skill_(update|run)|automation_create|pc_run|pc_checkup_apply|pc_browser_(login|save_login|request)|phone_call|a2a_send|safety_report|my_details)/.test(name);
}

/** What a tool call is on a team run: reading, writing a draft, or an action for the final OK. */
export function toolKind(name: string, tool?: Tool): 'read' | 'draft' | 'action' {
  if (name.startsWith('pc_')) return 'action';
  if (DRAFT_TOOLS.has(name)) return 'draft';
  return interruptible(name, tool) ? 'read' : 'action';
}

/** The tools a role may be given in the plan editor (hard-limit tools never listed). */
export function teamRunTools(app: AppContext, priv: boolean): { name: string; kind: 'read' | 'draft' | 'action'; computer: boolean }[] {
  const perms = app.settings.get().toolPermissions;
  return app.tools
    .list()
    .filter((t) => (!t.isAvailable || t.isAvailable()) && !HARD_LIMIT_TOOL(t.spec.name, t) && app.tools.permission(t.spec.name, perms) !== 'never' && !(priv && OFFSERVER_TOOL(t.spec.name)))
    .map((t) => ({ name: t.spec.name, kind: toolKind(t.spec.name, t), computer: t.spec.name.startsWith('pc_') }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

const NOTE_SPEC: ToolSpec = {
  name: 'note_finding',
  description: "Put one finding on the team's shared scratchpad: a fact you found, and its source (the URL, file or document it came from). Every fact the team uses must be noted with its source.",
  parameters: { type: 'object', properties: { text: { type: 'string', description: 'The fact, in one or two sentences.' }, source: { type: 'string', description: 'Where it came from: a URL, a file path or a document name.' } }, required: ['text', 'source'] },
};

/** The verdict line a checker ends with: "VERDICT: OK" or "VERDICT: FIX: <what to change>". */
export function checkVerdict(report: string | null): { ok: boolean; detail: string } | undefined {
  const line = [...(report ?? '').matchAll(/^\s*\**VERDICT:\**\s*(.+)$/gim)].at(-1)?.[1]?.trim();
  if (!line) return undefined;
  if (/^(OK|APPROVE|PASS)/i.test(line)) return { ok: true, detail: line };
  return { ok: false, detail: line.replace(/^(FIX(ES)?|CHANGES NEEDED|FAIL(ED)?)\s*:?\s*/i, '') };
}

const cleanBudget = (v: unknown, base: RoleBudget): RoleBudget => {
  const b = (v ?? {}) as Partial<Record<keyof RoleBudget, unknown>>;
  const n = (x: unknown, d: number, lo: number, hi: number) => (x === undefined || x === null || x === '' || !Number.isFinite(Number(x)) ? d : Math.min(hi, Math.max(lo, Number(x))));
  return { tokens: Math.round(n(b.tokens, base.tokens, 1_000, 2_000_000)), minutes: Math.round(n(b.minutes, base.minutes, 1, 120)), usd: Math.round(n(b.usd, base.usd, 0, 1_000) * 100) / 100 };
};

/**
 * A plan as she proposed it or the person edited it, made safe: known tools only, never a hard-limit
 * tool, computer use only when ticked (never from her own proposal), outside tools and cloud models
 * left out in private, steps that point at real roles and earlier work with no loops.
 */
export function cleanRunPlan(app: AppContext, raw: unknown, o: { private: boolean; fromModel?: boolean; goal?: string }): RunPlan {
  const p = (raw ?? {}) as Record<string, unknown>;
  const goal = clip(String(o.goal ?? p.goal ?? '').trim(), 4000);
  const perms = app.settings.get().toolPermissions;
  const known = new Map(app.tools.list().map((t) => [t.spec.name, t]));
  const usable = (name: string, computer: boolean): boolean => {
    const t = known.get(name);
    if (!t || (t.isAvailable && !t.isAvailable())) return false;
    if (HARD_LIMIT_TOOL(name, t) || app.tools.permission(name, perms) === 'never') return false;
    if (name.startsWith('pc_') && !computer) return false;
    if (o.private && OFFSERVER_TOOL(name)) return false;
    return true;
  };
  const providers = app.settings.get().providers ?? [];
  const rolesRaw = Array.isArray(p.roles) ? p.roles.slice(0, TEAM_RUN.maxRoles) : [];
  const ids = new Set<string>();
  const roles: RunRole[] = rolesRaw.map((x, i) => {
    const r = (x ?? {}) as Record<string, unknown>;
    const kind: RoleKind = KINDS.includes(r.kind as RoleKind) ? (r.kind as RoleKind) : 'custom';
    let id = typeof r.id === 'string' && /^[\w-]{1,24}$/.test(r.id) ? r.id : `role${i + 1}`;
    while (ids.has(id)) id = `${id}-${i + 1}`;
    ids.add(id);
    const name = String(r.name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || kind[0].toUpperCase() + kind.slice(1);
    const computer = !o.fromModel && r.computer === true;
    const asked = Array.isArray(r.tools) ? r.tools.map(String) : DEFAULT_TOOLS[kind];
    const tools = [...new Set(asked)].filter((t) => usable(t, computer)).slice(0, 20);
    let model: RunRole['model'] = 'auto';
    const m = r.model as { providerId?: unknown; model?: unknown } | undefined;
    if (m && typeof m === 'object' && m.providerId && m.model) {
      const cfg = providers.find((pr) => pr.id === String(m.providerId));
      if (cfg && (!o.private || onThisComputer(cfg, String(m.model)))) model = { providerId: cfg.id, model: String(m.model).slice(0, 200) };
    }
    return { id, name, kind, instructions: String(r.instructions ?? '').trim().slice(0, 2000), model, tools, computer, budget: cleanBudget(r.budget, DEFAULT_BUDGET[kind]) };
  });
  if (!roles.length) throw new TeamRunError(400, en('A team needs at least one helper.'));
  const stepsRaw = Array.isArray(p.steps) ? p.steps.slice(0, TEAM_RUN.maxSteps) : [];
  const sids = new Set<string>();
  const steps: RunStepPlan[] = [];
  stepsRaw.forEach((x, i) => {
    const s = (x ?? {}) as Record<string, unknown>;
    const role = String(s.role ?? '');
    if (!ids.has(role)) {
      if (o.fromModel) return; // her plan named a helper that isn't there: leave the part out
      throw new TeamRunError(400, en('Each part needs one of the helpers.'));
    }
    let id = typeof s.id === 'string' && /^[\w-]{1,24}$/.test(s.id) ? s.id : `s${i + 1}`;
    while (sids.has(id)) id = `${id}-${i + 1}`;
    sids.add(id);
    const title = String(s.title ?? '').trim().slice(0, 120) || `Part ${i + 1}`;
    steps.push({ id, role, title, instructions: String(s.instructions ?? '').trim().slice(0, 3000) || title, after: Array.isArray(s.after) ? [...new Set(s.after.map(String))] : [] });
  });
  if (!steps.length) throw new TeamRunError(400, en('A team needs at least one part to do.'));
  for (const s of steps) {
    if (s.after.some((a) => !sids.has(a) || a === s.id)) {
      if (o.fromModel) s.after = s.after.filter((a) => sids.has(a) && a !== s.id);
      else throw new TeamRunError(400, en('A part can only wait for other parts of this plan.'));
    }
  }
  // No loops: every part must be reachable in dependency order.
  const done = new Set<string>();
  for (let pass = 0; pass <= steps.length && done.size < steps.length; pass++) for (const s of steps) if (!done.has(s.id) && s.after.every((a) => done.has(a))) done.add(s.id);
  if (done.size < steps.length) throw new TeamRunError(400, en('These parts wait for each other in a circle. Change what each one waits for.'));
  const d = (p.deliver ?? {}) as Record<string, unknown>;
  const format = (FORMATS as readonly string[]).includes(String(d.format)) ? (String(d.format) as DocFormat) : 'docx';
  const deliver = { kind: d.kind === 'document' ? ('document' as const) : ('message' as const), format, title: String(d.title ?? '').trim().slice(0, 120) || clip(goal || 'Team run', 80) };
  const limits: RoleBudget = {
    tokens: roles.reduce((n, r) => n + r.budget.tokens * Math.max(1, steps.filter((s) => s.role === r.id).length), 0),
    minutes: Math.min(240, roles.reduce((n, r) => n + r.budget.minutes, 0)),
    usd: Math.round(roles.reduce((n, r) => n + r.budget.usd, 0) * 100) / 100,
  };
  return { goal, roles, steps, deliver, limits };
}

type Row = Record<string, string | number | null>;
interface Live {
  ctl: AbortController;
  run: TeamRun;
  paused: boolean;
  wake: (() => void)[];
  limit?: string;
  rec: RunRecorder;
  scope: ToolScope;
  done: Promise<TeamRun>;
  started: number;
}

export class TeamRuns {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #live = new Map<number, Live>();
  /** U3.16: saved team recipes (the plan's shape, {job} for the job text). */
  readonly recipes: TeamRecipes;

  constructor(app: AppContext, db: DatabaseSync) {
    this.#app = app;
    this.#db = db;
    this.recipes = new TeamRecipes(app, db);
    db.exec(`
CREATE TABLE IF NOT EXISTS team_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  plan TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '[]',
  checks TEXT NOT NULL DEFAULT '[]',
  actions TEXT NOT NULL DEFAULT '[]',
  log TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0,
  run_id INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS team_runs_conv ON team_runs(conversation_id, id);
`);
    // A run that was going when the server stopped: what it found and drafted stays; it doesn't restart by itself.
    db.prepare("UPDATE team_runs SET status = 'interrupted', ended_at = ? WHERE status IN ('running', 'paused')").run(app.now().toISOString());
  }

  #view(r: Row): TeamRun {
    const j = <T>(k: string, d: T): T => (r[k] === null || r[k] === undefined ? d : (JSON.parse(String(r[k])) as T));
    return {
      id: Number(r.id),
      conversationId: String(r.conversation_id),
      goal: String(r.goal),
      status: String(r.status) as RunStatus,
      plan: j<RunPlan>('plan', {} as RunPlan),
      steps: j<RunStep[]>('steps', []),
      notes: j<Finding[]>('notes', []),
      checks: j<CheckRound[]>('checks', []),
      actions: j<QueuedAction[]>('actions', []),
      log: j<{ at: string; text: string }[]>('log', []),
      result: j<TeamRun['result']>('result', null),
      tokens: Number(r.tokens),
      usd: Number(r.usd),
      runId: r.run_id === null ? null : Number(r.run_id),
      error: r.error === null ? null : String(r.error),
      createdAt: String(r.created_at),
      endedAt: r.ended_at === null ? null : String(r.ended_at),
    };
  }

  get(id: number): TeamRun | undefined {
    const r = this.#db.prepare('SELECT * FROM team_runs WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#view(r) : undefined;
  }

  list(limit = 20): TeamRun[] {
    return (this.#db.prepare('SELECT * FROM team_runs ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map((r) => this.#view(r));
  }

  #save(run: TeamRun): void {
    this.#db
      .prepare('UPDATE team_runs SET status = ?, plan = ?, steps = ?, notes = ?, checks = ?, actions = ?, log = ?, result = ?, tokens = ?, usd = ?, run_id = ?, error = ?, ended_at = ? WHERE id = ?')
      .run(run.status, JSON.stringify(run.plan), JSON.stringify(run.steps), JSON.stringify(run.notes), JSON.stringify(run.checks), JSON.stringify(run.actions), JSON.stringify(run.log.slice(-300)), run.result ? JSON.stringify(run.result) : null, Math.round(run.tokens), run.usd, run.runId, run.error, run.endedAt, run.id);
    this.#app.events?.publish({ type: 'team-run', run: { id: run.id, status: run.status, conversationId: run.conversationId } });
  }

  #note(run: TeamRun, text: string): void {
    run.log.push({ at: this.#app.now().toISOString(), text: this.#app.redactor.redact(clip(text, 600)) });
    this.#save(run);
  }

  /** The run being worked on (in memory while live, else from the table). */
  #current(id: number): TeamRun {
    const run = this.#live.get(id)?.run ?? this.get(id);
    if (!run) throw new TeamRunError(404, en('No such team run.'));
    return run;
  }

  #private(conversationId: string): boolean {
    return Boolean(this.#app.store.getConversation(conversationId)?.private) || privateLocalOn();
  }

  /** She proposes the plan. Nothing runs until the person approves it. */
  async propose(conversationId: string, goal: string, o: { deliver?: 'document' | 'message'; format?: string; recipe?: number } = {}): Promise<TeamRun> {
    const app = this.#app;
    const conv = app.store.getConversation(conversationId);
    if (!conv) throw new TeamRunError(404, en('No such conversation.'));
    if (conv.partner) throw new TeamRunError(400, en('Not in a chat with someone else.'));
    const g = goal.trim();
    if (g.length < 8 || g.length > 4000) throw new TeamRunError(400, en('Describe the job in 8 to 4000 characters.'));
    const priv = this.#private(conversationId);
    // U3.16: from a recipe: its plan with {job} filled, no planning call; still approved once.
    const fromRecipe = o.recipe === undefined ? undefined : cleanRunPlan(app, this.recipes.planFor(o.recipe, g), { private: priv, goal: g });
    const perms = app.settings.get().toolPermissions;
    const tools = app.tools.list().filter((t) => (!t.isAvailable || t.isAvailable()) && !HARD_LIMIT_TOOL(t.spec.name, t) && app.tools.permission(t.spec.name, perms) !== 'never' && !t.spec.name.startsWith('pc_') && !(priv && OFFSERVER_TOOL(t.spec.name)));
    const prompt = `You plan a team run for a big job. The job from ${app.settings.get().ownerName?.trim() || 'the owner'}:\n"""${g}"""\n\nTools helpers may have: ${tools.map((t) => t.spec.name).join(', ')}.\nRoles: researcher (finds facts with sources), drafter (writes the deliverable from the findings), checker (checks every claim against the sources), or custom (say what it does).\n\nSplit the job into 2 to 6 parts. Parts that don't need each other's results run at the same time; \"after\" lists the parts a part must wait for. Usually: one or more research parts, then a draft after them, then a check after the draft. Give each role only the tools it needs. Sending, posting or buying is queued for one final approval at the end.\nReturn ONLY JSON: {"roles":[{"id":"r","name":"Researcher","kind":"researcher","instructions":"…","tools":["web_search"]}],"steps":[{"id":"s1","role":"r","title":"…","instructions":"…","after":[]}],"deliver":{"kind":"document|message","format":"docx|pdf|md","title":"…"}}`;
    let plan: RunPlan;
    if (fromRecipe) plan = fromRecipe;
    else {
      let text = '';
      try {
        text = await complete(app, { ...conv, providerId: null, model: null }, [{ role: 'user', content: prompt }], 1800, 'planning');
      } catch (err) {
        console.warn(`team runs: planning model failed: ${(err as Error).message}`);
      }
      try {
        const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, unknown>;
        if (o.deliver) j.deliver = { ...((j.deliver as object) ?? {}), kind: o.deliver, ...(o.format ? { format: o.format } : {}) };
        plan = cleanRunPlan(app, j, { private: priv, fromModel: true, goal: g });
      } catch {
        plan = cleanRunPlan(app, standardPlan(g, o), { private: priv, fromModel: true, goal: g });
      }
    }
    const now = app.now().toISOString();
    const steps: RunStep[] = plan.steps.map((s) => ({ ...s, status: 'waiting', report: null, receipts: [], tokens: 0, usd: 0, runs: 0, startedAt: null, endedAt: null }));
    const id = Number(this.#db.prepare("INSERT INTO team_runs (conversation_id, goal, status, plan, steps, log, created_at) VALUES (?, ?, 'proposed', ?, ?, ?, ?)").run(conv.id, g, JSON.stringify(plan), JSON.stringify(steps), JSON.stringify([{ at: now, text: 'Plan proposed.' }]), now).lastInsertRowid);
    const msg = app.store.addMessage(conv.id, 'notice', `teamrun:${clip(g.replace(/\s+/g, ' '), 120)}`, { teamRun: { id } });
    app.events?.publish({ type: 'message', conversationId: conv.id, message: msg, reason: 'job' });
    const run = this.get(id)!;
    this.#save(run);
    return run;
  }

  /** The person changes the plan (only before it is approved). */
  edit(id: number, plan: unknown): TeamRun {
    const run = this.#current(id);
    if (run.status !== 'proposed') throw new TeamRunError(409, en('This plan was already approved.'));
    run.plan = cleanRunPlan(this.#app, plan, { private: this.#private(run.conversationId), goal: run.goal });
    run.steps = run.plan.steps.map((s) => ({ ...s, status: 'waiting', report: null, receipts: [], tokens: 0, usd: 0, runs: 0, startedAt: null, endedAt: null }));
    this.#note(run, 'Plan changed.');
    return this.get(id)!;
  }

  /** The one approval of the plan: the run starts. */
  approve(id: number): TeamRun {
    const run = this.#current(id);
    if (run.status !== 'proposed') throw new TeamRunError(409, en('This plan was already approved.'));
    if (this.#live.size >= TEAM_RUN.maxLive) throw new TeamRunError(409, en('Two team runs are already working. Wait for one, or stop one.'));
    const conv = this.#app.store.getConversation(run.conversationId);
    if (!conv) throw new TeamRunError(404, en('No such conversation.'));
    run.status = 'running';
    run.log.push({ at: this.#app.now().toISOString(), text: `Plan approved by ${this.#app.settings.get().ownerName?.trim() || 'the owner'}.` });
    const rec = this.#app.runs ? new RunRecorder(this.#app.runs, { kind: 'team', conversationId: conv.id, title: clip(`Team run: ${run.goal}`, 120), budget: run.plan.limits }) : RunRecorder.none();
    if (rec.on) run.runId = rec.id;
    this.#save(run);
    const live: Live = { ctl: new AbortController(), run, paused: false, wake: [], rec, scope: captureToolScope(conv, conv.workspace, privateLocalOn()), done: Promise.resolve(run), started: Date.now() };
    this.#live.set(id, live);
    live.done = usageScope
      .run({ purpose: 'team', conversationId: conv.id, ...(rec.on ? { runId: rec.id, onCall: (c) => rec.modelCall(c) } : {}) }, () => this.#run(live))
      .then((r) => {
        rec.close(r.status === 'done' || r.status === 'waiting' ? 'ok' : r.status === 'limit' ? 'limit' : r.status === 'stopped' ? 'stopped' : 'error');
        return r;
      })
      .finally(() => this.#live.delete(id));
    return this.get(id)!;
  }

  async finished(id: number): Promise<TeamRun> {
    await this.#live.get(id)?.done;
    return this.get(id)!;
  }

  live(): number[] {
    return [...this.#live.keys()];
  }

  pause(id: number): boolean {
    const l = this.#live.get(id);
    if (!l || l.paused || l.run.status !== 'running') return false;
    l.paused = true;
    l.run.status = 'paused';
    this.#note(l.run, 'Paused: no new parts start; helpers stop before their next move.');
    return true;
  }

  resume(id: number): boolean {
    const l = this.#live.get(id);
    if (!l || !l.paused) return false;
    l.paused = false;
    l.run.status = 'running';
    this.#note(l.run, 'Going on.');
    for (const w of l.wake.splice(0)) w();
    return true;
  }

  stop(id: number): boolean {
    const l = this.#live.get(id);
    if (l) {
      l.run.log.push({ at: this.#app.now().toISOString(), text: 'Stopped by you.' });
      l.ctl.abort(new Error('stopped'));
      for (const w of l.wake.splice(0)) w();
      return true;
    }
    const run = this.get(id);
    if (run && (run.status === 'proposed' || run.status === 'waiting')) {
      run.status = 'stopped';
      run.endedAt = this.#app.now().toISOString();
      for (const a of run.actions) if (a.status === 'queued') a.status = 'skipped';
      this.#note(run, 'Stopped by you.');
      return true;
    }
    return false;
  }

  async #gate(l: Live): Promise<void> {
    while (l.paused && !l.ctl.signal.aborted) await new Promise<void>((res) => l.wake.push(res));
    if (l.ctl.signal.aborted) throw l.ctl.signal.reason;
  }

  async #run(l: Live): Promise<TeamRun> {
    const run = l.run;
    try {
      await this.#schedule(l);
      if (l.ctl.signal.aborted) throw l.ctl.signal.reason;
      const failed = run.steps.filter((s) => s.status === 'failed');
      await this.#deliver(l);
      run.status = run.actions.some((a) => a.status === 'queued') ? 'waiting' : failed.length ? 'failed' : 'done';
      if (run.status === 'waiting') run.log.push({ at: this.#app.now().toISOString(), text: `Waiting for your one OK on ${run.actions.length} action${run.actions.length === 1 ? '' : 's'}.` });
      else run.endedAt = this.#app.now().toISOString();
      if (failed.length) run.error = `${failed.length} part(s) failed`;
    } catch (err) {
      run.endedAt = this.#app.now().toISOString();
      if (l.limit) {
        run.status = 'limit';
        run.log.push({ at: run.endedAt, text: `Stopped at ${l.limit}. What was found and drafted so far is kept.` });
      } else if (l.ctl.signal.aborted) run.status = 'stopped';
      else {
        run.status = 'failed';
        run.error = clip((err as Error).message, 300);
        run.log.push({ at: run.endedAt, text: `Failed: ${run.error}` });
      }
      for (const s of run.steps) if (s.status === 'running') Object.assign(s, { status: 'stopped', endedAt: run.endedAt });
    }
    this.#save(run);
    return this.get(run.id)!;
  }

  /** Runs the parts in dependency order, up to 3 at a time. */
  async #schedule(l: Live): Promise<void> {
    const run = l.run;
    const active = new Map<string, Promise<void>>();
    let firstError: unknown;
    const byId = new Map(run.steps.map((s) => [s.id, s]));
    for (;;) {
      if (l.ctl.signal.aborted) break;
      for (const s of run.steps) if (s.status === 'waiting' && s.after.some((a) => ['failed', 'skipped', 'stopped'].includes(byId.get(a)?.status ?? 'skipped'))) Object.assign(s, { status: 'skipped', report: 'Skipped: a part it waits for did not finish.' });
      if (!l.paused) {
        for (const s of run.steps) {
          if (active.size >= TEAM_RUN.parallel) break;
          if (s.status !== 'waiting' || active.has(s.id) || !s.after.every((a) => byId.get(a)?.status === 'done')) continue;
          const p = this.#part(l, s)
            .catch((err) => {
              firstError ??= err;
              if (err instanceof LimitError) {
                l.limit ??= err.message;
                l.ctl.abort(err);
              }
            })
            .finally(() => active.delete(s.id));
          active.set(s.id, p);
        }
      }
      if (!active.size) {
        if (l.paused) {
          await this.#gate(l);
          continue;
        }
        break;
      }
      await Promise.race(active.values());
    }
    await Promise.allSettled(active.values());
    if (l.limit) throw new LimitError(l.limit);
    if (l.ctl.signal.aborted) throw l.ctl.signal.reason;
    void firstError;
  }

  /** One part, and for a checker the fix rounds. */
  async #part(l: Live, step: RunStep): Promise<void> {
    await this.#helper(l, step);
    const role = l.run.plan.roles.find((r) => r.id === step.role);
    if (role?.kind === 'checker' && step.status === 'done') await this.#checkLoop(l, step);
  }

  async #checkLoop(l: Live, checker: RunStep): Promise<void> {
    const run = l.run;
    const kindOf = (s: RunStep) => run.plan.roles.find((r) => r.id === s.role)?.kind;
    const drafts = run.steps.filter((s) => checker.after.includes(s.id) && kindOf(s) !== 'checker' && s.status === 'done');
    for (let round = 0; ; round++) {
      const v = checkVerdict(checker.report);
      const draft = drafts.map((d) => d.report ?? '').join('\n\n');
      // The draft's claims are held to the run's receipts, and its citations to the scratchpad.
      const unsupported = checkClaims(draft, run.steps.flatMap((s) => s.receipts)).map((c) => `No receipt backs: "${clip(c.sentence, 160)}"`);
      const bad = [...new Set([...draft.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])).filter((n) => n < 1 || n > run.notes.length))];
      const fixes = [...(v && !v.ok ? [v.detail] : []), ...unsupported, ...(bad.length ? [`Citations ${bad.map((n) => `[${n}]`).join(' ')} point at no finding on the scratchpad.`] : [])];
      const ok = fixes.length === 0;
      run.checks.push({ round: round + 1, ok, fixes, open: !ok && round >= TEAM_RUN.maxCheckRounds });
      if (ok || round >= TEAM_RUN.maxCheckRounds || !drafts.length) {
        this.#note(run, ok ? 'The checker found every claim backed by its sources.' : `Still open after ${TEAM_RUN.maxCheckRounds} fix rounds: ${clip(fixes.join(' · '), 300)}`);
        return;
      }
      this.#note(run, `The checker sent fixes back (round ${round + 1} of ${TEAM_RUN.maxCheckRounds}).`);
      const ask = `The checker asks for these fixes:\n${fixes.map((f) => `- ${f}`).join('\n')}\nRewrite your whole part with them; keep the citations [n] to the scratchpad.`;
      for (const d of drafts) await this.#helper(l, d, ask);
      await this.#helper(l, checker, 'The draft was rewritten after your fixes: check it again.');
      if (checker.status !== 'done') return;
    }
  }

  #chain(conv: NonNullable<ReturnType<AppContext['store']['getConversation']>>, role: RunRole) {
    const m = role.model === 'auto' ? null : role.model;
    let chain = resolveChain(this.#app, { ...conv, providerId: m?.providerId ?? null, model: m?.model ?? null, mode: 'chat' }, JOB[role.kind]);
    if (conv.private) {
      chain = chain.filter((c) => onThisComputer(c.provider.config, c.model));
      if (!chain.length) throw new Error('This chat is private: team helpers use models on this computer only, and none is set up.');
    }
    return chain;
  }

  #roleUse(run: TeamRun, role: string): { tokens: number; usd: number } {
    return run.steps.filter((s) => s.role === role).reduce((a, s) => ({ tokens: a.tokens + s.tokens, usd: a.usd + s.usd }), { tokens: 0, usd: 0 });
  }

  #overBudget(l: Live, role: RunRole, step: RunStep, next: number): string | undefined {
    const run = l.run;
    const use = this.#roleUse(run, role.id);
    if (use.tokens + next > role.budget.tokens) return `${role.name}'s budget (about ${role.budget.tokens.toLocaleString('en-US')} tokens)`;
    if (role.budget.usd && use.usd >= role.budget.usd) return `${role.name}'s budget of $${role.budget.usd.toFixed(2)}`;
    if (step.startedAt && Date.now() - l.started > run.plan.limits.minutes * 60_000) return `the time budget (${run.plan.limits.minutes} minutes)`;
    if (run.tokens + next > run.plan.limits.tokens) return `the run's budget (about ${run.plan.limits.tokens.toLocaleString('en-US')} tokens)`;
    if (run.plan.limits.usd && run.usd >= run.plan.limits.usd) return `the run's budget of $${run.plan.limits.usd.toFixed(2)}`;
    return undefined;
  }

  /** A helper does its part: its model, its tools, the scratchpad, its budget. */
  async #helper(l: Live, step: RunStep, extra?: string): Promise<void> {
    const app = this.#app;
    const run = l.run;
    const role = run.plan.roles.find((r) => r.id === step.role)!;
    const conv = app.store.getConversation(run.conversationId);
    if (!conv) throw new Error('The conversation is gone.');
    const owner = app.settings.get().ownerName?.trim() || 'the owner';
    const t0 = Date.now();
    Object.assign(step, { status: 'running', startedAt: app.now().toISOString(), endedAt: null, runs: step.runs + 1 });
    this.#note(run, `${role.name} started: ${step.title}${step.runs > 1 ? ` (round ${step.runs})` : ''}`);
    try {
      await this.#gate(l);
      const chain = this.#chain(conv, role);
      const priv = conv.private || privateLocalOn();
      const tools = app.tools.list().filter((t) => role.tools.includes(t.spec.name) && (!t.isAvailable || t.isAvailable()) && !HARD_LIMIT_TOOL(t.spec.name, t) && !(priv && OFFSERVER_TOOL(t.spec.name)) && (!t.spec.name.startsWith('pc_') || role.computer));
      const specs = [...tools.map((t) => t.spec), NOTE_SPEC];
      const before = run.steps.filter((s) => step.after.includes(s.id) && s.report);
      const kindRule: Record<RoleKind, string> = {
        researcher: 'Find the facts the job needs. Note every fact with note_finding and its source.',
        drafter: 'Write your part of the deliverable from the findings on the scratchpad. Cite findings as [n]. Use only facts that are on the scratchpad or in the reports you were given.',
        checker: 'Check every claim in the draft against the findings and their sources. List each claim that is wrong or has no source, with the fix. End with exactly one line: "VERDICT: OK" or "VERDICT: FIX: <what to change>".',
        custom: 'Do your part as your instructions say.',
      };
      const system = [
        `You are ${role.name}, the ${role.kind} on a team run led by ${app.persona.name}, working for ${owner}. You are a helper, not a companion: no persona, no small talk. Do your one part with your tools.`,
        kindRule[role.kind],
        role.instructions,
        `Actions outside reading and writing drafts (sending, posting, buying, using the computer) are not done now: calling such a tool queues it for ${owner}'s one final approval at the end. Never say something was sent or done when it was only queued.`,
        'When your part is done, stop calling tools and reply with your result (a draft, a check or a short report).',
        ...SAFETY_BOUNDARIES,
      ].filter(Boolean).join('\n\n');
      const pad = run.notes.length ? run.notes.map((n) => `[${n.n}] ${n.text} (source: ${n.source})`).join('\n') : '(nothing yet)';
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: `The whole job: ${run.goal}\n\nThe team's scratchpad (findings with sources):\n${pad}\n\n${before.length ? `What the parts before yours gave:\n${before.map((s) => `- ${run.plan.roles.find((r) => r.id === s.role)?.name ?? s.role} (${s.title}):\n${clip(s.report ?? '', 4000)}`).join('\n')}\n\n` : ''}Your part: ${step.title}\n${step.instructions}${extra ? `\n\n${extra}` : ''}` },
      ];
      const receipts: Receipt[] = [];
      let ci = 0;
      for (let move = 0; move < TEAM_RUN.maxMoves; move++) {
        await this.#gate(l);
        if (Date.now() - t0 > role.budget.minutes * 60_000) throw new LimitError(`${role.name}'s time budget (${role.budget.minutes} minutes)`);
        const over = this.#overBudget(l, role, step, est(messages));
        if (over) throw new LimitError(over);
        let reply = '';
        const calls: ToolCall[] = [];
        const { provider, model } = chain[ci];
        const sc: UsageScope = { ...(usageScope.getStore() ?? {}), tokens: 0, usd: 0, reported: 0, unreported: 0 };
        try {
          await usageScope.run(sc, async () => {
            for await (const ev of streamWithin((sig) => provider.stream({ model, messages, tools: specs, signal: sig, temperature: 0.3 }), l.ctl.signal, fallbackAfterMs(app, { provider, promptChars: promptChars(messages) }))) {
              if (ev.type === 'text') reply += ev.text;
              else if (ev.type === 'tool_call') calls.push(ev.call);
            }
          });
        } catch (err) {
          if (!reply && !calls.length && !l.ctl.signal.aborted && ci < chain.length - 1) {
            ci++;
            move--;
            continue;
          }
          throw err;
        }
        const used = (sc.reported ?? 0) > 0 ? (sc.tokens ?? 0) : est(messages) + est(reply) + est(calls);
        step.tokens += used;
        step.usd += sc.usd ?? 0;
        run.tokens += used;
        run.usd = Math.round((run.usd + (sc.usd ?? 0)) * 10_000) / 10_000;
        if (!calls.length) {
          step.report = app.redactor.redact(reply.trim() || '(no report)');
          break;
        }
        messages.push({ role: 'assistant', content: reply, toolCalls: calls });
        for (const call of calls) {
          const r = await this.#tool(l, step, role, tools, call);
          receipts.push(r);
          step.receipts.push({ ...r, output: clip(r.output, 2000) });
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: clip(r.output, 12_000) });
          if (l.ctl.signal.aborted) throw l.ctl.signal.reason;
        }
        this.#save(run);
      }
      step.report ??= `(stopped after ${TEAM_RUN.maxMoves} moves without a final result)`;
      step.status = 'done';
      step.endedAt = app.now().toISOString();
      this.#note(run, `${role.name} finished: ${clip(step.report, 160)}`);
    } catch (err) {
      step.endedAt = app.now().toISOString();
      if (err instanceof LimitError) {
        // This part never finished: it waits (what it noted on the scratchpad stays).
        Object.assign(step, { status: step.runs > 1 ? 'done' : 'waiting', startedAt: step.runs > 1 ? step.startedAt : null });
        this.#note(run, `${role.name} reached ${err.message}.`);
        throw err;
      }
      step.status = l.ctl.signal.aborted ? 'stopped' : 'failed';
      if (!l.ctl.signal.aborted) step.report = `Failed: ${clip((err as Error).message, 300)}`;
      this.#note(run, `${role.name} ${step.status}: ${step.title}`);
      if (!l.ctl.signal.aborted) return; // the parts that wait for it are skipped; the rest go on
      throw err;
    }
  }

  /** One tool call: the scratchpad, a read or a draft now; anything else queued for the final OK. */
  async #tool(l: Live, step: RunStep, role: RunRole, tools: Tool[], call: ToolCall): Promise<Receipt> {
    const app = this.#app;
    const run = l.run;
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    const t0 = Date.now();
    const done = (status: Receipt['status'], output: string, approval: 'auto' | 'refused' | 'queued' = 'auto'): Receipt => {
      l.rec.tool({ id: call.id, name: call.name, summary: clip(`${role.name}: ${call.name}`, 200), args: app.redactor.redactValue(args), status, output: app.redactor.redact(output), ms: Date.now() - t0, approval: approval === 'queued' ? 'allowed' : approval });
      return { name: call.name, status, args, output: app.redactor.redact(output) };
    };
    if (call.name === 'note_finding') {
      const text = String(args.text ?? '').trim();
      const source = String(args.source ?? '').trim();
      if (!text) return done('error', 'Say the finding.');
      if (!source) return done('error', 'Give the source (a URL, file or document) for every finding.');
      const n = run.notes.length + 1;
      run.notes.push({ n, step: step.id, role: role.name, text: app.redactor.redact(clip(text, 1000)), source: app.redactor.redact(clip(source, 300)), at: app.now().toISOString() });
      return done('ok', `Noted as [${n}].`);
    }
    const tool = tools.find((t) => t.spec.name === call.name);
    if (!tool) return done('denied', HARD_LIMIT_TOOL(call.name, app.tools.get(call.name)) ? `${call.name} is never used on a team run.` : `${role.name} doesn't have the ${call.name} tool in this plan.`, 'refused');
    const conv = app.store.getConversation(run.conversationId)!;
    const kind = toolKind(call.name, tool);
    try {
      assertToolAdmission(app, l.scope, tool, l.ctl.signal, { workspace: conv.workspace, privateLocal: privateLocalOn(), offServer: OFFSERVER_TOOL(call.name), network: !(conv.private || privateLocalOn()) });
    } catch (err) {
      if (err instanceof ToolAdmissionError) return done('denied', err.message, 'refused');
      throw err;
    }
    let summary = call.name;
    try {
      summary = app.redactor.redact(tool.summarize(args));
    } catch {
      /* the tool name is enough */
    }
    if (kind === 'action') {
      const n = run.actions.length + 1;
      run.actions.push({ n, step: step.id, role: role.name, tool: call.name, args, summary: clip(summary, 300), status: 'queued', output: null });
      this.#note(run, `${role.name} queued for your final OK: ${clip(summary, 160)}`);
      return done('ok', `Queued as action ${n} for the final approval: it runs only if ${app.settings.get().ownerName?.trim() || 'the owner'} approves it at the end. It has NOT happened yet.`, 'queued');
    }
    // Reading and writing drafts: the plan's one approval covers the tools listed in it.
    try {
      const out = await tool.run(args, { workspaceDir: workspaceDir(workspacesBase(app), conv.workspace), signal: l.ctl.signal, sandbox: { ...app.sandbox, network: !(conv.private || privateLocalOn()) }, conversationId: conv.id, companionName: app.persona.name });
      return done('ok', out);
    } catch (err) {
      return done('error', `Error: ${(err as Error).message}`);
    }
  }

  /** The one deliverable: the checked draft(s) with the sources, as a document or a message. */
  async #deliver(l: Live): Promise<void> {
    const app = this.#app;
    const run = l.run;
    const kindOf = (s: RunStep) => run.plan.roles.find((r) => r.id === s.role)?.kind;
    const needed = new Set(run.steps.flatMap((s) => s.after));
    const picked: RunStep[] = [];
    for (const s of run.steps.filter((x) => !needed.has(x.id))) {
      const from = kindOf(s) === 'checker' ? run.steps.filter((d) => s.after.includes(d.id)) : [s];
      for (const d of from) if (d.status === 'done' && d.report && !picked.includes(d)) picked.push(d);
    }
    if (!picked.length) return;
    const last = run.checks.at(-1);
    const parts = [picked.map((s) => s.report!.trim()).join('\n\n')];
    if (last?.open) parts.push(`Still open after ${TEAM_RUN.maxCheckRounds} check rounds:\n${last.fixes.map((f) => `- ${f}`).join('\n')}`);
    if (run.notes.length) parts.push(`Sources:\n${run.notes.map((n) => `[${n.n}] ${n.source}`).join('\n')}`);
    const body = app.redactor.redact(parts.join('\n\n'));
    if (run.plan.deliver.kind === 'document') {
      try {
        const { made } = makeDocument(app, { format: run.plan.deliver.format, title: run.plan.deliver.title, content: body }, { conversationId: run.conversationId });
        run.result = { kind: 'document', docId: made.id, title: made.title, format: made.format };
        this.#note(run, `Made the document "${made.title}" (${made.format}).`);
        return;
      } catch (err) {
        this.#note(run, `The document could not be made (${clip((err as Error).message, 160)}); the result is in the chat instead.`);
      }
    }
    const msg = app.store.addMessage(run.conversationId, 'assistant', body, { teamRun: { id: run.id } });
    app.events?.publish({ type: 'message', conversationId: run.conversationId, message: msg, reason: 'job' });
    run.result = { kind: 'message', messageId: msg.id };
  }

  /** The ONE final approval: every queued action at once (untick some with `skip`), or none. */
  async decide(id: number, d: { approved: boolean; skip?: number[] }): Promise<TeamRun> {
    const app = this.#app;
    const run = this.#current(id);
    if (run.status !== 'waiting') throw new TeamRunError(409, en('Nothing is waiting for your OK on this run.'));
    const conv = app.store.getConversation(run.conversationId);
    if (!conv) throw new TeamRunError(404, en('No such conversation.'));
    const skip = new Set((d.skip ?? []).map(Number));
    run.status = 'running';
    this.#save(run);
    const scope = captureToolScope(conv, conv.workspace, privateLocalOn());
    const signal = new AbortController().signal;
    const owner = app.settings.get().ownerName?.trim() || 'the owner';
    for (const a of run.actions) {
      if (a.status !== 'queued') continue;
      if (!d.approved || skip.has(a.n)) {
        a.status = d.approved ? 'skipped' : 'denied';
        continue;
      }
      const tool = app.tools.get(a.tool);
      try {
        if (!tool || HARD_LIMIT_TOOL(a.tool, tool)) throw new ToolAdmissionError(`The ${a.tool} tool isn't available.`);
        assertToolAdmission(app, scope, tool, signal, { workspace: conv.workspace, privateLocal: privateLocalOn(), offServer: OFFSERVER_TOOL(a.tool), network: !(conv.private || privateLocalOn()) });
        a.output = app.redactor.redact(clip(await tool.run(a.args, { workspaceDir: workspaceDir(workspacesBase(app), conv.workspace), signal, sandbox: { ...app.sandbox, network: !(conv.private || privateLocalOn()) }, conversationId: conv.id, companionName: app.persona.name }), 2000));
        a.status = 'done';
      } catch (err) {
        a.status = err instanceof ToolAdmissionError ? 'denied' : 'error';
        a.output = app.redactor.redact(clip((err as Error).message, 400));
      }
    }
    const did = run.actions.filter((a) => a.status === 'done').length;
    run.status = 'done';
    run.endedAt = app.now().toISOString();
    this.#note(run, d.approved ? `${owner} approved: ${did} of ${run.actions.length} action(s) done.` : `${owner} said no: none of the ${run.actions.length} action(s) ran.`);
    return this.get(id)!;
  }
}

function standardPlan(goal: string, o: { deliver?: 'document' | 'message'; format?: string }): Record<string, unknown> {
  return {
    roles: [
      { id: 'researcher', name: 'Researcher', kind: 'researcher' },
      { id: 'drafter', name: 'Drafter', kind: 'drafter' },
      { id: 'checker', name: 'Checker', kind: 'checker' },
    ],
    steps: [
      { id: 's1', role: 'researcher', title: 'Find the facts', instructions: `Find what this job needs, with sources: ${goal}` },
      { id: 's2', role: 'drafter', title: 'Write it', instructions: `Write the result for: ${goal}`, after: ['s1'] },
      { id: 's3', role: 'checker', title: 'Check it', instructions: 'Check every claim in the draft against the sources.', after: ['s2'] },
    ],
    deliver: { kind: o.deliver ?? 'message', ...(o.format ? { format: o.format } : {}) },
  };
}

/** Server words the run card uses (so the extractor sees them). */
export const TEAM_RUN_LINES = [en('No such team run.')];

/** Her tool: propose a team run (the person edits and approves the plan on its card). */
export function createTeamRunTools(app: () => AppContext): Tool[] {
  const propose: Tool = {
    defaultPermission: 'auto',
    spec: {
      name: 'team_run',
      description:
        'Propose a team run for a big job that splits well (research several things at once, write it up, check it): you plan roles (researcher, drafter, checker or custom), each with its model, tools and budget; the person edits and approves the plan once on its card, helpers work in parallel, a checker checks the claims against the sources, and one deliverable (a document or a message) comes back. Sending, posting or buying waits for one final approval. For code, use team_task; for small things, do them yourself. When the person names one of their saved team recipes (\"use my product comparison team\"), pass its name as recipe: the plan comes from it.',
      parameters: { type: 'object', properties: { goal: { type: 'string', description: 'The whole job: what to find, write or decide, and what the result should be.' }, recipe: { type: 'string', description: 'The name of a saved team recipe to start from (optional).' }, deliver: { type: 'string', enum: ['document', 'message'], description: 'A document (Word, PDF, Markdown…) or a message here.' }, format: { type: 'string', enum: [...FORMATS], description: 'For a document (default docx).' } }, required: ['goal'] },
    },
    isAvailable: () => Boolean(app().teamRuns),
    summarize: (a) => `Team run: ${clip(String(a.goal ?? ''), 160)}`,
    async run(args, ctx) {
      const a = app();
      if (!a.teamRuns || !ctx.conversationId) throw new Error('Team runs need a conversation.');
      const wanted = typeof args.recipe === 'string' && args.recipe.trim() ? args.recipe.trim() : '';
      const recipe = wanted ? a.teamRuns.recipes.find(wanted) : undefined;
      if (wanted && !recipe) {
        const names = a.teamRuns.recipes.list().map((r) => `“${r.name}”`);
        throw new Error(names.length ? `No team recipe called “${clip(wanted, 60)}”. The saved recipes: ${names.join(', ')}. Ask which one they mean.` : 'There are no saved team recipes yet. Plan the run without one.');
      }
      const run = await a.teamRuns.propose(ctx.conversationId, String(args.goal ?? ''), { ...(args.deliver === 'document' || args.deliver === 'message' ? { deliver: args.deliver } : {}), ...(typeof args.format === 'string' ? { format: args.format } : {}), ...(recipe ? { recipe: recipe.id } : {}) });
      return `Team run #${run.id} proposed${recipe ? ` from your recipe “${recipe.name}”` : ''}: ${run.plan.roles.length} helpers, ${run.plan.steps.length} parts, a budget of about ${run.plan.limits.tokens.toLocaleString('en-US')} tokens. The plan is on its card in this chat: the person edits it and approves it once; nothing runs before that. Don't describe results before the run ends.`;
    },
  };
  return [propose];
}
