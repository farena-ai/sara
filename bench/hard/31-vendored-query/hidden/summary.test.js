import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openShop } from '../src/db.js';
import { customerSummary } from '../src/reports.js';
import { shop } from './fixture.js';

test('rules 18-19: all non-cancelled orders per existing customer', () => {
  assert.deepEqual(customerSummary(shop()), [
    { customerId: 2, name: 'pine & co', orders: 4, revenue: 20900 },
    { customerId: 4, name: 'Atlas Maps', orders: 3, revenue: 16600 },
    { customerId: 5, name: 'Birch Supply', orders: 3, revenue: 15700 },
    { customerId: 1, name: 'Harbor Books', orders: 2, revenue: 13000 },
    { customerId: 3, name: 'Quill Studio', orders: 3, revenue: 8900 },
  ]);
});

test('rule 18: the range is inclusive on both ends', () => {
  assert.deepEqual(customerSummary(shop(), { from: '2026-01-01', to: '2026-01-31' }), [
    { customerId: 2, name: 'pine & co', orders: 2, revenue: 15000 },
    { customerId: 5, name: 'Birch Supply', orders: 2, revenue: 13500 },
    { customerId: 1, name: 'Harbor Books', orders: 1, revenue: 5000 },
    { customerId: 3, name: 'Quill Studio', orders: 2, revenue: 4800 },
    { customerId: 4, name: 'Atlas Maps', orders: 1, revenue: 3000 },
  ]);
  assert.deepEqual(customerSummary(shop(), { from: '2026-03-01', to: '2026-03-01' }), [{ customerId: 3, name: 'Quill Studio', orders: 1, revenue: 4100 }]);
});

test('rule 19: customers without counting orders are left out', () => {
  assert.deepEqual(customerSummary(shop(), { from: '2026-02-16', to: '2026-02-27' }), []);
  assert.deepEqual(customerSummary(shop(), { from: '2026-02-01', to: '2026-01-01' }), []);
});

test('rule 20: equal revenue sorts by name ignoring case, then by id', () => {
  const db = openShop({
    customers: [
      { id: 1, name: 'beta', email: '1@x', region: null, since: '2024-01-01' },
      { id: 2, name: 'Carrot', email: '2@x', region: null, since: '2024-01-01' },
      { id: 5, name: 'ALPHA', email: '5@x', region: null, since: '2024-01-01' },
      { id: 4, name: 'alpha', email: '4@x', region: null, since: '2024-01-01' },
      { id: 3, name: 'Zed', email: '3@x', region: null, since: '2024-01-01' },
    ],
    orders: [
      { id: 1, customerId: 1, date: '2026-01-01', total: 1000, status: 'open', note: null },
      { id: 2, customerId: 2, date: '2026-01-01', total: 1000, status: 'paid', note: null },
      { id: 3, customerId: 5, date: '2026-01-01', total: 1000, status: 'closed', note: null },
      { id: 4, customerId: 4, date: '2026-01-01', total: 1000, status: 'open', note: null },
      { id: 5, customerId: 3, date: '2026-01-01', total: 999, status: 'open', note: null },
      { id: 6, customerId: 3, date: '2026-01-02', total: 1, status: 'open', note: null },
    ],
  });
  assert.deepEqual(customerSummary(db).map((e) => e.customerId), [4, 5, 1, 2, 3]);
});

test('rules 1-2 for the summary: bad dates throw RangeError "bad-date"', () => {
  assert.throws(() => customerSummary(shop(), { from: '2026-02-29' }), (e) => e instanceof RangeError && e.message === 'bad-date');
  assert.throws(() => customerSummary(shop(), { to: 'soon' }), (e) => e instanceof RangeError && e.message === 'bad-date');
});
