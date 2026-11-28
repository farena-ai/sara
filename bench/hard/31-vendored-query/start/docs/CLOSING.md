# Month-end closing

`closeMonth(db, month)` in `src/closing.js` closes one month's orders and records the closing in
the `closings` table. It never throws for the cases below; it returns a result object.

1. `month` is a `YYYY-MM` string with a month from `01` to `12`. Anything else returns
   `{ ok: false, error: 'bad-month' }` and changes nothing.
2. Every order dated in that month (from the 1st to the last day of the month, inclusive) whose
   status is `open` or `paid` gets the status `closed`. Orders with other statuses (`closed`,
   `cancelled`) and orders of other months are not touched.
3. A row is added to `closings`: `{ month, orders, revenue }` where `orders` is the number of
   orders whose status was changed and `revenue` the sum of their totals in cents.
4. The status changes and the new `closings` row are written in **one** transaction, which is
   committed explicitly: either all of them are stored or none of them.
5. A month that already has a `closings` row returns `{ ok: false, error: 'already-closed' }`
   and changes nothing.
6. On success it returns `{ ok: true, month, closed, revenue }`, with `closed` and `revenue` the
   same numbers as in the new `closings` row.
7. A month with no orders to close can still be closed: it returns `closed: 0, revenue: 0`, its
   `closings` row is stored, and closing it again gives `already-closed`.
8. Closed orders are ordinary orders for the reports: without a `status` filter they are
   included in `salesReport` and count in `customerSummary`.
