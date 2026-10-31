// Phase 87 (computer use CU1, docs/design/COMPUTER_USE.md §2–§4): Sara's hands on this Mac.
// Phase 88 (CU2): acting in the Sara browser (find, click, type, select, keys, scroll, upload,
// downloads) through the shared page agent and real DevTools input; the floating "Sara is working"
// badge with Stop / Resume, the global stop shortcut ⌃⌥Esc (Carbon hot key: no permission needed),
// takeover (real input in her window pauses her unless "Let Sara keep control"), the input rate
// limit, the local log "What Sara did on this Mac", and token renewal over the connection.
// Phase 89 (CU3): the dev tunnel (HandsTunnels below): c.tunnel opens a listener on 127.0.0.1 only
// (BSD sockets); each connection the Sara browser makes to it is a stream over this connection to the
// dev server her job runs on the server. At most 4 tunnels and 64 connections each; all close on
// c.untunnel, Stop and when the connection drops.
// Phase 90 (CU4): saved logins in the Keychain (service "Sara logins", this device only; see HandsLogins):
// b.login fills one through DevTools input only on its exact site, b.saveLogin opens this app's own
// consent panel ("I understand" unticked), b.logins / b.forgetLogin list and remove (names and sites
// only), b.yourTurn shows "Your turn" until the person presses Continue; optional Touch ID first.
// When the owner switches on "Let Sara use this computer" (Settings → Computer use in the app), the
// page gets a `hands` token from the server and hands it to this app; the app keeps it in the
// Keychain, opens its own WebSocket to <server>/api/hands (Authorization header, no cookies) and runs
// only CU1's command set in the Sara browser: a visible Chrome or Edge window with its own profile,
// driven over the DevTools protocol through a pipe (fds 3 and 4, no port). Reading pages goes through
// the one shared page agent (desktop/shared/page-agent.js, in Resources). The same protocol, command
// set and limits as the Windows app (desktop/windows/src/hands.cpp) and the reference hands
// (src/hands-ref.ts): the op allowlist, http(s) only, never the Sara server's own pages (except preview
// links), 20 page loads a minute, password fields never read, key-shaped text masked.
import Foundation
import AppKit
import Carbon.HIToolbox
import Security
import LocalAuthentication

// MARK: small helpers

private func jsonText(_ o: Any) -> String {
  guard JSONSerialization.isValidJSONObject(o), let d = try? JSONSerialization.data(withJSONObject: o, options: [.fragmentsAllowed]) else { return "null" }
  return String(data: d, encoding: .utf8) ?? "null"
}
private func jsonQuote(_ s: String) -> String { jsonText([s]).dropFirst().dropLast().description }
private func parseJSON(_ s: String) -> [String: Any]? {
  guard let d = s.data(using: .utf8) else { return nil }
  return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
}

