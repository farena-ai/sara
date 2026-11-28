"""Calendar: weekdays, weeks, months, holidays and parsing, under explicit rules."""

import re
from datetime import date as _date

from .day import Day
from .errors import KalendsError
from .moment import Moment

CODES = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")
"""Weekday codes in ISO order: MO is ISO weekday 1, SU is 7."""

_DAY = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
_TIME = re.compile(r"(\d{2}):(\d{2})")


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


class Calendar:
    """Rules for counting days: which weekday starts the week, and which days are holidays.

    Calendar(week_start=7) is a calendar whose weeks run Sunday to Saturday. `week_start` is the
    ISO number of the first weekday (1 = Monday ... 7 = Sunday); the default is Monday."""

    __slots__ = ("_week_start", "_holidays")

    def __init__(self, week_start=1, holidays=()):
        if not _is_int(week_start) or not 1 <= week_start <= 7:
            raise KalendsError(f"week_start must be an ISO weekday number 1 (Monday) to 7 (Sunday), got {week_start!r}")
        days = frozenset(holidays)
        for d in days:
            if not isinstance(d, Day):
                raise KalendsError(f"holidays must be Day values, got {d!r}")
        object.__setattr__(self, "_week_start", week_start)
        object.__setattr__(self, "_holidays", days)

    def __setattr__(self, name, value):
        raise AttributeError("Calendar objects are immutable; use with_holidays() for a changed copy")

    def __repr__(self):
        return f"Calendar(week_start={self._week_start}, holidays=<{len(self._holidays)} days>)"

    @property
    def week_start(self):
        """ISO number (1 = Monday ... 7 = Sunday) of the weekday the weeks start on."""
        return self._week_start

    @property
    def holidays(self):
        return self._holidays

    def with_holidays(self, holidays):
        """A new calendar with the same week start and these holidays."""
        return Calendar(self._week_start, holidays)

    # Weekdays and weeks -------------------------------------------------------------------

    @staticmethod
    def _iso_weekday(day):
        return _date.fromordinal(day.ordinal).isoweekday()

    def weekday(self, day):
        """The position of `day` in this calendar's week: 1 for the first day of the week ...
        7 for the last. With week_start=7 (Sunday), a Sunday is 1 and a Monday is 2."""
        if not isinstance(day, Day):
            raise KalendsError(f"weekday() needs a Day, got {day!r}")
        return (self._iso_weekday(day) - self._week_start) % 7 + 1

    def weekday_code(self, day):
        """The weekday of `day` as a code: 'MO', 'TU', 'WE', 'TH', 'FR', 'SA' or 'SU'."""
        if not isinstance(day, Day):
            raise KalendsError(f"weekday_code() needs a Day, got {day!r}")
        return CODES[self._iso_weekday(day) - 1]

    def weekday_number(self, code):
        """The position (1 to 7) that weekday `code` has in this calendar's week, i.e. what
        weekday() returns for such a day."""
        if code not in CODES:
            raise KalendsError(f"unknown weekday code {code!r}; codes are {', '.join(CODES)}")
        return (CODES.index(code) + 1 - self._week_start) % 7 + 1

    def week_of(self, day):
        """The first day of the week (in this calendar) that contains `day`."""
        return day.plus(1 - self.weekday(day))

    def weeks_apart(self, a, b):
        """How many weeks the week containing `b` is after the week containing `a` (negative when
        before; 0 when both days are in the same week of this calendar)."""
        return self.week_of(a).days_until(self.week_of(b)) // 7

    # Months -------------------------------------------------------------------------------

    @staticmethod
    def days_in_month(year, month):
        if not _is_int(year) or not _is_int(month) or not 1 <= month <= 12:
            raise KalendsError(f"bad year/month: {year!r}/{month!r}")
        nxt = _date(year + 1, 1, 1) if month == 12 else _date(year, month + 1, 1)
        return (nxt - _date(year, month, 1)).days

    def add_months(self, day, months):
        """The same day of the month `months` months later. When that month is shorter, the
        result is CLAMPED to its last day: add_months(Day(2026, 1, 31), 1) is Day(2026, 2, 28)."""
        if not _is_int(months):
            raise KalendsError(f"months must be an int, got {months!r}")
        index = day.year * 12 + (day.month - 1) + months
        year, month0 = divmod(index, 12)
        return Day(year, month0 + 1, min(day.day, self.days_in_month(year, month0 + 1)))

    @staticmethod
    def months_apart(a, b):
        """How many months b's month is after a's month (the days of the month do not matter)."""
        return (b.year * 12 + b.month) - (a.year * 12 + a.month)

    def nth_weekday(self, year, month, weekday, n):
        """The n-th day of the month that has the given weekday, or None when there is none.

        `weekday` is a position in THIS calendar's week (1 to 7, as returned by weekday() and
        weekday_number()), not an ISO number and not a code. `n` is 1 to 5 counting from the
        start of the month, or -1 to -5 counting from the end (-1 is the last)."""
        if not _is_int(weekday) or not 1 <= weekday <= 7:
            raise KalendsError(f"weekday must be an int 1..7 relative to the calendar's week (see weekday_number()), got {weekday!r}")
        if not _is_int(n) or n == 0 or not -5 <= n <= 5:
            raise KalendsError(f"n must be 1..5 or -1..-5, got {n!r}")
        size = self.days_in_month(year, month)
        first = Day(year, month, 1)
        matches = [first.plus(i) for i in range(size) if self.weekday(first.plus(i)) == weekday]
        index = n - 1 if n > 0 else len(matches) + n
        return matches[index] if 0 <= index < len(matches) else None

    # Ranges and holidays ------------------------------------------------------------------

    def days(self, start, stop):
        """Iterates over the days from `start` up to but NOT including `stop`."""
        if not isinstance(start, Day) or not isinstance(stop, Day):
            raise KalendsError("days() needs two Day values")
        d = start
        while d < stop:
            yield d
            d = d.plus(1)

    def is_holiday(self, day):
        return day in self._holidays

    # Parsing: these never raise; they return (value, None) or (None, "what is wrong") -----

    def parse_day(self, text):
        """'2026-01-05' -> (Day(2026, 1, 5), None); anything else -> (None, message)."""
        if not isinstance(text, str):
            return None, f"expected a 'YYYY-MM-DD' string, got {text!r}"
        m = _DAY.fullmatch(text)
        if not m:
            return None, f"not a 'YYYY-MM-DD' day: {text!r}"
        try:
            return Day(int(m[1]), int(m[2]), int(m[3])), None
        except KalendsError as e:
            return None, str(e)

    def parse_time(self, text):
        """'09:30' -> (570, None): minutes after midnight, 00:00 to 23:59."""
        if not isinstance(text, str):
            return None, f"expected an 'HH:MM' string, got {text!r}"
        m = _TIME.fullmatch(text)
        if not m or int(m[1]) > 23 or int(m[2]) > 59:
            return None, f"not an 'HH:MM' time: {text!r}"
        return int(m[1]) * 60 + int(m[2]), None

    def parse_moment(self, text):
        """'2026-01-05T09:30' -> (Moment(Day(2026, 1, 5), 570), None)."""
        if not isinstance(text, str) or "T" not in text:
            return None, f"not a 'YYYY-MM-DDTHH:MM' moment: {text!r}"
        day_text, _, time_text = text.partition("T")
        day, err = self.parse_day(day_text)
        if err:
            return None, err
        minute, err = self.parse_time(time_text)
        if err:
            return None, err
        return Moment(day, minute), None
