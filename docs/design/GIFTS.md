# V2.7 Gifts and occasions (one page)

ROADMAP_V item 19. User doc: [docs/PEOPLE.md "Gifts and occasions"](../PEOPLE.md#gifts-and-occasions).

## What existed (reused, not duplicated)
- `src/people.ts`: People cards (birthday, notes, facts with `private`, `category` = sensitive,
  `pending`, `roomId`), the card's `private`/`sensitive` flags, `onWipe`/`onMerge`.
- `src/people-ties.ts` (S4): anniversaries and other yearly dates per card (`tie(id).dates`), the
  week-ahead birthday nudge on Today. Not changed.
- `src/humanize.ts`: the owner's writing style card (`writingFor(app).get().card`, `styleCardNote`).
- `src/planner.ts`: tasks, built-in projects, reminders; `src/reminders.ts` tick (no timers).
- `src/life.ts` `complete()` (background model chain, `writing` job for the card).

## What is new
- `src/gifts.ts` — per space (the space's own `store.db`, tables `gift_plans`, `gift_reminders`):
  - `occasions(person)`: birthday + the card's yearly dates, next date in the owner's time zone.
  - `ideas(personId)`: up to 5 ideas from what she knows. **Only usable facts go in**: never a
    private card (refused before any model call), never a private
    fact, a sensitive fact (health, intimate, money, legal), a pending fact or a room fact. Ideas
    over the budget are dropped. Saved on the card.
  - `card(personId, occasion)`: a short card text in the owner's writing style (style card when
    set), signed with the owner's name. Saved as a draft; never sent anywhere.
  - `toList(personId, idea)`: a to-do in the built-in Planner project **Gifts**, due a week before
    the occasion; once per idea.
  - `due(now)`: on the reminder tick (at most hourly), a Planner reminder N days (default 14)
    before each occasion of the people it applies to (family and partner by default, or anyone with
    a budget or ideas, or anyone switched on on the card); one per person + occasion + year; never
    for private cards; off with the Settings switch.
- Routes under the existing `/api/people` family (no new route group):
  `GET/PUT /people/:id/gifts`, `POST /people/:id/gifts/ideas|card|list`, `GET/PUT /people/gifts-prefs`.
- Chat tools `people_gift_ideas`, `people_gift_card` (in `PEOPLE_TOOLS`: never for outside apps or
  group chats; lean family `people` gets gift words).
- Web: a "Gifts and occasions" section on each People card (`web/gifts.js`) and a section in
  Settings → You → Briefing and reminders (switch, days before, default budget).

## Not done
- No price lookups or buying (V2.2/shopping find stays separate); ideas are text.
- No sending of the card; copy it into a message or a real card.
