# Changelog

## 4.1.0

- `router.routes()`.
- `clock.pending()`.

## 4.0.0 (breaking)

- All durations are seconds (they were milliseconds in 3.x): `timeout`, `retry.delay`, clocks.
- `retry.attempts` replaces `retries` and counts the first attempt.
- Statuses are only retried when listed in `retry.statuses`.
- Unknown client options throw instead of being ignored.

## 3.0.0 (breaking)

- `req.headers` is the raw list of pairs; use `req.header(name)`.
- `req.json()` returns `{ ok, value, error }` instead of throwing.
- Query values are always arrays.
