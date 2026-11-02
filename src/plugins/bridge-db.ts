// Phase 117 (docs/design/BRIDGES3.md §6.1): the plugin-bridge tables, additive, in the store.db of
// the one companion a bridge plugin runs for (`CREATE TABLE IF NOT EXISTS`, so 2.49 opens a 2.50
// database and ignores them).
//
// - bridge_identities: the owner's pinned identity on a bridge (Signal: his safety number). A
//   changed one pauses his owner powers there until he confirms it in the app (§4.4).
// - bridge_skips: daily counts of what a bridge ignored and why (only an id or address, never text).
// - bridge_windows (Phase 122, WHATSAPP §3.1 W4): each chat's reply window on a platform that refuses
//   her free-form messages after his last message is N hours old (WhatsApp: 24). Meta's own
//   timestamp of his message counts, not its arrival.
// - bridge_threads: a mail thread → its conversation (written by the email plugin's turns, part B;
//   the table and its helpers are here so part B only uses them).
import type { DatabaseSync } from 'node:sqlite';

const ready = new WeakSet<object>();

export function bridgeDb(db: DatabaseSync): DatabaseSync {
  if (ready.has(db)) return db;
  db.exec(`CREATE TABLE IF NOT EXISTS bridge_threads (
  bridge TEXT NOT NULL,
  chat_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  subject TEXT,
  last_message_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bridge, chat_key, thread_id)
);
CREATE INDEX IF NOT EXISTS bridge_threads_conv ON bridge_threads(conversation_id);
CREATE TABLE IF NOT EXISTS bridge_identities (
  bridge TEXT NOT NULL,
  chat_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  new_fingerprint TEXT,
  pinned_at TEXT NOT NULL, changed_at TEXT,
  PRIMARY KEY (bridge, chat_key)
);
CREATE TABLE IF NOT EXISTS bridge_skips (
  bridge TEXT NOT NULL, day TEXT NOT NULL,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_at TEXT, last_from TEXT,
  PRIMARY KEY (bridge, day, reason)
);
CREATE TABLE IF NOT EXISTS bridge_windows (
  bridge TEXT NOT NULL,
  chat_key TEXT NOT NULL,
  last_in_at TEXT NOT NULL,
  open_until TEXT NOT NULL,
  closed_by TEXT,
  PRIMARY KEY (bridge, chat_key)
);`);
  ready.add(db);
  return db;
}

export interface BridgeIdentity {
  bridge: string;
  chatKey: string;
  fingerprint: string;
  state: 'ok' | 'changed';
  newFingerprint: string | null;
  pinnedAt: string;
  changedAt: string | null;
}

type Row = Record<string, string | number | null>;
const toIdentity = (r: Row): BridgeIdentity => ({ bridge: String(r.bridge), chatKey: String(r.chat_key), fingerprint: String(r.fingerprint), state: r.state === 'changed' ? 'changed' : 'ok', newFingerprint: (r.new_fingerprint as string | null) ?? null, pinnedAt: String(r.pinned_at), changedAt: (r.changed_at as string | null) ?? null });

/** A safety number as the plugin reports it: digits, letters, spaces (≤ 200), or undefined. */
export function cleanFingerprint(v: unknown): string | undefined {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s && s.length <= 200 && /^[\w :+/=-]+$/.test(s) ? s : undefined;
}

export function identityOf(db: DatabaseSync, bridge: string, chatKey: string): BridgeIdentity | undefined {
  const r = bridgeDb(db).prepare('SELECT * FROM bridge_identities WHERE bridge = ? AND chat_key = ?').get(bridge, chatKey) as Row | undefined;
  return r ? toIdentity(r) : undefined;
}

export function identities(db: DatabaseSync, bridge: string): BridgeIdentity[] {
  return (bridgeDb(db).prepare('SELECT * FROM bridge_identities WHERE bridge = ? ORDER BY pinned_at').all(bridge) as Row[]).map(toIdentity);
}

