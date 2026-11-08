// EC13 (docs/ops/EC1213_DESIGN.md): the overnight memory tidy (opt-in, off by default). Once a
// night, in the owner's quiet hours and when nobody has written for 30 minutes, on the reminder
// scheduler's tick (no timer of its own):
//   1. duplicates (code only) are merged: the copy points at the kept note (superseded_by);
//   2. contradictions (code finds them; a model may only drop a false hit) become proposals with
//      Keep the newer / Keep the older / Keep both; nothing is applied on its own;
//   3. old threads (3+ summaries of one conversation older than 90 days) are summed up by a model in
//      one new summary; the originals are archived (searchable, never put into a prompt).
// It never deletes: every change is a row in memory_tidy_log with what it was before, and Undo puts
// it back. A short "what changed" note and one morning card go to his most recent own chat.
// Gates: a note from a private conversation, or tied to a private or sensitive person fact, is never
// merged with a note outside the same conversation and never goes to a model that is not on this
// computer. Models: only those on this computer unless he picks "any model" (the admin's pin
// `memoryTidy: 'local'` keeps it local; 'off' turns it off). Each space tidies only its own store.
//
// Tables (additive, the space's own store.db): memory_tidy_runs, memory_tidy_log.
import { dbHeld } from './legal-hold.ts';
import type { DatabaseSync } from 'node:sqlite';
import { resolveChain, streamWithin, type AppContext } from './chat.ts';
import { en, trOwner } from './i18n.ts';
import { inQuiet, proactiveSettings } from './life.ts';
import type { Memory, MemoryKind } from './memory.ts';
import { queryWords, stem } from './memory-rank.ts';
import { privateLocalOn } from './net-guard.ts';
import { zonedParts } from './planner.ts';
import { policy } from './policy-profile.ts';
import { onThisComputer } from './private-local.ts';

export const TIDY = { dupJaccard: 0.85, conflictOverlap: 0.5, staleDays: 90, threadMin: 3, threadMax: 12, idleMs: 30 * 60_000, maxProposals: 10, maxDigests: 5 } as const;
export type TidyModel = 'local' | 'any';
export interface TidySettings {
  on: boolean;
  model: TidyModel;
}
export type ChangeKind = 'merge' | 'contradiction' | 'digest';
export type ChangeState = 'applied' | 'undone' | 'open' | 'kept-newer' | 'kept-older' | 'kept-both';
export interface TidyRun {
  id: number;
  night: string;
  why: 'night' | 'now';
  at: string;
  merged: number;
  proposals: number;
  digests: number;
  /** Why the model steps were left out ('no-local-model'), or null. */
  skipped: string | null;
}
export interface NoteRef {
  id: number;
  kind: MemoryKind;
  content: string;
  happenedOn: string;
}
export interface TidyChange {
  id: number;
  runId: number;
  kind: ChangeKind;
  state: ChangeState;
  /** merge: the copy; contradiction: the older note; digest: the first original. */
  a: NoteRef;
  /** merge: the kept note; contradiction: the newer note; digest: the new summary. */
  b: NoteRef;
  /** digest: how many originals were archived. */
  count?: number;
}

export class TidyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const KINDS_DUP: MemoryKind[] = ['fact', 'self', 'decision', 'promise'];
const KINDS_CONFLICT: MemoryKind[] = ['fact', 'decision'];
const NEG = /\b(not|never|no longer|no more|stopped|quit|doesn['’]?t|don['’]?t|didn['’]?t|isn['’]?t|won['’]?t|can['’]?t|hates?|dislikes?)\b/i;
const numbers = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).join(' ');
const words = (s: string) => new Set(queryWords(s).map(stem));
const ref = (m: Memory): NoteRef => ({ id: m.id, kind: m.kind, content: m.content, happenedOn: m.happenedOn });
const DAY = 86_400_000;
type Row = Record<string, string | number | null>;

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
}
function overlapOfShorter(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size);
}

export function tidySettings(app: AppContext): TidySettings {
  const s = (app.settings.get() as { memoryTidy?: Partial<TidySettings> }).memoryTidy ?? {};
  return { on: s.on === true, model: s.model === 'any' ? 'any' : 'local' };
}

export class MemoryTidy {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  #busy = false;

