# Performance: long chats stay smooth

Long coding chats (hundreds of messages, many tool steps) used to feel start-stop in the web app,
worst in Firefox: frames took 70-170 ms, a button press could take a third of a second to show, and
opening a window put a blurred "fog" over a page that was already struggling. The server was never
the problem (p95 12 ms per request); the cost was all in the page. This note says what was slow, how
it was measured and what keeps it fast. Numbers: `outputs/perf/BEFORE.md` and `AFTER.md` (local, not
in git).

## How it is measured

A throwaway server with a scripted model builds a 304-message coding chat (30 turns, each with file
reads, a file write, two terminal runs and a long Markdown reply: 446,000 characters). Playwright
drives it at 1440 px in Firefox and Chromium (headless): it streams new turns at about 40 tokens a
second and, while she streams, types, opens and closes run cards and opens Settings and the command
bar. It records the frame times (`requestAnimationFrame`), input-to-next-frame latency, long tasks
(Chromium), how long a window takes to show, DOM size, JS heap and event listeners, and whether
anything covers the chat. A Chromium trace with style-invalidation tracking says what the main
thread spends its time on.

Headless Firefox composites in software, as Firefox does on many Windows PCs: it shows the cost of
the decoration plainly.

## What was slow, and what changed

| Cause | Measured | Change |
|---|---|---|
| Glass blur (`backdrop-filter`) on the header, sidebar, composer and her panel, over a page that moves (her orbs, the light field, streaming text) | Firefox: every change re-blurred the panels, ~60 ms a frame; removing the blur rules took frames from 63 ms to 6 ms | **Settings → Appearance → Glass blur**: *Auto* (default) is off in Firefox and on elsewhere; *On* / *Off* pick it. Off keeps the colors with slightly more solid panels (`web/smooth.js` `glassPlan`, `html[data-glass]` in `web/polish.css`). |
| Three window-sized aurora layers drifting at full frame rate under the glass, beside the V4 light field | Firefox idle: 69 ms frames; with the aurora still: 6 ms | V4 palettes hold the aurora still; the light field (a quarter-size canvas) is the one moving layer, at 10 frames a second (15 while she works). Sara Classic keeps its drift. |
| Page-wide `:has()` selectors (`html:has(dialog:modal)`, `body:has(#today[open])`) | Chromium: every DOM change re-checked them and invalidated every button and icon (13,500 button invalidations in 8 s of streaming); style work 2.6 s of 8 s | `html.modal-open` (set by `watchModal`) and `html.today-open` classes instead. Style work: 0.7 s of 8 s. |
| A face orb per reply, each animating at 30 fps; a layout read per orb per frame; her state written to `<html>` on every activity event; a recolour (computed style read) on every `<html>` attribute change | Firefox: 40 ms frames from the orbs alone | Only the newest reply's face and the header orbs move (earlier faces hold a still frame); sizes come from a `ResizeObserver`; state and labels are written only when they change; recolour once a frame, only for colour attributes. |
| A layout read (`scrollHeight`) after every streamed token, and an unconditional jump to the bottom | One forced layout per token | The reply renders once a frame; one read before and one scroll after, and only when he was at the bottom (`streamFrame`). Scrolling up to read now stays put while she streams. |
| The name/translation walker called `closest()` for every node it visited | Opening Settings: ~80 ms in `closest()` | The tree walker already skips raw subtrees, so nodes inside it are not checked again. |
| `toLocaleString()` built a number formatter on every call (step times, budgets) | ~20 ms per turn | One cached `Intl.NumberFormat` per locale and options. |
| The redraw after each turn asked for all messages shown so far plus 10 | The page grew by ~10 messages every turn | At the bottom the redraw keeps the last 150 messages (earlier ones come back when you scroll up); reading up keeps everything. |

## The "fog"

There is no disconnect overlay in the web app: the fog was a modal window's blurred backdrop
(`dialog::backdrop` with `blur(6px)`) drawn over a page that was already slow, so the window took
200-500 ms to show and to close, and the blur re-rendered with every change underneath. With glass blur
off (Firefox by default) the backdrop is the plain scrim, and the Sara Classic aurora pauses while a
window is open (`html.modal-open`, no page-wide `:has()`).

## Sending in a long chat (LAGFIX, 2026-11-20)

Sending a message in a long chat made the page (and so the app) feel stuck until she finished. Three
things ran for every few words she wrote: her whole reply was parsed and drawn again, the page measured
itself before and after each draw, and the "she is working" glows animated a shadow, which redraws the
page on every frame. Now finished paragraphs are drawn once, her reply updates about 20 times a second,
and the glows only fade (the graphics card does that). On a long chat on a slower computer the page's
long pauses while she writes went from 211 to 5. Details and numbers: `docs/design/LAGFIX.md`.

