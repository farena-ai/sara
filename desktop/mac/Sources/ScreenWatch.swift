// W0.5: the V4.5 screen companion on the Mac (docs/design/V4SCREEN.md, docs/desktop.md "Screen companion").
// Opt-in (off by default), this Mac only: every 5 s it reads the window in front through Accessibility
// (its title, the program's name and the names of its controls; never a secure field, never a typed value)
// and, when an error dialog or a stuck form shows, offers help in the quick-ask panel's small bubble without
// taking the keyboard. The rules are src/screen-companion.ts's, ported as fixed lists (test/w0-mac.test.ts keeps
// them equal, like desktop/windows/src/screen-watch.cpp). Never a window hidden from Sara (HandsScreen.blockedKind)
// or one of hers; one offer per thing seen (kept as a number), at most one every 2 minutes, none while paused, off
// or while quick ask is open. Nothing is written or sent: the offer only goes to the bubble, and only "Help with
// this" puts the line into the quick-ask box, where the person still presses Ask.
// Permission: Accessibility only (System Settings → Privacy & Security → Accessibility). No pictures are taken, so
// Screen Recording is not needed; without Accessibility the watch simply sees nothing and Settings says so.
import AppKit
import ApplicationServices

enum ScreenRules {
  static let everyMs = 5000
  static let cooldownMs = 120000
  static let stuckChecks = 3
  static let maxTexts = 80
  static let maxTextLen = 300
  static let lineLen = 160
  static let remember = 64
  /// Looking stops after this long or this many elements (a busy window must never slow the Mac).
  static let lookSeconds = 1.5
  static let maxNodes = 400

  /// An error shown in a dialog (English, Spanish, French, German, Portuguese, Italian). Lower case.
  static let errorWords: [String] = [
    "error", "failed", "failure", "could not", "couldn't", "cannot", "can't", "unable to", "exception",
    "has stopped working", "something went wrong", "access is denied", "access denied", "permission denied",
    "timed out", "not found", "crashed", "fatal", "no se pudo", "no se puede", "falló", "ha fallado",
    "acceso denegado", "erreur", "échec", "impossible de", "a échoué", "accès refusé", "fehler", "fehlgeschlagen",
    "konnte nicht", "kann nicht", "zugriff verweigert", "erro", "falhou", "falha", "não foi possível", "acesso negado",
    "errore", "impossibile", "non è stato possibile", "accesso negato"
  ]
  /// A form that is waiting for something. Lower case.
  static let formWords: [String] = [
    "required", "is missing", "please enter", "please fill", "must be", "invalid", "not valid", "incorrect",
    "obligatorio", "no es válido", "obligatoire", "n'est pas valide", "erforderlich", "pflichtfeld", "ungültig",
    "obrigatório", "inválido", "obbligatorio", "non valido"
  ]
  /// A window title saying the program hangs. Lower case.
  static let hangWords: [String] = [
    "not responding", "no responde", "ne répond pas", "reagiert nicht", "não responde", "non risponde"
  ]

  struct Look {
    var title = ""
    var app = ""
    var dialog = false
    var texts: [String] = []
    var hidden: String? = nil
    var own = false
  }
  struct Finding { let kind: String; let line: String }

  private static func wordChar(_ c: Character?) -> Bool { guard let c else { return false }; return c.isLetter || c.isNumber }
  private static func fold(_ s: String) -> String { s.lowercased().replacingOccurrences(of: "\u{2018}", with: "'").replacingOccurrences(of: "\u{2019}", with: "'") }

  /// One of the words, as a whole word (no letter or digit right before or after).
  static func hasWord(_ text: String, _ words: [String]) -> Bool {
    let t = Array(fold(text))
    for w in words {
      let wc = Array(w)
      guard !wc.isEmpty, wc.count <= t.count else { continue }
      var i = 0
      while i + wc.count <= t.count {
        if t[i..<(i + wc.count)].elementsEqual(wc) && !wordChar(i > 0 ? t[i - 1] : nil) && !wordChar(i + wc.count < t.count ? t[i + wc.count] : nil) { return true }
        i += 1
      }
    }
    return false
  }
  /// Control characters and runs of white space become one space; trimmed.
  static func tidy(_ s: String) -> String {
    var out = String.UnicodeScalarView()
    var space = false
    for u in s.unicodeScalars {
      if u.value < 0x20 || u.value == 0x7f || CharacterSet.whitespacesAndNewlines.contains(u) { space = !out.isEmpty; continue }
      if space { out.append(" "); space = false }
      out.append(u)
    }
    return String(out)
  }
  /// The line shown in the bubble: key-shaped text masked, at most lineLen characters.
  static func cut(_ s: String) -> String {
    let m = handsMask(s)
    return m.count > lineLen ? String(m.prefix(lineLen - 1)) + "…" : m
  }

