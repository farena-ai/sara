import { fail } from '../util/errors.js';
import { isInteger } from '../util/strings.js';

const CELL_ALIGNS = ['left', 'right', 'center'];

/** R6: the text a cell value stands for. */
export function cellText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value === null || value === undefined) return '';
  return fail(`a cell cannot be ${Array.isArray(value) ? 'an array' : typeof value}`);
}

function isCellObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One row as cells { text, span, align, col } covering exactly `columnCount` columns (R29). */
export function normalizeRow(row, columnCount) {
  const cells = [];
  let col = 0;
  for (const value of row) {
    let text;
    let span = 1;
    let align;
    if (isCellObject(value)) {
      text = cellText(value.text);
      if (value.span !== undefined) {
        if (!isInteger(value.span)) fail('span must be an integer of at least 1');
        span = value.span;
      }
      if (value.align !== undefined) {
        if (!CELL_ALIGNS.includes(value.align)) fail(`a cell's align must be one of ${CELL_ALIGNS.join(', ')}`);
        align = value.align;
      }
    } else {
      text = cellText(value);
    }
    if (col + span > columnCount) fail('a row covers more columns than the table has');
    cells.push({ text, span, align, col });
    col += span;
  }
  while (col < columnCount) {
    cells.push({ text: '', span: 1, align: undefined, col });
    col++;
  }
  return cells;
}

/** The header row: one cell per column (R35). */
export function headerRow(columns) {
  return columns.map((c, col) => ({
    text: c.header ?? '',
    span: 1,
    align: c.headerAlign ?? (c.align === 'decimal' ? 'right' : c.align),
    col,
  }));
}

export function hasHeader(columns) {
  return columns.some((c) => c.header !== undefined);
}
