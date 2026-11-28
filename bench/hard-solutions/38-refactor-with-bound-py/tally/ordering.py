"""The order of the report's lines (docs/CONTRACT.md, "Order")."""


def order_groups(stats, order):
    """stats come in appearance order. "key": by group key; "revenue": highest first, ties in appearance order."""
    by_position = sorted(stats, key=lambda s: s.position)
    if order == "key":
        return sorted(by_position, key=lambda s: s.key)
    return sorted(by_position, key=lambda s: s.revenue, reverse=True)


def apply_limit(stats, limit):
    if limit is None:
        return stats
    return stats[:limit]
