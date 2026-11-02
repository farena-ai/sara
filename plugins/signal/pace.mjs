// The Signal plugin's pacing and the rules Sara keeps on Signal (docs/design/BRIDGES3.md §4.10):
//   - at most one message a second per chat, 20 a minute per group, 60 an hour and 400 a day in all;
//   - she only writes to someone who wrote to her in the last 24 hours (or called her in a group):
//     she never writes first to anyone (Sara's own messages to the owner arrive as replies);
//   - a rate-limit error pauses that chat for an hour, and all chats for 6 hours after 3 in a day.
export const PER_CHAT_GAP_MS = 1000;
export const GROUP_PER_MINUTE = 20;
export const PER_HOUR = 60;
export const PER_DAY = 400;
export const REPLY_WINDOW_MS = 24 * 3600_000;
export const PAUSE_CHAT_MS = 3600_000;
export const PAUSE_ALL_MS = 6 * 3600_000;

export class Pacer {
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

  constructor({ now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.#now = now;
    this.#sleep = sleep;
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
    return Object.fromEntries([...this.#lastIn].filter(([, v]) => t - v < REPLY_WINDOW_MS));
  }

  /** Why she may not send to this chat now (undefined: she may). */
  refused(chatId) {
    const t = this.#now();
    const heard = this.#lastIn.get(chatId);
    if (!heard || t - heard > REPLY_WINDOW_MS) return "nobody in this chat wrote to her in the last 24 hours (she never writes first)";
    if (this.#pausedAll > t) return 'Signal sends are paused for a few hours after repeated rate limits';
    if ((this.#pausedChat.get(chatId) ?? 0) > t) return 'Signal sends to this chat are paused for an hour after a rate limit';
    this.#sent = this.#sent.filter((x) => t - x < 24 * 3600_000);
    if (this.#sent.length >= PER_DAY) return `the cap of ${PER_DAY} Signal messages a day is reached`;
    if (this.#sent.filter((x) => t - x < 3600_000).length >= PER_HOUR) return `the cap of ${PER_HOUR} Signal messages an hour is reached`;
    return undefined;
  }

  /** Runs one send in this chat's lane, at most one a second (groups: 20 a minute). */
  send(chatId, isGroup, fn) {
    const prev = this.#chains.get(chatId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const why = this.refused(chatId);
      if (why) throw Object.assign(new Error(why), { refused: true });
      const t = this.#now();
      const wait = (this.#lastOut.get(chatId) ?? 0) + PER_CHAT_GAP_MS - t;
      if (wait > 0) await this.#sleep(wait);
      if (isGroup) {
        const g = (this.#groupSent.get(chatId) ?? []).filter((x) => this.#now() - x < 60_000);
        if (g.length >= GROUP_PER_MINUTE) await this.#sleep(60_000 - (this.#now() - g[0]));
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
    this.#pausedChat.set(chatId, t + PAUSE_CHAT_MS);
    this.#limits = this.#limits.filter((x) => t - x < 24 * 3600_000);
    this.#limits.push(t);
    if (this.#limits.length >= 3) this.#pausedAll = t + PAUSE_ALL_MS;
    return this.#limits.length === 1;
  }

  /** Today's count (Settings shows it). */
  get today() {
    const t = this.#now();
    return this.#sent.filter((x) => t - x < 24 * 3600_000).length;
  }
}
