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

## Keeping it fast

`test/smooth.test.ts` guards the patterns: no page-wide `:has()`, no layout read per token or per orb
frame, the stream renders once a frame, still faces in the chat, the after-turn window, the V4 aurora
still and the glass setting. When adding decoration, prefer opacity and transform on small elements,
never `backdrop-filter` over something that changes every frame, and test in Firefox.