private let secretShapes: [NSRegularExpression] = [
  "sk-[A-Za-z0-9_-]{16,}", "[sr]k_(live|test)_[A-Za-z0-9]{10,}", "gh[pousr]_[A-Za-z0-9]{20,}", "github_pat_[A-Za-z0-9_]{20,}",
  "xox[abprs]-[A-Za-z0-9-]{10,}", "AKIA[0-9A-Z]{16}", "AIza[0-9A-Za-z_-]{30,}", "xai-[A-Za-z0-9]{20,}",
  "sara_(dev|hands|m)\\.[\\w-]+\\.[\\w-]+", "eyJ[\\w-]{8,}\\.[\\w-]{8,}\\.[\\w-]{8,}",
].compactMap { try? NSRegularExpression(pattern: $0) }
/// Text that looks like a key or token is masked before it leaves this Mac.
func handsMask(_ s: String) -> String {
  var t = s
  for re in secretShapes { t = re.stringByReplacingMatches(in: t, range: NSRange(t.startIndex..., in: t), withTemplate: "[hidden]") }
  return t
}
private func shortText(_ s: String, _ n: Int = 500) -> String {
  handsMask(String(s.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\r" || $0 == "\t" }).joined(separator: " ").prefix(n)))
}

/// The origin of an http(s) address, its path, and whether it has a user name in it.
private func httpOrigin(_ raw: String) -> (origin: String, path: String, userinfo: Bool)? {
  guard let u = URLComponents(string: raw), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https", let host = u.host?.lowercased(), !host.isEmpty else { return nil }
  let port = u.port.flatMap { (scheme == "http" && $0 == 80) || (scheme == "https" && $0 == 443) ? nil : $0 }
  return ("\(scheme)://\(host)" + (port.map { ":\($0)" } ?? ""), u.percentEncodedPath.isEmpty ? "/" : u.percentEncodedPath, u.user != nil || u.password != nil)
}
/// Whether the Sara browser may load an address (§4.1); the reason when not.
func handsAddressAllowed(_ url: String, serverOrigin: String) -> String? {
  if url == "about:blank" { return nil }
  guard let o = httpOrigin(url) else { return "The Sara browser only opens web addresses (http or https)." }
  if o.userinfo { return "Addresses with a user name or password are not opened." }
  if o.origin == serverOrigin && o.path.range(of: "^/preview/[0-9a-f]{32}(/|$)", options: .regularExpression) == nil { return "Sara's own server is never opened in the Sara browser." }
  return nil
}

struct HandsOpError: Error {
  let code: String
  let message: String
}

/// A request's stop flag (Stop, the server's cancel, the deadline).
final class HandsCancel {
  private let lock = NSLock()
  private var flag = false
  var isSet: Bool { lock.lock(); defer { lock.unlock() }; return flag }
  func set() { lock.lock(); flag = true; lock.unlock() }
}

// MARK: the Sara browser (Chrome or Edge over a DevTools pipe)

final class HandsBrowser {
  struct Tab {
    var id = "", targetId = "", sessionId = "", frameId = ""
    var logs: [[String: Any]] = []
    var consoleErrors = 0, failedRequests = 0, status = 0, loads = 0
    var starts = 0      // Phase 88: page loads started (an action that navigates waits for its load)
    var dialog = ""     // Phase 88: the last page dialog, closed with Cancel
    var requests: [String: (String, String)] = [:]
  }
  var downloadsDir: URL?
  /// Phase 90: the page agent's catchLogins, in a world of its own on every page.
  var catchScript = ""
  private var caught: (origin: String, user: String, pass: String, at: Date)?
  /// Phase 90: a sign-in the person typed in the Sara browser ("Use what I just typed"), memory only.
  func takeCaught(_ origin: String) -> (String, String)? {
    cond.lock(); defer { cond.unlock() }
    guard let c = caught, c.origin == origin, Date().timeIntervalSince(c.at) < 600 else { return nil }
    return (c.user, c.pass)
  }
  func clearCaught() { cond.lock(); caught = nil; cond.unlock() }
  let serverOrigin: String
  let profileDir: URL
  let found: (path: String, kind: String, name: String)?
  private let cond = NSCondition()
  private var alive = false
  private var pid: pid_t = 0
  private var wfd: Int32 = -1, rfd: Int32 = -1
  private var nextId = 1
  private var results: [Int: [String: Any]] = [:]
  private var tabs: [String: Tab] = [:]
  private var order: [String] = []
  private var active = ""
  private var tabN = 0
  private(set) var seq = 0
  private let writeLock = NSLock()

  init(serverOrigin: String, profileDir: URL) {
    self.serverOrigin = serverOrigin
    self.profileDir = profileDir
    found = HandsBrowser.find()
  }

  static func find() -> (path: String, kind: String, name: String)? {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    for (p, k, n) in [("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "chrome", "Google Chrome"), ("\(home)/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "chrome", "Google Chrome"),
                      ("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "edge", "Microsoft Edge"), ("/Applications/Chromium.app/Contents/MacOS/Chromium", "chromium", "Chromium")]
    where FileManager.default.isExecutableFile(atPath: p) { return (p, k, n) }
    return nil
  }

  var running: Bool { cond.lock(); defer { cond.unlock() }; return alive }

  func start() throws {
    if running { return }
    guard let f = found else { throw HandsOpError(code: "perm_missing", message: "There is no Google Chrome or Microsoft Edge on this Mac for the Sara browser.") }
    try? FileManager.default.createDirectory(at: profileDir, withIntermediateDirectories: true)
    var toChild: [Int32] = [0, 0], fromChild: [Int32] = [0, 0]
    guard pipe(&toChild) == 0, pipe(&fromChild) == 0 else { throw HandsOpError(code: "error", message: "Couldn't make the pipe to the Sara browser.") }
    var fa: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&fa)
    posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_addopen(&fa, 1, "/dev/null", O_WRONLY, 0)
    posix_spawn_file_actions_addopen(&fa, 2, "/dev/null", O_WRONLY, 0)
    // The browser reads DevTools commands from fd 3 and writes answers to fd 4.
    posix_spawn_file_actions_adddup2(&fa, toChild[0], 3)
    posix_spawn_file_actions_adddup2(&fa, fromChild[1], 4)
    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    // Nothing else of this app is inherited (only the descriptors set up above).
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT))
    let args = [f.path, "--user-data-dir=\(profileDir.path)", "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
                "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-breakpad", "--no-pings", "--use-mock-keychain", "--password-store=basic",
                "--disable-features=Translate,MediaRouter,OptimizationHints,msEdgeSync,msImplicitSignin,msSignInFRE", "--window-size=1280,860", "about:blank"]
    var cargs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) } + [nil]
    defer { for p in cargs { free(p) } }
    var child: pid_t = 0
    let rc = posix_spawn(&child, f.path, &fa, &attr, &cargs, environ)
    posix_spawn_file_actions_destroy(&fa)
    posix_spawnattr_destroy(&attr)
    Darwin.close(toChild[0])
    Darwin.close(fromChild[1])
    guard rc == 0 else {
      Darwin.close(toChild[1]); Darwin.close(fromChild[0])
      throw HandsOpError(code: "error", message: "The Sara browser didn't start.")
    }
    cond.lock()
    pid = child; wfd = toChild[1]; rfd = fromChild[0]; alive = true
    tabs = [:]; order = []; results = [:]
    cond.unlock()
    let reader = Thread { [weak self] in self?.readLoop() }
    reader.start()
    for _ in 0..<50 {
      let r = try call("Target.getTargets", [:])
      for t in (r["targetInfos"] as? [[String: Any]] ?? []) where t["type"] as? String == "page" {
        _ = try attach(t["targetId"] as? String ?? "")
      }
      if tabCount > 0 { break }
      Thread.sleep(forTimeInterval: 0.15)
    }
    if tabCount == 0 { _ = try newTab() }
    // Phase 88: downloads land in Downloads/Sara, nowhere else.
    if let d = downloadsDir {
      try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
      _ = try? call("Browser.setDownloadBehavior", ["behavior": "allow", "downloadPath": d.path])
    }
  }
  /// The browser's process id (its windows belong to it): takeover looks for input there.
  var browserPid: pid_t { cond.lock(); defer { cond.unlock() }; return alive ? pid : 0 }
  func starts(_ id: String) -> Int { cond.lock(); defer { cond.unlock() }; return tabs[id]?.starts ?? -1 }
  func waitStart(_ id: String, after: Int, timeout: TimeInterval, cancel: HandsCancel) -> Bool {
    let until = Date().addingTimeInterval(timeout)
    cond.lock()
    defer { cond.unlock() }
    while alive, let t = tabs[id], t.starts == after {
      if cancel.isSet || Date() >= until { return false }
      _ = cond.wait(until: min(until, Date().addingTimeInterval(0.05)))
    }
    return alive && tabs[id] != nil
  }
  func takeDialog(_ id: String) -> String {
    cond.lock()
    defer { cond.unlock() }
    let d = tabs[id]?.dialog ?? ""
    tabs[id]?.dialog = ""
    return d
  }

  func close() {
    if running { send("Browser.close", [:], session: nil) }
    cond.lock()
    let p = pid
    cond.unlock()
    if p > 0 {
      var status: Int32 = 0
      var waited = 0
      while waitpid(p, &status, WNOHANG) == 0 && waited < 30 { Thread.sleep(forTimeInterval: 0.1); waited += 1 }
      if waited >= 30 { kill(p, SIGKILL); waitpid(p, &status, 0) }  // only the browser this app started
    }
    cond.lock()
    if wfd >= 0 { Darwin.close(wfd) }
    wfd = -1; pid = 0; alive = false; tabs = [:]; order = []
    cond.broadcast()
    cond.unlock()
  }

  private func write(_ msg: [String: Any]) -> Bool {
    cond.lock()
    let fd = wfd
    cond.unlock()
    guard fd >= 0 else { return false }
    var data = Data(jsonText(msg).utf8)
    data.append(0)
    writeLock.lock()
    defer { writeLock.unlock() }
    return data.withUnsafeBytes { buf -> Bool in
      var off = 0
      while off < buf.count {
        let n = Darwin.write(fd, buf.baseAddress! + off, buf.count - off)
        if n <= 0 { return false }
        off += n
      }
      return true
    }
  }

  func send(_ method: String, _ params: [String: Any], session: String?) {
    cond.lock()
    let id = nextId; nextId += 1
    cond.unlock()
    var m: [String: Any] = ["id": id, "method": method, "params": params]
    if let session { m["sessionId"] = session }
    _ = write(m)
  }

  /// A DevTools command and its answer.
  func call(_ method: String, _ params: [String: Any], session: String? = nil, timeout: TimeInterval = 15, cancel: HandsCancel? = nil) throws -> [String: Any] {
    cond.lock()
    guard alive else { cond.unlock(); throw HandsOpError(code: "error", message: "The Sara browser was closed.") }
    let id = nextId; nextId += 1
    cond.unlock()
    var m: [String: Any] = ["id": id, "method": method, "params": params]
    if let session { m["sessionId"] = session }
    guard write(m) else { throw HandsOpError(code: "error", message: "The Sara browser was closed.") }
    let until = Date().addingTimeInterval(timeout)
    cond.lock()
    defer { cond.unlock() }
    while results[id] == nil {
      if !alive { throw HandsOpError(code: "error", message: "The Sara browser was closed.") }
      if cancel?.isSet == true { throw HandsOpError(code: "stopped", message: "Stopped.") }
      if Date() >= until { throw HandsOpError(code: "timeout", message: "\(method) took too long.") }
      _ = cond.wait(until: min(until, Date().addingTimeInterval(0.1)))
    }
    let r = results.removeValue(forKey: id)!
    if let e = r["error"] as? [String: Any] { throw HandsOpError(code: "error", message: e["message"] as? String ?? "DevTools error") }
    return r["result"] as? [String: Any] ?? [:]
  }

  func attach(_ targetId: String) throws -> String {
    let r = try call("Target.attachToTarget", ["targetId": targetId, "flatten": true])
    let session = r["sessionId"] as? String ?? ""
    cond.lock()
    tabN += 1
    var t = Tab()
    t.id = "t\(tabN)"; t.targetId = targetId; t.sessionId = session
    tabs[t.id] = t; order.append(t.id); active = t.id
    cond.unlock()
    for d in ["Page.enable", "Runtime.enable", "Network.enable", "Log.enable"] { _ = try? call(d, [:], session: session) }
    // Phase 90: "Use what I just typed". A binding only the catcher's own isolated world can call (the
    // page's scripts can't), installed on every page; what it hands over stays in this app's memory.
    if !catchScript.isEmpty {
      _ = try? call("Runtime.addBinding", ["name": "saraLoginCaught", "executionContextName": "sara-login-catch"], session: session)
      _ = try? call("Page.addScriptToEvaluateOnNewDocument", ["source": catchScript, "worldName": "sara-login-catch", "runImmediately": true], session: session)
    }
    // §4.1: the server's own pages are refused even when a page sends the browser there.
    _ = try? call("Fetch.enable", ["patterns": [["urlPattern": serverOrigin + "/*"]]], session: session)
    let tree = try? call("Page.getFrameTree", [:], session: session)
    cond.lock()
    tabs[t.id]?.frameId = ((tree?["frameTree"] as? [String: Any])?["frame"] as? [String: Any])?["id"] as? String ?? ""
    cond.unlock()
    return t.id
  }

  func newTab() throws -> String {
    let r = try call("Target.createTarget", ["url": "about:blank"])
    return try attach(r["targetId"] as? String ?? "")
  }

  var tabCount: Int { cond.lock(); defer { cond.unlock() }; return tabs.count }
  var activeId: String { cond.lock(); defer { cond.unlock() }; return active }
  func tab(_ want: String) throws -> Tab {
    cond.lock()
    defer { cond.unlock() }
    if let t = tabs[want.isEmpty ? active : want] { return t }
    if want.isEmpty, let last = order.last(where: { tabs[$0] != nil }), let t = tabs[last] { return t }
    throw HandsOpError(code: "not_found", message: want.isEmpty ? "No tab is open." : "No tab \(want) (pc_browser_tabs lists them).")
  }
  func activate(_ id: String) { cond.lock(); if tabs[id] != nil { active = id }; cond.unlock() }
  func resetCounts(_ id: String, clearLogs: Bool = false) {
    cond.lock()
    tabs[id]?.consoleErrors = 0; tabs[id]?.failedRequests = 0; tabs[id]?.status = 0
    if clearLogs { tabs[id]?.logs = [] }
    cond.unlock()
  }
  func forget(_ id: String) {
    cond.lock()
    tabs[id] = nil
    order.removeAll { $0 == id }
    if active == id { active = order.last ?? "" }
    cond.unlock()
  }
  func allTabs() -> [Tab] { cond.lock(); defer { cond.unlock() }; return order.compactMap { tabs[$0] } }
  func loads(_ id: String) -> Int { cond.lock(); defer { cond.unlock() }; return tabs[id]?.loads ?? -1 }
  func waitLoad(_ id: String, after: Int, timeout: TimeInterval, cancel: HandsCancel) -> Bool {
    let until = Date().addingTimeInterval(timeout)
    cond.lock()
    defer { cond.unlock() }
    while alive, let t = tabs[id], t.loads == after {
      if cancel.isSet || Date() >= until { return false }
      _ = cond.wait(until: min(until, Date().addingTimeInterval(0.1)))
    }
    return alive && tabs[id] != nil
  }
  func logs(_ id: String, since: Int) -> [[String: Any]] {
    cond.lock()
    defer { cond.unlock() }
    return Array((tabs[id]?.logs ?? []).filter { ($0["seq"] as? Int ?? 0) > since }.suffix(200))
  }
  func statusOf(_ id: String, request: String) -> Int {
    cond.lock()
    defer { cond.unlock() }
    return (tabs[id]?.logs ?? []).first { $0["requestId"] as? String == request }?["status"] as? Int ?? 0
  }

  private func readLoop() {
    cond.lock()
    let fd = rfd
    cond.unlock()
    var buf = Data()
    var chunk = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = read(fd, &chunk, chunk.count)
      if n <= 0 { break }
      buf.append(chunk, count: n)
      while let z = buf.firstIndex(of: 0) {
        let msg = buf.subdata(in: buf.startIndex..<z)
        buf.removeSubrange(buf.startIndex...z)
        guard let m = (try? JSONSerialization.jsonObject(with: msg)) as? [String: Any] else { continue }
        if let id = m["id"] as? Int {
          cond.lock(); results[id] = m; cond.broadcast(); cond.unlock()
        } else { event(m) }
      }
    }
    Darwin.close(fd)
    cond.lock()
    alive = false; tabs = [:]; order = []; rfd = -1
    cond.broadcast()
    cond.unlock()
  }

  private func tabKey(session: String?) -> String? { tabs.first { $0.value.sessionId == session }?.key }
  private func log(_ key: String, _ e: [String: Any]) {
    seq += 1
    var x = e
    x["seq"] = seq
    tabs[key]?.logs.append(x)
    if (tabs[key]?.logs.count ?? 0) > 500 { tabs[key]?.logs.removeFirst() }
  }

  private func event(_ m: [String: Any]) {
    let method = m["method"] as? String ?? ""
    let p = m["params"] as? [String: Any] ?? [:]
    let session = m["sessionId"] as? String
    if method == "Runtime.bindingCalled" {
      guard p["name"] as? String == "saraLoginCaught", let c = parseJSON(p["payload"] as? String ?? "") else { return }
      let origin = handsLoginOrigin(c["origin"] as? String ?? "")
      if !origin.isEmpty, let pw = c["password"] as? String, !pw.isEmpty {
        cond.lock(); caught = (origin, String((c["username"] as? String ?? "").prefix(200)), String(pw.prefix(500)), Date()); cond.unlock()
      }
      return
    }
    if method == "Fetch.requestPaused" {
      let url = (p["request"] as? [String: Any])?["url"] as? String ?? ""
      let ok = handsAddressAllowed(url, serverOrigin: serverOrigin) == nil
      let rid = p["requestId"] as? String ?? ""
      send(ok ? "Fetch.continueRequest" : "Fetch.failRequest", ok ? ["requestId": rid] : ["requestId": rid, "errorReason": "BlockedByClient"], session: session)
      if !ok {
        cond.lock()
        if let k = tabKey(session: session) { log(k, ["kind": "network", "method": "GET", "url": shortText(url), "error": "blocked by the Sara browser (Sara\u{2019}s own server)"]) }
        cond.unlock()
      }
      return
    }
    cond.lock()
    defer { cond.broadcast(); cond.unlock() }
    if method == "Target.detachedFromTarget" {
      if let k = tabs.first(where: { $0.value.sessionId == p["sessionId"] as? String })?.key {
        tabs[k] = nil; order.removeAll { $0 == k }
        if active == k { active = order.last ?? "" }
      }
      return
    }
    guard let k = tabKey(session: session) else { return }
    switch method {
    case "Page.loadEventFired": tabs[k]?.loads += 1
    case "Page.frameStartedLoading", "Page.frameRequestedNavigation": tabs[k]?.starts += 1
    case "Page.javascriptDialogOpening":
      // A page dialog would block everything: it is closed with Cancel (the safe answer) and reported.
      tabs[k]?.dialog = shortText(p["message"] as? String ?? "", 200)
      send("Page.handleJavaScriptDialog", ["accept": false], session: session)
    case "Page.frameNavigated":
      if let f = p["frame"] as? [String: Any], f["parentId"] == nil { tabs[k]?.frameId = f["id"] as? String ?? "" }
    case "Runtime.consoleAPICalled":
      let type = p["type"] as? String ?? ""
      guard ["error", "warning", "assert"].contains(type) else { return }
      let text = (p["args"] as? [[String: Any]] ?? []).map { a -> String in
        if let v = a["value"] { return v as? String ?? jsonText(v) }
        return a["description"] as? String ?? ""
      }.joined(separator: " ")
      if type != "warning" { tabs[k]?.consoleErrors += 1 }
      var e: [String: Any] = ["kind": "console", "level": type == "warning" ? "warning" : "error", "text": shortText(text)]
      if let f = ((p["stackTrace"] as? [String: Any])?["callFrames"] as? [[String: Any]])?.first { e["url"] = shortText(f["url"] as? String ?? ""); e["line"] = (f["lineNumber"] as? Int ?? 0) + 1 }
      log(k, e)
    case "Runtime.exceptionThrown":
      let d = p["exceptionDetails"] as? [String: Any] ?? [:]
      let desc = ((d["exception"] as? [String: Any])?["description"] as? String ?? d["text"] as? String ?? "error").components(separatedBy: "\n")[0]
      tabs[k]?.consoleErrors += 1
      var e: [String: Any] = ["kind": "exception", "text": shortText(desc)]
      if let u = d["url"] as? String { e["url"] = shortText(u); e["line"] = (d["lineNumber"] as? Int ?? 0) + 1 }
      log(k, e)
    case "Log.entryAdded":
      let e = p["entry"] as? [String: Any] ?? [:]
      let level = e["level"] as? String ?? ""
      guard level == "error" || level == "warning", e["source"] as? String != "network" else { return }
      if level == "error" { tabs[k]?.consoleErrors += 1 }
      log(k, ["kind": "console", "level": level, "text": shortText(e["text"] as? String ?? "")])
    case "Network.requestWillBeSent":
      let r = p["request"] as? [String: Any] ?? [:]
      tabs[k]?.requests[p["requestId"] as? String ?? ""] = (r["method"] as? String ?? "GET", shortText(r["url"] as? String ?? ""))
    case "Network.responseReceived":
      let r = p["response"] as? [String: Any] ?? [:]
      let status = r["status"] as? Int ?? Int(r["status"] as? Double ?? 0)
      let url = r["url"] as? String ?? ""
      if p["type"] as? String == "Document" && p["frameId"] as? String == tabs[k]?.frameId { tabs[k]?.status = status }
      if status >= 400 && !url.hasSuffix("/favicon.ico") {
        tabs[k]?.failedRequests += 1
        let rid = p["requestId"] as? String ?? ""
        log(k, ["kind": "network", "method": tabs[k]?.requests[rid]?.0 ?? "GET", "url": shortText(url), "status": status, "type": p["type"] as? String ?? "", "requestId": rid])
      }
    case "Network.loadingFailed":
      if p["canceled"] as? Bool == true || p["blockedReason"] as? String == "inspector" { return }
      tabs[k]?.failedRequests += 1
      let rid = p["requestId"] as? String ?? ""
      let was = tabs[k]?.requests[rid]
      log(k, ["kind": "network", "method": was?.0 ?? "GET", "url": was?.1 ?? "", "error": shortText(p["errorText"] as? String ?? ""), "type": p["type"] as? String ?? "", "requestId": rid])
    default: break
    }
  }
}

// MARK: the hands connection

// MARK: Phase 89 (CU3): the dev tunnel (BSD sockets, loopback only)

/// c.tunnel {tunnel, port}: a listener on 127.0.0.1 (that port when free here, else any free one).
/// Each connection to it becomes a stream: {t:'s', ev:'open', tunnel, sid} to the server, then bytes
/// both ways as binary frames with the header {"s": sid}; {ev:'end'} when a side has no more to send,
/// {ev:'close'} when it's gone, {ev:'pause'|'resume'} for flow control.
final class HandsTunnels {
  static let maxTunnels = 4, maxStreams = 64
  final class Stream {
    let fd: Int32
    let tunnel: String
    var closed = false, paused = false, gotEof = false, serverEnded = false
    let wlock = NSLock()
    init(fd: Int32, tunnel: String) { self.fd = fd; self.tunnel = tunnel }
  }
  private struct Listener { let fd: Int32; let port: Int; let localPort: Int; var sids: Set<UInt32> }
  private let lock = NSLock()
  private var tunnels: [String: Listener] = [:]
  private var streams: [UInt32: Stream] = [:]
  private var nextSid: UInt32 = 0
  var sendText: ((String) -> Void)?
  var sendData: (([String: Any], Data) -> Void)?

