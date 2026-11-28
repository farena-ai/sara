# boxtext

Plain-text tables and reports for terminals, log files and e-mail. No packages, Node 20+.

```js
import { renderTable } from './src/index.js';

process.stdout.write(renderTable({
  width: 48,
  title: 'Stock',
  columns: [
    { header: 'Item' },
    { header: 'Qty', align: 'decimal' },
    { header: 'Note', flex: 1, maxLines: 2 },
  ],
  rows: [
    ['Apple', 3, 'fresh from the farm'],
    ['Kiwi', 12.5, ''],
  ],
}));
```

Or from the command line, with a JSON file holding the same object:

```sh
node bin/boxtext.js table.json
```

## Status

Version 2.0 is a rewrite around one specification, [docs/LAYOUT.md](docs/LAYOUT.md). The
measuring code, the option checks, fixed and auto columns, word wrapping and both border styles
have been carried over from 1.x. The rest of 2.0 (see CHANGELOG.md) is not written yet.

docs/LAYOUT.md is the specification: where this README, a comment or the code disagrees with it,
LAYOUT.md is right. [docs/API.md](docs/API.md) lists the functions and options and
[docs/EXAMPLES.md](docs/EXAMPLES.md) shows worked examples with their exact output.

## Layout

| Path | What it is |
|---|---|
| `src/index.js` | The public functions |
| `src/text/` | Measuring (`width.js`, `widthTable.js`, `clusters.js`), normalizing, wrapping, truncating, padding |
| `src/layout/` | Cells and rows, column widths, row layout |
| `src/render/` | Border styles, rule lines, the table renderer |
| `src/util/` | Errors, option checks, small string helpers |
| `bin/boxtext.js`, `src/cli.js` | The command line |
| `examples/` | Small scripts printing example reports |
| `test/` | The test suite (`node --test`) |

## Tests

```sh
node --test
```
