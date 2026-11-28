import { openShop } from '../src/db.js';

export const customers = [
  { id: 1, name: 'Harbor Books', email: 'a@harbor.example', region: 'north', since: '2024-01-01' },
  { id: 2, name: 'pine & co', email: 'b@pine.example', region: 'south', since: '2024-01-01' },
  { id: 3, name: 'Quill Studio', email: 'c@quill.example', region: null, since: '2024-01-01' },
  { id: 4, name: 'Atlas Maps', email: 'd@atlas.example', region: 'north', since: '2024-01-01' },
  { id: 5, name: 'Birch Supply', email: 'e@birch.example', region: 'south', since: '2024-01-01' },
];

// Ids are not in date order on purpose; customer 9 does not exist.
export const orders = [
  { id: 1, customerId: 1, date: '2026-01-31', total: 5000, status: 'paid', note: 'Atlas reprint' },
  { id: 2, customerId: 2, date: '2026-01-05', total: 12000, status: 'open', note: null },
  { id: 3, customerId: 3, date: '2026-01-05', total: 3000, status: 'open', note: 'rush ORDER' },
  { id: 4, customerId: 4, date: '2026-02-01', total: 7000, status: 'open', note: 'maps' },
  { id: 5, customerId: 9, date: '2026-01-20', total: 2500, status: 'paid', note: 'legacy' },
  { id: 6, customerId: 1, date: '2026-01-10', total: 12000, status: 'cancelled', note: 'oops' },
  { id: 7, customerId: 5, date: '2026-01-05', total: 12000, status: 'paid', note: 'shelves' },
  { id: 8, customerId: 2, date: '2026-02-28', total: 900, status: 'open', note: null },
  { id: 9, customerId: 3, date: '2026-03-01', total: 4100, status: 'closed', note: 'quill pens' },
  { id: 10, customerId: 4, date: '2025-12-31', total: 6600, status: 'paid', note: 'year end' },
  { id: 11, customerId: 5, date: '2026-01-18', total: 1500, status: 'open', note: 'Harbor overflow' },
  { id: 12, customerId: 1, date: '2026-02-15', total: 8000, status: 'closed', note: null },
  { id: 13, customerId: 2, date: '2026-01-22', total: 3000, status: 'open', note: 'pine boards' },
  { id: 14, customerId: 4, date: '2026-01-22', total: 3000, status: 'open', note: null },
  { id: 15, customerId: 5, date: '2026-02-10', total: 2200, status: 'paid', note: null },
  { id: 16, customerId: 3, date: '2026-01-02', total: 1800, status: 'open', note: null },
  { id: 17, customerId: 1, date: '2026-02-20', total: 4000, status: 'cancelled', note: null },
  { id: 18, customerId: 2, date: '2026-03-15', total: 5000, status: 'paid', note: 'spring' },
];

export const shop = () => openShop({ customers, orders });

/** Every non-cancelled order id: newest date first, same date by higher id first. */
export const BY_DATE = [18, 9, 8, 12, 15, 4, 1, 14, 13, 5, 11, 7, 3, 2, 16, 10];
export const SUM_ALL = 77600;

export const ids = (report) => report.rows.map((r) => r.id);
