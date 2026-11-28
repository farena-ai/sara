import unittest

from helpers import evaluator, statement


class EvaluatorTest(unittest.TestCase):
    def test_default_deny(self):
        ev, _ = evaluator([statement("s1", resources=["/docs/a"])])
        d = ev.evaluate("alice", "docs:read", "/docs/b")
        self.assertEqual((d.effect, d.reason, d.statement), ("DENY", "no-match", None))

    def test_allow(self):
        ev, _ = evaluator([statement("s1", grants={"rows": 10})])
        d = ev.evaluate("alice", "docs:read", "/docs/b")
        self.assertEqual((d.effect, d.reason, d.statement, d.grants), ("ALLOW", "allow", "s1", {"rows": 10}))

    def test_more_specific_allow_is_selected(self):
        ev, _ = evaluator([statement("wide"), statement("narrow", resources=["/docs/a"])])
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/a").statement, "narrow")
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/b").statement, "wide")

    def test_deny_beats_allow(self):
        ev, _ = evaluator([statement("read"), statement("block", "deny", resources=["/docs/**"])])
        d = ev.evaluate("alice", "docs:read", "/docs/a")
        self.assertEqual((d.effect, d.reason, d.statement), ("DENY", "explicit-deny", "block"))

    def test_deny_beats_a_more_specific_allow(self):
        ev, _ = evaluator([statement("exact", resources=["/docs/a"]), statement("block", "deny", resources=["/docs/*"])])
        d = ev.evaluate("alice", "docs:read", "/docs/a")
        self.assertEqual((d.effect, d.statement), ("DENY", "block"))

    def test_action_case_is_ignored(self):
        ev, _ = evaluator([statement("s1")])
        self.assertTrue(ev.evaluate("alice", "DOCS:READ", "/docs/a").allowed)


if __name__ == "__main__":
    unittest.main()
