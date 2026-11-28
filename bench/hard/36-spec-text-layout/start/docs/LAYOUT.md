# Layout specification (version 2.0)

This document is the specification of `boxtext`. Every rule is numbered; the numbers are stable
and are quoted by the tests and by bug reports ("R21"). Where two rules could seem to disagree,
the rule text says which one wins. Words in `code` are option or function names (see
[API.md](API.md)). "w" is always a width measured in display columns (R1), never in characters.

Throughout, "space" means U+0020 only. Other whitespace characters (for example U+00A0) are
ordinary characters of width 1.

## 1. Text model

**R1. Code points and widths.** Text is processed one Unicode code point at a time, never one
UTF-16 code unit at a time (a character outside the Basic Multilingual Plane, such as U+1F600,
is one code point). The width of a code point is 0 if it is listed under "width 0" in
Appendix A, 2 if it is listed under "width 2", and 1 otherwise. The table in Appendix A is
complete: no other code point has width 0 or 2.

**R2. Clusters.** Text is divided into clusters: each code point of width 1 or 2 starts a new
cluster, and each code point of width 0 joins the cluster before it. A width-0 code point with no
cluster before it forms a cluster of its own (of width 0). The width of a cluster is the sum of the
widths of its code points. Wrapping, breaking and truncation (sections 2 and 3) never split a
cluster.

**R3. Text width.** The display width of a string is the sum of the widths of its code points.

**R4. Line breaks and tabs.** Before anything else, cell text, header text and the title are
normalized: every "\r\n" pair and every remaining "\r" becomes "\n", and every tab ("\t")
becomes one space.

**R5. Orphan marks.** After R4, a width-0 code point is removed when the code point before it is a
space or "\n", or when it is the first code point of the text. Removal is applied from left to
right, so in "a" + space + U+0301 + U+0302 both marks are removed (U+0302 now follows the space).

**R6. Cell values.** A cell is a string, a number, `null`, `undefined`, or a cell object
`{ text, span, align }` (any non-null object that is not an array). A number is shown as
`String(value)`; `null` and `undefined` are the empty string; the `text` of a cell object follows
the same conversion. Any other cell or `text` value (a boolean, an array, an object as `text`)
is a `LayoutError`.

## 2. Wrapping

Wrapping turns a text into lines of width at most w. It is used for every header cell and for
every body cell whose column has `overflow: "wrap"` (the default).

**R7. Paragraphs.** The normalized text (R4, R5) is split at every "\n" into paragraphs. Each
paragraph is wrapped on its own and contributes at least one line. A paragraph with no words
(empty, or only spaces) contributes exactly one empty line. So "a\n\nb" gives the lines
"a", "", "b", and the empty text gives one empty line.

**R8. Words.** Inside a paragraph, a word is a maximal run of clusters that are not spaces.
Spaces only separate words: on a line, consecutive words are joined by exactly one space,
however many spaces separated them in the input, and a line never begins or ends with a space.

**R9. Greedy filling.** Words are placed in order. A word of width at most w is appended to the
current line (after one space) if the line's width plus 1 plus the word's width is at most w;
if the current line is empty the word simply becomes its content. If it does not fit, the current
line is finished and the word starts the next line.

**R10. Long words.** A word wider than w is broken. If the current line is not empty it is
finished first, so a broken word always starts a new line. The word's clusters are then laid into
pieces from left to right: a cluster is added to the current piece if the piece's width plus the
cluster's width is at most w; otherwise the piece is finished and the cluster starts a new piece.
Every piece but the last becomes a line of its own. The last piece becomes the current line, and
the words that follow are appended to it under R9 like to any other line.

**R11. Over-wide clusters.** When breaking a word (R10), a cluster whose width is greater than w
(a width-2 cluster when w is 1) is replaced by a single "?" (width 1).

## 3. Truncation and line limits

