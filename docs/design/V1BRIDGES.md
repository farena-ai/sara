# V1.3 Bridges: "Where do you text?"

ROADMAP_V V1.3 (VAUDIT item 12). One page; extends what exists, adds no new bridge.

## What already existed
- Plugins: `plugins/{matrix,imessage,whatsapp,signal,slack,teams,email}`, built-in Telegram and Discord
  (`src/bridges/`). Each has a guided setup card on its own Settings page (`co-<app>`, `data-tile="chat"`,
  web/<app>.js on web/setup-card.js `INTROS` + stepper + `testList`), server checks in
  `src/plugins/<app>-setup.ts`, and a read-only Test (`PluginManager.testBridge`) shown as ✓/✕ lines.
- Matrix: the "Make her a Matrix account" step with the exact Element screens (account guidance), login,
  room, link code, Test. iMessage: the BlueBubbles address/password check (`server` step) once added.
- Signal: `POST /api/plugins/signal/probe` works before the plugin is added.
- WhatsApp: `send-test` (a real message into the owner's chat).
- Connections → Apps and services (`co-services`, web/settings-services.js): tiles with a status dot.
- Fakes: `test/fixtures/matrix/hs.mjs` (homeserver), `test/fixtures/imessage/bb.mjs` (BlueBubbles).

## What V1.3 adds
1. **The picker** at the top of Apps and services: "Where do you text?" One button per place people
   already text (Messages on iPhone, WhatsApp, Signal, Telegram, Discord, Element/Matrix, Slack, Teams,
   email). A phone switch (iPhone / Android) marks the easiest fits. Picking one shows what it needs,
   its state, and **Set it up**, which opens that app's page with defaults filled in
   (`sessionStorage['sara.where.defaults']`, read once by matrix.js/imessage.js). Set-up apps get
   **Check** (plain ✓/✕ lines from each plugin's own diagnose/Test) and **Send me a test**.
2. `GET /api/plugins/where` (owner only, the `plugins` route family): per app `{id, page, plugin,
   available, installed, on, running, linked, canSendTest, defaults}`. Defaults: Matrix
   `@sara-<owner>:matrix.org` (the format the account step already suggests), iMessage
   `127.0.0.1:1234` or the saved address, Signal `127.0.0.1:7583`.
3. `POST /api/plugins/where/check {app}`: the plugin's Test lines plus "Your chat is linked".
4. `POST /api/plugins/where/send-test {app}`: one short "Test from Sara" into the owner's linked chat
   (Matrix, iMessage, WhatsApp). New plugin check step `send-test` in matrix and imessage
   (plugin versions 1.1.0 so installed copies are offered the update). Nobody else is ever messaged:
   only `ownerChats[0]`; nothing linked → `NOT_LINKED`.
5. `POST /api/plugins/where/probe {app:'imessage', address, onOtherMachine}`: BlueBubbles
   reachability before (or without) adding the plugin. One `GET /api/v1/ping`, no password sent,
   this computer or (with the switch) the home network only, 3 s. `ok` when BlueBubbles answers
   (a 401 "not authorized" from BlueBubbles counts as reached; the password is checked in step 4).
   Codes: `BAD_ADDRESS`, `NOT_LOCAL`, `DOWN`, `SLOW`, `NOT_BB`. Also on the iMessage page's intro.
6. Matrix page: **Send me a test** next to Test once connected.

## Not built (parked)
- WhatsApp/Signal live setup (needs numbers): stays testable against fakes only.
- No auto-discovery of Macs on the network (mDNS) yet.

## Tests
`test/v1-bridges.test.ts`: the pure picker model; routes; the acceptance round trip: picker → fake
homeserver (Matrix) and fake BlueBubbles (iMessage) configured with the picker's defaults, an owner
message answered, Check all ✓, Send me a test delivered to the owner's chat only; the probe codes.
