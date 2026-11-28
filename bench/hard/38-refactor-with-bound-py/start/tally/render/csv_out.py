"""CSV: a header row, one row per group and the TOTAL row; no title. Lines end with "\\n"."""

import csv
import io


def render_csv(table):
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(table.headers)
    for row in table.rows:
        writer.writerow(row)
    writer.writerow(table.total)
    return buffer.getvalue()
