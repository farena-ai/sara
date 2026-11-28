"""Clocks. The evaluator never reads the system time itself; it is given a clock."""

import re
from datetime import datetime, timedelta, timezone

_STAMP = re.compile(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z")


class FixedClock:
    """A clock that always returns the same instant until it is moved."""

    def __init__(self, instant):
        self._instant = instant

    def now(self):
        return self._instant

    def set(self, instant):
        self._instant = instant

    def advance(self, seconds):
        self._instant = self._instant + timedelta(seconds=seconds)


class SystemClock:
    """The real time, in UTC."""

    def now(self):
        return datetime.now(timezone.utc)


def to_utc(instant):
    """An aware UTC datetime for any datetime (naive ones are taken to be UTC)."""
    if not isinstance(instant, datetime):
        raise TypeError("a clock must return a datetime")
    if instant.tzinfo is None:
        return instant.replace(tzinfo=timezone.utc)
    return instant.astimezone(timezone.utc)


def parse_utc(text):
    """Parses YYYY-MM-DDTHH:MM:SSZ into an aware datetime; raises ValueError otherwise."""
    if not isinstance(text, str):
        raise ValueError("timestamp must be a string")
    m = _STAMP.fullmatch(text)
    if not m:
        raise ValueError(f"timestamp {text!r} is not YYYY-MM-DDTHH:MM:SSZ")
    year, month, day, hour, minute, second = (int(g) for g in m.groups())
    return datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)


def utc(year, month, day, hour=0, minute=0, second=0, microsecond=0):
    """Shorthand for an aware UTC datetime (used by tests and examples)."""
    return datetime(year, month, day, hour, minute, second, microsecond, tzinfo=timezone.utc)
