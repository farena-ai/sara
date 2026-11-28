"""Loading a policy document (docs/POLICY.md sections 1, 2 and 8)."""

import json

from .actions import parse_action_patterns
from .clock import parse_utc
from .conditions import parse_conditions
from .errors import PolicyError
from .model import Delegation, Policy, PrincipalEntry, Statement
from .names import check_object_id, check_principal_id, role_list, role_name
from .patterns import parse_resource_patterns
from .timewindow import parse_windows


def _object(value, what, where=None):
    if not isinstance(value, dict):
        raise PolicyError(f"{what} must be an object", where)
    return value


def _list(value, what, where=None):
    if not isinstance(value, list):
        raise PolicyError(f"{what} must be a list", where)
    return value


def _roles(doc):
    parents = {}
    for name, spec in _object(doc.get("roles", {}), "roles").items():
        where = f"role {name!r}"
        inherits = _list(_object(spec, "a role", where).get("inherits", []), "inherits", where)
        parents[role_name(name, where)] = tuple(inherits)
    return parents


def _principals(doc):
    out = {}
    for pid, spec in _object(doc.get("principals", {}), "principals").items():
        where = f"principal {pid!r}"
        check_principal_id(pid, where)
        _object(spec, "a principal", where)
        attrs = _object(spec.get("attributes", {}), "attributes", where)
        out[pid] = PrincipalEntry(pid, role_list(spec.get("roles", []), where), dict(attrs))
    return out


def _statement(spec, index):
    _object(spec, "a statement")
    where = f"statement {spec.get('id')!r}"
    sid = check_object_id(spec.get("id"), where)
    effect = spec.get("effect")
    if effect not in ("allow", "deny"):
        raise PolicyError(f"invalid effect {effect!r}", where)
    roles = role_list(spec.get("roles", []), where)
    principals = tuple(spec.get("principals", []))
    if not roles and not principals:
        raise PolicyError("a statement must name a role or a principal", where)
    actions = parse_action_patterns(spec.get("actions"), where)
    resources = parse_resource_patterns(spec.get("resources"), where)
    attributes, time = (), ()
    cond = spec.get("conditions", {})
    if "attributes" in cond:
        attributes = parse_conditions(cond["attributes"], where)
    if "time" in cond:
        time = parse_windows(cond["time"], where)
    return Statement(sid, effect, roles, principals, actions, resources, spec.get("priority", 0),
                     dict(spec.get("grants", {})), attributes, time, index)


def _delegation(spec):
    _object(spec, "a delegation")
    where = f"delegation {spec.get('id')!r}"
    did = check_object_id(spec.get("id"), where)
    try:
        expires = parse_utc(spec.get("expires"))
    except ValueError as e:
        raise PolicyError(str(e), where) from None
    actions = parse_action_patterns(spec["actions"], where) if "actions" in spec else None
    return Delegation(did, spec.get("from"), spec.get("to"), role_list(spec.get("roles", []), where), expires, actions)


def load_policy(doc):
    _object(doc, "a policy document")
    if doc.get("version") != 1:
        raise PolicyError(f"unsupported version {doc.get('version')!r}", "policy")
    statements = [_statement(s, i) for i, s in enumerate(_list(doc.get("statements", []), "statements"))]
    delegations = [_delegation(d) for d in _list(doc.get("delegations", []), "delegations")]
    return Policy(_roles(doc), _principals(doc), statements, delegations, doc.get("max_delegation_depth", 2))


def load_policy_file(path):
    with open(path, encoding="utf-8") as f:
        try:
            doc = json.load(f)
        except json.JSONDecodeError as e:
            raise PolicyError(f"not JSON: {e}", str(path)) from None
    return load_policy(doc)
