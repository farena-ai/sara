"""Audit records (docs/POLICY.md section 10)."""


def encode_field(value):
    if not isinstance(value, str) or value == "":
        return "-"
    out = []
    for byte in value.encode("utf-8"):
        if 0x21 <= byte <= 0x7E and byte != 0x25:
            out.append(chr(byte))
        else:
            out.append("%{:02X}".format(byte))
    return "".join(out)


def format_timestamp(instant_utc):
    return "{:04d}-{:02d}-{:02d}T{:02d}:{:02d}:{:02d}Z".format(
        instant_utc.year, instant_utc.month, instant_utc.day,
        instant_utc.hour, instant_utc.minute, instant_utc.second,
    )


def format_record(instant_utc, effect, principal, action, resource, reason, statement, via):
    return " ".join([
        format_timestamp(instant_utc),
        effect,
        "principal=" + encode_field(principal),
        "action=" + encode_field(action),
        "resource=" + encode_field(resource),
        "reason=" + reason,
        "statement=" + (statement or "-"),
        "via=" + (">".join(via) if via else "-"),
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