**R12. Truncate mode.** A body cell whose column has `overflow: "truncate"` is always shown on one
line. Its text is first flattened: the words of the normalized text (separated by spaces or
"\n") joined by single spaces, with no leading or trailing space. If the flattened text has width
at most w it is shown unchanged, without an ellipsis.

**R13. Ellipsis.** Otherwise the cell shows the longest run of whole clusters from the start of
the flattened text whose width is at most w minus the width of the ellipsis, then trailing spaces
of that run are removed, then the ellipsis is appended. The ellipsis is the table option
`ellipsis`, default "…" (U+2026, width 1). The result may be narrower than w, for example
when a width-2 cluster does not fit; alignment (R25) then pads it.

**R14. Narrow ellipsis room.** If the ellipsis is at least as wide as w, the cell shows the
longest run of whole clusters from the start of the ellipsis whose width is at most w (with the
default ellipsis and w = 1 that is "…").

**R15. Line limit.** A column option `maxLines` (only meaningful with `overflow: "wrap"`) limits
each body cell of the column to that many lines. When wrapping gives more lines than
`maxLines`, only the first `maxLines` lines are kept and the last kept line L is marked: if the
width of L plus the width of the ellipsis is at most w, the line becomes L followed directly by the
ellipsis (no space between); otherwise L is shortened exactly as in R13 (or R14) and the ellipsis
appended. When wrapping gives `maxLines` lines or fewer, nothing is marked. `maxLines` never
applies to header cells.

## 4. Column widths

**R16. Column kinds.** A column has at most one of `width` (a fixed column), `percent` (a percent
column) and `flex` (a flex column); a column with none of them is an auto column. `width`,
`flex`, `min`, `max` and `maxLines` must be integers of at least 1, `percent` must be an integer
from 1 to 100, `min` must not exceed `max`, and the `percent` values of all columns must not add
up to more than 100. Anything else is a `LayoutError`.

**R17. Overhead and budget.** The width of every output line of the table is the overhead of the
style plus the sum of the column widths. For n columns the overhead is 3n + 1 in the `"ascii"`
style and 2(n - 1) in the `"none"` style (see R32, R33). When the table option `width` is given,
the budget B is `width` minus the overhead: the column widths must add up to at most B.

**R18. Min and max.** `min` defaults to 1 for every column. `min` and `max` clamp the width of
percent, auto and flex columns (clamping means: a value below `min` becomes `min`, a value
above `max` becomes `max`). Fixed columns are exactly `width`; their `min` and `max` are ignored.

**R19. Natural width.** The natural width of a column is the largest of: 1; the width of the
widest paragraph of its header (paragraphs as in R7, words joined by single spaces as in R8);
and, for each body cell of the column with span 1, the cell's natural width. The natural width
of a cell in a `"wrap"` column is the width of its widest paragraph (same as for the header); in a
`"truncate"` column it is the width of its flattened text (R12). For a column with
`align: "decimal"` the natural width is also at least the decimal width D of R27. Cells with a
span greater than 1 never count.

**R20. Percent columns.** A percent column is `floor(percent × B / 100)` wide, then clamped (R18).

**R21. Flex shares.** After fixed, percent and auto columns (auto columns are their natural width,
clamped) the remaining width is R = B minus their sum, or 0 if that is negative. R is shared
among the flex columns in proportion to `flex`: with K the sum of the `flex` values, each column
gets `floor(R × flex / K)`, and the units still left over (fewer than the number of flex columns)
are given one each to the flex columns with the largest value of `(R × flex) mod K`; equal values
go to the leftmost column first.

**R22. Clamped flex columns.** Flex columns are clamped by rounds. In a round, shares are computed
by R21 for the flex columns not yet settled, with R reduced by the widths of the settled ones (R
again counts as 0 if negative). If any share is above that column's `max`, every such column is
settled at its `max` and a new round starts. Otherwise, if any share is below that column's
`min`, every such column is settled at its `min` and a new round starts. Otherwise the remaining
columns take their shares and resolution ends. Width that no column can take (every flex column
settled at its `max`) is left unused: the table is then narrower than `width`.

