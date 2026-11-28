"""The team's calendar: weeks run Sunday to Saturday, and these are the office holidays."""

from vendor.kalends import Calendar, Day

WEEK_START = 7  # ISO weekday number: Sunday

HOLIDAYS = (
    Day(2026, 1, 1),
    Day(2026, 1, 19),
    Day(2026, 2, 16),
    Day(2026, 5, 25),
    Day(2026, 7, 3),
    Day(2026, 9, 7),
    Day(2026, 11, 26),
    Day(2026, 12, 25),
)


def team_calendar():
    """The calendar every rota function is given."""
    return Calendar(week_start=WEEK_START, holidays=HOLIDAYS)
