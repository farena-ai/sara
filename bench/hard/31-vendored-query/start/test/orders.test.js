import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCustomer, listCustomers } from '../src/customers.js';
import { formatCents, parseCents } from '../src/money.js';
import { checkOrder, ordersOf } from '../src/orders.js';
import { shop } from './fixture.js';

test('orders of one customer, oldest first', () => {
  assert.deepEqual(ordersOf(shop(), 1), [
    { id: 1, date: '2026-01-03', total: 1000, status: 'paid' },
    { id: 4, date: '2026-01-20', total: 3000, status: 'open' },
  ]);
});

test('customers by name and by region', () => {
  const db = shop();
  assert.deepEqual(listCustomers(db).map((c) => c.name), ['Harbor Books', 'Pine & Co', 'Quill Studio']);
  assert.deepEqual(listCustomers(db, { region: 'south' }).map((c) => c.id), [2]);
  assert.equal(findCustomer(db, 3).name, 'Quill Studio');
  assert.equal(findCustomer(db, 42), null);
});

test('order checks', () => {
  const db = shop();
  assert.deepEqual(checkOrder(db, { customerId: 1, date: '2026-03-01', total: 100 }), []);
  assert.deepEqual(checkOrder(db, { customerId: 9, date: '2026-02-30', total: -1, status: 'lost' }), ['unknown customer', 'bad date', 'bad total', 'bad status']);
});

test('money', () => {
  assert.equal(formatCents(123456), '1,234.56');
  assert.equal(formatCents(-5), '-0.05');
  assert.equal(parseCents('1,234.5'), 123450);
});
