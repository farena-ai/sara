# Interruptions, resuming, idempotency

Stores are migrated on machines that get rebooted, by jobs that get killed. These rules are what make that
safe.

## The fault hook

`migrate(dir, { fault })` takes an optional function. Every change the migration makes inside the store
folder (writing a file, renaming, removing, creating a folder) goes through `src/store/fsx.js`, which calls
`fault(point)` first; `point` names the operation (`"write records/orders.ndjson"`,
`"rename .migrate/x -> store.json"`, `"remove .migrate"`, `"mkdir .migrate"`). The migration never changes
anything in the store folder in another way.

- If `fault` throws, that operation does not happen and the error ends the run: as if the process had been
  killed just before it.
- If `fault` returns `"torn"` for a write, the first half of the file's bytes are written, and the run ends
  with an `Interrupted` error: as if the process had been killed in the middle of the write.

Reading never calls the hook.

## Resuming

A run may end at any operation, in either way above, any number of times in a row. Running `migrate` again
(with the same target, and without faults) must then finish the migration, and the store must end up
**byte for byte** the same as after one uninterrupted run from the original store: every data file,
`store.json`, `manifest.json`, and no `.migrate/` folder left. That holds whatever the step, the file or the
point in the run where it stopped, including while writing the manifest.

`migrate status` says `interrupted run` when a run was stopped after it started changing the store; the
next `migrate run` carries on with it rather than starting afresh (the records may then be partly
converted, so they cannot simply be read again as the old schema).

## Idempotency

- Running `migrate` on a store that is already at the target schema, with a manifest that matches its data
  files, changes nothing: no file is written, renamed or removed (so the fault hook is never called), and the
  result has `steps: []`. Running twice is therefore the same as running once, bytes included.
- A store at the target without a manifest gets its manifest written, and nothing else changes.
- A store at the target whose manifest does not match (as `verify` in STORE.md defines it) is refused with a `ManifestError`
  `manifest does not match <first mismatching path>` and is not changed (CLI exit code 3).
- Migrating to a lower schema than the store's is refused (`StoreError`).
