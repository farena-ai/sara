import os
import unittest

from rota.conflicts import find_conflicts
from rota.expand import expand_all
from rota.load import load_schedules
from support import CAL, schedule, window

DAY = window("2026-01-05T00:00", "2026-01-06T00:00")


def pairs(conflicts):
    return [(c.first.schedule_id, c.first.start.iso(), c.second.schedule_id, c.second.start.iso(), c.minutes) for c in conflicts]


class ConflictRules(unittest.TestCase):
    def test_rule_15_touching_is_not_a_conflict(self):
        occ = expand_all([schedule(id="a"), schedule(id="b", time="09:30")], DAY, CAL)
        self.assertEqual(find_conflicts(occ), [])

    def test_rule_15_and_16_overlap_minutes(self):
        occ = expand_all([schedule(id="a"), schedule(id="b", time="09:30"), schedule(id="c", time="09:15")], DAY, CAL)
        self.assertEqual(pairs(find_conflicts(occ)), [
            ("a", "2026-01-05T09:00", "c", "2026-01-05T09:15", 15),
            ("c", "2026-01-05T09:15", "b", "2026-01-05T09:30", 15),
        ])

    def test_rule_15_a_schedule_can_conflict_with_itself(self):
        s = schedule(id="long", time="22:00", duration=1500)
        occ = expand_all([s], window("2026-01-05T00:00", "2026-01-08T00:00"), CAL)
        self.assertEqual(pairs(find_conflicts(occ)), [
            ("long", "2026-01-05T22:00", "long", "2026-01-06T22:00", 60),
            ("long", "2026-01-06T22:00", "long", "2026-01-07T22:00", 60),
        ])

    def test_rule_16_order_and_unsorted_input(self):
        a = schedule(id="a", duration=60)
        b = schedule(id="b", time="09:10", duration=10)
        c = schedule(id="c", time="09:30", duration=10)
        occ = expand_all([a, b, c], DAY, CAL)
        self.assertEqual(pairs(find_conflicts(list(reversed(occ)))), [
            ("a", "2026-01-05T09:00", "b", "2026-01-05T09:10", 10),
            ("a", "2026-01-05T09:00", "c", "2026-01-05T09:30", 10),
        ])

    def test_rule_16_first_is_first_in_timeline_order(self):
        x = schedule(id="x", duration=30)
        m = schedule(id="m", duration=45)
        self.assertEqual(pairs(find_conflicts(expand_all([x, m], DAY, CAL))), [("m", "2026-01-05T09:00", "x", "2026-01-05T09:00", 30)])

    def test_rule_16_partial_overlap_across_midnight(self):
        night = schedule(id="night", time="23:00", duration=120)
        early = schedule(id="early", time="00:30", duration=60, start="2026-01-06")
        occ = expand_all([night, early], window("2026-01-05T12:00", "2026-01-06T12:00"), CAL)
        self.assertEqual(pairs(find_conflicts(occ)), [("night", "2026-01-05T23:00", "early", "2026-01-06T00:30", 30)])


class TeamFile(unittest.TestCase):
    def test_the_team_week_of_the_19th(self):
        here = os.path.dirname(os.path.abspath(__file__))
        schedules = load_schedules(os.path.join(here, "..", "data", "team.json"), CAL)
        occ = expand_all(schedules, window("2026-01-18T00:00", "2026-01-25T00:00"), CAL)
        self.assertEqual([(o.schedule_id, o.start.iso(), o.moved) for o in occ], [
            ("on-call", "2026-01-17T22:00", False),
            ("standup", "2026-01-20T09:30", False),
            ("on-call", "2026-01-20T22:00", False),
            ("standup", "2026-01-21T09:30", False),
            ("standup", "2026-01-22T09:30", False),
            ("review", "2026-01-23T09:00", True),
            ("standup", "2026-01-23T09:30", False),
            ("on-call", "2026-01-23T22:00", False),
        ])
        self.assertEqual(pairs(find_conflicts(occ)), [("review", "2026-01-23T09:00", "standup", "2026-01-23T09:30", 15)])

    def test_the_team_retro_is_on_the_last_friday_six_times(self):
        here = os.path.dirname(os.path.abspath(__file__))
        schedules = load_schedules(os.path.join(here, "..", "data", "team.json"), CAL)
        retro = [s for s in schedules if s.id == "retro"]
        occ = expand_all(retro, window("2026-01-01T00:00", "2027-01-01T00:00"), CAL)
        self.assertEqual([o.start.iso() for o in occ], [
            "2026-01-30T16:00", "2026-02-27T16:00", "2026-03-27T16:00",
            "2026-04-24T16:00", "2026-05-29T16:00", "2026-06-26T16:00",
        ])


if __name__ == "__main__":
    unittest.main()
