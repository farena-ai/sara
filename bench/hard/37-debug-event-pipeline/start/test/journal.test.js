import assert from 'node:assert/strict';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeClock } from '../src/clock.js';
import { Pipeline } from '../src/pipeline.js';
import { MemorySink } from '../src/sinks/memory-sink.js';
import { events, tempDir } from './helpers.js';

test('a restart carries on with the pending events', () => {
  const t = tempDir();
  try {
    const clock = new FakeClock();
    const sink = new MemorySink({ reject: (e, ctx) => (ctx.now < 100 && e.id === 'e2' ? 'later' : null) });
    const first = new Pipeline({ sink, clock, journalDir: t.dir });
    for (const e of events(3)) first.submit(e);
    first.tick();
    assert.deepEqual(first.pending().map((e) => e.id), ['e2']);
    // the process stops here; a new one opens the same journal
    clock.set(100);
    const second = new Pipeline({ sink, clock, journalDir: t.dir });
    assert.deepEqual(second.pending(), [{ seq: 2, id: 'e2', key: 'k2', attempts: 1, dueAt: 100 }]);
    second.tick();
    assert.deepEqual(sink.acceptedIds(), ['e1', 'e3', 'e2']);
    assert.equal(second.stats().delivered, 3);
    assert.equal(second.submit({ id: 'e4', key: 'k4' }).seq, 4);
  } finally {
    t.cleanup();
  }
});

test('records are one JSON object per line', () => {
  const t = tempDir();
  try {
    const p = new Pipeline({ sink: new MemorySink(), clock: new FakeClock(5), journalDir: t.dir });
    p.submit({ id: 'a', key: 'k', data: { n: 1 } });
    p.tick();
    const lines = readFileSync(join(t.dir, 'segment-1.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines, [{ t: 'enq', seq: 1, id: 'a', key: 'k', at: 5, data: { n: 1 } }, { t: 'done', seq: 1, batch: 1, at: 5 }]);
  } finally {
    t.cleanup();
  }
});

test('a torn last line is ignored and cut off', () => {
  const t = tempDir();
  try {
    const sink = new MemorySink();
    const p = new Pipeline({ sink, clock: new FakeClock(), journalDir: t.dir });
    p.submit({ id: 'a', key: 'k' });
    appendFileSync(join(t.dir, 'segment-1.log'), '{"t":"done","seq":1,"ba');
    const again = new Pipeline({ sink, clock: new FakeClock(), journalDir: t.dir });
    assert.deepEqual(again.pending().map((e) => e.id), ['a']);
    assert.ok(readFileSync(join(t.dir, 'segment-1.log'), 'utf8').endsWith('\n'));
  } finally {
    t.cleanup();
  }
});

test('nothing is delivered twice after a restart on a long journal', () => {
  const t = tempDir();
  try {
    const clock = new FakeClock();
    const sink = new MemorySink();
    const config = { segmentSize: 4, batchSize: 5 };
    const first = new Pipeline({ sink, clock, journalDir: t.dir, config });
    for (const e of events(40)) first.submit(e);
    first.tick();
    clock.advance(50);
    const second = new Pipeline({ sink, clock, journalDir: t.dir, config });
    second.runUntilIdle();
    assert.ok(readdirSync(t.dir).length > 10);
    const twice = sink.acceptedIds().filter((id) => sink.count(id) > 1);
    assert.deepEqual([...new Set(twice)], []);
    assert.equal(sink.accepted.length, 40);
  } finally {
    t.cleanup();
  }
});
