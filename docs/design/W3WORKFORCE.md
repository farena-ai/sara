# W3.4 Agent workforce v2

ROADMAP_W W3.4. Lean extension of C10 workers (docs/WORKERS.md, `src/workers.ts`) and the V3.3
weekly workforce report (docs/design/V3WORKFORCE.md, `src/workforce.ts`). No new place, page, feed,
route family or timer.

## What existed
- Workers with a character, tool groups, a daily token budget, a durable job queue with retries,
  Failed jobs, "needs you" alerts (one per key, quiet hours), leads (`HAND TO <name>:` lines to the
  workers under a lead), bundles and one-click hire.
- The weekly workforce report (jobs, tokens, dollars from `usage.forTeam`) on a chosen day and hour,
  posted through `postAlert(app, 'workforce')` (W1.2 nudge gate applies).
- Spend limits for the whole server (`src/spend.ts`); nothing per worker goal.

## Built
1. **Goals with a measure** (`src/worker-goals.ts`, `Workers.goals`): a goal belongs to a worker and
   has one simple measure: *finished jobs* (jobs the last worker in the chain finished) or *a number*
   (the worker ends a reply with `PROGRESS: <n>`, or he types it in). Target, a short name for what is
   counted, counted per week (from Monday, his time zone) or over the whole goal. Max 24 goals.
2. **Caps stop work and ask**: a dollar cap (usage rows of the goal's jobs' team tasks) and/or a token
   cap per goal and period. Before a goal job starts, `gate()` checks it: at the cap the goal turns
   *capped*, its jobs wait (the worker's other jobs still run) and he gets ONE "needs you" alert per
   cap and period (reason `cap`). Raising the cap or a new week lets them run. A running job never gets
   more tokens than are left under a token cap (the team's job limit).
3. **Hand-offs as a chain**: a goal lists up to 4 workers after its own (scout → writer → editor). When
   a step is done its output (minus the PROGRESS/NEXT/PASS lines) becomes the next worker's job, same
   goal, linked by `worker_jobs.from_job`; the giving worker's chat says "Passed to …". Any worker can
   also end with `PASS TO <name>: <job>` to hand work to any other worker. A chain stops after six
   steps. `chainOf(job)` walks the whole chain; the goal view shows the last three.
4. **Weekly plan**: on the workforce report's day and hour (default Monday 9 AM) the workers propose a
   plan: for each active goal its *weekly job*, the `NEXT: <job>` lines its workers wrote (up to 3), or
   one "next step toward" item, each with an estimate (average cost of its recent chains) and an
   *over the cap* flag. It is posted where Workforce report alerts go; nothing starts until he decides.
   One card (Team → Goals and weekly plan): rename, untick, add jobs, **Approve the plan** or **Skip
   this week**. Used suggestions are cleared. First look after a start only remembers the week (no old
   week is proposed); **Propose a plan now** makes one at once.
5. **Goal view** (`web/worker-goals.js`, in the Team dialog under Workers that stay): per goal the
   chain, a progress meter, spend vs cap meters, *What is blocked* (at its cap, goal paused, a paused
   worker in the chain, an approval or daily budget waiting, failed goal jobs) and recent hand-offs;
   Give it a job, Raise the cap, Pause/Resume, Edit, Delete.
6. Workers are told their goals, the PROGRESS/NEXT lines and who they can PASS TO
   (`goals.lines(w)` in `helperDefs`).

Routes ride the owner-only, audited `workers` family: `GET/POST /api/workers/goals`,
`PATCH/DELETE /api/workers/goals/:id`, `POST /api/workers/goals/:id/jobs`,
`GET /api/workers/jobs/:jid/chain`, `POST /api/workers/plan/propose`, `POST /api/workers/plan/decide`.
Tables (additive): `worker_goals`, `worker_plans`, `worker_goal_kv`; columns `worker_jobs.goal_id`,
`worker_jobs.from_job`.

## Acceptance (tests: `test/w3-workforce.test.ts`)
- Goal validation (worker, title, caps > 0, no worker twice in a chain).
- A token cap holds the next job, alerts once, and a raised cap runs it with exactly the room left.
- A dollar cap counts the goal's usage rows; next Monday the held job runs by itself.
- A three-worker chain passes outputs along, counts only when the last worker finishes, and shows
  as one chain; PASS TO hands to any worker; chains stop at six steps.
- PROGRESS sets a number goal; NEXT lines feed the plan; prompts carry goals and the line formats.
- The plan: not on the first look, proposed on Monday 9 AM and posted to the workforce feed, approved
  with rename/skip/add, never twice a week, skipping queues nothing.
- Routes are the owner's (members 403); the Team dialog has the section, strings via `t()`.
