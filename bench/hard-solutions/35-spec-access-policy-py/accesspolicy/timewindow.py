"""Time windows (docs/POLICY.md section 7)."""

import re
from datetime import timedelta

from .errors import PolicyError

DAY_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_HHMM = re.compile(r"(\d{2}):(\d{2})")
_OFFSET = re.compile(r"([+-])(\d{2}):(\d{2})")
_KEYS = {"start", "end", "days", "tz_offset"}


def _clock_time(text, allow_end_of_day, where):
    if isinstance(text, str) and allow_end_of_day and text == "24:00":
        return 24 * 3600
    m = _HHMM.fullmatch(text) if isinstance(text, str) else None
    if not m:
        raise PolicyError(f"invalid time {text!r}", where)
    hours, minutes = int(m.group(1)), int(m.group(2))
    if hours > 23 or minutes > 59:
        raise PolicyError(f"invalid time {text!r}", where)
    return hours * 3600 + minutes * 60


def _offset(text, where):
    m = _OFFSET.fullmatch(text) if isinstance(text, str) else None
    if not m:
        raise PolicyError(f"invalid tz_offset {text!r}", where)
    hours, minutes = int(m.group(2)), int(m.group(3))
    if hours > 23 or minutes > 59:
        raise PolicyError(f"invalid tz_offset {text!r}", where)
    total = hours * 3600 + minutes * 60
    return -total if m.group(1) == "-" else total


class TimeWindow:
    def __init__(self, spec, where=None):
        if not isinstance(spec, dict):
            raise PolicyError("a time window must be an object", where)
        unknown = set(spec) - _KEYS
        if unknown:
            raise PolicyError(f"unknown time window keys {sorted(unknown)}", where)
        if "start" not in spec or "end" not in spec:
            raise PolicyError("a time window needs start and end", where)
        self.start = _clock_time(spec["start"], False, where)
        self.end = _clock_time(spec["end"], True, where)
        days = spec.get("days")
        if days is None:
            self.days = frozenset(range(7))
        else:
            if not isinstance(days, list) or not days or not all(d in DAY_NAMES for d in days):
                raise PolicyError(f"invalid days {days!r}", where)
            self.days = frozenset(DAY_NAMES.index(d) for d in days)
        self.offset = _offset(spec.get("tz_offset", "+00:00"), where)

    def contains(self, instant_utc):
        local = instant_utc + timedelta(seconds=self.offset)
        t = local.hour * 3600 + local.minute * 60 + local.second + local.microsecond / 1_000_000
        day = local.weekday()
        if self.end > self.start:
            return day in self.days and self.start <= t < self.end
        if day in self.days and t >= self.start:
            return True
        return (day - 1) % 7 in self.days and t < self.end


def parse_windows(spec, where=None):
    if not isinstance(spec, list) or not spec:
        raise PolicyError("time must be a non-empty list of windows", where)
    return tuple(TimeWindow(w, where) for w in spec)


def any_window(windows, instant_utc):
    return any(w.contains(instant_utc) for w in windows)
