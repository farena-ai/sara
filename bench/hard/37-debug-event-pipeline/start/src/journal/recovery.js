// Rebuilds the pipeline's state from the journal's records, replayed oldest first.
import { makeEntry } from '../queue/entry.js';

export function replay(records) {
  const pending = new Map(); // seq -> entry
  const ids = new Map(); // id -> time it was accepted (for the dedupe window)
  const counts = { submitted: 0, delivered: 0, retried: 0, dead: 0 };
  const deadLetters = [];
  let maxSeq = 0;
  let maxBatch = 0;
  let lastAt = 0;

  for (const r of records) {
    if (Number.isInteger(r.at) && r.at > lastAt) lastAt = r.at;
    switch (r.t) {
      case 'enq':
        pending.set(r.seq, makeEntry({ seq: r.seq, id: r.id, key: r.key, data: r.data, enqueuedAt: r.at }));
        ids.set(r.id, r.at);
        counts.submitted++;
        if (r.seq > maxSeq) maxSeq = r.seq;
        break;
      case 'fail': {
        const entry = pending.get(r.seq);
        if (entry) {
          entry.attempts = r.attempts;
          entry.dueAt = r.due;
        }
        counts.retried++;
        break;
      }
      case 'done':
        pending.delete(r.seq);
        counts.delivered++;
        if (r.batch > maxBatch) maxBatch = r.batch;
        break;
      case 'dead': {
        const entry = pending.get(r.seq);
        pending.delete(r.seq);
        counts.dead++;
        deadLetters.push({ seq: r.seq, id: entry?.id ?? r.id, attempts: r.attempts, reason: r.reason });
        break;
      }
      default:
        break;
    }
  }

  return {
    pending: [...pending.values()].sort((a, b) => a.seq - b.seq),
    ids,
    counts,
    deadLetters,
    nextSeq: maxSeq + 1,
    nextBatch: maxBatch + 1,
    lastAt,
  };
}
