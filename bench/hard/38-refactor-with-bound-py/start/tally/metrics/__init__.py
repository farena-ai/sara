"""Everything a report shows about one group (or about all rows, for the TOTAL line)."""

from dataclasses import dataclass, field
from decimal import Decimal

from .basic import count, revenue, units
from .customers import distinct_customers
from .median import median_qty
from .top import top_products


@dataclass
class GroupStats:
    key: tuple
    position: int
    count: int = 0
    units: int = 0
    revenue: Decimal = Decimal(0)
    customers: int = 0
    median_qty: object = None
    top: list = field(default_factory=list)
    rank: int = 0


def compute(key, position, rows, spec):
    return GroupStats(
        key=key,
        position=position,
        count=count(rows),
        units=units(rows),
        revenue=revenue(rows),
        customers=distinct_customers(rows),
        median_qty=median_qty(rows),
        top=top_products(rows, spec.top_products) if spec.top_products else [],
    )


__all__ = ["GroupStats", "compute"]
