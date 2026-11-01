# Today, rethought: a designed home screen on big screens and phones (design, Phases 111–112, versions 2.44.0–2.45.0)

Status: **track complete.** TD1 (Phase 111) is built in 2.44.0 and TD2 (Phase 112) in 2.45.0; see *As built (2.44.0)* and *As built (2.45.0)* at the end. Design study of 2026-10-31. This is a read-only study of the code at
2.43.0 (Phase 110 CH4 released). It is a ground-up design: no layout, schema or protocol detail is taken
from Hermes Agent, OpenClaw or any other agent. Zero new npm runtime dependencies. Every outgoing
request still goes through `src/net-guard.ts` (`netFetch`), as Google, Open-Meteo and Home Assistant do
today.

**The owner's words (2026-10-30, with a screenshot of Today):** "arrange the boxes to be more neat and
tidy while keeping the look ... feel more intentional and thought out instead of here is a bunch of
information with no organization"; the Mail tile "never has updated to show the new current
information" after a Gmail clean-up; "If there is any other boxes that would be considered great
information for this, maybe include them"; mobile "different options and look ... I will leave that
to you".

**The check recorded in ROADMAP (2026-10-30):** "the Mail tile is live (Gmail's own inbox unread count,
cached 2 minutes) and was correct; the clean-up was mostly labelling (≈3,300 emails) and archiving
already-read mail, which doesn't change the unread count, and the tile says nothing about what changed
or when it updated." §5.1 goes one step further and finds two code paths where the tile really does
stay stale.

**He loves the current look.** The dark glass cards (`.today-card`), the pink/violet accents
(`--accent-solid`, the `td-warm` and `td-code` tints), her face with the mood halo and the small line
icons stay. This track changes *where things go and what they say*, not the visual language.

**Goal:** open Today and see, in a fixed and predictable order, (1) who she is and how the day looks,
(2) the day itself as one timeline, (3) what needs you, (4) what is new with her, (5) what is
running. Every tile has a home, a size and a reason to be there. Nothing is invented, empty tiles go
away, and every number says how fresh it is.

**The rule of this track: build on what is there.** `buildToday` (`src/today.ts`) stays the source of
the day; each tile keeps its existing data source (planner, Google, memory, moments, jobs, board,
agenda, hooks, Home Assistant, model catalog). The tiles' ids (`td-*`), the deep link
(`/#view=today`, Alt+T), the "view over the chat column" `<dialog id="today">` and Today as the start
view (`web/start-view.js`) are kept. New tiles read existing stores (usage, runs, approvals, people,
rooms); the only new tables are the layout preference and the mail snapshot.

Contents: 1 what exists today · 2 the shape and shared building blocks · 3 the layout (TD1) ·
4 the tiles, one by one · 5 Mail tile 2.0 and the stale-mail bug · 6 new tiles · 7 phones and tablets
(TD2) · 8 performance · 9 accessibility · 10 per-phase scope, tables, routes and UI · 11 safety and
privacy · 12 done when · 13 owner to-dos · 14 risks · 15 blocking questions with defaults ·
16 wireframes.

---

## 1. What exists today (mapped from the code)

### 1.1 The pieces

