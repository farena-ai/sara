import os
import unittest

from tally import build_report, load_spec, parse_spec, report_file

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def expected(name):
    with open(os.path.join(HERE, "expected", name), encoding="utf-8", newline="") as f:
        return f.read()


def rec(region, product, qty, price, customer="c1", day="2026-03-01", **more):
    r = {"order": "o", "day": day, "region": region, "store": "s1", "product": product, "category": "k", "customer": customer, "qty": str(qty), "price": price}
    r.update(more)
    return r


class ExampleReports(unittest.TestCase):
    def test_by_region_text(self):
        spec = load_spec(os.path.join(ROOT, "examples", "by_region.json"))
        self.assertEqual(report_file(os.path.join(ROOT, "examples", "sales.csv"), spec), expected("by_region.txt"))

    def test_by_customer_csv_and_json(self):
        spec = load_spec(os.path.join(ROOT, "examples", "by_customer.json"))
        for fmt, name in (("csv", "by_customer.csv"), ("json", "by_customer.json")):
            spec.format = fmt
            self.assertEqual(report_file(os.path.join(ROOT, "examples", "sales.csv"), spec), expected(name))


class Basics(unittest.TestCase):
    def test_sums_and_total(self):
        records = [rec("north", "mug", 2, "3.50"), rec("south", "mug", 1, "3.50", customer="c2"), rec("north", "tray", 1, "10")]
        out = build_report(records, parse_spec({"group_by": ["region"], "metrics": ["count", "units", "revenue", "customers"]}))
        self.assertEqual(
            out,
            "region  count  units  revenue  customers\n"
            "------  -----  -----  -------  ---------\n"
            "north       2      3    17.00          1\n"
            "south       1      1     3.50          1\n"
            "TOTAL       3      4    20.50          2\n",
        )

    def test_records_may_come_from_a_generator(self):
        def gen():
            yield rec("a", "x", 1, "1")
            yield rec("b", "x", 2, "1")

        out = build_report(gen(), parse_spec({"group_by": ["region"], "metrics": ["units"], "format": "csv"}))
        self.assertEqual(out, "region,units\na,1\nb,2\nTOTAL,3\n")

    def test_listed_group_without_records(self):
        out = build_report([rec("a", "x", 1, "2")], parse_spec({"group_by": ["region"], "metrics": ["count", "avg_price", "median_qty"], "groups": [["z"]], "format": "csv"}))
        self.assertEqual(out, "region,count,avg_price,median_qty\na,1,2.00,1\nz,0,-,-\nTOTAL,1,2.00,1\n")

    def test_bad_record(self):
        from tally import RecordError

        with self.assertRaisesRegex(RecordError, r"^record 2: bad qty 'two'$"):
            build_report([rec("a", "x", 1, "2"), rec("a", "x", "two", "2")], parse_spec({"group_by": ["region"]}))


if __name__ == "__main__":
    unittest.main()
