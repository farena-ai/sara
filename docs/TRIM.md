# Subscription trimmer: Maybe cancel (V2.8)

**Where:** Money → Maybe cancel (the Money place, under Subscriptions). In chat: "which
subscriptions should I cancel?", "am I paying for two music apps?".

## What you get

- **A "Maybe cancel" list** of subscriptions worth a second look, most reasons first, each with
  why it is there:
  - **Unused**: the service's own email says so ("we miss you", "you haven't watched anything in
    60 days"), or you pressed *Not using it* on a Subscriptions row.
  - **Price went up**: a repeating charge in your bank export got more expensive, or a price-change
    email (from $15.49 to $17.99).
  - **Two of the same kind**: two or more video services, music apps, storage plans, news
    subscriptions, fitness apps or audiobook services.
  - **Free trial ending** in the next two weeks.
- **From what Money already reads**: repeating charges in your bank or card exports, and
  subscription email the inbox helper reads (trials, price changes, renewals, receipts). Each service
  shows once, whether it came from your bank export, your email or both.
- **Start a cancel errand** (one tap): opens Errands → "Cancel a subscription" for that service. It
  waits until you press Start; she then finds the cancel page, fills it and **stops before the
  final confirm**, which asks you again. Nothing is cancelled without your OK.
- **Keep it**: off the list until something new turns up about it (say the price goes up again).
  *Show them again* brings kept ones back. *How to cancel* links the service's own page.
- **Once a month** (on the 1st, from 9 AM): a short note with the list where Money alerts go.
  Turn it off with *Send me this list once a month*.

Tracking only: Sara never logs in to a service, cancels or pays anything on her own.

## Design (one page)

- **Existed and reused:** `src/money/hub.ts` (repeating charges `subscriptionsOf` with price
  changes and cancel links, subscription mail `money_mailsubs` with trials, price changes and
  renewals), `src/money/budget.ts` (`findSubscriptions`), `src/errands.ts` (the `cancel` template:
  find → fill and stop → final confirm with `needsOk`), `postAlert(app, 'money')` (where Money
  alerts go), the reminder tick, the inbox helper.
- **New:** `src/money/trim.ts`:
  - `observeTrimMail` (inbox helper, after Money's own reader): "we miss you / haven't used" mail
    (needs subscription words or a known service, so a friend's "we miss you" stays out) and
    subscription receipts (receipt/payment/charged + subscription words + an amount; offers stay
    out) → `money_trim_mail` in the person's money store.
  - `trimList`: one entry per service (`subKey`: "NETFLIX.COM" = "Netflix", "Disney+" = "disney
    plus"), reasons from bank rows, Money's mail rows and the new signals; service kinds by name
    (`serviceGroup`). Marks (`trim_marks` state): *Not using it*, *Keep it* (remembers the reasons
    it was kept with), the cancel errand's id. A finished cancel errand drops the row; a stopped one
    lets you start again.
  - `trimAction`: cancel (errand `by: 'page'`, so it is *planning* until Start; facts: merchant,
    the known cancel page, amount; a trial's end is the deadline), keep, unkeep, unused, used, prefs.
  - `trimTick` on the reminder tick: once a month, only when the list has something.
  - `trimLines` joins `budget_subscriptions` so chat answers with the same list.
- **Routes** (inside the existing Money group, no new family): `GET /api/money/trim`,
  `PUT /api/money/trim/prefs {monthly}`, `POST /api/money/trim/:key/(cancel|keep|unkeep|unused|used)`
  (`:key` may also be the name shown on the Subscriptions list).
- **Web:** `web/trim.js` (drawn from `web/money.js`); *Not using it* on Subscriptions rows.
- **Tests:** `test/v2-trim.test.ts` (fake subscription mails give the right list; bank rows; the
  errand waits for Start and its final confirm needs OK; monthly note once; routes).
