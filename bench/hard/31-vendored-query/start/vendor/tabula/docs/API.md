# tabula 2.3 API reference

Everything is synchronous. Import from `vendor/tabula/index.js`:

```js
import { createStore, TabulaError, OPERATORS, VERSION } from './vendor/tabula/index.js';
```

All errors are `TabulaError` objects with a string `code` (listed at the end).

## Store

### `createStore()`

Returns a new empty `Store`.

### `store.define(name, definition)` -> the store

Adds a table. Returns the store, so definitions can be chained.

```js
store.define('orders', {
  key: 'id',                         // the key column (required)
  columns: { id: 'int', total: 'int', note: 'text?' },
  unique: ['ref'],                   // optional: columns whose non-null values must be unique
});
```

Column types: `int` (integer number), `num` (finite number), `text` (string), `bool`, `date`
(a `'YYYY-MM-DD'` string that is a real calendar day). A type ending in `?` is nullable.
The key column must be `int` or `text` and not nullable. When the key is `int`, rows may be
inserted without it and get the next free key (largest key + 1).

Defining a table twice throws `bad-definition`.

### `store.tables()` -> string[]

Table names in definition order.

### `store.load(name, rows)` -> keys[]

Inserts many rows outside a transaction, all or nothing. Throws `schema` or `conflict` on the first
problem (and then inserts none). Returns the keys of the inserted rows. Meant for seeding data.

### `store.from(name)` -> Query

A query over the table's committed rows.

### `store.lookup(name, key)` -> row | null

The row with that key, or `null`. The key must have the key column's type: on an `int` key,
`lookup('orders', '7')` is `null` even if there is an order 7.

### `store.begin()` -> Transaction

Starts a transaction (see below).

### `store.version` -> number

How many loads and commits have changed the store.

## Rows

Rows come out of tabula as **frozen copies**: assigning to a property of a row throws a
`TypeError` (ES modules run in strict mode), and changing a copy would not change the store anyway.
Build a new object when you need a different shape. Every column is present in a row; nullable
columns that were left out on insert are `null`.

## Query

A `Query` is immutable. Each of `where`, `whereAny`, `orderBy`, `page` and `select` returns a
**new** query; the query it was called on is unchanged:

```js
let q = store.from('orders');
if (onlyBig) q = q.where('total', 'ge', 10000);   // keep the result
q.where('status', 'eq', 'open');                    // does nothing useful: the new query is dropped
```

A query reads the table when it is run (`run`, `first`, `count`, `sum`, `group`), not when it is
built, so a query built before a commit sees the committed rows when it runs later.

### `query.where(column, op, value)` -> Query

Keeps rows where `column op value` holds. Several `where` calls are combined with AND. Unknown
columns throw `unknown-column`; unknown operators or values of the wrong shape throw `bad-op`.

| op | value | keeps rows where the column... |
|---|---|---|
| `eq` | one value | equals the value (`===`) |
| `ne` | one value | does not equal the value |
| `lt` `le` `gt` `ge` | one value | is `<`, `<=`, `>`, `>=` the value |
| `in` | array | equals one of the values |
| `nin` | array | equals none of the values |
| `between` | `[low, high]` | is `>= low` and `< high` (**high is excluded**) |
| `has` | string | contains the string (case-sensitive) |
| `ihas` | string | contains the string, ignoring case |
| `null` | none | is null |
| `notnull` | none | is not null |

Note the names: `le` and `ge` (not `lte`/`gte`), and there is no `like` or `=`.
Comparisons use JavaScript `<` and `>`; dates are `'YYYY-MM-DD'` strings, which compare correctly
as strings.

**Nulls.** A null column value never matches `eq`, `lt`, `le`, `gt`, `ge`, `in`, `between`, `has`
or `ihas`. It does match `ne` and `nin` (null is "not equal" to any value), and of course `null`.

### `query.whereAny(conditions)` -> Query

`conditions` is a non-empty array of `[column, op, value]` arrays (`[column, 'null']` for the
operators without a value). Keeps rows that match **at least one** of them. The group as a whole is
ANDed with the other filters.

```js
q.whereAny([['status', 'eq', 'open'], ['total', 'gt', 0]]);
```

### `query.orderBy(spec)` -> Query

`spec` is a column name, a column name prefixed with `-` for descending order, or an array of those
(the first is the primary key of the ordering). Exactly one argument: `orderBy('total', 'desc')`
throws `bad-order`.

Each call **replaces** the ordering of the query it is called on; it does not add a secondary key:

