"""Reads a sales CSV file: a header naming the nine fields (any order), then one record per row."""

import csv

from ..errors import RecordError
from ..fields import FIELDS


def _check_structure(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if header is None:
            raise RecordError(f"{path}: empty file (a header is needed)")
        missing = [name for name in FIELDS if name not in header]
        if missing:
            raise RecordError(f"{path}: header lacks {', '.join(missing)}")
        if len(set(header)) != len(header):
            raise RecordError(f"{path}: header names a column twice")
        width = len(header)
        for number, row in enumerate(reader, start=2):
            if row and len(row) != width:
                raise RecordError(f"{path}: line {number}: expected {width} fields, got {len(row)}")
    return header


def _records(path, header):
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        next(reader)
        for row in reader:
            if row:
                yield dict(zip(header, row))


def read_csv(path):
    """The file's records, as dicts of strings, one at a time. The whole file is checked first."""
    header = _check_structure(path)
    return _records(path, header)
