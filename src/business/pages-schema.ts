// C16 (docs/ops/C16_DESIGN.md): team page tables inside each workspace content database, plus the
// workspace legal hold. The hold reuses the EC17 bottom layer's table name and error marker
// (src/legal-hold.ts), so a hold is enforced by BEFORE DELETE triggers whatever code path deletes.
import type { DatabaseSync } from 'node:sqlite';
import { EDIT_HISTORY_ERROR, LEGAL_HOLD_ERROR } from '../legal-hold.ts';

/** Workspace content a hold protects from deletion. */
export const HELD_CONTENT = ['pages', 'page_versions', 'page_comments', 'conversations', 'messages', 'documents', 'uploads', 'memories', 'citations'] as const;

export function installPages(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, author_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT, revision INTEGER NOT NULL CHECK(revision>=1));
    CREATE TABLE IF NOT EXISTS page_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, page_id TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, editor_id TEXT, edited_at TEXT NOT NULL, UNIQUE(page_id, revision));
    CREATE TABLE IF NOT EXISTS page_comments (id TEXT PRIMARY KEY, page_id TEXT NOT NULL, parent_id TEXT, author_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT);
    CREATE INDEX IF NOT EXISTS page_comments_page ON page_comments(page_id, created_at, id);
    CREATE TABLE IF NOT EXISTS page_mentions (id TEXT PRIMARY KEY, identity_id TEXT NOT NULL, page_id TEXT NOT NULL, comment_id TEXT NOT NULL, by_id TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT);
    CREATE INDEX IF NOT EXISTS page_mentions_person ON page_mentions(identity_id, created_at);
    CREATE TABLE IF NOT EXISTS sara_legal_hold (scope TEXT PRIMARY KEY, since TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS page_versions_append BEFORE UPDATE ON page_versions
      WHEN NEW.page_id IS NOT OLD.page_id OR NEW.revision IS NOT OLD.revision OR NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body OR NEW.edited_at IS NOT OLD.edited_at OR (NEW.editor_id IS NOT NULL AND NEW.editor_id IS NOT OLD.editor_id)
      BEGIN SELECT RAISE(ABORT, '${EDIT_HISTORY_ERROR}'); END;`);
  for (const table of HELD_CONTENT) db.exec(`CREATE TRIGGER IF NOT EXISTS sara_hold_${table} BEFORE DELETE ON ${table} WHEN EXISTS (SELECT 1 FROM sara_legal_hold) BEGIN SELECT RAISE(ABORT, '${LEGAL_HOLD_ERROR}'); END;`);
}
export function contentHeld(db: DatabaseSync): boolean {
  return Boolean(db.prepare('SELECT 1 FROM sara_legal_hold LIMIT 1').get());
}