| Piece | Where | What it does today | Matters here because |
|---|---|---|---|
| The view | `web/index.html` l. 307–347: `<dialog id="today" class="today-dialog today-view">` → `.td-scroll` → `header.td-hero` (date, greeting, `#td-her` mood line + her day line, *Plan my day with her*, *Refresh*, `#td-status`, her face `#td-face-btn` with the AI badge, *Chat* back button) → `#td-start` (Getting started checklist) → `#td-tiles` (16 `section.today-card.td-tile`) → *Ask Sara anything…* | Opened with `show()` (non-modal) over the chat column; `showToday()` marks the rest of `#chat` `inert`; Esc / Android back closes it unless something sits on top (`initToday`). | The header and the dialog stay. The tile order in the HTML is today's only "design": whatever is not hidden flows into the grid in source order. |
| The grid | `web/today.css` l. 113–122: `.td-tiles { grid-template-columns: repeat(auto-fill, minmax(min(100%, 250px), 1fr)); grid-auto-flow: row dense }`; `@container today (min-width: 600px) .td-wide { span 2 }`; `(min-width: 1100px)` → 4 columns | An auto-fill masonry: tiles are as tall as their content, `dense` back-fills holes, so a short tile jumps up beside a tall one and the order changes with the data. | **This is the owner's "bunch of information with no organization".** Rows have ragged heights, Mail can land beside Home one day and under Moments the next, and nothing groups related things. |
| The loader | `web/app.js` `loadToday(fresh)` l. 7834: `GET /api/today[?fresh=1]`, then fills greeting, date, mood, **Mail** (`#td-mail`, in app.js, not today.js), **Coming up** (`#td-dates`), **Model changes** (`#td-models`), On this day (`renderTodayMoments`), then `renderTodayTiles(d)` | `openToday()` runs `loadToday()` + `loadChecklist()`; *Refresh* runs `loadToday(true)`; the SSE `board` (2 s throttle) and `agenda` (1.5 s) events reload it; settings changes reload it (l. 7480); `ctx.refreshToday()` exists for other modules. | Three tiles are drawn in app.js and the rest in today.js: TD1 moves all tile drawing into today.js (§2.1 B2). **No SSE event reloads Today after a Gmail change** (§5.1). |
| Tile renderer | `web/today.js` (668 lines) `renderTodayTiles`: `renderDay`, `loadDoneToday` (`GET /api/planner`), `renderPlanner`, `renderBoardTile`, `ctx.renderPlans` (web/agenda.js), `renderHooksTile`, then in parallel `GET /api/today/weather`, `renderHome` (`GET /api/home/entities`), `renderMemories` (`GET /memories?kind=fact`), `renderMoments` (`GET /moments`), `renderWork` (`GET /jobs` + `GET /team`); then `renderSetup` | After `/api/today` the page makes **six to seven more requests**, each tile appearing when its own answer lands. | Each late tile pushes the masonry around: layout shift on every open (§8). |
| The day | `src/today.ts` (201 lines) `buildToday(app, {fresh})` | greeting key, local day, to-dos (due today/overdue, or undated `high`, max 12), reminders (next 24 h, max 8), calendar + mail (Google, cached 2 min in a module-level `cache` keyed `day|email`), her mood/energy/expression/day line, dates (memory `upcoming(today, 14)` + People `birthdays(today, 14)`, sensitive memories left out), running jobs, board `today()`, hooks `today()` (not for members), agenda `todayTile()`, model notices | The batch endpoint already exists in spirit: TD1 widens it (§8.1) instead of adding seven routes. |
| Route | `src/routes/planner.ts` l. 124: `GET /api/today` (+ `onThisDay` from moments; adults-only photos only with Adult mode and never in the phone apps, `fromPhoneApp(req)`); l. 134: `GET /api/today/weather` (Open-Meteo, 15-minute `weatherCache`, `{setUp:false}` without a briefing place, never on the demo) | `today` is in `DEMO_READS` (`src/server.ts` l. 335) and in the member-allowed list (`src/household.ts` l. 512). | Members get their **own** companion's `buildToday`; the demo gets the demo app. Both stay true for every new part (§11). |
| Phone widget | Phase 14 (`GET /api/today` is also the home-screen widget's source, see the comment in routes/planner.ts) | The Android/iOS widgets read the same JSON. | New fields are additive; nothing the widget reads is renamed or removed (§10.3). |
| Her panel | `web/her-panel.js` l. 385 `loadToday(force)`: top 3 of events, reminders and to-dos from `/api/today`, refreshed every 5 minutes while open | A second reader of the same JSON. | Same: additive only. |
| Phone apps | `android/app/src/main/java/com/backstagecoding/sara/MainActivity.java` (a WebView), `ios/Sara/WebView.swift` + `AppModel.swift` (WKWebView) | Both load the web app; Today is the same `web/today.js`. | TD2 is web CSS/JS plus two small native touches (pull to refresh, §7.6). |
| Mobile CSS | `web/today.css` l. 34 `overscroll-behavior: contain`; l. 295 the bottom bar with `env(safe-area-inset-*)` and `--safe-b` | One column on phones because `minmax(250px, 1fr)` only fits one. | No phone-specific order, no collapsing, no pull to refresh, no swipe rows. |

### 1.2 Every tile and its data source

| Tile (id) | Title today | Drawn by | Data | Empty → | Notes |
|---|---|---|---|---|---|
| `td-weather` | Weather | today.js `renderWeather` | `GET /api/today/weather` (briefing place, Open-Meteo, 15 min) | hidden (no place) / honest error line | Sky art (`weatherArt`), high/low, rain %, next 4 hours, sparkline. |
| `td-calendar` | Your day | `renderDay` → `dayTimeline(d)` | `d.calendar.events` (Google, today) + `d.agenda.reminders` | "Nothing on the calendar today." | Never hidden. To-dos are **not** on the timeline; leave-by times are not either. |
| `td-agenda` | Planner | `renderPlanner` | `d.agenda.tasks` + `GET /api/planner` (done today, for the ring) | "Nothing due today." | Tick → `PATCH /tasks/:id {status:'done'}`; overdue marked; top 6. |
| `td-board` | On the board | `renderBoardTile` | `d.board` (ST4: `waiting` with the question, `doing`) | hidden | "N need you" pill. |
| `td-plans` | Her plans | `web/agenda.js` l. 405 `renderPlans` | `d.plans` (ST8 `todayTile()`: reach-outs with times and reasons, goals, shared count and token budget) | hidden | Her own agenda. |
| `td-hooks` | From your webhooks | `renderHooksTile` | `d.hooks` (ST7: important *Tell me* items, "sending too much" notes, 24 h) | hidden | Owner only. |
| `td-memories` | She remembered | `renderMemories` | `GET /memories?kind=fact` → `recentMemories(list, 3)` | hidden | `td-warm` tint. |
| `td-otd` | On this day / Moments | `web/moments.js` (`renderTodayMoments`) else `renderMoments` (`GET /moments`, 4 newest photos) | `d.onThisDay` / album | hidden | `td-wide` (spans 2). |
| `td-jobs` | Running now / Working on it / Background work | `renderWork` → `workItems(jobs, team)` | `GET /jobs`, `GET /team` (owner) | hidden | Rings, *Open the chat*, *Stop*; last ended job within 12 h. |
| `td-home` | Home | `renderHome` → `pickHome` | `GET /api/home/entities?domains=light,switch,climate,lock,cover,fan` | hidden (`not-connected` → setup row) | Real switches for `canSwitch` (`src/home-switch.ts`), *Ask Sara* for locks etc.; picks saved in `localStorage['sara.today.home']` (device, not companion). Owner only, never on the demo. |
| `td-mail` | Mail | app.js `loadToday` | `d.mail` = `mailToday()`: `labels/INBOX.messagesUnread` + `is:unread is:important in:inbox newer_than:3d` (5, From/Subject) | hidden (no Gmail) | "N unread in your inbox. Looks important:" + rows. No time, no change, no link (§5). |
| `td-dates` | Coming up | app.js | `d.dates` (memory dates + People birthdays, 14 days) | hidden | A row about a person opens their card (ST6). |
| `td-models` | Model changes | app.js | `d.models` / `d.modelItems` (retired models, 3 days) | hidden | |
| `td-setup` | Add to your day | `renderSetup` → `setupItems` | weather / calendar / home not set up | hidden; *Hide* in `localStorage['sara.today.setup']` | Owner only. |
| `td-start` | Getting started | app.js `loadChecklist` | `GET /api/checklist` | hidden / *Hide* | Above the grid, not a tile. |
| (header) | greeting, mood, her day line | app.js | `d.greetingKey`, `d.owner`, `d.her` | | Her day line expands on click. |

### 1.3 What does not exist

A layout model (sections, sizes, order), equal-height rows, per-companion tile preferences (the two
saved things today are per-*device* `localStorage` keys), a single "needs you" place (approvals, failed
jobs, overdue to-dos, waiting board cards and important webhooks are spread over four tiles or not
shown at all: **pending approvals and failed runs are not on Today**), leave-by times on the timeline,
usage on Today, a "since you were away" digest, a freshness line on any tile, a refresh of Today after
a Gmail action, a phone order different from the desktop one, collapsible sections, pull to refresh,
swipe rows, and a test that Today does not shift as tiles load.

### 1.4 Code facts that change the design

1. **`forgetTodayMail()` is undone by an in-flight load** (§5.1 cause 2): `buildToday` assigns
   `cache = {...}` *after* awaiting Google, so a Today load that started before a Gmail action finishes
   writes the pre-action numbers back over the cleared cache, where they live for 2 minutes.
2. **Nothing tells an open Today that mail changed** (§5.1 cause 3). The board and her plans have SSE
   events that reload Today; Gmail does not. Today is the start view, so it is often the page left open.
3. **The masonry orders by data, not by meaning** (`grid-auto-flow: row dense`): the same Today looks
   different every time. TD1 replaces it with named sections whose order never depends on content.
4. **Seven requests per open.** Moving them behind one endpoint is the precondition for "no layout
   shift" and for phones on a slow link (§8).
5. **Tile preferences are per device.** "Saved per companion" (ROADMAP) needs a server-side store in
   the companion's own database (§10.1), with the device keys migrated once.

---

## 2. The shape

```
GET /api/today?parts=…   ──►  buildToday (src/today.ts, widened)        ──►  one JSON, every part
                                ├─ day:     agenda · calendar · leave-by · dates         (B1 timeline)
                                ├─ needs:   overdue · approvals · failed runs · board    (B3 needs list)
                                │           waiting · hooks · mail that matters
                                ├─ her:     mood · memories · moments · plans
                                ├─ work:    jobs · team · runs · board doing · projects
                                ├─ mail:    Mail 2.0 (§5)          ┐ each part has
                                ├─ weather · home · usage · away   ┘ { at, cached?, error? }
                                └─ layout:  this companion's tile prefs (B5)
web/today.js  ──►  B2 tile registry → B4 grid (sections, S/M/L, fixed slots) → tiles fill in place
```

### 2.1 Shared building blocks (built once, used by both phases)

| Block | What | Used by |
|---|---|---|
| **B1 · `dayItems(d, now)`** (pure, `web/today.js`, tested in Node) | Extends `dayTimeline`: calendar events, reminders, **to-dos with a time** (`dueAt` today), and **leave-by times** (§4.1) merged into one ordered list; all-day first; past items dimmed; a *now* marker between past and next; undated to-dos stay out (they live in Needs you or behind the Planner link). Each item keeps `kind` for its icon and its one action (tick, open event, snooze reminder). | Your day (TD1), the phone's *Now* card (TD2), her panel later. |
| **B2 · the tile registry** (`TILES` in `web/today.js`) | One record per tile: `id`, `section`, `sizes` (allowed of S/M/L), `defaultSize`, `phoneRank`, `ownerOnly`, `part` (which JSON part feeds it), `render(part, ctx)`, `isEmpty(part)`, `icon`, `title`, `tip`. The app.js-drawn tiles (Mail, Coming up, Model changes) move here. Rendering is "find slot → render into it"; nothing appends to the grid. | Every tile, the Customise sheet, the phone order. |
| **B3 · `needsItems(d)`** (pure) | One ranked list from: approvals waiting, failed runs/jobs (last 24 h), overdue to-dos, board cards waiting on you (ST4 `waiting`), important webhook items (ST7), mail that matters (Mail 2.0 `important`), reach-outs she couldn't send (ST8 `expired`), retired-model notices that need a pick. Each item: `kind`, `title`, `why`, `at`, `action` (one verb: *Approve*, *Open*, *Retry*, *Mark done*, *Pick a model*), `key` (stable, for *Not today*). Order: approvals → failed → overdue (oldest first) → board → mail → hooks → models. | Needs you (TD1), the phone's second card, *Since you were away*. |
| **B4 · the grid** (`web/today.css`) | A 12-column grid per section; S = 3 columns, M = 4, L = 6 (a full-row 12 only through the fill rule); rows `grid-auto-rows: minmax(var(--td-row), auto)` with **equal heights within a row** (`align-items: stretch`), no `dense`; tiles never reorder because of content. Breakpoints by container query on `#today` (it sits beside the sidebar and her panel, so the viewport is the wrong measure). | TD1 and TD2. |
| **B5 · tile preferences** (`today_layout` row in the companion's `store.db`, §10.1) | Per companion: section order, tile order, size, hidden, collapsed sections (phone), *Not today* keys (cleared at local midnight), `seen_at` (for *Since you were away*), Home picks. Read with `/api/today`, written with `PUT /api/today/layout`. The device keys `sara.today.home` and `sara.today.setup` are read once, sent to the server, then removed. | Customise, phones, Since you were away. |
| **B6 · freshness** (`part.at`, `freshWords(at, now)` in today.js, pure) | Every server part carries `at` (when it was read from its source) and `cached: true` if a cache served it. The tile foot shows *Updated 2 min ago* (relative, re-worded each minute, in a `<time datetime>`); past the part's own limit it says *May be out of date · Refresh*. | Mail, Weather, Calendar, Home, Usage, Runs. |
| **B7 · `todayChanged(app, part)`** (server, `src/today.ts`) | One function that clears that part's cache **and** bumps its generation counter (§5.2), then emits SSE `today {part}` to that companion's clients. Called by: Gmail organize (`#record`, and progress every 500 messages), Gmail tools that change labels/read/archive, Google sign-in/out (today's `clearTodayCache`), planner writes, approvals decided, job/run end, Home switch, Today-relevant settings. The client debounces (1.5 s) and reloads only that part (`?parts=mail`). | Mail 2.0 and every live tile; replaces the ad-hoc board/agenda reload timers in app.js. |

### 2.2 Where data lives

- **Nothing new is copied.** Tiles read the stores that already own the data: planner, memory, People,
  moments, jobs, runs, usage, board, agenda, hooks, Home Assistant, Google. The only new rows are the
  layout preferences (B5) and a tiny daily mail snapshot (§5.3).
- **Per companion.** `today_layout` and `mail_daily` live in the companion's own `store.db` (Phase 31:
  `data/companions/<id>/`). A shared planner stays shared as it is today.
- **Household members** have their own companion and so their own Today, built by `buildToday` on
  *their* app (§11).

### 2.3 Settings shape

Today's settings live on the Today page (*Customise* sheet, §3.5) and also as a *Today* card under
Settings → You → Briefing & Today, so they can be found from Settings. Every control has a `?` tip of
at most 260 characters. Stored in `today_layout` (B5), not `settings.json`: it is a view preference
of one companion and must not ride along with `OWNER_SETTINGS`.

| Setting | Control | Default | `?` tip (≤ 260) |
|---|---|---|---|
| Tile order, size, shown | the Customise sheet (↑/↓ buttons + drag handle, S/M/L pick-list, *Show* switch) | the designed layout (§3) | "Move, resize or hide any tile. Your choices are saved for this companion and follow you to every device you use her on." |
| Since you were away after | slider Off · 4 – 24 h, step 1 h | 8 h | "How long you need to be away before Today opens with a short note of what happened while you were gone. Slide to Off to never show it." |
| Needs you: include mail | switch | on | "Puts unread mail that Gmail marks important into Needs you. Turn off to keep mail only in the Mail tile." |
| Usage today: show cost | switch | on | "Shows today's estimated spend next to tokens. Local models and subscriptions always count as $0." |
| Coming up: how far | pick-list 7 / 14 / 30 days | 7 | "How far ahead Coming up looks for events, dates and birthdays." |
| Phone: when Today opens | pick-list *As I left it* / *Everything open* / *Only Now open* | *As I left it* | "What Today looks like when you open it on a phone: sections open or closed as you left them, all open, or only the Now card." |

---

## 3. The layout (TD1, Phase 111)

### 3.1 Principles

1. **Meaning decides position, not data.** Named sections in a fixed order. A tile is always in its
   section and slot; when it is empty it collapses (§3.4). A tile from another section never slides
   into its place.
2. **Rows are even.** Within a row, tiles are the same height (`align-items: stretch`); a tile with more
   than fits shows its first items and *See all (N)*. A tile never makes a row taller than its size's
   cap (`--td-max-s`, `--td-max-m`, `--td-max-l` theme tokens).
3. **Three sizes.** S (3 of 12 columns) for a number or a short list, M (4) for a list of 3–5, L (6) for
   a timeline, a photo strip or a list with actions. Each tile allows only the sizes it reads well at.
4. **One verb per row.** Each item has at most one action on the row (tick, *Approve*, *Open*); the rest
   is in the item's ⋯ menu, so the page reads calmly.
5. **Say how fresh.** Every tile that reads an outside source has a foot line: *Updated 2 min ago*.
6. **Keep the look.** `.today-card` glass, `--accent-solid` pink/violet, `td-warm` for With her,
   `td-code` for Work, the line icons and her face. Section headings are new, quiet labels
   (`.td-sec-h`: small caps, `--text-2`, a hairline rule), not new cards.

### 3.2 The sections

| # | Section | What it answers | Tiles (default size at 1440) |
|---|---|---|---|
| 0 | **Header** (not a section) | Who, when, how is she | date · greeting · her mood line and day line · face with mood halo and AI badge · *Plan my day* · *Refresh* + freshness · *Customise* · *Chat* |
| 1 | **Your day** | What does today look like? | Your day timeline (L) · Weather (S) · Coming up (S) |
| 2 | **Needs you** | What is waiting on me? | Needs you (L) · Mail (L) |
| 3 | **With her** | What's new between us? | She remembered (S) · Moments (L) · Her plans (S) |
| 4 | **Work** | What is running, and how is it going? | Running now (S) · On the board (S) · Coding projects (S) · Usage today (S) |
| 5 | **Home & more** (only when it has tiles) | The rest | Home (L) · Model changes (S) · Add to your day (one row) |

The webhooks tile folds into Needs you (§4.6). *Since you were away* (§6.5) is not a tile but a
dismissible strip between the header and Your day, shown only after the away threshold.

**Why this order.** His day is what he opens Today for (the morning briefing already leads with it).
Needs you comes second, not first, because on most opens it is short or empty and a list of problems
at the top of a home screen reads as an alarm. On phones (§7) it moves up to right after *Now*,
because a phone glance is "anything for me?". With her sits before Work because Sara is a companion
first; a coder who lives in Work moves that section up (§3.5: sections reorder too).

### 3.3 The grid at each width (container width of `#today`)

| Container | Columns | Sizes become | Typical case |
|---|---|---|---|
| ≥ 1200 px | 12 | S = 3 · M = 4 · L = 6 | 1440 desktop with the sidebar |
| 900 – 1199 | 12 | S = 4 · M = 6 · L = 12 → rows of two or three | laptop, or desktop with her panel open |
| 600 – 899 | 2 tracks | S = 1 · M = 1 · L = 2 | tablet (§7.5) |
| < 600 | 1 | one column in phone order | phone (§7) |

Each section is its own grid, so a row never mixes sections. The defaults add up to 12 per row at
1440 (6+3+3, 6+6, 3+6+3, 3+3+3+3, 6+3+3). What keeps rows tidy whatever the owner hides or resizes:

- **The fill rule** (`fillRow(spans, cols)`, pure, tested): after hiding and collapsing, tiles are laid
  into rows in order; if a row adds up to less than the column count, its tiles grow, last first, to
  the next allowed size until the row is full; if no allowed size fits, the row's tiles share it
  equally. The result is a class per tile (`td-span-3`, `td-span-4`, `td-span-6`, `td-span-12`), never
  an inline style.

### 3.4 Empty tiles

- A tile whose part `isEmpty` is `hidden`; its section re-runs the fill rule.
- A section with no visible tiles hides its heading too.
- Tiles that are empty because **they are not set up** (Weather without a place, Calendar or Mail
  without Google, Home without Home Assistant, Coding projects without a project, Usage without a
  budget) never show as empty cards: each becomes one line in a single **Add to your day** row at the
  bottom (today's `td-setup`, widened). Each line has its own *Hide*, saved in B5.
- Tiles that are empty because **there is nothing today** say so only where people look for them:
  Your day ("Nothing planned. Enjoy the space.") and Needs you ("Nothing needs you right now." with a
  small check). Every other empty tile collapses.

### 3.5 Customise: reorder, resize and hide

- **Entry:** *Customise* in the header (`sliders` icon, 44 px target) and *Customise Today* in the
  command palette. Opens the app's side sheet on desktop, a bottom sheet on phones.
- **The sheet:** one card per section (sections move ↑/↓ too); inside, one row per tile: drag handle,
  title, an **S / M / L pick-list** showing only that tile's sizes, a *Show* switch, ↑/↓ buttons
  (keyboard and touch never need drag). Each row's `?` tip says what the tile shows and where its data
  comes from.
- **Live preview:** changes apply to the page behind the sheet as you make them; *Done* saves
  (`PUT /api/today/layout`); *Reset to the designed layout* asks once and restores the B2 defaults.
- **On the page:** each tile's ⋯ menu has *Smaller*, *Larger*, *Move up*, *Move down*, *Hide this
  tile*. No free drag on the page itself (it fights scrolling and is hard to make accessible).
- **Saved per companion** (B5): Sara and a second companion can have different Todays; the layout is
  the same on every device of that companion. Phones share order and hidden but keep their own sizes
  (there are none: one column) and their *collapsed* state (§7.3).
- **Undo:** hiding a tile shows a toast *Hidden "Usage today" · Undo* for 8 s.

---

## 4. The tiles, one by one

### 4.1 Your day (L): one timeline

- **Merges** calendar events, reminders, to-dos with a time today, and **leave-by** times (B1). Leave-by
  comes from `src/leaveby.ts`: for each of today's events with a street address the server already
  works out travel time + buffer when the job runs; TD1 adds `leaveByPlan(app, events)` returning
  `{eventId, leaveAt, minutes}` for today's events (cached with the calendar part, reusing the same
  Nominatim/OSRM calls and their cache, never on the demo). Shown as a row *Leave by 2:35 · 25 min
  drive* tied under its event, with a car icon.
- **Now marker:** a thin accent line labelled *Now* between the last past and the next item; past items
  dimmed (`.past`), not removed, so the morning still reads as a day.
- **Actions:** a to-do row has its tick (as the Planner tile today); a reminder row has *Snooze 1 h*
  in ⋯; an event row opens the event's place in the Planner; *Open the Planner* in the foot.
- **To-dos without a time** stay off the timeline. Overdue ones go to Needs you; the rest stay behind
  *N more to-dos today* in the foot (opens the Planner). That retires the separate Planner tile: the
  done-today ring (`countDoneToday`) moves into this tile's head.
- **Calendar error** stays visible as one line (`d.calendar.error`), as today.
- Freshness foot: *Calendar updated 1 min ago*.

### 4.2 Weather (S)

Unchanged content (`renderWeather`); at S size the next-hours row shows 3 hours and the sparkline
sits under the temperature. Freshness foot from `weatherCache.at` (15-minute cache).

### 4.3 Coming up (S → M)

Today's `td-dates`, widened: memory dates and People birthdays (ST6, `people.birthdays`) **plus the next
calendar events after today** (one Google call, `timeMin = tomorrow`, `timeMax = +N days`,
`maxResults 10`, cached with the calendar part). Window from the *Coming up: how far* setting (7 by
default; the server already supports 14 for dates). Rows: *Tomorrow · Dentist 9:00*, *Sat · Priya's
birthday (32)*; a person row opens the card, as today. Sensitive memories stay out (`sensitiveMemory`).

### 4.4 Needs you (L)

Built from B3 (§2.1). Up to 6 rows, *See all (N)* opens a sheet with the full list. Each row: kind icon,
title, a muted *why* line (*Waiting since 9:12 · Telegram*, *Failed at 3:04 · tests*), one action
button. ⋯ → *Not today* (key saved in B5, cleared at midnight) and *Open*.

| Kind | Source | Action on the row |
|---|---|---|
| Approval | the pending-approvals list (the same one the approval cards and `POST /api/approvals/:id` use) | *Approve* / *Deny* (two small buttons: the only row with two, because that is the decision) |
| Failed job or run | `app.jobs` ended with status ≠ ok in 24 h; `app.runs` failed runs (Phase 78) | *Open* (the chat or the run) · ⋯ *Retry* where the job supports it |
| Overdue to-do | planner, `overdue: true` | tick |
| Board card waiting | ST4 `board.today().waiting` with the question | *Answer* (opens the card) |
| Mail that matters | Mail 2.0 `important` (setting *include mail*) | *Open in Gmail* |
| Webhook | ST7 `hooks.today()` | *Open* |
| Her reach-out she couldn't send | ST8 `todayTile().expired` | *Open her plans* |
| Model needs a pick | `retired-no-replacement` / `retired-auto-switch-off` notices | *Pick a model* |

The head shows the count as the existing `td-needs` pill. Empty: "Nothing needs you right now."

### 4.5 Mail (L): see §5

### 4.6 From your webhooks

Folds into Needs you (it only ever held "needs you" items). The tile id `td-hooks` stays registered but
hidden by default, so an owner who liked it separately can show it again in Customise.

### 4.7 She remembered (S/M), Moments (M/L), Her plans (S/M)

- **She remembered:** unchanged data (`recentMemories`, 3); at S size 2 items. Moved off its own request
  into the batch (§8).
- **Moments:** On this day when there is one, else the newest 4 photos, as today; L shows 4 across, M 2.
  Adults-only photos keep today's rule (Adult mode on and never in the phone apps).
- **Her plans:** today's `renderPlans` (ST8), unchanged, gets S/M sizes; at S only the next reach-out
  and the shared count.

### 4.8 Running now (S/M), On the board (S/M)

- **Running now:** `workItems` as today, plus **runs**: a one-line summary from `app.runs.stats()` for
  today (*12 runs · 1 failed*), linking to Settings → Data & health → Runs. Failed items also appear in
  Needs you; here they are only counted.
- **On the board:** keeps *Doing* only; *Needs you* cards move to the Needs you tile (one place for
  waiting things). Empty when nothing is doing.

### 4.9 Coding projects (S/M), new data on an existing idea

Per coding workspace the owner has used in the last 7 days (conversations in coding mode with a
`workspace`; `projectknow.ts` already knows them): name, **last change** (`git log -1` time and subject,
read locally, no network), **tests** (the last run's result from `app.runs` where the step ran the
project's test command, else nothing), **open PRs** (only when the GitHub tool is connected:
`src/tools/github.ts`, one `GET /repos/:o/:r/pulls?state=open` per project through `netFetch`,
cached 10 minutes, at most 3 projects). Rows open the latest coding chat in that workspace. Never for
members; never on the demo.

### 4.10 Home (M/L)

Today's tile with its switches and *Ask Sara*, plus **who's home** (`person.*` entities from Home
Assistant: name + *Home* / *Away*) and **scenes** (`scene.*`, up to 4, as pill buttons that run through
the same `canSwitch` check in `src/home-switch.ts`: a scene is "the owner pressing it", so no approval
card, but scenes are opt-in per scene in the picker because a scene can unlock or open). The picker
moves from `localStorage` to B5.

### 4.11 Model changes (S), Add to your day (row), Getting started

- **Model changes** stays as is, but notices that need a pick also appear in Needs you.
- **Add to your day:** §3.4.
- **Getting started** (`td-start`) stays above the sections until done or hidden; it is the first-run
  path, not part of the layout.

---

## 5. Mail tile 2.0 and the stale-mail bug

### 5.1 What really happened (root cause from the code)

The 2026-10-30 check was right that the number was correct: `mailToday()` reads
`labels/INBOX.messagesUnread`, and labelling ≈3,300 emails plus archiving read mail does not change how
many *unread* emails are in the inbox. But reading the code shows the tile can also be **genuinely
stale**, for three reasons that stack:

1. **The tile shows the wrong measure and no context.** One number (unread in the inbox) and up to 5
   unread-important subjects from the last 3 days. A clean-up that archives or labels changes the
   inbox *total*, the label counts and what she did, none of which the tile shows; it has no
   *updated at* line, so a correct-but-unchanged number looks frozen.
2. **A race puts old numbers back after `forgetTodayMail()`.** In `buildToday` the cache check runs, then
   `await Promise.all([calendarToday, mailToday])`, then `cache = { at: Date.now(), … }`. If a Today
   load starts before the organizer's `#record()` (which calls `forgetTodayMail()`), it reads Gmail
   *before* the change, and its assignment lands *after* the clear: the pre-clean-up numbers are cached
   for another 2 minutes, and with `at` set to the late finish time. The organizer runs as a long
   background job (thousands of ids, 1,000 per `batchModify`, `progress` every 50), and her panel polls
   `/api/today` every 5 minutes, so an in-flight load during the run is likely, not rare.
3. **An open Today is never told.** `#record()` only clears the server cache; nothing reloads the page.
   The board and her plans push SSE events that reload Today (`app.js` l. 5875, l. 5881); Gmail has no
   event. Today is the start view and is often left open on a second screen or phone, so it keeps
   showing what it loaded before the clean-up until it is reopened or *Refresh* is pressed. And
   `forgetTodayMail()` runs only at the end of a whole run (and on Undo), never during it, so a long
   run shows nothing at all until it finishes.

Two smaller facts: the cache is one module-level variable for the whole server process, keyed only by
`day|email`, so two companions connected to the same Google account share one entry (harmless for
numbers, wrong for *what she organised*, which is per companion); and `?fresh=1` from *Refresh* skips
the cache but the result is still overwritten by a slower in-flight load that started earlier.

### 5.2 The fix (TD1, in B7)

- **Generation counter.** `today.ts` keeps `gen` per part. `todayChanged(app, 'mail')` bumps it and
  clears the entry. A load records `gen` before it awaits and only writes the cache if `gen` is
  unchanged (otherwise it returns its result once, marked `stale: true`, and the client asks again).
  Tested with a fake Google that answers slowly while a change lands.
- **Cache per companion:** keyed `companionId|day|email`, held on the app (`app.todayCache`), not the
  module.
- **Tell the page.** `todayChanged` emits SSE `today {part:'mail'}`; Today (and her panel) reload that
  part after 1.5 s. Called from `#record()`, from Undo, from `#apply`'s progress every 500 messages
  (so a long run updates as it goes), and from every Gmail tool that changes labels or read state.
- **Freshness on the tile** (B6): *Updated just now* / *Updated 3 min ago*.

### 5.3 What the tile shows

```
┌ ✉ Mail ─────────────────────────── 1,204 in inbox · 37 unread ┐
│  ▼ 212 since yesterday     ▲ 4 unread since yesterday          │
│  Looks important                                               │
│   • Dana Ruiz — Contract for Friday                     9:41   │
│   • GitHub — [sara] CI failed on main                   8:02   │
│  She organised today                                           │
│   Labelled 3,312 as Receipts · Archived 418 read     [ Undo ]  │
│  Updated 2 min ago · Open Gmail                                │
└────────────────────────────────────────────────────────────────┘
```

| Line | Source |
|---|---|
| Inbox total and unread | `labels/INBOX` → `messagesTotal`, `messagesUnread` (the same call as today, one more field) |
| Change since yesterday | `mail_daily(day, total, unread, at)` in the companion's `store.db`: the first reading of each local day is kept; the tile shows today's latest minus yesterday's first. No row for yesterday → the change line is left out (no invented baseline). |
| Looks important | today's `is:unread is:important in:inbox newer_than:3d` (5), now with the time (`internalDate`) and a link to the thread (`https://mail.google.com/mail/u/0/#inbox/<threadId>`) |
| She organised today | `gmail_actions` rows of this companion since local midnight, `undone_at IS NULL`, grouped by action and label, in `ACTION_WORDS` (`labelled`, `archived`, `moved to trash`…), with each row's **Undo** calling the organizer's existing undo (the same as in chat); trash and spam rows also show the 30-day note |
| Updated | `part.at` (B6) |

Sizes: M (no *organised* list, a one-line summary *She organised 3,730 today*), L (as drawn). Errors keep
today's honest line plus *Reconnect Google* when the error is the missing `gmail.modify` scope
(`RECONNECT_TEXT`).

### 5.4 Why this answers the owner

After his clean-up the tile would have said *▼ 418 since yesterday* in the inbox total, *She organised
today: labelled 3,312 as …, archived 418 read [Undo]*, and *Updated just now*: the work is visible,
the unchanged unread number is explained by its neighbours, and the page updates while the job runs.

---

## 6. New tiles

### 6.1 Needs you (L) — §4.4.

### 6.2 Coming up (S/M) — §4.3 (next N days: events, dates, People birthdays).

### 6.3 Usage today (S)

- **What:** tokens and estimated cost today against the budget, from `app.usage` (Phase 52; the same
  local-midnight "today" the `GET /api/usage` route uses), shown as a ring (`viz.js` `ring`) with
  *142k tokens · $0.84 of $5.00*. Budget from the owner's daily budget where one is set (job budgets,
  `jobBudget`, and the per-source `budget_ledger` of STAPLES §2.1.5); without a budget the ring is
  replaced by a sparkline of the last 7 days and the foot offers *Set a daily budget*.
- **Split:** the top 3 purposes (`summary` by purpose: chat, coding, background…) as a small bar.
- Local models and subscriptions are $0 as the meter already reports them ("local", "$0 (subscription)").
- Owner only (members see their own message/cost count through `app.member.today()` in their header
  instead, §11). Not on the demo.

### 6.4 Home (M/L): scenes and who's home — §4.10.

### 6.5 Since you were away (a strip, not a tile)

- **When:** on open, if `now − seen_at ≥` the threshold (8 h by default, B5), where `seen_at` is the
  last time Today or a chat was open and visible on any of this companion's devices (updated at most
  every 5 minutes through `PUT /api/today/seen`).
