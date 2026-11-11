// Phase 116 (BR2 B5, docs/design/BRIDGES2.md §5.3): what arrives while she works. One store and one
// queue per conversation for the web app, Telegram, Discord and plugin bridges.
//
// - A *steer* waits for the turn's next safe point (between steps, src/chat.ts takes it there with
//   `takeSteers`) and is stored as a user message only then. If the turn ends first, it becomes the
//   first queued turn ('moved').
// - An *interrupt* is a steer marked `meta.now`: the running turn is told at once (`attach`) and
//   stops the model call it is in (what she wrote stays, marked interrupted), cancels a read-only
//   tool in progress, and never kills a tool that changes things: she stops right after it returns.
//   An approval card keeps waiting: a steer never answers one.
// - A *queued* message runs as its own turn after the current one. It is NOT written to the
//   conversation until its turn starts: the turn rebuilds its history from the store at every step,
//   so a queued message stored early would quietly act as a steer.
// - Rows live in the conversation's own `store.db` (every companion and member), so the app can show
//   them and a restart doesn't lose them silently: at start-up waiting rows become 'stale' and
//   nothing runs by itself (no surprise spend). The runners are closures and die with the process.
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { en } from './i18n.ts';

/** What the sender is told (translated where it is shown; `{n}`, `{max}`, `{text}` filled in). */
export const PENDING_LINES = {
  queued: en("I'll do this next ({n} waiting)."),
  full: en("I already have {max} waiting here. I'll take more when I've done some."),
  steered: en("Got it, I'll use that at the next step."),
  interrupting: en('Got it, stopping to read that now.'),
  steers: en("That's enough notes for this step. I'll read them before the next one."),
  moved: en("She'd already finished; she'll answer your note now."),
  restarted: en('I restarted before I got to your message: "{text}". Send it again if you still want it.'),
} as const;

export type PendingKind = 'steer' | 'queue';
/** What a message sent while she works does: wait for the next step, wait its turn, or cut in now. */
export type BusyMode = 'steer' | 'queue' | 'interrupt';
/** What the running turn is doing right now (the Interrupt pill says what she waits for). */
export interface TurnPhase {
  kind: 'model' | 'tool' | 'approval';
  /** The tool running (kind 'tool'). */
  tool?: string;
  /** Its short line ("npm run build"). */
  summary?: string;
  /** A command the owner may stop (the run's own cancel kills the process). */
  stoppable?: boolean;
}
/** The running turn's side of an interrupt (src/chat.ts). */
export interface TurnHooks {
  /** Stop the model call / read-only tool in progress and take the waiting notes next. */
  interrupt: () => void;
  /** Stop the command in progress (only commands); false when none runs. */
  stopTool: () => boolean;
}

/**
 * Tools an interrupt may cancel mid-way: they only read, search, look or fetch, so stopping them
 * changes nothing. Everything else (writes, edits, commands, sends, payments, computer actions)
 * finishes first. A tool can say so itself (`interruptible`).
 */
const READ_ONLY_INTERRUPTIBLE: ReadonlySet<string> = new Set([
  'list_dir', 'read_file', 'search', 'code_map', 'code_find', 'code_refs', 'code_deps', 'recall', 'search_library', 'library', 'search_memory', 'list_facts', 'list_notes', 'list_tasks', 'list_recent_conversations', 'read_note', 'get_today', 'settings_guide', 'web_search', 'web_fetch', 'job_status', 'recipe_find', 'gmail_search', 'gmail_read', 'gmail_thread', 'gmail_needs_answer', 'mail_search', 'mail_read', 'mail_thread', 'mail_needs_answer', 'mail_accounts', 'mail_folders', 'calendar_events', 'home_status', 'github_list', 'github_read', 'ssh_servers', 'browser_read', 'browser_screenshot', 'find_tools', 'skill_read', 'moments', 'scrapbook',
]);
export function interruptible(name: string, tool?: { interruptible?: boolean }): boolean {
  return tool?.interruptible === true || READ_ONLY_INTERRUPTIBLE.has(name);
}
export type PendingState = 'waiting' | 'taken' | 'moved' | 'dropped' | 'stale';
export type PendingSender = 'owner' | 'member' | 'person';