**R23. Shrinking.** If the widths now add up to more than B, columns are narrowed one column unit
at a time: each time, the widest column that is not fixed and is wider than its `min` loses 1;
among equally wide candidates the rightmost one loses it. This repeats until the sum is at most B.
If no column can be narrowed and the sum is still above B, it is a `LayoutError`.

**R24. No width option.** Without the table option `width` there is no budget: flex columns are
sized like auto columns, R21 to R23 do not apply, and a percent column is a `LayoutError`.

## 5. Alignment

**R25. Padding.** Every line of a cell is padded with spaces to exactly the cell's width.
`"left"` (the default) pads on the right, `"right"` on the left, and `"center"` puts
`floor(gap / 2)` spaces on the left and the rest on the right.

**R26. Header and cell alignment.** A header cell uses the column's `headerAlign` if set,
otherwise the column's `align`, except that a `"decimal"` column's header is `"right"`. A cell
object's own `align` (`"left"`, `"right"` or `"center"`) overrides the column's alignment for that
cell.

**R27. Decimal metrics.** In a column with `align: "decimal"`, a numeric cell is a body cell with
span 1 and no `align` of its own whose flattened text (R12) matches: an optional "-", one or more
digits 0–9, and optionally a "." followed by one or more digits. For a numeric cell, its integer
part is everything before the "." (the whole text if there is none, including the "-") and its
fraction is everything after it (empty if there is none). Over all numeric cells of the column in
the whole table (every page), let I be the longest integer part and F the longest fraction. The
decimal width D is I when F is 0, and I + 1 + F otherwise. A column with no numeric cells has no
decimal width.

**R28. Decimal alignment.** If D is at most the column's width, each numeric cell is one line:
spaces so that its integer part is I wide, then the cell's flattened text, then spaces so that
the "." column lines up: F + 1 spaces if the cell has no fraction and F > 0, otherwise F minus the
fraction's length. That D-wide block is then right-aligned in the column (R25); this holds in
`"truncate"` columns too. If D is greater than the column's width, numeric cells are laid out
like any other text of their column (wrapped or truncated), right-aligned. Every other body
cell of a decimal column is right-aligned, unless it has its own `align` (R26).

## 6. Rows and spans

**R29. Row shape.** A row is an array of cells; a cell object with `span: k` covers k columns
(k an integer of at least 1, default 1). If the cells of a row cover fewer columns than the table
has, the missing columns are empty cells. A row whose cells cover more columns than the table
has, or a span that is not an integer of at least 1, is a `LayoutError`.

**R30. Spanned cells.** A cell spanning columns i to j has the width of those columns plus what
lies between them on a line: 3 per inner boundary in `"ascii"` (padding, separator, padding) and
2 per inner boundary in `"none"`. Its `overflow`, `maxLines`, `valign` and alignment come from
column i (with `"decimal"` meaning `"right"`, R27 not applying), unless the cell object has its
own `align`.

**R31. Row height and vertical alignment.** A row is as tall as its tallest cell. A shorter body
cell gets blank lines (spaces to its width) according to its column's `valign`: `"top"` (the
default) puts them all below, `"bottom"` all above, and `"middle"` puts `floor(missing / 2)`
above and the rest below. Header cells are always top-aligned.

## 7. Output

**R32. The "ascii" style** (the default). A content line is "|", then for each cell a space, the
cell's line and a space, each followed by "|". A rule line is "+", then for each column
(spans are ignored) `width + 2` rule characters followed by "+". The table starts with a rule of
"-", the header (if any) is followed by a rule of "=", and the table ends with a rule of "-".
With the table option `rowRules: true`, a rule of "-" is placed between two body rows on the same
page.

