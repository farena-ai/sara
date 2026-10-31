// Sara for Mac (Phase 33): a native window around the owner's own Sara server, using the system's
// WebKit. Menu bar icon (keeps running when the window is closed), notifications, open at login,
// microphone for calls, first-run setup (server address, then the server's own /pair page for the
// sign-in code). No credentials are stored here: the sign-in is the server's session cookie, kept in
// the app's own WebKit storage.
// Phase 46d: the app also carries Sara's server and sets it up on this Mac (Setup.swift,
// Server.swift); `Sara --run-server` is launchd's supervisor and `Sara --cli …` the `sara` command.
// Phase 55: the first launch asks "Run Sara on this Mac" or "Connect to a Sara somewhere else"; the
// menu switches both ways later, and an unreachable server shows "Can't reach your Sara".
// Phase 68: several Sara servers, each with its own sign-in (Servers.swift).
// Phase 75: the new look's window (Shell.swift): the page drawn under a transparent title bar with
// the traffic lights inset into its header, dark or light following the page's theme, optional
// vibrancy, and the theme colour from the first frame (no white flash).
// Phase 75 stage 2 (QuickAsk.swift): a global shortcut (⌥⇧S) for a floating quick-ask panel, her
// face, mood and "Now" (jobs, approvals with Allow / Deny) at the top of the menu bar menu, her mood
// in the menu bar icon's tooltip.
// Phase 75 stage 3 (Notify.swift): notifications with buttons for approvals (Allow / Deny / Open) and
// reminders (Done / Snooze 10 min), files dropped on the Dock icon go into the message box.
import AppKit
import ServiceManagement
import UserNotifications
import WebKit

let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.33.0"
let prefs = UserDefaults.standard

/// Reached without HTTPS when no scheme is typed: localhost, *.local and IP addresses (a home
/// network, Tailscale's 100.x addresses). The same rule as the Windows app and installer.
func plainHTTPHost(_ hostPort: String) -> Bool {
  if hostPort.hasPrefix("[") { return true }
  let name = hostPort.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
  if name == "localhost" || (name.count > 6 && name.hasSuffix(".local")) { return true }
  let parts = name.split(separator: ".", omittingEmptySubsequences: false)
  return parts.count == 4 && parts.allSatisfy { p in !p.isEmpty && p.count <= 3 && p.allSatisfy(\.isASCII) && p.allSatisfy(\.isNumber) && (Int(p) ?? 999) <= 255 }
}

/// "https://host:port/anything" → "https://host:port"; nil if it isn't an http(s) address.
/// Without a scheme: https, except for plainHTTPHost addresses.
func originOf(_ raw: String) -> String? {
  var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  if !s.contains("://") {
    let host = String(s.prefix { $0 != "/" && $0 != "?" && $0 != "#" }).lowercased()
    s = (plainHTTPHost(host) ? "http://" : "https://") + s
  }
  guard let u = URLComponents(string: s), let scheme = u.scheme?.lowercased(), scheme == "https" || scheme == "http",
        let host = u.host?.lowercased(), !host.isEmpty, u.user == nil else { return nil }
  return "\(scheme)://\(host)" + (u.port.map { ":\($0)" } ?? "")
}

func htmlEscape(_ s: String) -> String {
  s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
    .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "'", with: "&#39;").replacingOccurrences(of: "\"", with: "&quot;")
}

/// The app's own pages (choose, connect, can't reach, starting): the new look's tokens
/// (docs/design/NEW_LOOK.md, web/theme.css), Night or Day as the page last said (Shell.swift adds
/// the theme and tells the window these pages draw the title strip). The same look as the Windows
/// app's pages.
let pageCSS = """
<meta name=viewport content='width=device-width'><style>
:root{--bg:#0f0d17;--panel:#17141f;--panel-2:#1e1a29;--text:#eee9f3;--muted:#a9a0b8;--accent:#f08aa5;--grad:linear-gradient(135deg,#e0607e,#9b6bff);--border:rgba(255,255,255,.08);--border-2:rgba(255,255,255,.16);--error:#ff6b7d;--on-accent:#160c14;--glow:0 0 0 1px rgba(224,96,126,.18),0 18px 50px rgba(155,107,255,.14);color-scheme:dark}
html.day{--bg:#faf7f5;--panel:#ffffff;--panel-2:#f6eff2;--text:#241c2b;--muted:#665d70;--accent:#b8436a;--border:rgba(36,28,43,.10);--border-2:rgba(36,28,43,.22);--error:#c0303a;--glow:0 12px 40px rgba(60,30,60,.10);color-scheme:light}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,system-ui,sans-serif;display:grid;place-items:center;padding:24px;-webkit-user-select:none;user-select:none}
.c{width:100%;max-width:440px;background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:30px 30px 26px;box-shadow:var(--glow)}
.logo{display:block;width:64px;height:64px;border-radius:50%;margin:0 0 18px;background:var(--panel-2);box-shadow:0 0 0 2px rgba(240,138,165,.35),0 0 24px rgba(155,107,255,.35)}
h1{font-size:22px;line-height:1.25;margin:0 0 8px;font-weight:600;letter-spacing:-.01em}
p{color:var(--muted);margin:0 0 12px}b{color:var(--text);font-weight:600}
label{display:block;font-weight:600;font-size:14px;margin:18px 0 6px}
input{width:100%;font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);-webkit-user-select:text;user-select:text}
input:focus{outline:2px solid var(--accent);outline-offset:-1px}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
button{font:inherit;font-weight:600;padding:9px 18px;min-height:40px;border:0;border-radius:10px;background:var(--grad);color:var(--on-accent);cursor:pointer;transition:filter .15s ease-out}
button:hover{filter:brightness(1.08)}button:focus-visible{outline:2px solid var(--text);outline-offset:2px}
button.g{background:transparent;color:var(--text);border:1px solid var(--border-2);font-weight:500}button.g:hover{border-color:var(--accent);filter:none}
button.choice{display:block;width:100%;text-align:left;margin:12px 0 0;padding:16px 18px;border-radius:12px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);font-size:16px}
button.choice:hover{border-color:var(--accent);background:var(--panel-2);filter:none}button.choice span{display:block;font-weight:400;font-size:13px;color:var(--muted);margin-top:4px}
.e{color:var(--error);font-size:14px;margin:8px 0 0}.e:empty{display:none}
.small{font-size:13px}.sep{border-top:1px solid var(--border);margin:22px 0 0;padding-top:14px}.sep p{margin:0 0 8px}
@media (prefers-reduced-motion:reduce){button{transition:none}}
</style>
"""

