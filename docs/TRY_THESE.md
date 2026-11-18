# Try these: a guided owner checklist (ROADMAP_U U1.5)

**Where:** Help (the ? in the sidebar) → **Try these**. Owner only: household members, kids and the
demo never see it. A direct link: `/#view=try`.

## What you see

- About 50 short checks of what is new since Sara 3.15 (V0.3 added 3.19 to 3.24: test restores, What's
  new, Talk with Sara, Business, shared projects, the marketplace, picture editing, Money, Family,
  Health, study cards, the browser extension, free flight status, Word comments, team recipes, the
  taskbar count, an iPhone connection, alerts into a project). Older ones: choices to tap, goals, research, ask
  about anything, Messages (link, cards, communities, pictures), make it sound human, meetings, People
  that need attention, trips, documents (template, tracked changes, ready to sign), agent teams, help
  passes, self-repair Check now, where alerts go, Adult mode in the apps, several Google accounts, one
  Windows install, approving and undoing a code change.
- Grouped by release, newest first, with progress ("6 of 30 tried: 3 worked, 2 didn't work, 1 skipped").
- Each item: 1 to 3 steps, **Take me there** (opens the exact page) or **Start the chat** (a new chat
  with the message filled in; you press Send), and *What you should see*.
- **Worked / Didn't work / Skip** plus an optional note (up to 500 characters). Press a result again to
  clear it.
- Items added by an update are marked **New** the first time you open the list.
- **Didn't work** adds **Ask Sara to fix it**: a new chat with your note that asks her to check herself
  and fix what she can (her self-repair tools `repair_status` / `repair_fix`, docs/SELF_REPAIR.md). Nothing
  is sent until you press Send.

## Your results

- **Export as Markdown** downloads `sara-try-these-<date>.md` (kept on your computer).
- **Send results to the developer** is off by default: tick *Let me send results to the developer* first.
  **Preview what is sent** shows the exact report. Send sends it as one report through the same path as
  Help → Report a problem (docs/SUPPORT.md): only the items you tried, each result and your notes, with
  keys, emails and your folder names removed. It shows in Help → My reports with its ticket number.
  Not available in private local mode (*Nothing leaves this computer*).

## Design (one page)

- **Data:** `src/owner-checks.ts` holds the curated list (`CHECKS`: id, release, title, steps, `view`
  hash or `ask` text, expect; English `en()` keys translated in `web/i18n/*.json`) and the owner's
  results in `<data>/owner-checks.json` (`results`, `seen`, `sendOn`, `sentAt`, `ticket`).
- **Routes:** `src/routes/owner-checks.ts`: `GET/PUT /api/owner-checks`, `PUT /api/owner-checks/:id`,
  `POST /api/owner-checks/seen`, `GET /api/owner-checks/preview`, `POST /api/owner-checks/send`
  (`fileTicket` from src/hub.ts: proof of work, scrubbed, stored in My reports), `GET
  /api/owner-checks/export`. Members 403, demo 404.
- **Web:** `web/owner-checks.js` (the `#try-these` dialog, Help card `#help-try`, `#view=try`), styles in
  `web/hub.css` (`ochk-` classes). "Ask Sara to fix it" uses the app's `askInChat` (fills the composer).
- **Adding items after a release:** append to `CHECKS` (and its release to `CHECK_RELEASES`), then run
  `node scripts/i18n-extract.ts --missing es` and translate the new keys in all five languages. Old items
  can stay; the list shows newest first. `test/u1check-owner-checks.test.ts` checks every deep link
  points at a real Settings page or place.
- **Existed and reused:** the hub ticket path and My reports (Phase 113), the Help window, the
  self-repair tools (T1), `#view=` deep links. No new tile, Settings page or model tool.
