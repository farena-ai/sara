"""Measures the engine the way docs/PERFORMANCE.md defines it, on the cases listed there.

    python tools/measure.py            all cases
    python tools/measure.py P2 M1      some of them

Nothing here uses a clock: the work is counted (lines of tally's code run, comparisons between field values)
and memory is the peak traced by tracemalloc. A measurement stops as soon as a bound is passed.
"""

import math
import os
import sys
import tempfile
import tracemalloc

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import gen  # noqa: E402
from tally import build_report, parse_spec  # noqa: E402
from tally.reader import read_records  # noqa: E402

PACKAGE = os.path.join(ROOT, "tally") + os.sep
COUNTED_FIELDS = ("order", "day", "region", "store", "product", "category", "customer")


class BoundExceeded(Exception):
    pass


class Counted(str):
    """A str that counts how often it is compared (==, !=, <, <=, >, >=) with anything."""

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


def counted(records):
    for r in records:
        yield {k: Counted(v) if k in COUNTED_FIELDS else v for k, v in r.items()}


def count_lines(fn, limit):
    """Runs fn() and returns how many lines of tally's own code ran (a "line" event of sys.settrace)."""
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
    finally:
        sys.settrace(None)
    return state["lines"]


def peak_memory(fn):
    tracemalloc.start()
    try:
        fn()
        return tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()


def line_bound(n, g):
    return 150 * n + 300 * g + 50_000


def comparison_bound(n, g):
    return 20 * n + 6 * g * math.ceil(math.log2(g + 2)) + 10_000


MEMORY_BOUND = 10 * 1024 * 1024

WORK = {
    "P1": (20_000, {"regions": 4}, {"group_by": ["region"], "top_products": 3, "order": "revenue"}),
    "P2": (20_000, {"customers": 5000}, {"group_by": ["customer"], "top_products": 2, "order": "key"}),
    "P3": (20_000, {"unique_customers": True, "products": 2000}, {"group_by": ["region", "category"], "top_products": 5, "order": "revenue"}),
}
MEMORY = {
    "M1": (50_000, {"regions": 4}, {"group_by": ["region"], "top_products": 3, "order": "revenue"}, "api"),
    "M2": (50_000, {"regions": 4}, {"group_by": ["region", "category"], "top_products": 3}, "csv"),
}


def count_groups(records, spec):
    return len({tuple(r[name] for name in spec.group_by) for r in records} | set(spec.groups))


def watched(records, every=1000):
    """Passes records on, stopping the run when the memory traced so far is over the bound."""
    for i, r in enumerate(records, start=1):
        if i % every == 0 and tracemalloc.get_traced_memory()[0] > MEMORY_BOUND:
            raise BoundExceeded(f"over {MEMORY_BOUND} bytes after {i} records")
        yield r


def run_work(name, seed=1):
    n, opts, spec_data = WORK[name]
    spec = parse_spec(spec_data)
    g = count_groups(gen.records(n, seed, **opts), spec)
    out = {}
    Counted.comparisons = 0
    Counted.limit = comparison_bound(n, g)
    first = None
    try:
        first = build_report(counted(gen.records(n, seed, **opts)), spec)
        out["comparisons"] = (Counted.comparisons, Counted.limit)
    except BoundExceeded:
        out["comparisons"] = (None, Counted.limit)
    finally:
        Counted.limit = None
    limit = line_bound(n, g)
    result = {}
    try:
        lines = count_lines(lambda: result.setdefault("report", build_report(gen.records(n, seed, **opts), spec)), limit)
        out["lines"] = (lines, limit)
    except BoundExceeded:
        out["lines"] = (None, limit)
    same = None if first is None or "report" not in result else first == result["report"]
    return n, g, out, same


def run_memory(name, seed=1):
    """The peak traced memory, or None when the run went over the bound."""
    n, opts, spec_data, how = MEMORY[name]
    spec = parse_spec(spec_data)
    with tempfile.TemporaryDirectory() as tmp:
        if how == "api":
            source = lambda: gen.records(n, seed, **opts)  # noqa: E731
        else:
            path = os.path.join(tmp, "sales.csv")
            gen.write_csv(path, gen.records(n, seed, **opts))
            source = lambda: read_records(path)  # noqa: E731
        try:
            return peak_memory(lambda: build_report(watched(source()), spec))
        except BoundExceeded:
            return None


def main(argv):
    names = argv or list(WORK) + list(MEMORY)
    ok = True
    for name in names:
        if name in WORK:
            n, g, out, same = run_work(name)
            for what, (value, limit) in out.items():
                good = value is not None
                ok &= good
                shown = f"over {limit}" if value is None else f"{value} of {limit}"
                print(f"{name} {what:12} n={n} g={g}: {shown} {'ok' if good else 'TOO MUCH'}")
            if same is False:
                ok = False
                print(f"{name}: the counted run and the traced run gave different reports!")
        elif name in MEMORY:
            peak = run_memory(name)
            good = peak is not None and peak <= MEMORY_BOUND
            ok &= good
            shown = f"over {MEMORY_BOUND}" if peak is None else f"{peak} bytes of {MEMORY_BOUND}"
            print(f"{name} peak memory: {shown} {'ok' if good else 'TOO MUCH'}")
        else:
            print(f"unknown case {name}")
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
