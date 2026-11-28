"""The command line (docs/CLI.md):

    python -m tally report DATA --spec SPEC.json [--format text|csv|markdown|json] [--limit N]
    python -m tally check DATA
"""

import argparse
import sys

from .errors import TallyError
from .fields import check_record
from .reader import read_records
from .report import build_report
from .spec import FORMATS, load_spec


def _parser():
    p = argparse.ArgumentParser(prog="tally", description="Sales reports from CSV or JSON-lines files.")
    sub = p.add_subparsers(dest="command", required=True)
    r = sub.add_parser("report", help="build a report")
    r.add_argument("data")
    r.add_argument("--spec", required=True)
    r.add_argument("--format", choices=FORMATS)
    r.add_argument("--limit", type=int)
    c = sub.add_parser("check", help="check every record of a file")
    c.add_argument("data")
    return p


def main(argv=None, out=None, err=None):
    out = out or sys.stdout
    err = err or sys.stderr
    args = _parser().parse_args(argv)
    try:
        if args.command == "check":
            n = 0
            for n, record in enumerate(read_records(args.data), start=1):
                check_record(record, n)
            out.write(f"ok: {n} records\n")
            return 0
        spec = load_spec(args.spec)
        if args.format:
            spec.format = args.format
        if args.limit is not None:
            if args.limit < 1:
                raise TallyError("--limit must be at least 1")
            spec.limit = args.limit
        out.write(build_report(read_records(args.data), spec))
        return 0
    except TallyError as e:
        err.write(f"error: {e}\n")
        return 2
