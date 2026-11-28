import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { api, cli, EXAMPLE, FIXTURES, golden, read, snapshot, withStore } from './helpers.js';

test('hidden STORE/MIGRATIONS: the example store migrated to schema 4 is exactly the expected store', () => {
  withStore(EXAMPLE, (dir) => {
    assert.deepEqual(api.migrate(dir), { from: 1, to: 4, steps: ['v1->v2', 'v2->v3', 'v3->v4'] });
    assert.deepEqual(snapshot(dir), golden('example-v4'));
  });
});

test('hidden STORE/MIGRATIONS: the example store migrated to schema 2 (with its manifest) is exactly the expected store', () => {
  withStore(EXAMPLE, (dir) => {
    api.migrate(dir, { to: 2 });
    assert.deepEqual(snapshot(dir), golden('example-v2'));
  });
});

test('hidden STORE/MIGRATIONS: a schema-2 store from an older tool (other files, old quarantine) to schema 4', () => {
  withStore(join(FIXTURES, 'store-v2'), (dir) => {
    assert.deepEqual(api.migrate(dir).steps, ['v2->v3', 'v3->v4']);
    assert.deepEqual(snapshot(dir), golden('fixture-v2-to-v4'));
  });
});

test('hidden STORE: migrating 1->2 and then 2->4 gives the same store as 1->4 in one run', () => {
  withStore(EXAMPLE, (dir) => {
    api.migrate(dir, { to: 2 });
    api.migrate(dir, { to: 3 });
    api.migrate(dir, { to: 4 });
    assert.deepEqual(snapshot(dir), golden('example-v4'));
  });
});

test('hidden STORE "The manifest": every data file with bytes, records and sha256; schema; two-space indent', () => {
  withStore(EXAMPLE, (dir) => {
    api.migrate(dir);
    const text = read(dir, 'manifest.json');
    const m = JSON.parse(text);
    assert.equal(m.schema, 4);
    assert.deepEqual(Object.keys(m.files), ['quarantine/customers.ndjson', 'quarantine/order_lines.ndjson', 'quarantine/orders.ndjson', 'records/customers.ndjson', 'records/order_lines.ndjson', 'records/orders.ndjson']);
    assert.deepEqual(m.files['records/orders.ndjson'], { bytes: 665, records: 6, sha256: '5f35918e765e89db0eb7100debe502ac91f650127b3b5e39f78bffc7baeeba78' });
    assert.ok(text.startsWith('{\n  "files": {\n    "quarantine/customers.ndjson": {\n      "bytes": '));
    assert.ok(text.endsWith('\n  "schema": 4\n}\n'));
  });
});

test('hidden STORE/CLI: verify finds a changed file, an extra file and a missing one', () => {
  withStore(EXAMPLE, (dir) => {
    api.migrate(dir);
    assert.deepEqual(cli(dir, 'verify', '.'), { code: 0, out: 'ok: 6 files match the manifest\n', err: '' });
    writeFileSync(join(dir, 'records', 'orders.ndjson'), read(dir, 'records/orders.ndjson').replace('"EUR"', '"USD"'));
    writeFileSync(join(dir, 'records', 'extra.ndjson'), '');
    rmSync(join(dir, 'quarantine', 'order_lines.ndjson'));
    assert.deepEqual(cli(dir, 'verify', '.'), { code: 3, out: 'mismatch: quarantine/order_lines.ndjson\nmismatch: records/extra.ndjson\nmismatch: records/orders.ndjson\n', err: '' });
    const v = api.verify(dir);
    assert.equal(v.ok, false);
    assert.deepEqual(v.mismatches, ['quarantine/order_lines.ndjson', 'records/extra.ndjson', 'records/orders.ndjson']);
  });
});

test('hidden CLI: verify without a manifest, and status of a finished store', () => {
  withStore(EXAMPLE, (dir) => {
    assert.deepEqual(cli(dir, 'verify', '.'), { code: 1, out: '', err: 'error: the store has no manifest\n' });
    cli(dir, 'run', '.');
    assert.equal(cli(dir, 'status', '.').out, 'schema 4\n  customers: 4 records\n  order_lines: 6 records\n  orders: 6 records\n');
  });
});
