# Open issues (since 1.3.0)

## #31 Events booked twice after the nightly job was restarted

The nightly import (150 events, `--segment-size 16`) was killed by a deploy halfway and restarted with the
same command, as the docs say. Afterwards the summary said `submitted 150 … delivered 243`, and
`relay totals` shows far more than the ledger should have: a lot of events were delivered a second time.
It has never happened on our small test runs, only on the big nightly one. The full session (both runs and
the totals) is in `logs/2026-11-18-nightly-restart.log`; the input is `examples/nightly-2026-11-18.ndjson`.

## #34 Batches come out short while events are waiting

With `--batch 4` and 12 events waiting, the first batches only had 3 events, then 3 again, though there
were plenty of events of other accounts ready. On the nightly run it is much worse: batches of 1 while a
hundred events are pending, and the whole run crawls while one account is locked.
`logs/2026-11-20-batches.log` (input `examples/batches-2026-11-20.ndjson`), and the first run in
`logs/2026-11-18-nightly-restart.log`.

## #36 Totals drift on days with locked accounts

On 2026-11-21 acct-3 and acct-4 were locked until t=400. After the run the ledger's totals do not match
`relay totals` (acct-4 is off), and the counters say `delivered 30` for 30 events although the ledger did
not book all of them. Some event seems to vanish: nobody retries it and it is not in the dead letters.
`logs/2026-11-21-locks.log` (input `examples/locks-2026-11-21.ndjson`).
