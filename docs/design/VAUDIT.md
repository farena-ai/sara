# VAUDIT (2026-11-18): what Sara already has for ROADMAP_V items 11-37

Docs-only audit for [ROADMAP_V.md](ROADMAP_V.md). For each item: **EXISTS** (shipped, works; improve it),
**PARTIAL** (real pieces exist; finish and join them) or **NEW** (nothing to build on but neighbors).
Evidence is file paths in this tree; "how good" is the auditor's read of the header comments, docs and
tests, not a live run. Owner rule applied: where something exists, the roadmap task makes it better and
easier (fewer steps, better defaults, clearer pages), never a second copy.

## Summary

| # | Item | Class | Main evidence |
|---|---|---|---|
| 11 | Import from OpenClaw, Hermes, ChatGPT, Claude | EXISTS | `src/movein/` (readers `hermes.ts`, `openclaw.ts`, `custom.ts`; `local.ts` finds agents on this PC), `src/history-import/` (ChatGPT, Claude), `src/companion-import/` (Character.AI, SillyTavern, any chat file); docs/MOVE_IN_GUIDE.md, docs/IMPORT.md |
| 12 | Bridges: WhatsApp, Signal, Matrix, iMessage, SMS | EXISTS (SMS NEW) | `plugins/whatsapp`, `plugins/signal`, `plugins/matrix`, `plugins/imessage` (BlueBubbles), `plugins/slack`, `plugins/teams`, `plugins/email`; docs/WHATSAPP.md, SIGNAL.md, MATRIX.md, IMESSAGE.md |
| 13 | Public benchmark page vs other harnesses | PARTIAL | `bench/` (original repo tasks), `scripts/bench-coding.ts`, `scripts/bench-tasks.ts`, `scripts/publish-results.ts`, docs/RESULTS.md + docs/results/*.json, `src/evals.ts` (owner's own eval loop). Missing: the same tasks run through other harnesses |
| 14 | One "Waiting on you" queue | PARTIAL | `src/needs-you.ts` (sidebar dot per chat), `src/inbox/helper.ts` (mail cards), `src/errands.ts` (waiting steps), approvals cards, `src/today.ts` ("Since you were away"), `src/biz/followups.ts`. Missing: one list across all of them, swipe on phone |
| 15 | Paperwork autopilot + renewals | PARTIAL (mostly EXISTS) | `src/documents/pdf-form.ts` (AcroForm fill, verified read-back), `src/form-fill.ts` + `src/my-details.ts` (web forms, stops before Submit), `src/facts.ts` (renewal, expiry, passport, license, warranty dates from Library docs, reminder N days before), `src/money/hub.ts` (subscription renewals). Missing: one Renewals list, "renew it" errand |
| 16 | Receipts and warranties vault | PARTIAL | `src/inbox/helper.ts` (receipt mail → Expenses, attachments → Library), `src/facts.ts` (`warranty_end`), `src/picture-reader.ts` (photo → text). Missing: return windows, a purchases list, photo-a-receipt flow. Note: `src/receipts.ts` is the *claims checker* (tool receipts), not purchases: name the new thing "Purchases" |
| 17 | Home Assistant + voice routines | EXISTS | `src/tools/home.ts` (read freely, changes ask), `integrations/home-assistant/` (custom component, tests), `src/routines.ts`, `src/talk.ts`, `src/wake.ts`; docs/HOME_ASSISTANT.md. Missing: one-click discovery, scenes as routines by voice |
| 18 | Car and house maintenance | PARTIAL (thin) | `src/my-details.ts` (vehicles), `src/facts.ts` (`vehicles`/`home` places), `src/errands.ts` ("book an oil change"). Missing: schedules, service history |
| 19 | Gifts and occasions | PARTIAL | `src/people.ts` (birthdays on cards), `src/people-ties.ts` (anniversaries, keep-in-touch nudges), `src/shopping/` (find, watch), `src/humanize.ts`/writing style. Missing: gift ideas, budget, list, card text |
| 20 | Audio briefing + weekly life review | PARTIAL | `src/briefing.ts` (text briefing, facts in code), `src/review.ts` (weekly planner review), `src/weekly.ts` (reflection), `src/voice.ts` (local Kokoro/Piper TTS), `src/spoken.ts`. Missing: the briefing as an audio file/podcast feed, a life (not planner) review |
| 21 | "Make me an app" | PARTIAL | `src/preview.ts` (token-scoped live previews of web apps she builds), `src/worktrees.ts`, `src/sandbox-run.ts`, `src/share.ts` (read-only links). Missing: keep an app running with its own data, versions, undo, a My apps page |
| 22 | Visual automation builder | PARTIAL | `src/automations.ts` (triggers/conditions/actions, history, pause), `web/automations.js`, `src/automation-templates.ts`, `src/run-diff.ts`/`src/replay.ts` (replay for chat runs). Missing: step canvas, per-run step view, replay one automation run |
| 23 | Agent workforce | EXISTS | `src/crews.ts` (standing members, schedules, summary), `src/workers.ts` (budgets, job queue, failed jobs, bundles import/export), `src/team.ts`, `src/market.ts` (community marketplace). Missing: weekly workforce report, "hire" flow from marketplace in one click |
| 24 | Coding workspace | EXISTS | `src/worktrees.ts`, `src/sandbox-run.ts` + `src/egress.ts`, `src/tools/github.ts` (open PR after OK), `src/codereview.ts`, `src/goals.ts` (rounds until tests green), `src/editor-link.ts` (ACP). Missing: a single "repos" page that starts a sandboxed task from an issue |
| 25 | Website receptionist widget | NEW | Neighbors: `src/business/`, `src/biz/portal.ts` (client portal link), `src/calendar-links.ts` (read-only calendars), `src/other-apps.ts` (OpenAI-compatible API, CORS, keys) |
| 26 | Local photo library understanding | PARTIAL | `src/moments.ts` (album with captions, albums, on this day), `src/scrapbook.ts`, `src/picture-reader.ts`, `src/library/vectors.ts` (embeddings for docs), `src/find.ts`. Missing: index a photo folder, search by people/places/things/text, made-for-you albums |
| 27 | Live interpreter | NEW | Neighbors: `src/talk.ts` + `web/talk.js` (voice-first turn loop), `src/voice.ts`, `src/lang-text.ts` |
| 28 | Screen companion | NEW | Neighbors: `src/hands-desktop.ts` + `src/hands-desktop-consent.ts` (consented screen access), `src/phone-helper.ts` (lend screen once), `src/watch.ts` (log watches) |
| 29 | Wearable/health imports | NEW | Destination exists: `src/health-log.ts` (sealed per-space health log, measurements, doctor summary). No Apple Health / Google Fit / Garmin reader |
| 30 | Meeting live + translated captions | PARTIAL | `src/meetings.ts` (listening rooms, transcript lines, notes), `src/meeting-audio.ts` (speakers). Missing: live caption view, translation |
| 31 | Time-travel undo for every action | PARTIAL | `src/snapshots.ts` (file undo), per-feature Undo (`src/everyday-settings.ts`, `src/mail/organize.ts`, `src/model-fitness.ts`, safety check-up), `src/self-code.ts` (rollback), `src/replay.ts` (run time-travel), `src/audit-trail.ts`. Missing: one action timeline with Revert per row |
| 32 | Privacy ledger | PARTIAL | `src/net-guard.ts` (the single way out of the server), `src/audit-trail.ts` (hash chain), `src/egress-run.ts` (refusals), `src/trust-report.ts` (sources read), `src/hub.ts` (fixed check-in body). Missing: a per-destination "what left and why" list |
| 33 | Legacy and emergency access | NEW | Neighbors: `src/household.ts`, `src/data-rights.ts` (per-person export), `src/vault.ts`, `src/share.ts`, `src/my-details.ts` (emergency contact field) |
| 34 | Elder and caregiver mode | PARTIAL | 3.3.0 easy mode (`src/everyday-settings.ts`, `src/lean.ts`), `src/health-log.ts` (medicine reminders, supply), `src/family.ts` (kid-safe profile = model for a role), `src/household.ts`. Missing: caregiver role with consent, check-ins, simplified home |
| 35 | Accessibility mode | PARTIAL (good base) | docs/ACCESSIBILITY.md (skip link, aria-live, labels, WCAG AA colors, large text), text size setting. Missing: dyslexia-friendly reading, one "Accessibility" switch, a screen-reader pass on newer pages |
| 36 | Phone fallback local model | PARTIAL | docs/OFFLINE.md (recent chats + notes read-only, outbox). Missing: an on-phone model for answers while offline |
| 37 | Cost autopilot | EXISTS (mostly) | `src/auto-route.ts` (scored pick + fallback), `src/cheap.ts` (local-first small calls), `src/budget.ts` (step-down ladder), `src/spend.ts` (limits, Token Saver), `src/evals.ts` (winner only on evidence), `src/modelpicks.ts`, `src/usage-report.ts`. Missing: a per-job "quality bar" that Auto uses to try cheaper models |

## Improvements for what exists (owner rule: better and easier)

- **11 Move in:** one "Bring everything" button per found agent (today persona, notes, chats, skills,
  jobs are separate steps); ChatGPT saved memories and custom instructions (export `user.json` /
  `memories`) and Claude project knowledge as notes; Hermes hooks/plugins/config listed today but not
  mapped; a "first evening" checklist after import (bridges, voice, model) with what was skipped.
- **12 Bridges:** a single "Where do you text?" picker that opens the right plugin with defaults filled;
  Matrix: create-account guidance and auto-verify; iMessage: BlueBubbles reachability test from the
  page; WhatsApp/Signal need a number: parked (live), but a dry "test with a fake server" stays possible.
- **13 Bench:** the tasks exist and are original; add adapters that run them through other harnesses
  installed by the user (their own CLIs, their own keys), a static results page, and a one-command
  rerun. Never copy their code; never publish to a registry.
- **15/16:** one Renewals page fed by facts.ts + money hub, each row with "Remind me / Start renewal
  errand"; purchases with return-by dates from receipts and store policies.
- **17 Home Assistant:** discover HA on the LAN (mDNS `_home-assistant._tcp`) and prefill the address;
  "test token" button; HA scenes appear as routines you can start by voice ("Hey Sara, movie night").
- **20:** the briefing already writes plain facts; render it with the local voice to an MP3 in the
  Library and an optional private podcast feed URL (token-scoped).
- **23:** a weekly workforce report (each worker: jobs, cost, failures, what it produced) and
  "Hire" from a marketplace listing in one click into Workers.
- **24:** "Fix this issue" from the GitHub issue list → worktree + sandbox + goal + PR card.
- **35:** fold existing pieces into one Accessibility section with a single switch.
- **37:** a quality bar per job, checked with the existing eval loop before Auto moves a job down a tier.

## Users' dreams (beyond OpenClaw and Hermes Agent)

Looked at the public feature pages of OpenClaw (channels, mobile/watch nodes, Canvas and inline
widgets, skills hub, cron) and Hermes Agent (20+ platforms, learning loop, cron, subagents, voice,
sandboxes). Sara already matches or beats most of these (bridges, skills learning, automations, teams,
sandbox + egress, wake word, ACP). The gaps worth having, none present today:

| D | Dream | Class | Evidence / neighbors |
|---|---|---|---|
| D1 | Teach by showing: do a task once in the browser, she turns it into a skill/automation | NEW | `extension/`, `src/browser.ts`, `src/skill-learning.ts` |
| D2 | Watch glance: Wear OS tile with today, approvals and push-to-talk | NEW | `android/` app, `src/push.ts`; no watch code (Apple Watch needs a paid program: Wear OS only) |
| D3 | Live canvas in chat: interactive tables, charts, checklists that stay current | NEW | `web/` cards, `src/cards.ts`, `src/preview.ts` sandboxing model |
| D4 | Snap and file: phone camera → multi-page scan → Library + facts + reminders in one tap | PARTIAL | `src/phone-helper.ts` (camera once), `src/picture-reader.ts`, `src/library/intake.ts`, `src/facts.ts` |
| D5 | One-minute voice journal with "on this day" | PARTIAL | `src/moments.ts` (on this day), `src/story.ts`, `src/voice.ts`, `src/talk.ts` |
| D6 | Friend-to-friend scheduling: her Sara and yours find a time | PARTIAL | `src/a2a.ts`, `src/a2a-client.ts`, calendars in `src/today.ts` |
| D7 | Subscription trimmer: finds unused subscriptions and runs the cancel errand | PARTIAL | `src/money/hub.ts` (trials, renewals, price changes), `src/errands.ts` |
| D8 | Second opinion: ask two or three models, see where they disagree | PARTIAL | `src/modelpicks.ts` (blind side-by-side test), `src/auto-route.ts` |

Dropped while auditing: a travel-day rebooking dream (already in `src/travel.ts`: delay alerts and
rebooking options).
