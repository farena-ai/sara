// V1.5 (docs/design/V1COST.md, ROADMAP_V item 37): Cost autopilot, a quality bar per job.
// Best (default): nothing changes. Good enough: Auto (src/auto-route.ts) tries the next cheaper
// connected model (on this computer first) on a sample of past turns of that job with the M9 eval
// loop (src/evals.ts) and moves the job down only when the cheaper model holds up on the quality
// parts. Every move has an Undo; "saved this month" prices the moved calls at the old model's price.
// Private chats never leave this computer: Auto's localOnly filter also runs on a moved model, and
// pickTasks never replays a private chat on a cloud model. Owner only (members have no eval loop).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { autoCandidates, autoChoose, autoOn, scoreCandidate, spendLimitHit, type AutoCand, type AutoJob } from './auto-route.ts';
import type { AppContext } from './chat.ts';
import { evalSchedule, pickTasks, WEIGHTS, TIE_EPSILON, type EvalResult, type VariantSpec } from './evals.ts';
import { en } from './i18n.ts';
import { privateLocalOn } from './net-guard.ts';
import { ReplayError } from './replay.ts';
import { QUALITY_PARTS } from './skill-learning.ts';
import { periodStarts } from './spend.ts';
import { billingOf, costOf, findPrice, priceTable } from './usage.ts';

/** The jobs with a quality bar (pictures stay on Best: replays don't carry the pictures). */
export const COST_JOBS = ['chat', 'coding', 'research'] as const;
export type CostJob = (typeof COST_JOBS)[number];
export type Bar = 'good' | 'best';
export const isCostJob = (j: unknown): j is CostJob => (COST_JOBS as readonly unknown[]).includes(j);
/** Past turns a trial replays (fewer is fine; under MIN_PAIRS nothing is decided). */
export const SAMPLE_TASKS = 8;
export const MIN_PAIRS = 3;
/** A model that failed a trial, or was undone, is not tried again for this long. */
export const RETRY_DAYS = 60;
/** The tick tries a job at most once a week, and only after 20 quiet minutes. */
const WEEK_MS = 7 * 86_400_000;
const IDLE_MS = 20 * 60_000;
const DAY_MS = 86_400_000;
const PURPOSES: Record<CostJob, string[]> = { chat: ['chat'], coding: ['coding'], research: ['research'] };

export interface ModelRef {
  providerId: string;
  model: string;
  label?: string;
}
export interface CostMove {
  to: ModelRef;
  from: ModelRef;
  at: string;
  evalId: number;
}
export type TrialState = 'running' | 'passed' | 'failed' | 'nothing' | 'error';
export interface CostTrial {
  id: number;
  job: CostJob;
  from: ModelRef;
  to: ModelRef;
  at: string;
  endedAt?: string;
  evalId: number;
  state: TrialState;
  pairs?: number;
  wins?: number;
  losses?: number;
}
export interface CostLog {
  job: CostJob;
  kind: 'moved' | 'undone' | 'best';
  to: ModelRef;
  from: ModelRef;
  at: string;
  /** A move: when it ended (Undo, Best). */
  until?: string;
}
interface CostState {
  bar: Partial<Record<CostJob, Bar>>;
  moves: Partial<Record<CostJob, CostMove>>;
  trials: CostTrial[];
  refused: { job: CostJob; providerId: string; model: string; until: string }[];
  log: CostLog[];
  seq: number;
}

const tierOf = (c: Pick<AutoCand, 'local' | 'billing'>) => (c.local || c.billing === 'local' ? 0 : c.billing === 'subscription' ? 1 : 2);
const keyOf = (c: { providerId: string; model: string }) => `${c.providerId}/${c.model}`;

/**
 * The models cheaper than `current` for a job, the one to try first at the front: on this
 * computer (best Auto score first), then subscriptions, then pay-per-use models with a lower known
 * price (the smallest step down first). A model with an unknown price is never "cheaper".
 */
