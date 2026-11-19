# V5.4 Caregiver mode (one page)

## What existed
- `src/health-log.ts` (U4.22): each person's own sealed health log (AES-256-GCM per space), medicines
  with dose reminders, a taken/skipped log; `kidHealth` + `parentView()` (a parent sees a child's
  medicines and doses, never symptoms or mood).
- `src/family.ts` `FamilyAccess`: `people()`, `spaceDirOf(id)`, `notifyPerson(id, …)`, `quietFor`.
- Easy mode (`src/everyday-settings.ts`): text size, Night/Day, voice by asking. Talk with Sara (U4.24).
- Nothing for adults caring for adults: no consent, no check-ins, no simplified home.

## What V5.4 adds (extends the health log; no new store, no new route group)
- **Consent lives with the person cared for.** `HealthLog.care()` (sealed, kind `care`) keeps
  `grants: [{ person, doses, checkins, since }]` and `contacts: [{ name, phone }]`. Only the person
  adds or withdraws a grant (Health → Caregivers). A caregiver is an adult in the same household
  (never a child, never yourself).
- **Daily check-in.** `HealthLog.checkIn('ok' | 'notgreat' | 'help')`, one row per day (the latest
  counts), sealed like every other record.
- **Caregiver view = code, not a model.** `careViewOf(app, personId)` opens the person's log, finds the
  grant for the asking person and returns only the consented parts: `doses` (missed doses of the last
  7 days, today's taken/skipped/open counts) and `checkins` (last 7 days). Never chats, symptoms,
  mood, readings, appointments or notes. The grant is read on every request, so withdrawing it
  hides everything at once (the next request answers 403).
- **Notices.** On the reminder tick, a dose still open 2 hours after its time tells each caregiver
  with dose consent once ("Kim has a dose not marked taken.", no medicine name on a lock screen);
  "I need help" tells caregivers with check-in consent right away.
- **Simple home.** A body-level full-screen page (`#simple-home`, `#view=simple`) with four big
  buttons: Talk, Medicines (today's due doses with big Taken buttons), Check in (OK / Not great /
  I need help) and Call family (`tel:` links to the people the person listed). "Open Simple home
  when Sara starts" is this device's own switch (like text size).

## Routes (inside `/api/health-log`, already a member route)
- `GET  /care` → `{ grants, contacts, checkins, people, caringFor: [{ id, name }] }`
- `PUT  /care/grants` `{ person, doses, checkins }` (both false = withdraw) · `DELETE /care/grants/:person`
- `POST /care/checkin` `{ status }` · `PUT /care/contacts` `{ contacts }`
- `GET  /care/of/:person` → the consented view, 403 without consent

## Acceptance
- A caregiver sees only consented items (tests: keys per grant, no symptom/mood/med notes leak).
- Withdrawing consent hides them at once (next GET 403, `caringFor` empty, no more notices).
