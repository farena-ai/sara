"""Markdown: "## title", then a pipe table; numbers right-aligned; "|" in a cell is written "\\|"."""

from ..table import LEFT


def _cell(text):
    return text.replace("|", "\\|")


def _line(cells):
    return "| " + " | ".join(_cell(c) for c in cells) + " |"


def render_markdown(table):
    lines = []
    if table.title:
        lines.append("## " + table.title)
        lines.append("")
    lines.append(_line(table.headers))
    lines.append("|" + "|".join(" --- " if a == LEFT else " ---: " for a in table.align) + "|")
    for row in table.rows:
        lines.append(_line(row))
    lines.append(_line(["**" + c + "**" if c else c for c in table.total]))
    return "\n".join(lines) + "\n"
