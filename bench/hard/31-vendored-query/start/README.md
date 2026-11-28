# Shopfloor back office

A small back office for a wholesale shop: customers, orders, reports and the month-end closing.
Data lives in an in-memory store built on **tabula**, a small table library vendored in
`vendor/tabula/` (its own README and `docs/API.md` describe it). tabula is third-party code kept
as it was released: do not change anything under `vendor/`.

```sh
node bin/shop.js sales --from 2026-01-01 --to 2026-01-31
node bin/shop.js customers
node bin/shop.js close 2026-01
node --test
```

## Layout

| Path | What |
|---|---|
| `src/db.js` | table definitions (`defineTables`) and `openShop(data)` |
| `src/dates.js` | day and month helpers (`isDay`, `isMonth`, `monthBounds`) |
| `src/money.js` | amounts are integer cents; formatting and parsing |
| `src/customers.js`, `src/orders.js` | look-ups used by the screens |
| `src/reports.js` | `salesReport` and `customerSummary` (spec: [docs/SALES.md](docs/SALES.md)) |
| `src/closing.js` | `closeMonth` (spec: [docs/CLOSING.md](docs/CLOSING.md)) |
| `src/format.js` | plain-text tables for the command line |
| `bin/shop.js` | the command-line entry point, over the demo data in `src/seed.js` |
| `docs/DATA.md` | the tables and their columns |

All functions take the store as their first argument, so tests can build a store with
`openShop({ customers, orders })` and pass it in.
