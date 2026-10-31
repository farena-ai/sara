// Phase 92 (computer use CU5, docs/design/COMPUTER_USE.md §5.1–5.2, §6.2, §7.4, §7.6): desktop look on a Mac.
// OS APIs only: ScreenCaptureKit (SCScreenshotManager, macOS 14+; SCContentFilter leaves the Sara app out of
// the capture), CGWindowListCopyWindowInfo for the window list, Accessibility (AXUIElement) for element lists,
// ImageIO through NSBitmapImageRep for JPEG. The rules are src/hands-desktop.ts's, done here before anything is
// sent: blocked windows (password managers, banking, security, a Sara token in the title, the person's own list)
// are blacked out and left out of lists; Sara's own windows never appear; secure text fields (AXSecureTextField)
// are boxed out and never give a value; key-shaped text is masked; one picture per 500 ms, 1280 px, 300
// elements, depth 8; a picture's viewId lasts 20 s.
// Screen Recording and Accessibility are macOS (TCC) permissions only the person can grant in System
// Settings: without them d.shot / d.elements answer perm_missing with the exact steps (never a bypass).
import AppKit
import ApplicationServices
import ScreenCaptureKit

enum HandsScreen {
  static let maxEdge = 1280, maxElements = 300, maxDepth = 8, maxNodes = 2500
  static let viewTtl: TimeInterval = 20, shotEvery: TimeInterval = 0.5
  static let lock = NSLock()
  static var extra: [String] = []
  struct View { let at: Date; let ox: Double; let oy: Double; let scale: Double; var window: Win? = nil; var items: [Item] = []; var width = 0; var height = 0 }
  static var views: [String: View] = [:]
  static var viewN = 0
  static var lastShot = Date.distantPast

  // §7.4: the default sensitive-windows list (the same as src/hands-desktop.ts DESKTOP_BLOCKLIST).
  static let blocks: [(kind: String, titles: [String], apps: [String])] = [
    ("password manager", ["1password", "bitwarden", "keepass", "lastpass", "dashlane", "proton pass", "keychain access", "credential manager", "enpass", "nordpass", "roboform"],
     ["1password", "bitwarden", "keepass", "keepassxc", "lastpass", "dashlane", "proton pass", "keychain access", "enpass", "nordpass", "roboform"]),
    ("security settings", ["windows security", "privacy & security", "privacy and security", "credential manager", "manage passwords"], ["securityhealthhost", "securityhealthui"]),
    ("banking", ["online banking", "bank of america", "wells fargo", "chase bank", "chase.com", "citibank", "barclays", "hsbc", "santander", "capital one", "paypal", "revolut", "monzo", "n26", "sparkasse", "credit union", "ing banking", "bnp paribas"], []),
    ("sign-in token", ["sara_dev.", "sara_hands.", "sara_m."], []),
  ]
  static func setExtra(_ lines: String) {
    lock.lock()
    extra = lines.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { $0.count >= 3 }.prefix(40).map { String($0.prefix(80)) }
    lock.unlock()
  }
  static func blockedKind(_ title: String, _ app: String) -> String? {
    let t = title.lowercased(), a = app.lowercased()
    for b in blocks where b.titles.contains(where: { t.contains($0) }) || b.apps.contains(where: { a.contains($0) }) { return b.kind }
    lock.lock()
    defer { lock.unlock() }
    if extra.contains(where: { t.contains($0) || a.contains($0) }) { return "your list" }
    return nil
  }
  /// §7.6: the fixed key shapes.
  static func mask(_ s: String) -> String { handsMask(s) }
  static func clip(_ s: String, _ n: Int) -> String { String(s.map { $0.isNewline || $0 == "\t" ? " " : $0 }.prefix(n)) }

  static var perms: (capture: Bool, ax: Bool) { (CGPreflightScreenCaptureAccess(), AXIsProcessTrusted()) }

