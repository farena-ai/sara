from rota.config import team_calendar
from rota.schedule import parse_schedule
from vendor.kalends import Span

CAL = team_calendar()


def schedule(cal=CAL, **fields):
    data = {"id": "s", "start": "2026-01-05", "time": "09:00", "duration": 30, "repeat": {"every": "day"}}
    data.update(fields)
    return parse_schedule(data, cal)


def window(start, end, cal=CAL):
    return Span(cal.parse_moment(start)[0], cal.parse_moment(end)[0])


JAN = ("2026-01-01T00:00", "2026-02-01T00:00")


def starts(occurrences):
    return [o.start.iso() for o in occurrences]


def days(occurrences):
    return [o.start.day.iso() for o in occurrences]
