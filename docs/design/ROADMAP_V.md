# ROADMAP_V (2026-11-18): close the gaps, then go past Hermes and OpenClaw

Owner decisions this round: server code changes stay on by default; no phone number yet (phone-dependent
items wait); legal review done; Chatlee.ai has no API and its terms forbid scraping/automation, so it is
not wired in unless Chatlee grants access; SSO and npm names as recommended below. Free tiers only.

## V0 Gaps (first)
1. Warm voice helper built and shipped per platform (Windows, Mac) in the release; Linux build step run on Linux.
2. Streaming hearing model option (partial transcripts while you talk).
3. Try these checks for 3.19–3.24 so What's new "Try it" works for every release.
4. Readiness "Restore drill" row counts the monthly test restores.
5. What's new prune + translation step inside scripts/whats-new.ts (not a side script).
6. Sign the Inno uninstaller now that Azure signing works; installer stdin timeout under load.
7. Browser extension on Edge Add-ons and Firefox Add-ons (free); Chrome Web Store after the $5 fee is approved.
8. SSO: generic OpenID Connect sign-in (Entra ID, Okta, Google Workspace, Authentik, Keycloak, Pocket ID), with role mapping; SAML only on request.
9. Developer SDK published to npm as `@farena-ai/sara-sdk` (fallback `sara-sdk`), with typed client, add-on helpers, examples.
10. Backlog: trip rename UI, duplicate Library docs, SETTINGS3 gaps, Yahoo stocks source replaced by an official free one.

## How V1-V5 are built (rewritten after the audit, docs/design/VAUDIT.md)

