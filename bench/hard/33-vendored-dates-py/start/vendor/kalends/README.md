# kalends

Immutable days, moments and spans for scheduling code, with an explicit `Calendar` that holds the
rules (which weekday starts the week, which days are holidays). Pure Python, standard library only.

```python
from vendor.kalends import Calendar, Day, Span

cal = Calendar(week_start=7, holidays=[Day(2026, 1, 1)])   # weeks run Sunday..Saturday
monday = Day(2026, 1, 5)
cal.weekday(monday)          # 2   (Sunday is 1 in this calendar)
cal.weekday_code(monday)     # 'MO'
meeting = Span.of(monday.at(9 * 60 + 30), 45)   # 09:30, 45 minutes
meeting.end.iso()            # '2026-01-05T10:15'
day, err = cal.parse_day("2026-02-30")          # (None, 'no such day: 2026-02-30')
```

## What to keep in mind

- **Values are immutable.** `day.plus(1)` returns a new `Day`; the old one is unchanged.
- **Minutes everywhere.** `Day.at(minute)` takes minutes after midnight, `Moment.plus()` takes
  minutes, `Span.length` is in minutes. There are no seconds and no time zones.
- **Weekdays belong to the calendar** and count from **1** at the calendar's first weekday:
  `cal.weekday(day)` is 1..7 relative to `week_start`. Use `weekday_code()` / `weekday_number()`
  to convert between codes like `'FR'` and those numbers. `Day` itself has no weekday.
- **Spans are half-open**: `[start, end)`. Touching spans do not overlap.
- **`cal.days(a, b)` excludes `b`.**
- **`add_months` clamps** to the end of shorter months.
- **Parsing does not raise**: `parse_day`, `parse_time` and `parse_moment` return
  `(value, None)` or `(None, message)`.

Reference: [docs/API.md](docs/API.md). Changes: [CHANGELOG.md](CHANGELOG.md).
