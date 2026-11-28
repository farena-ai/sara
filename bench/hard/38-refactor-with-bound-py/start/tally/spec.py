"""Report specs: what to group by, which columns to show, how to order them (docs/SPEC_FORMAT.md)."""

import json
from dataclasses import dataclass, field

from .errors import SpecError
from .fields import GROUPABLE

METRICS = ("count", "units", "revenue", "customers", "avg_price", "median_qty", "share", "rank")
FORMATS = ("text", "csv", "markdown", "json")
ORDERS = ("key", "revenue")


@dataclass
class ReportSpec:
    group_by: tuple
    metrics: tuple = METRICS
    top_products: int = 0
    order: str = "key"
    where: dict = field(default_factory=dict)
    groups: tuple = ()
    format: str = "text"
    limit: object = None
    title: str = ""


def _text_list(value, what):
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise SpecError(f"spec: {what} must be a list of strings")
    return value


def parse_spec(data):
    """Builds a ReportSpec from the parsed JSON object; raises SpecError on anything not allowed."""
    if not isinstance(data, dict):
        raise SpecError("spec: must be a JSON object")
    known = {"group_by", "metrics", "top_products", "order", "where", "groups", "format", "limit", "title"}
    for name in data:
        if name not in known:
            raise SpecError(f"spec: unknown setting {name!r}")
    if "group_by" not in data:
        raise SpecError("spec: group_by is required")
    group_by = _text_list(data["group_by"], "group_by")
    if not group_by:
        raise SpecError("spec: group_by must name at least one field")
    for name in group_by:
        if name not in GROUPABLE:
            raise SpecError(f"spec: cannot group by {name!r}")
    if len(set(group_by)) != len(group_by):
        raise SpecError("spec: group_by names a field twice")

    metrics = _text_list(data.get("metrics", list(METRICS)), "metrics")
    for name in metrics:
        if name not in METRICS:
            raise SpecError(f"spec: unknown metric {name!r}")
    if len(set(metrics)) != len(metrics):
        raise SpecError("spec: metrics names a metric twice")

    top = data.get("top_products", 0)
    if not isinstance(top, int) or isinstance(top, bool) or top < 0:
        raise SpecError("spec: top_products must be a whole number of at least 0")

    order = data.get("order", "key")
    if order not in ORDERS:
        raise SpecError(f"spec: order must be one of {', '.join(ORDERS)}")

    fmt = data.get("format", "text")
    if fmt not in FORMATS:
        raise SpecError(f"spec: format must be one of {', '.join(FORMATS)}")

    limit = data.get("limit")
    if limit is not None and (not isinstance(limit, int) or isinstance(limit, bool) or limit < 1):
        raise SpecError("spec: limit must be a whole number of at least 1")

    title = data.get("title", "")
    if not isinstance(title, str):
        raise SpecError("spec: title must be a string")

    where = data.get("where", {})
    if not isinstance(where, dict):
        raise SpecError("spec: where must be an object")
    clean = {}
    for name, value in where.items():
        if name in ("day_from", "day_to"):
            if not isinstance(value, str):
                raise SpecError(f"spec: where.{name} must be a date string")
            clean[name] = value
        elif name in GROUPABLE:
            clean[name] = _text_list(value, f"where.{name}")
        else:
            raise SpecError(f"spec: cannot filter on {name!r}")

    groups = data.get("groups", [])
    if not isinstance(groups, list):
        raise SpecError("spec: groups must be a list")
    keys = []
    for g in groups:
        g = _text_list(g, "each entry of groups")
        if len(g) != len(group_by):
            raise SpecError(f"spec: each entry of groups needs {len(group_by)} values")
        keys.append(tuple(g))

    return ReportSpec(
        group_by=tuple(group_by),
        metrics=tuple(metrics),
        top_products=top,
        order=order,
        where=clean,
        groups=tuple(keys),
        format=fmt,
        limit=limit,
        title=title,
    )


def load_spec(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except OSError as e:
        raise SpecError(f"spec: cannot read {path}: {e.strerror}") from None
    except json.JSONDecodeError as e:
        raise SpecError(f"spec: not valid JSON ({e.msg} at line {e.lineno})") from None
    return parse_spec(data)
