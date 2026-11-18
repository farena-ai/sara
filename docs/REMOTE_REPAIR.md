# Remote repair: a friend's Sara fixes things on your server (T5)

Roadmap: [ROADMAP_T.md § T5](design/ROADMAP_T.md). Built on the support link ([SUPPORT_LINK.md](SUPPORT_LINK.md))
and the messages link ([MESSAGES.md](MESSAGES.md)): no second link and no second code. If Hank and Sam have
linked their Sara servers, Hank can ask Sam's Sara to fix something on his server. **Hank's own Sara checks
and runs every step herself**, through her own self-repair ([SELF_REPAIR.md](SELF_REPAIR.md)) and her own code
changes ([SELF_CODE.md](SELF_CODE.md)), with Hank's OK. Owner only: household members and kid mode never
(on either side); not on the demo.

## Using it

- **Ask** (Hank): in a chat, *"I can't get the weather add-on working, can you have Sam fix it?"* puts a card
  in the Messages chat with Sam (nothing is sent yet). Or open that chat → **Ask Sam to fix something**. The
  card asks **how long** (1 hour, 1 day, 7 days) and **what Sam's Sara may do**:
  - *Look only*: she can read the report and the problem list, nothing else.
  - *Look and fix, with my OK for each step*: every step waits for Hank's **Approve**.
  - *Look and fix within this pass*: one **Approve the plan** runs the steps; **code changes always ask on
    their own**.
  **Give a fix pass** sends the request with Hank's description.
- **Accept** (Sam): a notice pops up (and a push on his phone): *Hank asks you to fix something*. The chat
  shows the request with **Accept** / **Decline**. Both chats then show the pass with its end time; Hank can
  **Revoke** it and Sam can **End** it at any time. A new pass ends the old one.
