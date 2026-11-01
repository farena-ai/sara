// Phase 79 (harness track M4, docs/design/HARNESS_TRACK.md §2.6, §3 M4, §7 #3): enforced cost
// budgets. One Budget object (tokens, dollars, steps, minutes) for every kind of task: a chat turn,
// a background job, a team task. `budgetCheck` compares it with what a task has spent so far (the
// run recorder's live sums for turns, the usage meter for jobs and team tasks); jobs and team
// tasks keep their own limits, settings keys and "Continue with more budget" and are checked
// through it. Chat turns get a TurnMeter: a set of TurnHooks (src/chat.ts) that, when a limit is
// about to be crossed, steps down a ladder instead of running on:
//   1. switch the remaining calls to the quick model (when one is set and it is cheaper),
//   2. cap the remaining tool loops (one more round, then answer),
//   3. one last small call WITHOUT tools: say what is done, what was dropped, and stop.
// Going on needs an explicit override: the "Continue with N more" button (a new turn with exactly
// that much more), or, with "Ask me before going on", an approval card. Nothing here skips the
// safety checks or an approval: the summary is a normal step of the loop (minors check, receipt
// check), and the tools of a capped step still go through their approvals.
import type { Billing } from './usage.ts';
import { trOwner } from './i18n.ts';
import type { Settings } from './settings.ts';
import type { ChatMessage, Provider } from './providers/types.ts';

/** The degrade ladder, in order (§2.6). */
export type Rung = 'smaller-model' | 'fewer-tools' | 'summarize-stop';
export const LADDER: readonly Rung[] = ['smaller-model', 'fewer-tools', 'summarize-stop'];

/**
 * A budget for one task (0/undefined = no limit on that line). Jobs and team tasks set tokens/usd
 * (team tasks also steps = helper runs and minutes); turns may set all four.
 */
export interface Budget {
  tokens?: number;
  usd?: number;
  steps?: number;
  minutes?: number;
  /** Which rungs of the ladder may be used (default: all three). */
  degrade?: Rung[];
}
export type Dimension = 'tokens' | 'usd' | 'steps' | 'minutes';

/** What a task has spent so far. */
export interface Spent {
  tokens: number;
  usd: number;
  /** Paid (API) calls with no price: their cost isn't in `usd`. */
  unpriced?: number;
  steps?: number;
  ms?: number;
  /** How the calls so far are paid for (a subscription's $ is meaningless, risk 6). */
  billing?: Billing[];
}

export interface BudgetCheck {
  /** The first line that is reached (or would be passed by `next`). */
  reached?: Dimension;
  /** That line in plain words ("its token budget (1,000 tokens)"). */
  reason?: string;
  /** The largest share used of any line (0–1+). */
  frac: number;
  /** The line closest to its limit. */
  top?: Dimension;
  /** A dollar limit was set but this task runs on a subscription (or locally): not counted. */
  usdIgnored?: boolean;
}

const fmtN = (n: number) => Math.round(n).toLocaleString('en-US');

/** The plain words for a line of a budget (the job/team texts use their own for theirs). */
export function reasonFor(dim: Dimension, b: Budget): string {
  switch (dim) {
    case 'tokens':
      return `its token budget (${fmtN(b.tokens ?? 0)} tokens)`;
    case 'usd':
      return `its budget of $${(b.usd ?? 0).toFixed(2)}`;
    case 'steps':
      return `its step limit (${fmtN(b.steps ?? 0)} steps)`;
    case 'minutes':
      return `its time limit (${fmtN(b.minutes ?? 0)} minutes)`;
  }
}

/** True when dollars mean nothing for these calls: none of them is a paid API call. */
export function usdMeaningless(billing: Billing[] | undefined): boolean {
  return Boolean(billing?.length) && !billing!.includes('api');
}

/**
 * Compares a budget with what was spent. A line is reached when it is used up, or when `next` (what
 * the coming call or step will roughly add) would take it past its limit. Order: tokens, dollars,
 * steps, minutes. Dollars are not counted for subscription/local calls (they cost $0 and the UI
 * says a $ limit can't apply there); a dollar-only budget on a paid model with no price stops at
 * the first such call (security review L4: it can't be kept, so it isn't run on unmetered).
 */
