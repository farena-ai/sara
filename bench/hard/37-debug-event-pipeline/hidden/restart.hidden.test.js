import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { callTimes, cli, done, enq, fail, FakeClock, MemorySink, Pipeline, segments, twice, withDir, writeJournal } from './helpers.js';

/** 30 accepted events, the first 20 delivered; 4 records per segment, so 13 segments. */
function longJournal() {
  const records = [];
  for (let i = 1; i <= 30; i++) records.push(enq(i, `e${i}`, `k${i}`, i));
  for (let i = 1; i <= 20; i++) records.push(done(i, Math.ceil(i / 5), 100));
  return records;
}

test('hidden §6.1 exactly once: nothing is delivered twice after a restart on a journal of more than nine segments', () => {
  withDir((dir) => {
    const clock = new FakeClock();
    const sink = new MemorySink();
    const config = { segmentSize: 3, batchSize: 4 };
    const first = new Pipeline({ sink, clock, journalDir: dir, config });
    for (let i = 1; i <= 25; i++) first.submit({ id: `e${i}`, key: `k${i % 7}` });
    first.tick();
    clock.advance(50);
    for (let i = 26; i <= 35; i++) first.submit({ id: `e${i}`, key: `k${i % 7}` });
    first.tick();
    clock.advance(50);
    const second = new Pipeline({ sink, clock, journalDir: dir, config });
    second.runUntilIdle();
    assert.deepEqual(twice(sink), []);
    assert.equal(sink.accepted.length, 35);
  });
});

test('hidden §7.1 / JOURNAL.md: a 13-segment journal written by 1.2 recovers exactly its pending events', () => {
  withDir((dir) => {
    writeJournal(dir, longJournal(), 4);
    const p = new Pipeline({ sink: new MemorySink(), clock: new FakeClock(200), journalDir: dir, config: { segmentSize: 4 } });
    assert.deepEqual(p.pending().map((e) => e.id), ['e21', 'e22', 'e23', 'e24', 'e25', 'e26', 'e27', 'e28', 'e29', 'e30']);
    const s = p.stats();
    assert.equal(s.submitted, 30);
    assert.equal(s.delivered, 20);
    assert.equal(s.pending, 10);
  });
});

test('hidden §6.1: after recovering a 1.2 journal only its pending events reach the sink', () => {
  withDir((dir) => {
    writeJournal(dir, longJournal(), 4);
    const sink = new MemorySink();
    const p = new Pipeline({ sink, clock: new FakeClock(200), journalDir: dir, config: { segmentSize: 4, batchSize: 50 } });
    p.runUntilIdle();
    assert.deepEqual(sink.acceptedIds(), ['e21', 'e22', 'e23', 'e24', 'e25', 'e26', 'e27', 'e28', 'e29', 'e30']);
  });
});

test('hidden §5.4: attempts and due time come from the latest fail record, wherever the segments fall', () => {
  withDir((dir) => {
    const records = [enq(1, 'x', 'x', 0)];
    let seq = 2;
    const filler = (n) => {
      for (let i = 0; i < n; i++) records.push(i % 2 === 0 ? enq(seq, `f${seq}`, `f${seq}`, 0) : done(seq++, 1, 0));
    };
    filler(31); // records 2..32: segments 1 to 8
    records.push(fail(1, 1, 100, 0)); // segment 9
    filler(3);
    records.push(fail(1, 2, 300, 100)); // segment 10
    filler(3);
    records.push(fail(1, 3, 700, 300)); // segment 11
    writeJournal(dir, records, 4);
    const p = new Pipeline({ sink: new MemorySink(), clock: new FakeClock(300), journalDir: dir, config: { segmentSize: 4 } });
    assert.deepEqual(p.pending().find((e) => e.id === 'x'), { seq: 1, id: 'x', key: 'x', attempts: 3, dueAt: 700 });
  });
});

/** Rejects `x` always; restarts the pipeline before every tick, the clock jumping to the next due time. */
function rejectWithRestarts(dir, maxAttempts) {
  const sink = new MemorySink({ reject: (e) => (e.id === 'x' ? 'down' : null) });
  const clock = new FakeClock();
  const config = { segmentSize: 1, maxAttempts };
  let p = new Pipeline({ sink, clock, journalDir: dir, config });
  p.submit({ id: 'x', key: 'x' });
  for (let i = 1; i <= 4; i++) p.submit({ id: `f${i}`, key: `f${i}` });
  for (let round = 0; round < 3 * maxAttempts; round++) {
    p.tick();
    p = new Pipeline({ sink, clock, journalDir: dir, config });
    const next = p.pending().find((e) => e.id === 'x');
    if (!next) break;
    clock.set(Math.max(clock.now(), next.dueAt));
  }
  return { sink, p };
}

