"""The bounds of docs/PERFORMANCE.md, measured the way it defines them (counted lines, counted comparisons,
traced memory; no clocks). The cases use another seed than tools/measure.py: the bounds hold for every seed."""

import os
import shutil
import tempfile
import unittest

import hlib
from tally import build_report, parse_spec
from tally.reader import read_records

SEED = 7
P1 = (20_000, {"regions": 4}, {"group_by": ["region"], "top_products": 3, "order": "revenue"})
P2 = (20_000, {"customers": 5000}, {"group_by": ["customer"], "top_products": 2, "order": "key"})
P3 = (20_000, {"unique_customers": True, "products": 2000}, {"group_by": ["region", "category"], "top_products": 5, "order": "revenue"})


class Work(unittest.TestCase):
    def lines(self, case, **spec_changes):
        n, opts, spec_data = case
        spec = parse_spec({**spec_data, **spec_changes})
        g = hlib.count_groups(hlib.records(n, SEED, **opts), spec)
        bound = hlib.line_bound(n, g)
        used = hlib.count_lines(lambda: build_report(hlib.records(n, SEED, **opts), spec), bound)
        self.assertIsNotNone(used, f"more than {bound} lines (n={n}, g={g})")

    def comparisons(self, case, **spec_changes):
        n, opts, spec_data = case
        spec = parse_spec({**spec_data, **spec_changes})
        g = hlib.count_groups(hlib.records(n, SEED, **opts), spec)
        bound = hlib.comparison_bound(n, g)
        used = hlib.count_comparisons(lambda: build_report(hlib.counted(hlib.records(n, SEED, **opts)), spec), bound, hlib.line_bound(n, g))
        self.assertIsNotNone(used, f"more than {bound} comparisons, or more than the line bound (n={n}, g={g})")
        self.assertGreater(used, n, "field values must be used as given (docs/PERFORMANCE.md, Comparisons)")

    def test_performance_P1_lines_few_big_groups(self):
        self.lines(P1)

    def test_performance_P1_comparisons_few_big_groups(self):
        self.comparisons(P1)

    def test_performance_P2_lines_many_small_groups(self):
        self.lines(P2)

    def test_performance_P2_comparisons_many_small_groups(self):
        self.comparisons(P2)

    def test_performance_P3_lines_every_customer_new(self):
        self.lines(P3)

    def test_performance_P3_comparisons_every_customer_new(self):
        self.comparisons(P3)

    def test_performance_bounds_hold_for_other_formats_P2_markdown_and_json(self):
        self.lines(P2, format="markdown")
        self.lines(P2, format="json")

    def test_performance_bounds_hold_with_filters_and_listed_groups_P3(self):
        changes = {"where": {"day_from": "2026-03-01", "category": ["c1", "c2", "c3"]}, "groups": [["r0", "c0"], ["r9", "c9"]]}
        self.comparisons(P3, **changes)
        self.lines(P3, **changes)


class Memory(unittest.TestCase):
    def test_performance_M1_memory_from_a_generator(self):
        spec = parse_spec({"group_by": ["region"], "top_products": 3, "order": "revenue"})
        peak = hlib.peak_memory(lambda: build_report(hlib.watched(hlib.records(50_000, SEED, regions=4)), spec))
        self.assertIsNotNone(peak, "over 10 MiB while building the report")
        self.assertLessEqual(peak, hlib.MEMORY_BOUND)

    def test_performance_M2_memory_reading_a_csv_file(self):
        tmp = tempfile.mkdtemp(prefix="tally-hidden-")
        try:
            path = os.path.join(tmp, "sales.csv")
            hlib.write_csv(path, hlib.records(50_000, SEED, regions=4))
            spec = parse_spec({"group_by": ["region", "category"], "top_products": 3})
            peak = hlib.peak_memory(lambda: build_report(hlib.watched(read_records(path)), spec))
            self.assertIsNotNone(peak, "over 10 MiB while reading the file and building the report")
            self.assertLessEqual(peak, hlib.MEMORY_BOUND)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_performance_M2_memory_reading_a_jsonl_file(self):
        import json

        tmp = tempfile.mkdtemp(prefix="tally-hidden-")
        try:
            path = os.path.join(tmp, "sales.jsonl")
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                for r in hlib.records(50_000, SEED, regions=4):
                    f.write(json.dumps(r) + "\n")
            spec = parse_spec({"group_by": ["region"], "top_products": 3})
            peak = hlib.peak_memory(lambda: build_report(hlib.watched(read_records(path)), spec))
            self.assertIsNotNone(peak, "over 10 MiB while reading the file and building the report")
            self.assertLessEqual(peak, hlib.MEMORY_BOUND)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_contract_records_are_read_once_from_a_one_shot_iterator(self):
        rows = list(hlib.records(50, SEED))
        it = iter(rows)
        out = build_report(it, parse_spec({"group_by": ["region"], "format": "csv", "metrics": ["count"]}))
        self.assertEqual(out.splitlines()[-1], "TOTAL,50")
        self.assertEqual(list(it), [])


if __name__ == "__main__":
    unittest.main()
