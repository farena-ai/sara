// W3.3 team workspace (docs/design/W3_TEAM.md): tables only, no imports, so the access policy can ask
// "is this person a guest?" without an import cycle. Control tables live in the business control
// database; the team inbox and approvals live in each workspace's own content database.
import type { DatabaseSync } from 'node:sqlite';

export function installTeamControl(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS business_team_guests (identity_id TEXT PRIMARY KEY, since INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS business_team_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
}

/** A guest is an organization user who may only read the workspaces they were added to. */
export function teamGuest(db: DatabaseSync, identityId: string): boolean {
  try { return Boolean(db.prepare('SELECT 1 FROM business_team_guests WHERE identity_id=?').get(identityId)); }
  catch { return false; }
}

export function installTeamContent(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS team_inbox (id TEXT PRIMARY KEY, subject TEXT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL,
      added_by TEXT NOT NULL, added_at TEXT NOT NULL, assignee_id TEXT, status TEXT NOT NULL CHECK(status IN ('open','done')), updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS team_replies (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, body TEXT NOT NULL, author_id TEXT NOT NULL, created_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','approved','refused','sent')), approval_id TEXT, decided_by TEXT, decided_at TEXT, sent_by TEXT, sent_at TEXT);
    CREATE INDEX IF NOT EXISTS team_replies_item ON team_replies(item_id, created_at);
    CREATE TABLE IF NOT EXISTS team_approvals (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('spend','reply')), title TEXT NOT NULL, amount_cents INTEGER,
      ref_id TEXT, requested_by TEXT NOT NULL, requested_at TEXT NOT NULL, needs TEXT NOT NULL CHECK(needs IN ('manager','admin')),
      status TEXT NOT NULL CHECK(status IN ('pending','approved','refused')), decided_by TEXT, decided_at TEXT);`);
}
