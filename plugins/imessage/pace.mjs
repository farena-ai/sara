// The pace (docs/design/BRIDGES4.md §4.10): per chat, bursts of at most 4 (a reply's parts and files),
// then one message every 2 s, in order; across iMessage at most 150 sends an hour and 600 a day, so a
// new Apple ID never floods Apple (over the cap the rest stays in the app with one notice). Typing (with
// the Private API) is renewed every 20 s while she works and isn't paced.

export const EVERY_MS = 2_000;
export const BURST = 4;
export const PER_HOUR = 150;
export const PER_DAY = 600;

export const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()) };

export class CapError extends Error {
  constructor(what) {
    super(`over the ${what} cap of iMessage sends`);
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
    const b = this.buckets.get(chat) ?? { tokens: BURST, at: now };
    b.tokens = Math.min(BURST, b.tokens + (now - b.at) / EVERY_MS);
    b.at = now;
    this.buckets.set(chat, b);
    return b;
  }

  /** Today's and this hour's sends (the card's count). */
  counts() {
    const now = this.clock.now();
    this.sent = this.sent.filter((t) => now - t < 86_400_000);
    return { hour: this.sent.filter((t) => now - t < 3_600_000).length, day: this.sent.length };
  }

  /** Waits for a slot in this chat, then runs `fn`; over the hourly or daily cap it throws CapError. */
  send(chat, fn) {
    const run = async () => {
      const c = this.counts();
      if (c.hour >= PER_HOUR) throw new CapError('hourly');
      if (c.day >= PER_DAY) throw new CapError('daily');
      const b = this.#bucket(chat);
      if (b.tokens < 1) {
        await this.clock.sleep(Math.ceil((1 - b.tokens) * EVERY_MS));
        this.#bucket(chat);
      }
      this.buckets.get(chat).tokens -= 1;
      this.sent.push(this.clock.now());
      return fn();
    };
    const prev = this.chains.get(chat) ?? Promise.resolve();
    const p = prev.then(run, run);
    this.chains.set(chat, p.catch(() => undefined));
    return p;
  }
}

export const TYPING_EVERY_MS = 20_000;
export class Typing {
  constructor(put, clock = { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t) }) {
    this.put = put;
    this.clock = clock;
    this.timers = new Map();
  }
  on(chat) {
    this.off(chat, false);
    void this.put(chat, true);
    const t = this.clock.setInterval(() => void this.put(chat, true), TYPING_EVERY_MS);
    t?.unref?.();
    this.timers.set(chat, t);
  }
  off(chat, say = true) {
    const t = this.timers.get(chat);
    if (t !== undefined) this.clock.clearInterval(t);
    this.timers.delete(chat);
    if (say && t !== undefined) void this.put(chat, false);
  }
}

/** With a working doorbell the catch-up still runs this often while idle (B2). */
export const DOORBELL_POLL_MS = 60_000;
/** How long until the next look at BlueBubbles (§4.3): 60 s with a doorbell; else every `pollSeconds` (5) while a chat with him was active in the last 10 minutes, six times that (30 s) when idle. */
export function pollDelay({ doorbell, active, pollSeconds }) {
  const every = Math.min(300, Math.max(1, Number(pollSeconds) || 5)) * 1000;
  if (doorbell) return DOORBELL_POLL_MS;
  return active ? every : every * 6;
}
