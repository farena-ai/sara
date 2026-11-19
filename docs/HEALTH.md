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

## Imports from a watch or phone app (V4.3)

Under **Trends from your watch or phone** on the Health page, pick a file and press **Import**:

| From | The file | What she reads |
|---|---|---|
| Apple Health (iPhone) | Health → your picture → Export All Health Data → `export.zip` (or the `export.xml` inside) | steps, sleep, heart rate, resting heart rate, weight |
| Google Fit | takeout.google.com → only Fit → the `.zip` | daily steps, average heart rate, weight (`Daily activity metrics.csv`), sleep sessions (`All Sessions`) |
| Garmin | Garmin Connect on the web: a steps, sleep or weight report exported as CSV, or `.fit` files (a zip of them works too) | steps, sleep, resting heart rate, weight; from `.fit`: steps and heart rate (monitoring files), weight (scale) |

- She keeps **one value per measurement and day** (a weighing keeps its own time): steps per day,
  hours asleep per night (the night belongs to the day you woke up), the day's average heart rate,
  resting heart rate, weight. Apple's phone and watch both count steps: the day takes the bigger of the
  two, not the sum. Overlapping sleep from two sources counts once; in-bed time counts only when a night
  has no asleep time.
- **Importing the same file again adds nothing.** A newer export adds only the new days (and updates a
  day that was still going when the older export was made). A day another app already gave stays as it
  was. Weight follows the unit you already use (lb or kg).
- **Trends**: a card per measurement with the newest value, the 7-day average, the change against the
  week before and a chart of the 30 days up to the newest value. Hand-logged sleep and weight count too.
  Imported days stay out of the hand-logged list; the doctor summary shows them as one line per
  measurement (days, average, lowest, highest).
- **Undo import** removes what that import added.
- The file is read in memory on this server and **never kept**; only the daily values are saved, sealed
  like every other record. Nothing is sent anywhere.

## Caregivers and Simple home (V5.4)

- **Daily check-in** (Health → Daily check-in, or Simple home → Check in): one tap a day: I'm OK,
  Not great or I need help. The latest answer of the day counts.
- **Caregivers** (Health → Caregivers): pick an adult in your household and what they may see:
  *Missed doses* (doses still open two hours after their time, the last 7 days, and today's
  taken/skipped/open counts) and/or *Check-ins* (your answers of the last 7 days). Nothing else:
  never your chats, symptoms, mood, readings, appointments or notes. Children can't be caregivers,
  and only you add, change or stop sharing.
- **People you care for** (Health, for the caregiver): only what each person shared, read from their
  own encrypted log every time. Stop sharing hides it at once.
- **Notices**: a missed dose tells caregivers with dose consent once on their phones ("Bo has a dose
  not marked taken.", no medicine name, quiet hours respected); I need help tells caregivers with
  check-in consent right away.
- **Simple home** (Health → Simple home → Open Simple home, or `#view=simple`): four big buttons:
  Talk with Sara, Medicines (today's due doses with a big Taken button), Check in and Call family
  (the people you list under Simple home, one-tap `tel:` links). "Open Simple home when Sara starts
  on this device" is that phone or computer's own switch.
- The consent list and the people to call are sealed in your own health log like every other record.
  Design: docs/design/V5CARE.md.

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
- **Imports (V4.3)** `src/health-import.ts` (pure readers, no disk, no network): `readHealthExport(name,
  buf, {tz})` sniffs zip / FIT / Apple XML / Google session JSON / CSV and returns `{source, readings}`
  (`{metric, day, at?, value, unit}`). Apple `export.xml` is scanned straight from the bytes (`<Record `
  tags only; real exports can be bigger than a JS string); zips are read with `src/library/zip.ts` (caps:
  1.5 GB per entry, ratio 400). CSV columns are matched by header words (date/steps/sleep/heart rate/
  resting/weight; max/min/goal/score columns are skipped); dates in ISO, US, `Nov 5, 2026`, `5 Nov 2026`
  and `05.11.2026` forms. FIT: definition + data messages, compressed timestamps, `timestamp_16`;
  monitoring (55) cycles as cumulative steps for walking/running and heart rate, record (20) heart rate,
  weight_scale (30). `HealthLog.importReadings` stores entries with `imp` = `metric@day` (weight
  `weight@<minute>`), `src` and `batch` inside the sealed data, in one transaction; an `import` row per
  file that changed something (`removeImport` = Undo). `trends()` feeds the page and `health_read`.
  Route `POST /api/health-log/import?name=` (raw body, 512 MB cap; a child is refused by
  `childRouteCheck`), `DELETE /api/health-log/imports/:id`; `GET /api/health-log` adds `trends` and
  `imports` and lists hand-logged entries only.

Not built (yet): sleep from Garmin `.fit` files and Garmin's JSON data export (use its CSV reports),
non-English Google Takeout column names, blood pressure/glucose imports, a Today tile, editing a medicine in place (remove and add again), reminders by weekday
in the page (the store supports `days`), quick add of temperatures in °C without the unit (read as °F).
Earlier chat messages that logged health stay in that chat's history: use a private chat (local models
only) for health talk if you also use cloud models.