- **What:** at most 5 lines built **without a model call**, from what the stores already record since
  `seen_at`: her messages that came on their own (reach-outs), jobs and runs that finished or failed,
  approvals that arrived, board cards that moved, mail she organised, memories she learned (count),
  moments added. Example: *While you were away (11 h): she sent you 2 messages · the nightly tests
  finished (1 failed) · 3 cards moved to Done · she learned 4 new things.* Each line links to its place.
- **Optional:** a one-sentence summary in her voice (a `quick` job, `source: 'today-away'`, budgeted
  from the ledger, local model preferred), off by default (§15 Q4).
- **Dismiss** (×) sets `seen_at`; it never shows twice for the same absence.

---

## 7. Phones and tablets (TD2, Phase 112)

The owner left the phone look to us. The phone is not the desktop squeezed: it answers "what now,
and anything for me?" in the first screen, and everything else is one tap away.

### 7.1 One column, in priority order

| Rank | Card | Content on a phone |
|---|---|---|
| 1 | **Now** (new, phone and tablet only) | The next 1–2 timeline items with a countdown (*Standup in 18 min*, *Leave by 2:35*), the current weather as one line (icon, temperature, *rain from 4 pm*), and her mood line. Built from B1 + weather; no new data. |
| 2 | **Needs you** | B3, top 3 rows, *See all (N)*. Hidden when empty (the Now card then shows a small "Nothing needs you" check). |
| 3 | **Your day** | The full timeline (B1), past items collapsed into *Earlier today (4)*. |
| 4 | **Weather** | The full tile (hours as a horizontal strip). |
| 5 | **Mail** | Totals, change, important (3), *She organised today* as one line + Undo. |
| 6 | **With her** | a **swipe row** (§7.2): She remembered · Moments · Her plans. |
| 7 | **Work** | a swipe row: Running now · On the board · Coding projects · Usage today. |
| 8 | **Coming up**, **Home**, Model changes, Add to your day | as tiles. |

