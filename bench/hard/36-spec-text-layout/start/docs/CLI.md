# Command line

```sh
node bin/boxtext.js <table.json> [--width N] [--style ascii|none] [--page-height N]
```

The JSON file holds one table object, exactly as `renderTable` takes it (see [API.md](API.md)).
`--width`, `--style` and `--page-height` override `width`, `style` and `pageHeight` from the
file. The table is written to standard output.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | The table was printed (or `--help`) |
| 1 | The table is invalid (`LayoutError`); the message is on standard error |
| 2 | Wrong arguments; the usage line is on standard error |
| 3 | The file could not be read or is not JSON |

Example, with `examples/stock.json`:

```sh
node bin/boxtext.js examples/stock.json --width 40
```
