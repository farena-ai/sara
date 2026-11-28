# What a report contains

This is the contract for `build_report(records, spec)` and `python -m tally report`. Every byte of the
output follows from the rules below; reports that people already use are compared byte for byte, so the
output must not change.

## Input

A record is a mapping with (at least) these fields, all text:

| field | rule |
|---|---|
| `order`, `region`, `store`, `product`, `category`, `customer` | any text (may be empty) |
| `day` | `YYYY-MM-DD` (month 1–12, day 1–31) |
| `qty` | a whole number, may be negative (`-2` is a return) |
| `price` | digits with up to two decimals (`12`, `12.5`, `12.50`), not negative |

`build_report` takes any iterable of records and reads it once (it may be a generator). Files are read
with `tally.reader.read_records(path)`: `.csv` (a header row naming the nine columns in any order, extra
columns allowed and ignored, blank rows skipped, UTF-8 with or without a BOM) or `.jsonl` (one JSON object
per line, blank lines skipped; JSON numbers become their text, `3` → `"3"`).

### Errors

- Every record is checked, in input order, also the records the spec's `where` leaves out. The first
  record that breaks a rule stops the report with `record <n>: …` (`n` counts records from 1):
  `missing field 'price'`, `field 'region' must be text`, `bad day '2026-13-01'`, `bad qty 'x'`,
  `bad price '1.234'` (checked in that order within a record).
- A file is checked as a whole before any of its records: a broken line anywhere in it (a CSV row with the
  wrong number of fields: `<path>: line <n>: expected 9 fields, got 8`; a JSON line that does not parse or
  is not an object: `<path>: line <n>: not valid JSON` / `not a JSON object`) is reported even when an
  earlier record has a bad value. CSV line numbers count CSV rows (the header is line 1).

## Filtering (`where`)

`day_from` / `day_to` keep records whose day is on or after / on or before that day (compared as text).
Any other entry `field: [values]` keeps records whose field is exactly one of the values.

## Groups

A record's group is the tuple of its `group_by` field values, **exactly as they are**: no trimming, no
case folding, no Unicode normalization (`"é"` written as one code point and as `e` + combining accent are
two groups).

Groups named in the spec's `groups` are always shown, also when no record falls in them (an empty group:
count 0, units 0, revenue 0.00, customers 0, and `-` for the rest). A listed group that also occurs in the
input is the same group. Duplicates in `groups` are ignored.

**Appearance order** is used for ties: the listed groups come first, in the order listed; then the other
groups in the order their first (kept) record appears in the input.

## Columns

The group_by fields (one column each), then the spec's `metrics` in the spec's order, then `top_products`
when `top_products` > 0.

| metric | value | shown as |
|---|---|---|
| `count` | number of records | `12` |
| `units` | sum of qty | `-3` |
| `revenue` | sum of qty × price, exact | two decimals |
| `customers` | number of different non-empty customer values (exact comparison) | `7` |
| `avg_price` | revenue ÷ units | two decimals; `-` when units is 0 |
| `median_qty` | median of the records' qty: the middle value, or the mean of the two middle values | `3`, `3.5`, `-0.5`; `-` for no records |
| `share` | revenue ÷ total revenue × 100 | one decimal, half up; `-` when the total revenue is 0 |
| `rank` | competition rank by revenue, highest first: equal revenue gets the same rank and the next rank skips (1, 2, 2, 4) | `2` |

Two decimals means rounded half to even (`0.125` → `0.12`, `0.135` → `0.14`). `avg_price` divides with
Python's default decimal context (28 digits) and then rounds. A value that rounds to zero is shown without a
sign (`0.00`, `0.0`, never `-0.00`).

`top_products` lists the group's best products: the products by their revenue within the group, highest
first, equal revenue by product name in code-point order; exactly `top_products` of them (fewer if the group
has fewer products). Each is `name (revenue)`, joined with `, `; `-` for an empty group.

Ranks are computed over all groups (empty listed groups included) before `limit` is applied.

## Order and limit

`order: "key"` sorts by group key: the tuples compared field by field, text in code-point order (so `"Z"`
comes before `"a"`, and `"é"` after `"z"`). `order: "revenue"` puts the highest revenue first; equal revenue
keeps appearance order. `limit: N` then keeps the first N groups.

## The TOTAL line

The last line, always present. It covers every kept record (all groups, not just the ones `limit` shows):
`TOTAL` in the first group column, the other group columns empty, the metrics over all kept records
(`customers` counts different customers over all of them, `median_qty` is the median of all their qty,
`share` is `100.0` or `-`), `rank` empty, and the best products over all of them.

## Formats

- **text**: the title and an empty line (when there is a title), the header line, a rule (`-` repeated to
  each column's width), one line per group, the TOTAL line. Columns are separated by two spaces; a column is
  as wide as its widest cell (header included), widths counting characters (code points); group and
  `top_products` columns are left-aligned, metrics right-aligned; trailing spaces are removed. Every line
  ends with `\n`.
- **csv**: the header row, the groups, the TOTAL row; no title; Python's `csv` quoting; lines end with `\n`.
- **markdown**: `## <title>` and an empty line (when there is a title), a pipe table
  (`| a | b |`), the alignment row (` --- ` left, ` ---: ` right), the groups, and the TOTAL row with every
  non-empty cell in `**bold**`; `|` inside a cell is written `\|`.
- **json**: `{"title", "columns", "rows": [{column: cell}], "total": {column: cell}}` with every cell a
  string as shown in the other formats, two-space indent, non-ASCII characters written as they are, and a
  final newline.
