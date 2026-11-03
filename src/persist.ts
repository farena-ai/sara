// Phase 118 (docs/design/PERSIST.md, 2.51.0): what goals (src/goals.ts) and loops (src/loops.ts)
// share: their settings (§3.3), the check runner P2 (§4.3, §4.4), the workspace fingerprint the
// tamper rule and "no files changed" read, and the one way both run a turn: an ordinary turn
// through the server's runTracked (the safety layer, approvals, the budget ladder, the claim check,
// the loop guard, steer and the run record all apply unchanged). Nothing here calls a model, except
// the reviewer check, which is one call on the Reviewing route.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { TOKEN_CHOICES, USD_CHOICES } from './budget.ts';
import { testCounts } from './cards.ts';
import type { AppContext, ChatEvent, TurnOptions } from './chat.ts';
import { en } from './i18n.ts';
import { complete } from './life.ts';
import { failureOf } from './loop-guard.ts';
import { scanProject } from './projectknow.ts';
import { classifyCommand, type RiskReason } from './sandbox-run.ts';
import { detectTests } from './security/fix.ts';
import type { Conversation } from './store.ts';
import { ROLES } from './team.ts';
import { runCommand } from './tools/sandbox.ts';
import { workspaceDir } from './tools/workspace.ts';
import { isGroupChannel } from './group.ts';
import { detectCheckers, projectsOf } from './diagnostics.ts';

// ------------------------------------------------------------------ settings (§3.3)

export interface GoalSettings {
  on: boolean;
  rounds: number;
  minutes: number;
  tokens: number;
  usd: number;
  stuckAfter: number;
  checkMinutes: number;
  reviewer: 'reviewing' | 'quick';
}
export interface LoopSettings {
  on: boolean;
  minEvery: number;
  defaultFor: number;
  maxFor: number;
  maxTicks: number;
  tick: { tokens: number; steps: number };
  dailyTokens: number;
  dailyUsd: number;
  quiet: 'pause' | 'hold';
  stuckAfter: number;
  failAfter: number;
  maxActive: number;
}
export interface PersistSettings {
  goals: GoalSettings;
  loops: LoopSettings;
}

export const GOAL_CHOICES = {
  rounds: [3, 5, 10, 20],
  minutes: [15, 30, 60, 120, 240],
  tokens: TOKEN_CHOICES as readonly number[],
  usd: USD_CHOICES as readonly number[],
  stuckAfter: [2, 3],
  checkMinutes: [2, 5, 10, 20, 30],
} as const;
export const LOOP_CHOICES = {
  minEvery: [1, 5, 10, 15],
  defaultFor: [1, 2, 4, 8, 24],
  maxFor: [8, 24, 72, 168],
  maxTicks: [12, 24, 48, 96],
  tickTokens: [20_000, 50_000, 100_000],
  tickSteps: [5, 10, 20],
  dailyTokens: [100_000, 300_000, 1_000_000, 3_000_000],
  dailyUsd: USD_CHOICES as readonly number[],
  stuckAfter: [3, 6, 12],
  failAfter: [1, 2, 3],
  maxActive: [1, 3, 5],
} as const;

export const DEFAULT_PERSIST: PersistSettings = {
  goals: { on: true, rounds: 5, minutes: 60, tokens: 1_000_000, usd: 0, stuckAfter: 2, checkMinutes: 10, reviewer: 'reviewing' },
  loops: { on: true, minEvery: 5, defaultFor: 4, maxFor: 24, maxTicks: 48, tick: { tokens: 50_000, steps: 10 }, dailyTokens: 300_000, dailyUsd: 0.5, quiet: 'pause', stuckAfter: 6, failAfter: 2, maxActive: 3 },
};

