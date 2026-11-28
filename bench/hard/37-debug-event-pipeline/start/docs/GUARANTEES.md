# What relay guarantees

This is the contract. Every rule here holds for any sink that follows [SINKS.md](SINKS.md), any
settings ([CONFIG.md](CONFIG.md)), and any number of restarts on the same journal folder.

Words used below:

- an event is **accepted** when `submit()` returns `{ accepted: true }`; it then gets a **seq**;
- an event is **delivered** when the sink was given it and did not reject it (the sink did not throw and
  did not list its id in `rejected`);
- an event is **pending** from the moment it is accepted until it is delivered or dead-lettered;
- a **restart** is a new `Pipeline` on the same `journalDir`. The old one may have been closed, or may
  simply have stopped between two calls (a killed process): the journal is written synchronously, so
  nothing that a call finished is lost.

## 1. Acceptance and seq

1.1 `submit({ id, key, data })` needs a non-empty string `id` and `key`; `data` is any JSON value (or
missing, stored as `null`).

1.2 Every accepted event gets a seq: 1 for the first event of a journal, then one more for each accepted
event, for the life of the journal, across restarts. Seqs are never reused.

## 2. Duplicates

2.1 An event whose `id` was accepted less than `dedupeWindowMs` ago (by the clock) is not accepted:
`submit()` returns `{ accepted: false, duplicate: true }` and the `duplicates` counter goes up. Once the
window has passed, the same id is accepted again as a new event.

2.2 The window survives a restart: it is rebuilt from the journal, using the time each id was accepted.

## 3. Readiness and batches

3.1 A pending event is **ready** at time `now` when its due time has come (`dueAt <= now`; the due time is
its acceptance time, or the time set for its next attempt after a failure) **and** no pending event of
the same key has a smaller seq.

3.2 `tick()` builds batches and hands each one to the sink, until no event is ready. A batch holds up to
`batchSize` events, taken in seq order among the ready ones. A batch never holds two events with the same
key (the second one becomes ready once the first is delivered, so it goes in a later batch of the same
tick).

3.3 Events that are not ready never take a place in a batch: if at least `batchSize` events are ready, the
batch is full. A batch is only short when fewer events are ready.

3.4 Batch ids are 1, 2, 3, … for the life of the journal, across restarts.

## 4. Order

4.1 Events with the same key are delivered in seq order. This holds through failures: while an event is
waiting for its next attempt, the later events of its key wait too (other keys go on). When it is
delivered or dead-lettered, the next event of its key becomes ready.

4.2 Within a batch, events are given to the sink in seq order.

## 5. Failures and retries

5.1 If the sink rejects some events of a batch, only those events failed; the others in the batch are
delivered. If the sink throws, every event of the batch failed.

5.2 After its n-th failed attempt an event's next attempt is due `backoffDelay(n)` ms later:
`min(backoffMaxMs, backoffBaseMs × 2^(n−1))` plus, when `jitterMs > 0`, a jitter of
`fnv1a(id + ":" + n) % (jitterMs + 1)` ms (see `src/util/hash.js`). It is tried again at the first tick at or
after that time.

5.3 An event is given to the sink at most `maxAttempts` times. If the `maxAttempts`-th attempt fails, it is
**dead-lettered**: it leaves the queue, goes to `pipeline.deadLetters` (`{ seq, id, attempts, reason }`)
and is never tried again.

5.4 All of this holds across restarts: attempts already made, and the due time of the next one, are in the
journal. A restart never gives an event an extra attempt and never makes one due earlier.

## 6. Exactly once

6.1 Every accepted event is delivered at most once, ever: a delivered event is never given to the sink
again, not in a retry of its batch, and not after any number of restarts.

6.2 Every accepted event is eventually delivered or dead-lettered, if the pipeline keeps ticking while the
clock moves on.

6.3 An event the sink rejected is never counted or recorded as delivered.

## 7. Restarts

7.1 After a restart the pipeline holds exactly the pending events, each with its seq, attempts and due
time; the counters, the dead letters, the next seq, the next batch id and the dedupe window are what they
were. Recovering the same journal twice gives the same state.

7.2 The journal folder stays as [JOURNAL.md](JOURNAL.md) describes it, whatever the number of restarts.

## 8. Counters

`pipeline.stats()` returns `{ submitted, delivered, retried, dead, duplicates, batches, pending }`:

| counter | counts | after a restart |
|---|---|---|
| submitted | accepted events | from the journal |
| delivered | delivered events (each event at most once) | from the journal |
| retried | failed attempts that were followed by another attempt | from the journal |
| dead | dead-lettered events | from the journal |
| duplicates | events refused as duplicates | this process only |
| batches | deliver() calls | this process only |
| pending | pending events now | — |

At any time: `submitted = delivered + dead + pending`.
