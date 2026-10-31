// Desktop input is local, typed and opt-in. No arbitrary script or command is accepted.
import AppKit
import ApplicationServices
import IOKit.pwr_mgt

extension HandsScreen {
  static let inputTag: Int64 = 0x53415241
  static var ownServer = ""
  static func setServerOrigin(_ origin: String) { lock.lock(); ownServer = origin; lock.unlock() }
  static func authority(_ raw: String) -> String? {
    let value = raw.contains("://") ? raw : "https://" + raw
    guard let c = URLComponents(string: value), let host = c.host, !host.isEmpty else { return nil }
    let port = c.port.map { $0 == 80 || $0 == 443 ? "" : ":\($0)" } ?? ""
    return host.lowercased() + port
  }
  static func browserAllowed(_ w: Win) -> Bool {
    var webSurface = ["safari", "chrome", "chromium", "edge", "firefox", "brave", "opera", "vivaldi", "arc", "zen", "duckduckgo"].contains(where: w.app.lowercased().contains)
    if let bundleURL = NSRunningApplication(processIdentifier: w.pid)?.bundleURL, let bundle = Bundle(url: bundleURL) {
      let handlers = bundle.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] ?? []
      if handlers.contains(where: { ($0["CFBundleURLSchemes"] as? [String] ?? []).contains(where: { ["http", "https"].contains($0.lowercased()) }) }) { webSurface = true }
    }
    lock.lock(); let own = authority(ownServer); lock.unlock()
    guard let own, let root = axWindow(w) else { return false }
    var nodes = 0, found = false, ownPage = false, editingAddress = false
    func scan(_ e: AXUIElement, _ depth: Int) {
      nodes += 1
      guard depth <= 8, nodes <= 1000, !ownPage else { return }
      let role = attr(e, kAXRoleAttribute) as? String ?? ""
      // Web content cannot supply a pretend native address bar.
      if role == "AXWebArea" { webSurface = true; return }
      if role == "AXDocument" { return }
      if ["AXTextField", "AXComboBox"].contains(role) {
        let label = [attr(e, "AXIdentifier"), attr(e, kAXTitleAttribute), attr(e, kAXDescriptionAttribute)].compactMap { $0 as? String }.joined(separator: " ").lowercased()
        if label.range(of: "address|search.field|omnibox|url|adresse|direcci|endere|indirizzo|location", options: .regularExpression) != nil,
           attr(e, kAXSubroleAttribute) as? String != "AXSecureTextField", let value = attr(e, kAXValueAttribute) as? String, let site = authority(value) {
          found = true; ownPage = site == own; editingAddress = editingAddress || attr(e, kAXFocusedAttribute) as? Bool == true
        }
      }
      for child in attr(e, kAXChildrenAttribute) as? [AXUIElement] ?? [] { scan(child, depth + 1) }
    }
    scan(root, 0); return !webSurface && !found ? true : found && !ownPage && !editingAddress
  }
  static func secureAncestors(_ e: AXUIElement) -> (secure: Bool, labels: String) {
    var current: AXUIElement? = e, labels = ""
    for _ in 0..<12 {
      guard let c = current else { break }
      guard let role = attr(c, kAXRoleAttribute) as? String else { return (true, labels) }
      if role == "AXSecureTextField" || attr(c, kAXSubroleAttribute) as? String == "AXSecureTextField" { return (true, labels) }
      labels += " " + (attr(c, kAXTitleAttribute) as? String ?? "") + " " + (attr(c, kAXDescriptionAttribute) as? String ?? "")
      if role == "AXStaticText" { labels += " " + (attr(c, kAXValueAttribute) as? String ?? "") }
      if let parent = attr(c, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() { current = (parent as! AXUIElement) } else { current = nil }
    }
    return (false, handsMask(labels))
  }
  static func denied(_ message: String) -> HandsOpError { HandsOpError(code: "denied_local", message: message) }
  static func unlocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return session["CGSSessionScreenIsLocked"] as? Bool != true && session["kCGSessionOnConsoleKey"] as? Bool != false
  }
  static func dangerousApp(_ name: String) -> Bool {
    let s = name.lowercased()
    return ["finder", "terminal", "iterm", "powershell", "script editor", "automator", "system settings", "system preferences", "sara"].contains(where: s.contains) || blockedKind(name, name) != nil
  }
  static func neverAction(_ text: String) -> Bool {
    text.range(of: "\\b(delete|remove|erase|trash|recycle|unlink)\\b(?!\\s+(my |your |this |the )?account\\b)|run as administrator|elevat(ed|ion)|delete (a )?(file|folder)|remove (a )?(file|folder)|empty (the )?(trash|recycle)|move to trash|format (disk|drive)|security settings", options: .regularExpression.union(.caseInsensitive)) != nil
  }
  static func onceAction(_ text: String) -> Bool {
    text.range(of: "\\b(pay|payment|purchase|buy|checkout|order|donate|card|credit|billing|cvv|cvc|account|password|recovery|privacy|security|send|post|install|uninstall)\\b|cc-number|cc-csc|2fa|two.factor", options: .regularExpression.union(.caseInsensitive)) != nil
  }
  struct BoundInput { let view: View; let window: Win; let item: Item; let point: CGPoint; let context: String }
  static func bindInput(_ a: [String: Any], activate: Bool = false, approvedRefresh: Bool = false, operation: String = "") throws -> BoundInput {
    guard unlocked() else { throw denied("The screen is locked or the secure desktop is active; Sara cannot control it.") }
    guard AXIsProcessTrusted() else { throw HandsOpError(code: "perm_missing", message: "Allow Sara in System Settings → Privacy & Security → Accessibility, then reopen Sara. Only the owner can grant this.") }
    let vid = a["viewId"] as? String ?? ""
    lock.lock(); let view = views[vid]; lock.unlock()
    guard let v = view, Date().timeIntervalSince(v.at) <= (approvedRefresh ? 600 : viewTtl), let saved = v.window else { throw HandsOpError(code: "stale_view", message: "That look is older than 20 seconds: look again.") }
    let all = list()
    let w = try find(all, a["window"] as? String ?? "w\(saved.id)")
    guard w.id == saved.id, w.pid == saved.pid, w.bounds == saved.bounds, w.title == saved.title, w.app == saved.app else { throw HandsOpError(code: "stale_view", message: "That window changed or is not the window in this look.") }
    // Signal zero checks permission only; it sends no signal. A privileged process is refused.
    guard kill(w.pid, 0) == 0 else { throw denied("I can't control windows running as administrator") }
    guard !dangerousApp(w.app) else { throw denied("Terminal, system settings and protected applications are not desktop input targets.") }
    guard browserAllowed(w) else { throw denied("Sara cannot control her own server/sign-in in a browser, or a browser whose address cannot be checked safely.") }
    if activate, NSWorkspace.shared.frontmostApplication?.processIdentifier != w.pid { _ = NSRunningApplication(processIdentifier: w.pid)?.activate(options: []) }
    let app = AXUIElementCreateApplication(w.pid)
    if activate, let target = axWindow(w) {
      _ = AXUIElementPerformAction(target, kAXRaiseAction as CFString)
      for _ in 0..<30 { if NSWorkspace.shared.frontmostApplication?.processIdentifier == w.pid { break }; Thread.sleep(forTimeInterval: 0.01) }
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == w.pid,
          let targetWindow = axWindow(w), let focusedWindow = attr(app, kAXFocusedWindowAttribute),
          CFGetTypeID(focusedWindow) == AXUIElementGetTypeID(), CFEqual(targetWindow, focusedWindow) else { throw denied("The target window is not in front. Look again when it is.") }
    let (items, _) = collect(w, limit: maxElements)
    guard items.count == v.items.count else { throw HandsOpError(code: "stale_view", message: "The controls changed: look again.") }
    for (old, new) in zip(v.items, items) {
      guard CFEqual(old.element, new.element), old.frame == new.frame, old.name == new.name, old.role == new.role, old.secret == new.secret, old.disabled == new.disabled else { throw HandsOpError(code: "stale_view", message: "A control changed: look again.") }
    }
    let item: Item
    let point: CGPoint
    if let ref = a["ref"] as? String, ref.range(of: "^e[1-9][0-9]{0,3}$", options: .regularExpression) != nil, let n = Int(ref.dropFirst()), n <= items.count {
      item = items[n - 1]; point = CGPoint(x: item.frame.midX, y: item.frame.midY)
    } else {
      guard let x = (a["x"] as? NSNumber)?.doubleValue, let y = (a["y"] as? NSNumber)?.doubleValue, x.isFinite, y.isFinite, x >= 0, y >= 0, x < Double(v.width), y < Double(v.height) else { throw denied("The point is outside this picture; list-only looks require a ref.") }
      point = CGPoint(x: v.ox + x / v.scale, y: v.oy + y / v.scale)
      var hit: AXUIElement?
      guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success, let e = hit else { throw denied("That point cannot be inspected safely.") }
      let secure = (attr(e, kAXRoleAttribute) as? String) == "AXSecureTextField" || (attr(e, kAXSubroleAttribute) as? String) == "AXSecureTextField"
      item = items.first(where: { CFEqual($0.element, e) }) ?? Item(element: e, role: attr(e, kAXRoleAttribute) as? String ?? "element", name: attr(e, kAXTitleAttribute) as? String ?? "", value: nil, secret: secure, disabled: attr(e, kAXEnabledAttribute) as? Bool == false, focused: false, frame: frameOf(e) ?? CGRect(origin: point, size: CGSize(width: 1, height: 1)))
    }
    let ancestors = secureAncestors(item.element)
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success, let actualHit = hit else { throw denied("The point cannot be inspected safely.") }
    let actual = secureAncestors(actualHit)
    var actions: CFArray?; AXUIElementCopyActionNames(item.element, &actions)
    let directPress = operation == "d.click" && a["button"] as? String != "right" && a["double"] as? Bool != true && (actions as? [String] ?? []).contains(kAXPressAction)
    if operation == "d.drag" || (operation == "d.click" && !directPress) {
      guard CFEqual(item.element, actualHit) else { throw HandsOpError(code: "stale_view", message: "That container's point hits a different control. Look again and use that control's ref.") }
    }
    let context = ancestors.labels + actual.labels
    guard !item.secret, !ancestors.secure, !actual.secure else { throw denied("That is a password field: Sara never types or presses keys into those.") }
    guard !item.disabled, !neverAction(item.name + context) else { throw denied("That disabled or protected desktop action is refused.") }
    guard all.first(where: { $0.bounds.contains(point) && $0.layer >= 0 })?.id == w.id else { throw denied("Another window covers that point. Sara will not act on it.") }
    if let f = attr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute), CFGetTypeID(f) == AXUIElementGetTypeID() {
      let e = f as! AXUIElement
      if secureAncestors(e).secure { throw denied("A password or secure field is focused. Sara cannot send input.") }
    } else { throw denied("The focused control cannot be inspected safely.") }
    return BoundInput(view: v, window: w, item: item, point: point, context: context)
  }
  static func launchInput(_ a: [String: Any], execute: Bool, cancelled: @escaping () -> Bool = { false }) throws -> [String: Any] {
    guard unlocked() else { throw denied("The screen is locked or the secure desktop is active.") }
    let bundle = a["app"] as? String ?? ""
    guard bundle.range(of: "^[A-Za-z0-9.-]{1,120}$", options: .regularExpression) != nil, !dangerousApp(bundle),
          let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle), !dangerousApp(url.deletingPathExtension().lastPathComponent) else { throw denied("Choose an installed app by its bundle id. Commands and protected apps are refused.") }
    if execute {
      let sem = DispatchSemaphore(value: 0)
      let expired = HandsCancel()
      var error: Error?
      DispatchQueue.main.async {
        guard !cancelled(), !expired.isSet, unlocked() else { error = denied("Stopped or locked before opening the app."); sem.signal(); return }
        let config = NSWorkspace.OpenConfiguration(); config.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, e in error = e; sem.signal() }
      }
      guard sem.wait(timeout: .now() + 10) == .success else { expired.set(); throw HandsOpError(code: "timeout", message: "The app launch did not finish; it may already be opening.") }
      if let error { throw error }
    }
    return ["launched": bundle]
  }
  static func inspectInput(_ op: String, _ a: [String: Any]) throws -> (summary: String, once: Bool) {
    if op == "d.launch" { _ = try launchInput(a, execute: false); let name = a["app"] as? String ?? ""; return ("Open installed app: \(name)", onceAction(name)) }
    let b = try bindInput(a, operation: op)
    let text = a["text"] as? String ?? ""
    guard text.utf16.count <= 2000, handsMask(text) == text else { throw denied("Text is too long or looks like a secret.") }
    let summary = "\(op) in \(b.window.title) / \(b.item.role) \(b.item.name)" + (op == "d.type" ? "\nText: \(text)" : op == "d.keys" ? "\nKeys: \(a["combo"] as? String ?? "")" : "")
    var once = onceAction("\(b.window.title) \(b.item.name) \(b.context) \(text)")
    var detail = summary
    if op == "d.drag" {
      var end = a; end.removeValue(forKey: "ref"); end["x"] = a["toX"]; end["y"] = a["toY"]
      let target = try bindInput(end)
      once = once || onceAction(target.item.name + target.context)
      detail += "\nDrop on: " + target.item.role + " " + target.item.name
    }
    return (detail, once)
  }
  static func refreshApproved(_ a: inout [String: Any], operation: String) throws {
    let b = try bindInput(a, activate: true, approvedRefresh: true, operation: operation)
    var v = View(at: Date(), ox: b.view.ox, oy: b.view.oy, scale: b.view.scale, window: b.window, items: b.view.items)
    v.width = b.view.width; v.height = b.view.height
    lock.lock(); viewN += 1; let vid = "v\(viewN)"; views[vid] = v; lock.unlock(); a["viewId"] = vid
  }
  static func input(_ op: String, _ a: [String: Any], cancelled: @escaping () -> Bool) throws -> [String: Any] {
    guard !cancelled() else { throw HandsOpError(code: "stopped", message: "Stopped before desktop input.") }
    if op == "d.launch" { return try launchInput(a, execute: true, cancelled: cancelled) }
    let b = try bindInput(a, activate: true, operation: op)
    var dragging = false
    func check() throws {
      if cancelled() { throw HandsOpError(code: "stopped", message: "Stopped during desktop input. Look again before trying.") }
      if dragging {
        let current = try find(list(), "w\(b.window.id)")
        let app = AXUIElementCreateApplication(current.pid)
        guard unlocked(), current.pid == b.window.pid, NSWorkspace.shared.frontmostApplication?.processIdentifier == current.pid,
              let target = axWindow(current), let focused = attr(app, kAXFocusedWindowAttribute), CFEqual(target, focused),
              !secureAncestors(b.item.element).secure, browserAllowed(current), attr(b.item.element, kAXEnabledAttribute) as? Bool != false else { throw denied("The drag target changed or became protected.") }
      } else {
        let current = try bindInput(a, operation: op)
        guard CFEqual(b.item.element, current.item.element), b.item.name == current.item.name, b.context == current.context else { throw denied("The approved hit control changed before input.") }
      }
    }
    func post(_ event: CGEvent?) throws {
      try check()
      guard let event else { throw denied("The OS could not create that input event.") }
      event.setIntegerValueField(.eventSourceUserData, value: inputTag); event.post(tap: .cghidEventTap)
    }
    func mouse(_ kind: CGEventType, _ p: CGPoint, _ button: CGMouseButton = .left) -> CGEvent? { CGEvent(mouseEventSource: nil, mouseType: kind, mouseCursorPosition: p, mouseButton: button) }
    func focus() throws {
      try check()
      guard AXUIElementSetAttributeValue(b.item.element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success,
            let f = attr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute), CFEqual(b.item.element, f) else { throw denied("Focus is not on the target control.") }
    }
    if op == "d.click" {
      let right = a["button"] as? String == "right", twice = a["double"] as? Bool == true
      var names: CFArray?
      AXUIElementCopyActionNames(b.item.element, &names)
      if !right, !twice, (names as? [String] ?? []).contains(kAXPressAction) {
        try check()
        guard AXUIElementPerformAction(b.item.element, kAXPressAction as CFString) == .success else { throw denied("The control refused its accessibility action.") }
      } else {
        for i in 1...(twice ? 2 : 1) {
          let down = mouse(right ? .rightMouseDown : .leftMouseDown, b.point, right ? .right : .left), up = mouse(right ? .rightMouseUp : .leftMouseUp, b.point, right ? .right : .left)
          down?.setIntegerValueField(.mouseEventClickState, value: Int64(i)); up?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
          try post(down)
          // Release even on interruption; never strand a held mouse button.
          defer { up?.setIntegerValueField(.eventSourceUserData, value: inputTag); up?.post(tap: .cghidEventTap) }
          try check()
        }
      }
    } else if op == "d.type" {
      let text = a["text"] as? String ?? ""
      guard text.utf16.count <= 2000, handsMask(text) == text else { throw denied("Text is too long or looks like a secret.") }
      var settable: DarwinBoolean = false
      AXUIElementIsAttributeSettable(b.item.element, kAXValueAttribute as CFString, &settable)
      if settable.boolValue {
        try check()
        guard AXUIElementSetAttributeValue(b.item.element, kAXValueAttribute as CFString, text as CFString) == .success else { throw denied("The field refused its accessibility value action.") }
      } else {
        guard b.item.role == "edit" else { throw denied("That control is not an editable field.") }
        try focus()
        for ch in text.utf16 {
          var value = ch
          let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true), up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
          down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &value); up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &value)
          try post(down); up?.setIntegerValueField(.eventSourceUserData, value: inputTag); up?.post(tap: .cghidEventTap)
        }
      }
    } else if op == "d.keys" {
      let combo = (a["combo"] as? String ?? "").lowercased()
      let keys: [String: CGKeyCode] = ["enter": 36, "tab": 48, "shift+tab": 48, "escape": 53, "arrowleft": 123, "arrowright": 124, "arrowup": 126, "arrowdown": 125, "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "backspace": 51, "cmd+a": 0, "ctrl+a": 0]
      guard let key = keys[combo] else { throw denied("That key combination is not on the safe desktop key list.") }
      try focus()
      let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true), up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false)
      let flags: CGEventFlags = combo == "shift+tab" ? .maskShift : combo.hasSuffix("+a") ? .maskCommand : []
      down?.flags = flags; up?.flags = flags
      try post(down); up?.setIntegerValueField(.eventSourceUserData, value: inputTag); up?.post(tap: .cghidEventTap)
    } else if op == "d.scroll" {
      let dx = (a["dx"] as? NSNumber)?.doubleValue ?? 0, dy = (a["dy"] as? NSNumber)?.doubleValue ?? 0
      guard dx.isFinite, dy.isFinite, abs(dx) <= 2400, abs(dy) <= 2400 else { throw denied("Scroll amount is outside the limit.") }
      var names: CFArray?; AXUIElementCopyActionNames(b.item.element, &names)
      let action = dy > 0 ? "AXScrollDownByPage" : "AXScrollUpByPage"
      if dx == 0, (names as? [String] ?? []).contains(action) {
        try check(); guard AXUIElementPerformAction(b.item.element, action as CFString) == .success else { throw denied("The control refused its accessibility scroll action.") }
      } else {
        try post(mouse(.mouseMoved, b.point))
        try post(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: -Int32(dy), wheel2: Int32(dx), wheel3: 0))
      }
    } else if op == "d.drag" {
      guard let x = (a["toX"] as? NSNumber)?.doubleValue, let y = (a["toY"] as? NSNumber)?.doubleValue, x.isFinite, y.isFinite, x >= 0, y >= 0, x < Double(b.view.width), y < Double(b.view.height) else { throw denied("The drag endpoint is outside this picture.") }
      let end = CGPoint(x: b.view.ox + x / b.view.scale, y: b.view.oy + y / b.view.scale)
      var destinationArgs = a; destinationArgs.removeValue(forKey: "ref"); destinationArgs["x"] = x; destinationArgs["y"] = y
      _ = try bindInput(destinationArgs)
      try post(mouse(.leftMouseDown, b.point))
      dragging = true
      var last = b.point
      defer { let up = mouse(.leftMouseUp, last); up?.setIntegerValueField(.eventSourceUserData, value: inputTag); up?.post(tap: .cghidEventTap) }
      for step in 1...8 {
        let p = CGPoint(x: b.point.x + (end.x - b.point.x) * Double(step) / 8, y: b.point.y + (end.y - b.point.y) * Double(step) / 8)
        guard list().first(where: { $0.bounds.contains(p) && $0.layer >= 0 })?.id == b.window.id else { throw denied("The drag crossed another window.") }
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &hit) == .success, let element = hit else { throw denied("The drag crossed an uninspectable control.") }
        let ancestry = secureAncestors(element)
        guard !ancestry.secure, !neverAction(ancestry.labels) else { throw denied("The drag crossed a protected or secure control.") }
        try post(mouse(.leftMouseDragged, p)); last = p
      }
    } else { throw HandsOpError(code: "unsupported", message: "Unsupported desktop input operation.") }
    let after = try elements(["window": "w\(b.window.id)"])
    return ["changed": true, "after": after]
  }
}

