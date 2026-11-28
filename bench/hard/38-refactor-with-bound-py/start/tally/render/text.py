"""Plain text: a title, a header, a rule, one line per group and the TOTAL line, in padded columns."""

from ..table import LEFT


def column_width(table, column):
    width = len(table.headers[column])
    for row in table.rows + [table.total]:
        width = max(width, len(row[column]))
    return width


def format_line(table, cells):
    parts = []
    for column, cell in enumerate(cells):
        width = column_width(table, column)
        parts.append(cell.ljust(width) if table.align[column] == LEFT else cell.rjust(width))
    return "  ".join(parts).rstrip()


def render_text(table):
    out = ""
    if table.title:
        out += table.title + "\n\n"
    out += format_line(table, table.headers) + "\n"
    out += format_line(table, ["-" * column_width(table, c) for c in range(len(table.headers))]) + "\n"
    for row in table.rows:
        out += format_line(table, row) + "\n"
    out += format_line(table, table.total) + "\n"
    return out
