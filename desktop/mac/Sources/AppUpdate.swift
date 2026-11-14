// N5 (Mac parity with the Windows app's own updates, docs/desktop.md → How the app updates): the Mac app
// reads the same signed update notice (update-notice.json on each release, src/update-notice.ts), checks its
// Ed25519 signature itself (CryptoKit, the release-notice key 0bfd41a73239cf88), so it never depends on the
// server it is connected to; refuses a notice that isn't signed by the release key, one older than a notice
// it already saw, a file that isn't on the release page; never installs a version older than its own.
// The DMG is downloaded to Application Support/<bundle id>/updates, checked against the notice's SHA-256,
// and installed by a small helper after the app quits: SHA-256 again, mount read-only, the new Sara.app's
// signature checked (and its Team ID the same as this app's when this one has one), copied next to the old
// one, swapped in, its version checked, the app started again. A failure keeps the old app and says so.
// Checks: at start (unless one ran in the last 15 minutes), every 6 hours, and soon after the server says it
// is newer (at most once an hour); when the server is newer than the notice (published a little later): 15
// min, 30, 1 h, 2 h, 4 h, 4 h (6 looks), then every 6 hours again. Offline: an hour later, quietly.
import AppKit
import CryptoKit

enum AppUpdateRules {
  static let noticeUrl = "https://github.com/farena-ai/sara/releases/latest/download/update-notice.json"
  static let assetBase = "https://github.com/farena-ai/sara/releases/download/"
  static let downloadPage = "https://github.com/farena-ai/sara/releases/latest"
  /// src/update-notice.ts NOTICE_KEYS (the release-notice key; its private half never leaves .secrets/).
  static let releaseKeys: [(id: String, key: String)] = [("0bfd41a73239cf88", "nbiVWlh8nPGrGcj1vzjzQD9AAMBCWKtoU6lkiWR3UMY=")]
  static let raceTries = 6

  static func versionParts(_ v: String) -> [Int] {
    var s = Substring(v.trimmingCharacters(in: .whitespaces))
    if s.first == "v" || s.first == "V" { s = s.dropFirst() }
    var out: [Int] = []
    var cur = ""
    for c in s + "." {
      if c == "." || c == "+" || c == "-" {
        out.append(Int(cur) ?? 0)
        cur = ""
        if out.count == 3 || c != "." { break }
      } else { cur.append(c) }
    }
    while out.count < 3 { out.append(0) }
    return Array(out.prefix(3))
  }
  /// -1, 0 or 1 (the first three numbers; "v" and a "-pre"/"+build" tail ignored).
  static func compare(_ a: String, _ b: String) -> Int {
    let x = versionParts(a), y = versionParts(b)
    for i in 0..<3 where x[i] != y[i] { return x[i] < y[i] ? -1 : 1 }
    return 0
  }
  static func isVersion(_ v: String) -> Bool { v.range(of: "^[0-9]{1,9}\\.[0-9]{1,9}\\.[0-9]{1,9}$", options: .regularExpression) != nil }
  static func isName(_ n: String) -> Bool { !n.isEmpty && n.count <= 200 && n.range(of: "^[A-Za-z0-9_.-]+$", options: .regularExpression) != nil }
  static func isSha(_ h: String) -> Bool { h.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }
  static func isDate(_ d: String) -> Bool { d.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}", options: .regularExpression) != nil }

  /// The publish race (leftover #1): the server is newer than the notice. 15 min doubling to 4 h, 6 looks; 0: no race.
  static func raceRetrySeconds(notice: String, server: String, tries: Int) -> Int {
    if server.isEmpty || tries < 0 || tries >= raceTries || compare(server, notice) <= 0 { return 0 }
    return min(15 * 60 << tries, 4 * 3600)
  }

  struct Asset { var name = ""; var url = ""; var sha256 = ""; var size: Int64 = 0 }
  enum Checked { case success(Notice), failure(String) }
  struct Notice { var keyId = ""; var version = ""; var minSupported = ""; var date = ""; var security = false; var mac: Asset?; }

