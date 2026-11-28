"""python -m rota data/team.json 2026-01-04T00:00 2026-01-11T00:00"""

import sys

from vendor.kalends import Span

from .agenda import agenda
from .config import team_calendar
from .conflicts import find_conflicts
from .expand import expand_all
from .load import load_schedules


def main(argv):
    if len(argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    cal = team_calendar()
    path, start_text, end_text = argv
    start, err1 = cal.parse_moment(start_text)
    end, err2 = cal.parse_moment(end_text)
    if err1 or err2:
        print(err1 or err2, file=sys.stderr)
        return 2
    timeline = expand_all(load_schedules(path, cal), Span(start, end), cal)
    print(agenda(timeline, find_conflicts(timeline)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