  struct Win {
    let id: CGWindowID
    let title: String
    let app: String
    let pid: pid_t
    let bounds: CGRect  // global points, top-left origin
    let layer: Int
    let sara: Bool
    let hidden: String?
  }
  static func isSara(_ pid: pid_t) -> Bool {
    if pid == getpid() { return true }
    return NSRunningApplication(processIdentifier: pid)?.bundleIdentifier?.hasPrefix("com.backstagecoding.sara") == true
  }
  /// Every on-screen window, front first.
  static func list() -> [Win] {
    guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    return info.compactMap { w in
      guard let id = w[kCGWindowNumber as String] as? CGWindowID, let pid = w[kCGWindowOwnerPID as String] as? pid_t else { return nil }
      let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
      let r = CGRect(x: b["X"] as? Double ?? 0, y: b["Y"] as? Double ?? 0, width: b["Width"] as? Double ?? 0, height: b["Height"] as? Double ?? 0)
      // Titles only come with the Screen Recording permission; app names always.
      let title = w[kCGWindowName as String] as? String ?? ""
      let app = w[kCGWindowOwnerName as String] as? String ?? ""
      let sara = isSara(pid)
      return Win(id: id, title: title, app: app, pid: pid, bounds: r, layer: w[kCGWindowLayer as String] as? Int ?? 0, sara: sara, hidden: sara ? nil : blockedKind(title, app))
    }
  }
  static func winView(_ w: Win) -> [String: Any] { ["id": "w\(w.id)", "title": mask(clip(w.title, 160)), "app": clip(w.app, 80)] }

