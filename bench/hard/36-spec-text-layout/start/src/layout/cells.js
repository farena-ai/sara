import { fail } from '../util/errors.js';

/** The text a cell value stands for. */
export function cellText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value === null || value === undefined) return '';
  return fail(`a cell cannot be ${Array.isArray(value) ? 'an array' : typeof value}`);
}

/** One row as cells { text, span, align, col }. */
export function normalizeRow(row, columnCount) {
  if (row.length > columnCount) fail('a row has more cells than the table has columns');
  const cells = [];
  for (let col = 0; col < columnCount; col++) {
    const value = row[col];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (value.span !== undefined && value.span !== 1) fail('spanning cells are not implemented yet');
      cells.push({ text: cellText(value.text), span: 1, align: value.align, col });
    } else {
      cells.push({ text: cellText(value), span: 1, align: undefined, col });
    }
  }
  return cells;
}

/** The header row: one cell per column. */
export function headerRow(columns) {
  return columns.map((c, col) => ({ text: c.header ?? '', span: 1, align: c.headerAlign ?? c.align, col }));
}

export function hasHeader(columns) {
  return columns.some((c) => c.header !== undefined);
}
