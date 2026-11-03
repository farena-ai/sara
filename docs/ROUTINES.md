# Routines

Ready-made things Sara does on a schedule: a morning briefing, a weekly review, a reminder to
stretch, a price watch, an inbox triage, a CI watch… Open **Planner → Routines** (or *Add a routine*
on Today, or *Turn on a routine* in Getting started).

Every card says the same four things before anything happens:

1. **When** it runs, in words ("Weekdays at 08:00, until 2 December").
2. **What it needs**, each ticked ✓ or ✗ with *Set it up* (a GitHub token, Gmail, a brain…). While
   something is missing the card's button reads **Set up first** and opens the first missing thing.
3. **What it costs**, computed by Sara from your model and the schedule, never from the card itself:
   *Free · no model calls*, or "About 1 model call a day … At most 1 a day", or for a routine that runs
   a model on a schedule the turns a day, the daily cap Sara enforces and the end date.
4. **Turn on**, which always shows the preview first: what will be created, the next three runs and
   the cost line. Nothing is created until you tap Turn on in the preview, and **Off** stops it at once.

## The ten routines

| Routine | What it uses | Costs |
|---|---|---|
| Morning briefing | the morning briefing (Settings → You) | about 1 model call a day, at most 1 |
| Weekly review | the weekly review | about 1 model call a week |
| Remind me to stretch | a repeating reminder (weekdays or every day) | free |
| Bedtime wind-down | a repeating reminder (every day) | free |
| Leave on time | leave-by reminders (needs Google Calendar and your home place) | free |
| Inbox triage | a repeat at a clock time (weekdays 08:00), reading Gmail | about 1 model turn on weekdays, ends after 7–90 days |
| Price watch | a repeat every 6, 12 or 24 hours, reading the page | about 2 model turns a day, ends after 30 days or when the price is reached |
| Watch my repo's CI | Sara's own GitHub poller (every 15 minutes) | free: no model, no CI minutes |
| New issues on my repo | the GitHub watcher: new issues become to-dos | free |
| Backup check | the weekly safety check (see [Safety check-up](SAFETY_CHECKUP.md)) | free |

## Paid routines always end

A routine that uses a model (Inbox triage, Price watch) is a [repeat](GOALS.md) with three extras:
a clock time or an interval of at least 6 hours, an end date (7, 14, 30 or 90 days; renewing is a
new Turn on, never automatic, and she reminds you a week before), and it stays on across a restart
(the missed slot is skipped, never run late). Every repeat guard still holds: the per-check budget,
its daily share (100,000 tokens by default), the all-repeats daily cap (300,000 tokens and $0.50),
quiet hours (a slot inside them is skipped), two failures stop it, and private local mode pauses it.

**Tools keep your approval settings.** The card names the tools a routine uses (Price watch:
`web_fetch`; Inbox triage: Gmail search and read). If one of them is set to *Ask* in Settings →
Coding → Tools and approvals, the routine pauses at that step and tells you, exactly like a repeat
does; set it to run without asking yourself if you want it unattended. A tool set to *Never* stays never.

## My routines

The left side (or *My routines* on a phone) lists everything that runs on a schedule, including
things set up elsewhere (a briefing switched on in Settings, a repeating reminder, a watched repo, a
repeat typed in a chat). Each row shows when it runs, its cost, its next run or why it is paused, and
an On/Off switch. ⋯ has *Open its chat*, *Run now* (briefing, review and paid routines: one model
call), *Change answers* and *Remove*. The switch reads the real state: turn the briefing off on its own
page and the routine shows Off here too.

## Ask her

"Can you check the price of this every day?" She shows the matching routine card in the chat
(`suggest_routine`); only you can turn it on, in Planner → Routines.

## Household members

Members can turn on the briefing, the weekly review, reminders and leave-by in their own space. The
GitHub, paid and safety routines are the owner's.

## Not in 2.54

`/routines` in Telegram and Discord, plugin routines, *Try it once now* on an unsaved card, and the
*Instant* (webhook) option for the CI watch are not built yet; the CI watch polls every 15 minutes.
