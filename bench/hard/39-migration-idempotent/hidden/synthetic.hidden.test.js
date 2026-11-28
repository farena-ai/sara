import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { api, faultAt, snapshot, withStore } from './helpers.js';
import { makeStore } from './make-store.js';

const WANT = {
  'manifest.json': '6ec12e3362e8c5dbc257568a0b63a981981e84ef6a54cb6d5fbc66ccb64eb557',
  'quarantine/customers.ndjson': '7beedcac25f3c4ca43d2e1db1fed023ec27302a9f76da75359666237cba1ba12',
  'quarantine/order_lines.ndjson': 'ece931f31171f9c4524971b9d29bb4ad48f53628ced5930871b03c60d2195196',
  'quarantine/orders.ndjson': '19d49bd334ebcda8c0a57ed604095146a700dbc2c91946cd9379a034aa8c0a09',
  'records/customers.ndjson': 'f600c080f3fe730f033ae962749cdfb0825a2d684139b857f72ef410b402c9c9',
  'records/order_lines.ndjson': 'a9dc050e6e2e95d291abfd3ac77c13975dce7edf2daebce6f86ab77919085e85',
  'records/orders.ndjson': 'bf9644a5820b01c06f01bb80cddccb1cacc585a9cb2cfa4003c2b724365ec580',
  'store.json': '18f24d9e82cb144b280676e3ca464340cd20d8f4da391090b1f9b3ad19cf9538',
};

function hashes(snap) {
  const out = {};
  for (const [rel, text] of Object.entries(snap)) if (!rel.endsWith('/')) out[rel] = createHash('sha256').update(text, 'utf8').digest('hex');
  return out;
}

function synthetic() {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-hidden-src-'));
  makeStore(dir, { customers: 60, orders: 200, seed: 3 });
  return dir;
}

test('hidden MIGRATIONS/STORE: a larger synthetic v1 store migrates to exactly the expected bytes', () => {
  const src = synthetic();
  try {
    withStore(src, (dir) => {
      api.migrate(dir);
      assert.deepEqual(hashes(snapshot(dir)), WANT);
    });
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test('hidden RESUME: the larger store, stopped at many points (torn and killed), resumes to the same bytes', () => {
  const src = synthetic();
  try {
    const points = withStore(src, (dir) => {
      const p = [];
      api.migrate(dir, { fault: (x) => p.push(x) });
      return p;
    });
    for (let n = 0; n < points.length; n += 2) {
      const got = withStore(src, (dir) => {
        assert.throws(() => api.migrate(dir, { fault: faultAt(n, n % 4 === 0 ? 'torn' : 'throw') }));
        api.migrate(dir);
        return hashes(snapshot(dir));
      });
      assert.deepEqual(got, WANT, `stopped at ${points[n]}`);
    }
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});
