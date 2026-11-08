# Phone as a helper

Sara can borrow your phone (or any browser where you're signed in) for one thing at a time: **one
picture from its camera, your location once, or one picture of a screen**. She asks only when it
helps with what you asked ("is this plant OK?", "what's the weather here?", "what does this error
say?"), and **every use is approved on the device**: a full-screen prompt says what she wants and
why, with **Allow once** and **Deny**. Nothing is taken in the background or without a tap.

## Switch it on (each device separately)

1. Sign the phone in to Sara (Settings → Devices and sign-in → *Add a phone or computer*, scan the
   code), in the Sara app or the phone's browser.
2. **On that phone**, open Settings → Devices and sign-in → *Phone as a helper* and tick **Sara may
   ask this device for its camera, location or screen**.

It's off on every device until you tick it there. The list under the switch shows which devices
are on. Signing a device out turns it off. Apps signed in with a device code (the terminal client,
VS Code) can't be helpers, and household members can't use it: it is the owner's.

## What happens when she asks

- The prompt appears on every helper device where Sara is open, with her reason, exactly what she'd
  get and the seconds left (90). Escape or **Deny** says no; she's told you said no and won't push.
- **Camera:** after *Allow once* the camera opens with a preview; you press **Take picture** (or
  *Cancel*). She sees the picture and it's on her reply, like a photo you sent.
- **Location:** approximate by default (rounded to about 1 km). If she needs the exact spot
  (directions), the prompt says *Your exact location, once.* The phone's own location permission
  may ask too. She uses it for that answer only.
- **Screen:** the browser's own picker chooses a screen or window and one frame is sent. Most phones
  can't share their screen from a browser; she's told so and can ask you for a screenshot instead.
- **No answer in 90 seconds** (phone locked, Sara not open): the prompt closes and she's told your
  phone didn't answer. Stopping her turn closes the prompt too.

## What is kept

Nothing beyond what you'd keep anyway: requests live in memory and disappear when answered. A
picture becomes part of that conversation (delete the message to delete it). A location is only in
that tool step. The audit trail (Settings → Data & health → Audit trail) gets one row per request:
`phone.camera`, `phone.location` or `phone.screen` with *OK*, *Refused* (Deny) or *Failed* (no
answer, not possible) and the device's name; switching a device on or off is a `phone.helper` row.
Never the picture, never coordinates.

## Privacy rules that still apply

- **Private local mode / private chats:** she asks only when her model runs on this computer;
  otherwise the phone isn't asked at all.
- Not in chats with a partner or group chats: only your own chats with her.
- Pictures: JPEG, PNG or WebP up to 1.5 MB (the page sends at most 1600 px).

## For admins

- Policy pin **Turn off Phone as a helper** (JSON `"phoneHelper": false`): no device can be switched
  on (409 "Set by your admin"), the tools are never offered and waiting prompts close at once.
- Per-tool ceilings work as for any tool, e.g. `"tools": { "phone_location": "never" }`.
- The tools default to *Runs on its own* in Settings → Tools, because the approval is on the phone;
  set them to *Ask* to get a chat card first as well.

## The phone apps

The Android and iPhone apps show the same prompt (they show Sara's web app). The Android app 2.87.0
(C18) takes the location fix itself after *Allow once* (`SaraPhone.helperLocate`), because Android's
web view gives location only to https pages and a server at home is often plain http; approximate
requests ask Android only for approximate location. Older app builds can't answer location requests
(she's told it didn't work). Camera works in every build. See OWNER_CHECKS.md.
