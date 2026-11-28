# relay 4.1 API reference

```js
import { createRouter, send, createClient, createClock, systemClock, RelayError } from './vendor/relay/index.js';
```

Errors are `RelayError` objects with a string `code` (see the end of this page).

## Router

### `createRouter()` -> Router

### `router.add(method, pattern, handler)` -> the router

Adds a route. `method` is an HTTP method name (any case, stored upper-case). Adding the same method
and pattern twice throws `bad-route`.

**Patterns** start with `/` and are split into segments at `/`. A segment is either literal text or
a placeholder that takes the **whole** segment:

| segment | matches | `req.params` value |
|---|---|---|
| `items` | exactly `items` (case-sensitive) | - |
| `{id}` | any non-empty segment | the segment, percent-decoded, as a **string** |
| `{id:int}` | a segment of digits only (`0`-`9`) | a **number** |

There is no `:id` syntax: a segment written `:id` is literal text and only matches a path segment
that is literally `:id`. A segment like `item-{id}` is not allowed (`bad-pattern`).

A trailing slash makes no difference: `/items/` is the same path as `/items`. The query string is
not part of the match.

When several routes match a path, the most specific wins: segments are compared left to right,
and a literal segment beats `{name:int}`, which beats `{name}`. Equal patterns are tried in the order
they were added. Only routes for the request's method are considered; if routes match the path but
none has the method, the response is **405** with body `{ error: 'method-not-allowed' }` and an
`allow` header listing the methods (sorted, joined with `, `). If no route matches the path, the
response is **404** with body `{ error: 'no-route' }`.

**Handlers** take one argument, the request, and return a `Response` (or a promise of one) made with
`send()`:

```js
router.add('GET', '/items/{id:int}', (req) => {
  const item = items.get(req.params.id);
  return item ? send(200, item) : send(404, { error: 'not-found' });
});
```

A handler that returns anything else (for example `undefined`, or a plain object) produces a **500**
with body `{ error: 'no-response', message }`. A handler that throws produces a **500** with body
`{ error: 'internal', message }`.

### `router.use(middleware)` -> the router

Adds a middleware. Middleware runs for **every** request, in the order it was added, including
requests that end in 404 or 405. Its signature is `(req, next)`:

- `next()` runs the rest of the chain (the next middleware, or the route) and returns a
  **promise** of its `Response`. Calling `next()` again returns the same promise; it does not run
  the chain twice.
- The middleware must **return** a `Response`: either the one from `next()` (possibly changed with
  `withHeaders`) or its own (for example a 401) without calling `next()`.
- Returning anything else (including `undefined`, for instance after calling `next()` without
  returning its result) produces a **500** `{ error: 'no-response' }`, like a handler.

```js
router.use(async (req, next) => {
  if (!req.header('x-token')) return send(401, { error: 'unauthorized' });
  const res = await next();
  return res.withHeaders({ 'x-checked': 'yes' });
});
```

Route matching happens before the middleware runs, so middleware can read `req.params` and
`req.route` (the matched pattern, or `null`).

### `router.dispatch(request)` -> Promise<Response>

Handles one request. `request` is a plain object:

| field | default | |
|---|---|---|
| `method` | `'GET'` | any case |
| `path` | `'/'` | may include a query string: `'/items?tag=a&tag=b'` |
| `headers` | none | an object `{ name: value }` or an array of `[name, value]` pairs |
| `body` | none | a string is sent as is; any other value is sent as JSON (and `content-type: application/json` is added when no content type was given) |

`dispatch` never rejects: errors in handlers become 500 responses.

### `router.routes()` -> string[]

`'METHOD /pattern'` for each route, in the order added.

## Request

What middleware and handlers receive. The request object itself is frozen; `req.state` is not.

| member | |
|---|---|
| `req.method` | upper-case method |
| `req.path` | the path without the query string |
| `req.params` | the placeholders of the matched route: strings for `{name}`, numbers for `{name:int}` (`{}` when no route matched) |
| `req.route` | the matched pattern, e.g. `'/items/{id:int}'`, or `null` |
| `req.query` | the query string as an object whose values are **always arrays of strings**: `?tag=a&tag=b&q=x&flag` gives `{ tag: ['a', 'b'], q: ['x'], flag: [''] }`. `+` and percent escapes are decoded. A missing parameter is `undefined`. |
| `req.headers` | the raw headers: a frozen array of `[name, value]` pairs, names as sent |
| `req.header(name)` | the value of a header, name matched **without regard to case**; repeated headers are joined with `', '`; `null` when absent |
| `req.text` | the raw body (`''` when there is none) |
| `req.json()` | parses the body as JSON and **never throws**: `{ ok: true, value }`, or `{ ok: false, error: 'empty' }` for an empty (or blank) body, or `{ ok: false, error: 'invalid' }` for a body that is not JSON |
| `req.state` | a plain object for this request only, for middleware to pass things to handlers |

