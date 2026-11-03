// Phase 118 part A (docs/design/PERSIST.md §4, 2.51.0): keep going until it's done. A goal on a
// chat that the owner set and started; she works in rounds, and after each round Sara (never she)
// runs the check he picked. Red → the next round gets the real failure; green → done (amber
// "done, review" when the round changed the tests); the same failure again, a round that changed
// nothing, or the loop guard pausing her tools → stuck; a cap → paused. Every round is an ordinary
// turn queued through the conversation's pending queue (src/pending.ts) and run by the server's
// runTracked, so steer, Stop, approvals, the turn budget and its ladder, the claim check, the loop
// guard and the safety layer all apply unchanged. After a restart everything is paused.
//
// Tables (additive, the conversation's own store.db): chat_goals, goal_checks (§4.15).
import { runTypesCheck } from './diagnostics.ts';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { budgetCheck, usdMeaningless, type Budget, type Dimension } from './budget.ts';
import { preflight, resolveFor, type AppContext, type ChatEvent, type PersistTurn, type TurnOptions } from './chat.ts';
import { en, trOwner } from './i18n.ts';
import { identityOf } from './persona.ts';
import { pendingFor, type PendingItem } from './pending.ts';
import {
  checkOptions,
  cleanChecks,
  fingerprint,
  fpChanges,
  oneLine,
  outcomeCollector,
  ownerWord,
  persistRefusal,
  persistSettings,
  runCommandCheck,
  runPersistTurn,
  runReviewerCheck,
  wsOf,
  type CheckResult,
  type Fingerprint,
  type GoalCheck,
  type TurnOutcome,
} from './persist.ts';
import { CRISIS_RESOURCES } from './safety.ts';
import { billingOf } from './usage.ts';

export type GoalState = 'draft' | 'running' | 'checking' | 'paused' | 'stuck' | 'done' | 'stopped';
export const FINAL_GOAL: readonly GoalState[] = ['stuck', 'done', 'stopped'];
export interface GoalCaps {
  rounds: number;
  minutes: number;
  tokens: number;
  usd: number;
}
export interface GoalUsed {
  tokens: number;
  usd: number;
  /** Active wall time (paused time and approval waits taken out). */
  ms: number;
  pausedMs: number;
  waitMs: number;
}
export interface GoalMeta {
  blocked?: { key: string; quote: string }[];
  source?: string;
  card?: number | string;
  proposedBy?: 'her';
  /** The last round's spend (the projection for the next one). */
  last?: { tokens: number; usd: number; ms: number };
  pausedAt?: string;
  /** The owner check is waiting for his tap. */
  asking?: boolean;
  /** Files changed per round (the History list). */
  changed?: Record<string, string[]>;
  /** The stuck note a *Try again* starts with. */
  note?: string;
  tampered?: string[];
  paid?: boolean;
}
export interface Goal {
  id: number;
  conversationId: string;
  text: string;
  checks: GoalCheck[];
  workspace: string | null;
  state: GoalState;
  reason: string | null;
  caps: GoalCaps;
  round: number;
  noProgress: number;
  used: GoalUsed;
  fingerprint: Fingerprint | null;
  meta: GoalMeta;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  endedAt: string | null;
}
export interface CheckRow {
  id: number;
  goalId: number;
  round: number;
  runId: number | null;
  kind: string;
  command: string | null;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  key: string | null;
  quote: string | null;
  tail: string;
  tampered: string[] | null;
  ms: number;
  at: string;
}
/** What the apps see (the chip, the card, Today). */
export type GoalView = Omit<Goal, 'fingerprint'> & { lastCheck: Omit<CheckRow, 'tail'> | null; frac: number; top: string | null };

const KEEP_DAYS = 90;
const BLOCKED_MAX = 20;
const APPROVAL_PAUSE_MS = 30 * 60_000;

/** The app's lines (translated for the owner; numbers filled in). */
export const GOAL_LINES = {
  round: en('🎯 Round {n} of {max} · {state}'),
  firstRound: en('🎯 Keep going until it’s done: {text}'),
  done: en('✅ Done: the check passed ({check}) after {rounds} round(s), {time}, {tokens} tokens.'),
  doneReview: en('✅ Done, but review it: the check passed ({check}) after {rounds} round(s). She changed these test files: {files}. Look before you trust it.'),
  doneReviewer: en('Checked by a reviewer model, not by tests.'),
  doneOwner: en('You said it’s done.'),
  stuck: en('⛔ Stuck after round {n}: {why} The check still says: {quote}'),
  stuckSame: en('The check failed the same way again.'),
  stuckNothing: en('The round changed nothing.'),
  stuckGuard: en('She kept trying the same failing step.'),
  stuckBroken: en('The check itself doesn’t run: {quote}'),
  capPause: en('⏸ I stopped before round {n}: this goal reached {reason}. The check still says: {quote}'),
  budgetPause: en('⏸ Paused: round {n} reached its budget. Press Continue with more on her reply to go on, or Stop.'),
  ownerPause: en('⏸ Paused. Resume when you want her to go on.'),
  restartPause: en('⏸ Sara restarted, so this goal is paused: {text}. Resume when you want her to go on.'),
  approvalPause: en('⏸ Paused: an OK has waited 30 minutes. Answering it lets the goal go on.'),
  crisisPause: en('⏸ Paused for now. Your wellbeing comes first.'),
  localPause: en('⏸ Paused: no model on this computer can do the next round while “Nothing leaves this computer” is on.'),
  stopped: en('⏹ Stopped: {text}'),
  safetyStop: en('⏹ Stopped for a safety reason.'),
  ask: en('🎯 Round {n} is finished. Is it done? Answer with the buttons.'),
  notYet: en('Not done yet, says {owner}.'),
  stillFails: en('{n} failing'),
  red: en('not passing yet'),
  checking: en('checking…'),
  working: en('working'),
} as const;

const SQL = `CREATE TABLE IF NOT EXISTS chat_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  text TEXT NOT NULL,
  checks TEXT NOT NULL,
  workspace TEXT,
  state TEXT NOT NULL,
  reason TEXT,
  caps TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  no_progress INTEGER NOT NULL DEFAULT 0,
  used TEXT NOT NULL DEFAULT '{}',
  fingerprint TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, started_at TEXT, updated_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX IF NOT EXISTS chat_goals_conv ON chat_goals(conversation_id, state);
CREATE TABLE IF NOT EXISTS goal_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  round INTEGER NOT NULL,
  run_id INTEGER,
  kind TEXT NOT NULL, command TEXT,
  ok INTEGER NOT NULL,
  exit_code INTEGER, timed_out INTEGER NOT NULL DEFAULT 0,
  passed INTEGER, failed INTEGER, skipped INTEGER,
  key TEXT,
  quote TEXT,
  tail TEXT NOT NULL DEFAULT '',
  tampered TEXT,
  ms INTEGER NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_checks_goal ON goal_checks(goal_id, round);`;

