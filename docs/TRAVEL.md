# Travel assistant (S6)

Bookings in your email become one itinerary per trip. Sara reminds you to check in, says when to leave
for the airport, tells you about delays, gate changes and cancellations, and lists rebooking options.
**She never books, changes or pays for anything.**

## What you get

- **Trips page** (sidebar → Trips, or `#view=trips`): each trip as a timeline: flights, rental car,
  hotel, train rides and event tickets, in order. Every time is shown in its own place's time zone
  ("Mon, Nov 23, 5:30 PM MST" for a flight leaving Denver), with confirmation codes and the latest flight
  status.
- **Today tile "Trips"**: the next trip (two weeks ahead) or the one under way, with what comes next.
- **Add to calendar**: one tap puts every booking of a trip in your connected calendar (through the same
  `calendar_add` tool that reads each event back). Nothing is added on its own; a booking already added
  (here or from an accepted inbox card) is skipped.
- **Check-in reminder** 24 hours before each flight, with a link to the airline.
- **Leave-by alert** for the airport, from the existing leave-by reminders (your home, travel mode and
  buffer in Settings → You → Leave-by reminders): you are at the airport 2 hours before a flight, 3 for an
  international one. Without a leave-by home there is no leave-by alert.
- **Flight status alerts** to your phone: delays of 15 minutes or more, back on time, the gate and gate
  changes, diversions, cancellations. Close to departure (6 hours) they come even in quiet hours.
- **Rebooking options** after a cancellation or a delay of 2 hours or more: the airline's own site (to
  change or rebook), the next flights on the same route when the status source knows them, and a reminder
  that a seat on the airline's next flight is usually free after a cancellation. You choose with the
  airline; she only lists options.
- **Packing list**: one tap makes a shared list ("Packing: Trip to Denver", Planner → Boards) from the
  trip's nights, what the bookings need (passport and power adapter abroad, driver's license with a car,
  event tickets) and the forecast at the destination when the trip is within 16 days (Open-Meteo, free, no
  key; cold, rain, snow, heat). Share it from the board like any shared list.
- **In chat**: `trip_list` (your trips) and `trip_status` (one trip in order, with a fresh status check
  for flights in the next 48 hours). Both only read.

## Flight status sources

No flight status source is free without a key, so status is **off** by default. The Trips page →
Flight status has a provider slot:

- **AirLabs** (airlabs.co, free plan): sign up yourself, paste your API key, choose AirLabs. The key is
  stored in this space's vault (`data:airlabs`), never in chats, logs or the page. Sara checks only flights
  leaving in the next 36 hours: every 30 minutes, every 10 minutes in the last 6 hours, at most 3 checks
  per tick. Its answer is the flight's current or next run; another day's run is ignored.
- Without a source you still get the timeline, check-in and leave-by alerts.

No paid source is used, and none is signed up for you.

## Design (one page)

- **Where bookings come from.** The N3 inbox helper already reads new mail in every connected mailbox
  (src/inbox/helper.ts, on the reminder tick, at most every 10 minutes, per-mailbox cursor). Its classifier
  (src/inbox/classify.ts) gained rental cars (JSON-LD `RentalCarReservation` and plain-text pick-up /
  return lines), trains (`TrainReservation` / `BusReservation`, "Train 512 from … to …") and per-flight
  times in a multi-flight plain-text mail. After classifying a mail, the helper hands its findings to
  `app.travel.observe()`. The inbox's own trip card (accept → reminders + calendar) is unchanged.
- **Engine** `src/travel.ts` (`Travel`, tables `travel_trips`, `travel_bookings`, `travel_kv` in each
  space's own store.db). A booking's key is its kind + number/confirmation + local date, so the same flight
  forwarded to a second mailbox is one booking (both mailboxes are listed). A newer mail about the same
  booking updates it. A booking joins the trip with the same confirmation, else a trip it overlaps
  (36 hours either side), else (a flight home) the trip whose first flight left from where it lands; event
  tickets only join a trip, they never start one.
- **Time zones.** JSON-LD times carry their offset. A plain-text wall time is read in its airport's zone
  (a built-in table of large airports, src/travel-places.ts); hotel, car, train and event times without an
  offset use the trip's destination zone (where its first flight lands, or the car's airport), else yours.
- **The tick** (`Travel.due` from `ReminderScheduler.tick`, no timer): flights leaving in the next
  36 hours get check-in, status checks and leave-by (`LeaveByWorker.planFor` with the airport as the
  place). Check-in and leave-by are skipped for a flight whose accepted inbox trip card already set those
  reminders. Alerts go to the trip's own chat ("Travel", channel `travel`) and to the phone (push).
- **Privacy.** Private local mode: no status or forecast requests and nothing to the phone. Household
  members have their own trips (their own mailboxes, tables and keys); routes `/api/trips` are a member
  route group. Private chats are never read; travel alerts live in their own chat. Email text is data.
- **Never books or pays.** No tool or route books, changes or pays; rebooking options are links and
  words. Calendar and packing list run only on the person's tap.

Routes: `GET /api/trips`, `PUT /api/trips/settings`, `GET|PATCH|DELETE /api/trips/:id`,
`POST /api/trips/:id/calendar|packing|check`. Tests: `test/s6-travel.test.ts` (fixture mails in
`test/travel-fixtures.ts`: three airlines, a hotel, a car, a train, an event; fake status source, fake
clock).

## Limits

- The AirLabs adapter follows its documented v9 `flight` and `schedules` answers; it was not run against
  the live service (no key on the build machine).
- Airline links are known for about 20 large airlines; others get a web search for "<airline> manage
  booking".
- Trips that overlap or touch are merged only through the rules above; renaming is on the route
  (`PATCH /api/trips/:id {title}`), not yet on the page.
