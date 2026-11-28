import { STATUSES } from './db.js';
import { isDay } from './dates.js';

/** One customer's orders, oldest first. */
export function ordersOf(db, customerId) {
  return db
    .from('orders')
    .where('customerId', 'eq', customerId)
    .orderBy(['date', 'id'])
    .run()
    .rows.map((o) => ({ id: o.id, date: o.date, total: o.total, status: o.status }));
}

/** Validates an order before it is placed; returns a list of problems (empty when fine). */
export function checkOrder(db, { customerId, date, total, status = 'open' }) {
  const problems = [];
  if (!db.lookup('customers', customerId)) problems.push('unknown customer');
  if (!isDay(date)) problems.push('bad date');
  if (!Number.isInteger(total) || total < 0) problems.push('bad total');
  if (!STATUSES.includes(status)) problems.push('bad status');
  return problems;
}
