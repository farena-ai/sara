"""Action patterns: `*`, `service:*` and `service:verb` (docs/POLICY.md section 4)."""

from .errors import PolicyError
from .names import ACTION, NAME_PART

ANY = "any"
SERVICE = "service"
EXACT = "exact"

_SPECIFICITY = {ANY: 0, SERVICE: 1, EXACT: 2}


class ActionPattern:
    __slots__ = ("text", "kind", "service", "verb")

    def __init__(self, text, kind, service=None, verb=None):
        self.text = text
        self.kind = kind
        self.service = service
        self.verb = verb

    def matches(self, action):
        """`action` is a normalised (lower-case, validated) request action."""
        if self.kind == ANY:
            return True
        service, _, verb = action.partition(":")
        if self.kind == SERVICE:
            return service == self.service
        return service == self.service and verb == self.verb

    @property
    def specificity(self):
        return _SPECIFICITY[self.kind]

    def __repr__(self):
        return f"ActionPattern({self.text!r})"


def parse_action_pattern(value, where=None):
    if not isinstance(value, str):
        raise PolicyError(f"action pattern must be a string, got {value!r}", where)
    text = value.lower()
    if text == "*":
        return ActionPattern(text, ANY)
    service, sep, verb = text.partition(":")
    if sep and verb == "*" and NAME_PART.fullmatch(service):
        return ActionPattern(text, SERVICE, service)
    if ACTION.fullmatch(text):
        return ActionPattern(text, EXACT, service, verb)
    raise PolicyError(f"invalid action pattern {value!r}", where)


def parse_action_patterns(values, where=None):
    if not isinstance(values, list) or not values:
        raise PolicyError("actions must be a non-empty list", where)
    return tuple(parse_action_pattern(v, where) for v in values)


def normalise_action(value):
    """The lower-cased action, or None when it is not a valid request action."""
    if not isinstance(value, str):
        return None
    text = value.lower()
    return text if ACTION.fullmatch(text) else None
