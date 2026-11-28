"""Role inheritance (docs/POLICY.md section 2)."""


class RoleGraph:
    def __init__(self, parents):
        self._parents = dict(parents)

    def is_defined(self, role):
        return role in self._parents

    def parents(self, role):
        return self._parents.get(role, ())

    def expand(self, assigned):
        """Every role reachable from the assigned roles."""
        seen = set()
        stack = list(assigned)
        while stack:
            role = stack.pop()
            if role in seen:
                continue
            seen.add(role)
            stack.extend(self.parents(role))
        return seen
