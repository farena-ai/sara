// A sink that remembers everything it was given. Used by the tests and by `relay run --sink memory`.
//
//   new MemorySink({ reject: (event, ctx) => reason | null, fail: (events, ctx) => message | null })
//
// reject() refuses single events (they come back in { rejected }); fail() makes the whole call throw.

export class MemorySink {
  constructor({ reject = () => null, fail = () => null } = {}) {
    this.reject = reject;
    this.fail = fail;
    this.calls = []; // every deliver() call: { batchId, now, ids }
    this.accepted = []; // every accepted event, in order
  }

  deliver(events, ctx) {
    this.calls.push({ batchId: ctx.batchId, now: ctx.now, ids: events.map((e) => e.id) });
    const message = this.fail(events, ctx);
    if (message) throw new Error(message);
    const rejected = [];
    let reason = null;
    for (const event of events) {
      const why = this.reject(event, ctx);
      if (why) {
        rejected.push(event.id);
        reason ??= why;
      } else {
        this.accepted.push({ ...event, batchId: ctx.batchId, at: ctx.now });
      }
    }
    return rejected.length > 0 ? { rejected, reason } : undefined;
  }

  /** How many times the event with this id was accepted. */
  count(id) {
    return this.accepted.filter((e) => e.id === id).length;
  }

  acceptedIds() {
    return this.accepted.map((e) => e.id);
  }
}