  constructor(app: AppContext, db: DatabaseSync) {
    this.#app = app;
    this.#db = db;
    db.exec(`
CREATE TABLE IF NOT EXISTS memory_tidy_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  night TEXT NOT NULL,
  why TEXT NOT NULL,
  at TEXT NOT NULL,
  merged INTEGER NOT NULL DEFAULT 0,
  proposals INTEGER NOT NULL DEFAULT 0,
  digests INTEGER NOT NULL DEFAULT 0,
  skipped TEXT,
  message_id INTEGER
);
CREATE TABLE IF NOT EXISTS memory_tidy_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  a_id INTEGER NOT NULL,
  b_id INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS memory_tidy_log_run ON memory_tidy_log(run_id, id);
`);
  }

  settings(): TidySettings {
    return tidySettings(this.#app);
  }

  /** The model rule in force: the admin's pin and private local mode keep it on this computer. */
  #mode(): TidyModel {
    return policy().pins.memoryTidy === 'local' || privateLocalOn() ? 'local' : this.settings().model;
  }

  setSettings(body: { on?: unknown; model?: unknown }): TidySettings {
    const pin = policy().pins.memoryTidy;
    const cur = this.settings();
    const next: TidySettings = { on: body.on === undefined ? cur.on : body.on === true, model: body.model === undefined ? cur.model : body.model === 'any' ? 'any' : 'local' };
    if (pin === 'off' && next.on) throw new TidyError(403, en('The overnight memory tidy is turned off by your admin.'));
    if (pin === 'local' && next.model === 'any') throw new TidyError(403, en('Your admin keeps the memory tidy on models on this computer.'));
    this.#app.settings.update({ memoryTidy: next } as never);
    return next;
  }

  runs(limit = 10): TidyRun[] {
    return (this.#db.prepare('SELECT * FROM memory_tidy_runs ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map((r) => this.#run(r));
  }

  #run(r: Row): TidyRun {
    return { id: Number(r.id), night: String(r.night), why: r.why === 'night' ? 'night' : 'now', at: String(r.at), merged: Number(r.merged), proposals: Number(r.proposals), digests: Number(r.digests), skipped: r.skipped === null ? null : String(r.skipped) };
  }

