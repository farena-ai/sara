# Gatekeeper policy specification (version 1)

This document is the specification of the policy language and of the evaluator in
`accesspolicy/`. Every rule is numbered (R1 to R40). When this document and the code disagree,
this document is right. Worked examples are in `docs/EXAMPLES.md`; the example policies are in
`docs/examples/`.

Words used throughout:

- A **principal** is a user or service account, identified by a principal id.
- A **request** asks whether principal P may perform action A on resource path R, optionally
  with a request **context** (a dict of attributes supplied by the caller).
- A **statement** is one entry of the policy's `statements` list.
- A **decision** is the result of one evaluation: an effect (`ALLOW` or `DENY`), a reason, the id
  of the selected statement (or none), the grants, the delegation chain used (`via`) and the
  audit record.

---

## 1. Policy documents

**R1. Document shape.** A policy document is a JSON object (a Python dict once parsed) with the
keys `version` (required, must be the integer `1`), `max_delegation_depth` (optional integer
>= 0, default `2`), `roles` (optional object), `principals` (optional object), `statements`
(optional list) and `delegations` (optional list). Any other top-level key, a wrong type for any
of these keys, or a `version` other than `1` makes `load_policy` raise `PolicyError`. The same
holds at every level of the document: a value whose type or shape differs from what this
document describes (for example a list where an object is described, or a string where a list
is described), a missing required key, or a key that is not allowed is an error. Every loading
problem raises `PolicyError`; loading never raises any other exception type for a malformed
document.

**R2. Statements.** A statement is an object with these keys and no others:

| key          | required | type / meaning                                                        |
|--------------|----------|-----------------------------------------------------------------------|
| `id`         | yes      | string matching `[A-Za-z0-9_.-]+`; unique within the document          |
| `effect`     | yes      | `"allow"` or `"deny"` (exactly these lower-case strings)                |
| `roles`      | no       | list of role names, default `[]`                                        |
| `principals` | no       | list of principal ids, default `[]`                                     |
| `actions`    | yes      | non-empty list of action patterns (section 4)                           |
| `resources`  | yes      | non-empty list of resource patterns (section 5)                         |
| `priority`   | no       | integer (not a boolean), default `0`                                    |
| `grants`     | no       | object mapping strings to integers (not booleans); allow statements only |
| `conditions` | no       | object with optional keys `attributes` (section 6) and `time` (section 7), and no others |

A statement must name at least one role or at least one principal. A `grants` key on a deny
statement is an error (even when it is empty). A duplicate statement id is an error.

## 2. Principals and roles

**R3. The directory.** `principals` maps a principal id (matching `[A-Za-z0-9_.@-]+`) to an
object with optional keys `roles` (list of role names, default `[]`) and `attributes` (object,
default `{}`); no other keys are allowed. These are the principal's **assigned roles** and
**attributes**. A principal id that is not in the directory is still a valid principal: it has
no assigned roles and no attributes, but statements that name it in `principals` and
delegations made to it apply to it as usual.

**R4. Role names are case-insensitive.** Every role name is converted to lower case when the
policy is loaded: the keys of `roles`, every entry of `inherits`, the directory's `roles`, the
statements' `roles` and the delegations' `roles`. Two keys of `roles` that are equal after
lower-casing are an error. Role names must be non-empty strings.

**R5. Inheritance.** `roles` maps a role name to an object with an optional `inherits` list of
role names (no other keys are allowed). A principal that holds role X also holds every role
that X inherits, transitively. A principal's **own roles** are its assigned roles plus every
role reachable from them through `inherits`.

**R6. Cycles and undefined roles.** Inheritance cycles are allowed and are not an error; every
role is reached at most once. A role name that is not a key of `roles` (whether it is assigned,
inherited, delegated or named by a statement) is a valid role that inherits nothing.

**R7. Inheritance distance.** The inheritance distance of an own role is the smallest number of
`inherits` steps from any assigned role to it: an assigned role has distance 0, a role it
inherits directly has distance 1, and so on. (Section 8 uses the same measure starting from a
delegated role.)

## 3. Requests

