// N5 (Mac parity with 3.4.x / 3.5.x "your own browser"): d.tabs and d.tabswitch on a Mac. The person's own
// Safari and Chrome-family browsers (Chrome, Edge, Brave, Arc, Chromium, Vivaldi) are asked for their
// windows and tabs with AppleScript (only browsers that are already running: asking never opens one), behind
// "Let Sara see my tabs" in the app (off by default) and "The whole screen". macOS asks the person once per
// browser (Privacy & Security → Automation); without it the op says how to allow it. Read only: titles and
// addresses, never the pages. Banking and password-manager tabs show only as hidden (HandsScreen's list),
// key-shaped text is masked, Sara's own browser (her profile) is never listed. d.tabswitch brings one tab
// to the front after the person approves it here, like a desktop action.
import AppKit

enum HandsTabs {
  struct Browser { let code: String; let bundle: String; let name: String; let safari: Bool }
  static let browsers: [Browser] = [
    Browser(code: "s", bundle: "com.apple.Safari", name: "Safari", safari: true),
    Browser(code: "c", bundle: "com.google.Chrome", name: "Chrome", safari: false),
    Browser(code: "e", bundle: "com.microsoft.edgemac", name: "Edge", safari: false),
    Browser(code: "b", bundle: "com.brave.Browser", name: "Brave", safari: false),
    Browser(code: "a", bundle: "company.thebrowser.Browser", name: "Arc", safari: false),
    Browser(code: "m", bundle: "org.chromium.Chromium", name: "Chromium", safari: false),
    Browser(code: "v", bundle: "com.vivaldi.Vivaldi", name: "Vivaldi", safari: false),
  ]
  /// Separators that never occur in titles (unit and record separators).
  static let us = "\u{1f}", rs = "\u{1e}"

  static func listScript(_ b: Browser) -> String {
    let q = b.safari
      ? """
        set ct to 0
        try
          set ct to index of current tab of w
        end try
        set out to out & "W" & (id of w as text) & US & (ct as text) & RS
        repeat with t in tabs of w
          set nm to ""
          set u to ""
          try
            set nm to name of t
          end try
          try
            set u to URL of t
          end try
          if u is missing value then set u to ""
          set out to out & "T" & nm & US & u & RS
        end repeat
        """
      : """
        set ct to 0
        try
          set ct to active tab index of w
        end try
        set out to out & "W" & (id of w as text) & US & (ct as text) & RS
        repeat with t in tabs of w
          set nm to ""
          set u to ""
          try
            set nm to title of t
          end try
          try
            set u to URL of t
          end try
          if u is missing value then set u to ""
          set out to out & "T" & nm & US & u & RS
        end repeat
        """
    return """
    set US to (character id 31)
    set RS to (character id 30)
    set out to ""
    tell application id "\(b.bundle)"
      repeat with w in windows
        try
    \(q)
        end try
      end repeat
    end tell
    return out
    """
  }

  /// Runs one AppleScript on the main thread (NSAppleScript belongs there); the error number with it.
  static func runScript(_ source: String) -> (String?, Int) {
    var result: String?
    var code = 0
    let work = {
      var err: NSDictionary?
      let s = NSAppleScript(source: source)
      let r = s?.executeAndReturnError(&err)
      if let e = err { code = (e[NSAppleScript.errorNumber] as? Int) ?? -1 } else { result = r?.stringValue ?? "" }
    }
    if Thread.isMainThread { work() } else { DispatchQueue.main.sync(execute: work) }
    return (result, code)
  }

  /// The person's own copy of that browser, when AppleScript can only mean that one. Sara's own browser (her
  /// profile, started by this app) is never one of the person's windows: while both run, the browser's name
  /// would reach either, so that browser is left out and says why.
  static func running(_ b: Browser) -> (app: NSRunningApplication?, ambiguous: Bool) {
    let all = NSRunningApplication.runningApplications(withBundleIdentifier: b.bundle).filter { !$0.isTerminated }
    let own = Hands.shared?.browser.processId ?? 0
    let theirs = all.filter { own <= 0 || $0.processIdentifier != own }
    if theirs.isEmpty { return (nil, false) }
    return all.count > 1 ? (nil, true) : (theirs[0], false)
  }

