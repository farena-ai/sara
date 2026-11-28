# Stockroom

A small stock-keeping API: items, price quotes from a separate pricing service, and (soon)
reservations. It is built on **relay**, an in-process HTTP-style router and client vendored in
`vendor/relay/` (see its README.md and docs/API.md). relay is third-party code kept as released:
do not change anything under `vendor/`.

```sh
node bin/stockroom.js GET /items
node bin/stockroom.js GET /items/1/quote?qty=10
node --test
```

| Path | What |
|---|---|
| `src/app.js` | `createApp({ items, pricing, clock, keys })`: the router with its middleware and routes |
| `src/middleware/` | request ids and the API-key check |
| `src/routes/` | the routes, one file per area |
| `src/pricing.js` | the client for the pricing service |
| `src/store.js` | the in-memory item store |
| `src/validate.js`, `src/errors.js` | body checks and error responses |
| `src/demo-pricing.js` | a stand-in pricing service for the command line |
| `docs/API.md` | **the specification** of every endpoint (numbered rules) |
| `docs/PRICING.md` | the pricing service's contract |
| `ISSUES.md` | what is broken and what is wanted |

Tests create an app with a fake pricing router and a virtual relay clock
(`createClock()`), so slow answers and timeouts take no real time.
