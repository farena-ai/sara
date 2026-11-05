import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { BusinessProfile } from './profile.ts';

/** Accepted operations retain their admission until every awaited continuation has settled. */
export class BusinessLifecycle {
  readonly #scope = new AsyncLocalStorage<{ active: boolean }>();
  readonly #pending = new Set<Promise<unknown>>();
  #state: 'open' | 'paused' | 'closed' = 'open';
  #staging: Promise<unknown> | undefined;
  get state() { return this.#state; }
  assertAdmission(): void {
    if (this.#state !== 'open' && !this.#scope.getStore()?.active) throw new Error('Business admission is closed.');
  }
  run<T>(operation: () => Promise<T>): Promise<T> {
    try { this.assertAdmission(); } catch (error) { return Promise.reject(error); }
    if (this.#scope.getStore()?.active) return operation();
    const token = { active: true };
    const pending = this.#scope.run(token, async () => operation());
    this.#pending.add(pending);
    void pending.finally(() => { token.active = false; this.#pending.delete(pending); }).catch(() => {});
    return pending;
  }
  async drain(): Promise<void> { while (this.#pending.size) await Promise.allSettled([...this.#pending]); }
  closeAdmission(): void { this.#state = 'closed'; }
  async waitSnapshot(): Promise<void> { await this.#staging?.catch(() => {}); }
  async snapshot<T>(stage: () => Promise<T>): Promise<T> {
    if (this.#state !== 'open' || this.#scope.getStore()?.active) throw new Error('Business snapshot is unavailable.');
    this.#state = 'paused';
    const operation = (async () => { await this.drain(); return stage(); })();
    this.#staging = operation;
    try { return await operation; }
    finally { this.#staging = undefined; if (this.state === 'paused') this.#state = 'open'; }
  }
}

/** SQLite's OS lock is released on process death; no PID guessing or stale-file deletion. */
export interface BusinessWriter { release(): void }
const writers = new WeakMap<BusinessWriter, { root: string; guard?: () => void }>();
export function bindBusinessWriter(writer: BusinessWriter, lifecycle: BusinessLifecycle): void {
  const entry = writers.get(writer); if (!entry) throw new Error('Invalid writer capability.'); entry.guard = () => lifecycle.assertAdmission();
}
export function withBusinessWriter<T>(profile: BusinessProfile, operation: () => T, borrowed?: BusinessWriter): T {
  const writer = borrowed ?? acquireBusinessWriter(profile);
  try {
    const entry = writers.get(writer);
    if (!entry || entry.root !== profile.root) throw new Error('Invalid writer capability.');
    entry.guard?.(); return operation();
  } finally { if (!borrowed) writer.release(); }
}
export function acquireBusinessWriter(profile: BusinessProfile): BusinessWriter {
  const db = new DatabaseSync(join(profile.businessDir, 'writer-fence.db'));
  try { db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;'); }
  catch { db.close(); throw new Error('Business root already has an active writer. Stop its runtime before this operation.'); }
  let released = false;
  const writer = { release() { if (!released) { released = true; writers.delete(writer); try { db.exec('ROLLBACK'); } finally { db.close(); } } } };
  writers.set(writer, { root: profile.root }); return writer;
}
