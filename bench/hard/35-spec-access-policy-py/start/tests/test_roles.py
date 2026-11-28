import unittest

from helpers import evaluator, statement


class RolesTest(unittest.TestCase):
    def test_direct_role(self):
        ev, _ = evaluator([statement("s1")])
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/a").allowed)

    def test_inherited_role(self):
        ev, _ = evaluator(
            [statement("s1", roles=["reader"])],
            principals={"alice": {"roles": ["editor"]}},
            roles={"editor": {"inherits": ["author"]}, "author": {"inherits": ["reader"]}},
        )
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/a").allowed)

    def test_role_not_held(self):
        ev, _ = evaluator([statement("s1", roles=["admin"])])
        self.assertFalse(ev.evaluate("alice", "docs:read", "/docs/a").allowed)

    def test_cycle_is_allowed(self):
        ev, _ = evaluator(
            [statement("s1", roles=["b"])],
            principals={"alice": {"roles": ["a"]}},
            roles={"a": {"inherits": ["b"]}, "b": {"inherits": ["a"]}},
        )
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/a").allowed)

    def test_principal_named_in_statement(self):
        ev, _ = evaluator([statement("s1", roles=[], principals=["bob"])])
        self.assertTrue(ev.evaluate("bob", "docs:read", "/docs/a").allowed)


if __name__ == "__main__":
    unittest.main()
