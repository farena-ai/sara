# U2.10: iPhone web app fixes (wording, errands badge, phone layout review)

ROADMAP_U U2.10. Sara on an iPhone is the web app (Safari, or added to the Home Screen; the native
app is not in the App Store). This item fixes what reads or works wrong there and reviews every screen
added since 3.15 at iPhone sizes.

## What existed (reused, not duplicated)

- `web/ios-web.js` (R4): `isIOS`, `isStandalone`, `badgeValue`, `applyBadge`; `web/pair-link.js`
  `phoneKind(ua, maxTouchPoints)` (iPadOS desktop UA counted as iOS).
- The app badge (R4/MSGPOP): `GET /api/phone/badge` and every web push's `data.badge`
  (`PushService.badge`, set in `src/server.ts`) both come from `badgeCount()` in `src/shortcuts.ts`;
  `web/sw.js` passes `data.badge` to `setAppBadge`; the page refreshes the badge when the Today
  `needs`/`errands` parts change (`web/app.js`).
- Errands (R3) push "Errand needs you" through `push.notifyOwner`, so the badge rides that push.

## Changes

1. **Wording (web/reach.js).** "Connect the Sara phone app" always said "Get the Sara app on your
   Android phone" with a Google Play link, also on an iPhone. `appLines({ua, maxTouchPoints,
   standalone})` now words step 1 for the device showing it: iPhone in Safari → add to Home Screen
   (Share → Add to Home Screen); iPhone Home Screen app → "already on your Home Screen"; Android →
   Google Play; a computer → Android plus a short iPhone line. On an iPhone the QR button says
   "Show a code for another phone" (you can't scan your own screen).
2. **Errands in the badge.** `badgeCount`/`waitingCount` add `Errands.waitingOnYou()` (one COUNT
   query on `status = 'waiting_you'`). Since the push badge, the badge route and the Shortcuts widget
   line ("Waiting for you in Sara") use the same functions, all three now include errands. Guarded:
   stubs without errands or a closed store count 0.
3. **Phone layout review.** A throwaway in-process server with a scripted fake model and Chrome with
   an iPhone user agent + touch (`isMobile`, `hasTouch`, DPR 2) at 375×667, 390×844, 430×932, light
   and dark (no Playwright WebKit build on this PC; installing one is not part of the repo's tools).
   Each screen: screenshot + DOM facts (sideways overflow, visible tap targets under 44 px,
   controls whose centre sits under a fixed/sticky bar). Fixes are CSS only, scoped to
   `@media (pointer: coarse)` / phone widths, theme variables only. Findings and fixes are listed in
   the handoff (docs/handoffs/2026-11-16-u2ios.md).

## Not done here

- Real Safari/WebKit and a real iPhone (safe-area insets, the Home Screen badge) are owner checks.
- The native iPhone app (desktop/ios) is untouched.