export function cheaperCandidates(cands: AutoCand[], current: AutoCand, job: AutoJob, o: { price: (c: AutoCand) => number | null; skip?: (c: AutoCand) => boolean; localOnly?: boolean; spendHit?: boolean }): AutoCand[] {
  const curTier = tierOf(current);
  const curPrice = curTier === 2 ? o.price(current) : 0;
  const out: { c: AutoCand; tier: number; price: number; score: number; i: number }[] = [];
  const seen = new Set<string>([keyOf(current)]);
  cands.forEach((c, i) => {
    if (seen.has(keyOf(c))) return;
    seen.add(keyOf(c));
    const s = scoreCandidate(c, job, { localOnly: o.localOnly, spendHit: o.spendHit });
    if (!s || o.skip?.(c)) return;
    const tier = tierOf(c);
    const price = tier === 2 ? o.price(c) : 0;
    if (price === null) return;
    const cheaper = tier < curTier || (tier === 2 && curTier === 2 && curPrice !== null && price < curPrice);
    if (cheaper) out.push({ c, tier, price, score: s.score, i });
  });
  return out.sort((a, b) => a.tier - b.tier || (a.tier === 2 ? b.price - a.price : b.score - a.score) || a.i - b.i).map((x) => x.c);
}

/**
 * Does the cheaper model hold up? Only the quality parts count (tests, finished, the owner's
 * reaction, the judge, findings; never cost). At least MIN_PAIRS pairs and at most one loss per
 * five pairs; a variant run that failed counts as a loss.
 */
export function barVerdict(result: EvalResult | null | undefined): { pass: boolean; pairs: number; wins: number; losses: number } {
  const v = result?.variants.find((x) => x.id !== 'control');
  if (!result || !v) return { pass: false, pairs: 0, wins: 0, losses: 0 };
  const q = (parts: Partial<Record<string, number>>) => {
    let w = 0;
    let sum = 0;
    for (const k of QUALITY_PARTS) {
      const x = parts[k];
      if (typeof x !== 'number' || !Number.isFinite(x)) continue;
      w += WEIGHTS[k];
      sum += WEIGHTS[k] * x;
    }
    return w ? sum / w : 0;
  };
  let pairs = 0;
  let wins = 0;
  let losses = 0;
  for (const t of result.tasks) {
    const x = t.variants[v.id];
    if (!x) continue;
    pairs++;
    if (x.outcome === 'missing') {
      losses++;
      continue;
    }
    const d = q(x.parts) - q(t.control.parts);
    if (d > TIE_EPSILON) wins++;
    else if (d < -TIE_EPSILON) losses++;
  }
  return { pass: pairs >= MIN_PAIRS && losses <= Math.floor(pairs / 5), pairs, wins, losses };
}

export class CostAutopilot {
  readonly #app: AppContext;
  readonly #file: string;
  #state: CostState | undefined;
  /** The running trial's finish (tests and the tick wait on it). */
  work: Promise<void> | undefined;

  constructor(app: AppContext, file = join(app.dataDir, 'cost-autopilot.json')) {
    this.#app = app;
    this.#file = file;
  }

  #load(): CostState {
    if (this.#state) return this.#state;
    let raw: Partial<CostState> = {};
    try {
      if (existsSync(this.#file)) raw = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<CostState>;
    } catch {
      raw = {};
    }
    this.#state = { bar: raw.bar ?? {}, moves: raw.moves ?? {}, trials: Array.isArray(raw.trials) ? raw.trials : [], refused: Array.isArray(raw.refused) ? raw.refused : [], log: Array.isArray(raw.log) ? raw.log : [], seq: Number(raw.seq) || 0 };
    return this.#state;
  }

  #save(): void {
    const s = this.#load();
    s.trials = s.trials.slice(-40);
    s.log = s.log.slice(-60);
    s.refused = s.refused.filter((r) => Date.parse(r.until) > this.#now());
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 1));
    renameSync(tmp, this.#file);
  }

  #now(): number {
    return this.#app.now().getTime();
  }

