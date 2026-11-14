// N5 (Mac parity): the app's side of the new abilities: the switches in Settings → Computer use (Files and
// which folders, commands, "Let Sara see my tabs"), save to this Mac, and the app's own updates (the page's
// banner and This computer row, the menu bar's "Update Sara app", the check-in's version and system).
import AppKit
import WebKit

enum N5Pref { case notMine, ok, error(String) }

extension AppDelegate {
  private var sidKey: String { "hands.\(Servers.activeId ?? "")" }

  // MARK: Settings → Computer use
  func n5SetPref(_ key: String, _ body: [String: Any]) -> N5Pref {
    let on = body["value"] as? Bool ?? false
    switch key {
    case "handsFiles":
      // "Files" (read only; the page showed its explainer first).
      prefs.set(on, forKey: "\(sidKey).files")
      Hands.shared?.tellFiles(on)
    case "handsFilesScope":
      let v = body["value"] as? String ?? ""
      guard HandsFiles.scopes.contains(v) else { return .error("Invalid folder choice") }
      if v == "home" || v == "drives" {
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = "Files: which folders"
        a.informativeText = v == "drives"
          ? "Sara may list and read files on all of this Mac's own disks (read only: she never changes, moves or deletes anything). System folders, Library, other people's folders, hidden files and places that hold keys or passwords stay out. Allow this on this Mac?"
          : "Sara may list and read files anywhere in your home folder (read only: she never changes, moves or deletes anything). Library, hidden folders and places that hold keys or passwords stay out. Allow this on this Mac?"
        a.addButton(withTitle: "Don't")
        a.addButton(withTitle: "Allow")
        guard a.runModal() == .alertSecondButtonReturn else { return .error("Cancelled") }
      }
      prefs.set(v, forKey: "\(sidKey).filesScope")
      n5FilesSync()
    case "handsRun", "handsRunReadOnly":
      // "Let her run commands on this computer" and "Simple read-only commands without asking" (both off by default).
      prefs.set(on, forKey: "\(sidKey).\(key == "handsRun" ? "run" : "runReadOnly")")
      n5RunSync()
    case "handsRunLevel":
      let v = body["value"] as? String ?? ""
      guard ["ask", "task", "always"].contains(v) else { return .error("Invalid command approval level") }
      if v == "always" {
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = "Commands: Always allowed"
        a.informativeText = "Sara may run commands on this Mac without approval cards. Commands that delete, change settings or download and run things still ask. Nothing runs as administrator. Stop always works. Allow this on this Mac?"
        a.addButton(withTitle: "Don't")
        a.addButton(withTitle: "Allow")
        guard a.runModal() == .alertSecondButtonReturn else { return .error("Not allowed on this computer") }
      }
      prefs.set(v, forKey: "\(sidKey).runLevel")
      n5RunSync()
    case "handsTabs":
      // "Let Sara see my tabs": macOS asks once per browser (Automation); say so before it does.
      if on {
        let a = NSAlert()
        a.messageText = "Let Sara see your browser tabs?"
        a.informativeText = "Sara may list the tabs open in your Safari, Chrome, Edge, Brave or Arc windows (titles and addresses only, never the pages) and, when you allow it here, bring one to the front. Banking and password-manager tabs stay hidden.\n\nThe first time, macOS asks \"Sara wants access to control Safari\" (or the other browser): choose Allow. You can change it later in System Settings → Privacy & Security → Automation."
        a.addButton(withTitle: "Turn on")
        a.addButton(withTitle: "Not now")
        guard a.runModal() == .alertFirstButtonReturn else { return .error("Cancelled") }
      }
      prefs.set(on, forKey: "\(sidKey).tabs")
      Hands.shared?.tellTabs(on)
      // macOS's own question for each open browser now, while the person is here (not later, during a task).
      if on {
        DispatchQueue.main.async {
          for b in HandsTabs.browsers where HandsTabs.running(b).app != nil { _ = HandsTabs.runScript("tell application id \"\(b.bundle)\" to count windows") }
        }
      }
    default: return .notMine
    }
    return .ok
  }

