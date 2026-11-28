"""Finding occurrences that overlap each other. Specified in docs/SCHEDULES.md."""

from .occurrence import Conflict, timeline_key


def find_conflicts(occurrences):
    """Every pair of occurrences that overlap, as Conflict values."""
    ordered = sorted(occurrences, key=timeline_key)
    found = []
    for i, first in enumerate(ordered):
        for second in ordered[i + 1:]:
            if second.start >= first.end:
                break
            shared = first.span.overlap(second.span)
            if shared is not None:
                found.append(Conflict(first, second, shared.length))
    return found
