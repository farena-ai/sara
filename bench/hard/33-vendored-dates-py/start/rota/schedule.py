"""Reading schedules: from the JSON shape of docs/FORMAT.md to Schedule values."""

from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping, Optional

from vendor.kalends import CODES, Day, Moment

EVERY = ("day", "week", "month")
TOP_KEYS = {"id", "start", "until", "count", "time", "duration", "repeat", "except", "moves", "skip_holidays"}
MAX_DURATION = 7 * 24 * 60


class ScheduleError(ValueError):
    """A schedule that does not follow docs/FORMAT.md."""


@dataclass(frozen=True)
class Schedule:
    id: str
    start: Day
    time: int
    duration: int
    every: str
    interval: int = 1
    on: tuple = ()
    month_day: Optional[int] = None
    nth: Optional[int] = None
    weekday: Optional[str] = None
    until: Optional[Day] = None
    count: Optional[int] = None
    exceptions: frozenset = frozenset()
    moves: Mapping[Day, Moment] = MappingProxyType({})
    skip_holidays: bool = False


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def parse_schedule(data, cal):
    """A Schedule from one JSON object. Raises ScheduleError naming the schedule and the problem."""
    if not isinstance(data, dict):
        raise ScheduleError("a schedule must be an object")
    sid = data.get("id")
    if not isinstance(sid, str) or not sid:
        raise ScheduleError("a schedule needs a non-empty string id")

    def bad(message):
        return ScheduleError(f"{sid}: {message}")

    unknown = set(data) - TOP_KEYS
    if unknown:
        raise bad(f"unknown fields {sorted(unknown)}")

    def day_of(field, text):
        day, err = cal.parse_day(text)
        if err:
            raise bad(f"{field}: {err}")
        return day

    start = day_of("start", data.get("start"))
    until = day_of("until", data["until"]) if data.get("until") is not None else None
    if until is not None and until < start:
        raise bad("until is before start")
    count = data.get("count")
    if count is not None and (not _is_int(count) or count < 1):
        raise bad("count must be a whole number >= 1")
    time, err = cal.parse_time(data.get("time"))
    if err:
        raise bad(f"time: {err}")
    duration = data.get("duration")
    if not _is_int(duration) or not 1 <= duration <= MAX_DURATION:
        raise bad(f"duration must be a whole number of minutes from 1 to {MAX_DURATION}")

    repeat = data.get("repeat")
    if not isinstance(repeat, dict) or repeat.get("every") not in EVERY:
        raise bad(f"repeat.every must be one of {', '.join(EVERY)}")
    every = repeat["every"]
    allowed = {"every", "interval"} | {"week": {"on"}, "month": {"day", "nth", "weekday"}, "day": set()}[every]
    if set(repeat) - allowed:
        raise bad(f"repeat: unknown fields {sorted(set(repeat) - allowed)} for every={every}")
    interval = repeat.get("interval", 1)
    if not _is_int(interval) or interval < 1:
        raise bad("repeat.interval must be a whole number >= 1")

    on, month_day, nth, weekday = (), None, None, None
    if every == "week":
        codes = repeat.get("on", [cal.weekday_code(start)])
        if not isinstance(codes, list) or not codes or any(c not in CODES for c in codes):
            raise bad(f"repeat.on must be a non-empty list of {', '.join(CODES)}")
        on = tuple(dict.fromkeys(codes))
    elif every == "month":
        if "day" in repeat:
            if "nth" in repeat or "weekday" in repeat:
                raise bad("repeat: give either day, or nth and weekday")
            month_day = repeat["day"]
            if not _is_int(month_day) or not 1 <= month_day <= 31:
                raise bad("repeat.day must be 1 to 31")
        else:
            nth, weekday = repeat.get("nth"), repeat.get("weekday")
            if not _is_int(nth) or nth not in (1, 2, 3, 4, 5, -1):
                raise bad("repeat.nth must be 1 to 5 or -1")
            if weekday not in CODES:
                raise bad(f"repeat.weekday must be one of {', '.join(CODES)}")

    exceptions = frozenset(day_of("except", d) for d in data.get("except", []))
    moves = {}
    for day_text, moment_text in (data.get("moves") or {}).items():
        moment, err = cal.parse_moment(moment_text)
        if err:
            raise bad(f"moves[{day_text}]: {err}")
        moves[day_of("moves", day_text)] = moment
    skip = data.get("skip_holidays", False)
    if not isinstance(skip, bool):
        raise bad("skip_holidays must be true or false")

    return Schedule(
        id=sid, start=start, time=time, duration=duration, every=every, interval=interval, on=on,
        month_day=month_day, nth=nth, weekday=weekday, until=until, count=count,
        exceptions=exceptions, moves=MappingProxyType(moves), skip_holidays=skip,
    )
