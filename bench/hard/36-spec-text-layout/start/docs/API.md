# API

Everything is exported from `src/index.js`. The rules (R1, R2, ...) are in [LAYOUT.md](LAYOUT.md).

## Tables

### `renderTable(table) → string`

The whole table. Pages (R37) are separated by a form feed "\f"; every page ends with "\n" (R34).

### `renderPages(table) → string[]`

The same pages as an array, one string per page.

### `columnWidths(table) → number[]`

The resolved width of every column (R16 to R24), the content width without padding or borders.

### The table object

| Option | Default | Meaning |
|---|---|---|
| `columns` | (required) | Non-empty array of column objects, see below |
| `rows` | `[]` | Array of rows; a row is an array of cells (R6, R29) |
| `width` | none | Total width of every line, borders included (R17, R24) |
| `style` | `"ascii"` | `"ascii"` or `"none"` (R32, R33) |
| `ellipsis` | `"…"` | Marks truncated text (R13 to R15) |
| `title` | none | A title line above the table, first page only (R36) |
| `rowRules` | `false` | A rule (or an empty line) between body rows (R32, R33, R38) |
| `pageHeight` | none | Maximum lines per page (R37) |
| `repeatHeader` | `true` | Show the header on every page (R39) |

### Column objects

| Option | Default | Meaning |
|---|---|---|
| `header` | none | Header text (R35); a number is shown as `String(value)` |
| `width` | none | Fixed width (R16, R18) |
| `percent` | none | Integer percent of the budget (R20) |
| `flex` | none | Integer share of what is left (R21, R22) |
| `min`, `max` | 1, none | Bounds for percent, auto and flex columns (R18) |
| `align` | `"left"` | `"left"`, `"right"`, `"center"` or `"decimal"` (R25 to R28) |
| `headerAlign` | see R26 | `"left"`, `"right"` or `"center"` |
| `overflow` | `"wrap"` | `"wrap"` or `"truncate"` (R7 to R14) |
| `maxLines` | none | Line limit for wrapped body cells (R15) |
| `valign` | `"top"` | `"top"`, `"middle"` or `"bottom"` (R31) |

### Cells

A string, a number, `null`/`undefined`, or `{ text, span, align }` (R6, R29, R30). `align` on a
cell is `"left"`, `"right"` or `"center"`.

## Text helpers

These are the building blocks the renderer uses; they follow the same rules.

### `charWidth(codePoint) → 0 | 1 | 2`

R1, for one code point given as a number.

### `textWidth(text) → number`

R3.

### `clusters(text) → string[]`

R2: the clusters of `text`, in order. It does not normalize (R4, R5 are not applied).

### `normalizeText(text) → string`

R4 and R5.

### `wrapText(text, width) → string[]`

The lines of `text` wrapped to `width` (R4, R5, R7 to R11), not padded.

### `truncateText(text, width, ellipsis = "…") → string`

The single line of R12 to R14, not padded.

### `alignText(line, width, align = "left") → string`

`line` padded to `width` by R25 (`align` is `"left"`, `"right"` or `"center"`).

## Errors

Every invalid input throws `LayoutError` (exported), never a plain `Error` or `TypeError`.
