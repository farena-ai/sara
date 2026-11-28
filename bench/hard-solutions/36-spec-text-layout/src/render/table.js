import { hasHeader, headerRow, normalizeRow } from '../layout/cells.js';
import { resolveWidths } from '../layout/columns.js';
import { decimalColumns } from '../layout/decimal.js';
import { paginate } from '../layout/paginate.js';
import { rowLines } from '../layout/rows.js';
import { normalizeSpec } from '../util/options.js';
import { sum, trimTrailingSpaces } from '../util/strings.js';
import { ruleLine, underline } from './rules.js';
import { getStyle, hasRules, overhead } from './styles.js';
import { titleLines } from './title.js';

/** Everything the renderer works out before writing lines. */
export function prepare(input) {
  const spec = normalizeSpec(input);
  const style = getStyle(spec.style);
  const grid = spec.rows.map((row) => normalizeRow(row, spec.columns.length));
  const decimals = decimalColumns(spec.columns, grid);
  const widths = resolveWidths(spec, style, grid, decimals);
  return { spec, style, grid, decimals, widths };
}

/** The resolved column widths of a table (docs/API.md). */
export function columnWidths(input) {
  return prepare(input).widths;
}

/** The pages of a table, each a string ending in "\n" (R32 to R39). */
export function renderPages(input) {
  const { spec, style, grid, decimals, widths } = prepare(input);
  const ctx = { widths, style, columns: spec.columns, decimals, ellipsis: spec.ellipsis };
  const ruled = hasRules(style);
  const lineWidth = overhead(style, widths.length) + sum(widths);
  const header = hasHeader(spec.columns) ? rowLines(headerRow(spec.columns), ctx, true) : null;
  const title = titleLines(spec.title, lineWidth, spec.ellipsis);
  const frame = (first) => {
    const before = first ? [...title] : [];
    if (ruled) before.push(ruleLine(style, widths, style.rule));
    if (header && (first || spec.repeatHeader)) {
      before.push(...header);
      before.push(ruled ? ruleLine(style, widths, style.headerRule) : underline(style, widths));
    }
    return { before, after: ruled ? [ruleLine(style, widths, style.rule)] : [] };
  };
  const rowRule = spec.rowRules ? (ruled ? ruleLine(style, widths, style.rule) : '') : null;
  const pages = paginate({ rows: grid.map((row) => rowLines(row, ctx, false)), frame, rowRule, pageHeight: spec.pageHeight });
  return pages.map((lines) => lines.map((l) => (ruled ? l : trimTrailingSpaces(l)) + '\n').join(''));
}

/** The whole table as one string, pages separated by "\f" (R34). */
export function renderTable(input) {
  return renderPages(input).join('\f');
}
