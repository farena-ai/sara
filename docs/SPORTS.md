# Sports, odds and your bet log (E4)

Sara follows your teams, compares betting lines and keeps your own bet log with the math done in
code. It is tracking and math only: she never places bets, never picks a side for you, never calls
anything a lock and never links to a sportsbook. Every number names its source and time. Built on
the live data and watches in [DATA.md](DATA.md).

## Your teams

- **Follow:** "follow the Chiefs", "my team is the Royals" (`team_follow`). She finds the team in
  ESPN's list (NFL, NBA, WNBA, MLB, NHL, college football and men's basketball, MLS, Premier League,
  La Liga, Bundesliga, Serie A, Ligue 1, Champions League) and turns on alerts for its games: game
  starts and final score. Optional: a close game late on ("tell me if it's within 3 in the 4th":
  4th quarter, last period, 7th inning, the last 15 minutes of a soccer match) and a point-spread
  move ("tell me if the Chiefs line moves 1.5 points"; needs the free Odds API key). Up to 6 teams.
- The alerts are E1 watches (same cards, notifications, quiet hours and shared budget) and last as
  long as you follow the team. `team_unfollow` removes them; `teams_followed` lists teams, the next
  game, the last result and the alerts.
- **Calendar:** "put the Chiefs games on my calendar" (`schedule_to_calendar`, 30 days by default).
  They go into Sara's planner as a **Games** list; your Google or Outlook calendar only when you ask
  for it (she asks before writing there). Each game is keyed by ESPN's game id: syncing again never
  makes a second copy and moves a game whose time changed. Games without a time yet say "time TBD".
- **News and injuries:** `team_news` reads ESPN's team headlines and the league injury report.
  Standings come from `sports_standings` (E1).
- **Briefing and Today:** the morning briefing gets one line ("Chiefs play tonight 7:20 PM at Bills;
  Royals won 5-3 vs Twins (ESPN, as of 7:02 AM)."). Today shows **My teams** (next game, last result,
  a live score) once you follow a team.

## Odds

- `odds_compare` lists one game's line at each book with the best price marked, the fair (no-vig)
  probability averaged across books and each book's hold (its cut). It uses The Odds API's free key
  (500 credits a month; Settings → Data sources); without a key she says where to get one. Each
  comparison is saved so a logged bet can get its closing line.
- `odds_math` is the calculator: American, decimal and fractional conversions, implied probability,
  the no-vig split and hold of a two- or three-way market, expected value for your own probability,
  the Kelly fraction (full and quarter; math, not advice) and parlay odds and payout.

## Bet log

- `bet_add` logs a bet you placed: sport, game, market (moneyline, spread, total, prop, parlay),
  pick, odds in any format (or a parlay's legs), stake, book and notes. With the league she links the
  ESPN game, so it can be settled from the final score later (`bet_settle` with "from the score"; she
  offers, you decide). Props and parlays are settled by hand.
- `bet_list` and `bet_stats`: bankroll, total staked, profit, ROI, win rate, average odds and
  closing-line value (your price against the last saved price before the game), for a date range and
  by sport, market or book. Voids count for nothing; pushes return the stake.

## Your limits

- `bet_limits`: a bankroll, a weekly loss limit, the most per bet and cool-off days. When a bet
  would cross a limit she says so plainly when you log it and notes it on the bet; it is still
  logged. During a cool-off she doesn't look up lines (odds tools answer with your cool-off); scores,
  schedules, the log and the calculator still work. A cool-off can be made longer, not shorter.
- When a limit is crossed or you ask for help she gives the free, confidential US helpline:
  **1-800-GAMBLER** (call or text).

## Privacy

Each household member has their own teams, calendar keys, bets and limits. In private chats and with
"Nothing leaves this computer" the tools that reach outside (follow, calendar, news, odds) are off;
the log, stats, limits and calculator work locally.
