# V4.5 Screen companion (ROADMAP_V item 28)

**Goal.** When an error dialog or a stuck form shows on the computer, Sara offers help in one small
bubble. Opt-in, local only, off by default, with a pause.

## What existed (reused, not duplicated)
- `desktop/windows/src/hands-screen.cpp`: `hiddenKindOf` (password managers, banking, the person's own
  list, Sara's own windows) and `maskSecrets` (key-shaped text). The watch uses both.
- `desktop/windows/src/quick-context.cpp`: `appLabel` (the program's friendly name) and the quick-ask
  page's removable chips that go only with the question (Quick ask anywhere).
- `desktop/shared/quick-ask.html`: the quick-ask window. The bubble is a mode of this page, not a new window.
- `src/hands-desktop.ts`: the reference-rules pattern (TypeScript rules, ported to the apps as fixed lists).
- Settings → This computer (`desktop-app`) and the `getPrefs`/`setPref` bridge.
- Not used: `src/phone-helper.ts` (one-time screen lending to the server) and `src/watch.ts` (server
  log watches). Both send things to the server, which this feature must never do.

## Design
- **Rules** (`src/screen-companion.ts`, ported to `desktop/windows/src/screen-watch.cpp`):
  - an error: a dialog (`#32770`, or a small owned pop-up) with an error word; or a title saying
    "not responding";
  - a stuck form: a form message ("is required", "invalid", ...) still there after 3 looks;
  - only short texts count (300 characters at most), so documents and web pages that mention "error"
    don't; whole words only; six languages;
  - never hidden windows or Sara's own; never password fields; never typed values (control *names* only).
- **Watch:** off by default; one look every 5 s on a worker thread (UI Automation, 1.5 s and 400
  elements at most); one offer per thing seen (kept as a 32-bit hash, at most 64); one offer per
  2 minutes at most; nothing while paused or while quick ask is open.
- **Bubble:** the quick-ask window shown with `SW_SHOWNOACTIVATE` (never takes the focus), gone by itself
  after 30 s. **Help with this** puts the line in as a chip and fills the question; nothing is sent
  until **Ask**. **Not now**. **Pause for 1 hour** (also in the tray menu and Settings).
- **Nothing kept or sent:** the watch has no file or network code (tests check the source); the log
  says only `screen: offered help (error|form)`, never the text or the program.
- **Settings:** This computer → Screen companion: the switch, Pause/Resume, a status line. The Mac app
  and older apps show "Only in the Windows app for now." / "Update the Sara app to use this."

## Proof
- `test/v4-screen.test.ts`: fake screens (`test/fixtures/fake-screens.ts`) give the expected finding; one
  offer; pause; cool-down; hidden/own windows; only hashes kept; word lists equal in C++. With the
  test build it also runs `ScreenWatchChecks` (the C++ port on the same fake screens and the same watch
  sequence) and `--live` (the real UI Automation reader on `ScreenWatchFixture`'s own off-screen windows:
  one offer each, the typed value and the password never read).
- Real test app: `SARA_TEST_SCREEN_TITLE` (test builds only) points the watch at the fixture's window,
  never the window in front; the bubble showed once without the focus and hid itself after 30 s.

## Not done
- The Mac app (needs the Accessibility API port; no Mac use in this wave).
- The bubble's own words are English, like the rest of the quick-ask page.
