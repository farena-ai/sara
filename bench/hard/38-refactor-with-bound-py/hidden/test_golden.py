"""Byte-for-byte reports (docs/CONTRACT.md). Each golden case is the output of tally 2.3 on that input; a
test's name says which rule of the contract the case is about."""

import hashlib
import io
import os
import shutil
import tempfile
import unittest

import hlib
from tally import build_report, parse_spec
from tally.cli import main

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "golden")


def read(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


class Golden(unittest.TestCase):
    def check_case(self, name):
        src = os.path.join(GOLDEN, name)
        tmp = tempfile.mkdtemp(prefix="tally-hidden-")
        cwd = os.getcwd()
        try:
            for f in os.listdir(src):
                shutil.copy(os.path.join(src, f), tmp)
            data = "data.jsonl" if os.path.exists(os.path.join(tmp, "data.jsonl")) else "data.csv"
            os.chdir(tmp)
            out, err = io.StringIO(), io.StringIO()
            code = main(["report", data, "--spec", "spec.json"], out, err)
        finally:
            os.chdir(cwd)
            shutil.rmtree(tmp, ignore_errors=True)
        self.assertEqual(err.getvalue(), read(os.path.join(src, "expected.err")))
        self.assertEqual(out.getvalue(), read(os.path.join(src, "expected.out")))
        self.assertEqual(code, int(read(os.path.join(src, "expected.code"))))


def _add(name):
    setattr(Golden, f"test_contract_{name}", lambda self: self.check_case(name))


for _name in sorted(os.listdir(GOLDEN)):
    _add(_name)


# Larger reports, compared by SHA-256 of the tally 2.3 output: (records, seed, generator options, spec, sha256, length)
LARGER = {
    "few_big_groups": (3000, 11, {"regions": 4}, {"group_by": ["region"], "top_products": 3, "order": "revenue"}, "0e713fe02a1f8992253daa399ad6b6d25d3f592e8882f2eacafc0ae4b8db2d5d", 864),
    "many_small_groups_csv": (3000, 12, {"customers": 800}, {"group_by": ["customer"], "top_products": 2, "order": "key", "format": "csv"}, "fa008a17a0f1d33d385c834bcbff23fd8a6c6eb842eca4c666da1486410e4442", 50865),
    "unique_customers_markdown_listed_filtered": (3000, 13, {"unique_customers": True, "products": 300}, {"group_by": ["region", "category"], "top_products": 5, "order": "revenue", "format": "markdown", "groups": [["r9", "c9"]], "where": {"day_from": "2026-02-01"}}, "3ad4bced36cdedd578d635f89e177840c753a6ce6691a30bf1e578d0226a2196", 5012),
    "by_day_json_limit": (3000, 14, {"regions": 6}, {"group_by": ["day"], "order": "revenue", "limit": 25, "format": "json", "top_products": 1}, "a14978de3743f50472efb64718a8cda1685d048f7ba5cfc047bf5bf18e1948f4", 7202),
}


class Larger(unittest.TestCase):
    pass


def _add_larger(name, case):
    n, seed, opts, spec, digest, length = case

    def test(self):
        out = build_report(hlib.records(n, seed, **opts), parse_spec(spec))
        self.assertEqual(len(out), length)
        self.assertEqual(hashlib.sha256(out.encode("utf-8")).hexdigest(), digest)

    setattr(Larger, f"test_contract_unchanged_output_{name}", test)


for _name, _case in LARGER.items():
    _add_larger(_name, _case)


if __name__ == "__main__":
    unittest.main()
