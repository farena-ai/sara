// Month-end closing. The behaviour is specified in docs/CLOSING.md.

/** Closes the orders of one month and records the closing. */
export function closeMonth(db, month) {
  throw new Error('closeMonth is not implemented yet');
}

/** The recorded closing of a month, or null. */
export function closingOf(db, month) {
  const row = db.lookup('closings', month);
  return row ? { month: row.month, orders: row.orders, revenue: row.revenue } : null;
}