The owner's section order and hidden tiles (B5) apply on top: hidden stays hidden; a moved section
moves. *Now* is always first and cannot be hidden (it is the phone's header line). The header itself
shrinks to one row: her face (40 px, halo), greeting, and the *Customise* and *Refresh* icons; the
date and *Plan my day* move into the Now card.

### 7.2 Swipe rows

- A section with several small tiles becomes a horizontal row of cards (`overflow-x: auto`,
  `scroll-snap-type: x mandatory`, `overscroll-behavior-x: contain`, the same pattern as
  `web/board.css` l. 39), each card 85% of the width so the next one peeks.
- Page dots under the row (`aria-hidden`), and the row is a `role="region"` with the section's name;
  each card is reachable by Tab and by the screen reader's normal swipe (no custom gestures needed to
  reach content).
- Swipe rows never hold actions that need a precise drag; a horizontal swipe on a row item never
  completes or deletes anything (no swipe-to-dismiss: too easy to trigger while scrolling the row).

### 7.3 Collapsible sections that remember

- Every section heading on a phone is a disclosure button (`aria-expanded`, 44 px tall, a chevron); a
  collapsed section shows a one-line summary in its heading (*Work · 2 running · 1 failed*,
  *With her · 3 new memories*).
- The state is saved per companion **and per form factor** (B5 `collapsed.phone`, `collapsed.tablet`)
  so closing Work on the phone does not close it on the desktop. The *Phone: when Today opens* setting
  (§2.3) overrides it.
