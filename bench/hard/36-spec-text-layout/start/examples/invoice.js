// Prints an invoice without borders: percent columns, truncation and a spanning total row.
import { renderTable } from '../src/index.js';

process.stdout.write(
  renderTable({
    style: 'none',
    width: 60,
    title: 'Invoice 2026-0042',
    columns: [
      { header: 'Description', percent: 50, overflow: 'truncate' },
      { header: 'Qty', align: 'right', width: 4 },
      { header: 'Price', align: 'decimal', flex: 1 },
      { header: 'Amount', align: 'decimal', flex: 1 },
    ],
    rows: [
      ['Consulting, on site, including travel within the city', 3, '120.00', '360.00'],
      ['Licence (annual)', 1, '99.5', '99.5'],
      [{ text: 'Total', span: 3, align: 'right' }, '459.50'],
    ],
  }),
);