  var count: Int { lock.lock(); defer { lock.unlock() }; return tunnels.count }

  /// The local port (throws denied_local / error).
  func open(id: String, port: Int) throws -> Int {
    guard id.range(of: "^[0-9a-f]{8,64}$", options: .regularExpression) != nil else { throw HandsOpError(code: "denied_local", message: "Not a tunnel id.") }
    guard port >= 1024 && port <= 65535 else { throw HandsOpError(code: "denied_local", message: "Dev tunnels use ports 1024 to 65535 only.") }
    lock.lock()
    defer { lock.unlock() }
    if let t = tunnels[id] { return t.localPort }
    guard tunnels.count < HandsTunnels.maxTunnels else { throw HandsOpError(code: "denied_local", message: "At most 4 dev tunnels at once on this Mac.") }
    var fd = HandsTunnels.listenOn(port)
    if fd < 0 { fd = HandsTunnels.listenOn(0) }
    guard fd >= 0 else { throw HandsOpError(code: "error", message: "Couldn't open a local port for the dev tunnel.") }
    var a = sockaddr_in()
    var al = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &al) } }
    let local = Int(UInt16(bigEndian: a.sin_port))
    tunnels[id] = Listener(fd: fd, port: port, localPort: local, sids: [])
    let t = Thread { [weak self] in self?.acceptLoop(id: id, fd: fd) }
    t.name = "sara.hands.tunnel"
    t.start()
    NSLog("Sara hands: dev tunnel 127.0.0.1:\(local) → the server's port \(port)")
    return local
  }

  /// c.untunnel (or Stop, or the connection dropped): the listener and its connections close.
  @discardableResult func close(_ id: String) -> Bool {
    lock.lock()
    guard let t = tunnels.removeValue(forKey: id) else { lock.unlock(); return false }
    var gone: [Stream] = []
    for sid in t.sids { if let st = streams.removeValue(forKey: sid) { gone.append(st) } }
    lock.unlock()
    Darwin.close(t.fd)
    for st in gone { shut(st) }
    return true
  }
  func closeAll() {
    lock.lock()
    let ids = Array(tunnels.keys)
    lock.unlock()
    for id in ids { close(id) }
  }

  /// {t:'s'} from the server.
  func control(_ m: [String: Any]) {
    guard let sid = (m["sid"] as? NSNumber)?.uint32Value else { return }
    lock.lock()
    guard let st = streams[sid] else { lock.unlock(); return }
    let ev = m["ev"] as? String ?? ""
    switch ev {
    case "end":
      st.serverEnded = true
      let both = st.gotEof
      lock.unlock()
      if !st.closed { Darwin.shutdown(st.fd, SHUT_WR) }
      if both { drop(sid, tell: false) }
      return
    case "close":
      lock.unlock()
      drop(sid, tell: false)
      return
    case "pause": st.paused = true
    case "resume": st.paused = false
    default: break
    }
    lock.unlock()
  }

  /// Bytes from the server for a stream (written to the Sara browser's connection).
  func data(sid: UInt32, _ d: Data) {
    lock.lock()
    let st = streams[sid]
    lock.unlock()
    guard let st, !st.closed else { return }
    st.wlock.lock()
    let ok = d.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
      guard let base = raw.baseAddress else { return true }
      var off = 0
      while off < raw.count {
        let k = Darwin.send(st.fd, base + off, raw.count - off, 0)
        if k <= 0 { return false }
        off += k
      }
      return true
    }
    st.wlock.unlock()
    if !ok { drop(sid, tell: true) }
  }

  /// Loopback only (127.0.0.1): nothing on the network can reach it. No SIGPIPE, not inherited.
  private static func listenOn(_ port: Int) -> Int32 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    if fd < 0 { return -1 }
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    var a = sockaddr_in()
    a.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    a.sin_family = sa_family_t(AF_INET)
    a.sin_port = in_port_t(UInt16(port).bigEndian)
    a.sin_addr.s_addr = UInt32(0x7f00_0001).bigEndian  // 127.0.0.1
    let ok = withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    if ok != 0 || listen(fd, 64) != 0 { Darwin.close(fd); return -1 }
    return fd
  }

  private func shut(_ st: Stream) {
    lock.lock()
    let was = st.closed
    st.closed = true
    lock.unlock()
    if !was { Darwin.shutdown(st.fd, SHUT_RDWR); Darwin.close(st.fd) }
  }
  private func drop(_ sid: UInt32, tell: Bool) {
    lock.lock()
    guard let st = streams.removeValue(forKey: sid) else { lock.unlock(); return }
    if var t = tunnels[st.tunnel] { t.sids.remove(sid); tunnels[st.tunnel] = t }
    lock.unlock()
    shut(st)
    if tell { sendText?("{\"t\":\"s\",\"ev\":\"close\",\"sid\":\(sid)}") }
  }
  private func alive(_ id: String, _ fd: Int32) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return tunnels[id]?.fd == fd
  }
  /// poll() with a short timeout, so closing the tunnel ends this loop (close() alone doesn't wake accept on macOS).
  private func acceptLoop(id: String, fd: Int32) {
    while alive(id, fd) {
      var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
      if poll(&p, 1, 250) <= 0 { continue }
      guard alive(id, fd) else { return }
      let c = accept(fd, nil, nil)
      if c < 0 { continue }
      var one: Int32 = 1
      setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
      setsockopt(c, IPPROTO_TCP, TCP_NODELAY, &one, socklen_t(MemoryLayout<Int32>.size))
      _ = fcntl(c, F_SETFD, FD_CLOEXEC)
      lock.lock()
      guard var t = tunnels[id], t.fd == fd, t.sids.count < HandsTunnels.maxStreams else { lock.unlock(); Darwin.close(c); continue }
      nextSid += 1
      let sid = nextSid
      let st = Stream(fd: c, tunnel: id)
      streams[sid] = st
      t.sids.insert(sid)
      tunnels[id] = t
      lock.unlock()
      sendText?("{\"t\":\"s\",\"ev\":\"open\",\"tunnel\":\"\(id)\",\"sid\":\(sid)}")
      let r = Thread { [weak self] in self?.readLoop(sid: sid, st: st) }
      r.name = "sara.hands.stream"
      r.start()
    }
  }
  private func readLoop(sid: UInt32, st: Stream) {
    var buf = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      lock.lock()
      let closed = st.closed, paused = st.paused
      lock.unlock()
      if closed { return }
      if paused { usleep(10_000); continue }
      var p = pollfd(fd: st.fd, events: Int16(POLLIN), revents: 0)
      if poll(&p, 1, 250) <= 0 { continue }
      let n = buf.withUnsafeMutableBytes { recv(st.fd, $0.baseAddress, $0.count, 0) }
      if n > 0 { sendData?(["s": sid], Data(buf[0..<n])); continue }
      if n == 0 {
        // The browser sent all it will: tell the server; the stream stays for the answer.
        lock.lock()
        st.gotEof = true
        let both = st.serverEnded
        lock.unlock()
        sendText?("{\"t\":\"s\",\"ev\":\"end\",\"sid\":\(sid)}")
        if both { drop(sid, tell: false) }
        return
      }
      if errno == EINTR || errno == EAGAIN { continue }
      drop(sid, tell: true)
      return
    }
  }
}

final class Hands: NSObject, URLSessionWebSocketDelegate {
  static let ops: Set<String> = ["b.start", "b.tabs", "b.open", "b.navigate", "b.snapshot", "b.read", "b.screenshot", "b.logs", "b.request", "b.close", "c.ping",
                                  // Phase 88 (CU2)
                                  "b.find", "b.click", "b.type", "b.select", "b.keys", "b.scroll", "b.upload", "b.downloads",
                                  // Phase 89 (CU3): the dev tunnel
                                  "c.tunnel", "c.untunnel",
                                  // Phase 90 (CU4): saved logins and the sign-in pause
                                  "b.login", "b.saveLogin", "b.logins", "b.forgetLogin", "b.yourTurn"]
  /// Ops that act: they count against the input rate limit and stop when the person takes over.
  static let inputOps: Set<String> = ["b.click", "b.type", "b.select", "b.keys", "b.scroll", "b.upload", "b.login"]
  /// Phase 90: ops that wait for the person (the consent panel, "Your turn"): up to 10 minutes.
  static let waitingOps: Set<String> = ["b.saveLogin", "b.yourTurn"]
  /// Phase 90: Touch ID before a saved login is used (off by default).
  var verify = false
  static var shared: Hands?

  let server: String
  private(set) var token: String
  let computer: String
  let pageAgent: String
  let version: String
  var localOnly: Bool
  let browser: HandsBrowser
  private var session: URLSession!
  private var task: URLSessionWebSocketTask?
  private var stopping = false
  private var attempt = 0
  private let queue = DispatchQueue(label: "sara.hands.ops")
  private let lock = NSLock()
  private var cancels: [String: HandsCancel] = [:]
  private var answers: [String: String] = [:]
  private var answerOrder: [String] = []
  private var opens: [Date] = []
  private var frameN = 0
  private var lastFrame = Date.distantPast
  private var lastFrameHash = 0
  private(set) var connected = false
  private(set) var lastError = ""
  // Phase 88: acting, the badge, the stop shortcut, takeover, the local log, renewal.
  var keep: Bool
  private(set) var paused = false
  let downloadsDir: URL
  let logFile: URL
  private var expiresAt: String
  let testLabel: Bool
  var onToken: ((String, String) -> Void)?
  private var inputs: [Date] = []
  private var lastOpAt = Date.distantPast
  private var opRunning = false
  private var what = ""
  private var keptAt = Date.distantPast
  private var badge: NSPanel?
  private var badgeLabel: NSTextField?
  private var badgeDot: NSView?
  private var resumeButton: NSButton?
  private var timer: Timer?
  private var lastIdle: Double = -1
  private var hotKeyRef: EventHotKeyRef?
  private var hotKeyHandler: EventHandlerRef?
  private(set) var hotkeyOk = false
  /// Phase 89: the dev tunnels open on this Mac.
  let tunnels = HandsTunnels()

  init(server: String, token: String, computer: String, profileDir: URL, pageAgent: String, version: String, localOnly: Bool,
       keep: Bool = false, downloadsDir: URL, logFile: URL, expiresAt: String = "", testLabel: Bool = false) {
    self.server = server
    self.token = token
    self.computer = computer
    self.pageAgent = pageAgent
    self.version = version
    self.localOnly = localOnly
    self.keep = keep
    self.downloadsDir = downloadsDir
    self.logFile = logFile
    self.expiresAt = expiresAt
    self.testLabel = testLabel
    browser = HandsBrowser(serverOrigin: server.lowercased(), profileDir: profileDir)
    browser.downloadsDir = downloadsDir
    if !pageAgent.isEmpty { browser.catchScript = "(\(pageAgent)).call(\"catchLogins\", {})" }
    super.init()
    tunnels.sendText = { [weak self] in self?.sendText($0) }
    tunnels.sendData = { [weak self] h, d in self?.sendBinary(h, d) }
    pruneLog()
    // The badge and the stop shortcut before the first hello (so it says whether ⌃⌥Esc is free).
    if Thread.isMainThread { setUpUI() } else { DispatchQueue.main.sync { self.setUpUI() } }
    let cfg = URLSessionConfiguration.ephemeral
    // Never cookies: the token is the only sign-in this connection has.
    cfg.httpShouldSetCookies = false
    cfg.httpCookieStorage = nil
    cfg.urlCache = nil
    session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
  }

  func start() { connect() }

  func stop() {
    lock.lock()
    stopping = true
    for c in cancels.values { c.set() }
    lock.unlock()
    tunnels.closeAll()
    tunnels.sendText = nil
    tunnels.sendData = nil
    let tearDown = { [weak self] in self?.tearDownUI() }
    if Thread.isMainThread { tearDown() } else { DispatchQueue.main.sync(execute: tearDown) }
    task?.cancel(with: .goingAway, reason: nil)
    session.invalidateAndCancel()
    queue.async { [browser] in browser.close() }
  }

  private func connect() {
    lock.lock()
    if stopping { lock.unlock(); return }
    lock.unlock()
    guard var u = URLComponents(string: server + "/api/hands") else { return }
    u.scheme = u.scheme == "https" ? "wss" : "ws"
    var req = URLRequest(url: u.url!)
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.httpShouldHandleCookies = false
    let t = session.webSocketTask(with: req)
    task = t
    t.resume()
    receive(t)
  }

  private func later() {
    lock.lock()
    let stop = stopping
    lock.unlock()
    if stop { return }
    let backoff: [Double] = [1, 2, 5, 10, 30]
    let s = lastError.contains("signed out") ? 300 : backoff[min(attempt, backoff.count - 1)]
    attempt += 1
    DispatchQueue.global().asyncAfter(deadline: .now() + s) { [weak self] in self?.connect() }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    guard webSocketTask === task else { return }
    connected = true
    attempt = 0
    lastError = ""
    NSLog("Sara hands: connected to \(server)")
    sendText(hello())
    // Phase 88: with under 30 days left on the token, ask for a fresh one over this connection.
    if !expiresAt.isEmpty, let end = ISO8601DateFormatter.withFraction.date(from: expiresAt) ?? ISO8601DateFormatter().date(from: expiresAt), end.timeIntervalSinceNow < 30 * 86400 {
      sendText(jsonText(["t": "renew"]))
    }
  }

