"""Requests (docs/POLICY.md section 3)."""

from dataclasses import dataclass, field
from typing import Dict, Tuple

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
    return Request(principal, action.lower(), split_path(resource), dict(context or {}))
