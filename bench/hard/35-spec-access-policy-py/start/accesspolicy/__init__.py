"""Gatekeeper: a small access-policy evaluator. The specification is docs/POLICY.md."""

from .audit import FileAuditSink, MemoryAuditSink, format_record
from .clock import FixedClock, SystemClock, utc
from .errors import PolicyError, RequestError
from .evaluator import Evaluator
from .loader import load_policy, load_policy_file
from .model import ALLOW, DENY, Decision

__all__ = [
    "ALLOW",
    "DENY",
    "Decision",
    "Evaluator",
    "FileAuditSink",
    "FixedClock",
    "MemoryAuditSink",
    "PolicyError",
    "RequestError",
    "SystemClock",
    "format_record",
    "load_policy",
    "load_policy_file",
    "utc",
]
