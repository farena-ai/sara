"""Delegation of roles between principals (docs/POLICY.md section 8)."""


def own_roles(policy, graph, principal_id):
    return graph.expand(policy.principal(principal_id).roles)


def held_roles(policy, graph, instant, action, principal_id):
    """The roles `principal_id` holds for this request."""
    return own_roles(policy, graph, principal_id)