  /** The morning card's contents: the run and each change (with the two notes it is about). */
  view(runId: number): (TidyRun & { changes: TidyChange[] }) | undefined {
    const r = this.#db.prepare('SELECT * FROM memory_tidy_runs WHERE id = ?').get(runId) as Row | undefined;
    if (!r) return undefined;
    const mem = this.#app.memory!;
    const changes: TidyChange[] = [];
    for (const c of this.#db.prepare('SELECT * FROM memory_tidy_log WHERE run_id = ? ORDER BY id').all(runId) as Row[]) {
      const a = mem.get(Number(c.a_id));
      const b = mem.get(Number(c.b_id));
      if (!a || !b) continue;
      const d = JSON.parse(String(c.detail)) as { ids?: number[] };
      changes.push({ id: Number(c.id), runId, kind: String(c.kind) as ChangeKind, state: String(c.state) as ChangeState, a: ref(a), b: ref(b), ...(d.ids ? { count: d.ids.length } : {}) });
    }
    return { ...this.#run(r), changes };
  }

  /** The night a time belongs to (the local date 12 hours earlier: 22:00 and 03:00 are the same night). */
  #night(now: Date): string {
    const p = zonedParts(new Date(now.getTime() - 12 * 3600_000), this.#app.settings.get().timeZone);
    return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  }

  /** Called from ReminderScheduler.tick(): 1 when tonight's tidy ran. */
  async due(now: Date = this.#app.now()): Promise<number> {
    if (this.#busy || !this.settings().on || policy().pins.memoryTidy === 'off' || !this.#app.memory) return 0;
    const p = proactiveSettings(this.#app);
    if (!inQuiet(zonedParts(now, this.#app.settings.get().timeZone).h, p.quietStart, p.quietEnd)) return 0;
    const night = this.#night(now);
    if (this.#db.prepare("SELECT 1 FROM memory_tidy_runs WHERE night = ? AND why = 'night'").get(night)) return 0;
    const last = (this.#db.prepare('SELECT MAX(created_at) AS at FROM messages').get() as { at: string | null } | undefined)?.at;
    if (last && now.getTime() - Date.parse(last) < TIDY.idleMs) return 0;
    await this.run('night', now);
    return 1;
  }

  /**
   * Closed notes may only go to a model on this computer. `room` is who a note may be merged or
   * compared with: open notes with each other, a private conversation's notes among themselves, and
   * a note tied to a private or sensitive person fact with none.
   */
  #closed(): ((m: Memory) => boolean) & { room: (m: Memory) => string } {
    const priv = new Map<string, boolean>();
    const sensitive = new Set<number>();
    try {
      for (const r of this.#db.prepare('SELECT memory_id FROM person_facts WHERE memory_id IS NOT NULL AND (private = 1 OR category IS NOT NULL)').all() as { memory_id: number }[]) sensitive.add(Number(r.memory_id));
    } catch {
      // No People in this space.
    }
    const isPrivate = (m: Memory) => {
      if (!m.conversationId) return false;
      if (!priv.has(m.conversationId)) priv.set(m.conversationId, Boolean(this.#app.store.getConversation(m.conversationId)?.private));
      return priv.get(m.conversationId)!;
    };
    const fn = (m: Memory) => sensitive.has(m.id) || isPrivate(m);
    return Object.assign(fn, { room: (m: Memory) => (sensitive.has(m.id) ? `person:${m.id}` : isPrivate(m) ? `private:${m.conversationId}` : 'open') });
  }

  /** Runs the tidy now (Tidy now, or tonight's slot). */
  async run(why: 'night' | 'now', now: Date = this.#app.now()): Promise<TidyRun> {
    if (policy().pins.memoryTidy === 'off') throw new TidyError(403, en('The overnight memory tidy is turned off by your admin.'));
    const mem = this.#app.memory;
    if (!mem) throw new TidyError(404, en('Memory is not available here.'));
    // EC17: a tidy merges and archives notes; under a legal hold it waits until the hold is released.
    if (dbHeld(this.#app.store.db)) throw new TidyError(409, en('These memories are under a legal hold. The tidy waits until the hold is released.'));
    if (this.#busy) throw new TidyError(409, en('The memory tidy is already running.'));
    this.#busy = true;
    try {
      const iso = now.toISOString();
      const runId = Number(this.#db.prepare('INSERT INTO memory_tidy_runs (night, why, at) VALUES (?, ?, ?)').run(this.#night(now), why, iso).lastInsertRowid);
      const closed = this.#closed();
      const live = mem.listAll().filter((m) => m.supersededBy === null && !m.archived);
      const log = (kind: ChangeKind, state: ChangeState, a: number, b: number, detail: Record<string, unknown> = {}) => this.#db.prepare('INSERT INTO memory_tidy_log (run_id, kind, state, a_id, b_id, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(runId, kind, state, a, b, JSON.stringify(detail), iso);
      const sameRoom = (a: Memory, b: Memory) => closed.room(a) === closed.room(b);
      const ws = new Map(live.map((m) => [m.id, words(m.content)]));
      // 1. Duplicates (code only).
      let merged = 0;
      const gone = new Set<number>();
      const older = (a: Memory, b: Memory) => (a.happenedOn < b.happenedOn || (a.happenedOn === b.happenedOn && a.id < b.id) ? -1 : 1);
      for (const kind of KINDS_DUP) {
        const list = live.filter((m) => m.kind === kind).sort(older);
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const [a, b] = [list[i], list[j]];
            if (gone.has(a.id) || gone.has(b.id) || !sameRoom(a, b)) continue;
            if (NEG.test(a.content) !== NEG.test(b.content) || numbers(a.content) !== numbers(b.content)) continue;
            if (jaccard(ws.get(a.id)!, ws.get(b.id)!) < TIDY.dupJaccard) continue;
            // The kept note: pinned, else the more used, else the older.
            const keep = a.pinned !== b.pinned ? (a.pinned ? a : b) : a.useCount !== b.useCount ? (a.useCount > b.useCount ? a : b) : a;
            const copy = keep === a ? b : a;
            mem.supersede(copy.id, keep.id);
            log('merge', 'applied', copy.id, keep.id, { before: copy.supersededBy });
            gone.add(copy.id);
            merged++;
          }
        }
      }
      // 2. Contradictions: found in code, a model may only drop one.
      const mode = this.#mode();
      const chain = this.#chain(mode);
      const found: [Memory, Memory][] = [];
      for (const kind of KINDS_CONFLICT) {
        const list = live.filter((m) => m.kind === kind && !gone.has(m.id)).sort(older);
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const [a, b] = [list[i], list[j]];
            if (!sameRoom(a, b) || overlapOfShorter(ws.get(a.id)!, ws.get(b.id)!) < TIDY.conflictOverlap) continue;
            if (NEG.test(a.content) === NEG.test(b.content) && numbers(a.content) === numbers(b.content)) continue;
            if (this.#db.prepare("SELECT 1 FROM memory_tidy_log WHERE kind = 'contradiction' AND ((a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?))").get(a.id, b.id, b.id, a.id)) continue;
            found.push([a, b]);
          }
        }
      }
      let proposals = 0;
      for (const [a, b] of found.slice(0, TIDY.maxProposals)) {
        const judge = this.#pick(chain, closed(a) || closed(b));
        if (judge) {
          const out = await this.#ask(judge, 'You check notes in an assistant\'s memory about its owner. Answer only YES or NO.', `Can both of these notes be true at the same time, now? If one replaces or contradicts the other, answer YES (they conflict). Otherwise answer NO.\nNote 1 (${a.happenedOn}): ${a.content}\nNote 2 (${b.happenedOn}): ${b.content}`, 8).catch(() => '');
          if (/^\s*no\b/i.test(out)) continue;
        }
        log('contradiction', 'open', a.id, b.id);
        proposals++;
      }
      // 3. Old threads: one new summary each (needs a model), the originals archived.
      let digests = 0;
      let skipped: string | null = null;
      const cutoff = new Date(now.getTime() - TIDY.staleDays * DAY).toISOString().slice(0, 10);
      const threads = new Map<string, Memory[]>();
      for (const m of live.filter((x) => x.kind === 'summary' && x.conversationId && !x.pinned && x.happenedOn < cutoff).sort(older)) threads.set(m.conversationId!, [...(threads.get(m.conversationId!) ?? []), m]);
      const stale = [...threads.values()].filter((l) => l.length >= TIDY.threadMin).sort((x, y) => x[0].id - y[0].id).slice(0, TIDY.maxDigests);
      if (!chain.length && (stale.length || found.length)) skipped = 'no-local-model';
      for (const list of stale) {
        const writer = this.#pick(chain, list.some(closed));
        if (!writer) continue;
        const notes = list.slice(-TIDY.threadMax);
        const out = (await this.#ask(writer, 'You tidy an assistant\'s long-term memory. Write ONE short summary (2 to 4 sentences, past tense, third person) that keeps every fact, decision and name in these notes. Use only these notes; add nothing.', notes.map((n) => `${n.happenedOn}: ${n.content}`).join('\n'), 300).catch(() => '')).trim().slice(0, 1200);
        if (out.length < 12) continue;
        const first = notes[0];
        const last = notes.at(-1)!;
        const made = mem.add({ kind: 'summary', content: out, conversationId: last.conversationId, sourceMessageId: last.sourceMessageId, sourceFromId: first.sourceFromId, happenedOn: last.happenedOn, evidence: `Overnight tidy: ${notes.length} older summaries` });
        for (const n of notes) mem.setArchived(n.id, true);
        log('digest', 'applied', first.id, made.id, { ids: notes.map((n) => n.id) });
        digests++;
      }
      this.#db.prepare('UPDATE memory_tidy_runs SET merged = ?, proposals = ?, digests = ?, skipped = ? WHERE id = ?').run(merged, proposals, digests, skipped, runId);
      if (merged || proposals || digests || skipped) this.#card(runId, { merged, proposals, digests, skipped });
      return this.runs(1)[0];
    } finally {
      this.#busy = false;
    }
  }

  /** The models it may use, each marked local or not (the mode decides whether non-local ones are kept). */
  #chain(mode: TidyModel): { provider: import('./providers/types.ts').Provider; model: string; local: boolean }[] {
    const conv = this.#cardChat();
    if (!conv) return [];
    try {
      return resolveChain(this.#app, conv, 'background')
        .map((c) => ({ provider: c.provider, model: c.model, local: onThisComputer(c.provider.config, c.model) }))
        .filter((c) => mode === 'any' || c.local);
    } catch {
      return [];
    }
  }

  /** A model for this input: notes that are closed only ever go to a model on this computer. */
  #pick<T extends { local: boolean }>(chain: T[], closed: boolean): T | undefined {
    return closed ? chain.find((c) => c.local) : chain[0];
  }

  async #ask(c: { provider: import('./providers/types.ts').Provider; model: string }, system: string, user: string, maxTokens: number): Promise<string> {
    let out = '';
    for await (const ev of streamWithin((sig) => c.provider.stream({ model: c.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0, maxTokens, reasoning: 'none', signal: sig }), AbortSignal.timeout(180_000), 120_000)) {
      if (ev.type === 'text') out += ev.text;
      if (out.length > maxTokens * 8) break;
    }
    return out;
  }

  /** His most recent own chat (web, not private, not with someone else), or a new "Memory" chat. */
  #cardChat(): import('./store.ts').Conversation | undefined {
    const r = this.#db.prepare("SELECT c.id FROM conversations c JOIN messages m ON m.conversation_id = c.id WHERE c.partner IS NULL AND c.private = 0 AND c.channel = 'web' ORDER BY m.id DESC LIMIT 1").get() as { id: string } | undefined;
    return (r ? this.#app.store.getConversation(r.id) : undefined) ?? this.#app.store.listConversations().find((c) => !c.partner && !c.private) ?? undefined;
  }

  #card(runId: number, n: { merged: number; proposals: number; digests: number; skipped: string | null }): void {
    const s = this.#app.settings.get();
    const conv = this.#cardChat() ?? this.#app.store.createConversation({ title: trOwner('Memory', s) });
    const note = trOwner('Overnight tidy: {merged} duplicates merged, {proposals} to check, {digests} old threads summed up.', s, n);
    const msg = this.#app.store.addMessage(conv.id, 'notice', `tidy:${note}`, { tidy: { runId, ...n } });
    this.#db.prepare('UPDATE memory_tidy_runs SET message_id = ? WHERE id = ?').run(msg.id, runId);
    this.#app.events?.publish({ type: 'message', conversationId: conv.id, message: msg, reason: 'reply' });
  }

  #change(id: number): Row {
    const c = this.#db.prepare('SELECT * FROM memory_tidy_log WHERE id = ?').get(id) as Row | undefined;
    if (!c) throw new TidyError(404, en('Change not found'));
    return c;
  }

  /** Undo one change: a merge, a summary or a decided proposal goes back to how it was. */
  undo(id: number): void {
    const c = this.#change(id);
    const mem = this.#app.memory!;
    const d = JSON.parse(String(c.detail)) as { before?: number | null; ids?: number[] };
    const a = Number(c.a_id);
    const b = Number(c.b_id);
    if (c.kind === 'merge' && c.state === 'applied') {
      mem.supersede(a, d.before ?? null);
      this.#set(id, 'undone');
    } else if (c.kind === 'digest' && c.state === 'applied') {
      for (const n of d.ids ?? []) mem.setArchived(n, false);
      mem.setArchived(b, true);
      this.#set(id, 'undone');
    } else if (c.kind === 'contradiction' && (c.state === 'kept-newer' || c.state === 'kept-older' || c.state === 'kept-both')) {
      if (c.state === 'kept-newer') mem.supersede(a, d.before ?? null);
      if (c.state === 'kept-older') mem.supersede(b, d.before ?? null);
      this.#set(id, 'open');
    } else throw new TidyError(409, en('This change was already undone.'));
  }

  /** A proposal answered: keep the newer (the older is replaced), the older, or both. */
  decide(id: number, choice: 'newer' | 'older' | 'both'): void {
    const c = this.#change(id);
    if (c.kind !== 'contradiction' || c.state !== 'open') throw new TidyError(409, en('This was already answered.'));
    const mem = this.#app.memory!;
    const a = Number(c.a_id);
    const b = Number(c.b_id);
    if (choice === 'newer') {
      this.#detail(id, { before: mem.get(a)?.supersededBy ?? null });
      mem.supersede(a, b);
    } else if (choice === 'older') {
      this.#detail(id, { before: mem.get(b)?.supersededBy ?? null });
      mem.supersede(b, a);
    }
    this.#set(id, choice === 'newer' ? 'kept-newer' : choice === 'older' ? 'kept-older' : 'kept-both');
  }

  #set(id: number, state: ChangeState): void {
    this.#db.prepare('UPDATE memory_tidy_log SET state = ?, decided_at = ? WHERE id = ?').run(state, this.#app.now().toISOString(), id);
  }

  #detail(id: number, d: Record<string, unknown>): void {
    this.#db.prepare('UPDATE memory_tidy_log SET detail = ? WHERE id = ?').run(JSON.stringify(d), id);
  }
}
