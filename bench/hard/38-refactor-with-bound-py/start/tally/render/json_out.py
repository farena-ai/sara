"""JSON: { "title", "columns", "rows": [ {column: cell} ], "total": {column: cell} }, two-space indent,
non-ASCII written as is, a newline at the end. Every cell is a string, as in the other formats."""

import json


def render_json(table):
    doc = {
        "title": table.title,
        "columns": table.headers,
        "rows": [dict(zip(table.headers, row)) for row in table.rows],
        "total": dict(zip(table.headers, table.total)),
    }
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
