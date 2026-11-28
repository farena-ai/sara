import io
import os
import unittest

from helpers import EXAMPLES

from accesspolicy.cli import main


def run(*argv):
    out = io.StringIO()
    code = main(list(argv), out)
    return code, out.getvalue()


class CliTest(unittest.TestCase):
    def test_lint(self):
        code, text = run("lint", os.path.join(EXAMPLES, "office.json"))
        self.assertEqual(code, 0)
        self.assertTrue(text.startswith("ok: 7 statements"))

    def test_check_allow(self):
        code, text = run("check", os.path.join(EXAMPLES, "office.json"), "ben", "wiki:read",
                         "/wiki/eng/plan", "--at", "2026-11-23T10:00:00Z")
        self.assertEqual(code, 0)
        self.assertIn(" ALLOW principal=ben ", text)

    def test_check_deny(self):
        code, text = run("check", os.path.join(EXAMPLES, "office.json"), "ben", "mail:send",
                         "/mail", "--at", "2026-11-23T10:00:00Z")
        self.assertEqual(code, 1)
        self.assertIn(" reason=no-match ", text)

    def test_missing_file(self):
        code, text = run("lint", os.path.join(EXAMPLES, "nope.json"))
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