// Phase 128 PL2c (POLISH2.md N17, Q4): three presets instead of 16 raw numbers. *Normal* is exactly
// DEFAULT_PERSIST, so nobody's limits change; every number is one of the offered choices. The on/off
// switches, the reviewer model and At night are not part of a preset. Anything else shows as Custom.
type PresetNumbers = { goals: Omit<GoalSettings, 'on' | 'reviewer'>; loops: Omit<LoopSettings, 'on' | 'quiet'> };
const numbersOf = (s: PersistSettings): PresetNumbers => {
  const { on: _g, reviewer: _r, ...goals } = s.goals;
  const { on: _l, quiet: _q, ...loops } = s.loops;
  return { goals, loops: { ...loops, tick: { ...loops.tick } } };
};
export type PresetId = 'careful' | 'normal' | 'long';
export const PRESET_IDS: readonly PresetId[] = ['careful', 'normal', 'long'];
export const PERSIST_PRESETS: Record<PresetId, PresetNumbers> = {
  careful: {
    goals: { rounds: 3, minutes: 30, tokens: 200_000, usd: 0.25, stuckAfter: 2, checkMinutes: 5 },
    loops: { minEvery: 15, defaultFor: 2, maxFor: 8, maxTicks: 12, tick: { tokens: 20_000, steps: 5 }, dailyTokens: 100_000, dailyUsd: 0.1, stuckAfter: 3, failAfter: 1, maxActive: 1 },
  },
  normal: numbersOf(DEFAULT_PERSIST),
  long: {
    goals: { rounds: 20, minutes: 240, tokens: 2_000_000, usd: 0, stuckAfter: 3, checkMinutes: 30 },
    loops: { minEvery: 5, defaultFor: 8, maxFor: 72, maxTicks: 96, tick: { tokens: 100_000, steps: 20 }, dailyTokens: 1_000_000, dailyUsd: 2, stuckAfter: 12, failAfter: 3, maxActive: 5 },
  },
};

/** Which preset these settings are, or 'custom' (any number differs: set by hand, or saved by 2.60 that way). */
export function presetOf(s: PersistSettings): PresetId | 'custom' {
  const mine = JSON.stringify(numbersOf(s));
  return PRESET_IDS.find((id) => JSON.stringify(PERSIST_PRESETS[id]) === mine) ?? 'custom';
}

const pick = (v: unknown, list: readonly number[], dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && list.includes(n) ? n : dflt;
};

/** Settings → Coding → Keep going and repeats (owner settings). Unknown values fall back to the defaults. */
export function persistSettings(app: AppContext): PersistSettings {
  const raw = ((app.settings.get() as { persist?: { goals?: Partial<GoalSettings>; loops?: Partial<LoopSettings> & { tick?: Partial<LoopSettings['tick']> } } }).persist ?? {}) as { goals?: Partial<GoalSettings>; loops?: Partial<LoopSettings> & { tick?: Partial<LoopSettings['tick']> } };
  const g = raw.goals ?? {};
  const l = raw.loops ?? {};
  const D = DEFAULT_PERSIST;
  // A test-only override (never in the app): the shortest loop interval may go under a minute in tests.
  const minEvery = typeof l.minEvery === 'number' && l.minEvery > 0 && l.minEvery < 1 && process.env.SARA_TEST_LOOP_MINUTES === '1' ? l.minEvery : pick(l.minEvery, LOOP_CHOICES.minEvery, D.loops.minEvery);
  return {
    goals: {
      on: g.on !== false,
      rounds: pick(g.rounds, [...GOAL_CHOICES.rounds, 1, 2], D.goals.rounds),
      minutes: pick(g.minutes, GOAL_CHOICES.minutes, D.goals.minutes),
      tokens: pick(g.tokens, [...GOAL_CHOICES.tokens, 30_000], D.goals.tokens),
      usd: pick(g.usd, GOAL_CHOICES.usd, D.goals.usd),
      stuckAfter: pick(g.stuckAfter, GOAL_CHOICES.stuckAfter, D.goals.stuckAfter),
      checkMinutes: pick(g.checkMinutes, GOAL_CHOICES.checkMinutes, D.goals.checkMinutes),
      reviewer: g.reviewer === 'quick' ? 'quick' : 'reviewing',
    },
    loops: {
      on: l.on !== false,
      minEvery,
      defaultFor: pick(l.defaultFor, LOOP_CHOICES.defaultFor, D.loops.defaultFor),
      maxFor: pick(l.maxFor, LOOP_CHOICES.maxFor, D.loops.maxFor),
      maxTicks: pick(l.maxTicks, LOOP_CHOICES.maxTicks, D.loops.maxTicks),
      tick: { tokens: pick(l.tick?.tokens, LOOP_CHOICES.tickTokens, D.loops.tick.tokens), steps: pick(l.tick?.steps, LOOP_CHOICES.tickSteps, D.loops.tick.steps) },
      dailyTokens: pick(l.dailyTokens, LOOP_CHOICES.dailyTokens, D.loops.dailyTokens),
      dailyUsd: pick(l.dailyUsd, LOOP_CHOICES.dailyUsd, D.loops.dailyUsd),
      quiet: l.quiet === 'hold' ? 'hold' : 'pause',
      stuckAfter: pick(l.stuckAfter, LOOP_CHOICES.stuckAfter, D.loops.stuckAfter),
      failAfter: pick(l.failAfter, LOOP_CHOICES.failAfter, D.loops.failAfter),
      maxActive: pick(l.maxActive, LOOP_CHOICES.maxActive, D.loops.maxActive),
    },
  };
}

