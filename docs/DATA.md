# Live data, "tell me when" and your tables (E1)

Sara can read live prices, scores, standings and betting lines from free sources, watch them for
you, and add up your own spreadsheets exactly. Everything here is information and math: she never
trades, never places bets and never calls a bet a sure thing.

## Data sources (Settings → Connections → Apps and services → Data sources)

| Kind | Default (no key) | Other free choices |
|---|---|---|
| Stock prices | Nasdaq (no key; the exchange's own prices for US stocks and ETFs), with Yahoo Finance behind it for indexes, other markets and anything Nasdaq can't answer | Yahoo Finance only (no key, can be 15 minutes late), Stooq (no key), Finnhub (free key, 60 a minute), Alpha Vantage (free key, 25 a day) |
| Sports | ESPN: scores, schedules, standings | TheSportsDB (free test key built in; per team) |
| Odds | none | The Odds API (free key: 500 credits a month, one per market) |

- Pick a source per kind, paste a free key where one is needed and press **Test** (one small real
  request). The quota line shows what is left (The Odds API's own count; Alpha Vantage's daily
  count; a "busy, try later" answer pauses the source until it says).
- Keys go to the server's encrypted vault as `data:<provider>`; they are never shown again, never
  written to logs and never sent to a model. Each household member has their own sources, keys and
  watches.
- Every answer names the source and the time of the data ("359.08 at 10:49 AM from Yahoo
  Finance"). A source that doesn't answer, needs a key or is out of free requests is said plainly.
- Answers are cached: prices 60 seconds, live scores 30 seconds, other sports 10 minutes, odds 5
  minutes.
- Since V0.10 (2026-11-18) the default asks Nasdaq first: its public quote answer (the one nasdaq.com's own
  watchlist uses; no key, no sign-up, several symbols in one request, stocks then ETFs) is the exchange's
  own data rather than Yahoo's unofficial one. It is not a documented developer API either, so Yahoo
  Finance stays right behind it: symbols Nasdaq doesn't know (`^`/`=` symbols, other markets) and any
  Nasdaq failure go to Yahoo in one batch, and each answer names the source it really came from.
  Finnhub and Alpha Vantage are the documented free APIs (free key).
- Stooq's free quote address answered "not found" on 2026-11-13, so Yahoo Finance was the default until V0.10;
  Stooq stays as a choice in case it comes back. TheSportsDB retired its old free key "3"; Sara uses
  the current test key "123".

## What she can do with it

- **Prices:** "What's AAPL at?", "How are MSFT and NVDA doing today?" (`market_quote`).
- **Sports:** "Lakers score?", "When do the Chiefs play next?", "NBA standings"
  (`sports_scores`, `sports_schedule`, `sports_standings`). Leagues: NFL, NBA, WNBA, MLB, NHL,
  college football and basketball, MLS, Premier League, La Liga, Bundesliga, Serie A, Ligue 1,
  Champions League.
- **Odds:** moneyline, spreads and totals per book, each with its implied probability, the no-vig
  (fair) probability and the book's margin (`odds_lines`).
- **Tables:** "What did I spend on food in March?" on a CSV or Excel file in your Library or shared
  in the chat (`analyze_table`). A built-in query engine (filters by text, number or date range,
  group by, sum, average, count, min, max, sort, top N) computes the numbers; no code runs, so it
  works without the sandbox. A result grouped by a column (two or more groups, values of zero or
  more) also shows as a bar chart in the chat (the first 20 groups); for a file, ask her to make a
  spreadsheet of the result.

## Tell me when

Say "tell me when AAPL goes above 400", "alert me when the Lakers game starts" or "let me know if
the Chiefs spread moves by a point" (`watch_add`, `watch_list`, `watch_remove`).

- Kinds: a price above or below a number, or moving a % in a day; a team's game starting, ending or
  the score changing; an odds line moving by an amount or crossing a number; a new email from someone
  or with certain words in your connected mail (checked every 10 minutes; the alert shows the sender
  and subject only). Bills are Planner reminders instead ([MONEY.md](MONEY.md)).
- Checked on the reminder clock (no new timer): prices about every minute, games every minute while
  one is on and every 10 minutes otherwise, odds every 2 hours. Watches share one budget: every
  watched symbol goes in one price request, one scoreboard per league, one odds request per sport
  and market, and the last 25 Odds API credits are kept for your own questions.
- A watch fires once per crossing: it tells you again only after the value went back past the
  line by a small margin (0.5 % for prices). A price that is already past the line when you add
  the watch is reported on the first check.
- Each alert is a card in the chat and, unless you chose "chat", a notification (none in quiet
  hours; the card still arrives). Watches run 30 days unless you give an end date (at most 90).
- If a free allowance runs out, the watches on it pause with one note and start again when it
  resets.
- Your watches are on Today (**Watching**) and in Settings → Data sources, where you can remove them.
- Private chats and "Nothing leaves this computer" mode turn the live-data tools off.

See also: [Watches on files and logs](WATCHES.md), [Library](LIBRARY.md), [Money](MONEY.md).
See also: [Sports, odds and your bet log](SPORTS.md), [Watches on files and logs](WATCHES.md), [Library](LIBRARY.md).
