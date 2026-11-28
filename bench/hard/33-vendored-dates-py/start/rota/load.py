"""Loading a file of schedules."""

import json

from .schedule import ScheduleError, parse_schedule


def load_schedules(path, cal):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ScheduleError(f"{path}: expected a list of schedules")
    schedules = [parse_schedule(item, cal) for item in data]
    ids = [s.id for s in schedules]
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        raise ScheduleError(f"{path}: duplicate ids {dupes}")
    return schedules
