// N5: `Sara --self-check [--notice <file> --key <base64> --asset-base <url> --expect <version>] [--live-tabs]`
// checks the Mac's own copies of the rules without a window and without changing anything outside a temporary
// folder it deletes again: the update notice (a test key made here, and a notice signed by Node when given),
// version order, the publish-race retries, the command refusals and the read-only list, "open" refusals, a real
// zsh run (exit code, masking, timeout and Stop ending the whole process tree), the Files scope, the save rules
// and the tab parser. --live-tabs also asks the running browsers for their tabs (macOS may refuse over SSH).
// Prints JSON {passed, failed, checks}; exit 0 when all passed.
import AppKit
import CryptoKit

enum SelfCheck {
  static var checks: [[String: Any]] = []
  /// A key-shaped test string (made at run time so no file holds one).
  static let fakeKey = ["s", "k-", "abcdefghijklmnopqrstuvwx"].joined()
  static func ok(_ name: String, _ pass: Bool, _ extra: [String: Any] = [:]) {
    var c: [String: Any] = ["name": name, "ok": pass]
    for (k, v) in extra { c[k] = v }
    checks.append(c)
  }
  static func arg(_ a: [String], _ k: String) -> String? { a.firstIndex(of: k).flatMap { $0 + 1 < a.count ? a[$0 + 1] : nil } }

