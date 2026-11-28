import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callTimes, FakeClock, keysUniquePerCall, MemorySink, Pipeline } from './helpers.js';

const keyOf = (id) => id.replace(/\d+$/, '');

function submitAll(p, ids) {
  for (const id of ids) p.submit({ id, key: keyOf(id) });
}

test('hidden §3.3: held events do not take a place, so the batch is full when batchSize events are ready', () => {
  const sink = new MemorySink();
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { batchSize: 4 } });
  submitAll(p, ['a1', 'a2', 'a3', 'b1', 'b2', 'c1', 'd1', 'e1', 'f1']);
  p.tick();
  assert.deepEqual(sink.calls.map((c) => c.ids), [['a1', 'b1', 'c1', 'd1'], ['a2', 'b2', 'e1', 'f1'], ['a3']]);
});

test('hidden §3.2: a batch never holds two events with the same key', () => {
  const sink = new MemorySink();
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { batchSize: 5 } });
  submitAll(p, ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'c1']);
  p.tick();
  assert.ok(keysUniquePerCall(sink, keyOf), JSON.stringify(sink.calls.map((c) => c.ids)));
  assert.deepEqual(sink.calls.map((c) => c.ids), [['a1', 'b1', 'c1'], ['a2', 'b2'], ['a3'], ['a4']]);
});

test('hidden §4.1: a later event of a key waits while the earlier one waits for its retry', () => {
  let failures = 2;
  const sink = new MemorySink({ reject: (e) => (e.id === 'a1' && failures-- > 0 ? 'busy' : null) });
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { batchSize: 3 } });
  submitAll(p, ['a1', 'a2', 'a3', 'b1']);
  p.runUntilIdle();
  const order = sink.acceptedIds().filter((id) => id.startsWith('a'));
  assert.deepEqual(order, ['a1', 'a2', 'a3']);
  assert.deepEqual(callTimes(sink, 'a2'), [300]);
  assert.deepEqual(callTimes(sink, 'b1'), [0]);
});

test('hidden §4.1: other keys go on, in full batches, while one key waits for a retry', () => {
  const sink = new MemorySink({ reject: (e, ctx) => (e.key === 'a' && ctx.now < 100 ? 'busy' : null) });
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { batchSize: 3 } });
  submitAll(p, ['a1', 'a2', 'a3', 'a4', 'b1', 'c1', 'd1', 'e1', 'f1', 'g1']);
  p.tick();
  assert.deepEqual(sink.calls.map((c) => c.ids), [['a1', 'b1', 'c1'], ['d1', 'e1', 'f1'], ['g1']]);
  assert.deepEqual(p.pending().map((e) => e.id), ['a1', 'a2', 'a3', 'a4']);
});

test('hidden §4.1: once the earlier event is dead-lettered the next event of its key goes on', () => {
  const sink = new MemorySink({ reject: (e) => (e.id === 'a1' ? 'never' : null) });
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { batchSize: 2, maxAttempts: 2 } });
  submitAll(p, ['a1', 'a2', 'b1']);
  p.runUntilIdle();
  assert.deepEqual(callTimes(sink, 'a1'), [0, 100]);
  assert.deepEqual(callTimes(sink, 'a2'), [100]);
  assert.deepEqual(sink.acceptedIds(), ['b1', 'a2']);
  assert.deepEqual(p.deadLetters.map((d) => d.id), ['a1']);
});

test('hidden §4.1: per-key order holds for many keys and random-looking failures', () => {
  const sink = new MemorySink({ reject: (e) => (e.attempt <= (e.seq * 7) % 3 ? 'flaky' : null) });
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { batchSize: 4, maxAttempts: 10 } });
  const ids = [];
  for (let i = 1; i <= 60; i++) ids.push(`${'abcde'[(i * 3) % 5]}${i}`);
  submitAll(p, ids);
  p.runUntilIdle();
  assert.equal(sink.accepted.length, 60);
  for (const key of 'abcde') {
    const seqs = sink.accepted.filter((e) => e.key === key).map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), `key ${key}`);
  }
  assert.ok(keysUniquePerCall(sink, keyOf));
});

test('hidden §4.2: within a batch events are in seq order, retried ones included', () => {
  let first = true;
  const sink = new MemorySink({ reject: (e) => (e.id === 'b1' && first ? ((first = false), 'busy') : null) });
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { batchSize: 10 } });
  submitAll(p, ['a1', 'b1', 'c1']);
  p.tick();
  p.clock.set(100);
  submitAll(p, ['a2', 'd1']);
  p.tick();
  assert.deepEqual(sink.calls.map((c) => c.ids), [['a1', 'b1', 'c1'], ['b1', 'a2', 'd1']]);
});

test('hidden §3.2: tick() keeps making batches until nothing is ready', () => {
  const sink = new MemorySink();
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { batchSize: 2 } });
  submitAll(p, ['a1', 'a2', 'a3', 'b1', 'c1', 'd1']);
  assert.equal(p.tick(), 3);
  assert.equal(p.stats().pending, 0);
  assert.deepEqual(sink.calls.map((c) => c.ids), [['a1', 'b1'], ['a2', 'c1'], ['a3', 'd1']]);
});

test('hidden §3.3: a short batch only happens when fewer events are ready', () => {
  const sink = new MemorySink({ reject: (e, ctx) => (e.key === 'a' && ctx.now === 0 ? 'busy' : null) });
  const clock = new FakeClock();
  const p = new Pipeline({ sink, clock, config: { batchSize: 3 } });
  submitAll(p, ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2', 'b3', 'c1']);
  p.tick();
  clock.set(50);
  submitAll(p, ['d1', 'e1', 'f1', 'g1']);
  p.tick();
  assert.deepEqual(sink.calls.map((c) => c.ids), [['a1', 'b1', 'c1'], ['b2'], ['b3'], ['d1', 'e1', 'f1'], ['g1']]);
});
