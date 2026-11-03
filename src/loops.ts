// Phase 118 part B (docs/design/PERSIST.md §5, 2.51.0): repeat it in the chat. A loop is the
// owner's order ("every 10 minutes, check the deploy and tell me if it's red"), confirmed with
// Start, that wakes her on the reminder scheduler's existing 15-second tick (no new timer). Each
// tick is a queued owner input (src/pending.ts) run as an ordinary turn with a small tick budget;
// what would ask is refused (nobody is watching) and pauses the loop. Unchanged results are one
// folded line with no ping; a change is her message and a notification; `met` needs a receipt (or
// a green P2 check). It always has an end time, a tick cap, a per-loop and an all-loops daily cap
// (the CH3 DailyLedger), it skips quiet hours, stops on failures and on no progress, and comes
// back paused after a restart.
//
// Tables (additive, the conversation's own store.db): chat_loops, loop_ticks (§5.12).
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DailyLedger } from './budget.ts';
import type { AppContext, PersistTurn } from './chat.ts';
import { en, trOwner } from './i18n.ts';
import { proactiveSettings, quietNow, inQuiet } from './life.ts';
import { localDate } from './memory-worker.ts';
import { identityOf } from './persona.ts';
import { pendingFor, type PendingItem } from './pending.ts';
import { oneLine, ownerWord, persistRefusal, persistSettings, refuseCheck, runCommandCheck, runPersistTurn, wsOf, type CheckResult } from './persist.ts';
import { zonedParts } from './planner.ts';
import { preflight } from './chat.ts';
import { privateLocalOn } from './net-guard.ts';
import { normalizeMessage } from './triggers.ts';

export type LoopState = 'draft' | 'active' | 'ticking' | 'paused' | 'done' | 'ended' | 'stopped';
export const FINAL_LOOP: readonly LoopState[] = ['done', 'ended', 'stopped'];
export type TickOutcome = 'same' | 'changed' | 'met' | 'failed' | 'skipped';

export interface LoopMeta {
  source?: string;
  proposedBy?: 'her';
  room?: number;
  /** The call a paused-for-approval loop needs (and *Allow once* lets through on the next tick). */
  ask?: { key: string; name: string; summary: string };
  allowOnce?: string[];
  /** Quiet hours: the night a skipped row was written for; a slot was missed. */
  quietLogged?: string;
  missed?: boolean;
  /** cap:day: the local day it paused on. */
  capDay?: string;
  /** crisis: paused until. */
  until?: string;
  pausedAt?: string;
  /** The last tick's spend (the projection for the daily caps). */
  last?: number;
  /** Phase 121: a routine loop's "ends on …" line was posted (once, a week before). */
  endsNoted?: boolean;
}
/** Phase 121 (BEGIN §4.5): a routine loop's clock schedule (the owner's time zone). */
export interface LoopSchedule {
  at: string;
  repeat: 'daily' | 'weekdays' | 'weekly';
  day?: number;
}
export interface Loop {
  id: number;
  conversationId: string;
  prompt: string;
  everyMin: number;
  untilText: string | null;
  untilCheck: { kind: 'command'; command: string } | null;
  endsAt: string;
  maxTicks: number;
  quiet: 'pause' | 'hold';
  tickBudget: { tokens: number; steps: number };
  dayTokens: number;
  state: LoopState;
  reason: string | null;
  nextAt: string | null;
  lastAt: string | null;
  ticks: number;
  failCount: number;
  sameCount: number;
  lastFingerprint: string | null;
  lastLine: string | null;
  held: number[];
  meta: LoopMeta;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  endedAt: string | null;
  /** Phase 121: set for loops made by a routine (routines.id); a typed /loop has none. */
  routineId: number | null;
  schedule: LoopSchedule | null;
}
export type LoopView = Loop & { conversationTitle?: string | null; todayTokens: number };
export interface TickRow {
  id: number;
  loopId: number;
  n: number;
  runId: number | null;
  messageId: number | null;
  outcome: TickOutcome;
  why: string | null;
  tokens: number;
  usd: number;
  at: string;
}

const KEEP_DAYS = 30;
const CRISIS_HOURS = 48;

export const LOOP_LINES = {
  same: en('{time} · no change'),
  met: en('✅ The repeat is done: {condition}'),
  ended: en('🔁 The repeat ended: {prompt}'),
  failed: en('🔁 I stopped the repeat: it failed {n} time(s) in a row. Last: {error}'),
  noProgress: en('🔁 Nothing changed in {n} checks. I stopped the repeat.'),
  approval: en('🔁 Paused: this repeat needed an OK for “{summary}”, and nobody is watching. Allow it once and resume, or stop it.'),
  capDay: en('🔁 Paused until tomorrow: today’s budget for repeats is used.'),
  restart: en('🔁 Sara restarted, so this repeat is paused: {prompt}. Resume it when you want.'),
  endsSoon: en('This routine ends on {date}. To keep it, open Planner → Routines and tap Keep it for 30 more days.'),
  crisis: en('🔁 Repeats in this chat are paused for now.'),
  slept: en('While you slept: {text}'),
  unattended: en('This is a repeat and {owner} isn’t watching: anything that needs an OK pauses it.'),
  stopped: en('🔁 Stopped: {prompt}'),
  safety: en('🔁 Stopped for a safety reason.'),
} as const;

const SQL = `CREATE TABLE IF NOT EXISTS chat_loops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  every_min REAL NOT NULL,
  until_text TEXT,
  until_check TEXT,
  ends_at TEXT NOT NULL,
  max_ticks INTEGER NOT NULL,
  quiet TEXT NOT NULL DEFAULT 'pause',
  tick_budget TEXT NOT NULL,
  day_tokens INTEGER NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  next_at TEXT, last_at TEXT,
  ticks INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0, same_count INTEGER NOT NULL DEFAULT 0,
  last_fingerprint TEXT, last_line TEXT,
  held TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, started_at TEXT, updated_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX IF NOT EXISTS chat_loops_due ON chat_loops(state, next_at);
CREATE TABLE IF NOT EXISTS loop_ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loop_id INTEGER NOT NULL,
  n INTEGER NOT NULL,
  run_id INTEGER, message_id INTEGER,
  outcome TEXT NOT NULL,
  why TEXT,
  tokens INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS loop_ticks_loop ON loop_ticks(loop_id, at);`;

