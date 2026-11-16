# Code changes: Sara fixes her own code (self-repair level 3)

When something in Sara is broken and settings or a repair can't fix it, she can change her own code.
She does it carefully: in a separate copy, tested, shown to you on one card, and only after you press
**Approve**. If she doesn't start properly afterwards, she goes back to the files she had by herself.

## Using it

- **In chat:** "Sara, the weather card shows Helo instead of Hello, can you fix your code?" She asks
  first (the `self_code_fix` tool always asks), then prepares the change in the background.
- **In Settings → Privacy & system → Updates → Code changes:** write what is broken, press
  **Prepare a fix**.

Each change gets one card: a plain-words summary, **Show the change** (the diff, folded), and the
checks (typecheck, related tests, the full test suite when it fits in the time, a test start).

- **Approve and apply**: she keeps a copy of the files she changes (and her version), applies the
  change, restarts, and waits for her health check. If she doesn't come back within 3 minutes, or comes
  back less healthy, she puts the old files back, restarts and tells you.
- **Undo**: takes an applied change out the same way (copy, restart, health check).
- **Discard**: forgets a change that wasn't applied.
- **Send this fix to the Sara developers** (off until you tick it): shows exactly what would be sent
  (the problem, her summary, the diff and the check results, with emails, keys, home folders and
  addresses removed), and sends it only when you press **Send**.

Settings on the same card: **Spending cap per fix** (default $2: the coding model stops at it) and
**Time cap** (default 20 minutes, checks included).

### After an update

Your code changes are kept as a list of patches in her data folder. After an official update, she
puts each one back into a separate copy of the new version first and runs the checks. Changes that
still fit and pass go back in (with the same restart and health check); a change that no longer fits
or fails the tests is **parked** and you are told. Ask her again for a parked fix if you still need it.

### Where it works

Only where her source is a folder she can write to and that stays after a restart: a **source
checkout** (`git clone` + `node src/main.ts`, or `npm start`). Everywhere else the card says why and
offers a report to the developers instead:

| Install | Code changes | Why |
|---|---|---|
| Source checkout (`git clone`, `npm start`, `node --watch`) | yes | her own writable folder |
| Linux server (`install.sh`: `/opt/sara` from `/opt/sara-src`) | no | a read-only copy made by root (only `sudo sara update` changes it; the service runs with `ProtectSystem=strict`) |
| Docker / container image | no | a change would vanish the next time the image is pulled |
| Windows and Mac apps | no | apps are repaired by reinstalling or going back, never by rewriting their code |
| Homebrew / WinGet | no | the package manager owns the files |

### What she never changes

At any level and with any permission: the safety layer, hard limits (budgets, network and tool
policies, private local mode), kid mode and household limits, approvals, the audit trail, the vault
and sign-in, her own permissions and this repair code, the tests that guard those, install scripts,
the apps, and her dependencies. A change that touches one of them is refused, and so is a change that
weakens tests (deletes a test file, removes checks or tests, or makes tests skip). Every step writes a
row in the audit trail. Owner only: household members, kid mode and the demo can't use it. In private
local mode only a local coding model is used.

## Design (one page)

**Decisions** (owner, ROADMAP_T): level 3 asks once per repair (the Approve on the card); a per-repair
spending cap (default $2, `selfCode.capUsd`); desktop apps are repaired by reinstalling or going back,
never by rewriting their code; fixes may be reported to the developers with the owner's OK, private
details removed. T1's `repair.permission` / `repair.fullUntil` are read (defaults `auto1`, none) and
shown; level 3 always waits for the Approve, also during a full-permission window.

**Shape.** `src/self-code.ts` (`SelfCode`, one per server, the owner's main companion; `selfCodeOf(app)`
is undefined for members, kid mode and the demo). `proposeCodeFix` = `SelfCode.propose`/`start`:
`makeWorkdir` (a `git worktree` of HEAD plus her uncommitted changes, else a copy; `node_modules` is a
junction, unlinked before the folder is removed), the coding model (owner's coding route, metered as
`self-code`) answers JSON (`read` / `edits` / `give_up`), edits are applied in the copy, `runChecks`
(typecheck; related tests = test files importing a changed file; the full suite when the time left is
more than 40 minutes; else a smoke start on a free port with an empty data folder until `/api/health`).
Failing checks go back to the model twice at most. The patch is `<data>/self-code/patches/<id>.patch`
(own unified format, applied by line matching with up to 3 lines of context fuzz, all files or none);
rows in `self_code_changes`. Approve: rules again, `snapshots/<id>/` (files + `manifest.json` with the
version), apply, then the restart runner (`src/self-code-runner.ts`, started detached; Sara emits
SIGTERM to shut down): it waits for her to exit, starts her the same way, polls `/api/health` (and
`/api/health/ready` when it was fine before), restores the snapshot and starts her again when not;
under `node --watch` the watcher restarts her. The result file is read at the next start (`finish`),
then `afterBoot` checks the queue: a patch whose lines aren't in her files is re-applied in a copy,
checked, then applied live through the same runner, or parked.

**Routes:** `/api/self-code` (GET status, POST request, PUT settings; `/:id` GET card with diff,
`/apply`, `/undo`, `/discard`, `/report` GET preview / POST `{send:true}`), owner only, apply and undo
ask a remote device first (`restart`).

**Risks.** A model change that passes the related tests but breaks something else: the full suite
runs when there is time, the health check and rollback catch a broken start, Undo is one press.
Dependencies are linked, not copied: deleting the copy unlinks first (tested). The runner restarts
her with the same environment; a source checkout under systemd with `Restart=always` may briefly race
it (the second start fails on the busy port; health is still checked).

**Tests** (`test/self-code.test.ts`, a tiny fake source tree; the real repository is never touched):
protected-path refusal, test-weakening refusal, patch round trip, install kinds, copy and worktree
modes (node_modules survives), related tests, smoke start, apply + health ok, apply + health bad →
rollback, Undo, patch queue re-apply after a fake update, conflict and failing-test parking, cost cap
stop, time/fix rounds, private local mode, hub report scrubbed and previewed exactly, member and kid
refusal.
