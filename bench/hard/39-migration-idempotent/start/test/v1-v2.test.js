import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrate } from '../src/index.js';
import { lines, ndjson, tempStore } from './helpers.js';

test('v1 -> v2 renames name, cleans the email and fills in the tier', () => {
  const s = tempStore({
    schema: 1,
    files: {
      'records/customers.ndjson': ndjson([{ id: 'a', name: 'Ann Lee', email: ' Ann@X.org', created: '2024-01-01' }, { id: 'b', email: 'b@x.org', tier: 'gold', created: '2024-01-01' }]),
      'records/orders.ndjson': '',
    },
  });
  try {
    const result = migrate(s.dir, { to: 2 });
    assert.deepEqual(result.steps, ['v1->v2']);
    assert.equal(s.read('store.json'), '{"schema":2}\n');
    assert.equal(
      s.read('records/customers.ndjson'),
      '{"created":"2024-01-01","email":"ann@x.org","full_name":"Ann Lee","id":"a","tier":"basic"}\n{"created":"2024-01-01","email":"b@x.org","id":"b","tier":"gold"}\n',
    );
  } finally {
    s.cleanup();
  }
});

test('v1 -> v2 converts dollars to cents and pounds to grams', () => {
  const s = tempStore({
    schema: 1,
    files: {
      'records/customers.ndjson': '',
      'records/orders.ndjson': ndjson([{ id: 'o', customer: 'a', total: '12.50', weight_lb: 2, items: [{ sku: 'k', qty: 2, price: '6.25' }] }]),
    },
  });
  try {
    migrate(s.dir, { to: 2 });
    assert.deepEqual(lines(s.read('records/orders.ndjson')), [{ customer: 'a', id: 'o', items: [{ price_cents: 625, qty: 2, sku: 'k' }], total_cents: 1250, weight_g: 907 }]);
  } finally {
    s.cleanup();
  }
});

test('records that cannot be upgraded go to quarantine with a reason', () => {
  const s = tempStore({
    schema: 1,
    files: {
      'records/customers.ndjson': `${ndjson([{ id: 'a', email: 'nope' }])}not json\n`,
      'records/orders.ndjson': ndjson([{ id: 'o', total: '1.234', weight_lb: 1, items: [] }]),
    },
  });
  try {
    migrate(s.dir, { to: 2 });
    assert.equal(s.read('records/customers.ndjson'), '');
    assert.deepEqual(lines(s.read('quarantine/customers.ndjson')), [
      { reason: 'not a JSON object', record: 'not json', step: 'v1->v2' },
      { reason: 'bad email', record: { email: 'nope', id: 'a' }, step: 'v1->v2' },
    ]);
    assert.deepEqual(lines(s.read('quarantine/orders.ndjson')).map((e) => e.reason), ['bad total']);
  } finally {
    s.cleanup();
  }
});

test('v1 -> v2 keeps other fields, an empty tier, and the order of the records', () => {
  const s = tempStore({
    schema: 1,
    files: {
      'records/customers.ndjson': ndjson([{ id: 'z', email: 'z@x.org', tier: '', vip: true }, { id: 'a', email: 'a@x.org', tier: null }]),
      'records/orders.ndjson': ndjson([{ id: 'o', customer: 'z', total: '3', weight_lb: 0.5, status: 'paid', items: [{ sku: 'k', qty: 1, price: '3', colour: 'red' }] }]),
    },
  });
  try {
    migrate(s.dir, { to: 2 });
    assert.deepEqual(lines(s.read('records/customers.ndjson')), [
      { email: 'z@x.org', id: 'z', tier: '', vip: true },
      { email: 'a@x.org', id: 'a', tier: 'basic' },
    ]);
    assert.deepEqual(lines(s.read('records/orders.ndjson')), [{ customer: 'z', id: 'o', items: [{ colour: 'red', price_cents: 300, qty: 1, sku: 'k' }], status: 'paid', total_cents: 300, weight_g: 227 }]);
    assert.equal(s.read('store.json'), '{"schema":2}\n');
  } finally {
    s.cleanup();
  }
});

test('v1 -> v2 quarantines orders with a bad weight or bad items', () => {
  const s = tempStore({
    schema: 1,
    files: {
      'records/customers.ndjson': '',
      'records/orders.ndjson': ndjson([
        { id: 'a', total: '1', weight_lb: 'heavy', items: [] },
        { id: 'b', total: '1', weight_lb: 1, items: 'none' },
        { id: 'c', total: '1', weight_lb: 1, items: [{ sku: 'k', price: 'x' }] },
      ]),
    },
  });
  try {
    migrate(s.dir, { to: 2 });
    assert.deepEqual(lines(s.read('quarantine/orders.ndjson')).map((e) => [e.record.id, e.reason]), [['a', 'bad weight'], ['b', 'bad items'], ['c', 'bad item price']]);
    assert.equal(s.read('records/orders.ndjson'), '');
  } finally {
    s.cleanup();
  }
});