  /// The notice, checked: signature by one of `keys`, every file on the release page with a SHA-256, not older than `seen`.
  static func verify(_ raw: Data, keys: [(id: String, key: String)], assetBase: String, seen: String) -> Checked {
    guard raw.count <= 256 * 1024, let n = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] else { return .failure("the notice is not readable") }
    guard let payload = n["payload"] as? String, let sigB64 = n["signature"] as? String, !sigB64.isEmpty else { return .failure("the notice is not signed") }
    let sig = Data(base64Encoded: sigB64) ?? Data()
    let kid = n["keyId"] as? String
    var tryKeys = keys.filter { $0.id == kid }
    if tryKeys.isEmpty { tryKeys = keys }
    var keyId = ""
    for k in tryKeys {
      guard sig.count == 64, let pk = Data(base64Encoded: k.key), pk.count == 32, let key = try? Curve25519.Signing.PublicKey(rawRepresentation: pk) else { continue }
      if key.isValidSignature(sig, for: Data(payload.utf8)) { keyId = k.id; break }
    }
    if keyId.isEmpty { return .failure("the signature does not match the release key") }
    guard let p = (try? JSONSerialization.jsonObject(with: Data(payload.utf8))) as? [String: Any] else { return .failure("the notice is not readable") }
    var r = Notice()
    r.keyId = keyId
    r.version = p["version"] as? String ?? ""
    r.minSupported = p["minSupported"] as? String ?? ""
    r.date = p["date"] as? String ?? ""
    if !isVersion(r.version) { return .failure("the notice has no version") }
    if !isVersion(r.minSupported) { return .failure("the notice has no minimum version") }
    if !isDate(r.date) { return .failure("the notice has no date") }
    guard let sec = p["security"] as? Bool, CFGetTypeID(p["security"] as CFTypeRef) == CFBooleanGetTypeID() else { return .failure("the notice has no security flag") }
    r.security = sec
    guard let assets = p["assets"] as? [String: Any] else { return .failure("the notice lists no files") }
    let prefix = assetBase + "v" + r.version + "/"
    for (platform, v) in assets {
      guard let a = v as? [String: Any], let name = a["name"] as? String, isName(name), let url = a["url"] as? String, url == prefix + name else { return .failure("a file in the notice is not on the release page") }
      guard let sha = a["sha256"] as? String, isSha(sha) else { return .failure("a file in the notice has no SHA-256") }
      if platform == "darwin" {
        var m = Asset(name: name, url: url, sha256: sha)
        if let size = a["size"] as? NSNumber, size.int64Value > 0 { m.size = size.int64Value }
        r.mac = m
      }
    }
    if let m = r.mac, !m.name.lowercased().hasSuffix(".dmg") { return .failure("the Mac file in the notice is not a disk image") }
    if !seen.isEmpty && compare(r.version, seen) < 0 { return .failure("the notice (\(r.version)) is older than one already seen (\(seen))") }
    return .success(r)
  }

  static func sha256(file: String) -> String? {
    guard let h = FileHandle(forReadingAtPath: file) else { return nil }
    defer { try? h.close() }
    var hasher = SHA256()
    while true {
      let d = h.readData(ofLength: 1 << 20)
      if d.isEmpty { break }
      hasher.update(data: d)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }
}

/// The app's updater (one per app; the page and the menus ask it).
final class AppUpdater: NSObject {
  enum State: String { case idle, checking, current, available, downloading, ready, installing, failed }
  static let shared = AppUpdater()
  private let lock = NSLock()
  private(set) var state = State.idle
  private(set) var message = ""
  private(set) var latest = ""
  private(set) var security = false
  private(set) var required = false
  private var notice: AppUpdateRules.Notice?
  private var working = false
  private(set) var want = false
  private var serverAhead = ""
  private var raceTries = 0
  private var lastServerCheck = 0.0
  var version = appVersion
  /// remote: this app replaces itself; server: Sara's server on this Mac brings the new app; manual: it can't (read-only place).
  var how = "remote"
  var onChange: (() -> Void)?
  var log: (String) -> Void = { NSLog("Sara app update: %@", $0) }
  private var timer: Timer?
  let d = UserDefaults.standard

