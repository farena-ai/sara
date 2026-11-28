import { paragraphs } from '../text/normalize.js';
import { textWidth } from '../text/width.js';
import { fail } from '../util/errors.js';

function widestParagraph(text) {
  return Math.max(0, ...paragraphs(text).map(textWidth));
}

/** The width a column needs to show its header and cells without wrapping. */
export function naturalWidth(column, col, grid) {
  let width = 1;
  if (column.header !== undefined) width = Math.max(width, widestParagraph(column.header));
  for (const row of grid) {
    for (const cell of row) if (cell.col === col) width = Math.max(width, widestParagraph(cell.text));
  }
  return width;
}

function clamp(value, column) {
  let v = Math.max(value, column.min);
  if (column.max !== undefined) v = Math.min(v, column.max);
  return v;
}

/** The width of every column. */
export function resolveWidths(spec, style, grid) {
  return spec.columns.map((c, i) => {
    if (c.kind === 'fixed') return c.width;
    if (c.kind === 'auto') return clamp(naturalWidth(c, i, grid), c);
    return fail(`${c.kind} columns are not implemented yet`);
  });
}
