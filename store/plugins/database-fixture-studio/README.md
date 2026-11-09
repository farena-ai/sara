# Database Fixture Studio

Offline synthetic fixtures, not a live database tool. Register `analyze` with Ask permission, no file/network/model/broker grants. Returns structured rows plus executable SQLite DDL/INSERT SQL and a native invocation card. Never imports row values or production/personal data.

Input example:

```json
{"seed":42,"tables":[{"name":"parent","rows":2,"columns":[{"name":"id","type":"integer","primaryKey":true}]},{"name":"child","rows":3,"columns":[{"name":"parent_id","type":"integer","notNull":true,"references":{"table":"parent","column":"id"}}]}]}
```

See `schema.json` for complete closed inputs. Supported constraints: one integer primary key/table, unique, notNull, integer min/max and text maxLength CHECK, matching-type foreign keys to single primary/unique columns. Deterministic seeded generation topologically orders tables; no retries. Missing/invalid keys, cycles/self-reference, impossible bounds/uniqueness and unsupported constructs explicitly refuse. Some satisfiable short text bounds may conservatively refuse. No arbitrary SQL input/endpoint, live DB, selected-workspace or all-dialect claim.

Limits: seed 0..4294967295, 6 tables, 12 columns/table, 100 rows/table, 200 total rows, 32-character ASCII identifiers, 80-character text, integer bounds ±1000000. At most 46000 content bytes / 60000 full result-envelope bytes; larger output refuses. Identifiers and generated literals are quoted. Table and per-table column names must be unique under ASCII case-folding; table names beginning with `sqlite_` in any case refuse. References must match the exact supplied table/column spelling throughout validation, ordering and generation; identifiers and output keys are never rewritten. SQLite insertion with actual FK/UNIQUE/NOT NULL/CHECK failures is exercised only by owned disposable tests, not by plugin filesystem/DB access.

All six locales cover ready/tool description, result card/message and non-echo refusal. `shots/1.png` is a labelled synthetic preview from actual handler output, not an installed Sara screenshot. Authoring host 2.67; official package target 2.68 is compatibility assessment, not full 2.68 runtime qualification.
