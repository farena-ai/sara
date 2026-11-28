"""Resource patterns (docs/POLICY.md section 5)."""

from .errors import PolicyError
from .paths import split_path

LITERAL = "literal"
SINGLE = "single"
TAIL = "tail"


class Segment:
    __slots__ = ("kind", "text")

    def __init__(self, kind, text):
        self.kind = kind
        self.text = text

    def matches(self, segment, principal):
        if self.kind == LITERAL:
            return segment == self.text
        return True


def _segment(text, last, where):
    if text == "**":
        if not last:
            raise PolicyError("'**' may only be the last segment", where)
        return Segment(TAIL, text)
    if text == "*":
        return Segment(SINGLE, text)
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
            if len(segments) <= len(self.body):
                return False
        elif len(segments) != len(self.body):
            return False
        return all(p.matches(s, principal) for p, s in zip(self.body, segments))

    @property
    def specificity(self):
        kinds = [s.kind for s in self.body]
        return (kinds.count(LITERAL), kinds.count(SINGLE), 0 if self.tail else 1)

    def __repr__(self):
        return f"ResourcePattern({self.text!r})"


def parse_resource_patterns(values, where=None):
    if not isinstance(values, list) or not values:
        raise PolicyError("resources must be a non-empty list", where)
    return tuple(ResourcePattern(v, where) for v in values)
