// Model tests ("Test my models", docs/MODEL_TESTS.md): the connected models answer small tasks per
// job (src/model-test-tasks.ts), graded by code. Each model gets a score per job: the share of the
// job's tasks it passed. The best is suggested for the job and the next ones are its backups; Auto
// (src/auto-route.ts) prefers them when scores exist.
//
// A run tests one model at a time per provider, models as the outer loop (a computer that keeps one
// model loaded loads each model once), at most two providers side by side. It can be stopped; what
// finished is kept, and the next start of a stopped run carries on where it stopped. Paid-per-token
// models are left out unless the owner ticks them. Nothing runs on its own except, when the owner
// turns on modelTests.autoNew, new models on the owner's own hardware after a model list refresh.
import type { DatabaseSync } from 'node:sqlite';
import { type AppContext, resolveProvider, vaultKeyFor } from './chat.ts';
import { embedTexts } from './embeddings.ts';
import { en, enf } from './i18n.ts';
import { EMBED_MODEL_NAME, isCloudModelName } from './model-names.ts';
import { JOBS } from './modelpicks.ts';
import { buildSystemPrompt } from './persona.ts';
import { modelSees } from './picture-reader.ts';
import { onThisComputer } from './private-local.ts';
import type { ChatMessage, ProviderConfig, ToolCall } from './providers/types.ts';
import { adultModeOn, ROUTE_PURPOSES, type ModelRoute, type RoutePurpose } from './settings.ts';
import { billingOf } from './usage.ts';
import { modelSeesByName } from './video.ts';
import { cleanReply, TASK_SET, TASKS, tasksFor, type TestTask } from './model-test-tasks.ts';

export type Billing = 'local' | 'subscription' | 'api';
export interface ModelRef {
  providerId: string;
  model: string;
}
export type Scope = { kind: 'all' } | { kind: 'provider'; providerId: string } | { kind: 'models'; models: ModelRef[] };
export interface TestRequest {
  scope: Scope;
  jobs?: RoutePurpose[];
  includePaid?: boolean;
}

export interface PlanModel extends ModelRef {
  label: string;
  billing: Billing;
  included: boolean;
  why?: string;
}
export interface PlanView {
  models: PlanModel[];
  jobs: RoutePurpose[];
  calls: number;
  paidCalls: number;
  minutes: number;
}
export interface RunView {
  id: string;
  state: 'running' | 'done' | 'stopped' | 'failed';
  done: number;
  total: number;
  current?: { providerId: string; model: string; job: RoutePurpose };
  startedAt: string;
  endedAt?: string;
  error?: string;
}
export interface JobScore {
  score: number;
  passed: number;
  total: number;
  firstMs?: number;
  totalMs?: number;
  error?: string;
}
export interface BestEntry extends ModelRef {
  score: number;
  tie: boolean;
  why: string;
}
export interface ScoresView {
  taskSet: number;
  jobs: { id: RoutePurpose; label: string; tasks: number }[];
  models: (ModelRef & { label: string; billing: Billing; local: boolean; testedAt?: string; stale: boolean; scores: Partial<Record<RoutePurpose, JobScore>> })[];
  best: Partial<Record<RoutePurpose, BestEntry[]>>;
  untested: (ModelRef & { label: string })[];
}

/** Scores this close (points) are a tie, broken by what the job needs. With 10 to 12 tasks a job, one task is 8 to 10 points, so a tie is the same number passed. */
export const TIE_POINTS = 3;
/** Providers tested side by side at most. */
export const MAX_PARALLEL = 2;
/** After this many errors in a row a model's other tasks are not asked (recorded as errors). */
export const ERRORS_IN_A_ROW = 3;
/** Timings (tests shorten them): the warm-up limit for a model on the owner's hardware, and how long a background run waits after the owner wrote. */
export const testTiming = { warmMs: 180_000, quietMs: 120_000, waitMs: 30_000 };

export class ModelTestsBusy extends Error {}

const NOT_CHAT = /caption|whisper|tts|rerank|guard|imagine|image|ocr/i;
const BILLING_RANK: Record<Billing, number> = { local: 0, subscription: 1, api: 2 };

/** Why a model is left out of a job (undefined: it takes part). */
export const LEFT_OUT = {
  paid: en('Paid per use: left out unless you include paid models.'),
  notChat: en('Not a model that talks.'),
  embedOnly: en('An embedding model: only tested for meaning search.'),
  notEmbed: en('Not an embedding model.'),
  blind: en('Cannot see pictures.'),
  adultOff: en('Adult mode is off.'),
  notOwn: en('Not on your own hardware, so not for private conversations.'),
  noProvider: en('That provider is not connected.'),
};

