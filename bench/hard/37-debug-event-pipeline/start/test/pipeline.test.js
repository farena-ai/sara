import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClock } from '../src/clock.js';
import { Pipeline } from '../src/pipeline.js';
import { LedgerSink } from '../src/sinks/ledger-sink.js';
import { MemorySink } from '../src/sinks/memory-sink.js';
import { events } from './helpers.js';

test('submitted events are delivered in batches', () => {
  const sink = new MemorySink();
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { batchSize: 2 } });
  for (const e of events(5)) assert.equal(p.submit(e).accepted, true);
  assert.equal(p.tick(), 3);
  assert.deepEqual(sink.calls.map((c) => c.ids), [['e1', 'e2'], ['e3', 'e4'], ['e5']]);
  assert.deepEqual(p.stats(), { submitted: 5, delivered: 5, retried: 0, dead: 0, duplicates: 0, batches: 3, pending: 0 });
});

test('a duplicate id inside the window is dropped', () => {
  const clock = new FakeClock(1000);
  const p = new Pipeline({ sink: new MemorySink(), clock, config: { dedupeWindowMs: 500 } });
  assert.equal(p.submit({ id: 'x', key: 'k' }).accepted, true);
  clock.advance(499);
  assert.deepEqual(p.submit({ id: 'x', key: 'k' }), { accepted: false, duplicate: true });
  clock.advance(1);
  assert.equal(p.submit({ id: 'x', key: 'k' }).accepted, true);
  assert.equal(p.stats().duplicates, 1);
});

test('a rejected event is retried after the backoff and then delivered', () => {
  const clock = new FakeClock();
  let fails = 2;
  const sink = new MemorySink({ reject: () => (fails-- > 0 ? 'busy' : null) });
  const p = new Pipeline({ sink, clock });
  p.submit({ id: 'x', key: 'k' });
  p.tick();
  clock.set(99);
  p.tick();
  assert.equal(sink.calls.length, 1);
  clock.set(100);
  p.tick();
  clock.set(300);
  p.tick();
  assert.deepEqual(sink.acceptedIds(), ['x']);
  assert.deepEqual(sink.calls.map((c) => c.now), [0, 100, 300]);
  assert.equal(p.stats().retried, 2);
});

test('an event is dead-lettered after maxAttempts', () => {
  const sink = new MemorySink({ reject: () => 'no' });
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { maxAttempts: 3 } });
  p.submit({ id: 'x', key: 'k' });
  p.runUntilIdle();
  assert.equal(sink.calls.length, 3);
  assert.deepEqual(p.deadLetters, [{ seq: 1, id: 'x', attempts: 3, reason: 'no' }]);
  assert.equal(p.stats().dead, 1);
});

test('ledger totals match the input when locked accounts are retried', () => {
  const sink = new LedgerSink({ locks: [{ account: 'b', until: 200 }, { account: 'c', until: 200 }] });
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { batchSize: 4 } });
  const amounts = { a: '1.00', b: '2.00', c: '3.00', d: '4.00' };
  for (const [account, amount] of Object.entries(amounts)) p.submit({ id: `e-${account}`, key: account, data: { account, amount } });
  p.runUntilIdle();
  assert.deepEqual(sink.report(), amounts);
  assert.equal(p.stats().delivered, 4);
});
