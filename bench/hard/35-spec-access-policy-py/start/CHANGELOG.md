# Changelog

## 0.4.0

- Time windows: `days`, `start` and `end`.
- `python -m accesspolicy explain` lists the applicable statements.
- `FileAuditSink`.

## 0.3.0

- Attribute conditions with `principal.` and `context.` keys (equality only).
- Deny statements.

## 0.2.0

- Resource patterns with `*` and `**`.
- Statement selection by resource specificity.

## 0.1.0

- Roles with inheritance, the directory of principals, action patterns.

## Not done yet

The specification `docs/POLICY.md` (version 1) has grown since 0.4: request validation, partial
wildcards and `{principal}`, the full set of condition operators, time zones and overnight
windows, delegation, the complete selection order, and the full audit format are among the
parts the code does not cover. The loader also accepts documents the specification rejects.
