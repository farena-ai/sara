"""Running totals for one group, kept while the records stream past (nothing per record is kept)."""

import heapq
from decimal import Decimal

from .metrics import GroupStats


class Accumulator:
    __slots__ = ("key", "position", "count", "units", "revenue", "customers", "qty_counts", "products")

    def __init__(self, key, position):
        self.key = key
        self.position = position
        self.count = 0
        self.units = 0
        self.revenue = Decimal(0)
        self.customers = set()
        self.qty_counts = {}
        self.products = {}

    def add(self, qty, revenue, customer, product):
        self.count += 1
        self.units += qty
        self.revenue += revenue
        if customer != "":
            self.customers.add(customer)
        counts = self.qty_counts
        counts[qty] = counts.get(qty, 0) + 1
        products = self.products
        seen = products.get(product)
        products[product] = revenue if seen is None else seen + revenue

    def median(self):
        n = self.count
        if n == 0:
            return None
        lo_index = (n - 1) // 2
        hi_index = n // 2
        lo = hi = None
        seen = 0
        for value in sorted(self.qty_counts):
            seen += self.qty_counts[value]
            if lo is None and seen > lo_index:
                lo = value
            if seen > hi_index:
                hi = value
                break
        if n % 2 == 1:
            return Decimal(lo)
        return Decimal(lo + hi) / 2

    def top(self, n):
        if not n:
            return []
        best = heapq.nsmallest(n, self.products.items(), key=lambda item: (-item[1], item[0]))
        return [(name, value) for name, value in best]

    def finish(self, top_n):
        return GroupStats(
            key=self.key,
            position=self.position,
            count=self.count,
            units=self.units,
            revenue=self.revenue,
            customers=len(self.customers),
            median_qty=self.median(),
            top=self.top(top_n),
        )
