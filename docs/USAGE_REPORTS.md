# Usage and cost reports

**Settings → Household → Usage reports** (design: `ops/EC1115_DESIGN.md`). Tokens and estimated
cost of every model call, from the same records as *Usage and costs* and the run records.

- **Show** daily, weekly (weeks start Monday) or monthly, in your time zone. **From / To** pick the
  days (empty = the last 30 days; up to 400 days).
- **Split by** person, workspace, project (the chat's planner project) and model. Calls made outside
  a chat (memory work, background jobs without a chat) show as *(none)* for workspace and project.
- **Download CSV**: the same table as a file (`sara-usage-<period>-<date>.csv`). Cells that would
  start a spreadsheet formula get a leading `'`.
- Costs are estimates from your price table; local and subscription models count as $0, and calls
  on a paid model with no price are counted as *calls with no price*.

## Who sees what

- **You (the owner)** see every person on the server: you and each household member.
- **A household member** sees only their own usage, never anyone else's.

## Monthly budgets (owner only)

Under the report, add a budget **for a person or a workspace** in dollars, tokens or both, and when
to warn (50–90%, default 80%). Each calendar month you get one notification when it is nearly used
and one when it is reached (a push notification when the phone app or browser notifications are
set up), and an audit row `usage.budget.alert`. A dollar budget does not count subscription or
local calls. A household member's **daily** spending limit (People on this server) still stops
their companions; the monthly budget is the early warning.

Storage: `<data>/usage-budgets.json`. API: `GET /api/usage/report`, `GET /api/usage/report.csv`
(`period`, `from`, `to`, `by`), `GET|PUT /api/usage/budgets`.