If the Windows app still greys out with "Not responding", its `desktop.log` (in the app's data folder)
has a `slow ui:` line naming what held the window, or `page busy:` when the page itself was too busy:
those lines are what to send with a report.

## Keeping it fast

`test/smooth.test.ts` guards the patterns: no page-wide `:has()`, no layout read per token or per orb
frame, the stream renders once a frame, still faces in the chat, the after-turn window, the V4 aurora
still and the glass setting. When adding decoration, prefer opacity and transform on small elements,
never `backdrop-filter` over something that changes every frame, and test in Firefox.

## The web app's own files (Z4, 2026-11-23)

The web app is about 290 ES modules and 41 stylesheets, with no build step. How they reach the browser:

- **The page** (`index.html`) is checked on every load (`no-cache` + ETag). The server sends it with
  every script and stylesheet address rewritten to `/v/<id>/…` (`versionPage` in
  `src/static-version.ts`). `<id>` is worked out from the names, sizes and times of every `.js`,
  `.mjs` and `.css` under `web/` (plus `src/identity.ts`, which becomes `identity.js`), looked at
  again at most every 3 seconds. The id is part of the page's ETag.
- **`/v/<id>/x.js`** is `x.js`. When `<id>` is the current one the answer says
  `public, max-age=31536000, immutable`, so the browser reuses it without asking. Any other id (a
  tab left open across an update) gets today's file with `no-cache`. Only scripts and stylesheets
  live there; a missing one is a 404, never the page.
- Modules import each other with **relative** paths, so everything `app.js` loads is under the same
  `/v/<id>/`. An absolute import (`import('/x.js')`) would load a second copy of that module and of
  everything it imports, with its own state: `test/z4-static-version.test.ts` fails on one.
- The page also names every module `app.js` loads at start (`<link rel="modulepreload">`, from
  `staticModules`, read from the import lines once per id), so a first load fetches them in one round
  with `app.js` instead of in waves by import depth.
- Plain addresses (`/app.js`) still work and are still checked each time: the small pages
  (`/pair`, `/help`, ...), `offline.html` and the service worker (`web/sw.js` stores the offline
  page's files by plain address) use them. Pictures, JSON and looks are not versioned (a custom look
  is per owner and must never sit under an address a browser keeps for good).

Measured in a desktop browser against a local server: a repeat load made 250 requests answered "not
changed" before, and makes none now; the first load after a change fetches all 250 once. Through a
tunnel or on a phone each of those requests was a round trip, so that is where the gain is. Not
measured on a phone or through the owner's tunnel.

## The page's weight at start (D7, T51, 2026-11-24)

How: headless Chromium over CDP against a local server on a fresh data folder: a 300-message chat
(150 questions, 150 Markdown replies with lists, some code and tables; the page draws the newest 150),
opened by its link (`/#c=<id>`). Each number is the median of 5 runs after one warm-up, at 1440 x 900,
at 390 x 844 (phone, 3x) and at 390 x 844 with the CPU slowed 4x. "Chat shown" is when 50+ messages
are in a visible chat; "usable" is when the message box shows and the last long task has ended.

What the start costs: the page has about 15,900 elements; 6,582 (41%) are in Settings. Settings is a
closed `<dialog>`, so the browser does no style or layout for it; its cost at start was the pass in
`web/naming.js` that puts her name and the app language into the page's own words, which walked the
whole page twice (once for the language, once for her name) before the chat was drawn.

| Step | Kept? | Desktop | Phone 390 px | Phone, CPU 4x |
|---|---|---|---|---|
| Before: chat shown / usable, cold load | | 833 / 858 ms | 785 / 785 ms | 4,721 / 5,276 ms |
| Before: reload | | 734 / 734 ms | 759 / 759 ms | 5,081 / 5,639 ms |
| Before: open the 300-message chat from another chat | | 112 ms | 98 ms | 796 ms |
| `content-visibility: auto` on each chat row | **No** | open 57 ms; first scroll through 150 rows 144 → 321 ms | open 55 ms | open 437 ms, chat shown 4,228 ms; scroll up 601 → 1,306 ms, p95 frame 14.5 → 21.8 ms |
| `content-visibility: auto` on each reply's text only | **No** | open 102 ms; scroll down 300 rows 327 → 906 ms | open 90 ms | open 657 ms; scroll down 2,123 → 6,071 ms, worst frame 34 → 63 ms |
| Settings named on first open, not at start (`nameNow`) | **Yes** | cold 643 / 643 ms, reload 598 ms | cold 613 / 613 ms, reload 643 ms | cold 3,743 / 4,198 ms, reload 4,019 / 4,509 ms |

Settings named on first open: the chat shows about 20-23% sooner (desktop 833 → 643 ms, phone at 4x
4,721 → 3,743 ms), script time at start 246 → 173 ms (desktop) and 1,673 → 1,133 ms (4x), the longest
task 1,622 → 1,120 ms (4x). What it moves: the first opening of Settings does that work, 423 → 453 ms
on a desktop and 1,690 → 1,837 ms at 4x (later openings are as before). DOM size, JS heap (about 6 MB
after GC) and the 300-message chat's open and scroll times are unchanged by it.

Why `content-visibility` was dropped: it halves the time to open a long chat, but every row is then
drawn when it scrolls into view, so the first scroll through a chat takes twice as long and frames at
4x go over 16 ms. On whole rows it also clips what sits outside a row (her face beside each reply and
your icon in the V4 looks are drawn outside the bubble); `overflow-clip-margin` would fix that in
Chromium but not in Safari (the iPhone app), and Safari has no scroll anchoring, so rows growing above
the view would make the chat jump while you scroll up. With the newest 20 rows always drawn the jump
to the bottom was right; on reply text only, "jump to message" landed up to 160 px off centre.

Not done, and why: moving Settings' markup into `<template>`s or wiring each page on first open. The
markup is parsed either way, a closed dialog has no style or layout cost, and the only per-element
work at start was the naming pass, now gone. The wiring is about 3,150 listeners at start, 612 of
them on Settings elements; adding those 612 took 0.1-0.2 ms (all 3,150: 1.2-1.9 ms; measured by
wrapping `addEventListener`, desktop). Settings' data is already fetched only when it opens
(`loadSettingsPages`). Deferring the wiring means changing how dozens of `web/settings-*.js` modules
and `web/app.js` start, and the tests that read those files, for well under a millisecond.
