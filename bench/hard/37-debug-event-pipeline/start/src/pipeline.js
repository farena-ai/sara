// The pipeline: submit() accepts events, tick() delivers everything that is ready at the clock's time.
//
//   submit ─▶ dedupe ─▶ journal (enq) ─▶ queue ─▶ batcher ─▶ dispatcher ─▶ sink
//                                          ▲                       │
//                                          └──── retry policy ◀────┘ (fail / dead)
import { Batcher } from './batch/batcher.js';
import { resolveConfig } from './config.js';
import { DedupeWindow } from './dedupe/window.js';
import { Dispatcher } from './dispatch/dispatcher.js';
import { Journal } from './journal/journal.js';
import { Stats } from './metrics/stats.js';
import { describe, makeEntry } from './queue/entry.js';
import { JobQueue } from './queue/queue.js';
import { afterFailure } from './retry/backoff.js';
import { silent } from './util/log.js';

export class SubmitError extends Error {}

export class Pipeline {
  /**
   * @param {object} options
   * @param {{ deliver(events, ctx): void | { rejected: string[], reason?: string } }} options.sink
   * @param {{ now(): number }} options.clock
   * @param {string} [options.journalDir]  folder for the journal; without it nothing survives a restart
   * @param {object} [options.config]      see docs/CONFIG.md
   * @param {Function} [options.log]       from createLog()
   */
  constructor({ sink, clock, journalDir, config, log = silent }) {
    if (!sink || typeof sink.deliver !== 'function') throw new TypeError('a sink with deliver() is required');
    if (!clock || typeof clock.now !== 'function') throw new TypeError('a clock is required');
    this.config = resolveConfig(config);
    this.clock = clock;
    this.log = log;
    this.queue = new JobQueue();
    this.batcher = new Batcher(this.queue, this.config, log);
    this.dispatcher = new Dispatcher(sink, log);
    this.window = new DedupeWindow(this.config.dedupeWindowMs);
    this.journal = new Journal(journalDir, this.config, log);
    this.deadLetters = [];
    this.closed = false;

    const state = this.journal.open();
    this.counters = new Stats(state.counts);
    this.nextSeq = state.nextSeq;
    this.batcher.nextId = state.nextBatch;
    this.lastJournalAt = state.lastAt;
    this.knownIds = new Set(state.ids.keys());
    for (const [id, at] of state.ids) this.window.remember(id, at);
    for (const entry of state.pending) this.queue.add(entry);
    this.deadLetters.push(...state.deadLetters);
  }

  /** Accepts an event { id, key, data }. Returns { accepted, seq } or { accepted: false, duplicate: true }. */
  submit(event) {
    this.#open();
    if (!event || typeof event.id !== 'string' || event.id === '') throw new SubmitError('an event needs a non-empty string id');
    if (typeof event.key !== 'string' || event.key === '') throw new SubmitError(`event ${event.id} needs a non-empty string key`);
    const now = this.clock.now();
    if (this.window.isDuplicate(event.id, now)) {
      this.counters.duplicates++;
      this.log('dedupe', `dropped ${event.id} (seen within ${this.config.dedupeWindowMs} ms)`);
      return { accepted: false, duplicate: true };
    }
    const entry = makeEntry({ seq: this.nextSeq++, id: event.id, key: event.key, data: event.data ?? null, enqueuedAt: now });
    this.journal.accepted(entry);
    this.queue.add(entry);
    this.window.remember(entry.id, now);
    this.knownIds.add(entry.id);
    this.counters.submitted++;
    return { accepted: true, seq: entry.seq };
  }

  /** Delivers every batch that is ready now. Returns how many batches went to the sink. */
  tick() {
    this.#open();
    const now = this.clock.now();
    let batches = 0;
    for (;;) {
      const batch = this.batcher.next(now);
      if (!batch) break;
      batches++;
      this.counters.batches++;
      const { accepted, retry, reason } = this.dispatcher.deliver(batch, now);
      for (const entry of accepted) {
        this.journal.delivered(entry, batch.id, now);
        this.counters.delivered++;
      }
      for (const entry of retry) this.#failed(entry, now, reason);
    }
    this.window.prune(now);
    return batches;
  }

  #failed(entry, now, reason) {
    const step = afterFailure(entry, now, this.config);
    if (step.kind === 'dead') {
      this.journal.dead(entry, step.attempts, now, reason);
      this.counters.dead++;
      this.deadLetters.push({ seq: entry.seq, id: entry.id, attempts: step.attempts, reason });
      this.log('retry', `${entry.id} dead after ${step.attempts} attempts (${reason})`);
      return;
    }
    this.journal.failed(entry, step.attempts, step.dueAt, now, reason);
    this.counters.retried++;
    this.queue.add({ ...entry, attempts: step.attempts, dueAt: step.dueAt });
    this.log('retry', `${describe(entry)} failed (${reason}); attempt ${step.attempts + 1} due at ${step.dueAt}`);
  }

  /**
   * Ticks, moving the clock on by tickMs between ticks, until nothing is pending
   * (or maxTicks ticks have run). Needs a clock with advance(). Returns the number of ticks.
   */
  runUntilIdle({ maxTicks = 100_000 } = {}) {
    let ticks = 0;
    while (this.queue.size > 0 && ticks < maxTicks) {
      this.tick();
      ticks++;
      if (this.queue.size > 0) this.clock.advance(this.config.tickMs);
    }
    return ticks;
  }

  /** True when an event with this id was ever accepted into this journal. */
  knows(id) {
    return this.knownIds.has(id);
  }

  pending() {
    return this.queue.pending().map((e) => ({ seq: e.seq, id: e.id, key: e.key, attempts: e.attempts, dueAt: e.dueAt }));
  }

  stats() {
    return this.counters.snapshot(this.queue.size);
  }

  close() {
    this.closed = true;
  }

  #open() {
    if (this.closed) throw new Error('the pipeline is closed');
  }
}
