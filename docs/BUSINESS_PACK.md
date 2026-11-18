# Business pack (U4.29): clients, time, invoices, a client page and bookkeeping

For freelancers and small shops using their own Sara. One **Business** place (sidebar → Business,
or `#view=business`) brings together pieces that already existed in chat: E6 invoices and quotes
([BUSINESS_TOOLS.md](BUSINESS_TOOLS.md)), N7 clients and time tracking
([WORK_AND_TEAMS.md](WORK_AND_TEAMS.md)) and R6 accounting files ([WORK_APPS.md](WORK_APPS.md)).
It is not the separate business-workspace instance ([BUSINESS.md](BUSINESS.md)).

**She never charges a card or takes a payment.** Invoices and the client page say how to pay you
(Settings → You → Business details → How to pay you).

## What you can do

| Where | What happens |
|---|---|
| **Timer** | Start and stop in the page or by chat ("start a timer for Rivera", `time_start`/`time_stop`). One timer at a time. |
| **Add time** | Hours on a day, or a start and end time, per client and project. Entries may not overlap; billed ones can't be removed. |
| **Rounding rule** | Settings → You → Business details: round each entry to 6, 15 or 30 minutes or an hour, to the nearest or always up. Applied when an entry ends; every report, time sheet and invoice adds the rounded hours. Default 6 minutes to the nearest (as before). |
| **Clients** | Name, email, hourly rate, payment terms (days), phone, address. A client's terms set the due date and their address and email fill their invoices unless the request says otherwise. |
| **Invoice hours** | "Invoice 6.5 h" on a client (or "invoice my hours for Rivera", `time_invoice`): one line per project at the client's rate. In chat, `expenses: [ids]` adds expenses at cost; each expense is billed once. |
| **Quotes → invoices** | "Make invoice" on a quote (or `invoice_from_quote`): same client, lines and tax, a new invoice number and PDF; the quote is marked accepted and is invoiced only once. |
| **Send** | "Email it" puts "Email invoice INV-… to …" in the message box; she calls `invoice_send`, and the approval card shows the exact email (To, Subject, the attached PDF, the text). Only after **Allow** does it go out through your mailbox (`mail_send`), and the invoice is marked sent with its due reminders. |
| **Paid / overdue** | Mark sent or paid in the page. Overdue is worked out from the due date; Planner reminders the day before it is due and 3 days after if unpaid (E6). |
| **Expenses** | Add one in the page or from a receipt in chat (`expense_add`). Rows from your bank exports in **Money** (last 90 days, money out) can be added with one click: Money's categories map to business ones (dining → Meals, subscriptions → Software, shopping → Office supplies …), once per bank row. |
| **Client portal** | "Make link" for a client: a read-only page with their sent invoices and quotes (lines, totals, status, due dates, the PDFs) and how to pay. No account; expires in 1, 7 or 30 days; revoke any time. |
| **Bookkeeping export** | A CSV for the period: *by category* (income as Sales, expenses per category, tax apart), or rows in QuickBooks Online, Xero or Wave columns (generic CSV too). Nothing is sent anywhere. |

## Design (one page)

- **Data.** Everything stays in the person's own `store.db` (the first companion's): `work_clients`
  (new columns `terms_days`, `address`, `phone`, added in place), `work_time`, `biz_invoices`,
  `biz_expenses`, and three small maps in `biz_state` (`quote-invoices`, `billed-expenses`,
  `from-money`). A voided invoice frees its quote and its expenses, worked out on read
  (src/biz/pack.ts). The rounding rule is two fields of the business details
  (`timeStep`, `timeRound`), read by `TimeStore` (`timeRuleOf`, `roundBy` in src/work/time.ts).
- **Client portal = an EC11 share link.** `buildPortal` (src/biz/portal.ts) makes a frozen snapshot
  of one client's invoices (never drafts or void ones; matched by name or the client's email) and
  stores it with `ShareStore.create` under `conversationId: portal:<client>`; files ride in the share's
  picture table (PDF and images only, never HTML, at most 12). `/s/<token>` renders it with
  `portalHtml` (escaped, no script, no-index, no-referrer, rate-limited, expiring, revocable; only the
  token's hash is stored). It is a copy as of the day it was made: make a new link after new invoices.
- **Routes** `/api/bizpack` (src/routes/bizpack.ts), audited; member route group (each household
  member gets their own, in their own space); children are refused (`CHILD_DENIED`), the demo too.
  Portal links follow the share-link rules (members only while the owner allows member links; off
  with the sharing policy and with "Nothing leaves this computer").
- **Tools** (src/tools/bizpack.ts): `invoice_from_quote` (auto), `invoice_send` (asks every time;
  hidden without a mailbox and in private-local mode; off in private chats via `OFFSERVER_TOOL` and
  lean's `OFF`). `invoice_send.prepare` fills `to`/`subject`/`message` into the call's arguments, so the
  card and the sent email are identical. Both sit in lean's *business* family (`invoice_*`).
- **Web**: web/bizpack.js (sidebar place `bizpack`, dialog `#bizpack`, `bp-` ids/classes),
  theme variables only; strings through `t()` in six languages.
- **Not done (on purpose):** no card payments or payment links, no client accounts or logins, no
  live portal (a frozen copy, like conversation shares), no multi-currency conversion, no
  recurring invoices. Expenses billed on an invoice are chosen in chat (`time_invoice` `expenses`);
  the page's "Invoice h" button bills hours only.

Tests: `test/u4-biz.test.ts` (rounding rules, client terms on invoices, quote → invoice once,
expenses billed once and freed by void, send-after-approval with the attached PDF and the sent
mark, the portal page showing one client only, escaped, expiring and serving the PDF, the
bookkeeping summary and Wave CSV, Money rows as expenses, wiring for members/kids/the place).
