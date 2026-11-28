"""Resource patterns (docs/POLICY.md section 5)."""

import re

from .errors import PolicyError
from .paths import split_path

LITERAL = "literal"
SINGLE = "single"
PARTIAL = "partial"
TAIL = "tail"
PRINCIPAL = "principal"

PLACEHOLDER = "{principal}"


class Segment:
    __slots__ = ("kind", "text", "regex")

    def __init__(self, kind, text, regex=None):
        self.kind = kind
        self.text = text
        self.regex = regex

    def matches(self, segment, principal):
        if self.kind == LITERAL:
            return segment == self.text
        if self.kind == SINGLE:
            return True
        if self.kind == PRINCIPAL:
            return segment == principal
        if self.kind == PARTIAL:
            return self.regex.fullmatch(segment) is not None
        raise AssertionError(self.kind)


def _segment(text, last, where):
    if text == "**":
        if not last:
            raise PolicyError("'**' may only be the last segment", where)
        return Segment(TAIL, text)
    if text == "*":
        return Segment(SINGLE, text)
    if text == PLACEHOLDER:
        return Segment(PRINCIPAL, text)
    if "{" in text or "}" in text:
        raise PolicyError(f"invalid segment {text!r}", where)
    if "**" in text:
        raise PolicyError(f"invalid wildcard segment {text!r}", where)
    if "*" in text:
        regex = re.compile(".*".join(re.escape(part) for part in text.split("*")), re.DOTALL)
        return Segment(PARTIAL, text, regex)
    return Segment(LITERAL, text)


class ResourcePattern:
    def __init__(self, text, where=None):
        try:
            raw = split_path(text)
        except ValueError as e:
            raise PolicyError(str(e), where) from None
        self.text = text
        self.segments = tuple(_segment(s, i == len(raw) - 1, where) for i, s in enumerate(raw))
        self.tail = bool(self.segments) and self.segments[-1].kind == TAIL
        self.body = self.segments[:-1] if self.tail else self.segments

    def matches(self, segments, principal):
        if self.tail:
            if len(segments) < len(self.body):
                return False
        elif len(segments) != len(self.body):
            return False
        return all(p.matches(s, principal) for p, s in zip(self.body, segments))

    @property
    def specificity(self):
        kinds = [s.kind for s in self.body]
        literal = sum(1 for k in kinds if k in (LITERAL, PRINCIPAL))
        partial = kinds.count(PARTIAL)
        single = kinds.count(SINGLE)
        return (literal, partial, single, 0 if self.tail else 1)

    def __repr__(self):
        return f"ResourcePattern({self.text!r})"


def parse_resource_patterns(values, where=None):
    if not isinstance(values, list) or not values:
        raise PolicyError("resources must be a non-empty list", where)
    out = []
    for v in values:
        if not isinstance(v, str):
            raise PolicyError(f"resource pattern must be a string, got {v!r}", where)
        out.append(ResourcePattern(v, where))
    return tuple(out)