const parse = <T>(s: unknown, d: T): T => {
  try {
    return s ? (JSON.parse(String(s)) as T) : d;
  } catch {
    return d;
  }
};
type Row = Record<string, unknown>;
const toGoal = (r: Row): Goal => ({
  id: Number(r.id),
  conversationId: String(r.conversation_id),
  text: String(r.text),
  checks: parse<GoalCheck[]>(r.checks, []),
  workspace: (r.workspace as string | null) ?? null,
  state: String(r.state) as GoalState,
  reason: (r.reason as string | null) ?? null,
  caps: parse<GoalCaps>(r.caps, { rounds: 5, minutes: 60, tokens: 1_000_000, usd: 0 }),
  round: Number(r.round),
  noProgress: Number(r.no_progress),
  used: { tokens: 0, usd: 0, ms: 0, pausedMs: 0, waitMs: 0, ...parse<Partial<GoalUsed>>(r.used, {}) },
  fingerprint: parse<Fingerprint | null>(r.fingerprint, null),
  meta: parse<GoalMeta>(r.meta, {}),
  createdAt: String(r.created_at),
  startedAt: (r.started_at as string | null) ?? null,
  updatedAt: String(r.updated_at),
  endedAt: (r.ended_at as string | null) ?? null,
});
const toCheck = (r: Row): CheckRow => ({
  id: Number(r.id),
  goalId: Number(r.goal_id),
  round: Number(r.round),
  runId: r.run_id === null ? null : Number(r.run_id),
  kind: String(r.kind),
  command: (r.command as string | null) ?? null,
  ok: Number(r.ok) === 1,
  exitCode: r.exit_code === null ? null : Number(r.exit_code),
  timedOut: Number(r.timed_out) === 1,
  passed: r.passed === null ? null : Number(r.passed),
  failed: r.failed === null ? null : Number(r.failed),
  skipped: r.skipped === null ? null : Number(r.skipped),
  key: (r.key as string | null) ?? null,
  quote: (r.quote as string | null) ?? null,
  tail: String(r.tail ?? ''),
  tampered: parse<string[] | null>(r.tampered, null),
  ms: Number(r.ms),
  at: String(r.at),
});

/** `/goal …` (§4.10): a subcommand, or the text with an optional "done when …". */
export type GoalCommand =
  | { sub: 'status' | 'start' | 'pause' | 'resume' | 'stop' | 'retry' }
  | { sub: 'check'; check: string }
  | { sub: 'set'; text: string; check?: string };
