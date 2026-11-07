// The pace of Sara's own chat-app plugins: one file, byte-equal in every plugin that sends (WhatsApp,
// Matrix, iMessage, Signal; scripts/sdk-sync.ts copies it, test/phase128d.test.ts checks the copies).
// Each app has its own limits (PL2d, docs/design/POLISH2.md Q8); `pacing('<app>')` gives that app's
// numbers and classes. Reads, receipts and typing are never paced (they are not messages).
//
//   - WhatsApp (WHATSAPP §4.11): Meta's pair rate is about one message every 6 s from a business number
//     to one person, with short bursts borrowed from the future (`131056` above it). Bursts of at most 5
//     (a reply's parts and files), then one every 6 s on average, per chat, in order. A `131056` or
//     `130429` backs off 4^X seconds (1, 4, 16, 64 … up to 5 minutes) and the same message is sent
//     again; nothing is dropped. At most 200 sends an hour and 1,000 a day, so a stuck loop stops itself.
//   - Matrix (docs/design/BRIDGES4.md §6.10): bursts of at most 5, then about one message a second per
//     room, in order. A `429 M_LIMIT_EXCEEDED` waits what the server says (Retry-After, else the
//     deprecated retry_after_ms, else 5 s) and the same message is sent again. At most 600 an hour and
//     3,000 a day. Typing in his room is renewed every 25 s.
//   - iMessage (docs/design/BRIDGES4.md §4.10): per chat, bursts of at most 4, then one message every
//     2 s; at most 150 an hour and 600 a day, so a new Apple ID never floods Apple (over the cap the rest
//     stays in the app with one notice). Typing (with the Private API) is renewed every 20 s.
//   - Slack (docs/ops/EC1_DESIGN.md): per channel bursts of at most 3, then about one message a second
//     (Slack's chat.postMessage pace). A `429 ratelimited` waits Retry-After (else 5 s) and the same
//     message is sent again. At most 600 an hour and 3,000 a day.
//   - Signal (docs/design/BRIDGES3.md §4.10): at most one message a second per chat, 20 a minute per
//     group, 60 an hour and 400 a day in all; she only writes to someone who wrote to her in the last
//     24 hours (or called her in a group), never first; a rate-limit error pauses that chat for an hour,
//     and all chats for 6 hours after 3 in a day.

export const LIMITS = {
  whatsapp: { name: 'WhatsApp', everyMs: 6_000, burst: 5, perHour: 200, perDay: 1_000, retry: 'backoff', maxRetryMs: 5 * 60_000 },
  matrix: { name: 'Matrix', everyMs: 1_000, burst: 5, perHour: 600, perDay: 3_000, retry: 'server', maxRetryMs: 5 * 60_000, defaultRetryMs: 5_000, typingMs: 25_000 },
  slack: { name: 'Slack', everyMs: 1_000, burst: 3, perHour: 600, perDay: 3_000, retry: 'server', maxRetryMs: 5 * 60_000, defaultRetryMs: 5_000 },
  imessage: { name: 'iMessage', everyMs: 2_000, burst: 4, perHour: 150, perDay: 600, retry: 'none', typingMs: 20_000 },
  signal: { name: 'Signal', perChatGapMs: 1_000, groupPerMinute: 20, perHour: 60, perDay: 400, replyWindowMs: 24 * 3600_000, pauseChatMs: 3600_000, pauseAllMs: 6 * 3600_000 },
};

export const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()) };

/** Over the hourly or daily cap of an app's sends. */
export class CapError extends Error {
  constructor(what, app = 'chat-app') {
    super(`over the ${what} cap of ${app} sends`);
    this.cap = what;
  }
}

/**
 * Per chat: a bucket of `burst` sends refilled one every `everyMs`, in order; hourly and daily caps
 * across the app. `retry` says what a failed send does: 'backoff' (WhatsApp: `isRate(err)` true →
 * 4^X s), 'server' (Matrix: `retryMs(err)` gives the wait, undefined → no retry), 'none' (iMessage).
 */
export class Pacer {
  constructor(clock = realClock, limits = LIMITS.whatsapp) {
    this.clock = clock;
    this.limits = limits;
    this.buckets = new Map();
    this.chains = new Map();
    this.sent = [];
  }

