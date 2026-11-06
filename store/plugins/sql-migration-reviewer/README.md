# SQL Migration Reviewer

Real SQLite rehearsal, not a prompt wrapper or production database tool. The `rehearse` tool requires Ask and accepts only explicit bounded migration SQL plus a typed **synthetic** baseline. Each invocation opens a fresh `node:sqlite` `DatabaseSync(':memory:')`, compiles and executes admitted statements, records actual schema/data-count/hash evidence, rolls back the entire migration, verifies the baseline, and closes the connection in `finally`. No files, connection strings, row-value import, workspace grants, network, model, shell, broker calls or persistent database.

```json
{"baseline":{"tables":[{"name":"items","rows":3,"columns":[{"name":"id","type":"INTEGER"},{"name":"label","type":"TEXT"}]}]},"sql":"CREATE TABLE archive (id INTEGER, label TEXT); CREATE INDEX items_id ON items (id);"}
```

## Closed first-tier grammar

Only these additive forms are admitted, case-insensitively:

```sql
CREATE TABLE identifier (identifier INTEGER|TEXT|REAL [NOT NULL], ...);
CREATE INDEX identifier ON identifier (identifier, ...);
```

The alternatives above describe grammar, not literal SQL syntax. Names are 1–32 ASCII characters matching `[A-Za-z][A-Za-z0-9_]*`, excluding the `sqlite_` prefix in any case. Plain and double-quoted names are accepted; doubled quotes are lexed correctly but fail the bounded-name restriction. `--` and non-nested `/* ... */` comments are lexed, not removed with regex. Optional final semicolon; every other statement requires a separator. Empty/extra statements, NUL, unterminated quotes/comments and trailing tokens refuse atomically before rehearsal. The recognizer accepts a closed grammar; it is **not** a full SQL AST parser or a general SQL-safety proof. Every admitted original statement is subsequently compiled by SQLite itself, which checks actual keyword, identifier, schema, column and index semantics.

Everything else refuses, including all ALTER (even otherwise safe variants), DROP, DELETE, arbitrary DML/SELECT, transactions, PRAGMA, ATTACH/DETACH, VACUUM, virtual/temp tables, views, triggers, UNIQUE/PRIMARY KEY/foreign keys, defaults, CHECK/generated expressions, collations, partial/expression indexes and functions. Rejecting all stored expressions also prevents dangerous functions from being deferred until later schema use; authorizer callbacks alone do not prove that property. Valid but unsupported SQLite SQL is not labelled intrinsically destructive: `unsupported-or-unsafe-input` is an admission refusal.

## Defense, evidence and limits

- Before baseline creation, an actual deny-all `setAuthorizer` probe must deny native CREATE compilation, invoke the callback and leave `sqlite_schema` empty. Missing/no-op enforcement returns `unsupported-runtime`; never execute a permissive fallback.
- Each untrusted DDL compilation installs a deny-by-default authorizer. Only main-database CREATE TABLE/INDEX, main-database reads required by DDL compilation, SQLite's internal schema INSERT/UPDATE and index rebuild actions are admitted. User DML, functions, reads via SELECT, transaction control, PRAGMA, attachments, views/triggers and virtual tables remain denied. No extensions are enabled. This is defense in depth alongside the much narrower recognizer, not authorization for arbitrary statements.
- Trusted fixed setup requires and reads back `temp_store=MEMORY`, `trusted_schema=OFF`, `max_page_count=256`, and journal mode `memory`. Busy timeout is zero. No caller can set pragmas. A fresh memory database has no other-user contention; this does not predict production locks or performance.
- SQL: 8192 UTF-8 bytes, 512 tokens, 8 statements. Baseline: 8 tables, 12 columns/table, 100 rows/table, 400 rows total. At most 8 new tables or indexes; no migration adds rows. Data are deterministic generated integers/reals/short synthetic strings, never supplied row values.
- Input: 1024 visited value nodes, depth 8, 16384 aggregate string-value bytes, 128 own keys/object, dense arrays only. Nonplain prototypes, cycles, getters, hidden properties, symbols and hidden toJSON functions refuse before serialization. JavaScript Proxy reflection traps are not a JSON-transport threat model or a claimed in-process JS sandbox.
- SQLite database pages are capped at 256 (default 4096-byte pages); this is not a total process/allocator cap. The host supplies a 128 MiB JS heap limit. Fixed rows/cells, no expressions/joins/subqueries/recursion/functions and small bounded index sorts bound algorithmic work; there is **no hard in-process wall-clock interrupt or OS sandbox claim**. Native SQLite/runtime vulnerabilities remain outside this finite grammar argument.
- Content ≤46000 bytes; full generated protocol envelope ≤60000 bytes. Excess output refuses, never silently clips. Cards/errors contain only fixed translated labels, not SQL, identifiers or row values. Structured reports contain bounded schema identifiers/types/nullability, index columns, actual row counts and SHA-256 hashes, but no SQL text or generated row values. SQLite's raw errors never escape.
- A semantic failure after earlier successful DDL reports the executed prefix and actual verified whole-transaction rollback. Grammar rejection executes zero statements and need not construct a database. `closed:true` is set only after an opened database closes (or admission rejects without opening one).

SQLite only. No PostgreSQL/MySQL compatibility, production safety/lock/cost/performance, live migration application, selected-project workflow, full Sara 2.68 application, chat approval, other-platform OS isolation or signed-publication claim. Authoring checkout remains Sara 2.67; packaging explicitly checks target 2.68. Node 24.20.0 was exercised; other runtimes must pass the enforcement probe and settings readback.

All six languages (en/es/fr/de/pt-BR/it) cover ready descriptions, status messages, cards and generic errors. Protocol keys/status/reason codes remain stable. `shots/1.png` is explicitly a synthetic preview rendered from actual handler output, not an installed Sara screenshot. See `schema.json` for the full closed tool schema and `THIRD_PARTY_NOTICES.md`/`LICENSE` for licensing.