  func urlSession(_ session: URLSession, task t: URLSessionTask, didCompleteWithError error: Error?) {
    guard t === task else { return }
    if let r = t.response as? HTTPURLResponse {
      switch r.statusCode {
      case 401: lastError = "This Mac was signed out: switch \"Let Sara use this computer\" off and on again."
      case 403: lastError = "The server refused this Mac (computer use is off for you there)."
      case 101: break
      default: lastError = "The server doesn't take computer use (HTTP \(r.statusCode)): update Sara there."
      }
    } else if error != nil { lastError = "Couldn't reach the server." }
    dropped()
  }

  private func dropped() {
    let was = connected
    connected = false
    lock.lock()
    for c in cancels.values { c.set() }
    lock.unlock()
    // Phase 89: every dev tunnel closes with the connection.
    tunnels.closeAll()
    if was { NSLog("Sara hands: disconnected") }
    later()
  }

  private func receive(_ t: URLSessionWebSocketTask) {
    t.receive { [weak self] result in
      guard let self, t === self.task else { return }
      switch result {
      case .failure: return  // didCompleteWithError reconnects
      case .success(let m):
        if case .string(let s) = m { self.onText(s) }
        // Phase 89: the only binary the server sends is dev tunnel bytes: header {"s": sid}, then data.
        if case .data(let d) = m, d.count >= 4 {
          let hl = Int(d[d.startIndex]) << 24 | Int(d[d.startIndex + 1]) << 16 | Int(d[d.startIndex + 2]) << 8 | Int(d[d.startIndex + 3])
          if hl > 0, hl <= 4096, d.count >= 4 + hl, let h = (try? JSONSerialization.jsonObject(with: d.subdata(in: d.startIndex + 4 ..< d.startIndex + 4 + hl))) as? [String: Any], let sid = (h["s"] as? NSNumber)?.uint32Value {
            self.tunnels.data(sid: sid, d.subdata(in: d.startIndex + 4 + hl ..< d.endIndex))
          }
        }
        self.receive(t)
      }
    }
  }

  func sendText(_ s: String) { task?.send(.string(s)) { _ in } }
  func sendBinary(_ header: [String: Any], _ data: Data) {
    let h = Data(jsonText(header).utf8)
    var out = Data([UInt8(h.count >> 24 & 0xff), UInt8(h.count >> 16 & 0xff), UInt8(h.count >> 8 & 0xff), UInt8(h.count & 0xff)])
    out.append(h)
    out.append(data)
    task?.send(.data(out)) { _ in }
  }

  func hello() -> String {
    let os = ProcessInfo.processInfo.operatingSystemVersion
    var browserInfo: [String: Any] = ["found": browser.found != nil]
    if let f = browser.found { browserInfo["kind"] = f.kind; browserInfo["name"] = f.name }
    return jsonText(["t": "hello", "v": 1, "app": version, "os": "macOS \(os.majorVersion).\(os.minorVersion).\(os.patchVersion)", "computer": computer, "screens": [] as [Any],
                     "browser": browserInfo, "perms": ["capture": false, "input": false, "ax": false], "optIn": ["browser": true, "desktop": false], "approvalsHere": false,
                     "logins": HandsLogins.views(server: browser.serverOrigin), "vault": ["kind": "keychain", "verify": verify], "busy": false, "localOnly": localOnly, "ops": Array(Hands.ops).sorted(),
                     "takeover": keep ? "keep" : "pause", "hotkey": hotkeyOk ? "⌃⌥Esc" : "", "paused": paused, "renew": true] as [String: Any])
  }

  /// Phase 90: the server hears at once when the logins here changed (names and sites only).
  func tellLogins() {
    sendText(jsonText(["t": "ev", "kind": "logins", "logins": HandsLogins.views(server: browser.serverOrigin), "vault": ["kind": "keychain", "verify": verify]] as [String: Any]))
  }
  /// Phase 90: removes one of this server's logins here (or all): the web Settings, the app's Settings.
  func forgetHere(_ name: String?) -> Int {
    let n = HandsLogins.remove(server: browser.serverOrigin, name: name)
    if n > 0 {
      localLog("b.forgetLogin", name == nil ? "removed every saved login" : "removed the saved login \u{201c}\(name ?? "")\u{201d}", "")
      tellLogins()
    }
    return n
  }
  func pressStop() {
    lock.lock()
    for c in cancels.values { c.set() }
    // Stop ends the task: the badge goes, and a pause ends with it.
    let wasPaused = paused
    paused = false
    lastOpAt = .distantPast
    lock.unlock()
    sendText(jsonText(["t": "ev", "kind": "stopped", "by": "user"]))
    // Stop ends the dev tunnels here too.
    tunnels.closeAll()
    if wasPaused { sendText(jsonText(["t": "ev", "kind": "resumed"])) }
    NSLog("Sara hands: stopped by the person at the Mac")
    #if DEBUG
    testLog("hands: stopped by the person")
    #endif
    updateBadge()
  }
  func tellLocalOnly(_ on: Bool) {
    localOnly = on
    sendText(jsonText(["t": "ev", "kind": "optin", "optIn": ["browser": true, "desktop": false], "localOnly": on, "takeover": keep ? "keep" : "pause"] as [String: Any]))
  }
  /// Phase 88: "When you move the mouse" changed.
  func tellTakeover(_ keepControl: Bool) {
    keep = keepControl
    if keepControl { resume() }
    sendText(jsonText(["t": "ev", "kind": "optin", "optIn": ["browser": true, "desktop": false], "localOnly": localOnly, "takeover": keepControl ? "keep" : "pause"] as [String: Any]))
  }
  /// Phase 88: the person used her window (real input: DevTools input never reaches the Mac's event stream).
  func userInput() {
    if keep { keptAt = Date(); updateBadge(); return }
    lock.lock()
    if paused { lock.unlock(); return }
    paused = true
    for (id, c) in cancels where acting.contains(id) { takenOver.insert(id); c.set() }
    lock.unlock()
    NSLog("Sara hands: paused, the person took over the Sara browser")
    #if DEBUG
    testLog("hands: paused (takeover)")
    #endif
    sendText(jsonText(["t": "ev", "kind": "takeover"]))
    updateBadge()
  }
  func resume() {
    lock.lock()
    let was = paused
    paused = false
    lastOpAt = Date()
    lock.unlock()
    guard was else { return }
    #if DEBUG
    testLog("hands: resumed")
    #endif
    sendText(jsonText(["t": "ev", "kind": "resumed"]))
    updateBadge()
  }
  var statusLine: String {
    if connected { return "Connected to Sara at \(URL(string: server)?.host ?? server)\(URL(string: server)?.port.map { ":\($0)" } ?? "")" }
    return lastError.isEmpty ? "Connecting to Sara…" : lastError
  }
  private var acting: Set<String> = []
  private var takenOver: Set<String> = []

  private func onText(_ raw: String) {
    guard let m = parseJSON(raw) else { return }
    let t = m["t"] as? String
    if t == "token", let tok = m["token"] as? String, tok.hasPrefix("sara_hands."), tok.count < 300 {
      // Phase 88: a fresh token (we asked for it): kept by the app, used from the next connection on.
      token = tok
      expiresAt = m["expiresAt"] as? String ?? ""
      let exp = expiresAt
      DispatchQueue.main.async { [weak self] in self?.onToken?(tok, exp) }
      NSLog("Sara hands: renewed this Mac's sign-in")
      #if DEBUG
      testLog("hands: renewed this Mac's sign-in")
      #endif
      return
    }
    if t == "cancel" {
      lock.lock()
      if m["all"] as? Bool == true { for c in cancels.values { c.set() } } else if let id = m["id"] as? String { cancels[id]?.set() }
      lock.unlock()
      return
    }
    if t == "s" { return tunnels.control(m) }  // Phase 89: a dev tunnel stream's control message
    guard t == "req", let id = m["id"] as? String, !id.isEmpty, id.count <= 100 else { return }
    // Phase 89: tunnels open and close at once (never queued behind a slow page).
    if let op = m["op"] as? String, op == "c.tunnel" || op == "c.untunnel" {
      let a = m["args"] as? [String: Any] ?? [:]
      let tid = a["tunnel"] as? String ?? ""
      do {
        let r: [String: Any]
        if op == "c.tunnel" {
          let local = try tunnels.open(id: tid, port: (a["port"] as? NSNumber)?.intValue ?? 0)
          r = ["localPort": local, "url": "http://127.0.0.1:\(local)"]
        } else {
          r = ["closed": tunnels.close(tid)]
        }
        sendText(jsonText(["t": "res", "id": id, "ok": true, "result": r] as [String: Any]))
      } catch let e as HandsOpError {
        sendText(jsonText(["t": "res", "id": id, "ok": false, "error": ["code": e.code, "message": e.message]] as [String: Any]))
      } catch {
        sendText(jsonText(["t": "res", "id": id, "ok": false, "error": ["code": "error", "message": "Something went wrong on the Mac."]] as [String: Any]))
      }
      return
    }
    lock.lock()
    // A retried request gets the first answer (a running one isn't run twice).
    if let a = answers[id] { lock.unlock(); return sendText(a) }
    if cancels[id] != nil { lock.unlock(); return }
    let cancel = HandsCancel()
    cancels[id] = cancel
    let op = m["op"] as? String ?? ""
    // Phase 88 (§7.7): at most 4 actions a second and 120 a minute, counted as they arrive (ops run
    // one at a time, so a flood would otherwise just queue up behind each other).
    if Hands.inputOps.contains(op) {
      inputs = inputs.filter { Date().timeIntervalSince($0) < 60 }
      let lastSecond = inputs.filter { Date().timeIntervalSince($0) < 1 }.count
      if lastSecond >= 4 || inputs.count >= 120 {
        cancels[id] = nil
        lock.unlock()
        return sendText(jsonText(["t": "res", "id": id, "ok": false, "error": ["code": "rate_limited", "message": "At most 4 actions a second and 120 a minute in the Sara browser."]] as [String: Any]))
      }
      inputs.append(Date())
      acting.insert(id)
    }
    lock.unlock()
    let opWhat = shortText(m["what"] as? String ?? "", 120)
    let args = m["args"] as? [String: Any] ?? [:]
    let deadline = min(Hands.waitingOps.contains(op) ? 600 : 120, max(1, (m["deadlineMs"] as? Double ?? Double(m["deadlineMs"] as? Int ?? 30000)) / 1000))
    DispatchQueue.global().asyncAfter(deadline: .now() + deadline) { cancel.set() }
    queue.async { [weak self] in
      guard let self else { return }
      let started = Date()
      var reply: [String: Any]
      let shows = op != "c.ping" && op != "b.tabs"
      if shows {
        self.lock.lock()
        if !opWhat.isEmpty { self.what = opWhat }
        self.opRunning = true
        self.lastOpAt = Date()
        self.lock.unlock()
        self.updateBadge()
      }
      do {
        if cancel.isSet { throw HandsOpError(code: "stopped", message: "Stopped.") }
        var a2 = args
        if Hands.inputOps.contains(op) { a2["__what"] = opWhat }
        let r = try self.run(id: id, op: op, args: a2, cancel: cancel, deadline: deadline)
        reply = ["t": "res", "id": id, "ok": true, "result": r]
      } catch let e as HandsOpError {
        var code = e.code
        var msg = e.message
        if code == "stopped" && Date().timeIntervalSince(started) >= deadline - 0.05 { code = "timeout"; msg = "Took longer than \(Int(deadline)) s." }
        self.lock.lock()
        let byTakeover = self.takenOver.contains(id)
        self.lock.unlock()
        if code == "stopped" && byTakeover { code = "takeover"; msg = "Paused: the owner took over the Sara browser. Nothing acts until they press Resume." }
        reply = ["t": "res", "id": id, "ok": false, "error": ["code": code, "message": String(handsMask(msg).prefix(500))]]
      } catch {
        reply = ["t": "res", "id": id, "ok": false, "error": ["code": "error", "message": "Something went wrong on the Mac."]]
      }
      let text = jsonText(reply)
      self.lock.lock()
      if shows { self.opRunning = false; self.lastOpAt = Date() }
      self.acting.remove(id)
      self.takenOver.remove(id)
      self.cancels[id] = nil
      self.answers[id] = text
      self.answerOrder.append(id)
      if self.answerOrder.count > 100 { self.answers[self.answerOrder.removeFirst()] = nil }
      self.lock.unlock()
      self.sendText(text)
    }
  }

