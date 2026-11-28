"""The decision procedure (docs/POLICY.md sections 9 and 10)."""

from .audit import format_record
from .clock import to_utc
from .delegation import held_roles
from .model import ALLOW, DENY, REASON_ALLOW, REASON_EXPLICIT_DENY, REASON_NO_MATCH, Decision
from .request import make_request
from .roles import RoleGraph
from .timewindow import any_window


class Match:
    __slots__ = ("statement", "key")

    def __init__(self, statement, resource_spec):
        self.statement = statement
        self.key = (resource_spec, -statement.index)


def bound(statement, principal, roles):
    if principal in statement.principals:
        return True
    return any(r in roles for r in statement.roles)


class Evaluator:
    def __init__(self, policy, clock, audit=None):
        self.policy = policy
        self.clock = clock
        self.audit = audit
        self.graph = RoleGraph(policy.roles)

    def evaluate(self, principal, action, resource, context=None):
        instant = to_utc(self.clock.now())
        request = make_request(principal, action, resource, context)
        decision = self._decide(request, instant)
        decision.record = format_record(instant, decision.effect, request.principal, request.action,
                                        request.resource, decision.reason, decision.statement)
        if self.audit is not None:
            self.audit.write(decision.record)
        return decision

    def matches(self, request, instant):
        roles = held_roles(self.policy, self.graph, instant, request.action, request.principal)
        attrs = self.policy.principal(request.principal).attributes
        out = []
        for st in self.policy.statements:
            if not bound(st, request.principal, roles):
                continue
            if not any(p.matches(request.action) for p in st.actions):
                continue
            specs = [p.specificity for p in st.resources if p.matches(request.segments, request.principal)]
            if not specs:
                continue
            if not all(c.holds(attrs, request.context, st.is_deny) for c in st.attributes):
                continue
            if st.time and not any_window(st.time, instant):
                continue
            out.append(Match(st, max(specs)))
        return out

    def _decide(self, request, instant):
        found = self.matches(request, instant)
        if not found:
            return Decision(DENY, REASON_NO_MATCH)
        top = max(m.key[0] for m in found)
        best = [m for m in found if m.key[0] == top]
        denies = [m for m in best if m.statement.is_deny]
        if denies:
            chosen = max(denies, key=lambda m: m.key)
            return Decision(DENY, REASON_EXPLICIT_DENY, chosen.statement.id)
        chosen = max(best, key=lambda m: m.key)
        return Decision(ALLOW, REASON_ALLOW, chosen.statement.id, dict(chosen.statement.grants))
