"""tally: sales reports from CSV or JSON-lines files. See README.md."""

from .errors import RecordError, SpecError, TallyError
from .report import build_report, report_file
from .spec import ReportSpec, load_spec, parse_spec

__version__ = "2.3.0"

__all__ = ["RecordError", "ReportSpec", "SpecError", "TallyError", "build_report", "load_spec", "parse_spec", "report_file"]
