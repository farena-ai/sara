"""Count, units and revenue of a list of rows."""

from decimal import Decimal


def count(rows):
    return len(rows)


def units(rows):
    total = 0
    for row in rows:
        total += row.qty
    return total


def revenue(rows):
    total = Decimal(0)
    for row in rows:
        total += row.revenue
    return total
