# Changelog

## 0.4.0 (unreleased)

- Timeline: `expand`, `expand_all` and `find_conflicts` (docs/SCHEDULES.md).

## 0.3.0

- Moved to kalends 3 (vendored in `vendor/kalends/`): schedule times are minutes after midnight,
  durations are minutes, and parsing reports problems as `ScheduleError` with the field name.
- `skip_holidays` and `moves` in the schedule format.

## 0.2.0

- The team calendar starts its weeks on Sunday, like the office planner.
