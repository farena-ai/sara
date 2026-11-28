import { flatten, paragraphs } from '../text/normalize.js';
import { textWidth } from '../text/width.js';
import { overhead } from '../render/styles.js';
import { fail } from '../util/errors.js';
import { sum } from '../util/strings.js';
import { resolveFlex } from './flex.js';
import { shrinkToFit } from './shrink.js';

function widestParagraph(text) {
  return Math.max(0, ...paragraphs(text).map(textWidth));
}

/** R19: the natural width of column `col`. */
export function naturalWidth(column, col, grid, metrics) {
  let width = 1;
  if (column.header !== undefined) width = Math.max(width, widestParagraph(column.header));
  for (const row of grid) {
    for (const cell of row) {
      if (cell.col !== col || cell.span !== 1) continue;
      const w = column.overflow === 'truncate' ? textWidth(flatten(cell.text)) : widestParagraph(cell.text);
      width = Math.max(width, w);
    }
  }
  if (metrics) width = Math.max(width, metrics.width);
  return width;
}

function clamp(value, column) {
  let v = Math.max(value, column.min);
  if (column.max !== undefined) v = Math.min(v, column.max);
  return v;
}

/** R16 to R24: the width of every column. */
export function resolveWidths(spec, style, grid, decimals) {
  const { columns } = spec;
  const natural = columns.map((c, i) => naturalWidth(c, i, grid, decimals[i]));
  if (spec.width === undefined) {
    return columns.map((c, i) => {
      if (c.kind === 'percent') fail('percent columns need the table width');
      if (c.kind === 'fixed') return c.width;
      return clamp(natural[i], c);
    });
  }
  const budget = spec.width - overhead(style, columns.length);
  const widths = columns.map((c, i) => {
    if (c.kind === 'fixed') return c.width;
    if (c.kind === 'percent') return clamp(Math.floor((c.percent * budget) / 100), c);
    if (c.kind === 'auto') return clamp(natural[i], c);
    return 0;
  });
  const flexIndexes = columns.map((c, i) => (c.kind === 'flex' ? i : -1)).filter((i) => i >= 0);
  if (flexIndexes.length > 0) {
    const room = budget - sum(widths);
    for (const [i, w] of resolveFlex(columns, flexIndexes, room)) widths[i] = w;
  }
  return shrinkToFit(columns, widths, budget);
}
