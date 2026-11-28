import unittest

from helpers import evaluator, statement

from accesspolicy import PolicyError, load_policy


class ConditionsTest(unittest.TestCase):
    def test_principal_attribute(self):
        ev, _ = evaluator(
            [statement("s1", conditions={"attributes": {"principal.dept": "eng"}})],
            principals={"alice": {"roles": ["reader"], "attributes": {"dept": "eng"}},
                        "bob": {"roles": ["reader"], "attributes": {"dept": "ops"}}},
        )
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/a").allowed)
        self.assertFalse(ev.evaluate("bob", "docs:read", "/docs/a").allowed)

    def test_context_attribute(self):
        ev, _ = evaluator([statement("s1", conditions={"attributes": {"context.site": "hq"}})])
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/a", {"site": "hq"}).allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/docs/a", {"site": "home"}).allowed)

    def test_missing_attribute_on_allow(self):
        ev, _ = evaluator([statement("s1", conditions={"attributes": {"context.site": "hq"}})])
        self.assertFalse(ev.evaluate("alice", "docs:read", "/docs/a").allowed)

    def test_bad_key(self):
        with self.assertRaises(PolicyError):
            load_policy({"version": 1, "statements": [statement("s1", conditions={"attributes": {"site": "hq"}})]})


if __name__ == "__main__":
    unittest.main()
