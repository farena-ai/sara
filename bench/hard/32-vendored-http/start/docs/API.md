# Stockroom API

The API is a relay router (`createApp()` in `src/app.js`). Requests are dispatched in process:
`app.dispatch({ method, path, headers, body })`. All bodies are JSON.

## General

1. Every response carries an `x-request-id` header `req-<n>`, where `n` counts the requests an
   app has handled, starting at 1. This includes errors, 401s and unknown routes.
2. Errors are JSON objects `{ error: <code> }`, sometimes with more fields named below.
3. Write requests (`POST`, `PUT`, `PATCH`, `DELETE`) need an `X-Api-Key` header holding one of the
   app's keys. Header names are not case-sensitive (`x-api-key` works too). A write without a valid
   key gets **401** `{ error: 'unauthorized' }`, even when the path does not exist. Reads (`GET`)
   need no key.
4. A path no route matches gets **404** `{ error: 'no-route' }`; a known path with a method it
   does not support gets **405** `{ error: 'method-not-allowed' }` with an `allow` header (for a
   write method, only once the key is valid, see rule 3).

## Items

An item is `{ id, sku, name, tags, stock, reserved }`: `stock` is how many are on the shelf,
`reserved` how many of those are promised to reservations.

5. `GET /items` returns **200** `{ items, count }`: the items sorted by id, and how many were
   returned.
6. `tag` filters by tag and may be given several times (`?tag=metal&tag=wood`): an item is listed
   when it has **at least one** of the given tags.
7. `q` keeps items whose name contains the text, ignoring case. The parameters `q`, `limit` and
   `qty` take one value: when one is given more than once, the **first** value is used.
8. `limit` (default 20) caps how many items are returned, after filtering. It must be a whole
   number from 1 to 100; anything else (including an empty value) gets **400**
   `{ error: 'bad-limit' }`.
9. `GET /items/<id>` returns **200** with the item, or **404** `{ error: 'not-found' }` when there
   is no item with that id. An id that is not a whole number is also a 404.
10. `POST /items` creates an item from a JSON body `{ sku, name, tags?, stock }`.
    An empty body or one that is not valid JSON gets **400** `{ error: 'invalid-json' }`.
    Otherwise the fields are checked in this order and the first bad one gets **422**
    `{ error: 'invalid', field }`: a body that is not a JSON object (`field: 'body'`); `sku`, a
    non-empty string of `A`-`Z`, `0`-`9` and `-`; `name`, a non-blank string; `tags`, an array of
    strings (optional, default `[]`); `stock`, a whole number >= 0.
11. A `sku` that another item already has gets **409** `{ error: 'duplicate-sku' }`.
12. A created item gets the next id (one more than the largest id so far), `reserved: 0`, and the
    response is **201** with the item and a `location: /items/<id>` header.
13. `DELETE /items/<id>` removes the item and answers **204** with no body. Unknown ids get
    **404** `{ error: 'not-found' }`. An item with `reserved > 0` cannot be removed: **409**
    `{ error: 'has-reservations' }`.

## Pricing

Prices come from the pricing service (see [PRICING.md](PRICING.md)), passed to `createApp` as
`pricing`, together with the `clock` to use for waiting.

14. Each call to the pricing service waits at most **2 seconds** for an answer. When it gets no
    answer in time, or gets status 502, 503 or 504, it tries again, up to **2 more times** (3
    attempts in all), waiting **0.5 seconds** before each new attempt. Other statuses are not
    retried.
15. `GET /items/<id>/quote?qty=<n>` asks the pricing service for `GET /prices/<sku>?qty=<n>` and
    answers **200** `{ id, sku, qty, unit, total }` (unit price and total in cents, from the
    pricing service). `qty` defaults to 1 and must be a whole number from 1 to 1000, otherwise
    **400** `{ error: 'bad-qty' }`. An unknown item is a **404** `{ error: 'not-found' }` (checked
    before `qty`).
16. When the pricing service answers 404, the quote is **404** `{ error: 'no-price' }`. When it
    gives no usable answer (no answer in time on every attempt, or a status other than 200 and 404
    after the attempts of rule 14), the quote is **503** `{ error: 'pricing-unavailable' }`.

## Reservations

17. `POST /items/<id>/reserve` (a write: rule 3 applies) reserves stock. The checks are made in
    this order: an `Idempotency-Key` replay (rule 21); the item must exist (**404**
    `{ error: 'not-found' }`); the body must be JSON (**400** `{ error: 'invalid-json' }`, also for
    an empty body); the body must be an object whose `qty` is a whole number >= 1 (**422**
    `{ error: 'invalid', field: 'qty' }`); `qty` must not be more than the item's available
    stock, `stock - reserved` (**409** `{ error: 'insufficient-stock', available }`).
18. A reservation adds `qty` to the item's `reserved` count and gets the next reservation number
    (1, 2, 3, ... per app). The price of the `qty` is asked from the pricing service with the rules
    of rule 14.
19. The answer is **201** `{ reservation, itemId, qty, total, available }`: `total` is the
    pricing service's `total`, or `null` when no price could be had; `available` is the item's
    `stock - reserved` after the reservation. Headers: `location: /reservations/<number>`, and
    `x-price-status`: `ok` when priced, `missing` when the pricing service answered 404,
    `unavailable` otherwise. The reservation is made even when there is no price.
20. `GET /reservations/<number>` returns **200** `{ reservation, itemId, qty, total }`, or **404**
    `{ error: 'not-found' }`.
21. A reservation request may carry an `Idempotency-Key` header. When a request comes with a key
    that an earlier **successful** reservation of this app used, the answer is **200** with
    exactly the body of that first answer and the header `x-idempotent-replay: true`, whatever
    the item or the body of the new request; nothing is reserved and the pricing service is not
    called. Requests that failed do not use up their key.
