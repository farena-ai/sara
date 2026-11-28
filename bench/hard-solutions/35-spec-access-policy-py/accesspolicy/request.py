"""Request validation and normalisation (docs/POLICY.md section 3)."""

from dataclasses import dataclass, field
from typing import Dict, Tuple

from .actions import normalise_action
from .errors import RequestError
from .names import is_principal_id
from .paths import join_path, split_path


@dataclass(frozen=True)
class Request:
    principal: str
    action: str
    segments: Tuple[str, ...]
    context: Dict[str, object] = field(default_factory=dict)

    @property
    def resource(self):
        return join_path(self.segments)


def make_request(principal, action, resource, context=None):
    if not is_principal_id(principal):
        raise RequestError(f"invalid principal {principal!r}")
    normalised = normalise_action(action)
    if normalised is None:
        raise RequestError(f"invalid action {action!r}")
    try:
        segments = split_path(resource)
    except ValueError as e:
        raise RequestError(str(e)) from None
    return Request(principal, normalised, segments, dict(context or {}))
