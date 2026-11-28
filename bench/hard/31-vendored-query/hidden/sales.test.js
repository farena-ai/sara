import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openShop } from '../src/db.js';
import { salesReport } from '../src/reports.js';
import { BY_DATE, ids, shop, SUM_ALL } from './fixture.js';

const every = (db, options = {}) => ids(salesReport(db, { perPage: 50, ...options }));
const badRange = (message) => (e) => e instanceof RangeError && e.message === message;

test('rule 1: "to" is inclusive (an order on the last day is listed)', () => {
  assert.deepEqual(every(shop(), { from: '2026-01-01', to: '2026-01-31' }), [1, 14, 13, 5, 11, 7, 3, 2, 16]);
});

test('rule 1: "from" is inclusive and either bound may be left out', () => {
  const db = shop();
  assert.deepEqual(every(db, { from: '2026-02-01', to: '2026-02-28' }), [8, 12, 15, 4]);
  assert.deepEqual(every(db, { to: '2026-01-02' }), [16, 10]);
  assert.deepEqual(every(db, { from: '2026-03-01' }), [18, 9]);
  assert.deepEqual(every(db, { from: '2026-01-22', to: '2026-01-22' }), [14, 13]);
});

test('rule 2: a bad from/to throws RangeError "bad-date"', () => {
  const db = shop();
  for (const bad of ['2026-02-30', '2026-1-05', '20260105', 20260105, '2026-13-01']) {
    assert.throws(() => salesReport(db, { from: bad }), badRange('bad-date'), String(bad));
    assert.throws(() => salesReport(db, { to: bad }), badRange('bad-date'), String(bad));
  }
});

test('rule 3: from after to gives an empty result', () => {
  const r = salesReport(shop(), { from: '2026-02-01', to: '2026-01-31' });
  assert.deepEqual(r.rows, []);
  assert.equal(r.total, 0);
  assert.equal(r.sum, 0);
  assert.equal(r.pages, 0);
});

test('rule 4: without status, only cancelled orders are left out', () => {
  assert.deepEqual(every(shop()), BY_DATE);
});

test('rule 5: status as one value or a list selects exactly those statuses', () => {
  const db = shop();
  assert.deepEqual(every(db, { status: 'cancelled' }), [17, 6]);
  assert.deepEqual(every(db, { status: ['closed', 'cancelled'] }), [9, 17, 12, 6]);
  assert.deepEqual(every(db, { status: 'paid', from: '2026-01-01', to: '2026-01-31' }), [1, 5, 7]);
});

test('rule 5: an unknown status or an empty list throws RangeError "bad-status"', () => {
  const db = shop();
  assert.throws(() => salesReport(db, { status: 'shipped' }), badRange('bad-status'));
  assert.throws(() => salesReport(db, { status: ['open', 'Paid'] }), badRange('bad-status'));
  assert.throws(() => salesReport(db, { status: [] }), badRange('bad-status'));
});

test('rule 6: customerId keeps one customer', () => {
  assert.deepEqual(every(shop(), { customerId: 2 }), [18, 8, 13, 2]);
});

test('rule 7: region matches the customer region; no region and missing customers never match', () => {
  const db = shop();
  assert.deepEqual(every(db, { region: 'north' }), [12, 4, 1, 14, 10]);
  assert.deepEqual(every(db, { region: 'south' }), [18, 8, 15, 13, 11, 7, 2]);
  assert.deepEqual(every(db, { region: 'east' }), []);
});

test('rule 8: search matches the note or the customer name, ignoring case', () => {
  const db = shop();
  assert.deepEqual(every(db, { search: 'harbor' }), [12, 1, 11]);
  assert.deepEqual(every(db, { search: 'ORDER' }), [3]);
  assert.deepEqual(every(db, { search: '  Pine ' }), [18, 8, 13, 2]);
  assert.deepEqual(every(db, { search: 'atlas' }), [4, 1, 14, 10]);
});

test('rule 8: a blank search filters nothing', () => {
  const db = shop();
  assert.deepEqual(every(db, { search: '' }), BY_DATE);
  assert.deepEqual(every(db, { search: '   ' }), BY_DATE);
});

test('rule 9: minTotal is inclusive', () => {
  assert.deepEqual(every(shop(), { minTotal: 7000 }), [12, 4, 7, 2]);
});

test('rule 10: filters are combined', () => {
  const db = shop();
  assert.deepEqual(every(db, { region: 'south', status: ['open'], minTotal: 1500 }), [13, 11, 2]);
  assert.deepEqual(every(db, { region: 'north', from: '2026-01-01', search: 'MAPS' }), [4, 14]);
});

