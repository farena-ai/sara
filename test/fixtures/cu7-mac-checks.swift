// Phase 94 (CU7): runs the Mac check-up (desktop/mac/Sources/HandsCheckup.swift) on this Mac and prints
// AGGREGATE numbers only (counts and sizes), never a name. Compiled as main.swift next to a copy of
// HandsCheckup.swift:  swiftc -O -o cu7-mac-checks main.swift HandsCheckup.swift
import Foundation

var pass = 0, total = 0
func expect(_ ok: Bool, _ what: String) { total += 1; if ok { pass += 1 }; print("\(ok ? "ok  " : "FAIL") \(what)") }
func gb(_ n: Any?) -> Double { Double((n as? UInt64) ?? UInt64((n as? Int) ?? 0)) / 1_073_741_824 }

let r = HandsCheckup.check([], cancelled: { false })
let c = r["checks"] as? [String: Any] ?? [:]
expect((r["os"] as? String ?? "").hasPrefix("mac "), "the answer starts with the os")
expect(JSONSerialization.isValidJSONObject(r), "the answer is valid JSON")
for k in ["startup", "disk", "folders", "updates", "battery", "extensions", "temp"] { expect(c[k] != nil, "\"\(k)\":") }
func ok(_ k: String) -> [String: Any]? { let v = c[k] as? [String: Any]; return v?["ok"] as? Bool == true ? v : nil }
if let s = ok("startup") { let items = s["items"] as? [[String: Any]] ?? []; print("  startup: \(items.count) launch agents, \(items.filter { $0["enabled"] as? Bool == true }.count) on, \(items.filter { $0["where"] as? String == "machine" }.count) for every user") } else { print("  startup: not checked") }
if let d = ok("disk") { let v = d["volumes"] as? [[String: Any]] ?? []; print(String(format: "  disk: %d volumes, %.1f GB free of %.1f GB", v.count, v.map { gb($0["free"]) }.reduce(0, +), v.map { gb($0["total"]) }.reduce(0, +))) ; expect(!v.isEmpty, "volumes read") }
if let f = ok("folders") { let v = f["folders"] as? [[String: Any]] ?? []; print(String(format: "  folders: %d measured, %.1f GB, %d counted partly", v.count, v.map { gb($0["bytes"]) }.reduce(0, +), v.filter { $0["partial"] as? Bool == true }.count)) } else { print("  folders: not checked (\((c["folders"] as? [String: Any])?["why"] as? String ?? "?"))") }
if let u = ok("updates") { print("  updates: \(u["pending"] ?? 0) waiting, restart needed: \(u["reboot"] as? Bool == true ? "yes" : "no")") } else { print("  updates: not checked") }
if let b = ok("battery") { print("  battery: \(b["present"] as? Bool == true ? "present" : "none")\(b["health"].map { ", health \($0)%" } ?? "")\(b["cycles"].map { ", \($0) cycles" } ?? "")") }
if let e = ok("extensions") { let bs = e["browsers"] as? [[String: Any]] ?? []; print("  extensions: \(bs.count) browser profiles, \(bs.map { ($0["extensions"] as? [Any])?.count ?? 0 }.reduce(0, +)) extensions") }
if let t = ok("temp") { let p = t["places"] as? [[String: Any]] ?? []; print(String(format: "  temp and caches: %.2f GB in %d places", p.map { gb($0["bytes"]) }.reduce(0, +), p.count)) }
let only = HandsCheckup.check(["disk"], cancelled: { false })["checks"] as? [String: Any] ?? [:]
expect(only.keys.sorted() == ["disk"], "only the asked checks run")
let stopped = HandsCheckup.check(["folders"], cancelled: { true })["checks"] as? [String: Any] ?? [:]
expect(stopped["folders"] != nil, "a cancelled check returns at once")
print("\(pass)/\(total) native check-up checks")
exit(pass == total ? 0 : 1)
