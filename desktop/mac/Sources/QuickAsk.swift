// Phase 75 stage 2 (native): worth installing.
// - A global shortcut (⌥⇧S by default; the menu bar's "Quick ask shortcut ▸" or the page's settings
//   through the bridge change it) opens a small floating quick-ask panel over any app: type, the
//   reply streams in, "Open in Sara" continues the conversation in the main window. Escape or
//   clicking elsewhere hides it; it remembers where you put it.
// - Carbon's RegisterEventHotKey: a real global shortcut that needs no Accessibility permission. A
//   clash with another app's shortcut is said once and marked in the menu.
// - The panel shows desktop/shared/quick-ask.html (the same page as the Windows app; in
//   Contents/Resources) loaded with loadHTMLString(baseURL: <server>/__sara_desktop/quick-ask) on the
//   SAME WKWebsiteDataStore as the main window, so it is same-origin with the server in use and has
//   its sign-in: the AI notice, private mode, household members and the demo's rules all hold as
//   in the web app (the page refuses on the demo and never accepts the AI notice itself).
// - The page also tells the app her name, mood, face and "Now" (background jobs running, approvals
//   waiting); the menu bar menu shows them at the top (Allow / Deny / Open in Sara), the menu bar
//   icon's tooltip shows her mood. Asked again every 45 s while the app runs, sooner on /api/events.
import AppKit
import Carbon.HIToolbox
import WebKit

let quickAskPath = "/__sara_desktop/quick-ask"

/// The shortcuts on offer (none of them macOS's own), or off. prefs "quickAskShortcut".
struct QuickShortcut {
  let id: String
  let label: String
  let key: UInt32
  let mods: UInt32
}
let quickShortcuts: [QuickShortcut] = [
  QuickShortcut(id: "opt+shift+s", label: "⌥⇧S", key: UInt32(kVK_ANSI_S), mods: UInt32(optionKey | shiftKey)),
  QuickShortcut(id: "ctrl+opt+s", label: "⌃⌥S", key: UInt32(kVK_ANSI_S), mods: UInt32(controlKey | optionKey)),
  QuickShortcut(id: "ctrl+shift+space", label: "⌃⇧Space", key: UInt32(kVK_Space), mods: UInt32(controlKey | shiftKey)),
  QuickShortcut(id: "ctrl+opt+space", label: "⌃⌥Space", key: UInt32(kVK_Space), mods: UInt32(controlKey | optionKey)),
  QuickShortcut(id: "opt+shift+a", label: "⌥⇧A", key: UInt32(kVK_ANSI_A), mods: UInt32(optionKey | shiftKey)),
]

/// One "Now" line: a background job running, or an approval waiting.
struct NowItem {
  let kind: String  // job | approval
  let id: String
  let conv: String
  let text: String
}

/// A panel that takes typing without bringing the main window forward (like Spotlight).
final class QuickPanel: NSPanel {
  var onCancel: (() -> Void)?
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
  override func cancelOperation(_ sender: Any?) { onCancel?() }
}

