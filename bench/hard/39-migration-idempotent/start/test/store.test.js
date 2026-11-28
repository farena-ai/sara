import assert from 'node:assert/strict';
import { test } from 'node:test';
import { status, StoreError } from '../src/index.js';
import { dataFiles, readCollections, readQuarantine, readSchema } from '../src/store/layout.js';
import { formatLines, parseLines } from '../src/store/ndjson.js';
import { sha256 } from '../src/store/checksum.js';
import { tempStore } from './helpers.js';

test('parseLines skips blank lines, accepts \\r\\n and keeps lines that are not objects as raw text', () => {
  const parsed = parseLines('{"a":1}\r\n\n  \n[1,2]\nnope\r\n"text"\n{"b":2}');
  assert.deepEqual(parsed, [{ record: { a: 1 } }, { raw: '[1,2]' }, { raw: 'nope' }, { raw: '"text"' }, { record: { b: 2 } }]);
});

test('formatLines writes canonical records, one per line', () => {
  assert.equal(formatLines([{ b: 1, a: 'é' }, { z: [3, { y: 1, x: 2 }] }]), '{"a":"é","b":1}\n{"z":[3,{"x":2,"y":1}]}\n');
  assert.equal(formatLines([]), '');
});

test('sha256 of bytes in lowercase hex', () => {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('readSchema needs a store.json with a whole schema number', () => {
  const ok = tempStore({ schema: 3 });
  const bad = tempStore({ schema: '"x"' });
  try {
    assert.equal(readSchema(ok.dir), 3);
    assert.throws(() => readSchema(bad.dir), StoreError);
    assert.throws(() => readSchema(`${ok.dir}-missing`), /not a store/);
  } finally {
    ok.cleanup();
    bad.cleanup();
  }
});

test('readCollections reads every .ndjson file in records/, by name', () => {
  const s = tempStore({ schema: 2, files: { 'records/orders.ndjson': '{"id":"o"}\n', 'records/customers.ndjson': '', 'records/readme.txt': 'x', 'quarantine/orders.ndjson': '{"q":1}\n' } });
  try {
    assert.deepEqual(readCollections(s.dir), { customers: [], orders: [{ record: { id: 'o' } }] });
    assert.equal(readQuarantine(s.dir, 'orders'), '{"q":1}\n');
    assert.equal(readQuarantine(s.dir, 'customers'), '');
    assert.deepEqual(dataFiles(s.dir), ['quarantine/orders.ndjson', 'records/customers.ndjson', 'records/orders.ndjson', 'records/readme.txt']);
  } finally {
    s.cleanup();
  }
});

test('status reports the schema, the counts and no interrupted run', () => {
  const s = tempStore();
  try {
    assert.deepEqual(status(s.dir), { schema: 1, interrupted: false, manifest: false, counts: { customers: 11, orders: 15 } });
  } finally {
    s.cleanup();
  }
});
