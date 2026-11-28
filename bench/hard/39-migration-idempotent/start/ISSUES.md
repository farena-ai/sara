# Open issues

## #7 Some totals lose a cent

A v1 order with `"total": "0.29"` comes out of v1 -> v2 with `"total_cents": 28`. `"4.35"` gives 434. Most
amounts are fine. Item prices have the same problem.

## #9 Duplicate customers are not set aside

Our export had two customers with id `c2`. After v1 -> v2 there is one `c2`, with the second record's name
and email, and nothing in quarantine. MIGRATIONS.md says the first one stays and the later one goes to
quarantine with `duplicate id`.

## #11 A killed run leaves a broken store

The nightly job was killed during the migration. Running it again failed: the customers were already
converted but store.json still said schema 1. RESUME.md describes what must happen instead.
