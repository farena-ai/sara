import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from accesspolicy import Evaluator, FixedClock, MemoryAuditSink, load_policy, utc  # noqa: E402

MONDAY_10 = utc(2026, 11, 23, 10, 0, 0)
EXAMPLES = os.path.join(ROOT, "docs", "examples")


def statement(sid, effect="allow", **kw):
    st = {"id": sid, "effect": effect, "roles": ["reader"], "actions": ["docs:read"], "resources": ["/docs/**"]}
    st.update(kw)
    return st


def evaluator(statements, principals=None, now=MONDAY_10, **extra):
    doc = {"version": 1, "statements": statements,
           "principals": principals if principals is not None else {"alice": {"roles": ["reader"]}}}
    doc.update(extra)
    sink = MemoryAuditSink()
    return Evaluator(load_policy(doc), FixedClock(now), sink), sink