/** PUT /api/persist: the body's values, each kept only when it is one of the offered choices. */
export function mergePersist(app: AppContext, body: Record<string, unknown>): PersistSettings {
  const cur = persistSettings(app);
  // PL2c: { preset: 'careful' | 'normal' | 'long' } sets every number of that preset (switches kept).
  const preset = PRESET_IDS.find((id) => id === body.preset);
  if (preset) {
    const P = PERSIST_PRESETS[preset];
    body = { goals: { ...(body.goals as object), ...P.goals }, loops: { ...(body.loops as object), ...P.loops, tick: { ...P.loops.tick } } };
  }
  const g = (body.goals ?? {}) as Record<string, unknown>;
  const l = (body.loops ?? {}) as Record<string, unknown>;
  const tick = (l.tick ?? {}) as Record<string, unknown>;
  const next: PersistSettings = {
    goals: {
      on: g.on === undefined ? cur.goals.on : Boolean(g.on),
      rounds: pick(g.rounds, GOAL_CHOICES.rounds, cur.goals.rounds),
      minutes: pick(g.minutes, GOAL_CHOICES.minutes, cur.goals.minutes),
      tokens: pick(g.tokens, GOAL_CHOICES.tokens, cur.goals.tokens),
      usd: pick(g.usd, GOAL_CHOICES.usd, cur.goals.usd),
      stuckAfter: pick(g.stuckAfter, GOAL_CHOICES.stuckAfter, cur.goals.stuckAfter),
      checkMinutes: pick(g.checkMinutes, GOAL_CHOICES.checkMinutes, cur.goals.checkMinutes),
      reviewer: g.reviewer === undefined ? cur.goals.reviewer : g.reviewer === 'quick' ? 'quick' : 'reviewing',
    },
    loops: {
      on: l.on === undefined ? cur.loops.on : Boolean(l.on),
      minEvery: pick(l.minEvery, LOOP_CHOICES.minEvery, cur.loops.minEvery),
      defaultFor: pick(l.defaultFor, LOOP_CHOICES.defaultFor, cur.loops.defaultFor),
      maxFor: pick(l.maxFor, LOOP_CHOICES.maxFor, cur.loops.maxFor),
      maxTicks: pick(l.maxTicks, LOOP_CHOICES.maxTicks, cur.loops.maxTicks),
      tick: { tokens: pick(tick.tokens, LOOP_CHOICES.tickTokens, cur.loops.tick.tokens), steps: pick(tick.steps, LOOP_CHOICES.tickSteps, cur.loops.tick.steps) },
      dailyTokens: pick(l.dailyTokens, LOOP_CHOICES.dailyTokens, cur.loops.dailyTokens),
      dailyUsd: pick(l.dailyUsd, LOOP_CHOICES.dailyUsd, cur.loops.dailyUsd),
      quiet: l.quiet === undefined ? cur.loops.quiet : l.quiet === 'hold' ? 'hold' : 'pause',
      stuckAfter: pick(l.stuckAfter, LOOP_CHOICES.stuckAfter, cur.loops.stuckAfter),
      failAfter: pick(l.failAfter, LOOP_CHOICES.failAfter, cur.loops.failAfter),
      maxActive: pick(l.maxActive, LOOP_CHOICES.maxActive, cur.loops.maxActive),
    },
  };
  app.settings.update({ persist: next } as never);
  return next;
}

