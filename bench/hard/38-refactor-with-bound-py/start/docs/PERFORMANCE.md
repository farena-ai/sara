# Performance

tally 2.3 was written for the monthly reports of a few shops: some thousand records, ten groups. It is now
used on the year's data of the whole chain, and it does not cope: a report on 20,000 records by customer
does not finish, and the nightly job runs out of memory on 50,000. Version 2.4 must handle the inputs
below within these bounds, **without changing any byte of any report** (docs/CONTRACT.md).

## How work and memory are measured

No clocks: the measurements are the same on every computer.

- **Lines**: the number of `line` events `sys.settrace` reports for code in files under `tally/` while the
  report is built (`build_report`, and the reader when reading a file). Code outside `tally/` (the standard
  library, builtins) is not counted.
- **Comparisons**: the input's text values (`order`, `day`, `region`, `store`, `product`, `category`,
  `customer`) are given as a `str` subclass that counts every `==`, `!=`, `<`, `<=`, `>`, `>=` it takes
  part in (also inside `in`, `sorted`, dict and set lookups). Values are used as they are given (CONTRACT.md,
  "Groups"), so these counts are the engine's comparisons of field values.
- **Memory**: the peak memory traced by `tracemalloc` while the report is built from a source that hands over
  one record at a time.

`n` is the number of input records, `g` the number of groups in the report (TOTAL not counted).

| bound | |
|---|---|
| lines | at most `150·n + 300·g + 50,000` |
| comparisons | at most `20·n + 6·g·⌈log2(g + 2)⌉ + 10,000` |
| memory | at most 10 MiB (10,485,760 bytes) for the memory cases |

## The cases

The records come from `tools/gen.py` (`records(n, seed, …)`); the bounds must hold for every seed.

| case | records | data | spec | measured |
|---|---|---|---|---|
| P1 | 20,000 | 4 regions | group_by region, top_products 3, order revenue | lines, comparisons |
| P2 | 20,000 | 5,000 customers | group_by customer, top_products 2, order key | lines, comparisons |
| P3 | 20,000 | every customer different, 2,000 products | group_by region + category, top_products 5, order revenue | lines, comparisons |
| M1 | 50,000 | 4 regions, given to `build_report` as a generator | group_by region, top_products 3, order revenue | memory |
| M2 | 50,000 | the same, written to a CSV file and read with `read_records` | group_by region + category, top_products 3 | memory |

All metrics are on (the default) in every case, and the output format is text. The bounds are not only for
these shapes: other formats, filters and listed groups must stay within them as well.

`python tools/measure.py [case …]` runs the cases and prints each measurement against its bound. It stops
a measurement as soon as the bound is passed, so a run that is far over the bound ends quickly.
