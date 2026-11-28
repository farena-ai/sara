"""Role inheritance (docs/POLICY.md section 2)."""

from collections import deque


class RoleGraph:
    def __init__(self, parents):
        self._parents = dict(parents)

    def is_defined(self, role):
        return role in self._parents

    def parents(self, role):
        return self._parents.get(role, ())

    def closure(self, role):
        """Every role held by holding `role`, with its inheritance distance from `role`."""
        return self.expand((role,))

    def expand(self, assigned):
        """Every role reachable from the assigned roles, with the smallest inheritance distance."""
        distance = {}
        queue = deque()
        for role in assigned:
            if role not in distance:
                distance[role] = 0
                queue.append(role)
        while queue:
            role = queue.popleft()
            for parent in self.parents(role):
                if parent not in distance:
                    distance[parent] = distance[role] + 1
                    queue.append(parent)
        return distance
