import unittest

from helpers import evaluator, statement


class AuditTest(unittest.TestCase):
    def test_one_line_per_decision(self):
        ev, sink = evaluator([statement("s1")])
        ev.evaluate("alice", "docs:read", "/docs/a")
        ev.evaluate("alice", "docs:read", "/mail/a")
        self.assertEqual(len(sink.lines), 2)

    def test_record_is_on_the_decision(self):
        ev, sink = evaluator([statement("s1")])
        d = ev.evaluate("alice", "docs:read", "/docs/a")
        self.assertEqual(d.record, sink.lines[-1])

    def test_record_start(self):
        ev, sink = evaluator([statement("s1")])
        ev.evaluate("alice", "docs:read", "/docs/a")
        self.assertTrue(sink.lines[-1].startswith(
            "2026-11-23T10:00:00Z ALLOW principal=alice action=docs:read resource=/docs/a reason=allow statement=s1"))


if __name__ == "__main__":
    unittest.main()
