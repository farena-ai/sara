import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from accesspolicy import Evaluator, FixedClock, MemoryAuditSink, PolicyError, load_policy, utc  # noqa: E402

MON_10 = utc(2026, 11, 23, 10, 0, 0)
FRI = 27
SAT = 28


def doc(**kw):
    d = {"version": 1}
    d.update(kw)
    return d


def st(sid, effect="allow", **kw):
    d = {"id": sid, "effect": effect, "actions": ["docs:read"], "resources": ["/docs/**"]}
    if "roles" not in kw and "principals" not in kw:
        d["roles"] = ["reader"]
    d.update(kw)
    return d


READER = {"alice": {"roles": ["reader"]}}


def make(statements, principals=None, now=MON_10, **kw):
    policy = load_policy(doc(statements=statements, principals=READER if principals is None else principals, **kw))
    sink = MemoryAuditSink()
    return Evaluator(policy, FixedClock(now), sink), sink


class CountingClock:
    def __init__(self, start, step):
        self.instant = start
        self.step = step
        self.calls = 0

    def now(self):
        self.calls += 1
        value = self.instant
        self.instant = self.instant + timedelta(seconds=self.step)
        return value


class Documents(unittest.TestCase):
    def test_r01_document_shape_errors(self):
        for bad in [
            {"version": 1, "statement": []},
            {"version": 2},
            {},
            {"version": True},
            {"version": "1"},
            {"version": 1, "max_delegation_depth": "2"},
            {"version": 1, "max_delegation_depth": -1},
            {"version": 1, "statements": {}},
            {"version": 1, "roles": []},
        ]:
            with self.assertRaises(PolicyError, msg=repr(bad)):
                load_policy(bad)
        load_policy({"version": 1})

    def test_r01_malformed_parts_raise_policy_error_only(self):
        for bad in [
            doc(statements=[st("s1", actions="docs:read")]),
            doc(statements=[st("s1", resources=[5])]),
            doc(statements=["not an object"]),
            doc(principals={"alice": ["reader"]}),
            doc(principals={"alice": {"roles": ["reader"], "attributes": {"tags": ["a", "b"]}}}),
            doc(principals={"alice": {"role": ["reader"]}}),
            doc(statements=[st("s1", conditions=[])]),
            doc(roles={"a": {"inherits": "b"}}),
            doc(delegations=[{"id": "d1", "from": "a", "to": "b", "roles": ["x"], "expires": 5}]),
        ]:
            with self.assertRaises(PolicyError, msg=repr(bad)):
                load_policy(bad)

    def test_r02_statement_validation(self):
        bad_statements = [
            st("s1", "deny", grants={}),
            st("s1", grants={"rows": True}),
            st("s1", grants={"rows": 1.5}),
            st("s1", priority=True),
            st("s1", priority="1"),
            st("s1", effect="Allow"),
            st("s 1"),
            {"id": "s1", "effect": "allow", "roles": [], "principals": [], "actions": ["*"], "resources": ["/"]},
            {"id": "s1", "effect": "allow", "roles": ["r"], "resources": ["/"]},
            {"id": "s1", "effect": "allow", "roles": ["r"], "actions": [], "resources": ["/"]},
            st("s1", note="x"),
            st("s1", conditions={"attrs": {}}),
        ]
        for bad in bad_statements:
            with self.assertRaises(PolicyError, msg=repr(bad)):
                load_policy(doc(statements=[bad]))
        with self.assertRaises(PolicyError):
            load_policy(doc(statements=[st("s1"), st("s1")]))
        load_policy(doc(statements=[st("s1", grants={"rows": 10}), st("s2", principals=["bob"], roles=[])]))


class Roles(unittest.TestCase):
    def test_r03_unknown_principal_is_valid(self):
        ev, _ = make([st("s1", principals=["zed"], roles=[])])
        d = ev.evaluate("zed", "docs:read", "/docs/a")
        self.assertEqual((d.effect, d.statement), ("ALLOW", "s1"))
        d = ev.evaluate("yan", "docs:read", "/docs/a")
        self.assertEqual((d.effect, d.reason), ("DENY", "no-match"))

    def test_r03_r30_delegation_to_principal_not_in_directory(self):
        ev, _ = make([st("s1")], delegations=[{"id": "d1", "from": "alice", "to": "zed", "roles": ["reader"], "expires": "2027-01-01T00:00:00Z"}])
        d = ev.evaluate("zed", "docs:read", "/docs/a")
        self.assertEqual((d.effect, d.via), ("ALLOW", ("d1",)))

    def test_r04_role_names_are_case_insensitive(self):
        ev, _ = make(
            [st("s1", roles=["Viewer"])],
            principals={"alice": {"roles": ["EDITOR"]}},
            roles={"Editor": {"inherits": ["VIEWER"]}, "viewer": {}},
        )
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/a").allowed)

    def test_r04_role_defined_twice_after_lower_casing(self):
        with self.assertRaises(PolicyError):
            load_policy(doc(roles={"Admin": {}, "admin": {}}))
        with self.assertRaises(PolicyError):
            load_policy(doc(principals={"alice": {"roles": [""]}}))

    def test_r05_inheritance_is_transitive(self):
        ev, _ = make(
            [st("s1", roles=["base"])],
            principals={"alice": {"roles": ["lead"]}},
            roles={"lead": {"inherits": ["member"]}, "member": {"inherits": ["staff"]}, "staff": {"inherits": ["base"]}},
        )
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/a").allowed)
        with self.assertRaises(PolicyError):
            load_policy(doc(roles={"a": {"inherits": [], "extra": 1}}))

    def test_r06_cycles_and_undefined_roles(self):
        ev, _ = make(
            [st("s1", roles=["b"]), st("s2", roles=["ghost"], resources=["/ghost"])],
            principals={"alice": {"roles": ["a"]}, "bob": {"roles": ["ghost"]}},
            roles={"a": {"inherits": ["b", "phantom"]}, "b": {"inherits": ["a"]}},
        )
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/x").allowed)
        self.assertTrue(ev.evaluate("bob", "docs:read", "/ghost").allowed)
        self.assertFalse(ev.evaluate("bob", "docs:read", "/docs/x").allowed)

    def test_r07_r37_inheritance_distance_breaks_ties(self):
        roles = {"lead": {"inherits": ["member"]}, "member": {"inherits": ["staff"]}}
        principals = {"alice": {"roles": ["lead"]}}
        ev, _ = make([st("far", roles=["staff"]), st("near", roles=["member"]), st("own", roles=["lead"], resources=["/x"])], principals=principals, roles=roles)
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/a").statement, "near")
        ev, _ = make([st("far", roles=["staff"]), st("named", principals=["alice"], roles=[]), st("own", roles=["lead"])], principals=principals, roles=roles)
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/a").statement, "named")


