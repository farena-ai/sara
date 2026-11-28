"""The loaded policy and the decision objects."""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

ALLOW = "ALLOW"
DENY = "DENY"

REASON_ALLOW = "allow"
REASON_EXPLICIT_DENY = "explicit-deny"
REASON_NO_MATCH = "no-match"
REASON_INVALID = "invalid-request"


@dataclass(frozen=True)
class PrincipalEntry:
    id: str
    roles: Tuple[str, ...] = ()
    attributes: Dict[str, object] = field(default_factory=dict)


@dataclass
class Statement:
    id: str
    effect: str
    roles: Tuple[str, ...]
    principals: Tuple[str, ...]
    actions: tuple
    resources: tuple
    priority: int = 0
    grants: Dict[str, int] = field(default_factory=dict)
    attributes: tuple = ()
    time: tuple = ()
    index: int = 0

    @property
    def is_deny(self):
        return self.effect == "deny"


@dataclass
class Delegation:
    id: str
    source: str
    target: str
    roles: Tuple[str, ...]
    expires: object
    actions: Optional[tuple] = None

    def covers_action(self, action):
        if self.actions is None:
            return True
        return any(p.matches(action) for p in self.actions)


@dataclass
class Policy:
    roles: Dict[str, Tuple[str, ...]]
    principals: Dict[str, PrincipalEntry]
    statements: List[Statement]
    delegations: List[Delegation]
    max_delegation_depth: int = 2

    def principal(self, principal_id):
        entry = self.principals.get(principal_id)
        return entry if entry is not None else PrincipalEntry(principal_id)

    def statement(self, statement_id):
        for s in self.statements:
            if s.id == statement_id:
                return s
        raise KeyError(statement_id)


@dataclass
class Decision:
    effect: str
    reason: str
    statement: Optional[str] = None
    grants: Dict[str, int] = field(default_factory=dict)
    via: Tuple[str, ...] = ()
    record: str = ""

    @property
    def allowed(self):
        return self.effect == ALLOW

    def __bool__(self):
        return self.allowed
