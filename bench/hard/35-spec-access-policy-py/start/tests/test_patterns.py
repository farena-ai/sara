import unittest

from accesspolicy import PolicyError
from accesspolicy.paths import split_path
from accesspolicy.patterns import ResourcePattern


def match(pattern, path, principal="alice"):
    return ResourcePattern(pattern).matches(split_path(path), principal)


class PatternsTest(unittest.TestCase):
    def test_literal(self):
        self.assertTrue(match("/docs/a", "/docs/a"))
        self.assertFalse(match("/docs/a", "/docs/b"))
        self.assertFalse(match("/docs/a", "/docs/A"))

    def test_trailing_slash_is_ignored(self):
        self.assertTrue(match("/docs/a", "/docs/a/"))
        self.assertTrue(match("/docs/a/", "/docs//a"))

    def test_single_wildcard(self):
        self.assertTrue(match("/docs/*", "/docs/a"))
        self.assertFalse(match("/docs/*", "/docs/a/b"))

    def test_double_wildcard_deeper(self):
        self.assertTrue(match("/docs/**", "/docs/a/b/c"))
        self.assertFalse(match("/docs/**", "/mail/a"))

    def test_double_wildcard_must_be_last(self):
        with self.assertRaises(PolicyError):
            ResourcePattern("/docs/**/a")

    def test_literal_beats_wildcard(self):
        self.assertGreater(ResourcePattern("/docs/a").specificity, ResourcePattern("/docs/*").specificity)
        self.assertGreater(ResourcePattern("/docs/*").specificity, ResourcePattern("/docs/**").specificity)


if __name__ == "__main__":
    unittest.main()