/** Pins (or re-pins, after "It's me") the owner's identity. */
export function pinIdentity(db: DatabaseSync, bridge: string, chatKey: string, fingerprint: string, at: string): void {
  bridgeDb(db)
    .prepare("INSERT INTO bridge_identities (bridge, chat_key, fingerprint, state, new_fingerprint, pinned_at, changed_at) VALUES (?, ?, ?, 'ok', NULL, ?, NULL) ON CONFLICT(bridge, chat_key) DO UPDATE SET fingerprint = excluded.fingerprint, state = 'ok', new_fingerprint = NULL, pinned_at = excluded.pinned_at, changed_at = NULL")
    .run(bridge, chatKey, fingerprint, at);
}

/**
 * Compares a reported identity with the pinned one. Returns the state after the check: 'none' (not
 * pinned), 'ok', or 'changed' (recorded; stays changed until confirmed, even if the old one returns).
 */
export function checkIdentity(db: DatabaseSync, bridge: string, chatKey: string, fingerprint: string | undefined, at: string): 'none' | 'ok' | 'changed' {
  const cur = identityOf(db, bridge, chatKey);
  if (!cur) return 'none';
  if (cur.state === 'changed') {
    if (fingerprint && fingerprint !== cur.newFingerprint && fingerprint !== cur.fingerprint) bridgeDb(db).prepare('UPDATE bridge_identities SET new_fingerprint = ?, changed_at = ? WHERE bridge = ? AND chat_key = ?').run(fingerprint, at, bridge, chatKey);
    return 'changed';
  }
  if (!fingerprint || fingerprint === cur.fingerprint) return 'ok';
  bridgeDb(db).prepare("UPDATE bridge_identities SET state = 'changed', new_fingerprint = ?, changed_at = ? WHERE bridge = ? AND chat_key = ?").run(fingerprint, at, bridge, chatKey);
  return 'changed';
}

export function forgetIdentity(db: DatabaseSync, bridge: string, chatKey?: string): void {
  if (chatKey) bridgeDb(db).prepare('DELETE FROM bridge_identities WHERE bridge = ? AND chat_key = ?').run(bridge, chatKey);
  else bridgeDb(db).prepare('DELETE FROM bridge_identities WHERE bridge = ?').run(bridge);
}

export const SKIP_REASONS = ['stranger', 'unaligned', 'list', 'auto', 'bounce', 'self', 'rate', 'loop', 'size', 'not-to-her', 'group-off', 'linked-mode', 'duplicate', 'group', 'old', 'muted', 'status-unknown', 'stranger-invite', 'encrypted', 'unknown-id', 'from-me', 'own-apple-id', 'other'] as const;

/** Counts one ignored message (the id or address only). */
export function countSkip(db: DatabaseSync, bridge: string, day: string, reason: string, from: string, at: string): void {
  const r = (SKIP_REASONS as readonly string[]).includes(reason) ? reason : 'other';
  bridgeDb(db)
    .prepare('INSERT INTO bridge_skips (bridge, day, reason, count, last_at, last_from) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(bridge, day, reason) DO UPDATE SET count = count + 1, last_at = excluded.last_at, last_from = excluded.last_from')
    .run(bridge, day, r, at, from.slice(0, 120));
}

export function skipsOn(db: DatabaseSync, bridge: string, day: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of bridgeDb(db).prepare('SELECT reason, count FROM bridge_skips WHERE bridge = ? AND day = ?').all(bridge, day) as Row[]) out[String(r.reason)] = Number(r.count);
  return out;
}

/** Hourly housekeeping: skip counts older than 30 days go. */
export function pruneSkips(db: DatabaseSync, beforeDay: string): void {
  bridgeDb(db).prepare('DELETE FROM bridge_skips WHERE day < ?').run(beforeDay);
}

// --- threads (email, part B uses these) ---

export function threadConversation(db: DatabaseSync, bridge: string, chatKey: string, threadId: string): string | undefined {
  const r = bridgeDb(db).prepare('SELECT conversation_id FROM bridge_threads WHERE bridge = ? AND chat_key = ? AND thread_id = ?').get(bridge, chatKey, threadId) as Row | undefined;
  return r ? String(r.conversation_id) : undefined;
}

