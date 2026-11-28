# Design

The package is split by section of `docs/POLICY.md`:

| module                    | responsibility                                                       |
|---------------------------|----------------------------------------------------------------------|
| `accesspolicy/loader.py`  | turns a policy document into a `Policy` (sections 1, 2, 8), raising `PolicyError` |
| `accesspolicy/model.py`   | the `Policy`, `Statement`, `Delegation`, `PrincipalEntry` and `Decision` objects |
| `accesspolicy/names.py`   | id and role-name syntax shared by the loader and the evaluator       |
| `accesspolicy/roles.py`   | role inheritance (`RoleGraph`)                                       |
| `accesspolicy/actions.py` | action patterns and their specificity (section 4)                    |
| `accesspolicy/paths.py`   | splitting and joining resource paths (R9)                            |
| `accesspolicy/patterns.py`| resource patterns and their specificity (section 5)                  |
| `accesspolicy/conditions.py` | attribute conditions (section 6)                                  |
| `accesspolicy/timewindow.py` | time windows (section 7)                                          |
| `accesspolicy/delegation.py` | which roles a principal holds for one request (section 8)         |
| `accesspolicy/request.py` | building a `Request` from the caller's arguments (section 3)         |
| `accesspolicy/evaluator.py` | the decision procedure (section 9) and writing the audit record    |
| `accesspolicy/audit.py`   | formatting records and the audit sinks (section 10)                  |
| `accesspolicy/clock.py`   | `FixedClock`, `SystemClock` and timestamp helpers                    |
| `accesspolicy/explain.py` | the `explain` command's listing of applicable statements             |
| `accesspolicy/cli.py`     | the command line                                                     |

## Flow of one evaluation

1. `Evaluator.evaluate` reads the clock and builds a `Request`.
2. `Evaluator.matches` collects the applicable statements. For each statement it checks the
   binding (principal list or held roles), the actions, the resources, the attribute conditions
   and the time windows, and records a sort key.
3. `Evaluator._decide` turns the applicable statements into a `Decision`.
4. The audit record is formatted and written to the sink.

## Conventions

- Everything that can be checked when a policy is loaded is checked by the loader, so the
  evaluator can assume a well-formed `Policy`.
- Timestamps are aware `datetime` objects in UTC everywhere inside the package.
- Role names are stored lower-case.
- Sort keys are tuples where a larger tuple is better, so `max()` picks the winner.