export interface PendingMeta {
  images?: string[];
  docs?: unknown[];
  othersPhotos?: string[];
  /** 'web' | 'telegram' | 'discord' | 'plugin-<x>' */
  source?: string;
  /** Bridges: where to answer (chat id, place, language, message id). */
  where?: Record<string, unknown>;
  /** The owner was told about it after a restart. */
  told?: boolean;
  [k: string]: unknown;
}

export interface PendingItem {
  id: string;
  conversationId: string;
  kind: PendingKind;
  content: string;
  meta: PendingMeta;
  sender: PendingSender;
  state: PendingState;
  messageId: number | null;
  createdAt: string;
  takenAt: string | null;
}

/** Runs one waiting item as its own turn (the bridge's #turn closure, or the web app's background runner). */
export type Runner = (item: PendingItem) => Promise<void>;

export const PENDING_TEXT_MAX = 4000;
export const STEERS_PER_TURN = 5;
export const QUEUE_MAX_DEFAULT = 5;
export const QUEUE_MAX_CHOICES = [3, 5, 10] as const;
export const BTW_CAP_CHOICES = [20, 60, 200] as const;
export const BTW_CAP_DEFAULT = 60;
const KEEP_DONE_MS = 7 * 24 * 3600_000;

/** Settings → Chats → While she's working (owner settings; members use the owner's). */
export interface WhileBusySettings {
  whileBusy: BusyMode;
  queueMax: number;
  btw: { model: 'local' | 'quick'; dailyCap: number };
}
export function whileBusySettings(app: AppContext): WhileBusySettings {
  const c = ((app.settings.get() as { chats?: { whileBusy?: unknown; queueMax?: unknown; btw?: { model?: unknown; dailyCap?: unknown } } }).chats ?? {}) as { whileBusy?: unknown; queueMax?: unknown; btw?: { model?: unknown; dailyCap?: unknown } };
  const q = Number(c.queueMax);
  const cap = Number(c.btw?.dailyCap);
  return {
    // New installs: at the next step (the turn keeps its rhythm); the owner may pick 'interrupt'.
    whileBusy: c.whileBusy === 'queue' ? 'queue' : c.whileBusy === 'interrupt' ? 'interrupt' : 'steer',
    queueMax: Number.isFinite(q) && q >= 1 ? Math.min(20, Math.round(q)) : QUEUE_MAX_DEFAULT,
    btw: { model: c.btw?.model === 'local' ? 'local' : 'quick', dailyCap: Number.isFinite(cap) && cap >= 1 ? Math.min(1000, Math.round(cap)) : BTW_CAP_DEFAULT },
  };
}

export type AddResult = { ok: true; item: PendingItem; waiting: number } | { ok: false; reason: 'full' | 'steers' | 'empty' };

interface Row {
  id: string;
  conversation_id: string;
  kind: string;
  content: string;
  meta: string;
  sender: string;
  state: string;
  message_id: number | null;
  created_at: string;
  taken_at: string | null;
}

const toItem = (r: Row): PendingItem => {
  let meta: PendingMeta = {};
  try {
    meta = JSON.parse(r.meta) as PendingMeta;
  } catch {
    /* a damaged row keeps its text */
  }
  return { id: r.id, conversationId: r.conversation_id, kind: r.kind === 'steer' ? 'steer' : 'queue', content: r.content, meta, sender: r.sender === 'person' ? 'person' : r.sender === 'member' ? 'member' : 'owner', state: r.state as PendingState, messageId: r.message_id, createdAt: r.created_at, takenAt: r.taken_at };
};

