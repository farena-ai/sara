# Health: a private, local-only health log (U4.22)

Sara keeps your own health log: medicines with dose reminders, appointments, symptoms, mood, sleep and
readings like blood pressure. It is **your log, not medical advice**: she never diagnoses, and every view,
answer and summary says so.

## Using it

Open **Health** in the sidebar (or under More).

- **Quick add**: type a reading as you would say it, or tell her in a chat: `headache 6/10`,
  `mood 7/10`, `slept 7h`, `BP 128/82`, `weight 172 lb`, `glucose 104`, `pulse 72`. The same works in
  Spanish, French, German, Portuguese and Italian (`dolor de cabeza 6/10`, `Blutdruck 128/82`).
- **Medicines**: name, dose, times of day (24-hour, `08:00, 20:00`) and, if you like, how many you have.
  At each time your phone gets a reminder; mark the dose **Taken** or **Skipped** (a reminder that came
  up shows under *Doses due*). With the number on hand she estimates when you will run out and shows the
  refill date in red when it is a week or less away.
- **Readings and symptoms**: the last 90 days, with a small chart per reading.
- **Appointments**: questions to ask, notes after the visit, and **Add to calendar** (an `.ics` file for
  your own calendar app; nothing is sent anywhere).
- **Doctor summary**: pick dates and **Make PDF**: medicines with taken/skipped counts, readings,
  symptoms, mood, sleep and appointments, made by the document maker on this server.
- **A child's medicines** (parents): pick a child to add or remove their medicines and reminders and see
  their doses. Their own symptoms and mood stay theirs. A child sees their medicines and marks doses.

## Privacy (Settings → You → What Sara knows → Health log)

| Switch | Default | What it does |
|---|---|---|
| Let a cloud model read my health log | off | Off: only a local model on this server reads the log. Logging works either way; with a cloud model she logs and says "Logged in Health." without repeating the numbers. |
| Include health when I ask from a private chat | off | Ask about anything searches the log, and only from a private chat. |
| Dose reminders on my phone | on | A notice at each dose time. |
| Show the medicine name in reminders | off | Off: "Time for a dose" (no names on a locked screen). |

Always, whatever the switches:
- The log lives in **your own space** (`<your space>/health-log/`); each household member has their own,
  and nobody else can open it in Sara (a parent sees a child's medicines and doses only). Whoever runs
  the server has the files and the key on disk, as with everything else on it.
- Every record is **encrypted at rest** (AES-256-GCM) with your space's own key (`health.key`, mode 0600).
- Chat messages that logged or read health are marked and **never become memories** and never show in
  Ask about anything's chat results.
- **Support reports, hub reports, remote-help reports and fix recipes** hide your medicine names, symptom
  names, appointment titles and any reading-shaped text (`BP 128/82`).
- **Other apps, outside requests and group chats** never get the health tools; kids' chats don't either.

## Design (one page)

- **Store** `src/health-log.ts`: `HealthLog.open(spaceDir)` → `<space>/health-log/health.db` (node:sqlite,
  one `items(kind, at, data)` table; `data` is sealed JSON; only kind and date are clear). Kinds: `med`,
  `dose`, `appt`, `entry`, `settings`. One instance per folder in the process (owner companions share it).
  The owner's folder comes from `FamilyAccess.spaceDirOf('owner')`, a member's is their own data folder.
- **Reminders**: `healthTick(app, now)` on `ReminderScheduler.tick` (no timers); each dose time in the
  last 6 hours that has no dose row gets one `due` row and one push (`notifyOwner`, tag `health-dose`).
  Nothing is created for spaces without a log.
- **Refill**: `supply − taken doses since refilledOn × perDose`, divided by doses per day.
- **Quick add** `parseQuick()`: symptoms with a 0–10 score, mood, sleep, BP, weight, glucose, pulse,
  temperature (six languages).
- **Doctor PDF**: `summaryMarkdown()` → `makePdf()` (src/documents/pdf.ts), never saved to the Library.
- **Chat** `src/tools/health-log.ts`: `health_log` (always logs; echoes values only to a local model or
  an allowed cloud model; marks the person's message `meta.health`) and `health_read` (refuses with an
  explanation unless `ctx.modelLocal` or `cloudOk`). Listed in `PEOPLE_TOOLS` (never outside/other apps/
  groups); not in `KID_TOOLS`; lean family `health`.
- **Exclusions**: `src/health-terms.ts` keeps each open log's words; `scrubText` (src/hub.ts) calls
  `hideHealth`, so support/hub/remote-help/fix-recipe text is covered in one place. `withoutHealth()`
  drops marked exchanges before the memory model sees a transcript; Ask's chat source skips them; Ask's
  `health` source runs only from a private chat with `includeInAsk`.
- **Routes** `/api/health-log` (src/routes/health-log.ts), a member route group, not audited (audit rows
  would name health things); a child may only GET and mark doses (src/family.ts).
- **Web** `web/health.js` (the place, charts as inline SVG with theme colors) and the four switches on
  Settings → You → What Sara knows.

Not built (yet): a Today tile, editing a medicine in place (remove and add again), reminders by weekday
in the page (the store supports `days`), quick add of temperatures in °C without the unit (read as °F).
Earlier chat messages that logged health stay in that chat's history: use a private chat (local models
only) for health talk if you also use cloud models.
