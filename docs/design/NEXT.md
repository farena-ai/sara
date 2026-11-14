# Next roadmap: capability and effectiveness (owner request, 2026-11-14)

Goal: make Sara noticeably better at actually getting things done for people, not just able to. Built on
what 3.7.0 has (computer use, documents and forms, mail, calendar, watches, shopping, money, sports,
decisions, business tools). Ordered by value per effort; each track ships as its own release when green.
Same standing rules as EVERYDAY.md: free sources first, approvals for changes, never fake data, lean.

Evidence behind the order (live use, 2026-11-11..13): replies that failed or crawled because of the wrong
model; a reply that said "done" when a form wasn't filled; a support report that never arrived; store
pages that block her; a time sheet filled by hand every week; Mac app behind Windows.

## N1 Get it right the first time (reliability, first)
Status: built on branch hermes/n1right (not merged): Auto per job, did-it-work read-backs with claim
gating, How she did. See docs/QUALITY.md. The hub send of the counts was skipped (needs a hub field).
- **Right model per job, automatically:** chat on a fast model, tool-heavy and long tasks on a strong one,
  pictures on a vision model, private chats local. One "Auto" choice that picks from what's connected,
  with the reason shown; falls back when a model is slow or errors (today: one fixed route per job).
- **"Did it work?" check after every action:** after a change (file, form, setting, email draft, desktop
  action) she verifies the result and says what she verified; a failed check retries once or reports.
- **Weekly quality report (owner only, local):** failed turns, slow turns, refused actions and Fix-it
  suggestions, from the runs table; one tap opens the failing chat. Also sent to the hub only if opted in.

## N2 Automations, one place (the biggest "assistant" gap)
- One **Automations** page that unifies watches, triggers, routines and reminders: "When ___, do ___".
  Triggers: time, email arrives, price/score/odds, a file appears, a webhook, a calendar event. Actions:
  tell me, draft a reply, fill a form, add to budget/bills, run a recipe, ask her to do a task.
- Build by chat ("every Friday at 3, fill my time sheet from my calendar and send me the draft") with a
  preview of exactly what will run and a dry run; actions that change things keep their approvals.
- Run history per automation with the outcome, and pause on repeated failure.
- Status: built on hermes/n2auto (docs/AUTOMATIONS.md, handoff 2026-11-14-n2-automations); not released.

## N3 From your inbox, without asking (proactive)
- Reads new mail (connected accounts) and offers one-tap actions: bill -> Bills, receipt -> Expenses,
  shipping email -> package tracking with delivery alerts, flight/hotel -> trip card with check-in and
  leave-by reminders, appointment -> calendar, invoice paid -> mark paid.
- Attachments filed to the Library automatically (by sender/type rules she suggests).
- Everything is a suggestion card until the person turns on "do it for me" per kind.
- Status: built on hermes/n3inbox (docs/INBOX_HELPER.md, handoff 2026-11-14-n3-inbox); not released.

## N4 Hands that finish the job
- **Web forms:** fill forms on websites in the person's own browser from their saved details (a "My
  details" page: addresses, sizes, vehicle, insurance numbers; never passwords or card numbers), with
  approval and a review before submit.
- **Store stock through the person's browser:** for retailers that block her, check price and pickup
  stock in the person's own browser where they're already the store's customer (their session, their
  store), with approval; results feed find_product and product watches.
- **Send with attachments:** mail send/draft with files from the Library (invoices, filled forms).
- **Time sheet from the calendar:** fill a recurring form from calendar/work hours each week (uses N2).

## N5 Everywhere the person is
- **Mac app parity:** PC tools (my tabs, files, commands), save to computer, self-update.
- **Phone:** share-to-Sara from any app (photo of a receipt, a PDF, a link), quick actions on lock-screen
  notifications (Approve, Snooze, Reply), and a home-screen widget (next thing, watches).
- **Car / hands-free mode:** voice-only replies, short answers, read-back of messages, no screens needed.

## N6 Knows your world (memory that pays off)
- **Personal facts page** she keeps from conversations and documents (with sources, editable): family,
  vehicles, policies, account numbers' last 4, renewals; used for forms and reminders.
- **Ask your documents:** answers across all Library files with citations ("what's my deductible?",
  "when does the lease end?"), plus renewal dates found in documents become reminders.

## N7 Work and teams
- Shared household/team tasks and lists with assignees; client list with a light pipeline (lead, quote,
  won, invoiced) tied to invoices and follow-ups; time tracking that feeds invoices and time sheets.

## Recommended order
N1 (small, protects everything) -> N2 (turns features into an assistant) -> N3 -> N4 -> N5 (Mac parity
first) -> N6 -> N7. Hank (Kent) is the first real user for N2-N4: his time sheet and Outlook calendar are
the acceptance tests.

## Owner decisions
- Azure Artifact Signing ($9.99/mo) for the Windows installer: in progress (owner setting up).
- N3 "do it for me" defaults: off (suggestion cards); owner chose the recommendation 2026-11-14. Build all of N1-N7 plus leftovers.
- Paid data (store APIs, odds beyond free tier): not without a yes.
