# Server dashboard (U5.34)

**Settings → Privacy & system → Health → Server dashboard** (owner only). One card per server:
this server, and each linked server whose owner gave you an active **help pass** (Messages → their
chat → Ask for help). Each card shows:

| Row | From | Green / amber / red |
|---|---|---|
| Health | the health checks (`src/health.ts`) | all pass / – / any failing |
| Versions | the server and each Windows/Mac app install (`src/app-installs.ts`) | up to date / an app is older |
| Disk space | free space where her data lives | ≥ 5 GB and 10 % / less / < 1 GB or 2 % |
| Memory | the operating system (total and free memory) | ≤ 90 % used / ≤ 95 % / more |
| Processor load | the 1-minute load average per core (not on Windows: grey) | ≤ 1 / ≤ 1.5 / more |
| Backups | the newest backup (`src/backup.ts`) | ≤ 3 days / ≤ 7 days / older or none |
| Recent errors | failed turns, tools and model services in the last week | none / some / 3+ turn errors or a service failing |
| Self-repair | problems open in self-repair (`src/repair.ts`) | none / some |
| Updates | the updater's state (`src/updates.ts`) | none waiting / one waiting / a security or required update, or the last one failed |

Grey means the server doesn't report it (an older server, Windows load, a disk that can't be read);
grey never turns a card red. The card shows when it was checked; **Refresh** reads every linked server
again. **Details** opens the page with more: a Settings page for this server, Messages (where the
help-pass report lives) for a linked one.

## Design (one page)

**Reuse, no new powers.** Both kinds of card are made from the same object: the S9b support report
(`supportReport` in `src/routes/support.ts`), already redacted. This server's card calls it without the
self-test (`{selfTest: false}`, fast); a linked server's card is the S9b `look` op, which answers only
while that owner's help pass is active and is written to both sides' help logs, exactly like
"Look at <name>'s Sara". U5.34 added two read-only numbers to the report: `system` (platform, cores,
load average or null on Windows, total/free memory, Sara's own memory) and `repair` (problems open,
last check). No chats, files, names or settings values are added.

**Shape.** `src/dashboard.ts` `serverCard(report, {name, self, link, now, error})` is pure: rows
`health versions disk memory cpu backups errors repair updates`, each `{state, text (English key),
params, page | view}`; the card's state is its worst row (grey ignored). `src/routes/dashboard.ts`:
`GET /api/dashboard` → `{servers, linked}` (this server fresh, linked servers from the last Refresh);
`POST /api/dashboard/refresh` reads each linked server with an active held pass (30 s cap each; an
unreachable one gets a grey card with the reason). Remote cards are kept in memory per app; a revoked
or expired pass drops its card. Owner only (members, kid mode, demo: 403). The page
(`web/dashboard.js`) reads linked servers once by itself when it opens and none was read yet.

**Tests:** `test/u5-dashboard.test.ts` (green server, every red/amber rule, grey for missing data and
older servers, an unreachable server, and two in-process servers linked by S9a: no pass → only this
server; pass → the friend's card after Refresh, logged as a look; GET doesn't look again; revoked →
gone).
