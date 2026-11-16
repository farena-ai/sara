# ADULTAPPS: Adult mode in the desktop apps, Open in browser in the phone apps

Owner request (2026-11-16): "adult mode got removed in our reorganization". It wasn't removed: since
2.61.3 the web hid the Adult mode page for any `SaraPhone/` or `SaraDesktop/` user agent, and the
server refused it for both (`fromSaraApp`). Owner decision: the desktop apps (not store-distributed)
behave like a browser; the phone apps (Google Play / App Store rules) keep refusing to turn it on.

## What existed
- `src/http.ts`: `fromPhoneApp` (phone only) and `fromSaraApp` (phone or desktop).
- Adult gates on `fromSaraApp`: `/api/adult` GET `canTurnOn` + PUT on (her.ts), explicit intimacy
  levels (her.ts studio list + persona PUT), adults-only outfits (her.ts `adultOk`), Discord/Telegram
  adult channels (connections.ts), the one-time Adult mode question (`adultAsk`, server.ts session).
- Web: `settings-nav.js` filtered out `you-adult`; `renderRoutes` hid the Adult model row
  (`adultOk`). Memory and planner adult checks already used `fromPhoneApp`.
- The page already handled `canTurnOn: false` (state, Turn off, a note).

## Change
- Every adult gate above now uses `fromPhoneApp`; `fromSaraApp` stays for its other uses.
- Web checks use `/\bSaraPhone\/\d/` only; the page filter is gone, so the page shows everywhere.
- Phone apps: the page shows its state; Turn off works; when off, "Turning it on needs a web
  browser" + **Open in browser** (`<server>/#view=settings:you-adult`). Android opens it through a new
  `SaraPhone.openInBrowser(url)` bridge (this server's host, http(s) only); the iPhone app sends
  `window.open` to Safari; older Android builds without the bridge copy the link (or show it).

## Not changed
Turn on still needs the 18+ box; the demo still refuses; household/child rules are unchanged.

## Tests
`test/adultapps.test.ts` (new), `adult`, `bond`, `wardrobe` (desktop allowed, phone refused),
`q2-ui` (page listed in the phone apps).
