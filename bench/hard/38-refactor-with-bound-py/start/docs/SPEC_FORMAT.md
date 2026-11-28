# Report specs

A spec is a JSON object. Only `group_by` is required.

```json
{
  "title": "Sales by region, March",
  "group_by": ["region"],
  "metrics": ["count", "units", "revenue", "customers", "avg_price", "median_qty", "share", "rank"],
  "top_products": 3,
  "order": "revenue",
  "where": {"day_from": "2026-03-01", "day_to": "2026-03-31", "category": ["toys", "books"]},
  "groups": [["north"], ["south"]],
  "format": "text",
  "limit": 10
}
```

| setting | default | allowed |
|---|---|---|
| `group_by` | — | one or more of `day`, `region`, `store`, `product`, `category`, `customer`, each once |
| `metrics` | all eight, in the order above | any of them, each once, in the order to show them |
| `top_products` | 0 (no column) | a whole number ≥ 0 |
| `order` | `key` | `key` or `revenue` |
| `where` | none | `day_from`, `day_to` (dates as text) and `<groupable field>: [values]` |
| `groups` | none | a list of groups, each a list with one value per `group_by` field |
| `format` | `text` | `text`, `csv`, `markdown`, `json` |
| `limit` | none | a whole number ≥ 1 |
| `title` | empty | text |

Anything else (an unknown setting, a wrong type) is refused with `spec: …`. `parse_spec(dict)` builds a
`ReportSpec` from the parsed object; `load_spec(path)` reads a file.
