# Renewals and paperwork (V2.1)

Settings → You → What Sara knows → **Renewals and paperwork**: one list of what needs renewing, soonest
first: passport, driver's license, registration, insurance, warranties, subscriptions and a lease.

## Where the dates come from

Nothing new is collected; the list reads what Sara already knows:

| Source | How it gets there |
| --- | --- |
| Library documents | The rules in `src/facts.ts` read renewal, expiry and "valid until" dates (and `EXP 03/14/2029` on cards) from every kept document. Bills' due dates stay in *From your documents* and are not renewals. |
| A photo of a card | **Add by photo of the card** puts the photo in your Library. A model that can see pictures reads it like any scanned page, and the date shows up here. |
| Renewal mail | The inbox helper reads new mail by the same rules: a policy renewing, a registration or license expiring, a warranty ending. Shop offers ("this offer expires…") are left out. |
| The Money page | Subscription renewals it caught in mail, and yearly charges (owner's household money only). Mail the Money page took is not read a second time. |
| You | Type a row in: what, name, date. Or tell Sara in a chat ("my passport expires March 31, 2027, keep track of it"): `renewal_add` adds the same row and its reminder. |

The same date for the same kind of thing shows **once**. A document beats the mail about it, and the row
says it was also in your mail.

## Each row

- **Remind me N days before** adds a planner reminder at 9:00 your time, the usual number of days before
  (`DAYS_BEFORE` in `src/facts.ts`: 30 for renewals, expiry, passports, licenses, warranties and leases).
  A document row also accepts its *From your documents* card, so Today doesn't ask again.
- **Fill the form** asks Sara in a chat to fill the renewal form with My details: your form in the Library
  (`fill_document`, verified copy), or the official page (`pc_fill_form`). She stops before Submit.
- **Start a renewal errand** plans an errand with the `renew` template (find the official way, fill the
  form, then Submit or pay only with your OK). It waits on the Errands page until you press Start, with
  the date as its deadline.
- **Hide** (or **Delete** for a row you typed) removes it from the list. It stays hidden when the
  document or mail is read again.

## Privacy

Long numbers keep only their last 4 digits, as everywhere in What Sara knows. Card and Social Security
numbers are refused in names. Each household member has their own list in their own space; the Money
page's subscriptions are the owner's.

## API

`GET /api/facts/renewals` → `{renewals, daysBefore, whats}` · `POST /api/facts/renewals {what, title, date}` ·
`POST /api/facts/renewals/:id/remind|hide|remove|errand`. Code: `src/renewals.ts`, `web/renewals.js`.
