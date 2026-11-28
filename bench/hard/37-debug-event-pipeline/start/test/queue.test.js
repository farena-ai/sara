import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeEntry } from '../src/queue/entry.js';
import { JobQueue } from '../src/queue/queue.js';

const entry = (seq, key, dueAt = 0) => makeEntry({ seq, id: `e${seq}`, key, data: null, enqueuedAt: 0, dueAt });
const ids = (list) => list.map((e) => e.id);

test('entries are kept in seq order whatever order they are added in', () => {
  const q = new JobQueue();
  for (const seq of [3, 1, 2]) q.add(entry(seq, `k${seq}`));
  assert.deepEqual(ids(q.pending()), ['e1', 'e2', 'e3']);
  assert.throws(() => q.add(entry(2, 'k2')), /already queued/);
});

test('takeReady takes ready entries in seq order and removes them', () => {
  const q = new JobQueue();
  for (const seq of [1, 2, 3]) q.add(entry(seq, `k${seq}`));
  assert.deepEqual(ids(q.takeReady(0, 2)), ['e1', 'e2']);
  assert.deepEqual(ids(q.pending()), ['e3']);
});

test('an entry that is not due yet is not taken', () => {
  const q = new JobQueue();
  q.add(entry(1, 'a', 500));
  q.add(entry(2, 'b'));
  assert.deepEqual(ids(q.takeReady(100, 5)), ['e2']);
  assert.deepEqual(ids(q.takeReady(500, 5)), ['e1']);
});

test('a batch never holds two entries of the same key', () => {
  const q = new JobQueue();
  q.add(entry(1, 'a'));
  q.add(entry(2, 'a'));
  q.add(entry(3, 'b'));
  assert.deepEqual(ids(q.takeReady(0, 5)), ['e1', 'e3']);
  assert.deepEqual(ids(q.takeReady(0, 5)), ['e2']);
});

test('held entries do not take a place in the batch', () => {
  const q = new JobQueue();
  q.add(entry(1, 'a'));
  q.add(entry(2, 'a'));
  q.add(entry(3, 'b'));
  q.add(entry(4, 'c'));
  q.add(entry(5, 'd'));
  assert.deepEqual(ids(q.takeReady(0, 3)), ['e1', 'e3', 'e4']);
});