  #bucket(chat) {
    const { burst, everyMs } = this.limits;
    const now = this.clock.now();
    const b = this.buckets.get(chat) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + (now - b.at) / everyMs);
    b.at = now;
    this.buckets.set(chat, b);
    return b;
  }

  /** This hour's and today's sends (the iMessage card's count). */
  counts() {
    const now = this.clock.now();
    this.sent = this.sent.filter((t) => now - t < 86_400_000);
    return { hour: this.sent.filter((t) => now - t < 3_600_000).length, day: this.sent.length };
  }

  /** Today's sends. */
  today() {
    return this.counts().day;
  }

  /** How long to wait before sending a failed message again (undefined: don't). */
  #retryWait(err, tries, retry) {
    const L = this.limits;
    if (L.retry === 'backoff') return retry(err) ? Math.min(L.maxRetryMs, 4 ** tries * 1000) : undefined;
    if (L.retry === 'server') {
      const wait = retry(err);
      return wait === undefined ? undefined : Math.min(L.maxRetryMs, wait);
    }
    return undefined;
  }

  /** Waits for a slot in this chat, runs `fn`; over the hourly or daily cap it throws CapError. */
  send(chat, fn, retry = () => undefined) {
    const run = async () => {
      const c = this.counts();
      if (c.hour >= this.limits.perHour) throw new CapError('hourly', this.limits.name);
      if (c.day >= this.limits.perDay) throw new CapError('daily', this.limits.name);
      for (let tries = 0; ; tries++) {
        const b = this.#bucket(chat);
        if (b.tokens < 1) {
          await this.clock.sleep(Math.ceil((1 - b.tokens) * this.limits.everyMs));
          this.#bucket(chat);
        }
        this.buckets.get(chat).tokens -= 1;
        this.sent.push(this.clock.now());
        try {
          return await fn();
        } catch (err) {
          const wait = this.#retryWait(err, tries, retry);
          if (wait === undefined || tries >= 8) throw err;
          await this.clock.sleep(wait);
        }
      }
    };
    const prev = this.chains.get(chat) ?? Promise.resolve();
    const p = prev.then(run, run);
    this.chains.set(chat, p.catch(() => undefined));
    return p;
  }
}

/** Signal's pacer: replies only (24 h window), one a second per chat, 20 a minute per group, pauses after rate limits. */
export class ReplyPacer {
  #now;
  #sleep;
  #lastIn = new Map();
  #lastOut = new Map();
  #sent = [];
  #groupSent = new Map();
  #pausedChat = new Map();
  #pausedAll = 0;
  #limits = [];
  #chains = new Map();
  #L;

  constructor({ now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}, limits = LIMITS.signal) {
    this.#now = now;
    this.#sleep = sleep;
    this.#L = limits;
  }

  /** Someone wrote to her in this chat (a DM, or a group that called her). */
  heard(chatId) {
    this.#lastIn.set(chatId, this.#now());
  }