**R33. The "none" style.** A content line is the cells' lines joined by two spaces, with no
padding and no outer border. The header (if any) is followed by an underline made of, for each
column, `width` "-" characters, joined by two spaces. There are no other rules; with
`rowRules: true`, an empty line is placed between two body rows on the same page.

**R34. Trailing spaces and line ends.** In the `"none"` style every output line has its trailing
spaces removed (a line that becomes empty stays as an empty line). In the `"ascii"` style lines
end with "|" or "+" and are not changed, except the title lines (R36), which always have their
trailing spaces removed. Each page is its lines, each followed by "\n" (so a page ends with
"\n"). `renderTable` joins the pages with a form feed "\f" between them; `renderPages` returns
them as an array.

**R35. The header.** The table has a header when at least one column has a `header` property that
is not `undefined` (an empty string counts). Then every column contributes a header cell (empty
when its `header` is missing), wrapped by R7–R11 to the column width whatever the column's
`overflow`.

**R36. Title.** With the table option `title`, the first page starts with two lines: the title,
then an empty line. The title is flattened (R12), truncated to the table's line width (R17) by
R12–R14, and centered in that width by R25 (then R34 removes the trailing spaces). The title
appears on the first page only.

## 8. Pages

**R37. Page frame.** With the table option `pageHeight` (an integer of at least 1), output is
split into pages of at most `pageHeight` lines. Each page is, in this order: the title lines
(first page only), the top rule (`"ascii"`), the header lines and the header rule or underline
(when the table has a header and the page shows it, R39), the body lines, and the bottom rule
(`"ascii"`). The body room of a page is `pageHeight` minus the number of all its other lines; a
page whose body room would be less than 1 is a `LayoutError`. Without `pageHeight` there is one
page with unlimited room. A table with no body rows is one page holding the frame only.

**R38. Placing rows.** Body rows are placed in order. A row rule or empty line from `rowRules`
(R32, R33) counts as one line and is only placed between two rows (or parts of rows) on the same
page, never at the top of a page. When the current page already has body lines, a row that does
not fit in what is left of it, together with its row rule, starts a new page. When the current
page has no body lines yet (it is the first page, or a row just started a new page) and the row
is taller than the body room, it is split there: the first lines that fill the body room stay on
that page, and the rest continues at the top of the next page (and is split again if still too
tall); the next row may follow that rest on the same page. Vertical alignment (R31) is applied to
the whole row before it is split.

**R39. Repeated header.** The header is shown on every page when the table option `repeatHeader`
is `true` (the default), and only on the first page when it is `false`.

## Appendix A. Width table

Width 0 (combining marks):

| From   | To     | Block |
|--------|--------|-------|
| U+0300 | U+036F | Combining Diacritical Marks |
| U+20D0 | U+20FF | Combining Diacritical Marks for Symbols |
| U+FE20 | U+FE2F | Combining Half Marks |

Width 2:

| From    | To      | Block |
|---------|---------|-------|
| U+1100  | U+115F  | Hangul Jamo (leading consonants) |
| U+2E80  | U+303E  | CJK radicals, punctuation |
| U+3041  | U+33FF  | Hiragana, Katakana, CJK compatibility |
| U+3400  | U+4DBF  | CJK Extension A |
| U+4E00  | U+9FFF  | CJK Unified Ideographs |
| U+AC00  | U+D7A3  | Hangul Syllables |
| U+F900  | U+FAFF  | CJK Compatibility Ideographs |
| U+FE30  | U+FE4F  | CJK Compatibility Forms |
| U+FF01  | U+FF60  | Fullwidth Forms |
| U+FFE0  | U+FFE6  | Fullwidth Signs |
| U+1F300 | U+1F64F | Pictographs, emoticons |
| U+1F900 | U+1F9FF | Supplemental Symbols and Pictographs |

Both ends of every range are included. The same table is in `src/text/widthTable.js`.
