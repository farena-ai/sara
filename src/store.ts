// Conversation storage on SQLite (built into Node 24). One owner per server.
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Role } from './providers/types.ts';
import { StartupError } from './settings.ts';
import { SOURCE_NAME, type HistorySource } from './history-import/types.ts';

/** Phase 51: conversations brought in from another assistant's export live on these channels. */
export const isImportChannel = (channel: string): boolean => channel.startsWith('import-');
/** Phase 51: "ChatGPT" / "Claude" for an imported conversation's channel (undefined otherwise). */
export function importedName(channel: string | undefined | null): string | undefined {
  if (!channel || !isImportChannel(channel)) return undefined;
  return SOURCE_NAME[channel.slice(7) as HistorySource] ?? 'another assistant';
}
/**
 * Phase 104 (move-in, docs/design/MOVE_IN.md §6.5): an imported conversation the owner said was HER
 * past ("she moved here") has a channel key starting "her:". Her lines in it are her own words, and
 * notes from it say "from before the move" instead of "that was another assistant".
 */
export const isHerPast = (conv: { channel: string; channelKey: string | null } | null | undefined): boolean => Boolean(conv && isImportChannel(conv.channel) && conv.channelKey?.startsWith('her:'));
/** Phase 104: the other assistant of an imported conversation (undefined when it was her own past). */
export function importedOther(conv: { channel: string; channelKey: string | null } | null | undefined): string | undefined {
  return conv && !isHerPast(conv) ? importedName(conv.channel) : undefined;
}
/** Phase 104: where she lived before ("Hermes Agent") for a conversation from her own past. */
export function movedFrom(conv: { channel: string; channelKey: string | null } | null | undefined): string | undefined {
  return conv && isHerPast(conv) ? importedName(conv.channel) : undefined;
}
/** Phase 51: SQL: message `m` wasn't brought in from an export (imported messages carry meta.importedFrom). */
export const NOT_IMPORTED = `(m.meta IS NULL OR m.meta NOT LIKE '%"importedFrom"%')`;

