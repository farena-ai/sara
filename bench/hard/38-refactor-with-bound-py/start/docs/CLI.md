# Command line

```
python -m tally report DATA --spec SPEC.json [--format text|csv|markdown|json] [--limit N]
python -m tally check DATA
```

`report` writes the report to standard output. `--format` and `--limit` replace the spec's settings.
`check` reads every record of DATA, checks it (CONTRACT.md, "Errors") and prints `ok: <n> records`.

DATA is a `.csv` or `.jsonl` file. On a problem (a bad spec, a bad file or record) tally prints
`error: <message>` on standard error, writes nothing else, and exits with 2.
