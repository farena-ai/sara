# relay

In-process HTTP-style routing and a client with timeouts and retries. There are no sockets: a
request is a plain object that a router handles in the same process, which makes services easy to
compose and to test. No dependencies.

```js
import { createRouter, createClient, createClock, send } from './vendor/relay/index.js';

const router = createRouter()
  .use(async (req, next) => {
    const res = await next();
    return res.withHeaders({ 'x-served-by': 'relay' });
  })
  .add('GET', '/hello/{name}', (req) => send(200, { hello: req.params.name }));

const client = createClient(router, { timeout: 2, retry: { attempts: 3, delay: 0.25, statuses: [503] } });
const [err, res] = await client.get('/hello/ada');
if (err) console.error(err.code);            // 'timeout' when no answer came in time
else console.log(res.status, res.body);      // 200 { hello: 'ada' }
```

## Things that differ from what you may be used to

- Handlers take **one** argument, the request, and **return** a response made with
  `send(status, body, headers)`. There is no `res` object to write to.
- Middleware is `(req, next)`; `next()` returns a promise of the downstream response, and the
  middleware must **return** a response (usually that one).
- Route placeholders are `{name}` (a string) or `{name:int}` (a number). `:name` is not a
  placeholder.
- `req.query` values are **always arrays** of strings.
- `req.headers` is the raw list of `[name, value]` pairs; use `req.header(name)` to look one up.
- `req.json()` does not throw: it returns `{ ok, value }` or `{ ok: false, error }`.
- Responses are immutable; `res.withHeaders()` makes a new one.
- All times are in **seconds**. `retry.attempts` counts the first try. Only the statuses listed
  in `retry.statuses` are retried.
- The client never rejects for a response: `[error, response]`, and a 500 is a response.

Reference: [docs/API.md](docs/API.md). Changes: [CHANGELOG.md](CHANGELOG.md).