## Response

### `send(status, body?, headers?)` -> Response

- `status`: an integer from 100 to 599, otherwise `bad-status` is thrown. Note the order: the
  status comes **first**.
- `body`: `undefined` for no body; a string is sent as text (`content-type: text/plain;
  charset=utf-8`); anything else is sent as JSON (`content-type: application/json`). A 204 or 304
  with a body throws `bad-body`.
- `headers`: an object of name -> string or number. Names are stored lower-case.

The body is copied when the response is made (it is serialized and parsed again), so changing the
object afterwards does not change the response.

### Response members

Responses are immutable.

| member | |
|---|---|
| `res.status` | the status code |
| `res.body` | the body as the receiver gets it: the parsed JSON value, the text, or `undefined` |
| `res.text` | the body as sent (`''` when none) |
| `res.headers` | a frozen object of lower-case name -> string |
| `res.header(name)` | one header (any case), or `null` |
| `res.ok` | `true` for 2xx statuses |
| `res.withHeaders(extra)` | a **new** response with the extra headers set (replacing ones of the same name) |

## Client

### `createClient(target, options?)` -> Client

`target` is anything with a `dispatch()` method, normally a router. Options:

| option | default | |
|---|---|---|
| `timeout` | `30` | **seconds** to wait for each attempt; `0` means no timeout |
| `retry` | `{ attempts: 1, delay: 0, statuses: [] }` | see below |
| `headers` | `{}` | headers sent with every request |
| `clock` | `systemClock` | the clock used for timeouts and delays (see Clocks) |

`retry` is an object with:

- `attempts`: the **total** number of attempts, counting the first one. `attempts: 1` (the default)
  means no retries; `attempts: 3` means the first try plus up to two retries.
- `delay`: **seconds** to wait before each retry (default `0`).
- `statuses`: the response statuses that count as failures to retry, e.g. `[502, 503, 504]`.
  The default is `[]`: **no status is retried** unless listed. A timeout or a failed attempt is
  always retried while attempts are left.

Unknown options (for example `retries`, `backoff` or `timeoutMs`) throw `bad-option`, and so do
values of the wrong kind.

### `client.request({ method, path, body, headers, timeout, retry })` -> Promise<[error, response]>

Sends a request, with retries as configured. `timeout` and `retry` here override the client's for
this call (`retry` fields not given keep the client's values). The promise resolves to a pair:

- `[null, response]` when a response came back. **Any status** is a response, including 4xx and
  5xx; when the retries for a listed status are used up, the last such response is returned.
- `[error, null]` when the last attempt got no response: `error.code` is `'timeout'` (no response
  within `timeout` seconds) or `'failed'` (the target threw).

It rejects only for bad options (`bad-option`). A response that comes after its attempt timed out
is ignored.

The response is the router's `Response` (see above): `res.status`, `res.body` (already parsed; there
is no `res.json()`), `res.header(name)`.

### Shortcuts

`client.get(path, options?)`, `client.delete(path, options?)`, `client.post(path, body, options?)`,
`client.put(path, body, options?)`, `client.patch(path, body, options?)`; `options` takes `headers`,
`timeout` and `retry`.

## Clocks

Clocks count **seconds**.

### `createClock({ start = 0 }?)` -> virtual clock

A clock for tests and simulations. Time stands still while code runs; when everything is waiting on
the clock, it jumps to the earliest timer. A 5-second wait takes no real time and runs the same way
every time. Timers due at the same time fire in the order they were set.

- `clock.now()` -> seconds since the start
- `clock.sleep(seconds)` -> a promise that resolves after that many (virtual) seconds
- `clock.timer(seconds)` -> `{ promise, cancel() }`
- `clock.pending()` -> the number of timers waiting

Pass the same clock to the clients and to any code that sleeps, so they share one timeline.

### `systemClock`

The same interface over real time.

## Error codes

| code | when |
|---|---|
| `bad-pattern` | `add()` got a pattern it cannot read |
| `bad-route` | `add()`/`use()` got a bad method or function, or a duplicate route |
| `bad-status` | `send()` got a bad status |
| `bad-body` | `send()` got a body that cannot be sent |
| `bad-headers` | headers of the wrong shape |
| `bad-option` | the client got an unknown option or a bad value |
| `timeout` | (client result) no response within the timeout |
| `failed` | (client result) the target threw |
