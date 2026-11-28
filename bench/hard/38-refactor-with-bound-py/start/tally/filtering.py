"""The spec's where: a day range (inclusive) and lists of allowed values per field."""


def matches(row, where):
    if not where:
        return True
    day = row["day"]
    if "day_from" in where and day < where["day_from"]:
        return False
    if "day_to" in where and day > where["day_to"]:
        return False
    for name, allowed in where.items():
        if name in ("day_from", "day_to"):
            continue
        if row[name] not in allowed:
            return False
    return True


def apply_filter(rows, where):
    return [row for row in rows if matches(row, where)]
