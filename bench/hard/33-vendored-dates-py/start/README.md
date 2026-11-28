# rota

The team's recurring schedules (stand-ups, reviews, on-call shifts, retros) on one timeline, with
the overlaps between them.

Dates and times are handled by **kalends**, a small library vendored in `vendor/kalends/` (its
README.md and docs/API.md describe it). kalends is third-party code kept as released: do not change
anything under `vendor/`.

```sh
python -m rota data/team.json 2026-01-04T00:00 2026-01-18T00:00
python -m unittest discover -s tests
```

| Path | What |
|---|---|
| `rota/config.py` | the team calendar: weeks start on Sunday, office holidays |
| `rota/schedule.py` | `parse_schedule`: JSON schedule -> `Schedule` ([docs/FORMAT.md](docs/FORMAT.md)) |
| `rota/occurrence.py` | `Occurrence`, `Conflict` and the timeline order |
| `rota/expand.py` | `expand`, `expand_all` ([docs/SCHEDULES.md](docs/SCHEDULES.md)) |
| `rota/conflicts.py` | `find_conflicts` ([docs/SCHEDULES.md](docs/SCHEDULES.md)) |
| `rota/agenda.py`, `rota/__main__.py` | the command line |
| `data/team.json` | the team's schedules |
