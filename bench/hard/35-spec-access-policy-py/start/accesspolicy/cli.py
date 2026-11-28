"""Command line: `python -m accesspolicy check|lint|explain ...` (see README.md)."""

import argparse
import json
import sys

from .clock import FixedClock, SystemClock, parse_utc
from .errors import PolicyError
from .evaluator import Evaluator
from .explain import explain
from .loader import load_policy_file


def _context(pairs):
    out = {}
    for pair in pairs or []:
        key, sep, raw = pair.partition("=")
        if not sep or not key:
            raise SystemExit(f"--context needs key=value, got {pair!r}")
        try:
            out[key] = json.loads(raw)
        except json.JSONDecodeError:
            out[key] = raw
    return out


def _clock(at):
    if at is None:
        return SystemClock()
    try:
        return FixedClock(parse_utc(at))
    except ValueError as e:
        raise SystemExit(str(e)) from None


def build_parser():
    parser = argparse.ArgumentParser(prog="accesspolicy", description="Evaluate gatekeeper policies.")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("check", "explain"):
        p = sub.add_parser(name)
        p.add_argument("policy")
        p.add_argument("principal")
        p.add_argument("action")
        p.add_argument("resource")
        p.add_argument("--context", action="append", metavar="KEY=VALUE")
        p.add_argument("--at", metavar="YYYY-MM-DDTHH:MM:SSZ")
    lint = sub.add_parser("lint")
    lint.add_argument("policy")
    return parser


def main(argv=None, out=None):
    out = out or sys.stdout
    args = build_parser().parse_args(argv)
    try:
        policy = load_policy_file(args.policy)
    except (OSError, PolicyError) as e:
        print(f"error: {e}", file=out)
        return 2
    if args.command == "lint":
        print(f"ok: {len(policy.statements)} statements, {len(policy.delegations)} delegations", file=out)
        return 0
    evaluator = Evaluator(policy, _clock(args.at))
    if args.command == "explain":
        for line in explain(evaluator, args.principal, args.action, args.resource, _context(args.context)):
            print(line, file=out)
        return 0
    decision = evaluator.evaluate(args.principal, args.action, args.resource, _context(args.context))
    print(decision.record, file=out)
    return 0 if decision.allowed else 1
