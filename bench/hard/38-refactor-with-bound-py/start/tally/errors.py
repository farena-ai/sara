"""Errors raised by tally. The CLI prints them as "error: <message>" and exits with 2."""


class TallyError(Exception):
    """Base class for every error tally reports to the user."""


class SpecError(TallyError):
    """The report spec is not valid (see docs/SPEC_FORMAT.md)."""


class RecordError(TallyError):
    """An input record (or line of an input file) is not valid."""
