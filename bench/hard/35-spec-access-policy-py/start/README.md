# Gatekeeper

A small access-policy evaluator for internal tools. A policy (a JSON document) describes roles,
principals, allow and deny statements, time windows and delegations; the evaluator answers
"may principal P do action A on resource R?" and writes one audit line per question.

- `docs/POLICY.md` is the specification (rules R1 to R40). It is the reference for every
  behaviour; the code must follow it.
- `docs/EXAMPLES.md` walks through the example policies in `docs/examples/`.
- `docs/DESIGN.md` describes the modules.

## Usage

```python
from accesspolicy import Evaluator, FixedClock, MemoryAuditSink, load_policy, utc

policy = load_policy({
    "version": 1,
    "roles": {"editor": {"inherits": ["viewer"]}},
    "principals": {"alice": {"roles": ["editor"]}},
    "statements": [
        {"id": "read-docs", "effect": "allow", "roles": ["viewer"],
         "actions": ["docs:read"], "resources": ["/docs/**"]},
    ],
})
sink = MemoryAuditSink()
evaluator = Evaluator(policy, clock=FixedClock(utc(2026, 11, 23, 10, 0)), audit=sink)
decision = evaluator.evaluate("alice", "docs:read", "/docs/handbook")
decision.allowed     # True
decision.statement   # "read-docs"
sink.lines[-1]       # "2026-11-23T10:00:00Z ALLOW principal=alice action=docs:read ..."
```

`evaluate(principal, action, resource, context=None)` returns a `Decision` with `effect`
(`"ALLOW"` / `"DENY"`), `reason`, `statement` (id or `None`), `grants` (dict), `via` (tuple of
delegation ids) and `record` (the audit line). The evaluator never reads the system clock on its
own: pass `FixedClock` in tests and `SystemClock` in services.

## Command line

```
python -m accesspolicy lint docs/examples/office.json
python -m accesspolicy check docs/examples/office.json ben wiki:read /wiki/public --at 2026-11-23T10:00:00Z
python -m accesspolicy explain docs/examples/sharing.json quinn doc:write /projects/x --at 2026-11-23T10:00:00Z
```

`--context key=value` adds a request context value (parsed as JSON when possible, so
`--context level=3` is a number and `--context site=hq` a string). `check` exits 0 for ALLOW and
1 for DENY.

## Development

Python 3.10 or later, standard library only.

```
python -m unittest discover -s tests
```

## Status

Version 0.4 covers roles, actions, literal and wildcard paths, simple attribute equality and
same-day time windows. Several parts of the specification are not implemented yet (see
CHANGELOG.md), and some existing behaviour does not match the specification.
