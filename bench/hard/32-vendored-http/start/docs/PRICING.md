# The pricing service

Another team's service. In production it is reached over the network; here it is any relay router
passed to `createApp({ pricing })` (tests pass a fake one, `bin/stockroom.js` uses
`src/demo-pricing.js`).

## `GET /prices/<sku>?qty=<n>`

- **200** `{ sku, qty, unit, total }`: unit price and the total for `qty`, in cents.
- **404** `{ error: 'unknown-sku' }` when it has no price for the sku.

It is known to be slow at times (several seconds) and to answer 502, 503 or 504 under load; those
usually pass on a second or third try. A 500 means a real error on their side and is not worth
retrying.
