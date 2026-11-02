// The outbox (BRIDGES3 §5.3): mail waiting to be sent, kept in the plugin's own data folder so a
// restart sends it later. A 4xx from the server ("try again later", RFC 5321 §4.2.1) keeps the mail
// and tries again after 1, 5 and 30 minutes; a 5xx or the third failure gives up and tells the
// owner. The clock is injectable (tests drive the minutes with a fake one).

export const RETRY_MIN = [1, 5, 30];

export class Outbox {
  /**
   * @param {object} o
   * @param {(items: object[]) => Promise<Map<string, Error|null>>} o.deliver sends the due items, returns an error (or null) per id
   * @param {(item: object, why: string) => void} o.gaveUp told once when a mail is given up
   * @param {(items: object[]) => void} o.save persists the list
   */
  constructor({ deliver, gaveUp, save, items = [], clock = { setTimeout, clearTimeout, now: () => Date.now() } }) {
    this.deliver = deliver;
    this.gaveUp = gaveUp;
    this.save = save;
    this.items = items.filter((x) => x && x.id && x.to && x.raw);
    this.clock = clock;
    this.timer = undefined;
    this.running = false;
    this.again = false;
  }

  add(item) {
    this.items.push({ tries: 0, next: 0, ...item });
    this.save(this.items);
    void this.flush();
  }

  /** Sends what is due; reschedules the rest. */
  async flush() {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        const now = this.clock.now();
        const due = this.items.filter((x) => x.next <= now);
        if (!due.length) break;
        let results;
        try {
          results = await this.deliver(due);
        } catch (err) {
          results = new Map(due.map((x) => [x.id, Object.assign(err instanceof Error ? err : new Error(String(err)), { transient: err?.transient ?? true })]));
        }
        for (const it of due) {
          const err = results.get(it.id);
          if (err === null || err === undefined) {
            this.items = this.items.filter((x) => x !== it);
            continue;
          }
          it.tries++;
          it.last = String(err.message ?? err).slice(0, 300);
          if (!err.transient || it.tries > RETRY_MIN.length) {
            this.items = this.items.filter((x) => x !== it);
            this.gaveUp(it, it.last);
          } else it.next = this.clock.now() + RETRY_MIN[it.tries - 1] * 60_000;
        }
        this.save(this.items);
      } while (this.again);
    } finally {
      this.running = false;
    }
    this.#schedule();
  }

  #schedule() {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.items.length) return;
    const wait = Math.max(1000, Math.min(...this.items.map((x) => x.next)) - this.clock.now());
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, wait);
    this.timer?.unref?.();
  }

  stop() {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