/// The local native card is the only place a desktop approval can be answered.
final class HandsDesktopApproval {
  static func ask(_ summary: String, taskChoice: Bool, test: Bool, cancel: HandsCancel) -> Int {
    let done = DispatchSemaphore(value: 0)
    var answer = 0
    DispatchQueue.main.async {
      guard !cancel.isSet else { done.signal(); return }
      let alert = NSAlert(); alert.messageText = test ? "TEST Sara: desktop action" : "Sara: desktop action"
      alert.informativeText = String(summary.prefix(900)) + "\nDecide here. Control-Option-Esc still stops Sara."
      alert.addButton(withTitle: "Allow once").keyEquivalent = ""
      if taskChoice { alert.addButton(withTitle: "Allow for this task").keyEquivalent = "" }
      let deny = alert.addButton(withTitle: "Don't"); deny.keyEquivalent = "\r"
      let window = alert.window; window.sharingType = .none; window.level = .modalPanel
      window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
      let timer = Timer(timeInterval: 0.05, repeats: true) { _ in if cancel.isSet { NSApp.abortModal(); window.orderOut(nil) } }
      RunLoop.main.add(timer, forMode: .modalPanel)
      NSApp.activate(ignoringOtherApps: true)
      let result = alert.runModal(); timer.invalidate()
      if !cancel.isSet { answer = result == .alertFirstButtonReturn ? 1 : taskChoice && result == .alertSecondButtonReturn ? 2 : 0 }
      done.signal()
    }
    done.wait(); return answer
  }
}
