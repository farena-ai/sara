# V3.3 Workforce report and one-click hire

ROADMAP_V V3.3 (VAUDIT item 23). Lean extension of C10 workers (docs/WORKERS.md) and the U4.27
marketplace (docs/MARKETPLACE.md); nothing new is duplicated.

## What existed
- `src/workers.ts`: workers with a daily token budget, a durable job queue (`worker_jobs`: status,
  tokens, error, result, `team_task_id`, `ended_at`), Failed jobs, "needs you" alerts, bundles
  (`exportBundle` / `previewImport` / `importBundle`, imports arrive **paused**).
- `src/usage.ts`: every model call is a `usage` row with `team_task_id`; `forTeam(id)` gives dollars.
- `src/destinations.ts`: `postAlert(app, feed)` + `FEEDS` = where things she posts on her own go
  (its own chat, a project, an existing chat, Telegram, Discord), changeable in Settings → Automations
  → Where alerts go and by chat (`alerts_route`).
- `src/market.ts`: listings (skill, template, automation, team, addon) checked by the receiver, then
  installed only with the reviewed hash.

## Built
1. **Weekly workforce report** (`src/workforce.ts`):
   - `workforceReport(app, {days, now})`: one row per worker over the window: jobs done / failed (by
     `ended_at` in the window), waiting now, tokens, dollars (sum of `usage.forTeam(team_task_id)`;
     unpriced calls counted), up to 3 failures (title + reason) and up to 3 outputs (title + first
     words of the result). Dropped jobs never count. Totals over all workers.
   - `workforceText(app, r)`: plain lines in the owner's language (`trOwner`).
   - `workforceTick(app, now)` (from `Workers.tick`, no timer): once per week on the chosen day from the
     chosen hour (default Monday 9 AM, his time zone), only when on and some worker did something.
     Posts through `postAlert(app, 'workforce')`, a new feed "Workforce report" (default: its own
     chat), so Telegram/Discord and other places come from the existing picker.
   - Prefs in `<dataDir>/workforce.json` `{on, day, hour, lastWeek}`.
   - Routes inside the existing `workers` family (owner-only, audited): `GET /api/workers/report`,
     `PUT /api/workers/report/settings`, `POST /api/workers/report/send`.
   - Web: Team → Workers that stay → "Weekly report" card (switch, day, hour, where it goes, Show this
     week, Send it now), every control with a tip.
2. **One-click hire** (`src/market.ts`): a sixth listing kind `worker` whose payload is a worker
   bundle (the worker and the workers it leads) **without memories**, with its budget preset (tokens a
   day, minutes a job, tries). The receiver checks: a real bundle, ≤ 12 workers, known tool groups,
   no "Run commands" or "Hand work to a coding agent" groups, no memories, the usual secrets/size/hash
   checks. Review shows each worker, what it may do and its budget. **Hire** installs with
   `Workers.importBundle(..., {confirm: true})`: every worker arrives **paused**; an update re-uses the
   top worker (patched, paused again). Get more → Shared by friends shows "Review and hire" / "Hire"
   and Share something offers "Worker". Workers that stay has "Find workers to hire".

## Acceptance (tests: `test/v3-workforce.test.ts`)
- Report counts, tokens and dollars equal the fake `worker_jobs`/`usage` rows (outside-window and
  dropped rows ignored).
- Weekly tick: not before the day/hour, once per week, never when off or idle; goes where the feed
  points (dedicated chat, or Telegram through a fake bridge).
- A hired listing arrives paused with the listing's budget; memories and shell groups never cross.
