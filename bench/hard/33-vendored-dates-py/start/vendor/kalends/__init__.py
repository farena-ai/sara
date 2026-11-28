"""kalends: immutable days, moments and spans, with an explicit Calendar.

See README.md for an overview and docs/API.md for the reference."""

from .calendar import CODES, Calendar
from .day import Day
from .errors import KalendsError
from .moment import MINUTES_PER_DAY, Moment, Span

__all__ = ["CODES", "Calendar", "Day", "KalendsError", "MINUTES_PER_DAY", "Moment", "Span"]
__version__ = "3.2.0"
