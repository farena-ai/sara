import os
import shutil
import tempfile
import unittest

from tally import RecordError
from tally.reader import read_records


class Readers(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="tally-test-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, name, text):
        path = os.path.join(self.tmp, name)
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        return path

    def test_csv_columns_in_any_order(self):
        path = self.write("a.csv", "﻿price,qty,customer,category,product,store,region,day,order\n1.50,2,u,c,p,s,n,2026-01-02,A\n\n")
        records = list(read_records(path))
        self.assertEqual(records, [{"price": "1.50", "qty": "2", "customer": "u", "category": "c", "product": "p", "store": "s", "region": "n", "day": "2026-01-02", "order": "A"}])

    def test_csv_header_must_name_every_field(self):
        path = self.write("b.csv", "order,day,region\n")
        with self.assertRaisesRegex(RecordError, "header lacks store, product"):
            list(read_records(path))

    def test_jsonl_numbers_become_text(self):
        path = self.write("c.jsonl", '{"qty": 3, "price": 4.5, "region": "n"}\n\n')
        self.assertEqual(list(read_records(path)), [{"qty": "3", "price": "4.5", "region": "n"}])

    def test_unknown_extension(self):
        with self.assertRaisesRegex(RecordError, "unknown file type"):
            read_records(os.path.join(self.tmp, "x.txt"))


if __name__ == "__main__":
    unittest.main()
