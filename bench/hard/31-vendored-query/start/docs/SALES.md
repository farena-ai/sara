# Sales and customer figures

Both functions live in `src/reports.js`, take the store first and must not change it.

## `salesReport(db, options)`

A filtered, sorted and paged list of orders.

```js
salesReport(db, { from: '2026-01-01', to: '2026-01-31', region: 'north', sort: 'total', page: 2, perPage: 20 });
// -> { rows: [...], total: 47, sum: 1234500, page: 2, perPage: 20, pages: 3 }
```

Options (all optional): `from`, `to`, `status`, `customerId`, `region`, `search`, `minTotal`,
`sort`, `page`, `perPage`.

### Filters

1. `from` and `to` are `YYYY-MM-DD` days and **both are inclusive**: `to: '2026-01-31'` includes
   orders dated 2026-01-31. Either may be left out (no bound on that side).
2. A `from` or `to` that is not a real `YYYY-MM-DD` day throws a `RangeError` with the message
   `bad-date`.
3. When `from` is after `to` the result is empty (`rows: []`, `total: 0`, `sum: 0`, `pages: 0`).
4. Without `status`, every order except `cancelled` ones is included.
5. `status` may be one status or an array of statuses; then exactly those statuses are included
   (so `status: 'cancelled'` lists only cancelled orders). An unknown status, or an empty array,
   throws a `RangeError` with the message `bad-status`.
6. `customerId` keeps only that customer's orders.
7. `region` keeps only orders whose customer has exactly that region. Orders of customers with no
   region (null), and orders whose customer no longer exists, never match a region.
8. `search` is trimmed; when something is left, an order matches if its `note` **or** its
   customer's `name` contains the text, ignoring case. Orders without a note can still match by
   the customer's name. An empty or blank `search` filters nothing.
9. `minTotal` (cents) keeps orders with `total >= minTotal`.
10. All filters given are combined: an order must pass every one of them.

### Order

11. `sort: 'date'` (the default): newest date first; orders on the same date by **higher id
    first**.
12. `sort: 'total'`: largest total first; equal totals by newer date first, then higher id first.
    Any other `sort` throws a `RangeError` with the message `bad-sort`.

### Pages

13. `page` counts from **1** (the first page is `page: 1`, the default). `perPage` defaults to
    10; a `perPage` above 50 is treated as 50. A `page` or `perPage` that is not a positive
    integer throws a `RangeError` with the message `bad-page`.
14. A page after the last one has `rows: []`, while `total`, `sum` and `pages` are still those
    of the whole result. The result's `page` and `perPage` are the values used (after the 50
    limit).
15. `total` is the number of matching orders on all pages, `sum` the sum of their totals (all
    pages, in cents) and `pages` is `Math.ceil(total / perPage)` (0 when nothing matches).

### Rows

16. Each row is a plain object with exactly these keys:
    `{ id, date, customer, region, total, status }`. `customer` is the customer's name and
    `region` the customer's region (`null` when the customer has none). `total` is in cents.
17. When the customer of an order no longer exists, `customer` is `'(unknown)'` and `region` is
    `null`; the order is still listed (unless a `region` filter is given, see rule 7).

## `customerSummary(db, options)`

Revenue per customer: `customerSummary(db, { from, to })` with the same optional, inclusive and
validated `from`/`to` as above (rules 1 to 3).

18. Only orders that are not `cancelled` and fall in the range count.
19. One entry per existing customer that has at least one counting order:
    `{ customerId, name, orders, revenue }` where `orders` is how many counting orders the customer
    has and `revenue` the sum of their totals (cents). Customers without counting orders, and orders
    of customers that no longer exist, are left out.
20. Entries are sorted by revenue, highest first; equal revenue by name A to Z ignoring case
    (compare the lower-cased names); equal names by `customerId` ascending.
