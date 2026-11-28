# Command line

```
migrate run <store> [--to N]     migrate the store up to schema N (default 4)
migrate status <store>           its schema, whether a run was interrupted, the record counts
migrate verify <store>           compare the data files with manifest.json
```

`run` prints one line per step it did (`v1->v2 done`) and then `store is at schema N`; with nothing to do it
prints `already at schema N, nothing to do`.

`status` prints `schema N` (with `, interrupted run (run again to finish)` when `.migrate/` is there) and
then `  <collection>: <n> records` per file in `records/`, in name order.

`verify` prints `ok: <n> files match the manifest` (exit 0), or one `mismatch: <path>` line per mismatch in
path order (exit 3); without a manifest it prints `error: the store has no manifest` on standard error
(exit 1).

Errors print `error: <message>` on standard error. Exit codes: 1 a store problem, 2 a usage error, 3 a
manifest that does not match.