export function budgetCheck(b: Budget | undefined, used: Spent, opts: { next?: Partial<Spent> } = {}): BudgetCheck {
  if (!b) return { frac: 0 };
  const next = opts.next ?? {};
  const ignoreUsd = Boolean(b.usd) && usdMeaningless(used.billing);
  const lines: [Dimension, number, number, number][] = [];
  if (b.tokens) lines.push(['tokens', b.tokens, used.tokens, next.tokens ?? 0]);
  if (b.usd && !ignoreUsd) lines.push(['usd', b.usd, used.usd, next.usd ?? 0]);
  if (b.steps) lines.push(['steps', b.steps, used.steps ?? 0, next.steps ?? 0]);
  if (b.minutes) lines.push(['minutes', b.minutes * 60_000, used.ms ?? 0, next.ms ?? 0]);
  let frac = 0;
  let top: Dimension | undefined;
  let reached: Dimension | undefined;
  for (const [dim, limit, u, n] of lines) {
    const f = u / limit;
    if (f > frac || top === undefined) {
      frac = Math.max(frac, f);
      top = dim;
    }
    // Minutes: over once past the limit (a job/team check every few seconds lands exactly on it).
    const hit = dim === 'minutes' ? u > limit || (n > 0 && u + n > limit) : u >= limit || (n > 0 && u + n > limit);
    if (hit && !reached) reached = dim;
  }
  if (!reached && b.usd && !ignoreUsd && !b.tokens && (used.unpriced ?? 0) > 0) {
    return { reached: 'usd', reason: `its budget of $${b.usd.toFixed(2)}: there's no price for this model, so its cost can't be counted (set a token budget or a price for the model)`, frac: Math.max(frac, 1), top: 'usd' };
  }
  return { ...(reached ? { reached, reason: reasonFor(reached, b) } : {}), frac, ...(top ? { top } : {}), ...(ignoreUsd ? { usdIgnored: true } : {}) };
}

/** The first budget line that is reached, in plain words, or undefined (jobs; Phase 52's rule). */
export function overBudget(b: Budget | undefined, used: { tokens: number; usd: number; unpriced?: number }): string | undefined {
  return budgetCheck(b ? { ...(b.tokens ? { tokens: b.tokens } : {}), ...(b.usd ? { usd: b.usd } : {}) } : undefined, used).reason;
}

// ------------------------------------------------------------------------------------------------
// Per-turn budgets (Settings → Abilities → Budgets)
// ------------------------------------------------------------------------------------------------

export interface TurnLimits {
  on: boolean;
  tokens: number;
  steps: number;
  /** 0 = no dollar limit. */
  usd: number;
  /** 0 = no time limit. */
  minutes: number;
}
export interface TurnBudgetSettings {
  /** Coding conversations (and work channels). §7 #3: on, 200k tokens / 40 steps, no $. */
  coding: TurnLimits;
  /** Everyday chats: off by default (the old 25-step stop still applies). */
  chat: TurnLimits;
  /** Rung 1: switch to the quick model near the limit (when one is set and cheaper). */
  quick: boolean;
  /** At the limit: 'wrap' = summarize and stop (Continue button); 'ask' = an approval card first. */
  onLimit: 'wrap' | 'ask';
}
export const TOKEN_CHOICES = [20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000] as const;
export const STEP_CHOICES = [5, 10, 20, 25, 40, 60, 80, 120] as const;
export const USD_CHOICES = [0, 0.1, 0.25, 0.5, 1, 2, 5, 10] as const;
export const MINUTE_CHOICES = [0, 5, 10, 20, 30, 60] as const;
export const DEFAULT_TURN_BUDGETS: TurnBudgetSettings = {
  coding: { on: true, tokens: 200_000, steps: 40, usd: 0, minutes: 0 },
  chat: { on: false, tokens: 100_000, steps: 20, usd: 0, minutes: 0 },
  quick: true,
  onLimit: 'wrap',
};
/** A turn never runs more model steps than this, whatever the budget says. */
export const HARD_STEP_CAP = 200;

const pick = <T extends number>(v: unknown, choices: readonly T[], d: T, allowOther = true): T => {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return d;
  if ((choices as readonly number[]).includes(n)) return n as T;
  return allowOther ? (Math.max(0, n) as T) : d;
};

