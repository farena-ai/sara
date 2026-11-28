"""Delegation of roles between principals (docs/POLICY.md section 8)."""

from dataclasses import dataclass
from typing import Tuple


@dataclass(frozen=True)
class Holding:
    depth: int
    inherit: int
    via: Tuple[str, ...] = ()

    @property
    def chain(self):
        return ">".join(self.via)

    def key(self):
        return (self.depth, self.inherit, self.chain)

    @property
    def distance(self):
        return 1 + self.depth + self.inherit


def own_holdings(policy, graph, principal_id):
    entry = policy.principal(principal_id)
    return {role: Holding(0, dist) for role, dist in graph.expand(entry.roles).items()}


def in_force(delegation, instant, action):
    return delegation.source != delegation.target and instant < delegation.expires and delegation.covers_action(action)


def compute_holdings(policy, graph, instant, action, principal_id):
    """The roles `principal_id` holds for this request, each with its chosen holding."""
    people = {principal_id} | set(policy.principals)
    for d in policy.delegations:
        people.add(d.source)
        people.add(d.target)
    held = {p: own_holdings(policy, graph, p) for p in people}
    limit = policy.max_delegation_depth
    active = [d for d in policy.delegations if in_force(d, instant, action)]
    if limit <= 0 or not active:
        return held[principal_id]
    changed = True
    while changed:
        changed = False
        for d in active:
            source = held[d.source]
            target = held[d.target]
            for role in d.roles:
                h = source.get(role)
                if h is None or h.depth + 1 > limit:
                    continue
                via = h.via + (d.id,)
                for q, dist in graph.closure(role).items():
                    candidate = Holding(h.depth + 1, dist, via)
                    current = target.get(q)
                    if current is None or candidate.key() < current.key():
                        target[q] = candidate
                        changed = True
    return held[principal_id]