  func n5FilesSync() {
    HandsFiles.setRoots(scope: prefs.string(forKey: "\(sidKey).filesScope") ?? "three", picked: prefs.stringArray(forKey: "\(sidKey).filesFolders") ?? [])
    Hands.shared?.tellOptIn()
  }
  func n5RunSync() {
    Hands.shared?.tellRun(on: prefs.bool(forKey: "\(sidKey).run"), level: prefs.string(forKey: "\(sidKey).runLevel") ?? "task", readOnly: prefs.bool(forKey: "\(sidKey).runReadOnly"))
  }
  /// The new hands' switches from this server's preferences (handsSync).
  func n5Configure(_ h: Hands) {
    #if DEBUG
    let env = ProcessInfo.processInfo.environment
    if Bundle.main.bundleIdentifier != "com.backstagecoding.sara.desktop" {
      if let t = env["SARA_FILES_TEST_ROOT"] { HandsFiles.setTestRoot(t) }
      // Test copies may start with the new switches on (the person's switches in the real app).
      for (e, k) in [("SARA_TEST_HANDS_FILES", "files"), ("SARA_TEST_HANDS_RUN", "run"), ("SARA_TEST_HANDS_TABS", "tabs")] where env[e] == "1" { prefs.set(true, forKey: "\(sidKey).\(k)") }
    }
    #endif
    HandsFiles.setRoots(scope: prefs.string(forKey: "\(sidKey).filesScope") ?? "three", picked: prefs.stringArray(forKey: "\(sidKey).filesFolders") ?? [])
    h.files = prefs.bool(forKey: "\(sidKey).files")
    h.tabsOn = prefs.bool(forKey: "\(sidKey).tabs")
    h.runner.test = handsTestLabel
    h.runner.configure(on: prefs.bool(forKey: "\(sidKey).run"), level: prefs.string(forKey: "\(sidKey).runLevel") ?? "task", readOnly: prefs.bool(forKey: "\(sidKey).runReadOnly"))
  }

  func n5Prefs(_ d: inout [String: Any]) {
    d["handsFilesSupported"] = true
    d["handsFiles"] = prefs.bool(forKey: "\(sidKey).files")
    d["handsFilesScopeSupported"] = true
    d["handsFilesScope"] = prefs.string(forKey: "\(sidKey).filesScope") ?? "three"
    d["handsFilesFolders"] = (prefs.stringArray(forKey: "\(sidKey).filesFolders") ?? []).map { URL(fileURLWithPath: $0).lastPathComponent }
    d["handsRunSupported"] = true
    d["handsRun"] = prefs.bool(forKey: "\(sidKey).run")
    d["handsRunLevel"] = prefs.string(forKey: "\(sidKey).runLevel") ?? "task"
    d["handsRunReadOnly"] = prefs.bool(forKey: "\(sidKey).runReadOnly")
    d["handsRunShell"] = "zsh"
    d["handsTabsSupported"] = true
    d["handsTabs"] = prefs.bool(forKey: "\(sidKey).tabs")
    for (k, v) in SaveFiles.shared.prefs() { d[k] = v }
    // The app's own updates and the check-in's computer and system (Settings → Devices).
    d["appUpdate"] = AppUpdater.shared.status()
    d["computer"] = Host.current().localizedName ?? "Mac"
    let os = ProcessInfo.processInfo.operatingSystemVersion
    d["os"] = "macOS \(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
  }

