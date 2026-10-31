// Phase 3 "dumb path" memory: dated conversation summaries and a few owner facts, each tied to its
// source turn, searched with SQLite FTS5 and injected under a small fixed budget. No embeddings, no
// second model.
import type { DatabaseSync } from 'node:sqlite';
import { bracketNote, DEFAULT_DECAY, type DecayPolicy, matchedWords, type PickNote, pickNote, policyId, type PolicyWithId, PRESET_HALF_LIFE, queryWords, rankMemories } from './memory-rank.ts';

/**
 * fact: about the owner. self: something Sara said about her own life/opinions (her continuity).
 * date: a date that matters to the owner (birthday, anniversary…), with onDate set (Phase 12).
 * reflection: something she noticed looking back over a week (Phase 12).
 */
export type MemoryKind = 'summary' | 'fact' | 'self' | 'date' | 'reflection' | 'decision' | 'promise' | 'milestone' | 'lesson';
/**
 * Phase 32: decision = decided together; promise = someone committed to something; milestone = part of your story.
 * Phase 85: lesson = what fixed a failure in a project, written by the recall triggers (src/triggers.ts) from
 * recorded run evidence only; it comes back through the triggers, not the everyday notes.
 */
export const MEMORY_KINDS: MemoryKind[] = ['summary', 'fact', 'self', 'date', 'reflection', 'decision', 'promise', 'milestone', 'lesson'];