final class QuickAsk: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
  weak var app: AppDelegate?
  var panel: QuickPanel?
  var web: WKWebView?
  var effect: NSVisualEffectView?
  var ready = false
  var wantShow = false
  var pageServer = ""
  var heightPt: CGFloat = 132
  var shownAt = Date.distantPast
  // What the page last said.
  var signedIn = false
  var demo = false
  var name = "Sara"
  var mood = ""
  var items: [NowItem] = []
  var face: NSImage?
  // The shortcut.
  var hotKeyRef: EventHotKeyRef?
  var handlerInstalled = false
  var shortcutTaken = false
  var timer: Timer?

  init(app: AppDelegate) {
    self.app = app
    super.init()
    if let data = try? Data(contentsOf: faceCacheURL), let img = NSImage(data: data) { face = img }
    // "Now" every 45 s while the app runs.
    timer = Timer.scheduledTimer(withTimeInterval: 45, repeats: true) { [weak self] _ in self?.refresh() }
  }

  // MARK: the shortcut

  var shortcutId: String {
    let id = prefs.string(forKey: "quickAskShortcut") ?? "opt+shift+s"
    return id == "off" || quickShortcuts.contains(where: { $0.id == id }) ? id : "opt+shift+s"
  }
  var shortcut: QuickShortcut? { quickShortcuts.first { $0.id == shortcutId } }

  /// (Re)registers the shortcut; a clash with another app is said once, in plain words.
  func registerShortcut(tell: Bool) {
    if !handlerInstalled {
      handlerInstalled = true
      var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
      InstallEventHandler(GetApplicationEventTarget(), { _, ev, ctx in
        guard let ctx else { return noErr }
        // Phase 88: only its own hot key (Sara's hands have the stop shortcut ⌃⌥Esc, id 2).
        var hk = EventHotKeyID()
        if let ev { GetEventParameter(ev, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hk) }
        guard hk.signature == OSType(0x5341_5241), hk.id == 1 else { return OSStatus(eventNotHandledErr) }
        let me = Unmanaged<QuickAsk>.fromOpaque(ctx).takeUnretainedValue()
        DispatchQueue.main.async { me.toggle() }
        return noErr
      }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), nil)
    }
    if let ref = hotKeyRef { UnregisterEventHotKey(ref) }
    hotKeyRef = nil
    shortcutTaken = false
    guard let s = shortcut else { return }
    var ref: EventHotKeyRef?
    let status = RegisterEventHotKey(s.key, s.mods, EventHotKeyID(signature: OSType(0x5341_5241), id: 1), GetApplicationEventTarget(), 0, &ref)
    if status == noErr {
      hotKeyRef = ref
    } else {
      shortcutTaken = true
      NSLog("Sara quick ask: \(s.label) is used by another app (\(status))")
      if tell { app?.postNotification(title: "Choose another shortcut for Ask Sara", body: "\(s.label) is already used by another app. Click Sara's menu bar icon → Quick ask shortcut to pick another one.", conv: "") }
    }
    #if DEBUG
    testLog("quick ask shortcut \(s.label) registered=\(status == noErr) status=\(status)")
    #endif
  }

  func unregisterShortcut() {
    if let ref = hotKeyRef { UnregisterEventHotKey(ref) }
    hotKeyRef = nil
  }

  @discardableResult
  func setShortcut(_ id: String) -> Bool {
    guard id == "off" || quickShortcuts.contains(where: { $0.id == id }) else { return false }
    prefs.set(id, forKey: "quickAskShortcut")
    registerShortcut(tell: true)
    return true
  }

  var prefs_: [String: Any] {
    ["quickAskShortcut": shortcutId, "quickAskShortcutLabel": shortcut?.label ?? "", "quickAskShortcutFree": !shortcutTaken,
     "quickAskShortcuts": quickShortcuts.map { ["id": $0.id, "label": $0.label] } + [["id": "off", "label": "Off"]]]
  }

  // MARK: the panel and its page

  /// The page for the server in use, on that server's data store (again after a switch).
  func reset() {
    ready = false
    signedIn = false
    demo = false
    name = "Sara"
    mood = ""
    items = []
    face = (try? Data(contentsOf: faceCacheURL)).flatMap { NSImage(data: $0) }
    pageServer = ""
    web?.configuration.userContentController.removeAllScriptMessageHandlers()
    web?.removeFromSuperview()
    web = nil
    DispatchQueue.main.async { [weak self] in self?.ensure() }
  }

  func ensure() {
    guard let app, let server = app.server, let base = URL(string: server + quickAskPath) else { return }
    if panel == nil { makePanel() }
    if web != nil && pageServer == server { return }
    let config = WKWebViewConfiguration()
    config.websiteDataStore = Servers.dataStore(Servers.active)  // the same sign-in as the main window
    config.applicationNameForUserAgent = "Version/18.0 Safari/605.1.15 SaraDesktop/1 (Mac)"
    config.userContentController.add(self, name: "quick")
    let w = WKWebView(frame: panel?.contentView?.bounds ?? .zero, configuration: config)
    w.autoresizingMask = [.width, .height]
    w.setValue(false, forKey: "drawsBackground")
    w.navigationDelegate = self
    w.uiDelegate = self  // Phase 75 stage 3: the microphone for talking instead of typing
    if #available(macOS 13.3, *) { w.isInspectable = false }
    effect?.addSubview(w)
    web = w
    pageServer = server
    guard let url = Bundle.main.url(forResource: "quick-ask", withExtension: "html"), let html = try? String(contentsOf: url, encoding: .utf8) else {
      w.loadHTMLString("<!doctype html><p>Quick ask is missing from this build.</p>", baseURL: nil)
      return
    }
    // Loaded here, never fetched from the server: the page's address is the server's own.
    w.loadHTMLString(html, baseURL: base)
  }

  func makePanel() {
    let p = QuickPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: heightPt), styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView], backing: .buffered, defer: false)
    p.titleVisibility = .hidden
    p.titlebarAppearsTransparent = true
    for b in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { p.standardWindowButton(b)?.isHidden = true }
    p.level = .floating
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
    p.isFloatingPanel = true
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = true
    p.delegate = self
    p.onCancel = { [weak self] in self?.hide() }
    // Frosted: the system's vibrancy behind a see-through page.
    let v = NSVisualEffectView(frame: p.contentView?.bounds ?? .zero)
    v.autoresizingMask = [.width, .height]
    v.material = .popover
    v.blendingMode = .behindWindow
    v.state = .active
    v.wantsLayer = true
    v.layer?.cornerRadius = 14
    v.layer?.masksToBounds = true
    p.contentView = v
    effect = v
    panel = p
  }

  var visible: Bool { panel?.isVisible ?? false }

  func toggle() {
    if visible && (panel?.isKeyWindow ?? false) { hide() } else { show() }
  }

  /// The shortcut (or the menu's "Ask Sara…"): over whatever is in front, typing ready.
  func show() {
    guard let app else { return }
    if app.server == nil { return app.showWindow() }  // nothing to ask yet: the window sets her up
    ensure()
    guard ready, let panel, let web else { wantShow = true; return }
    wantShow = false
    panel.appearance = Shell.appearance
    place()
    shownAt = Date()
    panel.makeKeyAndOrderFront(nil)
    panel.makeFirstResponder(web)
    let theme = Shell.isDay ? "day" : "night"
    web.evaluateJavaScript("window.saraQuick&&saraQuick.show({theme:'\(theme)',solid:false,shortcut:'\(shortcutTaken ? "" : shortcut?.label ?? "")'})")
  }

  func hide() {
    guard let panel, panel.isVisible else { return }
    prefs.set(NSStringFromPoint(panel.frame.origin), forKey: "quickAskOrigin")
    panel.orderOut(nil)
    web?.evaluateJavaScript("window.saraQuick&&saraQuick.hidden()")  // a recording stops
  }

  /// Where it was last time (if still on a screen), else centred near the top of the main screen.
  func place() {
    guard let panel else { return }
    var frame = panel.frame
    frame.size = NSSize(width: 640, height: heightPt)
    if let s = prefs.string(forKey: "quickAskOrigin") {
      let o = NSPointFromString(s)
      let probe = NSRect(origin: o, size: frame.size)
      if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(probe) }) {
        frame.origin = o
        panel.setFrame(frame, display: true)
        return
      }
    }
    let screen = NSScreen.main ?? NSScreen.screens.first
    let vf = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
    frame.origin = NSPoint(x: vf.midX - frame.width / 2, y: vf.maxY - vf.height / 6 - frame.height)
    panel.setFrame(frame, display: true)
  }

  // Clicking anywhere else hides it.
  func windowDidResignKey(_ notification: Notification) {
    if Date().timeIntervalSince(shownAt) > 0.4 { hide() }
  }
  func windowDidMove(_ notification: Notification) {
    if let panel, panel.isVisible { prefs.set(NSStringFromPoint(panel.frame.origin), forKey: "quickAskOrigin") }
  }

  func refresh() {
    if ready { web?.evaluateJavaScript("window.saraQuick&&saraQuick.refresh()") }
  }

  /// Allow / Deny from the menu bar: the same route the approval card in the chat uses.
  func decide(_ approvalId: String, _ ok: Bool) {
    guard ready, let web, let data = try? JSONSerialization.data(withJSONObject: [approvalId]), let arr = String(data: data, encoding: .utf8) else { return }
    web.evaluateJavaScript("window.saraQuick&&saraQuick.decide(\(arr)[0],\(ok))")
  }

  /// Phase 75 stage 3: Snooze 10 min from a reminder's notification (the normal reminders route).
  func snooze(rid: String, conv: String, text: String) {
    guard ready, let web, let data = try? JSONSerialization.data(withJSONObject: [rid, conv, text]), let arr = String(data: data, encoding: .utf8) else { return }
    web.evaluateJavaScript("window.saraQuick&&saraQuick.snooze(...\(arr))")
  }

  /// Phase 75 stage 3: the microphone, for this page on the server in use only (macOS asks once).
  func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    let o = originOf("\(origin.protocol)://\(origin.host)" + (origin.port > 0 ? ":\(origin.port)" : ""))
    decisionHandler(type == .microphone && o != nil && o == app?.server && o == pageServer && frame.isMainFrame ? .grant : .deny)
  }

  // MARK: the page's messages

  func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
    // Only the quick-ask page this app loaded for the server in use.
    let o = message.frameInfo.securityOrigin
    let origin = originOf("\(o.protocol)://\(o.host)" + (o.port > 0 ? ":\(o.port)" : ""))
    guard message.frameInfo.isMainFrame, let app, let server = app.server, origin == server, pageServer == server,
          let body = message.body as? [String: Any], body["m"] as? String == "qa", let a = body["a"] as? String else { return }
    switch a {
    case "ready":
      ready = true
      if wantShow { show() }
    case "hide":
      hide()
    case "size":
      let h = CGFloat(max(96, min(560, (body["h"] as? Double) ?? Double(heightPt))))
      guard h != heightPt else { return }
      heightPt = h
      if let panel {
        var f = panel.frame
        let top = f.maxY
        f.size.height = h
        f.origin.y = top - h  // the top edge stays put
        panel.setFrame(f, display: true, animate: false)
      }
    case "drag":
      if let panel, let e = NSApp.currentEvent, e.type == .leftMouseDown || NSEvent.pressedMouseButtons & 1 == 1 {
        panel.performDrag(with: e)
      }
    case "open":
      // "Open in Sara": the conversation continues in the main window.
      hide()
      app.showWindow()
      app.openConversation(body["conv"] as? String ?? "")
    case "state":
      take(body)
    case "reminder":
      app.notifyReminder(conv: body["conv"] as? String ?? "", rid: body["rid"] as? String ?? "", text: body["text"] as? String ?? "")
    default: break
    }
  }

  func take(_ b: [String: Any]) {
    guard b["online"] as? Bool ?? false else { return }  // offline for a moment: keep what we knew
    signedIn = b["signedIn"] as? Bool ?? false
    demo = b["demo"] as? Bool ?? false
    name = String((b["name"] as? String ?? "Sara").prefix(60))
    mood = String((b["mood"] as? String ?? "").prefix(40))
    items = (b["now"] as? String ?? "").split(separator: "\n").prefix(10).compactMap { line in
      let f = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
      return f.count == 4 && (f[0] == "job" || f[0] == "approval") ? NowItem(kind: f[0], id: f[1], conv: f[2], text: f[3]) : nil
    }
    if let s = b["face"] as? String, s.hasPrefix("data:image/png;base64,"), let data = Data(base64Encoded: String(s.dropFirst(22))), data.count < 512 * 1024, let img = NSImage(data: data) {
      face = img
      try? data.write(to: faceCacheURL)
    }
    app?.updateStatusTip()
    // Phase 75 stage 3: approvals waiting → a notification with Allow / Deny; decided ones go away.
    app?.notifyApprovals(signedIn && !demo ? b["asks"] as? String ?? "" : "")
    // While a turn runs, ask every 5 s (an approval can come any moment), else every 45 s.
    let busy = b["busy"] as? Bool ?? false
    if busy != (timer?.timeInterval == 5) {
      timer?.invalidate()
      timer = Timer.scheduledTimer(withTimeInterval: busy ? 5 : 45, repeats: true) { [weak self] _ in self?.refresh() }
    }
  }

  /// Her face, cached per server address (in this app's own caches folder) so the menu has it from
  /// the first click after a start.
  var faceCacheURL: URL {
    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent(Bundle.main.bundleIdentifier ?? "Sara", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let host = String(hostOf(app?.server ?? "none").map { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" ? $0 : "_" }.prefix(100))
    return dir.appendingPathComponent("face-\(host).png")
  }

  /// The page that loaded must be the quick-ask page (it always is: it's loaded from the bundle).
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if action.navigationType == .other && action.request.url?.path == quickAskPath { return decisionHandler(.allow) }
    decisionHandler(.cancel)
    if let url = action.request.url, url.scheme == "http" || url.scheme == "https" { NSWorkspace.shared.open(url) }
  }

  #if DEBUG
  /// Test builds: the panel as a PNG (its vibrancy and the web view's snapshot) and its state.
  func testShot(_ path: String, done: @escaping () -> Void) {
    guard let panel, let web, let content = panel.contentView else { return done() }
    web.evaluateJavaScript("JSON.stringify(window.saraQuick?saraQuick.state():null)") { r, _ in
      testLog("quick ask state \(r ?? "nil") visible=\(panel.isVisible) key=\(panel.isKeyWindow) frame=\(panel.frame)")
      web.takeSnapshot(with: nil) { img, _ in
        let size = content.bounds.size
        let out = NSImage(size: size)
        out.lockFocus()
        (Shell.isDay ? NSColor(srgbRed: 0.93, green: 0.91, blue: 0.92, alpha: 1) : NSColor(srgbRed: 0.10, green: 0.09, blue: 0.13, alpha: 1)).setFill()
        NSBezierPath(roundedRect: NSRect(origin: .zero, size: size), xRadius: 14, yRadius: 14).fill()
        img?.draw(in: NSRect(origin: .zero, size: size))
        out.unlockFocus()
        if let tiff = out.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) { try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path)) }
        testLog("quick ask shot \(path)")
        done()
      }
    }
  }
  #endif
}

