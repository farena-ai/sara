# Money: portfolio, budget and bills (E3) and the Money place (U4.20)

Part of the everyday-assistant track ([design/EVERYDAY.md](design/EVERYDAY.md)). Sara reads your own
brokerage and bank exports and works out the numbers in code. It is information and math, not
financial advice: she never buys, sells, moves money or pays a bill, and every price says where it
came from and when. For the owner and every household member, each in their own space; not on the demo.

## What she can do

| Ask | Tool | What happens |
|---|---|---|
| "Here's my Fidelity export" / "I have AAPL 10 @ 150" | `portfolio_import` | Reads a positions CSV or Excel file (Fidelity, Schwab, Vanguard, Robinhood, E*TRADE and others: columns found by name, like Symbol/Ticker, Quantity/Shares, Cost Basis or Average Cost, Account) or a typed list. Cash and money-market lines count as cash. Importing an account again replaces that account's holdings. |
| "How are my stocks doing?" | `portfolio_show` | Value now from the stock-price source in [Data sources](DATA.md) (one batched request), today's change, gain against the cost basis and the share of each holding, with the source and time. A symbol with no price is left out and named. Then, for the 10 biggest holdings, the next earnings date and the latest 3 headlines from Yahoo Finance (free, no key; checked at most once an hour), with the time checked; what can't be read is named. |
| "Here's my bank statement" | `budget_import` | A bank or card export: CSV, Excel, OFX or QFX (download it from the bank's website; PDFs aren't read). Rows loaded before are skipped (same date, amount, description and account). Each gets a category: groceries, dining, fuel, utilities, subscriptions, shopping, travel, health, income, transfers or other. |
| "Costco is groceries" | `budget_category` | Moves that merchant's rows and remembers it for later imports. |
| "What did I spend in October?" | `budget_summary` | Totals by category against the month before, the biggest changes, top merchants and income; transfers and card payments are left out of spending. Says when the loaded data only partly covers the period. |
| "What subscriptions do I have?" | `budget_subscriptions` | The same merchant charging about the same amount every week, month or year: amount, next expected date and the yearly cost. |
| "Keep dining under $300 a month" | `budget_limit` | When a month's spending passes it, she tells you once that month (checked when transactions are loaded). |
| "Remind me about the electric bill on the 20th" | `bill_add`, `bill_list`, `bill_paid`, `bill_remove` | Monthly (a day of the month), yearly or one-time bills, optionally from a found subscription. An ordinary Planner reminder 3 days before (or as many as you say) at 9 AM. *Paid* moves it to the next due date. |
| "Tell me when Dana emails" | `watch_add` (kind `mail`) | Checks your connected mailboxes at most every 10 minutes for new mail from that sender or with those words, and tells you once per message: sender and subject only. |

- **Briefing:** with holdings and the morning briefing on, it adds a line like "Portfolio: $48,210,
  +0.8% today (Yahoo Finance, 9:31 AM)". If prices don't come, it gives the last value and its time.
- **Today:** a **Money** tile (portfolio value and today's move with its source and time, bills due
  this week, spent this month). It appears only once you load holdings or transactions, or add a bill.
- **Price alerts** stay E1's `watch_add` (kind `price`). Earnings dates and headlines come with
  `portfolio_show` only (no alerts for them).
- No new settings.

## Decisions and limits

- Money is never added up by the model; results carry the worked-out numbers in whole cents.
- Bills use Planner reminders, so there is no separate "bill" watch kind (no duplicate alerts).
- Mail watches use the follow-ups mail reader (E6), only for mailboxes you connected; household
  members and the demo have none. Private chats and "Nothing leaves this computer" turn `watch_add`
  and `portfolio_show` off (they use the network); budget and bill tools work on your saved data.
- Categories are the household kind (groceries, dining…), not the business expense categories of
  [E6](BUSINESS_TOOLS.md): they answer different questions.
- Holdings, transactions, rules, limits and bills live in the person's first companion's `store.db`
  (tables `money_*`).
- Tests: `test/e3-money.test.ts` (four brokerage and three bank layouts plus OFX/QFX on invented
  fixtures in `test/fixtures/e3/`, dedupe, categories and corrections, subscriptions, summary math,
  limits, bills and reminders, the mail watch with a fake reader, valuation with fake quotes, the
  briefing line, Today, household isolation, private chats, persona, the lean picker).

