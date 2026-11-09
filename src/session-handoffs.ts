// Pure SQLite storage. App identity and source eligibility belong to session-continuity.
import type { DatabaseSync } from 'node:sqlite';

export interface SessionHandoffHeader {
  id: number; sourceConversationId: string; targetConversationId: string;
  sourceThroughMessageId: number; sourceWorkspace: string; targetWorkspace: string;
  sourceDialogueEpoch: number; createdAt: string; expiresAt: string;
}
export interface SessionHandoff extends SessionHandoffHeader { text: string }
export type SessionHandoffInput = Omit<SessionHandoff, 'id' | 'createdAt' | 'expiresAt'>;
type Row = Record<string, string | number>;
const HEADER_COLUMNS = 'id,source_conversation_id,target_conversation_id,source_through_message_id,source_workspace,target_workspace,source_dialogue_epoch,created_at,expires_at';
function header(r: Row): SessionHandoffHeader {
  return { id: Number(r.id), sourceConversationId: String(r.source_conversation_id), targetConversationId: String(r.target_conversation_id), sourceThroughMessageId: Number(r.source_through_message_id), sourceWorkspace: String(r.source_workspace), targetWorkspace: String(r.target_workspace), sourceDialogueEpoch: Number(r.source_dialogue_epoch), createdAt: String(r.created_at), expiresAt: String(r.expires_at) };
}

/** Called only by ordinary Store setup, after conversation and epoch migrations. */
export function installSessionHandoffSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    target_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    source_through_message_id INTEGER NOT NULL,
    source_workspace TEXT NOT NULL, target_workspace TEXT NOT NULL,
    source_dialogue_epoch INTEGER NOT NULL,
    text TEXT NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 600),
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    CHECK(source_conversation_id <> target_conversation_id)
  );
  CREATE INDEX IF NOT EXISTS session_handoffs_target ON session_handoffs(target_conversation_id,id DESC);
  CREATE INDEX IF NOT EXISTS session_handoffs_pair ON session_handoffs(source_conversation_id,target_conversation_id,id DESC);
  CREATE TRIGGER IF NOT EXISTS session_handoffs_scope AFTER UPDATE OF workspace,private,channel,channel_key,partner,archived_at,ended_at ON conversations
  WHEN OLD.workspace IS NOT NEW.workspace OR OLD.private IS NOT NEW.private OR OLD.channel IS NOT NEW.channel
    OR OLD.channel_key IS NOT NEW.channel_key OR OLD.partner IS NOT NEW.partner OR OLD.archived_at IS NOT NEW.archived_at OR OLD.ended_at IS NOT NEW.ended_at
  BEGIN DELETE FROM session_handoffs WHERE source_conversation_id=OLD.id OR target_conversation_id=OLD.id; END;
  CREATE TRIGGER IF NOT EXISTS session_handoffs_epoch AFTER UPDATE OF dialogue_epoch ON conversations
  WHEN OLD.dialogue_epoch IS NOT NEW.dialogue_epoch
  BEGIN DELETE FROM session_handoffs WHERE source_conversation_id=OLD.id; END;`);
  installSessionRoomInvalidation(db);
}

/** B3 creates its table lazily; install only after it exists, never from an R1 read. */
export function installSessionRoomInvalidation(db: DatabaseSync): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rooms'").get()) return;
  const matching = (row: 'OLD' | 'NEW'): string => `SELECT id FROM conversations WHERE channel_key=${row}.key
    AND (channel=${row}.bridge OR channel=${row}.bridge||'-nsfw')`;
  const erase = (row: 'OLD' | 'NEW'): string => `DELETE FROM session_handoffs WHERE source_conversation_id IN (${matching(row)}) OR target_conversation_id IN (${matching(row)});`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS session_handoffs_room_insert AFTER INSERT ON rooms
    WHEN NEW.kind<>'dm' OR NEW.adult<>0 BEGIN ${erase('NEW')} END;
    CREATE TRIGGER IF NOT EXISTS session_handoffs_room_update AFTER UPDATE OF bridge,key,kind,adult ON rooms
    WHEN OLD.bridge IS NOT NEW.bridge OR OLD.key IS NOT NEW.key OR OLD.kind IS NOT NEW.kind OR OLD.adult IS NOT NEW.adult
    BEGIN ${erase('OLD')} ${erase('NEW')} END;
    CREATE TRIGGER IF NOT EXISTS session_handoffs_room_delete AFTER DELETE ON rooms BEGIN ${erase('OLD')} END;`);
}

/** Construction and reads are deliberately schema-free and read-only. */
export class SessionHandoffStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) { this.#db = db; }
  transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  headers(targetId?: string): SessionHandoffHeader[] {
    return (this.#db.prepare(`SELECT ${HEADER_COLUMNS} FROM session_handoffs ${targetId === undefined ? '' : 'WHERE target_conversation_id=?'} ORDER BY id DESC`).all(...(targetId === undefined ? [] : [targetId])) as Row[]).map(header);
  }
  read(id: number): SessionHandoff | undefined {
    const row = this.#db.prepare(`SELECT ${HEADER_COLUMNS},text FROM session_handoffs WHERE id=?`).get(id) as Row | undefined;
    return row ? { ...header(row), text: String(row.text) } : undefined;
  }
  insert(input: SessionHandoffInput, now: Date): SessionHandoff {
    const createdAt = now.toISOString(); const expiresAt = new Date(now.getTime() + 86400000).toISOString();
    const id = Number(this.#db.prepare(`INSERT INTO session_handoffs (source_conversation_id,target_conversation_id,source_through_message_id,source_workspace,target_workspace,source_dialogue_epoch,text,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(input.sourceConversationId, input.targetConversationId, input.sourceThroughMessageId, input.sourceWorkspace, input.targetWorkspace, input.sourceDialogueEpoch, input.text, createdAt, expiresAt).lastInsertRowid);
    this.#db.prepare('DELETE FROM session_handoffs WHERE julianday(expires_at)<=julianday(?) OR julianday(created_at) IS NULL OR julianday(expires_at) IS NULL OR julianday(created_at)>julianday(?)').run(createdAt, createdAt);
    this.#db.exec(`DELETE FROM session_handoffs WHERE id IN (SELECT id FROM (SELECT id,ROW_NUMBER() OVER (PARTITION BY source_conversation_id,target_conversation_id ORDER BY id DESC) AS position FROM session_handoffs) WHERE position>5);
      DELETE FROM session_handoffs WHERE id NOT IN (SELECT id FROM session_handoffs ORDER BY id DESC LIMIT 100);`);
    return { ...input, id, createdAt, expiresAt };
  }
  deleteTarget(targetId: string): void { this.#db.prepare('DELETE FROM session_handoffs WHERE target_conversation_id=?').run(targetId); }
}
