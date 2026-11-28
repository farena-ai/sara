"""Output formats."""

from .csv_out import render_csv
from .json_out import render_json
from .markdown import render_markdown
from .text import render_text

RENDERERS = {"text": render_text, "csv": render_csv, "markdown": render_markdown, "json": render_json}


def render(table, fmt):
    return RENDERERS[fmt](table)


__all__ = ["RENDERERS", "render"]
