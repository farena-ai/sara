import { alignText } from '../text/align.js';
import { flatten } from '../text/normalize.js';
import { limitLines, truncateText } from '../text/truncate.js';
import { wrapText } from '../text/wrap.js';
import { boundaryWidth } from '../render/styles.js';
import { spaces, sum } from '../util/strings.js';
import { formatDecimal, isNumericCell } from './decimal.js';

/** R30: the width of a cell starting at `col` and covering `span` columns. */
export function cellWidth(widths, style, col, span) {
  return sum(widths.slice(col, col + span)) + (span - 1) * boundaryWidth(style);
}

/** The lines of one body cell, each padded to `width` (R12 to R15, R25 to R28, R30). */
export function bodyCellLines(cell, width, column, metrics, ellipsis) {
  if (cell.span === 1 && column.align === 'decimal' && metrics && metrics.width <= width && isNumericCell(cell)) {
    return [alignText(formatDecimal(flatten(cell.text), metrics), width, 'right')];
  }
  let align = cell.align ?? column.align;
  if (align === 'decimal') align = 'right';
  let lines;
  if (column.overflow === 'truncate') {
    lines = [truncateText(cell.text, width, ellipsis)];
  } else {
    lines = wrapText(cell.text, width);
    if (column.maxLines !== undefined) lines = limitLines(lines, column.maxLines, width, ellipsis);
  }
  return lines.map((l) => alignText(l, width, align));
}

/** The lines of one header cell (R26, R35). */
export function headerCellLines(cell, width) {
  return wrapText(cell.text, width).map((l) => alignText(l, width, cell.align));
}

/** R31: pads a cell's lines to `height` according to `valign`. */
export function fillHeight(lines, height, width, valign) {
  const missing = height - lines.length;
  if (missing <= 0) return lines;
  const blank = spaces(width);
  const above = valign === 'bottom' ? missing : valign === 'middle' ? Math.floor(missing / 2) : 0;
  return [...Array(above).fill(blank), ...lines, ...Array(missing - above).fill(blank)];
}

/** Joins the cells' lines into content lines of the style (R32, R33). */
export function joinCells(style, parts) {
  const pl = spaces(style.padLeft);
  const pr = spaces(style.padRight);
  return style.left + parts.map((p) => pl + p + pr).join(style.separator) + style.right;
}

/** Lays out one row: returns its content lines. */
export function rowLines(cells, ctx, isHeader) {
  const { widths, style, columns, decimals, ellipsis } = ctx;
  const laid = cells.map((cell) => {
    const width = cellWidth(widths, style, cell.col, cell.span);
    const column = columns[cell.col];
    const lines = isHeader ? headerCellLines(cell, width) : bodyCellLines(cell, width, column, decimals[cell.col], ellipsis);
    return { lines, width, valign: isHeader ? 'top' : column.valign };
  });
  const height = Math.max(...laid.map((c) => c.lines.length));
  const filled = laid.map((c) => fillHeight(c.lines, height, c.width, c.valign));
  const out = [];
  for (let n = 0; n < height; n++) out.push(joinCells(style, filled.map((lines) => lines[n])));
  return out;
}