test('hidden §5.3 / §5.4: across restarts an event is given to the sink at most maxAttempts times', () => {
  withDir((dir) => {
    const { sink, p } = rejectWithRestarts(dir, 5);
    assert.equal(callTimes(sink, 'x').length, 5);
    assert.deepEqual(p.deadLetters.map((d) => [d.id, d.attempts]), [['x', 5]]);
    assert.equal(p.stats().dead, 1);
  });
});

test('hidden §5.2 / §5.4: a restart never makes a retry due earlier than its backoff', () => {
  withDir((dir) => {
    const { sink } = rejectWithRestarts(dir, 5);
    assert.deepEqual(callTimes(sink, 'x'), [0, 100, 300, 700, 1500]);
  });
});

test('hidden JOURNAL.md: after restarts no segment holds more than segmentSize records', () => {
  withDir((dir) => {
    writeJournal(dir, longJournal(), 4);
    const sink = new MemorySink();
    const clock = new FakeClock(200);
    let p = new Pipeline({ sink, clock, journalDir: dir, config: { segmentSize: 4 } });
    for (let i = 31; i <= 40; i++) p.submit({ id: `e${i}`, key: `k${i}` });
    p.tick();
    clock.advance(50);
    p = new Pipeline({ sink, clock, journalDir: dir, config: { segmentSize: 4 } });
    for (let i = 41; i <= 45; i++) p.submit({ id: `e${i}`, key: `k${i}` });
    p.tick();
    for (const [name, records] of Object.entries(segments(dir))) assert.ok(records.length <= 4, `${name} has ${records.length} records`);
  });
});

test('hidden JOURNAL.md: new records go to the newest segment, and the next one is numbered after it', () => {
  withDir((dir) => {
    writeJournal(dir, longJournal(), 4); // segment-13.log holds 2 records
    const p = new Pipeline({ sink: new MemorySink(), clock: new FakeClock(200), journalDir: dir, config: { segmentSize: 4 } });
    for (let i = 31; i <= 34; i++) p.submit({ id: `e${i}`, key: `k${i}` });
    const segs = segments(dir);
    assert.deepEqual(Object.keys(segs).sort((a, b) => a.length - b.length || a.localeCompare(b)), Array.from({ length: 14 }, (_, i) => `segment-${i + 1}.log`));
    assert.deepEqual(segs['segment-13.log'].map((r) => r.seq), [19, 20, 31, 32]);
    assert.deepEqual(segs['segment-14.log'].map((r) => r.seq), [33, 34]);
    assert.deepEqual(segs['segment-9.log'].map((r) => r.t), ['done', 'done', 'done', 'done']);
  });
});

test('hidden JOURNAL.md / CLI.md: relay journal ls lists the segments oldest first', () => {
  withDir((dir) => {
    writeJournal(join(dir, 'j'), longJournal(), 4);
    const r = cli(dir, 'journal', 'ls', '--journal', 'j', '--json');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out).map((s) => s.name), Array.from({ length: 13 }, (_, i) => `segment-${i + 1}.log`));
  });
});

