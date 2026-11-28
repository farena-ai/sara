# kalends 3.2 API reference

```python
from vendor.kalends import Calendar, Day, Moment, Span, KalendsError, CODES, MINUTES_PER_DAY
```

`KalendsError` (a subclass of `ValueError`) is raised for values that cannot exist and for
arguments of the wrong type. The `parse_*` methods never raise it.

All values are **immutable**: assigning an attribute raises `AttributeError`, and every method
that "changes" a value returns a new one. Values are hashable and compare with `==`, `<`, etc.
against values of the same class (comparing a `Day` with a `Moment` raises `TypeError`).

## Day

`Day(year, month, day)`: a calendar day. Months and days of the month count from 1. Raises
`KalendsError` for a day that does not exist (`Day(2026, 2, 30)`) or non-int arguments.

| member | |
|---|---|
| `d.year`, `d.month`, `d.day` | ints |
| `d.ordinal` | the day number (`Day(1, 1, 1).ordinal == 1`); `Day.from_ordinal(n)` is the reverse |
| `d.plus(days)` | a **new** `Day`, `days` (an int, may be negative) later |
| `d.days_until(other)` | `other` minus `d` in days (negative when `other` is earlier) |
| `d.at(minute)` | the `Moment` at `minute` minutes after midnight, `0` to `1439`: `d.at(570)` is 09:30 |
| `d.iso()`, `str(d)` | `'2026-01-05'` |

A `Day` has no weekday method: weekdays depend on the calendar's rules (see `Calendar.weekday`).
There is no `+` or `-` operator; use `plus()` and `days_until()`.

## Moment

`Moment(day, minute)`: minute `minute` (0 to 1439) of `day`.

| member | |
|---|---|
| `m.day` | the `Day` |
| `m.minute` | minutes after midnight |
| `m.plus(minutes)` | a **new** `Moment`, `minutes` (int) later; crosses into other days as needed |
| `m.minutes_until(other)` | `other` minus `m` in minutes |
| `m.time_text()` | `'09:30'` |
| `m.iso()`, `str(m)` | `'2026-01-05T09:30'` |

A day always has 1440 minutes (`MINUTES_PER_DAY`): there are no time zones and no daylight saving
changes.

## Span

`Span(start, end)`: the **half-open** stretch of time from `start` (included) to `end`
(**excluded**). `end` must not be before `start`. `Span.of(start, minutes)` makes the span that
starts at `start` and lasts `minutes` minutes.

| member | |
|---|---|
| `s.start`, `s.end` | the two `Moment`s |
| `s.length` | length in **minutes** |
| `s.is_empty()` | `start == end` |
| `s.contains(moment)` | `start <= moment < end` |
| `s.overlaps(other)` | `True` when the spans share at least one minute. Spans that only touch (one ends exactly where the other starts) do **not** overlap; an empty span overlaps nothing |
| `s.overlap(other)` | the shared part as a `Span`, or `None` when they do not overlap |
| `s.shift(minutes)` | a new span moved by `minutes`, same length |
| `s.iso()` | `'2026-01-05T09:30/2026-01-05T10:15'` |

## Calendar

`Calendar(week_start=1, holidays=())`. `week_start` is the **ISO number** of the weekday the
weeks begin on: 1 = Monday (the default) ... 7 = Sunday. `holidays` is an iterable of `Day`s.
`cal.week_start` and `cal.holidays` (a frozenset) read them back; `cal.with_holidays(days)`
returns a copy with other holidays.

### Weekdays and weeks

Weekday **numbers** in kalends are always positions in the calendar's week, counted from **1**:

| method | |
|---|---|
| `cal.weekday(day)` | 1 to 7: the position of `day` in its week. With `week_start=7`, Sunday is 1, Monday 2, ... Saturday 7. With the default `week_start=1`, Monday is 1 ... Sunday 7 |
| `cal.weekday_code(day)` | the weekday as a code, the same in every calendar: `'MO'`, `'TU'`, `'WE'`, `'TH'`, `'FR'`, `'SA'`, `'SU'` (`CODES` lists them in that order) |
| `cal.weekday_number(code)` | the position (1 to 7) of a code in this calendar's week, i.e. what `weekday()` returns for such a day. With `week_start=7`, `weekday_number('FR')` is 6. Unknown codes raise `KalendsError` |
| `cal.week_of(day)` | the first day of the week that contains `day` (a Sunday when `week_start=7`) |
| `cal.weeks_apart(a, b)` | how many weeks the week containing `b` comes after the week containing `a`: 0 when they are in the same week of this calendar, 1 for the next week, and so on (negative when `b`'s week is earlier) |

Because weeks follow `week_start`, two days can be in the same week in one calendar and in
neighbouring weeks in another: Saturday 2026-01-03 and Sunday 2026-01-04 are `weeks_apart` 0 when
weeks start on Monday, but 1 when they start on Sunday.

### Months

| method | |
|---|---|
| `cal.days_in_month(year, month)` | 28 to 31 |
| `cal.months_apart(a, b)` | how many months `b`'s month is after `a`'s month (days of the month are ignored) |
| `cal.add_months(day, n)` | the same day of the month `n` months later. When the target month is shorter, the result is **clamped** to its last day: `add_months(Day(2026, 1, 31), 1)` is `Day(2026, 2, 28)` |
| `cal.nth_weekday(year, month, weekday, n)` | the `n`-th day of that month with that weekday, or `None` when there is none (for example no 5th Friday). `n` is 1 to 5, or -1 to -5 counting from the end (-1 = the last). **`weekday` is a position in this calendar's week** (1 to 7, as from `weekday_number()`), not an ISO number and not a code: `cal.nth_weekday(2026, 1, cal.weekday_number('FR'), -1)` is the last Friday of January 2026 |

### Ranges and holidays

| method | |
|---|---|
| `cal.days(start, stop)` | an iterator over the days from `start` up to but **not including** `stop` (nothing when `stop <= start`) |
| `cal.is_holiday(day)` | whether `day` is one of the calendar's holidays |

### Parsing

These never raise. Each returns a pair: `(value, None)` on success, `(None, message)` otherwise.

| method | accepts | value |
|---|---|---|
| `cal.parse_day(text)` | `'YYYY-MM-DD'` (exactly, zero-padded) | a `Day` |
| `cal.parse_time(text)` | `'HH:MM'`, `00:00` to `23:59` | minutes after midnight (an int) |
| `cal.parse_moment(text)` | `'YYYY-MM-DDTHH:MM'` | a `Moment` |

```python
day, err = cal.parse_day(text)
if err:
    ...  # day is None
```