type Row = Record<string, unknown>;
const parse = <T>(s: unknown, d: T): T => {
  try {
    return s ? (JSON.parse(String(s)) as T) : d;
  } catch {
    return d;
  }
};
const toLoop = (r: Row): Loop => ({
  id: Number(r.id),
  conversationId: String(r.conversation_id),
  prompt: String(r.prompt),
  everyMin: Number(r.every_min),
  untilText: (r.until_text as string | null) ?? null,
  untilCheck: parse(r.until_check, null),
  endsAt: String(r.ends_at),
  maxTicks: Number(r.max_ticks),
  quiet: r.quiet === 'hold' ? 'hold' : 'pause',
  tickBudget: parse(r.tick_budget, { tokens: 50_000, steps: 10 }),
  dayTokens: Number(r.day_tokens),
  state: String(r.state) as LoopState,
  reason: (r.reason as string | null) ?? null,
  nextAt: (r.next_at as string | null) ?? null,
  lastAt: (r.last_at as string | null) ?? null,
  ticks: Number(r.ticks),
  failCount: Number(r.fail_count),
  sameCount: Number(r.same_count),
  lastFingerprint: (r.last_fingerprint as string | null) ?? null,
  lastLine: (r.last_line as string | null) ?? null,
  held: parse<number[]>(r.held, []),
  meta: parse<LoopMeta>(r.meta, {}),
  createdAt: String(r.created_at),
  startedAt: (r.started_at as string | null) ?? null,
  updatedAt: String(r.updated_at),
  endedAt: (r.ended_at as string | null) ?? null,
  routineId: r.routine_id === null || r.routine_id === undefined ? null : Number(r.routine_id),
  schedule: parse<LoopSchedule | null>(r.schedule, null),
});

/** Phase 121: the next slot of a clock schedule strictly after `after` (the owner's zone). */
export function nextScheduled(sc: LoopSchedule, after: Date, tz?: string): Date {
  let t = atLocal(sc.at, after, tz);
  for (let i = 0; i < 9; i++) {
    const wd = zonedParts(t, tz).wd;
    if (sc.repeat === 'daily' || (sc.repeat === 'weekdays' && wd >= 1 && wd <= 5) || (sc.repeat === 'weekly' && wd === (sc.day ?? 1))) return t;
    t = atLocal(sc.at, new Date(t.getTime() + 60_000), tz);
  }
  return t;
}
/** Phase 121: routine loops (BEGIN §4.5): the longest a routine may run, and the shortest interval. */
export const ROUTINE_MAX_DAYS = [7, 14, 30, 90] as const;
export const ROUTINE_MIN_EVERY_H = 6;

// ------------------------------------------------------------------ the command (§5.3)

export type LoopCommand =
  | { sub: 'list' | 'start' }
  | { sub: 'pause' | 'resume' | 'stop'; n?: number; all?: boolean }
  | { sub: 'set'; spec: LoopSpec }
  | { sub: 'error'; error: string };
export interface LoopSpec {
  prompt: string;
  everyMin: number;
  forMin?: number;
  endsAtLocal?: string;
  times?: number;
  untilText?: string;
  untilCommand?: string;
}
const SUB: Record<string, 'list' | 'start' | 'pause' | 'resume' | 'stop'> = {
  list: 'list', lista: 'list', liste: 'list',
  start: 'start', empezar: 'start', iniciar: 'start', commencer: 'start', starten: 'start', comecar: 'start', inizia: 'start', avvia: 'start',
  pause: 'pause', pausa: 'pause', pausar: 'pause', pausieren: 'pause',
  resume: 'resume', reanudar: 'resume', reprendre: 'resume', weiter: 'resume', continuar: 'resume', riprendi: 'resume',
  stop: 'stop', parar: 'stop', detener: 'stop', arreter: 'stop', stopp: 'stop', ferma: 'stop',
};
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const mins = (n: string, u: string) => Number(n) * (/^h/i.test(u) ? 60 : 1);

