# Business and documents (E6)

Part of the everyday-assistant track ([design/EVERYDAY.md](design/EVERYDAY.md)). Invoices and quotes,
"who do I owe a reply", contract reading, receipts to an expense report, and meeting notes to action
items. For the owner and every household member, each in their own space; not on the demo.

## What she can do

| Ask | Tool | What happens |
|---|---|---|
| "Make an invoice for Rivera Co: 10 hours at $85" | `invoice_make` | Numbered `INV-2026-0001` (quotes `Q-2026-0001`), one series per kind per year per person. Totals in code (integer cents, half away from zero; tax on the subtotal). A PDF or Word file with the default layout, or **their own** `.xlsx`/`.docx` template from the Library filled in a copy (fill_document's engine). Starts as a draft. |
| "Which invoices are unpaid?" | `invoice_list` | Status draft / sent / overdue / paid / accepted / void. *Overdue* is worked out from the due date on read, never stored. |
| "I sent it" / "Rivera paid" | `invoice_mark` | *sent* adds two ordinary Planner reminders (the day before it's due, and 3 days after if unpaid, 9 AM local); *paid* or *void* clears them. Recording only: nothing is sent. |
| "Who do I owe a reply?" | `follow_ups` | From the connected mailboxes (Gmail, Outlook, IMAP): conversations whose last message is someone else's, written *to* them (not only copied), not a newsletter / no-reply / automated message, waiting longer than N days (default 2); ranked (a question, written to them alone, unread, a back-and-forth, then age). Plus to-dos due. Replies are offered as drafts through `mail_draft` / `gmail_draft`, which ask first. With no mailbox it says what to connect. |
| "Read this lease" | `contract_review` | Code finds the parties, dates (start, end, renewal), notice periods and the **last day to give notice**, amounts, rates (as % a month), termination sentences, and a checklist: automatic renewal, unlimited liability, non-compete, exclusivity, arbitration, one-sided changes, late fees above 1.5% a month, indemnity. Each with the exact sentence and page / section. The model's own points come back through `findings` and are kept only if their quote is in the document word for word. Not legal advice; a lawyer for big decisions. |
| "Add this receipt" | `expense_add` | Vendor, date, total, tax and category read by code from the receipt's text (a PDF, or a photo the Library or the picture reader read); values the model reads from the photo win. Same vendor + day + total is refused as a duplicate unless confirmed. |
| "Expense report for October" | `expense_report` | Excel (Expenses and By category sheets) or PDF/Word: every expense, totals by category, receipts listed (pictures included in the PDF). |
| "Turn these notes into action items" | `action_items` | Owner, due date and the exact line, from pasted notes or a Library document. Code finds "Dana will … by Friday", "Action: …", "- [ ] …", "@sam to …"; extra items need a real quote. `create_tasks` makes Planner to-dos once. Meeting rooms and recordings keep their own notes and action items (EC19, [MEETINGS.md](MEETINGS.md)). |

**Settings → You → Business details**: name, address, email, phone, tax ID, a logo (a picture in the
Library), how to pay, currency, default tax rate and payment terms. Every field has a **?** tip.

**Today**: a *Money and replies* tile (unpaid total, how many overdue; how many were waiting on a reply
at the last check, with its time). It appears only once an invoice exists or `follow_ups` was used,
and reads no mail by itself.

## Decisions and limits

- Money is never added up by the model. Tool results carry the worked-out totals.
- Email is never sent by these tools; the mail tools' own approvals apply. The mail tools can't attach
  files, so a drafted invoice email asks the person to attach the file (Download on the card).
- Invoices, numbers and expenses live in the person's first companion's `store.db` (tables `biz_*`),
  so all their companions share them and a household member's are their own.
- Contract reading is deterministic where it can be (dates, money, rates, the checklist) and quote-checked
  where it can't. It is a reading aid: she says it isn't legal advice.
- Tests: `test/e6-business.test.ts` (money and rounding, numbering per space, overdue and reminders,
  default and template invoices, follow-up filtering on fixture threads, a fixture contract, receipts,
  duplicates, report totals, action items, the lean picker in six languages).