```js
q.orderBy('-date').orderBy('id');      // ordered by id only
q.orderBy(['-date', 'id']);            // by date descending, then id ascending
```

Values order as: `null` first, then `false` before `true`, numbers numerically, strings by code
unit (so `'Zed'` sorts before `'adam'`). Rows that tie on every ordering column come out in
ascending key order. Without `orderBy`, rows come out in ascending key order.

### `query.page(index, size)` -> Query

Keeps only one page of the ordered rows. **`index` counts from 0**: `page(0, 10)` is rows 1 to
10, `page(1, 10)` rows 11 to 20. `index` must be an integer `>= 0` and `size` an integer `>= 1`,
otherwise `bad-page` is thrown. A page past the end is empty.

### `query.select(columns)` -> Query

Rows of the result have only these columns (in this order). Filters and ordering may still use
any column.

### `query.run()` -> `{ rows, matched, index, size }`

Runs the query. The result object and its `rows` array are frozen.

- `rows`: the rows (only the page, when `page()` was used)
- `matched`: the number of rows that matched the filters, **before** paging
- `index`, `size`: the page used, or `null` when there was no `page()`

### `query.first()` -> row | null

The first row in the query's order, ignoring `page()`; `null` when nothing matches.

### `query.count()` -> number

The number of matching rows, ignoring `page()`.

### `query.sum(column)` -> number

The sum of a number column over all matching rows, ignoring `page()`. Nulls are skipped; no rows
give `0`.

### `query.group(column, sumColumn?)` -> `[{ key, count, sum? }]`

Groups the matching rows (ignoring `page()`) by a column. One entry per distinct value, sorted by
the value (in the ordering above). `sum` is present only when `sumColumn` is given.

## Transactions

```js
const tx = store.begin();
const id = tx.insert('orders', { total: 1250, note: null });
tx.patch('orders', 3, { total: 990 });
tx.remove('orders', 4);
const [err, counts] = tx.commit();
```

A transaction sees the store as it was at `begin()`, plus its own writes (through `tx.from` and
`tx.lookup`). Nothing reaches the store until `commit()`. A transaction that is never committed,
or is rolled back, has **no effect**: there is no automatic commit.

Writes are checked against the table's columns immediately (a row that does not fit throws
`schema`), but duplicate keys, duplicate unique values and conflicts with other commits are only
found by `commit()`.

### `tx.from(name)` -> Query, `tx.lookup(name, key)` -> row | null

Like the store's, but over the transaction's view.

### `tx.insert(name, row)` -> key

Adds a row and returns its key. For an `int` key the key may be left out; it is then assigned
(largest key in the transaction's view + 1).

### `tx.patch(name, key, changes)` -> boolean

Sets some columns of one row: `changes` is an object of column -> new value (the key column cannot
be changed). Returns `false`, and records nothing, when the transaction sees no row with that key.

### `tx.remove(name, key)` -> boolean

Deletes one row. Returns `false`, and records nothing, when there is no such row.

### `tx.commit()` -> `[error, counts]`

Writes all the changes to the store at once, or none of them. **It does not throw** when the store
refuses the changes; it returns a pair:

- `[null, { inserted, patched, removed }]` when the changes were written
- `[error, null]` when they were refused; `error` is a `TabulaError` with code `conflict`
  (duplicate key or unique value), `missing` (a row it changed was removed by another commit) or
  `stale` (a row it changed was changed by another commit since `begin()`). Nothing was written.

The transaction is closed after `commit()` whatever the outcome.

### `tx.rollback()`

Drops the changes and closes the transaction.

### `tx.open` -> boolean

`false` after `commit()` or `rollback()`. Any use of a closed transaction (including running a
query made from `tx.from`) throws `closed`.

## Error codes

| code | when |
|---|---|
| `unknown-table` | the table was never defined |
| `unknown-column` | a column the table does not have (or a non-number column for `sum`) |
| `bad-definition` | `define()` got an invalid definition |
| `bad-op` | unknown operator or a value of the wrong shape |
| `bad-order` | `orderBy()` got anything but one field spec or one array |
| `bad-page` | `page()` got an invalid index or size |
| `schema` | a row or change does not fit the columns |
| `conflict` | duplicate key or unique value (from `load` as a throw, from `commit` as a returned error) |
| `missing` | `commit()`: a changed row no longer exists |
| `stale` | `commit()`: a changed row was changed by another commit |
| `closed` | the transaction is already closed |
