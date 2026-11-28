import unittest

from helpers import evaluator, statement

from accesspolicy import utc

OFFICE_HOURS = [{"days": ["mon", "tue", "wed", "thu", "fri"], "start": "09:00", "end": "17:00"}]


def allowed_at(now):
    ev, _ = evaluator([statement("s1", conditions={"time": OFFICE_HOURS})], now=now)
    return ev.evaluate("alice", "docs:read", "/docs/a").allowed


class WindowsTest(unittest.TestCase):
    def test_inside(self):
        self.assertTrue(allowed_at(utc(2026, 11, 23, 12, 0)))

    def test_start_is_inside(self):
        self.assertTrue(allowed_at(utc(2026, 11, 23, 9, 0)))

    def test_before_start(self):
        self.assertFalse(allowed_at(utc(2026, 11, 23, 8, 59, 59)))

    def test_weekend(self):
        self.assertFalse(allowed_at(utc(2026, 11, 28, 12, 0)))


if __name__ == "__main__":
    unittest.main()