  static func run(_ a: [String]) -> Int32 {
    notices(a)
    versions()
    runRules()
    processes()
    files()
    saves()
    tabs(live: a.contains("--live-tabs"))
    let failed = checks.filter { $0["ok"] as? Bool != true }.count
    let result: [String: Any] = ["app": appVersion, "passed": checks.count - failed, "failed": failed, "checks": checks]
    if let d = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]), let t = String(data: d, encoding: .utf8) { print(t) }
    return failed == 0 ? 0 : 1
  }

  // MARK: the signed notice
  static func notices(_ a: [String]) {
    let key = Curve25519.Signing.PrivateKey()
    let pub = key.publicKey.rawRepresentation.base64EncodedString()
    let base = "https://github.com/farena-ai/sara/releases/download/"
    func make(_ v: String = "9.9.9", assets: [String: Any]? = nil, sign: Curve25519.Signing.PrivateKey? = nil, tamper: Bool = false, security: Any = false) -> Data {
      let sha = String(repeating: "ab", count: 32)
      let p: [String: Any] = ["version": v, "date": "2026-11-14", "minSupported": "3.0.0", "security": security,
                              "assets": assets ?? ["darwin": ["name": "Sara-\(v).dmg", "url": "\(base)v\(v)/Sara-\(v).dmg", "sha256": sha, "size": 100],
                                                   "win32-x64": ["name": "Sara-Setup-\(v).exe", "url": "\(base)v\(v)/Sara-Setup-\(v).exe", "sha256": sha]]]
      let payload = String(data: try! JSONSerialization.data(withJSONObject: p, options: [.sortedKeys]), encoding: .utf8)!
      let sig = try! (sign ?? key).signature(for: Data(payload.utf8)).base64EncodedString()
      let shown = tamper ? payload.replacingOccurrences(of: "9.9.9", with: "9.9.8") : payload
      return try! JSONSerialization.data(withJSONObject: ["format": "sara-update-notice/1", "keyId": "test", "payload": shown, "signature": sig])
    }
    let keys = [(id: "test", key: pub)]
    func v(_ d: Data, seen: String = "") -> AppUpdateRules.Checked { AppUpdateRules.verify(d, keys: keys, assetBase: base, seen: seen) }
    if case .success(let n) = v(make()) { ok("notice: a notice signed by the key is trusted", n.version == "9.9.9" && n.mac?.name == "Sara-9.9.9.dmg" && n.mac?.size == 100) } else { ok("notice: a notice signed by the key is trusted", false) }
    if case .failure(let w) = v(make(tamper: true)) { ok("notice: a changed payload is refused", w.contains("signature")) } else { ok("notice: a changed payload is refused", false) }
    if case .failure(let w) = v(make(sign: Curve25519.Signing.PrivateKey())) { ok("notice: another key's signature is refused", w.contains("signature")) } else { ok("notice: another key's signature is refused", false) }
    if case .failure(let w) = v(make(), seen: "10.0.0") { ok("notice: older than one already seen is refused", w.contains("older")) } else { ok("notice: older than one already seen is refused", false) }
    let sha = String(repeating: "cd", count: 32)
    if case .failure(let w) = v(make(assets: ["darwin": ["name": "Sara.dmg", "url": "https://evil.example/v9.9.9/Sara.dmg", "sha256": sha]])) { ok("notice: a file not on the release page is refused", w.contains("release page")) } else { ok("notice: a file not on the release page is refused", false) }
    if case .failure(let w) = v(make(assets: ["darwin": ["name": "Sara.dmg", "url": "\(base)v9.9.9/Sara.dmg", "sha256": "nothex"]])) { ok("notice: a file without a SHA-256 is refused", w.contains("SHA-256")) } else { ok("notice: a file without a SHA-256 is refused", false) }
    if case .failure(let w) = v(make(assets: ["darwin": ["name": "Sara.zip", "url": "\(base)v9.9.9/Sara.zip", "sha256": sha]])) { ok("notice: a Mac file that isn't a disk image is refused", w.contains("disk image")) } else { ok("notice: a Mac file that isn't a disk image is refused", false) }
    if case .failure(let w) = v(make(security: "no")) { ok("notice: a notice without a security flag is refused", w.contains("security")) } else { ok("notice: a notice without a security flag is refused", false) }
    if case .success(let n) = v(make(assets: ["win32-x64": ["name": "Sara-Setup.exe", "url": "\(base)v9.9.9/Sara-Setup.exe", "sha256": sha]])) { ok("notice: Windows-only notice has no Mac file", n.mac == nil) } else { ok("notice: Windows-only notice has no Mac file", false) }
    let rk = AppUpdateRules.releaseKeys.first
    ok("notice: the release key 0bfd41a73239cf88 is a 32-byte Ed25519 key", rk?.id == "0bfd41a73239cf88" && (try? Curve25519.Signing.PublicKey(rawRepresentation: Data(base64Encoded: rk?.key ?? "") ?? Data())) != nil)
    // A notice Node signed (scripts/test: the server's own signing code), when given.
    if let f = arg(a, "--notice"), let k = arg(a, "--key"), let d = FileManager.default.contents(atPath: f) {
      let b = arg(a, "--asset-base") ?? base
      switch AppUpdateRules.verify(d, keys: [("node", k)], assetBase: b, seen: "") {
      case .success(let n): ok("notice: a notice signed by Node (src/update-notice.ts) is trusted", n.version == (arg(a, "--expect") ?? n.version) && n.mac != nil, ["version": n.version])
      case .failure(let w): ok("notice: a notice signed by Node (src/update-notice.ts) is trusted", false, ["why": w])
      }
      switch AppUpdateRules.verify(d, keys: AppUpdateRules.releaseKeys, assetBase: b, seen: "") {
      case .success: ok("notice: the Node test notice is refused with the release key", false)
      case .failure(let w): ok("notice: the Node test notice is refused with the release key", w.contains("signature"))
      }
    }
  }

  static func versions() {
    ok("version: 3.5.10 > 3.5.9", AppUpdateRules.compare("3.5.10", "3.5.9") == 1)
    ok("version: v3.5.0 = 3.5", AppUpdateRules.compare("v3.5.0", "3.5") == 0)
    ok("version: 3.5.0-beta.1 = 3.5.0 (first three numbers)", AppUpdateRules.compare("3.5.0-beta.1", "3.5.0") == 0)
    ok("version: 2.9.9 < 3.0.0", AppUpdateRules.compare("2.9.9", "3.0.0") == -1)
    let seq = (0...6).map { AppUpdateRules.raceRetrySeconds(notice: "3.5.0", server: "3.5.1", tries: $0) }
    ok("race: 15 min doubling to 4 h, 6 tries, then none", seq == [900, 1800, 3600, 7200, 14400, 14400, 0], ["seconds": seq])
    ok("race: none when the notice is as new as the server", AppUpdateRules.raceRetrySeconds(notice: "3.5.1", server: "3.5.1", tries: 0) == 0 && AppUpdateRules.raceRetrySeconds(notice: "3.5.1", server: "", tries: 0) == 0)
  }

  // MARK: commands
  static func runRules() {
    for c in ["sudo ls", "su -", "cd /tmp && su root", "doas ls", "osascript -e 'do shell script \"id\" with administrator privileges'", "Start-Process x -Verb RunAs"] { ok("run: elevating is refused: \(c)", HandsRunRules.elevated(c)) }
    for c in ["ls ~/sudoku", "echo summary", "git status"] { ok("run: not elevating: \(c)", !HandsRunRules.elevated(c)) }
    for c in ["rm -rf build", "mv a b", "chmod 777 x", "defaults write com.apple.dock x", "curl -O https://x", "launchctl unload x", "killall Finder", "diskutil eraseDisk x", "git push"] { ok("run: always asks: \(c)", HandsRunRules.destructiveCommand(c)) }
    for c in ["ls -la", "git status", "df -h"] { ok("run: doesn't always ask: \(c)", !HandsRunRules.destructiveCommand(c)) }
    for c in ["ls -la", "git status", "cat notes.txt | head -5", "df -h", "du -sh Documents"] { ok("run: read-only: \(c)", HandsRunRules.readOnlyCommand(c)) }
    for c in ["ls; rm x", "cat x > y", "echo $HOME", "rm x", "ls && open x", "cat x | sh"] { ok("run: not read-only: \(c)", !HandsRunRules.readOnlyCommand(c)) }
    let open: [(String, String?)] = [("https://example.com", "url"), ("mailto:a@b.c", "url"), ("ftp://x.example", nil), ("file:///etc/hosts", nil), ("/Applications/Calculator.app", nil), ("~/run.command", nil), ("~/x.sh", nil),
                                      ("~/Documents/a.pdf", "path"), ("TextEdit", "app"), ("ls -la /", nil), ("//server/share", nil)]
    for (t, want) in open {
      let got = (try? HandsRunRules.openPlan(t))?.kind.rawValue
      ok("open: \(t) → \(want ?? "refused")", got == want)
    }
    for n in ["Terminal", "iTerm", "Script Editor", "Automator", "System Settings", "Keychain Access", "1Password 7"] { ok("open: never opens \(n)", HandsRunRules.refusedApp(n)) }
    ok("open: TextEdit may be opened", !HandsRunRules.refusedApp("TextEdit"))
    let capped = HandsRunRules.capped(String(repeating: "x", count: 70_000))
    ok("run: output capped to 64,000 characters (start and end)", capped.truncated && capped.text.count <= 64_000 + 80 && capped.text.contains("characters left out"))
    ok("run: control characters dropped, keys masked", HandsRunRules.masked("a\u{1b}[31mb\r\n" + fakeKey) == "a[31mb\n[hidden]")
  }

  static func processes() {
    let c1 = HandsCancel()
    if let r = try? HandsRunProcess.run(command: "echo hello; echo oops >&2; exit 3", cwd: NSHomeDirectory(), timeout: 20, cancel: c1, onChunk: { _ in }) {
      ok("process: exit code and both outputs", r.code == 3 && r.output.contains("hello") && r.output.contains("oops") && !r.timedOut && !r.stopped, ["code": r.code ?? -1])
    } else { ok("process: exit code and both outputs", false) }
    var chunks = ""
    if let r = try? HandsRunProcess.run(command: "pwd; printf 'sk-%s\\n' abcdefghijklmnopqrstuvwx", cwd: NSTemporaryDirectory(), timeout: 20, cancel: HandsCancel(), onChunk: { chunks += $0 }) {
      let masked = HandsRunRules.masked(r.output)
      ok("process: runs in the folder asked for; live chunks and output masked", masked.contains("[hidden]") && !masked.contains("abcdefghijklmnop") && chunks.contains("[hidden]") && r.output.contains("/"))
    } else { ok("process: runs in the folder asked for; live chunks and output masked", false) }
    let marker = "47.\(Int.random(in: 100...999))"
    let started = Date()
    if let r = try? HandsRunProcess.run(command: "(sleep \(marker) &) ; sleep 61", cwd: NSHomeDirectory(), timeout: 1.5, cancel: HandsCancel(), onChunk: { _ in }) {
      usleep(300_000)
      ok("process: the deadline ends the command and what it started", r.timedOut && r.code == nil && Date().timeIntervalSince(started) < 6 && !alive("sleep \(marker)"))
    } else { ok("process: the deadline ends the command and what it started", false) }
    let c2 = HandsCancel()
    DispatchQueue.global().asyncAfter(deadline: .now() + 1) { c2.set() }
    let marker2 = "48.\(Int.random(in: 100...999))"
    if let r = try? HandsRunProcess.run(command: "sh -c 'sleep \(marker2)' & sleep 62", cwd: NSHomeDirectory(), timeout: 60, cancel: c2, onChunk: { _ in }) {
      usleep(300_000)
      ok("process: Stop ends the whole process tree", r.stopped && !alive("sleep \(marker2)"))
    } else { ok("process: Stop ends the whole process tree", false) }
  }
  static func alive(_ pattern: String) -> Bool {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
    p.arguments = ["-f", pattern]
    p.standardOutput = FileHandle.nullDevice
    try? p.run()
    p.waitUntilExit()
    return p.terminationStatus == 0
  }

  // MARK: files
  static func files() {
    let fm = FileManager.default
    let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("sara-selfcheck-\(getpid())")
    defer { try? fm.removeItem(at: root); HandsFiles.setTestRoot(""); HandsFiles.setRoots(scope: "three", picked: []) }
    let docs = root.appendingPathComponent("Documents")
    for d in ["Desktop", "Downloads", "Documents/sub", "Documents/Library", "Documents/.git"] { try? fm.createDirectory(at: root.appendingPathComponent(d), withIntermediateDirectories: true) }
    func put(_ p: String, _ s: String) { try? s.write(to: docs.appendingPathComponent(p), atomically: true, encoding: .utf8) }
    put("notes.txt", "hello from notes\nkey " + fakeKey + "\n")
    put(".hidden.txt", "no")
    put("id_rsa", "no")
    put("passwords.txt", "no")
    put("Library/x.txt", "no")
    put("sub/a.md", "# a")
    put("report.pdf", "%PDF")
    try? Data([0x61, 0x00, 0x62]).write(to: docs.appendingPathComponent("bin.txt"))
    try? fm.createSymbolicLink(atPath: docs.appendingPathComponent("link-out").path, withDestinationPath: "/etc")
    try? fm.createSymbolicLink(atPath: docs.appendingPathComponent("link-in.txt").path, withDestinationPath: docs.appendingPathComponent("notes.txt").path)
    HandsFiles.setTestRoot(root.path)
    HandsFiles.setRoots(scope: "three", picked: [])
    ok("files: three folders by default", HandsFiles.rootNames() == ["desktop", "documents", "downloads"])
    if let l = try? HandsFiles.list("Documents", "") {
      let names = (l["entries"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }
      ok("files: list shows plain files and folders", names.contains("notes.txt") && names.contains("sub") && names.contains("link-in.txt") && names.first == "sub", ["names": names])
      ok("files: hidden, secret, Library and links that lead out are left out", !names.contains(".hidden.txt") && !names.contains("id_rsa") && !names.contains("passwords.txt") && !names.contains("Library") && !names.contains("link-out") && (l["hidden"] as? Int ?? 0) >= 5, ["hidden": l["hidden"] ?? 0])
    } else { ok("files: list shows plain files and folders", false) }
    if let r = try? HandsFiles.read("my documents", "notes.txt") { ok("files: reads a text file, keys masked", (r["text"] as? String ?? "").contains("hello from notes") && (r["text"] as? String ?? "").contains("[hidden]")) } else { ok("files: reads a text file, keys masked", false) }
    if let r = try? HandsFiles.read("documents", "link-in.txt") { ok("files: a link inside the folder is read", (r["text"] as? String ?? "").contains("hello")) } else { ok("files: a link inside the folder is read", false) }
    func refused(_ name: String, _ folder: String, _ path: String, read: Bool = true, code: String = "denied_local") {
      do { _ = read ? try HandsFiles.read(folder, path) : try HandsFiles.list(folder, path); ok("files: refused: \(name)", false) } catch let e as HandsOpError { ok("files: refused: \(name)", e.code == code, ["message": e.message]) } catch { ok("files: refused: \(name)", false) }
    }
    refused("..", "documents", "../Desktop/x.txt")
    refused("a full path", "documents", "/etc/hosts")
    refused("~", "documents", "~/x.txt")
    refused("a link that leads out", "documents", "link-out/hosts")
    refused("a secret name", "documents", "id_rsa")
    refused("a hidden name", "documents", ".hidden.txt")
    refused("Library", "documents", "Library/x.txt")
    refused("binary data", "documents", "bin.txt")
    refused("not a text type", "documents", "report.pdf")
    refused("another folder", "Pictures", "", read: false)
    refused("a missing file", "documents", "nope.txt", code: "not_found")
    HandsFiles.setRoots(scope: "picked", picked: [docs.appendingPathComponent("sub").path])
    ok("files: a picked folder is a root by its name", HandsFiles.rootNames().contains("sub") && ((try? HandsFiles.read("sub", "a.md"))?["text"] as? String) == "# a")
    HandsFiles.setRoots(scope: "home", picked: [])
    ok("files: home adds the home folder", HandsFiles.rootNames().last == "home")
    HandsFiles.setRoots(scope: "drives", picked: [])
    ok("files: all disks (test: one)", HandsFiles.rootNames().contains("drive T") && HandsFiles.scopeName == "drives")
    HandsFiles.setTestRoot("")
    let users = (NSHomeDirectory() as NSString).deletingLastPathComponent
    ok("files: another person's home folder is never entered", HandsFiles.otherUser(users + "/zz-not-me-\(getpid())/x") && !HandsFiles.otherUser(NSHomeDirectory() + "/Documents") && !HandsFiles.otherUser(users + "/Shared/x"))
    ok("files: Library and system folders can't be picked", HandsFiles.pickable(NSHomeDirectory() + "/Library") != nil && HandsFiles.pickable("/System") != nil && HandsFiles.pickable("/usr") != nil && HandsFiles.pickable(NSHomeDirectory()) == nil)
  }

  // MARK: save to this Mac
  static func saves() {
    ok("save: names cleaned", SaveFiles.cleanName("a/b:c.pdf") == "a_b_c.pdf" && SaveFiles.cleanName(".hidden") == "hidden" && SaveFiles.cleanName("") == "document" && SaveFiles.cleanName(String(repeating: "x", count: 300) + ".docx").count == 150)
    for (u, want) in [("/api/library/12/file", true), ("/api/library/made/3/file", true), ("/api/files/abc-1.pdf", true), ("/api/library/../x", false), ("/api/files/a?b", false), ("/api/secrets", false), ("https://evil/api/files/x", false)] {
      ok("save: \(u) \(want ? "may" : "may not") be saved", SaveFiles.urlOk(u) == want)
    }
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("sara-save-\(getpid())")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    try? "x".write(to: dir.appendingPathComponent("Report.pdf"), atomically: true, encoding: .utf8)
    try? "x".write(to: dir.appendingPathComponent("Report (2).pdf"), atomically: true, encoding: .utf8)
    ok("save: never over another file (Report (3).pdf)", SaveFiles.uniquePath(dir, "Report.pdf").lastPathComponent == "Report (3).pdf" && SaveFiles.uniquePath(dir, "New.pdf").lastPathComponent == "New.pdf")
  }

  // MARK: tabs
  static func tabs(live: Bool) {
    let us = HandsTabs.us, rs = HandsTabs.rs
    let text = "W12\(us)2\(rs)TInbox (3)\(us)https://mail.example.com/\(rs)TBank of America\(us)https://www.bankofamerica.com/\(rs)W13\(us)1\(rs)TNews\(us)\(rs)"
    let w = HandsTabs.parse(text, HandsTabs.browsers[1])
    ok("tabs: the AppleScript answer is read (windows, tabs, front tab)", w.count == 2 && w[0].id == "wc12" && w[0].active == 2 && w[0].tabs.count == 2 && w[1].tabs.first?.url == "")
    ok("tabs: banking tabs are blocked", HandsTabs.pageAct("Bank of America", "https://www.bankofamerica.com/").act == "block")
    ok("tabs: browser password pages are blocked", HandsTabs.pageAct("Passwords", "chrome://password-manager/passwords").act == "block")
    ok("tabs: settings and checkout ask every time", HandsTabs.pageAct("Settings", "chrome://settings/").act == "once" && HandsTabs.pageAct("Checkout", "https://shop.example.com/checkout").act == "once")
    ok("tabs: an ordinary page follows the approval choice", HandsTabs.pageAct("Weather", "https://weather.example.com/today").act == "level")
    ok("tabs: the list scripts only ask running browsers by id", HandsTabs.browsers.allSatisfy { HandsTabs.listScript($0).contains("tell application id \"\($0.bundle)\"") })
    guard live else { return }
    let (wins, refused, busy) = HandsTabs.collect()
    let safari = wins.filter { $0.browser.safari }
    let running = HandsTabs.running(HandsTabs.browsers[0]).app != nil
    ok("tabs (live): Safari's tabs through AppleScript", !running || !safari.isEmpty || refused.contains("Safari"),
       ["safariRunning": running, "windows": safari.count, "tabs": safari.reduce(0) { $0 + $1.tabs.count }, "refused": refused, "busy": busy, "titles": safari.flatMap { $0.tabs.map { String(handsMask($0.title).prefix(40)) } }.prefix(5).map { $0 }])
  }
}