export function noteThread(db: DatabaseSync, t: { bridge: string; chatKey: string; threadId: string; conversationId: string; subject?: string | null; lastMessageId?: string | null; at: string }): void {
  bridgeDb(db)
    .prepare('INSERT INTO bridge_threads (bridge, chat_key, thread_id, conversation_id, subject, last_message_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(bridge, chat_key, thread_id) DO UPDATE SET conversation_id = excluded.conversation_id, subject = COALESCE(excluded.subject, subject), last_message_id = COALESCE(excluded.last_message_id, last_message_id), updated_at = excluded.updated_at')
    .run(t.bridge, t.chatKey, t.threadId, t.conversationId, t.subject ?? null, t.lastMessageId ?? null, t.at);
}

/** Phase 117 part B: a thread's conversation is forgotten (deleted conversation; the next mail opens a new session). */
export function forgetThread(db: DatabaseSync, bridge: string, chatKey: string, threadId: string): void {
  bridgeDb(db).prepare('DELETE FROM bridge_threads WHERE bridge = ? AND chat_key = ? AND thread_id = ?').run(bridge, chatKey, threadId);
}

export function forgetBridge(db: DatabaseSync, bridge: string): void {
  const d = bridgeDb(db);
  d.prepare('DELETE FROM bridge_threads WHERE bridge = ?').run(bridge);
  d.prepare('DELETE FROM bridge_identities WHERE bridge = ?').run(bridge);
  d.prepare('DELETE FROM bridge_skips WHERE bridge = ?').run(bridge);
  d.prepare('DELETE FROM bridge_windows WHERE bridge = ?').run(bridge);
}

// ------------------------------------------------------------------ Phase 122: the reply window (W4)

export interface BridgeWindow {
  lastInAt: string;
  openUntil: string;
  closedBy: string | null;
}

/** His message at `at` (the platform's timestamp) opens the window for `hours` (only ever moves it forward). */
export function noteWindow(db: DatabaseSync, bridge: string, chatKey: string, at: string, hours: number): void {
  bridgeDb(db);
  const until = new Date(Date.parse(at) + hours * 3600_000).toISOString();
  db.prepare(`INSERT INTO bridge_windows (bridge, chat_key, last_in_at, open_until, closed_by) VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(bridge, chat_key) DO UPDATE SET last_in_at = excluded.last_in_at, open_until = excluded.open_until, closed_by = NULL WHERE excluded.last_in_at > bridge_windows.last_in_at`).run(bridge, chatKey.toLowerCase(), at, until);
}

export function windowOf(db: DatabaseSync, bridge: string, chatKey: string): BridgeWindow | undefined {
  bridgeDb(db);
  const r = db.prepare('SELECT * FROM bridge_windows WHERE bridge = ? AND chat_key = ?').get(bridge, chatKey.toLowerCase()) as Row | undefined;
  return r ? { lastInAt: String(r.last_in_at), openUntil: String(r.open_until), closedBy: (r.closed_by as string | null) ?? null } : undefined;
}

/** Whether she may still send a free-form message to that chat at `now`. */
export function windowOpen(db: DatabaseSync, bridge: string, chatKey: string, now: Date): boolean {
  const w = windowOf(db, bridge, chatKey);
  return Boolean(w && !w.closedBy && Date.parse(w.openUntil) > now.getTime());
}

/** A send proved it closed early (WhatsApp `131047`). */
export function closeWindow(db: DatabaseSync, bridge: string, chatKey: string, by: string, now: Date): void {
  bridgeDb(db);
  db.prepare('UPDATE bridge_windows SET closed_by = ?, open_until = ? WHERE bridge = ? AND chat_key = ?').run(by.slice(0, 20), now.toISOString(), bridge, chatKey.toLowerCase());
}

/** The owner's WhatsApp chat window in this companion's store (the routes' *Send me a test message*). */
export function bridgeWindowOpen(app: { store: { db: DatabaseSync }; now?: () => Date }, chat: string, bridge = 'plugin-whatsapp'): boolean {
  return windowOpen(app.store.db, bridge, chat, app.now?.() ?? new Date());
}
