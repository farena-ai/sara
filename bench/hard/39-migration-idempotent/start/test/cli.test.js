import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cli, tempStore } from './helpers.js';

test('migrate status shows the schema and the record counts', () => {
  const s = tempStore();
  try {
    assert.deepEqual(cli(s.dir, 'status', '.'), { code: 0, out: 'schema 1\n  customers: 11 records\n  orders: 15 records\n', err: '' });
  } finally {
    s.cleanup();
  }
});

test('migrate run --to 2 prints the steps', () => {
  const s = tempStore();
  try {
    const r = cli(s.dir, 'run', '.', '--to', '2');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'v1->v2 done\nstore is at schema 2\n');
  } finally {
    s.cleanup();
  }
});

test('usage errors exit with 2', () => {
  const s = tempStore();
  try {
    assert.equal(cli(s.dir, 'run').code, 2);
    assert.equal(cli(s.dir, 'run', '.', '--to', 'x').code, 2);
    assert.equal(cli(s.dir, 'nope', '.').code, 2);
  } finally {
    s.cleanup();
  }
});

test('the example store gets to schema 4', () => {
  const s = tempStore();
  try {
    const r = cli(s.dir, 'run', '.');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'v1->v2 done\nv2->v3 done\nv3->v4 done\nstore is at schema 4\n');
    assert.equal(s.read('store.json'), '{"schema":4}\n');
    assert.ok(existsSync(join(s.dir, 'records', 'order_lines.ndjson')));
    assert.ok(existsSync(join(s.dir, 'manifest.json')));
    assert.equal(existsSync(join(s.dir, '.migrate')), false);
  } finally {
    s.cleanup();
  }
});