// ------------------------------------------------------------------ where goals and loops may be (§4.14, §7)

/** Why this conversation can't have a goal or a loop, or undefined when it can. */
export function persistRefusal(app: AppContext, conv: Conversation | undefined, o: { offRecord?: boolean } = {}): string | undefined {
  if (!conv) return en('Conversation not found');
  if (app.member) return en('Keep going and repeats are for the owner only.');
  if (o.offRecord) return en("Off the record, nothing can keep going or repeat: nothing is kept here.");
  if (conv.partner) return en('Not in a chat with someone else.');
  if (isGroupChannel(conv.channel)) return en('Not in a group chat.');
  if (['api', 'mcp', 'a2a', 'home-assistant', 'alexa'].includes(conv.channel)) return en('Not in a chat another app started.');
  return undefined;
}

// ------------------------------------------------------------------ checks (§4.3)

export type CheckKind = 'tests' | 'build' | 'lint' | 'types' | 'command' | 'reviewer' | 'owner';
export const CHECK_KINDS: readonly CheckKind[] = ['tests', 'build', 'lint', 'types', 'command', 'reviewer', 'owner'];
export interface GoalCheck {
  kind: CheckKind;
  command?: string;
  /** How the card and the messages say it. */
  words: string;
}

const CHECK_WORDS: Record<CheckKind, string> = {
  tests: 'Tests pass',
  build: 'It builds',
  lint: 'Lint is clean',
  types: 'Types check',
  command: 'This passes',
  reviewer: 'A reviewer model approves the change',
  owner: "I'll say when it's done",
};
export const checkWords = (c: Pick<GoalCheck, 'kind' | 'command'>): string => (c.command ? `${CHECK_WORDS[c.kind]}: ${c.command}` : CHECK_WORDS[c.kind]);

/** The conversation's workspace folder (checks run there). */
export function wsOf(app: AppContext, conv: Conversation): string {
  return workspaceDir(app.rootDir ?? app.dataDir, conv.workspace || 'main');
}

/** The checks this workspace actually has (tests, build, lint) plus the three that always exist. */
export function checkOptions(app: AppContext, conv: Conversation): GoalCheck[] {
  const out: GoalCheck[] = [];
  let dir: string;
  try {
    dir = wsOf(app, conv);
  } catch {
    return [{ kind: 'command', words: CHECK_WORDS.command }, { kind: 'reviewer', words: CHECK_WORDS.reviewer }, { kind: 'owner', words: CHECK_WORDS.owner }];
  }
  let cmds: { test?: string; build?: string; lint?: string } = {};
  try {
    cmds = scanProject(dir, dir).commands;
  } catch {
    /* not a project */
  }
  const test = cmds.test ?? detectTests(dir);
  if (test) out.push({ kind: 'tests', command: test, words: checkWords({ kind: 'tests', command: test }) });
  if (cmds.build) out.push({ kind: 'build', command: cmds.build, words: checkWords({ kind: 'build', command: cmds.build }) });
  if (cmds.lint) out.push({ kind: 'lint', command: cmds.lint, words: checkWords({ kind: 'lint', command: cmds.lint }) });
  // Phase 120 (PRECISE §4.11): the project's own type checker as a goal check (the P3 driver runs it).
  try {
    const types = projectsOf(dir).flatMap((p) => detectCheckers(p.dir).filter((c) => c.installed && (c.id === 'tsc' || c.id === 'pyright' || c.id === 'mypy' || c.id === 'cargo' || c.id === 'govet')).map((c) => c.label));
    if (types.length) out.push({ kind: 'types', command: [...new Set(types)].join(', '), words: checkWords({ kind: 'types', command: [...new Set(types)].join(', ') }) });
  } catch {
    /* not a project */
  }
  out.push({ kind: 'command', words: CHECK_WORDS.command }, { kind: 'reviewer', words: CHECK_WORDS.reviewer }, { kind: 'owner', words: CHECK_WORDS.owner });
  return out;
}

