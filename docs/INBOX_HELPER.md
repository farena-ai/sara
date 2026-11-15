# From your inbox (inbox helper)

Sara reads the new email in your connected mailboxes (Gmail, Outlook and Microsoft 365, Yahoo, iCloud
and other IMAP mailboxes; see [Email and calendar](EMAIL.md)) and turns what needs doing into
one-tap cards on **Today → From your inbox**. Turn it on or off, pick the mailboxes and choose what she
may do on her own in **Settings → Connections → Apps and services → Email and calendar → Inbox helper**.

## What becomes a card

| Email | Accept does |
| --- | --- |
| A bill or statement (amount, due date) | Adds it to **Bills** with a reminder before it's due ([money](MONEY.md)) |
| A receipt or order confirmation | Saves it to **Expenses** (vendor, date, total, items) ([business tools](BUSINESS_TOOLS.md)) |
| Shipping (UPS, USPS, FedEx, DHL, Amazon tracking numbers) | Tracks the package; later emails about it update the status, and she tells you on the delivery day, when it's out for delivery and when it was delivered |
| A flight or hotel booking | A **trip**: flights, hotel, confirmation codes; calendar entries; a check-in reminder 24 hours before departure; a leave-by reminder (travel time to the airport + 2 hours) when your home is set in Leave-by reminders |
| An appointment or event booking | Adds it to your calendar (or a reminder an hour before when no calendar is connected) |
| "Paid" for one of your invoices (INV-2026-0003) | Marks that invoice paid |
| A document attachment (PDF, Word, Excel, pictures) | **File it** saves it to a Library folder (Insurance, Statements, Receipts…) |

Each card has **Accept**, **Dismiss** and **Always for …**. Every Accept goes through the same tools you'd
use by asking her, and each one is read back ("Verified: …"). Undo removes what was added where the
place it went supports that (bills, expenses, packages, trips with their reminders and calendar
entries, paid invoices, filed documents).

## Doing it for you

Every kind starts as suggestions only. **Do it for me** (per kind, all off at first) makes her do it as
soon as the email arrives; Today then shows "Done from your inbox" with **Undo**, and one chat line in
the **From your inbox** chat lists what was done. She never sends email or pays anything from here,
whatever is on. A tool you set to *never* in Tools is never run.

## Filing rules

After you file an attachment by hand she suggests a rule ("File PDFs from shieldmutual.com into
Library/Insurance?"). You can also ask: "file PDFs from my insurer into Library/Insurance". Rules that
are on file new matching attachments right away (up to 25 MB each, file types the Library reads).

## How it reads

- About every 10 minutes (on the same clock as reminders), only mail that arrived since the last
  look; the same email is never looked at twice and the same thing (tracking number, confirmation
  code, order or invoice number) is never suggested twice. The first look covers the last 3 days.
- Rules first: the booking data airlines, hotels and shops put in their emails (schema.org), sender,
  subject and body patterns, carrier tracking-number shapes. When an email looks like a bill or an
  order but the rules can't read it, a small model may read it: a model on this computer by default,
  your quick model if you choose it, or none. In private local mode only rules are used.
- Email text is other people's words: it is read as data, never followed.
- Each person's own: a household member's suggestions, packages and trips come from their own
  mailboxes, in their own space.

## For Sara (chat tools)

`packages_list`, `trips_list`, `inbox_suggestions` (read only) and `inbox_file_rule` (asks). Code:
`src/inbox/classify.ts` (rules, JSON-LD, carriers), `src/inbox/helper.ts` (scan, cards, actions,
packages, trips, filing), `src/inbox/read.ts` (mailbox reader), `src/tools/inbox.ts`,
`src/routes/inbox.ts`, `web/inbox-helper.js`. Tables `inbox_kv`, `inbox_items`, `inbox_packages`,
`inbox_trips`, `inbox_rules` in each space's own store.
