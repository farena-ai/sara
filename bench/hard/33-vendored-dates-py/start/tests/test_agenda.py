import unittest

from rota.agenda import agenda
from rota.config import HOLIDAYS, team_calendar
from rota.occurrence import Conflict, Occurrence, timeline_key
from vendor.kalends import Day, Span


def occ(sid, day, minute, minutes, moved=False):
    return Occurrence(sid, day, Span.of(day.at(minute), minutes), moved)


class AgendaTest(unittest.TestCase):
    def test_team_calendar(self):
        cal = team_calendar()
        self.assertEqual(cal.week_start, 7)
        self.assertTrue(cal.is_holiday(Day(2026, 1, 19)))
        self.assertEqual(len(HOLIDAYS), 8)

    def test_timeline_key(self):
        d = Day(2026, 1, 5)
        items = [occ("b", d, 540, 30), occ("a", d, 540, 30), occ("c", d, 480, 30)]
        self.assertEqual([o.schedule_id for o in sorted(items, key=timeline_key)], ["c", "a", "b"])

    def test_agenda_text(self):
        d = Day(2026, 1, 5)
        a = occ("standup", d, 570, 15)
        b = occ("review", d, 540, 60, moved=True)
        text = agenda([b, a], [Conflict(b, a, 15)])
        self.assertEqual(text.splitlines(), [
            "2026-01-05",
            "  09:00-10:00  review (moved)",
            "  09:30-09:45  standup",
            "",
            "Conflicts:",
            "  review 2026-01-05T09:00 and standup 2026-01-05T09:30: 15 min",
        ])


if __name__ == "__main__":
    unittest.main()