  /// What one look at a window finds: an error, a form message, or nothing (src/screen-companion.ts screenFinding).
  static func finding(_ look: Look) -> Finding? {
    if look.own || look.hidden != nil { return nil }
    let title = tidy(look.title)
    let texts = look.texts.prefix(maxTexts).map(tidy).filter { !$0.isEmpty && $0.count <= maxTextLen }
    if look.dialog, let e = (texts + [title]).first(where: { !$0.isEmpty && hasWord($0, errorWords) }) { return Finding(kind: "error", line: cut(e)) }
    if !title.isEmpty && hasWord(title, hangWords) { return Finding(kind: "error", line: cut(title)) }
    if let f = texts.first(where: { hasWord($0, formWords) }) { return Finding(kind: "form", line: cut(f)) }
    return nil
  }

  /// FNV-1a over UTF-16 code units (the same number as the reference and the Windows app).
  static func hash(_ s: String) -> UInt32 {
    var h: UInt32 = 0x811c9dc5
    for u in s.utf16 { h ^= UInt32(u); h = h &* 0x01000193 }
    return h
  }

  /// The window in front, read through Accessibility on this Mac (call off the main thread). Sara's own and
  /// hidden windows come back with only `own` / `hidden` set; nil when there is nothing to read (no permission,
  /// no window).
  static func lookAtFront() -> Look? {
    guard AXIsProcessTrusted(), let front = NSWorkspace.shared.frontmostApplication else { return nil }
    let pid = front.processIdentifier
    var look = Look()
    look.app = front.localizedName ?? ""
    if HandsScreen.isSara(pid) { look.own = true; return look }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, Float(lookSeconds))
    guard let raw = HandsScreen.attr(app, kAXFocusedWindowAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
    var win = raw as! AXUIElement
    look.title = HandsScreen.attr(win, kAXTitleAttribute) as? String ?? ""
    if let k = HandsScreen.blockedKind(look.title, look.app) { look.hidden = k; return look }
    // A dialog: a dialog window, or a sheet (macOS shows most error messages as a sheet on the window).
    func isDialog(_ e: AXUIElement) -> Bool {
      let role = HandsScreen.attr(e, kAXRoleAttribute) as? String ?? ""
      let sub = HandsScreen.attr(e, kAXSubroleAttribute) as? String ?? ""
      return role == "AXSheet" || sub == "AXDialog" || sub == "AXSystemDialog"
    }
    look.dialog = isDialog(win)
    if !look.dialog, let sheet = (HandsScreen.attr(win, kAXChildrenAttribute) as? [AXUIElement] ?? []).first(where: isDialog) {
      win = sheet
      look.dialog = true
    }
    let started = Date()
    var nodes = 0
    func go(_ e: AXUIElement, _ depth: Int) {
      guard depth <= 8, nodes < maxNodes, look.texts.count < maxTexts, Date().timeIntervalSince(started) < lookSeconds else { return }
      for c in HandsScreen.attr(e, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
        nodes += 1
        if nodes >= maxNodes || look.texts.count >= maxTexts { return }
        let role = HandsScreen.attr(c, kAXRoleAttribute) as? String ?? ""
        let sub = HandsScreen.attr(c, kAXSubroleAttribute) as? String ?? ""
        // Never a password field (not even its name), never what someone typed (only labels and messages).
        if role == "AXSecureTextField" || sub == "AXSecureTextField" { continue }
        var name = HandsScreen.attr(c, kAXTitleAttribute) as? String ?? ""
        if name.isEmpty { name = HandsScreen.attr(c, kAXDescriptionAttribute) as? String ?? "" }
        if name.isEmpty, role == "AXStaticText" { name = HandsScreen.attr(c, kAXValueAttribute) as? String ?? "" }
        if !name.isEmpty { look.texts.append(name) }
        go(c, depth + 1)
      }
    }
    go(win, 1)
    return look
  }
}

/// The watch: switched off by default; one offer per thing seen; pause; a cool-down. Memory only.
final class ScreenWatchState {
  var on = false
  private var pausedUntil: Double = 0
  private var lastOffer: Double = -Double.infinity
  private var offered: [UInt32] = []
  private var streakFp: UInt32 = 0
  private var streakN = 0

  func pause(_ ms: Double, now: Double) { pausedUntil = ms > 0 ? now + ms : 0 }
  func pausedFor(_ now: Double) -> Double { max(0, pausedUntil - now) }

