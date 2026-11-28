# Expanding schedules

`rota.expand` turns `Schedule` values (see FORMAT.md) into occurrences on a timeline, and
`rota.conflicts` finds occurrences that overlap. All functions take the team calendar
(`rota.config.team_calendar()`, a kalends `Calendar`) as `cal`; tests may pass other calendars.

```python
expand(schedule, window, cal)        # -> [Occurrence], for one schedule
expand_all(schedules, window, cal)   # -> [Occurrence], all schedules merged
find_conflicts(occurrences)          # -> [Conflict]
```

`window` is a kalends `Span`. `Occurrence` and `Conflict` are defined in `rota/occurrence.py`.

## Time

1. Times are local wall-clock times; there are no time zones and no daylight saving changes.
   Durations are whole minutes.
2. An occurrence starts at the schedule's `time` on its day and lasts `duration` minutes. It
   may run past midnight into the following day(s).

## Which days

3. A schedule only produces occurrences on days from `start` to `until`, **both inclusive**
   (without `until` there is no last day).
4. `every: day`: every `interval`-th day counting from `start`: `start`, `start + interval`,
   `start + 2 * interval`, ... The count always starts at `start`, whatever window is asked for.
5. `every: week`: the days whose weekday is in `on`, in every `interval`-th week counting from
   the week that contains `start` (that week is week 0; with `interval: 2` the weeks 0, 2, 4, ...
   are used). **Weeks are those of the calendar**: for the team they run from Sunday to Saturday
   (`week_start` 7 in rota/config.py). Days of week 0 before `start` are not used.
6. `every: month` with `day`: that day of every `interval`-th month counting from the month of
   `start` (month 0). A month that does not have that day (a 31st in April, a 30th in February)
   has **no** occurrence that month; it is not moved to the last day of the month. In the month of
   `start`, the day is only used if it is not before `start`.
7. `every: month` with `nth` and `weekday`: the `nth` such weekday of every `interval`-th month
   counting from the month of `start` (`nth: -1` is the last one in the month). A month without
   it (for example without a 5th Friday) has no occurrence. Days before `start` are not used.

## Count, exceptions, holidays and moves

8. `count` is the most occurrences the schedule produces, counted on the days of rules 3 to 7 in
   date order from `start`. Days removed by `except` or `skip_holidays` **still use up** one of the
   `count`: a schedule with `count: 5` and one excepted day has 4 occurrences.
9. A day listed in `except` has no occurrence. Listing a day the schedule would not use anyway
   changes nothing.
10. With `skip_holidays: true`, days that are holidays of the calendar have no occurrence. By
    default holidays are treated like any other day.
11. `moves` maps a day to a new start: the occurrence of that day starts at the given moment
    instead, keeps its duration and its `day`, and has `moved = True`. A move only applies to a
    day that has an occurrence after rules 3 to 10; a move for any other day (one the schedule
    does not use, an excepted or skipped day, a day past `count` or `until`) is ignored.

## The window

12. An occurrence is part of the result when its time overlaps the window, which is half-open
    (`[window.start, window.end)`): an occurrence that ends exactly when the window starts, or
    starts exactly when it ends, is **not** included; one that started before the window and is
    still going on when it starts **is** included. Moved occurrences are judged by their new time,
    so a move can bring an occurrence into the window from a day outside it, or take one out.
13. Results are in timeline order: by start, then by schedule id, then by end
    (`rota.occurrence.timeline_key`). `expand_all` merges the occurrences of all schedules in this
    order.
14. An `Occurrence` has `schedule_id`, `day` (the day the schedule put it on, before any move),
    `span` (its time as a kalends `Span`; `start` and `end` are shortcuts) and `moved`.

## Conflicts

15. Two occurrences conflict when their spans overlap by at least one minute. Occurrences that
    only touch (one ends at the minute the other starts) do not conflict. Occurrences of the same
    schedule can conflict with each other (a long duration with a short interval).
16. `find_conflicts(occurrences)` returns one `Conflict(first, second, minutes)` per overlapping
    pair: `first` is the one that comes first in timeline order, `minutes` is how long they
    overlap. The list is sorted by the timeline position of `first`, then of `second`. The input
    does not have to be sorted.
