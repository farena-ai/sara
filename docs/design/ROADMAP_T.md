# ROADMAP_T: self-repair and growth

Owner (2026-11-16): "self repair. If something is broken, or if something is not working right, it can repair
itself. Ask the user, get the full permissions, and be able to repair, fix, enhance, essentially come alive and
be able to grow and function." Plus: a friend's Sara can fix things on another linked server when asked, and
better new-message notices (one-to-one prominent, communities quieter).

Decisions (owner approved the recommended design): level 1 fixes run on their own and are reported; levels 2
and 3 ask once per repair (not per step); a "full permission for 24 hours" switch; code fixes use the coding
model with a per-repair spending cap (default $2); fixes found on other servers can be reported to the
developer with that owner's OK, private details removed; desktop apps are repaired by reinstalling or rolling
back, never by rewriting their code.

Never, at any level or permission: turn off or edit the safety layer, hard limits, kid mode, approvals or the
audit trail; read or change vault values; give herself more permission. Every action is logged.

| # | Item | Wave |
|---|---|---|
| T1 | Repair engine and level 1 (fix the setup): detect from health, doctor, self-test, health history and turn errors; a playbook of fixes with a snapshot first and automatic undo when health gets worse; Repairs page; "fix yourself" in chat | T-A |
| T2 | Level 2 (grow): repeated failures or a requested ability become a proposed skill, automation or add-on, on trial before trusted | T-A |
| T3 | Level 3 (change her own code): edit in a separate copy, full tests, plain-words change summary, one approval, apply with snapshot, health check, automatic rollback; local changes re-applied after updates; optional report to the developer | T-A |
| T4 | Messages notices: the link code expires, the link does not (say so); a popup for new one-to-one messages; a quiet community indicator with per-community notify all / mentions / none (default mentions) | T-A |
| T5 | Remote repair between linked servers: "can you have Sara fix it" sends a help request with a repair pass; the helper's Sara diagnoses and proposes a plan; the helped server runs it through its own repair engine after its owner approves (or within a time-limited "let her fix it" pass); live progress and Stop on both sides; full log | T-B |
