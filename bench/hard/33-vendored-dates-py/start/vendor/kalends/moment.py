"""Moment (a day and a minute of that day) and Span (a half-open stretch of time).

Everything is counted in whole MINUTES. There are no seconds, no time zones and no daylight
saving changes: a day always has 1440 minutes."""

from functools import total_ordering

from .day import Day
from .errors import KalendsError

MINUTES_PER_DAY = 1440


def _check_minutes(name, value):
    if not isinstance(value, int) or isinstance(value, bool):
        raise KalendsError(f"{name} must be a whole number of minutes (int), got {value!r}")


@total_ordering
class Moment:
    """An immutable point in time: a Day and the minute of that day (0 to 1439)."""

    __slots__ = ("_day", "_minute")

    def __init__(self, day, minute):
        if not isinstance(day, Day):
            raise KalendsError(f"Moment() needs a Day, got {day!r}")
        _check_minutes("minute", minute)
        if not 0 <= minute < MINUTES_PER_DAY:
            raise KalendsError(f"minute of the day must be 0 to 1439, got {minute}")
        object.__setattr__(self, "_day", day)
        object.__setattr__(self, "_minute", minute)

    @classmethod
    def _from_abs(cls, total):
        ordinal, minute = divmod(total, MINUTES_PER_DAY)
        return cls(Day.from_ordinal(ordinal), minute)

    def __setattr__(self, name, value):
        raise AttributeError("Moment values are immutable; plus() returns a new moment")

    def _abs(self):
        return self._day.ordinal * MINUTES_PER_DAY + self._minute

    @property
    def day(self):
        return self._day

    @property
    def minute(self):
        """Minutes since the start of the day."""
        return self._minute

    def plus(self, minutes):
        """A new Moment `minutes` later (earlier when negative), crossing days as needed."""
        _check_minutes("minutes", minutes)
        return Moment._from_abs(self._abs() + minutes)

    def minutes_until(self, other):
        """Minutes from this moment to `other` (negative when `other` is earlier)."""
        if not isinstance(other, Moment):
            raise KalendsError(f"minutes_until() needs a Moment, got {other!r}")
        return other._abs() - self._abs()

    def time_text(self):
        return f"{self._minute // 60:02d}:{self._minute % 60:02d}"

    def iso(self):
        return f"{self._day.iso()}T{self.time_text()}"

    def __str__(self):
        return self.iso()

    def __repr__(self):
        return f"Moment({self._day!r}, {self._minute})"

    def __eq__(self, other):
        if not isinstance(other, Moment):
            return NotImplemented
        return self._abs() == other._abs()

    def __lt__(self, other):
        if not isinstance(other, Moment):
            return NotImplemented
        return self._abs() < other._abs()

    def __hash__(self):
        return hash(("Moment", self._abs()))


class Span:
    """An immutable, half-open stretch of time [start, end): it includes `start` and excludes
    `end`. A span from 09:00 to 10:00 and one from 10:00 to 11:00 do not overlap."""

    __slots__ = ("_start", "_end")

    def __init__(self, start, end):
        if not isinstance(start, Moment) or not isinstance(end, Moment):
            raise KalendsError("Span() needs two Moments")
        if end < start:
            raise KalendsError(f"a span cannot end ({end}) before it starts ({start})")
        object.__setattr__(self, "_start", start)
        object.__setattr__(self, "_end", end)

    @classmethod
    def of(cls, start, minutes):
        """The span that starts at `start` and lasts `minutes` minutes (>= 0)."""
        _check_minutes("minutes", minutes)
        if minutes < 0:
            raise KalendsError(f"a span cannot last a negative number of minutes ({minutes})")
        return cls(start, start.plus(minutes))

    def __setattr__(self, name, value):
        raise AttributeError("Span values are immutable")

    @property
    def start(self):
        return self._start

    @property
    def end(self):
        return self._end

    @property
    def length(self):
        """Length in minutes."""
        return self._start.minutes_until(self._end)

    def is_empty(self):
        return self._start == self._end

    def contains(self, moment):
        """True when start <= moment < end."""
        if not isinstance(moment, Moment):
            raise KalendsError(f"contains() needs a Moment, got {moment!r}")
        return self._start <= moment < self._end

    def overlaps(self, other):
        """True when the two spans share at least one minute. Spans that only touch (one ends
        where the other starts) do not overlap, and an empty span overlaps nothing."""
        if not isinstance(other, Span):
            raise KalendsError(f"overlaps() needs a Span, got {other!r}")
        if self.is_empty() or other.is_empty():
            return False
        return self._start < other._end and other._start < self._end

    def overlap(self, other):
        """The shared part of two spans as a Span, or None when they do not overlap."""
        if not self.overlaps(other):
            return None
        return Span(max(self._start, other._start), min(self._end, other._end))

    def shift(self, minutes):
        """A new span moved by `minutes` (same length)."""
        return Span(self._start.plus(minutes), self._end.plus(minutes))

    def iso(self):
        return f"{self._start.iso()}/{self._end.iso()}"

    def __str__(self):
        return self.iso()

    def __repr__(self):
        return f"Span({self._start!r}, {self._end!r})"

    def __eq__(self, other):
        if not isinstance(other, Span):
            return NotImplemented
        return self._start == other._start and self._end == other._end

    def __hash__(self):
        return hash(("Span", self._start, self._end))
