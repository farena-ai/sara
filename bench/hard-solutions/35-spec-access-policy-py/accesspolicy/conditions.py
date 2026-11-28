"""Attribute conditions (docs/POLICY.md section 6)."""

from .errors import PolicyError

SOURCES = ("principal", "context")
OPERATORS = ("eq", "in", "gte", "lte", "present")


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def is_scalar(value):
    return value is None or isinstance(value, (str, bool, int, float))


def values_equal(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if is_number(a) and is_number(b):
        return a == b
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    return a is None and b is None


class Condition:
    __slots__ = ("key", "source", "name", "ops")

    def __init__(self, key, source, name, ops):
        self.key = key
        self.source = source
        self.name = name
        self.ops = ops

    def holds(self, principal_attrs, context, deny):
        values = principal_attrs if self.source == "principal" else context
        if self.name not in values:
            for op, operand in self.ops:
                if op == "present":
                    if operand:
                        return False
                elif not deny:
                    return False
            return True
        value = values[self.name]
        for op, operand in self.ops:
            if op == "present":
                ok = bool(operand)
            elif op == "eq":
                ok = values_equal(value, operand)
            elif op == "in":
                ok = any(values_equal(value, o) for o in operand)
            elif op == "gte":
                ok = is_number(value) and value >= operand
            else:
                ok = is_number(value) and value <= operand
            if not ok:
                return False
        return True

    def __repr__(self):
        return f"Condition({self.key!r}, {self.ops!r})"


def _operators(spec, where):
    if not isinstance(spec, dict):
        if not is_scalar(spec):
            raise PolicyError(f"condition value must be a scalar or an object, got {spec!r}", where)
        return (("eq", spec),)
    if not spec:
        raise PolicyError("empty condition", where)
    ops = []
    for op, operand in spec.items():
        if op not in OPERATORS:
            raise PolicyError(f"unknown condition operator {op!r}", where)
        if op == "eq" and not is_scalar(operand):
            raise PolicyError("eq needs a scalar", where)
        if op == "in" and (not isinstance(operand, list) or not all(is_scalar(o) for o in operand)):
            raise PolicyError("in needs a list of scalars", where)
        if op in ("gte", "lte") and not is_number(operand):
            raise PolicyError(f"{op} needs a number", where)
        if op == "present" and not isinstance(operand, bool):
            raise PolicyError("present needs a boolean", where)
        ops.append((op, tuple(operand) if op == "in" else operand))
    return tuple(ops)


def parse_conditions(spec, where=None):
    if not isinstance(spec, dict):
        raise PolicyError("attributes must be an object", where)
    out = []
    for key, value in spec.items():
        source, dot, name = key.partition(".") if isinstance(key, str) else ("", "", "")
        if not dot or source not in SOURCES or name == "":
            raise PolicyError(f"invalid attribute key {key!r}", where)
        out.append(Condition(key, source, name, _operators(value, where)))
    return tuple(out)