**R8. Request validation.** A request is invalid when any of these holds: the principal id is
not a string matching `[A-Za-z0-9_.@-]+`; the action, after lower-casing, is not a string
matching `[a-z0-9-]+:[a-z0-9-]+`; the resource is not a string, does not start with `/`, or has
a segment that is exactly `.` or `..`. An invalid request is never an exception: the decision is
`DENY` with reason `invalid-request`, no statement, empty grants and empty `via`, and it is
audited like any other decision (R39, R40).

**R9. Normalisation.** The request action is lower-cased. The request resource is split on `/`
and empty segments are dropped, so repeated slashes collapse and a trailing slash is ignored:
`//docs///a/` is the path `/docs/a` with segments `docs`, `a`. The path `/` has zero segments.
Resource paths are case-sensitive and are never lower-cased.

## 4. Actions

**R10. Action patterns.** An action pattern is lower-cased when loaded and must then have one
of three forms: `*` (any action), `service:*` (every verb of that service) or `service:verb`
(exactly that action), where `service` and `verb` match `[a-z0-9-]+`. Any other use of `*`
(such as `docs:re*` or `*:read`) and any other shape is an error. Matching is done on the
lower-cased request action.

**R11. Action specificity.** `service:verb` has action specificity 2, `service:*` has 1 and `*`
has 0.

## 5. Resource patterns

**R12. Pattern syntax.** A resource pattern is written like a path and normalised the same way
as a request resource (R9); it must start with `/` and must not contain a `.` or `..` segment.
Each segment is one of: a **literal** (no `*`, `{` or `}`), which matches a request segment that
is exactly equal (case-sensitive); `*`; a **partial wildcard**; `**`; or `{principal}`. A segment
that contains `{` or `}` and is not exactly `{principal}` is an error.

**R13. Single wildcard.** A segment that is exactly `*` matches exactly one request segment,
whatever it is.

**R14. Partial wildcard.** A segment that contains `*` together with other characters (for
example `report-*.pdf` or `a*b*c`) matches one request segment; each `*` in it stands for any
run of characters, including the empty run. The other characters must match exactly
(case-sensitive) and have no special meaning. A segment that contains `**` together with other
characters (such as `a**`) is an error.

**R15. Double wildcard.** A segment that is exactly `**` may only be the last segment of a
pattern (anywhere else it is an error). It matches zero or more request segments, so `/docs/**`
matches `/docs`, `/docs/a` and `/docs/a/b/c`, and `/**` matches every path including `/`.

**R16. Principal placeholder.** A segment that is exactly `{principal}` matches one request
segment equal to the requesting principal's id (case-sensitive). It is always the id of the
principal named in the request, also when the statement applies through a delegated role.

**R17. Pattern specificity.** The specificity of a resource pattern is the tuple
`(L, P, S, T)` where `L` is the number of literal and `{principal}` segments, `P` the number of
partial-wildcard segments, `S` the number of `*` segments, and `T` is `1` when the pattern does
not end in `**` and `0` when it does. Tuples are compared element by element from the left; the
greater tuple is the more specific pattern. Example: `/docs/a` is `(2,0,0,1)`, `/docs/*` is
`(1,0,1,1)`, `/docs/**` is `(1,0,0,0)` and `/` is `(0,0,0,1)`.

**R18. Several patterns in one statement.** When several of a statement's resource patterns
match the request, the statement's resource specificity is that of the most specific matching
pattern. Likewise its action specificity is the greatest action specificity among its matching
action patterns.

## 6. Attribute conditions

**R19. Attribute keys.** `conditions.attributes` is an object whose keys are `principal.<name>`
(an attribute of the requesting principal from the directory, R3) or `context.<name>` (a key of
the request context), where `<name>` is non-empty. Any other key is an error. A statement's
attribute conditions hold when every one of its keys holds.

**R20. Operators.** The value for a key is either a scalar, which is shorthand for `{"eq": value}`,
or an object of one or more operators, all of which must hold:

- `eq`: a scalar (string, number, boolean or null); equality as defined in R21;
- `in`: a list of scalars; holds when the attribute is equal (R21) to at least one element (an
  empty list never holds);
- `gte` / `lte`: a number (not a boolean); see R22;
- `present`: a boolean; see R23.

