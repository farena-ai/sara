# Settings

Passed as `config` to `new Pipeline({ … })`. Unknown names and bad values throw `ConfigError`.

| setting | default | meaning |
|---|---|---|
| `batchSize` | 10 | most events in one batch (≥ 1) |
| `maxAttempts` | 5 | most times an event is given to the sink (≥ 1) |
| `backoffBaseMs` | 100 | delay after the first failure (≥ 1) |
| `backoffMaxMs` | 10000 | the delay never exceeds this, before jitter (≥ backoffBaseMs) |
| `jitterMs` | 0 | largest jitter added to a delay (≥ 0) |
| `dedupeWindowMs` | 60000 | how long an id counts as a duplicate after it was accepted (≥ 0; 0 turns dedupe off) |
| `segmentSize` | 64 | most records in one journal segment (≥ 1) |
| `tickMs` | 50 | how far `runUntilIdle()` and `relay run` move the clock between ticks (≥ 1) |

The delay after the n-th failure is `min(backoffMaxMs, backoffBaseMs × 2^(n−1))` plus jitter
(GUARANTEES.md §5.2). With the defaults: 100, 200, 400, 800 ms, and the 5th failure dead-letters.