export interface Memory {
  id: number;
  kind: MemoryKind;
  content: string;
  conversationId: string | null;
  /** Fact: the owner's message it came from. Summary: last message covered. */
  sourceMessageId: number | null;
  /** Summary: first message covered. */
  sourceFromId: number | null;
  /** Local date (YYYY-MM-DD) the source happened. */
  happenedOn: string;
  /** Fact: the owner's own words it was taken from. */
  evidence: string | null;
  edited: boolean;
  /** date: "MM-DD" every year, or "YYYY-MM-DD" (one day, or the year it started). */
  onDate: string | null;
  /** fact: replaced by a newer fact (weekly reflection); kept for review but no longer used. */
  supersededBy: number | null;
  /** date: the last day she brought it up (so she mentions it once a year). */
  mentionedOn: string | null;
  /** promise: when it was kept (or dropped); open promises have null. Phase 32. */
  resolvedAt: string | null;
  /** Phase 44: fact: the library document it was learned from (evidence = words from it). */
  sourceDocId: number | null;
  /** Phase 76: never fades; always a candidate (still under the budget). */
  pinned: boolean;
  /** Phase 76: local day it last went into a prompt because it matched. */
  lastUsedOn: string | null;
  /** Phase 76: days it was used that way (at most +1 per day). */
  useCount: number;
  /** Phase 104 (move-in): searchable by recall, never put into a prompt by itself. */
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  conversation_id TEXT,
  source_message_id INTEGER,
  source_from_id INTEGER,
  happened_on TEXT NOT NULL,
  evidence TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_kind ON memories(kind, happened_on);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content='memories', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TABLE IF NOT EXISTS memory_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_state (
  conversation_id TEXT PRIMARY KEY,
  summarized_through INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error TEXT
);
`;

type Row = Record<string, string | number | null>;

function toMemory(r: Row): Memory {
  return {
    id: Number(r.id),
    kind: r.kind as MemoryKind,
    content: String(r.content),
    conversationId: (r.conversation_id as string | null) ?? null,
    sourceMessageId: r.source_message_id === null ? null : Number(r.source_message_id),
    sourceFromId: r.source_from_id === null ? null : Number(r.source_from_id),
    happenedOn: String(r.happened_on),
    evidence: (r.evidence as string | null) ?? null,
    edited: Boolean(r.edited),
    onDate: (r.on_date as string | null) ?? null,
    supersededBy: r.superseded_by === null || r.superseded_by === undefined ? null : Number(r.superseded_by),
    mentionedOn: (r.mentioned_on as string | null) ?? null,
    resolvedAt: (r.resolved_at as string | null) ?? null,
    sourceDocId: r.source_doc_id === null || r.source_doc_id === undefined ? null : Number(r.source_doc_id),
    pinned: Boolean(r.pinned),
    lastUsedOn: (r.last_used_on as string | null | undefined) ?? null,
    useCount: Number(r.use_count ?? 0),
    archived: Boolean(r.archived),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** Turns free text into a safe FTS5 OR-query of meaningful words (quoted, so no FTS syntax leaks in). */
export function ftsQuery(text: string): string | null {
  const uniq = queryWords(text);
  return uniq.length ? uniq.map((w) => `"${w}"`).join(' OR ') : null;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim();

export class MemoryStore {
  readonly db: DatabaseSync;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.#now = now;
    db.exec(SCHEMA);
    // Phase 12 columns (added in place on older databases).
    const cols = new Set((db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).map((c) => c.name));
    for (const [c, type] of [['on_date', 'TEXT'], ['superseded_by', 'INTEGER'], ['mentioned_on', 'TEXT'], ['resolved_at', 'TEXT'], ['source_doc_id', 'INTEGER'], ['pinned', 'INTEGER NOT NULL DEFAULT 0'], ['last_used_on', 'TEXT'], ['use_count', 'INTEGER NOT NULL DEFAULT 0'], ['archived', 'INTEGER NOT NULL DEFAULT 0']]) if (!cols.has(c)) db.exec(`ALTER TABLE memories ADD COLUMN ${c} ${type}`);
  }

  add(m: { kind: MemoryKind; content: string; conversationId: string | null; sourceMessageId: number | null; sourceFromId?: number | null; happenedOn: string; evidence?: string | null; onDate?: string | null; sourceDocId?: number | null }): Memory {
    const ts = this.#now().toISOString();
    const r = this.db
      .prepare(
        'INSERT INTO memories (kind, content, conversation_id, source_message_id, source_from_id, happened_on, evidence, on_date, source_doc_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(m.kind, m.content, m.conversationId, m.sourceMessageId, m.sourceFromId ?? null, m.happenedOn, m.evidence ?? null, m.onDate ?? null, m.sourceDocId ?? null, ts, ts);
    return this.get(Number(r.lastInsertRowid))!;
  }

  get(id: number): Memory | undefined {
    const r = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Row | undefined;
    return r ? toMemory(r) : undefined;
  }

  list(opts: { kind?: MemoryKind; q?: string; limit?: number; pinned?: boolean } = {}): Memory[] {
    const limit = Math.min(500, opts.limit ?? 200);
    // Phase 76: the Memory page's "Pinned" filter.
    if (opts.pinned) return this.list({ ...opts, pinned: false, limit: 500 }).filter((m) => m.pinned).slice(0, limit);
    const q = opts.q ? ftsQuery(opts.q) : null;
    if (opts.q && !q) return [];
    if (q) {
      const rows = this.db
        .prepare(`SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid WHERE memories_fts MATCH ? ${opts.kind ? 'AND m.kind = ?' : ''} ORDER BY bm25(memories_fts) LIMIT ?`)
        .all(...(opts.kind ? [q, opts.kind, limit] : [q, limit])) as Row[];
      return rows.map(toMemory);
    }
    const rows = this.db
      .prepare(`SELECT * FROM memories ${opts.kind ? 'WHERE kind = ?' : ''} ORDER BY happened_on DESC, id DESC LIMIT ?`)
      .all(...(opts.kind ? [opts.kind, limit] : [limit])) as Row[];
    return rows.map(toMemory);
  }

  /**
   * Phase 76: word search with the matched words worked out in code (FTS5 + bm25 order), for the
   * "why" of each note.
   */
  search(q: string, limit = 12): { memory: Memory; matched: string[] }[] {
    const words = queryWords(q);
    return this.list({ q, limit }).map((memory) => ({ memory, matched: matchedWords(words, memory.content) }));
  }

  /** Phase 76: pin a note (never fades) or unpin it. */
  setPinned(id: number, on: boolean): Memory | undefined {
    this.db.prepare('UPDATE memories SET pinned = ? WHERE id = ?').run(on ? 1 : 0, id);
    return this.get(id);
  }

  /** Phase 104 (move-in): an archived note is searchable but never auto-injected (§6.4). */
  setArchived(id: number, on: boolean): void {
    this.db.prepare('UPDATE memories SET archived = ? WHERE id = ?').run(on ? 1 : 0, id);
  }

  /** Phase 76: pinned notes still in use (newest first). */
  pinnedNotes(limit = 20): Memory[] {
    return (this.db.prepare('SELECT * FROM memories WHERE pinned = 1 AND superseded_by IS NULL ORDER BY happened_on DESC, id DESC LIMIT ?').all(limit) as Row[]).map(toMemory);
  }

  /** Phase 76: notes most recently used because they matched (facts, decisions, about her). */
  recentlyUsed(limit = 4): Memory[] {
    return (this.db.prepare("SELECT * FROM memories WHERE last_used_on IS NOT NULL AND superseded_by IS NULL AND kind IN ('fact','decision','self','milestone') ORDER BY last_used_on DESC, id DESC LIMIT ?").all(limit) as Row[]).map(toMemory);
  }

  /** Phase 76: notes that went into a prompt because they matched: +1 use per local day at most. */
  markUsed(ids: number[], day: string): number {
    const st = this.db.prepare('UPDATE memories SET use_count = use_count + 1, last_used_on = ? WHERE id = ? AND (last_used_on IS NULL OR last_used_on <> ?)');
    let n = 0;
    for (const id of new Set(ids)) n += Number(st.run(day, id, day).changes);
    return n;
  }

  /** Every note, newest first (Phase 38: for meaning-search vectors). */
  listAll(): Memory[] {
    return (this.db.prepare('SELECT * FROM memories ORDER BY happened_on DESC, id DESC').all() as Row[]).map(toMemory);
  }

  /** True if a fact (or self-fact) with the same text already exists. */
  hasFact(content: string, sourceMessageId: number | null, kind: 'fact' | 'self' = 'fact'): boolean {
    const rows = this.db.prepare('SELECT content, source_message_id FROM memories WHERE kind = ?').all(kind) as Row[];
    const n = norm(content);
    return rows.some((r) => norm(String(r.content)) === n || (sourceMessageId !== null && Number(r.source_message_id) === sourceMessageId && norm(String(r.content)) === n));
  }

  /**
   * After the owner renames the companion: notes about them use the new name. Quotes (the exact
   * words from a message) are left as they were said. Returns how many notes changed.
   */
  renameCompanion(oldName: string, newName: string): number {
    const old = oldName.trim();
    const neu = newName.trim();
    if (!old || !neu || old === neu) return 0;
    const re = new RegExp(`\\b${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const rows = this.db.prepare('SELECT id, content FROM memories WHERE content LIKE ?').all(`%${old}%`) as { id: number; content: string }[];
    const upd = this.db.prepare('UPDATE memories SET content = ? WHERE id = ?');
    let n = 0;
    for (const r of rows) {
      const next = r.content.replace(re, neu);
      if (next !== r.content) {
        upd.run(next, r.id);
        n++;
      }
    }
    return n;
  }

