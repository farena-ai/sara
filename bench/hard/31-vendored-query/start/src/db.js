import { createStore } from '../vendor/tabula/index.js';

export const STATUSES = Object.freeze(['open', 'paid', 'closed', 'cancelled']);

/** The shop's tables (see docs/DATA.md). */
export function defineTables(store) {
  return store
    .define('customers', {
      key: 'id',
      columns: { id: 'int', name: 'text', email: 'text', region: 'text?', since: 'date' },
      unique: ['email'],
    })
    .define('orders', {
      key: 'id',
      columns: { id: 'int', customerId: 'int', date: 'date', total: 'int', status: 'text', note: 'text?' },
    })
    .define('closings', {
      key: 'month',
      columns: { month: 'text', orders: 'int', revenue: 'int' },
    });
}

/** A store with the shop's tables, filled from `data` ({ customers, orders, closings }). */
export function openShop(data = {}) {
  const store = defineTables(createStore());
  for (const name of ['customers', 'orders', 'closings']) {
    if (data[name]?.length) store.load(name, data[name]);
  }
  return store;
}
