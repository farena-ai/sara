# Changelog

## 1.3.0

- Batches no longer hold two events with the same key, and a key waits while its earlier event waits for a
  retry (the per-key order of GUARANTEES.md §4 now holds through failures).
- Sinks can reject single events of a batch (`{ rejected: [ids] }`) instead of failing the whole batch.
- `LedgerSink` can lock accounts for a while (`--lock`).
- `relay run --rate`, `--stop-after`, and resuming a killed run on the same journal.
- The run log shows, per batch, how many pending events were held back (`held`) or not yet due (`waiting`).

## 1.2.0

- The journal is split into segments (`segment-<n>.log`, `segmentSize` records each) instead of one
  file that grew forever.
- `relay journal ls` and `relay journal pending`.

## 1.1.0

- Retries with exponential backoff and a dead-letter list.
- The dedupe window is rebuilt from the journal on restart.

## 1.0.0

- First version: queue, batches, journal, MemorySink.
