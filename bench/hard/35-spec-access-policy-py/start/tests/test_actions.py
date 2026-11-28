import unittest

from accesspolicy import PolicyError
from accesspolicy.actions import parse_action_pattern


class ActionsTest(unittest.TestCase):
    def test_exact(self):
        p = parse_action_pattern("docs:read")
        self.assertTrue(p.matches("docs:read"))
        self.assertFalse(p.matches("docs:write"))
        self.assertEqual(p.specificity, 2)

    def test_service_wildcard(self):
        p = parse_action_pattern("docs:*")
        self.assertTrue(p.matches("docs:write"))
        self.assertFalse(p.matches("mail:send"))
        self.assertEqual(p.specificity, 1)

    def test_any(self):
        p = parse_action_pattern("*")
        self.assertTrue(p.matches("mail:send"))
        self.assertEqual(p.specificity, 0)

    def test_upper_case_pattern(self):
        self.assertTrue(parse_action_pattern("Docs:Read").matches("docs:read"))

    def test_bad_patterns(self):
        for bad in ["docs", "docs:re*", "*:read"]:
            with self.assertRaises(PolicyError):
                parse_action_pattern(bad)


if __name__ == "__main__":
    unittest.main()
