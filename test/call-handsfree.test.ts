// Phase 27: hands-free classic calls. You can talk over her while she is still answering.
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error plain browser JavaScript, no types
import { Call } from '../web/voice.js';
// @ts-expect-error plain browser JavaScript, no types
import { CallApprovals, CALL_APPROVAL_WAIT_MS } from '../web/call-approvals.js';

class FakeMic {
  ctx = { sampleRate: 16000 };
  chunks: Float32Array[] = [];
  onFrame: ((f: Float32Array, level: number) => void) | null = null;
  async open() {}
  start() {}
  close() {}
  trim() {}
  stop() {
    return new Uint8Array(10);
  }
  /** `ms` of sound at `level`, in 20 ms frames. */
  feed(level: number, ms: number) {
    for (let t = 0; t < ms; t += 20) {
      const f = new Float32Array(320);
      this.chunks.push(f);
      this.onFrame?.(f, level);
    }
  }
}

test('classic call: she can be interrupted while her reply is still coming, and the new words are sent', async () => {
  const mic = new FakeMic();
  const speaker = { speaking: false, stopped: 0, stop() { this.stopped++; this.speaking = false; } };
  const said: string[] = [];
  let interrupts = 0;
  let finishReply: () => void = () => {};
  let n = 0;
  const call = new Call({
    mic,
    speaker,
    transcribe: async () => ['tell me a long story', 'wait, stop'][n++],
    onUtterance: (text: string) => {
      said.push(text);
      // Her reply takes a while (streaming, then speaking).
      return new Promise<void>((r) => (finishReply = r));
    },
    onInterrupt: () => interrupts++,
    onStatus: () => {},
  });
  await call.start();
  mic.feed(0.2, 400);
  mic.feed(0, 1000);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(said, ['tell me a long story']);
  // She's speaking her (still unfinished) reply; you talk over her.
  speaker.speaking = true;
  mic.feed(0.3, 500);
  assert.equal(speaker.stopped, 1, 'her voice stops');
  assert.equal(interrupts, 1, 'her reply is stopped');
  mic.feed(0, 1000);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(said, ['tell me a long story', 'wait, stop']);
  finishReply();
  call.stop();
});

// R2b: an approval card on a classic call (web/call-approvals.js, DOM-free).
test('classic call approval card shown on video screen', () => {
  const shown: unknown[] = [];
  const released: unknown[] = [];
  const said: string[] = [];
  let stops = 0;
  const timers = new Map<number, () => void>();
  let n = 0;
  const make = () =>
    new CallApprovals({
      t: (s: string) => s,
      say: (s: string) => said.push(s),
      stop: () => stops++,
      show: (c: unknown) => shown.push(c),
      release: (c: unknown) => released.push(c),
      setTimer: (fn: () => void, ms: number) => {
        assert.equal(ms, CALL_APPROVAL_WAIT_MS);
        timers.set(++n, fn);
        return n;
      },
      clearTimer: (h: number) => timers.delete(h),
    });
  assert.equal(CALL_APPROVAL_WAIT_MS, 120_000);
  // The card goes on the call screen, she says one plain line, once per wait.
  const ca = make();
  const card = { id: 'card-1' };
  ca.shown('call-1', card);
  ca.shown('call-1', card);
  assert.deepEqual(shown, [card]);
  assert.deepEqual(said, ['I need your OK for that. It is on your screen.']);
  assert.equal(ca.waiting, 1);
  // A tap answered it: off the call screen, its timer gone, nothing stopped.
  ca.done('call-1');
  assert.deepEqual(released, [card]);
  assert.equal(timers.size, 0);
  assert.equal(stops, 0);
  // Two minutes without a tap: cancelled (the turn stops) and she says so.
  ca.shown('call-2', { id: 'card-2' });
  [...timers.values()][0]();
  assert.equal(stops, 1);
  assert.equal(ca.waiting, 0);
  assert.match(said.at(-1)!, /cancelled that: it waited two minutes/);
  // Hang-up (or a dropped call) cancels what waits; with nothing waiting it does nothing.
  ca.shown('call-3', { id: 'card-3' });
  assert.equal(ca.ended(), true);
  assert.equal(stops, 2);
  assert.equal(ca.ended(), false);
  assert.equal(stops, 2);
  // Talking over her while a card waits is an interruption: cancelled, never an OK.
  ca.shown('call-4', { id: 'card-4' });
  assert.equal(ca.heard(), true);
  assert.equal(stops, 3);
  assert.equal(ca.waiting, 0);
});
