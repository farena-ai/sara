# tally

Sales reports from CSV or JSON-lines files: group the records, sum them up, rank the groups and print a
table (text, CSV, Markdown or JSON). Python 3.10+, standard library only.

```sh
python -m tally report examples/sales.csv --spec examples/by_region.json
python -m tally report examples/sales.csv --spec examples/by_customer.json --format markdown
python -m tally check examples/sales.csv
```

```python
from tally import build_report, parse_spec
from tally.reader import read_records

spec = parse_spec({"group_by": ["region"], "top_products": 2, "order": "revenue"})
print(build_report(read_records("examples/sales.csv"), spec), end="")
```

## Documentation

- [docs/CONTRACT.md](docs/CONTRACT.md): what a report contains, byte for byte (the contract)
- [docs/SPEC_FORMAT.md](docs/SPEC_FORMAT.md): report specs
- [docs/CLI.md](docs/CLI.md): the command line
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md): the sizes tally must handle and how that is measured
- [CHANGELOG.md](CHANGELOG.md)

## Layout

```
tally/report.py        build_report: check, filter, group, compute, rank, order, render
tally/fields.py        the record fields and their checks
tally/spec.py          report specs
tally/reader/          CSV and JSON-lines readers
tally/filtering.py     where
tally/grouping.py      groups in appearance order
tally/metrics/         count, units, revenue, customers, median, top products
tally/ranking.py       competition ranks
tally/ordering.py      line order and limit
tally/sorting.py       a stable sort
tally/table.py         statistics to display cells
tally/money.py         number formatting and rounding
tally/render/          text, csv, markdown, json
tools/gen.py           generated data for the performance cases
tools/measure.py       measures the performance cases (docs/PERFORMANCE.md)
```

## Tests

```sh
python -m unittest discover -s tests
```
