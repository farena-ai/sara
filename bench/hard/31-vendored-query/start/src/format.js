import { formatCents } from './money.js';

/** Renders rows as a plain text table with the given columns ({ key, title, align? }). */
export function table(rows, columns) {
  const cells = rows.map((r) => columns.map((c) => (c.format ? c.format(r[c.key]) : String(r[c.key] ?? ''))));
  const widths = columns.map((c, i) => Math.max(c.title.length, ...cells.map((row) => row[i].length)));
  const line = (vals) => vals.map((v, i) => (columns[i].align === 'right' ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(columns.map((c) => c.title)), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n');
}

/** The text form of a salesReport() result. */
export function renderSales(report) {
  const body = table(report.rows, [
    { key: 'id', title: 'Order', align: 'right' },
    { key: 'date', title: 'Date' },
    { key: 'customer', title: 'Customer' },
    { key: 'region', title: 'Region' },
    { key: 'status', title: 'Status' },
    { key: 'total', title: 'Total', align: 'right', format: formatCents },
  ]);
  return `${body}\n\nPage ${report.page} of ${report.pages}; ${report.total} orders, ${formatCents(report.sum)} in all.`;
}

/** The text form of a customerSummary() result. */
export function renderSummary(entries) {
  return table(entries, [
    { key: 'name', title: 'Customer' },
    { key: 'orders', title: 'Orders', align: 'right', format: String },
    { key: 'revenue', title: 'Revenue', align: 'right', format: formatCents },
  ]);
}