  func check(_ look: ScreenRules.Look, now: Double) -> (kind: String, app: String, line: String)? {
    guard on, now >= pausedUntil, let f = ScreenRules.finding(look) else { streakFp = 0; streakN = 0; return nil }
    let app = String(ScreenRules.tidy(look.app).prefix(80))
    let fp = ScreenRules.hash("\(f.kind)\n\(app)\n\(f.line)")
    streakN = streakFp == fp ? streakN + 1 : 1
    streakFp = fp
    if f.kind == "form" && streakN < ScreenRules.stuckChecks { return nil }
    if offered.contains(fp) || now - lastOffer < Double(ScreenRules.cooldownMs) { return nil }
    offered.append(fp)
    if offered.count > ScreenRules.remember { offered.removeFirst() }
    lastOffer = now
    return (f.kind, app, f.line)
  }
}

/// The looking (a timer on the main thread, the reading on a background queue) and the bubble's buttons.
final class ScreenCompanion {
  static let shared = ScreenCompanion()
  let watch = ScreenWatchState()
  weak var app: AppDelegate?
  private var timer: Timer?
  private var hideTimer: Timer?
  private var busy = false
  /// Milliseconds since the Mac started (never jumps with the clock).
  var nowMs: Double { ProcessInfo.processInfo.systemUptime * 1000 }

  /// The switch changed (or the app started): look every 5 s while it is on.
  func sync(_ app: AppDelegate) {
    self.app = app
    watch.on = prefs.bool(forKey: "screenCompanion")
    timer?.invalidate()
    timer = nil
    if watch.on { timer = Timer.scheduledTimer(withTimeInterval: Double(ScreenRules.everyMs) / 1000, repeats: true) { [weak self] _ in self?.tick() } }
  }

  private func tick() {
    guard let app, watch.on, watch.pausedFor(nowMs) == 0, !busy, app.server != nil else { return }
    if app.quick?.visible == true { return }  // he is using quick ask (or a bubble is up): no look
    busy = true
    DispatchQueue.global(qos: .utility).async { [weak self] in
      let look = ScreenRules.lookAtFront()
      DispatchQueue.main.async { self?.looked(look) }
    }
  }

  private func looked(_ look: ScreenRules.Look?) {
    busy = false
    guard let look, let app, let quick = app.quick, !quick.visible else { return }
    guard let offer = watch.check(look, now: nowMs) else { return }
    quick.showOffer(kind: offer.kind, app: offer.app, line: offer.line)
    // Gone by itself after 30 s unless he took it.
    hideTimer?.invalidate()
    hideTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in self?.app?.quick?.endOffer() }
  }

  /// The bubble's buttons: help (the quick-ask box with that line, typing ready), dismiss, pause for 1 hour.
  func act(_ a: String) {
    hideTimer?.invalidate()
    hideTimer = nil
    guard let quick = app?.quick else { return }
    if a == "help" { return quick.takeOffer() }
    if a == "pause" { watch.pause(3_600_000, now: nowMs) }
    quick.endOffer(force: true)
  }
}

extension AppDelegate {
  /// Settings → This computer: the switch, the pause and whether the Mac still needs the permission.
  func screenPrefs(_ d: inout [String: Any]) {
    let left = ScreenCompanion.shared.watch.pausedFor(ScreenCompanion.shared.nowMs)
    d["screenCompanion"] = prefs.bool(forKey: "screenCompanion")
    d["screenPausedMin"] = Int((left + 59_999) / 60_000)
    d["screenNeedsAccess"] = !AXIsProcessTrusted()
  }

  /// The menu bar menu: pause / resume while the companion is on (rebuilt each time the menu opens).
  static let screenTag = 7810
  func refreshScreenItem(in m: NSMenu) {
    for item in m.items where item.tag == AppDelegate.screenTag { m.removeItem(item) }
    let sc = ScreenCompanion.shared
    guard sc.watch.on else { return }
    let paused = sc.watch.pausedFor(sc.nowMs) > 0
    let it = NSMenuItem(title: paused ? "Resume the screen companion" : "Pause the screen companion for 1 hour", action: #selector(toggleScreenPause), keyEquivalent: "")
    it.target = self
    it.tag = AppDelegate.screenTag
    let at = m.items.firstIndex { $0.title == "Open at login" } ?? m.items.count
    m.insertItem(it, at: at)
  }
  @objc func toggleScreenPause() {
    let sc = ScreenCompanion.shared
    sc.watch.pause(sc.watch.pausedFor(sc.nowMs) > 0 ? 0 : 3_600_000, now: sc.nowMs)
  }
}
