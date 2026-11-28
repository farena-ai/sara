// relay run <events.ndjson>: feeds an events file through a pipeline on a fake clock (docs/CLI.md).
import { resolve } from 'node:path';
import { FakeClock } from '../../clock.js';
import { formatStats } from '../../metrics/stats.js';
import { Pipeline } from '../../pipeline.js';
import { LedgerSink } from '../../sinks/ledger-sink.js';
import { MemorySink } from '../../sinks/memory-sink.js';
import { createLog } from '../../util/log.js';
import { UsageError } from '../args.js';
import { parseLock, readEvents } from '../input.js';

export const options = {
  journal: { type: 'string' },
  sink: { type: 'string' },
  batch: { type: 'int' },
  'max-attempts': { type: 'int' },
  'segment-size': { type: 'int' },
  tick: { type: 'int' },
  rate: { type: 'int' },
  start: { type: 'int' },
  lock: { type: 'string', multiple: true },
  'stop-after': { type: 'int' },
  json: { type: 'flag' },
};

export function run({ values, positionals, io, logWrite }) {
  if (positionals.length !== 1) throw new UsageError('usage: relay run <events.ndjson> [options]');
  const events = readEvents(resolve(io.cwd, positionals[0]));
  const sinkName = values.sink ?? 'ledger';
  if (sinkName !== 'ledger' && sinkName !== 'memory') throw new UsageError(`unknown sink "${sinkName}" (ledger or memory)`);
  const sink = sinkName === 'ledger' ? new LedgerSink({ locks: (values.lock ?? []).map(parseLock) }) : new MemorySink();
  const clock = new FakeClock(values.start ?? 0);
  const pipeline = new Pipeline({
    sink,
    clock,
    journalDir: values.journal ? resolve(io.cwd, values.journal) : undefined,
    config: { batchSize: values.batch, maxAttempts: values['max-attempts'], segmentSize: values['segment-size'], tickMs: values.tick },
    log: createLog(logWrite, clock),
  });
  const tickMs = pipeline.config.tickMs;
  if (pipeline.lastJournalAt > 0 && clock.now() <= pipeline.lastJournalAt) clock.set(pipeline.lastJournalAt + tickMs);

  const fresh = events.filter((e) => !pipeline.knows(e.id));
  const rate = values.rate ?? fresh.length;
  if (rate < 1 && fresh.length > 0) throw new UsageError('--rate must be at least 1');
  let next = 0;
  let ticks = 0;
  const stopAfter = values['stop-after'];
  while (next < fresh.length || pipeline.queue.size > 0) {
    if (stopAfter !== undefined && ticks >= stopAfter) break;
    for (const end = Math.min(fresh.length, next + rate); next < end; next++) pipeline.submit(fresh[next]);
    pipeline.tick();
    ticks++;
    clock.advance(tickMs);
    if (ticks > 1_000_000) throw new Error('the run does not finish');
  }

  const stats = pipeline.stats();
  const totals = sinkName === 'ledger' ? sink.report() : undefined;
  if (values.json) {
    io.stdout(`${JSON.stringify({ stats, totals, dead: pipeline.deadLetters, skipped: events.length - fresh.length, ticks })}\n`);
  } else {
    io.stdout(`${formatStats(stats)}\n`);
    if (events.length > fresh.length) io.stdout(`skipped ${events.length - fresh.length} events already in the journal\n`);
    if (totals) for (const [account, amount] of Object.entries(totals)) io.stdout(`  ${account.padEnd(12)} ${amount.padStart(12)}\n`);
    for (const d of pipeline.deadLetters) io.stdout(`dead: ${d.id} after ${d.attempts} attempts (${d.reason})\n`);
  }
  return 0;
}
