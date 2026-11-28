import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeMonth, closingOf } from '../src/closing.js';
import { openShop } from '../src/db.js';
import { customerSummary, salesReport } from '../src/reports.js';
import { orders, shop } from './fixture.js';

const statusOf = (db, id) => db.lookup('orders', id).status;
const snapshot = (db) => db.from('orders').run().rows.map((o) => `${o.id}:${o.status}`).join(',');

test('closing rule 1: a bad month returns bad-month and changes nothing', () => {
  const db = shop();
  const before = snapshot(db);
  for (const bad of ['2026-13', '2026-00', '2026-1', '202601', 'January', '', undefined, 202601]) {
    assert.deepEqual(closeMonth(db, bad), { ok: false, error: 'bad-month' }, String(bad));
  }
  assert.equal(snapshot(db), before);
  assert.equal(db.from('closings').count(), 0);
});

test('closing rule 2: open and paid orders of the whole month become closed', () => {
  const db = shop();
  closeMonth(db, '2026-02');
  assert.deepEqual([4, 8, 15].map((id) => statusOf(db, id)), ['closed', 'closed', 'closed']);
  assert.equal(statusOf(db, 17), 'cancelled');
  assert.equal(statusOf(db, 12), 'closed');
});

test('closing rule 2: the first and last day of the month are in it, neighbours are not', () => {
  const db = shop();
  closeMonth(db, '2026-02');
  assert.equal(statusOf(db, 4), 'closed');
  assert.equal(statusOf(db, 8), 'closed');
  assert.equal(statusOf(db, 1), 'paid');
  assert.equal(statusOf(db, 9), 'closed');
  assert.equal(statusOf(db, 18), 'paid');
  const jan = shop();
  closeMonth(jan, '2026-01');
  assert.equal(statusOf(jan, 1), 'closed');
  assert.equal(statusOf(jan, 16), 'closed');
  assert.equal(statusOf(jan, 4), 'open');
  assert.equal(statusOf(jan, 10), 'paid');
  assert.equal(statusOf(jan, 6), 'cancelled');
});

test('closing rules 3 and 6: the closings row and the result agree', () => {
  const db = shop();
  assert.deepEqual(closeMonth(db, '2026-01'), { ok: true, month: '2026-01', closed: 9, revenue: 43800 });
  assert.deepEqual(closingOf(db, '2026-01'), { month: '2026-01', orders: 9, revenue: 43800 });
  assert.deepEqual(closeMonth(db, '2026-02'), { ok: true, month: '2026-02', closed: 3, revenue: 10100 });
  assert.deepEqual(closingOf(db, '2026-02'), { month: '2026-02', orders: 3, revenue: 10100 });
});

test('closing rule 4: the changes are committed in one go', () => {
  const db = shop();
  const before = db.version;
  closeMonth(db, '2026-02');
  assert.equal(db.version, before + 1, 'one commit');
  assert.equal(db.from('orders').where('status', 'eq', 'closed').count(), 5);
});

test('closing rule 5: closing a month twice returns already-closed and changes nothing', () => {
  const db = shop();
  closeMonth(db, '2026-02');
  const before = snapshot(db);
  const version = db.version;
  assert.deepEqual(closeMonth(db, '2026-02'), { ok: false, error: 'already-closed' });
  assert.equal(snapshot(db), before);
  assert.equal(db.version, version);
  assert.deepEqual(closingOf(db, '2026-02'), { month: '2026-02', orders: 3, revenue: 10100 });
});

test('closing rule 5: orders added after the closing stay open when the month is closed again', () => {
  const db = shop();
  closeMonth(db, '2026-01');
  db.load('orders', [{ id: 50, customerId: 1, date: '2026-01-15', total: 999, status: 'open', note: 'late' }]);
  assert.deepEqual(closeMonth(db, '2026-01'), { ok: false, error: 'already-closed' });
  assert.equal(statusOf(db, 50), 'open');
  assert.deepEqual(closingOf(db, '2026-01'), { month: '2026-01', orders: 9, revenue: 43800 });
});

test('closing rule 5: a closing recorded earlier counts as closed', () => {
  const db = openShop({ customers: [], orders: orders.filter((o) => o.customerId === 9), closings: [{ month: '2026-01', orders: 0, revenue: 0 }] });
  assert.deepEqual(closeMonth(db, '2026-01'), { ok: false, error: 'already-closed' });
  assert.equal(statusOf(db, 5), 'paid');
});

test('closing rule 7: a month without orders can be closed once', () => {
  const db = shop();
  assert.deepEqual(closeMonth(db, '2026-06'), { ok: true, month: '2026-06', closed: 0, revenue: 0 });
  assert.deepEqual(closingOf(db, '2026-06'), { month: '2026-06', orders: 0, revenue: 0 });
  assert.deepEqual(closeMonth(db, '2026-06'), { ok: false, error: 'already-closed' });
});

test('closing rule 7: December closes into the right year', () => {
  const db = shop();
  assert.deepEqual(closeMonth(db, '2025-12'), { ok: true, month: '2025-12', closed: 1, revenue: 6600 });
  assert.equal(statusOf(db, 16), 'open');
});

test('closing rule 8: closed orders still appear in the reports', () => {
  const db = shop();
  closeMonth(db, '2026-02');
  const feb = salesReport(db, { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(feb.rows.map((r) => [r.id, r.status]), [[8, 'closed'], [12, 'closed'], [15, 'closed'], [4, 'closed']]);
  assert.equal(customerSummary(db, { from: '2026-02-01', to: '2026-02-28' }).length, 4);
});
