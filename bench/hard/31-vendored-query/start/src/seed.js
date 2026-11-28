// Demo data for bin/shop.js.
export const demo = {
  customers: [
    { id: 1, name: 'Harbor Books', email: 'orders@harbor.example', region: 'north', since: '2024-03-01' },
    { id: 2, name: 'Pine & Co', email: 'buy@pine.example', region: 'south', since: '2024-06-12' },
    { id: 3, name: 'Quill Studio', email: 'hello@quill.example', region: null, since: '2025-01-20' },
  ],
  orders: [
    { id: 1, customerId: 1, date: '2026-01-04', total: 12900, status: 'paid', note: 'atlas reprint' },
    { id: 2, customerId: 2, date: '2026-01-09', total: 4550, status: 'open', note: null },
    { id: 3, customerId: 3, date: '2026-01-15', total: 8800, status: 'cancelled', note: 'duplicate' },
    { id: 4, customerId: 1, date: '2026-02-02', total: 2100, status: 'open', note: 'bookmarks' },
    { id: 5, customerId: 2, date: '2026-02-14', total: 31000, status: 'paid', note: 'shelving' },
  ],
};
