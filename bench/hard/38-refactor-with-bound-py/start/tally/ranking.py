"""Ranks by revenue, highest first, the way sports tables do: equal revenue, equal rank, and the next
rank skips (1, 2, 2, 4)."""


def assign_ranks(stats):
    for s in stats:
        s.rank = 1 + sum(1 for other in stats if other.revenue > s.revenue)
    return stats