  // Where it reads from (test copies only: a local test server and a test key).
  var noticeUrl = AppUpdateRules.noticeUrl
  var assetBase = AppUpdateRules.assetBase
  var keys = AppUpdateRules.releaseKeys
  var testHooks = false

  var dataDir: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(Bundle.main.bundleIdentifier ?? "Sara")
  }
  var updatesDir: URL { dataDir.appendingPathComponent("updates") }
  private func val(_ k: String) -> String { d.string(forKey: "update." + k) ?? "" }
  private func put(_ k: String, _ v: String) { if v.isEmpty { d.removeObject(forKey: "update." + k) } else { d.set(v, forKey: "update." + k) } }
  private func num(_ k: String) -> Double { Double(val(k)) ?? 0 }
  private var now: Double { Date().timeIntervalSince1970 }
  var autoOn: Bool { val("auto") != "0" }

  func configure(how: String) {
    #if DEBUG
    // Test copies (another bundle id) only: a notice and DMG from a local test server, a test key.
    let env = ProcessInfo.processInfo.environment
    if Bundle.main.bundleIdentifier != "com.backstagecoding.sara.desktop" {
      if let u = env["SARA_UPDATE_NOTICE_URL"] { noticeUrl = u; testHooks = true }
      if let b = env["SARA_UPDATE_ASSET_BASE"] { assetBase = b }
      if let k = env["SARA_UPDATE_KEY"] { keys = [("test", k)] }
      if let v = env["SARA_APP_VERSION"] { version = v }
    }
    #endif
    self.how = how
    let rv = val("readyVersion")
    if !rv.isEmpty {
      if AppUpdateRules.compare(rv, version) > 0 && FileManager.default.fileExists(atPath: val("readyPath")) {
        latest = rv
        setState(.ready, "Sara app \(rv) is ready.")
      } else {
        try? FileManager.default.removeItem(atPath: val("readyPath"))
        for k in ["readyVersion", "readySha", "readyPath"] { put(k, "") }
      }
    }
    try? FileManager.default.removeItem(at: updatesDir.appendingPathComponent("apply-update.sh"))
    if now - num("lastCheck") > 15 * 60 { put("nextCheck", "") }
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.check(force: false) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.check(force: false) }
  }

  private func setState(_ s: State, _ m: String) { state = s; message = m }
  private func changed() { DispatchQueue.main.async { [weak self] in self?.onChange?() } }

  private func allowed(_ url: String) -> Bool { url.hasPrefix("https://") || (testHooks && url.hasPrefix("http://127.0.0.1:")) }

  /// GET with the system's proxy settings; the body or why not.
  private func fetch(_ url: String, max: Int64, to file: URL? = nil, timeout: Double) -> (Data?, String) {
    guard allowed(url), let u = URL(string: url) else { return (nil, "not an https address") }
    var req = URLRequest(url: u, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
    req.setValue("SaraApp/\(version) (Mac)", forHTTPHeaderField: "User-Agent")
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForResource = file == nil ? 60 : 3600
    let s = URLSession(configuration: cfg)
    defer { s.finishTasksAndInvalidate() }
    let sem = DispatchSemaphore(value: 0)
    var body: Data?, err = ""
    if let file {
      s.downloadTask(with: req) { loc, resp, e in
        defer { sem.signal() }
        if let e { err = "offline or blocked (\(e.localizedDescription))"; return }
        guard let r = resp as? HTTPURLResponse, r.statusCode == 200, let loc else { err = "HTTP \((resp as? HTTPURLResponse)?.statusCode ?? 0)"; return }
        let size = (try? FileManager.default.attributesOfItem(atPath: loc.path)[.size] as? NSNumber)?.int64Value ?? 0
        if size > max { err = "the file is larger than expected"; return }
        try? FileManager.default.removeItem(at: file)
        do { try FileManager.default.moveItem(at: loc, to: file); body = Data() } catch { err = "couldn't save it" }
      }.resume()
    } else {
      s.dataTask(with: req) { data, resp, e in
        defer { sem.signal() }
        if let e { err = "offline or blocked (\(e.localizedDescription))"; return }
        guard let r = resp as? HTTPURLResponse, r.statusCode == 200 else { err = "HTTP \((resp as? HTTPURLResponse)?.statusCode ?? 0)"; return }
        if Int64(data?.count ?? 0) > max { err = "the file is larger than expected"; return }
        body = data
      }.resume()
    }
    sem.wait()
    return (body, err)
  }

  private func recordFail(_ v: String) {
    let n = val("failVersion") == v ? Int(num("failCount")) + 1 : 1
    put("failVersion", v)
    put("failCount", String(n))
    put("failUntil", String(Int(now) + min(3600 << min(n - 1, 10), 48 * 3600)))
  }
  private func backingOff(_ v: String) -> Bool { val("failVersion") == v && now < num("failUntil") }
  private func readyFor(_ n: AppUpdateRules.Notice) -> Bool {
    guard let m = n.mac else { return false }
    let p = val("readyPath")
    return val("readyVersion") == n.version && val("readySha") == m.sha256 && !p.isEmpty && FileManager.default.fileExists(atPath: p) && AppUpdateRules.sha256(file: p) == m.sha256
  }

  func check(force: Bool) {
    lock.lock()
    if working || state == .installing || (!force && now < num("nextCheck")) { lock.unlock(); return }
    working = true
    if state != .ready { state = .checking }
    lock.unlock()
    changed()
    DispatchQueue.global().async { [weak self] in self?.runCheck() }
  }

  private func runCheck() {
    let (body, err) = fetch(noticeUrl, max: 256 * 1024, timeout: 30)
    var doDownload: AppUpdateRules.Notice?
    lock.lock()
    let t = now
    put("lastCheck", String(Int(t)))
    if body == nil {
      put("nextCheck", String(Int(t) + 3600))
      log("couldn't read the update notice: \(err)")
      if state == .checking { setState(notice != nil ? .available : .idle, "Couldn't check for a new app (\(err)). Sara tries again later.") }
      if state == .available, let n = notice, readyFor(n) { setState(.ready, "Sara app \(n.version) is ready.") }
    } else {
      switch AppUpdateRules.verify(body!, keys: keys, assetBase: assetBase, seen: val("seen")) {
      case .failure(let why):
        put("nextCheck", String(Int(t) + 6 * 3600))
        log("the update notice wasn't trusted: \(why)")
        setState(.failed, "The update notice wasn't trusted (\(why)), so nothing was downloaded.")
      case .success(let n):
        let race = AppUpdateRules.raceRetrySeconds(notice: n.version, server: serverAhead, tries: raceTries)
        if race > 0 {
          // The server is newer than the notice: it is probably not published yet. Look again soon.
          raceTries += 1
          put("nextCheck", String(Int(t) + race))
          log("the server is on \(serverAhead) but the notice still says \(n.version): looking again in \(race / 60) min")
        } else {
          put("nextCheck", String(Int(t) + 6 * 3600))
          if AppUpdateRules.compare(n.version, serverAhead) >= 0 { raceTries = 0 }
        }
        if val("seen").isEmpty || AppUpdateRules.compare(n.version, val("seen")) > 0 { put("seen", n.version) }
        notice = n
        latest = n.version
        security = n.security
        required = AppUpdateRules.compare(version, n.minSupported) < 0
        if AppUpdateRules.compare(n.version, version) <= 0 {
          setState(.current, "The Sara app is up to date (\(version)).")
          want = false
        } else if n.mac == nil {
          setState(.failed, "Sara \(n.version) has no disk image for Mac yet.")
        } else if how == "server" {
          setState(.available, "Sara \(n.version) is out. Sara's server on this Mac updates this app with her: Settings → Updates.")
        } else if how == "manual" {
          setState(.available, "Sara app \(n.version) is out. This copy can't replace itself (it isn't in Applications or that folder is read-only): download it from \(AppUpdateRules.downloadPage).")
        } else if readyFor(n) {
          setState(.ready, "Sara app \(n.version) is ready.")
        } else {
          setState(.available, "Sara app \(n.version) is out.")
          if want || (autoOn && !backingOff(n.version)) { doDownload = n }
        }
      }
    }
    if doDownload == nil { working = false }
    lock.unlock()
    if let n = doDownload {
      download(n)
      lock.lock(); working = false; lock.unlock()
    }
    changed()
  }

  private func download(_ n: AppUpdateRules.Notice) {
    guard let m = n.mac else { return }
    lock.lock(); setState(.downloading, "Downloading Sara app \(n.version)…"); lock.unlock()
    changed()
    try? FileManager.default.createDirectory(at: updatesDir, withIntermediateDirectories: true)
    let dest = updatesDir.appendingPathComponent(m.name), part = updatesDir.appendingPathComponent(m.name + ".part")
    let (ok, err) = fetch(m.url, max: m.size > 0 ? m.size : 1 << 30, to: part, timeout: 120)
    let got = ok != nil ? AppUpdateRules.sha256(file: part.path) ?? "" : ""
    lock.lock()
    defer { lock.unlock() }
    if ok == nil {
      try? FileManager.default.removeItem(at: part)
      recordFail(n.version)
      log("downloading \(n.version) failed: \(err)")
      setState(.available, "Sara app \(n.version) is out, but it couldn't be downloaded (\(err)). Sara tries again later.")
    } else if got != m.sha256 {
      try? FileManager.default.removeItem(at: part)
      recordFail(n.version)
      log("the download of \(n.version) didn't match the signed notice (\(got)): deleted")
      setState(.failed, "The download of Sara app \(n.version) didn't match the signed update notice, so it was deleted and nothing was installed. Sara tries again later.")
    } else {
      try? FileManager.default.removeItem(at: dest)
      guard (try? FileManager.default.moveItem(at: part, to: dest)) != nil else {
        setState(.available, "Sara app \(n.version) is out, but it couldn't be saved. Sara tries again later.")
        return
      }
      put("readyVersion", n.version)
      put("readySha", m.sha256)
      put("readyPath", dest.path)
      log("Sara app \(n.version) downloaded and checked (SHA-256 \(m.sha256.prefix(12))…)")
      setState(.ready, "Sara app \(n.version) is ready.")
    }
  }

  /// The server said its version (the page's check-in): a newer one starts a check (and fresh race retries).
  func serverVersion(_ v: String) {
    guard AppUpdateRules.isVersion(v), AppUpdateRules.compare(v, version) > 0 else { return }
    lock.lock()
    let fresh = serverAhead.isEmpty || AppUpdateRules.compare(v, serverAhead) > 0
    if fresh { serverAhead = v; raceTries = 0 }
    if !fresh && now - lastServerCheck < 3600 { lock.unlock(); return }
    lastServerCheck = now
    lock.unlock()
    log("the server is on \(v): checking for a newer app")
    check(force: true)
  }
  func wantInstall() {
    lock.lock(); want = true; let ready = state == .ready; lock.unlock()
    if !ready { check(force: true) }
    changed()
  }
  func later() {
    lock.lock(); want = false; if let n = notice { put("laterVersion", n.version) }; lock.unlock()
    changed()
  }
  func setAuto(_ on: Bool) {
    put("auto", on ? "1" : "0")
    if on { check(force: true) }
    changed()
  }
  var isReady: Bool { lock.lock(); defer { lock.unlock() }; return state == .ready && how == "remote" }
  /// Installs by itself only with the switch on and not after a failed install of that version.
  var mayInstallByItself: Bool { isReady && autoOn && !backingOff(val("readyVersion")) }

  func status() -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    return ["state": state.rawValue, "version": version, "latest": latest, "message": message, "security": security, "required": required, "auto": autoOn, "want": want, "how": how,
            "page": AppUpdateRules.downloadPage, "later": val("laterVersion"), "checkedAt": num("lastCheck") * 1000]
  }

  /// Hands the verified DMG to the helper, which waits for this app to quit. "" when it started; else why not.
  func install(relaunch: Bool, background: Bool) -> String {
    lock.lock()
    if how == "server" { lock.unlock(); return "Sara's server on this Mac updates this app with her: Settings → Updates." }
    if how != "remote" { lock.unlock(); return "This copy of the app can't replace itself: download it from \(AppUpdateRules.downloadPage)." }
    if state != .ready { lock.unlock(); return "The new app isn't downloaded yet." }
    let path = val("readyPath"), sha = val("readySha"), to = val("readyVersion")
    lock.unlock()
    if path.isEmpty || AppUpdateRules.sha256(file: path) != sha {
      lock.lock()
      try? FileManager.default.removeItem(atPath: path)
      put("readyVersion", "")
      setState(.failed, "The downloaded app didn't match the signed update notice any more, so it was deleted and nothing was installed.")
      lock.unlock()
      changed()
      return message
    }
    let script = updatesDir.appendingPathComponent("apply-update.sh")
    do { try AppUpdater.helperScript.write(to: script, atomically: true, encoding: .utf8) } catch { return "Couldn't prepare the update. Nothing was changed." }
    let logFile = dataDir.appendingPathComponent("desktop.log").path
    let args = ["/bin/sh", script.path, path, sha, to, version, Bundle.main.bundlePath, updatesDir.appendingPathComponent("result.json").path, String(getpid()), relaunch ? "1" : "0", background ? "1" : "0", logFile]
    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    // Its own session: it outlives this app (it waits for it to quit).
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT))
    var fa: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&fa)
    posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_addopen(&fa, 1, "/dev/null", O_WRONLY, 0)
    posix_spawn_file_actions_addopen(&fa, 2, "/dev/null", O_WRONLY, 0)
    var cargs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) } + [nil]
    defer { for p in cargs { free(p) } }
    var pid: pid_t = 0
    let rc = posix_spawn(&pid, "/bin/sh", &fa, &attr, &cargs, environ)
    posix_spawn_file_actions_destroy(&fa)
    posix_spawnattr_destroy(&attr)
    guard rc == 0 else { return "Couldn't start the update (\(rc)). Nothing was changed." }
    lock.lock(); setState(.installing, "Installing Sara app \(to)…"); lock.unlock()
    log("installing \(to)" + (relaunch ? " (the app closes and comes back)" : " (as the app closes)"))
    changed()
    return ""
  }

  /// The helper's result from the last update (once): ok and the words for the person.
  func takeResult() -> (ok: Bool, text: String)? {
    let f = updatesDir.appendingPathComponent("result.json")
    guard let data = try? Data(contentsOf: f), let r = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
    try? FileManager.default.removeItem(at: f)
    let to = r["to"] as? String ?? "", from = r["from"] as? String ?? "", why = r["why"] as? String ?? ""
    if r["result"] as? String == "ok" {
      for k in ["readyVersion", "readySha", "readyPath", "failVersion", "failCount", "failUntil"] { put(k, "") }
      return (true, "The Sara app is updated to \(to).")
    }
    recordFail(to)
    let text = "Sara app \(to) didn't install (\(why.isEmpty ? "unknown reason" : why)), so this app stays at \(from). You can download it from \(AppUpdateRules.downloadPage) and drag Sara into Applications."
    lock.lock(); latest = to; setState(.failed, text); lock.unlock()
    return (false, text)
  }

  /// The helper: after the app quits, SHA-256 again, mount read-only, check the new app, swap it in, start it.
  static let helperScript = """
  #!/bin/sh
  # Sara app update helper (written by the app; AppUpdate.swift). Arguments: dmg sha to from app result parent relaunch background log
  DMG="$1"; SHA="$2"; TO="$3"; FROM="$4"; APP="$5"; RES="$6"; PARENT="$7"; RELAUNCH="$8"; BG="$9"; LOG="${10}"
  PB=/usr/libexec/PlistBuddy
  log() { echo "$(date '+%Y-%m-%d %H:%M:%S') app update: $*" >> "$LOG"; }
  MNT=""
  finish() {
    [ -n "$MNT" ] && { hdiutil detach -quiet "$MNT" 2>/dev/null || hdiutil detach -force -quiet "$MNT" 2>/dev/null; rmdir "$MNT" 2>/dev/null; }
    printf '{"result":"%s","to":"%s","from":"%s","why":"%s","at":%s}\\n' "$1" "$TO" "$FROM" "$2" "$(date +%s)" > "$RES.part" && mv -f "$RES.part" "$RES"
    if [ "$1" = ok ]; then log "Sara app $TO installed"; rm -f "$DMG"; else log "Sara app $TO didn't install: $2; the app stays at $FROM"; fi
    if [ "$RELAUNCH" = 1 ] && [ -d "$APP" ]; then
      if [ "$BG" = 1 ]; then open -g "$APP" --args --after-update --background; else open "$APP" --args --after-update; fi
    fi
    [ "$1" = ok ] && exit 0 || exit 1
  }
  i=0
  while kill -0 "$PARENT" 2>/dev/null; do
    i=$((i+1)); [ $i -gt 600 ] && finish failed "the app didn't close within a minute"
    sleep 0.1
  done
  sleep 1
  got=$(shasum -a 256 "$DMG" 2>/dev/null | awk '{print $1}')
  if [ "$got" != "$SHA" ]; then rm -f "$DMG"; finish failed "the downloaded disk image didn't match the signed update notice, so it was deleted"; fi
  MNT=$(mktemp -d "${TMPDIR:-/tmp}/sara-update.XXXXXX") || finish failed "no folder to open the disk image in"
  hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$DMG" || { rmdir "$MNT"; MNT=""; finish failed "the disk image didn't open"; }
  NEW="$MNT/Sara.app"
  [ -d "$NEW" ] || finish failed "the disk image has no Sara.app"
  codesign --verify --deep --strict "$NEW" 2>/dev/null || finish failed "the new Sara.app's signature isn't valid"
  mine=$(codesign -dv "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')
  theirs=$(codesign -dv "$NEW" 2>&1 | sed -n 's/^TeamIdentifier=//p')
  if [ -n "$mine" ] && [ "$mine" != "not set" ] && [ "$mine" != "$theirs" ]; then finish failed "the new Sara.app is signed by someone else"; fi
  newv=$($PB -c 'Print :CFBundleShortVersionString' "$NEW/Contents/Info.plist" 2>/dev/null)
  [ "$newv" = "$TO" ] || finish failed "the disk image holds Sara $newv, not $TO"
  log "installing Sara app $TO over $FROM"
  rm -rf "$APP.new"
  ditto "$NEW" "$APP.new" || { rm -rf "$APP.new"; finish failed "the new app couldn't be copied next to the old one"; }
  hdiutil detach -quiet "$MNT" 2>/dev/null; rmdir "$MNT" 2>/dev/null; MNT=""
  rm -rf "$APP.old"
  mv "$APP" "$APP.old" || { rm -rf "$APP.new"; finish failed "the old app couldn't be moved aside"; }
  if ! mv "$APP.new" "$APP"; then mv "$APP.old" "$APP"; finish failed "the new app couldn't be put in place"; fi
  got=$($PB -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null)
  if [ "$got" != "$TO" ]; then rm -rf "$APP"; mv "$APP.old" "$APP"; finish failed "the app is still $got after the update"; fi
  rm -rf "$APP.old"
  finish ok ""
  """
}