  restore(map) {
    for (const [k, v] of Object.entries(map ?? {})) if (Number.isFinite(v)) this.#lastIn.set(k, v);
  }
  snapshot() {
    const t = this.#now();
    return Object.fromEntries([...this.#lastIn].filter(([, v]) => t - v < this.#L.replyWindowMs));
  }

  /** Why she may not send to this chat now (undefined: she may). */
  refused(chatId) {
    const L = this.#L;
    const t = this.#now();
    const heard = this.#lastIn.get(chatId);
    if (!heard || t - heard > L.replyWindowMs) return "nobody in this chat wrote to her in the last 24 hours (she never writes first)";
    if (this.#pausedAll > t) return 'Signal sends are paused for a few hours after repeated rate limits';
    if ((this.#pausedChat.get(chatId) ?? 0) > t) return 'Signal sends to this chat are paused for an hour after a rate limit';
    this.#sent = this.#sent.filter((x) => t - x < 24 * 3600_000);
    if (this.#sent.length >= L.perDay) return `the cap of ${L.perDay} Signal messages a day is reached`;
    if (this.#sent.filter((x) => t - x < 3600_000).length >= L.perHour) return `the cap of ${L.perHour} Signal messages an hour is reached`;
    return undefined;
  }

  /** Runs one send in this chat's lane, at most one a second (groups: 20 a minute). */
  send(chatId, isGroup, fn) {
    const L = this.#L;
    const prev = this.#chains.get(chatId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const why = this.refused(chatId);
      if (why) throw Object.assign(new Error(why), { refused: true });
      const t = this.#now();
      const wait = (this.#lastOut.get(chatId) ?? 0) + L.perChatGapMs - t;
      if (wait > 0) await this.#sleep(wait);
      if (isGroup) {
        const g = (this.#groupSent.get(chatId) ?? []).filter((x) => this.#now() - x < 60_000);
        if (g.length >= L.groupPerMinute) await this.#sleep(60_000 - (this.#now() - g[0]));
        g.push(this.#now());
        this.#groupSent.set(chatId, g);
      }
      this.#lastOut.set(chatId, this.#now());
      this.#sent.push(this.#now());
      return fn();
    });
    this.#chains.set(chatId, next.catch(() => {}));
    return next;
  }

  /** A rate-limit error: returns true when it's the first one today (notify the owner once). */
  rateLimited(chatId) {
    const t = this.#now();
    this.#pausedChat.set(chatId, t + this.#L.pauseChatMs);
    this.#limits = this.#limits.filter((x) => t - x < 24 * 3600_000);
    this.#limits.push(t);
    if (this.#limits.length >= 3) this.#pausedAll = t + this.#L.pauseAllMs;
    return this.#limits.length === 1;
  }

  /** Today's count (Settings shows it). */
  get today() {
    const t = this.#now();
    return this.#sent.filter((x) => t - x < 24 * 3600_000).length;
  }
}

/** Typing in a chat: on when a turn starts, renewed every `every` ms, off with the reply. */
export class Typing {
  constructor(put, clock = { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t) }, every = 20_000) {
    this.put = put;
    this.clock = clock;
    this.every = every;
    this.timers = new Map();
  }
  on(chat) {
    this.off(chat, false);
    void this.put(chat, true);
    const t = this.clock.setInterval(() => void this.put(chat, true), this.every);
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

/** How long a Matrix 429 asks to wait: the Retry-After header (seconds), else retry_after_ms, else 5 s. */
export function retryAfterMs(headers = {}, body = {}) {
  const { maxRetryMs, defaultRetryMs } = LIMITS.matrix;
  const h = Number(headers['retry-after']);
  if (Number.isFinite(h) && h >= 0) return Math.min(maxRetryMs, h * 1000);
  const b = Number(body?.retry_after_ms);
  if (Number.isFinite(b) && b >= 0) return Math.min(maxRetryMs, b);
  return defaultRetryMs;
}

/** With a working doorbell the iMessage catch-up still runs this often while idle (B2). */
export const DOORBELL_POLL_MS = 60_000;
/** How long until the next look at BlueBubbles (§4.3): 60 s with a doorbell; else every `pollSeconds` (5) while a chat with him was active in the last 10 minutes, six times that (30 s) when idle. */
export function pollDelay({ doorbell, active, pollSeconds }) {
  const every = Math.min(300, Math.max(1, Number(pollSeconds) || 5)) * 1000;
  if (doorbell) return DOORBELL_POLL_MS;
  return active ? every : every * 6;
}

/**
 * One app's numbers and classes, with the names each plugin's own pace.mjs used before 2.61.3:
 * `const { Pacer, CapError, EVERY_MS } = pacing('whatsapp')`. Signal's `Pacer` is the ReplyPacer.
 */
export function pacing(app) {
  const L = LIMITS[app];
  if (!L) throw new Error(`no pace for ${app}`);
  if (app === 'signal') {
    return {
      LIMITS: L,
      PER_CHAT_GAP_MS: L.perChatGapMs,
      GROUP_PER_MINUTE: L.groupPerMinute,
      PER_HOUR: L.perHour,
      PER_DAY: L.perDay,
      REPLY_WINDOW_MS: L.replyWindowMs,
      PAUSE_CHAT_MS: L.pauseChatMs,
      PAUSE_ALL_MS: L.pauseAllMs,
      Pacer: class extends ReplyPacer {
        constructor(clock) {
          super(clock, L);
        }
      },
    };
  }
  return {
    LIMITS: L,
    EVERY_MS: L.everyMs,
    BURST: L.burst,
    PER_HOUR: L.perHour,
    PER_DAY: L.perDay,
    ...(L.maxRetryMs ? { MAX_BACKOFF_MS: L.maxRetryMs, MAX_RETRY_MS: L.maxRetryMs } : {}),
    ...(L.defaultRetryMs ? { DEFAULT_RETRY_MS: L.defaultRetryMs } : {}),
    ...(L.typingMs ? { TYPING_EVERY_MS: L.typingMs } : {}),
    realClock,
    CapError,
    Pacer: class extends Pacer {
      constructor(clock = realClock) {
        super(clock, L);
      }
    },
    Typing: class extends Typing {
      constructor(put, clock) {
        super(put, clock, L.typingMs ?? 20_000);
      }
    },
    retryAfterMs,
    pollDelay,
  };
}