class Requests(unittest.TestCase):
    def test_r08_invalid_requests_are_denied_not_raised(self):
        ev, sink = make([st("s1", resources=["/**"], actions=["*"])])
        for principal, action, resource in [
            ("bob smith", "docs:read", "/docs/a"),
            ("alice", "docs.read", "/docs/a"),
            ("alice", "docs:read:x", "/docs/a"),
            ("alice", "docs:read", "docs/a"),
            ("alice", "docs:read", "/docs/../a"),
            ("alice", "docs:read", "/docs/./a"),
            ("alice", "docs:read", None),
            (None, "docs:read", "/docs/a"),
            ("alice", 7, "/docs/a"),
        ]:
            d = ev.evaluate(principal, action, resource)
            self.assertEqual((d.effect, d.reason, d.statement, d.grants, d.via), ("DENY", "invalid-request", None, {}, ()), (principal, action, resource))
        self.assertEqual(len(sink.lines), 9)
        self.assertTrue(ev.evaluate("alice", "DOCS:Read", "/docs/a").allowed)

    def test_r09_normalisation(self):
        ev, sink = make([st("s1", resources=["/docs/a"]), st("root", resources=["/"], actions=["docs:list"])])
        d = ev.evaluate("alice", "docs:READ", "//docs///a/")
        self.assertEqual(d.statement, "s1")
        self.assertIn(" action=docs:read resource=/docs/a ", sink.lines[-1])
        self.assertEqual(ev.evaluate("alice", "docs:read", "/Docs/a").reason, "no-match")
        self.assertEqual(ev.evaluate("alice", "docs:list", "///").statement, "root")


class Actions(unittest.TestCase):
    def test_r10_action_pattern_forms(self):
        for bad in ["docs:re*", "*:read", "docs", "docs:", ":read", "docs:read:x", "do cs:read", "**"]:
            with self.assertRaises(PolicyError, msg=bad):
                load_policy(doc(statements=[st("s1", actions=[bad])]))
        ev, _ = make([st("s1", actions=["DOCS:*"])])
        self.assertTrue(ev.evaluate("alice", "docs:write", "/docs/a").allowed)
        self.assertFalse(ev.evaluate("alice", "doc:write", "/docs/a").allowed)

    def test_r11_action_specificity(self):
        ev, _ = make([
            st("any", actions=["*"], grants={"level": 0}),
            st("svc", actions=["docs:*"], grants={"level": 1}),
            st("exact", actions=["docs:read"], grants={"level": 2}),
        ])
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/a").statement, "exact")
        self.assertEqual(ev.evaluate("alice", "docs:write", "/docs/a").statement, "svc")
        self.assertEqual(ev.evaluate("alice", "mail:send", "/docs/a").grants, {"level": 0})


