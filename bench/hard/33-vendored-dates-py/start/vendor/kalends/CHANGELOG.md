# Changelog

## 3.2.0

- `Calendar.weeks_apart()` and `Calendar.week_of()`.
- `Span.overlap()` returns the shared part.

## 3.0.0 (breaking)

- Weekday numbers are positions in the calendar's week, from 1 (they were 0-based ISO numbers).
- `Day.weekday()` removed: weekdays depend on the calendar.
- Durations are minutes (they were `timedelta`s).
- `parse_*` return `(value, error)` pairs instead of raising.