Every V1-V5 item was checked against the code first ([VAUDIT.md](VAUDIT.md): EXISTS / PARTIAL / NEW
with file evidence). Most of the original list already exists in some form, so most tasks below
**improve and join** what is there instead of building it again. Each wave is **5 independent builder
tasks** (one builder each, own worktree); tasks in a wave do not own the same module. Shared files
(src/main.ts, src/server.ts, src/chat.ts, web/app.js, web/index.html, web/i18n/*.json, CHANGELOG) get
small, append-only edits. Waves are ordered by user value. Sizes: S (a day), M (2-3 days), L (a week).
Every task follows the standing rules: tests first, strings via t() in 5 languages, SETTINGS3 with tips,
free only, live check on a throwaway server with screenshots light/dark 1440/390.

Items D1-D8 are "users' dreams" added by the audit (features neither OpenClaw nor Hermes Agent has in
this form). Phone-number items are parked at the end.

## V1 Move in and catch up (wave 1)

**V1.1 Move in: one button, nothing left behind** (item 11) · EXISTS · M
- Exists: `src/movein/` (Hermes, OpenClaw, custom readers; `local.ts` finds agents on this PC),
  `src/history-import/` (ChatGPT, Claude chats), `src/companion-import/` (Character.AI, SillyTavern, any file).
- Build: one "Bring everything" per found agent (persona, notes, chats, skills, jobs in one reviewed
  batch); ChatGPT saved memories and custom instructions, Claude project knowledge → notes; map the
  Hermes hooks/plugins/config entries that are only listed today; a "first evening" checklist after
  import (bridges, voice, model) that says what was skipped and why.
- Acceptance: a fake Hermes home and a fake ChatGPT zip (built at test time) import in one review with
  counts matching the source; the checklist lists every skipped kind; nothing is saved before review.

**V1.2 Waiting on you: one queue** (item 14) · PARTIAL · M
- Exists: `src/needs-you.ts` (per-chat dot), approval cards, `src/inbox/helper.ts` cards, errands waiting
  steps, `src/today.ts` "Since you were away", `src/biz/followups.ts`.
- Build: one read-only aggregator over those sources (no second store) and a Waiting on you list
  (Today tile + its own view), oldest-urgent first, each row opening its own card; on phones swipe right
  = approve draft / swipe left = later, only where the card already allows a one-tap answer.
- Acceptance: each source appears once with a working action; a household member sees only their own;
  money/password cards never approve by swipe.

**V1.3 Bridges: "Where do you text?"** (item 12) · EXISTS · S
- Exists: plugins for Matrix, iMessage (BlueBubbles), Signal, WhatsApp, Slack, Teams, email.
- Build: one picker on Connections that opens the right plugin with defaults filled; Matrix account
  guidance + "send me a test"; iMessage reachability test from the page; each plugin's diagnose step
  shown as plain checks. WhatsApp/Signal stay testable against fakes only (live setup parked).
- Acceptance: picker → configured fake Matrix and fake BlueBubbles round-trip a message in tests.

**V1.4 Open benchmark page** (item 13) · PARTIAL · M · BUILT on hermes/v1bench (docs/design/V1BENCH.md)
- Exists: `bench/` original tasks, `scripts/bench-tasks.ts`, `scripts/bench-coding.ts`,
  `scripts/publish-results.ts`, docs/RESULTS.md.
- Build: adapters that run the same tasks through other harnesses the user installed themselves (their
  CLIs, their keys; never their code in our repo), one `node scripts/bench-compare.ts` rerun, a static
  results page (docs/results + an HTML page) with model, date, exact commands.
- Acceptance: `--mode verify` passes; a fake harness adapter produces a row; results page builds offline.

**V1.5 Cost autopilot: a quality bar per job** (item 37) · EXISTS · M
- Exists: `src/auto-route.ts`, `src/cheap.ts`, `src/budget.ts`, `src/spend.ts` (Token Saver),
  `src/evals.ts`, `src/usage-report.ts`.
- Build: a per-job quality bar (Good enough / Best); Auto tries the next cheaper model (local first) on
  a sample of past turns with the existing eval loop and moves the job down only when it passes;
  "saved $X this month" on Models & usage, Undo on every move.
- Acceptance: a fake cheaper model that passes moves the job, one that fails does not; private chats
  never leave local models.

## V2 Life autopilot (waves 2 and 3)

**V2.1 Renewals and paperwork** (item 15) · PARTIAL · M
- Exists: `src/documents/pdf-form.ts`, `src/form-fill.ts`, `src/my-details.ts`, `src/facts.ts` date
  kinds with reminders, `src/money/hub.ts` renewals.
- Build: one Renewals list (passport, license, registration, insurance, warranties, subscriptions)
  from those sources; each row: remind me / fill the form / start a renewal errand; add by photo of the
  card. Owns `src/facts.ts` this wave.
- Acceptance: dates from a fake Library doc and a fake renewal mail show once each; reminders set at
  the existing DAYS_BEFORE.

**V2.2 Purchases: receipts, returns, warranties** (item 16) · PARTIAL · M
- Exists: inbox receipt → Expenses, attachments → Library, `src/picture-reader.ts`. Name it
  "Purchases": `src/receipts.ts` is the claims checker.
- Build: a purchases list (item, store, price, date, return-by, warranty-until) from receipt mail and
  receipt photos; return-window reminders; "start a return" errand. Reads facts.ts, does not edit it.
- Acceptance: a fake receipt mail and a fake photo become rows with the right return-by date.

**V2.3 Home Assistant in one click, scenes by voice** (item 17) · EXISTS · S
- Exists: `src/tools/home.ts`, `integrations/home-assistant/`, `src/routines.ts`, `src/wake.ts`.
- Build: LAN discovery (mDNS) to prefill the address, Test token, HA scenes/scripts listed as routines
  you start by voice; locks and alarms keep asking.
- Acceptance: a fake HA server is found, tested and a scene runs by a spoken routine; lock asks.

**V2.4 Morning briefing as audio** (item 20) · PARTIAL · S
- Exists: `src/briefing.ts`, `src/review.ts`, `src/weekly.ts`, `src/voice.ts` (local Kokoro/Piper).
- Build: render the briefing with the local voice to an audio file in the Library, play button on Today,
  optional token-scoped private podcast feed; a weekly *life* review (people, health log, money, moments)
  next to the planner review.
- Acceptance: a fake voice engine writes the file; the feed needs its token; no cloud voice unless picked.

**V2.5 Snap and file** (D4) · PARTIAL · M
- Exists: `src/phone-helper.ts` (camera once), `src/picture-reader.ts`, `src/library/intake.ts`.
- Build: multi-page scan from the phone app or browser camera (crop, de-skew, PDF), one tap to Library
  through the existing intake, so facts.ts finds its dates as for any document (V2.1 and V2.2 then
  pick it up with no extra wiring; this task edits neither).
- Acceptance: three fake page images become one PDF with read text and suggested facts.

Wave 3:

**V2.6 Car and house upkeep** (item 18) · PARTIAL · M
- Exists: vehicles in `src/my-details.ts`, `src/errands.ts`, planner reminders.
- Build: upkeep schedules per car (by miles or months) and home (filters, gutters, smoke alarms) from
  a small built-in table, service history (by hand or from receipts), "book it" errand.
- Acceptance: a schedule fires a reminder; logging a service resets the next due.

**V2.7 Gifts and occasions** (item 19) · PARTIAL · M
- Exists: `src/people.ts`, `src/people-ties.ts` (birthdays, anniversaries), `src/shopping/`.
- Build: per person gift ideas (from what she knows, never private cards), a budget, a shopping list
  item, card text in your writing style, reminder 2 weeks before.
- Acceptance: a fake card with a birthday gets ideas and a draft card; private facts not used.

**V2.8 Subscription trimmer** (D7) · PARTIAL · S
- Exists: `src/money/hub.ts` (trials, renewals, price changes), `src/errands.ts` (cancel errands).
- Build: a monthly "maybe cancel" list (unused, price went up, duplicates) with one-tap cancel errand.
- Acceptance: fake subscription mails produce the right list; nothing cancels without OK.

**V2.9 One-minute voice journal** (D5) · PARTIAL · S
- Exists: `src/moments.ts` (on this day), `src/story.ts`, `src/talk.ts`, local hearing.
- Build: a daily voice entry (local hearing, text kept, audio optional), mood tag, "on this day" view;
  private by default.
- Acceptance: a fake hearing engine saves an entry; it never appears outside the owner's space.

**V2.10 Friend-to-friend scheduling** (D6) · PARTIAL · M
- Exists: `src/a2a.ts`, `src/a2a-client.ts`, calendars.
- Build: "find a time with Sam": her Sara and his trade free/busy only (no event text), propose 3
  times, both people confirm.
- Acceptance: two in-process servers agree a slot; only busy blocks cross.

## V3 Your own apps and agents (wave 4)

**V3.1 My apps** (item 21) · DONE (2026-11-18, [MY_APPS.md](MY_APPS.md)) · L
- Exists: `src/preview.ts` (token-scoped previews of apps she builds), `src/worktrees.ts`,
  `src/sandbox-run.ts`, `src/share.ts`.
- Build: keep an app she built (static pages + a small JSON data store per app, no server code from the
  model), versions with Undo, My apps page, share link; served on the user's own server only.
- Acceptance: build → keep → edit → Undo restores the previous version; the app never gets the Sara session.

**V3.2 Automation step view and replay** (item 22) · DONE (2026-11-18, docs/handoffs/2026-11-18-v3replay.md) · M
- Exists: `src/automations.ts`, `web/automations.js`, templates, history, pause.
- Build: a step list editor (drag to reorder, add step between), each run with its steps and outcome,
  "Run again with this input"; no new run engine.
- Acceptance: reorder saves; a failed fake run replays once with the same input.

**V3.3 Workforce report and one-click hire** (item 23) · EXISTS · S
- Exists: `src/crews.ts`, `src/workers.ts`, `src/team.ts`, `src/market.ts`.
- Build: a weekly report per worker (jobs, cost, failures, outputs) to chat/Telegram; "Hire" from a
  marketplace listing straight into Workers with its budget preset.
- Acceptance: report counts match fake job rows; a hired listing arrives paused.

**V3.4 "Fix this issue"** (item 24) · EXISTS · M
- Exists: `src/worktrees.ts`, `src/sandbox-run.ts`, `src/goals.ts`, `src/tools/github.ts`, `src/codereview.ts`.
- Build: from a repo's issue list one button: worktree + sandbox + goal until tests pass + review + PR
  card (PR only after OK).
- Acceptance: against a fake GitHub and a local repo, a fake model's fix opens a PR only after approve.

**V3.5 Website receptionist** (item 25) · NEW · L
- Neighbors: `src/business/`, `src/biz/portal.ts`, `src/other-apps.ts` (keys, CORS, rate limit),
  `src/calendar-links.ts`.
- Build: an embeddable widget script for the owner's site, answering only from chosen Library docs
  and business details under business rules, offering free slots and creating a booking request the
  owner approves; rate limits, no tools, AI disclosure.
- Acceptance: widget on a throwaway page answers from a fake doc, refuses off-topic, books only after OK.

## V4 Senses (wave 5)

**V4.1 Photo library search** (item 26) · DONE (2026-11-18, [V4PHOTOS.md](V4PHOTOS.md), docs/PHOTO_LIBRARY.md) · L
- Exists: `src/moments.ts`, `src/picture-reader.ts`, `src/library/vectors.ts`, `src/find.ts`.
- Build: index a chosen photo folder locally (GPU when present): captions, text in photos, places from
  EXIF, optional face groups you name; search by words; made-for-you albums in Moments. Nothing leaves.
- Acceptance: fake images with fake captions/EXIF are found by place and text; private-local test passes.

**V4.2 Live interpreter** (item 27) · NEW · M
- Neighbors: `src/talk.ts`, `web/talk.js`, `src/voice.ts`.
- Build: Interpreter in Talk: pick two languages, each turn heard, translated and spoken in the other;
  big two-sided screen for the phone.
- Acceptance: fake hearing/voice engines translate both directions; the transcript is saved.

**V4.3 Health imports** (item 29) · NEW · M
- Destination: `src/health-log.ts`.
- Build: readers for Apple Health `export.xml`, Google Takeout Fit and Garmin CSV/FIT exports → sealed
  measurements (steps, sleep, heart rate, weight), dedupe, a trend on the Health page.
- Acceptance: small synthetic exports import once; a second import adds nothing.

**V4.4 Live and translated captions** (item 30) · PARTIAL · M
- Exists: `src/meetings.ts`, `src/meeting-audio.ts`.
- Build: a captions view that follows a meeting room live, with an optional translated line under each.
- Acceptance: fake transcript lines stream to the view; translation runs local-first.

**V4.5 Screen companion** (item 28) · NEW · M
- Neighbors: `src/hands-desktop.ts`, `src/hands-desktop-consent.ts`, `src/phone-helper.ts`.
- Build: opt-in, local only: the desktop app checks the active window every few seconds for error
  dialogs/stuck forms (local text read), offers help in one small bubble; off by default, pause button.
- Acceptance: a fake screen with an error text triggers one offer; nothing is kept or sent.

## V5 Trust no one has (wave 6)

**V5.1 Action timeline with Revert** (item 31) · PARTIAL · L
- Exists: `src/snapshots.ts`, per-feature Undo, `src/self-code.ts` rollback, `src/audit-trail.ts`.
- Build: one timeline of what she changed (files, settings, mail moves, calendar, planner) with Revert
  where an undo already exists and "can't be undone" said plainly where not; new changes register an undo.
- Acceptance: each listed kind reverts in a test; irreversible ones are labeled.

**V5.2 Privacy ledger** (item 32) · PARTIAL · M
- Exists: `src/net-guard.ts` (every outgoing request), `src/audit-trail.ts`, `src/egress-run.ts`.
- Build: count each outgoing request in net-guard by destination host and purpose (model, search,
  mail, hub...), never bodies; a "What left this server" page per day.
- Acceptance: fake requests show under the right destination; private local mode shows zero.

**V5.3 Legacy and emergency access** (item 33) · NEW · L
- Neighbors: `src/household.ts`, `src/data-rights.ts`, `src/vault.ts`, `src/share.ts`.
- Build: name a trusted person and what they get (notes, documents, not chats by default); after N
  days of no sign-in: reminders to the owner, a waiting period, then an expiring access link; the owner
  can cancel at any time.
- Acceptance: simulated clock walks through each stage; a sign-in cancels.

**V5.4 Caregiver mode** (item 34) · DONE (docs/design/V5CARE.md) · M
- Exists: easy mode (`src/everyday-settings.ts`, `src/lean.ts`), `src/health-log.ts` medicines,
  `src/family.ts` profile pattern, `src/household.ts`.
- Build: a simplified home (big buttons: talk, medicines, call family), daily check-in, a caregiver
  view with the person's consent (missed doses, check-ins, never chats).
- Acceptance: a caregiver sees only consented items; withdrawing consent hides them at once.

**V5.5 Accessibility switch** (item 35) · PARTIAL · S
- Exists: docs/ACCESSIBILITY.md (skip link, aria-live, labels, AA colors, large text).
- Build: one Accessibility section: dyslexia-friendly reading (font, spacing, line focus), reduce motion,
  large layout everywhere; screen-reader pass on pages added since R9.
- Acceptance: axe-style checks on the newer pages; the switch survives reload.

## Wave 7: reach further

**V5.6 Phone fallback model** (item 36) · DONE (2026-11-18, [V5_PHONE_MODEL.md](V5_PHONE_MODEL.md), docs/OFFLINE.md) · L
- Exists: docs/OFFLINE.md (read-only recent chats, outbox).
- Build: an optional small on-phone model in the Android app for short answers while the server is
  away, marked "offline answer"; synced back when online.
- Acceptance: with the server down, the app answers from the local model and the reply is synced later.

**D1 Teach by showing** · NEW · L
- Neighbors: `extension/`, `src/browser.ts`, `src/skill-learning.ts`.
- Build: "Watch me do this" in the browser extension records steps (clicks, fields, no passwords),
  turns them into a skill or an automation draft you review.
- Acceptance: a recorded fake flow replays on a fake page; password fields are never recorded.

**D2 Wear OS glance** · NEW · M
- Neighbors: `android/`, `src/push.ts`. Wear OS only (Apple Watch needs a paid program).
- Build: a tile with today, waiting-on-you count and push-to-talk; approvals stay on the phone.
- Acceptance: the tile builds and shows fake data from a test server.

**D3 Live canvas in chat** · NEW · M
- Neighbors: chat cards, `src/preview.ts` sandbox model.
- Build: she can post a small interactive view (table, chart, checklist) that updates from its source
  and runs sandboxed with no Sara session.
- Acceptance: a checklist card updates live; its script cannot read the page.

**D8 Second opinion** · DONE (docs/design/D8SECOND.md) · S
- Exists: `src/modelpicks.ts` (blind side-by-side), `src/auto-route.ts`.
- Build: "Get a second opinion" on any reply: two other connected models answer, the differences
  highlighted; spend shown first.
- Acceptance: two fake models' answers appear with the diff; private chats use local models only.

## Parked (needs a phone number)

- WhatsApp and Signal live setup (plugins exist and are tested against fakes; the live account needs a number).
- SMS bridge.
- Calling errands and a phone line for the website receptionist.

## Order

V0 first (gaps, as one wave), then waves 1-7 in the order above. Each wave's five tasks run in
parallel; a wave starts when the previous one is merged.
