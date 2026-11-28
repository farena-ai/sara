"""Measurement helpers for the hidden tests: the definitions of docs/PERFORMANCE.md, and a copy of the
records generator of tools/gen.py (so the data does not depend on the project's copy)."""

import csv
import math
import os
import random
import sys
import tracemalloc

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKAGE = os.path.join(ROOT, "tally") + os.sep
FIELDS = ("order", "day", "region", "store", "product", "category", "customer", "qty", "price")
COUNTED_FIELDS = ("order", "day", "region", "store", "product", "category", "customer")
MEMORY_BOUND = 10 * 1024 * 1024


def records(n, seed=1, regions=4, stores=20, products=50, categories=8, customers=2000, unique_customers=False):
    """Yields n records (dicts of strings), one at a time."""
    rnd = random.Random(seed)
    for i in range(n):
        cents = rnd.randint(1, 50000)
        yield {
            "order": f"o{i + 1}",
            "day": f"2026-{1 + rnd.randrange(12):02d}-{1 + rnd.randrange(28):02d}",
            "region": f"r{rnd.randrange(regions)}",
            "store": f"s{rnd.randrange(stores)}",
            "product": f"p{rnd.randrange(products)}",
            "category": f"c{rnd.randrange(categories)}",
            "customer": f"u{i}" if unique_customers else f"u{rnd.randrange(customers)}",
            "qty": str(rnd.randint(-2, 12)),
            "price": f"{cents // 100}.{cents % 100:02d}",
        }


def write_csv(path, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(FIELDS)
        for r in rows:
            w.writerow([r[name] for name in FIELDS])



class BoundExceeded(Exception):
    pass


class Counted(str):
    comparisons = 0
    limit = None

    @classmethod
    def _count(cls):
        cls.comparisons += 1
        if cls.limit is not None and cls.comparisons > cls.limit:
            raise BoundExceeded(f"more than {cls.limit} comparisons")

    def __eq__(self, other):
        Counted._count()
        return str.__eq__(self, other)

    def __ne__(self, other):
        Counted._count()
        return str.__ne__(self, other)

    def __lt__(self, other):
        Counted._count()
        return str.__lt__(self, other)

    def __le__(self, other):
        Counted._count()
        return str.__le__(self, other)

    def __gt__(self, other):
        Counted._count()
        return str.__gt__(self, other)

    def __ge__(self, other):
        Counted._count()
        return str.__ge__(self, other)

    __hash__ = str.__hash__


def counted(rows):
    for r in rows:
        yield {k: Counted(v) if k in COUNTED_FIELDS else v for k, v in r.items()}


def line_bound(n, g):
    return 150 * n + 300 * g + 50_000


def comparison_bound(n, g):
    return 20 * n + 6 * g * math.ceil(math.log2(g + 2)) + 10_000


def count_groups(rows, spec):
    keys = set()
    for r in rows:
        if _kept(r, spec.where):
            keys.add(tuple(r[name] for name in spec.group_by))
    return len(keys | set(spec.groups))


def _kept(r, where):
    if "day_from" in where and r["day"] < where["day_from"]:
        return False
    if "day_to" in where and r["day"] > where["day_to"]:
        return False
    return all(r[k] in v for k, v in where.items() if k not in ("day_from", "day_to"))


def count_lines(fn, limit):
    """Lines of tally's code run by fn(), or None when more than limit."""
    state = {"lines": 0}

    def local(frame, event, arg):
        if event == "line":
            state["lines"] += 1
            if state["lines"] > limit:
                raise BoundExceeded(f"more than {limit} lines")
        return local

    def global_(frame, event, arg):
        return local if frame.f_code.co_filename.startswith(PACKAGE) else None

    sys.settrace(global_)
    try:
        fn()
    except BoundExceeded:
        return None
    finally:
        sys.settrace(None)
    return state["lines"]


def count_comparisons(fn, limit, line_limit):
    """Comparisons of Counted values made by fn(), or None when more than limit. The run is also stopped
    (None) past line_limit lines, so that a run far over the line bound does not take forever."""
    Counted.comparisons = 0
    Counted.limit = limit
    try:
        if count_lines(fn, line_limit) is None:
            return None
    except BoundExceeded:
        return None
    finally:
        Counted.limit = None
    return Counted.comparisons


def watched(rows, every=1000):
    for i, r in enumerate(rows, start=1):
        if i % every == 0 and tracemalloc.get_traced_memory()[0] > MEMORY_BOUND:
            raise BoundExceeded(f"over {MEMORY_BOUND} bytes after {i} records")
        yield r


def peak_memory(fn):
    """Peak traced memory of fn(), or None when the run went over the bound."""
    tracemalloc.start()
    try:
        fn()
        return tracemalloc.get_traced_memory()[1]
    except BoundExceeded:
        return None
    finally:
        tracemalloc.stop()
