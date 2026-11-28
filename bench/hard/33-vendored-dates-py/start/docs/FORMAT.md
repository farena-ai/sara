# Schedule format

A schedule file is a JSON list of schedule objects. `rota.schedule.parse_schedule(data, cal)`
reads one object into a `Schedule` and raises `ScheduleError` when it does not follow this page.

| field | required | JSON | `Schedule` field |
|---|---|---|---|
| `id` | yes | non-empty string | `id` |
| `start` | yes | `"YYYY-MM-DD"`, the first day the schedule can happen | `start` (a `Day`) |
| `until` | no | `"YYYY-MM-DD"`, the last day it can happen (inclusive); not before `start` | `until` (a `Day` or `None`) |
| `count` | no | whole number >= 1 | `count` (or `None`) |
| `time` | yes | `"HH:MM"`, the local start time | `time`: minutes after midnight |
| `duration` | yes | whole number of minutes, 1 to 10080 | `duration` |
| `repeat` | yes | object, see below | `every`, `interval`, `on`, `month_day`, `nth`, `weekday` |
| `except` | no | list of `"YYYY-MM-DD"` | `exceptions` (a frozenset of `Day`) |
| `moves` | no | object `"YYYY-MM-DD": "YYYY-MM-DDTHH:MM"` | `moves` (a mapping `Day` -> `Moment`) |
| `skip_holidays` | no | `true` / `false` (default `false`) | `skip_holidays` |

## `repeat`

- `{ "every": "day", "interval": n }`
- `{ "every": "week", "interval": n, "on": ["MO", "TH"] }`: `on` lists weekday codes
  (`MO TU WE TH FR SA SU`). When `on` is left out it is the weekday of `start`, so `Schedule.on` is
  never empty for a weekly schedule.
- `{ "every": "month", "interval": n, "day": 15 }`: a day of the month, 1 to 31.
- `{ "every": "month", "interval": n, "nth": 2, "weekday": "TU" }`: `nth` is 1 to 5, or -1 for
  the last.

`interval` defaults to 1.

Example (the team's file is `data/team.json`):

```json
{ "id": "review", "start": "2026-01-08", "time": "14:00", "duration": 60,
  "repeat": { "every": "week", "interval": 2 },
  "moves": { "2026-01-22": "2026-01-23T09:00" } }
```
