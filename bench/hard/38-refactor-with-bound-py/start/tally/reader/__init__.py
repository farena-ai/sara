"""Input files. read_records(path) picks the reader from the extension (.csv or .jsonl)."""

from ..errors import RecordError
from .csv_reader import read_csv
from .jsonl_reader import read_jsonl


def read_records(path):
    name = str(path).lower()
    if name.endswith(".csv"):
        return read_csv(path)
    if name.endswith(".jsonl"):
        return read_jsonl(path)
    raise RecordError(f"{path}: unknown file type (use .csv or .jsonl)")


__all__ = ["read_csv", "read_jsonl", "read_records"]
