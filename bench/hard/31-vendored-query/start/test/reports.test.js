import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeMonth, closingOf } from '../src/closing.js';
import { customerSummary, salesReport } from '../src/reports.js';
import { shop } from './fixture.js';

test('sales report: everything but cancelled orders, newest first', () => {
  const r = salesReport(shop());
  assert.deepEqual(r.rows.map((o) => o.id), [5, 4, 2, 1]);
  assert.equal(r.total, 4);
  assert.equal(r.sum, 7200);
  assert.equal(r.page, 1);
  assert.equal(r.pages, 1);
  assert.deepEqual(r.rows[1], { id: 4, date: '2026-01-20', customer: 'Harbor Books', region: 'north', total: 3000, status: 'open' });
});

test('sales report: one customer', () => {
  assert.deepEqual(salesReport(shop(), { customerId: 1 }).rows.map((o) => o.id), [4, 1]);
});

test('customer summary', () => {
  assert.deepEqual(customerSummary(shop()), [
    { customerId: 1, name: 'Harbor Books', orders: 2, revenue: 4000 },
    { customerId: 2, name: 'Pine & Co', orders: 1, revenue: 2500 },
    { customerId: 3, name: 'Quill Studio', orders: 1, revenue: 700 },
  ]);
});

test('closing a month', () => {
  const db = shop();
  assert.deepEqual(closeMonth(db, '2026-02'), { ok: true, month: '2026-02', closed: 1, revenue: 700 });
  assert.deepEqual(closingOf(db, '2026-02'), { month: '2026-02', orders: 1, revenue: 700 });
});