/// The style plus the theme the page last said and the note that these pages draw the title strip.
var pageStyle: String { pageCSS + Shell.localPageScript }

/// Her picture at the top of these pages (PageLogo.swift is made by scripts/make-app-icons.py).
let pageLogo = "<img class=logo alt='' src='\(pageLogoDataURL)'>"

/// A page that only says what's happening ("Starting Sara…").
func statusPage(_ title: String, _ text: String = "") -> String {
  "<!doctype html><html><head>\(pageStyle)</head><body><div class=c>\(pageLogo)<h1>\(htmlEscape(title))</h1>" + (text.isEmpty ? "" : "<p>\(htmlEscape(text))</p>") + "</div></body></html>"
}

/// The page side of window.SaraDesktop. call() returns a promise (WebKit replies to the message).
let shim = """
(() => {
  if (window.SaraDesktop || !window.webkit || !webkit.messageHandlers.sara) return;
  const post = (o) => webkit.messageHandlers.sara.postMessage(o);
  window.SaraDesktop = {
    platform: 'mac',
    call(m, a = {}) { return post({ m, ...a }); },
    notify(title, body, conv) { post({ m: 'notify', title: String(title || ''), body: String(body || ''), conv: String(conv || '') }).catch(() => {}); },
    attention(kind) { post({ m: 'attention', kind: String(kind || '') }).catch(() => {}); },
  };
})();
"""

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
  WKScriptMessageHandlerWithReply, UNUserNotificationCenterDelegate, WKDownloadDelegate {
  var window: NSWindow!
  var web: WKWebView!
  var statusItem: NSStatusItem!
  var server: String? { prefs.string(forKey: "server").flatMap { $0.isEmpty ? nil : $0 } }
  var quitting = false
  let local = LocalServer()
  var setupSheet: SetupSheet?
  var serverState = "Checking…"
  /// Menu items whose submenu is rebuilt each time it opens (Your Saras, Sara on this Mac).
  var liveSubmenus: [(item: NSMenuItem, make: () -> NSMenu)] = []
  /// Phase 68: the saved server the web view's data store belongs to, and one being removed.
  var webServerId: String?
  var pendingRemove: String?
  /// Phase 75 (Shell.swift): the window's content (web view, optional vibrancy), whether the page
  /// draws the title strip (and for which place), the last press for moving the window.
  var chromeRoot: NSView?
  var vibrancyView: NSVisualEffectView?
  var pageDrawsTitlebar = false
  var pageTitleOrigin = ""
  var lastMouseDown: NSEvent?
  var mouseDownMonitor: Any?
  /// Phase 75 stage 2: the quick-ask panel, its shortcut and "Now" (QuickAsk.swift).
  var quick: QuickAsk?
  /// Phase 75 stage 3: the notifications this app showed, and files waiting for her page (Notify.swift).
  let notes = NativeNotes()

  // MARK: start-up
  /// The web view, on the data store of the server it shows (Phase 68: one store per server).
  func makeWebView(store: WKWebsiteDataStore, for id: String?) {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = store
    config.applicationNameForUserAgent = "Version/18.0 Safari/605.1.15 SaraDesktop/1 (Mac)"
    config.mediaTypesRequiringUserActionForPlayback = []
    config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "sara")
    config.userContentController.addUserScript(WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    // Phase 75: window.saraShell and <html class="shell-mac"> before any page script (Shell.swift).
    config.userContentController.addUserScript(WKUserScript(source: shellScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let old = web
    if let old {
      old.stopLoading()
      old.configuration.userContentController.removeAllScriptMessageHandlers()
    }
    web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.setValue(false, forKey: "drawsBackground")
    web.allowsBackForwardNavigationGestures = true
    if let z = prefs.object(forKey: "zoom") as? Double { web.pageZoom = z }
    webServerId = id
    attachWebView(old: old)
    // Phase 75 stage 2: the quick-ask page follows the server in use (same data store).
    quick?.reset()
  }

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()
    let frame = NSRect(x: 0, y: 0, width: 1100, height: 780)
    window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    window.title = "Sara"
    window.titlebarAppearsTransparent = true
    window.minSize = NSSize(width: 380, height: 500)
    window.delegate = self
    window.isReleasedWhenClosed = false
    window.center()
    window.setFrameAutosaveName("SaraMain")
    // Phase 75: the theme colour, appearance and title bar before anything is shown (Shell.swift).
    setUpWindowChrome()
    // Phase 68: the saved servers (the one from before 1.8 becomes the first, as it was).
    let current = Servers.active
    makeWebView(store: Servers.dataStore(current), for: current?.id)

    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    if let img = NSImage(systemSymbolName: "heart.circle", accessibilityDescription: "Sara") {
      img.isTemplate = true
      statusItem.button?.image = img
    } else { statusItem.button?.title = "S" }
    statusItem.button?.toolTip = current.map { "Sara · \($0.name)" } ?? "Sara"
    // Phase 75 stage 2: the quick-ask shortcut (a clash is said once per start) and its page.
    quick = QuickAsk(app: self)
    quick?.registerShortcut(tell: true)
    quick?.ensure()
    statusItem.menu = statusMenu()
    handsSync()  // Phase 87: Sara's hands, if this Mac lets her

    UNUserNotificationCenter.current().delegate = self
    // Phase 75 stage 3: the kinds with buttons; permission is asked the first time there's something to show.
    registerNoteCategories()

    let background = ProcessInfo.processInfo.arguments.contains("--background")
      || (NSAppleEventManager.shared().currentAppleEvent?.paramDescriptor(forKeyword: keyAELaunchedAsLogInItem) != nil)
    if !background { showWindow() }
    let migrating = migrateFromDaemonIfNeeded()
    let upgrading = migrating ? false : checkUpgrade()
    refreshServerState()
    Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.refreshServerState() }
    #if DEBUG
    runQuickTest()
    if let t = ProcessInfo.processInfo.environment["SARA_TEST_SETUP"], server == nil, !local.configured {
      // Test builds: "agent,local,7861" sets up without the sheet (no screen over SSH; the first
      // field is the old run mode and is ignored: she always runs while you're signed in).
      let p = t.split(separator: ",").map(String.init)
      let access = Access(rawValue: p.count > 1 ? p[1] : "") ?? .local
      let port = p.count > 2 ? Int(p[2]) ?? defaultPort : defaultPort
      DispatchQueue.global().async {
        let o = self.local.setUp(access: access, port: port)
        testLog("setup ok=\(o.ok) approval=\(o.needsApproval) notes=\(o.notes)")
        DispatchQueue.main.async { if o.needsApproval { self.askForApproval(notes: o.notes, changing: false) } else { self.waitForServer(notes: [], changing: false) } }
      }
      return
    }
    #endif
    if migrating { return }  // it opens her page when done
    if upgrading { return waitForUpgrade { [weak self] in self?.server == nil ? self?.startFirstRun() : self?.openServer() } }
    if server == nil { startFirstRun() } else { openServer() }
  }

  /// Phase 55: "from startup" (the LaunchDaemon) is gone; a Mac that used it moves to the agent.
  /// Returns true when it started (it then opens her page itself).
  func migrateFromDaemonIfNeeded() -> Bool {
    guard local.configured, local.readEnv()["SARA_MAC_RUN"] == "daemon" else { return false }
    web.loadHTMLString(statusPage("Updating Sara…", "She now runs while you're signed in to this Mac."), baseURL: nil)
    DispatchQueue.global().async { [weak self] in
      guard let self else { return }
      let o = self.local.migrateFromDaemon() ?? LocalServer.Outcome()
      DispatchQueue.main.async {
        if o.needsApproval { return self.askForApproval(notes: o.notes, changing: true) }
        if !o.ok { self.alert("Sara couldn't move to the new way of running", o.notes.joined(separator: "\n\n")) }
        if self.server == nil { self.startFirstRun() } else if self.isLocalServer { self.waitForServer(notes: o.notes, changing: true) } else { self.openServer() }
      }
    }
    return true
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    showWindow()
    return true
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { .terminateNow }

  func showWindow() {
    NSApp.setActivationPolicy(.regular)
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  // Closing the window keeps her running in the menu bar (unless that's turned off).
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    if quitting || !keepRunning { NSApp.terminate(nil); return true }
    window.orderOut(nil)
    NSApp.setActivationPolicy(.accessory)
    if !prefs.bool(forKey: "toldMenuBar") {
      prefs.set(true, forKey: "toldMenuBar")
      postNotification(title: "Sara is still here", body: "She keeps running in the menu bar so she can reach you. Click her icon there to quit.", conv: "")
    }
    return false
  }

  var keepRunning: Bool { prefs.object(forKey: "keepRunning") as? Bool ?? true }
  var notificationsOn: Bool { prefs.object(forKey: "notifications") as? Bool ?? true }
  var startAtLogin: Bool { SMAppService.mainApp.status == .enabled }

  // MARK: menus
  // The menu bar menu and the Sara menu list the same things in the same order as the Windows
  // tray menu: Open Sara · Settings… | Your Saras ▸ · Sara on this Mac ▸ | Open at Login · Help | Quit.

  /// "Your Saras ▸" and, when the app carries her server, "Sara on this Mac ▸".
  func addSubmenus(to m: NSMenu) {
    let saras = NSMenuItem(title: "Your Saras", action: nil, keyEquivalent: "")
    saras.submenu = sarasMenu()
    liveSubmenus.append((item: saras, make: { [unowned self] in self.sarasMenu() }))
    m.addItem(saras)
    if local.hasBundledServer || local.configured {
      let mac = NSMenuItem(title: "Sara on this Mac", action: nil, keyEquivalent: "")
      mac.submenu = thisMacMenu()
      liveSubmenus.append((item: mac, make: { [unowned self] in self.thisMacMenu() }))
      m.addItem(mac)
    }
  }

  func buildMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "About Sara", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
    appMenu.addItem(.separator())
    addSubmenus(to: appMenu)
    appMenu.delegate = self
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Hide Sara", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let others = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    others.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Quit Sara", action: #selector(quit), keyEquivalent: "q")
    appItem.submenu = appMenu
    main.addItem(appItem)
    let editItem = NSMenuItem()
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    main.addItem(editItem)
    let viewItem = NSMenuItem()
    let view = NSMenu(title: "View")
    view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
    view.addItem(.separator())
    view.addItem(withTitle: "Actual Size", action: #selector(zoomReset), keyEquivalent: "0")
    view.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
    view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
    viewItem.submenu = view
    main.addItem(viewItem)
    let winItem = NSMenuItem()
    let win = NSMenu(title: "Window")
    win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    win.addItem(.separator())
    win.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
    winItem.submenu = win
    main.addItem(winItem)
    let helpItem = NSMenuItem()
    let help = NSMenu(title: "Help")
    help.addItem(withTitle: "Sara Help", action: #selector(openHelp), keyEquivalent: "?")
    helpItem.submenu = help
    main.addItem(helpItem)
    NSApp.mainMenu = main
    NSApp.windowsMenu = win
    NSApp.helpMenu = help
  }

  func statusMenu() -> NSMenu {
    let m = NSMenu()
    m.addItem(withTitle: "Open Sara", action: #selector(openFromMenu), keyEquivalent: "")
    m.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: "")
    // Phase 87/88: the hands items (status, Stop, Resume, the log, off) are put in each time the
    // menu opens (refreshHandsItems), so they follow the setting without a restart.
    m.addItem(.separator())
    addSubmenus(to: m)
    m.addItem(.separator())
    m.addItem(withTitle: "Open at login", action: #selector(toggleLogin), keyEquivalent: "")
    // Phase 75 stage 2: the quick-ask shortcut (her face, mood, Ask and "Now" are put at the top
    // each time the menu opens: refreshNowItems in QuickAsk.swift).
    let keys = NSMenuItem(title: "Quick ask shortcut", action: nil, keyEquivalent: "")
    keys.submenu = shortcutMenu()
    liveSubmenus.append((item: keys, make: { [unowned self] in self.shortcutMenu() }))
    m.addItem(keys)
    m.addItem(withTitle: "Help", action: #selector(openHelp), keyEquivalent: "")
    m.addItem(.separator())
    m.addItem(withTitle: "Quit Sara", action: #selector(quit), keyEquivalent: "")
    m.delegate = self
    return m
  }

  /// Settings… and Help: that view of the web app (its #view= links), in the window.
  func openView(_ view: String) {
    showWindow()
    guard server != nil else { return }
    if isServer(web.url) {
      // replaceState first: setting the hash it already has wouldn't open the view again.
      web.evaluateJavaScript("history.replaceState(null,'',location.pathname);location.hash='view=\(view)'")
    } else { openServer("/#view=\(view)") }
  }
  @objc func openSettings() { openView("settings") }
  @objc func openHelp() { openView("help") }

  // View → Zoom In / Out / Actual Size (remembered).
  func setZoom(_ z: Double) {
    let v = min(2.0, max(0.6, (z * 10).rounded() / 10))
    prefs.set(v, forKey: "zoom")
    web.pageZoom = v
  }
  @objc func zoomIn() { setZoom(web.pageZoom + 0.1) }
  @objc func zoomOut() { setZoom(web.pageZoom - 0.1) }
  @objc func zoomReset() { setZoom(1) }

  @objc func openFromMenu() { showWindow() }
  @objc func reload() {
    if server == nil { showSetup() } else { web.reload() }
  }
  @objc func toggleLogin() { setStartAtLogin(!startAtLogin) }
  @objc func quit() {
    quitting = true
    NSApp.terminate(nil)
  }
  /// Phase 87: the hands connection and the Sara browser close with the app.
  func applicationWillTerminate(_ note: Notification) {
    let h = Hands.shared
    Hands.shared = nil
    h?.stop()
    h?.browser.close()
  }

  func setStartAtLogin(_ on: Bool) {
    do { if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } } catch { NSLog("Sara login item: \(error)") }
  }

  // MARK: pages
  func openServer(_ path: String = "/") {
    guard let s = server, let url = URL(string: s + path) else { return showSetup() }
    web.load(URLRequest(url: url))
  }

  func showSetup(_ error: String = "", typed: String = "") {
    // Phase 68: with a Sara already here, this page adds another one; Back returns to her.
    let here = Servers.active
    let value = htmlEscape(!typed.isEmpty ? typed : here == nil ? prefs.string(forKey: "lastServer") ?? "" : "")
    let back = here.map { "<button class=g id=k>Back to \(htmlEscape($0.name))</button>" } ?? ""
    let html = """
    <!doctype html><html><head>\(pageStyle)</head><body><div class=c>\(pageLogo)<h1>\(here == nil ? "Connect to your Sara" : "Add a Sara")</h1>
    <p>\(here == nil ? "Type the address you open Sara at in a web browser." : "Type the address of another Sara. Your other Saras stay signed in.")</p>
    <label for=u>Address</label><input id=u autofocus spellcheck=false placeholder='sara.example.com' value='\(value)'><p class=e id=e role=alert>\(htmlEscape(error))</p>
    <div class=row><button id=b>Continue</button>\(back)</div>
    <div class=sep><p class=small>Next you sign in with a code: on a device where you're signed in, open Settings → Data &amp; health → Devices and sign-in → <b>Add a phone or computer</b>.</p>\(local.hasBundledServer ? "<button class=g id=l>Run Sara on this Mac instead</button>" : "")</div></div><script>
    const $=(i)=>document.getElementById(i);
    const k=$('k');if(k)k.onclick=()=>webkit.messageHandlers.sara.postMessage({m:'retry'});
    const l=$('l');if(l)l.onclick=()=>webkit.messageHandlers.sara.postMessage({m:'setupLocal'});
    const go=()=>webkit.messageHandlers.sara.postMessage({m:'setServer',url:$('u').value});
    $('b').onclick=go;$('u').onkeydown=e=>{if(e.key==='Enter')go();};</script></body></html>
    """
    // 2.18: the key handler must not return a value: `e=>e.key==='Enter'&&go()` returned false for
    // every other key, and an on… handler returning false cancels the key, so nothing could be typed.
    web.loadHTMLString(html, baseURL: nil)
  }

  func showOffline() {
    let why = isLocalServer
      ? (local.stopped ? "She is stopped on this Mac. Start her from the menu bar: Sara on this Mac → Start." : "She runs on this Mac and may still be starting. If not, her log says why: Sara on this Mac → Open data folder → logs.")
      : "Check your internet connection, that the address is right, and that Sara is running there. This page tries again by itself."
    // Phase 68: the other saved Saras are one click away.
    let others = Servers.list().filter { $0.id != Servers.activeId }.map { "<button class=g data-id='\(htmlEscape($0.id))'>\(htmlEscape($0.name))</button>" }.joined()
    let othersBlock = others.isEmpty ? "" : "<div class=sep><p class=small>Your other Saras</p><div class=row style='margin-top:0'>" + others + "</div></div>"
    let html = """
    <!doctype html><html><head>\(pageStyle)</head><body><div class=c>\(pageLogo)<h1>Can't reach your Sara</h1><p><b>\(htmlEscape(server ?? ""))</b> isn't answering.</p><p>\(htmlEscape(why))</p>
    <div class=row><button id=r>Try again</button><button class=g id=s>Add a Sara</button></div>\(othersBlock)</div><script>
    document.getElementById('r').onclick=()=>webkit.messageHandlers.sara.postMessage({m:'retry'});
    for(const b of document.querySelectorAll('[data-id]'))b.onclick=()=>webkit.messageHandlers.sara.postMessage({m:'useServer',id:b.dataset.id});
    document.getElementById('s').onclick=()=>webkit.messageHandlers.sara.postMessage({m:'changeServer'});
    setTimeout(()=>webkit.messageHandlers.sara.postMessage({m:'retry'}),30000);</script></body></html>
    """
    web.loadHTMLString(html, baseURL: nil)
  }

  func isServer(_ url: URL?) -> Bool {
    guard let url, let s = server, let o = originOf(url.absoluteString) else { return false }
    return o == s
  }

  // MARK: the bridge
  func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
    // Phase 75: the page's shell messages use {type: …} (theme, backdrop, shell); the bridge uses {m: …}.
    guard let body = message.body as? [String: Any], let kind = (body["m"] ?? body["type"]) as? String else { return replyHandler(nil, "Bad message") }
    let origin = message.frameInfo.securityOrigin
    let fromServer = server.map { s in originOf("\(origin.protocol)://\(origin.host)" + (origin.port > 0 ? ":\(origin.port)" : "")) == s } ?? false
    switch kind {
    // The local setup/offline pages may only set the server, retry or change server.
    case "setServer":
      guard let o = originOf(body["url"] as? String ?? "") else {
        showSetup("That doesn't look like a web address. Try something like sara.example.com.", typed: body["url"] as? String ?? "")
        return replyHandler(nil, nil)
      }
      prefs.set(o, forKey: "lastServer")
      // Phase 68: a saved server again, or a new one next to the others (nobody is signed out).
      if !Servers.list().contains(where: { $0.url == o }) && Servers.list().contains(where: { $0.url != o }) && !Servers.canHoldSeveral {
        alert("Several Saras need macOS 14", "This Mac can keep one Sara signed in. Remove the other one first (Your Saras → Remove…), or update macOS.")
        return replyHandler(nil, nil)
      }
      useServer(Servers.idFor(o), path: "/pair")
      return replyHandler(true, nil)
    case "retry":
      openServer()
      return replyHandler(true, nil)
    case "setupLocal", "chooseLocal":
      chooseLocal()
      return replyHandler(true, nil)
    case "chooseRemote":
      showSetup()
      return replyHandler(true, nil)
    case "changeServer":
      showSetup()
      return replyHandler(true, nil)
    case "useServer" where !fromServer:
      useServer(body["id"] as? String ?? "")
      return replyHandler(true, nil)
    // Phase 75: any page may say it draws the title strip, and move or zoom the window from it.
    case "shell", "dragWindow", "zoomWindow":
      handleShellMessage(kind, body, origin: pageOrigin(message.frameInfo))
      return replyHandler(true, nil)
    #if DEBUG
    case "testShot", "testClick", "testQuit":
      testShellHook(kind, body)
      return replyHandler(true, nil)
    #endif
    default: break
    }
    guard fromServer else { return replyHandler(nil, "Not allowed") }  // everything else only from the owner's own server
    switch kind {
    case "getPrefs": replyHandler(prefsDict(), nil)
    // Phase 75 stage 2: the page can open the quick-ask panel.
    case "quickAsk":
      replyHandler(true, nil)
      quick?.show()
    // Phase 75: the page's theme (night | day | system) and backdrop (solid | vibrancy).
    case "theme", "backdrop":
      handleShellMessage(kind, body, origin: pageOrigin(message.frameInfo))
      replyHandler(true, nil)
    case "setPref":
      let on = body["value"] as? Bool ?? false
      switch body["key"] as? String {
      case "quickAskShortcut":
        guard quick?.setShortcut(body["value"] as? String ?? "") == true else { return replyHandler(nil, "Unknown shortcut") }
      case "startAtLogin": setStartAtLogin(on)
      case "keepRunning": prefs.set(on, forKey: "keepRunning")
      case "notifications": prefs.set(on, forKey: "notifications")
      case "handsDesktop":
        // Phase 92: "The whole screen" (desktop look; the page showed its explainer first).
        prefs.set(on, forKey: "hands.\(Servers.activeId ?? "").desktop")
        Hands.shared?.tellDesktop(on)
      case "handsBlockExtra":
        // Phase 92: "Also hide these windows" (one app or title per line).
        let v = String((body["value"] as? String ?? "").prefix(2000))
        prefs.set(v, forKey: "hands.\(Servers.activeId ?? "").blockExtra")
        HandsScreen.setExtra(v)
      case "handsLocalOnly":
        // Phase 87: "Screenshots only to models on this computer" (the server hears it at once).
        prefs.set(on, forKey: "hands.\(Servers.activeId ?? "").localOnly")
        Hands.shared?.tellLocalOnly(on)
      case "loginsVerify":
        // Phase 90: Touch ID before Sara uses a saved login (off by default).
        prefs.set(on, forKey: "hands.\(Servers.activeId ?? "").loginsVerify")
        Hands.shared?.verify = on
        Hands.shared?.tellLogins()
      case "pmRelockMinutes":
        // Phase 91: lock the password managers again after this many idle minutes.
        let n = Int(body["value"] as? String ?? "") ?? (body["value"] as? Int ?? 0)
        guard [5, 15, 30, 60].contains(n) else { return replyHandler(nil, "5, 15, 30 or 60 minutes.") }
        prefs.set(n, forKey: "hands.\(Servers.activeId ?? "").pm.relockMinutes")
        Hands.shared?.pm.setRelockMinutes(n)
        Hands.shared?.tellManagers()
      case "handsTakeover":
        // Phase 88: "When you move the mouse": pause Sara (default) or let her keep control.
        let keepIt = body["value"] as? String == "keep"
        prefs.set(keepIt ? "keep" : "pause", forKey: "hands.\(Servers.activeId ?? "").takeover")
        Hands.shared?.tellTakeover(keepIt)
      default: return replyHandler(nil, "Unknown setting")
      }
      replyHandler(prefsDict(), nil)
    // Phase 87: "Let Sara use this computer". The page made the hands token after the owner confirmed
    // it's them; it goes to the Keychain and is never given back to any page.
    case "handsOpenPerm":
      // Phase 92: the guided step (§9.1): the exact System Settings pane; the person turns Sara on there.
      HandsScreen.openSettings(body["which"] as? String == "ax" ? "ax" : "capture")
      replyHandler(true, nil)
    case "handsPair":
      let token = body["token"] as? String ?? ""
      guard token.hasPrefix("sara_hands."), token.count < 300, let sid = Servers.activeId else { return replyHandler(nil, "That isn't a hands token.") }
      guard HandsKeychain.save(token, account: sid) else { return replyHandler(nil, "The Keychain couldn't keep the token.") }
      prefs.set(true, forKey: "hands.\(sid).on")
      prefs.set(body["id"] as? String ?? "", forKey: "hands.\(sid).deviceId")
      handsSync()
      replyHandler(prefsDict(), nil)
    case "handsOff":
      handsOff()
      replyHandler(prefsDict(), nil)
    case "handsStop":
      Hands.shared?.pressStop()
      replyHandler(true, nil)
    // Phase 90: this server's saved logins on this Mac (names, sites, dates; never a password).
    case "loginsList":
      guard let s = server else { return replyHandler(["logins": [] as [Any]], nil) }
      replyHandler(["logins": HandsLogins.views(server: s.lowercased())], nil)
    case "loginsRemove":
      guard let s = server else { return replyHandler(nil, "Not connected to a Sara server.") }
      let name = body["name"] as? String
      let all = body["all"] as? Bool == true
      if !all && (name ?? "").isEmpty { return replyHandler(nil, "Say which saved login to remove.") }
      let n = Hands.shared.map { $0.forgetHere(all ? nil : name) } ?? HandsLogins.remove(server: s.lowercased(), name: all ? nil : name)
      replyHandler(["removed": n], nil)
    // Phase 91: the password managers on this Mac (names and states). Turning one on shows this app's own
    // warning (the page can only ask: a server's page can never turn one on by itself); off locks it at once.
    case "pmList":
      replyHandler(pmListDict(), nil)
    case "pmSet":
      let mid = body["manager"] as? String ?? ""
      guard let i = handsPmIndex(mid), let sid = Servers.activeId else { return replyHandler(nil, "Not a password manager Sara knows.") }
      let on = body["on"] as? Bool == true
      if on {
        guard Hands.shared?.pm.installed(i) == true else { return replyHandler(nil, "That password manager isn't installed on this Mac.") }
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = "\(handsTestLabel ? "TEST · " : "")Turn on \(handsPms[i].name) for Sara?"
        a.informativeText = handsManagerWarning.replacingOccurrences(of: "{manager}", with: handsPms[i].name).replacingOccurrences(of: "{minutes}", with: String(pmRelock(sid)))
        a.addButton(withTitle: "Not now")
        a.addButton(withTitle: "Turn on")
        guard a.runModal() == .alertSecondButtonReturn else { return replyHandler(["cancelled": true], nil) }
        if i == 2 && (prefs.string(forKey: "hands.\(sid).pm.keepassDb") ?? "").isEmpty {
          guard let db = pickKeepassDb() else { return replyHandler(["cancelled": true], nil) }
          prefs.set(db, forKey: "hands.\(sid).pm.keepassDb")
          Hands.shared?.pm.setKeepassDb(db)
        }
      }
      prefs.set(on, forKey: "hands.\(sid).pm.\(mid)")
      if let h = Hands.shared { DispatchQueue.global().async { h.pm.setOn(i, on) } }
      replyHandler(pmListDict(), nil)
    case "pmKeepassDb":
      guard let sid = Servers.activeId, let db = pickKeepassDb() else { return replyHandler(["cancelled": true], nil) }
      prefs.set(db, forKey: "hands.\(sid).pm.keepassDb")
      if let h = Hands.shared { DispatchQueue.global().async { h.pm.setKeepassDb(db) } }
      replyHandler(pmListDict(), nil)
    case "testNotification":
      postNotification(title: body["title"] as? String ?? "Sara", body: body["body"] as? String ?? "", conv: "")
      replyHandler(true, nil)
    case "notify":
      notifyFromPage(title: body["title"] as? String ?? "Sara", body: body["body"] as? String ?? "", conv: body["conv"] as? String ?? "")
      replyHandler(true, nil)
    case "attention":
      showWindow()
      NSApp.requestUserAttention(.criticalRequest)
      replyHandler(true, nil)
    // Phase 68: the page's ⇄ menu. Names and hosts only: no sign-in ever goes to a page.
    case "servers": replyHandler(Servers.json(), nil)
    case "useServer":
      replyHandler(true, nil)
      useServer(body["id"] as? String ?? "")
    case "addServer":
      replyHandler(true, nil)
      addServerFromMenu()
    case "removeServer":
      replyHandler(true, nil)
      removeServer(body["id"] as? String ?? "")
    case "renameServer", "serverName":
      let byUser = kind == "renameServer"
      let id = byUser ? body["id"] as? String ?? "" : Servers.activeId ?? ""
      let name = (body["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      if !name.isEmpty, let p = Servers.list().first(where: { $0.id == id }), byUser || !p.named {
        Servers.update(id) { s in
          s.name = Servers.uniqueName(name, url: s.url, except: s.id)
          if byUser { s.named = true }
        }
        if id == Servers.activeId { updateStatusTip() }
      }
      replyHandler(Servers.json(), nil)
    default: replyHandler(nil, "Unknown")
    }
  }

  /// Phase 92: the Mac's permissions as last told to the server.
  private var lastPerms = (false, false)
  func prefsDict() -> [String: Any] {
    var d: [String: Any] = ["platform": "mac", "version": appVersion, "startAtLogin": startAtLogin, "keepRunning": keepRunning, "notifications": notificationsOn, "server": server ?? "",
                            "theme": Shell.themePref, "titlebar": Int(macTitlebar)]
    // Phase 75 stage 2: the quick-ask shortcut, the choices, and whether another app has it.
    for (k, v) in quick?.prefs_ ?? [:] { d[k] = v }
    // Phase 87: "Let Sara use this computer" for the Sara in use (Hands.swift).
    let sid = Servers.activeId ?? ""
    d["handsSupported"] = true
    d["handsOptIn"] = prefs.bool(forKey: "hands.\(sid).on")
    d["handsLocalOnly"] = prefs.bool(forKey: "hands.\(sid).localOnly")
    d["handsConnected"] = Hands.shared?.connected ?? false
    d["handsDeviceId"] = prefs.string(forKey: "hands.\(sid).deviceId") ?? ""
    d["handsError"] = Hands.shared?.lastError ?? ""
    d["handsTakeover"] = prefs.string(forKey: "hands.\(sid).takeover") == "keep" ? "keep" : "pause"
    d["handsHotkey"] = (Hands.shared?.hotkeyOk ?? false) ? "⌃⌥Esc" : ""
    d["handsBrowser"] = HandsBrowser.find() != nil
    d["computerName"] = Host.current().localizedName ?? "this Mac"
    d["loginsSupported"] = true
    d["loginsVerify"] = prefs.bool(forKey: "hands.\(sid).loginsVerify")
    d["pmSupported"] = true
    // Phase 92: the whole screen, the person's own hidden windows, and the Mac's two permissions (ticks in the page).
    d["handsDesktopSupported"] = true
    d["handsDesktop"] = prefs.bool(forKey: "hands.\(sid).desktop")
    d["handsBlockExtra"] = prefs.string(forKey: "hands.\(sid).blockExtra") ?? ""
    let perms = HandsScreen.perms
    d["handsPerms"] = ["capture": perms.capture, "ax": perms.ax]
    // The server hears when a permission was just granted.
    if let h = Hands.shared, h.desktop, (perms.capture, perms.ax) != lastPerms { lastPerms = (perms.capture, perms.ax); h.tellOptIn() }
    return d
  }
  /// Phase 91: the password managers here for the app's own Settings page (names and states only).
  func pmListDict() -> [String: Any] {
    guard let h = Hands.shared, h.pm.detected else { return ["managers": [] as [Any], "detected": false] }
    return ["managers": h.pm.views(), "relockMinutes": h.pm.relockMinutes, "keepassDb": h.pm.keepassDbName, "detected": true]
  }
  func pmRelock(_ sid: String) -> Int {
    let n = prefs.integer(forKey: "hands.\(sid).pm.relockMinutes")
    return [5, 15, 30, 60].contains(n) ? n : 15
  }
  var handsTestLabel: Bool {
    #if DEBUG
    return Bundle.main.bundleIdentifier != "com.backstagecoding.sara.desktop"
    #else
    return false
    #endif
  }
  /// Phase 91: the person picks the KeePassXC database Sara may unlock.
  func pickKeepassDb() -> String? {
    let p = NSOpenPanel()
    p.title = "Choose the KeePassXC database Sara may use"
    p.allowsMultipleSelection = false
    p.canChooseDirectories = false
    return p.runModal() == .OK ? p.url?.path : nil
  }

  // MARK: Phase 87: Sara's hands on this Mac
  /// Starts or stops the hands for the Sara in use, as its settings say.
  func handsSync() {
    Hands.shared?.stop()
    Hands.shared = nil
    #if DEBUG
    // Test builds with another bundle id only: SARA_TEST_HANDS_TOKEN=<file> puts a paired hands token
    // into this copy's own Keychain item and switches its hands on (no pairing page over SSH).
    if Bundle.main.bundleIdentifier != "com.backstagecoding.sara.desktop", let sid = Servers.activeId,
       let f = ProcessInfo.processInfo.environment["SARA_TEST_HANDS_TOKEN"], let tok = try? String(contentsOfFile: f, encoding: .utf8) {
      let t = tok.trimmingCharacters(in: .whitespacesAndNewlines)
      if t.hasPrefix("sara_hands."), HandsKeychain.load(account: sid) == nil || ProcessInfo.processInfo.environment["SARA_TEST_HANDS_REPLACE"] == "1", HandsKeychain.save(t, account: sid) {
        prefs.set(true, forKey: "hands.\(sid).on")
        if let exp = ProcessInfo.processInfo.environment["SARA_TEST_HANDS_EXPIRES"] { prefs.set(exp, forKey: "hands.\(sid).expires") }
        // Phase 92: test copies can start with "The whole screen" on (the person's switch in the real app).
        if ProcessInfo.processInfo.environment["SARA_TEST_HANDS_DESKTOP"] == "1" { prefs.set(true, forKey: "hands.\(sid).desktop") }
        testLog("hands: test token stored")
      }
    }
    #endif
    guard let sid = Servers.activeId, let s = server, prefs.bool(forKey: "hands.\(sid).on"), let token = HandsKeychain.load(account: sid), token.hasPrefix("sara_hands.") else { return }
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(Bundle.main.bundleIdentifier ?? "Sara")
    let agentURL = Bundle.main.url(forResource: "page-agent", withExtension: "js")
    var agent = (agentURL.flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    while agent.hasSuffix(";") { agent.removeLast() }
    // Phase 88: Downloads/Sara (test builds: a folder in the app's own support folder), the local
    // log, the takeover choice, the TEST label, and a renewed token kept in the Keychain.
    var testLabel = false
    #if DEBUG
    testLabel = Bundle.main.bundleIdentifier != "com.backstagecoding.sara.desktop"
    #endif
    let downloads = testLabel ? support.appendingPathComponent("hands-downloads")
      : FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0].appendingPathComponent("Sara")
    try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
    let h = Hands(server: s, token: token, computer: Host.current().localizedName ?? "this Mac", profileDir: support.appendingPathComponent("hands-browser/\(sid)"),
                  pageAgent: agent, version: "Sara for Mac \(appVersion)", localOnly: prefs.bool(forKey: "hands.\(sid).localOnly"),
                  keep: prefs.string(forKey: "hands.\(sid).takeover") == "keep", downloadsDir: downloads,
                  logFile: support.appendingPathComponent("hands-log.txt"), expiresAt: prefs.string(forKey: "hands.\(sid).expires") ?? "", testLabel: testLabel)
    h.onToken = { tok, exp in
      if HandsKeychain.save(tok, account: sid) { prefs.set(exp, forKey: "hands.\(sid).expires") }
    }
    h.verify = prefs.bool(forKey: "hands.\(sid).loginsVerify")
    // Phase 92: "The whole screen" and "Also hide these windows".
    h.desktop = prefs.bool(forKey: "hands.\(sid).desktop")
    HandsScreen.setExtra(prefs.string(forKey: "hands.\(sid).blockExtra") ?? "")
    // Phase 91: the password managers the owner turned on here, KeePassXC's database and the idle minutes.
    var idle = 0
    #if DEBUG
    if testLabel { idle = Int(ProcessInfo.processInfo.environment["SARA_PM_IDLE_SECONDS"] ?? "") ?? 0 }
    #endif
    h.pm.configure(testRun: testLabel, on: handsPms.map { prefs.bool(forKey: "hands.\(sid).pm.\($0.id)") }, keepassDb: prefs.string(forKey: "hands.\(sid).pm.keepassDb") ?? "",
                   relockMinutes: pmRelock(sid), idleSeconds: idle)
    Hands.shared = h
    h.start()
  }
  func handsOff() {
    Hands.shared?.stop()
    Hands.shared = nil
    guard let sid = Servers.activeId else { return }
    HandsKeychain.delete(account: sid)
    for k in ["on", "deviceId", "expires"] { prefs.removeObject(forKey: "hands.\(sid).\(k)") }
  }
  @objc func handsStopFromMenu() { Hands.shared?.pressStop() }
  @objc func handsResumeFromMenu() { Hands.shared?.resume() }
  @objc func handsLogFromMenu() {
    // Phase 88: her local record (plain text, no pictures), opened for the owner.
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(Bundle.main.bundleIdentifier ?? "Sara")
    let f = support.appendingPathComponent("hands-log.txt")
    if !FileManager.default.fileExists(atPath: f.path) { try? "".write(to: f, atomically: true, encoding: .utf8) }
    NSWorkspace.shared.open(f)
  }
  /// Phase 88: the menu bar menu's hands items, rebuilt each time it opens (no restart needed after
  /// "Let Sara use this computer" changes): "Connected to Sara at …", Stop, Resume, the log, Off.
  static let handsTag = 7600
  func refreshHandsItems(in m: NSMenu) {
    for item in m.items where item.tag >= AppDelegate.handsTag && item.tag < AppDelegate.handsTag + 10 { m.removeItem(item) }
    guard prefs.bool(forKey: "hands.\(Servers.activeId ?? "").on") else { return }
    var at = (m.items.firstIndex { $0.title == "Settings…" } ?? 1) + 1
    func put(_ title: String, _ action: Selector?, _ tag: Int, enabled: Bool = true) {
      let it = NSMenuItem(title: title, action: action, keyEquivalent: "")
      it.target = self
      it.tag = AppDelegate.handsTag + tag
      it.isEnabled = enabled
      m.insertItem(it, at: at)
      at += 1
    }
    let h = Hands.shared
    put(h?.statusLine ?? "Not connected to Sara", nil, 0, enabled: false)
    put("Stop Sara on this Mac" + ((h?.hotkeyOk ?? false) ? "   ⌃⌥Esc" : ""), #selector(handsStopFromMenu), 1, enabled: h?.connected ?? false)
    if h?.paused ?? false { put("Resume Sara", #selector(handsResumeFromMenu), 2) }
    put("What Sara did on this Mac", #selector(handsLogFromMenu), 3)
    put("Don't let Sara use this Mac", #selector(handsOffFromMenu), 4)
  }
  @objc func handsOffFromMenu() { handsOff() }

  // MARK: notifications
  func postNotification(title: String, body: String, conv: String) {
    addNote(id: UUID().uuidString, title: title, body: body, info: conv.isEmpty ? [:] : ["conv": conv])
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([.banner, .sound])
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    // Phase 75 stage 3: Allow / Deny / Done / Snooze or the notification itself (Notify.swift).
    handleNoteResponse(r)
    done()
  }

  // MARK: navigation: only the owner's server opens inside the app; other links go to the browser.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, preferences: WKWebpagePreferences, decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
    let url = action.request.url
    if action.shouldPerformDownload { return decisionHandler(.download, preferences) }
    if url?.scheme == "about" || url?.scheme == "blob" || url?.scheme == "data" || isServer(url) || (url?.absoluteString == "about:blank") {
      // Phase 75: a page from another place says again whether it draws the title strip.
      if action.targetFrame?.isMainFrame ?? false, url?.scheme != "blob" { pageWillLoad(url) }
      return decisionHandler(.allow, preferences)
    }
    decisionHandler(.cancel, preferences)
    if let url, url.scheme == "http" || url.scheme == "https" || url.scheme == "mailto" { NSWorkspace.shared.open(url) }
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
    decisionHandler(disposition.lowercased().hasPrefix("attachment") || !response.canShowMIMEType ? .download : .allow)
  }

  func webView(_ webView: WKWebView, didFinish nav: WKNavigation!) {
    // Phase 75 stage 3: files dropped on the Dock icon while her page wasn't there yet.
    if isServer(webView.url) { deliverDockFiles() }
    // Phase 68: removing a server that wasn't in use: now it's open, sign out there.
    if let r = pendingRemove, r == Servers.activeId, isServer(webView.url) {
      pendingRemove = nil
      removeActiveServer()
    }
    #if DEBUG
    testHook(webView)
    #endif
  }

  #if DEBUG
  // Test builds only (swiftc -D DEBUG): SARA_TEST_JS runs that script after each page load and
  // appends its result to SARA_TEST_OUT, so the app can be checked over SSH without a screen.
  func testHook(_ webView: WKWebView) {
    let env = ProcessInfo.processInfo.environment
    guard let js = env["SARA_TEST_JS"].flatMap({ try? String(contentsOfFile: $0, encoding: .utf8) }), let out = env["SARA_TEST_OUT"] else { return }
    webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
      let line: String
      switch result {
      case .success(let v): line = "\(webView.url?.absoluteString ?? "?") => \(v)\n"
      case .failure(let e): line = "\(webView.url?.absoluteString ?? "?") !! \(e)\n"
      }
      if let h = FileHandle(forWritingAtPath: out) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile() }
      else { try? line.write(toFile: out, atomically: true, encoding: .utf8) }
    }
  }
  #endif

  func webView(_ webView: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
    let e = error as NSError
    if e.code == NSURLErrorCancelled || e.domain == "WebKitErrorDomain" { return }
    showOffline()
  }

  func webView(_ webView: WKWebView, createWebViewWith config: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url {
      if isServer(url) { webView.load(action.request) } else { NSWorkspace.shared.open(url) }
    }
    return nil
  }

  // Microphone (calls, voice messages) and, Phase 69, the camera on video calls (only after the
  // owner turns it on in the call; macOS asks once): allowed for the owner's server only.
  func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    let o = "\(origin.protocol)://\(origin.host)" + (origin.port > 0 ? ":\(origin.port)" : "")
    let media = type == .microphone || type == .camera || type == .cameraAndMicrophone
    decisionHandler(server != nil && originOf(o) == server && media ? .grant : .deny)
  }

  // alert / confirm / prompt and file pickers, as a browser would.
  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    let a = NSAlert()
    a.messageText = prompt
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
    field.stringValue = defaultText ?? ""
    a.accessoryView = field
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn ? field.stringValue : nil) }
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let p = NSOpenPanel()
    p.allowsMultipleSelection = parameters.allowsMultipleSelection
    p.canChooseDirectories = parameters.allowsDirectories
    p.beginSheetModal(for: window) { r in completionHandler(r == .OK ? p.urls : nil) }
  }

  // Downloads (log, export, files she made) go to Downloads.
  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
    var url = dir.appendingPathComponent(suggestedFilename)
    var n = 1
    let base = url.deletingPathExtension().lastPathComponent, ext = url.pathExtension
    while FileManager.default.fileExists(atPath: url.path) {
      n += 1
      url = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
    }
    completionHandler(url)
  }
  func downloadDidFinish(_ download: WKDownload) {
    postNotification(title: "Downloaded", body: "Saved to your Downloads folder.", conv: "")
  }
}

/// Settings… and Help need a Sara to show them.
extension AppDelegate: NSMenuItemValidation {
  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    if item.action == #selector(openSettings) || item.action == #selector(openHelp) { return server != nil }
    return true
  }
}

