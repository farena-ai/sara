"""Expanding schedules into occurrences. Specified in docs/SCHEDULES.md."""


def expand(schedule, window, cal):
    """The occurrences of one schedule that overlap `window` (a Span), in timeline order."""
    raise NotImplementedError("expand")


def expand_all(schedules, window, cal):
    """The occurrences of several schedules that overlap `window`, merged in timeline order."""
    raise NotImplementedError("expand_all")