  static func screensList() -> [[String: Any]] {
    NSScreen.screens.enumerated().map { i, s in
      let id = (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
      return ["id": "s\(i + 1)", "w": Int(s.frame.width * s.backingScaleFactor), "h": Int(s.frame.height * s.backingScaleFactor), "scale": s.backingScaleFactor, "primary": CGDisplayIsMain(id) != 0]
    }
  }

  static func windows() -> [String: Any] {
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    var out: [[String: Any]] = []
    var seenFront = false
    for w in list() where w.layer == 0 && !w.sara && w.bounds.width > 40 && w.bounds.height > 30 {
      if out.count >= 60 { break }
      if let k = w.hidden { out.append(["hidden": k]); continue }
      var v = winView(w)
      v["bounds"] = [Int(w.bounds.minX), Int(w.bounds.minY), Int(w.bounds.width), Int(w.bounds.height)]
      if !seenFront && w.pid == front { v["focused"] = true; seenFront = true }
      if w.title.isEmpty && !perms.capture { v["note"] = "title needs Screen Recording" }
      out.append(v)
    }
    return ["windows": out]
  }

  // MARK: Accessibility
  struct Item { var element: AXUIElement; var role: String; var name: String; var value: String?; var secret: Bool; var disabled: Bool; var focused: Bool; var frame: CGRect }
  static func attr(_ e: AXUIElement, _ a: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil
  }
  static func frameOf(_ e: AXUIElement) -> CGRect? {
    guard let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute) else { return nil }
    var pt = CGPoint.zero, sz = CGSize.zero
    guard CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    AXValueGetValue(p as! AXValue, .cgPoint, &pt)
    AXValueGetValue(s as! AXValue, .cgSize, &sz)
    return CGRect(origin: pt, size: sz)
  }
  /// The AX window that matches a CG window (same app, same frame; else its focused / first window).
  static func axWindow(_ w: Win) -> AXUIElement? {
    let app = AXUIElementCreateApplication(w.pid)
    AXUIElementSetMessagingTimeout(app, 2)
    let wins = attr(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
    if let hit = wins.first(where: { frameOf($0).map { abs($0.minX - w.bounds.minX) < 3 && abs($0.minY - w.bounds.minY) < 3 && abs($0.width - w.bounds.width) < 3 } ?? false }) { return hit }
    if let t = wins.first(where: { (attr($0, kAXTitleAttribute) as? String ?? "") == w.title && !w.title.isEmpty }) { return t }
    return nil
  }
  static let actionRoles: Set<String> = ["AXButton", "AXCheckBox", "AXComboBox", "AXTextField", "AXTextArea", "AXLink", "AXMenuItem", "AXRadioButton", "AXSlider", "AXPopUpButton", "AXTab", "AXCell", "AXRow", "AXSearchField", "AXSecureTextField"]
  static func collect(_ w: Win, limit: Int) -> (items: [Item], total: Int) {
    guard let root = axWindow(w) else { return ([], 0) }
    var items: [Item] = []
    var total = 0, nodes = 0
    func go(_ e: AXUIElement, _ depth: Int) {
      guard depth <= maxDepth, nodes <= maxNodes else { return }
      for c in attr(e, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
        nodes += 1
        if nodes > maxNodes { return }
        let role = attr(c, kAXRoleAttribute) as? String ?? ""
        let sub = attr(c, kAXSubroleAttribute) as? String ?? ""
        let secret = sub == "AXSecureTextField" || role == "AXSecureTextField"
        var name = (attr(c, kAXTitleAttribute) as? String) ?? ""
        if name.isEmpty { name = (attr(c, kAXDescriptionAttribute) as? String) ?? "" }
        // Static text keeps its words in its value (never for a secure field: not even read).
        if name.isEmpty, role == "AXStaticText", !secret { name = (attr(c, kAXValueAttribute) as? String) ?? "" }
        if let f = frameOf(c), f.width > 0, f.height > 0, !name.isEmpty || actionRoles.contains(role) || secret {
          total += 1
          if items.count < limit {
            var it = Item(element: c, role: shortRole(role, secret), name: mask(clip(name, 200)), value: nil, secret: secret, disabled: (attr(c, kAXEnabledAttribute) as? Bool) == false, focused: (attr(c, kAXFocusedAttribute) as? Bool) == true, frame: f)
            if !secret, ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSlider"].contains(role), let v = attr(c, kAXValueAttribute) { it.value = mask(clip("\(v)", 200)) }
            items.append(it)
          }
        }
        go(c, depth + 1)
      }
    }
    go(root, 1)
    return (items, total)
  }
  static func shortRole(_ r: String, _ secret: Bool) -> String {
    if secret { return "edit" }
    switch r {
    case "AXButton", "AXPopUpButton": return "button"
    case "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox": return "edit"
    case "AXStaticText": return "text"
    case "AXLink": return "link"
    case "AXCheckBox": return "checkbox"
    case "AXRadioButton": return "radio"
    case "AXMenuItem": return "menuitem"
    case "AXImage": return "image"
    case "AXTab": return "tab"
    default: return r.hasPrefix("AX") ? String(r.dropFirst(2)).lowercased() : (r.isEmpty ? "element" : r)
    }
  }
  static func itemsJson(_ items: [Item], _ v: View?) -> [[String: Any]] {
    items.enumerated().map { i, it in
      var f = it.frame
      if let v { f = CGRect(x: (f.minX - v.ox) * v.scale, y: (f.minY - v.oy) * v.scale, width: f.width * v.scale, height: f.height * v.scale) }
      var o: [String: Any] = ["ref": "e\(i + 1)", "role": it.role, "box": [Int(f.minX.rounded()), Int(f.minY.rounded()), max(1, Int(f.width.rounded())), max(1, Int(f.height.rounded()))]]
      if !it.name.isEmpty { o["name"] = it.name }
      if it.secret { o["secret"] = true } else if let val = it.value, !val.isEmpty { o["value"] = val }
      if it.disabled { o["disabled"] = true }
      if it.focused { o["focused"] = true }
      return o
    }
  }
  static func find(_ all: [Win], _ id: String) throws -> Win {
    guard let w = all.first(where: { "w\($0.id)" == id }) else { throw HandsOpError(code: "not_found", message: "No such window (pc_windows lists them).") }
    if w.sara { throw HandsOpError(code: "not_found", message: "That is one of Sara's own windows: she never looks at those.") }
    if let k = w.hidden { throw HandsOpError(code: "blocked_window", message: "That window is hidden from Sara on this Mac (\(k)).") }
    return w
  }
  static func front(_ all: [Win], in area: CGRect) -> Win? {
    all.first { $0.layer == 0 && !$0.sara && $0.hidden == nil && $0.bounds.width > 40 && $0.bounds.intersects(area) }
  }

  static func elements(_ a: [String: Any]) throws -> [String: Any] {
    guard AXIsProcessTrusted() else {
      throw HandsOpError(code: "perm_missing", message: "Sara can't read windows on this Mac yet: the owner allows it once in System Settings → Privacy & Security → Accessibility → turn on Sara (the Sara app's Computer use page has an Open System Settings button).")
    }
    let limit = min(maxElements, max(1, a["limit"] as? Int ?? maxElements))
    var v: View?
    if let vid = a["viewId"] as? String, !vid.isEmpty {
      lock.lock()
      v = views[vid]
      lock.unlock()
      guard let vv = v, Date().timeIntervalSince(vv.at) <= viewTtl else { throw HandsOpError(code: "stale_view", message: "That picture is older than 20 seconds (or unknown): look again.") }
    }
    let all = list()
    let w: Win
    if let id = a["window"] as? String, !id.isEmpty { w = try find(all, id) } else if let f = front(all, in: CGRect(x: -1e5, y: -1e5, width: 2e5, height: 2e5)) { w = f } else { return ["items": [], "total": 0] }
    let (items, total) = collect(w, limit: limit)
    let pictureCoordinates = v != nil
    var vid = a["viewId"] as? String ?? ""
    if v == nil {
      v = View(at: Date(), ox: 0, oy: 0, scale: 1, window: w, items: items)
      lock.lock(); viewN += 1; vid = "v\(viewN)"; views = views.filter { Date().timeIntervalSince($0.value.at) < viewTtl * 3 }; views[vid] = v; lock.unlock()
    } else if v?.window?.id != w.id { throw HandsOpError(code: "stale_view", message: "That window is not the window in this look.") }
    var out: [String: Any] = ["viewId": vid, "window": winView(w), "items": itemsJson(items, v), "total": total, "coords": pictureCoordinates ? "picture" : "screen"]
    if total > items.count { out["more"] = true }
    return out
  }

  // MARK: pictures
  /// d.shot: the picture (blocked windows black, secure fields boxed out, Sara left out) + its result.
  static func shot(_ a: [String: Any]) throws -> (jpeg: Data, w: Int, h: Int, viewId: String, thumb: (Data, Int, Int)?, result: [String: Any]) {
    guard CGPreflightScreenCaptureAccess() else {
      throw HandsOpError(code: "perm_missing", message: "Sara can't take pictures of this Mac's screen yet: the owner allows it once in System Settings → Privacy & Security → Screen Recording → turn on Sara, then quits and reopens Sara (the Sara app's Computer use page has an Open System Settings button).")
    }
    guard #available(macOS 14.0, *) else { throw HandsOpError(code: "unsupported", message: "Desktop pictures need macOS 14 or later on this Mac.") }
    lock.lock()
    if Date().timeIntervalSince(lastShot) < shotEvery { lock.unlock(); throw HandsOpError(code: "rate_limited", message: "At most one picture every 500 ms.") }
    lastShot = Date()
    lock.unlock()
    let edge = min(maxEdge, max(64, a["maxEdge"] as? Int ?? maxEdge))
    let all = list()
    var win: Win?
    if let id = a["window"] as? String, !id.isEmpty { win = try find(all, id) }
    // ScreenCaptureKit is async: wait for it on this (the ops) queue.
    let sem = DispatchSemaphore(value: 0)
    var got: Result<(CGImage, CGRect), Error> = .failure(HandsOpError(code: "error", message: "No picture."))
    let screenIdx = max(0, (Int(String((a["screen"] as? String ?? "s1").dropFirst())) ?? 1) - 1)
    let saraPid = getpid()
    Task.detached {
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let cfg = SCStreamConfiguration()
        cfg.showsCursor = false
        let filter: SCContentFilter
        let area: CGRect
        if let w = win {
          guard let scw = content.windows.first(where: { $0.windowID == w.id }) else { throw HandsOpError(code: "not_found", message: "That window is gone.") }
          filter = SCContentFilter(desktopIndependentWindow: scw)
          area = scw.frame
        } else {
          let ds = content.displays
          guard !ds.isEmpty else { throw HandsOpError(code: "unsupported", message: "No screen found.") }
          let d = ds[min(screenIdx, ds.count - 1)]
          // Sara's own windows are left out of the capture itself.
          let sara = content.applications.filter { $0.processID == saraPid || $0.bundleIdentifier.hasPrefix("com.backstagecoding.sara") }
          filter = SCContentFilter(display: d, excludingApplications: sara, exceptingWindows: [])
          area = d.frame
        }
        let scale = Double(NSScreen.main?.backingScaleFactor ?? 2)
        cfg.width = max(1, Int(area.width * scale))
        cfg.height = max(1, Int(area.height * scale))
        let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        got = .success((img, area))
      } catch { got = .failure(error) }
      sem.signal()
    }
    if sem.wait(timeout: .now() + 15) == .timedOut { throw HandsOpError(code: "timeout", message: "The screen picture took too long.") }
    let (img, area) = try got.get()
    let full = CGSize(width: img.width, height: img.height)
    let s = min(1, Double(edge) / Double(max(img.width, img.height)))
    let W = max(1, Int((full.width * s).rounded())), H = max(1, Int((full.height * s).rounded()))
    guard let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
      throw HandsOpError(code: "error", message: "Couldn't make the picture.")
    }
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
    // Points (global, top-left) → picture pixels (CGContext: bottom-left).
    let k = Double(W) / area.width
    let toPic = { (r: CGRect) -> CGRect in CGRect(x: (r.minX - area.minX) * k, y: Double(H) - (r.maxY - area.minY) * k, width: r.width * k, height: r.height * k) }
    var blacked = 0, masked = 0
    ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    if win == nil {
      for w in all where w.hidden != nil && w.bounds.intersects(area) {
        ctx.fill(toPic(w.bounds))
        blacked += 1
      }
    }
    // Secure text fields boxed out (Accessibility; without it macOS still draws them as dots).
    let ax = AXIsProcessTrusted()
    if ax {
      ctx.setFillColor(CGColor(red: 0.09, green: 0.09, blue: 0.09, alpha: 1))
      let targets = win.map { [$0] } ?? Array(all.filter { $0.layer == 0 && !$0.sara && $0.hidden == nil && $0.bounds.intersects(area) }.prefix(12))
      for w in targets {
        for it in collect(w, limit: maxElements).items where it.secret {
          ctx.fill(toPic(it.frame))
          masked += 1
        }
      }
    }
    let bound = win ?? front(all, in: area)
    let boundItems = bound.map { collect($0, limit: maxElements).items } ?? []
    let v = View(at: Date(), ox: area.minX, oy: area.minY, scale: k, window: bound, items: boundItems, width: W, height: H)
    var result: [String: Any] = ["w": W, "h": H, "scale": k, "blackedOut": blacked, "masked": masked]
    if !ax { result["axMissing"] = true }
    if let w = win { result["window"] = winView(w) } else { result["screen"] = "s\(screenIdx + 1)" }
    if a["marks"] as? Bool == true, ax, let target = win ?? front(all, in: area) {
      let (items, total) = collect(target, limit: maxElements)
      ctx.setStrokeColor(CGColor(red: 0.9, green: 0.12, blue: 0.12, alpha: 1))
      ctx.setLineWidth(2)
      for it in items { ctx.stroke(toPic(it.frame)) }
      result["items"] = itemsJson(items, v)
      result["total"] = total
      result["marksOf"] = winView(target)
    }
    guard let out = ctx.makeImage(), let jpeg = NSBitmapImageRep(cgImage: out).representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else {
      throw HandsOpError(code: "error", message: "Couldn't encode the picture.")
    }
    var thumb: (Data, Int, Int)?
    if let tw = a["thumb"] as? Int, tw >= 64, tw <= 640 {
      let ts = Double(tw) / Double(max(W, H))
      let TW = max(1, Int(Double(W) * ts)), TH = max(1, Int(Double(H) * ts))
      if let tc = CGContext(data: nil, width: TW, height: TH, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) {
        tc.draw(out, in: CGRect(x: 0, y: 0, width: TW, height: TH))
        if let ti = tc.makeImage(), let td = NSBitmapImageRep(cgImage: ti).representation(using: .jpeg, properties: [.compressionFactor: 0.55]) { thumb = (td, TW, TH) }
      }
    }
    lock.lock()
    viewN += 1
    let vid = "v\(viewN)"
    views = views.filter { Date().timeIntervalSince($0.value.at) < viewTtl * 3 }
    views[vid] = v
    lock.unlock()
    result["viewId"] = vid
    return (jpeg, W, H, vid, thumb, result)
  }

  /// The guided step's button: the exact System Settings pane (and macOS's own prompt for Screen Recording).
  static func openSettings(_ which: String) {
    if which == "capture" { _ = CGRequestScreenCaptureAccess() }
    let pane = which == "capture" ? "Privacy_ScreenCapture" : "Privacy_Accessibility"
    if let u = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(u) }
  }
}
