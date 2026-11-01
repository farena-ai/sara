// Phase 115 (BR1 B2): the send pacer. One outgoing queue per bridge and chat with three priorities:
// her reply and approvals first, then files, then progress edits (docs/design/BRIDGES2.md §3.1 B2).
// It honours a platform's 429 (`retry_after`) and Discord's X-RateLimit headers by pausing that
// chat's queue, and it coalesces progress edits: only the newest text of one progress message is
// sent; an edit that was replaced before its turn is dropped. A burst of edits can therefore never
// delay her answer or earn the bot a block.

/** Her reply, approvals, command answers. */
export const PRIO_REPLY = 0;
/** Pictures and files. */
export const PRIO_FILE = 1;
/** Progress edits (coalesced by slot). */
export const PRIO_EDIT = 2;
export type Priority = typeof PRIO_REPLY | typeof PRIO_FILE | typeof PRIO_EDIT;

/** A platform said "too many requests": wait `retryAfterMs`, then try again. */
export class RateLimited extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, message = 'rate limited') {
    super(message);
    this.retryAfterMs = Math.max(0, Math.min(retryAfterMs, 10 * 60_000));
  }
}

/** Time, injectable (tests drive a fake clock). */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};
export const sleepOn = (clock: Clock, ms: number): Promise<void> => new Promise((r) => (ms <= 0 ? r() : void clock.setTimeout(r, ms)));

interface Item {
  prio: Priority;
  seq: number;
  slot?: string;
  fn: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  attempts: number;
}

interface Lane {
  items: Item[];
  running: boolean;
  pausedUntil: number;
}

/** Attempts per item when the platform keeps answering 429 (edits give up sooner). */
const MAX_TRIES: Record<Priority, number> = { 0: 4, 1: 3, 2: 2 };

export class SendQueue {
  readonly #lanes = new Map<string, Lane>();
  readonly #clock: Clock;
  #seq = 0;
  /** Every send in the order it went out (key, priority, slot): tests read it. */
  readonly sent: { key: string; prio: Priority; slot?: string }[] = [];

  constructor(o: { clock?: Clock } = {}) {
    this.#clock = o.clock ?? realClock;
  }

  get clock(): Clock {
    return this.#clock;
  }

  /** Pauses a chat's queue (a 429, or a bucket with no requests left until it resets). */
  pause(key: string, ms: number): void {
    const lane = this.#lane(key);
    lane.pausedUntil = Math.max(lane.pausedUntil, this.#clock.now() + ms);
  }

  /** Waiting items per chat (for tests and the status line). */
  waiting(key: string): number {
    return this.#lanes.get(key)?.items.length ?? 0;
  }

  /**
   * Queues one call. With a `slot` (one progress message), a waiting call for the same slot is
   * replaced: its promise resolves `undefined` and only the newest one is sent.
   */
  send<T>(key: string, prio: Priority, fn: () => Promise<T>, slot?: string): Promise<T | undefined> {
    const lane = this.#lane(key);
    if (slot) {
      const old = lane.items.find((i) => i.slot === slot && i.attempts === 0);
      if (old) {
        lane.items.splice(lane.items.indexOf(old), 1);
        old.resolve(undefined);
      }
    }
    const p = new Promise<T | undefined>((resolve, reject) => {
      lane.items.push({ prio, seq: this.#seq++, ...(slot ? { slot } : {}), fn, resolve: resolve as (v: unknown) => void, reject, attempts: 0 });
    });
    if (!lane.running) void this.#drain(key, lane);
    return p;
  }

  #lane(key: string): Lane {
    let lane = this.#lanes.get(key);
    if (!lane) {
      lane = { items: [], running: false, pausedUntil: 0 };
      this.#lanes.set(key, lane);
    }
    return lane;
  }

  async #drain(key: string, lane: Lane): Promise<void> {
    lane.running = true;
    try {
      while (lane.items.length) {
        const wait = lane.pausedUntil - this.#clock.now();
        if (wait > 0) {
          await sleepOn(this.#clock, wait);
          continue;
        }
        lane.items.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
        const item = lane.items[0];
        item.attempts++;
        try {
          const v = await item.fn();
          lane.items.splice(lane.items.indexOf(item), 1);
          this.sent.push({ key, prio: item.prio, ...(item.slot ? { slot: item.slot } : {}) });
          item.resolve(v);
        } catch (err) {
          if (err instanceof RateLimited && item.attempts < MAX_TRIES[item.prio]) {
            this.pause(key, err.retryAfterMs);
            continue;
          }
          lane.items.splice(lane.items.indexOf(item), 1);
          if (err instanceof RateLimited) this.pause(key, err.retryAfterMs);
          item.reject(err);
        }
      }
    } finally {
      lane.running = false;
      if (lane.items.length) void this.#drain(key, lane);
      else if (lane.pausedUntil <= this.#clock.now()) this.#lanes.delete(key);
    }
  }
}