/** `/loop every <n>(m|h)[ for <n>(m|h) | until <hh:mm> | <n> times][ until <condition>]: <prompt>`. */
export function parseLoopCommand(args: string): LoopCommand {
  const a = args.trim();
  if (!a) return { sub: 'list' };
  const [w, ...rest] = a.split(/\s+/);
  const sub = SUB[fold(w)];
  if (sub === 'list' || sub === 'start') return rest.length ? { sub: 'error', error: en('Say /loop every 10m: what to do.') } : { sub };
  if (sub) {
    if (rest[0] && fold(rest[0]) === 'all') return { sub, all: true };
    const n = rest[0] ? Number(rest[0]) : undefined;
    return { sub, ...(n !== undefined && Number.isFinite(n) ? { n } : {}) };
  }
  const colon = a.indexOf(':');
  // "every 10m: …" – the first ':' that isn't part of a time like 14:30.
  const m = /^every\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hours?)\b([\s\S]*)$/i.exec(a);
  if (!m || colon < 0) return { sub: 'error', error: en('Say /loop every 10m: what to do.') };
  let head = m[3];
  const body = head.match(/^((?:[^:`]|`[^`]*`|\d:\d)*?):\s*([\s\S]+)$/);
  if (!body) return { sub: 'error', error: en('Say /loop every 10m: what to do.') };
  head = body[1];
  const prompt = body[2].trim();
  const spec: LoopSpec = { prompt, everyMin: mins(m[1], m[2]) };
  const forM = /\bfor\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hours?)\b/i.exec(head);
  if (forM) spec.forMin = mins(forM[1], forM[2]);
  const timeM = /\buntil\s+(\d{1,2}:\d{2})\b/i.exec(head);
  if (timeM) spec.endsAtLocal = timeM[1];
  const timesM = /\b(\d+)\s+times\b/i.exec(head);
  if (timesM) spec.times = Number(timesM[1]);
  const cond = /\buntil\s+(?!\d{1,2}:\d{2}\b)([\s\S]+)$/i.exec(head);
  if (cond) {
    const c = cond[1].trim();
    const cmd = /`([^`]+)`/.exec(c);
    if (cmd) spec.untilCommand = cmd[1].trim();
    spec.untilText = c.replace(/\s+passes$/i, '').trim();
  }
  return { sub: 'set', spec };
}

/** The next hh:mm (local) after now, as a Date. */
function atLocal(hhmm: string, now: Date, tz?: string): Date {
  const [h, mi] = hhmm.split(':').map(Number);
  const p = zonedParts(now, tz);
  let delta = (h * 60 + mi - (p.h * 60 + p.mi)) * 60_000;
  if (delta <= 0) delta += 86_400_000;
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000 + delta);
}

// ------------------------------------------------------------------ the store and the clock

export class Loops {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly ledger: DailyLedger;

  constructor(app: AppContext, db: DatabaseSync = app.store.db) {
    this.#app = app;
    this.#db = db;
    db.exec(SQL);
    // Phase 121 (additive): routine loops' clock schedule and their routine.
    const cols = new Set((db.prepare('PRAGMA table_info(chat_loops)').all() as Row[]).map((r) => String(r.name)));
    if (!cols.has('schedule')) db.exec('ALTER TABLE chat_loops ADD COLUMN schedule TEXT');
    if (!cols.has('routine_id')) db.exec('ALTER TABLE chat_loops ADD COLUMN routine_id INTEGER');
    this.ledger = new DailyLedger(db, () => localDate(app.now(), app.settings.get().timeZone));
  }

  get(id: number): Loop | undefined {
    const r = this.#db.prepare('SELECT * FROM chat_loops WHERE id = ?').get(id) as Row | undefined;
    return r ? toLoop(r) : undefined;
  }
  /** A conversation's loops (standing ones first, then the last 30 days' ended ones). */
  forConversation(conversationId: string): Loop[] {
    return (this.#db.prepare('SELECT * FROM chat_loops WHERE conversation_id = ? ORDER BY id').all(conversationId) as Row[]).map(toLoop);
  }
  /** Planner → Repeats and Today: every loop of this companion. */
  all(): Loop[] {
    return (this.#db.prepare('SELECT * FROM chat_loops ORDER BY id').all() as Row[]).map(toLoop);
  }
  standing(conversationId: string): Loop[] {
    return this.forConversation(conversationId).filter((l) => !FINAL_LOOP.includes(l.state) && l.state !== 'draft');
  }
  ticks(loopId: number, limit = 100): TickRow[] {
    return (this.#db.prepare('SELECT * FROM loop_ticks WHERE loop_id = ? ORDER BY id DESC LIMIT ?').all(loopId, limit) as Row[]).map((r) => ({ id: Number(r.id), loopId: Number(r.loop_id), n: Number(r.n), runId: r.run_id === null ? null : Number(r.run_id), messageId: r.message_id === null ? null : Number(r.message_id), outcome: String(r.outcome) as TickOutcome, why: (r.why as string | null) ?? null, tokens: Number(r.tokens), usd: Number(r.usd), at: String(r.at) }));
  }
  view(l: Loop | undefined): LoopView | null {
    if (!l) return null;
    return { ...l, conversationTitle: this.#app.store.getConversation(l.conversationId)?.title ?? null, todayTokens: this.ledger.get(`loop:${l.id}`).tokens };
  }
  #activeCount(): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM chat_loops WHERE state IN ('active','ticking')").get() as Row).n);
  }

  /** The card's fields and estimate (§5.3), or what's wrong. */
  plan(spec: LoopSpec): { ok: true; card: { prompt: string; everyMin: number; forMin: number; endsAt: string; maxTicks: number; untilText: string | null; untilCommand: string | null; quiet: 'pause' | 'hold'; quietHours: string; tickTokens: number; dailyTokens: number; ticks: number; capped: boolean } } | { ok: false; error: string } {
    const app = this.#app;
    const set = persistSettings(app).loops;
    const now = app.now();
    const prompt = String(spec.prompt ?? '').trim().slice(0, 1000);
    if (!prompt) return { ok: false, error: en('Say what she should do each time.') };
    const every = Number(spec.everyMin);
    if (!Number.isFinite(every) || every <= 0) return { ok: false, error: en('Say how often, like every 10m.') };
    if (every < set.minEvery) return { ok: false, error: trOwner('Every {every} minute(s) is shorter than the {min} minutes allowed.', app.settings.get(), { every, min: set.minEvery }) };
    let forMin = spec.forMin ?? (spec.endsAtLocal ? (atLocal(spec.endsAtLocal, now, app.settings.get().timeZone).getTime() - now.getTime()) / 60_000 : spec.times ? spec.times * every : set.defaultFor * 60);
    let capped = false;
    if (forMin > set.maxFor * 60) {
      forMin = set.maxFor * 60;
      capped = true;
    }
    const maxTicks = Math.max(1, Math.min(set.maxTicks, spec.times ?? Infinity, Math.floor(forMin / every) || 1));
    if (spec.untilCommand) {
      const no = refuseCheck(spec.untilCommand);
      if (no) return { ok: false, error: no.text };
    }
    const p = proactiveSettings(app);
    // The estimate (code): slots in the window minus the quiet-hours ones.
    let ticks = 0;
    for (let t = now.getTime() + every * 60_000, i = 0; t <= now.getTime() + forMin * 60_000 && i < maxTicks; t += every * 60_000) {
      if (set.quiet === 'pause' && inQuiet(zonedParts(new Date(t), app.settings.get().timeZone).h, p.quietStart, p.quietEnd)) continue;
      ticks++;
      i++;
    }
    return { ok: true, card: { prompt, everyMin: every, forMin, endsAt: new Date(now.getTime() + forMin * 60_000).toISOString(), maxTicks, untilText: spec.untilText ?? null, untilCommand: spec.untilCommand ?? null, quiet: set.quiet, quietHours: `${String(p.quietStart).padStart(2, '0')}:00–${String(p.quietEnd).padStart(2, '0')}:00`, tickTokens: set.tick.tokens, dailyTokens: set.dailyTokens, ticks, capped } };
  }

  /** §5.13 POST: a draft (or active with `start`); 409 at maxActive. */
  create(conversationId: string, body: LoopSpec & { quiet?: unknown; start?: boolean; source?: string; proposedBy?: 'her'; room?: number }): { loop: Loop } | { status: number; error: string } {
    const app = this.#app;
    const conv = app.store.getConversation(conversationId);
    const no = persistRefusal(app, conv);
    if (no) return { status: conv ? 400 : 404, error: no };
    const set = persistSettings(app).loops;
    if (!set.on) return { status: 400, error: en('Repeats are switched off in Settings → Coding → Keep going and repeats.') };
    const pl = this.plan(body);
    if (!pl.ok) return { status: 400, error: pl.error };
    if (body.start && this.#activeCount() >= set.maxActive) return { status: 409, error: trOwner('{n} repeats are already running. Stop one first.', app.settings.get(), { n: set.maxActive }) };
    const c = pl.card;
    const now = app.now().toISOString();
    const quiet = body.quiet === 'hold' ? 'hold' : body.quiet === 'pause' ? 'pause' : set.quiet;
    const meta: LoopMeta = { ...(body.source ? { source: body.source } : {}), ...(body.proposedBy ? { proposedBy: body.proposedBy } : {}), ...(body.room ? { room: body.room } : {}) };
    // A draft keeps its window length; Start sets the real end time.
    const r = this.#db
      .prepare('INSERT INTO chat_loops (conversation_id, prompt, every_min, until_text, until_check, ends_at, max_ticks, quiet, tick_budget, day_tokens, state, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(conversationId, c.prompt, c.everyMin, c.untilText, c.untilCommand ? JSON.stringify({ kind: 'command', command: c.untilCommand }) : null, c.endsAt, c.maxTicks, quiet, JSON.stringify(set.tick), Math.max(1, Math.floor(set.dailyTokens / set.maxActive)), 'draft', JSON.stringify({ ...meta, forMin: c.forMin }), now, now);
    const id = Number(r.lastInsertRowid);
    if (body.start) {
      const s = this.start(id);
      if ('error' in s) return s;
    }
    this.#emit(id);
    return { loop: this.get(id)! };
  }

  /**
   * Phase 121 (BEGIN §4.5): a loop made by a routine's Turn on (the owner's tap on a card that showed
   * the cost line): a clock schedule or an interval of at least 6 hours, an end date up to 90 days
   * (the card offers 7 / 14 / 30 / 90; 30 by default), the per-loop daily share, and every Phase 118
   * guard. Tools keep the owner's approval settings: anything that would ask pauses it.
   */
  createRoutine(conversationId: string, spec: { prompt: string; everyMin?: number; schedule?: LoopSchedule; days: number; untilText?: string; routineId: number; source?: string }): { loop: Loop } | { status: number; error: string } {
    const app = this.#app;
    const set = persistSettings(app).loops;
    if (!set.on) return { status: 400, error: en('Repeats are switched off in Settings → Coding → Keep going and repeats.') };
    if (!(ROUTINE_MAX_DAYS as readonly number[]).includes(spec.days)) return { status: 400, error: en('Pick 7, 14, 30 or 90 days.') };
    const tz = app.settings.get().timeZone;
    const now = app.now();
    const ends = now.getTime() + spec.days * 86_400_000;
    let every = Number(spec.everyMin ?? 0);
    let maxTicks = 0;
    if (spec.schedule) {
      every = spec.schedule.repeat === 'weekly' ? 7 * 1440 : 1440;
      for (let t = nextScheduled(spec.schedule, now, tz); t.getTime() <= ends && maxTicks < 400; t = nextScheduled(spec.schedule, t, tz)) maxTicks++;
    } else {
      if (!(every >= ROUTINE_MIN_EVERY_H * 60)) return { status: 400, error: trOwner('A routine checks every {h} hours at most.', app.settings.get(), { h: ROUTINE_MIN_EVERY_H }) };
      maxTicks = Math.floor((ends - now.getTime()) / (every * 60_000));
    }
    if (this.#activeCount() >= set.maxActive) return { status: 409, error: trOwner('{n} repeats are already running. Stop one first.', app.settings.get(), { n: set.maxActive }) };
    const pf = preflight(spec.prompt, { owner: true });
    if (pf.minor || pf.crisis) return { status: 400, error: en('I can’t do that.') };
    const iso = now.toISOString();
    const next = spec.schedule ? nextScheduled(spec.schedule, now, tz) : new Date(now.getTime() + every * 60_000);
    const r = this.#db
      .prepare('INSERT INTO chat_loops (conversation_id, prompt, every_min, until_text, until_check, ends_at, max_ticks, quiet, tick_budget, day_tokens, state, meta, created_at, updated_at, started_at, next_at, schedule, routine_id) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(conversationId, spec.prompt.slice(0, 1000), every, spec.untilText ?? null, new Date(ends).toISOString(), Math.max(1, maxTicks), 'pause', JSON.stringify(set.tick), Math.max(1, Math.floor(set.dailyTokens / set.maxActive)), 'active', JSON.stringify({ source: spec.source ?? 'routine' }), iso, iso, iso, next.toISOString(), spec.schedule ? JSON.stringify(spec.schedule) : null, spec.routineId);
    const id = Number(r.lastInsertRowid);
    this.#emit(id);
    return { loop: this.get(id)! };
  }

  /** The owner's tap (Rule 7: Start is the OK for the spend the card showed). */
  start(id: number): { loop: Loop } | { status: number; error: string } {
    const app = this.#app;
    const l = this.get(id);
    if (!l) return { status: 404, error: en('Repeat not found') };
    if (l.state !== 'draft') return { status: 409, error: en('This repeat has already started.') };
    const set = persistSettings(app).loops;
    if (this.#activeCount() >= set.maxActive) return { status: 409, error: trOwner('{n} repeats are already running. Stop one first.', app.settings.get(), { n: set.maxActive }) };
    const pf = preflight(l.prompt, { owner: true });
    if (pf.minor) {
      this.#set(id, { state: 'stopped', reason: 'safety', ended_at: app.now().toISOString() });
      return { status: 400, error: en('I can’t do that.') };
    }
    if (pf.crisis) {
      this.#set(id, { state: 'stopped', reason: 'crisis', ended_at: app.now().toISOString() });
      return { status: 400, error: en('Your wellbeing comes first. The repeat wasn’t started.') };
    }
    const now = app.now();
    const forMin = Number((l.meta as { forMin?: number }).forMin) || (Date.parse(l.endsAt) - Date.parse(l.createdAt)) / 60_000;
    this.#set(id, { state: 'active', reason: null, started_at: now.toISOString(), ends_at: new Date(now.getTime() + forMin * 60_000).toISOString(), next_at: new Date(now.getTime() + l.everyMin * 60_000).toISOString() });
    this.#emit(id);
    return { loop: this.get(id)! };
  }

  pause(id: number, reason = 'owner'): Loop | undefined {
    const l = this.get(id);
    if (!l || !['active', 'ticking'].includes(l.state)) return l;
    this.#dropQueued(l);
    this.#set(id, { state: 'paused', reason, meta: JSON.stringify({ ...l.meta, pausedAt: this.#app.now().toISOString() }) });
    this.#emit(id);
    return this.get(id);
  }

  /** Resume (owner): the next tick at now + every; *Allow once and resume* lets the waiting call through once. */
  resume(id: number, o: { allowOnce?: boolean } = {}): { loop: Loop } | { status: number; error: string } {
    const app = this.#app;
    const l = this.get(id);
    if (!l) return { status: 404, error: en('Repeat not found') };
    if (l.state !== 'paused') return { status: 409, error: en('This repeat isn’t paused.') };
    const now = app.now();
    if (Date.parse(l.endsAt) <= now.getTime()) return { status: 409, error: en('It ended while paused. Start it again as a new repeat.') };
    if (this.#activeCount() >= persistSettings(app).loops.maxActive) return { status: 409, error: trOwner('{n} repeats are already running. Stop one first.', app.settings.get(), { n: persistSettings(app).loops.maxActive }) };
    const meta: LoopMeta = { ...l.meta, ...(o.allowOnce && l.meta.ask ? { allowOnce: [l.meta.ask.key] } : {}) };
    delete meta.ask;
    delete meta.pausedAt;
    this.#set(id, { state: 'active', reason: null, fail_count: 0, next_at: l.routineId !== null ? this.#nextSlot({ ...l, nextAt: null }, now) : new Date(now.getTime() + l.everyMin * 60_000).toISOString(), meta: JSON.stringify(meta) });
    this.#emit(id);
    return { loop: this.get(id)! };
  }

  stop(id: number, reason = 'owner', line = true): Loop | undefined {
    const l = this.get(id);
    if (!l || FINAL_LOOP.includes(l.state)) return l;
    this.#dropQueued(l);
    if (l.state === 'ticking') this.#app.stopTurn?.(l.conversationId);
    this.#set(id, { state: l.state === 'draft' ? 'stopped' : 'stopped', reason, ended_at: this.#app.now().toISOString(), next_at: null });
    if (line && l.state !== 'draft') this.#line(l, trOwner(LOOP_LINES.stopped, this.#app.settings.get(), { prompt: oneLine(l.prompt, 80) }), true);
    this.#emit(id);
    return this.get(id);
  }

  /** *Run now*: a tick at once (it counts as one). */
  runNow(id: number): { loop: Loop } | { status: number; error: string } {
    const l = this.get(id);
    if (!l) return { status: 404, error: en('Repeat not found') };
    if (l.state !== 'active') return { status: 409, error: en('Only a running repeat can check now.') };
    this.#tick(l, this.#app.now());
    return { loop: this.get(id)! };
  }

  /** PATCH: every, ends, quiet (never past the settings). */
  patch(id: number, body: { everyMin?: unknown; endsAt?: unknown; quiet?: unknown }): { loop: Loop } | { status: number; error: string } {
    const l = this.get(id);
    if (!l) return { status: 404, error: en('Repeat not found') };
    if (FINAL_LOOP.includes(l.state)) return { status: 409, error: en('This repeat has ended.') };
    const set = persistSettings(this.#app).loops;
    const patch: Record<string, unknown> = {};
    if (body.everyMin !== undefined) {
      const e = Number(body.everyMin);
      if (!(e >= set.minEvery)) return { status: 400, error: trOwner('Every {every} minute(s) is shorter than the {min} minutes allowed.', this.#app.settings.get(), { every: e, min: set.minEvery }) };
      patch.every_min = e;
    }
    if (body.endsAt !== undefined) {
      const t = Date.parse(String(body.endsAt));
      const start = Date.parse(l.startedAt ?? l.createdAt);
      if (!Number.isFinite(t)) return { status: 400, error: en('Say when it should end.') };
      patch.ends_at = new Date(Math.min(t, start + set.maxFor * 3_600_000)).toISOString();
    }
    if (body.quiet !== undefined) patch.quiet = body.quiet === 'hold' ? 'hold' : 'pause';
    this.#set(id, patch);
    this.#emit(id);
    return { loop: this.get(id)! };
  }

  /** DELETE: a draft or an ended one. */
  remove(id: number): boolean {
    const l = this.get(id);
    if (!l || !(l.state === 'draft' || FINAL_LOOP.includes(l.state))) return false;
    this.#db.prepare('DELETE FROM loop_ticks WHERE loop_id = ?').run(id);
    this.#db.prepare('DELETE FROM chat_loops WHERE id = ?').run(id);
    this.#app.events?.publish({ type: 'loop', conversationId: l.conversationId, loop: null });
    return true;
  }

  /** Start-up: active loops come back paused (restart), next tick cleared, one line each. */
  startupSweep(): number {
    const rows = (this.#db.prepare("SELECT * FROM chat_loops WHERE state IN ('active','ticking')").all() as Row[]).map(toLoop);
    const now = this.#app.now();
    // Phase 121 (BEGIN §4.5.3): a routine loop stays on across a restart: the next slot, missed
    // slots skipped (one row), never run as a backlog. A typed /loop still comes back paused.
    for (const l of rows.filter((x) => x.routineId !== null)) {
      const missed = l.state === 'ticking' || !l.nextAt || Date.parse(l.nextAt) <= now.getTime();
      if (missed) this.#skip(l, 'restart');
      this.#set(l.id, { state: 'active', ...(l.state === 'ticking' ? { ticks: Math.max(0, l.ticks - 1) } : {}), next_at: missed ? this.#nextSlot({ ...l, nextAt: null }, now) : l.nextAt });
    }
    for (const l of rows.filter((x) => x.routineId === null)) {
      this.#set(l.id, { state: 'paused', reason: 'restart', next_at: null, meta: JSON.stringify({ ...l.meta, pausedAt: this.#app.now().toISOString() }) });
      this.#dropQueued(l);
      this.#line(l, trOwner(LOOP_LINES.restart, this.#app.settings.get(), { prompt: oneLine(l.prompt, 80).replace(/[.!?…]+$/u, '') }), false);
    }
    return rows.filter((x) => x.routineId === null).length;
  }

  /** A crisis line from the owner in a chat pauses its loops for 48 hours (like her plans). */
  crisisPause(conversationId: string): void {
    const until = new Date(this.#app.now().getTime() + CRISIS_HOURS * 3_600_000).toISOString();
    let n = 0;
    for (const l of this.standing(conversationId)) {
      if (l.state === 'paused' && l.reason === 'crisis') continue;
      this.#dropQueued(l);
      this.#set(l.id, { state: 'paused', reason: 'crisis', meta: JSON.stringify({ ...l.meta, until }) });
      this.#emit(l.id);
      n++;
    }
    if (n) {
      const l = this.standing(conversationId)[0];
      if (l) this.#line(l, trOwner(LOOP_LINES.crisis, this.#app.settings.get()), false);
    }
  }
  /** `/reset`: every loop in the chat pauses. Returns how many. */
  pauseAll(conversationId: string): number {
    let n = 0;
    for (const l of this.standing(conversationId)) if (l.state !== 'paused') {
      this.pause(l.id, 'owner');
      n++;
    }
    return n;
  }

  /** Hourly: ended loops and their ticks after 30 days. */
  prune(): number {
    const cutoff = new Date(this.#app.now().getTime() - KEEP_DAYS * 86_400_000).toISOString();
    const ids = (this.#db.prepare("SELECT id FROM chat_loops WHERE state IN ('done','ended','stopped') AND updated_at < ?").all(cutoff) as Row[]).map((r) => Number(r.id));
    for (const id of ids) {
      this.#db.prepare('DELETE FROM loop_ticks WHERE loop_id = ?').run(id);
      this.#db.prepare('DELETE FROM chat_loops WHERE id = ?').run(id);
    }
    return ids.length;
  }
  forget(conversationId: string): void {
    for (const r of this.#db.prepare('SELECT id FROM chat_loops WHERE conversation_id = ?').all(conversationId) as Row[]) this.#db.prepare('DELETE FROM loop_ticks WHERE loop_id = ?').run(Number(r.id));
    this.#db.prepare('DELETE FROM chat_loops WHERE conversation_id = ?').run(conversationId);
  }

  /** `/loop list`: one line per loop. */
  listLines(conversationId: string): string[] {
    const tz = this.#app.settings.get().timeZone;
    return this.forConversation(conversationId).filter((l) => !FINAL_LOOP.includes(l.state)).map((l, i) => {
      const next = l.nextAt ? hhmm(new Date(l.nextAt), tz) : '–';
      return `🔁 ${i + 1} · ${fmtEvery(l.everyMin)} · ${oneLine(l.prompt, 40)} · ${l.state === 'paused' ? `paused (${l.reason})` : `next ${next}`} · ${l.ticks} of ${l.maxTicks}${l.lastLine ? ` · last: ${oneLine(l.lastLine, 40)}` : ''}`;
    });
  }

  // ------------------------------------------------------------------ the clock (P4)

  /** Called from ReminderScheduler.tick() (the same 15 s clock and guard). Returns ticks queued. */
  due(now: Date = this.#app.now()): number {
    const app = this.#app;
    const set = persistSettings(app).loops;
    const quiet = quietNow(app, now);
    let queued = 0;
    // Held pings (quiet: hold) go out as one line once quiet hours end.
    if (!quiet) for (const l of this.all().filter((x) => x.held.length)) this.#releaseHeld(l);
    // Paused for the day's cap: back the next local day while the end time is ahead; crisis after 48 h.
    for (const l of this.all().filter((x) => x.state === 'paused')) {
      if (l.reason === 'cap:day' && l.meta.capDay && l.meta.capDay !== this.ledger.day() && Date.parse(l.endsAt) > now.getTime()) {
        this.#set(l.id, { state: 'active', reason: null, next_at: now.toISOString() });
        this.#emit(l.id);
      } else if (l.reason === 'crisis' && l.meta.until && Date.parse(l.meta.until) <= now.getTime() && Date.parse(l.endsAt) > now.getTime()) {
        this.#set(l.id, { state: 'active', reason: null, next_at: now.toISOString() });
        this.#emit(l.id);
      }
    }
    // Phase 121: routine loops pause in private local mode (they read the web or the mailbox), and
    // post one "ends on …" line a week before their end.
    for (const l of this.all().filter((x) => x.routineId !== null && x.state === 'active')) {
      if (privateLocalOn()) {
        this.pause(l.id, 'private-local');
        continue;
      }
      if (!l.meta.endsNoted && Date.parse(l.endsAt) - now.getTime() <= 7 * 86_400_000) {
        this.#set(l.id, { meta: JSON.stringify({ ...l.meta, endsNoted: true }) });
        this.#line(l, trOwner(LOOP_LINES.endsSoon, app.settings.get(), { date: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', ...(app.settings.get().timeZone ? { timeZone: app.settings.get().timeZone } : {}) }).format(new Date(l.endsAt)) }), true, { endsSoon: true, routine: l.routineId });
      }
    }
    const rows = (this.#db.prepare("SELECT * FROM chat_loops WHERE state IN ('active','ticking') AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at").all(now.toISOString()) as Row[]).map(toLoop);
    for (const l of rows) {
      // In code and in this order (§3.1 P4): active; before ends_at; ticks left; quiet; caps.
      if (now.getTime() >= Date.parse(l.endsAt) || l.ticks >= l.maxTicks) {
        if (l.state === 'ticking') continue;
        this.#end(l);
        continue;
      }
      const next = this.#nextSlot(l, now);
      if (l.state === 'ticking') {
        this.#skip(l, 'still running');
        this.#set(l.id, { next_at: next });
        continue;
      }
      if (quiet && l.quiet === 'pause' && l.routineId !== null) {
        // A routine's slot in quiet hours is skipped to its next slot (no catch-up in the morning).
        this.#skip(l, 'quiet');
        this.#set(l.id, { next_at: next });
        this.#emit(l.id);
        continue;
      }
      if (quiet && l.quiet === 'pause') {
        const night = localDate(new Date(now.getTime() - 12 * 3_600_000), app.settings.get().timeZone);
        if (l.meta.quietLogged !== night) this.#skip(l, 'quiet');
        this.#set(l.id, { next_at: this.#quietEnd(now), meta: JSON.stringify({ ...l.meta, quietLogged: night, missed: true }) });
        this.#emit(l.id);
        continue;
      }
      const usedAll = this.ledger.get('loops');
      // The last tick's spend is the projection; a fresh day always allows its first tick.
      const lastSpend = this.ledger.get(`loop:${l.id}`).tokens > 0 ? (l.meta.last ?? l.tickBudget.tokens) : 0;
      if (!this.ledger.fits(`loop:${l.id}`, { tokens: l.dayTokens }, { tokens: lastSpend }) || !this.ledger.fits('loops', { tokens: set.dailyTokens }, { tokens: lastSpend }) || (set.dailyUsd > 0 && usedAll.usd >= set.dailyUsd)) {
        this.#skip(l, 'cap');
        this.#set(l.id, { state: 'paused', reason: 'cap:day', meta: JSON.stringify({ ...l.meta, capDay: this.ledger.day() }) });
        this.#line(l, trOwner(LOOP_LINES.capDay, app.settings.get()), true);
        this.#emit(l.id);
        continue;
      }
      this.#set(l.id, { next_at: next, meta: JSON.stringify({ ...l.meta, missed: false }) });
      this.#tick(this.get(l.id)!, now);
      queued++;
    }
    return queued;
  }

  /** The next slot after now (missed slots are not made up). */
  #nextSlot(l: Loop, now: Date): string {
    if (l.schedule) return nextScheduled(l.schedule, now, this.#app.settings.get().timeZone).toISOString();
    const step = l.everyMin * 60_000;
    const base = l.nextAt ? Date.parse(l.nextAt) : now.getTime();
    let t = base + step;
    if (t <= now.getTime()) t = base + Math.ceil((now.getTime() - base + 1) / step) * step;
    return new Date(t).toISOString();
  }
  /** When quiet hours end (the next local quietEnd:00). */
  #quietEnd(now: Date): string {
    const p = proactiveSettings(this.#app);
    return atLocal(`${p.quietEnd}:00`, now, this.#app.settings.get().timeZone).toISOString();
  }

  /** Queues one tick as an owner input (it waits behind a turn he started; never stacked). */
  #tick(l: Loop, now: Date): void {
    const app = this.#app;
    const n = l.ticks + 1;
    this.#set(l.id, { state: 'ticking', ticks: n, last_at: now.toISOString() });
    const label = `🔁 ${hhmm(now, app.settings.get().timeZone)} · ${oneLine(l.prompt, 80)}`;
    const pend = pendingFor(app);
    const r = pend.add(l.conversationId, { kind: 'queue', content: label, sender: 'owner', meta: { loop: { id: l.id, tick: n }, source: l.meta.source ?? 'web' } }, (item) => this.#runTick(l.id, n, item, label), { queueMax: 50 });
    if (!r.ok) {
      this.#set(l.id, { state: 'active', ticks: n - 1 });
      this.#skip(l, 'busy');
      return;
    }
    this.#emit(l.id);
    pend.drain(l.conversationId);
  }

  async #runTick(id: number, n: number, _item: PendingItem, label: string): Promise<void> {
    const app = this.#app;
    const l = this.get(id);
    if (!l || l.state !== 'ticking') return;
    const s = app.settings.get();
    const tz = s.timeZone;
    const hasOwnerMsg = app.store.messages(l.conversationId).some((m) => m.role === 'user');
    const tickMsg = app.store.addMessage(l.conversationId, 'notice', `loop:${label}`, { loop: { id, tick: n } });
    const owner = ownerWord(app);
    const end = l.routineId !== null ? new Date(l.endsAt).toISOString().slice(0, 10) : hhmm(new Date(l.endsAt), tz);
    const note = `[Note from the app, not from ${owner}: this is a repeat ${owner} set in this chat (${fmtEvery(l.everyMin)}, until ${end}). Do this now: "${l.prompt}".${l.untilText ? ` The repeat ends when this is true: "${l.untilText}".` : ''}${l.lastLine ? ` Last time (at ${l.lastAt ? hhmm(new Date(l.lastAt), tz) : '?'}) you found: "${oneLine(l.lastLine, 300)}".` : ''}\nUse your tools to look at the real state now; don't guess from earlier messages.\nEnd your reply with one line, exactly one of: [[loop: same]] [[loop: changed]] [[loop: met]].]`;
    const persist: PersistTurn = { kind: 'loop', id, n, note, unattended: trOwner(LOOP_LINES.unattended, s, { owner }), ...(l.meta.allowOnce?.length ? { allowOnce: l.meta.allowOnce } : {}) };
    if (l.meta.allowOnce?.length) this.#set(id, { meta: JSON.stringify({ ...l.meta, allowOnce: [] }) });
    const lastOwner = app.store.messages(l.conversationId).filter((m) => m.role === 'user').at(-1)?.content ?? l.prompt;
    const out = await runPersistTurn(app, l.conversationId, hasOwnerMsg ? lastOwner : l.prompt, { ...(hasOwnerMsg ? { resume: true } : {}), persist, budget: { tokens: l.tickBudget.tokens, steps: l.tickBudget.steps } });
    const cur = this.get(id);
    if (!cur) return;
    if (out.tokens || out.usd) {
      this.ledger.add(`loop:${id}`, { tokens: out.tokens, usd: out.usd, runs: 1 });
      this.ledger.add('loops', { tokens: out.tokens, usd: out.usd, runs: 1 });
    }
    this.#set(id, { meta: JSON.stringify({ ...cur.meta, last: out.tokens || cur.meta.last }) });
    if (out.status === 'busy') {
      this.#record(cur, 0, 'skipped', 'busy', out, null);
      this.#set(id, { state: 'active', ticks: n - 1 });
      return void this.#emit(id);
    }
    if (cur.state !== 'ticking') {
      // Paused or stopped meanwhile.
      this.#record(cur, n, 'failed', 'stopped', out, null);
      return void this.#emit(id);
    }
    if (out.status === 'stopped') {
      // /stop or Stop on the tick: this tick ends; the loop stays and the next one runs on time.
      this.#record(cur, n, 'failed', 'stopped', out, null);
      this.#set(id, { state: 'active' });
      return void this.#emit(id);
    }
    if (out.minors) {
      this.#record(cur, n, 'failed', 'safety', out, null);
      this.#set(id, { state: 'stopped', reason: 'safety', ended_at: app.now().toISOString(), next_at: null });
      this.#line(cur, trOwner(LOOP_LINES.safety, s), true);
      return void this.#emit(id);
    }
    if (out.crisis) {
      this.#record(cur, n, 'failed', 'crisis', out, null);
      this.#set(id, { state: 'active' });
      this.crisisPause(l.conversationId);
      return;
    }
    if (out.unattended) {
      this.#record(cur, n, 'failed', `approval: ${out.unattended.name}`, out, out.replyId || null);
      this.#set(id, { state: 'paused', reason: 'approval', meta: JSON.stringify({ ...this.get(id)!.meta, ask: out.unattended, pausedAt: app.now().toISOString() }) });
      this.#line(cur, trOwner(LOOP_LINES.approval, s, { summary: oneLine(out.unattended.summary, 120) }), true, { ask: out.unattended });
      return void this.#emit(id);
    }
    // The reply's tag, read and stripped before it is shown (§5.4).
    const reply = out.replyId ? app.store.messageById(out.replyId) : undefined;
    let tag = 'changed' as 'same' | 'changed' | 'met';
    let text = reply?.content ?? '';
    const tm = /\[\[\s*loop\s*:\s*(same|changed|met)\s*\]\]\s*$/i.exec(text);
    if (tm) {
      tag = tm[1].toLowerCase() as typeof tag;
      text = text.slice(0, tm.index).trimEnd();
      if (reply) app.store.updateMessageContent(reply.id, text);
    }
    text = text.replace(/\[\[\s*loop\s*:[^\]]*\]\]/gi, '').trim();
    const failed = out.status === 'error' || out.budgetHit || out.guardPaused;
    // An until command is a P2 check run by the app (red is not a failure: it's what we wait for).
    let check: CheckResult | undefined;
    if (!failed && cur.untilCheck) {
      const conv = app.store.getConversation(l.conversationId);
      try {
        check = conv ? await runCommandCheck(app, wsOf(app, conv), 'command', cur.untilCheck.command, new AbortController().signal, persistSettings(app).goals.checkMinutes * 60_000) : undefined;
      } catch (err) {
        check = { kind: 'command', ok: false, exitCode: null, timedOut: false, key: 'check|error', quote: (err as Error).message, tail: '', ms: 0, broken: (err as Error).message };
      }
    }
    if (failed || check?.broken) {
      const fc = cur.failCount + 1;
      const why = check?.broken ?? (out.budgetHit ? en('It reached its budget.') : out.guardPaused ? en('She kept trying the same failing step.') : oneLine(out.error ?? 'error', 200));
      this.#record(cur, n, 'failed', why, out, out.replyId || null);
      if (reply) app.store.updateMessageMeta(reply.id, { loop: { id, tick: n, outcome: 'failed' } });
      if (fc >= persistSettings(app).loops.failAfter) {
        this.#set(id, { state: 'stopped', reason: 'failed', fail_count: fc, ended_at: app.now().toISOString(), next_at: null });
        this.#line(cur, trOwner(LOOP_LINES.failed, s, { n: fc, error: why }), true);
      } else this.#set(id, { state: 'active', fail_count: fc });
      return void this.#endIfDone(id);
    }
    // P5: proof and fingerprints, in code.
    const fp = createHash('sha256').update(`${normalizeMessage(text)}\n${out.failKeys.join('\n')}`).digest('hex').slice(0, 16);
    let outcome: 'same' | 'changed' | 'met' = tag;
    if (cur.untilCheck) outcome = check?.ok ? 'met' : tag === 'met' ? 'changed' : tag;
    else if (outcome === 'met' && (out.toolsOk === 0 || out.claims > 0)) outcome = 'changed';
    if (outcome === 'changed' && cur.lastFingerprint === fp) outcome = 'same';
    const sameRun = outcome === 'same' && cur.lastFingerprint === fp ? cur.sameCount + 1 : outcome === 'same' ? 1 : 0;
    this.#set(id, { last_fingerprint: fp, last_line: oneLine(app.redactor.redact(text), 300), fail_count: 0, same_count: sameRun, state: 'active' });
    this.#record(cur, n, outcome, null, out, out.replyId || null);
    if (reply) app.store.updateMessageMeta(reply.id, { loop: { id, tick: n, outcome, tickMessageId: tickMsg.id }, ...(outcome === 'same' ? { folded: true } : { background: true }) });
    if (outcome !== 'same' && reply && text) {
      const msg = { id: reply.id, role: reply.role, content: text, createdAt: reply.createdAt, meta: { ...(reply.meta ?? {}), loop: { id, tick: n, outcome } } };
      if (cur.quiet === 'hold' && quietNow(app)) this.#set(id, { held: JSON.stringify([...this.get(id)!.held, reply.id]) });
      else {
        app.events?.publish({ type: 'message', conversationId: l.conversationId, message: msg, reason: 'reply' });
        void app.push?.notifyOwner(identityOf(app.persona).name, oneLine(text, 200), l.conversationId, `loop-${id}`).catch(() => {});
      }
    }
    if (outcome === 'met') {
      this.#set(id, { state: 'done', ended_at: app.now().toISOString(), next_at: null });
      this.#line(cur, trOwner(LOOP_LINES.met, s, { condition: cur.untilText ?? cur.prompt }), !(cur.quiet === 'hold' && quietNow(app)));
      return void this.#emit(id);
    }
    if (cur.untilText && sameRun >= persistSettings(app).loops.stuckAfter) {
      this.#set(id, { state: 'stopped', reason: 'no-progress', ended_at: app.now().toISOString(), next_at: null });
      this.#line(cur, trOwner(LOOP_LINES.noProgress, s, { n: sameRun }), true);
      return void this.#emit(id);
    }
    this.#endIfDone(id);
  }

  #endIfDone(id: number): void {
    const l = this.get(id);
    if (!l) return;
    if (l.state === 'active' && (l.ticks >= l.maxTicks || this.#app.now().getTime() >= Date.parse(l.endsAt))) this.#end(l);
    else this.#emit(id);
  }
  #end(l: Loop): void {
    this.#set(l.id, { state: 'ended', ended_at: this.#app.now().toISOString(), next_at: null });
    this.#line(l, trOwner(LOOP_LINES.ended, this.#app.settings.get(), { prompt: oneLine(l.prompt, 80) }), true);
    this.#emit(l.id);
  }
  #releaseHeld(l: Loop): void {
    const app = this.#app;
    const msgs = l.held.map((id) => app.store.messageById(id)).filter((m): m is NonNullable<typeof m> => Boolean(m));
    this.#set(l.id, { held: null });
    if (!msgs.length) return;
    const text = trOwner(LOOP_LINES.slept, app.settings.get(), { text: msgs.map((m) => oneLine(m.content, 160)).join(' · ') });
    void app.push?.notifyOwner(identityOf(app.persona).name, text, l.conversationId, `loop-${l.id}`).catch(() => {});
    this.#line(l, text, true);
  }

  #skip(l: Loop, why: string): void {
    this.#db.prepare('INSERT INTO loop_ticks (loop_id, n, outcome, why, at) VALUES (?, 0, ?, ?, ?)').run(l.id, 'skipped', why, this.#app.now().toISOString());
  }
  #record(l: Loop, n: number, outcome: TickOutcome, why: string | null, out: { runId: number; tokens: number; usd: number }, messageId: number | null): void {
    this.#db.prepare('INSERT INTO loop_ticks (loop_id, n, run_id, message_id, outcome, why, tokens, usd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(l.id, n, out.runId || null, messageId, outcome, why, out.tokens, out.usd, this.#app.now().toISOString());
  }
  #dropQueued(l: Loop): void {
    const pend = pendingFor(this.#app);
    for (const it of pend.list(l.conversationId)) if ((it.meta.loop as { id?: number } | undefined)?.id === l.id) pend.cancel(l.conversationId, it.id);
  }
  /** One line in the chat (and the chat app when `publish`), the app's words, never a model call. */
  #line(l: Loop, text: string, publish: boolean, extra: Record<string, unknown> = {}): void {
    const app = this.#app;
    const msg = app.store.addMessage(l.conversationId, 'assistant', text, { loop: { id: l.id, end: true, ...extra }, app: true, background: true });
    if (publish) app.events?.publish({ type: 'message', conversationId: l.conversationId, message: { id: msg.id, role: msg.role, content: msg.content, createdAt: msg.createdAt, meta: msg.meta }, reason: 'job' });
  }
  #set(id: number, patch: Record<string, unknown>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.#db.prepare(`UPDATE chat_loops SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...(Object.values(patch) as (string | number | null)[]), this.#app.now().toISOString(), id);
  }
  #emit(id: number): void {
    const l = this.get(id);
    if (!l) return;
    try {
      this.#app.events?.publish({ type: 'loop', conversationId: l.conversationId, loop: this.view(l) });
    } catch {
      /* best effort */
    }
  }
}

export const fmtEvery = (m: number): string => (m >= 60 && m % 60 === 0 ? `every ${m / 60}h` : `every ${m < 1 ? `${Math.round(m * 60)}s` : `${m}m`}`);
const hhmm = (d: Date, tz?: string): string => {
  const p = zonedParts(d, tz);
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
};

/** This companion's loops (made on first use). */
export function loopsFor(app: AppContext): Loops {
  app.loops ??= new Loops(app);
  return app.loops;
}
