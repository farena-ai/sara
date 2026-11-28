# Moving from 1.x to 2.0

2.0 keeps the shape of the table object but renames a few options and makes every layout rule
explicit in [LAYOUT.md](LAYOUT.md). This page lists what changes for code written against 1.6.

## Renamed options

| 1.x | 2.0 |
|---|---|
| `columns[].size` | `columns[].width` |
| `columns[].grow` | `columns[].flex` |
| `columns[].minWidth`, `maxWidth` | `columns[].min`, `max` |
| `border: true` / `border: false` | `style: "ascii"` / `style: "none"` |
| `separators: true` | `rowRules: true` |
| `wrap: false` | `overflow: "truncate"` |

The old names are not accepted any more; they are simply ignored as unknown properties.

## Behaviour that changes

- Widths are measured in display columns (LAYOUT.md R1 to R3). 1.x counted UTF-16 code units,
  so East Asian text and emoji were laid out too narrow.
- 1.x kept runs of spaces inside cells. 2.0 joins words with single spaces (R8).
- 1.x cut long words at the column edge only when `breakWords` was set. 2.0 always breaks words
  that are wider than the column (R10) and no longer has `breakWords`.
- 1.x printed "..." for truncated text. The default ellipsis is now "…" (one column wide);
  pass `ellipsis: "..."` to keep the old look.
- 1.x made the last flex column absorb all rounding. 2.0 shares the units left over by
  rounding as described in R21.
- In 1.x, a page break could fall inside a row. 2.0 keeps rows whole unless a row is taller than
  a page (R38).
- `renderTable` returns pages separated by "\f" when `pageHeight` is set. 1.x returned an array;
  use `renderPages` for that.

## New in 2.0

Percent columns, decimal alignment, cell spans, vertical alignment, `maxLines`, `title`,
`repeatHeader`, and the `columnWidths` function.
