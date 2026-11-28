import os
import unittest

from helpers import EXAMPLES, statement

from accesspolicy import PolicyError, load_policy, load_policy_file


class LoaderTest(unittest.TestCase):
    def test_version_is_required(self):
        with self.assertRaises(PolicyError):
            load_policy({})
        with self.assertRaises(PolicyError):
            load_policy({"version": 2})

    def test_minimal_document(self):
        policy = load_policy({"version": 1})
        self.assertEqual(policy.statements, [])
        self.assertEqual(policy.max_delegation_depth, 2)

    def test_statement_needs_a_binding(self):
        with self.assertRaises(PolicyError):
            load_policy({"version": 1, "statements": [statement("s1", roles=[])]})

    def test_statement_effect(self):
        with self.assertRaises(PolicyError):
            load_policy({"version": 1, "statements": [statement("s1", effect="permit")]})

    def test_examples_load(self):
        for name in sorted(os.listdir(EXAMPLES)):
            if name.endswith(".json"):
                with self.subTest(name=name):
                    load_policy_file(os.path.join(EXAMPLES, name))


if __name__ == "__main__":
    unittest.main()
