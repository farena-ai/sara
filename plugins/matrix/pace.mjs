// The pace per room (docs/design/BRIDGES4.md §6.10): bursts of at most 5, then about one message a
// second, in order. A `429 M_LIMIT_EXCEEDED` waits what the server says (Retry-After, else the
// deprecated retry_after_ms, else 5 s) and the same message is sent again; nothing is dropped and
// the order is kept. Across Matrix at most 600 sends an hour and 3,000 a day, so a loop stops
// itself. Typing and receipts are not paced (they are not messages).

export const EVERY_MS = 1_000;
export const BURST = 5;
export const PER_HOUR = 600;
export const PER_DAY = 3_000;
export const DEFAULT_RETRY_MS = 5_000;
export const MAX_RETRY_MS = 5 * 60_000;

export const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()) };

export class CapError extends Error {
  constructor(what) {
    super(`over the ${what} cap of Matrix sends`);
    this.cap = what;
  }
}

export class Pacer {
  constructor(clock = realClock) {
    this.clock = clock;
    this.buckets = new Map();
    this.chains = new Map();
    this.sent = [];
  }

  #bucket(room) {
    const now = this.clock.now();
    const b = this.buckets.get(room) ?? { tokens: BURST, at: now };
    b.tokens = Math.min(BURST, b.tokens + (now - b.at) / EVERY_MS);
    b.at = now;
    this.buckets.set(room, b);
    return b;
  }

  /** Waits for a slot, runs `fn`, waits and retries a rate-limit answer (`retryMs(err)` says how long, or undefined). */
  send(room, fn, retryMs = () => undefined) {
    const run = async () => {
      const now = this.clock.now();
      this.sent = this.sent.filter((t) => now - t < 86_400_000);
      if (this.sent.filter((t) => now - t < 3_600_000).length >= PER_HOUR) throw new CapError('hourly');
      if (this.sent.length >= PER_DAY) throw new CapError('daily');
      for (let tries = 0; ; tries++) {
        const b = this.#bucket(room);
        if (b.tokens < 1) {
          await this.clock.sleep(Math.ceil((1 - b.tokens) * EVERY_MS));
          this.#bucket(room);
        }
        this.buckets.get(room).tokens -= 1;
        this.sent.push(this.clock.now());
        try {
          return await fn();
        } catch (err) {
          const wait = retryMs(err);
          if (wait === undefined || tries >= 8) throw err;
          await this.clock.sleep(Math.min(MAX_RETRY_MS, wait));
        }
      }
    };
    const prev = this.chains.get(room) ?? Promise.resolve();
    const p = prev.then(run, run);
    this.chains.set(room, p.catch(() => undefined));
    return p;
  }
}

/** How long a 429 asks to wait: the Retry-After header (seconds), else retry_after_ms, else 5 s. */
export function retryAfterMs(headers = {}, body = {}) {
  const h = Number(headers['retry-after']);
  if (Number.isFinite(h) && h >= 0) return Math.min(MAX_RETRY_MS, h * 1000);
  const b = Number(body?.retry_after_ms);
  if (Number.isFinite(b) && b >= 0) return Math.min(MAX_RETRY_MS, b);
  return DEFAULT_RETRY_MS;
}

/** Typing in his room (§6.7): on when a turn starts, renewed every 25 s, off with the reply. */
export const TYPING_EVERY_MS = 25_000;
export class Typing {
  constructor(put, clock = { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t) }) {
    this.put = put;
    this.clock = clock;
    this.timers = new Map();
  }
  on(room) {
    this.off(room, false);
    void this.put(room, true);
    const t = this.clock.setInterval(() => void this.put(room, true), TYPING_EVERY_MS);
    t?.unref?.();
    this.timers.set(room, t);
  }
  off(room, say = true) {
    const t = this.timers.get(room);
    if (t !== undefined) this.clock.clearInterval(t);
    this.timers.delete(room);
    if (say && t !== undefined) void this.put(room, false);
  }
}
