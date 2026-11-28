"""Turns group statistics into a table of display strings (docs/CONTRACT.md, "Columns")."""

from dataclasses import dataclass

from .money import fmt_int, fmt_median, fmt_money, fmt_percent, fmt_ratio

LEFT, RIGHT = "left", "right"


@dataclass
class Table:
    title: str
    headers: list
    align: list
    rows: list
    total: list


def _top_cell(top):
    if not top:
        return "-"
    return ", ".join(f"{name} ({fmt_money(value)})" for name, value in top)


def _metric_cell(name, s, grand_revenue, is_total):
    if name == "count":
        return fmt_int(s.count)
    if name == "units":
        return fmt_int(s.units)
    if name == "revenue":
        return fmt_money(s.revenue)
    if name == "customers":
        return fmt_int(s.customers)
    if name == "avg_price":
        return fmt_ratio(s.revenue, s.units)
    if name == "median_qty":
        return fmt_median(s.median_qty)
    if name == "share":
        return fmt_percent(s.revenue, grand_revenue)
    if name == "rank":
        return "" if is_total else fmt_int(s.rank)
    raise ValueError(name)


def build_table(shown, total, spec):
    headers = list(spec.group_by) + list(spec.metrics)
    align = [LEFT] * len(spec.group_by) + [RIGHT] * len(spec.metrics)
    if spec.top_products:
        headers.append("top_products")
        align.append(LEFT)

    def line(s, is_total):
        if is_total:
            cells = ["TOTAL"] + [""] * (len(spec.group_by) - 1)
        else:
            cells = [str(v) for v in s.key]
        cells += [_metric_cell(name, s, total.revenue, is_total) for name in spec.metrics]
        if spec.top_products:
            cells.append(_top_cell(s.top))
        return cells

    return Table(
        title=spec.title,
        headers=headers,
        align=align,
        rows=[line(s, False) for s in shown],
        total=line(total, True),
    )