extension AppDelegate: NSMenuDelegate {
  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.item(withTitle: "Open at login")?.state = startAtLogin ? .on : .off
    for s in liveSubmenus where s.item.menu === menu { s.item.submenu = s.make() }
    // Phase 75 stage 2: her face, mood, Ask and "Now" at the top of the menu bar menu.
    if menu === statusItem?.menu {
      refreshNowItems(in: menu)
      refreshHandsItems(in: menu)
      quick?.refresh()  // fresh for the next time it opens
    }
  }
}

#if DEBUG
/// Test builds: a line into SARA_TEST_OUT.
func testLog(_ s: String) {
  guard let out = ProcessInfo.processInfo.environment["SARA_TEST_OUT"] else { return }
  let line = "native => \(s)\n"
  if let h = FileHandle(forWritingAtPath: out) { h.seekToEndOfFile(); h.write(Data(line.utf8)); h.closeFile() } else { try? line.write(toFile: out, atomically: true, encoding: .utf8) }
}
#endif

// launchd's supervisor and the `sara` command run without a window.
let argv = CommandLine.arguments
if argv.count > 1 && argv[1] == "--run-server" { Supervisor.run() }
if argv.count > 1 && argv[1] == "--cli" { exit(CLI.run(Array(argv.dropFirst(2)))) }

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
