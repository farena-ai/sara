# W1.3 Continue on another device

Roadmap: docs/design/ROADMAP_W.md W1.3. Code: `src/continue-here.ts`, `src/routes/continue-here.ts`,
`web/continue-here.js`. Tests: `test/w1continue.test.ts`. User doc: docs/CHATS.md "Continue on another device".

## What existed (extended, not duplicated)
- Phase 119 **Pick up across apps** (`src/pickup.ts`, `web/pickup.js`): carries the *conversation* between
  chat apps (Telegram → web). Owner only, per app channel, no draft/scroll. Left as it is.
- **Session continuity** (`src/session-continuity.ts`): model-side context between the owner's sessions.
  Not about devices. Left as it is.
- **Push** (`src/push.ts`, `src/apns.ts`): browser push + iPhone app, `sendAll` to every device.
  Extended with `sendPhones` (only subscriptions labelled iPhone/iPad/Android + the iPhone app).
- **Android app**: `InboxJob` (15-min check of `/api/phone/inbox`) + `LiveInbox` (SSE). Extended with a
  `handoff` field / `continue` event.
- **W0.6 ages** (`ageWords` in `src/time-sense.ts`, six languages) give "2 minutes ago".
- D3 canvas cards (`web/canvas-card.js`) now carry `data-canvas`; Talk via `talkOn`/`startTalk`.

## Design (one page)
- Each browser/app keeps a random id (`localStorage['sara.device.id']`, nothing about the device in it)
  and its kind from the user agent (phone, tablet, PC, Mac, computer).
- The page PUTs its spot, debounced 1.5 s, on chat open, typing, scroll and page hide (keepalive):
  `{device, kind, conversationId, draft (≤4000), scroll (message id at the top, 0 = end), talk, canvas}`.
- The server keeps the newest spot per device (≤8) in `<dataDir>/continue-here.json`, the person's own
  data folder: a household member's app has its own, so nothing crosses people. Shared rooms, group
  chats, demo and off-the-record spaces are never noted.
- `GET /api/continue-here?device=` gives at most one offer: the newest spot of ANOTHER device inside the
  window (default 30 min, 5–240), newer than this device's own last spot and not dismissed here.
- Card (body-level popover, moved into the top modal like the Messages notices): "Continue where you
  left off on your PC — 2 minutes ago", chat title, the draft, "Talk was on" / "Live view open";
  Not now (dismiss up to that spot) / Continue (open chat, put the draft in an empty composer, jump to
  the live view or the message, start Talk with the tap as the mic gesture).
- "Continue on my phone" (⋯ chips row, hidden on phones): notes the spot, keeps a 30-min handoff for
  the Android check, publishes `continue` (LiveInbox re-checks), pushes to phones only; the phone's
  notification opens `/#c=<id>`, and opening Sara there shows the card with the draft.
- Settings → Connections → Phone and notifications → Continue on another device: on/off (off forgets
  every spot) and How soon after. Members have the same section for themselves.

## Not done / limits
- The draft lives on the server in plain JSON in the person's folder (like the chats themselves).
- The phone notification opens the chat; the draft arrives through the card (one tap), not by itself.
- Talk restarts on the new device (a new Talk session in the same chat), not mid-sentence.