  // MARK: the ops
  private func shot(_ t: HandsBrowser.Tab, maxWidth: Double, quality: Int, cancel: HandsCancel?) throws -> (Data, Int, Int) {
    let m = try browser.call("Page.getLayoutMetrics", [:], session: t.sessionId, cancel: cancel)
    let vv = m["cssVisualViewport"] as? [String: Any] ?? [:]
    let vw = max(1, vv["clientWidth"] as? Double ?? Double(vv["clientWidth"] as? Int ?? 1280)), vh = max(1, vv["clientHeight"] as? Double ?? Double(vv["clientHeight"] as? Int ?? 800))
    let scale = min(1, maxWidth / vw)
    let r = try browser.call("Page.captureScreenshot", ["format": "jpeg", "quality": quality, "clip": ["x": 0, "y": 0, "width": vw, "height": vh, "scale": scale]], session: t.sessionId, timeout: 30, cancel: cancel)
    return (Data(base64Encoded: r["data"] as? String ?? "") ?? Data(), Int((vw * scale).rounded()), Int((vh * scale).rounded()))
  }
  private func thumb(_ id: String, _ t: HandsBrowser.Tab, _ args: [String: Any], _ cancel: HandsCancel) {
    let w = args["thumb"] as? Double ?? Double(args["thumb"] as? Int ?? 0)
    guard w >= 64 && w <= 640, let s = try? shot(t, maxWidth: w, quality: 55, cancel: cancel), !s.0.isEmpty else { return }
    sendBinary(["id": id, "kind": "thumb", "mime": "image/jpeg", "w": s.1, "h": s.2], s.0)
  }
  /// §3.5: a live-view frame after a change (at most one per 500 ms, only when the picture changed).
  private func frame(_ t: HandsBrowser.Tab) {
    guard Date().timeIntervalSince(lastFrame) >= 0.5, let s = try? shot(t, maxWidth: 960, quality: 60, cancel: nil), !s.0.isEmpty else { return }
    let h = s.0.hashValue
    if h == lastFrameHash { return }
    lastFrameHash = h
    lastFrame = Date()
    frameN += 1
    sendBinary(["frame": frameN, "mime": "image/jpeg", "w": s.1, "h": s.2], s.0)
  }
  private func info(_ t: HandsBrowser.Tab) -> [String: Any] {
    let r = (try? browser.call("Target.getTargetInfo", ["targetId": t.targetId]))?["targetInfo"] as? [String: Any] ?? [:]
    return ["url": r["url"] as? String ?? "", "title": handsMask(r["title"] as? String ?? "")]
  }
  private func counts(_ id: String) -> [String: Any] {
    let t = try? browser.tab(id)
    return ["consoleErrors": t?.consoleErrors ?? 0, "failedRequests": t?.failedRequests ?? 0]
  }
  /// One page-agent function in an isolated world (the page's own scripts can't touch it).
  private func agent(_ t: HandsBrowser.Tab, _ fn: String, _ args: [String: Any], _ cancel: HandsCancel) throws -> [String: Any] {
    let tree = try browser.call("Page.getFrameTree", [:], session: t.sessionId, cancel: cancel)
    let frameId = ((tree["frameTree"] as? [String: Any])?["frame"] as? [String: Any])?["id"] as? String ?? ""
    let w = try browser.call("Page.createIsolatedWorld", ["frameId": frameId, "worldName": "sara-page-agent"], session: t.sessionId, cancel: cancel)
    let expr = "(\(pageAgent)).call(\(jsonQuote(fn)), \(jsonText(args)))"
    let r = try browser.call("Runtime.evaluate", ["expression": expr, "contextId": w["executionContextId"] ?? 0, "returnByValue": true], session: t.sessionId, timeout: 20, cancel: cancel)
    if r["exceptionDetails"] != nil { throw HandsOpError(code: "error", message: "The page couldn't be read.") }
    return (r["result"] as? [String: Any])?["value"] as? [String: Any] ?? [:]
  }
  private func tabsList() -> [[String: Any]] {
    let act = browser.activeId
    return browser.allTabs().map { t in (["tab": t.id, "active": t.id == act] as [String: Any]).merging(info(t)) { a, _ in a } }
  }

  private func run(id: String, op: String, args a: [String: Any], cancel: HandsCancel, deadline: Double) throws -> [String: Any] {
    guard Hands.ops.contains(op) else { throw HandsOpError(code: "unsupported", message: "This computer doesn't do \"\(op.prefix(40))\" (not in its command set).") }
    if op == "c.ping" { return ["pong": true, "at": Date().timeIntervalSince1970] }
    // Phase 88: nothing acts while the person has taken over; and the device's own rate limit.
    if Hands.inputOps.contains(op) {
      lock.lock()
      let p = paused
      lock.unlock()
      if p { throw HandsOpError(code: "takeover", message: "Paused: the owner took over the Sara browser. Nothing acts until they press Resume.") }
    }
    if op == "b.downloads" { return ["files": downloadsList()] }
    // Phase 90: the saved logins here (names and sites only go back) and the sign-in pause.
    if op == "b.logins" { return ["logins": HandsLogins.views(server: browser.serverOrigin), "verify": verify] }
    if op == "b.forgetLogin" {
      let all = a["all"] as? Bool == true
      let name = handsCleanName(a["name"] as? String ?? "")
      if !all && name.isEmpty { throw HandsOpError(code: "not_found", message: "Say which saved login to remove.") }
      let n = forgetHere(all ? nil : name)
      return ["removed": n, "logins": HandsLogins.views(server: browser.serverOrigin)]
    }
    if op == "b.yourTurn" { return try yourTurn(a, cancel) }
    if op != "b.tabs" || browser.running { try browser.start() }
    switch op {
    case "b.start": return ["browser": ["kind": browser.found?.kind ?? "", "name": browser.found?.name ?? ""], "tabs": tabsList()]
    case "b.tabs": return ["tabs": browser.running ? tabsList() : []]
    case "b.open":
      let url = a["url"] as? String ?? ""
      if let why = handsAddressAllowed(url, serverOrigin: browser.serverOrigin) { throw HandsOpError(code: "denied_local", message: why) }
      opens = opens.filter { Date().timeIntervalSince($0) < 60 }
      if opens.count >= 20 { throw HandsOpError(code: "rate_limited", message: "At most 20 pages a minute in the Sara browser.") }
      opens.append(Date())
      var tid = ""
      if a["newTab"] as? Bool == true || browser.tabCount == 0 { tid = try browser.newTab() }
      let t = try browser.tab(tid)
      browser.activate(t.id)
      browser.resetCounts(t.id, clearLogs: true)
      let before = browser.loads(t.id)
      let nav = try browser.call("Page.navigate", ["url": url], session: t.sessionId, timeout: 30, cancel: cancel)
      if let err = nav["errorText"] as? String { throw HandsOpError(code: "not_found", message: "The page didn't open: \(err)") }
      _ = browser.waitLoad(t.id, after: before, timeout: min(deadline, 60), cancel: cancel)
      if cancel.isSet { throw HandsOpError(code: "stopped", message: "Stopped.") }
      Thread.sleep(forTimeInterval: 0.25)
      let now = try browser.tab(t.id)
      thumb(id, now, a, cancel)
      frame(now)
      return (["tab": now.id, "status": now.status] as [String: Any]).merging(info(now)) { x, _ in x }.merging(counts(now.id)) { x, _ in x }
    default: break
    }
    let t = try browser.tab(a["tab"] as? String ?? "")
    switch op {
    case "b.navigate":
      browser.activate(t.id)
      let action = a["action"] as? String ?? "reload"
      let before = browser.loads(t.id)
      if action == "reload" {
        browser.resetCounts(t.id)
        _ = try browser.call("Page.reload", [:], session: t.sessionId, timeout: 30, cancel: cancel)
      } else if action == "back" || action == "forward" {
        let h = try browser.call("Page.getNavigationHistory", [:], session: t.sessionId, cancel: cancel)
        let entries = h["entries"] as? [[String: Any]] ?? []
        let i = (h["currentIndex"] as? Int ?? 0) + (action == "back" ? -1 : 1)
        guard i >= 0 && i < entries.count else { throw HandsOpError(code: "not_found", message: "There is no page to go \(action) to.") }
        if handsAddressAllowed(entries[i]["url"] as? String ?? "", serverOrigin: browser.serverOrigin) != nil { throw HandsOpError(code: "denied_local", message: "That page isn't opened in the Sara browser.") }
        _ = try browser.call("Page.navigateToHistoryEntry", ["entryId": entries[i]["id"] ?? 0], session: t.sessionId, cancel: cancel)
      } else { throw HandsOpError(code: "unsupported", message: "action: back, forward or reload.") }
      _ = browser.waitLoad(t.id, after: before, timeout: min(deadline, 15), cancel: cancel)
      Thread.sleep(forTimeInterval: 0.2)
      thumb(id, t, a, cancel)
      frame(t)
      return (["tab": t.id] as [String: Any]).merging(info(t)) { x, _ in x }.merging(counts(t.id)) { x, _ in x }
    case "b.snapshot":
      var r = try agent(t, "snapshot", ["from": a["from"] ?? 0, "limit": 400], cancel)
      thumb(id, t, a, cancel)
      r["tab"] = t.id
      r["viewId"] = "v\(Int(Date().timeIntervalSince1970 * 1000))"
      return r.merging(counts(t.id)) { x, _ in x }
    case "b.read":
      var args: [String: Any] = ["max": a["max"] ?? 8000]
      if let ref = a["ref"] as? String { args["ref"] = ref }
      var r = try agent(t, "text", args, cancel)
      if let e = r["error"] as? String { throw HandsOpError(code: "not_found", message: e) }
      r["tab"] = t.id
      return r
    case "b.screenshot":
      let mw = min(1920, max(160, a["maxWidth"] as? Double ?? Double(a["maxWidth"] as? Int ?? 1280)))
      let q = min(90, max(30, a["quality"] as? Int ?? 70))
      let s = try shot(t, maxWidth: mw, quality: q, cancel: cancel)
      let viewId = "v\(Int(Date().timeIntervalSince1970 * 1000))"
      sendBinary(["id": id, "kind": "shot", "mime": "image/jpeg", "w": s.1, "h": s.2, "viewId": viewId], s.0)
      return ["tab": t.id, "w": s.1, "h": s.2, "viewId": viewId]
    case "b.logs":
      let since = a["since"] as? Int ?? Int(a["since"] as? Double ?? 0)
      return (["tab": t.id, "entries": browser.logs(t.id, since: since), "last": browser.seq] as [String: Any]).merging(info(t)) { x, _ in x }
    case "b.request":
      let rid = a["requestId"] as? String ?? ""
      guard let body = try? browser.call("Network.getResponseBody", ["requestId": rid], session: t.sessionId, cancel: cancel) else {
        throw HandsOpError(code: "not_found", message: "That response is no longer kept by the browser (reload and look again).")
      }
      let status = browser.statusOf(t.id, request: rid)
      if body["base64Encoded"] as? Bool == true { return ["status": status, "mime": "binary", "body": "(not text)", "truncated": false] }
      let text = handsMask(body["body"] as? String ?? "")
      return ["status": status, "mime": "text", "body": String(text.prefix(64 * 1024)), "truncated": text.count > 64 * 1024]
    case "b.find":
      if a["focused"] as? Bool == true {
        let st = try agent(t, "state", [:], cancel)
        let focus = st["focus"] as? String ?? ""
        return ["found": true, "role": "page", "name": focus, "desc": focus.isEmpty ? "the page" : focus, "page": ["url": st["url"] ?? "", "title": st["title"] ?? ""]]
      }
      return try agent(t, "target", targetArgs(a), cancel)
    case "b.click", "b.type", "b.select", "b.keys", "b.upload":
      return try act(id: id, op: op, t: t, a: a, cancel: cancel)
    case "b.login": return try login(id: id, t: t, a: a, cancel: cancel)
    case "b.saveLogin": return try saveLogin(t: t, a: a, cancel: cancel)
    case "b.scroll":
      var r = try agent(t, "scroll", targetArgs(a), cancel)
      if let e = r["error"] as? String { throw HandsOpError(code: r["stale"] as? Bool == true ? "stale_view" : "not_found", message: e) }
      Thread.sleep(forTimeInterval: 0.15)
      thumb(id, t, a, cancel)
      frame(t)
      r["tab"] = t.id
      return r
    case "b.close":
      _ = try browser.call("Target.closeTarget", ["targetId": t.targetId], cancel: cancel)
      browser.forget(t.id)
      return ["closed": t.id]
    default:
      throw HandsOpError(code: "unsupported", message: "This computer doesn't do \"\(op)\".")
    }
  }
}

extension ISO8601DateFormatter {
  static let withFraction: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
}

// MARK: Phase 88: acting, the badge, the stop shortcut, takeover, the local log

