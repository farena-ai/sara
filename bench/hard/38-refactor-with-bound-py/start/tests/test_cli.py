import io
import os
import shutil
import tempfile
import unittest

from tally.cli import main

HERE = os.path.dirname(os.path.abspath(__file__))
SALES = os.path.join(os.path.dirname(HERE), "examples", "sales.csv")


def run(*argv):
    out, err = io.StringIO(), io.StringIO()
    code = main(list(argv), out, err)
    return code, out.getvalue(), err.getvalue()


class Cli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="tally-test-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, name, text):
        path = os.path.join(self.tmp, name)
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        return path

    def test_check(self):
        self.assertEqual(run("check", SALES), (0, "ok: 40 records\n", ""))

    def test_format_and_limit_options(self):
        spec = self.write("s.json", '{"group_by": ["region"], "metrics": ["count"], "order": "revenue"}')
        code, out, _ = run("report", SALES, "--spec", spec, "--format", "csv", "--limit", "2")
        self.assertEqual(code, 0)
        self.assertEqual(out, "region,count\neast,8\nsouth,13\nTOTAL,40\n")

    def test_errors_exit_2(self):
        data = self.write("d.csv", "order,day,region,store,product,category,customer,qty,price\nA,2026-01-01,n,s,p,c,u,1\n")
        spec = self.write("s.json", '{"group_by": ["region"]}')
        code, out, err = run("report", data, "--spec", spec)
        self.assertEqual((code, out), (2, ""))
        self.assertEqual(err, f"error: {data}: line 2: expected 9 fields, got 8\n")


if __name__ == "__main__":
    unittest.main()
