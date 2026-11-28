import { hasHeader, headerRow, normalizeRow } from '../layout/cells.js';
import { resolveWidths } from '../layout/columns.js';
import { rowLines } from '../layout/rows.js';
import { normalizeSpec } from '../util/options.js';
import { trimTrailingSpaces } from '../util/strings.js';
import { ruleLine, underline } from './rules.js';
import { getStyle, hasRules } from './styles.js';

/** Everything the renderer works out before writing lines. */
export function prepare(input) {
  const spec = normalizeSpec(input);
  const style = getStyle(spec.style);
  const grid = spec.rows.map((row) => normalizeRow(row, spec.columns.length));
  const widths = resolveWidths(spec, style, grid);
  return { spec, style, grid, widths };
}

/** The resolved column widths of a table (docs/API.md). */
export function columnWidths(input) {
  return prepare(input).widths;
}

/** The pages of a table, each a string ending in "\n". */
export function renderPages(input) {
  const { spec, style, grid, widths } = prepare(input);
  const ctx = { widths, style, columns: spec.columns };
  const ruled = hasRules(style);
  const lines = [];
  if (ruled) lines.push(ruleLine(style, widths, style.rule));
  if (hasHeader(spec.columns)) {
    lines.push(...rowLines(headerRow(spec.columns), ctx, true));
    lines.push(ruled ? ruleLine(style, widths, style.headerRule) : underline(style, widths));
  }
  for (const row of grid) lines.push(...rowLines(row, ctx, false));
  if (ruled) lines.push(ruleLine(style, widths, style.rule));
  return [lines.map((l) => (ruled ? l : trimTrailingSpaces(l)) + '\n').join('')];
}

/** The whole table as one string. */
export function renderTable(input) {
  return renderPages(input).join('\f');
}
