// U2.7 (docs/desktop.md → Quick ask anywhere; the Windows app's desktop/windows/src/quick-context.cpp): quick ask
// on a Mac with what was selected in the app in front and a picture of its window.
// - Selected text: when the shortcut is pressed (before the panel comes to the front) the focused element of
//   the app in front is asked for its selected text with Accessibility (kAXSelectedTextAttribute). Needs the
//   Accessibility permission (the same one her hands use); without it nothing is read and there is no
//   copy-and-paste fallback. Never a password field (AXSecureTextField), never Sara's own windows, never a window
//   hidden from her hands' rules (HandsScreen.blockedKind: password managers, banking, security settings, the
//   person's own list). Key-shaped text is masked; at most 8,000 characters. The text is never logged.
// - This window: the page's picture button sends {a:'window'}; one picture of that window through her hands'
//   picture code (HandsScreen.shot: ScreenCaptureKit, secure fields boxed out, macOS 14+, Screen Recording).
// Tray switch: "Quick ask includes selected text" (prefs quickAskSelection, on by default).
import AppKit
import ApplicationServices

enum QuickContext {
  static let maxChars = 8000
  struct Ctx {
    var app = ""
    var window = false
    var text = ""
    var skipped = ""
    var looked = false
    var windowId: CGWindowID?
    var json: [String: Any] { ["app": app, "window": window, "text": text, "skipped": skipped, "looked": looked] }
  }
  static var last = Ctx()
  static var selectionOn: Bool { prefs.object(forKey: "quickAskSelection") == nil || prefs.bool(forKey: "quickAskSelection") }

  /// What is in front right now (call before the quick-ask panel takes the front).
  static func capture(selection: Bool) -> Ctx {
    var c = Ctx()
    defer { last = c }
    guard let front = NSWorkspace.shared.frontmostApplication, !HandsScreen.isSara(front.processIdentifier) else { return c }
    let pid = front.processIdentifier
    c.app = HandsScreen.clip(front.localizedName ?? "", 80)
    let w = HandsScreen.list().first { $0.pid == pid && $0.layer == 0 && $0.bounds.width > 40 && $0.bounds.height > 30 }
    if let kind = HandsScreen.blockedKind(w?.title ?? "", front.localizedName ?? "") {
      c.skipped = kind
      return c
    }
    c.window = w != nil
    c.windowId = w?.id
    guard selection, AXIsProcessTrusted() else { return c }
    c.looked = true
    let sys = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(sys, 0.4)
    guard let f = HandsScreen.attr(sys, kAXFocusedUIElementAttribute), CFGetTypeID(f) == AXUIElementGetTypeID() else { return c }
    let el = f as! AXUIElement
    var owner: pid_t = 0
    AXUIElementGetPid(el, &owner)
    guard owner == pid else { return c }
    if (HandsScreen.attr(el, kAXSubroleAttribute) as? String) == "AXSecureTextField" {
      c.skipped = "password field"
      return c
    }
    if let s = HandsScreen.attr(el, kAXSelectedTextAttribute) as? String {
      c.text = clean(s)
    }
    return c
  }

  /// Masked, trimmed, at most 8,000 characters.
  static func clean(_ s: String) -> String {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    return HandsScreen.mask(String(t.prefix(maxChars)))
  }

  /// One picture of the window that was in front ({data, w, h} or {error}); done on the main thread.
  static func picture(_ done: @escaping ([String: Any]) -> Void) {
    guard let id = last.windowId, last.skipped.isEmpty else { return done(["error": "No window to take a picture of."]) }
    DispatchQueue.global(qos: .userInitiated).async {
      var r: [String: Any]
      do {
        let s = try HandsScreen.shot(["window": "w\(id)", "maxEdge": 1600])
        r = ["data": "data:image/jpeg;base64," + s.jpeg.base64EncodedString(), "w": s.w, "h": s.h]
      } catch let e as HandsOpError {
        r = ["error": e.message]
      } catch {
        r = ["error": "No picture came from that window."]
      }
      DispatchQueue.main.async { done(r) }
    }
  }
}
