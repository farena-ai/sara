# Car and house upkeep (V2.6)

Settings → You → My details → **Car and house upkeep** (a section right under My details): oil changes,
tire rotations, filters, gutters and smoke alarms on a schedule, with a reminder on the day, a service
history, and a "book it" errand.

## What already existed (reused, not copied)

| Piece | Where |
| --- | --- |
| Your cars (make, model, year) | My details vehicles (`src/my-details.ts`). The car box offers them; any other name works too ("Work truck"). |
| Reminders | Planner reminders (`src/planner.ts`), delivered by the normal `ReminderScheduler.tick`. No new timer. |
| Receipts | V2.2 Purchases (`src/money/purchases.ts`) already reads receipt mail and receipt photos. Upkeep only looks at that list. |
| Booking | The errands `book` template (`src/errands.ts`): find places near you, compare, ask for a booking, stop before anything is sent without your OK. |

## How it works

- **Add the car schedule** / **Add the home schedule** adds the usual jobs from a small built-in table
  (`UPKEEP_TABLE` in `src/upkeep.ts`; general US guidance, the reason shown under each job). The car
  list has oil, tires, engine and cabin air filters, brakes, wipers and the battery. The home list has
  the furnace/AC filter, gutters, testing smoke and CO alarms (monthly, as the US Fire Administration
  advises), smoke alarm batteries, a heating and cooling tune-up, the water heater and the dryer vent.
  Adding a schedule a second time adds nothing twice. **Your own job** adds anything else, every N months
  and/or N miles.
- **Next due**: the last time it was done (or the day you added it, so nothing is overdue on day one)
  plus the interval. For a car the job is due at the miles *or* the months, whichever comes first. Miles
  become a date from your **odometer** readings (and miles typed with a service): miles a day between the
  earliest and latest reading of the past year, at least two weeks apart. Until then, about 12,000 miles a
  year is assumed.
- **Reminder**: each job keeps one Planner reminder at 9 AM local on its due day ("Oil change (2019 Honda
  Civic) is due around 45,000 miles (about December 4, 2026)…"). It moves when the date moves (a log, new
  miles), is not made again after it has been delivered for the same date, and **Reminders off** cancels it.
- **Logging resets the next due**: **Done today**, or **Log with details** (date, miles, cost, note). An
  older date is kept as history; the newest date drives the schedule. A miles number lower than the last
  reading is refused (a typo guard).
- **From receipts**: purchases whose item or store reads like a job on your list ("Synthetic oil change",
  "Gutter cleaning"; up to 400 days back) show under *Found in your receipts* with **Log it** (date, cost and
  store from the receipt) or **Not this**. Each receipt is offered once.
- **Book it** (jobs a shop does; not for do-it-yourself jobs like testing alarms) starts a `book` errand
  with the service and the due date as its deadline, and opens Errands.
- **Chat**: `upkeep_list` ("when is my oil change due?") and `upkeep_log` ("I changed the furnace filter
  today") in the lean `details` family. They are never on the demo.

## Data and privacy

Everything is kept in each person's own `store.db` (`upkeep_items`, `upkeep_log`, `upkeep_miles`,
`upkeep_skip`). Household members have their own list, and nothing leaves the server. Routes
(`src/routes/my-details.ts`, the existing `my-details` family):

- `GET /api/my-details/upkeep` returns `{cars, items, found, odometer, table}`
- `POST /api/my-details/upkeep/setup | add | miles | skip`
- `POST /api/my-details/upkeep/:id/log | remind | book | remove`

## Limits

- The table is general guidance, not your car's manual: change an interval by removing the job and
  adding your own, or just log it when you do it.
- Miles only, not kilometers.
- Receipts are matched by words; a receipt with only a shop name ("Joe's Garage") is not matched.
