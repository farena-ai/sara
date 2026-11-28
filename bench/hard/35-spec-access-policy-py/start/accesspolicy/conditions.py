"""Attribute conditions (docs/POLICY.md section 6)."""

from .errors import PolicyError

SOURCES = ("principal", "context")


class Condition:
    __slots__ = ("key", "source", "name", "value")

    def __init__(self, key, source, name, value):
        self.key = key
        self.source = source
        self.name = name
        self.value = value

    def holds(self, principal_attrs, context, deny):
        values = principal_attrs if self.source == "principal" else context
        if self.name not in values:
            return False
        return values[self.name] == self.value

    def __repr__(self):
        return f"Condition({self.key!r}, {self.value!r})"


def parse_conditions(spec, where=None):
    if not isinstance(spec, dict):
        raise PolicyError("attributes must be an object", where)
    out = []
    for key, value in spec.items():
        source, dot, name = key.partition(".")
        if not dot or source not in SOURCES:
            raise PolicyError(f"invalid attribute key {key!r}", where)
        out.append(Condition(key, source, name, value))
    return tuple(out)
