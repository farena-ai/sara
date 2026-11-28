"""Stable sorting. Equal items always keep the order they came in, also when sorting highest first."""


def insertion_sort(items, key=None, reverse=False):
    key = key or (lambda x: x)
    out = []
    for item in items:
        k = key(item)
        i = len(out)
        if reverse:
            while i > 0 and key(out[i - 1]) < k:
                i -= 1
        else:
            while i > 0 and k < key(out[i - 1]):
                i -= 1
        out.insert(i, item)
    return out