extension Hands {
  /// The target arguments of an op (a ref checked against the last look, a label, or a picture point).
  func targetArgs(_ a: [String: Any]) -> [String: Any] {
    var o: [String: Any] = [:]
    for k in ["ref", "expect", "text", "field", "x", "y", "w", "h", "focused", "clear", "option", "dy"] { if let v = a[k] { o[k] = v } }
    return o
  }
  private func num(_ v: Any?) -> Double { (v as? Double) ?? Double(v as? Int ?? 0) }
  /// A real left click at a page point (mouse moved, pressed, released).
  private func mouseClick(_ t: HandsBrowser.Tab, _ x: Double, _ y: Double, _ cancel: HandsCancel) throws {
    _ = try browser.call("Input.dispatchMouseEvent", ["type": "mouseMoved", "x": x, "y": y, "button": "none"], session: t.sessionId, cancel: cancel)
    _ = try browser.call("Input.dispatchMouseEvent", ["type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1], session: t.sessionId, cancel: cancel)
    _ = try browser.call("Input.dispatchMouseEvent", ["type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1], session: t.sessionId, cancel: cancel)
  }
  /// The keys of a combination, as the page agent's list allows (anything else is refused here).
  private func pressKeys(_ t: HandsBrowser.Tab, _ combo: String, _ cancel: HandsCancel) throws {
    let plan = try agent(t, "keys", ["combo": combo], cancel)
    guard let events = plan["events"] as? [[String: Any]] else { throw HandsOpError(code: "denied_local", message: plan["error"] as? String ?? "Not a key Sara presses.") }
    for ev in events { _ = try browser.call("Input.dispatchKeyEvent", ev, session: t.sessionId, cancel: cancel) }
  }
  /// One page-agent function that returns an element: its object id ("" when it isn't one).
  private func agentNode(_ t: HandsBrowser.Tab, _ fn: String, _ args: [String: Any], _ cancel: HandsCancel) throws -> String {
    let tree = try browser.call("Page.getFrameTree", [:], session: t.sessionId, cancel: cancel)
    let frameId = ((tree["frameTree"] as? [String: Any])?["frame"] as? [String: Any])?["id"] as? String ?? ""
    let w = try browser.call("Page.createIsolatedWorld", ["frameId": frameId, "worldName": "sara-page-agent"], session: t.sessionId, cancel: cancel)
    let expr = "(\(pageAgent)).call(\(jsonQuote(fn)), \(jsonText(args)))"
    let r = try browser.call("Runtime.evaluate", ["expression": expr, "contextId": w["executionContextId"] ?? 0, "returnByValue": false], session: t.sessionId, timeout: 20, cancel: cancel)
    let res = r["result"] as? [String: Any] ?? [:]
    return res["subtype"] as? String == "node" ? res["objectId"] as? String ?? "" : ""
  }
  static func safeName(_ raw: String) -> String {
    var n = String(raw.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last ?? "")
    n = String(n.map { c -> Character in (c.asciiValue.map { $0 < 0x20 } ?? false) || "<>:\"|?*".contains(c) ? "_" : c })
    return String(n.prefix(120))
  }
  func downloadsList() -> [[String: Any]] {
    let fm = FileManager.default
    let items = (try? fm.contentsOfDirectory(at: downloadsDir, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey])) ?? []
    let iso = ISO8601DateFormatter()
    return items.compactMap { u -> [String: Any]? in
      let v = try? u.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey])
      guard v?.isRegularFile == true, !u.lastPathComponent.hasSuffix(".crdownload") else { return nil }
      return ["name": u.lastPathComponent, "bytes": v?.fileSize ?? 0, "at": iso.string(from: v?.contentModificationDate ?? Date())]
    }.sorted { ($0["at"] as? String ?? "") > ($1["at"] as? String ?? "") }.prefix(100).map { $0 }
  }
  /// "What Sara did on this Mac": one plain line per action (no pictures), kept 30 days.
  func localLog(_ op: String, _ what: String, _ target: String) {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd HH:mm:ss"
    f.timeZone = TimeZone(identifier: "UTC")
    let line = "\(f.string(from: Date()))  \(handsMask(what.isEmpty ? op : what))\(target.isEmpty ? "" : "  (\(handsMask(target)))")  [\(op)]\n"
    if let h = try? FileHandle(forWritingTo: logFile) { h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close() } else { try? line.write(to: logFile, atomically: true, encoding: .utf8) }
  }
  func pruneLog() {
    guard let text = try? String(contentsOf: logFile, encoding: .utf8) else { return }
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = TimeZone(identifier: "UTC")
    let cut = f.string(from: Date().addingTimeInterval(-30 * 86400))
    let kept = text.split(separator: "\n").filter { $0.count >= 10 && String($0.prefix(10)) >= cut }
    try? (kept.joined(separator: "\n") + (kept.isEmpty ? "" : "\n")).write(to: logFile, atomically: true, encoding: .utf8)
  }
  /// One acting op: the target, her highlight, the real input, then the after-state (§6.3).
  func act(id: String, op: String, t: HandsBrowser.Tab, a: [String: Any], cancel: HandsCancel) throws -> [String: Any] {
    browser.activate(t.id)
    let beforeUrl = (try? browser.call("Target.getTargetInfo", ["targetId": t.targetId]))?["targetInfo"].flatMap { ($0 as? [String: Any])?["url"] as? String } ?? ""
    _ = browser.takeDialog(t.id)
    let errs0 = t.consoleErrors, failed0 = t.failedRequests
    let starts0 = browser.starts(t.id)
    let tArgs = targetArgs(a)
    var target: [String: Any] = [:]
    var extra: [String: Any] = [:]
    func need() throws {
      target = try agent(t, "target", tArgs, cancel)
      guard target["found"] as? Bool == true else { throw HandsOpError(code: target["stale"] as? Bool == true ? "stale_view" : "not_found", message: target["error"] as? String ?? "That is not on the page.") }
      let desc = target["desc"] as? String ?? "That"
      if target["disabled"] as? Bool == true { throw HandsOpError(code: "not_found", message: "\(desc) is disabled.") }
      if let c = target["covered"] as? String, !c.isEmpty { throw HandsOpError(code: "not_found", message: "\(desc) is covered by \(c): close that first.") }
      _ = try? agent(t, "mark", ["x": target["x"] ?? 0, "y": target["y"] ?? 0, "box": target["box"] ?? NSNull(), "label": testLabel ? "Sara (TEST)" : "Sara"], cancel)
    }
    switch op {
    case "b.click":
      try need()
      try mouseClick(t, num(target["x"]), num(target["y"]), cancel)
    case "b.type":
      let value = a["value"] as? String ?? ""
      if value.count > 2000 { throw HandsOpError(code: "denied_local", message: "At most 2000 characters per action.") }
      if handsMask(value) != value { throw HandsOpError(code: "denied_local", message: "That text looks like a key or a sign-in token: Sara never types those.") }
      try need()
      if target["secret"] as? Bool == true { throw HandsOpError(code: "denied_local", message: "That is a password field: Sara never types into those.") }
      if target["editable"] as? Bool != true { throw HandsOpError(code: "not_found", message: "\(target["desc"] as? String ?? "That") is not a text field.") }
      try mouseClick(t, num(target["x"]), num(target["y"]), cancel)
      var fArgs = tArgs
      fArgs["clear"] = (a["clear"] as? Bool) ?? true
      let f = try agent(t, "focusFor", fArgs, cancel)
      if f["error"] != nil || f["focused"] as? Bool != true { throw HandsOpError(code: f["secret"] as? Bool == true ? "denied_local" : "not_found", message: f["error"] as? String ?? "That field could not be focused.") }
      if !value.isEmpty { _ = try browser.call("Input.insertText", ["text": value], session: t.sessionId, timeout: 20, cancel: cancel) }
      if a["submit"] as? Bool == true { try pressKeys(t, "Enter", cancel) }
    case "b.select":
      var cArgs = tArgs
      cArgs["option"] = a["option"] as? String ?? ""
      let c = try agent(t, "choose", cArgs, cancel)
      if let e = c["error"] as? String { throw HandsOpError(code: c["stale"] as? Bool == true ? "stale_view" : "not_found", message: e) }
      _ = try? agent(t, "mark", ["x": c["x"] ?? 0, "y": c["y"] ?? 0, "label": "Sara"], cancel)
      target = c
      extra["selected"] = c["selected"] ?? ""
    case "b.keys":
      try pressKeys(t, a["combo"] as? String ?? "", cancel)
      extra["combo"] = a["combo"] ?? ""
    case "b.upload":
      var name: String
      if let file = a["file"] as? [String: Any] {
        name = Hands.safeName(file["name"] as? String ?? "")
        let data = Data(base64Encoded: file["data"] as? String ?? "") ?? Data()
        if name.isEmpty || name.hasPrefix(".") || data.count > 2 * 1024 * 1024 { throw HandsOpError(code: "denied_local", message: "Uploads from the server are at most 2 MB.") }
        try? FileManager.default.createDirectory(at: downloadsDir, withIntermediateDirectories: true)
        do { try data.write(to: downloadsDir.appendingPathComponent(name)) } catch { throw HandsOpError(code: "error", message: "Couldn't put the file in Downloads/Sara.") }
      } else {
        name = a["name"] as? String ?? ""
        if name.isEmpty || name != Hands.safeName(name) || name.hasPrefix(".") { throw HandsOpError(code: "denied_local", message: "Only a file name in Downloads/Sara.") }
      }
      let path = downloadsDir.appendingPathComponent(name).path
      var isDir: ObjCBool = false
      guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir), !isDir.boolValue else { throw HandsOpError(code: "not_found", message: "There is no \(name) in Downloads/Sara on this Mac.") }
      try need()
      let objectId = try agentNode(t, "fileInput", tArgs, cancel)
      if objectId.isEmpty { throw HandsOpError(code: "not_found", message: "That is not a file upload field.") }
      _ = try browser.call("DOM.setFileInputFiles", ["files": [path], "objectId": objectId], session: t.sessionId, cancel: cancel)
      extra["name"] = name
    default: break
    }
    // After an action: wait for a page load it started (if any).
    let loads0 = browser.loads(t.id)
    if browser.waitStart(t.id, after: starts0, timeout: 0.5, cancel: cancel) { _ = browser.waitLoad(t.id, after: loads0, timeout: 15, cancel: cancel) }
    Thread.sleep(forTimeInterval: 0.25)
    if cancel.isSet { throw HandsOpError(code: "stopped", message: "Stopped.") }
    let st = (try? agent(t, "state", [:], cancel)) ?? [:]
    let desc = target["desc"] as? String ?? ""
    localLog(op, (a["__what"] as? String) ?? "", desc.isEmpty ? (a["combo"] as? String ?? "") : desc)
    thumb(id, t, a, cancel)
    let now = (try? browser.tab(t.id)) ?? t
    frame(now)
    let dialog = browser.takeDialog(t.id)
    var out: [String: Any] = ["tab": t.id, "target": ["desc": desc, "role": target["role"] ?? "", "name": target["name"] ?? ""], "state": st,
                              "navigated": (st["url"] as? String ?? beforeUrl) != beforeUrl, "newErrors": now.consoleErrors - errs0, "newFailed": now.failedRequests - failed0,
                              "consoleErrors": now.consoleErrors, "failedRequests": now.failedRequests]
    if !dialog.isEmpty { out["dialog"] = dialog }
    for (k, v) in extra { out[k] = v }
    return out
  }

