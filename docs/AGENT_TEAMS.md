# Agent teams (team runs, S8)

For a big job that splits well — research several things at once, write it up, check it — she runs a
**team**: helpers working at the same time, each with its own model, tools and budget, then one result
and **one** approval point for anything that leaves Sara.

(Microsoft Teams is [TEAMS.md](TEAMS.md). Code work with a coder, tester and reviewer is the older
*team task*; standing helpers on a schedule are [crews](CREWS.md).)

## Start one

- In any chat: *"Get a team to compare three e-bikes under $2,000 and write it up as a Word document."*
  She calls `team_run`, which only **proposes** a plan; a card appears in the chat.
- Or Team → **Team runs**: describe the job, pick the result (a message here, Word, PDF or Markdown),
  **Plan it**.

## The plan (shown before anything runs)

| Part of the plan | What you can change |
|---|---|
| Helpers (roles) | Name; kind: researcher, drafter, checker or your own role; **model** (Auto = your usual model for that kind of work); **tools** (✉ marks actions); **budget** (tokens, minutes, optional $); *May use the computer*. |
| Parts | Which helper, the title, and what each part **waits for**. Parts that wait for nothing run at the same time (up to 3). |
| Result | A message in the chat, or a document in your Library (`make_document`) with the sources listed. |

The budget for the whole run (the helpers' budgets added up) is on the plan before you approve it.
**Approve and start** is the plan's one OK; tools listed in the plan for reading and writing drafts then
run without asking again. **Drop this plan** discards it.

Never offered, even by hand: commands and coding agents (shell, SSH, jobs, Claude Code), sign-ins and
saved logins, settings and her character, deleting things, other teams or crews, live phone calls.
Computer-use tools only when you tick *May use the computer* for that helper (her own proposal never
ticks it). Tools you switched off in Settings stay off.

## While it runs

- Each helper's part shows live on the run and on its chat card: waiting, working, done, its tokens,
  the round; **Pause** (no new part starts; helpers stop before their next move), **Go on**, **Stop**.
- **Scratchpad:** researchers note each finding with its source (`note_finding`); every later helper
  sees the numbered findings, and drafts cite them as [n].
- **Checker:** checks the draft against the findings and the receipts (claims of things done that no
  receipt backs, citations that point at no finding, and its own `VERDICT: FIX: …`). Fixes go back to the
  drafter, then it checks again — **two rounds at most**; anything still open is written into the result,
  not hidden.
- **Budgets:** a helper or the whole run stops at its token, dollar or time budget. The run says where it
  stopped and keeps what was found and drafted; parts that hadn't started stay waiting.

## The one final OK

Sending, posting, buying and computer actions are **not done during the run**: a helper's call is
queued and it is told so. At the end one card lists every queued action (who asked, what it does).
Untick any you don't want, then **Do the ticked actions**, or **Do none**. Each action is checked again
against your current settings before it runs.

## Private and local

In a private chat, or with *Nothing leaves this computer* on, helpers use models on this computer only
(a cloud model in the plan falls back to Auto, which picks a local one) and tools that reach outside
are left out.

## Where it's kept

Each run (plan, parts and their reports and receipts, scratchpad, checks, actions, log, tokens and
cost) is a row in `team_runs` in your space, and a run record (*kind team*) like any team task. A run
that was working when the server stopped shows *interrupted by a restart*; it doesn't restart by itself.

## For admins

Owner only: household members, the demo and paired devices get 403. Route group `team-runs` is audited.
At most two runs work at once.

## Design (one page)

- **Built on what existed:** helpers' roles and budgets ([team.ts](../src/team.ts)), model routing
  (`resolveChain`, Auto, private-local filter), tool admission (`assertToolAdmission`), receipts and
  `checkClaims`, run records (`RunRecorder`), usage metering (`usageScope`), `makeDocument`, chat notice
  cards like crews. Crews and team tasks are unchanged.
- **New:** `src/team-runs.ts` (`TeamRuns`, table `team_runs`, one JSON row per run), the `team_run` tool,
  `src/routes/team-runs.ts`, `web/team-runs.js` (Team → Team runs, the `teamrun:` chat card), event
  `team-run`.
- **Decisions:** the plan approval covers the read/draft tools it lists (that is the point: one OK);
  everything else is queued, never run mid-run; hard-limit tools are cut at plan time *and* refused at
  call time; parallel scheduling is a small dependency scheduler (cap 3), the checker loop lives in the
  checker's part so dependents wait for the checked draft; budget checks before every model call
  (estimated tokens where the model reports none).
- **Risks:** estimated tokens are rough for models that don't report usage; a helper may still write a
  draft file in the workspace (drafts are allowed); run records interleave steps from parallel helpers.
- **Tests:** `test/s8-team-runs.test.ts` (scripted model: plan + hard limits, private, parallelism and
  dependency order, scratchpad, checker loop 1 and 2 rounds, single final approval with an unticked
  action, budget stop, pause/stop, document result) and `test/s8-team-runs-routes.test.ts` (routes,
  owner-only, audit, UI wiring).
