# Keep going until it's done, and repeat it in the chat: a goal on the chat that only ends when the checks really ran, and `/loop` (design, Phase 118, version 2.51.0)

Status: design study, 2026-11-01. Nothing here is built. It is a read-only study of the code at
2.50.x (Phases 115–117 released: the live progress message, steer / queue / `/btw`, the loop
guard, the Signal and email plugin bridges), plus the public feature pages of Hermes Agent and
OpenClaw that GAP_REVIEW cites (sources in §13). It is a ground-up design: no code, schema, prompt
or wording is taken from Hermes Agent, OpenClaw or any other agent; this file names only their
**features**. Zero new npm runtime dependencies. No new timer, no new run engine, no new kind of
model call: everything below is a turn through `runTracked`/`runBackground`, a command through the
workspace sandbox, or a row in `store.db`.

**The owner's words (2026-10-31, approving the gap review's suggestions as Phases 115–128):** "I like
the top 10 as well as the lower down ones." The ROADMAP line he approved:

- *Phase 118 (2.51.0):* "Keep going until it's done (a goal on the chat, held by the budget, done = the
  checks really ran) and repeat-in-chat loops (#6, #14)."

And the gap review's pitches he said yes to (GAP_REVIEW §2):

- **#6** "'get all the tests green' becomes a goal on the chat; she works, checks, and keeps going
  until it's met, stuck, or out of budget, then tells you which." *Fits:* "the M4 budget is the
  ceiling; board cards (ST4) can carry the same goal in the background." *Simple UI:* "a *Keep going
  until…* chip above the composer with the goal, a progress ring and Stop; `/goal` in chat apps."
  Risk note (G4): "the M4 budget stays a hard ceiling and *Continue with more* stays the owner's;
  'done' needs receipts (tests ran), not the model's word; Stop always wins."
- **#14** "'every 10 minutes, check the deploy and tell me when it changes' runs inside the chat with
  its context, until it's done or the end time." *Fits:* "each tick is a normal turn with the budget;
  results that change nothing stay quiet." *Simple UI:* "she proposes it as a card (every …, until …,
  about N model calls); it shows on Today under background work with Stop." Risk note (G5): "A
  scheduled, paid model call: off until asked, an end time and a per-loop cap by default, listed in
  Planner with Stop, counts against the daily budget; quiet hours apply to pings."

**The brief for this design (from the parent, on the owner's behalf):**
1. *Goals on a chat.* She keeps working toward a stated goal across turns until it's done. The goal
   is **held by the existing budget limits**. *Done* means **the checks really ran**: tests, a build
   or a verifier **the owner picks**; never self-declared. **Visible status, pause/stop, a cap on
   rounds, time and spend.** It **survives restarts only as "paused"**.
2. *Repeat-in-chat loops.* "`/loop every 10m: check the deploy and tell me if it's red`", or "until
   X". **Owner-only, budgeted, quiet hours respected, they stop on failure and on no-progress.** They
   relate to the existing schedules/automations, her plans (ST8) and the board.

**Goal:** "get the tests green" stops being five "continue"s. She works a round, Sara (not she) runs
the check the owner picked, and if it's still red she gets the real failure and goes again, until it's
green, stuck, or at a cap, and then she says which, with the check's own output as the proof. And
"keep an eye on the deploy" becomes one confirmed card that wakes her every ten minutes, says nothing
while nothing changes, tells him the moment it goes red, and stops by itself at its end time, on a
failure, or when it's going nowhere.

**The rule of this track: build on what is there.** A goal round is an ordinary turn
(`runTurn` through `runBackground`), so the safety layer, approvals, the plan check, the sandbox gate,
the turn budget's ladder, the claim check, the loop guard, steer/queue and the run record all apply
unchanged. The check is a command run the way background jobs run commands (`runCommand` in the
conversation's workspace sandbox, scrubbed by the redactor) and read the way result cards read test
output (`cards.ts testCounts`); the verifier is the helper team's existing *reviewer* role
(`team.ts ROLES.reviewer`, its `VERDICT:` line). "Same failure as last round" is the M10 failure key
the loop guard already uses (`triggers.ts`). A loop tick is a queued owner input
(`pending.ts`) run as an ordinary turn; the clock is the reminder scheduler's existing 15-second tick
(`reminders.ts`), quiet hours are the ones the owner already set for her messages (`proactive`,
`life.ts`), and the daily cap is the CH3 `DailyLedger` (`budget.ts`). Goals and loops are shown in the
places that already show work: the composer's busy area (BR2 chips), the progress message (BR1 B4),
Today's background-work tile, Planner, and the board card. The mandatory safety layer
(`src/safety.ts`: AI disclosure at the start and every 3 hours, honesty when sincerely asked, crisis
resources, the hard block on sexual content involving minors) is untouched and runs inside every
round and every tick, because each is a normal turn.

Contents: 1 what exists today · 2 how Hermes Agent and OpenClaw do it, and where Sara differs · 3 the
shape and shared building blocks · 4 part A: keep going until it's done (`/goal`) · 5 part B: repeat
it in the chat (`/loop`) · 6 safety and money across the phase · 7 household isolation · 8 reuse vs
build · 9 risks · 10 the phase at a glance · 11 blocking questions with defaults · 12 key choices in
short · 13 sources. The `test/phase118.test.ts` Done-when list is §5.14 (both parts), the owner to-dos §5.15.

---

## 1. What exists today (mapped from the code)

| Piece | Where | What it does today | Matters here because |
|---|---|---|---|
| The turn loop | `src/chat.ts` `runTurn` (2,665 lines): `for (step …)` rebuilds the history from the store every step; `TurnHooks` at four fixed seams (`beforeModelCall`, `beforeTool`, `afterTool`, `afterReply`, joined by `joinHooks`; the first `ask`/`stop` wins); `TurnOptions` (`resume`, `budget`, `budgetMore`, `pendingId`, `noTools`, `outside`, `replay` …); the last step's "Stopped after N steps. Say \"continue\"…" (l. 2624) | One turn = one answer. Nothing carries on after `done`. | A goal round needs **no change to the loop**: it is a turn with one more `TurnOptions` field (`goal`) and one more hook set (a note at step 0, the round's receipts at the end). |
| Continue | `server.ts` `POST /api/conversations/:id/continue` (l. ~1980): `{resume:true}` answers the last owner message again; with `body.budget` → `cleanMore` → `{resume:true, budgetMore}` only when the last reply has `meta.budget.stage = 'reached'`; the turn tells her once "pressed \"Continue with more\" and gave this task … more" (`budget.ts` l. 456) | The explicit, owner-only override after a budget stop. | A goal **never presses Continue by itself**. A round that reaches its turn budget pauses the goal on that same button (§4.7). |
| Turn budgets (M4) | `src/budget.ts`: `Budget {tokens, usd, steps, minutes, degrade}`, `budgetCheck`, `DEFAULT_TURN_BUDGETS` (coding on: 200k tokens / 40 steps; chat off: 100k / 20), `HARD_STEP_CAP = 200`, the ladder (quick model → one more tool round → a summary without tools), `onLimit: 'wrap' \| 'ask'`, `TurnMeter`, `moreWords`, the pick-lists `TOKEN_CHOICES`, `STEP_CHOICES`, `USD_CHOICES`, `MINUTE_CHOICES` | The per-turn ceiling and its words ("its token budget (200,000 tokens)"). | "Held by the existing budget limits": every round and every tick runs **inside** the turn budget; the goal and loop caps are **sums over runs** checked with the same `budgetCheck` and worded with the same `reasonFor`. |
| Daily caps | `budget.ts` `DailyLedger` (`budget_ledger (day, source, tokens, usd, runs)`, `fits(source, cap, next)`), used by `cheap.ts` (titles, `/btw`, describe-first); household `MemberLimits {messagesPerDay, costPerDay}` (`household.ts` l. 436, checked before any model call); ST8's `agenda_ledger` and its daily token / dollar budget; webhooks' `runsPerDay` + token budget per hook | A day's spend per source, checked before the call. | Loops spend from the same ledger (source `loop:<id>` and the total `loops`), so Settings → Usage and the cap check already work. |
| Background jobs | `src/jobs.ts`: `JobManager.start(spec)` runs a command in the conversation's workspace sandbox (`runCommand`, `MAX_JOB_MS` 60 min, `MAX_RUNNING` 3), output scrubbed (`app.redactor`), a run of kind `job`, a `notice` card + her short report checked against the receipt (`checkClaims`); jobs `running` at start-up become `interrupted`; `#paused` (budget stops) is lost on restart | The pattern for "a command the app runs, with a receipt she can't overstate". | The goal check runs the **same way** (`runCommand`, sandbox, redactor, run step), but synchronously between rounds and not as a user-visible job (§4.4). The "interrupted on restart" line is the model for "paused on restart". |
| Run record (M3) | `src/runs.ts`: `RunKind = 'turn' \| 'job' \| 'team' \| 'eval' \| 'redteam' \| 'security'`, `RunStatus` incl. `budget`, `limit`, `interrupted`; per step model, tokens, cost, tools, `guard` (Phase 116) | Every turn is a run with sums. | Goal and loop spend = the sum of their runs' tokens / cost (no second meter). Each round/tick run gets `goalId`/`loopId` in its `policy` JSON (existing column) for the run view's filter. |
| Loop guard (B7) | `src/loop-guard.ts` (136 lines): per turn, 3 identical failing calls → blocked; declined twice → not asked again; 3 more blocked tries → tools paused (`loop_guard` event with `paused`) | Per **turn**, cleared by a new turn. | A goal is many turns: without care she can re-try the same broken command once per round forever. §4.6 carries the block **across a goal's rounds** and counts "tools paused" as *stuck*. |
| Steer / queue (B5) | `src/pending.ts` (371 lines): `PendingInputs.add({kind:'steer'\|'queue', content, meta, sender}, runner)`, `takeSteers` at the safe point, `drain` after each turn (`server.ts` `runTracked` `finally`), `defaultRunner` → `runBackground`; rows `waiting` at start-up become `stale` and never run; `queueMax` | One queue per conversation for web, Telegram, Discord, plugins. | The next goal round and each loop tick enter **through this queue** (`sender: 'owner'`, `meta.goal` / `meta.loop`), so they never collide with a turn the owner started and they inherit "nothing runs after a restart". |
| Progress message (B4) | `src/bridges/progress.ts` (351 lines): one message per long turn, edited in place through the pacer, verbs only, `finalLine(outcome …)` (`done`, `stopped`, `error`, `budget`, `restart`), Stop button | Per turn. | A goal round's message gets a header line ("🎯 Round 2 of 5 · 3 tests failing") and a goal outcome on its final line; a loop tick that stays quiet posts **no** progress message (§5.6). |
| Commands (CH1) | `src/bridges/commands.ts`: `MENU_COMMANDS` (`new reset stop status help model remember`), typed `bug idea progress`, `BUSY_COMMANDS` (`steer queue btw`), `commandAllowed(place, who, name)` (owner-only checked on the server), `DESCRIPTIONS`, `COMMAND_WORDS` (six languages), Discord bulk overwrite, Telegram `setMyCommands` | Commands run before the queue and never reach a model. | `/goal` and `/loop` join this table (typed, owner only) with the same parser; `/status` gains one line each; `/stop` and `/reset` learn what they do to a goal or a loop (§4.10, §5.8). |
| Reminders and planner repeats | `src/reminders.ts` `ReminderScheduler` (15 s tick, `guard('reminders')`, late ones delivered "sorry it's late", skips a conversation mid-turn); `planner.ts` `Repeat = none \| daily \| weekdays \| weekly \| monthly`, `nextOccurrence`, place reminders; move-in maps old cron jobs onto planner tasks that "never act by themselves" (`movein/schedules.ts`) | Time-driven messages, no model call. | The loop clock **is this tick** (one more `due()` list), not a new timer. Minutes-level repeats are new to the planner, which is why loops get their own small table instead of more `reminders` columns (§3.2). |
| Her plans (ST8) | `src/agenda.ts` (1,237 lines): **her** goals (`agenda_goals`, status `proposed \| active \| paused \| done \| dropped`, a check-in every 1–30 days) and follow-ups, opt-in (off), every item quoting the owner's words, the shared daily message cap and quiet hours (`proactive`: 22–9, `maxPerDay` 2, `minGapHours` 6), a daily token / dollar budget, a crisis pause; Planner → *Her plans*, Today's tile | Things **she** keeps at over days, on her own initiative. | Different thing, same words. A chat goal is **his** objective for **this chat, now**; a loop is **his** order. Neither is made by her, neither counts against her proactive cap, but loops **reuse its quiet hours** and **show beside it** in Planner (§5.10). The UI never calls a chat goal just "Goal" (§4.11). |
| The board (ST4) | `src/board.ts`, `src/board-work.ts` (809 lines): a card is a planner task; *Assign → Sara* works it through `runTracked` in the card's own conversation (channel `board`); **"Done means receipts"**: a clean claim check moves it to Done, otherwise *Waiting on you* with "I think it's done, but I couldn't prove: …"; budget → "Continue with more budget?" | Background work with an honest Done. | A card can carry a goal check ("Done when: `npm test` passes"); board-work then uses the goal driver and its Done needs the check **and** the clean claim check (§4.12). |
| Coding checks | `projectknow.ts` (the project's `build`, `test`, `lint` commands, found by looking); `security/fix.ts` `detectTests(dir)`; `cards.ts` the shell result card (`kind:'test'`, `ok`, `exitCode`, `testCounts` passed/failed/skipped for node --test, jest/vitest, pytest, cargo, go); `receipts.ts` claim kinds incl. `tests_pass` ("contradicted" when the last test run exited ≠ 0); `team.ts` roles `tester`, `reviewer` (`VERDICT: APPROVE` / `CHANGES NEEDED`); `sandbox-run.ts` `classifyCommand(command) → {reasons: writes \| installs \| deletes \| network \| scripts \| system}`; findings (`security/findings.ts`, the "no theater" quote rule); evals (`evals.ts`) run the project's tests in a sandbox copy | Each knows how to run and read a check. | The check picker offers exactly these (§4.3). No new parser, no new runner, no new judge. |
| Safety | `src/safety.ts` (`preflight`, `detectCrisis`, `minorSexualMatch`, `disclosureDue`, `isWorkChannel`), `src/redact.ts`, `net-guard.ts` private local mode | Runs inside every `runTurn`. | Rounds and ticks are turns, so all of it runs. The *unattended* parts (the note that starts a round, a tick's prompt, the check's output) are covered in §6. |
| Household | `src/main.ts` (`isMember` → no tools), bridges only for the owner's main companion | | Goals need tools (checks run in the workspace) and loops are owner-only by the brief: both are **owner-space only**, for each of the owner's companions (§7). |

What does **not** exist: a turn that starts itself after another turn ended, anything that
re-runs a prompt on a timer inside a conversation, a check the app runs to decide "done" (the board
uses the claim check only; the claim check proves she **didn't lie**, not that the work is
**finished**), a cap that spans several turns, and a way to keep the loop guard's memory across
turns.

Five code facts change the design:
1. **`drain()` already runs after every turn.** The next round needs no scheduler: when a round's
   turn ends and its check is red, the driver adds the next round to the pending queue and `drain`
   starts it (or the owner's queued message goes first, §4.9).
2. **Queued rows become `stale` at start-up and never run.** Rounds and ticks ride the queue, so
   "survives restarts only as paused" is mostly already true; the goal and loop rows get the same
   start-up sweep (`active → paused`, reason `restart`).
3. **The claim check can't say "finished".** `tests_pass` is only checked when she *claims* it. A goal
   needs a check that runs whether or not she says anything: the app runs it (§4.4).
4. **The loop guard forgets at the end of each turn.** Within a goal that is a hole (§4.6).
5. **Nothing reads quiet hours outside `life.ts`/`agenda.ts`/`calls.ts`.** Each has its own copy of
   the wrap-around test. Loops read the `proactive` hours through one small shared helper instead of a
   fourth copy (§5.5).

---

## 2. How Hermes Agent and OpenClaw do it, and where Sara differs

Only features, from their public docs (read 2026-11-01; [H4], [H5], [H6], [O5], [O6] in §13). No code,
prompt or wording is taken.

- **Hermes Agent `/goal` [H4].** A standing objective on the session; after every turn "a lightweight
  judge model checks whether the goal is satisfied by the assistant's last response", and if not, a
  continuation prompt is fed back, until achieved, paused/cleared, or a **turn budget** (20 in the
  example) runs out. Commands: `/goal <text>`, `/goal status`, `pause`, `resume`, `clear`, a drafted
  "completion contract". The page itself names two failure modes: the judge says *continue* when it's
  done (the turn budget catches it) and says *done* when it isn't ("you know better"). It keeps a
  sharp line from its Kanban board (a goal never creates a card; a card can run with its own goal).
- **Hermes Agent `/loop` [H5] and `/heartbeat` [H6].** Re-runs a prompt "on a recurring cadence inside
  your current session"; each wakeup is a real turn. A fixed interval or self-paced (backing off while
  replies don't change, "a local digest comparison"); ends when the agent ends its reply with a
  completion marker, after `--times N`, when an `--until` condition is judged met, by the user, or at
  a backstop of ticks (100 by default). One loop per session; interrupting a wakeup pauses the loop;
  it points at cron for unattended work that must survive restarts.
- **OpenClaw goal [O5].** "One durable objective attached to the current … session"; it continues
  "after a normal turn finishes"; it has token budgets, pause/resume/block/complete/clear (`/goal
  complete` and model-facing goal tools can mark it achieved), and goals "survive process restarts".
  OpenClaw lists `/loop` among its commands [O6] (unverified: command list only).

**Where Sara differs, on purpose:**

| Question | Hermes / OpenClaw (docs) | Sara (this design) | Why |
|---|---|---|---|
| Who says "done"? | A judge model reads her last reply [H4]; the agent or the user can mark it complete [O5] | **Only a check the owner picked, run by the app**: tests, a build, a command, the reviewer role, or the owner's own tap. Her words never end a goal; her *claims* are still checked | The owner's rule: "never self-declared". A judge reading the reply is still the model's word about itself |
| What holds it? | A turn count [H4], token budgets [O5] | The **existing turn budget per round** + goal caps on rounds, minutes, tokens and dollars, summed from the run record; Continue with more stays a button | "Held by the existing budget limits" |
| After a restart | Survives [O5] | **Paused**, with one line; nothing runs until he says Resume | Rule 7: nothing paid starts by itself |
| Loop end | Marker, `--times`, `--until` judge, backstop ticks [H5] | **A required end time**, a tick cap, a daily cap, stop on failure, stop on no-progress, quiet hours; `until` met only with a receipt or a check | Owner's brief |
| Who may loop | The session's user | **The owner only**, in his own chats | Owner's brief |
| Many tools in a loop tick | Full turn [H5] | Full turn, but anything that would **ask** is refused and pauses the loop (nobody is watching) | The approval system stays the owner's |

---

## 3. The shape

```
 /goal get the tests green  (web chip ▸ "Keep going until…", Telegram, Discord, plugin bridges)
   │
   ├─► the goal card: what, the check (picked by the owner), caps ─► Start (owner's tap = the OK)
   │
   └─► round 1 = an ordinary turn (runBackground, TurnOptions.goal, the turn budget as usual)
          │      ├ steer / queue / Stop / approvals / loop guard / ladder: unchanged
          │      └ ends: done │ budget │ stopped │ error │ tools paused
          ▼
        P2 check (the app runs it: tests / build / command / reviewer / "I'll say")
          │
          ├ green + claim check clean + check not tampered ─► ✅ Done (the check's output is the proof)
          ├ red, a new failure or fewer failing ─► round n+1 queued (P1 → pending queue → drain)
          ├ red, the same failure key twice / tools paused / no files changed ─► ⛔ Stuck: here's what
          └ a cap (rounds, minutes, tokens, $) or the round hit its turn budget ─► ⏸ Paused: Continue?

 /loop every 10m: check the deploy and tell me if it's red   (or: until X · for 4h · 12 times)
   │
   ├─► the loop card: every, until, ends at, about N model calls, ~tokens/day ─► Start (owner's tap)
   │
   └─► P4 clock (the reminder tick, 15 s) ─► due? quiet hours? daily cap? busy? ─► tick = queued turn
                                                         │
                                 P5 outcome ◄────────────┘   same → one folded line, no ping
                                                             changed → her message + notification
                                                             met (with a receipt/check) → message, loop ends
                                                             failed ×2 / stuck / end / caps → loop stops, one line
```

### 3.1 Shared building blocks (built once, used by both parts)

1. **P1 · Goals** (`src/goals.ts`, new; part A). `GoalStore` over `chat_goals` and `goal_checks`, and
   the driver: `set(conv, spec, by)`, `afterRound(convId, runId, outcome)` (called from the round's
   own runner when its turn ends), `pause(id, reason)`, `resume(id, more?)`, `stop(id)`,
   `startupSweep()`. It starts each round by **adding a queued owner input** to the conversation's
   `PendingInputs` (`kind: 'queue'`, `sender: 'owner'`, `meta.goal = {id, round}`) with a runner that
   calls `runBackground(convId, text, { goal: {id, round} })`, so rounds and the owner's own messages
   share one order and one busy rule. It never calls a model itself.
2. **P2 · The check runner** (inside `src/goals.ts`; part A, reused by part B's `until` checks).
   `runCheck(app, conv, check, signal) → CheckResult {ok, exitCode, counts?, key, quote, tail, ms,
   tampered?}`. Commands run with `runCommand` (`tools/sandbox.ts`) in the conversation's workspace,
   with the same sandbox info and `shellNetwork` as jobs, a time limit (default 10 min), output
   scrubbed by `app.redactor`; `counts` from `cards.ts testCounts`; `key` and `quote` from
   `triggers.ts errorLine` + `normalizeMessage` (the M10 key, so the guard, recall and "the same
   failure" agree). The reviewer kind runs the existing `team.ts` reviewer role as one helper step on
   the Reviewing route. Each check is a step on the round's run (`rec.tool`, name `goal_check`), so
   Settings → Runs shows it.
3. **P3 · Guard memory across rounds** (`src/loop-guard.ts`, grown; part A). `LoopGuard.seed()` already
   rebuilds a guard from recorded steps for replays. A goal round seeds its guard from the **previous
   rounds' blocked keys** (kept on the goal row, `meta.blocked`), so a call blocked in round 2 is
   still blocked in round 3. An owner steer still clears it (BR2 §5.8).
4. **P4 · Loops** (`src/loops.ts`, new; part B). `LoopStore` over `chat_loops` and `loop_ticks`, and the
   clock: `due(now)` is called from the companion's `ReminderScheduler.tick()` (one more line: no new
   timer, the same `guard('reminders')`). A due tick checks, in code and in this order: the loop is
   `active`; now is before `ends_at`; ticks left; quiet hours (P6); the loop's and the day's ledger
   (`DailyLedger.fits('loop:<id>' / 'loops', …)`); private local mode; then adds a queued owner input
   (`meta.loop = {id, tick}`) whose runner calls `runBackground(convId, prompt, { loop: {id, tick} })`.
5. **P5 · Tick outcome** (inside `src/loops.ts`). After a tick's turn: its outcome from the reply's
   last line (`same` / `changed` / `met`, stripped before the reply is shown), checked in code against
   the tick's receipts and a fingerprint (§5.4); `met` without a receipt is downgraded to `changed`.
   `same` folds the reply into a one-line notice; `changed` and `met` keep her message and notify.
6. **P6 · Quiet hours, one helper** (`src/life.ts`, grown). `quietNow(app, now) → boolean` from
   `settings.proactive.quietStart/quietEnd` in the owner's time zone (the wrap-around test that
   `life.ts`, `agenda.ts` and `calls.ts` each have). Loops use it; the others may switch to it later
   (not required in this phase).
7. **P7 · Commands and cards** (`src/bridges/commands.ts`, grown; `web/persist.js` + `web/persist.css`,
   new). `/goal` and `/loop` (typed, owner only, never reach a model), a parser for the two forms
   (`parseGoalCommand`, `parseLoopCommand`, §4.10, §5.8), and two proposal cards she can offer in a
   chat with the tools `propose_goal` / `propose_loop` (they **only** draw a card; nothing starts until
   the owner taps *Start*), the same pattern as ST8's proposal cards (`web/proposal-card.js`).

### 3.2 Where data lives

Goals and loops live in the **conversation's own** `store.db` (the owner's companions; §7). Everything
is additive (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN` behind a column check, as
`store.ts migrate()` does), so 2.50.x opens a 2.51.0 database and ignores the new tables.

| Data | Database | Part |
|---|---|---|
| `chat_goals` (one standing goal per conversation, its caps, state, totals) | `store.db` (owner's companions) | A |
| `goal_checks` (every check that ran: kind, command, exit, counts, key, quote, tail) | `store.db` | A |
| `chat_loops` (one or more loops per conversation, cadence, end, caps, state) | `store.db` | B |
| `loop_ticks` (every tick: ran or skipped and why, outcome, spend, message) | `store.db` | B |
| Spend per loop and for all loops today | `budget_ledger` (CH3), sources `loop:<id>` and `loops` | B |
| Each round's and tick's turn | `runs` (M3), `policy` JSON gets `{goalId, round}` / `{loopId, tick}` | A, B |
| Rounds and ticks waiting their turn | `pending_inputs` (BR2), `meta.goal` / `meta.loop` | A, B |

Why not the planner's `reminders` table for loops: reminders repeat by day (`Repeat`), carry no caps,
no state machine and no conversation context, and the planner database is shared by several
companions (Phase 31's `owns`). A loop shares the reminder **clock** and is listed **beside** reminders
in Planner, but keeps its own rows. Why not `agenda_goals` for chat goals: those are hers, quote his
words, check in over days and count against her proactive cap; a chat goal is his order for this
chat, now (§4.11).

### 3.3 Settings shape (owner-only; `persist` added to `OWNER_SETTINGS`)

```ts
persist: {
  goals: {
    on: boolean,                  // "Let her keep going until it's done" (default true; each goal still needs Start)
    rounds: number,               // rounds per goal (default 5; pick-list 3 / 5 / 10 / 20)
    minutes: number,              // wall time per goal, waiting for you not counted (default 60; 15 / 30 / 60 / 120 / 240)
    tokens: number,               // all rounds together (default 1,000,000; TOKEN_CHOICES)
    usd: number,                  // all rounds together, paid models only (default 0 = none; USD_CHOICES)
    stuckAfter: number,           // the same failure this many rounds in a row = stuck (default 2; 2 / 3)
    checkMinutes: number,         // time limit of one check (default 10; 2 / 5 / 10 / 20 / 30)
    reviewer: 'reviewing' | 'quick', // the route for the reviewer check (default 'reviewing')
  },
  loops: {
    on: boolean,                  // "Let her repeat things in a chat" (default true; each loop still needs Start)
    minEvery: number,             // shortest interval in minutes (default 5; 1 / 5 / 10 / 15)
    defaultFor: number,           // end time when none is given, hours (default 4; 1 / 2 / 4 / 8 / 24)
    maxFor: number,               // the longest a loop may run, hours (default 24; 8 / 24 / 72 / 168)
    maxTicks: number,             // ticks per loop (default 48; 12 / 24 / 48 / 96)
    tick: { tokens: number, steps: number },  // one tick's turn budget (default 50,000 / 10)
    dailyTokens: number,          // all loops together today (default 300,000; 0 = no cap is NOT offered)
    dailyUsd: number,             // all loops together today, paid models (default 0.5; USD_CHOICES)
    quiet: 'pause' | 'hold',      // in quiet hours: don't run (default) / run but hold the pings until morning
    stuckAfter: number,           // "until" loops: unchanged ticks in a row = no progress (default 6; 3 / 6 / 12)
    failAfter: number,            // failed ticks in a row = stop (default 2; 1 / 2 / 3)
    maxActive: number,            // loops running at once, all chats (default 3; 1 / 3 / 5)
  },
}
```
Per goal and per loop, the card can lower (never raise past the setting) each cap. Every key has a
? tip (§4.13, §5.11).

---

## 4. Part A · keep going until it's done (`/goal`)

### 4.1 Scope

1. **Set a goal** on a chat: from the web chip *Keep going until…*, `/goal <what> [done when <check>]`
   in the web composer or a chat app, or a card she proposes (`propose_goal`) when he says "keep going
   until the tests pass". Nothing runs until the owner taps **Start** (or sends `/goal … ` himself,
   which is the tap).
2. **The check is picked by the owner** from what the project has (tests, build, lint, a command he
   types, the reviewer, or "I'll say when"), shown before Start, **frozen** for the goal.
3. **Rounds:** each round is an ordinary turn; after it, the app runs the check; red → the next round
   gets the real failure; green → done. One standing goal per conversation.
4. **Ends** as *done*, *stuck*, *paused* (a cap, a round's budget stop, a restart, Pause, an approval
   left waiting) or *stopped*, always with one plain message saying which, why, and the check's
   last output.
5. **Visible everywhere:** the chip and ring above the composer, a goal line under each round's reply,
   the progress message header in chat apps, `/goal` and `/status`, Today's background work, the
   board card when it came from one, the run view.
6. **Caps:** rounds, minutes, tokens, dollars, plus each round's own turn budget.
7. **Restarts:** an active goal comes back **paused**, with one line and *Resume*.

Out of scope for 2.51.0: goals across several chats, a goal that spawns helpers by itself (the team
already does that and can be the check's *work*), goals in partner chats, group chats, members'
spaces or off-the-record chats (§4.14, §7).

### 4.2 Lifecycle

```
draft ──Start──► running ──round ends──► checking ──green──► done
  │                 ▲                        │
  │                 └──── next round ◄── red, progress
  │                                          ├── red, same failure ×stuckAfter / tools paused ──► stuck
  │                                          └── a cap reached ──► paused (reason: cap)
  └──Cancel──► (deleted)      running/checking ──Pause / restart / round hit its budget / approval waiting──► paused
                              paused ──Resume (owner)──► running      any ──Stop (owner)──► stopped
```

- **States:** `draft` (card shown, nothing ran), `running` (a round's turn is in progress or queued),
  `checking` (the check runs), `paused` (with `reason`: `owner`, `restart`, `cap:<dim>`, `budget`,
  `approval`, `private-local`, `crisis`, `error`), `stuck`, `done`, `stopped`. `done`, `stuck` and `stopped` are
  final; a new `/goal` replaces a final one (kept in the history list) and asks before replacing a
  running or paused one.
- **Resume** is the owner's only (button, `/goal resume`): it keeps the totals, gives the goal **one
  more round** at least, and, if the pause was a cap, offers the cap again ("+2 rounds", "+30 min",
  "+500,000 tokens") with the same `moreWords` wording as Continue with more. A stuck goal can be
  *Tried again*, which is a new goal with the same text and check and the stuck note as its first
  round's note.
- **Stop** wins at any point: it stops the running turn (`app.stopTurn`), kills a running check (its
  `AbortSignal`), drops the queued round, and the goal is `stopped`. `/stop` in a chat app stops the
  turn **and pauses** the goal (it is the "stop now" button, not "forget the goal"); `/goal stop` ends
  it; `/reset` stops it and clears the queue (CH1 semantics).

### 4.3 The check: what "done" means (picked by the owner)

The goal card lists the checks **this conversation's workspace actually has**, read the way the
code already reads them, with the project's own command shown verbatim:

| Kind | Where the command comes from | Green means | Shown as |
|---|---|---|---|
| `tests` | `projectknow.ts` `commands.test`, else `security/fix.ts detectTests(dir)` | exit 0 **and**, when `testCounts` can read the summary, `failed = 0` and `passed > 0` (a run that found no tests isn't green) | "Tests pass: `npm test`" |
| `build` | `projectknow.ts` `commands.build` | exit 0 | "It builds: `npm run build`" |
| `lint` | `projectknow.ts` `commands.lint` | exit 0 | "Lint is clean: `npm run lint`" |
| `command` | typed by the owner on the card (≤ 400 characters) | exit 0 (and the test-count rule if the output has a test summary) | "This passes: `…`" |
| `reviewer` | `team.ts` `ROLES.reviewer` (read-only tools, no file changes), on the Reviewing route | the last line is `VERDICT: APPROVE`, and the verdict quotes at least one changed file line verbatim (the findings "no theater" check, `validateQuotes`) | "A reviewer model approves the change" |
| `owner` | nobody: after each round the card asks him | his tap on *Yes, it's done* | "I'll say when it's done" |

Rules, all in code:
- **She never picks or changes the check.** She may *suggest* one on her `propose_goal` card (from
  the same list); the owner's Start freezes `check_kind`, `check_command` and the workspace on the row.
  No tool can edit them; `/goal check …` (owner) changes it and resets the stuck count.
- **Checks can combine:** `tests` + `reviewer` (both must pass), or `build` + `tests`. At most three.
  The default on a coding conversation with a test command is **`tests` alone**; with only a build,
  `build`; with neither, the card has no default and asks him to pick (`command`, `reviewer` or
  `owner`).
- **`reviewer` alone and `owner`** are allowed (writing, research, a chat that isn't code), and the
  card and the final message say plainly which it was: "Checked by a reviewer model, not by tests" /
  "You said it's done". The reviewer is never the model that did the round when another model is set
  for Reviewing (risk 4).
- **Not every command is a check.** `classifyCommand` (`sandbox-run.ts`) runs on a `command` (and on
  the project's own command, which can be anything a `package.json` says): a check whose reasons
  include `installs`, `deletes`, `system` or `network` is refused on the card with the reason in
  words ("This check installs packages. Pick one that only runs tests or builds."). `writes` and
  `scripts` are allowed (test runners write caches and run scripts). §11 Q3 asks whether `network`
  should be allowed for a deploy check.

### 4.4 Running the check, and keeping it honest

- **When:** after every round's turn ends with `done` (she answered) or `error` (a model error: the
  check still says where things stand). Not after `stopped` (the owner stopped it) or a budget stop
  (§4.7). Never during a turn: the check is not one of her tools and doesn't appear in her tool list.
- **How:** `runCheck` (P2) in the workspace sandbox, `checkMinutes` time limit, max 400 KB of output
  kept like jobs, scrubbed, the last 4,000 characters stored on `goal_checks.tail`. It runs while the
  conversation shows *Checking…* (the busy state is held, so a typed message queues behind it).
- **The proof:** the check's row is the receipt. The goal can only go `done` from a `goal_checks` row
  with `ok = 1` written by P2 **after** the round's last tool call. A green she *claims* in her reply
  is checked by the claim check as today; the goal ignores it either way.
- **Tamper check.** "Make the tests pass" invites the shortcut of editing the tests. Before the first
  round P2 records a fingerprint of what the check depends on: the command's script line (for `npm
  test`, the `scripts.test` value; `projectknow` already reads it), and the sha256 of every file the
  round touches that matches test paths (`test/`, `tests/`, `__tests__/`, `*_test.*`, `*.test.*`,
  `*.spec.*`, `conftest.py`, `pytest.ini`, `jest.config.*`, `vitest.config.*`) from the run record's
  `files` per step. A green check after a round that **changed the check's script, deleted a test
  file, or changed test files** ends as **`done, review`**: green, but the final message lists the test
  files she changed with *View changes* (the run's diff), and the goal is shown with an amber tick,
  not a green one. Changing tests is often right (a new test for the fix); the owner decides.
- **A check that can't run** (the command isn't found, the sandbox refuses, a time-out): the round
  counts as red with the reason as its failure line; two in a row → `stuck` with "The check itself
  doesn't run: …".

### 4.5 A round: what she sees

Round 1 is the goal's text as the owner's message (it is stored as his message, `meta.goal = {id,
round: 1}`), so the conversation reads naturally. Rounds 2+ are **app notes, not owner messages**:
the round's queued input is stored as a `notice` (`meta.goal`) shown as a small line in the chat
("🎯 Round 2 of 5 · 3 tests still fail"), and the turn gets, at step 0, a `userNote` through a
`beforeModelCall` hook (the same seam Continue with more uses):

```
[Note from the app, not from {owner}: you're working toward a goal {owner} set in this chat:
"{goal text}". Round {n} of {max}. After your last round the app ran the check {owner} picked
({check words}) and it is NOT done yet:
{scrubbed failure: exit code, test counts, up to 20 lines around the failing lines, ≤ 2,000 chars}
{if any: Still blocked from earlier rounds (don't retry them): {calls, ≤ 5}}
Carry on from where you are. Don't redo what is done. Don't say it's finished: the check decides.
When you've done what you can this round, say in one or two sentences what you changed.]
```

- The failure text is **check output**, so it is fenced like tool output (`untrustedPeer`-style
  labels are not needed: it comes from his own workspace, as a test run's output does today) and
  scrubbed by the redactor; it is never shown to a partner or a room.
- The round's turn budget is the **normal one** for the conversation (coding: 200k tokens / 40 steps
  by default) with the ladder; `TurnOptions.goal` changes nothing about approvals: a card in round 3
  is a card, and the goal waits for it (§4.8 for one left waiting).
- `buildHistory` sees earlier rounds as normal history, so later rounds can fill the context; CH1's
  context ring and the oldest-first drop apply as today (`/compact` comes in Phase 123).

### 4.6 Progress, stuck, and the loop guard across rounds

After each red check P1 compares it with the last one, in code:
- **Progress** (go on): the failure key (`name|class|normalizeMessage(errorLine)`) changed, or
  `failed` went down, or `passed` went up, or the check kind's exit code went from non-zero to a
  different non-zero with a different key.
- **No progress** (count +1): the same key, the same or more failing tests, **or** the round changed
  no files (the run record's `files` and `kept` are empty) and the check is red. At `stuckAfter`
  (default 2) rounds of no progress in a row → `stuck`.
- **Tools paused** by the loop guard (`loop_guard` with `paused`) in a round → `stuck` at once ("She
  kept trying the same failing step").
- **Guard memory:** each blocked key and its quote are added to `chat_goals.meta.blocked` (≤ 20); the
  next round's `LoopGuard` is seeded with them (P3), and the round note lists them. A steer from the
  owner clears the list, as it clears the guard today.

`stuck` sends one message (§4.8) with the last failure, what changed in each round (one line each from
the run record), and three buttons: *Try again* (a new goal, same text and check), *Change the check*,
*Done here*.

### 4.7 Held by the budget: caps

Two layers, both existing mechanisms:
1. **Each round is a turn with its own turn budget** (M4), unchanged: the ladder steps down near the
   limit and the summary step stops it. A round that **stops at its budget pauses the goal** (`paused`,
   `reason: budget`) and the reply's own *Continue with N more* button is the way on: pressing it runs
   that turn on (the existing `/continue` route with `budget`), and when that turn ends the goal
   resumes from its check. **The goal never presses Continue.** With `onLimit: 'ask'`, the card at
   the limit is the existing approval card; the goal waits like any approval.
2. **The goal's caps**, summed over its rounds from the run record (`runs` rows with
   `policy.goalId`): `rounds`, `minutes` (wall time from Start, minus time waiting for the owner's
   approvals, which the turn meter already subtracts per round, and minus paused time), `tokens`, `usd`
   (only counted for paid API calls, the `usdMeaningless` rule). P1 checks them with `budgetCheck`
   **before queuing** each round, with the last round's spend as `next` (the same projection the meter
   uses), so a round that would cross a cap doesn't start. Reached → `paused`, `reason: cap:<dim>`,
   message "I stopped before round 4: this goal reached its token budget (1,000,000 tokens). The
   check still says: 2 tests fail. *Resume with +500,000 tokens* / *Stop*."
   The `HARD_STEP_CAP` and the member limits apply per round as today.

The goal's totals are on the chip's ring (the share of the closest cap, the same `frac` / `top` as the
step-line meter), in `/goal`, and in Settings → Usage as purpose `goal` (each round's model calls run
inside `usageScope` with `purpose: 'goal'`; the claim judge and the reviewer check keep their own
purposes).

### 4.8 The end, in words (one message each, her voice where a model may speak)

- **Done:** she writes one short message after the green check (a `complete()` call on the quick
  route like jobs' report, 300 tokens, counted in the goal), checked with `checkClaims` against the
  check's receipt and the rounds' receipts; failing that, the app's words: "Done: the check passed
  (`npm test`: 148 passed, 0 failed) after 3 rounds, 0:41, 412,000 tokens." The check's output is a
  folded card under it.
- **Done, review:** as above, plus "She changed these test files: … Look before you trust it."
- **Stuck / paused / stopped:** **the app's words only** (no model call: the goal may be out of budget
  and these must be exact), in the owner's language through `trOwner`, with the reason, the last
  check's failure line and the buttons.
- **An approval left waiting:** a round that has waited 30 minutes on an approval card pauses the goal
  (`reason: approval`); the card stays and answering it resumes the goal.
- Push: *Done* and *Stuck* notify like "Sara finished" (`push.notifyOwner`), and ring if the owner
  wants long tasks to ring (`calls.wants('job')`); *paused* for a cap notifies once.

### 4.9 Talking to her while a goal runs

BR2's three ways keep their meaning; the goal adds one rule: **his words come first.**
- **During a round** a plain owner message is a **steer** (the default `whileBusy`) and is taken at
  the next safe point, as today. It clears the cross-round guard memory (§4.6).
- **Between rounds** (checking, or the next round queued) a plain owner message is **queued ahead of
  the next round** (P1 adds rounds behind whatever is already waiting), runs as a normal turn with the
  goal note added (it counts as a round, so caps hold), and the check runs after it.
- **`/btw`** works as today and never counts as a round.
- **Typing "stop", "that's enough", "forget it"** is just a message; the buttons and `/goal stop` stop
  it. (No guessing from words: commands are explicit.)

### 4.10 In Telegram, Discord and plugin bridges

Typed commands (not in the menus, like `/progress`), owner only (`commandAllowed`), in his private chat
and his work rooms, never in partner chats or rooms she only talks in:

| Command | What it does |
|---|---|
| `/goal <text>` | Shows the goal card as a message with the default check and caps and *Start* / *Change* buttons (Telegram inline keyboard, Discord components; plugins: the text plus "send `/goal start`") |
| `/goal <text> done when tests` · `… done when build` · `… done when \`cmd\`` · `… done when I say` | The same with the check named (`tests`, `build`, `lint`, `review`, a back-ticked command, `I say`) |
| `/goal start` | Starts the drafted goal (the tap, typed) |
| `/goal` or `/goal status` | "🎯 Get the tests green · round 2 of 5 · checking… · last check: 3 failing · 0:12 · 180k of 1M tokens" |
| `/goal pause` · `/goal resume` · `/goal stop` | As the buttons; `resume` after a cap offers "+ the same again" |
| `/goal check <tests\|build\|lint\|review\|cmd\|I say>` | Changes the check (owner), resets the stuck count |

- `/status` gets one line when a goal stands. `/stop` stops the turn and pauses the goal; `/reset`
  stops it.
- **The progress message** (B4) of a round gets a header: `🎯 Round 2 of 5 · last check: 3 failing`,
  and `⏳ Checking: npm test` while the check runs (the check is a line with the verb "Running the
  tests…" from `web/step-words.js`, its output never shown). Its final line gains the goal's state:
  `✅ Done · round 3 · tests pass` / `⛔ Stuck after round 2` / `⏸ Paused: token budget`.
- The end messages (§4.8) are sent as normal messages (so the phone notifies), with their buttons as
  inline buttons (Telegram) or components (Discord): *Resume*, *Stop*, *Try again*.
- Names in six languages for the subcommand words (`start pause resume stop check`) join
  `COMMAND_WORDS`; the goal text itself is never translated.

### 4.11 The web app

- **Words.** The UI says *Keep going until…* and "goal" only next to it ("this chat's goal"), so it is
  never confused with **her** goals in Planner → *Her plans*. The ? tip says so (§4.13).
- **Starting.** The composer's ▾ menu (BR2's split Send) gains *Keep going until it's done…*: it opens
  the goal card above the composer, prefilled with the typed text: the goal (editable), **Done when**
  (radio list of the checks found, each with its command in mono; *A command…*; *A reviewer
  model*; *I'll say*), **Caps** (rounds, time, tokens, dollars when a paid model is in use, each a
  pick-list no higher than the setting), a line "Each round is one reply within your usual budget
  (200,000 tokens, 40 steps)", and *Start* / *Cancel*. Her `propose_goal` card is the same card inside
  her message, with *Start* / *Not now*.
- **While it runs.** A chip above the composer: 🎯 *Get the tests green* · ring (closest cap) · *Round 2
  of 5* · *Checking…* / *Working* / *Paused: …* · ⏸ / ▶ · ⏹ · ⋯ (*Change the check*, *Caps*, *History*).
  The chip is there on every device showing the chat (hub event `goal`). Each round's reply gets a goal
  line under the step line: "🎯 Round 2 · check after: ❌ 3 failing (was 5)" with the check's output
  folded, and the round's Continue button where the budget stopped it.
- **History.** *History* lists the rounds: when, what she changed (files from the run record), the check
  result, tokens and time, with a link to each run in Settings → Runs.
- **Today.** The *Background work* tile lists running and paused goals ("🎯 Get the tests green ·
  Sara · round 2 · checking") with ⏸ and ⏹, next to jobs and board cards.
- **Accessibility.** The chip is a `role="status"` region; state changes are announced once (not every
  ring tick); every button has a text label; the ring has its numbers in its `aria-label`.

### 4.12 Goals on the board

A card's *Assign → Sara* dialog gains **Done when** with the same checks (default: *Her receipts*,
which is today's rule; the project's tests are offered first on a coding project). With a check:
- board-work starts the card's conversation with a goal (`set(conv, {text: card title + notes, check,
  caps: board settings' budget})`) instead of a single turn, and syncs the card from the goal: `doing`
  while running ("Round 2 · checking"), **Done** only when the goal is `done` **and** the last round's
  claim check found nothing unproven (both rules), *Waiting on you* for `done, review`
  ("Green, but she changed tests: …"), `stuck`, `paused`, an approval; Stop on the card stops the goal.
- The card's activity log gets one line per round and per check (`card_activity`, kind `goal`).
- A card goal counts against **board** concurrency (2 cards at once), not against goals in chats (a
  conversation has at most one goal either way).
- As in Hermes' own split (a goal never creates a card [H4]), **setting a goal in a chat never
  creates a card**, and moving a card never sets a goal.

### 4.13 ? tips (each ≤ 260 characters)

- *Keep going until it's done*: "She works in rounds. After each one Sara runs the check you picked; if
  it fails she gets the real error and goes again, until it passes, she's stuck, or a cap is reached.
  She can't declare it done herself."
- *Done when*: "What has to pass for this to count as done. Tests and builds are run by Sara, not by
  her, and their output is the proof. *A reviewer model* and *I'll say* are for work tests can't check."
- *Rounds*: "The most replies she gets for this goal. Each round is one reply within your usual budget
  per reply."
- *Time*: "Wall time from Start. Time waiting for your OK and paused time don't count."
- *Tokens / Dollars for one goal*: "All rounds together, counted from the run record. Dollars count only
  for paid models. She stops before a round that would go past it, and you can add more."
- *Stuck after*: "If the check fails the same way this many rounds in a row, or a round changes
  nothing, she stops and tells you what she tried."
- *Check time limit*: "A check that runs longer than this counts as failed."
- *Her goals vs this chat's goal*: "Her plans (Planner) are things she keeps at over days, if you let
  her. *Keep going until…* is your goal for this chat, now, and ends when its check passes."

### 4.14 Who, where, and when it can't

- **Owner only**, in the owner's companions' conversations (the main one and the others he made),
  coding or everyday (an everyday chat usually picks *reviewer* or *I'll say*).
- **Not** in partner chats (no tools), group chats (Phase 66 rounds), rooms she only talks in,
  members' spaces (no tools, §7), off-the-record chats (no tools, nothing kept), `/v1`, MCP and A2A
  turns (another app's turn has no say over her next turn), or replays/evals (they run with
  `opts.replay`; a goal row is never created there).
- **Private conversations:** allowed; every round already uses local models only (`resolveChain`), and
  the reviewer check uses a local Reviewing model or isn't offered.
- **Private local mode on:** rounds run on local models as any turn does; a goal whose next round has
  no allowed model pauses (`reason: private-local`) rather than erroring every round.

### 4.15 Tables (additive, `store.db` of each of the owner's companions)

```sql
CREATE TABLE IF NOT EXISTS chat_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  text TEXT NOT NULL,                     -- ≤ 2000 characters, the owner's words
  checks TEXT NOT NULL,                   -- JSON [{kind: 'tests'|'build'|'lint'|'command'|'reviewer'|'owner', command?, words}] (≤ 3), frozen at Start
  workspace TEXT,                         -- the conversation's workspace at Start (checks run there)
  state TEXT NOT NULL,                    -- 'draft'|'running'|'checking'|'paused'|'stuck'|'done'|'stopped'
  reason TEXT,                            -- paused: 'owner'|'restart'|'cap:rounds'|'cap:minutes'|'cap:tokens'|'cap:usd'|'budget'|'approval'|'private-local'|'crisis'|'error'; done: 'review' when tests changed
  caps TEXT NOT NULL,                     -- JSON {rounds, minutes, tokens, usd} (≤ the settings)
  round INTEGER NOT NULL DEFAULT 0,       -- rounds started
  no_progress INTEGER NOT NULL DEFAULT 0, -- red rounds in a row without progress (§4.6)
  used TEXT NOT NULL DEFAULT '{}',        -- JSON {tokens, usd, ms, pausedMs} summed from the runs, refreshed after each round
  fingerprint TEXT,                       -- JSON: the check's script line, test-file hashes at Start (§4.4)
  meta TEXT NOT NULL DEFAULT '{}',        -- {blocked: [{key, quote}], source: 'web'|'telegram'|…, card?: taskId, proposedBy?: 'her'}
  created_at TEXT NOT NULL, started_at TEXT, updated_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX IF NOT EXISTS chat_goals_conv ON chat_goals(conversation_id, state);
-- One standing goal per conversation: enforced in code (a partial unique index on state is avoided
-- for older SQLite builds); `set` refuses a second running/paused one.

CREATE TABLE IF NOT EXISTS goal_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL,
  round INTEGER NOT NULL,
  run_id INTEGER,                         -- the round's run (the check is a step on it)
  kind TEXT NOT NULL, command TEXT,       -- as frozen on the goal
  ok INTEGER NOT NULL,                    -- 1 = green by §4.3's rule
  exit_code INTEGER, timed_out INTEGER NOT NULL DEFAULT 0,
  passed INTEGER, failed INTEGER, skipped INTEGER,
  key TEXT,                               -- the M10 failure key (null when green)
  quote TEXT,                             -- the failure line, scrubbed, ≤ 300 characters
  tail TEXT NOT NULL DEFAULT '',          -- the last 4,000 characters of output, scrubbed
  tampered TEXT,                          -- JSON list of test files / script changed this round, or null
  ms INTEGER NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_checks_goal ON goal_checks(goal_id, round);
```
Final goals and their checks are kept **90 days** (the run view links to them), then removed by the
hourly housekeeping that already prunes `pending_inputs`; deleting the conversation deletes them.

### 4.16 Routes (owner only; the companion's conversations)

- `GET /api/conversations/:id/goal` → the standing goal (or the last final one) with its last check,
  `used`, the caps and the check options for this workspace (`checks: [{kind, command, words}]`).
- `POST /api/conversations/:id/goal` `{text, checks, caps?, start?: boolean}` → 201 the goal
  (`draft`, or `running` with `start`); 409 "This chat already has a goal: stop it first or replace
  it" unless `replace: true`; 400 with the reason for a refused check (§4.3).
- `POST /api/conversations/:id/goal/start` · `/pause` · `/resume` `{more?: {rounds?, minutes?,
  tokens?, usd?}}` · `/stop` · `/retry` (a stuck one, as a new goal).
- `PUT /api/conversations/:id/goal/check` `{checks}` (owner) → resets `no_progress`.
- `POST /api/conversations/:id/goal/said` `{done: boolean}` → the `owner` check's answer.
- `GET /api/conversations/:id/goal/rounds` → rounds with checks, files, spend, run ids.
- `GET /api/goals` → every running and paused goal in this companion (Today's tile).
- Events on the hub: `{type:'goal', conversationId, goal}` on every state change; in the turn's stream
  `{type:'goal_check', goalId, round, ok, passed?, failed?, quote?}` (a new `ChatEvent` member) so the
  web step line and the progress message can draw it.
- Board: `POST /api/board/cards/:ref/work` (ST4) accepts `checks`.

---

## 5. Part B · repeat it in the chat (`/loop`)

### 5.1 Scope

1. **Set a loop** on a chat: `/loop every 10m: check the deploy and tell me if it's red`, `/loop every
   30m until the PR is merged: …`, `/loop every 5m for 2h: …`, `/loop … 12 times`; or the ▾ menu's
   *Repeat this…*; or a card she proposes (`propose_loop`) when he says "keep an eye on it". Nothing
   runs until the owner taps **Start** (typing `/loop …` shows the card; `/loop start` or the button
   starts it).
2. **Each tick is an ordinary turn** in that chat with its context and tools, under a small tick budget.
3. **Quiet unless it matters:** an unchanged result is one folded line, no ping; a change or the
   `until` condition being met is her message and a notification.
4. **Ends** by itself at its end time, after its tick cap, when `until` is met (with proof), after
   `failAfter` failed ticks, after `stuckAfter` unchanged ticks for an `until` loop, at the daily cap
   (paused to tomorrow), or by the owner (Stop / Pause).
5. **Owner only**, budgeted (per tick, per loop per day, all loops per day), quiet hours respected.
6. **Restarts:** active loops come back **paused**, one line each, *Resume*.
7. Listed in Planner beside reminders and *Her plans*, on Today's background work, in `/loop list`.

Out of scope for 2.51.0: self-paced loops that pick their own interval (§11 Q9), loops in partner chats,
rooms she only talks in, members' spaces or off-the-record chats, loops that run a slash command, and
loops that survive restarts running.

### 5.2 Lifecycle

```
draft ──Start──► active ──due──► (skipped: quiet / cap / busy-late / private-local) ──► active
                   │  └─due──► ticking ──same──► active
                   │                     ├changed──► active (her message, a ping)
                   │                     ├met (with proof)──► done
                   │                     └failed──► active (fail_count+1) ──×failAfter──► stopped (failed)
                   ├── same ×stuckAfter (until loops) ──► stopped (no progress)
                   ├── ends_at / max ticks ──► ended
                   ├── daily cap ──► paused (cap:day) ──next local day──► active
                   └── Pause / restart / an approval it would need ──► paused ──Resume──► active
                 any ──Stop──► stopped (owner)
```

- **States:** `draft`, `active`, `ticking`, `paused` (`reason`: `owner`, `restart`, `cap:day`,
  `approval`, `private-local`, `crisis` for 48 h), `done` (until met), `ended` (end time or ticks), `stopped` (with
  `reason`: `owner`, `failed`, `no-progress`). Quiet hours **skip** ticks; they never pause the loop
  (§5.5).
- **One tick at a time per loop.** A tick that comes due while the previous one still runs is skipped
  (`loop_ticks.outcome = 'skipped'`, reason `still running`), never stacked.
- **Missed ticks** (the server was down, or quiet hours) are not made up: the next tick is the next
  slot after now. After quiet hours, if the loop missed at least one tick, the first tick runs at the
  end of quiet hours (one, not the backlog).
- **Pause** keeps the counters; **Resume** sets the next tick to now + `every`; a loop whose end time
  has passed while paused can't resume ("It ended at 18:00 while paused. Start it again?" → a new loop
  with the same prompt).

### 5.3 Saying it, and the card

**The command form** (parsed in code, `parseLoopCommand`; the words in six languages join
`COMMAND_WORDS`, the numbers and units stay as typed):

```
/loop every <n>(m|h)[ for <n>(m|h) | until <hh:mm> | <n> times][ until <condition>]: <prompt>
/loop every 10m: check the deploy and tell me if it's red
/loop every 30m for 3h until the PR is merged: look at PR 42
/loop every 15m until `npm test` passes: …          ← a back-ticked command = a code check (P2)
```
- `every` is required and at least `minEvery` (default 5 min); the end is `for` / `until <time>` /
  `times`, else `defaultFor` (4 h); never past `maxFor` (24 h) or `maxTicks` (48).
- `until <condition>` makes it an **until loop** (it can be *met*); without it, a **watch loop** (it
  reports changes until its end). A back-ticked command after `until` is a P2 check run by the app
  after each tick, with §4.3's command rules.
- A message that only *sounds* like a loop ("check every 10 minutes") is not parsed: she may answer
  with a `propose_loop` card filled from it, which is the same card.

**The card** (web, and as a message with buttons in chat apps):

> 🔁 **Repeat in this chat** · *check the deploy and tell me if it's red*
> Every **10 minutes** · until **14:30** (4 h) · at most **24 times**
> Quiet hours 22:00–09:00: **no checks then** · She tells you **only when something changes**
> About **24 replies**, up to **50,000 tokens** each · today's cap for all repeats **300,000 tokens**
> `[ Start ]  [ Change… ]  [ Cancel ]`

The estimate is code: ticks = min(maxTicks, window / every) minus the quiet-hours slots; the tokens
line is the tick budget; on a paid model the dollars line uses the price table (`findPrice`) the way
the eval estimate does, "about $0.40 at most". Start is the owner's OK for that spend (Rule 7).

### 5.4 A tick, and what counts as a change

A tick's turn gets the prompt as a **notice** in the chat (folded: "🔁 10:20 · check the deploy…") and,
at step 0, a `userNote` through `beforeModelCall`:

```
[Note from the app, not from {owner}: this is a repeat {owner} set in this chat ({every}, until
{end}). Do this now: "{prompt}". {until: The repeat ends when this is true: "{condition}".}
Last time (at {time}) you found: "{last result line, ≤ 300 chars}".
Use your tools to look at the real state now; don't guess from earlier messages.
End your reply with one line, exactly one of: [[loop: same]] [[loop: changed]] [[loop: met]].]
```

P5 then decides, in code:
- **The tag** is read from the last line and **stripped** before the reply is stored or shown (a
  missing or garbled tag = `changed`, the safe side: he hears about it).
- **`met` needs proof:** at least one tool in the tick ran `ok` (a receipt, e.g. `web_fetch`, `git`,
  `shell`) and her reply passes the claim check; for an `until` with a back-ticked command, the P2
  check must be green (her tag is then ignored either way). Without proof, `met` becomes `changed` and
  the loop goes on.
- **`same` is cross-checked:** P5 keeps a fingerprint of each tick (sha256 of the reply's text through
  `normalizeMessage`, which takes out times, numbers like durations, ids and paths, plus the M10 keys of
  any failing tool calls). A `same` whose fingerprint differs from the last one is still `same` (she
  judged the meaning), but a `changed` whose fingerprint is identical is downgraded to `same` (no
  ping for nothing). The fingerprint also feeds no-progress (§5.6).
- **What he sees:** `same` → her reply is stored folded under the tick notice ("10:20 · no change ·
  green") with no notification and no chat-app message; `changed` → her reply as a normal message,
  a push, and the chat app gets it; `met` → the same plus "✅ The repeat is done: {condition}" and the
  loop ends.

**Tools in a tick** are hers as usual (the turn's registry and permissions), but nobody is watching:
**any call that would ask is refused** with "This is a repeat and {owner} isn't watching: anything
that needs an OK pauses it." and the loop pauses (`reason: approval`) with a card listing the call; *Allow
once and resume* runs the next tick with that one call allowed (an `allowed` approval answered ahead,
recorded as the owner's). *Always allowed* tools and read-only tools run. The sandbox gate's
*every*/*risky* modes apply; their cards count as asks.

### 5.5 Quiet hours

- The quiet hours are **the ones he already set for her messages** (`settings.proactive.quietStart` /
  `quietEnd`, default 22–9, through P6 `quietNow`), shown on the card. No second setting.
- `quiet: 'pause'` (default): **no tick runs in quiet hours** (no model call, no spend, no ping); the
  skipped slots are written as `skipped: quiet` and one tick runs at the end of quiet hours if any slot
  was missed.
- `quiet: 'hold'` (the card's *Keep checking at night*): ticks run, `same` stays silent as always, and a
  `changed`/`met` message is stored but **its push and chat-app message wait** until quiet hours end,
  then go as one line ("While you slept: the deploy went red at 03:10"). Crisis lines, approvals and
  safety notices are never held (they don't come from loops anyway).
- A loop never rings a call (`calls.ts`), whatever the job-call setting.

### 5.6 Stops: failure and no progress

- **A failed tick** is a turn that ended in `error` (model error, a private-local refusal), a budget stop
  (the tick budget's summary step), a loop-guard pause, or an `until` check that **can't run**. A red
  `until` check is *not* a failure (it's the thing being waited for). At `failAfter` (default 2) failed
  ticks in a row → `stopped (failed)` with the last error in the app's words.
- **No progress** applies to **until loops**: `stuckAfter` (default 6) ticks in a row with `same` and the
  same fingerprint → `stopped (no-progress)`: "Nothing changed in 6 checks (an hour). I stopped the
  repeat. *Start again* / *Every 30 minutes instead*." Watch loops don't stop for "same" (no change is
  the good news they wait for); they stop at their end time and tick cap.
- **Tools paused** by the loop guard inside a tick counts as a failure; the guard itself is per tick
  (each tick is a fresh turn; P3's cross-round memory is for goals only, because a watch loop *should*
  re-run the same read every time).
- Every stop sends one line in the chat (and the chat app), never a model call.

### 5.7 Budget

- **Per tick:** a turn budget of `tick.tokens` / `tick.steps` (default 50,000 / 10) passed as
  `TurnOptions.budget`, with the normal ladder; `onLimit` is forced to `'wrap'` (nobody to ask).
- **Per loop per day** and **all loops per day:** before each tick P4 checks `DailyLedger.fits('loop:<id>',
  {tokens: cap})` and `fits('loops', {tokens: dailyTokens})` with the last tick's spend as `next`; after
  the tick it adds the run's tokens/usd to both sources. Dollars: `dailyUsd`, paid API calls only. Over
  → `paused (cap:day)`, one line, and it **resumes by itself at the next local day only if its end time
  is still ahead** (the owner's Start already covered that window; the cap is a brake, not a new
  decision). §11 Q8 asks whether the next day should need a tap instead.
- **Household member limits** don't apply (owner only); the owner's own spend shows in Settings → Usage
  as purpose `loop`.
- **Concurrency:** at most `maxActive` loops active across his chats (default 3); a loop tick and a goal
  round in the same conversation queue behind each other; across conversations ticks run like any
  background turn.

### 5.8 In Telegram, Discord and plugin bridges

| Command | What it does |
|---|---|
| `/loop every 10m: …` (and the `for` / `until` / `times` forms) | Shows the card with *Start* / *Cancel* |
| `/loop start` | Starts the last drafted loop in this chat |
| `/loop` or `/loop list` | "🔁 1 · every 10m · check the deploy… · next 10:30 · 3 of 24 · last: no change" per loop |
| `/loop pause [n]` · `/loop resume [n]` · `/loop stop [n]` | One loop (by its number in the list; no number = the only one, else the list) |
| `/loop stop all` | Every loop in this chat |

- Typed only, owner only, in his private chat and his work rooms. A loop set in a work room ticks in the
  room's conversation and posts **only** `changed` / `met` / stop lines there (never `same`), and only if
  the room allows her progress lines; partner chats and rooms she only talks in: never.
- `/stop` stops a running tick (the loop stays active; the next tick runs on time). `/reset` stops the
  tick and **pauses** every loop in the chat ("2 repeats paused").
- No progress message for ticks that end `same`: B4 is created only after `afterSeconds` anyway, and a
  tick's message is suppressed until P5 knows the outcome (for `changed`/`met` the answer arrives as a
  normal message).

### 5.9 The web app

- **Starting.** The ▾ menu next to Send gains *Repeat this…*: the loop card above the composer with
  *Every* (5 / 10 / 15 / 30 min / 1 h / 2 h / 6 h, never below `minEvery`), *Until* (*a time*, *for…*,
  *a number of times*), *Stop when* (optional: *this is true…* text, or *this command passes…*), *At
  night* (*Don't check* / *Keep checking, tell me in the morning*), the estimate line, and *Start*. Her
  `propose_loop` card is the same card inside her message.
- **While it stands.** A second chip above the composer (beside a goal's, if any): 🔁 *check the deploy…*
  · *every 10 min* · *next 10:30* (a minute countdown, seconds only in the last minute) · *3 of 24* ·
  ⏸ / ▶ · ⏹ · ⋯ (*Run now*, *Change*, *History*). *Run now* is a tick at once (counts as one).
- **In the chat.** Ticks with `same` are one folded line each, grouped ("🔁 6 checks · no change ·
  10:20–11:10", expandable); `changed` / `met` are her normal messages with a small 🔁 badge and the
  tick time.
- **Planner → Repeats.** A list of every loop in his chats (active, paused, last 30 days ended), next to
  *Reminders* and *Her plans*: chat, prompt, every, next, ends, ticks, today's tokens, state, with
  Pause/Resume/Stop and *Open the chat*. The section explains in one line: "Repeats are yours; Her plans
  are hers."
- **Today.** *Background work* lists active loops ("🔁 Deploy check · next 10:30") with Stop.
- **Settings → Abilities → Keep going and repeats** holds both parts' settings (§3.3) with ? tips, and
  a read-only line with today's loop spend from the ledger.

### 5.10 How loops relate to what's already there

| Existing thing | What it is | A loop is different because | What they share |
|---|---|---|---|
| Reminders (`planner.ts`, `reminders.ts`) | A **message at a time**, no model call, repeats by day | A loop **runs a turn** with tools, every few minutes, for hours | The 15 s clock (`ReminderScheduler.tick` calls `loops.due`), the Planner page, the "late" rule (missed slots are not made up) |
| Moved-in cron jobs (`movein/schedules.ts`) | Old schedules turned into planner tasks that **never act by themselves** | A loop acts, but only after Start, inside an end time | Nothing runs unasked; a moved-in "every 10 minutes" job could be offered as a loop card in a later phase (not now) |
| Her plans (ST8, `agenda.ts`) | **Her** follow-ups and goals, opt-in, quoting his words, her daily message cap | His order; she never starts or extends one; ticks don't count against her proactive cap (§11 Q12) | Quiet hours (P6 reads `proactive`), the daily-ledger idea, the Planner page, the crisis pause (a crisis line in the chat pauses its loops for 48 h like her plans) |
| Background jobs (`jobs.ts`) | **One command**, running while the chat goes on, a report at the end | A loop is many short turns; a tick may *start* a job (`start_job` is her tool) and the next tick reads it (`job_status`) | Today's background-work tile, Stop, the run record, "interrupted/paused on restart" |
| Webhooks (ST7) | Runs when **someone else** calls | Runs on **his** clock | Per-source caps on runs and tokens a day (`runsPerDay`, `budget`), the ledger |
| The board (ST4) | Cards she works until done | v1: a loop is not a card and a card doesn't loop; a loop tick may move a card with her tools if he asked | Concurrency is separate; both show on Today |
| Goals (part A) | Works until a **check** passes | Waits until the **world** changes | P2 (an `until` command is a P2 check), the queue, the restart rule |

### 5.11 ? tips (each ≤ 260 characters)

- *Repeat this in the chat*: "She does it again on a timer, in this chat, with its context. She only
  tells you when something changes. Each check is one short reply within its own small budget."
- *Every*: "How often she checks. Shorter means more replies and more cost. The shortest allowed is set in
  Settings."
- *Until / For*: "Every repeat has an end. Without one it stops after {hours} hours."
- *Stop when*: "Optional. She stops when this is true and she has looked (a tool really ran). A command in
  back-ticks is run by Sara and must pass."
- *At night*: "Your quiet hours from *Messages from her*. *Don't check* costs nothing at night; *Keep
  checking* tells you in the morning."
- *Repeats per day (tokens / dollars)*: "All repeats together. When today's share is used, they wait for
  tomorrow. Dollars count only for paid models."
- *Stop after failures*: "If her check fails this many times in a row (an error, the budget, a stuck
  step), the repeat stops and tells you why."
- *Stop when nothing changes*: "For repeats with *Stop when*: if nothing changes for this many checks
  in a row, it stops. Repeats that only watch go on until their end."
- *Repeats at once*: "The most repeats running across all your chats."
- *Tick budget*: "One check's limit. A check that reaches it counts as failed."

### 5.12 Tables (additive, `store.db` of each of the owner's companions)

```sql
CREATE TABLE IF NOT EXISTS chat_loops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  prompt TEXT NOT NULL,                   -- ≤ 1000 characters, the owner's words
  every_min INTEGER NOT NULL,             -- ≥ minEvery
  until_text TEXT,                        -- the condition in his words (null = a watch loop)
  until_check TEXT,                       -- JSON P2 check {kind:'command', command} or null
  ends_at TEXT NOT NULL,                  -- always set (≤ maxFor after Start)
  max_ticks INTEGER NOT NULL,
  quiet TEXT NOT NULL DEFAULT 'pause',    -- 'pause' | 'hold'
  tick_budget TEXT NOT NULL,              -- JSON {tokens, steps}
  day_tokens INTEGER NOT NULL,            -- this loop's share a day (default: dailyTokens / maxActive)
  state TEXT NOT NULL,                    -- 'draft'|'active'|'ticking'|'paused'|'done'|'ended'|'stopped'
  reason TEXT,                            -- see §5.2
  next_at TEXT, last_at TEXT,
  ticks INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0, same_count INTEGER NOT NULL DEFAULT 0,
  last_fingerprint TEXT, last_line TEXT,  -- the last result line, scrubbed, ≤ 300 characters
  held TEXT,                              -- JSON message ids waiting for the end of quiet hours
  meta TEXT NOT NULL DEFAULT '{}',        -- {source, proposedBy?: 'her', room?: roomId}
  created_at TEXT NOT NULL, started_at TEXT, updated_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX IF NOT EXISTS chat_loops_due ON chat_loops(state, next_at);

CREATE TABLE IF NOT EXISTS loop_ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loop_id INTEGER NOT NULL,
  n INTEGER NOT NULL,                     -- tick number (skips get 0)
  run_id INTEGER, message_id INTEGER,
  outcome TEXT NOT NULL,                  -- 'same'|'changed'|'met'|'failed'|'skipped'
  why TEXT,                               -- skipped: 'quiet'|'cap'|'still running'|'busy'|'private-local'; failed: the error line
  tokens INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS loop_ticks_loop ON loop_ticks(loop_id, at);
```
Ended loops and their ticks are kept **30 days**, then pruned by the same hourly housekeeping; deleting
the conversation deletes them. Skipped rows for quiet hours are written once per night, not per slot.

### 5.13 Routes (owner only)

- `POST /api/conversations/:id/loops/parse` `{text}` → the card's fields and the estimate (or 400 with
  what's wrong: "every 1 minute is shorter than the 5 minutes allowed").
- `POST /api/conversations/:id/loops` `{prompt, everyMin, until?, untilCheck?, endsAt? | forMin? |
  times?, quiet?, start?}` → 201 the loop; 409 at `maxActive`.
- `GET /api/conversations/:id/loops` · `GET /api/loops` (Planner → Repeats, Today).
- `POST /api/loops/:id/start` · `/pause` · `/resume` · `/stop` · `/run-now` · `PATCH /api/loops/:id`
  (every, ends, quiet; never past the settings) · `DELETE /api/loops/:id` (a draft or an ended one).
- `GET /api/loops/:id/ticks?limit=` → the tick list with run ids.
- Events on the hub: `{type:'loop', conversationId, loop}` on every state change and `next_at` move.

### 5.14 Done when (`test/phase118.test.ts`, plus the existing suites green)

With the **scripted fake model** (`test/helpers.ts` `FakeProvider` / `makeApp`: it plays a script of
steps and records every request), a **fake clock** (`makeApp(dir, clock)`), a temp workspace with a tiny
`package.json` whose `test` script is a Node one-liner reading a file (`node -e "process.exit(require('fs').readFileSync('state','utf8')==='green'?0:1)"`,
printing `ℹ pass N` / `ℹ fail N`), and fake tools in a test registry:

*Part A, goals*
- **The main test, done = the check:** a goal "make the tests pass", check `tests`. Round 1: the fake
  model writes `state = red-a` and answers "All tests pass now!" → the claim check flags it as today,
  **the goal does not end**; the app runs `npm test` (exit 1); a `goal_checks` row `ok = 0` with the
  failure quote; round 2 is queued **behind** nothing and starts by itself; its step-0 request contains
  the app note with the real failure text and "Round 2 of 5". Round 2 writes `state = green` → the
  check passes → state `done`, one final message whose numbers match the check's counts, a `goal`
  hub event per state change, and `/goal` prints "done".
- **Never self-declared:** a script that only ever *says* it's done, five rounds, never changes `state`
  → the goal is `stuck` after round 2 (`stuckAfter` 2: same failure key, no files changed), **not**
  done; with `stuckAfter` 3 it is `stuck` after round 3. No round after `stuck`.
- **Progress resets stuck:** fail with key A, then key B, then key B → `stuck` only after the third.
  Failing tests 5 → 3 → 3 counts as progress then no progress.
- **Tamper:** the round edits `test/a.test.js` and the check goes green → `done` with `reason = 'review'`
  and the final message lists `test/a.test.js`; editing `package.json`'s `scripts.test` → the same.
  A round that only adds a new test file and fixes the code → `review` too (the owner decides; asserted
  so the rule is visible).
- **Refused checks:** a `command` check `npm install && npm test` → 400 with the `installs` reason; `rm -rf
  build && make` → `deletes`; a project command that is network-only (`curl …`) → refused (§11 Q3
  default). `writes` (`jest --ci` writing a cache) is allowed.
- **The check can't be changed by her:** no tool in her registry touches `chat_goals`; a fake
  `propose_goal` call with a different check while a goal runs → a card only, the goal's `checks`
  unchanged.
- **Caps:** rounds 2 → after a red round 2, `paused` with `cap:rounds`, no round 3 queued, message with
  *Resume +2 rounds*; tokens: a cap of 30,000 with rounds of ~20,000 → round 2 is **not started**
  (projection) and the goal pauses before it; minutes with the fake clock, minus a 5-minute approval
  wait (not counted); `usd` ignored on a subscription provider (`usdMeaningless`).
- **Held by the turn budget:** a round that reaches its turn budget (5 steps in the test settings) ends
  with the ladder's summary, the goal goes `paused (budget)`, **no** further round; POST `/continue` with
  `budget` runs that turn on, and after it the check runs and the goal continues.
- **Loop guard across rounds:** round 1 has the same failing call 3 times (blocked); round 2's fake model
  tries it once more → refused at once (seeded); the round note lists it. An owner steer in round 2
  clears it. Tools paused in a round → `stuck`.
- **Stop wins:** Stop during a round → the turn stops, the queued round is dropped, the goal `stopped`;
  Stop while the check runs → the check process is killed (its signal aborted) and no `goal_checks` row
  says green. `/stop` (fake Telegram) → turn stopped, goal `paused`; `/reset` → `stopped`.
- **Owner first:** an owner message posted while the check runs is queued **ahead of** round 3 and runs as
  round 3 with the goal note; a steer during a round is taken at the safe point as in Phase 116.
- **Restart:** a goal `running` (and one `checking`) when the app is rebuilt on the same data folder →
  both `paused (restart)`, no turn started, no check run (fake model `providerCalls` unchanged), one
  notice line each; Resume starts the next round.
- **Reviewer and owner checks:** `reviewer` with a fake helper answering `VERDICT: APPROVE` but quoting a
  line that isn't in the file → not green ("no theater"); with a real quoted line → green, and the final
  message says "Checked by a reviewer model, not by tests". `owner`: after a round the card asks;
  POST `/goal/said {done:true}` → `done`, `{done:false}` → the next round.
- **Who:** `/goal` from a partner (fake Telegram) → refused like other owner commands, never reaches a
  model; a member's space has no goal routes (404); an off-the-record chat → 400; a group chat → 400.
- **Board:** *Assign → Sara* with `checks: tests` → the card is `doing` while rounds run, moves to Done
  only when the goal is `done` **and** the last claim check is clean; `done, review` → *Waiting on you*.
- **Bridges:** fake Telegram: `/goal make it green done when tests` → a card message with Start; the
  progress message of round 2 has the `🎯 Round 2 of 5` header and the final `✅ Done · round 2 · tests
  pass`; the end message is a new message (not an edit).

*Part B, loops*
- **The main test:** `/loop every 10m for 1h: check the deploy and tell me if it's red` → card; Start; the
  fake clock advances 10 minutes and `ReminderScheduler.tick()` runs → one tick turn whose step-0 request
  contains the loop note; the fake model calls a fake `deploy_status` tool (ok: green) and ends with
  `[[loop: same]]` → the tag is stripped, the reply is stored folded, **no push** (fake push recorder
  empty), no chat-app message. Next tick: `deploy_status` returns red, `[[loop: changed]]` → a normal
  message, one push, the fake Telegram gets it. After 1 hour of ticks → `ended`, one line, no more ticks.
- **`met` needs proof:** an until loop where the fake model says `[[loop: met]]` without any tool call →
  treated as `changed`, the loop goes on; with an ok tool call and a clean claim check → `done`. With a
  back-ticked until command, the P2 check decides and her tag is ignored.
- **A `changed` with an identical fingerprint** (same text with a different timestamp) → downgraded to
  `same`, no push.
- **Quiet hours:** with quiet 22–9 and the clock at 23:00, due ticks are skipped (one `skipped: quiet`
  row), no model call; at 09:00 one tick runs (not the backlog). With `quiet: 'hold'` a `changed` at
  03:00 is stored, its push waits, and at 09:00 one push "While you slept…".
- **Failure:** two ticks in a row ending in a fake provider error → `stopped (failed)` with one line; a red
  until-check is not a failure.
- **No progress:** an until loop with six `same` ticks with the same fingerprint → `stopped
  (no-progress)`; a watch loop with twenty `same` ticks keeps running.
- **Budget:** a tick reaching its 10-step budget counts as failed; the loop's daily token share used up →
  `paused (cap:day)`, no model call; the next local day it is `active` again while `ends_at` is ahead;
  the `loops` source in `budget_ledger` matches the runs' tokens; Settings → Usage shows purpose `loop`.
- **No asks while nobody watches:** a tick whose fake model calls a tool with permission `ask` → refused
  with the line, **no approval event**, loop `paused (approval)`; *Allow once and resume* → the next tick
  runs that call once.
- **One at a time:** a tick due while the previous one still runs (a fake tool waiting on a latch) →
  `skipped: still running`; an owner message in the same chat while a tick runs is a steer as usual, and
  a tick due while the owner's turn runs is queued behind it.
- **Limits:** `every 1m` → 400 (below `minEvery`); a fourth active loop → 409; `for 30h` → capped to 24 h
  on the card; no end at all → `defaultFor`.
- **Restart:** active loops after a rebuild → `paused (restart)`, `next_at` cleared, **no tick** runs on
  the next scheduler tick; Resume schedules the next one at now + every.
- **Who:** `/loop` from a partner, in a room she only talks in, from a member, or in an off-the-record chat
  → refused, no row; a crisis line from the owner in the chat pauses its loops (`reason: crisis`, 48 h).
- **Old clients and old data:** 2.50 tables untouched; a database without the new tables opens; the
  `/v1`, MCP and A2A paths can't create goals or loops.

*Both*
- **Safety unchanged:** every round and tick runs the disclosure rule and the minors check on every
  reply (the app's own notes need no `preflight`; the owner's goal text and loop prompt get it once, at
  Start, like a message: a minors hit refuses the card, a crisis hit shows the resources and doesn't
  start it). A fake reply
  that trips `minorSexualMatch` is replaced as today and the goal/loop **stops** with the safety reason),
  and private conversations use local models only (a cloud-only setup → `paused (private-local)`).
- **Commands never reach a model:** `/goal …` and `/loop …` parsed with zero `providerCalls`.

### 5.15 Owner to-dos

On a real coding project from the web app: set *Keep going until* "make `npm test` pass" on a branch with
two failing tests, watch the rounds, the chip and the checks; then try one where the fix needs a test
change and check the amber *review* ending. From Telegram on the phone: `/goal … done when tests`, Start,
`/goal`, `/stop`, `/goal resume`. Set `/loop every 10m for 1h: check <a real CI or status page> and tell
me if it's red` and leave it: check that unchanged ticks stay silent, that a change pings once, that
quiet hours skip, and the Repeats list in Planner. Restart the server with one of each running and
check both come back paused. Look at Settings → Usage for *goal* and *loop*. Decide §11 Q1–Q15.

---

## 6. Safety and money across the phase

### 6.1 The mandatory layer is untouched

Rounds and ticks are turns, so the disclosure, honesty, crisis resources and the minors block run in
each, as they do for any turn; no setting here can switch them off. The approval system stays the
owner's: a goal waits for cards like any turn, a loop tick **refuses** what would ask (nobody is there
to see the card) and pauses. Nothing in this phase approves, denies or skips a card, and the check
runner is not one of her tools.

### 6.2 "Done" is never her word

The only ways a goal ends `done` are a P2 row written by code after the round (`tests`, `build`, `lint`,
`command`), a reviewer verdict that passes the quote rule, or the owner's own tap. Her replies are
checked by the claim check exactly as today (a false "tests pass" is still flagged and corrected), and
the goal ignores them. Loops' `met` needs a receipt or a green check. The tamper rule turns "green
because the tests changed" into an amber ending the owner reviews.

### 6.3 Unattended work

- **Nothing starts by itself.** Every goal and every loop starts with the owner's Start (a tap or his
  own typed command). Her `propose_*` tools only draw cards. After a restart everything is paused.
- **Nothing runs without an end.** Goals: rounds, minutes, tokens, dollars, each round's turn budget.
  Loops: an end time always, a tick cap, a tick budget, a per-loop and an all-loops daily cap.
- **Safety stops win.** A minors-block replacement, a crisis line in the chat (her own pause rule from
  ST8: 48 h for loops in that chat; a goal is paused), or private local mode with no allowed model stop
  or pause the work with the reason; they are never retried automatically.
- **Prompt injection through what she reads.** A tick's `web_fetch` page or a failing test's output can
  contain instructions. They are tool output, as today (scrubbed, fenced, no extra rights); loops can't
  approve anything; a goal round's note carries check output but not the owner's authority (it says
  "Note from the app, not from {owner}").
- **Checks are commands in his workspace.** They run in the workspace sandbox like jobs, with
  `classifyCommand` refusing installs, deletes, system changes and network (§11 Q3), a time limit, and
  output scrubbed by the redactor before it is stored or shown.

### 6.4 Money

New spend is only ever **turns the owner started a goal or a loop for**, inside the caps he saw on the
card. Purposes `goal` and `loop` in Settings → Usage; the `loops` ledger source; paid-model dollars
counted where they mean something (`usdMeaningless`). The check itself costs no model call (except the
reviewer kind, on its own purpose `review`). The progress header, the chip, the stuck detection and
the fingerprints are code only.

### 6.5 Threat model additions (`docs/THREAT_MODEL.md` in the release)

A model that edits tests to turn a goal green (the tamper rule, the amber ending); a check command
smuggled through the project's own `package.json` (`classifyCommand` on the resolved command, the
command shown verbatim on the card); a loop left running to burn money (end time, caps, restart pause,
`maxActive`); a loop as a way to act while the owner sleeps (asks are refused in ticks; quiet hours
skip by default); someone posing as the owner to start one (owner = platform user id, owner-only
commands, as today); a page or test output telling her "say [[loop: met]]" (needs a receipt, a garbled
or unproven tag is a `changed`, the worst case is an early ping); a notification flood (`same` is
silent, fingerprints downgrade empty changes, held pings in quiet hours).

---

## 7. Household isolation

- **Owner space only.** Goals and loops exist in the owner's companions (the main one and the others he
  made), each in its own `store.db`; the routes check the owner's session. Members' spaces get neither:
  their companions have no tools (`isMember`), so a check can't run and a tick couldn't look at
  anything; their routes return 404 and their composer shows neither menu item. §11 Q13 asks about a later
  "member goals with *I'll say*".
- **No crossing.** A goal or loop belongs to one conversation; it reads only that conversation's history
  and workspace, the same as any turn there. Planner → Repeats lists only the signed-in companion
  space's loops; the owner's usage view of members is unchanged (they have no goal/loop spend).
- **Chat apps** are the owner's main companion's, as today; a `/goal` or `/loop` there lands in that
  companion's conversation for that chat.
- **Shared household boards** (Phase 99): a card on a shared board can carry a goal only when the owner
  assigns it to his own Sara; members can't assign work with checks.

---

## 8. Reuse vs build

| Reused as is | Grown | New |
|---|---|---|
| `runTurn`, `runTracked`, `runBackground`, `TurnHooks` (`beforeModelCall` `userNote`), the ladder, `TurnMeter`, `budgetCheck`, `reasonFor`, `moreWords`, `cleanMore`, the `/continue` route | `TurnOptions.goal` / `.loop` (a note at step 0, purposes `goal` / `loop`, `policy` on the run) | `src/goals.ts` (P1, P2) |
| `PendingInputs` (`add`, `drain`, `markStale`, `defaultRunner`), steer at the safe point | queued inputs carry `meta.goal` / `meta.loop`; `drain` order puts owner items before rounds | — |
| `runCommand`, the workspace sandbox, `app.redactor`, `classifyCommand`, `projectknow` commands, `detectTests`, `cards.ts testCounts`, `triggers.ts errorLine` / `normalizeMessage` | — | `goal_checks` |
| `team.ts` reviewer role, `validateQuotes` | one helper step callable on its own (no team task around it) | — |
| `LoopGuard`, `seed()` | seeded from `chat_goals.meta.blocked` between rounds | — |
| `ReminderScheduler.tick` (15 s), `DailyLedger`, `findPrice` | `tick()` calls `loops.due(now)` | `src/loops.ts` (P4, P5), `chat_loops`, `loop_ticks` |
| `proactive` quiet hours, ST8 crisis pause | `quietNow()` exported from `life.ts` (P6) | — |
| `checkClaims`, `complete()` (jobs' report pattern), `trOwner`, `push.notifyOwner` | — | the end messages' templates (six languages) |
| CH1 commands, `commandAllowed`, `COMMAND_WORDS`, Telegram inline keyboards, Discord components | `/goal`, `/loop` (typed), `/status`, `/stop`, `/reset` lines | — |
| B4 progress message, `finalLine`, `web/step-words.js` | a goal header and goal outcomes | — |
| BR2 split Send ▾ menu, chips, `web/proposal-card.js`, Today's background work, Planner, board-work | *Keep going until…*, *Repeat this…*; Planner → *Repeats*; board *Done when* | `web/persist.js`, `web/persist.css`, tools `propose_goal`, `propose_loop` |

Nothing needs an npm package. No new timer (the reminder tick), no new run kind (rounds and ticks are
`turn` runs with a `policy` tag), no new model job (the reviewer uses the Reviewing route).

---

## 9. Risks

1. **The check passes for the wrong reason** (tests edited, a test runner that finds no tests and exits
   0). *Mitigation:* the tamper rule's amber ending; "green" needs `passed > 0` when counts are readable;
   the check's output is always one click away.
2. **Projects without a usable check.** Many chats aren't code. *Mitigation:* `reviewer` and `owner` kinds,
   labelled honestly; no default is guessed when none is found.
3. **Long or flaky checks.** A 15-minute suite run after every round, or a flaky test that flips the
   failure key. *Mitigation:* `checkMinutes`; flaky keys count as progress, so the rounds cap (not
   *stuck*) ends it; the owner can pick a narrower command (`npm test -- test/a.test.js`).
4. **The reviewer approves its own work.** *Mitigation:* never the model that did the round when another
   Reviewing model is set; the quote rule; the label "not by tests"; tests + reviewer as a combined check.
5. **Context fills over rounds.** Ten rounds of a big task can push early rounds out of the history.
   *Mitigation:* the round note restates the goal and the last failure each time; CH1's context ring;
   `/compact` in Phase 123.
6. **Cost surprises on paid models.** *Mitigation:* the card shows the caps and the estimate; dollars
   counted from the price table; caps checked before each round and tick with a projection; a model with
   no price and a dollar-only cap stops at the first such call (the existing L4 rule in `budgetCheck`).
7. **Loop ticks on one-slot local models** compete with the owner's own chat. *Mitigation:* ticks queue
   behind his turns; `maxActive`; the tick budget is small; quiet hours skip by default.
8. **The tag protocol (`[[loop: …]]`) on small models.** They may forget it. *Mitigation:* a missing tag is
   `changed` (he hears too much, not too little), and fingerprints downgrade identical replies to `same`.
9. **Notification fatigue** from a chatty watch loop. *Mitigation:* `same` is silent and fingerprinted; the
   card's default is "only when something changes"; Pause is one tap on the notification's chat.
10. **Restart while a check runs** leaves a child process. *Mitigation:* `stopAllTurns` also aborts running
    checks (their signals), and the sandbox kills the process group as for jobs; the goal is `paused`.
11. **Name clash with her goals (ST8).** *Mitigation:* the words *Keep going until…* and *Repeats*, the
    tip, and a separate Planner section.
12. **Old clients** (phone and desktop apps before 2.51) don't know the chips or cards. *Mitigation:* the
    goal and loop lines are ordinary notices and messages with text, so old clients show them as text;
    Stop on an old client stops the turn (and pauses the goal), which is safe.

---

## 10. The phase at a glance

The release ships its docs in the same commit: a user guide page (`docs/PERSIST.md`: *Keep going until
it's done* and *Repeats*), the CHATS command table, `web/help.html`, CHANGELOG, ROADMAP / ROADMAP.public,
i18n in six languages, ? tips, THREAT_MODEL, and the README "What's new" row.

| Phase | Version | Slice | Main new code | Test |
|---|---|---|---|---|
| 118 part A | 2.51.0 | goals on a chat: the card and the check picker, rounds through the queue, the check runner and tamper rule, progress / stuck, guard memory across rounds, caps over the run record, pause/resume/stop, restart → paused, `/goal` in chat apps, the progress header, the chip, Today, the board's *Done when* | P1/P2 `goals.ts`, P3 in `loop-guard.ts`, `chat_goals`, `goal_checks`, `propose_goal` | `test/phase118.test.ts` (part A) |
| 118 part B | 2.51.0 | loops: the parser and card, the clock on the reminder tick, tick outcome with proof and fingerprints, quiet hours, failure / no-progress stops, per-tick / per-loop / all-loops budgets, asks refused, restart → paused, `/loop` in chat apps, Planner → *Repeats* | P4/P5 `loops.ts`, P6 `quietNow`, `chat_loops`, `loop_ticks`, `propose_loop` | `test/phase118.test.ts` (part B) |

Part B uses part A's check runner for `until` commands and shares the commands file and the web module,
but each part can be built and tested in one helper run (A first). One release, one test file.

---

## 11. Blocking questions (with the defaults the parent applies if the owner is away)

1. **What may count as "done" on its own.** Default: **`tests`, `build`, `lint` or a command** are the
   normal checks; **`reviewer` alone and *I'll say*** are allowed and labelled plainly ("Checked by a
   reviewer model, not by tests" / "You said it's done"). Alternative: code checks only (no goals on
   non-code chats).
2. **Green after she changed the tests.** Default: **`done, review`**: an amber ending listing the test
   files and the script line she changed, *View changes*; on the board it waits on him. Alternative:
   plain *done* (trust the green), or refuse to count it at all (blocks honest new tests).
3. **Network in checks.** Default: **refused** (a check that needs the network is usually a deploy, which
   is a loop's job; the sandbox keeps `shellNetwork` as set for her own commands). Alternative: allow
   `network` when the owner ticks *This check may use the network* on the card.
4. **Goal caps.** Default: **5 rounds, 60 minutes, 1,000,000 tokens, no dollar cap unless he sets one**,
   each round inside the usual turn budget (coding 200k / 40 steps), stuck after **2** rounds without
   progress, a check time limit of **10 minutes**.
5. **A round that hits its turn budget.** Default: **the goal pauses** on that reply's *Continue with
   more* (the owner's override stays his). Alternative: the next round starts anyway while the goal's
   own caps allow (fewer taps, but it turns the per-turn ceiling into a suggestion).
6. **Approvals inside a loop tick.** Default: **refused, and the loop pauses** with *Allow once and
   resume*. Alternative: the tick waits for the card like a turn (a loop at night would sit on a card
   for hours).
7. **Quiet hours for loops.** Default: **no ticks in quiet hours** (the `proactive` hours), one catch-up
   tick when they end; *Keep checking at night* holds the pings until morning. Alternative: ticks run and
   only the pings wait (more cost at night).
8. **The daily cap and the next day.** Default: **a loop paused by the daily cap carries on by itself the
   next local day** while its end time is ahead (Start covered that window). Alternative: it waits for a
   tap.
9. **Self-paced loops** (no interval, she backs off while nothing changes, as Hermes does [H5]).
   Default: **not in 2.51.0**; every loop has an interval. A later option.
10. **Loop limits.** Default: **every ≥ 5 minutes, an end of 4 hours when none is given, 24 hours at most,
    48 ticks, a tick budget of 50,000 tokens / 10 steps, 300,000 tokens and $0.50 a day for all loops,
    3 active loops.**
11. **No progress for watch loops.** Default: **only until loops stop for "nothing changed"** (after 6
    ticks); watch loops ("tell me if it's red") run to their end, since no change is the good news.
    Alternative: watch loops also stop after N unchanged ticks.
12. **Loops and her message cap.** Default: **ticks don't count against her proactive daily cap** (he
    asked for them; her own plans keep their cap), but they **share its quiet hours**. Alternative: count
    `changed` messages against the cap.
13. **Household members.** Default: **no goals or loops for members** (their companions have no tools).
    Alternative later: member goals with *I'll say* or *reviewer* only.
14. **Work rooms.** Default: **the owner may set goals and loops in his work rooms**; rooms get only
    `changed` / `met` / end lines and the goal's end message; partner chats and talk-only rooms never.
    Alternative: private chats only.
15. **How rounds 2+ appear in the chat.** Default: **a small app line, not a message from him**, with the
    note to her sent as the app's (so the history doesn't fill with fake owner lines). Alternative: each
    round as an owner message "keep going" (simpler, but untrue).
16. **The board's default *Done when*.** Default: **her receipts** (today's rule) unless he picks a check;
    a coding project offers its tests first. Alternative: the project's tests by default whenever found.

---

## 12. Key choices in short

- **Done = a check the owner picked, run by Sara**: tests, a build, lint, a command, a reviewer verdict
  with real quotes, or his own tap. Her words never end a goal; a green that came from edited tests ends
  amber, for him to review.
- **A round is an ordinary turn** queued through the BR2 queue, inside the usual turn budget and ladder;
  the goal's own caps (rounds, minutes, tokens, dollars) are sums over the run record, checked before each
  round. *Continue with more* stays his button.
- **Stuck is code:** the same M10 failure key twice, no files changed, or tools paused by the loop guard,
  whose blocks now carry across a goal's rounds.
- **A loop is a queued turn on the reminder clock** with a required end, a tick budget and daily caps on
  the CH3 ledger; quiet hours are her existing ones; unchanged results are silent; `met` needs a receipt;
  two failures or six unchanged until-ticks stop it; anything that would ask pauses it.
- **Owner only, Start always, paused after a restart**, no new timer, no new run kind, no new tables
  outside the four additive ones (`chat_goals`, `goal_checks`, `chat_loops`, `loop_ticks`), zero npm
  runtime dependencies, the mandatory safety layer in every round and tick.
- **Separate from her plans and the board**, but shown beside them: Planner → *Repeats* next to *Her
  plans*, Today's background work, and a board card can carry the same check as a goal.

---

## 13. Sources

Public feature pages, read 2026-11-01 (features only; no code, prompt or wording taken). The index
entries and labels are GAP_REVIEW's (§Sources there):

- [H4] Hermes Agent, *Persistent Goals* (`/goal`: a standing objective; "after every turn a lightweight
  judge model checks whether the goal is satisfied by the assistant's last response"; a turn budget;
  `status`, `pause`, `resume`, `clear`; false-negative / false-positive notes; a goal never creates a
  Kanban card). https://hermes-agent.nousresearch.com/docs/user-guide/features/goals
- [H5] Hermes Agent, *Recurring Loops* (`/loop`: re-runs a prompt "inside your current session"; fixed
  interval or self-paced with "a local digest comparison"; ends by a completion marker, `--times`,
  `--until` judged, the user, or `max_ticks` (default 100); one loop per session; interrupting a wakeup
  pauses it; cron for unattended work). https://hermes-agent.nousresearch.com/docs/user-guide/features/loops
- [H6] Hermes Agent, *Session Heartbeats* (`/heartbeat`; index entry as in GAP_REVIEW).
  https://hermes-agent.nousresearch.com/docs/user-guide/features/heartbeat
- [O5] OpenClaw, *Goal* ("one durable objective attached to the current … session"; continues after a
  normal turn; token budgets; `/goal` start/edit/pause/resume/complete/block/clear; survives process
  restarts). https://docs.openclaw.ai/tools/goal
- [O6] OpenClaw, *Slash commands* (lists `/loop` and `/goal`; unverified beyond the command list).
  https://docs.openclaw.ai/tools/slash-commands

Sara code read for §1: `src/chat.ts` (`TurnOptions`, `ChatEvent`, `TurnHooks` and `joinHooks`, the step
loop's end, the budget outcome, `preflight`), `src/server.ts` (`runTracked`, `runBackground`, the pending
wiring, `app.stopTurn`, `stopAllTurns`, the `/continue` route with `budget`), `src/budget.ts` (turn
budgets, the ladder, `TurnMeter`, `DailyLedger`), `src/runs.ts` (`RunKind`, `RunStatus`, `open`'s
`policy`), `src/jobs.ts`, `src/loop-guard.ts` (`seed`), `src/pending.ts`, `src/bridges/progress.ts`
(`finalLine`, outcomes), `src/bridges/commands.ts` (`MENU_COMMANDS`, `BUSY_COMMANDS`, `DESCRIPTIONS`),
`src/reminders.ts`, `src/planner.ts` (`Repeat`), `src/movein/schedules.ts`, `src/agenda.ts` (settings,
limits, statuses, quiet hours), `src/life.ts` (`DEFAULT_PROACTIVE`), `src/board.ts`, `src/board-work.ts`
(the Done rule), `src/receipts.ts` (`Receipt`, `tests_pass`), `src/cards.ts` (`testCounts`), `src/evals.ts`,
`src/security/fix.ts` (`detectTests`), `src/security/findings.ts` (`validateQuotes`), `src/sandbox-run.ts`
(`classifyCommand`), `src/projectknow.ts`, `src/team.ts` (roles), `src/triggers.ts` (M10 keys),
`src/household.ts` (`MemberLimits`, `OWNER_SETTINGS`), `src/webhooks.ts` (limits), `src/main.ts` (timers,
housekeeping), `test/helpers.ts` (`FakeProvider`, `makeApp`); docs `ROADMAP.md` (Phase 118),
`design/GAP_REVIEW.md` (#6, #14, G4, G5), `design/BRIDGES2.md` (B4, B5, B7), `AGENDA.md`, `BOARD.md`.

## As built (2.51.0)

Phase 118 ships this design (user guide: [../GOALS.md](../GOALS.md)). Where the code differs:

- **Board (§4.12):** the card dialog's *Done when* offers *Her receipts* (default), *Tests pass*,
  *It builds* and *Lint is clean*; a command, reviewer or owner check is set from the card's chat.
  `CardWorker` polls the goal (200 ms) instead of subscribing to its events; the card's activity
  log gets one `receipt` line per checked round (not a new `goal` activity kind).
- **Unattended asks (§5.6):** besides `ask` tools, a coding command the sandbox gate would put on a
  card counts as an ask, so a tick never waits on a card nobody sees.
- **Loop clock in tests:** there is no environment override for the shortest interval; the live run
  used a settings-file value (`persist.loops.minEvery: 0.5`). The settings page offers 1, 5, 10, 15.
- **First tick of a day:** the daily projection uses the last tick's spend only once the loop has
  spent today, so the first tick of a fresh day always runs.
- Round inputs are the last owner message (never an empty turn), and persist turns don't trigger
  `runTracked`'s long-turn push.
