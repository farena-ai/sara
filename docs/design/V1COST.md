# V1.5 Cost autopilot: a quality bar per job

ROADMAP_V V1.5 (item 37, VAUDIT: EXISTS mostly). One page.

## What existed (reused, not rebuilt)
- `src/auto-route.ts` (N1 Auto): scores every connected model per job (chat, coding, vision,
  research) and makes a two-model chain; private chats and "Nothing leaves this computer" only see
  models on this computer (`localOnly`), the spend limit drops pay-per-use models.
- `src/evals.ts` (M9 eval loop): frozen tasks from past turns (`pickTasks`, private chats left out
  unless every variant is local), control vs variant replays, scoring, ceilings, `createWith`
  (used by the ST2 skill check). `src/skill-learning.ts` `QUALITY_PARTS` (quality parts only).
- `src/usage.ts` (UsageStore, prices, `costOf`), `src/spend.ts` (`periodStarts`, limits, Token
  Saver), `src/budget.ts`, `src/cheap.ts`, `src/usage-report.ts`.

## What V1.5 adds
- **A quality bar per job** (chat, coding, research): *Best* (default, nothing changes) or
  *Good enough*. Pictures stay on Best (replays don't carry the pictures).
- **The trial** (`src/cost-autopilot.ts`, `CostAutopilot.tryJob`): with *Good enough* and Auto on
  for that job, it takes Auto's current pick, finds the next cheaper connected model (on this
  computer first, then a subscription, then the next lower pay-per-use price; unknown prices are
  never "cheaper"), and runs the existing eval loop on a sample of 8 past turns of that job
  (control = current pick, variant = the cheaper one), inside the eval schedule's token budget.
- **The verdict** (`barVerdict`): on the quality parts only (tests, finished, the owner's reaction,
  the judge, findings; cost never decides), at least 3 usable pairs and at most one loss per five
  pairs (a variant run that failed counts as a loss). Pass → the job moves down: Auto puts the
  cheaper model first and keeps the old pick as its fallback. Fail → nothing moves; that model is
  not tried again for 60 days.
- **When**: "Try a cheaper model now" in Settings, or by itself through the existing hourly eval
  tick (main.ts) at most once a week per job, only when idle and no other eval runs. No new timer.
- **Undo on every move**: Undo puts the job back and keeps that model out for 60 days; switching
  the bar to Best undoes the move too. The last 20 moves/trials are listed.
- **Saved this month**: for each move, the job's calls on the cheaper model since the move (this
  month, owner's time zone) priced at the old model's price minus what they cost. Shown on Models &
  usage → Which model does what (Cost autopilot section) and on Usage and costs.

## Privacy
- Private conversations: Auto's `localOnly` filter runs on the moved model too, so a moved cloud
  model is never used in a private chat (it falls back to the local chain). Trials never replay a
  private chat on a cloud model (`pickTasks` leaves private turns out unless every variant is local).
- Owner-only: members and the demo have no eval loop, so no autopilot (`app.costAutopilot`
  undefined → 404 under `/api/model-jobs/cost`).

## Data
`<dataDir>/cost-autopilot.json`: `{ bar, moves, trials, refused }`. No settings.json churn.

## Routes (owner, `model-jobs` family)
`GET /api/model-jobs/cost` · `PUT /api/model-jobs/cost {job, bar}` ·
`POST /api/model-jobs/cost/try {job}` · `POST /api/model-jobs/cost/undo {job}`.