class Patterns(unittest.TestCase):
    def test_r12_literal_segments_and_bad_patterns(self):
        ev, _ = make([st("s1", resources=["/Docs/Plan.txt"])])
        self.assertTrue(ev.evaluate("alice", "docs:read", "/Docs/Plan.txt").allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/docs/plan.txt").allowed)
        for bad in ["docs/a", "/docs/../a", "/docs/./a", "/home/{user}", "/home/{principal}x", "/a/{b"]:
            with self.assertRaises(PolicyError, msg=bad):
                load_policy(doc(statements=[st("s1", resources=[bad])]))

    def test_r13_single_wildcard(self):
        ev, _ = make([st("s1", resources=["/docs/*"])])
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/a").allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/docs").allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/docs/a/b").allowed)

    def test_r14_partial_wildcard(self):
        ev, _ = make([st("s1", resources=["/reports/q*-*.csv"]), st("s2", resources=["/raw/a.b+c*"])])
        self.assertTrue(ev.evaluate("alice", "docs:read", "/reports/q1-2026.csv").allowed)
        self.assertTrue(ev.evaluate("alice", "docs:read", "/reports/q-.csv").allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/reports/Q1-2026.csv").allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/reports/q1-2026.csv/x").allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/reports/q12026.csv").allowed)
        self.assertTrue(ev.evaluate("alice", "docs:read", "/raw/a.b+c").allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/raw/aXb+c").allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/raw/a.bbc").allowed)
        for bad in ["/a/b**", "/a/**b/c", "/a/x**y"]:
            with self.assertRaises(PolicyError, msg=bad):
                load_policy(doc(statements=[st("s1", resources=[bad])]))

    def test_r15_double_wildcard(self):
        ev, _ = make([st("s1", resources=["/docs/**"]), st("all", resources=["/**"], actions=["docs:list"])])
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs").allowed)
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/a/b/c").allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/doc").allowed)
        self.assertTrue(ev.evaluate("alice", "docs:list", "/").allowed)
        with self.assertRaises(PolicyError):
            load_policy(doc(statements=[st("s1", resources=["/a/**/b"])]))

    def test_r16_principal_placeholder(self):
        ev, _ = make([st("home", resources=["/home/{principal}/**"])], principals={"alice": {"roles": ["reader"]}, "Bob": {"roles": ["reader"]}})
        self.assertTrue(ev.evaluate("alice", "docs:read", "/home/alice/notes").allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/home/bob/notes").allowed)
        self.assertTrue(ev.evaluate("Bob", "docs:read", "/home/Bob").allowed)
        self.assertFalse(ev.evaluate("Bob", "docs:read", "/home/bob").allowed)

    def test_r17_pattern_specificity_order(self):
        patterns = ["/**", "/docs/**", "/*/a", "/docs/*", "/docs/a*", "/docs/a/**", "/docs/a"]
        statements = [st(f"s{i}", resources=[p]) for i, p in enumerate(patterns)]
        expected = ["s0", "s1", "s2", "s3", "s4", "s5", "s6"]
        for n in range(1, len(patterns) + 1):
            ev, _ = make(list(reversed(statements[:n])))
            self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/a").statement, expected[n - 1], patterns[:n])

    def test_r17_more_literals_beat_fewer_wildcards(self):
        ev, _ = make([st("wild", resources=["/a/*/c/*"]), st("lit", resources=["/a/b/**"])])
        self.assertEqual(ev.evaluate("alice", "docs:read", "/a/b/c/d").statement, "wild")
        ev, _ = make([st("partials", resources=["/a/b*/c*/d*"]), st("lits", resources=["/a/bb/cc/*"])])
        self.assertEqual(ev.evaluate("alice", "docs:read", "/a/bb/cc/dd").statement, "lits")

    def test_r18_best_matching_pattern_of_a_statement(self):
        ev, _ = make([
            st("plain", resources=["/docs/*"], actions=["docs:read"]),
            st("multi", resources=["/**", "/docs/a"], actions=["*"]),
        ])
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/a").statement, "multi")
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/b").statement, "plain")
        ev, _ = make([st("one", actions=["docs:*"]), st("two", actions=["*", "docs:read"])])
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/b").statement, "two")
        self.assertEqual(ev.evaluate("alice", "docs:write", "/docs/b").statement, "one")


class Conditions(unittest.TestCase):
    def test_r19_attribute_keys(self):
        for bad in [{"user.dept": "eng"}, {"principal.": "eng"}, {"dept": "eng"}, {"Context.x": 1}]:
            with self.assertRaises(PolicyError, msg=repr(bad)):
                load_policy(doc(statements=[st("s1", conditions={"attributes": bad})]))
        ev, _ = make([st("s1", conditions={"attributes": {"principal.dept": "eng", "context.site": "hq"}})],
                     principals={"alice": {"roles": ["reader"], "attributes": {"dept": "eng", "site": "branch"}}, "bob": {"roles": ["reader"]}})
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/a", {"site": "hq"}).allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/docs/a", {"site": "branch"}).allowed)
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/a", {"site": "hq", "dept": "ops"}).allowed)
        self.assertFalse(ev.evaluate("bob", "docs:read", "/docs/a", {"site": "hq", "dept": "eng"}).allowed)

    def test_r20_operators(self):
        ev, _ = make([
            st("range", conditions={"attributes": {"context.level": {"gte": 2, "lte": 4}}}),
            st("listed", resources=["/x"], conditions={"attributes": {"context.site": {"in": ["hq", "lab"]}}}),
            st("never", resources=["/y"], conditions={"attributes": {"context.site": {"in": []}}}),
        ])
        self.assertEqual([ev.evaluate("alice", "docs:read", "/docs/a", {"level": n}).allowed for n in (1, 2, 4, 5)], [False, True, True, False])
        self.assertTrue(ev.evaluate("alice", "docs:read", "/x", {"site": "lab"}).allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/x", {"site": "home"}).allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/y", {"site": "hq"}).allowed)
        for bad in [{"between": [1, 2]}, {}, {"eq": [1]}, {"in": "hq"}, {"gte": "2"}, {"gte": True}, {"present": 1}, ["a"]]:
            with self.assertRaises(PolicyError, msg=repr(bad)):
                load_policy(doc(statements=[st("s1", conditions={"attributes": {"context.x": bad}})]))

    def test_r21_equality_is_type_strict(self):
        ev, _ = make([st("one", conditions={"attributes": {"context.v": 1}}),
                      st("yes", resources=["/x"], conditions={"attributes": {"context.v": True}}),
                      st("in", resources=["/y"], conditions={"attributes": {"context.v": {"in": ["1", 0]}}})])
        self.assertEqual([ev.evaluate("alice", "docs:read", "/docs/a", {"v": v}).allowed for v in (1, 1.0, "1", True)], [True, True, False, False])
        self.assertEqual([ev.evaluate("alice", "docs:read", "/x", {"v": v}).allowed for v in (True, 1, "true")], [True, False, False])
        self.assertEqual([ev.evaluate("alice", "docs:read", "/y", {"v": v}).allowed for v in ("1", 1, 0, False, 0.0)], [True, False, True, False, True])

    def test_r22_ordering_needs_numbers(self):
        ev, _ = make([st("s1", conditions={"attributes": {"context.n": {"gte": 1}}})])
        self.assertEqual([ev.evaluate("alice", "docs:read", "/docs/a", {"n": v}).allowed for v in (1, 1.5, "5", True, None, 0)], [True, True, False, False, False, False])

    def test_r23_missing_versus_null(self):
        ev, _ = make([
            st("has", conditions={"attributes": {"context.t": {"present": True}}}),
            st("lacks", resources=["/x"], conditions={"attributes": {"context.t": {"present": False}}}),
            st("null", resources=["/y"], conditions={"attributes": {"context.t": None}}),
        ])
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/a", {"t": None}).allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/docs/a", {}).allowed)
        self.assertTrue(ev.evaluate("alice", "docs:read", "/x", {}).allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/x", {"t": None}).allowed)
        self.assertTrue(ev.evaluate("alice", "docs:read", "/y", {"t": None}).allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/y", {}).allowed)

    def test_r24_deny_fails_closed_on_missing_attributes(self):
        statements = [
            st("open", resources=["/docs/**"]),
            st("no-mfa", "deny", resources=["/docs/secret/**"], conditions={"attributes": {"context.mfa": False}}),
        ]
        ev, _ = make(statements)
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/secret/x").reason, "explicit-deny")
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/secret/x", {"mfa": False}).reason, "explicit-deny")
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/secret/x", {"mfa": True}).allowed)

    def test_r24_fail_closed_only_for_missing(self):
        ev, _ = make([
            st("open", resources=["/**"]),
            st("low", "deny", conditions={"attributes": {"context.level": {"lte": 2}}}),
            st("needs-tag", "deny", resources=["/t/**"], conditions={"attributes": {"context.tag": {"present": True}}}),
        ])
        self.assertFalse(ev.evaluate("alice", "docs:read", "/docs/a").allowed)
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/a", {"level": "1"}).allowed)
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/a", {"level": 3}).allowed)
        self.assertTrue(ev.evaluate("alice", "docs:read", "/t/a").allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/t/a", {"tag": None}).allowed)


def windowed(windows, now):
    ev, _ = make([st("s1", conditions={"time": windows})], now=now)
    return ev.evaluate("alice", "docs:read", "/docs/a").allowed


class Windows(unittest.TestCase):
    def test_r25_days_and_offset(self):
        w = [{"days": ["mon"], "start": "09:00", "end": "17:00", "tz_offset": "+02:00"}]
        self.assertFalse(windowed(w, utc(2026, 11, 23, 6, 59, 59)))
        self.assertTrue(windowed(w, utc(2026, 11, 23, 7, 0, 0)))
        self.assertFalse(windowed(w, utc(2026, 11, 23, 15, 0, 0)))
        self.assertTrue(windowed([{"start": "00:00", "end": "01:00", "days": ["tue"], "tz_offset": "+05:30"}], utc(2026, 11, 23, 19, 0)))
        self.assertTrue(windowed([{"start": "09:00", "end": "10:00"}], utc(2026, 11, 29, 9, 30)))
        self.assertTrue(windowed([{"start": "01:00", "end": "02:00"}, {"start": "09:30", "end": "10:30"}], MON_10))

    def test_r25_window_validation(self):
        for bad in [[], [{"start": "25:00", "end": "26:00"}], [{"start": "24:00", "end": "23:00"}], [{"start": "9:00", "end": "17:00"}],
                    [{"start": "09:00"}], [{"start": "09:00", "end": "17:00", "days": []}], [{"start": "09:00", "end": "17:00", "days": ["Mon"]}],
                    [{"start": "09:00", "end": "17:00", "tz": "+01:00"}], [{"start": "09:00", "end": "17:00", "tz_offset": "+1:00"}], {"start": "09:00", "end": "10:00"}]:
            with self.assertRaises(PolicyError, msg=repr(bad)):
                load_policy(doc(statements=[st("s1", conditions={"time": bad})]))

    def test_r26_half_open_boundaries(self):
        w = [{"start": "09:00", "end": "17:00"}]
        self.assertTrue(windowed(w, utc(2026, 11, 23, 9, 0, 0)))
        self.assertFalse(windowed(w, utc(2026, 11, 23, 8, 59, 59, 999999)))
        self.assertTrue(windowed(w, utc(2026, 11, 23, 16, 59, 59, 999999)))
        self.assertFalse(windowed(w, utc(2026, 11, 23, 17, 0, 0)))
        late = [{"start": "20:00", "end": "24:00", "days": ["mon"]}]
        self.assertTrue(windowed(late, utc(2026, 11, 23, 23, 59, 59)))
        self.assertFalse(windowed(late, utc(2026, 11, 24, 0, 0, 0)))

    def test_r27_overnight_windows(self):
        w = [{"days": ["fri"], "start": "22:00", "end": "06:00"}]
        self.assertTrue(windowed(w, utc(2026, 11, FRI, 23, 0)))
        self.assertTrue(windowed(w, utc(2026, 11, SAT, 5, 59, 59)))
        self.assertFalse(windowed(w, utc(2026, 11, SAT, 6, 0)))
        self.assertFalse(windowed(w, utc(2026, 11, FRI, 3, 0)))
        self.assertFalse(windowed(w, utc(2026, 11, SAT, 23, 0)))

    def test_r27_equal_start_and_end_is_a_full_day(self):
        w = [{"days": ["mon"], "start": "08:00", "end": "08:00"}]
        self.assertTrue(windowed(w, utc(2026, 11, 23, 8, 0)))
        self.assertTrue(windowed(w, utc(2026, 11, 24, 7, 59, 59)))
        self.assertFalse(windowed(w, utc(2026, 11, 24, 8, 0)))
        self.assertFalse(windowed(w, utc(2026, 11, 23, 7, 59)))

    def test_r25_r27_overnight_with_negative_offset(self):
        w = [{"days": ["sun"], "start": "23:00", "end": "01:00", "tz_offset": "-05:00"}]
        self.assertTrue(windowed(w, utc(2026, 11, 30, 4, 30)))
        self.assertTrue(windowed(w, utc(2026, 11, 30, 5, 30)))
        self.assertFalse(windowed(w, utc(2026, 11, 30, 6, 0)))
        self.assertFalse(windowed(w, utc(2026, 11, 29, 4, 30)))

    def test_r28_clock_is_read_once(self):
        policy = load_policy(doc(principals=READER, statements=[st("s1", conditions={"time": [{"start": "09:00", "end": "10:00"}]})]))
        clock = CountingClock(utc(2026, 11, 23, 9, 59, 59), 5)
        sink = MemoryAuditSink()
        d = Evaluator(policy, clock, sink).evaluate("alice", "docs:read", "/docs/a")
        self.assertEqual(clock.calls, 1)
        self.assertTrue(d.allowed)
        self.assertTrue(d.record.startswith("2026-11-23T09:59:59Z ALLOW "))

    def test_r28_naive_and_offset_clock_values(self):
        policy = load_policy(doc(principals=READER, statements=[st("s1")]))
        d = Evaluator(policy, FixedClock(datetime(2026, 11, 23, 10, 0, 0))).evaluate("alice", "docs:read", "/docs/a")
        self.assertTrue(d.record.startswith("2026-11-23T10:00:00Z "))
        plus2 = timezone(timedelta(hours=2))
        d = Evaluator(policy, FixedClock(datetime(2026, 11, 24, 1, 30, 0, tzinfo=plus2))).evaluate("alice", "docs:read", "/docs/a")
        self.assertTrue(d.record.startswith("2026-11-23T23:30:00Z "))


def delegation(did, frm, to, roles, expires="2027-01-01T00:00:00Z", **kw):
    d = {"id": did, "from": frm, "to": to, "roles": roles, "expires": expires}
    d.update(kw)
    return d


TEAM = {"alice": {"roles": ["editor"]}, "bob": {}, "carol": {}, "dave": {}, "erin": {"roles": ["editor"]}}
EDITOR = {"editor": {"inherits": ["reader"]}}


class Delegations(unittest.TestCase):
    def test_r29_expiry_is_exclusive(self):
        dl = [delegation("d1", "alice", "bob", ["editor"], expires="2026-11-23T10:00:00Z")]
        ev, _ = make([st("s1")], principals=TEAM, roles=EDITOR, delegations=dl, now=utc(2026, 11, 23, 9, 59, 59, 999999))
        self.assertTrue(ev.evaluate("bob", "docs:read", "/docs/a").allowed)
        ev, _ = make([st("s1")], principals=TEAM, roles=EDITOR, delegations=dl, now=utc(2026, 11, 23, 10, 0, 0))
        self.assertFalse(ev.evaluate("bob", "docs:read", "/docs/a").allowed)

    def test_r29_delegation_validation(self):
        for bad in [
            [delegation("d1", "alice", "bob", ["editor"], expires="2027-01-01T00:00:00")],
            [delegation("d1", "alice", "bob", ["editor"], expires="2027-01-01 00:00:00Z")],
            [delegation("d1", "alice", "bob", [])],
            [delegation("d1", "alice", "bob", ["editor"], actions=[])],
            [delegation("d1", "alice", "bob", ["editor"], note="x")],
            [delegation("d1", "alice", "bob", ["editor"]), delegation("d1", "alice", "carol", ["editor"])],
            [delegation("d 1", "alice", "bob", ["editor"])],
        ]:
            with self.assertRaises(PolicyError, msg=repr(bad)):
                load_policy(doc(delegations=bad))

    def test_r29_action_filter(self):
        dl = [delegation("d1", "alice", "bob", ["editor"], actions=["docs:read"])]
        ev, _ = make([st("s1", roles=["editor"], actions=["docs:*"])], principals=TEAM, roles=EDITOR, delegations=dl)
        self.assertTrue(ev.evaluate("bob", "docs:read", "/docs/a").allowed)
        self.assertFalse(ev.evaluate("bob", "docs:write", "/docs/a").allowed)
        self.assertTrue(ev.evaluate("alice", "docs:write", "/docs/a").allowed)

    def test_r29_r31_filtered_link_breaks_the_chain(self):
        dl = [delegation("d1", "alice", "bob", ["editor"], actions=["docs:read"]), delegation("d2", "bob", "carol", ["editor"])]
        ev, _ = make([st("s1", roles=["editor"], actions=["docs:*"])], principals=TEAM, roles=EDITOR, delegations=dl)
        self.assertTrue(ev.evaluate("carol", "docs:read", "/docs/a").allowed)
        self.assertFalse(ev.evaluate("carol", "docs:write", "/docs/a").allowed)

    def test_r30_only_held_roles_pass(self):
        dl = [delegation("d1", "bob", "carol", ["editor"]), delegation("d2", "alice", "dave", ["reader", "admin"])]
        ev, _ = make([st("s1", roles=["reader"]), st("adm", roles=["admin"], resources=["/admin/**"])], principals=TEAM, roles=EDITOR, delegations=dl)
        self.assertFalse(ev.evaluate("carol", "docs:read", "/docs/a").allowed)
        self.assertTrue(ev.evaluate("dave", "docs:read", "/docs/a").allowed)
        self.assertFalse(ev.evaluate("dave", "docs:read", "/admin/a").allowed)

    def test_r30_delegate_gets_inherited_roles_with_distance_from_delegated_role(self):
        roles = {"editor": {"inherits": ["reader"]}, "reader": {"inherits": ["guest"]}}
        dl = [delegation("d1", "alice", "bob", ["reader"])]
        ev, _ = make([st("g", roles=["guest"]), st("r", roles=["reader"]), st("e", roles=["editor"])], principals=TEAM, roles=roles, delegations=dl)
        d = ev.evaluate("bob", "docs:read", "/docs/a")
        self.assertEqual((d.statement, d.via), ("r", ("d1",)))
        ev, _ = make([st("g", roles=["guest"])], principals=TEAM, roles=roles, delegations=dl)
        self.assertEqual(ev.evaluate("bob", "docs:read", "/docs/a").via, ("d1",))

    def test_r31_depth_limit(self):
        dl = [delegation("d1", "alice", "bob", ["editor"]), delegation("d2", "bob", "carol", ["editor"]), delegation("d3", "carol", "dave", ["editor"])]
        ev, _ = make([st("s1")], principals=TEAM, roles=EDITOR, delegations=dl)
        self.assertEqual(ev.evaluate("carol", "docs:read", "/docs/a").via, ("d1", "d2"))
        self.assertFalse(ev.evaluate("dave", "docs:read", "/docs/a").allowed)
        ev, _ = make([st("s1")], principals=TEAM, roles=EDITOR, delegations=dl, max_delegation_depth=3)
        self.assertEqual(ev.evaluate("dave", "docs:read", "/docs/a").via, ("d1", "d2", "d3"))
        ev, _ = make([st("s1")], principals=TEAM, roles=EDITOR, delegations=dl, max_delegation_depth=0)
        self.assertFalse(ev.evaluate("bob", "docs:read", "/docs/a").allowed)
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/a").allowed)

    def test_r29_r31_expired_link_breaks_downstream(self):
        dl = [delegation("d1", "alice", "bob", ["editor"], expires="2026-11-23T09:00:00Z"), delegation("d2", "bob", "carol", ["editor"])]
        ev, _ = make([st("s1")], principals=TEAM, roles=EDITOR, delegations=dl)
        self.assertFalse(ev.evaluate("bob", "docs:read", "/docs/a").allowed)
        self.assertFalse(ev.evaluate("carol", "docs:read", "/docs/a").allowed)

    def test_r31_shorter_chain_survives_the_limit(self):
        dl = [delegation("d1", "alice", "bob", ["editor"]), delegation("d2", "bob", "carol", ["editor"]),
              delegation("d3", "carol", "dave", ["editor"]), delegation("d4", "erin", "carol", ["editor"])]
        ev, _ = make([st("s1")], principals=TEAM, roles=EDITOR, delegations=dl)
        self.assertEqual(ev.evaluate("carol", "docs:read", "/docs/a").via, ("d4",))
        self.assertEqual(ev.evaluate("dave", "docs:read", "/docs/a").via, ("d4", "d3"))

    def test_r32_own_holding_beats_delegated(self):
        roles = {"lead": {"inherits": ["staff"]}, "staff": {"inherits": ["editor"]}, "editor": {}}
        principals = {"alice": {"roles": ["editor"]}, "bob": {"roles": ["lead"]}}
        dl = [delegation("d1", "alice", "bob", ["editor"])]
        ev, _ = make([st("s1", roles=["editor"])], principals=principals, roles=roles, delegations=dl)
        self.assertEqual(ev.evaluate("bob", "docs:read", "/docs/a").via, ())

    def test_r32_smallest_chain_string_and_derived_holdings(self):
        principals = {"xavier": {"roles": ["editor"]}, "yara": {"roles": ["editor"]}}
        dl = [delegation("k2", "xavier", "bob", ["editor"]), delegation("k10", "yara", "bob", ["editor"]), delegation("a9", "bob", "carol", ["editor"])]
        ev, sink = make([st("s1", roles=["editor"])], principals=principals, delegations=dl)
        self.assertEqual(ev.evaluate("bob", "docs:read", "/docs/a").via, ("k10",))
        self.assertEqual(ev.evaluate("carol", "docs:read", "/docs/a").via, ("k10", "a9"))
        self.assertTrue(sink.lines[-1].endswith(" via=k10>a9"))

    def test_r32_depth_before_inheritance_distance(self):
        roles = {"lead": {"inherits": ["staff"]}, "staff": {"inherits": ["editor"]}, "editor": {}}
        principals = {"alice": {"roles": ["lead"]}, "bob": {"roles": ["editor"]}}
        dl = [delegation("d1", "bob", "carol", ["editor"]), delegation("d0", "alice", "carol", ["lead"])]
        ev, _ = make([st("s1", roles=["editor"])], principals=principals, roles=roles, delegations=dl)
        self.assertEqual(ev.evaluate("carol", "docs:read", "/docs/a").via, ("d1",))
        dl = [delegation("d1", "alice", "bob", ["lead"]), delegation("d2", "bob", "carol", ["editor"]), delegation("d0", "dave", "carol", ["editor"])]
        principals = {"alice": {"roles": ["lead"]}, "dave": {"roles": ["editor"]}}
        ev, _ = make([st("s1", roles=["editor"])], principals=principals, roles=roles, delegations=dl)
        self.assertEqual(ev.evaluate("carol", "docs:read", "/docs/a").via, ("d0",))

    def test_r33_delegation_passes_roles_only(self):
        principals = {"alice": {"roles": ["editor"], "attributes": {"dept": "eng"}}, "bob": {}}
        dl = [delegation("d1", "alice", "bob", ["editor"])]
        ev, _ = make([
            st("mine", principals=["alice"], roles=[], resources=["/private/**"]),
            st("eng", roles=["editor"], resources=["/eng/**"], conditions={"attributes": {"principal.dept": "eng"}}),
            st("home", roles=["editor"], resources=["/home/{principal}/**"]),
        ], principals=principals, delegations=dl)
        self.assertFalse(ev.evaluate("bob", "docs:read", "/private/a").allowed)
        self.assertFalse(ev.evaluate("bob", "docs:read", "/eng/a").allowed)
        self.assertTrue(ev.evaluate("alice", "docs:read", "/eng/a").allowed)
        self.assertFalse(ev.evaluate("bob", "docs:read", "/home/alice/a").allowed)
        self.assertTrue(ev.evaluate("bob", "docs:read", "/home/bob/a").allowed)

    def test_r33_r36_deny_bound_to_delegated_role(self):
        principals = {"alice": {"roles": ["contractor"]}, "bob": {"roles": ["reader"]}}
        dl = [delegation("d1", "alice", "bob", ["contractor"])]
        ev, _ = make([st("read", resources=["/docs/**"]), st("block", "deny", roles=["contractor"], resources=["/docs/hr/**"])], principals=principals, delegations=dl)
        d = ev.evaluate("bob", "docs:read", "/docs/hr/pay")
        self.assertEqual((d.effect, d.reason, d.statement, d.via), ("DENY", "explicit-deny", "block", ("d1",)))
        self.assertTrue(ev.evaluate("bob", "docs:read", "/docs/eng").allowed)

    def test_r04_r30_delegated_role_names_are_lower_cased(self):
        dl = [delegation("d1", "alice", "bob", ["EDITOR"])]
        ev, _ = make([st("s1", roles=["Reader"])], principals=TEAM, roles={"Editor": {"inherits": ["READER"]}}, delegations=dl)
        self.assertTrue(ev.evaluate("bob", "docs:read", "/docs/a").allowed)


class Decisions(unittest.TestCase):
    def test_r34_all_parts_must_match(self):
        ev, _ = make([st("s1", conditions={"attributes": {"context.ok": True}, "time": [{"start": "09:00", "end": "11:00"}]})])
        self.assertTrue(ev.evaluate("alice", "docs:read", "/docs/a", {"ok": True}).allowed)
        self.assertFalse(ev.evaluate("alice", "docs:write", "/docs/a", {"ok": True}).allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/mail/a", {"ok": True}).allowed)
        self.assertFalse(ev.evaluate("alice", "docs:read", "/docs/a", {"ok": False}).allowed)
        self.assertFalse(ev.evaluate("bob", "docs:read", "/docs/a", {"ok": True}).allowed)
        ev, _ = make([st("s1", conditions={"attributes": {"context.ok": True}, "time": [{"start": "11:00", "end": "12:00"}]})])
        self.assertFalse(ev.evaluate("alice", "docs:read", "/docs/a", {"ok": True}).allowed)

    def test_r35_default_deny(self):
        ev, sink = make([st("s1", resources=["/docs/a"])])
        d = ev.evaluate("alice", "docs:read", "/docs/b")
        self.assertEqual((d.effect, d.reason, d.statement, d.grants, d.via), ("DENY", "no-match", None, {}, ()))
        self.assertTrue(sink.lines[-1].endswith(" reason=no-match statement=- via=-"))

    def test_r36_explicit_deny_beats_more_specific_allow(self):
        ev, _ = make([
            st("exact", resources=["/docs/a"], priority=100, grants={"rows": 5}),
            st("wide-deny", "deny", resources=["/**"], actions=["*"], roles=["reader"]),
        ])
        d = ev.evaluate("alice", "docs:read", "/docs/a")
        self.assertEqual((d.effect, d.reason, d.statement, d.grants), ("DENY", "explicit-deny", "wide-deny", {}))

    def test_r36_r38_best_deny_is_reported(self):
        ev, _ = make([
            st("deny-wide", "deny", resources=["/**"]),
            st("deny-docs", "deny", resources=["/docs/*"]),
            st("deny-pri", "deny", resources=["/docs/*"], priority=3),
            st("allow", resources=["/docs/a"]),
        ])
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/a").statement, "deny-pri")
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/a/b").statement, "deny-wide")

    def test_r37_binding_distance_and_via(self):
        principals = {"alice": {"roles": ["editor"]}, "bob": {"roles": ["staff"]}}
        roles = {"staff": {"inherits": ["member"]}}
        dl = [delegation("d1", "alice", "bob", ["editor"])]
        ev, _ = make([st("s1", roles=["editor", "member"])], principals=principals, roles=roles, delegations=dl)
        self.assertEqual(ev.evaluate("bob", "docs:read", "/docs/a").via, ())
        ev, _ = make([st("s1", roles=["editor", "staff"])], principals={"alice": {"roles": ["editor"]}, "bob": {"roles": ["lead"]}},
                     roles={"lead": {"inherits": ["x"]}, "x": {"inherits": ["staff"]}}, delegations=dl)
        self.assertEqual(ev.evaluate("bob", "docs:read", "/docs/a").via, ("d1",))
        ev, _ = make([st("s1", roles=["editor"], principals=["bob"])], principals=principals, delegations=dl)
        self.assertEqual(ev.evaluate("bob", "docs:read", "/docs/a").via, ())

    def test_r37_r38_delegated_role_is_farther_than_own_role(self):
        principals = {"alice": {"roles": ["editor"]}, "bob": {"roles": ["reader"]}}
        dl = [delegation("d1", "alice", "bob", ["editor"])]
        ev, _ = make([st("by-editor", roles=["editor"], grants={"rows": 50}), st("by-reader", roles=["reader"], grants={"rows": 10})], principals=principals, delegations=dl)
        d = ev.evaluate("bob", "docs:read", "/docs/a")
        self.assertEqual((d.statement, d.grants, d.via), ("by-reader", {"rows": 10}, ()))

    def test_r38_selection_order(self):
        roles = {"lead": {"inherits": ["staff"]}}
        principals = {"alice": {"roles": ["lead"]}}
        ev, _ = make([st("near", roles=["lead"]), st("pri", roles=["staff"], priority=1)], principals=principals, roles=roles)
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/a").statement, "pri")
        ev, _ = make([st("pri", roles=["lead"], priority=9, actions=["docs:*"]), st("act", roles=["staff"])], principals=principals, roles=roles)
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/a").statement, "act")
        ev, _ = make([st("act", roles=["lead"], priority=9, resources=["/docs/*"]), st("res", roles=["staff"], actions=["*"], resources=["/docs/a"])], principals=principals, roles=roles)
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/a").statement, "res")
        ev, _ = make([st("first", roles=["lead"], priority=-1), st("second", roles=["lead"], priority=-1)], principals=principals, roles=roles)
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/a").statement, "first")

    def test_r38_grants_are_a_copy_and_never_merged(self):
        ev, _ = make([st("wide", grants={"rows": 10, "export": 1}), st("narrow", resources=["/docs/a"], grants={"rows": 100}), st("bare", resources=["/docs/b"])])
        d = ev.evaluate("alice", "docs:read", "/docs/a")
        self.assertEqual(d.grants, {"rows": 100})
        d.grants["rows"] = 0
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/a").grants, {"rows": 100})
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/b").grants, {})


class Audit(unittest.TestCase):
    def test_r39_one_record_per_evaluation(self):
        ev, sink = make([st("s1"), st("d", "deny", resources=["/docs/x"])])
        decisions = [ev.evaluate("alice", "docs:read", r) for r in ("/docs/a", "/docs/x", "/mail", "bad")]
        self.assertEqual(len(sink.lines), 4)
        self.assertEqual([d.record for d in decisions], sink.lines)
        policy = load_policy(doc(principals=READER, statements=[st("s1")]))
        d = Evaluator(policy, FixedClock(MON_10)).evaluate("alice", "docs:read", "/docs/a")
        self.assertTrue(d.record)

    def test_r40_exact_line(self):
        dl = [delegation("d1", "alice", "bob", ["reader"])]
        ev, sink = make([st("s1")], delegations=dl, now=utc(2026, 11, 23, 10, 5, 9, 999999))
        ev.evaluate("bob", "Docs:Read", "/docs//a/")
        self.assertEqual(sink.lines[-1], "2026-11-23T10:05:09Z ALLOW principal=bob action=docs:read resource=/docs/a reason=allow statement=s1 via=d1")
        ev.evaluate("alice", "docs:read", "/mail")
        self.assertEqual(sink.lines[-1], "2026-11-23T10:05:09Z DENY principal=alice action=docs:read resource=/mail reason=no-match statement=- via=-")
        self.assertNotIn("\n", "".join(sink.lines))

    def test_r40_percent_encoding(self):
        ev, sink = make([st("s1")])
        ev.evaluate("alice", "docs:read", "/docs/café menu/100%")
        self.assertIn(" resource=/docs/caf%C3%A9%20menu/100%25 ", sink.lines[-1])
        ev.evaluate("alice", "docs:read", "/docs/tab\there")
        self.assertIn(" resource=/docs/tab%09here ", sink.lines[-1])

    def test_r08_r40_invalid_request_record(self):
        ev, sink = make([st("s1")], now=utc(2026, 11, 23, 8, 0, 1, 500000))
        ev.evaluate("bad id", "Docs:READ", "/docs/../x")
        self.assertEqual(sink.lines[-1], "2026-11-23T08:00:01Z DENY principal=bad%20id action=Docs:READ resource=/docs/../x reason=invalid-request statement=- via=-")
        ev.evaluate("", None, 42)
        self.assertEqual(sink.lines[-1], "2026-11-23T08:00:01Z DENY principal=- action=- resource=- reason=invalid-request statement=- via=-")
        ev.evaluate("alice", "docs:read", "//docs//")
        self.assertIn(" resource=/docs ", sink.lines[-1])

    def test_r08_r28_invalid_request_reads_clock_once(self):
        policy = load_policy(doc(principals=READER, statements=[st("s1")]))
        clock = CountingClock(utc(2026, 11, 23, 9, 0, 0), 1)
        Evaluator(policy, clock, MemoryAuditSink()).evaluate("alice", "docs read", "/docs/a")
        self.assertEqual(clock.calls, 1)


class Interactions(unittest.TestCase):
    def test_r24_r36_r38_fail_closed_deny_beats_specific_allow(self):
        ev, _ = make([
            st("exact", resources=["/docs/report.pdf"], priority=5, principals=["alice"], roles=[]),
            st("geo", "deny", resources=["/docs/**"], conditions={"attributes": {"context.country": {"in": ["xx"]}}}),
        ])
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/report.pdf").statement, "geo")
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/report.pdf", {"country": "nl"}).statement, "exact")

    def test_r15_r17_exact_path_beats_double_wildcard_of_same_prefix(self):
        ev, _ = make([st("tree", resources=["/docs/**"]), st("dir", resources=["/docs"])])
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/").statement, "dir")
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/a").statement, "tree")

    def test_r27_r29_r36_night_deny_through_a_delegated_role(self):
        principals = {"alice": {"roles": ["operator"]}, "bob": {"roles": ["reader"]}}
        dl = [delegation("night", "alice", "bob", ["operator"], expires="2026-11-28T03:00:00Z", actions=["ops:*"])]
        statements = [
            st("ops", roles=["operator"], actions=["ops:*"], resources=["/ops/**"]),
            st("freeze", "deny", roles=["operator"], actions=["ops:deploy"], resources=["/ops/**"],
               conditions={"time": [{"days": ["fri"], "start": "22:00", "end": "06:00", "tz_offset": "+01:00"}]}),
        ]
        cases = [
            (utc(2026, 11, FRI, 20, 59, 59), "ops:deploy", ("ALLOW", "ops")),
            (utc(2026, 11, FRI, 21, 0, 0), "ops:deploy", ("DENY", "freeze")),
            (utc(2026, 11, FRI, 21, 0, 0), "ops:restart", ("ALLOW", "ops")),
            (utc(2026, 11, SAT, 2, 59, 59), "ops:deploy", ("DENY", "freeze")),
            (utc(2026, 11, SAT, 3, 0, 0), "ops:deploy", ("DENY", None)),
        ]
        for now, action, expected in cases:
            ev, _ = make(statements, principals=principals, delegations=dl, now=now)
            d = ev.evaluate("bob", action, "/ops/web")
            self.assertEqual((d.effect, d.statement), expected, (now, action))

    def test_r09_r16_r40_placeholder_after_normalisation(self):
        ev, sink = make([st("home", resources=["/home/{principal}/*.txt"])], principals={"a.b@x": {"roles": ["reader"]}})
        d = ev.evaluate("a.b@x", "docs:read", "/home//a.b@x/notes.txt/")
        self.assertTrue(d.allowed)
        self.assertIn(" principal=a.b@x action=docs:read resource=/home/a.b@x/notes.txt ", sink.lines[-1])

    def test_r06_r31_r32_delegation_cycle_terminates(self):
        principals = {"alice": {"roles": ["editor"]}, "bob": {}}
        dl = [delegation("d1", "alice", "bob", ["editor"]), delegation("d2", "bob", "alice", ["editor"]), delegation("d3", "bob", "bob", ["editor"])]
        ev, _ = make([st("s1", roles=["editor"])], principals=principals, roles={"editor": {"inherits": ["editor"]}}, delegations=dl, max_delegation_depth=5)
        self.assertEqual(ev.evaluate("bob", "docs:read", "/docs/a").via, ("d1",))
        self.assertEqual(ev.evaluate("alice", "docs:read", "/docs/a").via, ())


if __name__ == "__main__":
    unittest.main()
