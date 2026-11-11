// Feature 4 (works offline): what a device wrote without a connection waits in its outbox and is
// sent when the server answers again. Each outbox item has its own key (`clientKey`); the server
// stores it with the message (or remembers it for a note) so a reconnect, a retry after a cut
// connection or two open tabs never store the same thing twice.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './http.ts';

const KEY = /^[A-Za-z0-9_-]{8,80}$/;

/** The outbox key from a request body: undefined when none was sent; a 400 when it isn't one. */
export function cleanClientKey(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !KEY.test(v)) throw new HttpError(400, 'That outbox key is not valid.');
  return v;
}

/** The id of the user message already stored in this chat with this key, if any. */
export function messageWithKey(db: DatabaseSync, conversationId: string, key: string): number | undefined {
  const r = db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' AND meta IS NOT NULL AND json_extract(meta, '$.clientKey') = ? ORDER BY id LIMIT 1").get(conversationId, key) as { id: number } | undefined;
  return r ? Number(r.id) : undefined;
}

/**
 * Keys being sent right now (in this process): a second request with the same key while the first
 * hasn't stored its message yet is told to wait (409), never run a second time.
 */
export class InFlightKeys {
  #keys = new Set<string>();
  /** A release function, or undefined when the key is already being sent. */
  hold(scope: string, key: string): (() => void) | undefined {
    const k = `${scope}\n${key}`;
    if (this.#keys.has(k)) return undefined;
    this.#keys.add(k);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#keys.delete(k);
    };
  }
}

/** Keys of things that aren't messages (notes added offline): the result is remembered for 30 days. */
export class ClientKeys {
  #db: DatabaseSync;
  #now: () => Date;
  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec('CREATE TABLE IF NOT EXISTS client_keys (scope TEXT NOT NULL, key TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (scope, key))');
  }
  /** What a key's first request answered, if it was seen before. */
  seen(scope: string, key: string): unknown {
    const r = this.#db.prepare('SELECT result FROM client_keys WHERE scope = ? AND key = ?').get(scope, key) as { result: string } | undefined;
    return r ? JSON.parse(r.result) : undefined;
  }
  remember(scope: string, key: string, result: unknown): void {
    const now = this.#now();
    this.#db.prepare('INSERT OR IGNORE INTO client_keys (scope, key, result, at) VALUES (?, ?, ?, ?)').run(scope, key, JSON.stringify(result), now.toISOString());
    this.#db.prepare('DELETE FROM client_keys WHERE at < ?').run(new Date(now.getTime() - 30 * 86_400_000).toISOString());
  }
}

/**
 * A random id for this server (made once, kept in its data folder): a page keeps its offline copy
 * per server and drops it when the same address answers with another server (a fresh install).
 */
const serverIds = new Map<string, string>();
export function serverIdOf(dir: string): string {
  const known = serverIds.get(dir);
  if (known) return known;
  const id = readOrMakeId(dir);
  serverIds.set(dir, id);
  return id;
}
function readOrMakeId(dir: string): string {
  const file = join(dir, 'offline-id.txt');
  try {
    if (existsSync(file)) {
      const id = readFileSync(file, 'utf8').trim();
      if (/^[a-f0-9]{16,64}$/.test(id)) return id;
    }
    const id = randomBytes(12).toString('hex');
    writeFileSync(file, `${id}\n`, { mode: 0o600 });
    return id;
  } catch {
    return 'unknown-server';
  }
}
