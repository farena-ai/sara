import { alignText } from '../text/align.js';
import { wrapText } from '../text/wrap.js';
import { fail } from '../util/errors.js';
import { spaces } from '../util/strings.js';

/** The lines of one cell, each padded to `width`. */
export function cellLines(cell, width, column, isHeader) {
  if (!isHeader && column.overflow !== 'wrap') fail(`overflow "${column.overflow}" is not implemented yet`);
  if (!isHeader && column.align === 'decimal') fail('decimal alignment is not implemented yet');
  const align = cell.align ?? column.align;
  return wrapText(cell.text, width).map((l) => alignText(l, width, align));
}

/** Joins the cells' lines into content lines of the style. */
export function joinCells(style, parts) {
  const pl = spaces(style.padLeft);
  const pr = spaces(style.padRight);
  return style.left + parts.map((p) => pl + p + pr).join(style.separator) + style.right;
}

/** Lays out one row: returns its content lines. */
export function rowLines(cells, ctx, isHeader) {
  const { widths, style, columns } = ctx;
  const laid = cells.map((cell) => ({ lines: cellLines(cell, widths[cell.col], columns[cell.col], isHeader), width: widths[cell.col] }));
  const height = Math.max(...laid.map((c) => c.lines.length));
  const out = [];
  for (let n = 0; n < height; n++) out.push(joinCells(style, laid.map((c) => c.lines[n] ?? spaces(c.width))));
  return out;
}
