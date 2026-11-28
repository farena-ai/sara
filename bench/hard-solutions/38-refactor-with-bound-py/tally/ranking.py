"""Ranks by revenue, highest first, the way sports tables do: equal revenue, equal rank, and the next
rank skips (1, 2, 2, 4)."""


def assign_ranks(stats):
    rank = 0
    previous = None
    for place, s in enumerate(sorted(stats, key=lambda s: s.revenue, reverse=True), start=1):
        if previous is None or s.revenue != previous:
            rank = place
            previous = s.revenue
        s.rank = rank
    return stats
