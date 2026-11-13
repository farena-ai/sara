# Everyday assistant track (owner request, 2026-11-12)

Goal: make Sara useful every day for business and personal work, beyond the companion side. Owner: "I want
it all built." Order below is the build order; each part ships as its own release when green.

Standing rules for the whole track:
- Free data sources and free-tier keys only; anything paid needs the owner's yes first.
- Information and math, never advice dressed as certainty; she never trades, never places bets, never buys
  without the person's approval on the checkout itself (payments stay "always ask").
- Every source is named in the answer with its time ("price at 2:41 PM from …"); stale or missing data is
  said plainly, never guessed.
- Reuse what exists (reminders tick, routines, briefing, research, browser, computer use, library,
  documents, people, budget, receipts); no new schedulers or engines.

## E1 Foundation: live data and "tell me when"
- Data sources setting: one place for providers and keys (stocks, sports, odds, shopping, places).
- Watches: price crosses, game start/final, odds move, bill due, email from someone, price drop on a
  product; checked on the existing reminder tick; alerts to phone, desktop and chat.
- Tables: analyze the person's CSV/xlsx (totals, groups, comparisons, charts) through the sandbox.

## E2 Find it near me (product finder)
- "Find X" searches stores near the person (their place from the briefing settings or asked) and online
  retailers: in stock, price, distance, pickup/delivery, link; a ranked short list with sources.
- Nearby stores from OpenStreetMap; store availability from the retailers' own product pages through her
  browser; when a site blocks her browser, she offers to check it in the person's own browser (computer
  use) or names the site to check. Amazon and other online retailers by search and product pages.
- Watch the price or stock ("tell me when it's back / under $X").
- Built on hermes/e2find (user guide [SHOPPING.md](../SHOPPING.md)): product watches are their own
  small module (`src/shopping/watch.ts`, table `product_watches`) on the reminder tick, ready to fold
  into E1's watches as one more watch kind.

## E3 Money
- Portfolio from a brokerage export; daily move in the briefing; price alerts; news and earnings dates.
- Budget from bank exports: categories, subscription finder, bills due.
- Built on hermes/e3money (user guide [MONEY.md](../MONEY.md)): holdings, transactions and bills in the
  person's store (`money_*`), prices through E1's quotes, bills as Planner reminders, mail watches as
  E1 watch kind `mail`. News and earnings dates are left for later.

## E4 Sports and odds
- Follow teams: schedules into the calendar, live score alerts, standings, injuries.
- Odds compared across books, line-movement alerts, bet log (bankroll, ROI), implied probability and
  value calculator, optional self-set loss limits. Tracking only.
- Built on hermes/e4sports (user guide [SPORTS.md](../SPORTS.md)): follows make E1 game/odds watches
  (new `close_late` game kind; follow watches renew); bet log, limits and odds snapshots in
  `src/sports/`.

## E5 Decisions
- Decision helper: options and criteria, weighted result, pre-mortem; saved and revisited later.
- Product/price comparisons (uses E2).

## E6 Business and documents
- Invoices and quotes from the person's own template, paid/unpaid tracking and reminders.
- Follow-ups ("who do I owe a reply"), contract reading (dates, money, unusual clauses), receipts to an
  expense report, meeting notes to action items with owners.

## E7 Usable by real people
- Setup that picks a working model; Mac app parity; starter cards on Today for each area; Hank as beta.
- Signed Windows installer: paid certificate, owner decision.
