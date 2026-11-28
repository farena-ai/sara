"""Day: one calendar day, without a time and without a time zone."""

from datetime import date as _date
from functools import total_ordering

from .errors import KalendsError


def _check_int(name, value):
    if not isinstance(value, int) or isinstance(value, bool):
        raise KalendsError(f"{name} must be an int, got {value!r}")


@total_ordering
class Day:
    """An immutable calendar day. Day(2026, 1, 5) is the 5th of January 2026.

    Months and days of the month count from 1. There is no weekday here: weekdays depend on the
    calendar (see Calendar.weekday)."""

    __slots__ = ("_ord",)

    def __init__(self, year, month, day):
        _check_int("year", year)
        _check_int("month", month)
        _check_int("day", day)
        try:
            ordinal = _date(year, month, day).toordinal()
        except ValueError:
            raise KalendsError(f"no such day: {year:04d}-{month:02d}-{day:02d}") from None
        object.__setattr__(self, "_ord", ordinal)

    @classmethod
    def from_ordinal(cls, ordinal):
        """The day with this ordinal (Day(1, 1, 1) is 1)."""
        _check_int("ordinal", ordinal)
        if not 1 <= ordinal <= _date.max.toordinal():
            raise KalendsError(f"ordinal out of range: {ordinal}")
        obj = cls.__new__(cls)
        object.__setattr__(obj, "_ord", ordinal)
        return obj

    def __setattr__(self, name, value):
        raise AttributeError("Day values are immutable; plus() returns a new day")

    def __delattr__(self, name):
        raise AttributeError("Day values are immutable")

    def _date(self):
        return _date.fromordinal(self._ord)

    @property
    def year(self):
        return self._date().year

    @property
    def month(self):
        return self._date().month

    @property
    def day(self):
        return self._date().day

    @property
    def ordinal(self):
        return self._ord

    def plus(self, days):
        """A new Day `days` later (earlier when negative). The day itself does not change."""
        _check_int("days", days)
        return Day.from_ordinal(self._ord + days)

    def days_until(self, other):
        """How many days from this day to `other` (negative when `other` is earlier)."""
        if not isinstance(other, Day):
            raise KalendsError(f"days_until() needs a Day, got {other!r}")
        return other._ord - self._ord

    def at(self, minute):
        """The Moment `minute` minutes after the start of this day (0 to 1439): at(570) is 09:30."""
        from .moment import Moment

        return Moment(self, minute)

    def iso(self):
        d = self._date()
        return f"{d.year:04d}-{d.month:02d}-{d.day:02d}"

    def __str__(self):
        return self.iso()

    def __repr__(self):
        d = self._date()
        return f"Day({d.year}, {d.month}, {d.day})"

    def __eq__(self, other):
        if not isinstance(other, Day):
            return NotImplemented
        return self._ord == other._ord

    def __lt__(self, other):
        if not isinstance(other, Day):
            return NotImplemented
        return self._ord < other._ord

    def __hash__(self):
        return hash(("Day", self._ord))
