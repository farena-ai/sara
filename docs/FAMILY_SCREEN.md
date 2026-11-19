# Family screen (W4.5)

A tablet on the wall or in the kitchen that shows the household's day and lets kids talk with Sara
safely. It builds on Family (R8 chores and kid-safe mode, U4.21 meals, rota and family calendar,
the shared grocery lists) and adds no new family data of its own.

## Set it up

1. On your phone or computer: Settings → Household → People on this server → **Family screen**.
   Give the screen a name (for example "Kitchen") and press **Make a pairing code**.
2. On the tablet, open `https://<your Sara address>/family-screen` and type the code.
   The code is a **one-time code**: it works once, for 10 minutes.
3. The tablet now has its own key. Add the page to the tablet's home screen and leave it open.

Each paired screen is listed in the same section: rename it by removing and pairing again, set its
night hours, turn the Talk button off, or remove it (it is signed out at once).

## What it shows

- **Today**: the approved family events for today and tonight's dinner. Private events (yours or
  anyone's "just me" events) and events a kid suggested that a parent hasn't approved never show.
- **Chores**: what is due today, per person, with big buttons. Tapping one marks it done for that
  person; as in Family, a kid's mark waits for a parent's OK. Points show, money never does.
- **Dinners this week**: the next seven days from the meal planner.
- **Shopping list**: the first shared grocery list. Tap to add, tap an item to tick it, or press the
  microphone and say it (only when this server has its own hearing set up).
- **Coming up**: family events still to come today, and your own reminders due today only if you
  turn on **Show my reminders** for that screen (off by default).
- **Talk**: a big kid-safe Talk button (see below).
- **Night**: between the screen's night hours (default 21:00 to 06:30, your time zone) the screen
  dims and Talk rests. A tap wakes it for a minute.

## Kid-safe Talk

- Never any tools from the screen: no computer use, no shopping, no money, no mail, no outside apps.
- Pick a kid's name: the turn runs in **that kid's own space**, so their daily limits, bedtime,
  age band and her tone for kids apply exactly as in their own app. The talk is saved in their own
  chats (titled "Family screen"), where their parents' usual summary sees topics, never words.
- **Everyone**: the turn runs off the record in the owner's space: an in-memory chat that is not in
  anyone's chat list, no memory, adult mode off, and her rules for a child aged 6 to 9.
- Asks about adult topics, buying, paying, cards, banks, passwords or game money get a kind "ask a
  grown-up" without any model. Crisis words still get the crisis help.
- Hearing goes to this server's own hearing (never the browser's cloud speech); her answer is read
  aloud by the tablet's own voice.

## Security

- The screen's key (`fs_…`) is kept on the server only as a SHA-256 hash in
  `<data>/family-screens.json`. It is sent in the `x-family-screen` header, never as a sign-in, so
  every other route (chats, memory, settings, money, Family's own pages) answers 401 to it.
- Wrong codes are limited per address (10 tries per 10 minutes). At most 10 screens.
- The screen reads only household things (family events, chores, dinners, the grocery list); it
  can't read or list anyone's chats, memories, People cards or money.
- Only the owner makes codes and manages screens (`/api/family/screens`).

## For developers

- `src/family-screen.ts`: `FamilyScreens` (codes, tokens, prefs), `screenBoard`, `screenTalk`,
  `familyScreenRoutes` (answered in `src/server.ts` before sign-in). Owner routes ride the `family`
  family in `src/routes/family.ts`.
- `FamilyAccess.appOf` (main.ts) gives a person's own main app for the kid Talk turn;
  `TurnOptions.kidSafe` gives the off-the-record turn the kid note and turns adult mode off.
- Page: `web/family-screen.html|js|css`; Settings section: `web/family-screens.js`.
- Tests: `test/w4-family-screen.test.ts`.
