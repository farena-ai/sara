// W3.4 (docs/design/W3WORKFORCE.md): agent workforce v2, on top of C10 workers (src/workers.ts) and
// the V3.3 weekly report (src/workforce.ts). Nothing here calls a model.
// - Goals: a worker gets a goal with one simple measure (KPI): "jobs" (finished chains this week or in
//   total) or "number" (a value the worker reports with a `PROGRESS: <n>` line, or he types in).
// - Caps: dollars and/or tokens per goal, per week (Monday, his time zone) or over the goal's life.
//   Before a goal job starts, the cap is checked; at the cap the goal is "capped", its jobs wait and
//   he is asked ONCE (the C10 "needs you" alert). Raising the cap (or a new week) lets them run. A
//   running job never gets more tokens than are left under the cap.
// - Hand-offs: a goal has a chain of workers (scout → writer → editor). When a step is done, its
//   output becomes the next worker's job (`from_job`), same goal; any worker can also end with
//   `PASS TO <name>: <job>`. Chains stop after six steps. The chain is shown in the goal view.
// - Weekly plan: on the workforce report's day and hour (default Monday 9 AM) the workers propose a
//   plan: each active goal's weekly job, the `NEXT: <job>` lines they wrote, or one next step. He
//   approves, edits, drops or adds items in one card; approved items become goal jobs.
// Tables (additive): worker_goals, worker_plans, worker_goal_kv; columns worker_jobs.goal_id/from_job.
import type { DatabaseSync } from 'node:sqlite';
import { audit } from './audit-trail.ts';
import type { AppContext } from './chat.ts';
import { postAlert } from './destinations.ts';
import { en, trOwner } from './i18n.ts';
import { localDate } from './memory-worker.ts';
import { dayStartUtc } from './planner.ts';
import { weekSlot } from './workforce.ts';
import type { Worker, WorkerJob, Workers } from './workers.ts';

export const GOALS = { maxGoals: 24, maxChain: 4, maxDepth: 5, maxSuggestions: 10, maxPlanItems: 30 } as const;
export type GoalKind = 'jobs' | 'number';
export type GoalPeriod = 'week' | 'total';
export type GoalState = 'on' | 'capped' | 'paused';
export interface Goal {
  id: number;
  workerId: number;
  title: string;
  measure: string;
  kind: GoalKind;
  target: number;
  current: number;
  period: GoalPeriod;
  capUsd: number | null;
  capTokens: number | null;
  chain: number[];
  every: string;
  suggestions: string[];
  state: GoalState;
  createdAt: string;
  updatedAt: string;
}
export interface ChainStep {
  id: number;
  workerId: number;
  worker: string;
  title: string;
  status: string;
  at: string;
}
export interface Blocked {
  kind: 'cap' | 'goal-paused' | 'paused' | 'approval' | 'budget' | 'failed';
  key: string;
  params: Record<string, string | number>;
  text: string;
  jobId?: number;
}
export interface GoalView extends Goal {
  worker: string;
  chainNames: string[];
  progress: { current: number; target: number; kind: GoalKind; measure: string; period: GoalPeriod };
  spent: { usd: number; tokens: number; unpriced: number };
  cap: { usd: number | null; tokens: number | null };
  since: string;
  waiting: number;
  running: number;
  blocked: Blocked[];
  chains: ChainStep[][];
}
export interface PlanItem {
  key: string;
  goalId: number;
  workerId: number;
  title: string;
  source: 'every' | 'next' | 'step';
  estUsd: number | null;
  overCap: boolean;
}
export interface WorkPlan {
  week: string;
  state: 'proposed' | 'approved' | 'skipped';
  items: PlanItem[];
  createdAt: string;
  decidedAt: string | null;
  made: number;
}

