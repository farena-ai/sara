# Open issues

Reported since the move to relay 4 (vendored in `vendor/relay/`).

- **#41** `GET /items/3` says `not-found`, although item 3 is in `GET /items`. Quotes for any item
  say `not-found` too.
- **#42** Every write (create, delete) is refused with 401, even with a valid `X-Api-Key`.
- **#43** Creating an item fails with 422 `sku` for perfectly good items, and broken JSON gets a
  422 instead of the documented 400.
- **#44** `GET /items?tag=metal` returns no items at all.
- **#45** Deleting an item answers 500.
- **#46** When the pricing service is slow, a quote waits far longer than the 2 seconds in
  docs/API.md before giving up, and one 503 blip from pricing is enough to fail a quote.

## Wanted

- **#38** Reservations: `POST /items/<id>/reserve` and `GET /reservations/<number>`, as specified
  in docs/API.md (rules 17 to 21), plus the `has-reservations` rule for deletes (rule 13).
