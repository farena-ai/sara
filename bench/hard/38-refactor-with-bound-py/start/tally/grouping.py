"""Puts rows into groups by the spec's group_by fields, keeping the order in which groups first appear."""


def group_key(row, fields):
    return tuple(row[name] for name in fields)


class Group:
    def __init__(self, key, position):
        self.key = key
        self.position = position  # appearance order: listed groups first, then as met in the input
        self.rows = []


def group_rows(rows, fields, listed=()):
    groups = []
    for key in listed:
        if not any(g.key == key for g in groups):
            groups.append(Group(key, len(groups)))
    for row in rows:
        key = group_key(row, fields)
        for g in groups:
            if g.key == key:
                g.rows.append(row)
                break
        else:
            group = Group(key, len(groups))
            group.rows.append(row)
            groups.append(group)
    return groups
