# Money: portfolio, budget and bills (E3)

Part of the everyday-assistant track ([design/EVERYDAY.md](design/EVERYDAY.md)). Sara reads your own
brokerage and bank exports and works out the numbers in code. It is information and math, not
financial advice: she never buys, sells, moves money or pays a bill, and every price says where it
came from and when. For the owner and every household member, each in their own space; not on the demo.

## What she can do

| Ask | Tool | What happens |
|---|---|---|
| "Here's my Fidelity export" / "I have AAPL 10 @ 150" | `portfolio_import` | Reads a positions CSV or Excel file (Fidelity, Schwab, Vanguard, Robinhood, E*TRADE and others: columns found by name, like Symbol/Ticker, Quantity/Shares, Cost Basis or Average Cost, Account) or a typed list. Cash and money-market lines count as cash. Importing an account again replaces that account's holdings. |
| "How are my stocks doing?" | `portfolio_show` | Value now from the stock-price source in [Data sources](DATA.md) (one batched request), today's change, gain against the cost basis and the share of each holding, with the source and time. A symbol with no price is left out and named. |
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
- **Price alerts** stay E1's `watch_add` (kind `price`); news and earnings dates are not part of E3.
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
