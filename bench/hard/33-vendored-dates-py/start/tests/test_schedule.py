import unittest

from rota.config import team_calendar
from rota.schedule import ScheduleError, parse_schedule
from vendor.kalends import Day

CAL = team_calendar()
BASE = {"id": "s", "start": "2026-01-05", "time": "09:30", "duration": 15, "repeat": {"every": "day"}}


def parse(**changes):
    data = dict(BASE)
    data.update(changes)
    return parse_schedule(data, CAL)


class ParseTest(unittest.TestCase):
    def test_basic_fields(self):
        s = parse(until="2026-02-01", count=3)
        self.assertEqual(s.start, Day(2026, 1, 5))
        self.assertEqual(s.until, Day(2026, 2, 1))
        self.assertEqual(s.time, 570)
        self.assertEqual(s.duration, 15)
        self.assertEqual((s.every, s.interval, s.count), ("day", 1, 3))

    def test_weekly_defaults_to_the_start_weekday(self):
        self.assertEqual(parse(repeat={"every": "week"}).on, ("MO",))
        self.assertEqual(parse(repeat={"every": "week", "on": ["FR", "MO", "FR"]}).on, ("FR", "MO"))

    def test_monthly(self):
        s = parse(repeat={"every": "month", "nth": -1, "weekday": "FR"})
        self.assertEqual((s.nth, s.weekday, s.month_day), (-1, "FR", None))
        self.assertEqual(parse(repeat={"every": "month", "day": 31}).month_day, 31)

    def test_exceptions_and_moves(self):
        s = parse(**{"except": ["2026-01-07"], "moves": {"2026-01-08": "2026-01-09T10:00"}})
        self.assertEqual(s.exceptions, frozenset({Day(2026, 1, 7)}))
        self.assertEqual(s.moves[Day(2026, 1, 8)].iso(), "2026-01-09T10:00")

    def test_errors(self):
        for bad in (
            {"start": "2026-02-30"},
            {"time": "24:00"},
            {"duration": 0},
            {"repeat": {"every": "year"}},
            {"repeat": {"every": "week", "on": ["MON"]}},
            {"repeat": {"every": "month", "day": 3, "nth": 1}},
            {"until": "2026-01-01"},
            {"colour": "red"},
        ):
            with self.assertRaises(ScheduleError, msg=bad):
                parse(**bad)


if __name__ == "__main__":
    unittest.main()