  update(id: number, content: string, onDate?: string | null): Memory | undefined {
    if (onDate !== undefined) this.db.prepare('UPDATE memories SET on_date = ? WHERE id = ?').run(onDate, id);
    this.db.prepare('UPDATE memories SET content = ?, edited = 1, updated_at = ? WHERE id = ?').run(content, this.#now().toISOString(), id);
    return this.get(id);
  }

  /** A fact replaced by a newer one (or null to use it again). */
  supersede(id: number, byId: number | null): void {
    this.db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(byId, id);
  }

  /** Dates in the next `days` days (0 = today), soonest first. */
  upcoming(today: string, days = 14): { memory: Memory; inDays: number; date: string; years: number | null }[] {
    const [y, mo, d] = today.split('-').map(Number);
    const base = Date.UTC(y, mo - 1, d);
    const out: { memory: Memory; inDays: number; date: string; years: number | null }[] = [];
    // Phase 35: milestones with a full date come back each year as anniversaries.
    const milestones = this.list({ kind: 'milestone', limit: 500 }).filter((m) => parseOnDate(m.onDate)?.year && !m.resolvedAt);
    for (const m of [...this.list({ kind: 'date', limit: 500 }), ...milestones]) {
      const parsed = parseOnDate(m.onDate);
      if (!parsed) continue;
      if (m.kind === 'milestone' && parsed.year! >= y) continue;
      // A one-time date (with a year in the future) only counts that year; yearly ones every year.
      for (const year of [y, y + 1]) {
        const at = Date.UTC(year, parsed.month - 1, parsed.day);
        const inDays = Math.round((at - base) / 86_400_000);
        if (inDays < 0 || inDays > days) continue;
        // One-time: a dated event she learned about before it happened (an interview, a trip).
        // Yearly: birthdays and anniversaries (learned after the date, e.g. with a birth year).
        const full = parsed.year ? `${parsed.year}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}` : '';
        if (parsed.year && (parsed.year > y || (m.kind === 'date' && m.happenedOn <= full))) {
          if (year !== parsed.year) continue;
        }
        const date = `${year}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`;
        out.push({ memory: m, inDays, date, years: parsed.year && parsed.year < year ? year - parsed.year : null });
        break;
      }
    }
    return out.sort((a, b) => a.inDays - b.inDays);
  }

  /**
   * Phase 37: one-time things that just happened (a dated event this year, 1 to `days` days ago),
   * so she can ask how it went. Birthdays and other yearly dates are not included.
   */
  recentPast(today: string, days = 3): { memory: Memory; daysAgo: number; date: string }[] {
    const [y, mo, d] = today.split('-').map(Number);
    const base = Date.UTC(y, mo - 1, d);
    const out: { memory: Memory; daysAgo: number; date: string }[] = [];
    for (const m of this.list({ kind: 'date', limit: 500 })) {
      const p = parseOnDate(m.onDate);
      if (!p?.year || p.year < y - 1) continue;
      const at = Date.UTC(p.year, p.month - 1, p.day);
      const daysAgo = Math.round((base - at) / 86_400_000);
      // Only events that were still ahead when she learned about them (not birthdays with a birth year).
      if (daysAgo < 1 || daysAgo > days || m.happenedOn > `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`) continue;
      out.push({ memory: m, daysAgo, date: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}` });
    }
    return out.sort((a, b) => a.daysAgo - b.daysAgo);
  }

  kvGet(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM memory_kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  kvSet(key: string, value: string): void {
    this.db.prepare('INSERT INTO memory_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Phase 32: open promises (oldest first), and marking one kept. */
  openPromises(limit = 20): Memory[] {
    return (this.db.prepare("SELECT * FROM memories WHERE kind = 'promise' AND resolved_at IS NULL AND superseded_by IS NULL ORDER BY COALESCE(on_date, '9999'), id LIMIT ?").all(limit) as Row[]).map(toMemory);
  }

  resolve(id: number, at: string): void {
    this.db.prepare('UPDATE memories SET resolved_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
  }

  markMentioned(id: number, day: string): void {
    this.db.prepare('UPDATE memories SET mentioned_on = ? WHERE id = ?').run(day, id);
  }

  /** Phase 44: what she learned from one library document. */
  fromDoc(docId: number): Memory[] {
    return (this.db.prepare('SELECT * FROM memories WHERE source_doc_id = ? ORDER BY id').all(docId) as Row[]).map(toMemory);
  }

  delete(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes) > 0;
  }

  /** Summaries whose message range includes a message. */
  summariesCovering(conversationId: string, messageId: number): Memory[] {
    return (
      this.db
        .prepare("SELECT * FROM memories WHERE kind = 'summary' AND conversation_id = ? AND source_from_id <= ? AND source_message_id >= ?")
        .all(conversationId, messageId, messageId) as Row[]
    ).map(toMemory);
  }

  // ---- summarization bookkeeping ----

  state(conversationId: string): { summarizedThrough: number; lastAttemptAt: string | null; lastError: string | null } {
    const r = this.db.prepare('SELECT * FROM memory_state WHERE conversation_id = ?').get(conversationId) as Row | undefined;
    return { summarizedThrough: Number(r?.summarized_through ?? 0), lastAttemptAt: (r?.last_attempt_at as string | null) ?? null, lastError: (r?.last_error as string | null) ?? null };
  }

  setState(conversationId: string, patch: { summarizedThrough?: number; lastAttemptAt?: string | null; lastError?: string | null }): void {
    const cur = this.state(conversationId);
    this.db
      .prepare('INSERT INTO memory_state (conversation_id, summarized_through, last_attempt_at, last_error) VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET summarized_through = excluded.summarized_through, last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error')
      .run(conversationId, patch.summarizedThrough ?? cur.summarizedThrough, patch.lastAttemptAt !== undefined ? patch.lastAttemptAt : cur.lastAttemptAt, patch.lastError !== undefined ? patch.lastError : cur.lastError);
  }

  /** Forgets everything learned from one conversation (when the owner deletes it and asks to forget). */
  deleteForConversation(conversationId: string): number {
    this.db.prepare('DELETE FROM memory_state WHERE conversation_id = ?').run(conversationId);
    return Number(this.db.prepare('DELETE FROM memories WHERE conversation_id = ?').run(conversationId).changes);
  }

  countForConversation(conversationId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE conversation_id = ?').get(conversationId) as Row).n);
  }

  /** Last errors of conversations whose summary keeps failing (for the health page). */
  failing(): string[] {
    return (this.db.prepare('SELECT last_error FROM memory_state WHERE last_error IS NOT NULL').all() as Row[]).map((r) => String(r.last_error));
  }

  /** Conversations quiet since `before` with owner messages not yet summarized. */
  /** Phase 32: conversations with at least `min` messages not yet summarized (even if still active). */
  rollingConversations(min: number, retryAfter: Date): string[] {
    const rows = this.db
      .prepare(
        `SELECT c.id FROM conversations c
         LEFT JOIN memory_state s ON s.conversation_id = c.id
         WHERE c.partner IS NULL
           AND (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role IN ('user','assistant') AND m.id > COALESCE(s.summarized_through, 0)) >= ?
           AND (s.last_attempt_at IS NULL OR s.last_error IS NULL OR s.last_attempt_at < ?)
         ORDER BY c.updated_at`,
      )
      .all(min, retryAfter.toISOString()) as Row[];
    return rows.map((r) => String(r.id));
  }

  dueConversations(before: Date, retryAfter: Date): string[] {
    const rows = this.db
      .prepare(
        `SELECT c.id FROM conversations c
         LEFT JOIN memory_state s ON s.conversation_id = c.id
         WHERE c.partner IS NULL
           AND (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id) < ?
           AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' AND m.id > COALESCE(s.summarized_through, 0))
           AND (s.last_attempt_at IS NULL OR s.last_error IS NULL OR s.last_attempt_at < ?)
         ORDER BY c.updated_at`,
      )
      .all(before.toISOString(), retryAfter.toISOString()) as Row[];
    return rows.map((r) => String(r.id));
  }
}

/** "MM-DD" or "YYYY-MM-DD" → parts (null if it isn't a real calendar day). */
export function parseOnDate(v: string | null | undefined): { year: number | null; month: number; day: number } | null {
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const year = m[1] ? Number(m[1]) : null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  const max = new Date(Date.UTC(year ?? 2000, month, 0)).getUTCDate(); // 2000: leap year, so Feb 29 is allowed yearly
  if (day > max) return null;
  if (year !== null && (year < 1900 || year > 2200)) return null;
  return { year, month, day };
}

/** The "coming up" block for her prompt: dates today and in the next two weeks. */
export function datesNote(mem: MemoryStore, today: string, days = 14, allow?: (m: Memory) => boolean): string | undefined {
  // Hardening M3: `allow` leaves out notes another app's turn may not see.
  const up = mem.upcoming(today, days).filter((u) => !allow || allow(u.memory));
  const fmt = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${iso}T12:00:00Z`));
  const lines = up
    .slice(0, 6)
    .map((u) => `- ${u.inDays === 0 ? 'TODAY' : u.inDays === 1 ? 'Tomorrow' : `In ${u.inDays} days`} (${fmt(u.date)}): ${u.memory.kind === 'milestone' ? `Anniversary of something in your story together: ${u.memory.content}` : u.memory.content}${u.years ? ` (${u.years} year${u.years === 1 ? '' : 's'})` : ''}`);
  return lines.length ? lines.join('\n') : undefined;
}

/**
 * Phase 37: things that just happened in the owner's life that they haven't talked about since
 * (no owner message after the day mentions it), for her to ask how they went.
 */
export function followUps(mem: MemoryStore, today: string, ownerSince: (sinceDay: string) => string[]): { memory: Memory; daysAgo: number; date: string }[] {
  const STOP = new Set(['with', 'from', 'that', 'this', 'have', 'will', 'their', 'there', 'about', 'appointment', 'today', 'tomorrow', 'week', 'morning', 'evening', 'afternoon', 'flies', 'going']);
  return mem.recentPast(today).filter((p) => {
    const words = (p.memory.content.toLowerCase().match(/[a-z0-9']{4,}/g) ?? []).map((w) => w.replace(/'s$/, '')).filter((w) => !STOP.has(w));
    if (!words.length) return true;
    const said = ownerSince(p.date).join(' ').toLowerCase();
    return !words.some((w) => said.includes(w));
  });
}

export function followUpsNote(items: { memory: Memory; daysAgo: number; date: string }[], owner: string): string | undefined {
  if (!items.length) return undefined;
  return `${items.map((p) => `- ${p.daysAgo === 1 ? 'Yesterday' : `${p.daysAgo} days ago`}: ${p.memory.content}`).join('\n')}\n${owner} told you about this before it happened and hasn't told you how it went. You care, so ask about it early in this conversation, in your own words (one at a time if there are several), unless ${owner} brings up something urgent.`;
}

// ---- per-turn selection (3.4) ----

export interface Injection {
  text: string;
  ids: number[];
  chars: number;
  /** Phase 76: why and how sure, per injected note (in the order injected); saved as meta.memoryPicks. */
  picks: PickNote[];
  /** Phase 76: the decay policy used (M3 records it per step). */
  policyId: string;
}

/**
 * Picks memories for this turn under a fixed character budget, best first (Phase 76: ranked by
 * `rankMemories`: word and meaning matches, then standing notes weighted by freshness). Memories
 * whose source is still inside this conversation's visible history are skipped (already in
 * context). Each line keeps its dated kind tag first and, unless `notes: false` (voice calls, her
 * day), ends with a short note: `[why: words "dog" + meaning; sure: high]`.
 */
export function selectMemories(
  mem: MemoryStore,
  opts: {
    userText: string;
    conversationId: string;
    oldestHistoryId: number;
    budgetChars: number;
    /** Before Phase 76: days before an un-matched note fades out (kept: maps to a half-life). */
    fadeDays?: number;
    /** Phase 76: the decay policy (`decayPolicy(memorySettings)`); wins over fadeDays. */
    policy?: PolicyWithId | DecayPolicy;
    today?: string;
    extra?: string[];
    /** Notes close in meaning; with scores (Phase 76) or plain (older callers). */
    related?: ({ memory: Memory; score: number } | Memory)[];
    docName?: (id: number) => string | undefined;
    /** Phase 74: the page a document note's words are on (for page citations). */
    docPage?: (id: number, evidence: string | null) => number | undefined;
    importedFrom?: (conversationId: string) => string | undefined;
    /** Phase 104: where she lived before a move-in, for notes from her own past ("Hermes Agent"). */
    movedFrom?: (conversationId: string) => string | undefined;
    /** Hardening M3: only notes this allows (another app's turn: none from private, imported or adult-channel conversations). */
    allow?: (m: Memory) => boolean;
    /** Phase 76: the bracket note after each line (default on; off for anything spoken aloud). */
    notes?: boolean;
    /** Phase 76 (hook for M8 "change one input"): notes forced in or out. */
    override?: { include?: number[]; exclude?: number[] };
  },
): Injection {
  const policy = opts.policy ?? (opts.fadeDays ? { ...DEFAULT_DECAY, halfLifeDays: opts.fadeDays } : { ...DEFAULT_DECAY, halfLifeDays: PRESET_HALF_LIFE.never });
  const ranked = rankMemories(mem, {
    query: opts.userText,
    conversationId: opts.conversationId,
    oldestHistoryId: opts.oldestHistoryId,
    related: opts.related,
    policy,
    today: opts.today,
    allow: opts.allow,
    override: opts.override,
  });
  const lines: string[] = [];
  const ids: number[] = [];
  const picks: PickNote[] = [];
  let chars = 0;
  // Lines from elsewhere (owner facts shared by the other companions) come after her own.
  const extra = opts.extra ?? [];
  for (const p of ranked) {
    const m = p.memory;
    const tag =
      m.kind === 'summary'
        ? ', conversation summary'
        : m.kind === 'self'
          ? ', something you said about yourself'
          : m.kind === 'reflection'
            ? ', something you noticed looking back over the week'
            : m.kind === 'decision'
              ? ', decided together: go by it unless told otherwise'
              : m.kind === 'promise'
                ? `, a promise still open${m.onDate ? `, due ${m.onDate}` : ''}: follow up on it`
                : m.kind === 'milestone'
                  ? ', part of your story together'
                  : '';
    // Phase 44: a note learned from a document names it, so she can say where it came from.
    const doc = m.sourceDocId !== null ? opts.docName?.(m.sourceDocId) : undefined;
    // Phase 51: a note learned from imported history says so (another assistant was there, not her).
    const other = m.conversationId ? opts.importedFrom?.(m.conversationId) : undefined;
    const moved = !other && m.conversationId ? opts.movedFrom?.(m.conversationId) : undefined;
    const page = doc && m.sourceDocId !== null ? opts.docPage?.(m.sourceDocId, m.evidence ?? null) : undefined;
    // Phase 76: the note goes AFTER the content, so small models see the same thing first.
    const line = `- (${m.happenedOn}${tag}${doc ? `, from the document "${doc}"${page ? `, page ${page}, cite: [p. ${page}](/#view=library:${m.sourceDocId}:${page})` : ''} in your library` : ''}${other ? `, learned from their imported ${other} history: that was ${other} talking with them, not you` : ''}${moved ? `, from before the move (on ${moved}): your own past` : ''}) ${m.content.replace(/\s+/g, ' ').trim()}${opts.notes === false ? '' : ` ${bracketNote(p)}`}`;
    if (chars + line.length + 1 > opts.budgetChars) continue;
    lines.push(line);
    ids.push(m.id);
    picks.push(pickNote(p));
    chars += line.length + 1;
  }
  for (const line of extra) {
    if (chars + line.length + 1 > opts.budgetChars) continue;
    lines.push(line);
    chars += line.length + 1;
  }
  return { text: lines.join('\n'), ids, chars, picks, policyId: 'id' in policy ? (policy as PolicyWithId).id : policyId(policy) };
}
