import { openShop } from '../src/db.js';

export const customers = [
  { id: 1, name: 'Harbor Books', email: 'a@harbor.example', region: 'north', since: '2024-01-01' },
  { id: 2, name: 'Pine & Co', email: 'b@pine.example', region: 'south', since: '2024-01-01' },
  { id: 3, name: 'Quill Studio', email: 'c@quill.example', region: null, since: '2024-01-01' },
];

export const orders = [
  { id: 1, customerId: 1, date: '2026-01-03', total: 1000, status: 'paid', note: 'first' },
  { id: 2, customerId: 2, date: '2026-01-08', total: 2500, status: 'open', note: null },
  { id: 3, customerId: 3, date: '2026-01-12', total: 400, status: 'cancelled', note: 'dup' },
  { id: 4, customerId: 1, date: '2026-01-20', total: 3000, status: 'open', note: null },
  { id: 5, customerId: 3, date: '2026-02-04', total: 700, status: 'paid', note: 'feb' },
];

export const shop = () => openShop({ customers, orders });
