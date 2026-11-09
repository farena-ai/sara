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

test('mnt2: a parallel cap lets different conversations step together, one step per conversation, FIFO when full', async () => {
  const db = {};
  const opts = { parallel: 2 };
  const a = gate!.acquireSessionStep(db, 'a', signal(), opts);
  const b = gate!.acquireSessionStep(db, 'b', signal(), opts);
  assert.equal(a.waiting, false); assert.equal(b.waiting, false, 'a second conversation is not held behind the first');
  const releaseA = await a.ready; const releaseB = await b.ready;
  const a2 = gate!.acquireSessionStep(db, 'a', signal(), { parallel: 4 });
  assert.equal(a2.waiting, true, 'the same conversation never runs two steps at once');
  const c = gate!.acquireSessionStep(db, 'c', signal(), opts);
  assert.equal(c.waiting, true, 'the owner-wide cap holds the third conversation');
  assert.equal(gate!.sessionStepBusy(db, 'a'), true); assert.equal(gate!.sessionStepBusy(db, 'c'), false);
  const order: string[] = [];
  const seen = [a2.ready.then(r => { order.push('a2'); return r; }), c.ready.then(r => { order.push('c'); return r; })];
  releaseB(); releaseB();
  await seen[1];
  assert.deepEqual(order, ['c'], 'a free slot skips a waiter whose conversation is still busy');
  releaseA();
  const releaseA2 = await seen[0]; (await seen[1])();
  assert.deepEqual(order, ['c', 'a2']); releaseA2();
  assert.equal(gate!.acquireSessionStep(db, 'z', signal(), opts).waiting, false, 'empty queues are cleaned up');
});

test('mnt2: a shared key (one scene) keeps its seats one at a time while busy shows the seat conversation', async () => {
  const db = {};
  const seat1 = gate!.acquireSessionStep(db, 'seat-1', signal(), { parallel: 4, key: 'scene:7' });
  const release1 = await seat1.ready;
  assert.equal(gate!.sessionStepBusy(db, 'seat-1'), true);
  const seat2 = gate!.acquireSessionStep(db, 'seat-2', signal(), { parallel: 4, key: 'scene:7' });
  assert.equal(seat2.waiting, true);
  assert.equal(gate!.acquireSessionStep(db, 'other', signal(), { parallel: 4 }).waiting, false);
  release1(); (await seat2.ready)();
});

test('mnt2: the waiting limit grows with the cap (twenty per parallel step) and the refusal says to retry', async () => {
  const db = {};
  const holds = await Promise.all(['h1', 'h2'].map(k => gate!.acquireSessionStep(db, k, signal(), { parallel: 2 }).ready));
  const waiters = Array.from({ length: 40 }, (_, i) => gate!.acquireSessionStep(db, `w${i}`, signal(), { parallel: 2 }));
  assert.ok(waiters.every(w => w.waiting));
  await assert.rejects(gate!.acquireSessionStep(db, 'overflow', signal(), { parallel: 2 }).ready, /Too many replies are waiting/);
  for (const h of holds) h();
  for (const w of waiters) (await w.ready)();
});
