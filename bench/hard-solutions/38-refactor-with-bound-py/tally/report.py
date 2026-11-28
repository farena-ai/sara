"""build_report(records, spec) -> the report as a string. This is the engine; docs/CONTRACT.md says what it
must produce and docs/PERFORMANCE.md how much work and memory it may use."""

from .accumulate import Accumulator
from .fields import check_record
from .filtering import matches
from .ordering import apply_limit, order_groups
from .ranking import assign_ranks
from .reader import read_records
from .render import render
from .table import build_table


def build_report(records, spec):
    """records: any iterable of mappings (it may be a one-shot generator); spec: a ReportSpec."""
    fields = spec.group_by
    where = spec.where
    groups = {}
    for key in spec.groups:
        if key not in groups:
            groups[key] = Accumulator(key, len(groups))
    total = Accumulator(None, -1)
    for index, record in enumerate(records, start=1):
        qty, price = check_record(record, index)
        if where and not matches(record, where):
            continue
        key = tuple([record[name] for name in fields])
        acc = groups.get(key)
        if acc is None:
            acc = groups[key] = Accumulator(key, len(groups))
        revenue = price * qty
        customer = record["customer"]
        product = record["product"]
        acc.add(qty, revenue, customer, product)
        total.add(qty, revenue, customer, product)
    stats = [acc.finish(spec.top_products) for acc in groups.values()]
    assign_ranks(stats)
    total_stats = total.finish(spec.top_products)
    shown = apply_limit(order_groups(stats, spec.order), spec.limit)
    return render(build_table(shown, total_stats, spec), spec.format)


def report_file(path, spec):
    return build_report(read_records(path), spec)
