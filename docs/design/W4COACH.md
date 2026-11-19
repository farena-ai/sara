# W4.4 Health coach (private)

ROADMAP_W W4.4: "Trends from imports plus the log become gentle weekly goals; never medical advice;
caregiver view optional."

## What existed (reused, not duplicated)
- U4.22 Health log (`src/health-log.ts`): sealed per-space sqlite (AES-256-GCM), medicines, doses
  taken/skipped, mood/sleep/measurements, `NOT_ADVICE` banner, words hidden from reports.
- V4.3 imports (`src/health-import.ts` + `HealthLog.importReadings/trends`): steps, sleep, heart rate,
  weight per day from Apple/Google/Garmin.
- V5.4 caregiver mode (`src/caregiver.ts`): consent per caregiver (doses, check-ins), view built in
  code on every request, withdraw hides at once, adults only.
- W1.2 nudge gate (`src/nudges.ts`) via `postAlert` (`src/destinations.ts` FEEDS).
- Weekly slot pattern of W1.5 her week (first look records the slot; late slots are not sent).

## What W4.4 adds (`src/health-coach.ts`, `web/health-coach.js`)
- **Your week** card at the top of Health: sleep, steps, weight, mood and medicines marked taken for
  the 7 days up to today against the 7 before, all computed in code from the person's own log. No
  model is ever called: nothing about the week reaches any model, local or cloud.
- **Gentle goals**: at most two, small, from a fixed table (mark each dose, a little more sleep, a
  few more steps, log mood). Accept or Not now. An accepted goal runs 7 days and shows "3 of 4 days".
  Never a weight goal, never a medicine change.
- **Red flags** (fixed thresholds: blood pressure, pulse/heart rate, glucose, temperature, very short
  sleep, a 5% weight change in a week, very low mood or "I need help", a symptom 8/10 or more): that
  measurement shows only "Talk to your doctor about …": no number, no comparison, no goal.
- **Wording rules**: every coach line lives in `COACH_TEXTS`; `test/w4-coach.test.ts` refuses advice
  words (diagnose, treat, dose changes, "normal", "risk", …) and checks every red-flag line.
- **Weekly check-in**: opt-in (`HealthSettings.coach`, Settings → You → What Sara knows → Health log
  and the card's own switch). Sundays 18:00 local, through `postAlert(app, 'healthcoach')` and the
  nudge gate. The post never carries a value or a medicine name ("Your week in Health is ready"), so
  chat apps, phone notices and later model turns see nothing private.
- **Caregiver share**: a third consent, "Weekly summary", on the existing grant. The caregiver sees
  the summary without mood and with red flags reduced to "worth a word with a doctor". Withdrawing
  works like the other consents.
- **Who**: the owner and each adult member, each from their own sealed log. Kids never (403, no card,
  no check-in).

State: accepted/skipped goals are sealed in the same health log (`kind = 'coach'`).

Routes (inside the existing `health-log` family, so no household-isolation churn):
`GET /api/health-log/coach`, `POST /api/health-log/coach/goals/:id {action: accept|skip}`;
the switch rides `PUT /api/health-log/settings {coach}`.