/** The default check (§4.3): tests alone; else the build; else none (he picks). */
export function defaultChecks(options: GoalCheck[]): GoalCheck[] {
  const t = options.find((c) => c.kind === 'tests' && c.command);
  if (t) return [t];
  const b = options.find((c) => c.kind === 'build' && c.command);
  return b ? [b] : [];
}

const REFUSED: Partial<Record<RiskReason, string>> = {
  installs: en('This check installs packages. Pick one that only runs tests or builds.'),
  deletes: en('This check deletes files. Pick one that only runs tests or builds.'),
  system: en('This check changes the system. Pick one that only runs tests or builds.'),
  network: en('This check uses the network. Pick one that only runs tests or builds.'),
};

/** The script line behind `npm test` / `npm run x` / `pnpm x` (what the command really runs). */
export function scriptLine(dir: string, command: string): string | undefined {
  const m = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:-]+)\s*$/.exec(command.trim());
  if (!m) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    return pkg.scripts?.[m[1] === 't' ? 'test' : m[1]];
  } catch {
    return undefined;
  }
}

/** §4.3: installs, deletes, system changes and network are refused (on the command and on the script it runs). */
export function refuseCheck(command: string, dir?: string): { reason: RiskReason; text: string } | undefined {
  const lines = [command, ...(dir ? [scriptLine(dir, command) ?? ''] : [])].filter(Boolean);
  for (const line of lines) {
    const r = classifyCommand(line);
    for (const reason of ['installs', 'deletes', 'system', 'network'] as const) if (r.reasons.includes(reason)) return { reason, text: REFUSED[reason]! };
  }
  return undefined;
}

/** Cleans a list of checks from a request (≤ 3, known kinds, commands from the project or typed ≤ 400 chars). */
export function cleanChecks(raw: unknown, options: GoalCheck[], dir?: string): { checks: GoalCheck[] } | { error: string } {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: GoalCheck[] = [];
  for (const x of list.slice(0, 3)) {
    const kind = (typeof x === 'string' ? x : (x as { kind?: unknown })?.kind) as CheckKind;
    if (!CHECK_KINDS.includes(kind)) return { error: en('Pick what has to pass: tests, build, lint, a command, a reviewer model or you.') };
    if (out.some((c) => c.kind === kind && kind !== 'command')) continue;
    let command: string | undefined;
    if (kind === 'command') {
      command = String((x as { command?: unknown }).command ?? '').trim().slice(0, 400);
      if (!command) return { error: en('Type the command that has to pass.') };
    } else if (kind === 'tests' || kind === 'build' || kind === 'lint' || kind === 'types') {
      command = options.find((c) => c.kind === kind)?.command;
      if (!command) return { error: en("This project has no command for that. Type one with A command… instead.") };
    }
    if (command && kind !== 'types') {
      const no = refuseCheck(command, dir);
      if (no) return { error: no.text };
    }
    out.push({ kind, ...(command ? { command } : {}), words: checkWords({ kind, ...(command ? { command } : {}) }) });
  }
  if (!out.length) return { error: en('Pick what has to pass: tests, build, lint, a command, a reviewer model or you.') };
  if (out.some((c) => c.kind === 'owner') && out.length > 1) return { error: en('"I\'ll say" can\'t be combined with other checks.') };
  return { checks: out };
}

export interface CheckResult {
  kind: CheckKind;
  command?: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  passed?: number;
  failed?: number;
  skipped?: number;
  /** The M10 failure key (name|class|normalised line); null when green. */
  key: string | null;
  quote: string;
  tail: string;
  ms: number;
  /** It couldn't run at all (not found, refused, timed out): counts as red, and two in a row is stuck. */
  broken?: string;
  /** The reviewer's verdict line (reviewer kind). */
  verdict?: string;
}

const TAIL = 4000;