export class GoalError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Row = Record<string, string | number | null>;
const clean = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, n);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const PASS_RE = /^\s*PASS TO ([^:\n]{1,40}):\s*(.{3,500})$/gim;
const PROGRESS_RE = /^\s*PROGRESS:\s*(-?\d+(?:[.,]\d+)?)\s*$/gim;
const NEXT_RE = /^\s*NEXT:\s*(.{3,160})$/gim;
const money = (usd: number) => `$${usd < 0.01 && usd > 0 ? usd.toFixed(3) : usd.toFixed(2)}`;

export class WorkerGoals {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #wk: Workers;

  constructor(app: AppContext, db: DatabaseSync, workers: Workers) {
    this.#app = app;
    this.#db = db;
    this.#wk = workers;
    db.exec(`
CREATE TABLE IF NOT EXISTS worker_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  measure TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'jobs',
  target REAL NOT NULL DEFAULT 0,
  current REAL NOT NULL DEFAULT 0,
  period TEXT NOT NULL DEFAULT 'week',
  cap_usd REAL,
  cap_tokens INTEGER,
  chain TEXT NOT NULL DEFAULT '[]',
  every TEXT NOT NULL DEFAULT '',
  suggestions TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'on',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS worker_plans (
  week TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  items TEXT NOT NULL,
  made INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS worker_goal_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
    const cols = new Set((db.prepare('PRAGMA table_info(worker_jobs)').all() as { name: string }[]).map((c) => c.name));
    if (!cols.has('goal_id')) db.exec('ALTER TABLE worker_jobs ADD COLUMN goal_id INTEGER');
    if (!cols.has('from_job')) db.exec('ALTER TABLE worker_jobs ADD COLUMN from_job INTEGER');
  }

  #now(): Date {
    return this.#app.now();
  }

  #view(r: Row): Goal {
    return {
      id: Number(r.id),
      workerId: Number(r.worker_id),
      title: String(r.title),
      measure: String(r.measure),
      kind: r.kind === 'number' ? 'number' : 'jobs',
      target: Number(r.target),
      current: Number(r.current),
      period: r.period === 'total' ? 'total' : 'week',
      capUsd: r.cap_usd === null ? null : Number(r.cap_usd),
      capTokens: r.cap_tokens === null ? null : Number(r.cap_tokens),
      chain: JSON.parse(String(r.chain)) as number[],
      every: String(r.every),
      suggestions: JSON.parse(String(r.suggestions)) as string[],
      state: r.state === 'capped' ? 'capped' : r.state === 'paused' ? 'paused' : 'on',
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  list(): Goal[] {
    return (this.#db.prepare('SELECT * FROM worker_goals ORDER BY id').all() as Row[]).map((r) => this.#view(r));
  }

  get(id: number): Goal | undefined {
    const r = this.#db.prepare('SELECT * FROM worker_goals WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#view(r) : undefined;
  }

  /** The goals a worker takes part in (its own, or as a step in the chain). */
  forWorker(workerId: number): Goal[] {
    return this.list().filter((g) => g.workerId === workerId || g.chain.includes(workerId));
  }

  #clean(body: Record<string, unknown>, cur?: Goal): Omit<Goal, 'id' | 'createdAt' | 'updatedAt'> {
    const has = (k: string) => body[k] !== undefined;
    const workerId = has('workerId') ? Number(body.workerId) : (cur?.workerId ?? 0);
    if (!this.#wk.get(workerId)) throw new GoalError(400, en('Pick the worker this goal is for.'));
    const title = has('title') ? clean(body.title, 120) : (cur?.title ?? '');
    if (title.length < 3) throw new GoalError(400, en('Say what the goal is in a few words.'));
    const measure = has('measure') ? clean(body.measure, 40) : (cur?.measure ?? '');
    const kind: GoalKind = has('kind') ? (body.kind === 'number' ? 'number' : 'jobs') : (cur?.kind ?? 'jobs');
    const num = (k: string, d: number) => {
      if (!has(k)) return d;
      const n = Number(body[k]);
      if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new GoalError(400, en('Use a number of 0 or more.'));
      return Math.round(n * 100) / 100;
    };
    const target = num('target', cur?.target ?? 0);
    const current = num('current', cur?.current ?? 0);
    const period: GoalPeriod = has('period') ? (body.period === 'total' ? 'total' : 'week') : (cur?.period ?? 'week');
    const cap = (k: string, d: number | null, max: number) => {
      if (!has(k)) return d;
      if (body[k] === null || body[k] === '' || body[k] === 0) return null;
      const n = Number(body[k]);
      if (!Number.isFinite(n) || n <= 0 || n > max) throw new GoalError(400, en('A cap must be more than 0.'));
      return n;
    };
    const capUsd = cap('capUsd', cur?.capUsd ?? null, 10_000);
    const capTok = cap('capTokens', cur?.capTokens ?? null, 100_000_000);
    const capTokens = capTok === null ? null : Math.round(capTok);
    let chain = cur?.chain ?? [];
    if (has('chain')) {
      chain = Array.isArray(body.chain) ? body.chain.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
      if (chain.length > GOALS.maxChain) throw new GoalError(400, en('A chain can pass work on at most 4 times.'));
      if (chain.some((id) => !this.#wk.get(id))) throw new GoalError(400, en('Pick workers you have for the chain.'));
    }
    if (new Set([workerId, ...chain]).size !== chain.length + 1) throw new GoalError(400, en('Each worker can be in the chain once, and not pass work to itself.'));
    const every = has('every') ? clean(body.every, 160) : (cur?.every ?? '');
    const suggestions = has('suggestions') ? (Array.isArray(body.suggestions) ? body.suggestions.map((s) => clean(s, 160)).filter((s) => s.length >= 3).slice(0, GOALS.maxSuggestions) : []) : (cur?.suggestions ?? []);
    const state: GoalState = has('state') ? (body.state === 'paused' ? 'paused' : 'on') : (cur?.state ?? 'on');
    return { workerId, title, measure, kind, target, current, period, capUsd, capTokens, chain, every, suggestions, state };
  }

  create(body: Record<string, unknown>): Goal {
    if (this.list().length >= GOALS.maxGoals) throw new GoalError(400, en('You have the most goals there can be (24). Delete one first.'));
    const g = this.#clean(body);
    const iso = this.#now().toISOString();
    const r = this.#db
      .prepare('INSERT INTO worker_goals (worker_id, title, measure, kind, target, current, period, cap_usd, cap_tokens, chain, every, suggestions, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(g.workerId, g.title, g.measure, g.kind, g.target, g.current, g.period, g.capUsd, g.capTokens, JSON.stringify(g.chain), g.every, JSON.stringify(g.suggestions), g.state, iso, iso);
    audit({ action: 'worker.goal', target: `goal${r.lastInsertRowid}`, role: 'owner', who: 'owner', channel: 'web', outcome: 'ok' });
    return this.get(Number(r.lastInsertRowid))!;
  }

  patch(id: number, body: Record<string, unknown>): Goal {
    const cur = this.get(id);
    if (!cur) throw new GoalError(404, en('Goal not found'));
    const g = this.#clean(body, cur);
    // A capped goal stays capped until the next check sees room (a raised cap, a new week).
    const state = body.state === undefined ? cur.state : g.state;
    this.#db
      .prepare('UPDATE worker_goals SET worker_id = ?, title = ?, measure = ?, kind = ?, target = ?, current = ?, period = ?, cap_usd = ?, cap_tokens = ?, chain = ?, every = ?, suggestions = ?, state = ?, updated_at = ? WHERE id = ?')
      .run(g.workerId, g.title, g.measure, g.kind, g.target, g.current, g.period, g.capUsd, g.capTokens, JSON.stringify(g.chain), g.every, JSON.stringify(g.suggestions), state, this.#now().toISOString(), id);
    return this.get(id)!;
  }

  /** Forgets the goal; its waiting jobs stay with their workers (no longer under a cap). */
  remove(id: number): boolean {
    this.#db.prepare('UPDATE worker_jobs SET goal_id = NULL WHERE goal_id = ? AND status IN (\'queued\', \'running\')').run(id);
    return Number(this.#db.prepare('DELETE FROM worker_goals WHERE id = ?').run(id).changes) > 0;
  }

  /** Workers that lost a worker drop it from chains (and its goals). */
  workerGone(workerId: number): void {
    for (const g of this.list()) {
      if (g.workerId === workerId) this.remove(g.id);
      else if (g.chain.includes(workerId)) this.#db.prepare('UPDATE worker_goals SET chain = ? WHERE id = ?').run(JSON.stringify(g.chain.filter((x) => x !== workerId)), g.id);
    }
  }

  /** A job for the goal, given to the goal's worker (the first step of its chain). */
  addJob(goalId: number, body: { title?: unknown; input?: unknown }): WorkerJob {
    const g = this.get(goalId);
    if (!g) throw new GoalError(404, en('Goal not found'));
    const job = this.#wk.enqueue(g.workerId, body, { goalId });
    this.#wk.tick();
    return this.#wk.job(job.id) ?? job;
  }

  // ── Spend and caps ────────────────────────────────────────────────────────

  /** Where the goal's counting starts: Monday 0:00 in his time zone, or when the goal was made. */
  since(g: Goal, now: Date = this.#now()): string {
    if (g.period === 'total') return g.createdAt;
    const tz = this.#app.settings.get().timeZone || 'UTC';
    const day = localDate(now, tz);
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return dayStartUtc(d.toISOString().slice(0, 10), tz).toISOString();
  }

  spent(g: Goal, now: Date = this.#now()): { usd: number; tokens: number; unpriced: number } {
    const rows = this.#db.prepare('SELECT tokens, team_task_id FROM worker_jobs WHERE goal_id = ? AND COALESCE(ended_at, started_at, created_at) >= ?').all(g.id, this.since(g, now)) as { tokens: number; team_task_id: number | null }[];
    let usd = 0;
    let unpriced = 0;
    let tokens = 0;
    for (const r of rows) {
      tokens += Number(r.tokens);
      if (r.team_task_id === null || !this.#app.usage) continue;
      const u = this.#app.usage.forTeam(Number(r.team_task_id));
      usd += u.usd;
      unpriced += u.unpriced;
    }
    return { usd: Math.round(usd * 1e6) / 1e6, tokens, unpriced };
  }

  #capLine(g: Goal, s: { usd: number; tokens: number }): { spent: string; cap: string } {
    const nf = new Intl.NumberFormat('en-US');
    if (g.capUsd !== null && s.usd >= g.capUsd) return { spent: money(s.usd), cap: money(g.capUsd) };
    return { spent: `${nf.format(s.tokens)} tokens`, cap: `${nf.format(g.capTokens ?? 0)} tokens` };
  }

  /**
   * May this job start now? Goal jobs wait while the goal is paused or at its cap (he is asked once
   * per cap and period); otherwise the answer carries the tokens left under the cap.
   */
  gate(job: WorkerJob, now: Date = this.#now()): { ok: boolean; tokens?: number } {
    if (!job.goalId) return { ok: true };
    const g = this.get(job.goalId);
    if (!g) return { ok: true };
    if (g.state === 'paused') return { ok: false };
    const s = this.spent(g, now);
    const reached = (g.capTokens !== null && s.tokens >= g.capTokens) || (g.capUsd !== null && s.usd >= g.capUsd);
    if (reached) {
      if (g.state !== 'capped') this.#db.prepare("UPDATE worker_goals SET state = 'capped', updated_at = ? WHERE id = ?").run(now.toISOString(), g.id);
      const w = this.#wk.get(g.workerId);
      if (w) {
        const line = this.#capLine(g, s);
        this.#wk.notify(`cap:g${g.id}:${this.since(g, now)}:${g.capUsd ?? ''}:${g.capTokens ?? ''}`, w, 'cap', en('{name} stopped work on "{goal}": it reached its cap ({spent} of {cap}). Raise the cap or pause the goal in Team → Workers that stay.'), { goal: g.title, ...line });
      }
      return { ok: false };
    }
    if (g.state === 'capped') this.#db.prepare("UPDATE worker_goals SET state = 'on', updated_at = ? WHERE id = ?").run(now.toISOString(), g.id);
    return g.capTokens === null ? { ok: true } : { ok: true, tokens: Math.max(0, g.capTokens - s.tokens) };
  }

  // ── Done jobs: measures, suggestions, hand-offs ──────────────────────────

  #depth(job: WorkerJob): number {
    let n = 0;
    for (let at = job.fromJob; at && n < 50; n++) at = this.#wk.job(at)?.fromJob ?? null;
    return n;
  }

  /** A job ended done: PROGRESS / NEXT lines, then its output goes to the next worker. */
  onDone(w: Worker, job: WorkerJob): void {
    const result = job.result ?? '';
    const g = job.goalId ? this.get(job.goalId) : undefined;
    if (g) {
      const prog = [...result.matchAll(PROGRESS_RE)].at(-1);
      const next = [...result.matchAll(NEXT_RE)].map((m) => m[1].trim());
      const sets: string[] = [];
      const args: (string | number)[] = [];
      if (prog && g.kind === 'number') {
        sets.push('current = ?');
        args.push(Number(prog[1].replace(',', '.')));
      }
      if (next.length) {
        sets.push('suggestions = ?');
        args.push(JSON.stringify([...new Set([...g.suggestions, ...next])].slice(-GOALS.maxSuggestions)));
      }
      if (sets.length) this.#db.prepare(`UPDATE worker_goals SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, this.#now().toISOString(), g.id);
    }
    if (this.#depth(job) >= GOALS.maxDepth) return;
    const handed: { to: Worker; title: string }[] = [];
    const all = this.#wk.list();
    for (const m of result.matchAll(PASS_RE)) {
      const to = all.find((x) => x.id !== w.id && x.name.toLowerCase() === m[1].trim().toLowerCase());
      if (to) handed.push({ to, title: clip(m[2].trim(), 160) });
    }
    if (!handed.length && g) {
      const steps = [g.workerId, ...g.chain];
      const at = steps.indexOf(w.id);
      const to = at >= 0 && at < steps.length - 1 ? this.#wk.get(steps[at + 1]) : undefined;
      if (to) handed.push({ to, title: job.title });
    }
    if (!handed.length) return;
    const body = result.replace(PASS_RE, '').replace(PROGRESS_RE, '').replace(NEXT_RE, '').trim();
    for (const h of handed) {
      try {
        this.#wk.enqueue(h.to.id, { title: h.title, input: clip(`From ${w.name}, for "${job.title}":\n\n${body}`, 5800) }, { goalId: job.goalId ?? undefined, fromJob: job.id });
        this.#wk.say(w, trOwner(en('Passed to {name}: {title}'), this.#app.settings.get(), { name: h.to.name, title: h.title }), { jobId: job.id, passedTo: h.to.id });
      } catch (err) {
        console.warn(`workers: pass to ${h.to.name} failed: ${(err as Error).message}`);
      }
    }
    this.#wk.tick();
  }

  /** The whole chain a job belongs to: from its first step down every hand-off, in order. */
  chainOf(jobId: number): ChainStep[] {
    let root = this.#wk.job(jobId);
    for (let n = 0; root?.fromJob && n < 50; n++) root = this.#wk.job(root.fromJob) ?? root;
    if (!root) return [];
    const names = new Map(this.#wk.list().map((x) => [x.id, x.name]));
    const out: WorkerJob[] = [root];
    for (let i = 0; i < out.length && out.length < 20; i++) {
      for (const r of this.#db.prepare("SELECT id FROM worker_jobs WHERE from_job = ? AND status <> 'dropped' ORDER BY id").all(out[i].id) as { id: number }[]) {
        const j = this.#wk.job(Number(r.id));
        if (j) out.push(j);
      }
    }
    return out.map((j) => ({ id: j.id, workerId: j.workerId, worker: names.get(j.workerId) ?? '?', title: j.title, status: j.status, at: j.endedAt ?? j.startedAt ?? j.createdAt }));
  }

  // ── The goal view ────────────────────────────────────────────────────────

  #progress(g: Goal, now: Date): number {
    if (g.kind === 'number') return g.current;
    const last = g.chain.length ? g.chain[g.chain.length - 1] : g.workerId;
    const since = g.period === 'week' ? this.since(g, now) : g.createdAt;
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM worker_jobs WHERE goal_id = ? AND worker_id = ? AND status = 'done' AND ended_at >= ?").get(g.id, last, since) as { n: number }).n);
  }

  view(id: number, now: Date = this.#now()): GoalView | undefined {
    const g = this.get(id);
    if (!g) return undefined;
    const set = this.#app.settings.get();
    const name = (wid: number) => this.#wk.get(wid)?.name ?? '?';
    const spent = this.spent(g, now);
    const blocked: Blocked[] = [];
    const add = (kind: Blocked['kind'], key: string, params: Record<string, string | number>, jobId?: number) => blocked.push({ kind, key, params, text: trOwner(key, set, params), ...(jobId ? { jobId } : {}) });
    if (g.state === 'capped') add('cap', en('Reached its cap: {spent} of {cap}. Raise the cap to go on.'), this.#capLine(g, spent));
    if (g.state === 'paused') add('goal-paused', en('You paused this goal; its jobs wait.'), {});
    for (const wid of [g.workerId, ...g.chain]) {
      const w = this.#wk.get(wid);
      if (!w) continue;
      if (w.state !== 'on') add('paused', en('{name} is paused, so its part waits.'), { name: w.name });
      const need = this.#wk.needsYou(wid);
      if (need && (need.reason === 'approval' || need.reason === 'budget')) add(need.reason, en('{name} is waiting: {text}'), { name: w.name, text: need.text });
    }
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    for (const r of this.#db.prepare("SELECT id, worker_id, title, error FROM worker_jobs WHERE goal_id = ? AND status = 'failed' AND replayed_by IS NULL AND ended_at >= ? ORDER BY id DESC LIMIT 3").all(g.id, weekAgo) as Row[]) {
      add('failed', en('{name} could not do "{title}": {error}'), { name: name(Number(r.worker_id)), title: String(r.title), error: clip(String(r.error ?? ''), 160) }, Number(r.id));
    }
    const count = (status: string) => Number((this.#db.prepare('SELECT COUNT(*) AS n FROM worker_jobs WHERE goal_id = ? AND status = ?').get(g.id, status) as { n: number }).n);
    const roots = this.#db.prepare("SELECT id FROM worker_jobs WHERE goal_id = ? AND from_job IS NULL AND status <> 'dropped' ORDER BY id DESC LIMIT 3").all(g.id) as { id: number }[];
    return {
      ...g,
      worker: name(g.workerId),
      chainNames: g.chain.map(name),
      progress: { current: this.#progress(g, now), target: g.target, kind: g.kind, measure: g.measure, period: g.period },
      spent,
      cap: { usd: g.capUsd, tokens: g.capTokens },
      since: this.since(g, now),
      waiting: count('queued'),
      running: count('running'),
      blocked,
      chains: roots.map((r) => this.chainOf(Number(r.id))),
    };
  }

  views(now: Date = this.#now()): GoalView[] {
    return this.list().map((g) => this.view(g.id, now)!);
  }

  /** Lines added to a worker's instructions: its goals and the lines it may end a reply with. */
  lines(w: Worker): string[] {
    const mine = this.forWorker(w.id);
    const others = this.#wk.list().filter((x) => x.id !== w.id).map((x) => x.name);
    const out: string[] = [];
    if (mine.length) {
      out.push(`Your goals: ${mine.map((g) => `"${g.title}"${g.target ? ` (target ${g.target}${g.measure ? ` ${g.measure}` : ''}${g.period === 'week' ? ' a week' : ''})` : ''}`).join('; ')}.`);
      out.push('At the end of a reply you may add: "PROGRESS: <number>" with the measure as it is now, and "NEXT: <a next job>" for jobs you would do next (one per line).');
      for (const g of mine) {
        const steps = [g.workerId, ...g.chain];
        const at = steps.indexOf(w.id);
        if (at >= 0 && at < steps.length - 1) out.push(`For "${g.title}" your result is passed to ${this.#wk.get(steps[at + 1])?.name ?? 'the next worker'}.`);
      }
    }
    if (others.length) out.push(`To hand work to another worker (${others.slice(0, 11).join(', ')}), end with one line per part: PASS TO <name>: <what to do>.`);
    return out;
  }

  // ── The weekly plan ──────────────────────────────────────────────────────

  #kv(key: string): string | undefined {
    return (this.#db.prepare('SELECT value FROM worker_goal_kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  #setKv(key: string, value: string): void {
    this.#db.prepare('INSERT INTO worker_goal_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  #planView(r: Row): WorkPlan {
    return { week: String(r.week), state: r.state === 'approved' ? 'approved' : r.state === 'skipped' ? 'skipped' : 'proposed', items: JSON.parse(String(r.items)) as PlanItem[], made: Number(r.made), createdAt: String(r.created_at), decidedAt: r.decided_at === null ? null : String(r.decided_at) };
  }

  /** The newest plan (proposed or decided). */
  plan(): WorkPlan | undefined {
    const r = this.#db.prepare('SELECT * FROM worker_plans ORDER BY week DESC LIMIT 1').get() as Row | undefined;
    return r ? this.#planView(r) : undefined;
  }

  /** Average dollars a goal's finished chain cost lately (null when nothing is priced yet). */
  #estimate(g: Goal): number | null {
    if (!this.#app.usage) return null;
    const rows = this.#db.prepare("SELECT team_task_id FROM worker_jobs WHERE goal_id = ? AND status = 'done' AND team_task_id IS NOT NULL ORDER BY id DESC LIMIT 10").all(g.id) as { team_task_id: number }[];
    if (!rows.length) return null;
    const usd = rows.reduce((n, r) => n + this.#app.usage!.forTeam(Number(r.team_task_id)).usd, 0) / rows.length;
    return usd > 0 ? Math.round(usd * (1 + g.chain.length) * 10000) / 10000 : null;
  }

  /** What the workers propose for this week, from each active goal. */
  propose(now: Date = this.#now()): WorkPlan {
    const items: PlanItem[] = [];
    let n = 0;
    for (const g of this.list()) {
      if (g.state === 'paused' || !this.#wk.get(g.workerId)) continue;
      const est = this.#estimate(g);
      const titles: { title: string; source: PlanItem['source'] }[] = [];
      if (g.every) titles.push({ title: g.every, source: 'every' });
      for (const s of g.suggestions.slice(0, 3)) titles.push({ title: s, source: 'next' });
      if (!titles.length) titles.push({ title: clip(trOwner(en('Next step toward: {goal}'), this.#app.settings.get(), { goal: g.title }), 160), source: 'step' });
      const left = g.capUsd === null ? Infinity : g.capUsd - this.spent(g, now).usd;
      let sum = 0;
      for (const x of titles) {
        sum += est ?? 0;
        items.push({ key: `i${++n}`, goalId: g.id, workerId: g.workerId, title: x.title, source: x.source, estUsd: est, overCap: sum > left });
      }
    }
    const week = weekSlot(this.#app, now);
    const iso = now.toISOString();
    this.#db.prepare("INSERT INTO worker_plans (week, state, items, made, created_at, decided_at) VALUES (?, 'proposed', ?, 0, ?, NULL) ON CONFLICT(week) DO UPDATE SET state = 'proposed', items = excluded.items, made = 0, created_at = excluded.created_at, decided_at = NULL").run(week, JSON.stringify(items.slice(0, GOALS.maxPlanItems)), iso);
    return this.plan()!;
  }

  /** Approve (with edits: a new title, skip, or added items) or skip this week's plan. */
  decidePlan(body: { approve?: unknown; items?: unknown; add?: unknown }): WorkPlan {
    const plan = this.plan();
    if (!plan) throw new GoalError(404, en('There is no plan to look at yet.'));
    if (plan.state !== 'proposed') throw new GoalError(409, en('This week’s plan was already decided.'));
    let made = 0;
    if (body.approve === true) {
      const edits = new Map((Array.isArray(body.items) ? body.items : []).map((e) => [String((e as { key?: unknown }).key), e as { title?: unknown; skip?: unknown }]));
      const todo: { goalId: number; title: string }[] = [];
      for (const it of plan.items) {
        const e = edits.get(it.key);
        if (e?.skip === true) continue;
        todo.push({ goalId: it.goalId, title: clean(e?.title, 160) || it.title });
      }
      for (const a of Array.isArray(body.add) ? body.add : []) {
        const x = a as { goalId?: unknown; title?: unknown };
        const title = clean(x.title, 160);
        if (title.length >= 3 && this.get(Number(x.goalId))) todo.push({ goalId: Number(x.goalId), title });
      }
      for (const x of todo.slice(0, GOALS.maxPlanItems)) {
        if (!this.get(x.goalId)) continue;
        try {
          this.addJob(x.goalId, { title: x.title, input: '' });
          made++;
        } catch (err) {
          console.warn(`workers: plan item "${x.title}" was not queued: ${(err as Error).message}`);
        }
      }
      // Suggestions that were in the plan are used up (kept or dropped).
      for (const g of this.list()) {
        const used = new Set(plan.items.filter((i) => i.goalId === g.id && i.source === 'next').map((i) => i.title));
        if (used.size) this.#db.prepare('UPDATE worker_goals SET suggestions = ? WHERE id = ?').run(JSON.stringify(g.suggestions.filter((s) => !used.has(s))), g.id);
      }
    }
    this.#db.prepare('UPDATE worker_plans SET state = ?, made = ?, decided_at = ? WHERE week = ?').run(body.approve === true ? 'approved' : 'skipped', made, this.#now().toISOString(), plan.week);
    audit({ action: body.approve === true ? 'worker.plan.approve' : 'worker.plan.skip', target: `plan${plan.week}`, role: 'owner', who: 'owner', channel: 'web', outcome: 'ok' });
    return this.plan()!;
  }

  #planText(p: WorkPlan): string {
    const set = this.#app.settings.get();
    const lines = [trOwner(en('Your workers propose this week’s plan:'), set), ''];
    const goals = new Map(this.list().map((g) => [g.id, g]));
    for (const it of p.items) lines.push(`- ${this.#wk.get(it.workerId)?.name ?? '?'}: ${it.title} (${goals.get(it.goalId)?.title ?? ''})`);
    lines.push('', trOwner(en('Approve or change it in Team → Workers that stay → Goals and weekly plan. Nothing starts until you approve.'), set));
    return lines.join('\n');
  }

  /**
   * The weekly proposal, on the workforce report's day and hour. The first look only remembers the
   * week (a fresh start mid-week never posts an old week); each week is proposed once.
   */
  tick(now: Date = this.#now()): boolean {
    if (this.#app.member) return false;
    const slot = weekSlot(this.#app, now);
    const seen = this.#kv('planWeek');
    if (seen === slot) return false;
    this.#setKv('planWeek', slot);
    if (!seen || !this.list().some((g) => g.state !== 'paused')) return false;
    const p = this.propose(now);
    if (!p.items.length) return false;
    postAlert(this.#app, 'workforce', { role: 'assistant', reason: 'proactive', nudge: { value: 0.7, urgency: 'reminder' }, content: this.#planText(p), meta: { workplan: { week: p.week } } });
    return true;
  }
}
