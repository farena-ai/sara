# Worked examples

Every example below names a policy from `docs/examples/`, the evaluation instant given to a
`FixedClock`, the request, and the decision with its exact audit record. They follow
`docs/POLICY.md`; the rule numbers in brackets say which rules decide the outcome.

```python
from accesspolicy import Evaluator, FixedClock, load_policy_file
from accesspolicy.clock import parse_utc

policy = load_policy_file("docs/examples/office.json")
ev = Evaluator(policy, FixedClock(parse_utc("2026-11-23T10:00:00Z")))
d = ev.evaluate("ana", "wiki:read", "/wiki/reports/q3-2026.md")
print(d.effect, d.statement, d.grants, d.record)
```

2026-11-23 is a Monday; 2026-11-27 is a Friday.

## office.json

**1. A manager reads a quarterly report.** 2026-11-23T10:00:00Z, `ana wiki:read
/wiki/reports/q3-2026.md`. `ana` is assigned `Manager`, which is the role `manager` [R4], and
inherits `employee` and `guest` [R5]. Both `staff-wiki` (`/wiki/**`, specificity (1,0,0,0)) and
`mgr-reports` (`/wiki/reports/q*-*.md`, specificity (2,1,0,1)) apply; `mgr-reports` is more
specific [R14, R17, R38], so its grants are returned and the grants of `staff-wiki` are not
merged in: `{"page_size": 200}`.

```
2026-11-23T10:00:00Z ALLOW principal=ana action=wiki:read resource=/wiki/reports/q3-2026.md reason=allow statement=mgr-reports via=-
```

**2. An employee reads the same report.** Same instant, `ben wiki:read /wiki/reports/q3-2026.md`.
`ben` is not a manager, so only `staff-wiki` applies. Grants `{"page_size": 50}`.

```
2026-11-23T10:00:00Z ALLOW principal=ben action=wiki:read resource=/wiki/reports/q3-2026.md reason=allow statement=staff-wiki via=-
```

**3. The public wiki root.** Same instant, `ben wiki:read /wiki/public/`. The trailing slash is
dropped [R9]; `/wiki/public/**` matches `/wiki/public` itself [R15]. `guest-lobby` (2,0,0,0)
beats `staff-wiki` (1,0,0,0) on resource specificity [R17] although `ben` holds `guest` only
through inheritance. Grants `{}`.

```
2026-11-23T10:00:00Z ALLOW principal=ben action=wiki:read resource=/wiki/public reason=allow statement=guest-lobby via=-
```

**4. A home folder.** Same instant, `ben Files:Read /home/ben//todo.txt`. The action is
lower-cased and the path normalised [R9]; `{principal}` matches `ben` [R16].

```
2026-11-23T10:00:00Z ALLOW principal=ben action=files:read resource=/home/ben/todo.txt reason=allow statement=own-home via=-
```

**5. The HR lock.** Same instant, `ana files:read /files/hr/pay.csv` with context
`{"network": "office"}`. `hr-lock` applies because `ana`'s `dept` is `sales` [R20]: `DENY`.

```
2026-11-23T10:00:00Z DENY principal=ana action=files:read resource=/files/hr/pay.csv reason=explicit-deny statement=hr-lock via=-
```

**6. HR at the office.** Same instant, `hal files:read /files/hr/pay.csv` with context
`{"network": "office"}`. `hr-files` applies (`clearance` 4 >= 3, `network` is `office`);
`hr-lock` does not (`dept` is `hr`).

```
2026-11-23T10:00:00Z ALLOW principal=hal action=files:read resource=/files/hr/pay.csv reason=allow statement=hr-files via=-
```

**7. HR from home.** Same request without a context. `context.network` is missing, so the allow
statement `hr-files` does not apply [R23]; nothing else does.

```
2026-11-23T10:00:00Z DENY principal=hal action=files:read resource=/files/hr/pay.csv reason=no-match statement=- via=-
```

**8. An employee without a department.** Same instant, `ivy files:read /files/hr/pay.csv`. `ivy`
has no `dept` attribute; `hr-lock` is a deny statement, so its condition holds for the missing
attribute [R24].

```
2026-11-23T10:00:00Z DENY principal=ivy action=files:read resource=/files/hr/pay.csv reason=explicit-deny statement=hr-lock via=-
```

**9. Friday night freeze.** 2026-11-27T19:30:00Z (Friday), `ben wiki:write /wiki/eng/plan`. With
the offset +01:00 the local time is Friday 20:30, inside the window that starts Friday 20:00
[R25, R27]. The deny wins over `staff-wiki` [R36].

```
2026-11-27T19:30:00Z DENY principal=ben action=wiki:write resource=/wiki/eng/plan reason=explicit-deny statement=night-freeze via=-
```

**10. The freeze is over.** 2026-11-28T05:00:00Z, the same request. Local time is Saturday 06:00,
which is the (excluded) end of the window [R26, R27].

```
2026-11-28T05:00:00Z ALLOW principal=ben action=wiki:write resource=/wiki/eng/plan reason=allow statement=staff-wiki via=-
```

**11. An invalid request.** 2026-11-23T10:00:00Z, `ben files:read /home/ben/../ana`. The `..`
segment makes the request invalid [R8]; the resource is written as given [R40].

```
2026-11-23T10:00:00Z DENY principal=ben action=files:read resource=/home/ben/../ana reason=invalid-request statement=- via=-
```