// ---------- storage ----------

function ensureTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS model_test_results (
    provider_id TEXT NOT NULL, model TEXT NOT NULL, task_id TEXT NOT NULL, task_set INTEGER NOT NULL,
    pass INTEGER NOT NULL, reason TEXT NOT NULL, error TEXT, first_ms INTEGER, total_ms INTEGER, at TEXT NOT NULL, run TEXT,
    PRIMARY KEY (provider_id, model, task_id, task_set))`);
  db.exec('CREATE TABLE IF NOT EXISTS model_test_runs (id TEXT PRIMARY KEY, lineage TEXT NOT NULL, background INTEGER NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT)');
}

interface Row {
  provider_id: string;
  model: string;
  task_id: string;
  task_set: number;
  pass: number;
  reason: string;
  error: string | null;
  first_ms: number | null;
  total_ms: number | null;
  at: string;
}

/** A provider was removed: its results go too. */
export function forgetModelTestResults(db: DatabaseSync, providerId: string): void {
  ensureTables(db);
  db.prepare('DELETE FROM model_test_results WHERE provider_id = ?').run(providerId);
}

// ---------- scores (pure) ----------

const median = (xs: number[]): number | undefined => {
  if (!xs.length) return undefined;
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return Math.round(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
};

/**
 * One job's score from a model's results: passed of the job's tasks. With the current task set every
 * task must have a result (a stopped run's half-done job has no score yet); with an older set, the
 * results of tasks that still exist count. More than half errors or timeouts: `error`.
 */
export function jobScore(rows: Row[], job: RoutePurpose, complete: boolean): JobScore | undefined {
  const ids = tasksFor(job).map((t) => t.id);
  const mine = rows.filter((r) => ids.includes(r.task_id));
  if (!mine.length || (complete && mine.length < ids.length)) return undefined;
  const passed = mine.filter((r) => r.pass).length;
  const errors = mine.filter((r) => r.error);
  const firstMs = median(mine.filter((r) => !r.error && r.first_ms !== null).map((r) => r.first_ms!));
  const totalMs = median(mine.filter((r) => !r.error && r.total_ms !== null).map((r) => r.total_ms!));
  return {
    score: Math.round((100 * passed) / mine.length),
    passed,
    total: mine.length,
    ...(firstMs !== undefined ? { firstMs } : {}),
    ...(totalMs !== undefined ? { totalMs } : {}),
    ...(errors.length * 2 > mine.length ? { error: String(errors[0].error).slice(0, 200) } : {}),
  };
}

export interface Contender extends ModelRef {
  billing: Billing;
  /** On this computer (loopback), for the Private tie. */
  here: boolean;
  s: JobScore;
}

/** Faster first (whole answer, then the first word); unknown last. */
const bySpeed = (a: Contender, b: Contender) => (a.s.totalMs ?? Infinity) - (b.s.totalMs ?? Infinity) || (a.s.firstMs ?? Infinity) - (b.s.firstMs ?? Infinity);
function tieOrder(job: RoutePurpose): (a: Contender, b: Contender) => number {
  if (job === 'quick') return bySpeed;
  if (job === 'private') return (a, b) => Number(b.here) - Number(a.here) || bySpeed(a, b);
  return (a, b) => BILLING_RANK[a.billing] - BILLING_RANK[b.billing] || bySpeed(a, b);
}
/** Why `a` won the tie with `b`, in plain words. */
function tieWhy(job: RoutePurpose, a: Contender, b: Contender): string {
  const model = b.model;
  if (job === 'private' && a.here && !b.here) return enf('Tied with {model}; runs on this computer', { model });
  if (job !== 'quick' && job !== 'private' && BILLING_RANK[a.billing] < BILLING_RANK[b.billing]) return a.billing === 'local' ? enf('Tied with {model}; runs on your own hardware at no cost', { model }) : enf('Tied with {model}; part of your subscription, not paid per use', { model });
  return bySpeed(a, b) < 0 ? enf('Tied with {model}; faster', { model }) : enf('Tied with {model}', { model });
}

/**
 * The best models for a job, best first, then backups (at most `n`). Highest score wins; scores
 * within TIE_POINTS of a group's top are a tie broken by what the job needs. Models that errored on
 * more than half the job's tasks, and models that passed nothing, are never suggested.
 */
export function pickBest(job: RoutePurpose, all: Contender[], n = 3): BestEntry[] {
  const left = all.filter((c) => !c.s.error && c.s.passed > 0).sort((a, b) => b.s.score - a.s.score);
  const out: BestEntry[] = [];
  const order = tieOrder(job);
  while (left.length && out.length < n) {
    const top = left[0].s.score;
    const group = left.filter((c) => c.s.score >= top - TIE_POINTS).sort(order);
    left.splice(0, left.length, ...left.filter((c) => !group.includes(c)));
    const tie = group.length > 1;
    group.forEach((c, i) => {
      const why = tie ? (i === 0 ? tieWhy(job, c, group[1]) : enf('Tied with {model}', { model: group[0].model })) : out.length === 0 ? enf('Highest score ({passed} of {total})', { passed: c.s.passed, total: c.s.total }) : enf('Next best ({passed} of {total})', { passed: c.s.passed, total: c.s.total });
      out.push({ providerId: c.providerId, model: c.model, score: c.s.score, tie, why });
    });
  }
  return out.slice(0, n);
}

// ---------- the engine ----------

interface Work extends ModelRef {
  billing: Billing;
  warm: boolean;
  tasks: { task: TestTask; job: RoutePurpose }[];
}
interface Run {
  view: RunView;
  lineage: string;
  background: boolean;
  models: Set<string>;
  abort: AbortController;
  done: Promise<void>;
}
class Stopped extends Error {}
interface BestCache {
  version: number;
  at: number;
  best: Partial<Record<RoutePurpose, BestEntry[]>>;
  scores: Map<string, Partial<Record<RoutePurpose, JobScore>>>;
}

const labelOf = (p: ProviderConfig | undefined, model: string) => (p ? `${p.label}: ${model}` : model);

/** Output tokens allowed for thinking on top of a task's own limit: the first try, then the second. */
export const THINK_ROOM = [2_000, 8_000];

export class ModelTests {
  readonly #app: AppContext;
  #run: Run | undefined;
  /** Models waiting for a background test (modelTests.autoNew). */
  readonly #queue: ModelRef[] = [];
  #version = 0;
  #bestCache: BestCache | undefined;
  #seq = 0;

  constructor(app: AppContext) {
    this.#app = app;
    ensureTables(app.store.db);
    // A run the server stopped in the middle of counts as stopped (its next start carries on).
    app.store.db.prepare("UPDATE model_test_runs SET state = 'stopped', ended_at = ? WHERE state = 'running'").run(app.now().toISOString());
  }

  get #db(): DatabaseSync {
    return this.#app.store.db;
  }

  // ---- which models, which jobs ----

  /** The models a provider has here: its kept list (pulled ones, embedding models too) or its live list, and the ones already chosen. */
  async #modelsOf(p: ProviderConfig): Promise<string[]> {
    const s = this.#app.settings.get();
    let listed: string[] = [];
    try {
      if (this.#app.modelCatalog?.known(p.id)) listed = this.#app.modelCatalog.present(p.id);
      else listed = await resolveProvider(this.#app, p.id, p.defaultModel ?? 'x').provider.listModels(AbortSignal.timeout(5000));
    } catch {
      listed = [];
    }
    const chosen = [...(s.defaultProviderId === p.id && s.defaultModel ? [s.defaultModel] : []), ...(p.defaultModel ? [p.defaultModel] : []), ...Object.values(s.routes ?? {}).filter((r) => r?.providerId === p.id).map((r) => r!.model)];
    return [...new Set([...chosen, ...listed])];
  }

  async #scopeModels(scope: Scope): Promise<ModelRef[]> {
    const s = this.#app.settings.get();
    if (scope.kind === 'models') return scope.models;
    const out: ModelRef[] = [];
    for (const p of s.providers) {
      if (scope.kind === 'provider' && p.id !== scope.providerId) continue;
      if (p.needsKey && !this.#app.vault.get(vaultKeyFor(p.id))) continue;
      for (const model of await this.#modelsOf(p)) out.push({ providerId: p.id, model });
    }
    return out;
  }

  #jobsOf(req: TestRequest): RoutePurpose[] {
    const want = req.jobs?.length ? JOBS.map((j) => j.id).filter((j) => req.jobs!.includes(j)) : JOBS.map((j) => j.id);
    return want.filter((j) => j !== 'adult' || adultModeOn(this.#app.settings.get()));
  }

  /** Why this model is left out of this job (undefined: it takes part). */
  #leftOut(config: ProviderConfig, model: string, job: RoutePurpose): string | undefined {
    const embed = EMBED_MODEL_NAME.test(model);
    if (job === 'embeddings') return embed && config.kind === 'openai-compatible' ? undefined : LEFT_OUT.notEmbed;
    if (embed) return LEFT_OUT.embedOnly;
    if (NOT_CHAT.test(model)) return LEFT_OUT.notChat;
    if (job === 'vision' || job === 'screen') {
      const sees = modelSees(this.#app, config, model) ?? modelSeesByName(model);
      if (!sees) return LEFT_OUT.blind;
    }
    if (job === 'adult' && !adultModeOn(this.#app.settings.get())) return LEFT_OUT.adultOff;
    if (job === 'private' && !(config.local && !isCloudModelName(model))) return LEFT_OUT.notOwn;
    return undefined;
  }

  /** The tasks to run and the plan the owner sees (nothing runs). */
  async #prepare(req: TestRequest, skip: Set<string>): Promise<{ plan: PlanView; work: Work[] }> {
    const s = this.#app.settings.get();
    const jobs = this.#jobsOf(req);
    const asked = req.jobs?.length ? req.jobs : jobs;
    const seen = new Set<string>();
    const models: PlanModel[] = [];
    const work: Work[] = [];
    for (const m of await this.#scopeModels(req.scope)) {
      const key = `${m.providerId}\n${m.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const config = s.providers.find((p) => p.id === m.providerId);
      if (!config) {
        models.push({ ...m, label: m.model, billing: 'api', included: false, why: LEFT_OUT.noProvider });
        continue;
      }
      const billing = billingOf(config, m.model);
      const base = { providerId: m.providerId, model: m.model, label: labelOf(config, m.model), billing };
      if (billing === 'api' && !req.includePaid) {
        models.push({ ...base, included: false, why: LEFT_OUT.paid });
        continue;
      }
      const reasons = asked.map((j) => (jobs.includes(j) ? this.#leftOut(config, m.model, j) : LEFT_OUT.adultOff));
      const ok = asked.filter((j, i) => jobs.includes(j) && !reasons[i]);
      if (!ok.length) {
        models.push({ ...base, included: false, why: reasons.find(Boolean) });
        continue;
      }
      models.push({ ...base, included: true });
      const tasks: Work['tasks'] = [];
      for (const task of TASKS) {
        const job = ok.find((j) => task.jobs.includes(j));
        if (job && !skip.has(`${key}\n${task.id}`)) tasks.push({ task, job });
      }
      if (tasks.length) work.push({ ...m, billing, warm: billing === 'local' && tasks.some((t) => t.task.kind === 'chat'), tasks });
    }
    const callsOf = (w: Work) => w.tasks.length + (w.warm ? 1 : 0);
    const calls = work.reduce((n, w) => n + callsOf(w), 0);
    // About 10 s a call on the owner's hardware, 6 s elsewhere; two providers at once.
    const perProvider = new Map<string, number>();
    for (const w of work) perProvider.set(w.providerId, (perProvider.get(w.providerId) ?? 0) + callsOf(w) * (w.billing === 'local' ? 10 : 6));
    const secs = [...perProvider.values()];
    const total = secs.reduce((a, b) => a + b, 0);
    const minutes = calls ? Math.max(1, Math.ceil(Math.max(Math.max(0, ...secs), total / MAX_PARALLEL) / 60)) : 0;
    return { plan: { models, jobs, calls, paidCalls: work.filter((w) => w.billing === 'api').reduce((n, w) => n + callsOf(w), 0), minutes }, work };
  }

  /** The (model, task) pairs a stopped owner run already finished (its next start carries on), and its lineage. */
  #resumable(): { lineage?: string; skip: Set<string> } {
    const last = this.#db.prepare('SELECT id, lineage, state FROM model_test_runs WHERE background = 0 ORDER BY rowid DESC LIMIT 1').get() as { id: string; lineage: string; state: string } | undefined;
    if (!last || last.state === 'done') return { skip: new Set() };
    const rows = this.#db.prepare('SELECT provider_id, model, task_id FROM model_test_results WHERE run = ? AND task_set = ?').all(last.lineage, TASK_SET) as { provider_id: string; model: string; task_id: string }[];
    return { lineage: last.lineage, skip: new Set(rows.map((r) => `${r.provider_id}\n${r.model}\n${r.task_id}`)) };
  }

  async plan(req: TestRequest): Promise<PlanView> {
    return (await this.#prepare(req, this.#resumable().skip)).plan;
  }

  // ---- runs ----

  status(): { run: RunView | null } {
    return { run: this.#run ? { ...this.#run.view } : null };
  }

  #publish(): void {
    if (this.#run) this.#app.events?.publish({ type: 'model-tests', run: { ...this.#run.view } });
  }

  /** Starts a run (409 when an owner run is going; a background run gives way). */
  async start(req: TestRequest): Promise<{ runId: string }> {
    if (this.#starting || (this.#run?.view.state === 'running' && !this.#run.background)) throw new ModelTestsBusy(en('A model test is already running.'));
    this.#starting = true;
    try {
      await this.#giveWay();
      const resume = this.#resumable();
      const { work } = await this.#prepare(req, resume.skip);
      // A background run may have begun while the list was read.
      await this.#giveWay();
      return { runId: this.#begin(work, false, resume.lineage) };
    } finally {
      this.#starting = false;
    }
  }
  #starting = false;

  /** A background run stops for the owner's run; its models not reached yet wait for the next turn. */
  async #giveWay(): Promise<void> {
    const bg = this.#run;
    if (!bg || bg.view.state !== 'running' || !bg.background) return;
    bg.abort.abort();
    await bg.done;
    const tested = new Set((this.#db.prepare('SELECT DISTINCT provider_id, model FROM model_test_results WHERE task_set = ?').all(TASK_SET) as { provider_id: string; model: string }[]).map((r) => `${r.provider_id}\n${r.model}`));
    for (const key of bg.models) {
      const [providerId, model] = key.split('\n');
      if (!tested.has(key)) this.#queue.push({ providerId, model });
    }
  }

  #begin(work: Work[], background: boolean, lineage?: string): string {
    const id = `mt-${this.#app.now().getTime().toString(36)}-${(++this.#seq).toString(36)}`;
    const startedAt = this.#app.now().toISOString();
    this.#db.prepare('INSERT INTO model_test_runs (id, lineage, background, state, started_at) VALUES (?, ?, ?, ?, ?)').run(id, lineage ?? id, background ? 1 : 0, 'running', startedAt);
    const run: Run = { view: { id, state: 'running', done: 0, total: work.reduce((n, w) => n + w.tasks.length, 0), startedAt }, lineage: lineage ?? id, background, models: new Set(work.map((w) => `${w.providerId}\n${w.model}`)), abort: new AbortController(), done: Promise.resolve() };
    this.#run = run;
    this.#publish();
    run.done = this.#runAll(run, work).then(
      () => this.#end(run, run.abort.signal.aborted ? 'stopped' : 'done'),
      (err: Error) => this.#end(run, 'failed', err.message.slice(0, 300)),
    );
    return id;
  }

  #end(run: Run, state: RunView['state'], error?: string): void {
    run.view = { ...run.view, state, endedAt: this.#app.now().toISOString(), ...(error ? { error } : {}) };
    delete run.view.current;
    this.#db.prepare('UPDATE model_test_runs SET state = ?, ended_at = ? WHERE id = ?').run(state, run.view.endedAt!, run.view.id);
    this.#publish();
    // Waiting new models (autoNew) go next, when nothing else runs.
    queueMicrotask(() => this.#drainQueue());
  }

  /** Stops the run going (what finished is kept). */
  stop(): void {
    if (this.#run?.view.state === 'running') this.#run.abort.abort();
  }

  /** For tests and shutdown: resolves when the current run has ended. */
  async idle(): Promise<void> {
    for (let r = this.#run; r && r.view.state === 'running'; r = this.#run) await r.done;
  }

  async #runAll(run: Run, work: Work[]): Promise<void> {
    // Models as the outer loop, one model at a time per provider, providers side by side.
    const groups = new Map<string, Work[]>();
    for (const w of work) groups.set(w.providerId, [...(groups.get(w.providerId) ?? []), w]);
    const queue = [...groups.values()];
    const lanes = run.background ? 1 : Math.min(MAX_PARALLEL, queue.length);
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        for (let g = queue.shift(); g; g = queue.shift()) for (const w of g) if (!run.abort.signal.aborted) await this.#runModel(run, w);
      }),
    );
  }

  async #runModel(run: Run, w: Work): Promise<void> {
    const signal = run.abort.signal;
    let inRow = 0;
    try {
      // A model on the owner's hardware may need to load first: one warm-up call with a long limit, not scored.
      if (w.warm) {
        await this.#quiet(run);
        await this.#ask(w, { id: 'warm-up', kind: 'chat', jobs: [], limitMs: testTiming.warmMs, maxTokens: 5, prompt: 'Reply with OK.', check: () => ({ pass: true, reason: '' }) }, signal).catch((err) => {
          if (err instanceof Stopped) throw err;
        });
      }
      for (const { task, job } of w.tasks) {
        if (signal.aborted) return;
        run.view.current = { providerId: w.providerId, model: w.model, job };
        this.#publish();
        let r: Result;
        if (inRow >= ERRORS_IN_A_ROW) r = { pass: false, reason: 'not asked', error: enf('Skipped after {n} errors in a row.', { n: ERRORS_IN_A_ROW }) };
        else {
          await this.#quiet(run);
          r = await this.#ask(w, task, signal);
        }
        inRow = r.error ? inRow + 1 : 0;
        this.#record(run, w, task.id, r);
        run.view.done++;
        this.#publish();
      }
    } catch (err) {
      if (!(err instanceof Stopped)) throw err;
    }
  }

  /** A background run waits while the owner is talking to her (low priority). */
  async #quiet(run: Run): Promise<void> {
    if (!run.background) return;
    for (;;) {
      if (run.abort.signal.aborted) throw new Stopped();
      const last = this.#app.store.lastOwnerMessageAt();
      if (!last || Date.now() - last.getTime() >= testTiming.quietMs) return;
      await new Promise((r) => setTimeout(r, testTiming.waitMs));
    }
  }

  #record(run: Run, w: Work, taskId: string, r: Result): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO model_test_results (provider_id, model, task_id, task_set, pass, reason, error, first_ms, total_ms, at, run) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(w.providerId, w.model, taskId, TASK_SET, r.pass ? 1 : 0, r.reason.slice(0, 200), r.error ?? null, r.firstMs ?? null, r.totalMs ?? null, this.#app.now().toISOString(), run.lineage);
    this.#version++;
  }

  /** One task, one call. Errors and timeouts come back as `error`; a stopped run throws Stopped. */
  async #ask(w: ModelRef, task: TestTask, runSignal: AbortSignal): Promise<Result> {
    const timeout = AbortSignal.timeout(task.limitMs);
    const signal = AbortSignal.any([runSignal, timeout]);
    const t0 = Date.now();
    try {
      const config = this.#app.settings.get().providers.find((p) => p.id === w.providerId);
      if (!config) throw new Error(LEFT_OUT.noProvider);
      if (task.kind === 'embed') {
        const vectors = await embedTexts({ config, key: this.#app.vault.get(vaultKeyFor(config.id)) ?? undefined, model: w.model }, task.texts, signal);
        const ms = Date.now() - t0;
        return { ...(await safeCheck(() => task.check(vectors, ms))), firstMs: ms, totalMs: ms };
      }
      const { provider } = resolveProvider(this.#app, w.providerId, w.model, { purpose: 'model-tests' });
      const messages: ChatMessage[] = [];
      if (task.system) messages.push({ role: 'system', content: task.system === 'persona' ? this.#persona() : task.system });
      messages.push(...(task.history ?? []), { role: 'user', content: task.prompt, ...(task.image ? { images: [task.image()] } : {}) }, ...(task.followUp ?? []));
      let text = '';
      let calls: ToolCall[] = [];
      let firstMs: number | undefined;
      // Many models think before they answer, whatever "reasoning: none" asks, and the thinking
      // counts against the output limit: on the first real run (2026-11-24, eight cloud models) a
      // limit of 120 to 300 tokens gave "empty reply" for most tasks and cut others short. So the
      // task's own limit is for the ANSWER, with room for thinking on top, and one more try with
      // far more room when nothing came back (the turn loop asks once more the same way).
      for (const room of THINK_ROOM) {
        text = '';
        calls = [];
        for await (const ev of provider.stream({ model: w.model, messages, ...(task.tools ? { tools: task.tools } : {}), temperature: 0, maxTokens: task.maxTokens + room, reasoning: 'none', signal })) {
          if (ev.type === 'text') text += ev.text;
          else if (ev.type === 'tool_call') calls.push(ev.call);
          else continue;
          if (firstMs === undefined && (calls.length || text.trim())) firstMs = Date.now() - t0;
        }
        if (runSignal.aborted) throw new Stopped();
        if (cleanReply(text) || calls.length) break;
      }
      const totalMs = Date.now() - t0;
      const reply = { text: cleanReply(text), calls };
      if (!reply.text && !calls.length) return { pass: false, reason: 'empty reply', firstMs, totalMs };
      return { ...(await safeCheck(() => task.check(reply))), ...(firstMs !== undefined ? { firstMs } : {}), totalMs };
    } catch (err) {
      if (runSignal.aborted) throw new Stopped();
      const totalMs = Date.now() - t0;
      const error = timeout.aborted ? enf('No answer within {s} seconds.', { s: Math.round(task.limitMs / 1000) }) : (err as Error).message.slice(0, 300) || 'error';
      return { pass: false, reason: 'error', error, totalMs };
    }
  }

  /** Her real instructions (as the Hard talk check sends them). */
  #persona(): string {
    const s = this.#app.settings.get();
    return buildSystemPrompt(this.#app.persona, { now: this.#app.now(), ownerName: s.ownerName, ...(s.timeZone ? { timeZone: s.timeZone } : {}) });
  }

  // ---- scores ----

  #rows(): Row[] {
    return this.#db.prepare('SELECT provider_id, model, task_id, task_set, pass, reason, error, first_ms, total_ms, at FROM model_test_results').all() as unknown as Row[];
  }

  /** Each tested model's rows from its newest task set. */
  #byModel(): Map<string, { ref: ModelRef; set: number; rows: Row[] }> {
    const out = new Map<string, { ref: ModelRef; set: number; rows: Row[] }>();
    for (const r of this.#rows()) {
      const key = `${r.provider_id}\n${r.model}`;
      const cur = out.get(key);
      if (!cur || r.task_set > cur.set) out.set(key, { ref: { providerId: r.provider_id, model: r.model }, set: r.task_set, rows: [r] });
      else if (r.task_set === cur.set) cur.rows.push(r);
    }
    return out;
  }

  /** May this model be suggested for this job here and now (provider still there, the job's own rules)? */
  #suggestable(config: ProviderConfig | undefined, model: string, job: RoutePurpose): boolean {
    return Boolean(config) && !this.#leftOut(config!, model, job);
  }

  #best(): BestCache {
    const c = this.#bestCache;
    if (c && c.version === this.#version && Date.now() - c.at < 60_000) return c;
    const s = this.#app.settings.get();
    const scores = new Map<string, Partial<Record<RoutePurpose, JobScore>>>();
    const contenders = new Map<RoutePurpose, Contender[]>();
    for (const [key, m] of this.#byModel()) {
      const config = s.providers.find((p) => p.id === m.ref.providerId);
      const fresh = m.set === TASK_SET;
      const per: Partial<Record<RoutePurpose, JobScore>> = {};
      for (const job of ROUTE_PURPOSES) {
        // Shared tasks would give a score for a job the model is not for (Private on a cloud model).
        if (config && !this.#suggestable(config, m.ref.model, job)) continue;
        const sc = jobScore(m.rows, job, fresh);
        if (!sc) continue;
        per[job] = sc;
        if (fresh && config) contenders.set(job, [...(contenders.get(job) ?? []), { ...m.ref, billing: billingOf(config, m.ref.model), here: onThisComputer(config, m.ref.model), s: sc }]);
      }
      scores.set(key, per);
    }
    const best: Partial<Record<RoutePurpose, BestEntry[]>> = {};
    for (const [job, list] of contenders) {
      const b = pickBest(job, list);
      if (b.length) best[job] = b;
    }
    this.#bestCache = { version: this.#version, at: Date.now(), best, scores };
    return this.#bestCache;
  }

  /** Auto (src/auto-route.ts): the best tested models for a job, best first, with their numbers. */
  bestFor(job: RoutePurpose): (BestEntry & { passed: number; total: number })[] {
    const b = this.#best();
    return (b.best[job] ?? []).map((e) => {
      const sc = b.scores.get(`${e.providerId}\n${e.model}`)?.[job];
      return { ...e, passed: sc?.passed ?? 0, total: sc?.total ?? 0 };
    });
  }

  async scores(): Promise<ScoresView> {
    const s = this.#app.settings.get();
    const b = this.#best();
    const by = this.#byModel();
    const models: ScoresView['models'] = [];
    for (const [key, m] of by) {
      const config = s.providers.find((p) => p.id === m.ref.providerId);
      if (!config) continue;
      const billing = billingOf(config, m.ref.model);
      const testedAt = m.rows.reduce((a, r) => (r.at > a ? r.at : a), '');
      models.push({ ...m.ref, label: labelOf(config, m.ref.model), billing, local: billing === 'local', ...(testedAt ? { testedAt } : {}), stale: m.set < TASK_SET, scores: b.scores.get(key) ?? {} });
    }
    const untested: ScoresView['untested'] = [];
    for (const m of await this.#scopeModels({ kind: 'all' })) {
      const config = s.providers.find((p) => p.id === m.providerId);
      if (!config || by.has(`${m.providerId}\n${m.model}`) || untested.some((u) => u.providerId === m.providerId && u.model === m.model)) continue;
      if (ROUTE_PURPOSES.every((j) => this.#leftOut(config, m.model, j))) continue;
      untested.push({ ...m, label: labelOf(config, m.model) });
    }
    return { taskSet: TASK_SET, jobs: JOBS.map((j) => ({ id: j.id, label: j.label, tasks: tasksFor(j.id).length })), models, best: b.best, untested };
  }

  /** Each job's model becomes its best tested one, the next two its backups. Jobs with no scores are left alone. */
  apply(jobs?: RoutePurpose[]): { changed: { job: RoutePurpose; providerId: string; model: string; backups: ModelRef[] }[]; previous: Partial<Record<RoutePurpose, ModelRoute | null>> } {
    const b = this.#best().best;
    const s = this.#app.settings.get();
    const routes = { ...(s.routes ?? {}) };
    const changed: { job: RoutePurpose; providerId: string; model: string; backups: ModelRef[] }[] = [];
    const previous: Partial<Record<RoutePurpose, ModelRoute | null>> = {};
    for (const job of jobs?.length ? jobs : ROUTE_PURPOSES) {
      const list = b[job];
      if (!list?.length) continue;
      const backups = list.slice(1, 3).map((e) => ({ providerId: e.providerId, model: e.model }));
      previous[job] = routes[job] ? structuredClone(routes[job]!) : null;
      routes[job] = { providerId: list[0].providerId, model: list[0].model, ...(backups.length ? { fallbacks: backups } : {}) };
      changed.push({ job, providerId: list[0].providerId, model: list[0].model, backups });
    }
    if (changed.length) this.#app.settings.update({ routes });
    return { changed, previous };
  }

  /** A provider was removed: its results go too. */
  forgetProvider(providerId: string): void {
    forgetModelTestResults(this.#db, providerId);
    this.#version++;
  }

  // ---- modelTests.autoNew ----

  /**
   * After a provider's model list was checked: with modelTests.autoNew on, its models on the owner's
   * own hardware that have no results yet are tested in the background, one at a time. Never a model
   * that is paid for or runs elsewhere.
   */
  async afterListRefresh(providerId: string): Promise<void> {
    const s = this.#app.settings.get();
    if (s.modelTests?.autoNew !== true) return;
    const config = s.providers.find((p) => p.id === providerId);
    if (!config || billingOf(config) !== 'local') return;
    const have = new Set((this.#db.prepare('SELECT DISTINCT model FROM model_test_results WHERE provider_id = ? AND task_set = ?').all(providerId, TASK_SET) as { model: string }[]).map((r) => r.model));
    for (const model of await this.#modelsOf(config)) {
      const busy = this.#run?.view.state === 'running' && this.#run.background && this.#run.models.has(`${providerId}\n${model}`);
      if (billingOf(config, model) !== 'local' || have.has(model) || busy || this.#queue.some((q) => q.providerId === providerId && q.model === model)) continue;
      this.#queue.push({ providerId, model });
    }
    this.#drainQueue();
  }

  #draining = false;
  #drainQueue(): void {
    if (this.#draining || this.#starting || this.#run?.view.state === 'running' || !this.#queue.length) return;
    if (this.#app.settings.get().modelTests?.autoNew !== true) {
      this.#queue.length = 0;
      return;
    }
    this.#draining = true;
    const models = this.#queue.splice(0, this.#queue.length);
    void this.#prepare({ scope: { kind: 'models', models }, includePaid: false }, new Set())
      .then(({ work }) => {
        // Only models that cost nothing, even if a provider changed meanwhile.
        const free = work.filter((w) => w.billing === 'local');
        if (free.length && !this.#starting && this.#run?.view.state !== 'running') this.#begin(free, true);
        else this.#queue.push(...free.map((w) => ({ providerId: w.providerId, model: w.model })));
      })
      .catch((err: Error) => console.warn(`model tests: ${err.message}`))
      .finally(() => (this.#draining = false));
  }
}

interface Result {
  pass: boolean;
  reason: string;
  error?: string;
  firstMs?: number;
  totalMs?: number;
}

async function safeCheck(fn: () => { pass: boolean; reason: string } | Promise<{ pass: boolean; reason: string }>): Promise<{ pass: boolean; reason: string }> {
  try {
    return await fn();
  } catch (err) {
    return { pass: false, reason: `check failed: ${(err as Error).message}`.slice(0, 200) };
  }
}
