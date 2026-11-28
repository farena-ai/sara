"""Plain text: a title, a header, a rule, one line per group and the TOTAL line, in padded columns."""

from ..table import LEFT


def column_widths(table):
    widths = [len(h) for h in table.headers]
    for row in table.rows:
        for column, cell in enumerate(row):
            if len(cell) > widths[column]:
                widths[column] = len(cell)
    for column, cell in enumerate(table.total):
        if len(cell) > widths[column]:
            widths[column] = len(cell)
    return widths


def format_line(table, widths, cells):
    parts = [cell.ljust(widths[c]) if table.align[c] == LEFT else cell.rjust(widths[c]) for c, cell in enumerate(cells)]
    return "  ".join(parts).rstrip()


def render_text(table):
    widths = column_widths(table)
    lines = []
    if table.title:
        lines.append(table.title)
        lines.append("")
    lines.append(format_line(table, widths, table.headers))
    lines.append(format_line(table, widths, ["-" * w for w in widths]))
    for row in table.rows:
        lines.append(format_line(table, widths, row))
    lines.append(format_line(table, widths, table.total))
    return "\n".join(lines) + "\n"