**12. Encoding in the record.** Same instant, `ana wiki:read "/wiki/Q&A notes/100%"`. The space
and the `%` are encoded; `&` is printable ASCII and is kept [R40].

```
2026-11-23T10:00:00Z ALLOW principal=ana action=wiki:read resource=/wiki/Q&A%20notes/100%25 reason=allow statement=staff-wiki via=-
```

## sharing.json

`olga` owns the projects and delegates `editor` to `pete` for reading and writing only (until
2026-12-01T00:00:00Z); `pete` passes it to `quinn`, and `quinn` to `rosa`. The maximum depth is
2. All requests are at 2026-11-23T10:00:00Z unless stated.

**13. A delegated write.** `pete doc:write /projects/x`. `pete` holds `editor` at depth 1 through
`d-olga-pete`, whose `actions` include `doc:write` [R29, R30].

```
2026-11-23T10:00:00Z ALLOW principal=pete action=doc:write resource=/projects/x reason=allow statement=edit via=d-olga-pete
```

**14. Reading uses pete's own role.** `pete doc:read /projects/x`. `view` (`doc:read`, action
specificity 2) beats `edit` (`doc:*`, 1) [R38]. `view` is bound by `pete`'s own `viewer` role,
so the chain is empty [R37].

```
2026-11-23T10:00:00Z ALLOW principal=pete action=doc:read resource=/projects/x reason=allow statement=view via=-
```

**15. Outside the delegation's actions.** `pete doc:delete /projects/x`. `d-olga-pete` is not in
force for `doc:delete` [R29], so `pete` holds only `viewer`.

```
2026-11-23T10:00:00Z DENY principal=pete action=doc:delete resource=/projects/x reason=no-match statement=- via=-
```

**16. A chain of two.** `quinn doc:write /projects/x`. `quinn` holds `editor` at depth 2 [R31];
the chain starts with the delegation made by the role's owner [R32].

```
2026-11-23T10:00:00Z ALLOW principal=quinn action=doc:write resource=/projects/x reason=allow statement=edit via=d-olga-pete>d-pete-quinn
```

**17. A broken first link.** `quinn doc:delete /projects/x`. `d-pete-quinn` has no action list,
but the link before it is not in force for `doc:delete`, so nothing reaches `quinn` [R29].

```
2026-11-23T10:00:00Z DENY principal=quinn action=doc:delete resource=/projects/x reason=no-match statement=- via=-
```

**18. Too deep.** `rosa doc:write /projects/x`. The holding would have depth 3 [R31].

```
2026-11-23T10:00:00Z DENY principal=rosa action=doc:write resource=/projects/x reason=no-match statement=- via=-
```

**19. Expiry.** 2026-12-01T00:00:00Z, `quinn doc:write /projects/x`. At its `expires` instant
`d-olga-pete` is no longer in force, and the chain behind it breaks [R29].

```
2026-12-01T00:00:00Z DENY principal=quinn action=doc:write resource=/projects/x reason=no-match statement=- via=-
```

**20. An inherited role through a chain.** `quinn doc:read /projects/archive/a`. `quinn` holds
`viewer` because the delegated `editor` inherits it [R30]; `view` wins on action specificity and
its chain is reported.

```
2026-11-23T10:00:00Z ALLOW principal=quinn action=doc:read resource=/projects/archive/a reason=allow statement=view via=d-olga-pete>d-pete-quinn
```

**21. Even the owner.** `olga doc:delete /projects/archive/a`. `owner` inherits `editor`, so the
deny applies to `olga` too [R36].

```
2026-11-23T10:00:00Z DENY principal=olga action=doc:delete resource=/projects/archive/a reason=explicit-deny statement=no-archive via=-
```

## oncall.json

The on-call window is 18:00 to 08:00 local time (offset -05:00) on weekdays, plus all of Saturday
and Sunday. The weekday window crosses midnight, so the Friday window ends on Saturday 08:00, and
each weekday window ends on the following morning [R27].

| instant (UTC)          | local time (-05:00)  | decision                        |
|------------------------|----------------------|---------------------------------|
| 2026-11-23T22:59:59Z   | Mon 17:59:59         | DENY `no-match`                 |
| 2026-11-23T23:30:00Z   | Mon 18:30:00         | ALLOW `night-shift`             |
| 2026-11-24T12:59:59Z   | Tue 07:59:59         | ALLOW `night-shift` (Monday's)  |
| 2026-11-24T13:00:00Z   | Tue 08:00:00         | DENY `no-match`                 |
| 2026-11-28T04:00:00Z   | Fri 23:00:00         | ALLOW `night-shift`             |
| 2026-11-30T04:59:59Z   | Sun 23:59:59         | ALLOW `night-shift` (Sunday's)  |
| 2026-11-30T05:00:00Z   | Mon 00:00:00         | DENY `no-match`                 |

The last row is not covered: Sunday's window ends at Monday 00:00 (exclusive), and the weekday
window of Sunday does not exist because `sun` is not in its `days`. For example:

```
2026-11-24T12:59:59Z ALLOW principal=sam action=ops:restart resource=/prod/web reason=allow statement=night-shift via=-
2026-11-30T05:00:00Z DENY principal=sam action=ops:restart resource=/prod/web reason=no-match statement=- via=-
```
