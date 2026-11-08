# Crews: standing helpers with a lead

A **crew** is a few of your helpers (Team → *Helpers and limits*) that do the same job again and
again: each member has a standing part, the crew has a brief (what it delivers), a budget and a
time. Sara leads it: she hands each member a card on the crew's own board, checks the work the way
a team task does (a failing test goes back, claims need receipts) and sends **one** summary.

Design: [ops/EC1213_DESIGN.md](ops/EC1213_DESIGN.md).

## Make one

Team → **Crews** → *Start from* a template, or *My own crew*, then **Add a crew…**:

| Field | What it does |
|---|---|
| Name | Its chat and its board are called *Crew: name*. |
| What the crew delivers | The brief every member gets with its part. |
| Members | One to four of your helpers, each with a part, in order. |
| When | *By hand*, *Every day* or *Every week* at a time, in your time zone. A slot missed by more than 6 hours is skipped (no pile-up after a long shutdown). |
| Also when a mail says | Optional words. When **you** mail Sara's own mailbox ([EMAIL_BRIDGE.md](EMAIL_BRIDGE.md)) with them in the subject, the crew starts. Someone else's mail never starts it, and the mail's text never goes to the crew. |
| Folder | Where each run's report file goes, inside the crew chat's workspace (default `crews/<name>`). |
| Budget, time limit | A run stops at its reading-and-writing budget, its time limit or after a few helper runs, and says how far it got. |
| Also send to Telegram | The summary and the report file also go to your own linked Telegram chat. |

Three templates come with Sara: **Research desk** (researcher + writer, Fridays 08:00), **Code
review crew** (reviewer + tester, by hand) and **Weekly planner** (researcher + writer, Mondays
08:00). Everything in them can be changed.

## What a run leaves behind

- one card per member on the board *Crew: name*: in *Done* when its part is done, in *Waiting on
  you* otherwise, with one **receipt** line per tool the member used;
- the lead's one summary and a **crew card** in the crew's chat (status, cards, receipts,
  *Open the file*);
- the report file `<folder>/<YYYY-MM-DD-HHmm>.md`: the summary and the receipts per member;
- the run on the Team page and in the run records, like any team task.

Risky tools still ask first (your normal approvals); an unanswered approval waits until the run's
time limit.

## Stop all

**Stop all** (under the crews) stops every crew that is working and pauses every crew. Nothing
starts again until you turn a crew on.

## For admins

- Crews are the owner's: household members, the demo and paired devices can't use them.
- Policy pin **Crews: Off** (Settings → Data & health → Policy) refuses making, running,
  scheduling and mail-starting crews on the server. See [AUDIT_AND_POLICY.md](AUDIT_AND_POLICY.md).
- Every change is an audit row (`crews.do`, `crews.change`, `crews.remove`); scheduled and
  mail-started runs write `crew.run` (role system), and each run is also `run.team`.
