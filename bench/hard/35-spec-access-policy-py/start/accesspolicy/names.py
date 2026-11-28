"""Name syntax shared by the loader and the evaluator."""

import re

from .errors import PolicyError

PRINCIPAL_ID = re.compile(r"[A-Za-z0-9_.@-]+")
OBJECT_ID = re.compile(r"[A-Za-z0-9_.-]+")
ACTION = re.compile(r"[a-z0-9-]+:[a-z0-9-]+")
NAME_PART = re.compile(r"[a-z0-9-]+")


def is_principal_id(value):
    return isinstance(value, str) and PRINCIPAL_ID.fullmatch(value) is not None


def check_principal_id(value, where):
    if not is_principal_id(value):
        raise PolicyError(f"invalid principal id {value!r}", where)
    return value


def check_object_id(value, where):
    if not isinstance(value, str) or OBJECT_ID.fullmatch(value) is None:
        raise PolicyError(f"invalid id {value!r}", where)
    return value


def role_name(value, where):
    """A role name as stored by the loader."""
    if not isinstance(value, str) or value == "":
        raise PolicyError(f"invalid role name {value!r}", where)
    return value.lower()


def role_list(values, where):
    if not isinstance(values, list):
        raise PolicyError("roles must be a list", where)
    return tuple(role_name(v, where) for v in values)