function cleanLimits(v: unknown, d: TurnLimits): TurnLimits {
  const l = (v ?? {}) as Record<string, unknown>;
  const tokens = Math.min(50_000_000, Math.max(1000, Math.round(pick(l.tokens, TOKEN_CHOICES, d.tokens as (typeof TOKEN_CHOICES)[number]))));
  const steps = Math.min(HARD_STEP_CAP, Math.max(2, Math.round(pick(l.steps, STEP_CHOICES, d.steps as (typeof STEP_CHOICES)[number]))));
  const usd = Math.min(10_000, Math.round(pick(l.usd, USD_CHOICES, d.usd as (typeof USD_CHOICES)[number]) * 100) / 100);
  const minutes = Math.min(240, Math.round(pick(l.minutes, MINUTE_CHOICES, d.minutes as (typeof MINUTE_CHOICES)[number])));
  return { on: l.on === undefined ? d.on : Boolean(l.on), tokens, steps, usd, minutes };
}

/** The owner's turn budgets with defaults filled in and every value in range. */
export function turnBudgetSettings(s: { turnBudgets?: unknown } | undefined): TurnBudgetSettings {
  const v = (s?.turnBudgets ?? {}) as Record<string, unknown>;
  return {
    coding: cleanLimits(v.coding, DEFAULT_TURN_BUDGETS.coding),
    chat: cleanLimits(v.chat, DEFAULT_TURN_BUDGETS.chat),
    quick: v.quick === undefined ? DEFAULT_TURN_BUDGETS.quick : Boolean(v.quick),
    onLimit: v.onLimit === 'ask' ? 'ask' : 'wrap',
  };
}

/** Merges a settings change onto the current settings (the route's PUT). */
export function mergeTurnBudgets(cur: TurnBudgetSettings, body: Record<string, unknown>): TurnBudgetSettings {
  return turnBudgetSettings({
    turnBudgets: {
      coding: { ...cur.coding, ...((body.coding ?? {}) as object) },
      chat: { ...cur.chat, ...((body.chat ?? {}) as object) },
      quick: body.quick === undefined ? cur.quick : body.quick,
      onLimit: body.onLimit === undefined ? cur.onLimit : body.onLimit,
    },
  });
}

/** The budget of one turn: coding (or work channel) vs everyday; undefined when switched off. */
export function turnBudgetFor(settings: TurnBudgetSettings, kind: 'coding' | 'chat'): Budget | undefined {
  const l = settings[kind];
  if (!l.on) return undefined;
  return { tokens: l.tokens, steps: l.steps, ...(l.usd ? { usd: l.usd } : {}), ...(l.minutes ? { minutes: l.minutes } : {}), degrade: settings.quick ? [...LADDER] : ['fewer-tools', 'summarize-stop'] };
}

/** An explicit "Continue with N more" amount (from the button or a bridge): any line > 0 counts. */
export function cleanMore(v: unknown): Budget | undefined {
  const b = (v ?? {}) as Record<string, unknown>;
  const num = (x: unknown, lo: number, hi: number) => {
    const n = Number(x);
    return x === undefined || x === null || x === '' || !Number.isFinite(n) || n <= 0 ? 0 : Math.min(hi, Math.max(lo, n));
  };
  const tokens = Math.round(num(b.tokens, 1000, 50_000_000));
  const steps = Math.round(num(b.steps, 1, HARD_STEP_CAP));
  const usd = Math.round(num(b.usd, 0.01, 10_000) * 100) / 100;
  const minutes = Math.round(num(b.minutes, 1, 240));
  const out: Budget = { ...(tokens ? { tokens } : {}), ...(steps ? { steps } : {}), ...(usd ? { usd } : {}), ...(minutes ? { minutes } : {}) };
  return Object.keys(out).length ? out : undefined;
}

/**
 * Is the quick model cheaper than the one in use? A paid model is never "cheaper" than a local
 * or subscription one; between two priced models compare the price per million tokens; a
 * different local/subscription model counts as cheaper (a smaller, faster model; dollars aren't
 * at stake there and tokens/steps/minutes still are).
 */
export function quickIsCheaper(cur: { billing: Billing; model: string; providerId: string; pricePerM?: number }, quick: { billing: Billing; model: string; providerId: string; pricePerM?: number }): boolean {
  if (cur.providerId === quick.providerId && cur.model === quick.model) return false;
  if (quick.billing === 'api') {
    if (cur.billing !== 'api') return false;
    if (quick.pricePerM === undefined) return false;
    return cur.pricePerM === undefined || quick.pricePerM < cur.pricePerM;
  }
  return true;
}

