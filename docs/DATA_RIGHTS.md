# Retention, legal hold, and one person's export or deletion

Settings → Household → **Retention and legal hold** (owner only, web app). On a personal install
(no household members) the page shows the server-wide controls and your own export. Design:
[ops/EC1617_DESIGN.md](ops/EC1617_DESIGN.md).

## Retention

How long each kind of data stays. Choices: until I change this (the default), 30, 90, 365 or 730
days. The rule is the same for everyone on the server.

| Kind | What is deleted after the window |
| --- | --- |
| Chats | Conversations nobody wrote in for that long, with their messages and read-once files. |
| Memories | Notes not changed or used for that long. Pinned memories always stay. |
| Files | Library files and chat photos added longer ago. Room archives stay. |
| Audit trail | Its own setting under Household → Audit trail (default one year). |

Retention runs on the hourly household check. Each run that deletes anything writes one
`retention.run` audit row with the counts (never content).

## Legal hold

A hold on one person, or on the whole server, stops **every** way their data could be deleted:
their own deletes, yours, edits that cut a chat short, retention, the overnight memory tidy,
removing them from the household (Delete now, Delete my account, the 7-day leaving sweep), and
the audit trail's own pruning (kept whole while any hold is on). It works at the database: each
held space's database refuses deletes of chats, messages, memories and library files, whatever
code asks. Everything that deletes is listed in `DELETE_PATHS` (`src/data-rights.ts`) and tested.
A refused delete answers "This data is under a legal hold" (409). Holds and releases are audit rows
(`data.hold`). A damaged settings file holds everything until it is saved again.

## One person's data

- **Download their data:** a ZIP with, per companion, `export.json` (chats, memories, notes,
  library text; secrets scrubbed), their photos and library files, and `manifest.json` with the
  SHA-256 of every file. Only that person's space is read. Audit row `data.person-export`.
- **Delete their data** (household members only; the owner's data goes with the whole server):
  refused while they are held. Otherwise their space is stopped and deleted and you get a receipt:
  how many chats, messages, memories and files there were, that the folder and the member record are
  gone, and when. The receipt is the `data.person-delete` audit row.

## Policy pins

In the policy (Household → Policy, `policy.json`): `legalHold: true` keeps the whole-server hold
on (it can't be released until the pin goes); `personDelete: false` refuses per-person deletion.

## Not covered

Business instances keep shared workspace content without any delete path today, so nothing there
can be lost; retention and per-person export for business workspaces is BACKLOG. Backups made
before a deletion still contain the data until they rotate out (Data & health → Backups).