export interface Conversation {
  id: string;
  title: string;
  providerId: string | null;
  model: string | null;
  workspace: string;
  /** 'coding' adds the engineering workflow and a higher step limit. */
  mode: ConversationMode;
  /** Private: local models only, no web or MCP tools (nothing leaves the server). */
  private: boolean;
  /** Where the conversation lives: 'web', 'telegram', 'discord'. */
  channel: string;
  /** Chat id on that channel (e.g. a Telegram chat id). */
  channelKey: string | null;
  /**
   * Set when Sara is talking with someone other than the owner (display name). Such chats get no
   * tools, no memory, no adult content and their own AI disclosure.
   */
  partner: string | null;
  /** Planner project this conversation belongs to (null = no project). */
  projectId: number | null;
  /** Set when archived: hidden from the main list, nothing deleted. */
  archivedAt: string | null;
  /** Phase 22: the owner's tags (lower-case words, e.g. "health", "taxes"). */
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** Phase 22: tags are short lower-case labels. */
export function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error('Tags must be a list.');
  const out = [...new Set(v.map((t) => String(t).toLowerCase().trim().replace(/^#/, '').replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s+/g, '-').slice(0, 24)).filter(Boolean))];
  if (out.length > 8) throw new Error('Up to 8 tags per conversation.');
  return out;
}

export type ConversationMode = 'chat' | 'coding';
export const CONVERSATION_MODES: readonly ConversationMode[] = ['chat', 'coding'];

export interface StoredMessage {
  id: number;
  conversationId: string;
  role: Role | 'notice';
  content: string;
  createdAt: string;
  /**
   * Extra structured data. Assistant: { toolCalls }. Tool: { toolCallId, name, args, status, ms }.
   */
  meta?: Record<string, unknown>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  provider_id TEXT,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS safety_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  conversation_id TEXT,
  created_at TEXT NOT NULL
);
`;

type Row = Record<string, string | number | null>;

function toConversation(r: Row): Conversation {
  return {
    id: String(r.id),
    title: String(r.title),
    providerId: (r.provider_id as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    workspace: String(r.workspace ?? 'main'),
    mode: (r.mode === 'coding' ? 'coding' : 'chat') as ConversationMode,
    private: Number(r.private ?? 0) === 1,
    channel: String(r.channel ?? 'web'),
    channelKey: (r.channel_key as string | null) ?? null,
    partner: (r.partner as string | null) ?? null,
    projectId: r.project_id === null || r.project_id === undefined ? null : Number(r.project_id),
    archivedAt: (r.archived_at as string | null) ?? null,
    tags: r.tags ? (JSON.parse(String(r.tags)) as string[]) : [],
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toMessage(r: Row): StoredMessage {
  return {
    id: Number(r.id),
    conversationId: String(r.conversation_id),
    role: r.role as StoredMessage['role'],
    content: String(r.content),
    createdAt: String(r.created_at),
    ...(r.meta ? { meta: JSON.parse(String(r.meta)) as Record<string, unknown> } : {}),
  };
}

/** Additive migrations only (rollback-safe): add columns that older versions ignore. */
function migrate(db: DatabaseSync): void {
  const cols = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => String(r.name)));
  if (!cols('messages').has('meta')) db.exec('ALTER TABLE messages ADD COLUMN meta TEXT');
  if (!cols('conversations').has('workspace')) db.exec("ALTER TABLE conversations ADD COLUMN workspace TEXT NOT NULL DEFAULT 'main'");
  if (!cols('conversations').has('mode')) db.exec("ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat'");
  if (!cols('conversations').has('private')) db.exec('ALTER TABLE conversations ADD COLUMN private INTEGER NOT NULL DEFAULT 0');
  if (!cols('conversations').has('channel')) db.exec("ALTER TABLE conversations ADD COLUMN channel TEXT NOT NULL DEFAULT 'web'");
  if (!cols('conversations').has('channel_key')) db.exec('ALTER TABLE conversations ADD COLUMN channel_key TEXT');
  if (!cols('conversations').has('partner')) db.exec('ALTER TABLE conversations ADD COLUMN partner TEXT');
  if (!cols('conversations').has('project_id')) db.exec('ALTER TABLE conversations ADD COLUMN project_id INTEGER');
  if (!cols('conversations').has('archived_at')) db.exec('ALTER TABLE conversations ADD COLUMN archived_at TEXT');
  if (!cols('conversations').has('tags')) db.exec('ALTER TABLE conversations ADD COLUMN tags TEXT');
  // Phase 32: a word index over every message, so she can look through past conversations.
  const hasFts = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'").get();
  db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;`);
  if (!hasFts) db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
}

export class Store {
  readonly db: DatabaseSync;
  readonly #now: () => Date;

  constructor(path: string, now: () => Date = () => new Date()) {
    try {
      this.db = new DatabaseSync(path);
      // WAL with synchronous=NORMAL: each commit no longer waits for a disk flush (it measured
      // ~80 ms per commit on the home server, for every saved message and run step). SQLite's own
      // guidance for WAL: the file can't be corrupted; only the last moments of writes can be lost
      // if the whole machine loses power, never on a crash of Sara herself.
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
      this.db.exec(SCHEMA);
      migrate(this.db);
    } catch (err) {
      const e = err as Error & { code?: string; errcode?: number };
      throw new StartupError(
        /not a database|malformed|corrupt|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(`${e.message} ${e.code ?? ''}`)
          ? `Her database ${path} is damaged (${e.message}).`
          : `Her database ${path} couldn't be opened (${e.message}). Check that the data folder exists, is a folder, and that Sara may write to it, and that the disk isn't full.`,
      );
    }
    this.#now = now;
  }

  close(): void {
    this.db.close();
  }

  createConversation(
    opts: { title?: string; providerId?: string | null; model?: string | null; workspace?: string; mode?: ConversationMode; private?: boolean; channel?: string; channelKey?: string | null; partner?: string | null; projectId?: number | null } = {},
  ): Conversation {
    const ts = this.#now().toISOString();
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO conversations (id, title, provider_id, model, workspace, mode, private, channel, channel_key, partner, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, opts.title ?? 'New conversation', opts.providerId ?? null, opts.model ?? null, opts.workspace ?? 'main', opts.mode ?? 'chat', opts.private ? 1 : 0, opts.channel ?? 'web', opts.channelKey ?? null, opts.partner ?? null, opts.projectId ?? null, ts, ts);
    return this.getConversation(id)!;
  }

  /** The conversation for a chat on a channel (e.g. one Telegram chat). */
  findChannelConversation(channel: string, key: string, who?: 'owner' | 'partner'): Conversation | undefined {
    // Phase 43: a chat can hold both (someone talked to her before being made an owner).
    const filter = who === 'owner' ? ' AND partner IS NULL' : who === 'partner' ? ' AND partner IS NOT NULL' : '';
    const r = this.db.prepare(`SELECT * FROM conversations WHERE channel = ? AND channel_key = ?${filter} ORDER BY created_at LIMIT 1`).get(channel, key) as Row | undefined;
    return r ? toConversation(r) : undefined;
  }

  getConversation(id: string): Conversation | undefined {
    const r = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Row | undefined;
    return r ? toConversation(r) : undefined;
  }

  listConversations(): Conversation[] {
    // Phase 51: imported history comes last, so "the latest conversation" is never one of them.
    return (this.db.prepare("SELECT * FROM conversations ORDER BY (channel LIKE 'import-%'), updated_at DESC").all() as Row[]).map(toConversation);
  }

  /**
   * Phase 51: one conversation from another assistant's export, with its original times, in one
   * transaction. Archived unless asked otherwise; every message carries meta.importedFrom.
   */
  insertImported(c: { title: string; channel: string; channelKey: string; createdAt: string; updatedAt: string; archived: boolean; from: string; herPast?: boolean; messages: { role: 'user' | 'assistant'; content: string; createdAt: string; attachments?: string[] }[] }): { id: string; firstId: number; lastId: number } {
    const id = randomUUID();
    const ins = this.db.prepare('INSERT INTO messages (conversation_id, role, content, created_at, meta) VALUES (?, ?, ?, ?, ?)');
    let firstId = 0;
    let lastId = 0;
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO conversations (id, title, provider_id, model, workspace, mode, private, channel, channel_key, partner, project_id, archived_at, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?, 0, ?, ?, NULL, NULL, ?, ?, ?)')
        .run(id, c.title, 'main', 'chat', c.channel, c.channelKey, c.archived ? this.#now().toISOString() : null, c.createdAt, c.updatedAt);
      for (const m of c.messages) {
        const meta = { importedFrom: c.from, ...(c.herPast ? { herPast: true } : {}), ...(m.attachments?.length ? { attachments: m.attachments } : {}) };
        lastId = Number(ins.run(id, m.role, m.content, m.createdAt, JSON.stringify(meta)).lastInsertRowid);
        firstId ||= lastId;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { id, firstId, lastId };
  }

  /** Phase 51: ids of imported conversations (all, or from one channel). */
  importedConversationIds(channel?: string): string[] {
    const rows = (channel ? this.db.prepare('SELECT id FROM conversations WHERE channel = ? ORDER BY created_at').all(channel) : this.db.prepare("SELECT id FROM conversations WHERE channel LIKE 'import-%' ORDER BY created_at").all()) as Row[];
    return rows.map((r) => String(r.id));
  }

  updateConversation(id: string, patch: { title?: string; providerId?: string | null; model?: string | null; workspace?: string; mode?: ConversationMode; private?: boolean; projectId?: number | null; archived?: boolean; tags?: string[] }): Conversation | undefined {
    const c = this.getConversation(id);
    if (!c) return undefined;
    // Tags don't count as activity either.
    if (patch.tags !== undefined) {
      const tags = cleanTags(patch.tags);
      this.db.prepare('UPDATE conversations SET tags = ? WHERE id = ?').run(tags.length ? JSON.stringify(tags) : null, id);
      const { tags: _t, ...rest } = patch;
      if (!Object.keys(rest).length) return this.getConversation(id);
      return this.updateConversation(id, rest);
    }
    // Filing and archiving don't count as activity (the list order stays put).
    if (patch.projectId !== undefined || patch.archived !== undefined) {
      this.db
        .prepare('UPDATE conversations SET project_id = ?, archived_at = ? WHERE id = ?')
        .run(patch.projectId !== undefined ? patch.projectId : c.projectId, patch.archived === undefined ? c.archivedAt : patch.archived ? (c.archivedAt ?? this.#now().toISOString()) : null, id);
      const { projectId: _p, archived: _a, ...rest } = patch;
      if (!Object.keys(rest).length) return this.getConversation(id);
      return this.updateConversation(id, rest);
    }
    this.db
      .prepare('UPDATE conversations SET title = ?, provider_id = ?, model = ?, workspace = ?, mode = ?, private = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.title ?? c.title,
        patch.providerId !== undefined ? patch.providerId : c.providerId,
        patch.model !== undefined ? patch.model : c.model,
        patch.workspace ?? c.workspace,
        patch.mode ?? c.mode,
        (patch.private ?? c.private) ? 1 : 0,
        this.#now().toISOString(),
        id,
      );
    return this.getConversation(id);
  }

  /** A project was deleted: its conversations move to "no project". */
  clearProject(projectId: number): number {
    return Number(this.db.prepare('UPDATE conversations SET project_id = NULL WHERE project_id = ?').run(projectId).changes);
  }

  deleteConversation(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes) > 0;
  }

  addMessage(conversationId: string, role: StoredMessage['role'], content: string, meta?: Record<string, unknown>): StoredMessage {
    const ts = this.#now().toISOString();
    const r = this.db
      .prepare('INSERT INTO messages (conversation_id, role, content, created_at, meta) VALUES (?, ?, ?, ?, ?)')
      .run(conversationId, role, content, ts, meta ? JSON.stringify(meta) : null);
    // Talking in an archived conversation brings it back.
    this.db.prepare(`UPDATE conversations SET updated_at = ?${role === 'user' ? ', archived_at = NULL' : ''} WHERE id = ?`).run(ts, conversationId);
    return { id: Number(r.lastInsertRowid), conversationId, role, content, createdAt: ts, ...(meta ? { meta } : {}) };
  }

  /** Replaces a message's text (Phase 28: a blocked reply is replaced, not kept). */
  updateMessageContent(id: number, content: string): void {
    this.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id);
  }

  /** Merges keys into a message's meta. */
  updateMessageMeta(id: number, patch: Record<string, unknown>): void {
    const r = this.db.prepare('SELECT meta FROM messages WHERE id = ?').get(id) as Row | undefined;
    if (!r) return;
    const meta = { ...(r.meta ? (JSON.parse(String(r.meta)) as Record<string, unknown>) : {}), ...patch };
    this.db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
  }

  messageById(id: number): StoredMessage | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return r ? toMessage(r) : undefined;
  }

  /** Photo ids referenced by any stored message. */
  imagesInUse(): Set<string> {
    const out = new Set<string>();
    // Phase 49: screenshots on her replies (the proof strip) count too.
    for (const r of this.db.prepare(`SELECT meta FROM messages WHERE meta LIKE '%"images"%' OR meta LIKE '%"proof"%'`).all() as Row[]) {
      const m = JSON.parse(String(r.meta)) as { images?: unknown; proof?: unknown };
      for (const list of [m.images, m.proof]) if (Array.isArray(list)) for (const id of list) out.add(String(id));
    }
    return out;
  }

  /** Deletes a message and everything after it in its conversation (regenerate / edit). */
  deleteMessagesFrom(conversationId: string, fromId: number): number {
    return Number(this.db.prepare('DELETE FROM messages WHERE conversation_id = ? AND id >= ?').run(conversationId, fromId).changes);
  }

  /** Search titles and owner/Sara messages (newest first). Partner chats included; tool output is not. */
  search(q: string, limit = 40): { conversationId: string; title: string; messageId: number | null; role: string | null; snippet: string; createdAt: string }[] {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    if (!words.length) return [];
    const like = (col: string) => words.map(() => `instr(lower(${col}), ?) > 0`).join(' AND ');
    const titles = (this.db.prepare(`SELECT id, title, updated_at FROM conversations WHERE ${like('title')} ORDER BY updated_at DESC LIMIT ?`).all(...words, limit) as Row[]).map((r) => ({
      conversationId: String(r.id),
      title: String(r.title),
      messageId: null,
      role: null,
      snippet: '',
      createdAt: String(r.updated_at),
    }));
    const msgs = (
      this.db
        .prepare(`SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.role IN ('user','assistant') AND ${like('m.content')} ORDER BY m.id DESC LIMIT ?`)
        .all(...words, limit) as Row[]
    ).map((r) => {
      const content = String(r.content).replace(/\s+/g, ' ');
      const at = Math.max(0, content.toLowerCase().indexOf(words[0]) - 60);
      return {
        conversationId: String(r.conversation_id),
        title: String(r.title),
        messageId: Number(r.id),
        role: String(r.role),
        snippet: `${at ? '…' : ''}${content.slice(at, at + 180)}${content.length > at + 180 ? '…' : ''}`,
        createdAt: String(r.created_at),
      };
    });
    return [...titles, ...msgs].slice(0, limit);
  }

  /**
   * Phase 22: one page of a conversation, oldest first: the latest `limit` messages (or those
   * before `before`), and how many earlier ones there are.
   */
  messagesPage(conversationId: string, opts: { before?: number; limit: number }): { messages: StoredMessage[]; earlier: number } {
    const before = opts.before ?? Number.MAX_SAFE_INTEGER;
    const rows = (this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(conversationId, before, opts.limit) as Row[]).reverse();
    const first = rows[0] ? Number(rows[0].id) : before;
    const earlier = Number((this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND id < ?').get(conversationId, first) as Row).n);
    return { messages: rows.map(toMessage), earlier };
  }

  /** Phase 22: pinned messages of a conversation, oldest first. */
  pinnedMessages(conversationId: string): StoredMessage[] {
    return (this.db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND meta LIKE '%"pinned":true%' ORDER BY id`).all(conversationId) as Row[]).map(toMessage).filter((m) => m.meta?.pinned === true);
  }

  /** Phase 22: every tag in use, with how many conversations have it (most used first). */
  allTags(): { tag: string; count: number }[] {
    const n = new Map<string, number>();
    for (const r of this.db.prepare('SELECT tags FROM conversations WHERE tags IS NOT NULL').all() as Row[]) for (const t of JSON.parse(String(r.tags)) as string[]) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /** Phase 78: the newest message id of a conversation (0 when empty). */
  lastMessageId(conversationId: string): number {
    const r = this.db.prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?').get(conversationId) as Row | undefined;
    return Number(r?.id ?? 0);
  }

  messages(conversationId: string): StoredMessage[] {
    return (this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId) as Row[]).map(toMessage);
  }

  /** Time of the latest owner message (any owner conversation) before a given message id. */
  /** Phase 37: the owner's own messages since a time (newest 200), for "did we talk about it?". */
  ownerMessagesSince(iso: string): string[] {
    return (this.db.prepare(`SELECT content FROM messages m WHERE role = 'user' AND created_at >= ? AND ${NOT_IMPORTED} ORDER BY id DESC LIMIT 200`).all(iso) as { content: string }[]).map((r) => r.content);
  }

  lastOwnerMessageAt(beforeId = Number.MAX_SAFE_INTEGER): Date | undefined {
    const r = this.db
      .prepare(`SELECT m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.role = 'user' AND c.partner IS NULL AND ${NOT_IMPORTED} AND m.id < ? ORDER BY m.id DESC LIMIT 1`)
      .get(beforeId) as Row | undefined;
    return r ? new Date(String(r.created_at)) : undefined;
  }

  /** Time of the very first owner message. */
  firstOwnerMessageAt(): Date | undefined {
    const r = this.db.prepare(`SELECT MIN(m.created_at) AS t FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.role = 'user' AND c.partner IS NULL AND ${NOT_IMPORTED}`).get() as Row | undefined;
    return r?.t ? new Date(String(r.t)) : undefined;
  }

  /** Latest disclosure notice (in one conversation, or any), used for the periodic AI reminder. */
  lastDisclosureAt(conversationId?: string): Date | undefined {
    const r = (
      conversationId
        ? this.db.prepare("SELECT created_at FROM messages WHERE role = 'notice' AND content LIKE 'disclosure:%' AND conversation_id = ? ORDER BY id DESC LIMIT 1").get(conversationId)
        : this.db.prepare("SELECT created_at FROM messages WHERE role = 'notice' AND content LIKE 'disclosure:%' ORDER BY id DESC LIMIT 1").get()
    ) as Row | undefined;
    return r ? new Date(String(r.created_at)) : undefined;
  }

  /** Counts only (no message content) so the owner can meet any reporting duty without exposing chats. */
  recordSafetyEvent(kind: string, conversationId?: string): void {
    this.db.prepare('INSERT INTO safety_events (kind, conversation_id, created_at) VALUES (?, ?, ?)').run(kind, conversationId ?? null, this.#now().toISOString());
  }

  /** Phase 69: when this kind of safety event last happened in a conversation (the camera pauses after a block). */
  lastSafetyEventAt(kind: string, conversationId: string): Date | undefined {
    const r = this.db.prepare('SELECT created_at FROM safety_events WHERE kind = ? AND conversation_id = ? ORDER BY id DESC LIMIT 1').get(kind, conversationId) as Row | undefined;
    return r ? new Date(String(r.created_at)) : undefined;
  }

  safetyEventCounts(): Record<string, number> {
    const rows = this.db.prepare('SELECT kind, COUNT(*) AS n FROM safety_events GROUP BY kind').all() as Row[];
    return Object.fromEntries(rows.map((r) => [String(r.kind), Number(r.n)]));
  }
}
