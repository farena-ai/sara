import unittest

from tally import SpecError, parse_spec


class Specs(unittest.TestCase):
    def test_defaults(self):
        s = parse_spec({"group_by": ["region"]})
        self.assertEqual(s.metrics[0], "count")
        self.assertEqual((s.order, s.format, s.top_products, s.limit), ("key", "text", 0, None))

    def test_refused(self):
        for data, message in [
            ({}, "group_by is required"),
            ({"group_by": ["qty"]}, "cannot group by 'qty'"),
            ({"group_by": ["region"], "metrics": ["mean"]}, "unknown metric 'mean'"),
            ({"group_by": ["region"], "order": "size"}, "order must be one of"),
            ({"group_by": ["region"], "limit": 0}, "limit must be"),
            ({"group_by": ["region"], "groups": [["a", "b"]]}, "needs 1 values"),
            ({"group_by": ["region"], "colour": "red"}, "unknown setting 'colour'"),
        ]:
            with self.subTest(data=data):
                with self.assertRaisesRegex(SpecError, message):
                    parse_spec(data)


if __name__ == "__main__":
    unittest.main()
