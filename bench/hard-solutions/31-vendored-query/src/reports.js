// Sales reports. The behaviour is specified in docs/SALES.md.
import { STATUSES } from './db.js';
import { isDay } from './dates.js';

const MAX_PER_PAGE = 50;
const SORTS = { date: ['-date', '-id'], total: ['-total', '-date', '-id'] };

function checkRange({ from, to }) {
  for (const day of [from, to]) if (day !== undefined && !isDay(day)) throw new RangeError('bad-date');
}

function inRange(query, { from, to }) {
  let q = query;
  if (from !== undefined) q = q.where('date', 'ge', from);
  if (to !== undefined) q = q.where('date', 'le', to);
  return q;
}

function withStatus(query, status) {
  if (status === undefined) return query.where('status', 'ne', 'cancelled');
  const list = Array.isArray(status) ? status : [status];
  if (!list.length || list.some((s) => !STATUSES.includes(s))) throw new RangeError('bad-status');
  return query.where('status', 'in', list);
}

const idsOf = (query) => query.select(['id']).run().rows.map((r) => r.id);

function toRow(db, order) {
  const customer = db.lookup('customers', order.customerId);
  return {
    id: order.id,
    date: order.date,
    customer: customer ? customer.name : '(unknown)',
    region: customer ? customer.region : null,
    total: order.total,
    status: order.status,
  };
}

/** A filtered, sorted, paged list of orders with totals. */
export function salesReport(db, options = {}) {
  const { status, customerId, region, search, minTotal, sort = 'date', page = 1, perPage = 10 } = options;
  checkRange(options);
  if (!Object.hasOwn(SORTS, sort)) throw new RangeError('bad-sort');
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(perPage) || perPage < 1) throw new RangeError('bad-page');
  const size = Math.min(perPage, MAX_PER_PAGE);

  let q = withStatus(inRange(db.from('orders'), options), status);
  if (customerId !== undefined) q = q.where('customerId', 'eq', customerId);
  if (region !== undefined) q = q.where('customerId', 'in', idsOf(db.from('customers').where('region', 'eq', region)));
  const text = typeof search === 'string' ? search.trim() : '';
  if (text) {
    const byName = idsOf(db.from('customers').where('name', 'ihas', text));
    q = q.whereAny([['note', 'ihas', text], ['customerId', 'in', byName]]);
  }
  if (minTotal !== undefined) q = q.where('total', 'ge', minTotal);

  const { rows, matched } = q.orderBy(SORTS[sort]).page(page - 1, size).run();
  return {
    rows: rows.map((o) => toRow(db, o)),
    total: matched,
    sum: q.sum('total'),
    page,
    perPage: size,
    pages: Math.ceil(matched / size),
  };
}

/** Revenue per customer over a date range. */
export function customerSummary(db, options = {}) {
  checkRange(options);
  const groups = inRange(db.from('orders'), options).where('status', 'ne', 'cancelled').group('customerId', 'total');
  const entries = [];
  for (const g of groups) {
    const customer = db.lookup('customers', g.key);
    if (customer) entries.push({ customerId: customer.id, name: customer.name, orders: g.count, revenue: g.sum });
  }
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return entries.sort((a, b) => b.revenue - a.revenue || byName(a.name.toLowerCase(), b.name.toLowerCase()) || a.customerId - b.customerId);
}
