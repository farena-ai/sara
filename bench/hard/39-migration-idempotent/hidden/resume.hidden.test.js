import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { allPoints, api, cli, EXAMPLE, faultAt, FIXTURES, golden, has, snapshot, withStore } from './helpers.js';

const FIXTURE = join(FIXTURES, 'store-v2');

/** Stops a run at point n (throw or torn), then runs again without faults; returns the final snapshot. */
function stopAndResume(from, to, stops) {
  return withStore(from, (dir) => {
    stops.forEach(([n, how], i) => {
      const hook = faultAt(n, how);
      if (i === 0) assert.throws(() => api.migrate(dir, { to, fault: hook }));
      else {
        // a later stop may come after the end of what is left to do: then that run simply finishes
        try {
          api.migrate(dir, { to, fault: hook });
        } catch {}
      }
    });
    api.migrate(dir, { to });
    return snapshot(dir);
  });
}

test('hidden RESUME: the run calls the fault hook for every file it leaves in the store', () => {
  const points = allPoints(EXAMPLE, 4);
  const wrote = new Set(points.filter((p) => p.startsWith('write ') || p.startsWith('rename ')).map((p) => p.split(' ').pop()));
  for (const rel of ['records/customers.ndjson', 'records/orders.ndjson', 'records/order_lines.ndjson', 'quarantine/customers.ndjson', 'quarantine/orders.ndjson', 'quarantine/order_lines.ndjson', 'store.json', 'manifest.json']) {
    assert.ok(wrote.has(rel), `no fault point for ${rel}: ${points.join(', ')}`);
  }
});

test('hidden RESUME: stopped before any operation of a v1 -> v4 run, the next run gives exactly the uninterrupted store', () => {
  const points = allPoints(EXAMPLE, 4);
  const want = golden('example-v4');
  for (let n = 0; n < points.length; n++) assert.deepEqual(stopAndResume(EXAMPLE, 4, [[n, 'throw']]), want, `stopped at ${n}: ${points[n]}`);
});

test('hidden RESUME: a torn write anywhere in a v1 -> v4 run, then a new run, gives exactly the uninterrupted store', () => {
  const points = allPoints(EXAMPLE, 4);
  const want = golden('example-v4');
  for (let n = 0; n < points.length; n++) {
    if (!points[n].startsWith('write ')) continue;
    assert.deepEqual(stopAndResume(EXAMPLE, 4, [[n, 'torn']]), want, `torn at ${n}: ${points[n]}`);
  }
});

test('hidden RESUME: interrupted again while resuming (several times in a row), the store still ends up exact', () => {
  const points = allPoints(EXAMPLE, 4);
  const want = golden('example-v4');
  for (let n = 0; n < points.length; n += 3) {
    assert.deepEqual(stopAndResume(EXAMPLE, 4, [[n, 'torn'], [Math.max(0, Math.floor(n / 2)), 'throw'], [1, 'torn']]), want, `stops at ${n}`);
  }
});

test('hidden RESUME: interruptions of a schema-2 store from an older tool resume to the exact store', () => {
  const points = allPoints(FIXTURE, 4);
  const want = golden('fixture-v2-to-v4');
  for (let n = 0; n < points.length; n++) {
    assert.deepEqual(stopAndResume(FIXTURE, 4, [[n, n % 2 === 0 ? 'torn' : 'throw']]), want, `stopped at ${n}: ${points[n]}`);
  }
});

test('hidden RESUME: interruptions of a run to schema 2 resume to the exact schema-2 store', () => {
  const points = allPoints(EXAMPLE, 2);
  const want = golden('example-v2');
  for (let n = 0; n < points.length; n++) assert.deepEqual(stopAndResume(EXAMPLE, 2, [[n, 'torn']]), want, `stopped at ${n}: ${points[n]}`);
});

test('hidden RESUME: after an interruption status says so, and the interrupted run is finished by the next one', () => {
  withStore(EXAMPLE, (dir) => {
    const points = allPoints(EXAMPLE, 4);
    const middle = points.findIndex((p) => p.startsWith('write records/'));
    assert.throws(() => api.migrate(dir, { fault: faultAt(middle + 2) }));
    assert.equal(api.status(dir).interrupted, true);
    assert.match(cli(dir, 'status', '.').out, /^schema \d, interrupted run \(run again to finish\)\n/);
    const r = cli(dir, 'run', '.');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(snapshot(dir), golden('example-v4'));
    assert.equal(has(dir, '.migrate'), false);
  });
});

test('hidden RESUME: writing only a missing manifest can be interrupted and resumed', () => {
  withStore(EXAMPLE, (dir) => {
    api.migrate(dir);
    rmSync(join(dir, 'manifest.json'));
    const points = [];
    api.migrate(dir, { fault: (p) => points.push(p) });
    assert.ok(points.some((p) => p.endsWith('manifest.json')));
    for (let n = 0; n < points.length; n++) {
      rmSync(join(dir, 'manifest.json'), { force: true });
      assert.throws(() => api.migrate(dir, { fault: faultAt(n, 'torn') }));
      api.migrate(dir);
      assert.deepEqual(snapshot(dir), golden('example-v4'), `stopped at ${points[n]}`);
    }
  });
});

test('hidden RESUME: an interrupted run on a store whose manifest is from an earlier run still finishes', () => {
  withStore(EXAMPLE, (dir) => {
    api.migrate(dir, { to: 2 });
    const points = [];
    withStore(dir, (copy) => api.migrate(copy, { fault: (p) => points.push(p) }));
    const late = points.length - 3;
    assert.throws(() => api.migrate(dir, { fault: faultAt(late) }));
    api.migrate(dir);
    assert.deepEqual(snapshot(dir), golden('example-v4'));
  });
});