export class PendingInputs {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  /** Item id → the closure that runs it (dies with the process). */
  readonly #runners = new Map<string, Runner>();
  /** Conversations with a runner of ours in progress (its turn and its reply delivery). */
  readonly #running = new Map<string, Promise<void>>();
  /** Conversations with a turn between its start and its end (runTurn). */
  readonly #live = new Map<string, number>();
  /** Conversation → its running turn's interrupt hooks (one turn per conversation runs at a time). */
  readonly #hooks = new Map<string, TurnHooks>();
  /** Conversation → what its running turn is doing (model call, tool, approval card). */
  readonly #phase = new Map<string, TurnPhase>();
  /** Hub events (`{type:'pending', …}`); unset for off-the-record conversations. */
  publish?: (ev: { type: 'pending'; conversationId: string; item: PendingItem | null; line?: string }) => void;
  /** The server's own busy test (its `active` map), so a queued turn never meets the 409. */
  externalBusy?: (conversationId: string) => boolean;
  /** The web app's runner for items without one of their own (web steers that moved, stale ones sent). */
  defaultRunner?: (conversationId: string) => Runner | undefined;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS pending_inputs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      sender TEXT NOT NULL,
      state TEXT NOT NULL,
      message_id INTEGER,
      created_at TEXT NOT NULL,
      taken_at TEXT
    );
    CREATE INDEX IF NOT EXISTS pending_inputs_conv ON pending_inputs(conversation_id, state, created_at);`);
  }

  // ------------------------------------------------------------------ turn life

  /** runTurn started a turn here (steers wait for its safe points). */
  turnStarted(conversationId: string): void {
    this.#live.set(conversationId, (this.#live.get(conversationId) ?? 0) + 1);
  }

  /** The turn ended: steers it didn't take become the first queued turn ('moved'); the next one starts. */
  turnEnded(conversationId: string): void {
    const n = (this.#live.get(conversationId) ?? 1) - 1;
    if (n > 0) this.#live.set(conversationId, n);
    else this.#live.delete(conversationId);
    for (const it of this.#rows(conversationId, ['waiting']).filter((x) => x.kind === 'steer')) {
      this.#set(it.id, { state: 'moved' });
      this.#emit(conversationId, { ...it, state: 'moved' }, 'moved');
    }
    this.drain(conversationId);
  }

  /** A turn is running in this conversation right now. */
  live(conversationId: string): boolean {
    return this.#live.has(conversationId) || Boolean(this.externalBusy?.(conversationId));
  }

  /** Busy for a new message: a turn runs, a runner of ours is still delivering, or items wait. */
  busy(conversationId: string): boolean {
    return this.live(conversationId) || this.#running.has(conversationId) || this.#rows(conversationId, ['waiting', 'moved']).some((x) => x.kind === 'queue' || x.state === 'moved');
  }

  /**
   * Runs `runner` now when nothing else runs here, else queues it behind (a turn started by a
   * bridge goes through here so the next message waits for its reply to be delivered).
   * Resolves when this runner has finished.
   */
  async run(conversationId: string, runner: () => Promise<void>): Promise<void> {
    const prev = this.#running.get(conversationId);
    if (prev) await prev.catch(() => undefined);
    const p = runner().finally(() => {
      if (this.#running.get(conversationId) === p) this.#running.delete(conversationId);
      this.drain(conversationId);
    });
    this.#running.set(conversationId, p);
    return p;
  }

  // ------------------------------------------------------------------ adding

  /**
   * A message that arrived while she works. Steers wait for the safe point (or, with no turn
   * running, become the next turn at once: 'moved'); queued ones wait their turn.
   */
  add(conversationId: string, input: { kind: PendingKind | BusyMode; content: string; meta?: PendingMeta; sender: PendingSender }, runner?: Runner, caps: { queueMax?: number } = {}): AddResult {
    const content = input.content.trim().slice(0, PENDING_TEXT_MAX);
    if (!content && !input.meta?.images?.length) return { ok: false, reason: 'empty' };
    // Partners always queue (they have no tools: steering means nothing there, and they never cut in).
    const kind: PendingKind = input.sender === 'person' ? 'queue' : input.kind === 'queue' ? 'queue' : 'steer';
    const now = kind === 'steer' && input.kind === 'interrupt';
    if (now) input = { ...input, meta: { ...(input.meta ?? {}), now: true } };
    const waiting = this.#rows(conversationId, ['waiting', 'moved']);
    const queueMax = caps.queueMax ?? QUEUE_MAX_DEFAULT;
    if (kind === 'queue' && waiting.filter((x) => x.kind === 'queue' || x.state === 'moved').length >= queueMax) return { ok: false, reason: 'full' };
    if (kind === 'steer' && waiting.filter((x) => x.kind === 'steer').length >= STEERS_PER_TURN) return { ok: false, reason: 'steers' };
    const at0 = this.#now();
    // Rows keep their arrival order (rowid) even when two arrive in the same millisecond.
    const createdAt = at0.toISOString();
    const id = `p-${randomBytes(6).toString('hex')}`;
    const state: PendingState = kind === 'steer' && !this.live(conversationId) ? 'moved' : 'waiting';
    this.#db.prepare('INSERT INTO pending_inputs (id, conversation_id, kind, content, meta, sender, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, conversationId, kind, content, JSON.stringify(input.meta ?? {}), input.sender, state, createdAt);
    if (runner) this.#runners.set(id, runner);
    const item = this.get(id)!;
    this.#emit(conversationId, item, state === 'moved' ? 'moved' : undefined);
    if (state === 'moved') this.drain(conversationId);
    else if (now) this.#cut(conversationId);
    return { ok: true, item, waiting: this.#rows(conversationId, ['waiting', 'moved']).filter((x) => x.kind === 'queue' || x.state === 'moved').length };
  }

  // ------------------------------------------------------------------ the safe point

  /** Called by the turn loop between steps: the waiting steers, in order, marked taken. */
  takeSteers(conversationId: string): PendingItem[] {
    const out = this.#rows(conversationId, ['waiting']).filter((x) => x.kind === 'steer');
    const at = this.#now().toISOString();
    for (const it of out) {
      this.#set(it.id, { state: 'taken', taken_at: at });
      this.#runners.delete(it.id);
      this.#emit(conversationId, { ...it, state: 'taken', takenAt: at });
    }
    return out.map((it) => ({ ...it, state: 'taken', takenAt: at }));
  }

  /** The user message an item became. */
  stored(id: string, messageId: number): void {
    this.#db.prepare('UPDATE pending_inputs SET message_id = ? WHERE id = ?').run(messageId, id);
  }

  // ------------------------------------------------------------------ interrupt now

  /** The running turn hands over its interrupt hooks; returns the detach. */
  attach(conversationId: string, hooks: TurnHooks): () => void {
    this.#hooks.set(conversationId, hooks);
    // A note marked now that arrived before the turn could listen still cuts in.
    if (this.interrupting(conversationId)) hooks.interrupt();
    return () => {
      if (this.#hooks.get(conversationId) === hooks) this.#hooks.delete(conversationId);
      this.#phase.delete(conversationId);
    };
  }

  /** The turn says what it is doing (undefined = between steps). */
  setPhase(conversationId: string, phase: TurnPhase | undefined): void {
    const was = this.#phase.get(conversationId);
    if (phase) this.#phase.set(conversationId, phase);
    else this.#phase.delete(conversationId);
    // The pill follows ("Waiting for the command…") only while something is interrupting.
    if (this.interrupting(conversationId) && JSON.stringify(was) !== JSON.stringify(phase)) this.#emit(conversationId, null, 'phase');
  }
  phase(conversationId: string): TurnPhase | undefined {
    return this.#phase.get(conversationId);
  }

  /** A note marked now waits here (the turn is stopping to read it). */
  interrupting(conversationId: string): boolean {
    return this.#rows(conversationId, ['waiting']).some((x) => x.kind === 'steer' && x.meta.now === true);
  }

  /**
   * *Interrupt now* on a pill: a waiting note (a steer, or a queued one: it becomes a steer) is
   * marked now and the running turn is told. Undefined when it no longer waits or isn't one of
   * the sender's own (partners never cut in).
   */
  interrupt(conversationId: string, id: string): PendingItem | undefined {
    const it = this.get(id);
    if (!it || it.conversationId !== conversationId || it.state !== 'waiting' || it.sender === 'person') return undefined;
    if (!this.live(conversationId)) return this.promote(conversationId, id);
    this.#db.prepare('UPDATE pending_inputs SET kind = ?, meta = ? WHERE id = ?').run('steer', JSON.stringify({ ...it.meta, now: true }), id);
    const item = this.get(id)!;
    this.#emit(conversationId, item);
    this.#cut(conversationId);
    return item;
  }

  /** *Stop the command*: the command in progress is stopped by its own cancel (true when one was). */
  stopTool(conversationId: string): boolean {
    return this.#phase.get(conversationId)?.stoppable === true && Boolean(this.#hooks.get(conversationId)?.stopTool());
  }

  #cut(conversationId: string): void {
    try {
      this.#hooks.get(conversationId)?.interrupt();
    } catch (err) {
      console.warn(`interrupt: ${(err as Error).message}`);
    }
  }

  /** Steers waiting for this conversation's next safe point. */
  waitingSteers(conversationId: string): number {
    return this.#rows(conversationId, ['waiting']).filter((x) => x.kind === 'steer').length;
  }

  // ------------------------------------------------------------------ running the queue

  /** Starts the next waiting turn when nothing runs here ('moved' steers first, then the queue in order). */
  drain(conversationId: string): void {
    if (this.live(conversationId) || this.#running.has(conversationId)) return;
    const rows = this.#rows(conversationId, ['moved', 'waiting']);
    const next = rows.find((x) => x.state === 'moved') ?? rows.find((x) => x.kind === 'queue');
    if (!next) return;
    const runner = this.#runners.get(next.id) ?? this.defaultRunner?.(conversationId);
    if (!runner) return;
    const at = this.#now().toISOString();
    this.#set(next.id, { state: 'taken', taken_at: at });
    this.#runners.delete(next.id);
    const item: PendingItem = { ...next, state: 'taken', takenAt: at };
    this.#emit(conversationId, item);
    void this.run(conversationId, () => runner(item)).catch((err: Error) => console.warn(`queued turn: ${err.message}`));
  }

  // ------------------------------------------------------------------ the app's controls

  get(id: string): PendingItem | undefined {
    const r = this.#db.prepare('SELECT * FROM pending_inputs WHERE id = ?').get(id) as Row | undefined;
    return r ? toItem(r) : undefined;
  }

  /** The waiting, moved and stale items of a conversation (the chips), in order. */
  list(conversationId: string): PendingItem[] {
    return this.#rows(conversationId, ['waiting', 'moved', 'stale']);
  }

  /** Cancels one waiting (or stale) item. */
  cancel(conversationId: string, id: string): boolean {
    const it = this.get(id);
    if (!it || it.conversationId !== conversationId || !['waiting', 'moved', 'stale'].includes(it.state)) return false;
    this.#set(id, { state: 'dropped' });
    this.#runners.delete(id);
    this.#emit(conversationId, { ...it, state: 'dropped' });
    return true;
  }

  /**
   * *Now* on a chip: a queued item becomes a steer while she works; a stale one (after a restart)
   * is sent now (it waits its turn if she is busy).
   */
  promote(conversationId: string, id: string, runner?: Runner): PendingItem | undefined {
    const it = this.get(id);
    if (!it || it.conversationId !== conversationId) return undefined;
    if (runner) this.#runners.set(id, runner);
    if (it.state === 'stale') {
      this.#set(id, { state: 'waiting', kind: 'queue' });
      this.#emit(conversationId, { ...it, state: 'waiting', kind: 'queue' });
      this.drain(conversationId);
      return this.get(id);
    }
    if (it.state !== 'waiting' || it.kind !== 'queue' || it.sender === 'person') return undefined;
    const live = this.live(conversationId);
    this.#set(id, live ? { kind: 'steer' } : { kind: 'steer', state: 'moved' });
    this.#emit(conversationId, this.get(id)!);
    if (!live) this.drain(conversationId);
    return this.get(id);
  }

  /** /reset, /new, deleting the conversation: drops what waits here; returns how many. */
  clear(conversationId: string): number {
    const rows = this.#rows(conversationId, ['waiting', 'moved', 'stale']);
    for (const it of rows) {
      this.#set(it.id, { state: 'dropped' });
      this.#runners.delete(it.id);
    }
    if (rows.length) this.#emit(conversationId, null);
    return rows.filter((x) => x.state !== 'stale').length;
  }

  /** Start-up: everything still waiting becomes 'stale' (shown, never run by itself). Returns them. */
  markStale(): PendingItem[] {
    const rows = (this.#db.prepare("SELECT * FROM pending_inputs WHERE state IN ('waiting', 'moved') ORDER BY rowid").all() as unknown as Row[]).map(toItem);
    if (rows.length) this.#db.prepare("UPDATE pending_inputs SET state = 'stale' WHERE state IN ('waiting', 'moved')").run();
    return rows.map((r) => ({ ...r, state: 'stale' }));
  }

  /** Stale bridge rows the owner hasn't been told about (`source` = 'telegram', 'discord', …). */
  untold(source: string): PendingItem[] {
    return (this.#db.prepare("SELECT * FROM pending_inputs WHERE state = 'stale' ORDER BY rowid").all() as unknown as Row[]).map(toItem).filter((x) => x.meta.source === source && !x.meta.told);
  }
  markTold(id: string): void {
    const it = this.get(id);
    if (it) this.#db.prepare('UPDATE pending_inputs SET meta = ? WHERE id = ?').run(JSON.stringify({ ...it.meta, told: true }), id);
  }

  /** Hourly housekeeping: taken, dropped and moved rows go after 7 days (stale ones stay until handled). */
  prune(): number {
    const cutoff = new Date(this.#now().getTime() - KEEP_DONE_MS).toISOString();
    return Number(this.#db.prepare("DELETE FROM pending_inputs WHERE state IN ('taken', 'dropped') AND created_at < ?").run(cutoff).changes);
  }

  // ------------------------------------------------------------------ inside

  #rows(conversationId: string, states: PendingState[]): PendingItem[] {
    const q = `SELECT * FROM pending_inputs WHERE conversation_id = ? AND state IN (${states.map(() => '?').join(', ')}) ORDER BY rowid`;
    return (this.#db.prepare(q).all(conversationId, ...states) as unknown as Row[]).map(toItem);
  }

  #set(id: string, patch: { state?: PendingState; kind?: PendingKind; taken_at?: string }): void {
    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
    this.#db.prepare(`UPDATE pending_inputs SET ${sets} WHERE id = ?`).run(...(Object.values(patch) as string[]), id);
  }

  #emit(conversationId: string, item: PendingItem | null, line?: string): void {
    try {
      this.publish?.({ type: 'pending', conversationId, item, ...(line ? { line } : {}) });
    } catch {
      /* the hub is best effort */
    }
  }
}

/** The pending inputs of this app's store (made on first use; the server sets its own for off-the-record chats). */
export function pendingFor(app: AppContext): PendingInputs {
  if (app.pending) return app.pending;
  const p = new PendingInputs(app.store.db, app.now);
  p.publish = (ev) => app.events?.publish(ev as never);
  app.pending = p;
  return p;
}

/** The chip's short text: the first 60 characters, one line. */
export const snippet = (s: string, n = 60): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
