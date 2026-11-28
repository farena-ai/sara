# Migrations

A store moves up one schema at a time: v1 → v2 → v3 → v4. Each step reads the store's collections as they
are at the start of the step and produces the next schema's collections plus quarantine entries. This file
says exactly what each step does; [STORE.md](STORE.md) says how files are written, and
[RESUME.md](RESUME.md) what must hold when a run is stopped and started again.

| step | name | collections read | collections written |
|---|---|---|---|
| 1 → 2 | `v1->v2` | customers, orders | customers, orders |
| 2 → 3 | `v2->v3` | customers, orders | customers, orders, order_lines |
| 3 → 4 | `v3->v4` | customers, orders, order_lines | customers, orders, order_lines |

Other files in `records/` are left alone. A collection whose file is missing counts as empty.

## Rules for every step

For each collection a step handles, in this order:

1. Lines that are not a JSON object (not JSON, or an array, a string, …) are quarantined with the reason
   `not a JSON object`; the entry's `record` is the line's text (without its line break).
2. Each remaining record, in file order, is checked: a record without a non-empty string `id` is quarantined
   with `missing id`; then the step's own checks below, in the order listed; the first one that fails
   quarantines the record with its reason. A record that passes is converted.
3. Of the converted records with the same `id`, the first (in file order) is kept and every later one is
   quarantined with `duplicate id`.

So a collection's new quarantine entries come in three runs: phase 1 lines, then phase 2 records, then
duplicates, each in file order. The entry's `record` is always the record as it was read at the start of
the step (before any conversion). Kept records stay in file order.

"Missing" below means the key is absent or its value is `null`.

## v1 -> v2

### customers

| check | reason |
|---|---|
| `email`, trimmed and lower-cased, must contain exactly one `@` with text before and after it | `bad email` |

Conversion: `name` is renamed `full_name` (the `name` key goes away; no `name`, no `full_name`); `email` is
stored trimmed and lower-cased; `tier` becomes `"basic"` when missing (an empty string stays as it is).

### orders

| check | reason |
|---|---|
| `total` is a dollar amount: digits, optionally grouped in thousands with commas (`1,234`), and optionally a `.` with one or two decimals | `bad total` |
| `weight_lb` is a number ≥ 0 | `bad weight` |
| `items` is an array | `bad items` |
| every item is an object whose `price` is a dollar amount as for `total` | `bad item price` |

Conversion: `total` → `total_cents`, the exact amount in whole cents (`"0.29"` → 29, `"1,234.5"` → 123450);
`weight_lb` → `weight_g` = `Math.round(weight_lb × 453.59237)`; in every item `price` → `price_cents` the
same way as the total (other item fields stay).

## v2 -> v3

Customers are done first, because orders depend on them.

### customers

| check | reason |
|---|---|
| when `phone` is a non-empty value: it must be a string whose digits (everything else removed) are 10 digits, or 11 digits starting with `1` | `bad phone` |

Conversion: `full_name` is replaced by `first_name` and `last_name`: the name is trimmed and runs of
whitespace become one space; `last_name` is the part after the last space and `first_name` everything
before it; a name without a space is all `first_name` with `last_name` `""`; no (or a non-string)
`full_name` gives two empty strings. `phone` becomes `+1` and the 10 digits, or `+` and the 11 digits; a
missing or empty `phone` is removed.

**Merging.** After the three phases, kept customers with the same `email` become one record: the first of
them in file order survives, in its place; for every key the survivor does not have (absent), it takes the
value from the first of the others (in file order) that has the key; and it gets `merged_ids`: the ids of
the others, in file order. Customers that were not merged have no `merged_ids`. The others are not
quarantined; they are simply gone.

### orders

| check | reason |
|---|---|
| its `customer`, after merging (an id that was merged points to its survivor), is the id of a kept customer of this step | `unknown customer` |
| `items` is an array | `bad items` |

Conversion: `customer` is the survivor's id; `items` is removed and `line_count` (the number of items) added.

### order_lines (new)

Each kept order's items become order_lines records, in order of the kept orders and then of the items: the
item's fields plus `id` = `<order id>#<n>` (n = 1, 2, … within the order) and `order` = the order's id (an
item's own `id` or `order` key is replaced). Any `records/order_lines.ndjson` present before this step is
ignored and replaced.

## v3 -> v4

Done in this order: customers, then order_lines (phases 1 to 3), then orders, then the order_lines rule
at the end of this section.

### customers

| check | reason |
|---|---|
| `created` is a string `YYYY-MM-DD` (four, two and two digits) | `bad date` |

Conversion: `created` → `created_at` = `created` + `"T00:00:00Z"`; `marketing_opt_in` becomes `false` when
missing.

### order_lines

| check | reason |
|---|---|
| `qty` is a whole number ≥ 0 and `price_cents` a whole number | `bad line` |

Conversion: `line_total_cents` = `qty × price_cents` is added.

### orders

| check | reason |
|---|---|
| `weight_g` is a number | `bad weight` |
| `total_cents` equals the sum of `line_total_cents` of the order_lines kept above whose `order` is this order's id (0 when there are none) | `total mismatch` |

Conversion: `weight_g` → `weight_kg` = `weight_g / 1000` (a JSON number: 680 → `0.68`); `currency` becomes
`"USD"` when missing. Orders are not checked against customers again in this step.

### order_lines of quarantined orders

Finally, every kept order line whose `order` is not the id of a kept order of this step is quarantined
with `order quarantined` (in file order, after the entries of phases 1 to 3).