// ------------------------------------------------------------------------------------------------
// The turn meter (TurnHooks for src/chat.ts)
// ------------------------------------------------------------------------------------------------

/** What a turn's budget looks like right now (the step line meter, the card, the run). */
export interface BudgetState {
  /** 'meter' every step; 'warn' at 80%; the rung taken; 'reached' (summary made); 'extended' (the owner said go on). */
  stage: 'meter' | 'warn' | 'smaller-model' | 'fewer-tools' | 'summarize-stop' | 'reached' | 'extended';
  limits: Budget;
  used: { tokens: number; usd: number; steps: number; minutes: number };
  frac: number;
  top?: Dimension;
  reached?: Dimension;
  reason?: string;
  usdIgnored?: boolean;
  /** Rungs taken so far, in order. */
  rungs: Rung[];
  /** The model the remaining calls use after rung 1. */
  model?: string;
  /** Tool calls not run because of the budget (summaries). */
  dropped?: string[];
  /** Work that is kept (files written, commits). */
  kept?: string[];
  /** "Continue with N more": the amount the button offers (the same budget again). */
  more?: Budget;
  /** This turn continued an earlier one with this much more (explicit override). */
  override?: Budget;
}

/** The answer a beforeModelCall hook may give (src/chat.ts applies it; first hook with one wins). */
export interface ModelCallPlan {
  events?: { type: 'budget'; state: BudgetState }[];
  /** Phase 85: the recall notes that go into this call ("Remembered on her own"), shown before it. */
  recall?: { type: 'recall'; item: import('./triggers.ts').RecallItem }[];
  switchTo?: { provider: Provider; model: string };
  noTools?: boolean;
  maxTokens?: number;
  /** The summary is a short answer: no thinking out loud (a small model could spend all of it there). */
  noThinking?: boolean;
  notes?: string[];
  /** A note sent as the owner's side (after her own last message, so no model reads it as hers to finish). */
  userNote?: string;
  ask?: { summary: string; state: BudgetState };
  stop?: boolean;
}

export interface TurnMeterOptions {
  budget: Budget;
  /** The recorder's live sums (tokens in+out, usd, unpriced, unreported, billing), or undefined. */
  spent?: () => { tokens: number; usd: number; unpriced: number; unreported: number; billing: Billing[] } | undefined;
  /** The quick model for rung 1, only if it is configured, allowed here and cheaper. */
  quick?: () => { provider: Provider; model: string } | undefined;
  /** 'ask' = an approval card at the limit before summarizing. */
  onLimit?: 'wrap' | 'ask';
  /** Warn (and start the ladder) at this share of a limit. */
  warnAt?: number;
  ownerName?: string;
  /** This turn continues an earlier one with exactly this much (recorded on the run and reply). */
  override?: Budget;
  now?: () => number;
}

const SUMMARY_MAX_TOKENS = 400;
/** Tool loops still allowed once rung 2 is taken. */
const CAPPED_LOOPS = 1;
const charsOf = (messages: ChatMessage[]) => messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0) + (m.role === 'assistant' && m.toolCalls ? JSON.stringify(m.toolCalls).length : 0), 0);

/**
 * Counts what a turn spends and steps down the ladder. Fed by the run recorder's sums (tokens and
 * cost the providers report); a call that reports no usage is counted by its size (characters / 4),
 * so token budgets hold on any model. Minutes leave out the time spent waiting for the owner's OK.
 */
