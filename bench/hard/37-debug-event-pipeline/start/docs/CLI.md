# The relay command

```
relay <command> [options]
```

Options take their value as `--name value` or `--name=value`. `--log FILE` (any command) appends the run
log to FILE: one line per thing that happened, `t=<clock ms> <component>: <message>`. Exit codes: 0 done,
1 unexpected error, 2 usage error, 3 bad settings or an unreadable journal.

## relay run EVENTS [options]

Feeds an events file (one JSON event `{ "id", "key", "data" }` per line; blank lines and `#` lines skipped)
through a pipeline on a fake clock.

| option | |
|---|---|
| `--journal DIR` | keep a journal there; without it nothing is kept |
| `--sink ledger\|memory` | default `ledger` |
| `--lock ACCOUNT:UNTIL` | lock a ledger account until clock time UNTIL (may repeat) |
| `--batch N`, `--max-attempts N`, `--segment-size N`, `--tick MS` | settings (CONFIG.md) |
| `--rate N` | submit N new events per tick (default: all of them before the first tick) |
| `--start MS` | the clock's start time (default 0) |
| `--stop-after TICKS` | stop after that many ticks, as if the process had been killed |
| `--json` | print one JSON object instead of text |

The loop is: submit up to `--rate` events, `tick()`, move the clock by `tickMs`; until every event was
submitted and nothing is pending (or `--stop-after`).

**Resuming.** With a journal that already has records, the clock starts at the time of the newest record
plus `tickMs` (or `--start`, if later), and events whose id is already in the journal are not submitted
again (`skipped N events already in the journal`). So after a killed run, the same command carries on.

Text output: the counters line (`submitted …, duplicates …, delivered …, retried …, dead …, pending …`),
the skipped line if any, the ledger totals (`  <account padded to 12> <amount padded to 12>`), and a
`dead: <id> after <n> attempts (<reason>)` line per dead letter. Note that the ledger totals are those of
this run's sink only; `relay totals` gives the journal's.

## relay journal ls --journal DIR

One line per segment, oldest first: `<name padded to 18> <records padded to 5> records`. With `--json`: an
array of `{ name, records, torn }`.

## relay journal pending --journal DIR

The pending events in seq order: `<seq padded to 6>  <id>  <key>  attempts=<n>  due=<ms>`. With `--json`: an
array of `{ seq, id, key, attempts, dueAt }`.

## relay totals --journal DIR

The sum of the amounts of the delivered events, per account, from the journal alone (each delivered
event counted once), in the same format as `relay run`'s totals. With `--json`: `{ account: "12.50" }`.
