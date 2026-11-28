// Drops an event whose id was accepted less than dedupeWindowMs ago.
// The window is rebuilt from the journal on restart, so a resent event is still caught after one.

export class DedupeWindow {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.seen = new Map(); // id -> time it was accepted
  }

  isDuplicate(id, now) {
    const at = this.seen.get(id);
    return at !== undefined && now - at < this.windowMs;
  }

  remember(id, at) {
    const prev = this.seen.get(id);
    if (prev === undefined || at > prev) this.seen.set(id, at);
  }

  /** Forgets ids that have left the window, so the map does not grow forever. */
  prune(now) {
    for (const [id, at] of this.seen) if (now - at >= this.windowMs) this.seen.delete(id);
  }

  get size() {
    return this.seen.size;
  }
}
