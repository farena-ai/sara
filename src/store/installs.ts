// Phase 124 (2.57.0, SARA_STORE.md §12.1): what the owner installed from the Sara Store, in his own
// sara.db (additive tables, CREATE TABLE IF NOT EXISTS like src/plugins/store.ts). 2.57 fills
// store_installs from a .zip whose content hash matches a verified store entry; 2.58's installs add
// rows of their own. store_submissions is created now and used by Phase 125's *Submit yours*.
import type { DatabaseSync } from 'node:sqlite';

export type InstallState = 'ok' | 'yanked' | 'blocked' | 'removed-from-store';
export interface StoreInstallRow {
  item: string;
  kind: 'plugin' | 'skill' | 'mcp';
  version: string;
  trust: string;
  local_ref: string;
  content_sha: string | null;
  entry_sha: string;
  recipe: string | null;
  prev_recipe: string | null;
  installed_at: string;
  updated_at: string;
  state: InstallState;
  state_note: string | null;
}

export function ensureStoreTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS store_installs (
    item TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    version TEXT NOT NULL,
    trust TEXT NOT NULL,
    local_ref TEXT NOT NULL,
    content_sha TEXT,
    entry_sha TEXT NOT NULL,
    recipe TEXT,
    prev_recipe TEXT,
    installed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ok',
    state_note TEXT
  );
  CREATE TABLE IF NOT EXISTS store_submissions (
    submission TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    item TEXT NOT NULL, kind TEXT NOT NULL, version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'uploading',
    messages TEXT NOT NULL DEFAULT '[]',
    checked_at TEXT
  );`);
}

export class StoreInstalls {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    ensureStoreTables(db);
  }
  all(): StoreInstallRow[] {
    return this.db.prepare('SELECT * FROM store_installs ORDER BY item').all() as unknown as StoreInstallRow[];
  }
  get(item: string): StoreInstallRow | undefined {
    return this.db.prepare('SELECT * FROM store_installs WHERE item = ?').get(item) as unknown as StoreInstallRow | undefined;
  }
  byRef(kind: string, ref: string): StoreInstallRow | undefined {
    return this.db.prepare('SELECT * FROM store_installs WHERE kind = ? AND local_ref = ?').get(kind, ref) as unknown as StoreInstallRow | undefined;
  }
  upsert(r: Omit<StoreInstallRow, 'state' | 'state_note' | 'recipe' | 'prev_recipe'> & Partial<Pick<StoreInstallRow, 'state' | 'state_note' | 'recipe' | 'prev_recipe'>>): void {
    this.db
      .prepare(
        `INSERT INTO store_installs (item, kind, version, trust, local_ref, content_sha, entry_sha, recipe, prev_recipe, installed_at, updated_at, state, state_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item) DO UPDATE SET kind = excluded.kind, version = excluded.version, trust = excluded.trust, local_ref = excluded.local_ref,
           content_sha = excluded.content_sha, entry_sha = excluded.entry_sha, recipe = excluded.recipe, prev_recipe = excluded.prev_recipe,
           updated_at = excluded.updated_at, state = excluded.state, state_note = excluded.state_note`,
      )
      .run(r.item, r.kind, r.version, r.trust, r.local_ref, r.content_sha, r.entry_sha, r.recipe ?? null, r.prev_recipe ?? null, r.installed_at, r.updated_at, r.state ?? 'ok', r.state_note ?? null);
  }
  setState(item: string, state: InstallState, note: string | null, at: string): void {
    this.db.prepare('UPDATE store_installs SET state = ?, state_note = ?, updated_at = ? WHERE item = ?').run(state, note, at, item);
  }
  delete(item: string): void {
    this.db.prepare('DELETE FROM store_installs WHERE item = ?').run(item);
  }
}
