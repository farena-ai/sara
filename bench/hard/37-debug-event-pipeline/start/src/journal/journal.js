// The journal: what the pipeline writes down so that a restart carries on where it stopped.
// Without a folder it keeps nothing (an in-memory pipeline forgets everything when it goes away).
import { SegmentStore } from './segment-store.js';
import { replay } from './recovery.js';

export class Journal {
  constructor(dir, config, log) {
    this.store = dir ? new SegmentStore(dir, config.segmentSize, log) : null;
    this.log = log;
  }

  get persistent() {
    return this.store !== null;
  }

  /** Opens the folder and returns the state recorded in it (empty for a new journal). */
  open() {
    if (!this.store) return replay([]);
    this.store.open();
    const state = replay(this.store.readAll());
    this.log('recovery', `${state.counts.submitted} submitted, ${state.counts.delivered} delivered, ${state.counts.dead} dead, ${state.pending.length} pending; next seq ${state.nextSeq}`);
    return state;
  }

  accepted(entry) {
    this.store?.append({ t: 'enq', seq: entry.seq, id: entry.id, key: entry.key, at: entry.enqueuedAt, data: entry.data });
  }

  delivered(entry, batchId, at) {
    this.store?.append({ t: 'done', seq: entry.seq, batch: batchId, at });
  }

  failed(entry, attempts, due, at, reason) {
    this.store?.append({ t: 'fail', seq: entry.seq, attempts, due, at, reason });
  }

  dead(entry, attempts, at, reason) {
    this.store?.append({ t: 'dead', seq: entry.seq, id: entry.id, attempts, at, reason });
  }

  segments() {
    return this.store ? this.store.list() : [];
  }
}
