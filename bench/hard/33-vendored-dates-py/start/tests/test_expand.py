import unittest

from rota.config import team_calendar
from rota.conflicts import find_conflicts
from rota.expand import expand, expand_all
from rota.schedule import parse_schedule
from vendor.kalends import Span

CAL = team_calendar()


def schedule(**fields):
    data = {"id": "s", "start": "2026-01-05", "time": "09:00", "duration": 30, "repeat": {"every": "day"}}
    data.update(fields)
    return parse_schedule(data, CAL)


def window(start, end):
    return Span(CAL.parse_moment(start)[0], CAL.parse_moment(end)[0])


def starts(occurrences):
    return [o.start.iso() for o in occurrences]


class ExpandTest(unittest.TestCase):
    def test_daily(self):
        occ = expand(schedule(), window("2026-01-05T00:00", "2026-01-08T00:00"), CAL)
        self.assertEqual(starts(occ), ["2026-01-05T09:00", "2026-01-06T09:00", "2026-01-07T09:00"])
        self.assertEqual(occ[0].end.iso(), "2026-01-05T09:30")
        self.assertFalse(occ[0].moved)

    def test_weekly(self):
        s = schedule(repeat={"every": "week", "on": ["MO", "WE"]})
        occ = expand(s, window("2026-01-05T00:00", "2026-01-19T00:00"), CAL)
        self.assertEqual([o.day.iso() for o in occ], ["2026-01-05", "2026-01-07", "2026-01-12", "2026-01-14"])

    def test_merged_timeline(self):
        a = schedule(id="a", time="10:00")
        b = schedule(id="b", time="08:00")
        occ = expand_all([a, b], window("2026-01-05T00:00", "2026-01-06T00:00"), CAL)
        self.assertEqual([o.schedule_id for o in occ], ["b", "a"])


class ConflictTest(unittest.TestCase):
    def test_overlap(self):
        a = schedule(id="a", duration=60)
        b = schedule(id="b", time="09:30")
        occ = expand_all([a, b], window("2026-01-05T00:00", "2026-01-06T00:00"), CAL)
        conflicts = find_conflicts(occ)
        self.assertEqual(len(conflicts), 1)
        self.assertEqual((conflicts[0].first.schedule_id, conflicts[0].second.schedule_id, conflicts[0].minutes), ("a", "b", 30))


if __name__ == "__main__":
    unittest.main()