## The Money place (U4.20)

A sidebar place (`#view=money`, sidebar **Money**) on top of E3's store and math. **Tracking only**:
nothing here logs in to a bank, pays, transfers or cancels anything, and the page says so at the top.
No network: it all works in private local mode ("Nothing leaves this computer").

### One-page design

| Part | What it does | Where |
|---|---|---|
| Import | `POST /api/money/import {name, data (base64), account?, mapping?}`. CSV/TSV/Excel/OFX/QFX/QIF. A CSV whose header isn't recognized answers `needMapping` with its columns and 3 sample rows; the page asks Date / Description / Amount (or Money out / Money in), a bank name and "charges are positive". The mapping is saved per layout (the folded header cells, `csv_maps` in `money_state`) and used by later files of that layout without asking. Every file is logged in `money_imports`. | `parse.ts` (`transactionsFromQif`, `MappingNeeded`, `headerSig`), `hub.ts` `importFile` |
| Duplicates across files | A row is a duplicate when an earlier import already holds as many rows with the same day, amount and merchant on the same account: the same name, the same last 4 digits ("Card …9876" = "9876"), or any account when one side's account was only the file name. Two equal coffees on one day in one file both count. | `store.ts` `importTransactions`, `acctKey` |
| Categories | E3's order (the person's rules, a keyword table, the bank's column, the sign). Changing a transaction's category (`PATCH /api/money/tx/:id`) is a rule for its merchant and moves its other rows; rules are listed and editable. Optional model suggestions (off by default): `POST /api/money/suggest` sends merchant names only (never amounts) and the person accepts each. | `hub.ts` `suggestCategories` |
| Month and trends | E3's `summarize` for the month (‹ › to move), and six months of spending per category. | `hub.ts` `trends` |
| Budgets | E3 limits. Gentle alerts on the **Money** alert feed (Settings → Automations → Where alerts go, or `alerts_route`): "getting close" once a month at the chosen share (default 80%) and "went past" once a month (E3's warning, also a phone notification). Off with *Gentle alerts*. | `hub.ts` `budgetAlerts` (also used by `budget_import` / `budget_limit`) |
| Bills due | E3 bills (inbox bills already land there through the inbox helper's `bill_add`) plus repeating charges found in transactions that aren't tracked yet; *Track with a reminder* adds one (the cycle already charged counts as paid). Mark paid / Stop tracking. | `hub.ts` `billsDue`, routes |
| Subscriptions | Repeating charges that are subscriptions (category, yearly, or a known service) with **price changes** (latest amount vs the one before) and a **How to cancel** link (a known account page, else a web search link). From mail: the inbox helper passes each new mail to `observeMoneyMail` (free trial ending, price change, renewal); a trial ending gets a Planner reminder two days before and one gentle alert. She never cancels. | `hub.ts` `subscriptionsOf`, `priceChanges`, `observeMoneyMail` (`money_mailsubs`) |
| Net worth | Balances the person types (asset or debt, `money_balances`) plus the portfolio's last checked value; one snapshot per day (`money_networth`). | `hub.ts` `netWorth` |
| Ask about anything | Source `money`: transactions by merchant words or an amount ("42.10"); opens the Money place at the row. Each space's own store, so household members stay apart; children skip it (their tool allowlist has no money tool). | `ask-everything.ts` `money` |
| Who | Owner and household members (`money` in `MEMBER_ROUTES`, each space's own store); children are refused (`CHILD_DENIED`); not on the demo; changes get an audit row. | routes `src/routes/money.ts` |

Settings live on the page itself (a **Money settings** section with tips): *Gentle alerts*, *Getting
close at* (never, 50-90%), *Let my model suggest categories*.

Limits: mail subscription reading is English-only for now; how-to-cancel links for unknown services are
a web search link; QIF investment accounts are skipped; PDFs are still not read.

Tests: `test/u4-money.test.ts` (QIF, mapping saved and reused, overlapping files and last-4 digits, rules
and suggestions, trends and gentle alerts on the Money feed, bills due, price changes and cancel links,
mail trials and price changes, net worth history, Ask source with members and kids, routes and page,
private local mode).
