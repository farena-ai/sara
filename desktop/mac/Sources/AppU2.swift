// U2.7 / U2.8 (docs/design/ROADMAP_U.md, docs/desktop.md → The Mac app catches up (U2)): the app's side of
// - the Dock badge: her page sends the same count as the sidebar's Messages pill (one-to-one unread plus
//   community mentions, src/messages.ts) through SaraDesktop.badge(n); the app shows it on the Dock icon
//   (NSApp.dockTile.badgeLabel, "99+" above 99, nothing at 0). A new page (another server, signed out, a
//   reload) starts with no badge until that page says otherwise.
// - Record this computer (MeetingRec.swift): start / stop / status / discard from Library → Meetings, after
//   its consent tick; the finished WAV goes back to the page as a file it reads in 1 MiB pieces (WebKit has no
//   way to hand a page a file handle) and sends to her server in parts like any recording; then it is deleted.
// Only her own server's page reaches these (main.swift's fromServer guard).
import AppKit
import WebKit

/// Added after main.swift's shim: SaraDesktop.badge(), meetingRec, and the finished recording as a file.
let u2Shim = """
(() => {
  const d = window.SaraDesktop;
  if (!d || d.platform !== 'mac' || d.badge) return;
  const post = (o) => webkit.messageHandlers.sara.postMessage(o);
  let shown = -1;
  d.badge = (n) => {
    const v = Math.max(0, Math.floor(Number(n) || 0));
    if (v === shown) return;
    shown = v;
    post({ m: 'badge', count: v }).catch(() => {});
  };
  d.meetingRec = true;
  const MB = 1048576;
  window.__saraMeetingFile = (o) => {
    const size = Math.max(0, Math.floor(Number(o && o.size) || 0));
    const token = String((o && o.token) || '');
    const read = async (a, b) => {
      const out = new Uint8Array(b - a);
      for (let at = a; at < b; at += MB) {
        const len = Math.min(MB, b - at);
        const s = atob(String(await post({ m: 'meetingRec', op: 'read', token, at, len })));
        if (s.length !== len) throw new Error('The recording could not be read.');
        for (let i = 0; i < len; i++) out[at - a + i] = s.charCodeAt(i);
      }
      return out.buffer;
    };
    const slice = (a, b) => {
      const from = Math.max(0, Math.min(size, Number(a) || 0));
      const to = Math.max(from, Math.min(size, b === undefined ? size : Number(b) || 0));
      return { size: to - from, type: '', arrayBuffer: () => read(from, to) };
    };
    const file = { name: String((o && o.name) || 'recording.wav'), size, type: 'audio/wav', lastModified: Number(o && o.lastModified) || Date.now(), slice, arrayBuffer: () => read(0, size) };
    window.dispatchEvent(new CustomEvent('sara-meeting-file', { detail: { file } }));
  };
})();
"""

enum DockBadge {
  /// The Dock's label for a count: nothing at 0, "99+" above 99.
  static func label(_ n: Int) -> String? { n <= 0 ? nil : n > 99 ? "99+" : String(n) }
}

extension AppDelegate {
  func setDockBadge(_ n: Int) { NSApp.dockTile.badgeLabel = DockBadge.label(n) }

  /// A new page in the main window: its own count comes with it (the old server's must not stay).
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    if webView === web { setDockBadge(0) }
  }

  /// U2 bridge calls (after the fromServer guard). False: not ours.
  func u2Call(_ kind: String, _ body: [String: Any], _ reply: @escaping (Any?, String?) -> Void) -> Bool {
    switch kind {
    case "badge":
      setDockBadge((body["count"] as? NSNumber)?.intValue ?? 0)
      reply(NSApp.dockTile.badgeLabel ?? "", nil)  // what the Dock shows now (checks read it back)
    case "meetingRec":
      meetingRec(body, reply)
    default:
      return false
    }
    return true
  }

  func meetingRec(_ b: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
    let r = MeetingRec.shared
    switch b["op"] as? String ?? "" {
    case "status":
      reply(r.status, nil)
    case "start":
      r.start { result, error in reply(result, error) }
    case "stop":
      guard let f = r.stop() else { return reply(nil, "Nothing is being recorded.") }
      reply(["seconds": f.seconds], nil)
      let meta: [String: Any] = ["name": (f.path as NSString).lastPathComponent, "size": f.size, "lastModified": Int(Date().timeIntervalSince1970 * 1000), "token": f.token]
      guard let d = try? JSONSerialization.data(withJSONObject: meta), let json = String(data: d, encoding: .utf8) else { return }
      web.evaluateJavaScript("window.__saraMeetingFile && window.__saraMeetingFile(\(json))")
    case "discard":
      r.discard()
      reply(true, nil)
    case "read":
      let at = (b["at"] as? NSNumber)?.intValue ?? -1, len = (b["len"] as? NSNumber)?.intValue ?? 0
      guard let s = r.read(token: b["token"] as? String ?? "", at: at, len: len) else { return reply(nil, "The recording could not be read.") }
      reply(s, nil)
    default:
      reply(nil, "unknown")
    }
  }
}
