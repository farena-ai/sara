# Work and teams (N7)

Shared household lists with assignees, a light client pipeline tied to invoices and quotes, and time
tracking that feeds invoices and time sheets. Everything is in chat (and two Today tiles); no new
Settings page.

## Shared lists and assignees
- Built on the household's shared boards (docs/BOARD.md): a shared list is a shared board. Only lists
  shared on purpose cross between spaces; a member sees a list after accepting the invitation, and
  never the owner's own to-dos, notes or other lists.
- `list_share` (asks first) makes or shares a list with people by name, optionally with items.
  `task_assign` gives an item to someone (or me / nobody) with an optional due time, adds the item when
  it isn't there, and `done: true` ticks it off and records who did it (`done_by`). `household_lists`
  reads them.
- The person an item is given to gets a phone/desktop notification ("Alex gave you a task") in their
  own space; taking an item yourself notifies nobody.
- Not in private chats: `list_share` and `task_assign` are left out there (they show things to
  another person).
- Today: **Shared with you** (items given to you with who and when, invitations with Accept, else
  your shared lists with open counts). Shows only once a list is shared with you.

## Clients pipeline
- A client is a People card marked as a client (relation "client"), plus a row in `work_clients` in
  the person's own store.db: stage (lead, quoted, won, invoiced, paid, lost), value, next step and
  date, hourly rate. Each household member has their own.
- `client_add`, `client_stage`, `clients_pipeline` (counts and value by stage, open value, overdue
  next steps; one client with its stage history and unbilled hours).
- Stages move by themselves from E6 (docs/BUSINESS_TOOLS.md): quote made -> quoted (value = its total,
  next step "Follow up on quote Q-..." a week later when none is set); quote accepted -> won; invoice
  made -> invoiced; invoice paid -> paid. Never backwards; a new quote or invoice for a paid or lost
  client starts a new round. An unknown client is added only once a client list exists.
- `follow_ups` also lists clients' next steps that are due or overdue.

## Time tracking
- `time_start` (one timer at a time; a running one stops first; a reminder at 10 hours),
  `time_stop`, `time_add` (date plus hours, or start and end; an end before the start runs past
  midnight; timed entries may not overlap), `time_report` (from/to, by client, project or day; xlsx,
  docx or pdf file with every entry).
- Each entry is rounded to 0.1 h (6 minutes, 3 minutes rounds up) when it ends; sums add the rounded
  entries, so reports, invoices and time sheets agree. Money stays in integer cents (E6).
- "Invoice my hours for Acme": `time_invoice` makes an invoice through `invoice_make` from the client's
  unbilled entries, one line per project (hours x the client's rate; `rate` sets and saves it), and
  marks the entries billed. Entries are held before the invoice is made, so two invoices can never
  take the same hours; billed entries can't be deleted; voiding the invoice frees them.
- Time sheet (docs/AUTOMATIONS.md): the time-sheet fill takes `source: calendar | tracked | both`.
  Tracked entries keep their times; hours-only entries follow each other from 9:00.
- Today: **Clients and hours** (running timer with Stop and a warning past 10 hours, this week's
  hours, clients by stage with values and overdue next steps). Shows only once used.
  `GET /api/work`, `POST /api/work/timer/stop` (member route group `work`).

## Files and tests
`src/work/clients.ts`, `src/work/time.ts`, `src/tools/work.ts`, `src/routes/work.ts`,
`src/shared-boards.ts` (done-by, `sharedWith`, assignment listeners), `src/biz/store.ts` (events),
`src/automations.ts` (time-sheet source), Today tiles `td-shared` and `td-worktime`.
Tests: `test/n7-work.test.ts`.
