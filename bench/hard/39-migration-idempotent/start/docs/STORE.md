# Store layout

A store is a folder:

```
store.json                  {"schema":N}
records/<collection>.ndjson the records: customers, orders, and from schema 3 order_lines
quarantine/<collection>.ndjson
                            records the migrations set aside, with the reason
manifest.json               what every data file holds, written at the end of every run that changes the store
.migrate/                   the migration's work folder; only there while a run is unfinished
```

"Data files" are the files in `records/` and `quarantine/`.

## Formats

Input files (written by older tools or by hand) may have keys in any order, spaces, blank lines and lines
ending in `\r\n`. Everything the migration writes is canonical:

- **NDJSON** (records and quarantine): each record as JSON with the keys of every object sorted (JavaScript's
  default string sort), arrays in their order, no spaces, non-ASCII characters as they are (UTF-8); one
  record per line, every line ending in `\n`; a collection without records is an empty file.
- **store.json**: the same canonical JSON and a final `\n`: `{"schema":4}` + `\n`.
- **manifest.json**: canonical keys, but indented with two spaces (`JSON.stringify(value, null, 2)`), and a
  final `\n`.

`src/store/canonical.js` and `src/store/ndjson.js` write these forms.

## Quarantine

`quarantine/<collection>.ndjson` holds one entry per record set aside: `{"reason", "record", "step"}` (see
MIGRATIONS.md for the reasons and what `record` holds). A step adds its entries after the ones already in
the file; entries are never removed or rewritten. A quarantine file only exists once it has an entry.

## The manifest

After a run finishes, `manifest.json` describes the store:

```json
{
  "files": {
    "quarantine/customers.ndjson": { "bytes": 748, "records": 6, "sha256": "7aa4…" },
    "records/customers.ndjson": { "bytes": 678, "records": 4, "sha256": "59fa…" }
  },
  "schema": 4
}
```

`files` has an entry for every data file (and nothing else), keyed by its path with `/`: its size in
bytes, its number of non-blank lines and the SHA-256 of its bytes in lowercase hex. `schema` is the store's
schema. A finished run always writes the manifest, also when it had no step to do but there was no
manifest yet.

`migrate verify <store>` (and `verify(dir)`, below) compares the data files with the manifest: a file whose
size, line count or checksum differs, a data file the manifest does not list, a listed file that is gone,
or a manifest for another schema are mismatches.

## API

```js
import { migrate, status, verify } from './src/index.js';

migrate(dir, { to = 4, fault }) // -> { from, to, steps: ['v1->v2', …] }; see RESUME.md for fault
status(dir)                     // -> { schema, interrupted, manifest, counts: { collection: lines } }
verify(dir)                     // -> { ok, manifest, mismatches: [paths, sorted], files }
```

`verify` on a store without a manifest gives `{ ok: false, manifest: false, mismatches: [] }`.
