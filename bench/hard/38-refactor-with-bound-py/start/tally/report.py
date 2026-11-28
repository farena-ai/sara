"""build_report(records, spec) -> the report as a string. This is the engine; docs/CONTRACT.md says what it
must produce and docs/PERFORMANCE.md how much work and memory it may use."""

from .fields import check_record
from .filtering import apply_filter
from .grouping import group_rows
from .metrics import compute
from .ordering import apply_limit, order_groups
from .ranking import assign_ranks
from .reader import read_records
from .render import render
from .rows import Row
from .table import build_table


def build_report(records, spec):
    """records: any iterable of mappings (it may be a one-shot generator); spec: a ReportSpec."""
    rows = []
    for index, record in enumerate(records, start=1):
        qty, price = check_record(record, index)
        rows.append(Row(record, qty, price, index))
    rows = apply_filter(rows, spec.where)
    groups = group_rows(rows, spec.group_by, spec.groups)
    stats = [compute(g.key, g.position, g.rows, spec) for g in groups]
    assign_ranks(stats)
    total = compute(None, -1, rows, spec)
    shown = apply_limit(order_groups(stats, spec.order), spec.limit)
    return render(build_table(shown, total, spec), spec.format)


def report_file(path, spec):
    return build_report(read_records(path), spec)