/**
 * Phase 120 (PRECISE §3.1 P2): one command in the workspace sandbox with network off, the same
 * refusal table as checks (installs, deletes, system changes and network are refused before it runs),
 * scrubbed, and the FULL capped output (≤ maxBytes) so a parser can read every line.
 */
export async function runProjectCommand(app: AppContext, dir: string, command: string, o: { signal: AbortSignal; timeoutMs: number; maxBytes?: number; env?: Record<string, string>; sandbox?: AppContext['sandbox'] }): Promise<{ exitCode: number | null; timedOut: boolean; out: string; ms: number; refused?: string; error?: string }> {
  const t0 = Date.now();
  const no = refuseCheck(command, dir);
  if (no) return { exitCode: null, timedOut: false, out: '', ms: 0, refused: no.text };
  try {
    const r = await runCommand(command, dir, { ...(o.sandbox ?? app.sandbox), network: false }, { timeoutMs: o.timeoutMs, signal: o.signal, maxBytes: o.maxBytes ?? 400_000, ...(o.env ? { env: o.env } : {}) });
    return { exitCode: r.exitCode, timedOut: r.timedOut, out: app.redactor.redact(r.output), ms: Date.now() - t0 };
  } catch (err) {
    const msg = app.redactor.redact((err as Error).message).slice(0, 300);
    return { exitCode: null, timedOut: false, out: '', ms: Date.now() - t0, error: msg };
  }
}

/** Runs one command check in the workspace sandbox (§4.4): scrubbed, time-limited, read like a test card. */
export async function runCommandCheck(app: AppContext, dir: string, kind: CheckKind, command: string, signal: AbortSignal, timeoutMs: number): Promise<CheckResult> {
  const t0 = Date.now();
  const r = await runProjectCommand(app, dir, command, { signal, timeoutMs, maxBytes: 400_000 });
  if (r.refused) {
    const no = refuseCheck(command, dir)!;
    return { kind, command, ok: false, exitCode: null, timedOut: false, key: `check|refused|${no.reason}`, quote: no.text, tail: '', ms: 0, broken: no.text };
  }
  if (r.error !== undefined) return { kind, command, ok: false, exitCode: null, timedOut: false, key: `check|error|${r.error}`, quote: r.error, tail: '', ms: Date.now() - t0, broken: r.error };
  const out = r.out;
  const counts = testCounts(out);
  const exitOk = r.exitCode === 0 && !r.timedOut;
  const countsOk = counts.passed === undefined ? true : (counts.failed ?? 0) === 0 && counts.passed > 0;
  const ok = exitOk && countsOk && !signal.aborted;
  const tail = out.slice(-TAIL);
  let key: string | null = null;
  let quote = '';
  let broken: string | undefined;
  if (!ok) {
    const f = failureOf(kind, `[exit code ${r.exitCode ?? 'none'}]\n${out}`);
    key = `${f.key}|${counts.failed ?? ''}`;
    quote = f.quote.slice(0, 300) || `exit code ${r.exitCode ?? 'none'}`;
    if (r.timedOut) {
      broken = en('The check ran out of time.');
      quote = broken;
      key = `${kind}|timeout`;
    } else if (r.exitCode === 127 || /command not found|is not recognized as an internal or external command|ENOENT/i.test(out.slice(0, 2000))) {
      broken = quote;
    }
  }
  return { kind, command, ok, exitCode: r.exitCode, timedOut: r.timedOut, ...counts, key, quote, tail, ms: Date.now() - t0, ...(broken ? { broken } : {}) };
}

