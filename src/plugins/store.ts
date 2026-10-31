// Phase 98 (ST3, docs/design/STAPLES.md §6.9): the plugin tables, in the owner's database
// (additive: CREATE TABLE IF NOT EXISTS). `plugins` pins what the owner approved (the content hash
// and the permission ids); `plugin_log` keeps what each plugin did, scrubbed and cut to 2 KB, for 30
// days; `plugin_kv` is each plugin's own small store; `budget_ledger` counts a plugin's model use
// per day (source = 'plugin:<id>', §2.1.5).
import type { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY, version TEXT NOT NULL, name TEXT NOT NULL, dir TEXT NOT NULL,
  manifest TEXT NOT NULL, sha TEXT NOT NULL, origin TEXT,
  approved_sha TEXT NOT NULL, approved_permissions TEXT NOT NULL, approved_at TEXT NOT NULL,
  fenced TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'installed',
  prev_version TEXT
);
CREATE TABLE IF NOT EXISTS plugin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, plugin TEXT NOT NULL, companion TEXT, at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plugin_log_by ON plugin_log(plugin, id);
CREATE TABLE IF NOT EXISTS plugin_kv (
  plugin TEXT NOT NULL, companion TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (plugin, companion, key)
);
CREATE TABLE IF NOT EXISTS budget_ledger (
  day TEXT NOT NULL, source TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source)
);
`;

export type PluginStatus = 'installed' | 'disabled' | 'crashed' | 'removed';
export type LogKind = 'hook' | 'tool' | 'call' | 'denied' | 'crash' | 'timeout' | 'log';

export interface PluginRow {
  id: string;
  version: string;
  name: string;
  dir: string;
  manifest: string;
  sha: string;
  origin: string | null;
  approved_sha: string;
  approved_permissions: string;
  approved_at: string;
  fenced: string;
  status: PluginStatus;
  prev_version: string | null;
  /** Why it was switched off (an additive column: "changed on disk", "crashed 3 times"). */
  status_note?: string | null;
}

export interface LogRow {
  id: number;
  plugin: string;
  companion: string | null;
  at: string;
  kind: LogKind;
  detail: string;
}

const KV_MAX_KEYS = 200;
export const KV_MAX_VALUE = 64 * 1024;

export class PluginStore {
  readonly db: DatabaseSync;
  readonly now: () => Date;
  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
    db.exec(SCHEMA);
    const cols = (db.prepare('PRAGMA table_info(plugins)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('status_note')) db.exec('ALTER TABLE plugins ADD COLUMN status_note TEXT');
  }

  all(): PluginRow[] {
    return this.db.prepare("SELECT * FROM plugins WHERE status != 'removed' ORDER BY name COLLATE NOCASE").all() as unknown as PluginRow[];
  }
  get(id: string): PluginRow | undefined {
    const r = this.db.prepare("SELECT * FROM plugins WHERE id = ? AND status != 'removed'").get(id) as unknown as PluginRow | undefined;
    return r ?? undefined;
  }
  upsert(r: Omit<PluginRow, 'status_note'> & { status_note?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO plugins (id, version, name, dir, manifest, sha, origin, approved_sha, approved_permissions, approved_at, fenced, status, prev_version, status_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET version = excluded.version, name = excluded.name, dir = excluded.dir, manifest = excluded.manifest, sha = excluded.sha, origin = excluded.origin,
           approved_sha = excluded.approved_sha, approved_permissions = excluded.approved_permissions, approved_at = excluded.approved_at, fenced = excluded.fenced, status = excluded.status,
           prev_version = excluded.prev_version, status_note = excluded.status_note`,
      )
      .run(r.id, r.version, r.name, r.dir, r.manifest, r.sha, r.origin, r.approved_sha, r.approved_permissions, r.approved_at, r.fenced, r.status, r.prev_version, r.status_note ?? null);
  }
  setStatus(id: string, status: PluginStatus, note: string | null = null): void {
    this.db.prepare('UPDATE plugins SET status = ?, status_note = ? WHERE id = ?').run(status, note, id);
  }
  delete(id: string): void {
    this.db.prepare('DELETE FROM plugins WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM plugin_kv WHERE plugin = ?').run(id);
  }

  log(plugin: string, companion: string | null, kind: LogKind, detail: string): void {
    this.db.prepare('INSERT INTO plugin_log (plugin, companion, at, kind, detail) VALUES (?, ?, ?, ?, ?)').run(plugin, companion, this.now().toISOString(), kind, detail.slice(0, 2048));
  }
  logs(plugin: string, limit = 100): LogRow[] {
    return this.db.prepare('SELECT * FROM plugin_log WHERE plugin = ? ORDER BY id DESC LIMIT ?').all(plugin, Math.max(1, Math.min(500, limit))) as unknown as LogRow[];
  }
  lastLog(plugin: string): LogRow | undefined {
    return (this.db.prepare("SELECT * FROM plugin_log WHERE plugin = ? AND kind != 'log' ORDER BY id DESC LIMIT 1").get(plugin) as unknown as LogRow | undefined) ?? undefined;
  }
  /** Log rows older than 30 days go. */
  prune(): number {
    const cutoff = new Date(this.now().getTime() - 30 * 86_400_000).toISOString();
    return Number(this.db.prepare('DELETE FROM plugin_log WHERE at < ?').run(cutoff).changes);
  }

  kvGet(plugin: string, companion: string, key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM plugin_kv WHERE plugin = ? AND companion = ? AND key = ?').get(plugin, companion, key) as { value: string } | undefined;
    return r?.value;
  }
  kvSet(plugin: string, companion: string, key: string, value: string | undefined): void {
    if (value === undefined) {
      this.db.prepare('DELETE FROM plugin_kv WHERE plugin = ? AND companion = ? AND key = ?').run(plugin, companion, key);
      return;
    }
    if (value.length > KV_MAX_VALUE) throw new Error('kv: a value is at most 64 KB');
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM plugin_kv WHERE plugin = ? AND companion = ?').get(plugin, companion) as { n: number }).n;
    if (n >= KV_MAX_KEYS && this.kvGet(plugin, companion, key) === undefined) throw new Error('kv: at most 200 keys');
    this.db.prepare('INSERT INTO plugin_kv (plugin, companion, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(plugin, companion, key) DO UPDATE SET value = excluded.value').run(plugin, companion, key, value);
  }

  ledger(day: string, source: string): { tokens: number; usd: number; runs: number } {
    const r = this.db.prepare('SELECT tokens, usd, runs FROM budget_ledger WHERE day = ? AND source = ?').get(day, source) as { tokens: number; usd: number; runs: number } | undefined;
    return r ?? { tokens: 0, usd: 0, runs: 0 };
  }
  addLedger(day: string, source: string, add: { tokens?: number; usd?: number; runs?: number }): void {
    this.db
      .prepare('INSERT INTO budget_ledger (day, source, tokens, usd, runs) VALUES (?, ?, ?, ?, ?) ON CONFLICT(day, source) DO UPDATE SET tokens = tokens + excluded.tokens, usd = usd + excluded.usd, runs = runs + excluded.runs')
      .run(day, source, Math.round(add.tokens ?? 0), add.usd ?? 0, add.runs ?? 0);
  }
}
