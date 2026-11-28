"""The decision procedure (docs/POLICY.md sections 9 and 10)."""

from .audit import format_record
from .clock import to_utc
from .delegation import compute_holdings
from .errors import RequestError
from .model import (ALLOW, DENY, REASON_ALLOW, REASON_EXPLICIT_DENY, REASON_INVALID, REASON_NO_MATCH,
                    Decision)
from .request import make_request
from .roles import RoleGraph
from .timewindow import any_window


class Match:
    __slots__ = ("statement", "distance", "via", "key")

    def __init__(self, statement, resource_spec, action_spec, distance, via):
        self.statement = statement
        self.distance = distance
        self.via = via
        self.key = (resource_spec, action_spec, statement.priority, -distance, -statement.index)


def binding(statement, principal, holdings):
    """(distance, via) when the statement is bound to the principal, else None."""
    if principal in statement.principals:
        return 0, ()
    best = None
    for role in statement.roles:
        h = holdings.get(role)
        if h is None:
            continue
        candidate = (h.distance, h.chain, h.via)
        if best is None or candidate[:2] < best[:2]:
            best = candidate
    return None if best is None else (best[0], best[2])


class Evaluator:
    def __init__(self, policy, clock, audit=None):
        self.policy = policy
        self.clock = clock
        self.audit = audit
        self.graph = RoleGraph(policy.roles)

    def evaluate(self, principal, action, resource, context=None):
        instant = to_utc(self.clock.now())
        try:
            request = make_request(principal, action, resource, context)
        except RequestError:
            decision = Decision(DENY, REASON_INVALID)
            return self._finish(instant, decision, principal, action, resource)
        decision = self._decide(request, instant)
        return self._finish(instant, decision, request.principal, request.action, request.resource)

    def _finish(self, instant, decision, principal, action, resource):
        decision.record = format_record(instant, decision.effect, principal, action, resource,
                                        decision.reason, decision.statement, decision.via)
        if self.audit is not None:
            self.audit.write(decision.record)
        return decision

    def matches(self, request, instant):
        holdings = compute_holdings(self.policy, self.graph, instant, request.action, request.principal)
        attrs = self.policy.principal(request.principal).attributes
        out = []
        for st in self.policy.statements:
            bound = binding(st, request.principal, holdings)
            if bound is None:
                continue
            action_specs = [p.specificity for p in st.actions if p.matches(request.action)]
            if not action_specs:
                continue
            resource_specs = [p.specificity for p in st.resources if p.matches(request.segments, request.principal)]
            if not resource_specs:
                continue
            if not all(c.holds(attrs, request.context, st.is_deny) for c in st.attributes):
                continue
            if st.time and not any_window(st.time, instant):
                continue
            out.append(Match(st, max(resource_specs), max(action_specs), bound[0], bound[1]))
        return out

    def _decide(self, request, instant):
        found = self.matches(request, instant)
        denies = [m for m in found if m.statement.is_deny]
        allows = [m for m in found if not m.statement.is_deny]
        if denies:
            best = max(denies, key=lambda m: m.key)
            return Decision(DENY, REASON_EXPLICIT_DENY, best.statement.id, {}, best.via)
        if allows:
            best = max(allows, key=lambda m: m.key)
            return Decision(ALLOW, REASON_ALLOW, best.statement.id, dict(best.statement.grants), best.via)
        return Decision(DENY, REASON_NO_MATCH)