  struct Win { let id: String; let browser: Browser; let windowId: String; var active: Int; var tabs: [(title: String, url: String)] }
  static func parse(_ text: String, _ b: Browser) -> [Win] {
    var out: [Win] = []
    for rec in text.components(separatedBy: rs) where !rec.isEmpty {
      let kind = rec.prefix(1), body = String(rec.dropFirst())
      let f = body.components(separatedBy: us)
      if kind == "W" {
        let wid = f[0].filter { $0.isNumber }
        out.append(Win(id: "w" + b.code + wid, browser: b, windowId: wid, active: Int(f.count > 1 ? f[1] : "0") ?? 0, tabs: []))
      } else if kind == "T", !out.isEmpty, out[out.count - 1].tabs.count < 100 {
        out[out.count - 1].tabs.append((title: f[0], url: f.count > 1 ? f[1] : ""))
      }
    }
    return out
  }

  /// Each running browser's windows. perm: a browser whose Automation permission is off.
  static func collect() -> (wins: [Win], refused: [String], busy: [String]) {
    var wins: [Win] = []
    var busy: [String] = []
    var refused: [String] = []
    for b in browsers {
      let r = running(b)
      if r.ambiguous { busy.append(b.name); continue }
      guard r.app != nil else { continue }
      let (text, code) = runScript(listScript(b))
      if code == -1743 || code == -1744 { refused.append(b.name); continue }
      guard let text else { continue }
      wins += parse(text, b)
    }
    return (wins, refused, busy)
  }
  static let permHelp = "Allow it once: System Settings → Privacy & Security → Automation → Sara → turn on the browser, then ask again."

  static func browserInternal(_ url: String) -> String {
    let u = url.lowercased()
    guard u.range(of: "^\\s*((edge|chrome|brave|opera|vivaldi|arc):\\/\\/|about:)", options: .regularExpression) != nil else { return "" }
    return u.range(of: "password|passkey|autofill|payment|wallet|sync|profile|people|sign-?in|account|security|credential|logins", options: .regularExpression) != nil ? "blocked" : "settings"
  }
  static let sensitive = "check-?out|payment|billing|\\bpay\\b|purchase|\\bcart\\b|\\border\\b|donat|wallet|account|security|privacy|password|passkey|sign[ -_]?in|sign[ -_]?up|log[ -_]?in|\\bauth|oauth|\\bsso\\b|2fa|mfa|two[- ]factor|verify|verification"
  /// src/computer-policy.ts ownBrowserPage: "block", "once" or "level".
  static func pageAct(_ title: String, _ url: String) -> (act: String, why: String) {
    if let k = HandsScreen.blockedKind("\(title) \(url)", "") { return ("block", "That tab is hidden from you on purpose (\(k)): never act there.") }
    let own = browserInternal(url)
    if own == "blocked" { return ("block", "That is the browser's own passwords, payment methods or account/sync page: never act there (the owner does that part).") }
    if own == "settings" { return ("once", "the browser's own settings page (asks every time)") }
    var path = url
    if let c = URLComponents(string: url.contains("://") ? url : "https://" + url) { path = "\(c.host ?? "") \(c.path) \(c.query ?? "")" }
    if "\(title) \(path)".range(of: sensitive, options: [.regularExpression, .caseInsensitive]) != nil { return ("once", "a payment, account, security or sign-in page (asks every time)") }
    return ("level", "")
  }