  #iso(): string {
    return this.#app.now().toISOString();
  }

  #label(r: { providerId: string; model: string }): ModelRef {
    const p = this.#app.settings.get().providers.find((x) => x.id === r.providerId);
    return { providerId: r.providerId, model: r.model, label: p ? `${r.model} · ${p.label}` : r.model };
  }

  /** Dollars for a typical million tokens (80% in, 20% out); 0 on this computer or a subscription, null unknown. */
  #price(c: { providerId: string; model: string }): number | null {
    const s = this.#app.settings.get();
    const p = s.providers.find((x) => x.id === c.providerId);
    if (!p) return null;
    const table = this.#app.usage?.prices() ?? priceTable(s.prices);
    return costOf(billingOf(p), findPrice(table, c.providerId, c.model), { input: 800_000, output: 200_000 });
  }

  #opts() {
    return { localOnly: privateLocalOn(), spendHit: spendLimitHit(this.#app) };
  }

  /** The model Auto would pick without the autopilot, and the cheaper one to try next. */
  #plan(job: CostJob): { cands: AutoCand[]; current?: AutoCand; base?: AutoCand; next?: AutoCand } {
    const cands = autoCandidates(this.#app);
    const top = autoChoose(cands, job, this.#opts(), 1)[0];
    const current = top ? cands.find((c) => keyOf(c) === keyOf(top)) : undefined;
    const mv = this.#load().moves[job];
    const moved = mv ? cands.find((c) => keyOf(c) === keyOf(mv.to)) : undefined;
    const base = moved ?? current;
    if (!base) return { cands, current };
    const now = this.#now();
    const refused = this.#load().refused.filter((r) => r.job === job && Date.parse(r.until) > now);
    const next = cheaperCandidates(cands, base, job, { ...this.#opts(), price: (c) => this.#price(c), skip: (c) => refused.some((r) => r.providerId === c.providerId && r.model === c.model) })[0];
    return { cands, current, base, ...(next ? { next } : {}) };
  }

  /** The model a job was moved to (Auto puts it first, when it may be used in that chat). */
  moveFor(job: string): { providerId: string; model: string } | undefined {
    if (!isCostJob(job) || this.#load().bar[job] !== 'good') return undefined;
    const m = this.#load().moves[job];
    return m ? { providerId: m.to.providerId, model: m.to.model } : undefined;
  }

  view() {
    const st = this.#load();
    const s = this.#app.settings.get();
    const jobs = COST_JOBS.map((job) => {
      const plan = this.#plan(job);
      const move = st.moves[job];
      const trial = [...st.trials].reverse().find((t) => t.job === job);
      return {
        job,
        bar: st.bar[job] ?? 'best',
        auto: autoOn(s, job),
        ...(plan.current ? { current: this.#label(plan.current) } : {}),
        ...(move ? { move } : {}),
        ...(plan.next ? { next: this.#label(plan.next) } : {}),
        ...(trial ? { trial } : {}),
        savedUsd: this.#saved(job),
      };
    });
    return { jobs, savedUsd: Math.round(jobs.reduce((n, j) => n + j.savedUsd, 0) * 100) / 100, log: st.log.slice(-20).reverse(), available: Boolean(this.#app.evals), sample: SAMPLE_TASKS };
  }

  /** Dollars this job's moves saved this month (owner's time zone), rounded to cents. */
  #saved(job: CostJob): number {
    const usage = this.#app.usage;
    if (!usage) return 0;
    const s = this.#app.settings.get();
    const now = this.#app.now();
    const monthStart = Date.parse(periodStarts(now, s.timeZone).monthStart);
    let saved = 0;
    for (const l of this.#load().log) {
      if (l.job !== job || l.kind !== 'moved') continue;
      const since = Math.max(Date.parse(l.at), monthStart);
      const till = l.until ? Date.parse(l.until) : now.getTime();
      if (till < since) continue;
      const u = usage.between(new Date(since).toISOString(), new Date(till).toISOString(), l.to.providerId, l.to.model, PURPOSES[job]);
      const from = s.providers.find((p) => p.id === l.from.providerId);
      const old = from ? costOf(billingOf(from), findPrice(usage.prices(), l.from.providerId, l.from.model), u) : null;
      if (old !== null) saved += Math.max(0, old - u.usd);
    }
    return Math.round(saved * 100) / 100;
  }

  setBar(job: unknown, bar: unknown): void {
    if (!isCostJob(job)) throw new ReplayError(400, en('Unknown job.'));
    if (bar !== 'good' && bar !== 'best') throw new ReplayError(400, en('The quality bar is Good enough or Best.'));
    const st = this.#load();
    st.bar[job] = bar;
    if (bar === 'best' && st.moves[job]) this.#endMove(job, 'best');
    this.#save();
  }

  #endMove(job: CostJob, kind: 'undone' | 'best'): CostMove {
    const st = this.#load();
    const m = st.moves[job]!;
    const at = this.#iso();
    const open = [...st.log].reverse().find((l) => l.job === job && l.kind === 'moved' && !l.until);
    if (open) open.until = at;
    st.log.push({ job, kind, to: m.to, from: m.from, at });
    delete st.moves[job];
    return m;
  }

  /** Undo a move: back to Auto's own pick; that model is not tried again for RETRY_DAYS. */
  undo(job: unknown): void {
    if (!isCostJob(job)) throw new ReplayError(400, en('Unknown job.'));
    if (!this.#load().moves[job]) throw new ReplayError(409, en('Nothing to undo for this job.'));
    const m = this.#endMove(job, 'undone');
    this.#load().refused.push({ job, providerId: m.to.providerId, model: m.to.model, until: new Date(this.#now() + RETRY_DAYS * DAY_MS).toISOString() });
    this.#save();
  }

  /** Moves the job down (a passed trial). `from` stays the first model the job was moved away from. */
  applyMove(job: CostJob, to: { providerId: string; model: string }, from: { providerId: string; model: string }, evalId: number): void {
    const st = this.#load();
    const first = st.moves[job]?.from ?? this.#label(from);
    if (st.moves[job]) {
      const open = [...st.log].reverse().find((l) => l.job === job && l.kind === 'moved' && !l.until);
      if (open) open.until = this.#iso();
    }
    const move: CostMove = { to: this.#label(to), from: first, at: this.#iso(), evalId };
    st.moves[job] = move;
    st.bar[job] = 'good';
    st.log.push({ job, kind: 'moved', to: move.to, from: move.from, at: move.at });
    this.#save();
  }

  running(): CostTrial | undefined {
    return this.#load().trials.find((t) => t.state === 'running');
  }

  /** Tries the next cheaper model for a job on its past turns (the owner's button, or the tick). */
  async tryJob(job: unknown, o: { wait?: boolean } = {}): Promise<CostTrial> {
    const app = this.#app;
    if (!isCostJob(job)) throw new ReplayError(400, en('Unknown job.'));
    const st = this.#load();
    if (st.bar[job] !== 'good') throw new ReplayError(409, en('Set this job to Good enough first.'));
    if (!autoOn(app.settings.get(), job)) throw new ReplayError(409, en('Turn on Auto for this job first.'));
    const evals = app.evals;
    if (!evals) throw new ReplayError(409, en('Not available here.'));
    if (this.running()) throw new ReplayError(409, en('A cheaper model is being tried already.'));
    const plan = this.#plan(job);
    if (!plan.base || !plan.next) throw new ReplayError(409, en('No cheaper model to try for this job.'));
    const from = this.#label(plan.base);
    const to = this.#label(plan.next);
    const variants: VariantSpec[] = [
      { id: 'control', model: { providerId: from.providerId, model: from.model } },
      { id: 'v1', model: { providerId: to.providerId, model: to.model } },
    ];
    const judge = Boolean(app.settings.get().routes?.review);
    const kind = job === 'coding' ? 'coding' : 'everyday';
    const trial: CostTrial = { id: ++st.seq, job, from, to, at: this.#iso(), evalId: 0, state: 'running' };
    const picked = pickTasks(app, { kind, count: SAMPLE_TASKS, variants, judge });
    if (picked.tasks.length < MIN_PAIRS) {
      st.trials.push({ ...trial, state: 'nothing', endedAt: trial.at, pairs: picked.tasks.length });
      this.#save();
      return st.trials.at(-1)!;
    }
    const ev = evals.createWith({ title: `Cost check: ${to.model} for ${job}`, kind, picked, variants, judge, maxTokens: evalSchedule(app.settings.get()).budgetTokens });
    trial.evalId = ev.id;
    evals.start(ev.id);
    st.trials.push(trial);
    this.#save();
    this.work = (evals.work ?? Promise.resolve()).then(() => void this.finish(trial.id)).catch(() => void this.finish(trial.id));
    if (o.wait) await this.work;
    return this.#load().trials.find((t) => t.id === trial.id)!;
  }

  /** The trial's eval ended: move the job down when the cheaper model held up. */
  finish(id: number): CostTrial | undefined {
    const st = this.#load();
    const trial = st.trials.find((t) => t.id === id);
    const evals = this.#app.evals;
    if (!trial || trial.state !== 'running' || !evals || evals.running(trial.evalId)) return trial;
    const ev = evals.store.get(trial.evalId);
    if (ev && (ev.status === 'running' || ev.status === 'judging' || ev.status === 'draft')) return trial;
    const v = barVerdict(ev?.result);
    trial.endedAt = this.#iso();
    trial.pairs = v.pairs;
    trial.wins = v.wins;
    trial.losses = v.losses;
    if (!ev || ev.status === 'error' || ev.status === 'stopped' || ev.status === 'interrupted') trial.state = 'error';
    else if (v.pass) trial.state = 'passed';
    else if (v.pairs < MIN_PAIRS) trial.state = 'nothing';
    else trial.state = 'failed';
    if (trial.state === 'failed') st.refused.push({ job: trial.job, providerId: trial.to.providerId, model: trial.to.model, until: new Date(this.#now() + RETRY_DAYS * DAY_MS).toISOString() });
    this.#save();
    if (trial.state === 'passed') this.applyMove(trial.job, trial.to, trial.from, trial.evalId);
    this.#app.events?.publish({ type: 'eval', id: trial.evalId, status: ev?.status ?? 'error', progress: ev?.progress ?? { done: 0, total: 0, tokens: 0, usd: 0, running: 0 } });
    return trial;
  }

  /**
   * Rides the hourly eval tick (src/main.ts): finishes trials whose eval ended (after a restart),
   * then tries one Good enough job with Auto on, at most once a week per job, after 20 quiet minutes.
   */
  tick(): number | undefined {
    const app = this.#app;
    const evals = app.evals;
    if (!evals) return undefined;
    for (const t of this.#load().trials.filter((x) => x.state === 'running')) this.finish(t.id);
    if (this.running()) return undefined;
    const now = this.#now();
    if (now - evals.lastActivity() < IDLE_MS) return undefined;
    const st = this.#load();
    for (const job of COST_JOBS) {
      if (st.bar[job] !== 'good' || !autoOn(app.settings.get(), job)) continue;
      const last = [...st.trials].reverse().find((t) => t.job === job);
      if (last && now - Date.parse(last.at) < WEEK_MS) continue;
      if (!this.#plan(job).next) continue;
      this.tryJob(job).catch((err) => console.warn(`cost autopilot: the ${job} trial didn't start: ${(err as Error).message}`));
      return this.running()?.id;
    }
    return undefined;
  }
}
