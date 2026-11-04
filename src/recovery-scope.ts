import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** A database identity travels with backups; filesystem paths must never bind ciphertext. */
export function recoveryScope(db: DatabaseSync): string {
  db.exec('CREATE TABLE IF NOT EXISTS recovery_scope (singleton INTEGER PRIMARY KEY CHECK(singleton=1), scope TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO recovery_scope(singleton,scope) VALUES(1,?)').run(randomUUID());
  const row = db.prepare('SELECT scope FROM recovery_scope WHERE singleton=1').get() as { scope: string };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.scope)) throw new Error('Invalid recovery scope');
  return row.scope;
}