- **Look and fix** (Sam): *Look and fix Hank's Sara* shows Hank's problem list (from his self-repair) and the
  support report's findings. **Add: fix it** / **Add: learn a skill** put a problem in the plan; below you can
  add a setting change, a skill to learn, or (when Hank's install allows it) a code change request in words.
  **Send plan**. In a chat with her, Sam can also just ask: `remote_look` and `remote_fix_plan` do the same.
- **Run** (Hank): the plan shows in the chat with each step. Hank approves (per step, or once), and watches
  each step go *Running… → Done* (or *Did not work*). Sam sees the same progress live. **Stop** on either
  side stops after the current step and undoes nothing; **Undo** stays next to each step that can be undone.
  At the end both get a short report in plain words (and a notification).
- **Help log** (both sides, under the chat) and the audit trail list every request, accept, look, plan, step,
  stop, undo and end (`remote-repair.*`; the other server's actions as `who: link:<name>`).
- **Private local mode** on Hank's side ("Nothing leaves this computer") refuses fix passes and pauses any
  existing one.

What a plan can contain, and nothing else: a fix from Hank's own problem list (self-repair level 1), learning
a skill on trial (level 2), the settings the support link allows (models, backups, wait before a backup
takes over, Auto's jobs, how much of a chat she reads, memory tidy, inner life), and a code change *request*
(Hank's Sara writes and tests it herself with her own model and caps, then asks Hank under Updates → Code
changes). Never commands, files, remote computer use, passwords or keys, or anything on the self-repair
never-list (safety, limits, kid mode, approvals, audit, permissions).

## Design (one page)

| | |
|---|---|
| Code | `src/remote-repair.ts` (RemoteRepair: fix passes, plans, the step checker `validate`, the runner, status events, `reportOf`), `src/routes/remote-repair.ts` (owner API + peer endpoint), `src/tools/remote-repair.ts` (`remote_help_request`, `remote_look`, `remote_fix_plan`), `web/remote-repair.js` (strip, cards, look panel, plan editor; loaded by `web/support.js`). |
| Reused | The S9b `SupportLink` (link peers, `call`, `verify`, help log, `onChange` → SSE `pm`), `supportReport` + its scrubber (unchanged), `supportFindings`, `cleanChange`/`patchFor`/`SUPPORT_ALLOW`; T1 `Repair` (`detect`, `fix`, `learn`, `undo`, `recordRepair`, `neverTouch`); T3 `selfCodeOf(app).start(request)`; T4 `onNotify` (popup + push). |
| Storage | `<data>/remote-repair.db`: `rr_passes` (id, link, side given/held, scope look/each/pass, problem, hours, status draft/asked/active/declined/revoked, expires_at, asked) and `rr_plans` (both sides' copies; steps as JSON with status, run id, undo flags). Opened with the owner's Messenger and closed with it. |
| Wire | `POST /msg/v1/repair/{request,accept,decline,revoke,look,plan,stop,status}` with the S9b headers; the signature covers `repair \n link \n time \n op \n sha256(body)`. The scope word is signed, so a `support` signature never passes here and a `repair` one never passes on `/msg/v1/support` (tests). Replay ids, 5-min skew, as S9b. 404 for members and the demo. |
| Pass | Helped side is the one that checks: `look`, `plan`, `stop` need an *accepted*, unexpired, unrevoked pass that this owner gave on that link (403 otherwise, audited), and private local mode off. The help pass (S9b) and the fix pass are separate rows and separate scopes. |
| Plan check | Helper: shape only (`stepShape`). Helped: `validate` against its own engines: a `fix` id must be on its current problem list (level 2, or level 1 and fixable), never a never-list setting; `setting` through `cleanChange` (allowlist + its own providers, ranges); `code` only when its T3 is available. One bad step refuses the whole plan (400 with the step's reason). Max 10 steps. |
| Runner | Steps run in order on the helped server. Scope *each*: every step `waiting` until its OK; *pass*: one plan OK, `code` steps still `waiting`. Before each step the pass is checked again (expired/revoked → the plan stops, the rest `skipped`). `fix`/`learn` → `Repair.fix`/`learn` with `by: link:<helper>` (snapshot, verify, auto-undo exactly as local); `setting` → re-checked `cleanChange`, written, `recordRepair` row with a `{path, value}` snapshot so `Repair.undo` can put it back; `code` → `selfCode.start(request)` (her own model/caps/tests; the T3 card asks to apply). Stop marks `stopping`; the runner ends after the current step. |
| Status | After every change the helped side sends a signed `status` (plan id, status, steps without request bodies); the helper's copy updates and its page reloads via SSE. Final status → report + notice on both. Sends for one plan go out in order (each carries the whole state). |
| Code results (U3.18) | A `code` step keeps `change` (the T3 id) and `code: {phase, checks, events}`. SelfCode's `onStatus` → `onCodeStatus(app, c)` → `RemoteRepair.codeChanged`: phases `preparing → prepared` (test names + pass/fail, never output) `→ approved → applied / rolledback / failed`, or `not-prepared`, `undone`, `discarded`, `parked` (`codePhase`). Each new phase: helped help log (`repair-code`), audit `remote-repair.code`, a signed `status` (also after the plan ended). The helper logs each new event, updates its report (`reportOf` adds "Code change #n was applied." …) and gets a notice for not prepared / applied / went back / undone. `sync()` (on every plan list read) catches up phases missed across a restart. Tests: `test/u3-repair-results.test.ts`. |

## Limits and gaps

- Never tried across two real machines or over the internet; loopback only (like S9a/S9b).
- A code change step is "done" when Hank's Sara has started preparing it (the plan does not wait days for
  his OK); since U3.18 its whole life after that (prepared with test results, approved, applied, went back,
  undone) still reaches the helper as status events, the plan view, the report and both help logs. Undoing
  it stays on Hank's Updates → Code changes.
- Fixes that worked can also travel without a fix pass, as opt-in "fix recipes" (U3.17, see SELF_REPAIR.md):
  they only become proposals on the other server.
- Undo is the T1 undo: settings, model switches, add-on off/on and learned skills; stopped jobs, cleared
  caches or database work can't come back (as for local repairs).
- Steps after a stop are marked *Not run*; a new plan is needed to continue.
- The helper sees Hank's problem texts and the redacted report on his own server: a look is only as private
  as that owner's Sara (as S9b).