- Needs you never collapses by itself; if the owner collapses it, the heading count still shows.

### 7.4 Pull to refresh

- **Web (mobile browsers and installed PWA):** a small pull handler on `.td-scroll` (pointer events,
  only when `scrollTop === 0`, threshold 64 px, a spinner in the header, `overscroll-behavior: contain`
  is kept so the browser's own reload does not fire). Calls `loadToday(true)` (all parts, `fresh=1`).
  Respects `prefers-reduced-motion` (no rubber-band, just the spinner).
- **Android app:** `MainActivity` hosts the WebView; it does **not** wrap it in a native
  SwipeRefreshLayout (which would reload the whole page and fight the web gesture); the web handler
  above is the one gesture everywhere.
- **iPhone app:** same: `WebView.swift` keeps `bounces` for the native feel and the web handler acts on
  the overscroll. The app's existing *Today* widget keeps reading `GET /api/today`.
- **Also refreshes:** on `visibilitychange` back to visible after more than 2 minutes, Today reloads
  parts older than their limits (no full refresh, no spinner).

### 7.5 Tablets (600 – 899 px container): two columns

Two tracks; L tiles span both, S/M take one; the Now card spans both at the top; sections keep their
desktop order (not the phone order), because a tablet is read like a page. Swipe rows are not used;
collapsible headings are.

### 7.6 The Android and iPhone apps' web views

- Same `web/today.js` and `web/today.css`; no native Today screen.
- `fromPhoneApp(req)` keeps its role: no adults-only photos in the apps.
- Safe areas: the header pads with `env(safe-area-inset-top)`, the last section with `--safe-b` (the
  bottom bar already does).
- Android back (arrives as Esc) still goes back to the chat; with a sheet (Customise, See all) open it
  closes the sheet first (`initToday` already checks for an open dialog).
- The native share sheet is not involved; *Open in Gmail* opens the Gmail app through the normal link
  handling.

---

## 8. Performance

### 8.1 One batched endpoint

`GET /api/today` becomes the only request Today makes on open. It gains the parts that today's tiles
fetch separately: `weather`, `home`, `memories` (3 newest), `moments` (4 newest or On this day),
`work` (jobs, team, runs summary), `usage`, `projects`, `needs` (approvals, failed), `mail` 2.0,
`layout`, `away`. Each part is built in parallel (`Promise.allSettled`) with its own timeout (Google
and Home Assistant 8 s, GitHub 5 s, local stores no timeout), and a part that fails or times out
returns `{error}` or is left out; the rest still arrives.

- `?parts=mail,weather` returns only those parts (used by B7 reloads and pull to refresh of one part).
- `?fresh=1` skips the caches for the parts asked.
- The old routes (`/api/today/weather`, `/jobs`, `/team`, `/memories`, `/moments`, `/home/entities`)
  stay for the rest of the app and for older clients.
- **Two-step answer for slow outside sources:** if a cached copy exists, the part is answered from it
  immediately (`cached: true`, `at`) and refreshed in the background; the SSE `today {part}` event
  then delivers the new copy. Opening Today never waits on Google when the cache is less than 15
  minutes old.

### 8.2 Caching

| Part | Cache | Cleared by (B7) |
|---|---|---|
| calendar, coming-up events, leave-by | 2 min, per companion | Google sign-in/out, calendar tools that write |
| mail | 2 min, per companion, generation counter | Gmail organize (record, progress, undo), Gmail tools that write |
| weather | 15 min (as today) | briefing place change |
| home | 30 s | a Home switch |
| projects (git, PRs) | 10 min | a coding turn that commits |
| usage, runs, jobs, needs, board, agenda, memories, moments | none (local SQLite reads, cheap) | — |

### 8.3 No layout shift

- **Fixed slots.** The section skeleton and every tile's slot are drawn from the layout (B5) before any
  data arrives, at their final size, with a skeleton body (`.td-skel`, a quiet shimmer that stops
  under `prefers-reduced-motion`). With one batched answer most tiles fill in one paint.
- **Collapse after, not during.** A tile that turns out empty is collapsed once, when the batch has
  arrived; slots for parts that come later via SSE are not removed until they answer.
- **Cached layout.** The last layout and the visible-tile set are kept in `sessionStorage`, so the
  second open of the session draws the right skeleton at once.
- **Targets:** first paint of the skeleton < 100 ms after open; batch answered < 300 ms on the owner's
  server with warm caches; CLS 0 on reload with cached parts (measured by the UI test with a
  `PerformanceObserver` on `layout-shift`).
- **Payload:** text only; photos are the existing thumbnails; the JSON stays under ~40 KB.

---

## 9. Accessibility

- **Landmarks and order.** Each section is a `<section aria-labelledby>` with an `h2` (`.td-sec-h`);
  tiles keep their `h3`. DOM order = visual order at every width (the phone order is produced by
  rendering in that order, never by CSS `order`), so reading and Tab order match what is seen.
- **Targets.** Every control at least 44 × 44 px (ticks, Approve/Deny, ⋯, section toggles, swipe-row
  cards, size pick-list); the ⋯ menu is a real menu button (`aria-haspopup="menu"`).
- **Keyboard.** Customise works fully with ↑/↓ buttons; on the page, a focused tile accepts
  `Alt+↑/↓` to move and `Alt+←/→` to resize (announced: *Usage today moved to Work, position 2*).
  Alt+T, Esc and the shortcuts keep working.
- **Live updates.** SSE reloads update quietly; only counts that change in Needs you are announced
  through one polite live region (*1 new item needs you*), at most once per 30 s. Freshness words are
  not live.
- **Charts.** Rings and sparklines have text equivalents (as `ring({label})` already does); the mail
  change uses words and ▲/▼ with text, never colour alone.
- **Motion and contrast.** Skeleton shimmer, pull spinner and swipe snapping respect
  `prefers-reduced-motion`; the glass cards keep text at 4.5:1 on their darkest blur (checked against
  the theme tokens in each built-in theme); `forced-colors` gets borders on cards.
- **Language.** All new strings through `t()` in the 6 languages; times by `locale()`; relative times
  by `Intl.RelativeTimeFormat`.

---

## 10. Per-phase scope, tables, routes and UI

### 10.1 Tables (additive, the companion's `store.db`)

```sql
CREATE TABLE IF NOT EXISTS today_layout (
  id INTEGER PRIMARY KEY CHECK (id = 1),      -- one row per companion database
  prefs TEXT NOT NULL,                        -- JSON: {sections:[...], tiles:{id:{size,hidden,order}}, collapsed:{phone:[],tablet:[]},
                                              --        notToday:{day, keys:[]}, home:{entities:[],scenes:[]}, setupHidden:[], awayHours, ...}
  seen_at TEXT,                               -- Since you were away
  version INTEGER NOT NULL DEFAULT 1,         -- for later layout migrations
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_daily (
  day TEXT NOT NULL,                          -- local YYYY-MM-DD
  email TEXT NOT NULL,                        -- which Google account
  first_total INTEGER NOT NULL, first_unread INTEGER NOT NULL, first_at TEXT NOT NULL,
  last_total INTEGER NOT NULL,  last_unread INTEGER NOT NULL,  last_at TEXT NOT NULL,
  PRIMARY KEY (day, email)
);
```

`prefs` is validated on write (known tile ids, allowed sizes, at most 64 entries, strings ≤ 64
chars); unknown ids are dropped, so tiles added later get their default slot. `mail_daily` keeps 30
days (pruned on write). No other new tables.

### 10.2 Routes

| Route | Phase | What |
|---|---|---|
| `GET /api/today?parts=&fresh=` | TD1 | widened batch (§8.1); every part with `at`; additive fields only |
| `PUT /api/today/layout` | TD1 | save `prefs` (validated); answers the normalised prefs |
| `DELETE /api/today/layout` | TD1 | reset to the designed layout |
| `PUT /api/today/seen` | TD1 | `seen_at = now` (rate-limited to once a minute per device) |
| `POST /api/today/needs/:key/not-today` | TD1 | add a key to today's *Not today* list |
| SSE `today {part}` | TD1 | B7, on the existing event stream |
| — | TD2 | no new routes; `collapsed.phone/tablet` go through `PUT /api/today/layout` |

All under the existing auth; members reach them on their own companion (`today` is already in the
member list, `src/household.ts` l. 512; the new paths are added beside it). On the demo the reads work
on demo data and the writes answer 403 like other demo writes.

### 10.3 Compatibility

The JSON keeps every field the phone widget and her panel read (`greeting`, `greetingKey`, `owner`,
`day`, `date`, `agenda`, `calendar`, `mail.unread`, `mail.important`, `her`, `dates`, `jobs`, `board`,
`hooks`, `plans`, `models`, `modelItems`, `onThisDay`). New data is in new keys (`mail.total`,
`mail.change`, `mail.organised`, `mail.at`, `parts`, `layout`, `needs`, `away`…).

### 10.4 UI (both phases)

- **Files:** `web/today.js` (registry, renderers, pure helpers `dayItems`, `needsItems`, `fillRow`,
  `freshWords`, `awayLines`, `phoneOrder`); `web/today-layout.js` (new: Customise sheet, ⋯ menus, the
  save/undo); `web/today.css` (sections, spans, skeleton, phone/tablet); `web/index.html` (section
  skeleton; the tile `section`s keep their ids). app.js keeps only `openToday`/`loadToday` wiring.
- **UI rules:** cards for every tile and every Customise row; pick-lists for sizes and choices;
  sliders for the away threshold; a `?` tip (≤ 260 chars) on every setting; **no inline styles** (spans
  are classes, colours are theme tokens: `--accent-solid`, `--surface-3`, `--text-2`, `--hairline`,
  `--r-control`); 44 px targets; checked at 1440 and 390.

### 10.5 Scope by phase

**TD1 · Phase 111 · 2.44.0 — Today on a big screen.** B1–B7; the five sections and header; the
12-column grid, S/M/L, fill rule, empty collapse, Add to your day row; Customise (reorder, resize,
hide, sections, reset, undo) saved per companion with the device keys migrated; Your day timeline with
to-dos and leave-by; Needs you; Mail 2.0 with the race fix, per-companion cache, SSE refresh,
`mail_daily`, *She organised today* + Undo, freshness; Coming up (next N days with birthdays); Usage
today; Home with scenes and who's home; Coding projects; Since you were away (no model); the batched
endpoint, caches and no-layout-shift skeleton; accessibility (§9) on desktop. Phones keep working in
one column in the desktop order (no regressions), nothing more.

**TD2 · Phase 112 · 2.45.0 — Today on phones and tablets.** The Now card; the phone order; swipe rows
for With her and Work; collapsible sections with per-form-factor memory and the *when Today opens*
setting; pull to refresh (web, Android and iPhone apps); refresh on return; the compact header; tablet
two columns; the bottom-sheet Customise; safe areas and back behaviour in both apps; accessibility on
phones (VoiceOver and TalkBack passes as owner checks).

---

## 11. Safety and privacy

- **Each person sees only their own Today.** `buildToday` runs on the app of the companion being
  viewed; a household member's request is served by *their* companion (`app.member`), with their own
  planner (or the shared planner only if the owner chose a shared one), memories, moments, layout and
  mail snapshot. Owner-only parts are left out on the **server**, not hidden in CSS: `hooks` (already),
  `home`, `usage` (members get `app.member.today()` in their header instead), `projects`, `needs`
  kinds *approval* / *failed run* / *webhook* / *model*, `away` lines about jobs and runs, and the
  Add-to-your-day lines for Google, Home Assistant and budgets. Tests assert the JSON, not the DOM.
- **Partner, group and room data never reach the owner's Today** unless designed here:
  - partner conversations (`partner IS NOT NULL`), Telegram/Discord groups and CH4 room logs, room
    summaries and room memory are **not** sources for any tile, for Needs you or for Since you were
    away;
  - the one designed exception: *Since you were away* may count "she answered in 2 rooms" (a number and
    the room titles from `rooms`, never lines, names or summaries), and only when the owner turns on
    *Include rooms* (off by default, §15 Q5);
  - an approval raised in a work room shows with its own text (that is the owner's approval card, as in
    chat) and the room's title, nothing else from the room;
  - People birthdays come from the owner's cards only; facts from room people (CH4 §7.8) are not dates
    on Today.
- **Sensitive and adult content.** `sensitiveMemory` stays out of Coming up; adults-only photos follow
  today's rule (Adult mode on, never in the phone apps, never on the demo); private/off-record
  conversations never feed She remembered or Since you were away.
- **Mail.** Subjects and senders are shown only to the owner, only for the Google account that
  companion connected; *She organised today* reads only this companion's `gmail_actions`; Undo uses
  the organizer's existing undo path and its approval rules (trash/spam stay *always ask*).
- **Home.** Scenes and switches run only through `canSwitch` (`src/home-switch.ts`); locks, alarms,
  doors and anything not switch-safe keep *Ask Sara* and the approval rule; scenes are opt-in one by one.
- **The demo** reads demo data only; no Google, Home Assistant, GitHub, usage or layout writes.
- **No new outgoing hosts** except GitHub's API for PRs, already used by `src/tools/github.ts`, and only
  when that tool is connected. Everything through `netFetch`.
- **The safety layer** (`src/safety.ts`) is untouched; the optional away summary is a normal `quick`
  call through the usual path and never writes memory.

---

## 12. Done when

### 12.1 `test/phase111.test.ts` (TD1, plus the existing suites green, including `today.test.ts`, `ui-today.test.ts`, `ui-start-today.test.ts`)

1. `dayItems` merges events, reminders, timed to-dos and leave-by rows in time order, all-day first,
   past flagged, undated to-dos excluded; a leave-by row follows its event.
2. `needsItems` ranks approvals → failed → overdue → board → mail → hooks → models; *Not today* keys
   are dropped; the list is empty for a member's request on the owner-only kinds.
3. `fillRow` fills every row to the column count for any mix of hidden tiles and sizes at 12, 8 and 2
   columns, and never emits a span a tile does not allow.
4. Layout: `PUT /api/today/layout` validates (unknown ids dropped, bad sizes rejected, size cap),
   round-trips, is per companion (two companions keep different prefs), `DELETE` resets; the old
   `sara.today.home` / `sara.today.setup` device keys migrate once and are removed.
5. **Stale-mail race:** with a fake Google that answers slowly, a Today load started before an
   organizer `#record()` does not leave pre-change numbers in the cache; the next load reads Gmail
   again; `?fresh=1` is never overwritten by an older in-flight load.
6. **Mail refresh:** an organize run emits SSE `today {part:'mail'}` at the end, on Undo and at least
   every 500 messages of a long run; a Gmail tool that changes labels does too.
7. Mail 2.0 JSON: `total`, `unread`, `change` only when yesterday's `mail_daily` row exists,
   `organised` grouped from today's not-undone `gmail_actions` of this companion, `at`; the cache key
   includes the companion.
8. Batched `/api/today`: one request returns every part; a part whose source throws or times out
   returns `{error}` and the others still arrive; `?parts=` limits the work done (fakes count calls).
9. Compatibility: every field the phone widget and her panel read is still present with the same type.
10. Coming up lists events for the next N days (7 by default), memory dates and People birthdays, with
    sensitive memories left out.
11. Usage today: tokens and cost since local midnight match `GET /api/usage`; local and subscription
    calls are $0; the part is absent for members and on the demo.
12. Home: who's home from `person.*`, scenes only when picked, a scene press goes through `canSwitch`;
    the part is absent for members and on the demo.
13. Coding projects: last change from git, tests from runs, PRs only with GitHub connected (fake
    `netFetch`), nothing for members.
14. Since you were away: shown only past the threshold, lines built from the stores with no model call,
    never includes partner, group or room content (rooms only as a count with *Include rooms* on),
    dismiss sets `seen_at`.
15. Privacy: a member's `/api/today` has no `hooks`, `home`, `usage`, `projects`, owner-only needs kinds
    or owner mail; partner conversations and room logs never appear in any part (seeded with
    recognisable text and searched for in the JSON).
16. UI (DOM test at 1440): the five section headings in order; tile spans are classes, no `style=`
    attributes in Today; every Customise setting has a `?` tip ≤ 260 chars; controls ≥ 44 px; no
    layout shift (CLS 0) after the batch arrives with cached parts; empty tiles collapse and the *Add to
    your day* row lists the not-set-up ones.

### 12.2 `test/phase112.test.ts` (TD2)

1. `phoneOrder(layout)` puts Now first, then Needs you, Your day, Weather, Mail, then the owner's
   section order; hidden tiles stay hidden; DOM order equals visual order.
2. At 390 px: one column, the compact header, With her and Work as swipe rows with scroll-snap and
   region labels, every card reachable by Tab.
3. Section collapse is saved per companion and per form factor; collapsing on a phone does not collapse
   on desktop; the *when Today opens* setting overrides it; Needs you shows its count when collapsed.
4. Pull to refresh: a pull past 64 px at `scrollTop 0` calls `loadToday(true)` once; not at
   `scrollTop > 0`; reduced motion shows only the spinner.
5. Return refresh: visibility back after > 2 min reloads only parts past their limit.
6. At 768 px: two tracks, L tiles span both, desktop section order, no swipe rows.
7. Phone app requests (`fromPhoneApp`) never get adults-only photos; Esc/back closes an open sheet
   before leaving Today.
8. 44 px targets and no inline styles at 390 and 768; the existing Today suites stay green.

---

## 13. Owner to-dos

- **TD1:** open Today at 1440 and say whether the section order feels right (§15 Q1); run a Gmail
  clean-up of a few hundred emails and watch the Mail tile change while it runs and show *She
  organised today* with Undo; pick Home scenes if you want them; set a daily budget if you want the
  Usage ring; connect GitHub if you want PRs on Coding projects.
- **TD2:** on your phone (web and the Android app; iPhone when you have one at hand): pull to refresh,
  collapse Work and check it stays collapsed only on the phone, swipe the With her row; a quick
  TalkBack/VoiceOver pass on the Now card and Needs you.

---

## 14. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | The batched endpoint becomes slow because one source is slow | Per-part timeouts, `allSettled`, cached-then-refresh with SSE (§8.1). |
| 2 | Equal-height rows hide content | *See all (N)* on every list tile; the size caps are tokens the owner can live with; L allowed where lists get long. |
| 3 | The fill rule surprises (a tile grows unexpectedly) | Deterministic and tested; Customise shows the result live; *Reset* is one tap. |
| 4 | Needs you becomes a nag | Only real items; *Not today*; second place on desktop; no badges outside Today. |
| 5 | GitHub PR calls cost rate limit | 10-minute cache, at most 3 projects, only when connected. |
| 6 | Mail counts look wrong because Gmail's label counters lag a few seconds after `batchModify` | The SSE reload waits 1.5 s; the freshness line shows when it was read; *Refresh* is always there. |
| 7 | Moving app.js tiles into the registry breaks the phone widget or her panel | Additive JSON only (§10.3) and a compatibility test. |
| 8 | Pull to refresh conflicts with the WebViews' native bounce | One web gesture everywhere; no native SwipeRefreshLayout; tested in both apps by the owner. |
| 9 | Since you were away leaks room or partner content | It is built from an allow-list of stores; partner and room stores are not on it (test 111.14/15). |
| 10 | Layout prefs from an older version break a newer Today | `version` column, unknown ids dropped, defaults for new tiles. |

---

## 15. Blocking questions (with the defaults we build if there is no answer)

| # | Question | Default |
|---|---|---|
| Q1 | Section order on desktop: Your day → Needs you → With her → Work, or Needs you first? | **Your day first**, Needs you second; Needs you moves to second on phones after Now. |
| Q2 | Should the separate Planner tile go away now that to-dos are on Your day and in Needs you? | **Yes**, folded in; the done-today ring moves to Your day; *Open the Planner* stays in the foot. |
| Q3 | Since you were away: after how long? | **8 hours**, slider 4–24 h with Off. |
| Q4 | Should the away note have a one-sentence summary in her voice (a small model call)? | **Off**: the note is built from the records with no model call; a switch turns her sentence on. |
| Q5 | May Since you were away mention rooms she answered in (count + room titles only)? | **No** until you turn on *Include rooms*. |
| Q6 | Home scenes on Today without an approval card? | **Yes for scenes you pick** one by one; everything else keeps Ask Sara and approvals. |
| Q7 | Coming up: 7 days, and include calendar events (not just dates and birthdays)? | **7 days, events included**; pick-list 7/14/30. |
| Q8 | Phone: does Today open with sections as you left them? | **As I left it**; options *Everything open* / *Only Now open*. |

---

## 16. Wireframes

### 16.1 Desktop, 1440 px (sidebar open, her panel closed; Today's container ≈ 1180 px → 12 columns)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Saturday, October 31                                                       ╭──────╮  ‹ Chat  │
│ Good morning, Frank                                                        │ face │          │
│ ● Sara  Feeling playful, rested. · "Baking day — and that Halloween list." ╰──────╯ AI comp. │
│ [ Plan my day with her ]   ⟳ Refresh · updated just now        ⚙ Customise                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ While you were away (11 h): she sent you 2 messages · nightly tests finished (1 failed) ·  × │
│ 3 cards moved to Done · she learned 4 new things                                             │
├ YOUR DAY ────────────────────────────────────────────────────────────────────────────────────┤
│ ┌ ▦ Your day ───────────── ◔ 2/5 ┐ ┌ ☀ Weather ── Austin ┐ ┌ ♥ Coming up ───────────┐        │
│ │ all day  Halloween              │ │  ☀  74°  Clear       │ │ Tomorrow  Dentist 9:00 │        │
│ │  8:30  ✓ Feed the cat (to-do)   │ │  H 79° · L 58°       │ │ Mon  Priya's birthday  │        │
│ │ ─ Now ─────────────────────     │ │  ╱╲_╱  rain 10%      │ │ Wed  Car service       │        │
│ │ 10:00  Standup · Meet           │ │ 11  12   1   2       │ │ Fri  Our anniversary   │        │
│ │  2:35  🚗 Leave by · 25 min     │ │ 75° 77° 78° 79°      │ │                        │        │
│ │  3:00  Dentist · 401 Main St    │ │ updated 6 min ago    │ │ next 7 days            │        │
│ │  6:00  🔔 Carve pumpkins        │ └──────────────────────┘ └────────────────────────┘        │
│ │ 3 more to-dos today · Planner   │                                                          │
│ └─────────────────────────────────┘   (L = 6 cols)       (S = 3)                 (S = 3)    │
├ NEEDS YOU ───────────────────────────────────────────────────────────────────────────────────┤
│ ┌ ! Needs you ─────────────────── 4 ┐ ┌ ✉ Mail ─────────────── 1,204 inbox · 37 unread ┐    │
│ │ ⚑ Run `git push` on sara?          │ │ ▼ 212 since yesterday · ▲ 4 unread             │    │
│ │   Telegram · 9:12  [Approve][Deny] │ │ Looks important                                │    │
│ │ ✕ nightly tests failed · 3:04      │ │  Dana Ruiz — Contract for Friday        9:41   │    │
│ │                           [ Open ] │ │  GitHub — CI failed on main             8:02   │    │
│ │ ◷ Renew passport · overdue 2 d [✓] │ │ She organised today                            │    │
│ │ ▤ "Pick a host" · board  [Answer]  │ │  Labelled 3,312 Receipts · Archived 418 [Undo] │    │
│ │                                    │ │ updated 2 min ago · Open Gmail                 │    │
│ └────────────────────────────────────┘ └────────────────────────────────────────────────┘    │
├ WITH HER ────────────────────────────────────────────────────────────────────────────────────┤
│ ┌ ✿ She remembered ┐ ┌ ✦ On this day · 2 years ago ─────────────┐ ┌ ⌖ Her plans ────────┐     │
│ │ You like rye      │ │ [photo] [photo] [photo] [photo]          │ │ 4:00 check in about │     │
│ │ bread toasted     │ │                                          │ │ the dentist         │     │
│ │ Priya moved to    │ │                                          │ │ 1 of 3 today        │     │
│ │ Denver            │ │ Open our moments                         │ │                     │     │
│ └───────────────────┘ └──────────────────────────────────────────┘ └─────────────────────┘     │
├ WORK ────────────────────────────────────────────────────────────────────────────────────────┤
│ ┌ ⚙ Running now ──┐ ┌ ▤ On the board ─┐ ┌ </> Coding projects ┐ ┌ ◔ Usage today ──┐         │
│ │ ◠ refactor auth  │ │ Doing            │ │ sara · 2 h ago      │ │   ╭──╮ 142k tok │         │
│ │   since 9:40     │ │  Docs pass       │ │ tests ✓ · 2 PRs     │ │   │17%│ $0.84   │         │
│ │ 12 runs · 1 fail │ │  Hub schema      │ │ frankweather · 1 d  │ │   ╰──╯ of $5.00 │         │
│ │ [Open] [Stop]    │ │                  │ │ tests ✕ · 0 PRs     │ │ chat ▇▇ code ▇  │         │
│ └──────────────────┘ └──────────────────┘ └─────────────────────┘ └─────────────────┘         │
├ HOME & MORE ─────────────────────────────────────────────────────────────────────────────────┤
│ ┌ ⌂ Home ── Frank: home · Ali: away ─────────────┐ ┌ ↻ Model changes ┐ ┌ (Add to your day) ┐  │
│ │ [Movie night] [Bedtime]                         │ │ gpt-x retired;  │ │ + Connect GitHub  │  │
│ │ ◉ Kitchen  on   ○ Porch off   🔒 Front locked  │ │ chat now uses … │ │   for PRs   Hide  │  │
│ └─────────────────────────────────────────────────┘ └─────────────────┘ └───────────────────┘  │
│                                  [ Ask Sara anything… ]                                      │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 16.2 Phone, 390 px (TD2)

```
┌──────────────────────────────────┐
│ (face) Good morning, Frank  ⚙ ⟳ │   compact header, 44 px icons
├──────────────────────────────────┤
│ NOW                     Sat 31   │
│ Standup in 18 min · Meet         │
│ 🚗 Leave by 2:35 for Dentist     │
│ ☀ 74° clear · rain from 4 pm     │
│ ● Sara: playful, rested          │
│ [ Plan my day with her ]         │
├──────────────────────────────────┤
│ ▾ NEEDS YOU · 4                  │
│ ⚑ git push on sara?              │
│              [Approve] [Deny]    │
│ ✕ nightly tests failed   [Open]  │
│ ◷ Renew passport · 2 d     [✓]   │
│ See all (4)                      │
├──────────────────────────────────┤
│ ▾ YOUR DAY                       │
│ Earlier today (2)            ▸   │
│ ─ Now ─────────────              │
│ 10:00 Standup                    │
│  2:35 🚗 Leave by                │
│  3:00 Dentist                    │
│  6:00 🔔 Carve pumpkins          │
├──────────────────────────────────┤
│ ▾ WEATHER   74° · H79 L58        │
│ 11 ·12 · 1 · 2 · 3 · 4 →         │
├──────────────────────────────────┤
│ ▾ MAIL   1,204 · 37 unread       │
│ ▼212 since yesterday             │
│ She organised 3,730    [Undo]    │
│ updated 2 min ago                │
├──────────────────────────────────┤
│ ▾ WITH HER                       │
│ ┌──────────────────────┐┌──      │  swipe row (85% cards)
│ │ She remembered       ││ On     │
│ │ You like rye bread … ││ this   │
│ └──────────────────────┘└──      │
│            ● ○ ○                 │
├──────────────────────────────────┤
│ ▸ WORK · 1 running · 1 failed    │  collapsed, remembered
├──────────────────────────────────┤
│ ▸ COMING UP · 4 · HOME           │
└──────────────────────────────────┘
  [ Today ][ Chat ][ Planner ][ … ]    bottom bar (existing)
```

---

## As built (2.44.0)

Phase 111 (TD1) follows this design with the §15 defaults (Q1 Your day first, Q2 the Planner tile
folded in and hidden, Q3 8 h, Q4 no model call, Q5 no rooms in the away note, Q6 picked scenes only,
Q7 7 days with events, Q8 *As I left it*, stored for TD2). User guide: [../TODAY.md](../TODAY.md).

**Where it lives.**
- `src/today-layout.ts`: the server's tile registry (same list as `web/today.js` `TILES`), the
  `today_layout` row (one per companion database: prefs JSON, `seen_at`) and the `mail_daily` table
  (first and last inbox reading per local day and address, for the *since yesterday* line). Prefs are
  validated on write: unknown tile ids are dropped, a size a tile doesn't allow is a 400, at most 64
  entries, `awayHours` is clamped to 0 or 4–24, and `comingDays` must be 7, 14 or 30.
- `src/today.ts`: `buildToday(app, {parts, fresh, demo, phoneApp, loaders})`, the one batched answer.
  Each part runs in parallel with its own timeout (9 s for Google, weather and Home Assistant; 6 s for
  projects) and reports `parts[name] = {at, cached?, stale?, error?}`. `?parts=a,b` limits the work.
  Google parts are cached for 2 minutes on the app (`app.todayState`, keyed by
  `companionId|day|email`), and each part has a **generation counter**. `todayChanged(app, part)`
  bumps the counter, drops the entry and publishes SSE `today {part}`. A load that started before a
  change answers once, marked `stale`, and never writes its older numbers into the cache, so `?fresh=1`
  is never overwritten by an older read.
- `src/today-parts.ts`: the parts read from other stores (She remembered, Moments, Running now, Usage
  today, Home, Coding projects, Needs you, Since you were away, Rooms).
- Routes (`src/routes/planner.ts`): `GET /api/today[?parts=…][&fresh=1]`; `GET|PUT|DELETE
  /api/today/layout`; `PUT /api/today/seen` (at most once a minute per device); `POST
  /api/today/needs/<key>/not-today` (*Not today* keys, cleared at local midnight). Writes are refused on the demo.
- Web: `web/today.js` (registry, fill rule, renderers, live parts), `web/today-layout.js` (Customise
  sheet, ⋯ menus, Alt+arrow moves and resizes, drag in the sheet, 8 s Undo after Hide, Reset),
  `web/today.css` (sections, the 12-column grid through container queries on `#today`: S/M/L = 3/4/6
  columns from 1060 px, 4/6/12 from 840 px, two tracks from 560 px, one below), and `sw.js` v45.

**The stale Mail tile (§5.2).** `GmailOrganizer` takes an `onChange` option (no import of `today.ts`,
so there is no cycle). `main.ts` passes `gmailTodayHook(app)`, which calls `todayChanged(app,'mail')`.
It fires at each recorded change, every 500 messages of a long run (`TODAY_EVERY`) and on Undo, from
Today or from the `gmail_undo` tool. The page reloads `mail` and `needs` 1.5 s after the event. Google
sign-in and sign-out clear every companion's Today cache. In the live run (fake Gmail on loopback),
Today stayed open while she archived 3,300 promotions and labelled 3,300 receipts. The tile went from
*4,513 in inbox* to *1,213* and showed *Labelled 3,300 as Receipts* about 3 s after approval, with no
reload. While Today is open, a chat reload waits until you leave Today, so a turn that finishes no
longer pulls Today away.

**Open points checked.**
1. *Which route lists pending approvals?* None does. Approvals live only in the running turns
   (`ctx.active` → `turn.approvals`, which the `ApprovalBroker` fills), and the client learned of them
   from SSE `turn` events. Needs you reads them from `ctx.active` in the Today route, and `server.ts`
   publishes `today {part:'needs'}` whenever an approval is added or settled.
2. *Are Gmail organizer action records per companion?* Yes. `gmail_actions` is created in the
   `store.db` passed to `GmailOrganizer`, which `main.ts` builds once per companion app (never for
   members or the demo). *She organised today* is therefore per companion, while the inbox counts come
   from the shared Google account and the cache key carries the companion id.

**Owner decision (2026-11-01): the Rooms tile.** This overrides the rule that no room data appears on
any tile, for this one opt-in tile only. *Rooms* (section *With her*, sizes S/M/L) summarises the
Discord channels and Telegram groups with *Keep up with this room* on: the current topic
(`currentTopic` from CH4's rolling summary, or the topic words of the last lines when there is no
summary yet; no new model calls), who spoke in the last 3 hours, the last activity, and **Peek**,
which opens the room window. It is off by default. The owner switches it on in *Customise → Show
the Rooms tile* and can pick rooms there (all of them when none are picked). It is shown only to the
owner on the main companion, never to household members, in the demo or on another companion. Rooms
with keep-up off never appear, and a forgotten room disappears. Nothing from the tile goes into memory
or other parts. Sara has no shared or kiosk view, so that rule has nothing to apply to yet; if one is
added, it must leave out this part. Tests: `111.R` in `test/phase111.test.ts`.

**Deviations and leftovers.**
- *Since you were away* has no optional one-sentence summary in her voice and no *Include rooms*
  switch yet (Q4 and Q5 defaults are Off, so nothing is lost). Both are left for TD2.
- Phone behaviour (Now card, collapsible sections, `collapsed.phone`) is TD2. At 390 px the TD1 page
  stacks to one column and stays usable. The phone preference (Q8) is stored and has a ? tip, but
  nothing reads it yet.
- The away line counts proactive, reminder and job messages from her, finished jobs, new memories,
  new moments and organised emails. Partner and room conversations are never sources of any part
  except the opt-in Rooms tile.

## As built (2.45.0)

Phase 112 (TD2) follows §7 with the §15 defaults (Q4 her sentence **off**, Q5 rooms **off**, Q8 *As I
left it*). User guide: [../TODAY.md](../TODAY.md) → *Phones and tablets*, *Since you were away*.
Tests: `test/phase112.test.ts` (112.1–112.8 as in §12.2, plus 112.N the Now card and 112.A the away
note's two switches).

**Where it lives.**
- `web/today.js`: `formFactor`, `phoneOrder`, `collapsedAtOpen`, `pullTracker`, `returnParts`,
  `escAction`, `nowItems`, `rainFrom` (pure, tested in Node); `applyLayout` draws three ways. The
  form factor is decided by the screen and Today's own width: **phone** when the screen is 600 px or
  less (a narrow desktop window gets it too), **tablet** on a touch screen whose Today content is
  narrower than 840 px (an iPad beside the sidebar), otherwise the TD1 desktop. A `ResizeObserver`
  redraws when it changes (a turned tablet, her panel opening).
- Phones: the tiles move into `#td-pg-<group>` sections built by appending in `phoneOrder`, so the DOM
  order is the visual order (no CSS `order`). Groups: `needs`, `day`, `weather`, `mail` (one tile
  each: the heading names it and the tile's own title is kept for screen readers), then the owner's
  order of `her`, `work` and `more` (Coming up joins Home & more). With her and Work become swipe rows
  only with two cards or more: 85% cards, `scroll-snap-type: x mandatory`, a `role="region"` named
  after the section, decorative dots and **‹ ›** buttons (the visible, keyboard and screen-reader way
  to move); no row action is a swipe. An empty Needs you is hidden on a phone; the Now card says
  *Nothing needs you right now.* Needs you shows its top three there.
- The Now card (`#td-now`, class `.td-nowcard`: `.td-now` is the timeline's Now marker) shows on
  phones and tablets: the next two timeline items by time with *in N min* / *Now:* / *at* /
  *Leave by … for …*, the weather in one line with the first wet hour, her mood line, and on a phone
  the date and *Plan my day with her* (the button node moves there and back).
- Collapsing: headings become 44 px disclosure buttons on phones and tablets (plain headings on the
  desktop). `prefs.collapsed.phone` / `.tablet` go through `PUT /api/today/layout` (no new route);
  the server accepts the sections plus the phone's `weather` and `mail` groups. Reset keeps them (it
  restores tiles, not what is folded). The *Phone: when Today opens* setting applies on each open:
  *Everything open*, or *Only Now open* (everything folded except Needs you, which never folds by
  itself). A folded heading shows a one-line summary; Needs you always shows its count.
- Pull to refresh: touch events (passive) on `.td-scroll`, armed only at `scrollTop` 0, let go when
  the page scrolls or the finger moves sideways, refresh once past 64 px (`loadToday(true)`), never
  twice while one runs. The spinner follows the finger in eight `data-step` classes (no inline style)
  and only shows, without travel, under reduced motion. Neither phone app wraps the web view in a
  native pull (`MainActivity` and `WebView.swift` are unchanged; the test checks).
- Return refresh: back to a visible Today after more than two minutes reloads only the parts older
  than `PART_LIMIT` (Google parts 2 min, home 30 s, weather 15 min, projects 10 min, local parts 5 min).
- Since you were away, the two TD1 leftovers: *Away note: include rooms* (`awayRooms`) adds
  `{kind:'rooms', n, titles}` from `room_lines` where she spoke since `seen_at` (owner, main companion,
  never members; titles only); *Away note: a sentence from her* (`awayVoice`) starts one `cheapCall`
  (`source`/`purpose` `today-away`, a local model first, then the quick route, 6 runs and 6,000 tokens
  a day) with the counted facts only, never waits for it, keeps it per absence and publishes SSE
  `today {part:'away'}`; it never writes memory. Both have **?** tips; translations in all five
  languages; help.html has *Today on a phone or tablet* and *Away note*.
- `web/sw.js` v46.

**Fixed on the way.** The tile foot's ` · ` separators used the class `td-dot` (the timeline's dot), so
they drew as small circles; they are `td-sep` now. At 320–430 px nothing in Today is wider than the
screen (checked live on every element at 320, 360, 390 and 430 px, swipe rows aside since they
scroll inside themselves); the TD1 note of a scroll area 4 px wider than the screen at 390 px no
longer reproduces with the phone layout. On touch screens every foot link, mail row and job button is
44 px; the compact header's face is 44 px (the design said 40) so it meets the target rule.

**Deviations.**
- The design's tablet band was "600–899 px of container"; a portrait tablet beside the sidebar has
  ~510 px, so tablets are detected by a touch screen and Today narrower than 840 px instead, and two
  tracks are forced there. A desktop window of the same width keeps the desktop Today.
- The pull gesture uses touch events rather than pointer events: pointer events are cancelled as soon
  as the browser starts its own scroll, touch events keep coming in both web views.
- The phone's single-tile groups keep the tile's ⋯ menu in a slim row at the top of the card.

**Owner checks (TD2).** On your phone (web and the Android app; the iPhone when at hand): pull to
refresh, fold Work and check it stays folded only on the phone, swipe the Work row, turn on *Away note:
a sentence from her* and see the sentence after an absence; a quick TalkBack/VoiceOver pass on the Now
card and Needs you.

**Track complete.** Both phases of this design are built; anything further goes to the backlog.
