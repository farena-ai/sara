import unittest

from rota.expand import expand, expand_all
from support import CAL, JAN, days, schedule, starts, window
from vendor.kalends import Calendar, Day

W = window(*JAN)


class TimeRules(unittest.TestCase):
    def test_rule_2_occurrences_run_past_midnight(self):
        s = schedule(time="23:30", duration=90)
        occ = expand(s, window("2026-01-06T00:00", "2026-01-07T00:00"), CAL)
        self.assertEqual(starts(occ), ["2026-01-05T23:30", "2026-01-06T23:30"])
        self.assertEqual([o.end.iso() for o in occ], ["2026-01-06T01:00", "2026-01-07T01:00"])

    def test_rule_2_duration_is_minutes(self):
        occ = expand(schedule(time="08:15", duration=135), window("2026-01-05T00:00", "2026-01-06T00:00"), CAL)
        self.assertEqual([(o.start.iso(), o.end.iso()) for o in occ], [("2026-01-05T08:15", "2026-01-05T10:30")])
        self.assertEqual(occ[0].span.length, 135)


class DayRules(unittest.TestCase):
    def test_rule_3_until_is_inclusive_and_start_bounds(self):
        occ = expand(schedule(until="2026-01-09"), W, CAL)
        self.assertEqual(days(occ), ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"])

    def test_rule_3_until_on_a_weekly_day(self):
        s = schedule(start="2026-01-05", until="2026-01-19", repeat={"every": "week", "on": ["MO"]})
        self.assertEqual(days(expand(s, W, CAL)), ["2026-01-05", "2026-01-12", "2026-01-19"])

    def test_rule_4_daily_interval_counts_from_start(self):
        s = schedule(start="2026-01-02", repeat={"every": "day", "interval": 3})
        occ = expand(s, window("2026-01-10T00:00", "2026-01-20T00:00"), CAL)
        self.assertEqual(days(occ), ["2026-01-11", "2026-01-14", "2026-01-17"])

    def test_rule_5_weekly_defaults_to_the_start_weekday(self):
        s = schedule(start="2026-01-08", repeat={"every": "week"})
        self.assertEqual(days(expand(s, W, CAL)), ["2026-01-08", "2026-01-15", "2026-01-22", "2026-01-29"])

    def test_rule_5_weeks_run_sunday_to_saturday(self):
        s = schedule(start="2026-01-03", repeat={"every": "week", "interval": 2, "on": ["SA", "SU"]})
        occ = expand(s, window("2025-12-28T00:00", "2026-02-01T00:00"), CAL)
        self.assertEqual(days(occ), ["2026-01-03", "2026-01-11", "2026-01-17", "2026-01-25", "2026-01-31"])

    def test_rule_5_every_third_week_skips_days_before_start(self):
        s = schedule(start="2026-01-07", repeat={"every": "week", "interval": 3, "on": ["SU", "WE"]})
        occ = expand(s, window("2026-01-01T00:00", "2026-02-22T00:00"), CAL)
        self.assertEqual(days(occ), ["2026-01-07", "2026-01-25", "2026-01-28", "2026-02-15", "2026-02-18"])

    def test_rule_5_weeks_follow_the_calendar_given(self):
        monday_weeks = Calendar(week_start=1)
        s = schedule(cal=monday_weeks, start="2026-01-03", repeat={"every": "week", "interval": 2, "on": ["SA", "SU"]})
        occ = expand(s, window("2025-12-28T00:00", "2026-02-01T00:00", monday_weeks), monday_weeks)
        self.assertEqual(days(occ), ["2026-01-03", "2026-01-04", "2026-01-17", "2026-01-18", "2026-01-31"])

    def test_rule_6_months_without_the_day_are_skipped(self):
        s = schedule(start="2026-01-31", repeat={"every": "month", "day": 31})
        occ = expand(s, window("2026-01-01T00:00", "2026-07-01T00:00"), CAL)
        self.assertEqual(days(occ), ["2026-01-31", "2026-03-31", "2026-05-31"])

    def test_rule_6_interval_counts_from_the_start_month(self):
        s = schedule(start="2025-12-15", repeat={"every": "month", "day": 30, "interval": 2})
        occ = expand(s, window("2025-12-01T00:00", "2026-07-01T00:00"), CAL)
        self.assertEqual(days(occ), ["2025-12-30", "2026-04-30", "2026-06-30"])

    def test_rule_6_day_before_start_in_the_first_month(self):
        s = schedule(start="2026-01-20", repeat={"every": "month", "day": 10})
        occ = expand(s, window("2026-01-01T00:00", "2026-04-01T00:00"), CAL)
        self.assertEqual(days(occ), ["2026-02-10", "2026-03-10"])

    def test_rule_7_last_friday(self):
        s = schedule(start="2026-01-01", repeat={"every": "month", "nth": -1, "weekday": "FR"})
        occ = expand(s, window("2026-01-01T00:00", "2026-05-01T00:00"), CAL)
        self.assertEqual(days(occ), ["2026-01-30", "2026-02-27", "2026-03-27", "2026-04-24"])

    def test_rule_7_months_without_a_fifth_are_skipped(self):
        s = schedule(start="2026-01-01", repeat={"every": "month", "nth": 5, "weekday": "TH"})
        occ = expand(s, window("2026-01-01T00:00", "2026-06-01T00:00"), CAL)
        self.assertEqual(days(occ), ["2026-01-29", "2026-04-30"])

    def test_rule_7_second_tuesday_every_third_month(self):
        s = schedule(start="2026-01-20", repeat={"every": "month", "nth": 2, "weekday": "TU", "interval": 3})
        occ = expand(s, window("2026-01-01T00:00", "2026-08-01T00:00"), CAL)
        self.assertEqual(days(occ), ["2026-04-14", "2026-07-14"])

    def test_rule_7_first_sunday(self):
        s = schedule(start="2026-01-01", repeat={"every": "month", "nth": 1, "weekday": "SU"})
        occ = expand(s, window("2026-01-01T00:00", "2026-04-01T00:00"), CAL)
        self.assertEqual(days(occ), ["2026-01-04", "2026-02-01", "2026-03-01"])


class CountExceptHolidayMove(unittest.TestCase):
    def test_rule_8_excepted_days_use_up_the_count(self):
        s = schedule(count=5, **{"except": ["2026-01-07"]})
        self.assertEqual(days(expand(s, W, CAL)), ["2026-01-05", "2026-01-06", "2026-01-08", "2026-01-09"])

    def test_rule_8_holidays_use_up_the_count(self):
        s = schedule(count=3, skip_holidays=True, repeat={"every": "week", "on": ["MO"]})
        self.assertEqual(days(expand(s, W, CAL)), ["2026-01-05", "2026-01-12"])

    def test_rule_8_count_starts_at_start_not_at_the_window(self):
        s = schedule(count=4)
        self.assertEqual(days(expand(s, window("2026-01-07T00:00", "2026-01-31T00:00"), CAL)), ["2026-01-07", "2026-01-08"])

    def test_rule_8_count_and_until_together(self):
        s = schedule(count=10, until="2026-01-07")
        self.assertEqual(len(expand(s, W, CAL)), 3)
        s = schedule(count=2, until="2026-01-30")
        self.assertEqual(len(expand(s, W, CAL)), 2)

    def test_rule_9_excepting_an_unused_day_changes_nothing(self):
        s = schedule(repeat={"every": "week", "on": ["MO"]}, **{"except": ["2026-01-06", "2026-01-12"]})
        self.assertEqual(days(expand(s, window("2026-01-01T00:00", "2026-01-27T00:00"), CAL)), ["2026-01-05", "2026-01-19", "2026-01-26"])

    def test_rule_10_skip_holidays(self):
        weekdays = {"every": "week", "on": ["MO", "TU", "WE", "TH", "FR"]}
        w = window("2026-01-18T00:00", "2026-01-25T00:00")
        self.assertEqual(days(expand(schedule(repeat=weekdays, skip_holidays=True), w, CAL)), ["2026-01-20", "2026-01-21", "2026-01-22", "2026-01-23"])
        self.assertEqual(days(expand(schedule(repeat=weekdays), w, CAL)), ["2026-01-19", "2026-01-20", "2026-01-21", "2026-01-22", "2026-01-23"])

    def test_rule_10_holidays_come_from_the_calendar_given(self):
        cal = Calendar(week_start=7, holidays=[Day(2026, 1, 21)])
        s = schedule(cal=cal, skip_holidays=True)
        occ = expand(s, window("2026-01-19T00:00", "2026-01-23T00:00", cal), cal)
        self.assertEqual(days(occ), ["2026-01-19", "2026-01-20", "2026-01-22"])

    def test_rule_11_a_move_keeps_duration_and_day(self):
        s = schedule(start="2026-01-08", time="14:00", duration=60, repeat={"every": "week", "interval": 2}, moves={"2026-01-22": "2026-01-23T09:00"})
        occ = expand(s, W, CAL)
        self.assertEqual([(o.start.iso(), o.end.iso(), o.day.iso(), o.moved) for o in occ], [
            ("2026-01-08T14:00", "2026-01-08T15:00", "2026-01-08", False),
            ("2026-01-23T09:00", "2026-01-23T10:00", "2026-01-22", True),
        ])

    def test_rule_11_moves_of_days_without_an_occurrence_are_ignored(self):
        s = schedule(count=3, **{
            "except": ["2026-01-06"],
            "moves": {"2026-01-06": "2026-01-10T09:00", "2026-01-08": "2026-01-11T09:00", "2026-01-07": "2026-01-07T15:00"},
        })
        occ = expand(s, W, CAL)
        self.assertEqual([(o.start.iso(), o.moved) for o in occ], [("2026-01-05T09:00", False), ("2026-01-07T15:00", True)])

    def test_rule_11_moves_of_skipped_holidays_and_unused_weekdays_are_ignored(self):
        s = schedule(skip_holidays=True, repeat={"every": "week", "on": ["MO"]}, moves={"2026-01-19": "2026-01-20T09:00", "2026-01-21": "2026-01-22T09:00"})
        self.assertEqual(starts(expand(s, W, CAL)), ["2026-01-05T09:00", "2026-01-12T09:00", "2026-01-26T09:00"])


class WindowRules(unittest.TestCase):
    def test_rule_12_the_window_is_half_open(self):
        s = schedule()
        self.assertEqual(expand(s, window("2026-01-06T09:30", "2026-01-07T09:00"), CAL), [])
        self.assertEqual(days(expand(s, window("2026-01-06T09:29", "2026-01-07T09:01"), CAL)), ["2026-01-06", "2026-01-07"])

    def test_rule_12_a_move_can_bring_an_occurrence_in_or_take_it_out(self):
        s = schedule(until="2026-01-31", moves={"2026-01-06": "2026-01-25T12:00", "2026-01-20": "2026-01-06T12:00"})
        occ = expand(s, window("2026-01-06T00:00", "2026-01-07T00:00"), CAL)
        self.assertEqual([(o.start.iso(), o.day.iso(), o.moved) for o in occ], [("2026-01-06T12:00", "2026-01-20", True)])

    def test_rule_12_a_move_into_the_window_from_a_later_month(self):
        s = schedule(start="2026-01-31", repeat={"every": "month", "day": 31}, moves={"2026-05-31": "2026-02-02T08:00"})
        occ = expand(s, window("2026-02-01T00:00", "2026-03-01T00:00"), CAL)
        self.assertEqual([(o.start.iso(), o.day.iso()) for o in occ], [("2026-02-02T08:00", "2026-05-31")])

    def test_rule_13_timeline_order(self):
        a = schedule(id="a", duration=60)
        b = schedule(id="b")
        c = schedule(id="c", time="08:00")
        late = schedule(id="0-late", start="2026-01-04", time="23:00", duration=720)
        occ = expand_all([a, b, c, late], window("2026-01-05T00:00", "2026-01-06T00:00"), CAL)
        self.assertEqual([o.schedule_id for o in occ], ["0-late", "c", "a", "b", "0-late"])

    def test_rule_13_moves_are_placed_by_their_new_time(self):
        s = schedule(moves={"2026-01-07": "2026-01-06T08:00"})
        occ = expand(s, window("2026-01-05T00:00", "2026-01-09T00:00"), CAL)
        self.assertEqual(starts(occ), ["2026-01-05T09:00", "2026-01-06T08:00", "2026-01-06T09:00", "2026-01-08T09:00"])

    def test_rule_14_occurrence_fields(self):
        (occ,) = expand(schedule(id="sync", time="17:45", duration=30), window("2026-01-05T00:00", "2026-01-06T00:00"), CAL)
        self.assertEqual(occ.schedule_id, "sync")
        self.assertEqual(occ.day, Day(2026, 1, 5))
        self.assertEqual(occ.span.start.iso(), "2026-01-05T17:45")
        self.assertEqual(occ.span.end.iso(), "2026-01-05T18:15")
        self.assertIs(occ.moved, False)


if __name__ == "__main__":
    unittest.main()