  // MARK: Phase 90 (CU4): saved logins and the sign-in pause
  func yourTurn(_ a: [String: Any], _ cancel: HandsCancel) throws -> [String: Any] {
    var what = handsCleanName(shortText(a["what"] as? String ?? "", 120))
    if what.isEmpty { what = "sign in" }
    lock.lock(); self.what = "your turn: \(what)"; lock.unlock()
    updateBadge()
    let panel = HandsLoginPanel(kind: .turn, turnWhat: what.prefix(1).uppercased() + what.dropFirst(), test: testLabel)
    panel.run(cancel: cancel)
    if cancel.isSet || !panel.continued { throw HandsOpError(code: "stopped", message: "Stopped.") }
    var out: [String: Any] = ["continued": true]
    if browser.running, let t = try? browser.tab("") { out["tab"] = t.id; for (k, v) in info(t) { out[k] = v } }
    return out
  }
  /// b.login: fills a saved login, only on a page whose current origin is exactly one of its sites.
  func login(id: String, t: HandsBrowser.Tab, a: [String: Any], cancel: HandsCancel) throws -> [String: Any] {
    browser.activate(t.id)
    let server = browser.serverOrigin
    guard let meta = HandsLogins.find(server: server, name: a["name"] as? String ?? "") else { return ["outcome": "not_found", "missing": "login", "tab": t.id] }
    let url = ((try? browser.call("Target.getTargetInfo", ["targetId": t.targetId]))?["targetInfo"] as? [String: Any])?["url"] as? String ?? ""
    let origin = handsLoginOrigin(url)
    guard !origin.isEmpty, meta.sites.contains(origin) else { return ["outcome": "site_mismatch", "tab": t.id] }
    if verify {
      let (ok, why) = handsTouchID("sign in to \(origin) with your saved \u{201c}\(meta.name)\u{201d} login", cancel: cancel)
      if !ok { throw HandsOpError(code: cancel.isSet ? "stopped" : "denied_local", message: why) }
    }
    guard let secret = HandsLogins.secret(server: server, name: meta.name) else { return ["outcome": "not_found", "missing": "login", "tab": t.id] }
    // The page itself must say the same origin (its main frame, now), and have a password field.
    let f = try agent(t, "loginFields", [:], cancel)
    if handsLoginOrigin(f["origin"] as? String ?? "") != origin { return ["outcome": "site_mismatch", "tab": t.id] }
    guard let passAt = f["pass"] as? [String: Any] else { return ["outcome": "not_found", "missing": "fields", "tab": t.id] }
    let label = testLabel ? "Sara (TEST)" : "Sara"
    /// 0 typed, 1 not a field, 2 another origin.
    func put(_ which: String, _ at: [String: Any], _ text: String) throws -> Int {
      _ = try? agent(t, "mark", ["x": at["x"] ?? 0, "y": at["y"] ?? 0, "box": at["box"] ?? NSNull(), "label": label], cancel)
      try mouseClick(t, num(at["x"]), num(at["y"]), cancel)
      let fo = try agent(t, "focusLogin", ["which": which], cancel)
      if fo["focused"] as? Bool != true { return 1 }
      if handsLoginOrigin(fo["origin"] as? String ?? "") != origin { return 2 }
      if which == "pass" && fo["secret"] as? Bool != true { return 1 }
      // DevTools input on this Mac's pipe: the text goes into the page and nowhere else.
      _ = try browser.call("Input.insertText", ["text": text], session: t.sessionId, timeout: 20, cancel: cancel)
      return 0
    }
    var k = 0
    defer { browser.clearCaught() }  // her own fill is not something the person typed
    if let userAt = f["user"] as? [String: Any], !secret.username.isEmpty { k = try put("user", userAt, secret.username) }
    if k == 0 { k = try put("pass", passAt, secret.password) }
    if k == 2 { return ["outcome": "site_mismatch", "tab": t.id] }
    if k == 1 { return ["outcome": "not_found", "missing": "fields", "tab": t.id] }
    let starts0 = browser.starts(t.id), loads0 = browser.loads(t.id)
    let submit = a["submit"] as? Bool != false
    if submit { try pressKeys(t, "Enter", cancel) }
    if browser.waitStart(t.id, after: starts0, timeout: 0.5, cancel: cancel) { _ = browser.waitLoad(t.id, after: loads0, timeout: 15, cancel: cancel) }
    Thread.sleep(forTimeInterval: 0.25)
    browser.clearCaught()
    HandsLogins.touch(server: server, name: meta.name)
    localLog("b.login", "signed in with the saved login \u{201c}\(meta.name)\u{201d}", origin)
    thumb(id, t, a, cancel)
    frame((try? browser.tab(t.id)) ?? t)
    return ["outcome": "filled", "tab": t.id, "submitted": submit]
  }
  /// b.saveLogin: this Mac's own consent panel decides; saved only with "I understand" ticked.
  func saveLogin(t: HandsBrowser.Tab, a: [String: Any], cancel: HandsCancel) throws -> [String: Any] {
    let url = ((try? browser.call("Target.getTargetInfo", ["targetId": t.targetId]))?["targetInfo"] as? [String: Any])?["url"] as? String ?? ""
    let site = handsLoginOrigin(url)
    if site.isEmpty { throw HandsOpError(code: "not_found", message: "Open the site\u{2019}s sign-in page in the Sara browser first: a login is saved for the site that is open.") }
    var name = handsCleanName(a["name"] as? String ?? "")
    if name.isEmpty { name = handsDefaultName(site) }
    lock.lock(); what = "waiting for you to save a login"; lock.unlock()
    updateBadge()
    let panel = HandsLoginPanel(kind: .consent, site: site, name: name, warning: handsLoginWarning.replacingOccurrences(of: "{site}", with: site), typed: browser.takeCaught(site), test: testLabel)
    panel.run(cancel: cancel)
    if cancel.isSet { throw HandsOpError(code: "stopped", message: "Stopped.") }
    if !panel.save { return ["outcome": "cancelled", "why": "the owner pressed Cancel on the Mac"] }
    if !panel.understood { return ["outcome": "cancelled", "why": "the box \"I understand\" under the warning was not ticked"] }
    let saved = handsCleanName(panel.outName).isEmpty ? name : handsCleanName(panel.outName)
    let server = browser.serverOrigin
    if HandsLogins.list(server: server).filter({ $0.name.lowercased() != saved.lowercased() }).count >= HandsLogins.maxLogins { throw HandsOpError(code: "denied_local", message: "At most 100 saved logins per Sara on one Mac.") }
    let status = HandsLogins.save(HandsLogins.Meta(name: saved, sites: [site], server: server, created: ISO8601DateFormatter().string(from: Date()), lastUsed: ""), username: panel.outUser, password: panel.outPass)
    if status != errSecSuccess { throw HandsOpError(code: "error", message: "The Keychain couldn't keep the login (\(status)).") }
    browser.clearCaught()
    localLog("b.saveLogin", "saved the login \u{201c}\(saved)\u{201d}", site)
    tellLogins()
    return ["outcome": "saved", "name": saved, "sites": [site]]
  }

  // ---- the badge (floating, never in her pictures), the stop shortcut ⌃⌥Esc, takeover ----
  func setUpUI() {
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 40), styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
    panel.level = .statusBar
    panel.isFloatingPanel = true
    panel.hidesOnDeactivate = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = true
    panel.appearance = NSAppearance(named: .darkAqua)  // light text on its dark pill, in Day theme too
    panel.sharingType = .none  // her pictures never show her own badge
    panel.title = testLabel ? "TEST Sara is working" : "Sara is working"
    let v = NSView()
    v.wantsLayer = true
    v.layer?.backgroundColor = NSColor(calibratedRed: 0.125, green: 0.094, blue: 0.149, alpha: 0.96).cgColor
    v.layer?.cornerRadius = 20
    let dot = NSView(frame: NSRect(x: 14, y: 14, width: 12, height: 12))
    dot.wantsLayer = true
    dot.layer?.cornerRadius = 6
    dot.layer?.backgroundColor = NSColor(calibratedRed: 1, green: 0.24, blue: 0.545, alpha: 1).cgColor
    let label = NSTextField(labelWithString: "")
    label.font = .systemFont(ofSize: 13, weight: .semibold)
    label.textColor = .white
    label.lineBreakMode = .byTruncatingTail
    let stopB = NSButton(title: "Stop", target: self, action: #selector(badgeStop))
    stopB.bezelStyle = .rounded
    stopB.contentTintColor = .systemRed
    let resumeB = NSButton(title: "Resume", target: self, action: #selector(badgeResume))
    resumeB.bezelStyle = .rounded
    for x in [dot, label, stopB, resumeB] as [NSView] { v.addSubview(x) }
    panel.contentView = v
    badge = panel
    badgeLabel = label
    badgeDot = dot
    resumeButton = resumeB
    // ⌃⌥Esc anywhere: stop her at once (a Carbon hot key needs no Accessibility permission).
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, ev, ctx in
      guard let ev, let ctx else { return OSStatus(eventNotHandledErr) }
      var hk = EventHotKeyID()
      GetEventParameter(ev, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
      guard hk.signature == OSType(0x5341_5248), hk.id == 2 else { return OSStatus(eventNotHandledErr) }
      let me = Unmanaged<Hands>.fromOpaque(ctx).takeUnretainedValue()
      DispatchQueue.main.async { me.pressStop() }
      return noErr
    }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), &hotKeyHandler)
    var ref: EventHotKeyRef?
    let status = RegisterEventHotKey(UInt32(kVK_Escape), UInt32(controlKey | optionKey), EventHotKeyID(signature: OSType(0x5341_5248), id: 2), GetApplicationEventTarget(), 0, &ref)
    hotKeyRef = ref
    hotkeyOk = status == noErr
    NSLog("Sara hands: stop shortcut ⌃⌥Esc \(hotkeyOk ? "ready" : "is taken by another app (\(status))")")
    #if DEBUG
    testLog("hands: stop shortcut ready=\(hotkeyOk)")
    DistributedNotificationCenter.default().addObserver(self, selector: #selector(testHook(_:)), name: Notification.Name((Bundle.main.bundleIdentifier ?? "sara") + ".handsTest"), object: nil)
    #endif
    timer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in self?.tick() }
  }
  func tearDownUI() {
    timer?.invalidate()
    timer = nil
    if let r = hotKeyRef { UnregisterEventHotKey(r) }
    hotKeyRef = nil
    if let h = hotKeyHandler { RemoveEventHandler(h) }
    hotKeyHandler = nil
    badge?.orderOut(nil)
    badge = nil
    #if DEBUG
    DistributedNotificationCenter.default().removeObserver(self)
    #endif
  }
  @objc func badgeStop() { pressStop() }
  @objc func badgeResume() { resume() }
  #if DEBUG
  /// Test builds only: "input" acts as the person moving the mouse in her window, "resume" presses
  /// Resume, "hotkey" acts as ⌃⌥Esc, "shot:<path>" saves the badge as a PNG.
  @objc func testHook(_ n: Notification) {
    guard testLabel, let cmd = n.object as? String else { return }
    if cmd == "input" { userInput() } else if cmd == "resume" { resume() } else if cmd == "hotkey" { pressStop() }
    else if cmd.hasPrefix("login:") { let c = String(cmd.dropFirst(6)); DispatchQueue.main.async { HandsLoginPanel.current?.testDrive(c) } }
    else if cmd == "off" { DispatchQueue.main.async { (NSApp.delegate as? AppDelegate)?.handsOff(); testLog("hands: off (test item removed)") } }
    else if cmd.hasPrefix("shot:"), let v = badge?.contentView, let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
      v.cacheDisplay(in: v.bounds, to: rep)
      try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: String(cmd.dropFirst(5))))
    }
  }
  #endif
  func updateBadge() { DispatchQueue.main.async { [weak self] in self?.tick(force: true) } }
  private var badgeActive: Bool { lock.lock(); defer { lock.unlock() }; return paused || opRunning || Date().timeIntervalSince(lastOpAt) < 30 }
  private func badgeText() -> String {
    lock.lock()
    let p = paused, w = what, kept = keep && Date().timeIntervalSince(keptAt) < 8
    lock.unlock()
    let pre = testLabel ? "TEST · " : ""
    if p { return pre + "Paused: you're in control of the Sara browser" }
    return pre + "Sara is working in her browser" + (w.isEmpty ? "" : " · \(w)") + (kept ? " · she keeps control" : "")
  }
  private func tick(force: Bool = false) {
    watchTakeover()
    guard let panel = badge, let label = badgeLabel else { return }
    let on = badgeActive
    if !on { if panel.isVisible { panel.orderOut(nil) }; return }
    if !force && panel.isVisible { return }
    lock.lock()
    let p = paused
    lock.unlock()
    label.stringValue = badgeText()
    badgeDot?.layer?.backgroundColor = (p ? NSColor.systemOrange : NSColor(calibratedRed: 1, green: 0.24, blue: 0.545, alpha: 1)).cgColor
    label.sizeToFit()
    let textW = min(label.frame.width, 520)
    let w = 36 + textW + 12 + 72 + (p ? 84 : 0) + 10
    label.frame = NSRect(x: 34, y: 11, width: textW, height: 18)
    resumeButton?.isHidden = !p
    resumeButton?.frame = NSRect(x: w - 10 - 72 - 84, y: 4, width: 80, height: 32)
    panel.contentView?.subviews.first { ($0 as? NSButton)?.title == "Stop" }?.frame = NSRect(x: w - 10 - 72, y: 4, width: 72, height: 32)
    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    panel.setFrame(NSRect(x: screen.midX - w / 2, y: screen.maxY - 40 - 8, width: w, height: 40), display: true)
    panel.orderFrontRegardless()
  }
  /// Real input (not hers: DevTools input never reaches the Mac's event stream) in her window?
  private func watchTakeover() {
    let pid = browser.browserPid
    lock.lock()
    let p = paused
    lock.unlock()
    guard badgeActive, pid > 0, !p else { lastIdle = -1; return }
    let kinds: [CGEventType] = [.mouseMoved, .leftMouseDown, .rightMouseDown, .keyDown, .scrollWheel, .leftMouseDragged]
    let idle = kinds.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 1e9
    defer { lastIdle = idle }
    guard lastIdle >= 0, idle + 0.05 < lastIdle else { return }
    var under: pid_t = 0
    let m = NSEvent.mouseLocation
    let h = NSScreen.screens.first?.frame.height ?? 0
    let pt = CGPoint(x: m.x, y: h - m.y)
    if let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
      for w in list where (w[kCGWindowLayer as String] as? Int ?? 1) == 0 {
        if let b = w[kCGWindowBounds as String] as? [String: Any], let r = CGRect(dictionaryRepresentation: b as CFDictionary), r.contains(pt) {
          under = pid_t(w[kCGWindowOwnerPID as String] as? Int ?? 0)
          break
        }
      }
    }
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    if under == pid || front == pid { userInput() }
  }
}

// MARK: Phase 90 (CU4, docs/design/COMPUTER_USE.md §8.2): saved logins in the Keychain
// One generic-password item per login: service "Sara logins" (test builds: "Sara logins (TEST)", so the
// owner's real items are never touched), account "<server>\n<name>", accessible only when this Mac is
// unlocked and never synced or moved (kSecAttrAccessibleWhenUnlockedThisDeviceOnly). The secret
// (username and password) is the item's data; the name, sites, server and dates are its generic
// attribute, so listing never reads a secret. What goes to the server is names, sites and dates; the
// password goes only into the page, through DevTools input on the browser's pipe, and only when the
// page's current origin is exactly one of the login's sites. Saved only through the consent panel
// below, with "I understand" ticked.

let handsLoginWarning = "Saving this password lets Sara sign in to {site} for you on this computer. It's stored encrypted here, never on Sara's server, and she never sees it. Anyone who can use your account on this computer could use it too. Save it only if you're comfortable; signing in yourself once and letting the Sara browser remember you is safer."

/// The exact origin of a page address for logins ("" for anything but http(s), or with a user name).
func handsLoginOrigin(_ raw: String) -> String {
  guard let o = httpOrigin(raw), !o.userinfo else { return "" }
  return o.origin
}
/// A login name as people write it: no control characters, single spaces, at most 60 characters.
func handsCleanName(_ raw: String) -> String {
  let s = String(String.UnicodeScalarView(raw.unicodeScalars.map { $0.value < 0x20 || $0.value == 0x7f ? " " : $0 }))
  return String(s.split(separator: " ").joined(separator: " ").prefix(60))
}
func handsDefaultName(_ site: String) -> String {
  var h = URLComponents(string: site)?.host ?? ""
  if h.hasPrefix("www.") { h.removeFirst(4) }
  return handsCleanName(h.isEmpty ? "Login" : h)
}

