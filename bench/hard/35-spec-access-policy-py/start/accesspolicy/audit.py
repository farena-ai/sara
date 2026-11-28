"""Audit records (docs/POLICY.md section 10)."""


def format_timestamp(instant_utc):
    return instant_utc.strftime("%Y-%m-%dT%H:%M:%SZ")


def format_record(instant_utc, effect, principal, action, resource, reason, statement, via=()):
    return " ".join([
        format_timestamp(instant_utc),
        effect,
        f"principal={principal}",
        f"action={action}",
        f"resource={resource}",
        f"reason={reason}",
        f"statement={statement or '-'}",
    ])


class MemoryAuditSink:
    """Keeps every record in a list (handy for tests)."""

    def __init__(self):
        self.lines = []

    def write(self, line):
        self.lines.append(line)


class FileAuditSink:
    """Appends every record to a text file, one per line."""

    def __init__(self, path):
        self.path = path

    def write(self, line):
        with open(self.path, "a", encoding="utf-8", newline="\n") as f:
            f.write(line + "\n")
