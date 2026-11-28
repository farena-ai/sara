# The journal

A journal is one folder. relay writes a record for everything that changes an event's state, and a
restart replays the records, oldest first, to rebuild the state (see GUARANTEES.md §7).

## Files

The folder holds **segments** named `segment-<n>.log`, where `<n>` is 1, 2, 3, … written in plain decimal
with no padding (`segment-9.log`, `segment-10.log`). Other files in the folder are ignored.

- A segment holds at most `segmentSize` records.
- Records are always appended to the newest segment, the one with the highest number. When it is full, the
  next record starts segment `<n+1>`. Segments are never rewritten, except that a torn last line is cut
  off (below).
- Reading the journal means reading the segments in number order, and each segment from top to bottom.
  That is the order the records were written in.
- `segmentSize` may differ between runs on the same journal: the limit applies to the segment being
  written.

Journals written by relay 1.0 to 1.2 have the same layout and records; 1.3 reads them unchanged.

## Records

One JSON object per line, ending in `\n`. Every record has `t` (its type) and `seq` (the event it is about).

| t | fields | written when |
|---|---|---|
| `enq` | `seq`, `id`, `key`, `at`, `data` | an event is accepted (`at` = acceptance time) |
| `fail` | `seq`, `attempts`, `due`, `at`, `reason` | an attempt failed and another is due at `due`; `attempts` = failed attempts so far |
| `done` | `seq`, `batch`, `at` | an event was delivered in batch `batch` |
| `dead` | `seq`, `id`, `attempts`, `at`, `reason` | an event was dead-lettered after `attempts` attempts |

Replaying the records in order:

- `enq` adds a pending event (attempts 0, due at `at`);
- `fail` sets that event's attempts and due time;
- `done` and `dead` remove it (and `dead` adds it to the dead letters).

The next seq is one more than the highest seq of any `enq`; the next batch id is one more than the
highest `batch` of any `done`.

## Torn writes

A process killed in the middle of a write can leave a last line without its `\n`. Such a line is not a
record: reading skips it, and opening the journal for writing cuts it off the newest segment before
appending.

## Looking at a journal

`relay journal ls` lists the segments oldest first with their record counts; `relay journal pending`
lists the pending events; `relay totals` sums the amounts of delivered events (see CLI.md).
