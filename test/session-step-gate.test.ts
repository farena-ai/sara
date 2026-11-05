import test from 'node:test';
import assert from 'node:assert/strict';

const gate = await import('../src/session-step-gate.ts').catch(() => undefined);
const signal = () => new AbortController().signal;

test('provider steps grant FIFO across conversations and double release cannot overlap grants', async () => {
  assert.ok(gate?.acquireSessionStep, 'provider-step FIFO capability is missing');
  const db = {};
  const first = gate.acquireSessionStep(db, 'web', signal());
  assert.equal(first.waiting, false);
  const releaseFirst = await first.ready;
  const second = gate.acquireSessionStep(db, 'discord', signal());
  const third = gate.acquireSessionStep(db, 'third', signal());
  assert.equal(second.waiting, true);
  const order: string[] = [];
  let releaseSecond: (() => void) | undefined;
  const observed = second.ready.then(release => { order.push('second'); releaseSecond = release; });
  const observedThird = third.ready.then(release => { order.push('third'); release(); });
  await Promise.resolve();
  assert.deepEqual(order, []);
  releaseFirst(); releaseFirst();
  await observed;
  assert.deepEqual(order, ['second']);
  releaseSecond!();
  await observedThird;
  assert.deepEqual(order, ['second', 'third']);
  const next = gate.acquireSessionStep(db, 'fresh', signal());
  assert.equal(next.waiting, false, 'empty queues must be cleaned up');
  (await next.ready)();
});

test('aborted waiters and already-aborted callers never get a lease', async () => {
  assert.ok(gate?.acquireSessionStep, 'provider-step abort capability is missing');
  const db = {};
  const release = await gate.acquireSessionStep(db, 'first', signal()).ready;
  const abort = new AbortController();
  const queued = gate.acquireSessionStep(db, 'queued', abort.signal);
  const rejected = assert.rejects(queued.ready, /Stopped/);
  abort.abort(new Error('Stopped.'));
  await rejected;
  release();
  await assert.rejects(gate.acquireSessionStep(db, 'already', abort.signal).ready, /Stopped/);
  (await gate.acquireSessionStep(db, 'next', signal()).ready)();
});

test('exactly twenty waiters per actual database object; other database objects are independent', async () => {
  assert.ok(gate?.acquireSessionStep, 'provider-step queue limit capability is missing');
  const db = {};
  const release = await gate.acquireSessionStep(db, 'first', signal()).ready;
  const waiters = Array.from({ length: 20 }, (_, i) => gate.acquireSessionStep(db, String(i), signal()));
  assert.ok(waiters.every(t => t.waiting));
  await assert.rejects(gate.acquireSessionStep(db, 'overflow', signal()).ready, /waiting|retry/i);
  const other = gate.acquireSessionStep({}, 'same-conversation', signal());
  assert.equal(other.waiting, false);
  (await other.ready)();
  release();
  for (const waiter of waiters) (await waiter.ready)();
});
