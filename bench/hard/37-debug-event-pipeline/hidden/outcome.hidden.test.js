import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { amountLine, callTimes, cli, FakeClock, LedgerSink, MemorySink, Pipeline, segments, withDir } from './helpers.js';

test('hidden §5.1: two rejected events next to each other in a batch are both retried', () => {
  const sink = new MemorySink({ reject: (e, ctx) => ((e.id === 'b' || e.id === 'c') && ctx.now === 0 ? 'busy' : null) });
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { batchSize: 5 } });
  for (const id of ['a', 'b', 'c', 'd']) p.submit({ id, key: id });
  p.tick();
  assert.deepEqual(p.pending().map((e) => [e.id, e.attempts, e.dueAt]), [['b', 1, 100], ['c', 1, 100]]);
  p.clock.set(100);
  p.tick();
  assert.deepEqual(sink.acceptedIds(), ['a', 'd', 'b', 'c']);
});

test('hidden §5.1: three or more rejections in a row, at the start and the end of a batch', () => {
  const bad = new Set(['e1', 'e2', 'e3', 'e5', 'e7', 'e8']);
  const sink = new MemorySink({ reject: (e, ctx) => (bad.has(e.id) && ctx.now === 0 ? 'busy' : null) });
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { batchSize: 8 } });
  for (let i = 1; i <= 8; i++) p.submit({ id: `e${i}`, key: `k${i}` });
  p.tick();
  assert.deepEqual(p.pending().map((e) => e.id), ['e1', 'e2', 'e3', 'e5', 'e7', 'e8']);
  assert.deepEqual(sink.acceptedIds(), ['e4', 'e6']);
});

test('hidden §6.3: a rejected event is never counted or recorded as delivered', () => {
  withDir((dir) => {
    const sink = new MemorySink({ reject: (e) => (e.id === 'b' || e.id === 'c' ? 'busy' : null) });
    const p = new Pipeline({ sink, clock: new FakeClock(), journalDir: dir, config: { batchSize: 5 } });
    for (const id of ['a', 'b', 'c', 'd']) p.submit({ id, key: id });
    p.tick();
    assert.equal(p.stats().delivered, 2);
    const doneSeqs = Object.values(segments(dir)).flat().filter((r) => r.t === 'done').map((r) => r.seq);
    assert.deepEqual(doneSeqs.sort(), [1, 4]);
  });
});

test('hidden §6.1: accepted events of a partly rejected batch are never given to the sink again', () => {
  const sink = new MemorySink({ reject: (e, ctx) => (['b', 'c'].includes(e.id) && ctx.now < 300 ? 'busy' : null) });
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { batchSize: 5 } });
  for (const id of ['a', 'b', 'c', 'd', 'e']) p.submit({ id, key: id });
  p.runUntilIdle();
  for (const id of ['a', 'd', 'e']) assert.deepEqual(callTimes(sink, id), [0], id);
  assert.deepEqual(callTimes(sink, 'b'), [0, 100, 300]);
  assert.deepEqual(callTimes(sink, 'c'), [0, 100, 300]);
  for (const id of ['a', 'b', 'c', 'd', 'e']) assert.equal(sink.count(id), 1);
});

test('hidden SINKS.md: rejected ids may come in any order', () => {
  const sink = {
    calls: 0,
    deliver(events) {
      this.calls++;
      if (this.calls === 1) return { rejected: [events[3].id, events[2].id, events[1].id], reason: 'later' };
      return undefined;
    },
  };
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { batchSize: 5 } });
  for (const id of ['a', 'b', 'c', 'd', 'e']) p.submit({ id, key: id });
  p.tick();
  assert.deepEqual(p.pending().map((e) => e.id), ['b', 'c', 'd']);
  assert.equal(p.stats().delivered, 2);
});

test('hidden §5.1: a sink that throws fails the whole batch', () => {
  let calls = 0;
  const sink = new MemorySink({ fail: () => (calls++ === 0 ? 'connection reset' : null) });
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { batchSize: 3 } });
  for (const id of ['a', 'b', 'c']) p.submit({ id, key: id });
  p.tick();
  assert.deepEqual(p.pending().map((e) => [e.id, e.attempts]), [['a', 1], ['b', 1], ['c', 1]]);
  p.clock.set(100);
  p.tick();
  assert.deepEqual(sink.acceptedIds(), ['a', 'b', 'c']);
  assert.equal(p.stats().retried, 3);
});

test('hidden §6.2 / §8: with locked accounts every event ends delivered once, and the counters add up', () => {
  const sink = new LedgerSink({ locks: [{ account: 'acct-3', until: 400 }, { account: 'acct-4', until: 400 }] });
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { batchSize: 6 } });
  const want = new Map();
  for (let i = 1; i <= 30; i++) {
    const account = `acct-${1 + (i % 6)}`;
    const cents = i * 37;
    want.set(account, (want.get(account) ?? 0) + cents);
    p.submit({ id: `evt-${i}`, key: account, data: { account, amount: (cents / 100).toFixed(2) } });
  }
  p.runUntilIdle();
  const s = p.stats();
  assert.equal(s.delivered, 30);
  assert.equal(s.submitted, s.delivered + s.dead + s.pending);
  assert.equal(new Set(sink.booked).size, 30);
  assert.equal(sink.booked.length, 30);
  for (const [account, cents] of want) assert.equal(sink.report()[account], (cents / 100).toFixed(2), account);
});

test('hidden CLI.md: relay totals and the ledger agree after the locked-accounts run', () => {
  withDir((dir) => {
    const lines = [];
    for (let i = 1; i <= 30; i++) {
      const account = `acct-${1 + ((i - 1) % 6)}`;
      lines.push(amountLine(`evt-${String(i).padStart(4, '0')}`, account, `${i}.${String(i % 100).padStart(2, '0')}`));
    }
    writeFileSync(join(dir, 'locks.ndjson'), `${lines.join('\n')}\n`);
    const r = cli(dir, 'run', 'locks.ndjson', '--journal', 'j', '--batch', '6', '--rate', '6', '--lock', 'acct-3:400', '--lock', 'acct-4:400', '--json');
    assert.equal(r.code, 0, r.err);
    const { totals, stats } = JSON.parse(r.out);
    assert.deepEqual(JSON.parse(cli(dir, 'totals', '--journal', 'j', '--json').out), totals);
    assert.equal(stats.delivered, 30);
    assert.equal(totals['acct-4'], '80.80');
  });
});

test('hidden §5.3: an invalid amount is rejected every time and ends in the dead letters', () => {
  const sink = new LedgerSink();
  const p = new Pipeline({ sink, clock: new FakeClock(), config: { batchSize: 4, maxAttempts: 3 } });
  p.submit({ id: 'ok1', key: 'a', data: { account: 'a', amount: '1.00' } });
  p.submit({ id: 'bad', key: 'b', data: { account: 'b', amount: 'lots' } });
  p.submit({ id: 'bad2', key: 'c', data: { account: 'c', amount: '1.234' } });
  p.submit({ id: 'ok2', key: 'd', data: { account: 'd', amount: '2.00' } });
  p.runUntilIdle();
  assert.deepEqual(p.deadLetters.map((d) => [d.id, d.attempts, d.reason]), [['bad', 3, 'invalid amount'], ['bad2', 3, 'invalid amount']]);
  assert.deepEqual(sink.report(), { a: '1.00', d: '2.00' });
  assert.equal(p.stats().delivered, 2);
});
