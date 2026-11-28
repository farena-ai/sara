"""The one exception kalends raises."""


class KalendsError(ValueError):
    """Raised for values that cannot exist (a 30th of February, minute 1440, an end before a
    start) and for arguments of the wrong kind. Parsing functions do not raise it: they return
    an (value, error) pair instead."""
