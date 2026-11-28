# relay

An in-process event pipeline for Node (no dependencies). You submit events; relay keeps them in a queue,
hands them to a sink in batches, retries the ones the sink rejects with exponential backoff, drops
duplicates, and writes everything to a journal on disk so a restarted process carries on where the
last one stopped.

```js
import { FakeClock, LedgerSink, Pipeline } from './src/index.js';

const clock = new FakeClock(0);
const sink = new LedgerSink({ locks: [{ account: 'acct-3', until: 400 }] });
const pipeline = new Pipeline({ sink, clock, journalDir: './journal', config: { batchSize: 5 } });

pipeline.submit({ id: 'evt-0001', key: 'acct-1', data: { account: 'acct-1', amount: '12.50' } });
pipeline.tick();           // delivers everything that is ready now
clock.advance(50);
pipeline.runUntilIdle();   // ticks (moving the clock by tickMs) until nothing is pending
console.log(pipeline.stats(), sink.report());
```

There are no timers: the pipeline only does something when you call `tick()`, and it reads the time
from the clock you give it. Everything (the journal included) is synchronous, so a run is the same
every time.

## Documentation

- [docs/GUARANTEES.md](docs/GUARANTEES.md): what relay promises (ordering, batching, retries, exactly-once, restarts). **The contract.**
- [docs/JOURNAL.md](docs/JOURNAL.md): the journal's files and records.
- [docs/SINKS.md](docs/SINKS.md): writing a sink; the two built-in ones.
- [docs/CONFIG.md](docs/CONFIG.md): settings.
- [docs/CLI.md](docs/CLI.md): the `relay` command.
- [CHANGELOG.md](CHANGELOG.md), [ISSUES.md](ISSUES.md) (open reports), [logs/](logs/) (recorded runs attached to the reports).

## Layout

```
bin/relay.js              the command line
src/pipeline.js           wires the parts together: submit(), tick(), runUntilIdle(), stats()
src/queue/                the pending events and the readiness rules
src/batch/                builds batches from the queue
src/dispatch/             calls the sink and reads its answer
src/retry/                backoff and the attempt limit
src/dedupe/               the duplicate window
src/journal/              segments on disk, record codec, replay on restart, read-only views
src/sinks/                MemorySink (tests) and LedgerSink (amounts per account)
src/metrics/              counters
src/cli/                  argument parsing and the commands
examples/                 the input files used for the runs in logs/
```

## Tests

```sh
node --test
```
