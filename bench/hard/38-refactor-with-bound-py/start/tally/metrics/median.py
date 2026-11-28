"""Median of the qty values (whole numbers): the middle one, or the mean of the two middle ones."""

from decimal import Decimal

from ..sorting import insertion_sort


def median_qty(rows):
    values = insertion_sort([row.qty for row in rows])
    n = len(values)
    if n == 0:
        return None
    if n % 2 == 1:
        return Decimal(values[n // 2])
    return Decimal(values[n // 2 - 1] + values[n // 2]) / 2