extension AppDelegate {
  /// The menu bar icon's tooltip: "Sara · relaxed" (+ approvals waiting, + which Sara when there are several).
  func updateStatusTip() {
    guard let q = quick else { return }
    var tip = q.name + (q.mood.isEmpty ? "" : " · \(q.mood)")
    let waiting = q.items.filter { $0.kind == "approval" }.count
    if waiting > 0 { tip += " · \(waiting) waiting for your OK" }
    if Servers.list().count > 1, let s = Servers.active { tip += "\n\(s.name)" }
    statusItem?.button?.toolTip = tip
  }

  /// A conversation in the main window (quick ask's "Open in Sara", the menu's "Now" items).
  func openConversation(_ conv: String) {
    guard !conv.isEmpty, conv.count <= 64, conv.allSatisfy({ $0.isHexDigit || $0 == "-" }) else { return }
    if isServer(web.url) { web.evaluateJavaScript("location.hash = 'c=\(conv)'") } else { openServer("/#c=\(conv)") }
  }

  // MARK: the menu bar menu's top: her face and mood, Ask Sara…, Now

  static let nowTag = 7500

  /// Rebuilt each time the menu opens (menuNeedsUpdate).
  func refreshNowItems(in m: NSMenu) {
    for item in m.items where item.tag >= AppDelegate.nowTag && item.tag < AppDelegate.nowTag + 100 { m.removeItem(item) }
    guard server != nil, let q = quick else { return }
    var at = 0
    func put(_ item: NSMenuItem) {
      if item.tag == 0 { item.tag = AppDelegate.nowTag + 1 }
      m.insertItem(item, at: at)
      at += 1
    }
    // Her face and mood (a click opens the window).
    let head = NSMenuItem(title: q.name, action: #selector(openFromMenu), keyEquivalent: "")
    head.target = self
    let title = NSMutableAttributedString(string: q.name, attributes: [.font: NSFont.menuFont(ofSize: 0).bold])
    if !q.mood.isEmpty { title.append(NSAttributedString(string: " · \(q.mood)", attributes: [.font: NSFont.menuFont(ofSize: 0), .foregroundColor: NSColor.secondaryLabelColor])) }
    head.attributedTitle = title
    if let f = q.face {
      let img = NSImage(size: NSSize(width: 26, height: 26), flipped: false) { r in
        NSBezierPath(ovalIn: r).addClip()
        f.draw(in: r)
        return true
      }
      head.image = img
    }
    head.toolTip = q.mood.isEmpty ? nil : "\(q.name) is \(q.mood)"
    put(head)
    // Quick ask: off on the demo (read-only) and until she's signed in.
    let ask = NSMenuItem(title: "Ask \(q.name)…", action: q.signedIn && !q.demo ? #selector(askFromMenu) : nil, keyEquivalent: "")
    ask.target = self
    if let s = q.shortcut, !q.shortcutTaken {
      ask.keyEquivalent = s.key == UInt32(kVK_Space) ? " " : (s.key == UInt32(kVK_ANSI_A) ? "a" : "s")
      var mods: NSEvent.ModifierFlags = []
      if s.mods & UInt32(optionKey) != 0 { mods.insert(.option) }
      if s.mods & UInt32(shiftKey) != 0 { mods.insert(.shift) }
      if s.mods & UInt32(controlKey) != 0 { mods.insert(.control) }
      ask.keyEquivalentModifierMask = mods
    }
    put(ask)
    if q.signedIn && !q.demo {
      // "Now": background jobs still running and approvals waiting.
      put(NSMenuItem.separator())
      let now = NSMenuItem(title: q.items.isEmpty ? "Now: nothing running" : "Now", action: nil, keyEquivalent: "")
      now.isEnabled = false
      put(now)
      for it in q.items {
        let item = NSMenuItem(title: it.text, action: it.kind == "job" ? #selector(openNowItem(_:)) : nil, keyEquivalent: "")
        item.target = self
        item.representedObject = it.conv
        if it.kind == "approval" {
          let sub = NSMenu()
          for (label, sel) in [("Allow", #selector(allowNowItem(_:))), ("Deny", #selector(denyNowItem(_:)))] {
            let x = NSMenuItem(title: label, action: sel, keyEquivalent: "")
            x.target = self
            x.representedObject = it.id
            sub.addItem(x)
          }
          sub.addItem(.separator())
          let open = NSMenuItem(title: "Open in Sara", action: #selector(openNowItem(_:)), keyEquivalent: "")
          open.target = self
          open.representedObject = it.conv
          sub.addItem(open)
          item.submenu = sub
        }
        put(item)
      }
    }
    put(NSMenuItem.separator())
  }

  /// "Quick ask shortcut ▸": the choices (✓ the one in use; a clash is marked) and Off.
  func shortcutMenu() -> NSMenu {
    let m = NSMenu()
    guard let q = quick else { return m }
    for s in quickShortcuts {
      let on = q.shortcutId == s.id
      let item = NSMenuItem(title: s.label + (on && q.shortcutTaken ? "  (used by another app)" : ""), action: #selector(pickShortcut(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = s.id
      item.state = on ? .on : .off
      m.addItem(item)
    }
    m.addItem(.separator())
    let off = NSMenuItem(title: "Off", action: #selector(pickShortcut(_:)), keyEquivalent: "")
    off.target = self
    off.representedObject = "off"
    off.state = q.shortcutId == "off" ? .on : .off
    m.addItem(off)
    return m
  }

  @objc func askFromMenu() { quick?.show() }
  @objc func pickShortcut(_ item: NSMenuItem) { _ = quick?.setShortcut(item.representedObject as? String ?? "") }
  @objc func openNowItem(_ item: NSMenuItem) {
    showWindow()
    openConversation(item.representedObject as? String ?? "")
  }
  @objc func allowNowItem(_ item: NSMenuItem) { quick?.decide(item.representedObject as? String ?? "", true) }
  @objc func denyNowItem(_ item: NSMenuItem) { quick?.decide(item.representedObject as? String ?? "", false) }
}

extension NSFont {
  var bold: NSFont { NSFontManager.shared.convert(self, toHaveTrait: .boldFontMask) }
}

#if DEBUG
extension AppDelegate {
  /// Test builds only: SARA_TEST_QUICK=<folder> opens the quick-ask panel by itself (no keyboard
  /// over SSH), saves Night and Day pictures of it, lists the menu bar menu's items and the
  /// tooltip, then checks Escape; SARA_TEST_QUICK_ASK=<question> asks it first.
  func runQuickTest() {
    let env = ProcessInfo.processInfo.environment
    guard let dir = env["SARA_TEST_QUICK"], let q = quick else { return }
    let after = { (s: Double, f: @escaping () -> Void) in DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: f) }
    after(12) {
      q.show()
      if let ask = env["SARA_TEST_QUICK_ASK"], let data = try? JSONSerialization.data(withJSONObject: [ask]), let arr = String(data: data, encoding: .utf8) {
        after(3) { q.web?.evaluateJavaScript("(()=>{const q=document.getElementById('q');if(q.disabled)return 'blocked';q.value=\(arr)[0];document.getElementById('ask').requestSubmit();return 'asked'})()") { r, _ in testLog("quick ask asked: \(r ?? "nil")") } }
      }
      let wait = env["SARA_TEST_QUICK_ASK"] == nil ? 6.0 : 60.0
      after(wait) {
        q.testShot(dir + "/mac-quickask-night.png") {
          if let m = self.statusItem.menu {
            self.refreshNowItems(in: m)
            testLog("menu: " + m.items.map { $0.isSeparatorItem ? "—" : ($0.title + ($0.isEnabled ? "" : " (off)") + ($0.image != nil ? " [face]" : "") + ($0.submenu != nil ? " ▸" : "")) }.joined(separator: " | "))
          }
          testLog("tooltip: \(self.statusItem.button?.toolTip ?? "nil")")
          let theme = Shell.themePref
          prefs.set("day", forKey: "theme")
          self.applyTheme()
          q.show()
          after(2) {
            q.testShot(dir + "/mac-quickask-day.png") {
              prefs.set(theme, forKey: "theme")
              self.applyTheme()
              q.panel?.cancelOperation(nil)
              testLog("after Escape: visible=\(q.panel?.isVisible ?? false)")
              testLog("quick test done")
            }
          }
        }
      }
    }
  }
}
#endif
