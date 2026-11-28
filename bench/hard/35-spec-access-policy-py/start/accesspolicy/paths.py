"""Resource paths: splitting and joining (docs/POLICY.md R9)."""


def split_path(text):
    """The segments of a path, or raises ValueError when it is not a valid path."""
    if not isinstance(text, str) or not text.startswith("/"):
        raise ValueError(f"path must start with '/': {text!r}")
    segments = tuple(s for s in text.split("/") if s != "")
    for s in segments:
        if s in (".", ".."):
            raise ValueError(f"path may not contain '{s}' segments: {text!r}")
    return segments


def join_path(segments):
    return "/" + "/".join(segments)


def normalise_path(text):
    return join_path(split_path(text))