test('hidden CLI.md: relay journal pending on a long journal shows the pending events in seq order', () => {
  withDir((dir) => {
    writeJournal(join(dir, 'j'), longJournal(), 4);
    const r = cli(dir, 'journal', 'pending', '--journal', 'j', '--json');
    assert.deepEqual(JSON.parse(r.out).map((e) => e.seq), [21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
  });
});

test('hidden JOURNAL.md: a torn last line is cut off the newest segment (segment-13), not another one', () => {
  withDir((dir) => {
    writeJournal(dir, longJournal(), 4);
    const nine = readFileSync(join(dir, 'segment-9.log'), 'utf8');
    appendFileSync(join(dir, 'segment-13.log'), '{"t":"done","seq":21,"ba');
    const p = new Pipeline({ sink: new MemorySink(), clock: new FakeClock(200), journalDir: dir, config: { segmentSize: 4 } });
    assert.equal(p.pending().length, 10);
    assert.ok(readFileSync(join(dir, 'segment-13.log'), 'utf8').endsWith('}\n'));
    assert.equal(readFileSync(join(dir, 'segment-9.log'), 'utf8'), nine);
  });
});

test('hidden §1.2 / §3.4: seq and batch ids carry on after a restart on a long journal', () => {
  withDir((dir) => {
    writeJournal(dir, longJournal(), 4);
    const sink = new MemorySink();
    const p = new Pipeline({ sink, clock: new FakeClock(200), journalDir: dir, config: { segmentSize: 4, batchSize: 100 } });
    assert.equal(p.submit({ id: 'new', key: 'n' }).seq, 31);
    p.tick();
    assert.deepEqual(sink.calls.map((c) => c.batchId), [5]);
  });
});

test('hidden §8: after restarts, submitted = delivered + dead + pending', () => {
  withDir((dir) => {
    const clock = new FakeClock();
    const sink = new MemorySink({ reject: (e, ctx) => (e.key === 'k0' && ctx.now < 400 ? 'busy' : null) });
    const config = { segmentSize: 2, batchSize: 3 };
    let p = new Pipeline({ sink, clock, journalDir: dir, config });
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 4; i++) p.submit({ id: `r${round}-${i}`, key: `k${i}` });
      p.tick();
      clock.advance(100);
      p = new Pipeline({ sink, clock, journalDir: dir, config });
      const s = p.stats();
      assert.equal(s.submitted, s.delivered + s.dead + s.pending, JSON.stringify(s));
    }
    p.runUntilIdle();
    assert.equal(p.stats().delivered, 24);
    assert.equal(sink.accepted.length, 24);
  });
});

test('hidden §7.1: two restarts in a row recover the same pending events', () => {
  withDir((dir) => {
    writeJournal(dir, longJournal(), 4);
    const a = new Pipeline({ sink: new MemorySink(), clock: new FakeClock(200), journalDir: dir, config: { segmentSize: 4 } });
    a.submit({ id: 'e31', key: 'k31' });
    const b = new Pipeline({ sink: new MemorySink(), clock: new FakeClock(200), journalDir: dir, config: { segmentSize: 4 } });
    const c = new Pipeline({ sink: new MemorySink(), clock: new FakeClock(200), journalDir: dir, config: { segmentSize: 4 } });
    assert.deepEqual(b.pending(), a.pending());
    assert.deepEqual(c.pending(), a.pending());
    assert.equal(a.pending().length, 11);
  });
});

test('hidden §2.2: the dedupe window survives a restart on a long journal', () => {
  withDir((dir) => {
    writeJournal(dir, longJournal(), 4);
    const p = new Pipeline({ sink: new MemorySink(), clock: new FakeClock(200), journalDir: dir, config: { segmentSize: 4, dedupeWindowMs: 1000 } });
    assert.deepEqual(p.submit({ id: 'e3', key: 'k3' }), { accepted: false, duplicate: true });
  });
});

test('hidden CLI.md: a killed nightly-sized run resumed with the same command books every event once', () => {
  withDir((dir) => {
    const lines = [];
    const want = {};
    for (let i = 1; i <= 150; i++) {
      const account = `acct-${1 + ((i * 7) % 8)}`;
      const cents = ((i * 389) % 9000) - 1500;
      lines.push(JSON.stringify({ id: `evt-${i}`, key: account, data: { account, amount: (cents / 100).toFixed(2) } }));
      want[account] = (want[account] ?? 0) + cents;
    }
    writeFileSync(join(dir, 'nightly.ndjson'), `${lines.join('\n')}\n`);
    const args = ['run', 'nightly.ndjson', '--journal', 'j', '--segment-size', '16', '--batch', '5', '--rate', '4', '--lock', 'acct-2:1200', '--max-attempts', '6'];
    assert.equal(cli(dir, ...args, '--stop-after', '32').code, 0);
    const second = cli(dir, ...args, '--json');
    assert.equal(second.code, 0, second.err);
    const { stats } = JSON.parse(second.out);
    assert.equal(stats.submitted, 150);
    assert.equal(stats.delivered, 150);
    const totals = JSON.parse(cli(dir, 'totals', '--journal', 'j', '--json').out);
    const expected = {};
    for (const account of Object.keys(want).sort()) expected[account] = (want[account] / 100).toFixed(2);
    assert.deepEqual(totals, expected);
  });
});
