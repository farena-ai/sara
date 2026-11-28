"""Loading a policy document (docs/POLICY.md sections 1, 2 and 8)."""

import json

from .actions import parse_action_patterns
from .clock import parse_utc
from .conditions import is_scalar, parse_conditions
from .errors import PolicyError
from .model import Delegation, Policy, PrincipalEntry, Statement
from .names import check_object_id, check_principal_id, role_list, role_name
from .patterns import parse_resource_patterns
from .timewindow import parse_windows

TOP_KEYS = {"version", "max_delegation_depth", "roles", "principals", "statements", "delegations"}
STATEMENT_KEYS = {"id", "effect", "roles", "principals", "actions", "resources", "priority", "grants", "conditions"}
DELEGATION_KEYS = {"id", "from", "to", "roles", "expires", "actions"}
CONDITION_KEYS = {"attributes", "time"}


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _object(value, what, where=None):
    if not isinstance(value, dict):
        raise PolicyError(f"{what} must be an object", where)
    return value


def _list(value, what, where=None):
    if not isinstance(value, list):
        raise PolicyError(f"{what} must be a list", where)
    return value


def _unknown(obj, allowed, where):
    extra = sorted(str(k) for k in obj if k not in allowed)
    if extra:
        raise PolicyError(f"unknown keys {extra}", where)


def _roles(doc):
    parents = {}
    for name, spec in _object(doc.get("roles", {}), "roles").items():
        where = f"role {name!r}"
        key = role_name(name, where)
        if key in parents:
            raise PolicyError("role defined twice", where)
        _unknown(_object(spec, "a role", where), {"inherits"}, where)
        parents[key] = role_list(spec.get("inherits", []), where)
    return parents


def _principals(doc):
    out = {}
    for pid, spec in _object(doc.get("principals", {}), "principals").items():
        where = f"principal {pid!r}"
        check_principal_id(pid, where)
        _unknown(_object(spec, "a principal", where), {"roles", "attributes"}, where)
        attrs = _object(spec.get("attributes", {}), "attributes", where)
        for key, value in attrs.items():
            if not is_scalar(value):
                raise PolicyError(f"attribute {key!r} must be a scalar", where)
        out[pid] = PrincipalEntry(pid, role_list(spec.get("roles", []), where), dict(attrs))
    return out


def _statement(spec, index, seen):
    _object(spec, "a statement")
    where = f"statement {spec.get('id')!r}"
    _unknown(spec, STATEMENT_KEYS, where)
    sid = check_object_id(spec.get("id"), where)
    if sid in seen:
        raise PolicyError("duplicate statement id", where)
    seen.add(sid)
    effect = spec.get("effect")
    if effect not in ("allow", "deny"):
        raise PolicyError(f"invalid effect {effect!r}", where)
    roles = role_list(spec.get("roles", []), where)
    principals = tuple(check_principal_id(p, where) for p in _list(spec.get("principals", []), "principals", where))
    if not roles and not principals:
        raise PolicyError("a statement must name a role or a principal", where)
    if "actions" not in spec or "resources" not in spec:
        raise PolicyError("a statement needs actions and resources", where)
    actions = parse_action_patterns(spec["actions"], where)
    resources = parse_resource_patterns(spec["resources"], where)
    priority = spec.get("priority", 0)
    if not _is_int(priority):
        raise PolicyError("priority must be an integer", where)
    grants = {}
    if "grants" in spec:
        if effect == "deny":
            raise PolicyError("deny statements cannot have grants", where)
        for k, v in _object(spec["grants"], "grants", where).items():
            if not _is_int(v):
                raise PolicyError(f"grant {k!r} must be an integer", where)
            grants[k] = v
    attributes, time = (), ()
    if "conditions" in spec:
        cond = _object(spec["conditions"], "conditions", where)
        _unknown(cond, CONDITION_KEYS, where)
        if "attributes" in cond:
            attributes = parse_conditions(cond["attributes"], where)
        if "time" in cond:
            time = parse_windows(cond["time"], where)
    return Statement(sid, effect, roles, principals, actions, resources, priority, grants, attributes, time, index)


def _delegation(spec, seen):
    _object(spec, "a delegation")
    where = f"delegation {spec.get('id')!r}"
    _unknown(spec, DELEGATION_KEYS, where)
    did = check_object_id(spec.get("id"), where)
    if did in seen:
        raise PolicyError("duplicate delegation id", where)
    seen.add(did)
    source = check_principal_id(spec.get("from"), where)
    target = check_principal_id(spec.get("to"), where)
    roles = role_list(spec.get("roles"), where)
    if not roles:
        raise PolicyError("a delegation must pass at least one role", where)
    try:
        expires = parse_utc(spec.get("expires"))
    except ValueError as e:
        raise PolicyError(str(e), where) from None
    actions = parse_action_patterns(spec["actions"], where) if "actions" in spec else None
    return Delegation(did, source, target, roles, expires, actions)


def load_policy(doc):
    _object(doc, "a policy document")
    _unknown(doc, TOP_KEYS, "policy")
    version = doc.get("version")
    if not _is_int(version) or version != 1:
        raise PolicyError(f"unsupported version {version!r}", "policy")
    depth = doc.get("max_delegation_depth", 2)
    if not _is_int(depth) or depth < 0:
        raise PolicyError("max_delegation_depth must be an integer >= 0", "policy")
    seen = set()
    statements = [_statement(s, i, seen) for i, s in enumerate(_list(doc.get("statements", []), "statements"))]
    seen = set()
    delegations = [_delegation(d, seen) for d in _list(doc.get("delegations", []), "delegations")]
    return Policy(_roles(doc), _principals(doc), statements, delegations, depth)


def load_policy_file(path):
    with open(path, encoding="utf-8") as f:
        try:
            doc = json.load(f)
        except json.JSONDecodeError as e:
            raise PolicyError(f"not JSON: {e}", str(path)) from None
    return load_policy(doc)
