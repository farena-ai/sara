# Changelog

## 2.0.0 (in progress)

One specification for everything: docs/LAYOUT.md (rules R1 to R39).

Carried over from 1.x and adapted to the new option names:

- display widths from the width table (Appendix A of LAYOUT.md)
- option checks with `LayoutError`
- fixed and auto columns
- word wrapping
- the `"ascii"` and `"none"` styles, header rules and underlines

New in 2.0, still to be written:

- clusters with combining marks, orphan marks, tabs and old Mac line breaks
- long words broken over lines
- `overflow: "truncate"`, `maxLines` and the `ellipsis` option
- percent and flex columns, `min`/`max` for them, shrinking to the table width
- centered and decimal alignment, `headerAlign`
- spanning cells, `valign`
- `rowRules`, `title`, `pageHeight` and `repeatHeader`

## 1.6.2

- Fixed: a header made only of spaces gave a column of width 0.

## 1.6.0

- The `"none"` style no longer leaves trailing spaces.

## 1.5.0

- Columns take `min` and `max`.

## 1.0.0

- First release: fixed-width columns, ASCII borders.
