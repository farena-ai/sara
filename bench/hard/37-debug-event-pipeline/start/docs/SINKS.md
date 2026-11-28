# Sinks

A sink is any object with a synchronous `deliver(events, ctx)` method.

- `events`: the batch, in seq order. Each event is `{ id, key, seq, attempt, data }`, where `attempt` is
  1 for the first try, 2 for the second, …
- `ctx`: `{ batchId, now }`.

It answers in one of three ways:

| answer | meaning |
|---|---|
| returns nothing (`undefined`) | every event of the batch is delivered |
| returns `{ rejected: [ids], reason? }` | the listed events failed (any order, any subset of the batch); the others are delivered |
| throws | every event of the batch failed; the error message is the reason |

Returning an id that is not in the batch, or anything else, is an error in the sink (relay throws
`SinkResultError`). A sink must not return a promise.

## MemorySink

Remembers every call (`sink.calls`: `{ batchId, now, ids }`) and every delivered event (`sink.accepted`,
with `batchId` and `at`). `new MemorySink({ reject, fail })`: `reject(event, ctx)` returns a reason to
reject one event (or a falsy value), `fail(events, ctx)` returns a message to make the whole call throw.
`sink.count(id)` says how many times an event was delivered.

## LedgerSink

Books `data.amount` (a string like `"12.50"`, up to two decimals, may be negative) on `data.account`
(the event's key when there is no account). `new LedgerSink({ locks: [{ account, until }] })`: while
`now < until` the account is locked and its events are rejected with the reason `account locked`. An
amount that cannot be read is rejected every time (`invalid amount`), so the event is dead-lettered after
`maxAttempts`. `sink.report()` gives `{ account: "123.45" }` sorted by account; `sink.booked` lists the
booked ids in order.

The ledger books an event each time it is delivered, so its totals are right exactly when every event is
delivered once (GUARANTEES.md §6).
