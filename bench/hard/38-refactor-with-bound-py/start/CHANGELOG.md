# Changelog

## 2.3.0

- `groups` in the spec: groups that are always shown, also when empty.
- Markdown output bolds the TOTAL row.
- `median_qty` replaces `avg_qty`.

## 2.2.0

- `where` filters on any groupable field, not only the day.
- Ranks follow the competition rule (1, 2, 2, 4) instead of dense ranks.
- JSON output keeps non-ASCII characters as they are.

## 2.1.0

- JSON-lines input.
- `top_products` breaks ties by product name.

## 2.0.0

- Report specs as JSON files; text, csv, markdown and json output.
