// The pace to one person (WHATSAPP §4.11): Meta's pair rate is about one message every 6 s from a
// business number to one person, with short bursts borrowed from the future (`131056` above it).
// Sara keeps well under it: bursts of at most 5 (a reply's parts and files), then one every 6 s on
// average, per chat, in order. A `131056` or `130429` backs off 4^X seconds (1, 4, 16, 64 … up to
// 5 minutes) and the same message is sent again; nothing is dropped. Across WhatsApp at most 200
// sends an hour and 1,000 a day, so a stuck loop stops itself. Reads and typing are not paced.

export const EVERY_MS = 6_000;
export const BURST = 5;
export const PER_HOUR = 200;
export const PER_DAY = 1_000;
export const MAX_BACKOFF_MS = 5 * 60_000;

export const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()) };

export class CapError extends Error {
  constructor(what) {
    super(`over the ${what} cap of WhatsApp sends`);
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

  #bucket(chat) {
    const now = this.clock.now();
    let b = this.buckets.get(chat);
    if (!b) b = { tokens: BURST, at: now };
    b.tokens = Math.min(BURST, b.tokens + (now - b.at) / EVERY_MS);
    b.at = now;
    this.buckets.set(chat, b);
    return b;
  }

  /** Waits for a slot, runs `fn`, retries rate-limit answers with backoff. `isRate(err)` says which errors those are. */
  send(chat, fn, isRate = () => false) {
    const run = async () => {
      const now = this.clock.now();
      this.sent = this.sent.filter((t) => now - t < 86_400_000);
      if (this.sent.filter((t) => now - t < 3_600_000).length >= PER_HOUR) throw new CapError('hourly');
      if (this.sent.length >= PER_DAY) throw new CapError('daily');
      for (let tries = 0; ; tries++) {
        const b = this.#bucket(chat);
        if (b.tokens < 1) {
          await this.clock.sleep(Math.ceil((1 - b.tokens) * EVERY_MS));
          this.#bucket(chat);
        }
        this.buckets.get(chat).tokens -= 1;
        this.sent.push(this.clock.now());
        try {
          return await fn();
        } catch (err) {
          if (!isRate(err) || tries >= 8) throw err;
          await this.clock.sleep(Math.min(MAX_BACKOFF_MS, 4 ** tries * 1000));
        }
      }
    };
    const prev = this.chains.get(chat) ?? Promise.resolve();
    const p = prev.then(run, run);
    this.chains.set(chat, p.catch(() => undefined));
    return p;
  }

  today() {
    const now = this.clock.now();
    return this.sent.filter((t) => now - t < 86_400_000).length;
  }
}