const SUBS: Record<string, 'status' | 'start' | 'pause' | 'resume' | 'stop' | 'check' | 'retry'> = {
  status: 'status', estado: 'status', statut: 'status', stato: 'status',
  start: 'start', empezar: 'start', iniciar: 'start', commencer: 'start', demarrer: 'start', starten: 'start', comecar: 'start', inizia: 'start', avvia: 'start',
  pause: 'pause', pausa: 'pause', pausar: 'pause', pausieren: 'pause',
  resume: 'resume', seguir: 'resume', reanudar: 'resume', reprendre: 'resume', weiter: 'resume', fortsetzen: 'resume', continuar: 'resume', riprendi: 'resume',
  stop: 'stop', parar: 'stop', detener: 'stop', arreter: 'stop', stopp: 'stop', ferma: 'stop',
  check: 'check', retry: 'retry',
};
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export function parseGoalCommand(args: string): GoalCommand {
  const a = args.trim();
  if (!a) return { sub: 'status' };
  const [w, ...rest] = a.split(/\s+/);
  const sub = SUBS[fold(w)];
  if (sub === 'check' && rest.length) return { sub: 'check', check: rest.join(' ') };
  if (sub && sub !== 'check' && !rest.length) return { sub };
  const m = /^([\s\S]+?)\s+done when\s+(.+)$/i.exec(a);
  return m ? { sub: 'set', text: m[1].trim(), check: m[2].trim() } : { sub: 'set', text: a };
}
/** "tests" / "build" / "lint" / "review" / "`cmd`" / "I say" → a check request. */
export function checkFromWords(w: string): unknown {
  const t = w.trim();
  const cmd = /^`([^`]+)`$/.exec(t);
  if (cmd) return { kind: 'command', command: cmd[1] };
  const f = fold(t).replace(/[.!]$/, '');
  if (/^(the )?tests?( pass)?$/.test(f)) return 'tests';
  if (/^(it )?builds?$/.test(f)) return 'build';
  if (/^lint/.test(f)) return 'lint';
  if (/^(the )?types?( check)?$|^it (type-?)?checks$/.test(f)) return 'types';
  if (/^(a )?review(er)?/.test(f)) return 'reviewer';
  if (/^(i say|i'll say|me)$/.test(f)) return 'owner';
  return { kind: 'command', command: t };
}

const fmtN = (n: number) => Math.round(n).toLocaleString('en-US');
const fmtTime = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};
const CAP_WORDS: Record<Dimension, string> = { tokens: 'its token budget', usd: 'its dollar budget', minutes: 'its time limit', steps: 'its round limit' };

export class Goals {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  /** Running checks (Stop kills them). */
  readonly #checks = new Map<number, AbortController>();
  /** Approval cards waiting in a round (goal id → since). */
  readonly #waiting = new Map<number, number>();

  constructor(app: AppContext, db: DatabaseSync = app.store.db) {
    this.#app = app;
    this.#db = db;
    db.exec(SQL);
  }

  // ------------------------------------------------------------------ reading

  get(id: number): Goal | undefined {
    const r = this.#db.prepare('SELECT * FROM chat_goals WHERE id = ?').get(id) as Row | undefined;
    return r ? toGoal(r) : undefined;
  }
  /** The standing goal (draft, running, checking, paused), else the last final one. */
  current(conversationId: string): Goal | undefined {
    const live = this.#db.prepare("SELECT * FROM chat_goals WHERE conversation_id = ? AND state IN ('draft','running','checking','paused') ORDER BY id DESC LIMIT 1").get(conversationId) as Row | undefined;
    if (live) return toGoal(live);
    const last = this.#db.prepare('SELECT * FROM chat_goals WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(conversationId) as Row | undefined;
    return last ? toGoal(last) : undefined;
  }
  standing(conversationId: string): Goal | undefined {
    const g = this.current(conversationId);
    return g && !FINAL_GOAL.includes(g.state) && g.state !== 'draft' ? g : undefined;
  }
  /** Every running and paused goal of this companion (Today's tile). */
  list(): Goal[] {
    return (this.#db.prepare("SELECT * FROM chat_goals WHERE state IN ('running','checking','paused') ORDER BY id").all() as Row[]).map(toGoal);
  }
  checks(goalId: number): CheckRow[] {
    return (this.#db.prepare('SELECT * FROM goal_checks WHERE goal_id = ? ORDER BY id').all(goalId) as Row[]).map(toCheck);
  }
  lastCheck(goalId: number): CheckRow | undefined {
    const r = this.#db.prepare('SELECT * FROM goal_checks WHERE goal_id = ? ORDER BY id DESC LIMIT 1').get(goalId) as Row | undefined;
    return r ? toCheck(r) : undefined;
  }
  view(g: Goal | undefined): GoalView | null {
    if (!g) return null;
    const { fingerprint: _fp, ...rest } = g;
    const last = this.lastCheck(g.id);
    const c = this.#capCheck(g, false);
    return { ...rest, lastCheck: last ? (({ tail: _t, ...x }) => x)(last) : null, frac: Math.min(1, c.frac), top: c.top ?? null };
  }
  /** The History list: per round its check, the files changed and the run. */
  rounds(goalId: number): { round: number; checks: CheckRow[]; files: string[]; runId: number | null; tokens: number; usd: number }[] {
    const g = this.get(goalId);
    if (!g) return [];
    const runs = this.#runs(g);
    const out = [];
    for (let n = 1; n <= g.round; n++) {
      const run = runs.find((r) => Number(r.policy?.round) === n);
      out.push({ round: n, checks: this.checks(goalId).filter((c) => c.round === n), files: g.meta.changed?.[String(n)] ?? [], runId: run?.id ?? null, tokens: run ? run.tokensIn + run.tokensOut : 0, usd: run?.usd ?? 0 });
    }
    return out;
  }

  // ------------------------------------------------------------------ setting one

  /** §4.16 POST: a draft (or running with `start`). 409 when one stands, unless `replace`. */
  create(conversationId: string, body: { text: unknown; checks?: unknown; caps?: unknown; start?: boolean; replace?: boolean; source?: string; proposedBy?: 'her'; card?: number | string; note?: string }): { goal: Goal } | { status: number; error: string } {
    const app = this.#app;
    const conv = app.store.getConversation(conversationId);
    const no = persistRefusal(app, conv);
    if (no) return { status: conv ? 400 : 404, error: no };
    const set = persistSettings(app).goals;
    if (!set.on) return { status: 400, error: en('Keep going until it’s done is switched off in Settings → Coding → Keep going and repeats.') };
    const text = String(body.text ?? '').trim().slice(0, 2000);
    if (!text) return { status: 400, error: en('Say what she should keep going at.') };
    const options = checkOptions(app, conv!);
    let dir: string | undefined;
    try {
      dir = wsOf(app, conv!);
    } catch {
      dir = undefined;
    }
    const cc = cleanChecks(body.checks, options, dir);
    if ('error' in cc) return { status: 400, error: cc.error };
    const standing = this.current(conversationId);
    if (standing && !FINAL_GOAL.includes(standing.state)) {
      if (standing.state !== 'draft' && !body.replace) return { status: 409, error: en('This chat already has a goal: stop it first or replace it.') };
      this.#set(standing.id, { state: 'stopped', reason: 'replaced', ended_at: app.now().toISOString() });
      this.#dropQueued(standing);
    }
    const caps = this.#cleanCaps(body.caps);
    const now = app.now().toISOString();
    const meta: GoalMeta = { blocked: [], ...(body.source ? { source: body.source } : {}), ...(body.proposedBy ? { proposedBy: body.proposedBy } : {}), ...(body.card !== undefined ? { card: body.card } : {}), ...(body.note ? { note: body.note } : {}) };
    const r = this.#db.prepare('INSERT INTO chat_goals (conversation_id, text, checks, workspace, state, caps, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(conversationId, text, JSON.stringify(cc.checks), conv!.workspace ?? null, 'draft', JSON.stringify(caps), JSON.stringify(meta), now, now);
    const id = Number(r.lastInsertRowid);
    if (body.start) {
      const s = this.start(id);
      if ('error' in s) return s;
    }
    this.#emit(id);
    return { goal: this.get(id)! };
  }

  #cleanCaps(raw: unknown): GoalCaps {
    const set = persistSettings(this.#app).goals;
    const c = (raw ?? {}) as Partial<Record<keyof GoalCaps, unknown>>;
    const lower = (v: unknown, max: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.min(max || n, n) : max;
    };
    return { rounds: lower(c.rounds, set.rounds), minutes: lower(c.minutes, set.minutes), tokens: lower(c.tokens, set.tokens), usd: set.usd ? lower(c.usd, set.usd) : 0 };
  }

  /** The owner's tap. The text is checked like a message (minors refuse the card; crisis doesn't start it). */
  start(id: number): { goal: Goal } | { status: number; error: string } {
    const app = this.#app;
    const g = this.get(id);
    if (!g) return { status: 404, error: en('Goal not found') };
    if (g.state !== 'draft') return { status: 409, error: en('This goal has already started.') };
    const pf = safetyOf(g.text);
    if (pf.minor) {
      this.#set(id, { state: 'stopped', reason: 'safety', ended_at: app.now().toISOString() });
      return { status: 400, error: en('I can’t work on that.') };
    }
    if (pf.crisis) {
      app.store.addMessage(g.conversationId, 'notice', `crisis:${pf.resources}`);
      this.#set(id, { state: 'stopped', reason: 'crisis', ended_at: app.now().toISOString() });
      return { status: 400, error: en('Your wellbeing comes first. The goal wasn’t started.') };
    }
    const conv = app.store.getConversation(g.conversationId)!;
    let fp: Fingerprint | null = null;
    try {
      fp = fingerprint(wsOf(app, conv), g.checks.flatMap((c) => (c.command ? [c.command] : [])));
    } catch {
      fp = null;
    }
    const now = app.now().toISOString();
    this.#set(id, { state: 'running', reason: null, started_at: now, fingerprint: JSON.stringify(fp) });
    this.#queueRound(this.get(id)!, g.meta.note);
    return { goal: this.get(id)! };
  }

  pause(id: number, reason = 'owner'): Goal | undefined {
    const g = this.get(id);
    if (!g || !['running', 'checking'].includes(g.state)) return g;
    this.#dropQueued(g);
    this.#set(id, { state: 'paused', reason, meta: JSON.stringify({ ...g.meta, pausedAt: this.#app.now().toISOString(), asking: false }) });
    if (reason === 'owner') this.#line(g, GOAL_LINES.ownerPause, {});
    this.#emit(id);
    return this.get(id);
  }

  /** Resume (owner only): at least one more round; after a cap, `more` raises that cap. */
  resume(id: number, more: Partial<GoalCaps> = {}): { goal: Goal } | { status: number; error: string } {
    const g = this.get(id);
    if (!g) return { status: 404, error: en('Goal not found') };
    if (g.state !== 'paused') return { status: 409, error: en('This goal isn’t paused.') };
    const caps = { ...g.caps };
    for (const k of ['rounds', 'minutes', 'tokens', 'usd'] as const) if (Number(more[k]) > 0) caps[k] += Number(more[k]);
    // At least one more round.
    if (caps.rounds <= g.round) caps.rounds = g.round + 1;
    const pausedMs = g.meta.pausedAt ? Math.max(0, this.#app.now().getTime() - Date.parse(g.meta.pausedAt)) : 0;
    const used = { ...g.used, pausedMs: g.used.pausedMs + pausedMs };
    const { pausedAt: _p, ...meta } = g.meta;
    this.#set(id, { state: 'running', reason: null, caps: JSON.stringify(caps), used: JSON.stringify(used), meta: JSON.stringify(meta) });
    const last = this.lastCheck(id);
    this.#queueRound(this.get(id)!, last && !last.ok ? undefined : undefined, true);
    return { goal: this.get(id)! };
  }

  /** Stop wins (§4.2): the turn stops, a check is killed, the queued round is dropped. */
  stop(id: number): Goal | undefined {
    const g = this.get(id);
    if (!g || FINAL_GOAL.includes(g.state)) return g;
    const wasDraft = g.state === 'draft';
    this.#set(id, { state: 'stopped', reason: 'owner', ended_at: this.#app.now().toISOString() });
    this.#checks.get(id)?.abort(new Error('stopped'));
    this.#dropQueued(g);
    if (!wasDraft) {
      this.#app.stopTurn?.(g.conversationId);
      this.#line(g, GOAL_LINES.stopped, { text: oneLine(g.text, 80) });
    }
    this.#emit(id);
    return this.get(id);
  }

  /** *Try again* on a stuck goal: a new goal, the same text and check, the stuck note first. */
  retry(id: number): { goal: Goal } | { status: number; error: string } {
    const g = this.get(id);
    if (!g) return { status: 404, error: en('Goal not found') };
    if (g.state !== 'stuck') return { status: 409, error: en('Only a stuck goal can be tried again.') };
    return this.create(g.conversationId, { text: g.text, checks: g.checks, caps: g.caps, start: true, source: g.meta.source, note: g.meta.note });
  }

  /** `/goal check …` / PUT check (owner): changes the check, resets the stuck count. */
  setChecks(id: number, raw: unknown): { goal: Goal } | { status: number; error: string } {
    const g = this.get(id);
    if (!g) return { status: 404, error: en('Goal not found') };
    if (FINAL_GOAL.includes(g.state)) return { status: 409, error: en('This goal has ended.') };
    const conv = this.#app.store.getConversation(g.conversationId)!;
    let dir: string | undefined;
    try {
      dir = wsOf(this.#app, conv);
    } catch {
      dir = undefined;
    }
    const cc = cleanChecks(raw, checkOptions(this.#app, conv), dir);
    if ('error' in cc) return { status: 400, error: cc.error };
    this.#set(id, { checks: JSON.stringify(cc.checks), no_progress: 0 });
    this.#emit(id);
    return { goal: this.get(id)! };
  }

  /** The owner check's answer (§4.16 POST /goal/said). */
  said(id: number, done: boolean): { goal: Goal } | { status: number; error: string } {
    const g = this.get(id);
    if (!g) return { status: 404, error: en('Goal not found') };
    if (!g.meta.asking || !g.checks.some((c) => c.kind === 'owner')) return { status: 409, error: en('She isn’t waiting for your answer.') };
    const meta = { ...g.meta, asking: false };
    this.#set(id, { meta: JSON.stringify(meta) });
    const res: CheckResult = { kind: 'owner', ok: done, exitCode: null, timedOut: false, key: done ? null : `owner|no|${g.round}`, quote: done ? '' : trOwner(GOAL_LINES.notYet, this.#app.settings.get(), { owner: ownerWord(this.#app) }), tail: '', ms: 0 };
    this.#insertCheck(g, null, res, null);
    if (done) this.#finish(this.get(id)!, [res], [], 'owner');
    else {
      this.#set(id, { state: 'running', reason: null });
      this.#queueRound(this.get(id)!);
    }
    return { goal: this.get(id)! };
  }

  // ------------------------------------------------------------------ restarts, commands, housekeeping

  /** Start-up (§4.1 7): running and checking goals become paused (restart), one line each; their queued rounds go. */
  startupSweep(): number {
    const rows = (this.#db.prepare("SELECT * FROM chat_goals WHERE state IN ('running','checking')").all() as Row[]).map(toGoal);
    const now = this.#app.now().toISOString();
    for (const g of rows) {
      this.#set(g.id, { state: 'paused', reason: 'restart', meta: JSON.stringify({ ...g.meta, pausedAt: now, asking: false }) });
      this.#dropQueued(g);
      this.#line(g, GOAL_LINES.restartPause, { text: oneLine(g.text, 80).replace(/[.!?…]+$/u, '') }, false);
    }
    return rows.length;
  }

  /** `/stop` in a chat app: the turn stops and the goal pauses (it is "stop now", not "forget it"). */
  onStopCommand(conversationId: string): void {
    const g = this.standing(conversationId);
    if (g && (g.state === 'running' || g.state === 'checking')) {
      this.#checks.get(g.id)?.abort(new Error('stopped'));
      this.pause(g.id, 'owner');
    }
  }
  /** `/reset`: the goal stops. */
  onResetCommand(conversationId: string): void {
    const g = this.standing(conversationId);
    if (g) this.stop(g.id);
  }

  /** Hourly: final goals and their checks after 90 days. */
  prune(): number {
    const cutoff = new Date(this.#app.now().getTime() - KEEP_DAYS * 86_400_000).toISOString();
    const ids = (this.#db.prepare("SELECT id FROM chat_goals WHERE state IN ('stuck','done','stopped') AND updated_at < ?").all(cutoff) as Row[]).map((r) => Number(r.id));
    for (const id of ids) {
      this.#db.prepare('DELETE FROM goal_checks WHERE goal_id = ?').run(id);
      this.#db.prepare('DELETE FROM chat_goals WHERE id = ?').run(id);
    }
    return ids.length;
  }
  /** Deleting a conversation deletes its goals. */
  forget(conversationId: string): void {
    for (const r of this.#db.prepare('SELECT id FROM chat_goals WHERE conversation_id = ?').all(conversationId) as Row[]) this.#db.prepare('DELETE FROM goal_checks WHERE goal_id = ?').run(Number(r.id));
    this.#db.prepare('DELETE FROM chat_goals WHERE conversation_id = ?').run(conversationId);
  }

  /** `/goal` and `/status`: one line. */
  statusLine(g: Goal): string {
    const s = this.#app.settings.get();
    const last = this.lastCheck(g.id);
    const lastWords = last ? (last.ok ? '✅' : last.failed ? trOwner(GOAL_LINES.stillFails, s, { n: last.failed }) : trOwner(GOAL_LINES.red, s)) : '–';
    const state = g.state === 'checking' ? trOwner(GOAL_LINES.checking, s) : g.state === 'running' ? trOwner(GOAL_LINES.working, s) : `${g.state}${g.reason ? ` (${g.reason})` : ''}`;
    const used = this.#used(g);
    return `🎯 ${oneLine(g.text, 60)} · ${g.round}/${g.caps.rounds} · ${state} · ${lastWords} · ${fmtTime(used.ms)} · ${fmtN(used.tokens)}/${fmtN(g.caps.tokens)}`;
  }

  // ------------------------------------------------------------------ the queue (P1)

  /**
   * Owner messages between rounds count as the next round (§4.9): the waiting round makes way and
   * his message runs as that round, with the goal note, and the check runs after it. Returns the
   * runner for the server's default queue runner, or undefined (a normal turn).
   */
  adopt(conversationId: string, item: PendingItem): (() => Promise<void>) | undefined {
    if (item.meta.goal || item.sender !== 'owner') return undefined;
    const g = this.standing(conversationId);
    if (!g || g.state !== 'running') return undefined;
    const pend = pendingFor(this.#app);
    const queued = pend.list(conversationId).find((x) => (x.meta.goal as { id?: number } | undefined)?.id === g.id && x.state === 'waiting');
    if (!queued) return undefined;
    pend.cancel(conversationId, queued.id);
    const n = g.round;
    const note = this.#note(g, n, this.lastCheck(g.id));
    return async () => {
      const cur = this.get(g.id);
      if (!cur || cur.state !== 'running') return;
      const before = this.#fp(cur);
      const persist = this.#persistFor(cur, n, note);
      const out = await runPersistTurn(this.#app, conversationId, item.content, { pendingId: item.id, persist, ...(item.meta.images?.length ? { images: item.meta.images } : {}) });
      const reply = out.replyId ? this.#app.store.messageById(out.replyId) : undefined;
      if (reply?.role === 'assistant' && reply.content.trim()) {
        this.#app.store.updateMessageMeta(reply.id, { goal: { id: g.id, round: n }, background: true });
        this.#app.events?.publish({ type: 'message', conversationId, message: { id: reply.id, role: reply.role, content: reply.content, createdAt: reply.createdAt, meta: { ...(reply.meta ?? {}), goal: { id: g.id, round: n }, background: true } }, reason: 'reply' });
      }
      if (out.status === 'busy') return;
      await this.#afterRound(this.get(g.id)!, n, out, persist, before);
    };
  }

  /** Planned shutdown: running checks are killed (their process group with them). */
  abortChecks(): void {
    for (const ac of this.#checks.values()) ac.abort(new Error('restart'));
  }

  /** The Continue-with-more route: a goal paused at a round's budget goes on with that turn (§4.7). */
  continuing(conversationId: string): { opts: TurnOptions; tap: (ev: ChatEvent) => void; finish: () => Promise<void> } | undefined {
    const g = this.standing(conversationId);
    if (!g || g.state !== 'paused' || g.reason !== 'budget') return undefined;
    const persist = this.#persistFor(g, g.round);
    this.#set(g.id, { state: 'running', reason: null });
    this.#emit(g.id);
    const before = this.#fp(g);
    const c = outcomeCollector(this.#app, conversationId);
    return { opts: { persist }, tap: c.tap, finish: async () => this.#afterRound(this.get(g.id)!, g.round, c.finish(), persist, before) };
  }

  /** Approval cards: a round waiting 30 minutes on one pauses the goal (checked from the reminder tick). */
  tick(now = this.#app.now().getTime()): void {
    for (const [id, since] of this.#waiting) if (now - since >= APPROVAL_PAUSE_MS) {
      this.#waiting.delete(id);
      const g = this.get(id);
      if (g?.state === 'running') {
        this.#set(id, { state: 'paused', reason: 'approval', meta: JSON.stringify({ ...g.meta, pausedAt: new Date(now).toISOString() }) });
        this.#line(g, GOAL_LINES.approvalPause, {});
        this.#emit(id);
      }
    }
  }

  #persistFor(g: Goal, round: number, note?: string): PersistTurn {
    return { kind: 'goal', id: g.id, n: round, ...(note ? { note } : {}), blocked: g.meta.blocked ?? [] };
  }

  /** Checks the caps (before queuing), then adds round n+1 to the pending queue. */
  #queueRound(g: Goal, firstNote?: string, resumed = false): void {
    const app = this.#app;
    const n = g.round + 1;
    const cap = this.#capCheck(g, true);
    if (cap.reached) {
      const last = this.lastCheck(g.id);
      this.#set(g.id, { state: 'paused', reason: `cap:${cap.reached === 'steps' ? 'rounds' : cap.reached}`, meta: JSON.stringify({ ...g.meta, pausedAt: app.now().toISOString() }) });
      this.#line(g, GOAL_LINES.capPause, { n, reason: cap.reason ?? '', quote: last?.quote ?? '–' });
      void app.push?.notifyOwner(trOwner('Sara paused a goal', app.settings.get(), undefined, identityOf(app.persona)), oneLine(g.text, 120), g.conversationId, `goal-${g.id}`).catch(() => {});
      this.#emit(g.id);
      return;
    }
    this.#set(g.id, { round: n });
    const last = this.lastCheck(g.id);
    const conv = app.store.getConversation(g.conversationId);
    const hasOwnerMsg = Boolean(conv && app.store.messages(g.conversationId).some((m) => m.role === 'user'));
    const first = n === 1 || !hasOwnerMsg;
    const label = first ? g.text : trOwner(GOAL_LINES.round, app.settings.get(), { n, max: g.caps.rounds, state: last && !last.ok ? (last.failed ? trOwner(GOAL_LINES.stillFails, app.settings.get(), { n: last.failed }) : trOwner(GOAL_LINES.red, app.settings.get())) : trOwner(GOAL_LINES.working, app.settings.get()) });
    const note = first ? (firstNote ? this.#note(g, n, undefined, firstNote) : this.#note(g, n, undefined)) : this.#note(g, n, last, undefined, resumed);
    const pend = pendingFor(app);
    const r = pend.add(g.conversationId, { kind: 'queue', content: label, sender: 'owner', meta: { goal: { id: g.id, round: n }, source: g.meta.source ?? 'web' } }, (item) => this.#runRound(g.id, n, item, first, label, note), { queueMax: 50 });
    if (!r.ok) {
      this.#set(g.id, { state: 'paused', reason: 'error', round: n - 1 });
      this.#emit(g.id);
      return;
    }
    this.#emit(g.id);
    pend.drain(g.conversationId);
  }

  async #runRound(id: number, n: number, item: PendingItem, first: boolean, label: string, note: string): Promise<void> {
    const app = this.#app;
    const g = this.get(id);
    if (!g || g.state !== 'running' || g.round !== n) return;
    const before = this.#fp(g);
    if (!first) {
      const msg = app.store.addMessage(g.conversationId, 'notice', `goal:${label}`, { goal: { id, round: n } });
      app.events?.publish({ type: 'message', conversationId: g.conversationId, message: { id: msg.id, role: msg.role, content: label, createdAt: msg.createdAt, meta: msg.meta }, reason: 'job' });
    }
    const persist = this.#persistFor(g, n, note);
    let waitStart = 0;
    const lastOwner = app.store.messages(g.conversationId).filter((m) => m.role === 'user').at(-1)?.content ?? g.text;
    const out = await runPersistTurn(app, g.conversationId, first ? g.text : lastOwner, { ...(first ? { pendingId: item.id } : { resume: true }), persist }, (ev) => {
      if (ev.type === 'approval') {
        waitStart = app.now().getTime();
        this.#waiting.set(id, app.now().getTime());
      } else if (waitStart && (ev.type === 'tool_running' || ev.type === 'tool_result')) {
        const cur = this.get(id);
        if (cur) this.#set(id, { used: JSON.stringify({ ...cur.used, waitMs: cur.used.waitMs + Math.max(0, app.now().getTime() - waitStart) }) });
        waitStart = 0;
        this.#waiting.delete(id);
      }
    });
    this.#waiting.delete(id);
    if (out.status === 'busy') {
      // Another turn got there first: try again after it (the queue's order holds).
      this.#set(id, { round: n - 1 });
      this.#queueRound(this.get(id)!);
      return;
    }
    if (first && out.status !== 'stopped' && item.id) {
      const um = app.store.messages(g.conversationId).filter((m) => m.role === 'user').at(-1);
      if (um && !um.meta?.goal) app.store.updateMessageMeta(um.id, { goal: { id, round: n } });
    }
    const reply = out.replyId ? app.store.messageById(out.replyId) : undefined;
    if (reply?.role === 'assistant' && reply.content.trim()) {
      app.store.updateMessageMeta(reply.id, { goal: { id, round: n }, background: true });
      app.events?.publish({ type: 'message', conversationId: g.conversationId, message: { id: reply.id, role: reply.role, content: reply.content, createdAt: reply.createdAt, meta: { ...(reply.meta ?? {}), goal: { id, round: n }, background: true } }, reason: 'reply' });
    }
    await this.#afterRound(this.get(id)!, n, out, persist, before);
  }

  /** After a round's turn: what it means for the goal, then the check (§4.4, §4.6, §4.7). */
  async #afterRound(g: Goal, n: number, out: TurnOutcome, persist: PersistTurn, before: Fingerprint | null): Promise<void> {
    const app = this.#app;
    // The guard's memory across rounds (an owner steer cleared it).
    const blocked = persist.steered ? (persist.blockedOut ?? []) : (persist.blockedOut ?? g.meta.blocked ?? []);
    const meta: GoalMeta = { ...g.meta, blocked: blocked.slice(-BLOCKED_MAX), last: { tokens: out.tokens, usd: out.usd, ms: 0 }, ...(out.paid ? { paid: true } : {}) };
    this.#set(g.id, { meta: JSON.stringify(meta) });
    const cur = this.get(g.id)!;
    if (cur.state !== 'running') return void this.#emit(g.id); // paused or stopped by the owner meanwhile
    if (out.minors) {
      this.#set(g.id, { state: 'stopped', reason: 'safety', ended_at: app.now().toISOString() });
      this.#line(cur, GOAL_LINES.safetyStop, {});
      return void this.#emit(g.id);
    }
    if (out.crisis) {
      this.#set(g.id, { state: 'paused', reason: 'crisis', meta: JSON.stringify({ ...cur.meta, pausedAt: app.now().toISOString() }) });
      this.#line(cur, GOAL_LINES.crisisPause, {});
      return void this.#emit(g.id);
    }
    if (out.status === 'stopped') {
      // Stop pressed in the chat: the goal pauses (Stop on the goal itself already ended it).
      this.#set(g.id, { state: 'paused', reason: 'owner', meta: JSON.stringify({ ...cur.meta, pausedAt: app.now().toISOString() }) });
      return void this.#emit(g.id);
    }
    if (out.budgetHit) {
      this.#set(g.id, { state: 'paused', reason: 'budget', meta: JSON.stringify({ ...cur.meta, pausedAt: app.now().toISOString() }) });
      this.#line(cur, GOAL_LINES.budgetPause, { n });
      return void this.#emit(g.id);
    }
    if (out.status === 'error' && /private local|Nothing leaves this computer|no model/i.test(out.error ?? '')) {
      this.#set(g.id, { state: 'paused', reason: 'private-local', meta: JSON.stringify({ ...cur.meta, pausedAt: app.now().toISOString() }) });
      this.#line(cur, GOAL_LINES.localPause, {});
      return void this.#emit(g.id);
    }
    if (out.guardPaused) return this.#stuck(cur, n, trOwner(GOAL_LINES.stuckGuard, app.settings.get()), this.lastCheck(g.id)?.quote ?? '–');
    // The check (Sara runs it, never she).
    this.#set(g.id, { state: 'checking' });
    this.#emit(g.id);
    const conv = app.store.getConversation(g.conversationId)!;
    let dir: string | undefined;
    try {
      dir = wsOf(app, conv);
    } catch {
      dir = undefined;
    }
    const after = dir ? fingerprint(dir, cur.checks.flatMap((c) => (c.command ? [c.command] : []))) : null;
    const roundChanges = before && after ? fpChanges(before, after) : { changed: out.files, tampered: [] };
    const startChanges = cur.fingerprint && after ? fpChanges(cur.fingerprint, after) : { changed: [], tampered: [] };
    const changedFiles = [...new Set([...roundChanges.changed, ...out.files])];
    const m2 = { ...this.get(g.id)!.meta, changed: { ...(cur.meta.changed ?? {}), [String(n)]: changedFiles.slice(0, 50) } };
    this.#set(g.id, { meta: JSON.stringify(m2) });
    if (cur.checks.some((c) => c.kind === 'owner')) {
      // "I'll say": the card asks him; his tap decides.
      this.#set(g.id, { meta: JSON.stringify({ ...m2, asking: true }) });
      const msg = app.store.addMessage(g.conversationId, 'assistant', trOwner(GOAL_LINES.ask, app.settings.get(), { n }), { goal: { id: g.id, round: n, ask: true }, app: true });
      app.events?.publish({ type: 'message', conversationId: g.conversationId, message: { id: msg.id, role: msg.role, content: msg.content, createdAt: msg.createdAt, meta: msg.meta }, reason: 'job' });
      return void this.#emit(g.id);
    }
    const ac = new AbortController();
    this.#checks.set(g.id, ac);
    const results: CheckResult[] = [];
    try {
      for (const c of cur.checks) {
        if (ac.signal.aborted) break;
        let r: CheckResult;
        if (c.kind === 'reviewer') {
          const changedText = dir ? changedFiles.slice(0, 8).flatMap((p) => {
            try {
              return [{ path: p, text: readFileSync(join(dir!, p), 'utf8').slice(0, 20_000) }];
            } catch {
              return [];
            }
          }) : [];
          r = await runReviewerCheck(app, conv, cur.text, changedText, ac.signal, persistSettings(app).goals.reviewer);
        } else if (dir && c.kind === 'types') {
          r = await runTypesCheck(app, conv.workspace || 'main', dir, ac.signal);
        } else if (dir && c.command) {
          r = await runCommandCheck(app, dir, c.kind, c.command, ac.signal, persistSettings(app).goals.checkMinutes * 60_000);
        } else r = { kind: c.kind, ok: false, exitCode: null, timedOut: false, key: `${c.kind}|missing`, quote: en('The check has no command.'), tail: '', ms: 0, broken: en('The check has no command.') };
        if (ac.signal.aborted) break;
        results.push(r);
        this.#insertCheck(cur, out.runId || null, r, startChanges.tampered.length ? startChanges.tampered : null, n);
        app.events?.publish({ type: 'goal_check', conversationId: g.conversationId, goalId: g.id, round: n, ok: r.ok, ...(r.passed !== undefined ? { passed: r.passed } : {}), ...(r.failed !== undefined ? { failed: r.failed } : {}), ...(r.quote ? { quote: r.quote } : {}) });
        if (!r.ok) break;
      }
    } finally {
      this.#checks.delete(g.id);
    }
    const now = this.get(g.id)!;
    if (ac.signal.aborted || now.state !== 'checking') return void this.#emit(g.id); // Stop (or Pause) while the check ran
    if (results.length === cur.checks.length && results.every((r) => r.ok)) {
      if (!out.claims) return this.#finish(now, results, startChanges.tampered, cur.checks.some((c) => c.kind === 'reviewer') && !cur.checks.some((c) => c.command) ? 'reviewer' : 'check');
      return this.#finish(now, results, startChanges.tampered, 'check', true);
    }
    const red = results.at(-1)!;
    // Progress or not (§4.6), in code.
    const prev = this.checks(g.id).filter((c) => c.round < n && !c.ok).at(-1);
    const nothing = changedFiles.length === 0;
    let streak = 1;
    if (prev) {
      const sameKey = prev.key === red.key;
      const fewer = red.failed !== undefined && prev.failed !== null && red.failed < prev.failed;
      const morePassed = red.passed !== undefined && prev.passed !== null && red.passed > prev.passed;
      const progress = !nothing && (!sameKey || fewer || morePassed);
      streak = progress ? 1 : now.noProgress + 1;
      if (red.broken && prev.key === red.key) streak = Math.max(streak, 2);
    } else if (nothing) streak = 1;
    this.#set(g.id, { no_progress: streak, state: 'running' });
    const stuckAfter = persistSettings(app).goals.stuckAfter;
    if (red.broken && prev && prev.quote === red.quote && streak >= 2) return this.#stuck(this.get(g.id)!, n, trOwner(GOAL_LINES.stuckBroken, app.settings.get(), { quote: red.quote }), red.quote);
    if (streak >= stuckAfter) return this.#stuck(this.get(g.id)!, n, trOwner(nothing ? GOAL_LINES.stuckNothing : GOAL_LINES.stuckSame, app.settings.get()), red.quote);
    this.#queueRound(this.get(g.id)!);
  }

  #insertCheck(g: Goal, runId: number | null, r: CheckResult, tampered: string[] | null, round = g.round): void {
    this.#db
      .prepare('INSERT INTO goal_checks (goal_id, round, run_id, kind, command, ok, exit_code, timed_out, passed, failed, skipped, key, quote, tail, tampered, ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(g.id, round, runId, r.kind, r.command ?? null, r.ok ? 1 : 0, r.exitCode, r.timedOut ? 1 : 0, r.passed ?? null, r.failed ?? null, r.skipped ?? null, r.key, r.quote ? oneLine(r.quote, 300) : null, r.tail, tampered?.length ? JSON.stringify(tampered) : null, r.ms, this.#app.now().toISOString());
  }

  /** Green: done (amber "review" when the tests or the check's script changed since Start). */
  #finish(g: Goal, results: CheckResult[], tampered: string[], by: 'check' | 'reviewer' | 'owner', claimsOpen = false): void {
    const app = this.#app;
    const s = app.settings.get();
    const review = tampered.length > 0 || claimsOpen;
    this.#set(g.id, { state: 'done', reason: review ? 'review' : by === 'check' ? null : by, ended_at: app.now().toISOString(), meta: JSON.stringify({ ...g.meta, asking: false, ...(tampered.length ? { tampered } : {}) }) });
    const used = this.#used(this.get(g.id)!);
    const r = results.find((x) => x.passed !== undefined) ?? results[0];
    const check = r ? `${r.command ?? r.kind}${r.passed !== undefined ? `: ${r.passed} passed, ${r.failed ?? 0} failed` : ''}` : by;
    let line = review && tampered.length
      ? trOwner(GOAL_LINES.doneReview, s, { check, rounds: g.round, files: tampered.join(', ') })
      : trOwner(GOAL_LINES.done, s, { check, rounds: g.round, time: fmtTime(used.ms), tokens: fmtN(used.tokens) });
    if (by === 'reviewer') line += ` ${trOwner(GOAL_LINES.doneReviewer, s)}`;
    if (by === 'owner') line += ` ${trOwner(GOAL_LINES.doneOwner, s)}`;
    this.#line(g, line, undefined, true, { state: 'done', review, tampered });
    void app.push?.notifyOwner(trOwner('Sara finished', s, undefined, identityOf(app.persona)), line, g.conversationId, `goal-${g.id}`).catch(() => {});
    if (app.calls?.wants('job')) app.calls.ring({ kind: 'job', reason: line, conversationId: g.conversationId });
    this.#emit(g.id);
  }

  #stuck(g: Goal, n: number, why: string, quote: string): void {
    const app = this.#app;
    const note = `${why} ${quote}`.trim();
    this.#set(g.id, { state: 'stuck', reason: null, ended_at: app.now().toISOString(), meta: JSON.stringify({ ...g.meta, note: `[Note from the app: the last try got stuck: ${oneLine(note, 400)} Try a different approach.]` }) });
    const line = trOwner(GOAL_LINES.stuck, app.settings.get(), { n, why, quote: quote || '–' });
    this.#line(g, line, undefined, true, { state: 'stuck' });
    void app.push?.notifyOwner(trOwner('Sara is stuck', app.settings.get(), undefined, identityOf(app.persona)), line, g.conversationId, `goal-${g.id}`).catch(() => {});
    this.#emit(g.id);
  }

  /** The round's note (§4.5): the goal, the round, the real failure, what stays blocked. */
  #note(g: Goal, n: number, last: CheckRow | undefined, extra?: string, resumed = false): string {
    const owner = ownerWord(this.#app);
    const words = g.checks.map((c) => c.words).join(' + ');
    const head = `[Note from the app, not from ${owner}: you're working toward a goal ${owner} set in this chat: "${oneLine(g.text, 600)}". Round ${n} of ${g.caps.rounds}.`;
    let body = '';
    if (last && !last.ok) {
      const tail = last.tail ? `\n${last.tail.split(/\r?\n/).filter((l) => l.trim()).slice(-20).join('\n').slice(-2000)}` : '';
      body = ` After your last round the app ran the check ${owner} picked (${words}) and it is NOT done yet: exit code ${last.exitCode ?? 'none'}${last.failed !== null ? `, ${last.failed} failing, ${last.passed ?? 0} passing` : ''}. ${last.quote ?? ''}${tail}\n`;
    } else if (resumed) body = ` ${owner} resumed it.`;
    else body = ` When you finish this round the app runs the check ${owner} picked (${words}).`;
    const bl = (g.meta.blocked ?? []).slice(0, 5);
    const blockedLine = bl.length ? `\nStill blocked from earlier rounds (don't retry them): ${bl.map((b) => `"${oneLine(b.quote, 120)}"`).join('; ')}` : '';
    return `${head}${body}${blockedLine}${extra ? `\n${extra}` : ''}\nCarry on from where you are. Don't redo what is done. Don't say it's finished: the check decides. When you've done what you can this round, say in one or two sentences what you changed.]`;
  }

  // ------------------------------------------------------------------ caps (§4.7)

  #runs(g: Goal) {
    return (this.#app.runs?.list({ conversationId: g.conversationId, limit: 500 }) ?? []).filter((r) => Number(r.policy?.goalId) === g.id);
  }
  /** Spend summed from the run record (no second meter); active time from Start minus pauses and waits. */
  #used(g: Goal): GoalUsed & { unpriced: number } {
    const runs = this.#runs(g);
    const tokens = runs.reduce((a, r) => a + r.tokensIn + r.tokensOut, 0);
    const usd = runs.reduce((a, r) => a + r.usd, 0);
    const unpriced = runs.reduce((a, r) => a + r.unpriced, 0);
    const end = g.endedAt ? Date.parse(g.endedAt) : g.meta.pausedAt ? Date.parse(g.meta.pausedAt) : this.#app.now().getTime();
    const ms = g.startedAt ? Math.max(0, end - Date.parse(g.startedAt) - g.used.pausedMs - g.used.waitMs) : 0;
    return { ...g.used, tokens, usd, ms, unpriced };
  }
  #capCheck(g: Goal, projected: boolean): ReturnType<typeof budgetCheck> {
    const used = this.#used(g);
    if (g.state === 'draft') return { frac: 0 };
    if (g.round >= g.caps.rounds && projected) return { reached: 'steps', reason: `${CAP_WORDS.steps} (${g.caps.rounds} rounds)`, frac: 1, top: 'steps' };
    const b: Budget = { ...(g.caps.tokens ? { tokens: g.caps.tokens } : {}), ...(g.caps.usd ? { usd: g.caps.usd } : {}), ...(g.caps.minutes ? { minutes: g.caps.minutes } : {}) };
    let billing: ReturnType<typeof billingOf>[] | undefined;
    try {
      const conv = this.#app.store.getConversation(g.conversationId);
      billing = conv ? [billingOf(resolveFor(this.#app, conv).provider.config)] : undefined;
    } catch {
      billing = undefined;
    }
    const last = g.meta.last;
    const c = budgetCheck(b, { tokens: used.tokens, usd: used.usd, unpriced: used.unpriced, ms: used.ms, ...(billing ? { billing } : {}) }, projected && last ? { next: { tokens: last.tokens, usd: last.usd } } : {});
    const roundFrac = g.caps.rounds ? g.round / g.caps.rounds : 0;
    if (roundFrac > c.frac && !c.reached) return { ...c, frac: roundFrac, top: 'steps' };
    if (c.reached === 'usd' && usdMeaningless(billing)) return { frac: c.frac };
    return c;
  }

  // ------------------------------------------------------------------ inside

  #fp(g: Goal): Fingerprint | null {
    const conv = this.#app.store.getConversation(g.conversationId);
    if (!conv) return null;
    try {
      return fingerprint(wsOf(this.#app, conv), g.checks.flatMap((c) => (c.command ? [c.command] : [])));
    } catch {
      return null;
    }
  }
  #dropQueued(g: Goal): void {
    const pend = pendingFor(this.#app);
    for (const it of pend.list(g.conversationId)) if ((it.meta.goal as { id?: number } | undefined)?.id === g.id) pend.cancel(g.conversationId, it.id);
  }
  /** One line in the chat in the owner's language (the app's words, never a model call). */
  #line(g: Goal, text: string, params: Record<string, unknown> | undefined, publish = true, extra: Record<string, unknown> = {}): void {
    const app = this.#app;
    const said = params ? trOwner(text, app.settings.get(), params) : text;
    const msg = app.store.addMessage(g.conversationId, 'assistant', said, { goal: { id: g.id, round: g.round, end: true, ...extra }, app: true, background: true });
    if (publish) app.events?.publish({ type: 'message', conversationId: g.conversationId, message: { id: msg.id, role: msg.role, content: msg.content, createdAt: msg.createdAt, meta: msg.meta }, reason: 'job' });
  }
  #set(id: number, patch: Record<string, unknown>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.#db.prepare(`UPDATE chat_goals SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...(Object.values(patch) as (string | number | null)[]), this.#app.now().toISOString(), id);
  }
  #emit(id: number): void {
    const g = this.get(id);
    if (!g) return;
    try {
      this.#app.events?.publish({ type: 'goal', conversationId: g.conversationId, goal: this.view(g) });
      if (g.meta.card !== undefined) this.#app.events?.publish({ type: 'board', boardId: 'goal', taskId: g.meta.card, what: 'goal' });
    } catch {
      /* the hub is best effort */
    }
  }
}

/** The goal text, checked once at Start like a message (§5.14 Both). */
function safetyOf(text: string): { minor: boolean; crisis: boolean; resources: string } {
  const pf = preflight(text, { owner: true });
  return { minor: Boolean(pf.minor), crisis: pf.crisis, resources: CRISIS_RESOURCES };
}

/** This companion's goals (made on first use). */
export function goalsFor(app: AppContext): Goals {
  app.goals ??= new Goals(app);
  return app.goals;
}
