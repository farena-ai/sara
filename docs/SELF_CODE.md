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

Where her source is a folder she can write to and that stays after a restart (a **source
checkout**: `git clone` + `node src/main.ts`, or `npm start`), and on a **Linux server install**
through the root helper (below). Everywhere else the card says why and offers a report to the
developers instead:

| Install | Code changes | Why |
|---|---|---|
| Source checkout (`git clone`, `npm start`, `node --watch`) | yes | her own writable folder |
| Linux server (`install.sh`: `/opt/sara` from `/opt/sara-src`) | yes, through the root helper | she still can't write her code; a small root helper applies the change you approved (see below). The server's administrator can turn it off |
| Docker / container image | no | a change would vanish the next time the image is pulled |
| Windows and Mac apps | no | apps are repaired by reinstalling or going back, never by rewriting their code |
| Homebrew / WinGet | no | the package manager owns the files |

### On a Linux server

A server install runs her from `/opt/<name>`, a copy only root can change (the service runs with
`ProtectSystem=strict`). There a small, locked-down **root helper** puts an approved change in place,
the same way `sudo sara update` does:

1. She prepares and tests the change in her own copy in her data folder (made from the source
   checkout, so the related tests are there), exactly as above. The spending and time caps are the same.
2. You press **Approve and apply**. She writes a request in her data folder (the change number, an
   approval id, the patch's fingerprint) and the word `selfcode` in `update-request`, which the
   `<name>-updater` unit already watches. She never gets admin rights.
3. The helper (root) reads the request and patch as her user (so a link can't make root read anything
   else), then checks everything again with **its own copy of the rules** from the root-owned source
   checkout: the request is for this Sara only, it carries an approval id, the patch is the one that
   was approved, no protected path, no test weakening, no path outside the folders the installer
   copies. It never runs a command from the request.
4. It keeps a copy of the files it changes, applies the change to `/opt/<name>`, restarts her and waits
   for her health check. If she doesn't come back healthy it puts the old files back and restarts her.
   The card shows **Applied**, **Went back** or **Refused** with the reason. **Undo** works the same way.
5. `sudo sara update` reinstalls a fresh copy, then puts your changes back in order. A change that no
   longer fits the new version or breaks a rule is **parked** (the card says so); if she doesn't start
   properly with them, they are all taken out and parked.

The source checkout itself is never changed, so another Sara on the same server never gets this
Sara's changes. For the server's administrator:

```sh
sudo sara selfcode            # list the changes in place and the parked ones
sudo sara selfcode revert 12  # take change #12 out (restart, health check, back if she isn't healthy)
sudo sara selfcode off        # turn code changes off entirely: the helper refuses every request
sudo sara selfcode on         # turn them back on (she still asks you on every change)
sudo sara selfcode reapply    # put them back after running install.sh by hand (sara update does it itself)
```

Turning it off keeps the changes already in place (revert them one by one if you want them gone).

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

**Server installs (rootapply, owner decision 2026-11-17).** The rules (`PROTECTED_PATHS`, test
weakening, the patch format) live in `src/self-code-rules.ts`, which imports nothing but Node; the root
side is `src/self-code-root.ts` (imports only that file) plus `deploy/lib-selfcode.sh`, sourced by the
`sara` command. All three are protected paths. Root runs the node part from the root-owned source
checkout, which the helper never patches, so a change can never alter the code root runs. Flow:
`<name>-updater.path` → `sara web-request` → word `selfcode` → `sc_web_request` (reads
`<data>/self-code/root-request.json` and `patches/<id>.patch` with `runuser -u <name>`, `check`,
snapshot + `apply` on `/opt/<name>` (only `src web persona templates skills plugins`; test files are
judged against the checkout), restart, `/api/health` + same version, else `restore` + restart).
Root's state is `/var/lib/<name>-updater/selfcode/` (`queue/` applied patches, `parked/`, `results/`
read by Sara, `snap/` root only) and the marker `selfcode.json` (`{helper, on, src}`) that
`installInfo` reads: `mode: 'root-helper'`, `from` = the checkout her working copies are made from.
The off switch is `/etc/<name>/selfcode-off`. `SelfCode.apply/undo` write the request instead of
touching files; `status()`/`finish()` read the results (a result counts only when newer than the
change's row); her in-app re-apply after an update is skipped there, `sara update` does it
(`sc_reapply`). Deviation from the first sketch: patches go to `/opt/<name>`, not to a `local/selfcode`
branch of `/opt/sara-src`, because several instances can share one checkout and must never get each
other's changes. The approval id is a consistency check written by her own process; the hard limits
are root's own rules, the off switch and the health rollback.

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
refusal. `test/self-code-root.test.ts` (fake root in temp folders, fake systemctl and health): request
checks (approval, other instance, shape), protected path, test weakening, path traversal, swapped patch,
apply + healthy → Applied, unhealthy → rolled back, off switch, undo and `selfcode revert`, `sara update`
re-apply with a conflict parked and an unhealthy re-apply parked, the wiring in `deploy/sara` and
`install.sh`, and SelfCode in helper mode (request written, no live change, results read).