enum HandsLogins {
  static var service: String = {
    #if DEBUG
    // Test copies (another bundle id) keep theirs apart, so the owner's real items are never touched.
    if Bundle.main.bundleIdentifier != "com.backstagecoding.sara.desktop" { return "Sara logins (TEST)" }
    #endif
    return "Sara logins"
  }()
  static let maxLogins = 100
  struct Meta {
    var name: String, sites: [String], server: String, created: String, lastUsed: String
    var json: [String: Any] { var o: [String: Any] = ["name": name, "sites": sites, "server": server, "created": created]; if !lastUsed.isEmpty { o["lastUsed"] = lastUsed }; return o }
    /// What may leave the Mac: names, sites, dates (never a username or password).
    var view: [String: Any] { var o: [String: Any] = ["name": name, "sites": sites, "created": created]; if !lastUsed.isEmpty { o["lastUsed"] = lastUsed }; return o }
  }
  static func account(_ server: String, _ name: String) -> String { server + "\n" + handsCleanName(name).lowercased() }
  static func all() -> [Meta] {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let items = out as? [[String: Any]] else { return [] }
    return items.compactMap { a -> Meta? in
      guard let g = a[kSecAttrGeneric as String] as? Data, let m = (try? JSONSerialization.jsonObject(with: g)) as? [String: Any] else { return nil }
      let meta = Meta(name: handsCleanName(m["name"] as? String ?? ""), sites: (m["sites"] as? [String] ?? []).map(handsLoginOrigin).filter { !$0.isEmpty },
                      server: m["server"] as? String ?? "", created: m["created"] as? String ?? "", lastUsed: m["lastUsed"] as? String ?? "")
      return meta.name.isEmpty || meta.server.isEmpty ? nil : meta
    }.sorted { $0.name.lowercased() < $1.name.lowercased() }
  }
  static func list(server: String) -> [Meta] { all().filter { $0.server == server } }
  static func views(server: String) -> [[String: Any]] { list(server: server).map { $0.view } }
  static func find(server: String, name: String) -> Meta? {
    let want = handsCleanName(name).lowercased()
    return list(server: server).first { $0.name.lowercased() == want }
  }
  /// The secret of one login (read only to fill it into the page on this Mac).
  static func secret(server: String, name: String) -> (username: String, password: String)? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account(server, name), kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data, let m = (try? JSONSerialization.jsonObject(with: d)) as? [String: String] else { return nil }
    return (m["username"] ?? "", m["password"] ?? "")
  }
  @discardableResult static func save(_ meta: Meta, username: String, password: String) -> OSStatus {
    let acct = account(meta.server, meta.name)
    SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: acct] as CFDictionary)
    guard let secret = try? JSONSerialization.data(withJSONObject: ["username": username, "password": password]), let generic = try? JSONSerialization.data(withJSONObject: meta.json) else { return errSecParam }
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: acct,
                            kSecAttrLabel as String: "\(service): \(meta.name)", kSecAttrDescription as String: "Sara login (\(meta.sites.joined(separator: ", ")))",
                            kSecAttrGeneric as String: generic, kSecValueData as String: secret,
                            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly, kSecAttrSynchronizable as String: false]
    return SecItemAdd(q as CFDictionary, nil)
  }
  static func touch(server: String, name: String) {
    guard var m = find(server: server, name: name) else { return }
    m.lastUsed = ISO8601DateFormatter().string(from: Date())
    guard let generic = try? JSONSerialization.data(withJSONObject: m.json) else { return }
    SecItemUpdate([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account(server, name)] as CFDictionary,
                  [kSecAttrGeneric as String: generic] as CFDictionary)
  }
  /// Removes one login of this server (or all of them); how many went.
  static func remove(server: String, name: String?) -> Int {
    var n = 0
    for m in list(server: server) where name == nil || m.name.lowercased() == handsCleanName(name ?? "").lowercased() {
      if SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account(server, m.name)] as CFDictionary) == errSecSuccess { n += 1 }
    }
    return n
  }
}

/// The Mac's own windows: "Save a login for Sara?" and "Your turn" (AppKit controls, on the main thread).
final class HandsLoginPanel: NSObject, NSWindowDelegate {
  enum Kind { case consent, turn }
  let kind: Kind
  let site: String, name: String, warning: String, turnWhat: String
  let typed: (String, String)?
  let test: Bool
  private(set) var save = false, understood = false, continued = false
  private(set) var outName = "", outUser = "", outPass = ""
  private var window: NSPanel?
  private var nameField: NSTextField?, userField: NSTextField?, passField: NSSecureTextField?
  private var tick: NSButton?, saveButton: NSButton?, status: NSTextField?
  private let done = DispatchSemaphore(value: 0)
  static weak var current: HandsLoginPanel?

  init(kind: Kind, site: String = "", name: String = "", warning: String = "", turnWhat: String = "", typed: (String, String)? = nil, test: Bool) {
    self.kind = kind; self.site = site; self.name = name; self.warning = warning; self.turnWhat = turnWhat; self.typed = typed; self.test = test
  }
  /// Shows the panel and waits (off the main thread) until it closes, Stop is pressed or the deadline passes.
  func run(cancel: HandsCancel) {
    DispatchQueue.main.async { self.build() }
    while done.wait(timeout: .now() + 0.1) == .timedOut {
      if cancel.isSet { DispatchQueue.main.async { self.finish() }; _ = done.wait(timeout: .now() + 5); break }
    }
  }
  private func label(_ s: String, _ font: NSFont, _ y: inout CGFloat, in v: NSView, width: CGFloat) -> NSTextField {
    let l = NSTextField(wrappingLabelWithString: s)
    l.font = font
    l.isSelectable = false
    let h = ceil(l.sizeThatFits(NSSize(width: width, height: 1000)).height)
    y -= h
    l.frame = NSRect(x: 20, y: y, width: width, height: h)
    v.addSubview(l)
    y -= 10
    return l
  }
  private func build() {
    let W: CGFloat = 500, cw = W - 40
    let v = NSView(frame: NSRect(x: 0, y: 0, width: W, height: 1000))
    v.wantsLayer = true
    v.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    var y: CGFloat = 1000 - 20
    let body = NSFont.systemFont(ofSize: 13), bold = NSFont.systemFont(ofSize: 17, weight: .semibold)
    func field(_ title: String, _ f: NSTextField) {
      let l = NSTextField(labelWithString: title)
      l.font = body
      y -= 28
      l.frame = NSRect(x: 20, y: y + 4, width: 100, height: 18)
      f.frame = NSRect(x: 126, y: y, width: cw - 106, height: 28)
      f.font = body
      v.addSubview(l); v.addSubview(f)
      y -= 10
    }
    func button(_ title: String, _ action: Selector, x: CGFloat, w: CGFloat) -> NSButton {
      let b = NSButton(title: title, target: self, action: action)
      b.bezelStyle = .rounded
      b.controlSize = .large
      b.frame = NSRect(x: x, y: y - 44, width: w, height: 44)
      v.addSubview(b)
      return b
    }
    if kind == .consent {
      _ = label("Save a login for Sara?", bold, &y, in: v, width: cw)
      _ = label("Site: \(site)", body, &y, in: v, width: cw)
      _ = label(warning, body, &y, in: v, width: cw)
      let n = NSTextField(string: name); n.setAccessibilityLabel("Name"); field("Name", n); nameField = n
      let u = NSTextField(string: ""); u.setAccessibilityLabel("Username"); field("Username", u); userField = u
      let p = NSSecureTextField(string: ""); p.setAccessibilityLabel("Password"); field("Password", p); passField = p
      if typed != nil {
        _ = button("Use what I just typed", #selector(useTyped), x: 126, w: 220)
        y -= 54
      }
      let t = NSButton(checkboxWithTitle: "I understand", target: self, action: #selector(ticked))
      t.state = .off  // never ticked for them
      t.font = body
      y -= 28
      t.frame = NSRect(x: 20, y: y, width: cw, height: 24)
      v.addSubview(t)
      tick = t
      y -= 10
      status = label(" ", body, &y, in: v, width: cw)
      let s = button("Save", #selector(pressSave), x: W - 20 - 230, w: 110)
      s.isEnabled = false
      saveButton = s
      let c = button("Cancel", #selector(pressCancel), x: W - 20 - 110, w: 110)
      c.keyEquivalent = "\u{1b}"
    } else {
      _ = label("Your turn", bold, &y, in: v, width: cw)
      _ = label("\(turnWhat) in the Sara browser, then press Continue. Sara waits until you do; she can't see what you type into password fields.", body, &y, in: v, width: cw)
      let c = button("Continue", #selector(pressContinue), x: W - 20 - 130, w: 130)
      c.keyEquivalent = "\r"
    }
    y -= 44 + 20
    let h = 1000 - y
    for s in v.subviews { s.frame.origin.y -= y }
    v.frame = NSRect(x: 0, y: 0, width: W, height: h)
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: W, height: h), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    panel.title = (test ? "TEST · " : "") + (kind == .consent ? "Sara: save a login?" : "Sara: your turn")
    panel.contentView = v
    panel.level = .floating
    panel.isFloatingPanel = true
    panel.hidesOnDeactivate = false
    panel.delegate = self
    panel.center()
    window = panel
    HandsLoginPanel.current = self
    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
    panel.makeFirstResponder(kind == .consent ? userField : nil)
  }
  @objc func ticked() { saveButton?.isEnabled = tick?.state == .on }
  @objc func useTyped() {
    // What the person typed in the Sara browser a moment ago (it never left this Mac).
    guard let t = typed else { return }
    userField?.stringValue = t.0
    passField?.stringValue = t.1
    status?.stringValue = "Filled in with what you just typed in the Sara browser."
  }
  @objc func pressSave() {
    // The Mac's own rule: nothing is saved without the ticked box, whatever the server says.
    guard tick?.state == .on else { status?.stringValue = "Tick \"I understand\" first, or press Cancel."; return }
    let p = passField?.stringValue ?? ""
    guard !p.isEmpty else { status?.stringValue = "Type the password first (or press Use what I just typed)."; return }
    save = true; understood = true
    outName = nameField?.stringValue ?? ""; outUser = userField?.stringValue ?? ""; outPass = p
    finish()
  }
  @objc func pressCancel() { finish() }
  @objc func pressContinue() { continued = true; finish() }
  func windowWillClose(_ notification: Notification) {
    if kind == .turn { continued = true }
    closeDone()
  }
  private var closed = false
  func finish() {
    passField?.stringValue = ""
    if let w = window { window = nil; w.delegate = nil; w.orderOut(nil); w.close() }
    closeDone()
  }
  private func closeDone() {
    if closed { return }
    closed = true
    passField?.stringValue = ""
    if HandsLoginPanel.current === self { HandsLoginPanel.current = nil }
    done.signal()
  }
  #if DEBUG
  /// Test builds only: drives this panel like a person would (fill, tick, save, cancel, continue, a picture).
  func testDrive(_ cmd: String) {
    if cmd == "tick" { tick?.state = .on; ticked() }
    else if cmd == "typed" { useTyped() }
    else if cmd == "save" { pressSave() }
    else if cmd == "cancel" { pressCancel() }
    else if cmd == "continue" { pressContinue() }
    else if cmd.hasPrefix("fill:") {
      let parts = cmd.dropFirst(5).split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
      if parts.count == 2 { userField?.stringValue = parts[0]; passField?.stringValue = parts[1] }
    } else if cmd.hasPrefix("shot:"), let v = window?.contentView, let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
      v.cacheDisplay(in: v.bounds, to: rep)
      try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: String(cmd.dropFirst(5))))
    }
  }
  #endif
}

/// "Ask for Touch ID before Sara uses a saved login" (off by default): Touch ID or the Mac's password,
/// through the Mac's own window. True only when macOS says it was the owner.
func handsTouchID(_ reason: String, cancel: HandsCancel) -> (Bool, String) {
  let ctx = LAContext()
  var err: NSError?
  guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else { return (false, "Touch ID isn't set up on this Mac: switch off \"Ask for Touch ID\" in the Sara app.") }
  let sem = DispatchSemaphore(value: 0)
  var ok = false
  ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in ok = success; sem.signal() }
  while sem.wait(timeout: .now() + 0.1) == .timedOut { if cancel.isSet { ctx.invalidate(); return (false, "Stopped.") } }
  return (ok, ok ? "" : "Nothing was filled: the person at the Mac didn't confirm it was them (Touch ID).")
}

// MARK: the token in the Keychain (this app's own item: a test copy with another bundle id has its own)

enum HandsKeychain {
  static var service: String { (Bundle.main.bundleIdentifier ?? "com.backstagecoding.sara.desktop") + ".hands" }
  static func save(_ token: String, account: String) -> Bool {
    delete(account: account)
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
                            kSecValueData as String: Data(token.utf8), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
    return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
  }
  static func load(account: String) -> String? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
    return String(data: d, encoding: .utf8)
  }
  static func delete(account: String) {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    SecItemDelete(q as CFDictionary)
  }
}
