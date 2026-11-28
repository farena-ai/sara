"""Time windows (docs/POLICY.md section 7)."""

import re

from .errors import PolicyError

DAY_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_HHMM = re.compile(r"(\d{2}):(\d{2})")


def _clock_time(text, where):
    m = _HHMM.fullmatch(text) if isinstance(text, str) else None
    if not m:
        raise PolicyError(f"invalid time {text!r}", where)
    hours, minutes = int(m.group(1)), int(m.group(2))
    if hours > 23 or minutes > 59:
        raise PolicyError(f"invalid time {text!r}", where)
    return hours * 3600 + minutes * 60


class TimeWindow:
    def __init__(self, spec, where=None):
        if not isinstance(spec, dict):
            raise PolicyError("a time window must be an object", where)
        if "start" not in spec or "end" not in spec:
            raise PolicyError("a time window needs start and end", where)
        self.start = _clock_time(spec["start"], where)
        self.end = _clock_time(spec["end"], where)
        days = spec.get("days")
        if days is None:
            self.days = frozenset(range(7))
        else:
            if not isinstance(days, list) or not all(d in DAY_NAMES for d in days):
                raise PolicyError(f"invalid days {days!r}", where)
            self.days = frozenset(DAY_NAMES.index(d) for d in days)

    def contains(self, instant_utc):
        t = instant_utc.hour * 3600 + instant_utc.minute * 60 + instant_utc.second
        return instant_utc.weekday() in self.days and self.start <= t <= self.end


def parse_windows(spec, where=None):
    if not isinstance(spec, list):
        raise PolicyError("time must be a list of windows", where)
    return tuple(TimeWindow(w, where) for w in spec)


def any_window(windows, instant_utc):
    return any(w.contains(instant_utc) for w in windows)