Any other operator name, an empty operator object, or a value of the wrong type is an error.
Attribute values in the directory must be scalars (anything else is a loading error); callers
pass scalar values in the request context.

**R21. Equality is type-strict.** Two values are equal only when both are strings and identical
(case-sensitive), both are booleans and identical, both are numbers (int or float, but not
booleans) and numerically equal (so `1` equals `1.0`), or both are null. In particular `1` is
not equal to `"1"` and `true` is not equal to `1`.

**R22. Ordering.** `gte` holds when the attribute value is a number (not a boolean) greater than
or equal to the operand; `lte` when it is a number less than or equal to it. For any other type
of attribute value (string, boolean, null) they do not hold.

**R23. Missing and null.** An attribute is **missing** when its key is absent from the directory
attributes (for `principal.`) or the request context (for `context.`). A key that is present with
the value null is not missing. `present: true` holds exactly when the attribute is not missing,
`present: false` exactly when it is missing. On an allow statement every other operator is
false for a missing attribute.

**R24. Deny statements fail closed.** On a deny statement, every operator other than `present`
holds when the attribute is missing (so a deny that depends on an attribute the caller did not
send still applies). `present` is evaluated as in R23. An attribute that is present with a value
of the wrong type is not missing: R21 and R22 apply to it as written.

## 7. Time windows

**R25. Windows.** `conditions.time` is a non-empty list of windows; the time condition holds when
the evaluation instant falls inside at least one of them. A window is an object with `start`
(required, `"HH:MM"`, 00:00 to 23:59), `end` (required, `"HH:MM"`, 00:00 to 23:59, or `"24:00"`),
`days` (optional non-empty list of `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun`; default every
day) and `tz_offset` (optional `"+HH:MM"` or `"-HH:MM"`, default `"+00:00"`); no other keys are
allowed. The instant is converted to local time by adding the offset to UTC; `days` and the
times refer to that local time. Anything else is an error.

**R26. Half-open.** A window with `end` later than `start` covers local times `t` with
`start <= t < end` on each listed day. The comparison uses the exact instant, fractions of a
second included: with `start` 09:00 and `end` 17:00, 09:00:00 and 16:59:59.999999 are inside and
08:59:59.999999 and 17:00:00 are outside. `end` `"24:00"` means the end of that day.

**R27. Windows that cross midnight.** A window with `end` earlier than or equal to `start` covers
`start <= t` on each listed day **and** `t < end` on the day after each listed day. `days` names
the day the window starts on: `{"days": ["fri"], "start": "22:00", "end": "06:00"}` covers Friday
22:00 to Saturday 05:59:59, and not Friday 03:00. A window whose `start` equals its `end` covers
24 hours starting at `start` on each listed day.

**R28. One clock reading.** The evaluator is given a clock: an object whose `now()` returns a
`datetime` (an aware one; a naive one is taken to be UTC). `evaluate` calls `now()` exactly once
per request, also for invalid requests, and uses that one instant for every time window, every
delegation expiry and the audit timestamp.

## 8. Delegation

**R29. Delegations.** A delegation is an object with keys `id` (string matching
`[A-Za-z0-9_.-]+`, unique among delegations), `from` and `to` (principal ids), `roles`
(non-empty list of role names), `expires` (a UTC timestamp written exactly as
`YYYY-MM-DDTHH:MM:SSZ`) and optionally `actions` (non-empty list of action patterns, R10); no
other keys are allowed. For one request a delegation is **in force** when `from` differs from
`to`, the evaluation instant is strictly before `expires` (at the `expires` instant it has
expired), and, if it has `actions`, at least one of them matches the request action. A
delegation that is not in force is ignored for that request, including as a link of a chain.

**R30. What a delegation passes on.** A delegation in force passes each role R of its `roles`
that the `from` principal holds (by its own roles or through delegations in force) to the `to`
principal. Roles in the list that the `from` principal does not hold pass nothing. The `to`
principal then holds R and every role R inherits (R5); for those roles the inheritance distance
is counted from R.

**R31. Chains and depth.** A role held through delegations has a **depth**: own roles have depth
0, and a role passed on by a delegation has the depth of the delegator's holding plus 1. A
holding whose depth would exceed `max_delegation_depth` is not created. With the default of 2, A
may delegate to B and B may pass the role on to C, but C cannot pass it to D. A value of 0
disables delegation entirely.

