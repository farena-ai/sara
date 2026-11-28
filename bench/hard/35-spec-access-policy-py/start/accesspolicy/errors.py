"""Exceptions raised by the gatekeeper library."""


class PolicyError(ValueError):
    """A policy document is malformed (see docs/POLICY.md)."""

    def __init__(self, message, where=None):
        self.where = where
        if where:
            message = f"{where}: {message}"
        super().__init__(message)


class RequestError(ValueError):
    """A request is malformed. The evaluator turns this into an invalid-request decision."""
