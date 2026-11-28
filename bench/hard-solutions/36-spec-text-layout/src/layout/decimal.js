import { flatten } from '../text/normalize.js';
import { spaces } from '../util/strings.js';

export const NUMERIC = /^-?[0-9]+(\.[0-9]+)?$/;

function parts(text) {
  const dot = text.indexOf('.');
  return dot < 0 ? [text, ''] : [text.slice(0, dot), text.slice(dot + 1)];
}

/** True when the cell takes part in decimal alignment (R27). */
export function isNumericCell(cell) {
  return cell.span === 1 && cell.align === undefined && NUMERIC.test(flatten(cell.text));
}

/** R27: { intWidth, fracWidth, width } over the given cells, or null without numeric cells. */
export function decimalMetrics(cells) {
  let intWidth = 0;
  let fracWidth = 0;
  let any = false;
  for (const cell of cells) {
    if (!isNumericCell(cell)) continue;
    const [i, f] = parts(flatten(cell.text));
    any = true;
    intWidth = Math.max(intWidth, i.length);
    fracWidth = Math.max(fracWidth, f.length);
  }
  if (!any) return null;
  return { intWidth, fracWidth, width: fracWidth === 0 ? intWidth : intWidth + 1 + fracWidth };
}

/** Metrics for every column (null for columns that are not decimal or have no numbers). */
export function decimalColumns(columns, grid) {
  return columns.map((column, col) => {
    if (column.align !== 'decimal') return null;
    const cells = [];
    for (const row of grid) for (const cell of row) if (cell.col === col) cells.push(cell);
    return decimalMetrics(cells);
  });
}

/** R28: the D-wide block for one numeric text. */
export function formatDecimal(text, metrics) {
  const [i, f] = parts(text);
  let right;
  if (f === '') right = metrics.fracWidth > 0 ? spaces(metrics.fracWidth + 1) : '';
  else right = spaces(metrics.fracWidth - f.length);
  return spaces(metrics.intWidth - i.length) + text + right;
}
