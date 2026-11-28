"""The fields of a sales record and how each one is checked (docs/CONTRACT.md, "Input")."""

import re
from decimal import Decimal

from .errors import RecordError

FIELDS = ("order", "day", "region", "store", "product", "category", "customer", "qty", "price")
TEXT_FIELDS = ("order", "region", "store", "product", "category", "customer")
GROUPABLE = ("day", "region", "store", "product", "category", "customer")

_QTY = re.compile(r"-?\d+")
_PRICE = re.compile(r"\d+(\.\d{1,2})?")
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


def parse_qty(text, where):
    if not isinstance(text, str) or not _QTY.fullmatch(text):
        raise RecordError(f"{where}: bad qty {text!r}")
    return int(text)


def parse_price(text, where):
    if not isinstance(text, str) or not _PRICE.fullmatch(text):
        raise RecordError(f"{where}: bad price {text!r}")
    return Decimal(text)


def check_day(text, where):
    if not isinstance(text, str) or not _DAY.fullmatch(text):
        raise RecordError(f"{where}: bad day {text!r}")
    month, day = int(text[5:7]), int(text[8:10])
    if not (1 <= month <= 12 and 1 <= day <= 31):
        raise RecordError(f"{where}: bad day {text!r}")


def check_record(record, index):
    """Checks one record (index counts from 1) and returns its (qty, price)."""
    where = f"record {index}"
    for name in FIELDS:
        if name not in record:
            raise RecordError(f"{where}: missing field {name!r}")
    for name in TEXT_FIELDS:
        if not isinstance(record[name], str):
            raise RecordError(f"{where}: field {name!r} must be text")
    check_day(record["day"], where)
    return parse_qty(record["qty"], where), parse_price(record["price"], where)
