"""Generates sales records for the measurements in docs/PERFORMANCE.md (deterministic for a seed).

    python tools/gen.py N OUT.csv [--seed S] [--regions R] [--customers C] [--unique-customers] [--products P]
"""

import argparse
import csv
import random
import sys

FIELDS = ("order", "day", "region", "store", "product", "category", "customer", "qty", "price")


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


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("n", type=int)
    p.add_argument("out")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--regions", type=int, default=4)
    p.add_argument("--customers", type=int, default=2000)
    p.add_argument("--products", type=int, default=50)
    p.add_argument("--unique-customers", action="store_true")
    a = p.parse_args(argv)
    write_csv(a.out, records(a.n, a.seed, regions=a.regions, products=a.products, customers=a.customers, unique_customers=a.unique_customers))
    return 0


if __name__ == "__main__":
    sys.exit(main())
