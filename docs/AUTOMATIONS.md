# Automations: when ___, do ___

Everything that runs on its own is in one place: **Settings → You → Automations**. You make an
automation there or by asking Sara ("every Friday at 3, fill my time sheet from my calendar and send
it to me"). The watches, event triggers, routines and repeating reminders you set up elsewhere are
listed on the same page, each read and switched through its own page's store (nothing is moved).

## When it runs

- **A schedule:** every day, every weekday, chosen days of the week, or a day of the month (the 31st
  is the last day in shorter months), at a time in your time zone (Settings → You → About you).
  Daylight-saving changes are handled: 3 PM stays 3 PM.
- **An email arrives** (optionally from a sender or with some words): the owner's mailbox, the same
  source as [When this happens](TRIGGERS.md). The sender check must have passed for a sender filter.
- **A webhook is delivered:** one of your [webhooks](WEBHOOKS.md).
- **A watch fires:** a price, score or odds watch ([live data](DATA.md)), a product watch
  ([shopping](SHOPPING.md)) or a file watch. A watch made for an automation is deleted with it.
- **Some minutes before a calendar event** (optionally with words in its title): your connected
  calendar (Outlook or Google), else your planner reminders.

Email and webhook automations are the owner's only. A household member has their own automations in
their own space; nobody else sees them.

## What it does

In order: **tell me** (chat, and a phone or desktop notification unless you pick chat only), **ask
Sara** (a task you wrote, run as an ordinary turn in the automation's own chat), **draft an email**,
**fill a document** (one of your templates in the Library, through fill_document), **run a recipe**,
**add a bill** or **add an expense** (the last three are written instructions to her, so the money and
recipe tools keep their own approvals). In a message, `{week}`, `{files}` and `{detail}` (what started
it) are filled in.

## Safe by default

- **Preview** shows what will run, the next three times and which approvals each run asks. Made by
  chat, the preview is the card she shows; it takes one **Allow**.
- **Try it** (a dry run) performs nothing: no draft, no copy kept, no task turn, no phone
  notification. It says what each step would do with today's data and puts one chat line labeled as a
  test in the automation's chat.
- **Approvals are never skipped.** A step whose tool is set to ask holds the run ("waiting for your
  OK") until you tap **Allow** on the page (or Decline); a tool set to never fails the step. A task
  asks in its chat like any turn.
- **Drafts are never sent** unless you turned on "send without asking" for that automation **and**
  `mail_send` itself is allowed to run without asking.
- One run at a time per automation. A run that is missed because the server was off for more than 12
  hours is recorded as skipped. Notifications wait in quiet hours (the chat line still lands), none go
  out in private local mode, and runs with a task are skipped while a spend limit is reached.
- Automations can't be made from a private chat.

## History and pausing

**History** keeps the last 50 runs: when, what started it, what each step did and the outcome, with a
link to its chat. Three failed runs in a row pause the automation and tell you why. Today shows an
**Automations** tile only when one failed, waits for your OK or runs today.

## The time sheet starter

*Fill my time sheet every week* runs every Friday at 3 PM. It reads the week's work events from your
calendar, works out each day's start, end and hours (an overnight shift counts on the day it starts),
fills **your own** template (WEEK OF, the DAY rows, START TIME, END TIME, REGULAR HOURS, OVERTIME
HOURS; TOTAL HOURS only if you ask, since most templates total with formulas) into a new copy, and
sends it to you to check. Tell her your rules: "shifts are 2200-0700, no lunch", "8 regular hours",
"only events called Shift", or fixed work days when there's no calendar. The original is never
changed.

## For Sara (chat tools)

`automation_create` (asks once; its card is the preview), `automation_preview`, `automation_dry_run`,
`automation_list`, `automation_history`, `automation_enable` (asks), `automation_disable`,
`automation_delete` (asks). Code: `src/automations.ts`, `src/tools/automations.ts`,
`src/routes/automations.ts`, `web/automations.js`. Tables: `automations`, `automation_runs` in each
space's own store.

N7: the time-sheet fill also takes `source: calendar | tracked | both` (hours tracked with `time_start` / `time_add`; docs/WORK_AND_TEAMS.md).
