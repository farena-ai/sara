# Self-repair: she fixes her own setup, and grows

Roadmap: [ROADMAP_T](design/ROADMAP_T.md) T1 (repair engine, level 1 "fix the setup") and T2 (level 2 "grow").

## For you

Sara checks herself every 15 minutes, and whenever you ask ("something is broken", "fix yourself", "check
yourself"). She looks at her health checks, the full check (doctor), the "Check everything" self-test, the
health history, recent failed replies and tools, model services, sign-ins, add-ons, background jobs and
errands, the database, disk space, settings, and the Sara apps on your computers.

**Level 1: fix the setup.** These she can fix:

| Problem | What she does | Undo |
|---|---|---|
| A model service doesn't answer | asks it again; a local model that went missing is downloaded again; otherwise switches talking to your backup model (Settings → Models & usage → Default model). In "Nothing leaves this computer" mode she only switches to a model on this computer | puts the old model back |
| A background job is stuck past its time limit | stops it | — |
| An errand hasn't moved for a day | gives it a push to take its next step | — |
| An add-on stopped working | starts it again; if it keeps failing, turns it off | turns it back on |
| The database reports damage or has lots of empty space | makes a backup first, then rebuilds the indexes and compacts it | restore that backup under Privacy & system → Backups |
| The disk is almost full | clears her own caches older than a day (downloads, imports, throwaway copies she can make again) | — |
| A setting has a value that can't work | puts it back to its default and shows which value it was | puts the old value back |
| A Sara app's update failed | asks the app to install again with its own updater (it keeps the previous version and goes back by itself) | — |
| You were signed out of a mailbox | only asks you to sign in again: she never types passwords | — |

Every fix is *check → copy of what was there → change → check again*. If health is worse afterwards (or the
problem is still there), she puts it back by herself and says so.

**Level 2: grow.** When the same thing fails again and again (the same error stopped 3 replies this week, or
one tool failed 3 times), she suggests learning a skill for it. You can also ask her to "learn to do X": she
proposes a skill, an automation, or an add-on to look for in Get more. New skills and automations start **on
trial** (a skill is used only when it clearly fits; an automation's steps still ask where they always do), and
both can be undone. Add-ons always install through Get more, where you see what they may do.

**Permission** (Settings → Privacy & system → Health → Self-repair):
- *Small fixes on her own, then tell me* (the default): level 1 runs by itself; you get a notification after.
- *Ask me first, every time*: every fix waits for your OK.
- *Full permission for 24 hours*: one OK covers every step of a bigger repair until it runs out.
- Learning something new (level 2) always asks, once per repair.

**Never**, at any level or permission: she does not turn off or edit the safety layer, hard limits, kid
mode, approvals or the audit trail; never reads or changes passwords and keys (the vault); never gives herself
more permission. Every action is in the audit trail (Privacy & system → Safety check-up → Audit trail). Only
the owner has self-repair: household members and kid mode never see it. Desktop apps are repaired only by
reinstalling or going back to the previous version through their own updater, never by changing their code.

The **Self-repair** card shows what is wrong now (with *Fix it*, *Learn a skill*, *Not now*, or *Open* for
the page that fixes it), and what she fixed (each step, *Undo* while it can still be undone).

## Design (one page)

- `src/repair.ts`: the engine, no server imports. `detectProblems(env)` builds the list: each `Problem` has a
  stable `id` (`model:<provider>`, `addon:<id>`, `job:<id>`, `errand:<id>`, `db:integrity|bloat`, `disk:low`,
  `setting:<path>`, `app:<id>`, `signin:<id>`, `health:<check>`, `doctor:<check>`, `selftest:<id>`,
  `turns:failing`, `grow:turn:<kind>`, `grow:tool:<tool>`), `level`, `severity`, an English key + params, evidence,
  and `fixable`. `Repair` keeps the last list, `due(now)` (the reminder tick, at most every 15 minutes; level 1
  runs alone when `runsAlone()`), `fix(ids | 'everything')`, `undo(runId)`, `learn()`, `decline()`, and the
  log table `repair_runs (id, level, problem, title, params, steps, snapshot, result, undone, undoable, by,
  trial_until, at)`. Health score = sum of level-1 severities; a fix is undone when the score rises or a new
  problem appears, or when it didn't fix anything.
- `src/repair-env.ts`: the real adapters, reusing what exists: `healthReport`, `gatherTrouble`/`noteCall`
  (model, sign-in), `HealthHistory`, turn/tool errors from the store, `JobManager`, `Errands`, the add-on
  manager (`setEnabled`, status `crashed`), `createBackup`, `PRAGMA quick_check`/`REINDEX`/`VACUUM`, `ModelPuller`,
  `AppInstalls.ask` (the apps' own updaters), `SkillStore.save` + `setLearned(trial)`, `Automations.create`,
  push notifications for "fixed on her own". `repairOf(app)` is undefined for members and kid mode.
- `src/routes/repair.ts`: `/api/repair` (GET, `check`, `fix`, `decline`, `learn`, `runs/:id/undo`, `settings`),
  owner only (403 for members, kid mode, demo), in `AUDITED`; the engine writes `repair.*` audit rows itself.
- `src/tools/repair.ts`: `repair_status` (read-only, interruptible) and `repair_fix` (problem id, `everything`,
  or `learn`). `prepare()` returns `auto` for level 1 under `auto1` or the 24-hour switch; level 2 always asks.
  Lean family `repair` (six languages); persona lines under "Fixing yourself".
- Settings: `repair.permission` (`auto1` | `ask`) and `repair.fullUntil` (ISO or null), read with
  `repairSettings()`, `fullOn()`, `runsAlone()`. T3 (`src/self-code.ts`) reads the same two.
- Never-list: `neverTouch(path)` + `safeSet()` are the only way a repair writes a setting; problem ids on a
  never-path are refused and audited. The engine has no vault handle.
- For T3/T5: `recordRepair(app, run)` adds a row to the log (and an audit row).
- Web: `web/repair.js` on the Health page (a top-level card, its own "On this page" entry).
- Tests: `test/t1-repair.test.ts` (fake env + clock: detection, every playbook fix, undo on worse health,
  permissions incl. 24-hour expiry, growth on trial, never-list), `test/t1-repair-routes.test.ts` (real
  server: owner/member/kid, audit rows, settings, tools' cards).

Known limits: undo is automatic only for settings, the model switch, add-on off/on and growth; a database fix
goes back through its backup (a restore needs a restart); stopped jobs and cleared caches can't come back.
"Reinstall the same version" for add-ons is a restart of the same installed version (the Store's own
"Go back" stays on Get more → My add-ons).