/** The reviewer check (§4.3): one call on the Reviewing route; APPROVE counts only with a real quote from a changed file. */
export async function runReviewerCheck(app: AppContext, conv: Conversation, goalText: string, changed: { path: string; text: string }[], signal: AbortSignal, route: 'reviewing' | 'quick'): Promise<CheckResult> {
  const t0 = Date.now();
  const files = changed.slice(0, 8).map((f) => `--- ${f.path}\n${f.text.slice(0, 6000)}`).join('\n\n') || '(no files changed)';
  const prompt = `${ROLES.reviewer.instructions}\nWhen you approve, quote at least one line of the changed files exactly, in back-ticks.\n\nThe goal: ${goalText}\n\nThe changed files:\n${files}`;
  let reply = '';
  try {
    reply = app.redactor.redact(await complete(app, conv, [{ role: 'user', content: prompt }], 600, route === 'quick' ? 'quick' : 'review', signal));
  } catch (err) {
    const msg = (err as Error).message.slice(0, 300);
    return { kind: 'reviewer', ok: false, exitCode: null, timedOut: false, key: `reviewer|error|${msg}`, quote: msg, tail: '', ms: Date.now() - t0, broken: msg };
  }
  const verdict = reply.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
  const approve = /^VERDICT:\s*APPROVE\b/i.test(verdict);
  // The findings' "no theater" rule: a verdict must quote the changed text verbatim.
  const quotes = [...reply.matchAll(/`([^`\n]{6,300})`/g)].map((m) => m[1].trim());
  const real = quotes.some((q) => changed.some((f) => f.text.includes(q)));
  const ok = approve && real && !signal.aborted;
  const quote = ok ? '' : approve ? en("The reviewer approved but didn't quote the changed files, so it doesn't count.") : verdict.slice(0, 300) || en('The reviewer gave no verdict.');
  return { kind: 'reviewer', ok, exitCode: null, timedOut: false, key: ok ? null : `reviewer|${approve ? 'no-quote' : 'changes'}|${verdict.slice(0, 120)}`, quote, tail: reply.slice(-TAIL), ms: Date.now() - t0, verdict };
}

// ------------------------------------------------------------------ the workspace fingerprint (§4.4, §4.6)

const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', '.cache', 'target', 'dist', 'build', '.sara']);
const TEST_PATH = /(^|\/)(test|tests|__tests__)\/|(^|\/)[^/]*_test\.[^/]+$|(^|\/)[^/]*\.(test|spec)\.[^/]+$|(^|\/)(conftest\.py|pytest\.ini)$|(^|\/)(jest|vitest)\.config\.[^/]+$/;
export const isTestPath = (p: string): boolean => TEST_PATH.test(p);

export interface Fingerprint {
  /** Every file: size and mtime (for "did the round change anything"). */
  all: Record<string, string>;
  /** Test files: sha256. */
  tests: Record<string, string>;
  /** The check commands' script lines (`scripts.test`). */
  scripts: Record<string, string>;
}

export function fingerprint(dir: string, commands: string[] = [], cap = 5000): Fingerprint {
  const fp: Fingerprint = { all: {}, tests: {}, scripts: {} };
  let n = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 8 || n > cap) return;
    let list;
    try {
      list = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (n > cap) return;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(p, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      n++;
      const rel = relative(dir, p).split(sep).join('/');
      try {
        const st = statSync(p);
        fp.all[rel] = `${st.size}:${Math.round(st.mtimeMs)}`;
        if (isTestPath(rel) && st.size < 2_000_000) fp.tests[rel] = createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
        else if (st.size < 2_000_000) fp.all[rel] += `:${createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12)}`;
      } catch {
        /* gone meanwhile */
      }
    }
  };
  walk(dir, 0);
  for (const c of commands) fp.scripts[c] = scriptLine(dir, c) ?? '';
  return fp;
}

/** What changed between two fingerprints: every file, and the test files / script lines (the tamper list). */
export function fpChanges(a: Fingerprint, b: Fingerprint): { changed: string[]; tampered: string[] } {
  const changed = new Set<string>();
  const keysAll = new Set([...Object.keys(a.all), ...Object.keys(b.all)]);
  for (const k of keysAll) if (a.all[k] !== b.all[k]) changed.add(k);
  const tampered = new Set<string>();
  for (const k of new Set([...Object.keys(a.tests), ...Object.keys(b.tests)])) {
    if (a.tests[k] !== b.tests[k]) {
      tampered.add(k);
      changed.add(k);
    }
  }
  for (const k of Object.keys(b.scripts)) if ((a.scripts[k] ?? '') !== b.scripts[k]) tampered.add(`package.json (scripts: ${k})`);
  return { changed: [...changed].sort(), tampered: [...tampered].sort() };
}

// ------------------------------------------------------------------ one turn (a round or a tick)

export interface TurnOutcome {
  status: 'done' | 'error' | 'stopped' | 'busy';
  error?: string;
  replyId: number;
  runId: number;
  budgetHit: boolean;
  guardPaused: boolean;
  toolsOk: number;
  toolsRun: number;
  claims: number;
  unattended?: { name: string; summary: string; key: string };
  minors: boolean;
  crisis: boolean;
  tokens: number;
  usd: number;
  paid: boolean;
  files: string[];
  failKeys: string[];
}

/** Reads a turn's events into a TurnOutcome (the round's runner and the Continue route share it). */
export function outcomeCollector(app: AppContext, conversationId: string): { o: TurnOutcome; tap: (ev: ChatEvent) => void; finish: () => TurnOutcome } {
  const o: TurnOutcome = { status: 'stopped', replyId: 0, runId: 0, budgetHit: false, guardPaused: false, toolsOk: 0, toolsRun: 0, claims: 0, minors: false, crisis: false, tokens: 0, usd: 0, paid: false, files: [], failKeys: [] };
  const tap = (ev: ChatEvent) => {
    if (ev.type === 'done') {
      o.status = o.status === 'error' ? 'error' : 'done';
      o.replyId = ev.messageId;
    } else if (ev.type === 'error') {
      o.status = ev.message === 'Stopped.' ? 'stopped' : 'error';
      o.error = ev.message;
    } else if (ev.type === 'budget' && ev.state.stage === 'reached') o.budgetHit = true;
    else if (ev.type === 'loop_guard' && ev.paused) o.guardPaused = true;
    else if (ev.type === 'tool_result') {
      o.toolsRun++;
      if (ev.status === 'ok') o.toolsOk++;
      else if (ev.status === 'error') o.failKeys.push(failureOf(ev.name, ev.output).key);
    } else if (ev.type === 'claim_check') o.claims += ev.claims.length;
    else if (ev.type === 'unattended') o.unattended ??= { name: ev.name, summary: ev.summary, key: ev.key };
    else if (ev.type === 'notice' && ev.kind === 'crisis') o.crisis = true;
    else if (ev.type === 'replace') o.minors = true;
  };
  const finish = () => {
    const reply = o.replyId ? app.store.messageById(o.replyId) : undefined;
    if (reply?.meta?.blocked) o.minors = String(reply.meta.blocked).startsWith('minor');
    const runId = Number(reply?.meta?.runId ?? 0) || (app.runs?.list({ conversationId, limit: 1 })[0]?.id ?? 0);
    o.runId = runId;
    const run = runId ? app.runs?.get(runId) : undefined;
    if (run) {
      o.tokens = run.tokensIn + run.tokensOut;
      o.usd = run.usd;
      o.paid = run.usd > 0 || run.unpriced > 0;
      o.files = [...new Set((app.runs?.steps(runId) ?? []).flatMap((s) => s.files))];
    }
    return o;
  };
  return { o, tap, finish };
}

/** Runs one ordinary turn through the server's runTracked (busy → status 'busy'; nothing is forced). */
export async function runPersistTurn(app: AppContext, conversationId: string, content: string, opts: TurnOptions, tap?: (ev: ChatEvent) => void): Promise<TurnOutcome> {
  const c = outcomeCollector(app, conversationId);
  if (!app.runTracked) return { ...c.o, status: 'error', error: 'no server' };
  try {
    await app.runTracked(conversationId, content, (ev) => {
      tap?.(ev);
      c.tap(ev);
    }, opts);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 409) return { ...c.o, status: 'busy' };
    return { ...c.o, status: 'error', error: e.message };
  }
  return c.finish();
}

/** "Note from the app, not from {owner}" (§4.5): the owner's name, or "the owner". */
export const ownerWord = (app: AppContext): string => app.settings.get().ownerName?.trim() || 'the owner';

/** Short one-line text (≤ n characters). */
export const oneLine = (s: string, n = 300): string => {
  const x = s.replace(/\s+/g, ' ').trim();
  return x.length > n ? `${x.slice(0, n - 1)}…` : x;
};
