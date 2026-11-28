// Prints a stock list: auto columns, a decimal column and a flex column with a line limit.
import { renderTable } from '../src/index.js';

const items = [
  ['A-100', 'Apple', 3, 'fresh from the farm, picked this morning'],
  ['A-101', 'Kiwi', 12.5, ''],
  ['B-200', 'Watermelon', 0.25, 'one left, slightly bruised on one side'],
  ['C-300', '梨 (nashi)', -4, 'returned'],
];

process.stdout.write(
  renderTable({
    title: 'Stock on hand',
    width: 56,
    columns: [
      { header: 'Code', width: 5 },
      { header: 'Item', max: 12 },
      { header: 'Qty', align: 'decimal' },
      { header: 'Note', flex: 1, maxLines: 2 },
    ],
    rows: items,
  }),
);
