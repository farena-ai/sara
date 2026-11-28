# Design

How a table goes from the object you pass to the text that comes out. The rules themselves are in
[LAYOUT.md](LAYOUT.md); this note only says where in the code each stage lives.

## Stages

1. **Options** (`src/util/options.js`). `normalizeSpec` checks the table and every column and fills
   in the defaults. After this stage a column has a `kind` (`"fixed"`, `"percent"`, `"flex"` or
   `"auto"`), a numeric `min`, and string values for `align`, `overflow` and `valign`.

2. **Cells** (`src/layout/cells.js`). Every row becomes an array of cell records
   `{ text, span, align, col }`, where `col` is the first column the cell covers and `text` is
   still the raw string (normalization happens when the text is measured or wrapped, so that the
   raw text stays available).

3. **Column metrics**. Before any width is known, the renderer collects what the columns need
   from the whole table: natural widths and, for decimal columns, the metrics of their numbers.
   These are computed once over all rows, never per page.

4. **Widths** (`src/layout/columns.js`). The width of every column, from the column kinds, the
   table width and the style's overhead.

5. **Rows** (`src/layout/rows.js`). Each row is turned into its content lines: every cell is
   wrapped or truncated to its width, aligned, and padded to the height of the row; then the
   cells' lines are joined with the style's borders and padding.

6. **Pages**. The header, rules and rows are put on pages.

7. **Output** (`src/render/table.js`). Lines are finished (trailing spaces where the style asks
   for it), each followed by "\n", and pages are joined.

## Text helpers

`src/text/` has no knowledge of tables. Every function there takes a string and a width and
returns strings; they are exported so that other programs can use the same measuring and
wrapping rules for text outside tables (log lines, e-mail bodies).

- `width.js` and `widthTable.js`: display widths. The table is searched with a binary search;
  keep the ranges sorted and disjoint when you change it.
- `clusters.js`: the units wrapping and truncation work with.
- `normalize.js`: line breaks, tabs, marks, words, paragraphs and the flattened text.
- `wrap.js`, `truncate.js`, `align.js`: one job each.

## Styles

A style (`src/render/styles.js`) is plain data: outer borders, separator, padding, the corner and
rule characters. `overhead()` and `boundaryWidth()` derive from that data, so a new style only
needs a new entry. Rule lines and underlines are in `src/render/rules.js`.

## Errors

Everything a caller can get wrong is reported as a `LayoutError` (`src/util/errors.js`), with a
message that names the column or option. Code in `src/` uses `fail(message)` for that; nothing
should let a `TypeError` escape for bad input.

## Testing

Tests use `node:test` and `node:assert/strict` only. Table tests compare whole outputs; the
`page(...lines)` helper in `test/helpers.js` builds the expected text of one page.
