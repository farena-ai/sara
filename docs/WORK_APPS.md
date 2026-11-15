# Deeper work apps (R6)

Sara works inside the files and chat apps you already use for work: Google Docs and Sheets, Word and
Excel in OneDrive or SharePoint, Slack and Teams. She also gives you a public booking page and makes the
CSV files QuickBooks Online and Xero import. Reading runs on its own; every change shows what changes
and waits for your OK, and she reads each change back before she says it worked.

## Google Docs and Sheets

- **Turn it on:** Settings → Connections → Apps and services → Gmail and Calendar → **Docs and Sheets** → *Allow Docs and
  Sheets*. Google shows a new permission page (the `documents` and `spreadsheets` permissions). A normal
  Google sign-in never asks for them; once allowed, later sign-ins keep them.
- **Tools:** `gdoc_read`, `gdoc_append`, `gdoc_replace_text` (Docs API `batchUpdate`), `gsheet_read`,
  `gsheet_update_range`, `gsheet_append_rows` (Sheets API). Give her the docs.google.com link or the
  file id.
- **Cards:** an append shows the end of the document and the `+` lines; a replace shows `- old` / `+ new`
  and how many places; a range update shows each cell `old → new`. Nothing in the text → nothing asked,
  nothing changed.
- **Read-back:** after each change she reads the document or cells again (the `Verified:` line).

## Word and Excel in Microsoft 365

- **Turn it on:** Settings → Connections → Apps and services → Email and calendar → **Word and Excel files** → *Allow Word and
  Excel files* for an Outlook / Microsoft 365 account. Microsoft asks for `Files.ReadWrite`; the account
  remembers it (and asks for it again on renewal).
- **Files:** a OneDrive/SharePoint link (Share → Copy link), a path like `/Documents/Budget.xlsx`, or an
  item id.
- **Excel:** `excel_read_range`, `excel_update_range` through the workbook API (a range and rows of values;
  `=` starts a formula). The card shows each cell `old → new`.
- **Word:** `word_read`, `word_fill`. She downloads the .docx, fills it with Sara's own OOXML editor (the
  same one as `fill_document`: "Label: ___" lines, cells next to a label, tables) and uploads it onto the
  **same item**, so OneDrive keeps the earlier version in its version history. Then she downloads it again
  and checks every value is in it. Files up to 4 MB.

## Slack and Teams actions

Through the bridges you already set up (Settings → Connections → Slack / Teams); the add-on runs the
calls with its own tokens.

- **Slack:** `slack_post` (a channel, a person by email, or a thread), `slack_react`, `slack_status`,
  `slack_remind`, `slack_search`. Posting, reacting, status and reminders ask first; search only reads.
  Status, reminders and search can only be done **as you**: add your own optional **user token**
  (`xoxp-`, scopes `users.profile:write`, `reminders:write`, `search:read`) in the Slack add-on's
  settings. A post is read back with `chat.getPermalink`.
- **Teams:** `teams_post` posts as her bot to a chat or channel the bot already knows (someone talked to
  her there). Teams' bot API can't read a message back, so she says Teams accepted it, with its id.
- The Slack and Teams add-ons are version 1.1.0 (the new `action` check step and the user-token box).
- Off in private chats, like every tool that reaches another service.

## Booking page

Settings → You → Business details → **Booking page**. Off by default.

- You set the page name (`/book/your-name`), the meeting name, length, buffer, at most per day, days
  ahead, notice in hours, a line for visitors and, per weekday, when you are free.
- Free time = your windows minus busy time from every connected calendar (Google free/busy, Outlook
  calendar) and your planner (an open task due at a set time keeps half an hour), minus the requests
  already made on the page (with the buffer around each).
- A visitor picks a time and gives a name, email and note. **Ask me first** (default): you get a notice
  and confirm or decline on the page. **Confirm on its own**: it is confirmed at once.
- Confirming creates the calendar event (the visitor as a guest, no invitation from the calendar) and
  sends a confirmation email from your own mailbox. Declining sends a short "please pick another time".
- The public page is server-rendered with no script, never indexed, rate-limited (60 views a minute and
  8 requests per 10 minutes per address, 20 open requests a day), with a hidden honeypot box and a
  signed time token (a form sent in under 2 seconds counts as a bot) instead of a captcha.
- Each person's own (a household member's page is theirs); never on the demo.

## Accounting exports

`accounting_export {from, to, format, what?}` in chat, or Business details → **Accounting export**
(Download CSV). Files only: no QuickBooks or Xero API, no keys, nothing sent.

- **QuickBooks Online:** invoices (InvoiceNo, Customer, InvoiceDate, DueDate, Terms, item lines with tax,
  MM/DD/YYYY), expenses as the 3-column bank file (Date, Description, Amount; money out negative), time
  activities (Date, Customer, Service, Description, Duration hh:mm, Billable).
- **Xero:** sales invoices (the `*` required columns; DD/MM/YYYY; account code 200 and "Tax on Sales" /
  "Tax Exempt", which you can change on import), expenses as a bank statement (`*Date`, `*Amount`, Payee,
  Description, Reference), time as a plain sheet.
- **Generic:** one file of invoices, expenses and time (Type, Date, Number, Party, Description, Quantity,
  Rate, Amount, Tax, Currency, Status).
- Invoices come from E6 (quotes and void invoices are left out), expenses from E6, time from N7. Text that a
  spreadsheet would run as a formula gets a leading `'`.

## Where it lives

`src/workapps/` (gdocs.ts, m365.ts, chatapps.ts, booking.ts, accounting.ts), `src/routes/booking.ts`,
`plugins/slack/actions.mjs` and the `action` step in both plugins, `web/workapps.js`, `web/book.css`.
Tests: `test/r6-workapps.test.ts` (fake Google, Graph and Slack, a throwaway server for the booking page).
