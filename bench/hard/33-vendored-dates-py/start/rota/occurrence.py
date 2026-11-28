"""The values the expander and the conflict finder return (docs/SCHEDULES.md)."""

from dataclasses import dataclass

from vendor.kalends import Day, Span


@dataclass(frozen=True)
class Occurrence:
    schedule_id: str
    day: Day          # the day the schedule put it on (before any move)
    span: Span
    moved: bool = False

    @property
    def start(self):
        return self.span.start

    @property
    def end(self):
        return self.span.end


@dataclass(frozen=True)
class Conflict:
    first: Occurrence
    second: Occurrence
    minutes: int


def timeline_key(occurrence):
    """The order of a timeline: by start, then schedule id, then end."""
    return (occurrence.start, occurrence.schedule_id, occurrence.end)
