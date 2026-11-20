# P2 stocks: stock trackers and graphs on Today

Owner request (2026-11-20): "if you are watching stocks, bring those graphs to the front screen and
allow stock trackers on the front page."

## What existed (extended, not duplicated)
- E1 live data (`src/data-sources.ts`): free quotes (V0.10 Nasdaq first, Yahoo Finance behind it),
  60 s cache, guarded `netFetch`, quota pauses, private-local errors.
- E1 "tell me when" watches (`src/live-watch.ts`): price above/below/moves %, checked on the
  reminder tick, alerts posted where the person chose (ALERTDEST, "Stock alerts" feed/project).
- Today's "Watching" tile (labels + last value) and the tile layout system (TILES in
  `web/today.js` + `src/today-layout.ts`, Customize sheet, ⋯ Hide with Undo, phone groups).
- No price charts anywhere; no symbol search.

## What P2 adds
- **One list.** A tracker is a live watch of kind `price` with `when: 'track'`: never checked in the
  background, never fires, not counted against the 20/40 alert limits, renewed instead of expiring,
  left out of Watching and of Where alerts go. The Stocks tile lists every symbol that has a
  tracker OR an alert; its alerts' levels show on its chart. Removing a symbol removes its alerts
  too (the button says so). Chat can add one too (`watch_add` with `when: track`).
- **Stocks tile** (`td-stocks`, Your day, opt-in, M/L): symbol, name, price, day change with an
  arrow and a sign (not color only, with an aria label), a sparkline (1D/1W/1M/1Y toggle kept per
  device), "as of" time with a W0.6 age, market open/closed and the source. `+` opens search
  (company or ticker, Yahoo Finance search, free, no key; already-tracked rows are marked), Enter
  adds the typed ticker; Edit list moves rows up/down and removes them.
- **Bigger chart** (`#stock-chart` dialog): the range toggle, previous close (1D), alert lines with
  labels, the alerts with remove, and "Alert me when the price is above/below …" (the same watch).
- **Shown once**: someone who already watches a stock gets the tile turned on once (with a note:
  Keep it / Hide); after that it is the normal layout pref (⋯ Hide, Customize).
- **Polite refresh** (`src/stock-trackers.ts`): quotes reused 1 min while the US market is open
  (9:30-16:00 New York, weekdays), 15 min when closed; charts cached 5 min (1D) to 12 h (1Y);
  after a failure the server waits 1, 2, 5, 15, 30 min and keeps the last prices marked "Showing
  the last prices"; the page asks again only while Today is open and visible.
- **Private local mode**: nothing is fetched; the tile says prices can't be fetched (with the age of
  what it has); trackers can still be added.
- **Who**: per space (each household member has their own list and alerts); never on a child's
  account (`stocksOf` is undefined, routes 403); the demo has no live data.

## Pieces
- `src/stock-trackers.ts` engine (`stocksOf(app)`, view/add/remove/order/chart/search/todayPart,
  `<dataDir>/stock-trackers.json` = order + shown-once flag only).
- `src/data-sources.ts`: `chart()`, `searchSymbols()`, `parseYahooChart`, `parseYahooSearch`.
- Routes under the existing family: `/api/data-sources/stocks[/order|/chart|/search|/alert|/intro|/:symbol]`.
- Today part `stocks` (symbols only, no network); web `web/stocks.js` + pure `web/stock-chart.js`
  (SVG paths, no imports); styles in `web/today.css` (theme variables only).
- Tests: `test/p2-stocks.test.ts` (fake price source).

## Not done
- US market holidays are not known (a holiday polls like a closed-market evening after the first
  answer: the cache keeps it to one request a minute at most).
- Non-US exchanges use US hours for the refresh pace.
