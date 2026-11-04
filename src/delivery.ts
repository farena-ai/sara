import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import type { Vault } from './vault.ts';
import { Redactor } from './redact.ts';
import { recoveryScope } from './recovery-scope.ts';

export type DeliveryState = 'queued' | 'attempted' | 'acknowledged' | 'failed' | 'outcome_unknown';
export type DeliveryResolution = 'confirmed_received' | 'confirmed_not_received' | 'dismissed';
export interface DeliveryReview {
  text: string;
  attachments?: { name: string; mime?: string; size?: number }[];
}
export interface DeliveryDescriptor {
  bridge: 'telegram' | 'discord';
  operation: string;
  destination: string;
  review?: DeliveryReview;
  logicalKey?: string;
}
export interface DeliveryView {
  id: string;
  bridge: string;
  operation: string;
  state: DeliveryState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  resolution?: DeliveryResolution;
  resolvedAt?: string;
  reviewAvailable: boolean;
  held: boolean;
}
interface Row {
  id: string;
  bridge: string;
  operation: string;
  state: DeliveryState;
  attempts: number;
  created_at: string;
  updated_at: string;
  payload: string | null;
  held: number;
  resolution: DeliveryResolution | null;
  resolved_at: string | null;
}
export class DeliveryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const STATES: DeliveryState[] = ['queued', 'attempted', 'acknowledged', 'failed', 'outcome_unknown'];
const RESOLUTIONS: DeliveryResolution[] = ['confirmed_received', 'confirmed_not_received', 'dismissed'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Per-space evidence only: construction recovers uncertainty but never dispatches work. */
export class DeliveryStore {
  readonly db: DatabaseSync;
  readonly #vault: Vault;
  readonly #scope: string;
  readonly #scrub: (s: string) => string;

  constructor(db: DatabaseSync, vault: Vault, scrub?: (s: string) => string) {
    this.db = db;
    this.#vault = vault;
    this.#scope = recoveryScope(db);
    const redactor = new Redactor(() => vault.values());
    this.#scrub = (s) => {
      let clean = redactor.redact(scrub ? scrub(s) : s);
      // Recovery previews also redact short known secrets, which general prose redaction skips.
      for (const secret of vault.values().filter(Boolean).sort((a, b) => b.length - a.length)) clean = clean.split(secret).join('[REDACTED]');
      return clean;
    };
    db.exec(`CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, bridge TEXT NOT NULL, operation TEXT NOT NULL, destination TEXT NOT NULL,
      logical_key TEXT UNIQUE, nonce TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT, refs TEXT, reason TEXT,
      resolution TEXT, resolved_at TEXT, held INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS deliveries_updated ON deliveries(updated_at);`);
    const columns = db.prepare('PRAGMA table_info(deliveries)').all() as unknown as { name: string }[];
    if (!columns.some(column => column.name === 'held')) db.exec('ALTER TABLE deliveries ADD COLUMN held INTEGER NOT NULL DEFAULT 0');
    this.recoverInterrupted();
  }

  recoverInterrupted(): void {
    this.db.prepare("UPDATE deliveries SET held=1 WHERE state='queued'").run();
    this.db.prepare("UPDATE deliveries SET state='outcome_unknown', reason='interrupted', updated_at=? WHERE state='attempted'").run(new Date().toISOString());
  }

  #context(id: string): string {
    return `delivery:v1:${this.#scope}:${id}`;
  }

  #review(value: DeliveryReview): DeliveryReview {
    if (!value || typeof value.text !== 'string' || value.text.length > 64_000 ||
      (value.attachments && (!Array.isArray(value.attachments) || value.attachments.length > 10))) {
      throw new DeliveryError(400, 'Invalid delivery review');
    }
    const attachments = value.attachments?.map((a) => {
      if (!a || typeof a.name !== 'string' || a.name.length > 255 || /[\\/\x00-\x1f]/.test(a.name) ||
        (a.mime !== undefined && (typeof a.mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(a.mime))) ||
        (a.size !== undefined && (!Number.isSafeInteger(a.size) || a.size < 0))) {
        throw new DeliveryError(400, 'Invalid attachment review');
      }
      return { name: this.#scrub(a.name), ...(a.mime ? { mime: a.mime } : {}), ...(a.size !== undefined ? { size: a.size } : {}) };
    });
    return { text: this.#scrub(value.text), ...(attachments ? { attachments } : {}) };
  }

  enqueue(d: DeliveryDescriptor): { id: string; nonce: string } {
    if (!d || !['telegram', 'discord'].includes(d.bridge) || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(d.operation) ||
      typeof d.destination !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(d.destination) ||
      (d.logicalKey !== undefined && (typeof d.logicalKey !== 'string' || !d.logicalKey || d.logicalKey.length > 256))) {
      throw new DeliveryError(400, 'Invalid delivery descriptor');
    }
    const id = randomUUID();
    const nonce = id.replaceAll('-', '').slice(0, 25);
    const now = new Date().toISOString();
    const payload = d.review ? this.#vault.seal(JSON.stringify(this.#review(d.review)), this.#context(id)) : null;
    // Metadata and encrypted review commit together; failure here precedes queue admission.
    this.db.prepare("INSERT INTO deliveries(id,bridge,operation,destination,logical_key,nonce,state,created_at,updated_at,payload) VALUES(?,?,?,?,?,?,'queued',?,?,?)")
      .run(id, d.bridge, d.operation, d.destination, d.logicalKey ?? null, nonce, now, now, payload);
    return { id, nonce };
  }

  #row(id: string): Row {
    if (typeof id !== 'string' || !UUID.test(id)) throw new DeliveryError(404, 'Delivery not found');
    const row = this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id) as unknown as Row | undefined;
    if (!row) throw new DeliveryError(404, 'Delivery not found');
    return row;
  }

  #transition(id: string, from: DeliveryState[], state: DeliveryState, reason?: string): void {
    this.#row(id);
    const r = this.db.prepare(`UPDATE deliveries SET state=?,updated_at=?,reason=? WHERE id=? AND state IN (${from.map(() => '?').join(',')}) AND resolution IS NULL`)
      .run(state, new Date().toISOString(), reason ?? null, id, ...from);
    if (!r.changes) throw new DeliveryError(409, 'Delivery state changed');
  }

  attempt(id: string): void {
    this.#row(id);
    const r = this.db.prepare("UPDATE deliveries SET state='attempted',attempts=attempts+1,updated_at=? WHERE id=? AND state='queued' AND held=0 AND resolution IS NULL")
      .run(new Date().toISOString(), id);
    if (!r.changes) throw new DeliveryError(409, 'Delivery is held or already attempted');
  }

  rateLimited(id: string): void {
    this.#transition(id, ['attempted'], 'queued', 'rate_limited');
  }

  acknowledge(id: string, refs: string[]): void {
    const row = this.#row(id);
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > 10 || refs.some(r => typeof r !== 'string' || !/^\d{1,24}$/.test(r) || /^0+$/.test(r))) {
      throw new DeliveryError(400, 'Invalid platform acknowledgment');
    }
    const r = this.db.prepare("UPDATE deliveries SET state='acknowledged',refs=?,payload=NULL,updated_at=? WHERE id=? AND state='attempted' AND resolution IS NULL")
      .run(JSON.stringify(refs), new Date().toISOString(), row.id);
    if (!r.changes) throw new DeliveryError(409, 'Delivery state changed');
  }

  fail(id: string, _safeReason = 'rejected'): void {
    this.#transition(id, ['queued', 'attempted'], 'failed', 'platform_rejected');
  }

  unknown(id: string, _safeReason = 'uncertain'): void {
    this.#transition(id, ['attempted'], 'outcome_unknown', 'outcome_uncertain');
  }

  list(limit = 100): DeliveryView[] {
    const n = Number.isSafeInteger(limit) ? Math.max(1, Math.min(200, limit)) : 100;
    const rows = this.db.prepare("SELECT id,bridge,operation,state,attempts,created_at,updated_at,payload IS NOT NULL AS has_payload,resolution,resolved_at,held FROM deliveries ORDER BY (resolution IS NULL AND state!='acknowledged') DESC,updated_at DESC,id DESC LIMIT ?")
      .all(n) as unknown as (Row & { has_payload: number })[];
    return rows.map(r => ({
      id: r.id, bridge: r.bridge, operation: this.#scrub(r.operation), state: r.state, attempts: r.attempts,
      createdAt: r.created_at, updatedAt: r.updated_at, reviewAvailable: Boolean(r.has_payload), held: r.state === 'queued' && Boolean(r.held),
      ...(r.resolution ? { resolution: r.resolution, resolvedAt: r.resolved_at! } : {}),
    }));
  }

  /** Stable keyset paging: resolving a loaded row cannot shift the remaining page boundary. */
  page(options: { filter?: 'unresolved' | 'all'; cursor?: string; limit?: number } = {}): { deliveries: DeliveryView[]; nextCursor: string | null } {
    const filter = options.filter ?? 'unresolved';
    if (filter !== 'unresolved' && filter !== 'all') throw new DeliveryError(400, 'Invalid delivery filter');
    if (options.cursor !== undefined && (!/^[1-9][0-9]{0,15}$/.test(options.cursor) || !Number.isSafeInteger(Number(options.cursor)))) {
      throw new DeliveryError(400, 'Invalid delivery cursor');
    }
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new DeliveryError(400, 'Invalid delivery limit');
    const condition = filter === 'unresolved' ? "AND resolution IS NULL AND state!='acknowledged'" : '';
    const rows = this.db.prepare(`SELECT rowid AS cursor,id,bridge,operation,state,attempts,created_at,updated_at,payload IS NOT NULL AS has_payload,resolution,resolved_at,held
      FROM deliveries WHERE rowid>? ${condition} ORDER BY rowid ASC LIMIT ?`)
      .all(Number(options.cursor ?? 0), limit + 1) as unknown as (Row & { has_payload: number; cursor: number })[];
    const selected = rows.slice(0, limit);
    return {
      deliveries: selected.map(r => ({
        id: r.id, bridge: r.bridge, operation: this.#scrub(r.operation), state: r.state, attempts: r.attempts,
        createdAt: r.created_at, updatedAt: r.updated_at, reviewAvailable: Boolean(r.has_payload), held: r.state === 'queued' && Boolean(r.held),
        ...(r.resolution ? { resolution: r.resolution, resolvedAt: r.resolved_at! } : {}),
      })),
      nextCursor: rows.length > limit ? String(selected.at(-1)!.cursor) : null,
    };
  }

  review(id: string): DeliveryReview {
    const r = this.#row(id);
    if (!r.payload) throw new DeliveryError(409, 'Delivery review is unavailable');
    try {
      return this.#review(JSON.parse(this.#vault.unseal(r.payload, this.#context(id))) as DeliveryReview);
    } catch {
      throw new DeliveryError(409, 'Delivery review is unavailable');
    }
  }

  resolve(id: string, expectedState: DeliveryState, decision: DeliveryResolution): void {
    if (!STATES.includes(expectedState) || !RESOLUTIONS.includes(decision)) throw new DeliveryError(400, 'Invalid delivery resolution');
    const row = this.#row(id);
    if (row.state === 'queued' && !row.held) throw new DeliveryError(409, 'Delivery is still queued to send');
    if (expectedState === 'attempted') throw new DeliveryError(409, 'Delivery is still in flight');
    // Human evidence never rewrites the transport outcome; resolved content no longer needs retention.
    const r = this.db.prepare("UPDATE deliveries SET resolution=?,resolved_at=?,payload=NULL WHERE id=? AND state=? AND resolution IS NULL AND (state!='queued' OR held=1)")
      .run(decision, new Date().toISOString(), id, expectedState);
    if (!r.changes) throw new DeliveryError(409, 'Delivery state changed');
  }
}

const stores = new WeakMap<AppContext['store'], DeliveryStore>();
export function deliveryFor(app: AppContext): DeliveryStore {
  let store = stores.get(app.store);
  if (!store) {
    store = new DeliveryStore(app.store.db, app.vault, s => app.redactor.redact(s));
    stores.set(app.store, store);
  }
  return store;
}