  /// Bridge calls of N5; false when the kind isn't one of them.
  func n5Call(_ kind: String, _ body: [String: Any], _ reply: @escaping (Any?, String?) -> Void) -> Bool {
    switch kind {
    case "filesAddFolder":
      let p = NSOpenPanel()
      p.title = "Choose a folder Sara may read (read only)"
      p.canChooseDirectories = true
      p.canChooseFiles = false
      guard p.runModal() == .OK, let u = p.url else { reply(["cancelled": true], nil); return true }
      if let why = HandsFiles.pickable(u.path) { reply(nil, why); return true }
      var list = prefs.stringArray(forKey: "\(sidKey).filesFolders") ?? []
      if !list.contains(where: { $0.lowercased() == u.path.lowercased() }) {
        guard list.count < 20 else { reply(nil, "At most 20 folders."); return true }
        list.append(u.path)
        prefs.set(list, forKey: "\(sidKey).filesFolders")
      }
      n5FilesSync()
      reply(prefsDict(), nil)
    case "filesRemoveFolder":
      var list = prefs.stringArray(forKey: "\(sidKey).filesFolders") ?? []
      let i = Int(body["index"] as? String ?? "") ?? (body["index"] as? Int ?? -1)
      if i >= 0 && i < list.count { list.remove(at: i) }
      prefs.set(list, forKey: "\(sidKey).filesFolders")
      n5FilesSync()
      reply(prefsDict(), nil)
    case "saveFile", "saveOpen", "saveSettings":
      SaveFiles.shared.call(kind, body, web: web, server: server, window: window, reply: reply)
    case "appUpdate":
      let u = AppUpdater.shared
      switch body["do"] as? String ?? "" {
      case "check": u.check(force: true)
      case "install":
        if u.isReady {
          let why = u.install(relaunch: true, background: !window.isVisible)
          if why.isEmpty { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.quitting = true; NSApp.terminate(nil) } } else { reply(nil, why); return true }
        } else { u.wantInstall() }
      case "later": u.later()
      case "auto": u.setAuto(body["value"] as? Bool ?? true)
      case "server": u.serverVersion(body["version"] as? String ?? "")
      default: break
      }
      reply(u.status(), nil)
    default: return false
    }
    return true
  }

  // MARK: the app's own updates
  func n5StartUpdates() {
    let u = AppUpdater.shared
    // Sara's server on this Mac brings the new app with her (Settings → Updates); a copy that can't
    // replace itself (a disk image, a read-only folder, App Translocation) only says where to get it.
    let bundle = Bundle.main.bundlePath
    let parent = (bundle as NSString).deletingLastPathComponent
    let movable = !bundle.hasPrefix("/Volumes/") && !bundle.contains("/AppTranslocation/") && FileManager.default.isWritableFile(atPath: parent) && bundle.hasSuffix(".app")
    u.configure(how: local.configured ? "server" : movable ? "remote" : "manual")
    u.onChange = { [weak self] in self?.n5UpdateChanged() }
    if let r = u.takeResult() { postNotification(title: r.ok ? "Sara is updated" : "The Sara app wasn't updated", body: r.text, conv: "") }
    // A quiet moment: the window closed to the menu bar and nobody used the Mac for 20 minutes, never while she uses it.
    Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
      guard let self, u.mayInstallByItself, !self.window.isVisible, Hands.shared?.busy != true else { return }
      let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
      guard idle > 20 * 60 else { return }
      if u.install(relaunch: true, background: true).isEmpty { self.quitting = true; NSApp.terminate(nil) }
    }
  }
  func n5UpdateChanged() {
    let st = AppUpdater.shared.status()
    if let data = try? JSONSerialization.data(withJSONObject: st), let json = String(data: data, encoding: .utf8), isServer(web.url) {
      web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('sara-app-update',{detail:\(json)}))")
    }
  }
  /// Quitting with a checked new app ready (and the switch on): it is installed as the app closes.
  func n5InstallOnQuit() {
    let u = AppUpdater.shared
    if u.mayInstallByItself { _ = u.install(relaunch: false, background: false) }
  }
  @objc func updateAppFromMenu() {
    let u = AppUpdater.shared
    if u.isReady {
      let why = u.install(relaunch: true, background: false)
      if why.isEmpty { quitting = true; NSApp.terminate(nil) } else { alert("The Sara app wasn't updated", why) }
      return
    }
    u.wantInstall()
    let st = u.status()
    let state = st["state"] as? String ?? ""
    if u.how != "remote" || state == "current" || state == "failed" {
      alert(state == "current" ? "The Sara app is up to date" : "Update Sara app", (st["message"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Checking for a new app…")
    } else {
      postNotification(title: "Update Sara app", body: "Checking for a new app. It is installed when it's downloaded and checked.", conv: "")
    }
  }
  /// The menu bar's "Update Sara app" item says what's there.
  var updateMenuTitle: String {
    let st = AppUpdater.shared.status()
    let latest = st["latest"] as? String ?? ""
    switch st["state"] as? String ?? "" {
    case "ready": return "Update Sara app to \(latest)"
    case "downloading": return "Downloading Sara app \(latest)…"
    case "installing": return "Installing Sara app \(latest)…"
    default: return "Update Sara app"
    }
  }
}
