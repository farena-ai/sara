// The pending events, kept in acceptance (seq) order.
//
// takeReady() picks the next batch. docs/GUARANTEES.md has the rules it follows:
//   - an event is ready when its dueAt has come and no earlier event of the same key is still pending;
//   - a batch never holds two events of the same key;
//   - events are taken in seq order.

export class JobQueue {
  constructor() {
    this.entries = [];
    this.lastScan = { taken: 0, held: 0, waiting: 0 };
  }

  get size() {
    return this.entries.length;
  }

  add(entry) {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.entries[mid].seq < entry.seq) lo = mid + 1;
      else hi = mid;
    }
    if (this.entries[lo]?.seq === entry.seq) throw new Error(`seq ${entry.seq} is already queued`);
    this.entries.splice(lo, 0, entry);
  }

  get(seq) {
    return this.entries.find((e) => e.seq === seq);
  }

  has(seq) {
    return this.get(seq) !== undefined;
  }

  remove(seq) {
    const i = this.entries.findIndex((e) => e.seq === seq);
    if (i === -1) return undefined;
    return this.entries.splice(i, 1)[0];
  }

  /** Takes (removes) up to `max` ready entries, in seq order. */
  takeReady(now, max) {
    const taken = [];
    const blocked = new Set();
    let held = 0;
    let waiting = 0;
    for (const entry of this.entries) {
      if (taken.length >= max) break;
      if (blocked.has(entry.key)) {
        held++;
        continue;
      }
      blocked.add(entry.key);
      if (entry.dueAt > now) {
        waiting++;
        continue;
      }
      taken.push(entry);
    }
    for (const entry of taken) this.remove(entry.seq);
    this.lastScan = { taken: taken.length, held, waiting };
    return taken;
  }

  /** Entries whose time has come, ignoring keys (for `relay journal pending` and the stats). */
  due(now) {
    return this.entries.filter((e) => e.dueAt <= now);
  }

  nextDueAt() {
    let next = null;
    for (const e of this.entries) if (next === null || e.dueAt < next) next = e.dueAt;
    return next;
  }

  pending() {
    return this.entries.slice();
  }
}
