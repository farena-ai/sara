import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli/main.js';
import { FakeClock } from '../src/clock.js';
import { Pipeline } from '../src/pipeline.js';

export { FakeClock, Pipeline };
export { LedgerSink } from '../src/sinks/ledger-sink.js';
export { MemorySink } from '../src/sinks/memory-sink.js';

export function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-hidden-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes records into segment-1.log, segment-2.log, … with `size` records each (a journal "from 1.2"). */
export function writeJournal(dir, records, size) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i * size < records.length; i++) {
    const chunk = records.slice(i * size, (i + 1) * size);
    writeFileSync(join(dir, `segment-${i + 1}.log`), chunk.map((r) => `${JSON.stringify(r)}\n`).join(''));
  }
}

/** { name: [records] } for every segment file in the folder. */
export function segments(dir) {
  const out = {};
  for (const name of readdirSync(dir)) {
    if (!/^segment-\d+\.log$/.test(name)) continue;
    out[name] = readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  return out;
}

export function cli(cwd, ...argv) {
  let out = '';
  let err = '';
  const code = run(argv, { stdout: (t) => (out += t), stderr: (t) => (err += t), cwd });
  return { code, out, err };
}

export const enq = (seq, id, key = id, at = 0, data = null) => ({ t: 'enq', seq, id, key, at, data });
export const done = (seq, batch, at = 0) => ({ t: 'done', seq, batch, at });
export const fail = (seq, attempts, due, at, reason = 'busy') => ({ t: 'fail', seq, attempts, due, at, reason });

/** Every id the sink accepted more than once. */
export function twice(sink) {
  return [...new Set(sink.acceptedIds().filter((id) => sink.count(id) > 1))];
}

/** Calls of a MemorySink that contained `id`, as their clock times. */
export function callTimes(sink, id) {
  return sink.calls.filter((c) => c.ids.includes(id)).map((c) => c.now);
}

export function keysUniquePerCall(sink, keyOf) {
  return sink.calls.every((c) => new Set(c.ids.map(keyOf)).size === c.ids.length);
}

export const amountLine = (id, account, amount) => JSON.stringify({ id, key: account, data: { account, amount } });