export class TurnMeter {
  readonly budget: Budget;
  readonly #o: TurnMeterOptions;
  readonly #started: number;
  #steps = 0;
  #estimated = 0;
  #waitMs = 0;
  #promptTok = 0;
  #stepTokens: number[] = [];
  #stepMs: number[] = [];
  #stepStart = 0;
  #lastSpent = 0;
  #rungs: Rung[] = [];
  #loopsLeft: number | undefined;
  #final = false;
  #finished = false;
  #warned = false;
  #asked: boolean | undefined;
  #model?: string;
  #dropped: string[] = [];
  #kept = new Set<string>();
  #toolsOff = false;
  #reachedChk?: BudgetCheck;
  /** The last check that started a rung (why she was saving), for a turn that ends short. */
  #nearChk?: BudgetCheck;
  /** The limit was reached and the summary made (the turn's run is 'budget'), with what was dropped. */
  get hit(): BudgetState | undefined {
    if (!this.#finished) return undefined;
    // The line that started the summary (the step count may be at its limit by now too).
    const chk = this.#reachedChk ?? budgetCheck(this.budget, this.spent());
    return this.#state('reached', { ...budgetCheck(this.budget, this.spent()), ...(chk.reached ? { reached: chk.reached, reason: chk.reason } : {}) });
  }
  /** Limits added by the owner's explicit OK on the approval card. */
  extended?: Budget;

  constructor(o: TurnMeterOptions) {
    this.#o = o;
    this.budget = { ...o.budget };
    this.#started = (o.now ?? Date.now)();
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  /** Time the owner spent deciding an approval (not counted against minutes). */
  waited(ms: number): void {
    this.#waitMs += Math.max(0, ms);
  }

  get final(): boolean {
    return this.#final;
  }

  /** The step limit the loop runs to (the summary is the last step). */
  get maxSteps(): number {
    return Math.min(HARD_STEP_CAP, (this.budget.steps ?? HARD_STEP_CAP) + (this.extended?.steps ?? 0));
  }

  spent(): Spent & { unreported: number } {
    const s = this.#o.spent?.();
    const tokens = (s?.tokens ?? 0) + this.#estimated;
    return { tokens, usd: s?.usd ?? 0, unpriced: s?.unpriced ?? 0, unreported: s?.unreported ?? 0, steps: this.#steps, ms: Math.max(0, this.#now() - this.#started - this.#waitMs), billing: s?.billing ?? [] };
  }

  #state(stage: BudgetState['stage'], chk?: { frac: number; top?: Dimension; reached?: Dimension; reason?: string; usdIgnored?: boolean }): BudgetState {
    const u = this.spent();
    const c = chk ?? budgetCheck(this.budget, u);
    return {
      stage,
      limits: { ...this.budget, degrade: undefined },
      used: { tokens: Math.round(u.tokens), usd: Math.round(u.usd * 1e6) / 1e6, steps: u.steps ?? 0, minutes: Math.round(((u.ms ?? 0) / 60_000) * 10) / 10 },
      frac: Math.round(c.frac * 1000) / 1000,
      ...(c.top ? { top: c.top } : {}),
      ...(c.reached ? { reached: c.reached, reason: c.reason } : {}),
      ...(c.usdIgnored ? { usdIgnored: true } : {}),
      rungs: [...this.#rungs],
      ...(this.#model ? { model: this.#model } : {}),
      ...(this.#dropped.length ? { dropped: [...this.#dropped] } : {}),
      ...(this.#kept.size ? { kept: [...this.#kept] } : {}),
      more: this.moreOffer(),
      ...(this.#o.override ? { override: this.#o.override } : {}),
    };
  }

  /** The "Continue with N more" amount: the same budget again (its lines without the ladder). */
  moreOffer(): Budget {
    const b = this.budget;
    return { ...(b.tokens ? { tokens: b.tokens } : {}), ...(b.steps ? { steps: b.steps } : {}), ...(b.usd ? { usd: b.usd } : {}), ...(b.minutes ? { minutes: b.minutes } : {}) };
  }

  /** The state for the reply meta and the run (after the turn or at any point). */
  state(): BudgetState {
    return this.hit ?? this.#state(this.#warned ? 'warn' : 'meter');
  }

  #allowed(r: Rung): boolean {
    return (this.budget.degrade ?? LADDER).includes(r);
  }

  /** The summary call: no tools, small, says what's done and what was dropped. */
  #summarize(chk: BudgetCheck): ModelCallPlan {
    this.#final = true;
    this.#toolsOff = true;
    this.#reachedChk = chk;
    if (!this.#rungs.includes('summarize-stop')) this.#rungs.push('summarize-stop');
    const st = this.#state('summarize-stop', chk);
    const owner = this.#o.ownerName?.trim() || 'the owner';
    const dropped = this.#dropped.length ? ` Not run because of the budget: ${this.#dropped.slice(0, 12).join('; ')}.` : '';
    const kept = this.#kept.size ? ` Kept: ${[...this.#kept].slice(0, 12).join(', ')}.` : '';
    const note = `[Note from the app: this task is at ${chk.reason ?? 'its budget'}, so this is your last message for it. Don't call tools. In 2 to 5 short sentences tell ${owner}: what you got done (only what the tool results above show), what you did NOT get to (the next steps you had planned, and anything below that didn't run), and that they can press "Continue with more" to let you go on.${dropped}${kept}]`;
    return { noTools: true, noThinking: true, maxTokens: SUMMARY_MAX_TOKENS, notes: [note], events: [{ type: 'budget', state: st }] };
  }

  /** TurnHooks.beforeModelCall: decide what this call may do. */
  beforeModelCall(c: { step: number; messages: ChatMessage[]; model: string }): ModelCallPlan | undefined {
    if (this.#finished) return { stop: true };
    this.#toolsOff = false;
    this.#stepStart = this.#now();
    this.#promptTok = Math.round(charsOf(c.messages) / 4);
    const used = this.spent();
    // The coming step is projected from the steps so far (none yet: no projection).
    const avgTok = this.#stepTokens.length ? this.#stepTokens.reduce((a, b) => a + b, 0) / this.#stepTokens.length : 0;
    const lastTok = this.#stepTokens.at(-1) ?? avgTok;
    const avgMs = this.#stepMs.length ? this.#stepMs.reduce((a, b) => a + b, 0) / this.#stepMs.length : 0;
    const budget = this.budget;
    const now = budgetCheck(budget, used);
    // The ladder needs up to 3 more calls (quick model, one capped round, the summary) and each call
    // re-sends a prompt that keeps growing: it starts now when waiting one more step would be too late,
    // i.e. when 4 more steps like the last (+10% for the growing prompt) would pass a line.
    const LADDER = 4 * 1.1;
    const ahead = budgetCheck(budget, used, { next: { tokens: Math.max(avgTok, lastTok) * LADDER, usd: 0, steps: 1, ms: avgMs * LADDER } });
    // Steps: the last allowed step is the summary.
    const stepsLeft = budget.steps ? this.maxSteps - this.#steps : Infinity;
    const reached = now.reached && now.reached !== 'steps' ? now : stepsLeft <= 1 ? { ...now, reached: 'steps' as Dimension, reason: reasonFor('steps', { steps: this.maxSteps }) } : undefined;
    if (reached) {
      if (this.#o.onLimit === 'ask' && this.#asked === undefined && !this.extended) {
        return { ask: { summary: `This task reached ${reached.reason}. Keep going with the same again?`, state: this.#state('reached', reached) } };
      }
      return this.#summarize(reached);
    }
    const plan: ModelCallPlan = { events: [] };
    // Near a token limit no single answer may run past what is left (a model that writes its thinking
    // out loud can't spend the rest of the budget in one call): the output is capped to the room left.
    const room = budget.tokens ? budget.tokens - used.tokens - this.#promptTok : Infinity;
    if (Number.isFinite(room) && room < 8192) plan.maxTokens = Math.max(SUMMARY_MAX_TOKENS, Math.round(room));
    // An explicit "Continue with N more": she is told once, at the start, and carries on.
    if (c.step === 0 && this.#o.override) plan.userNote = `[Note from the app: ${this.#o.ownerName?.trim() || 'the owner'} pressed "Continue with more" and gave this task ${moreWords(this.#o.override)} more. Carry on from where you stopped (your last message says what was left); don't redo what is already done, and don't apologize.]`;
    // 80% of a line: a warning on the meter only. The ladder starts when the next step would pass a
    // line, or with 3 steps left (quick model at 3, one more round at 2, the summary at the last).
    // Never before the first step is done (nothing to judge by yet).
    if (this.#steps >= 1 && now.frac >= (this.#o.warnAt ?? 0.8) && !this.#warned) {
      this.#warned = true;
      plan.events!.push({ type: 'budget', state: this.#state('warn', now) });
    }
    const near = this.#steps >= 1 && (Boolean(ahead.reached) || stepsLeft <= 3);
    if (near) {
      // On the ladder a single answer may use at most a third of the room left (thinking out loud included).
      if (Number.isFinite(room)) plan.maxTokens = Math.min(plan.maxTokens ?? Infinity, Math.max(SUMMARY_MAX_TOKENS * 2, Math.round(room / 3)));
      const top = ahead.reached ?? (stepsLeft <= 3 ? 'steps' : (now.top ?? 'tokens'));
      this.#nearChk = { ...now, reached: top, reason: ahead.reason ?? reasonFor(top, { ...budget, steps: this.maxSteps }) };
      // One rung per step: the quick model first, then fewer tool loops.
      if (!this.#rungs.includes('smaller-model') && !this.#rungs.includes('fewer-tools') && this.#allowed('smaller-model')) {
        const q = this.#o.quick?.();
        if (q && q.model !== c.model) {
          this.#rungs.push('smaller-model');
          this.#model = q.model;
          plan.switchTo = q;
          plan.events!.push({ type: 'budget', state: this.#state('smaller-model', now) });
          return plan;
        }
      }
      if (!this.#rungs.includes('fewer-tools') && this.#allowed('fewer-tools')) {
        this.#rungs.push('fewer-tools');
        this.#loopsLeft = CAPPED_LOOPS;
        plan.notes = [`[Note from the app: this task is close to ${this.#nearChk.reason}. Use at most one more round of tools, then answer with what you have.]`];
        plan.events!.push({ type: 'budget', state: this.#state('fewer-tools', now) });
        return plan;
      }
    }
    // Rung 2's one more round is used: the next call is the summary (rung 3), with the line that is closest.
    if (this.#loopsLeft !== undefined && this.#loopsLeft <= 0) {
      const chk = this.#nearChk ?? { ...now, reached: now.top ?? 'tokens', reason: reasonFor(now.top ?? 'tokens', budget) };
      const sum = this.#summarize(chk);
      sum.events = [...(plan.events ?? []), ...(sum.events ?? [])];
      return sum;
    }
    plan.events!.push({ type: 'budget', state: this.#state('meter', now) });
    return plan;
  }

  /** The owner's answer on the "keep going?" card. Yes = the same budget again (an explicit override). */
  answer(yes: boolean): void {
    this.#asked = yes;
    if (yes) {
      const more = this.moreOffer();
      this.extended = more;
      if (this.budget.tokens) this.budget.tokens += more.tokens ?? 0;
      if (this.budget.usd) this.budget.usd = Math.round((this.budget.usd + (more.usd ?? 0)) * 100) / 100;
      if (this.budget.minutes) this.budget.minutes += more.minutes ?? 0;
      this.#rungs = [];
      this.#loopsLeft = undefined;
      this.#warned = false;
    }
  }

  extendedState(): BudgetState {
    return this.#state('extended');
  }

  /** TurnHooks.afterReply: one step done (counts its size when the model reported no usage). */
  afterReply(c: { reply: string; calls: unknown[]; final: boolean }): void {
    this.#steps++;
    const s = this.#o.spent?.();
    const reportedNow = s ? s.tokens : 0;
    let tok = reportedNow - this.#lastSpent;
    this.#lastSpent = reportedNow;
    if (!s || tok <= 0) {
      // Nothing reported for this step: count it by size.
      tok = this.#promptTok + Math.round((c.reply.length + (c.calls.length ? JSON.stringify(c.calls).length : 0)) / 4);
      this.#estimated += tok;
    }
    this.#stepTokens.push(tok);
    this.#stepMs.push(Math.max(0, this.#now() - this.#stepStart));
    if (c.calls.length && this.#loopsLeft !== undefined) this.#loopsLeft--;
    if (this.#final) this.#finished = true;
  }

  /**
   * The turn ended while the ladder was in use without its summary step (she answered inside the
   * capped round, or the call failed): it still counts as stopped at the budget (the card, the run).
   * Only rung 1 with a real answer is a normal finish (the quick model did the job).
   */
  endShort(emptyReply: boolean): void {
    if (this.#finished || !this.#rungs.length) return;
    if (!emptyReply && !this.#rungs.includes('fewer-tools')) return;
    this.#finished = true;
    this.#reachedChk ??= this.#nearChk;
  }

  get rungs(): Rung[] {
    return [...this.#rungs];
  }

  /** Steps (model calls of the loop) made so far. */
  get steps(): number {
    return this.#steps;
  }

  /** TurnHooks.afterTool: what was dropped (not run because tools were off) and what is kept. */
  afterTool(c: { call: { name: string }; args: Record<string, unknown>; summary: string; status: 'ok' | 'error' | 'denied'; approval: string }): void {
    // A call made while tools were off for the budget did not run: it was dropped.
    if (this.#toolsOff && c.status === 'denied' && c.approval === 'refused') this.#dropped.push(c.summary.slice(0, 160));
    const path = typeof c.args.path === 'string' ? c.args.path : typeof c.args.file === 'string' ? c.args.file : '';
    if (c.status === 'ok' && /^(write_file|edit_file|apply_patch)$/.test(c.call.name)) this.#kept.add(path.slice(0, 160) || c.call.name);
    if (c.status === 'ok' && c.call.name === 'git_commit') this.#kept.add('commit');
  }
}

/** "200,000 tokens, 40 steps" (the words in her note and the run). */
export function moreWords(b: Budget): string {
  const parts: string[] = [];
  if (b.tokens) parts.push(`${fmtN(b.tokens)} tokens`);
  if (b.steps) parts.push(`${fmtN(b.steps)} steps`);
  if (b.usd) parts.push(`$${b.usd.toFixed(2)}`);
  if (b.minutes) parts.push(`${fmtN(b.minutes)} minutes`);
  return parts.join(', ') || 'the same budget';
}

/** The app's own words when her summary came back empty (small models), with what was dropped. */
export function budgetSummaryFallback(st: BudgetState, s: Pick<Settings, 'language' | 'languageDetected'>): string {
  const reason = st.reason ?? 'its budget';
  return st.dropped?.length
    ? trOwner('I stopped here: this task reached {reason}. Not done: {dropped}. Press "Continue with more" if you want me to go on.', s, { reason, dropped: st.dropped.slice(0, 8).join('; ') })
    : trOwner('I stopped here: this task reached {reason}, so I didn\'t finish it. Press "Continue with more" if you want me to go on.', s, { reason });
}

// ---------------------------------------------------------------------------------------------
// Phase 109 (CH3, docs/design/CHATS.md §3.1 B4): the daily ledger per source, shared by the small
// model calls that never take a turn (titles now, room summaries in CH4). One row per day and
// source in the database it is given (the companion's store.db for titles); A2A, webhooks and
// plugins keep the same table in their own databases. The day is the owner's local day.
// ---------------------------------------------------------------------------------------------

export const LEDGER_SQL = `CREATE TABLE IF NOT EXISTS budget_ledger (
  day TEXT NOT NULL, source TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source)
);`;

export interface LedgerRow {
  tokens: number;
  usd: number;
  runs: number;
}

/** What a source spent today, and adding to it. `day()` gives the owner's local day (YYYY-MM-DD). */
export class DailyLedger {
  readonly #db: import('node:sqlite').DatabaseSync;
  readonly #day: () => string;
  constructor(db: import('node:sqlite').DatabaseSync, day: () => string) {
    this.#db = db;
    this.#day = day;
    db.exec(LEDGER_SQL);
  }
  day(): string {
    return this.#day();
  }
  get(source: string, day: string = this.#day()): LedgerRow {
    const r = this.#db.prepare('SELECT tokens, usd, runs FROM budget_ledger WHERE day = ? AND source = ?').get(day, source) as LedgerRow | undefined;
    return r ? { tokens: Number(r.tokens), usd: Number(r.usd), runs: Number(r.runs) } : { tokens: 0, usd: 0, runs: 0 };
  }
  add(source: string, add: Partial<LedgerRow>): void {
    this.#db
      .prepare('INSERT INTO budget_ledger (day, source, tokens, usd, runs) VALUES (?, ?, ?, ?, ?) ON CONFLICT(day, source) DO UPDATE SET tokens = tokens + excluded.tokens, usd = usd + excluded.usd, runs = runs + excluded.runs')
      .run(this.#day(), source, Math.round(add.tokens ?? 0), add.usd ?? 0, add.runs ?? 0);
  }
  /** True when one more run (and `next` tokens) still fits under the caps (0/undefined = no cap). */
  fits(source: string, cap: { runs?: number; tokens?: number }, next: { tokens?: number } = {}): boolean {
    const used = this.get(source);
    if (cap.runs && used.runs + 1 > cap.runs) return false;
    if (cap.tokens && used.tokens + (next.tokens ?? 0) > cap.tokens) return false;
    return true;
  }
}