**R32. Choosing one holding.** A principal can hold the same role in several ways. Each holding
has a depth, an inheritance distance and a `via` chain: empty for own roles, and for a delegated
holding the delegator's chain followed by this delegation's id (so the first id is the delegation
made by a principal that holds the role as its own role). For every role the principal uses the
holding with the smallest depth; among those, the smallest inheritance distance; among those, the
smallest chain, comparing the ids joined with `>` as strings. When a delegation passes a role
on, the new holding is derived from the delegator's chosen holding of that role.

**R33. What delegation does not pass on.** Delegation passes roles only. Statements that name the
delegator in `principals`, the delegator's attributes and the `{principal}` placeholder all
still refer to the principal named in the request. Deny statements bound to a delegated role
apply exactly like allow statements bound to it.

## 9. Decisions

**R34. Applicable statements.** A statement applies to a valid request when all of these hold:
it is bound to the principal (the principal's id is in its `principals`, or the principal holds
at least one of its `roles` by its own roles or through delegations in force); at least one of
its action patterns matches the action; at least one of its resource patterns matches the
resource; its attribute conditions hold (section 6); and its time condition, if any, holds
(section 7).

**R35. Default deny.** When no statement applies the decision is `DENY` with reason `no-match`,
no statement, empty grants and empty `via`.

**R36. Explicit deny beats allow.** When at least one deny statement applies the decision is
`DENY` with reason `explicit-deny`, however specific, prioritised or close the applicable allow
statements are. The reported statement is the best applicable deny statement (R38). Otherwise,
when at least one allow statement applies, the decision is `ALLOW` with reason `allow` and the
best applicable allow statement (R38).

**R37. Binding distance and via.** The binding distance of an applicable statement is 0 when it
names the principal in `principals`. Otherwise it is the smallest value of
`1 + depth + inheritance distance` (from the chosen holding, R32) over the statement's roles that
the principal holds; when several of those roles give that smallest value, the one whose chain
is smallest (joined with `>`, compared as strings, so an empty chain comes first) is used. The
decision's `via` is the chain of that role's chosen holding, or empty when the distance is 0.

**R38. Selecting the best statement and its grants.** Among applicable statements of the
deciding effect, the best is the one with, in this order: the greatest resource specificity
(R17, R18); then the greatest action specificity (R11, R18); then the greatest `priority`; then
the smallest binding distance (R37); then the earliest position in `statements`. An `ALLOW`
decision's grants are a copy of the best allow statement's `grants` (an empty dict when it has
none); grants of other applicable statements are never merged in. A `DENY` decision always has
empty grants.

## 10. Audit

**R39. One record per evaluation.** Every call of `evaluate` produces exactly one audit record,
whatever the outcome: it is passed to the audit sink's `write` method (when the evaluator has a
sink) and is also available as the decision's `record`.

**R40. Record format.** A record is one line of text, without a line terminator, made of these
fields separated by single spaces, in this order:

```
<timestamp> <EFFECT> principal=<p> action=<a> resource=<r> reason=<reason> statement=<id> via=<chain>
```

- `timestamp` is the evaluation instant in UTC written as `YYYY-MM-DDTHH:MM:SSZ`; fractions of a
  second are dropped (truncated, never rounded).
- `EFFECT` is `ALLOW` or `DENY`; `reason` is `allow`, `explicit-deny`, `no-match` or
  `invalid-request`.
- For a valid request, `p` is the principal id, `a` the lower-cased action and `r` the normalised
  resource (R9). For an invalid request they are the values exactly as given (not lower-cased or
  normalised); a value that is not a string or is empty is written as `-`.
- In `p`, `a` and `r`, every byte of the UTF-8 encoding that is not in the range 0x21 to 0x7E, and
  every `%`, is written as `%` followed by two upper-case hexadecimal digits: a space becomes
  `%20`, `é` becomes `%C3%A9`, `%` becomes `%25`.
- `statement` is the selected statement's id, or `-` when there is none.
- `chain` is the decision's `via` ids joined with `>`, or `-` when it is empty.
