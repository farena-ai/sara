"""Plain-text agenda of a timeline, for the command line."""


def agenda(occurrences, conflicts=()):
    lines = []
    current = None
    for occ in occurrences:
        if occ.start.day != current:
            current = occ.start.day
            lines.append(f"{current.iso()}")
        mark = " (moved)" if occ.moved else ""
        lines.append(f"  {occ.start.time_text()}-{occ.end.time_text()}  {occ.schedule_id}{mark}")
    if conflicts:
        lines.append("")
        lines.append("Conflicts:")
        for c in conflicts:
            lines.append(f"  {c.first.schedule_id} {c.first.start.iso()} and {c.second.schedule_id} {c.second.start.iso()}: {c.minutes} min")
    return "\n".join(lines)
