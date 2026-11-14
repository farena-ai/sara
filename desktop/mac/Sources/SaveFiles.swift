// N5 (Mac parity with the Windows app's "Save to my PC", desktop/windows/src/save-files.cpp; the page is
// web/save-to-pc.js): files she made get "Save to…" (the Mac's Save panel, which starts in the last folder
// used) and "Save to Downloads", then Open / Show in Finder; "Put her documents in a folder automatically"
// saves each new document she makes into a folder of the person's choice (Documents/Sara by default). The
// web view downloads the bytes with its own sign-in (WKWebView.startDownload) into the place picked on this
// Mac; the full path never goes back to the page (a short folder name and a token for Open / Show).
import AppKit
import WebKit

final class SaveFiles: NSObject, WKDownloadDelegate {
  static let shared = SaveFiles()
  private struct Intent { let name: String; let path: URL; let reply: (Any?, String?) -> Void }
  private var intents: [ObjectIdentifier: Intent] = [:]
  private var saved: [String: String] = [:]  // token → path (Open / Show in Finder)
  private var next = 1
  private let d = UserDefaults.standard
  var testDir = ""

  // MARK: the rules (SaveFiles checks in the self-check)
  /// A file name this Mac accepts: no slashes or colons, no control characters, at most 150 characters.
  static func cleanName(_ raw: String) -> String {
    var o = String(raw.map { $0.unicodeScalars.first!.value < 0x20 || "/:\\".contains($0) ? "_" : $0 })
    while o.hasSuffix(".") || o.hasSuffix(" ") { o.removeLast() }
    while o.hasPrefix(" ") || o.hasPrefix(".") { o.removeFirst() }
    if o.count > 150 {
      let ext = (o as NSString).pathExtension
      let keep = ext.isEmpty || ext.count > 7 ? "" : "." + ext
      o = String(o.prefix(150 - keep.count)) + keep
    }
    return o.isEmpty ? "document" : o
  }
  /// "name.pdf", then "name (2).pdf", "name (3).pdf"…
  static func uniquePath(_ dir: URL, _ name: String) -> URL {
    let fm = FileManager.default
    var p = dir.appendingPathComponent(name)
    if !fm.fileExists(atPath: p.path) { return p }
    let ext = (name as NSString).pathExtension, stem = ext.isEmpty ? name : (name as NSString).deletingPathExtension
    for n in 2..<1000 {
      p = dir.appendingPathComponent(ext.isEmpty ? "\(stem) (\(n))" : "\(stem) (\(n)).\(ext)")
      if !fm.fileExists(atPath: p.path) { return p }
    }
    return dir.appendingPathComponent("\(stem) (\(Int(Date().timeIntervalSince1970)))" + (ext.isEmpty ? "" : ".\(ext)"))
  }
  /// Only her files: /api/library/<n>/file, /api/library/made/<n>/file, /api/files/<id>.
  static func urlOk(_ p: String) -> Bool {
    if p.contains("..") || p.contains(where: { "?#%\\".contains($0) }) { return false }
    if p.range(of: "^/api/library/made/[0-9]+/file$", options: .regularExpression) != nil { return true }
    if p.range(of: "^/api/library/[0-9]+/file$", options: .regularExpression) != nil { return true }
    return p.range(of: "^/api/files/[A-Za-z0-9._-]{1,120}$", options: .regularExpression) != nil
  }

