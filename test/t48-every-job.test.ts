// D2: a worker moved onto everyJob() (src/tick-jobs.ts) runs on its period, never overlaps itself
// when a round is slow, keeps going after a round that throws, and stops on shutdown.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ReviewWorker } from '../src/review.ts';
import { resetTickJobs, tickJobStatus } from '../src/tick-jobs.ts';

const flush = () => new Promise((r) => setImmediate(r));

test('D2 everyJob: a moved worker runs on its period, skips while busy, survives a throw, stops', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  resetTickJobs();
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: unknown) => void warned.push(String(m));
  try {
    const w = new ReviewWorker({} as never);
    let calls = 0;
    let mode: 'ok' | 'slow' | 'throw' = 'ok';
    let release: () => void = () => {};
    Object.assign(w, {
      tick: () => {
        calls++;
        if (mode === 'throw') throw new Error('disk full');
        if (mode === 'slow') return new Promise<void>((r) => (release = r));
        return Promise.resolve(undefined);
      },
    });
    w.start(60_000);
    const rec = () => tickJobStatus().find((j) => j.name === 'review')!;

    // The first round comes after one period, as with setInterval.
    t.mock.timers.tick(59_999);
    assert.equal(calls, 0);
    t.mock.timers.tick(1);
    assert.equal(calls, 1);
    await flush();
    assert.equal(rec().runs, 1);

    // A slow round: the next two due rounds are skipped, not run on top of it.
    mode = 'slow';
    t.mock.timers.tick(60_000);
    assert.equal(calls, 2);
    t.mock.timers.tick(60_000);
    t.mock.timers.tick(60_000);
    assert.equal(calls, 2);
    assert.equal(rec().skipped, 2);
    mode = 'throw';
    release();
    await flush();

    // A round that throws is logged under the worker's name; the next one still runs.
    t.mock.timers.tick(60_000);
    assert.equal(calls, 3);
    assert.equal(rec().failing, 1);
    assert.match(rec().lastError ?? '', /disk full/);
    assert.ok(warned.includes('review: disk full'), warned.join('\n'));
    mode = 'ok';
    t.mock.timers.tick(60_000);
    assert.equal(calls, 4);
    await flush();
    assert.equal(rec().failing, 0);

    // Shutdown: no more rounds.
    w.stop();
    t.mock.timers.tick(10 * 60_000);
    assert.equal(calls, 4);
  } finally {
    console.warn = warn;
  }
});
