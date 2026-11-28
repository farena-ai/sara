# Changelog

## 2.3.1

- `group()` results are frozen like every other result.

## 2.3.0

- `whereAny()` for OR groups.
- `query.select()`.

## 2.0.0 (breaking)

- Queries are immutable: every builder method returns a new query.
- `orderBy()` takes one spec or an array and replaces the previous ordering (it used to append).
- `page(index, size)` replaces `limit()`/`offset()`. Page indexes count from 0.
- `run()` returns `{ rows, matched, index, size }` instead of an array.
- `commit()` returns `[error, counts]` instead of throwing.
- Operators renamed: `lte` -> `le`, `gte` -> `ge`, `like` removed (use `has` / `ihas`).
