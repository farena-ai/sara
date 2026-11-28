# store-migrate

Upgrades a store (a folder of NDJSON record files) from one schema version to the next, setting aside the
records that cannot be upgraded. Node 24, no dependencies.

```sh
node bin/migrate.js status examples/store-v1
cp -r examples/store-v1 /tmp/s && node bin/migrate.js run /tmp/s
```

Version 0.4 knows the step from schema 1 to 2. The stores in the field are at schema 1 or 2, and they must
get to schema 4: the steps v2 → v3 and v3 → v4, the quarantine for them, the manifest with checksums,
resuming an interrupted run and running twice safely are all specified in docs/ and are what 1.0 must do.

## Documentation

- [docs/MIGRATIONS.md](docs/MIGRATIONS.md): what each step does to the records
- [docs/STORE.md](docs/STORE.md): the folder, the file formats, quarantine, the manifest, the API
- [docs/RESUME.md](docs/RESUME.md): the fault hook, resuming after an interruption, idempotency
- [docs/CLI.md](docs/CLI.md): the command line
- [docs/EXAMPLES.md](docs/EXAMPLES.md): small stores before and after each step
- [docs/SCHEMAS.md](docs/SCHEMAS.md): the record shapes at each schema
- [docs/OPERATIONS.md](docs/OPERATIONS.md): how the shops run the tool
- [CHANGELOG.md](CHANGELOG.md), [ISSUES.md](ISSUES.md)

## Layout

```
bin/migrate.js            command line
src/migrate/runner.js     runs the steps
src/migrate/registry.js   the list of steps
src/migrate/quarantine.js quarantine entries and a step's result
src/migrate/status.js     migrate status
src/steps/                one module per step, plus helpers in common/
src/store/                reading the folder, canonical JSON, NDJSON, checksums, fsx (all writes)
examples/store-v1/        a schema-1 store with most of the cases in it
tools/make-store.js       writes a larger synthetic schema-1 store
```

## Tests

```sh
node --test
```
