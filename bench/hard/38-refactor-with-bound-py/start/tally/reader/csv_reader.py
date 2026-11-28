"""Reads a sales CSV file: a header naming the nine fields (any order), then one record per row."""

import csv
import io

from ..errors import RecordError
from ..fields import FIELDS


def read_csv(path):
    """Returns the file's records, as dicts of strings."""
    with open(path, encoding="utf-8-sig", newline="") as f:
        text = f.read()
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        raise RecordError(f"{path}: empty file (a header is needed)")
    header = rows[0]
    missing = [name for name in FIELDS if name not in header]
    if missing:
        raise RecordError(f"{path}: header lacks {', '.join(missing)}")
    if len(set(header)) != len(header):
        raise RecordError(f"{path}: header names a column twice")
    records = []
    for number, row in enumerate(rows[1:], start=2):
        if not row:
            continue
        if len(row) != len(header):
            raise RecordError(f"{path}: line {number}: expected {len(header)} fields, got {len(row)}")
        records.append(dict(zip(header, row)))
    return records
