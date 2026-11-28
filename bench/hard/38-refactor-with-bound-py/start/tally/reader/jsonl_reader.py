"""Reads a JSON-lines file: one JSON object per line, blank lines skipped. Numbers become text ("3", "4.5")."""

import json

from ..errors import RecordError


def _text(value):
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        return str(value)
    return value


def read_jsonl(path):
    records = []
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    for number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            raise RecordError(f"{path}: line {number}: not valid JSON") from None
        if not isinstance(obj, dict):
            raise RecordError(f"{path}: line {number}: not a JSON object")
        records.append({k: _text(v) for k, v in obj.items()})
    return records