  /// d.tabs: { browsers: [{id, app, browser, title, tabs: [{title, url?, active?} | {hidden, active?}]}] }.
  static func tabs() throws -> [String: Any] {
    let (wins, refused, busy) = collect()
    if wins.isEmpty && !refused.isEmpty { throw HandsOpError(code: "perm_missing", message: "macOS doesn't let Sara read the tabs of \(refused.joined(separator: ", ")) yet. \(permHelp)") }
    var out: [[String: Any]] = []
    for w in wins.prefix(20) {
      let front = w.tabs.indices.contains(w.active - 1) ? w.tabs[w.active - 1].title : (w.tabs.first?.title ?? "")
      if let k = HandsScreen.blockedKind(front, w.browser.name) { out.append(["hidden": k]); continue }
      let tabs: [[String: Any]] = w.tabs.enumerated().map { i, t in
        var o: [String: Any] = [:]
        if let k = HandsScreen.blockedKind("\(t.title) \(t.url)", "") { o["hidden"] = k } else {
          o["title"] = handsMask(HandsScreen.clip(t.title, 160))
          if !t.url.isEmpty { o["url"] = handsMask(HandsScreen.clip(t.url, 300)) }
        }
        if i + 1 == w.active { o["active"] = true }
        return o
      }
      out.append(["id": w.id, "app": w.browser.name, "browser": w.browser.name, "title": handsMask(HandsScreen.clip(front, 160)), "tabs": tabs])
    }
    var r: [String: Any] = ["browsers": out]
    var notes: [String] = []
    if !refused.isEmpty { notes.append("Not allowed to read: \(refused.joined(separator: ", ")). \(permHelp)") }
    if !busy.isEmpty { notes.append("\(busy.joined(separator: ", ")) is also Sara's own browser right now, so its tabs aren't listed: close Sara's browser window (or ask her to) and list again.") }
    if !notes.isEmpty { r["note"] = notes.joined(separator: " ") }
    return r
  }

  /// The checks before the card: the window and tab are still there, the title the same (numbers may change), not blocked.
  static func inspectSwitch(_ a: [String: Any]) throws -> (win: Win, index: Int, title: String, url: String, once: Bool) {
    let wid = a["window"] as? String ?? ""
    guard let b = browsers.first(where: { wid.hasPrefix("w" + $0.code) }) else { throw HandsOpError(code: "not_found", message: "That is not one of your own browser windows (pc_my_tabs lists them).") }
    let r = running(b)
    if r.ambiguous { throw HandsOpError(code: "denied_local", message: "\(b.name) is also Sara's own browser right now, so the tab can't be told apart: close Sara's browser window first.") }
    guard r.app != nil else { throw HandsOpError(code: "stale_view", message: "That browser isn't open any more: list the tabs again (pc_my_tabs).") }
    let (text, code) = runScript(listScript(b))
    if code == -1743 || code == -1744 { throw HandsOpError(code: "perm_missing", message: "macOS doesn't let Sara reach \(b.name) yet. \(permHelp)") }
    guard let w = parse(text ?? "", b).first(where: { $0.id == wid }) else { throw HandsOpError(code: "stale_view", message: "That window is not there any more: list the tabs again (pc_my_tabs).") }
    let i = (a["tab"] as? NSNumber)?.intValue ?? 0
    guard i >= 1, i <= w.tabs.count else { throw HandsOpError(code: "stale_view", message: "That tab is not there any more: list the tabs again (pc_my_tabs).") }
    let t = w.tabs[i - 1]
    let shape = { (x: String) in x.replacingOccurrences(of: "\\d+", with: "#", options: .regularExpression) }
    if let want = a["title"] as? String, !want.isEmpty, shape(handsMask(HandsScreen.clip(t.title, 160))) != shape(want) { throw HandsOpError(code: "stale_view", message: "The tabs changed: list them again (pc_my_tabs).") }
    let page = pageAct(t.title, t.url)
    if page.act == "block" { throw HandsOpError(code: "denied_local", message: page.why) }
    return (w, i, t.title, t.url, page.act == "once")
  }

  /// After Allow: that tab to the front of its window, the window to the front, the browser in front.
  static func switchTo(_ w: Win, _ i: Int) throws {
    let b = w.browser
    let s = b.safari
      ? "tell application id \"\(b.bundle)\"\nset w to window id \(w.windowId)\nset current tab of w to tab \(i) of w\nset index of w to 1\nactivate\nend tell"
      : "tell application id \"\(b.bundle)\"\nset w to window id \(w.windowId)\nset active tab index of w to \(i)\nset index of w to 1\nactivate\nend tell"
    let (_, code) = runScript(s)
    if code == -1743 || code == -1744 { throw HandsOpError(code: "perm_missing", message: "macOS doesn't let Sara reach \(b.name) yet. \(permHelp)") }
    if code != 0 { throw HandsOpError(code: "error", message: "\(b.name) didn't switch the tab (AppleScript error \(code)).") }
  }
}
