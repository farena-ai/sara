// Counters. submitted / delivered / retried / dead count over the life of the journal (they are rebuilt from it
// on restart); duplicates and batches count this process only. See docs/GUARANTEES.md, "Counters".

export class Stats {
  constructor(fromJournal = {}) {
    this.submitted = fromJournal.submitted ?? 0;
    this.delivered = fromJournal.delivered ?? 0;
    this.retried = fromJournal.retried ?? 0;
    this.dead = fromJournal.dead ?? 0;
    this.duplicates = 0;
    this.batches = 0;
  }

  snapshot(pending) {
    return {
      submitted: this.submitted,
      delivered: this.delivered,
      retried: this.retried,
      dead: this.dead,
      duplicates: this.duplicates,
      batches: this.batches,
      pending,
    };
  }
}

export function formatStats(s) {
  return `submitted ${s.submitted}, duplicates ${s.duplicates}, delivered ${s.delivered}, retried ${s.retried}, dead ${s.dead}, pending ${s.pending}`;
}
