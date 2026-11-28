# tabula

A tiny in-memory table store for small tools and tests: typed tables, immutable queries and
explicit transactions. No dependencies, synchronous, plain JavaScript (ES modules).

```js
import { createStore } from './vendor/tabula/index.js';

const db = createStore()
  .define('people', { key: 'id', columns: { id: 'int', name: 'text', city: 'text?' } });

db.load('people', [{ name: 'Ada', city: 'London' }, { name: 'Linus', city: null }]);

const londoners = db.from('people').where('city', 'eq', 'London');
const { rows, matched } = londoners.orderBy('name').page(0, 20).run();

const tx = db.begin();
tx.patch('people', 1, { city: 'Paris' });
const [err, counts] = tx.commit();
if (err) console.error(err.code, err.message);
```

## Ideas in one page

- **Queries are values.** `where`, `whereAny`, `orderBy`, `page` and `select` never change the
  query they are called on; they return a new one. Keep the result.
- **One ordering.** `orderBy` takes one field spec or an array of them and replaces any earlier
  ordering. `'-total'` means descending.
- **Pages count from zero.** `page(0, 20)` is the first twenty rows.
- **`between` is half-open**: `[low, high)`.
- **Results are objects**: `run()` returns `{ rows, matched, index, size }`; `matched` counts every
  matching row, not only the page.
- **Rows are frozen copies.** Change data through a transaction, never by editing a row.
- **Transactions must be committed.** `commit()` returns `[error, counts]`; it does not throw for a
  refused commit. A transaction that is not committed changes nothing.

The full reference is in [docs/API.md](docs/API.md). Changes are listed in
[CHANGELOG.md](CHANGELOG.md).