test('rule 11: default order is newest first, same date by higher id first', () => {
  const r = salesReport(shop(), { from: '2026-01-05', to: '2026-01-05' });
  assert.deepEqual(ids(r), [7, 3, 2]);
  assert.deepEqual(every(shop(), { sort: 'date' }), BY_DATE);
});

test('rule 12: sort by total, ties by newer date then higher id', () => {
  assert.deepEqual(every(shop(), { sort: 'total' }), [7, 2, 12, 4, 10, 18, 1, 9, 14, 13, 3, 5, 15, 16, 11, 8]);
});

test('rule 12: an unknown sort throws RangeError "bad-sort"', () => {
  assert.throws(() => salesReport(shop(), { sort: 'customer' }), badRange('bad-sort'));
  assert.throws(() => salesReport(shop(), { sort: '-total' }), badRange('bad-sort'));
});

test('rule 13: pages count from 1 and perPage defaults to 10', () => {
  const db = shop();
  const first = salesReport(db);
  assert.deepEqual(ids(first), BY_DATE.slice(0, 10));
  assert.equal(first.page, 1);
  assert.equal(first.perPage, 10);
  assert.deepEqual(ids(salesReport(db, { page: 2 })), BY_DATE.slice(10));
  assert.deepEqual(ids(salesReport(db, { page: 3, perPage: 4 })), BY_DATE.slice(8, 12));
  assert.deepEqual(ids(salesReport(db, { page: 2, perPage: 5, sort: 'total' })), [18, 1, 9, 14, 13]);
});

test('rule 13: perPage above 50 is treated as 50', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, customerId: 1, date: '2026-04-01', total: 100, status: 'open', note: null }));
  const db = openShop({ customers: [{ id: 1, name: 'A', email: 'a@x', region: null, since: '2024-01-01' }], orders: many });
  const r = salesReport(db, { perPage: 500 });
  assert.equal(r.perPage, 50);
  assert.equal(r.rows.length, 50);
  assert.equal(r.pages, 2);
  assert.equal(r.total, 60);
  assert.equal(ids(salesReport(db, { perPage: 500, page: 2 })).length, 10);
});

test('rule 13: page and perPage must be positive integers ("bad-page")', () => {
  const db = shop();
  for (const page of [0, -1, 1.5, '2', NaN]) assert.throws(() => salesReport(db, { page }), badRange('bad-page'), String(page));
  for (const perPage of [0, -5, 2.5, '10']) assert.throws(() => salesReport(db, { perPage }), badRange('bad-page'), String(perPage));
});

test('rule 14: a page after the last one is empty but keeps the totals', () => {
  const r = salesReport(shop(), { page: 9, perPage: 5 });
  assert.deepEqual(r.rows, []);
  assert.equal(r.page, 9);
  assert.equal(r.perPage, 5);
  assert.equal(r.total, 16);
  assert.equal(r.pages, 4);
  assert.equal(r.sum, SUM_ALL);
});

test('rule 15: total, sum and pages cover all pages', () => {
  const db = shop();
  const r = salesReport(db, { perPage: 3, page: 2 });
  assert.equal(r.rows.length, 3);
  assert.equal(r.total, 16);
  assert.equal(r.sum, SUM_ALL);
  assert.equal(r.pages, 6);
  const north = salesReport(db, { region: 'north', perPage: 2 });
  assert.equal(north.total, 5);
  assert.equal(north.sum, 8000 + 7000 + 5000 + 3000 + 6600);
  assert.equal(north.pages, 3);
});

test('rule 16: rows have exactly id, date, customer, region, total, status', () => {
  const r = salesReport(shop(), { from: '2026-01-05', to: '2026-01-05' });
  assert.deepEqual(r.rows, [
    { id: 7, date: '2026-01-05', customer: 'Birch Supply', region: 'south', total: 12000, status: 'paid' },
    { id: 3, date: '2026-01-05', customer: 'Quill Studio', region: null, total: 3000, status: 'open' },
    { id: 2, date: '2026-01-05', customer: 'pine & co', region: 'south', total: 12000, status: 'open' },
  ]);
  for (const row of r.rows) assert.deepEqual(Object.keys(row).sort(), ['customer', 'date', 'id', 'region', 'status', 'total']);
});

test('rule 17: an order of a deleted customer shows "(unknown)"', () => {
  const r = salesReport(shop(), { from: '2026-01-20', to: '2026-01-20' });
  assert.deepEqual(r.rows, [{ id: 5, date: '2026-01-20', customer: '(unknown)', region: null, total: 2500, status: 'paid' }]);
});

test('reports do not change the store', () => {
  const db = shop();
  const before = db.version;
  salesReport(db, { region: 'north', search: 'a', sort: 'total', page: 2, perPage: 2 });
  assert.equal(db.version, before);
});
