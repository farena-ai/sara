// Phase 50: the code maps of all workspaces (shared by every companion, like the workspaces). A
// map is opened the first time something asks for it (a code tool, the Map view, a write in that
// workspace) and then kept up to date in the background: after her file tools write, after a job
// finishes, on demand, and with a light look every few minutes while it's in use. Each step works
// for at most ~150 ms and then gives the server back (setImmediate), so a big first index never
// holds up a chat turn; meaning-search vectors are made afterwards, a batch at a time.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { EmbedTarget } from '../embeddings.ts';
import { guard } from '../log.ts';
import { everyJob, type EveryJob } from '../tick-jobs.ts';
import { CodeMapStore, type RunReport } from './store.ts';

/** Longest a single background step may run. */
export const STEP_MS = 150;
/** How long a map stays "in use" (looked at again by the light check) after it was last asked for. */
const IN_USE_MS = 2 * 3600_000;
const CHECK_MS = 3 * 60_000;

export interface CodeMapsOptions {
  /** Where the map databases live (<data>/cache/codemap). */
  cacheDir: string;
  /** The embeddings job (meaning search), when set. */
  target?: () => EmbedTarget | undefined;
  stepMs?: number;
}

export class CodeMaps {
  readonly #opts: CodeMapsOptions;
  readonly #stores = new Map<string, CodeMapStore>();
  readonly #dirty = new Set<string>();
  readonly #used = new Map<string, number>();
  #timer: EveryJob | undefined;
  #pending: NodeJS.Timeout | undefined;
  #busy = false;
  #ctl = new AbortController();

  constructor(opts: CodeMapsOptions) {
    this.#opts = opts;
  }

  get target(): EmbedTarget | undefined {
    try {
      return this.#opts.target?.();
    } catch {
      return undefined;
    }
  }

  static key(dir: string): string {
    try {
      return realpathSync(dir);
    } catch {
      return dir;
    }
  }

  /** The map of a workspace folder (opened, not refreshed). */
  get(dir: string): CodeMapStore {
    const key = CodeMaps.key(dir);
    let s = this.#stores.get(key);
    if (!s) {
      const name = basename(key).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'workspace';
      const tag = createHash('sha1').update(key).digest('hex').slice(0, 8);
      s = new CodeMapStore(key, join(this.#opts.cacheDir, `${name}-${tag}.db`));
      this.#stores.set(key, s);
    }
    this.#used.set(key, Date.now());
    return s;
  }

  /** Something in the workspace may have changed: look again soon. */
  touch(dir: string): void {
    const key = CodeMaps.key(dir);
    // Only maps that exist are kept up to date in the background (others are built when asked).
    if (!this.#stores.has(key)) return;
    this.#dirty.add(key);
    this.#schedule(300);
  }

  /**
   * Brings the map up to date, in steps that give the server back between them, for up to
   * `maxMs`. Returns whether it finished (else the background carries on).
   */
  async until(dir: string, maxMs = 8000): Promise<{ store: CodeMapStore; done: boolean; report?: RunReport }> {
    const store = this.get(dir);
    const t0 = Date.now();
    let report: RunReport | undefined;
    while (Date.now() - t0 < maxMs) {
      report = store.refresh(Math.min(this.#opts.stepMs ?? STEP_MS, Math.max(10, maxMs - (Date.now() - t0))));
      if (report.done) {
        this.#dirty.delete(CodeMaps.key(dir));
        this.#schedule(50); // vectors for what changed
        return { store, done: true, report };
      }
      await new Promise((r) => setImmediate(r));
    }
    this.#dirty.add(CodeMaps.key(dir));
    this.#schedule(50);
    return { store, done: false, report };
  }

  #schedule(ms: number): void {
    if (this.#pending) return;
    this.#pending = setTimeout(() => {
      this.#pending = undefined;
      void guard('codemap', () => this.tick());
    }, ms);
    this.#pending.unref?.();
  }

  /** One background round: a step for each workspace that changed, then a batch of vectors. */
  async tick(): Promise<boolean> {
    if (this.#busy) return false;
    this.#busy = true;
    let more = false;
    try {
      for (const key of [...this.#dirty]) {
        const s = this.#stores.get(key);
        if (!s) {
          this.#dirty.delete(key);
          continue;
        }
        const r = s.refresh(this.#opts.stepMs ?? STEP_MS);
        if (r.done) this.#dirty.delete(key);
        else more = true;
        await new Promise((r2) => setImmediate(r2));
      }
      const target = this.target;
      if (target) {
        for (const s of this.#stores.values()) {
          if (s.building) continue;
          const n = await s.indexVectors(target, 32, this.#ctl.signal).catch(() => 0);
          if (n) {
            more = true;
            break;
          }
        }
      }
    } finally {
      this.#busy = false;
    }
    if (more) this.#schedule(this.#dirty.size ? 20 : 500);
    return more;
  }

  start(): void {
    this.#timer = everyJob('code maps', CHECK_MS, () => {
      const now = Date.now();
      for (const [key, at] of this.#used) if (now - at < IN_USE_MS && this.#stores.has(key)) this.#dirty.add(key);
      if (this.#dirty.size) this.#schedule(10);
    });
  }

  stop(): void {
    this.#timer?.stop();
    clearTimeout(this.#pending);
    this.#pending = undefined;
    this.#ctl.abort();
    this.#ctl = new AbortController();
  }

  close(): void {
    this.stop();
    for (const s of this.#stores.values()) s.close();
    this.#stores.clear();
  }

  /** Workspaces with an open map (for tests and the health page). */
  open(): string[] {
    return [...this.#stores.keys()];
  }
}
