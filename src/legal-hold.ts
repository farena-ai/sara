// EC17 (docs/ops/EC1617_DESIGN.md): the bottom layer of a legal hold. While a space is held its
// database carries a `sara_legal_hold` row and BEFORE DELETE triggers refuse deletes of chats,
// messages, memories and library files, whatever code path issues them. File and folder deletes
// (photos, a member's whole space, audit pruning) ask `heldDir()` / `anyHold()` first. Imports only
// i18n's en() marker, so the stores can use it without cycles; src/data-rights.ts owns the policy.
import type { DatabaseSync } from 'node:sqlite';
import { en } from './i18n.ts';

export const LEGAL_HOLD_ERROR = 'SARA_LEGAL_HOLD';
/** Tables whose rows a hold protects (data kinds: chats, memories, files). */
export const HELD_TABLES = ['conversations', 'messages', 'memories', 'library_docs'] as const;

export class LegalHoldError extends Error {
  readonly status = 409;
  constructor() {
    super(en('This data is under a legal hold. Release the hold first (Settings → Household → Retention and legal hold).'));
  }
}
/** True for our own error and for the trigger's RAISE coming back from SQLite. */
export function isLegalHold(err: unknown): boolean {
  return err instanceof LegalHoldError || String((err as Error)?.message ?? '').includes(LEGAL_HOLD_ERROR);
}

/** Creates the hold table and a trigger on every protected table that exists in this database. */
export function installHold(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS sara_legal_hold (scope TEXT PRIMARY KEY, since TEXT NOT NULL)');
  for (const table of HELD_TABLES) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    db.exec(`CREATE TRIGGER IF NOT EXISTS sara_hold_${table} BEFORE DELETE ON ${table} WHEN EXISTS (SELECT 1 FROM sara_legal_hold) BEGIN SELECT RAISE(ABORT, '${LEGAL_HOLD_ERROR}'); END;`);
  }
}
/** Puts this database under hold (or releases it). Installs the triggers first. */
export function setDbHold(db: DatabaseSync, on: boolean, now = new Date()): void {
  installHold(db);
  if (on) db.prepare("INSERT OR IGNORE INTO sara_legal_hold (scope, since) VALUES ('space', ?)").run(now.toISOString());
  else db.exec('DELETE FROM sara_legal_hold');
}
export function dbHeld(db: DatabaseSync): boolean {
  try {
    return Boolean(db.prepare('SELECT 1 FROM sara_legal_hold LIMIT 1').get());
  } catch {
    return false; // No table yet: never held.
  }
}
/** The first line of every delete primitive: refuse before anything is touched. */
export function assertNotHeld(db: DatabaseSync): void {
  if (dbHeld(db)) throw new LegalHoldError();
}

// ---- folder-level answers, set by src/data-rights.ts (unset = nothing is held) ----
let resolver: { held: (dir: string) => boolean; any: () => boolean } = { held: () => false, any: () => false };
export function setHoldResolver(r: typeof resolver | undefined): void {
  resolver = r ?? { held: () => false, any: () => false };
}
export function heldDir(dir: string): boolean {
  return resolver.held(dir);
}
/** Any hold at all (whole instance or one person): audit pruning stops. */
export function anyHold(): boolean {
  return resolver.any();
}
export function assertDirNotHeld(dir: string): void {
  if (heldDir(dir)) throw new LegalHoldError();
}
