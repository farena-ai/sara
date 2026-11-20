# LAGFIX: the lag (and "Not responding") after sending a message

Owner report (2026-11-20): "every time I send a message lately it goes into 'not responding' but after
a while returns ok but has that lag pretty bad." Server times were normal. This page says what was
measured, what was found, what changed and what is left.

## What existed

- `docs/PERFORMANCE.md` + `web/smooth.js` + `test/smooth.test.ts` (an earlier long-chat pass): the reply
  rendered once a frame, a window of 150 messages after each turn, no page-wide `:has()`, still orbs.
- The Windows app had no way to say its window thread was busy, and no handler for WebView2's
  "renderer unresponsive" event.
- LAGFIX extends those files; nothing is duplicated.

## How it was measured

- Web: an in-process throwaway server with a scripted model; a long coding chat (40 turns, 248
  messages: tool steps, search cards, code blocks, tables, memory picks; the page shows the newest 150,
  so a longer chat draws the same); Send streams a ~3,000-character
  reply after a tool step at ~40 tokens a second. Chrome (headless, Playwright) records long tasks, CDP
  Performance metrics (main-thread, style, layout, script time), input delay (a 100 ms timer's lateness),
  a CPU profile (self/inclusive time per function) and a timeline trace. 1x and 4x CPU throttle. The
  "before" is the base commit in a scratch worktree, same script. (Headless Chrome draws frames back to
  back, so total busy time saturates at 4x either way: long tasks and input delay are the honest numbers.)
- Windows app: the test build (`SARA_TEST_INSTALL=1`) with a new heartbeat hook (`ui-heartbeat.log`: a
  thread sends the window WM_NULL every 100 ms and logs the answer time) and the new "slow ui" loop log,
  against the same server, screen companion on, quick-ask polling, two streamed turns, window visible,
  page throttled 4x, old and new web code.

## Findings

| # | Where | Measured | Change |
|---|---|---|---|
| 1 | Each streamed frame re-parsed and redrew the WHOLE reply (`setReply` -> `parseMd` + `toDom`) | O(n^2) over a reply; 380 ms of script per reply at 1x | Finished blocks are drawn once and kept, only the open last block is redrawn (`streamBlocks`, `stableCut`: blank line outside an open code fence, not inside a list/quote/table that goes on). The full draw at the end is unchanged. |
| 2 | One draw per animation frame (60-144 a second) | ~150 draws/s headless | At most ~20 draws a second (`paced`, `STREAM_EVERY_MS = 50`), still in a frame, last token always drawn. |
| 3 | `nearBottom` read layout before every draw, then the scroll read it again | 1,549 layouts per reply; `streamFrame` 2.4 s self at 1x | "At the newest line" comes from the box's scroll events (`followTracker`); one layout per draw (the scroll). |
| 4 | Busy pulses animated `box-shadow` (`hp-pulse`/`hp-breathe` on her panel glow, `step-pulse` on live step dots, `v4-breathe`, and with her own picture `v4d-ring-*` on four faces) | Pausing all animations halved main-thread time (12.3 s -> 6.6 s); own picture added ~4 s | Opacity-only keyframes on a pseudo-element with a fixed glow (compositor); her own picture: only the header face ripples, the others keep a steady lit ring. `test/lagfix.test.ts` pins it. |
| 5 | After the turn, the chat is rebuilt from the server (`renderMessages`, ~16k nodes) | one task: ~170 ms at 1x, 0.7-1.0 s at 4x | Not changed (see Left). |
| 6 | Windows: window thread | heartbeat worst 171 ms (old web) / 46 ms (new), no "slow ui" over 250 ms in the streamed turns; one 1.2 s `servers` answer once at first load (not reproduced) | `slow ui:` lines in desktop.log for any message > 250 ms (rate-limited; modal loops excluded), `page busy:` when WebView2 says the page is unresponsive, the face PNG no longer re-written every 5 s while she works. |

Numbers (same session, 4x CPU, one streamed reply on the long chat):

| | before | after |
|---|---|---|
| Long tasks while sending + streaming | 211 (19.5 s in total) | 5 (1.3 s) |
| Longest task | 1,738 ms | 811 ms (the after-turn redraw) |
| Input delay p95 / worst | 167 ms / 1,882 ms | 29 ms / 886 ms |
| Same with her own picture: long tasks, input p95 / worst | 253, 223 ms / 1,708 ms | 21, 60 ms / 791 ms |
| 1x: main-thread time / style / layout (count) | 10.3 s / 2.4 s / 1.2 s (1,563) | 7.8 s / 1.5 s / 0.87 s (926) |

## "Not responding"

The window thread of the Windows app never stopped answering in the measured runs, even with the page
throttled 4x on the old code; the page's own thread was what stopped (busy for the whole reply, clicks
waiting ~2 s, the page-drawn title bar and buttons not reacting), which feels exactly like a hung
window. On the owner's longer, richer chats at full speed that is the 4x case. If Windows itself greys
the window again, desktop.log now says which message held the thread (`slow ui: page: <kind> N ms`,
`timer N`, `command N`) or that the page was unresponsive (`page busy:`): send those lines.

## Mac app (review only, can't run here)

- `QuickAsk.swift` state handler (main thread, every 5 s while she works): decodes and re-writes the
  face file, re-writes the icon file and re-sets `NSApp.applicationIconImage` (a Dock round trip) every
  time, even when nothing changed. Windows skips an unchanged icon; Mac should compare the data first.
- `DispatchQueue.main.sync` from worker threads in Hands/HandsTabs/HandsRun: fine while the main thread
  never waits on those workers; worth a timeout if one ever does.
- `AppUpdate.fetch` waits on a semaphore but runs on a global queue (fine). Timers: 10 s server state
  (off the main thread), 45 s / 5 s quick-ask refresh (as Windows).

## Left / next

- The after-turn full redraw (#5): redraw only the latest turn and patch the "latest message" bits
  (Regenerate, edit, open choice card) on the previous one. ~0.8 s at 4x today, once per reply.
- Mac: the Dock icon / face rewrite above (needs a Mac build to verify).
- Real WebView2 at 60 Hz on the owner's PC was not measured (headless Chrome + the test app hidden or
  briefly visible here).
