"""A human-readable explanation of one decision (used by `python -m accesspolicy explain`)."""

from .clock import to_utc
from .request import make_request


def explain(evaluator, principal, action, resource, context=None):
    """Lines describing the applicable statements, best first, followed by the decision record."""
    lines = []
    try:
        request = make_request(principal, action, resource, context)
    except ValueError:
        request = None
    if request is not None:
        instant = to_utc(evaluator.clock.now())
        found = sorted(evaluator.matches(request, instant), key=lambda m: m.key, reverse=True)
        if not found:
            lines.append("no statement applies")
        for m in found:
            st = m.statement
            lines.append(f"{st.effect:5} {st.id} key={m.key}")
    decision = evaluator.evaluate(principal, action, resource, context)
    lines.append(decision.record)
    return lines
