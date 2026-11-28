// Prints a timesheet in pages of 12 lines, the header repeated on each page.
import { renderPages } from '../src/index.js';

const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const rows = [];
for (const [n, day] of days.entries()) {
  rows.push([day, (7.5 + n * 0.25).toFixed(2), n % 2 ? 'office' : 'remote, with a long call about the release in the afternoon']);
}
rows.push([{ text: 'Total', span: 1 }, '38.75', '']);

const pages = renderPages({
  width: 50,
  pageHeight: 12,
  rowRules: true,
  columns: [
    { header: 'Day', width: 4 },
    { header: 'Hours', align: 'decimal' },
    { header: 'Where', flex: 1 },
  ],
  rows,
});
for (const [i, page] of pages.entries()) process.stdout.write(`-- page ${i + 1} --\n${page}`);
