import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { api, cli, EXAMPLE, FIXTURES, golden, read, snapshot, withStore } from './helpers.js';

test('hidden RESUME "Idempotency": a second run changes nothing and makes no write at all', () => {
  withStore(EXAMPLE, (dir) => {
    api.migrate(dir);
    const before = snapshot(dir);
    const points = [];
    assert.deepEqual(api.migrate(dir, { fault: (p) => points.push(p) }), { from: 4, to: 4, steps: [] });
    assert.deepEqual(points, []);
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(cli(dir, 'run', '.'), { code: 0, out: 'already at schema 4, nothing to do\n', err: '' });
    assert.deepEqual(snapshot(dir), before);
  });
});

test('hidden RESUME "Idempotency": a run to schema 2 twice, and the fixture store twice, are the same as once', () => {
  withStore(EXAMPLE, (dir) => {
    api.migrate(dir, { to: 2 });
    api.migrate(dir, { to: 2 });
    assert.deepEqual(snapshot(dir), golden('example-v2'));
  });
  withStore(join(FIXTURES, 'store-v2'), (dir) => {
    api.migrate(dir);
    api.migrate(dir);
    assert.deepEqual(snapshot(dir), golden('fixture-v2-to-v4'));
  });
});

test('hidden RESUME "Idempotency": a store at the target without a manifest only gets its manifest', () => {
  withStore(EXAMPLE, (dir) => {
    api.migrate(dir);
    rmSync(join(dir, 'manifest.json'));
    const points = [];
    assert.deepEqual(api.migrate(dir, { fault: (p) => points.push(p) }).steps, []);
    assert.ok(points.every((p) => !/records\/|quarantine\//.test(p)), points.join(', '));
    assert.deepEqual(snapshot(dir), golden('example-v4'));
  });
});

test('hidden RESUME "Idempotency": a store at the target whose manifest does not match is refused and left alone', () => {
  withStore(EXAMPLE, (dir) => {
    api.migrate(dir);
    writeFileSync(join(dir, 'records', 'customers.ndjson'), `${read(dir, 'records/customers.ndjson')}{"id":"new"}\n`);
    const before = snapshot(dir);
    assert.throws(() => api.migrate(dir), (e) => e instanceof api.ManifestError && e.message === 'manifest does not match records/customers.ndjson');
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(cli(dir, 'run', '.'), { code: 3, out: '', err: 'error: manifest does not match records/customers.ndjson\n' });
  });
});

test('hidden RESUME: migrating to a lower schema is refused', () => {
  withStore(EXAMPLE, (dir) => {
    api.migrate(dir, { to: 3 });
    assert.throws(() => api.migrate(dir, { to: 2 }), api.StoreError);
    assert.equal(cli(dir, 'run', '.', '--to', '1').code, 1);
  });
});

test('hidden CLI: run prints every step, then the schema', () => {
  withStore(join(FIXTURES, 'store-v2'), (dir) => {
    assert.deepEqual(cli(dir, 'run', '.', '--to', '3'), { code: 0, out: 'v2->v3 done\nstore is at schema 3\n', err: '' });
    assert.deepEqual(cli(dir, 'run', '.'), { code: 0, out: 'v3->v4 done\nstore is at schema 4\n', err: '' });
  });
});