  // MARK: places
  private func known(_ dir: FileManager.SearchPathDirectory, _ test: String) -> URL {
    if !testDir.isEmpty {
      let u = URL(fileURLWithPath: testDir).appendingPathComponent(test)
      try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
      return u
    }
    return FileManager.default.urls(for: dir, in: .userDomainMask)[0]
  }
  var downloadsDir: URL { known(.downloadsDirectory, "Downloads") }
  var documentsDir: URL { known(.documentDirectory, "Documents") }
  var autoOn: Bool { d.bool(forKey: "save.docsAutoOn") }
  func autoDir(create: Bool) -> URL {
    let s = d.string(forKey: "save.docsAutoDir") ?? ""
    let u = s.isEmpty ? documentsDir.appendingPathComponent("Sara") : URL(fileURLWithPath: s)
    if create { try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true) }
    return u
  }
  /// "Downloads", "Documents", "Desktop" by their own names; another folder as "parent/name" (never the user's name).
  func folderLabel(_ dir: URL) -> String {
    let p = dir.standardizedFileURL.path
    let desktop = FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask)[0].path
    if [downloadsDir.path, documentsDir.path, desktop].contains(p) { return dir.lastPathComponent }
    let parent = dir.deletingLastPathComponent().lastPathComponent
    return parent.isEmpty || parent == "/" ? dir.lastPathComponent : "\(parent)/\(dir.lastPathComponent)"
  }
  func settings() -> [String: Any] { ["docsAuto": autoOn, "docsAutoLabel": autoOn ? folderLabel(autoDir(create: false)) : ""] }
  func prefs() -> [String: Any] { var s = settings(); s["saveFiles"] = true; return s }

  // MARK: the bridge (saveFile, saveOpen, saveSettings)
  func call(_ kind: String, _ body: [String: Any], web: WKWebView?, server: String?, window: NSWindow?, reply: @escaping (Any?, String?) -> Void) {
    switch kind {
    case "saveFile":
      let path = body["url"] as? String ?? "", mode = body["mode"] as? String ?? ""
      guard SaveFiles.urlOk(path), ["ask", "downloads", "auto"].contains(mode), let web, let server, let url = URL(string: server + path) else { return reply(nil, "That file can't be saved from here.") }
      if mode == "auto" && !autoOn { return reply(["cancelled": true], nil) }
      let name = SaveFiles.cleanName(body["name"] as? String ?? "")
      let start = { (dest: URL) in
        // SaveFiles.shared lives as long as the app.
        web.startDownload(using: URLRequest(url: url)) { dl in
          dl.delegate = self
          self.intents[ObjectIdentifier(dl)] = Intent(name: name, path: dest, reply: reply)
        }
      }
      if mode == "ask" {
        let panel = NSSavePanel()
        panel.title = "Save to"
        panel.nameFieldStringValue = name
        let last = d.string(forKey: "save.lastDir") ?? ""
        var isDir: ObjCBool = false
        panel.directoryURL = !last.isEmpty && FileManager.default.fileExists(atPath: last, isDirectory: &isDir) && isDir.boolValue ? URL(fileURLWithPath: last) : documentsDir
        let done = { (r: NSApplication.ModalResponse) in
          guard r == .OK, let dest = panel.url else { return reply(["cancelled": true], nil) }
          self.d.set(dest.deletingLastPathComponent().path, forKey: "save.lastDir")
          start(dest)
        }
        if let window, window.isVisible { panel.beginSheetModal(for: window, completionHandler: done) } else { done(panel.runModal()) }
      } else {
        start(SaveFiles.uniquePath(mode == "downloads" ? downloadsDir : autoDir(create: true), name))
      }
    case "saveOpen":
      guard let p = saved[body["token"] as? String ?? ""], FileManager.default.fileExists(atPath: p) else { return reply(nil, "That file isn't there any more.") }
      if body["how"] as? String == "folder" { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)]) } else { NSWorkspace.shared.open(URL(fileURLWithPath: p)) }
      reply(true, nil)
    case "saveSettings":
      if body["pick"] as? String == "1" {
        let p = NSOpenPanel()
        p.title = "Choose the folder for her documents"
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.canCreateDirectories = true
        p.directoryURL = autoDir(create: false)
        if p.runModal() == .OK, let u = p.url {
          d.set(u.path, forKey: "save.docsAutoDir")
          d.set(true, forKey: "save.docsAutoOn")
        }
      } else if body["auto"] as? String == "1" {
        _ = autoDir(create: true)
        d.set(true, forKey: "save.docsAutoOn")
      } else if body["auto"] as? String == "0" {
        d.set(false, forKey: "save.docsAutoOn")
      }
      reply(settings(), nil)
    default: reply(nil, "Unknown request")
    }
  }

  // MARK: WKDownloadDelegate: the place was picked before the download started
  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    guard let i = intents[ObjectIdentifier(download)] else { return completionHandler(nil) }
    if let r = response as? HTTPURLResponse, r.statusCode != 200 {
      intents[ObjectIdentifier(download)] = nil
      i.reply(["ok": false], nil)
      return completionHandler(nil)
    }
    // "Replace" in the Save panel: the old file goes (WebKit never overwrites).
    try? FileManager.default.removeItem(at: i.path)
    completionHandler(i.path)
  }
  func downloadDidFinish(_ download: WKDownload) {
    guard let i = intents.removeValue(forKey: ObjectIdentifier(download)) else { return }
    let token = String(next)
    next += 1
    saved[token] = i.path.path
    NSLog("Sara save: saved %@", i.path.lastPathComponent)
    i.reply(["ok": true, "name": i.path.lastPathComponent, "folder": folderLabel(i.path.deletingLastPathComponent()), "token": token], nil)
  }
  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    guard let i = intents.removeValue(forKey: ObjectIdentifier(download)) else { return }
    NSLog("Sara save: failed: %@", error.localizedDescription)
    i.reply(["ok": false], nil)
  }
}
