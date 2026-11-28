// Month-end closing. The behaviour is specified in docs/CLOSING.md.
import { isMonth, monthBounds } from './dates.js';

/** Closes the orders of one month and records the closing. */
export function closeMonth(db, month) {
  if (!isMonth(month)) return { ok: false, error: 'bad-month' };
  const { first, nextFirst } = monthBounds(month);
  const tx = db.begin();
  const { rows } = tx.from('orders').where('date', 'between', [first, nextFirst]).where('status', 'in', ['open', 'paid']).run();
  for (const order of rows) tx.patch('orders', order.id, { status: 'closed' });
  const revenue = rows.reduce((sum, order) => sum + order.total, 0);
  tx.insert('closings', { month, orders: rows.length, revenue });
  const [err] = tx.commit();
  if (err) return { ok: false, error: err.code === 'conflict' ? 'already-closed' : err.code };
  return { ok: true, month, closed: rows.length, revenue };
}

/** The recorded closing of a month, or null. */
export function closingOf(db, month) {
  const row = db.lookup('closings', month);
  return row ? { month: row.month, orders: row.orders, revenue: row.revenue } : null;
}
