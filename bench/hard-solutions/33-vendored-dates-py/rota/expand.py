"""Expanding schedules into occurrences. Specified in docs/SCHEDULES.md."""

from vendor.kalends import Day, Span

from .occurrence import Occurrence, timeline_key


def _days(schedule, cal, last):
    """The days rules 3 to 7 give, in date order, from schedule.start up to `last` (inclusive)."""
    if schedule.until is not None and schedule.until < last:
        last = schedule.until
    start = schedule.start
    if schedule.every == "day":
        day = start
        while day <= last:
            yield day
            day = day.plus(schedule.interval)
    elif schedule.every == "week":
        for day in cal.days(start, last.plus(1)):
            if cal.weekday_code(day) in schedule.on and cal.weeks_apart(start, day) % schedule.interval == 0:
                yield day
    else:
        months = 0
        while True:
            first = cal.add_months(Day(start.year, start.month, 1), months)
            if first > last:
                return
            if schedule.month_day is not None:
                fits = schedule.month_day <= cal.days_in_month(first.year, first.month)
                day = Day(first.year, first.month, schedule.month_day) if fits else None
            else:
                day = cal.nth_weekday(first.year, first.month, cal.weekday_number(schedule.weekday), schedule.nth)
            if day is not None and start <= day <= last:
                yield day
            months += schedule.interval


def expand(schedule, window, cal):
    """The occurrences of one schedule that overlap `window` (a Span), in timeline order."""
    last = max([window.end.day, *schedule.moves])
    found = []
    for n, day in enumerate(_days(schedule, cal, last)):
        if schedule.count is not None and n >= schedule.count:
            break
        if day in schedule.exceptions or (schedule.skip_holidays and cal.is_holiday(day)):
            continue
        moved = day in schedule.moves
        span = Span.of(schedule.moves[day] if moved else day.at(schedule.time), schedule.duration)
        if span.overlaps(window):
            found.append(Occurrence(schedule.id, day, span, moved))
    return sorted(found, key=timeline_key)


def expand_all(schedules, window, cal):
    """The occurrences of several schedules that overlap `window`, merged in timeline order."""
    return sorted((o for s in schedules for o in expand(s, window, cal)), key=timeline_key)
