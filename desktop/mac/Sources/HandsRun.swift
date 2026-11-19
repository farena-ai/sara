// N5 (Mac parity with 3.5 PC tools, docs/design/PC_TOOLS.md): c.run / c.open on a Mac. The rules are
// src/hands-run.ts's (the server checks the same before it sends and again after), with zsh instead of
// PowerShell / cmd: every command is shown in this app's own card (a non-activating panel that never
// takes the keyboard and never shows in her pictures), runs as the person (never root, never sudo),
// in its own process group with every process it started tracked, so Stop (the badge, ⌃⌥Esc, the chat),
// the deadline and the end of the command end the whole tree. Output is masked and capped here.
import AppKit
import Darwin

enum HandsRunRules {
  static let commandChars = 4000, outputChars = 64_000, chunkChars = 4000, liveChars = 64_000, pathChars = 1024
  static let grantSeconds: TimeInterval = 15 * 60
  private static func re(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p, options: [.caseInsensitive]) }
  private static func has(_ r: NSRegularExpression, _ s: String) -> Bool { r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }

  /// Never as administrator (the same list as src/hands-run.ts ELEVATE).
  static let elevate = [re("-verb\\s+['\"]?runas\\b"), re("\\brunas(\\.exe)?\\b"), re("\\bg?sudo\\b"), re("\\bStart-Process\\b[^\\n]*-Verb\\b"),
                        re("(^|[;&|(]\\s*)(su|doas|pkexec)(\\s|$)"), re("with\\s+administrator\\s+privileges"), re("\\bauthopen\\b")]
  /// Always asks, whatever the policy (src/hands-run.ts DESTRUCTIVE, Windows' words and the Mac's own).
  static let destructive = re("\\b(remove-item|ri|rm|rmdir|rd|del|erase|format(-volume)?|clear-disk|initialize-disk|diskpart|clear-content|set-content|out-file|reg(\\.exe)?\\s+(add|delete|import|restore)|set-itemproperty|remove-itemproperty|new-itemproperty|stop-computer|restart-computer|shutdown(\\.exe)?|logoff|set-executionpolicy|stop-process|spps|taskkill|kill|move-item|mv|move|ren(ame)?(-item)?|copy-item|xcopy|robocopy|cipher|bcdedit|vssadmin|wmic|icacls|takeown|attrib|uninstall(-package)?|msiexec|winget|choco|invoke-webrequest|iwr|curl|wget|invoke-restmethod|irm|invoke-expression|iex|start-bitstransfer|downloadstring|downloadfile|net(\\.exe)?\\s+(user|localgroup|share)|schtasks|sc(\\.exe)?\\s+(delete|config|create|stop)|new-service|set-service|disable-|enable-|git\\s+(push|reset|clean|checkout|rebase|commit|merge)|chmod|chown|chflags|chgrp|launchctl|defaults\\s+(write|delete|import)|diskutil|dd|osascript|killall|pkill|brew|softwareupdate|pmset|networksetup|systemsetup|scutil|csrutil|spctl|xattr|srm|shred|truncate|tmutil|installer|hdiutil|security|dscl|crontab|sed\\s+-i|tee|ln|cp|unlink|trash|open\\s+-a)\\b")
  static let readHead = re("^(get-childitem|gci|dir|ls|get-content|gc|type|cat|get-location|gl|pwd|get-date|date\\s*/t|whoami|hostname|get-process|gps|ps|get-item|gi|test-path|get-volume|get-psdrive|git\\s+(status|log|diff|branch|show|remote\\s+-v)|df|du|sw_vers|uname|uptime|head|tail|wc)(\\s|$)")
  static let readPipe = re("^(select-object|select|format-table|ft|format-list|fl|sort-object|sort|measure-object|measure|out-string|head|tail|wc|uniq|cut)(\\s|$)")

  static func elevated(_ c: String) -> Bool { elevate.contains { has($0, c) } }
  static func destructiveCommand(_ c: String) -> Bool { has(destructive, c) }
  /// One simple read-only command (no `;`, `&`, redirects, subexpressions; only $env:NAME variables).
  static func readOnlyCommand(_ command: String) -> Bool {
    let c = command.trimmingCharacters(in: .whitespacesAndNewlines)
    if c.isEmpty || c.count > 400 || c.rangeOfCharacter(from: CharacterSet(charactersIn: ";&<>`{}\r\n")) != nil || c.contains("$(") || c.contains("@(") { return false }
    if has(re("\\$(?!env:[A-Za-z_][\\w]*)"), c) { return false }
    let parts = c.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    guard has(readHead, parts[0]) else { return false }
    if has(re("^(type|cat|gc|get-content)\\b"), parts[0]) && has(re("\\b(-stream|::)"), parts[0]) { return false }
    return parts.dropFirst().allSatisfy { has(readPipe, $0) }
  }
  /// Control characters other than newline and tab go; \r\n becomes \n.
  static func plain(_ s: String) -> String {
    String(String.UnicodeScalarView(s.replacingOccurrences(of: "\r\n", with: "\n").unicodeScalars.filter { $0 == "\n" || $0 == "\t" || ($0.value >= 0x20 && $0.value != 0x7f) }))
  }
  static func masked(_ s: String) -> String { handsMask(plain(s)) }
  /// At most `max` characters: the start and the end, with how much was left out between.
  static func capped(_ s: String, _ max: Int = outputChars) -> (text: String, truncated: Bool) {
    guard s.count > max else { return (s, false) }
    let head = max / 4, tail = max - head - 80
    return (String(s.prefix(head)) + "\n[… \(s.count - head - tail) characters left out …]\n" + String(s.suffix(tail)), true)
  }
  /// File types never opened by c.open (opening never runs a program): src/hands-run.ts RUNNABLE.
  static let runnable = re("\\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|pif|lnk|url|reg|hta|cpl|jar|appref-ms|application|gadget|inf|scf|ms-settings|app|command|tool|sh|zsh|bash|csh|pkg|mpkg|scpt|scptd|applescript|workflow|terminal|webloc|inetloc|dmg|prefpane|kext)/?$")
  /// Apps never opened by name: the ones that run commands or change the system for whoever drives them.
  static func refusedApp(_ name: String) -> Bool {
    let n = name.lowercased()
    return ["terminal", "iterm", "warp", "script editor", "automator", "shortcuts", "system settings", "system preferences", "keychain access", "disk utility", "migration assistant", "sara"].contains { n.contains($0) } || HandsScreen.blockedKind(name, name) != nil
  }
  enum OpenKind: String { case url, path, app }
  /// c.open's target: an http(s)/mailto address, a full path (never a program), or an app's name.
  static func openPlan(_ raw: String) throws -> (kind: OpenKind, target: String) {
    let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    func no(_ m: String) -> HandsOpError { HandsOpError(code: "denied_local", message: m) }
    guard !t.isEmpty, t.count <= 2000, t.unicodeScalars.allSatisfy({ $0.value >= 0x20 }) else { throw no("target: a web address, a full file or folder path, or an installed app's name.") }
    if has(re("^[a-z][a-z0-9+.-]*://"), t) || t.lowercased().hasPrefix("mailto:") {
      guard has(re("^(https?://|mailto:)"), t) else { throw no("Only http, https and mailto addresses are opened.") }
      return (.url, t)
    }
    if t.hasPrefix("/") || t.hasPrefix("~") {
      if t.hasPrefix("//") { throw no("Only files and folders on this computer, not network shares.") }
      guard t.count <= pathChars else { throw no("That path is too long.") }
      if has(runnable, t) { throw no("Opening a program or script file is refused (use a command the person approves, or open the app by its name).") }
      return (.path, t)
    }
    guard t.count <= 80, has(re("^[\\w .+&'()-]+$"), t) else { throw no("An app is opened by its name as in Applications (like \"TextEdit\"), never a command line.") }
    return (.app, t)
  }
  /// "~", "~/x" → the home folder.
  static func expand(_ p: String) -> String { p == "~" ? NSHomeDirectory() : p.hasPrefix("~/") ? NSHomeDirectory() + String(p.dropFirst(1)) : p }
}

/// The card: a panel that never activates the app (the person's window in front stays in front and keeps
/// the keyboard), mouse only, always on top, never in screenshots. Closing it is Don't.
final class HandsRunPanel: NSObject, NSWindowDelegate {
  private var panel: NSPanel?
  private var answer = 0
  private var finished = false
  private let done = DispatchSemaphore(value: 0)

  /// 0 Don't, 1 once, 2 this task, 3 W0.5: Always allow everything (the server's switch, confirmed here once).
  static func ask(title: String, heading: String, text: String, note: String, taskChoice: Bool, allChoice: Bool = false, cancel: HandsCancel) -> Int {
    let p = HandsRunPanel()
    DispatchQueue.main.async { p.show(title: title, heading: heading, text: text, note: note, taskChoice: taskChoice, allChoice: allChoice) }
    while p.done.wait(timeout: .now() + 0.05) == .timedOut {
      if cancel.isSet { DispatchQueue.main.async { p.finish(0) } }
    }
    return cancel.isSet ? 0 : p.answer
  }
  private func show(title: String, heading: String, text: String, note: String, taskChoice: Bool, allChoice: Bool) {
    let w: CGFloat = 640, h: CGFloat = 400
    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
    let p = NSPanel(contentRect: NSRect(x: screen.midX - w / 2, y: screen.maxY - h - 80, width: w, height: h), styleMask: [.titled, .closable, .nonactivatingPanel, .utilityWindow], backing: .buffered, defer: false)
    p.title = title
    p.level = .modalPanel
    p.isFloatingPanel = true
    p.hidesOnDeactivate = false
    p.becomesKeyOnlyIfNeeded = true
    p.sharingType = .none  // never in her pictures
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    p.delegate = self
    p.isReleasedWhenClosed = false
    let v = NSView(frame: NSRect(x: 0, y: 0, width: w, height: h))
    let head = NSTextField(wrappingLabelWithString: heading)
    head.font = .boldSystemFont(ofSize: 14)
    head.frame = NSRect(x: 20, y: h - 46, width: w - 40, height: 30)
    v.addSubview(head)
    let scroll = NSScrollView(frame: NSRect(x: 20, y: 130, width: w - 40, height: h - 186))
    scroll.hasVerticalScroller = true
    scroll.borderType = .bezelBorder
    let tv = NSTextView(frame: scroll.bounds)
    tv.isEditable = false
    tv.isSelectable = true
    tv.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
    tv.string = String(text.prefix(4200))
    tv.autoresizingMask = [.width]
    scroll.documentView = tv
    v.addSubview(scroll)
    let foot = NSTextField(wrappingLabelWithString: note)
    foot.font = .systemFont(ofSize: 12)
    foot.textColor = .secondaryLabelColor
    foot.frame = NSRect(x: 20, y: 70, width: w - 40, height: 50)
    v.addSubview(foot)
    func button(_ t: String, _ tag: Int, _ x: CGFloat, _ bw: CGFloat) {
      let b = NSButton(title: t, target: self, action: #selector(pressed(_:)))
      b.tag = tag
      b.bezelStyle = .rounded
      b.frame = NSRect(x: x, y: 20, width: bw, height: 36)
      v.addSubview(b)
    }
    button("Allow once", 1, 20, 140)
    // W0.5: like hands-run.cpp, the Always allow everything button takes the task button's place.
    if allChoice { button("Always allow everything", 3, 172, 220) } else if taskChoice { button("Allow for this task", 2, 172, 200) }
    button("Don't", 0, w - 160, 140)
    p.contentView = v
    panel = p
    // Shown without activating Sara: the window the person is using keeps the keyboard.
    p.orderFrontRegardless()
    #if DEBUG
    HandsRunPanel.current = self
    #endif
  }
  @objc private func pressed(_ b: NSButton) { finish(b.tag) }
  func windowWillClose(_ notification: Notification) { finish(0, closing: true) }
  func finish(_ a: Int, closing: Bool = false) {
    guard !finished else { return }
    finished = true
    answer = a
    if !closing { panel?.orderOut(nil); panel?.close() }
    panel = nil
    #if DEBUG
    if HandsRunPanel.current === self { HandsRunPanel.current = nil }
    #endif
    done.signal()
  }
  #if DEBUG
  /// Test copies: the distributed notification `run:allow|task|deny` answers the open card.
  static weak var current: HandsRunPanel?
  #endif
}

/// c.run / c.open for one connection (Hands owns one).
final class HandsRun {
  var on = false
  var level = "task"
  var readOnlyAuto = false
  var test = false
  private var grants: [String: Date] = [:]
  /// W0.5: Always allow everything keys confirmed on this Mac's card (key -> until), like hands-run.cpp's g_all.
  private var allGrants: [String: Date] = [:]
  private let lock = NSLock()

  func configure(on: Bool, level: String, readOnly: Bool) {
    lock.lock()
    if level != self.level || !on { grants.removeAll(); allGrants.removeAll() }
    self.on = on
    self.level = ["ask", "task", "always"].contains(level) ? level : "task"
    self.readOnlyAuto = readOnly
    lock.unlock()
  }
  func clearGrants() { lock.lock(); grants.removeAll(); lock.unlock() }

  struct Ctx {
    let cancel: HandsCancel
    let paused: () -> Bool
    let ev: ([String: Any]) -> Void
    let log: (String, String) -> Void
    let approving: (Bool) -> Void
  }

  func handle(op: String, _ a: [String: Any], _ ctx: Ctx) throws -> [String: Any] {
    lock.lock(); let isOn = on; lock.unlock()
    guard isOn else { throw HandsOpError(code: "denied_local", message: "\"Let her run commands on this computer\" is off here: only the person here can switch it on, in the Sara app (Settings, Computer use).") }
    if ctx.paused() || !HandsScreen.unlocked() { throw HandsOpError(code: "takeover", message: "Paused on this computer (the person took over or it is locked): nothing new runs until they are back.") }
    if op == "c.run" { return try runCommand(a, ctx) }
    if op == "c.open" { return try openThing(a, ctx) }
    throw HandsOpError(code: "unsupported", message: "This computer doesn't do that.")
  }

  /// The policy: read-only auto (opt-in), destructive always once, then the level and the task grants.
  private func approve(_ a: [String: Any], _ ctx: Ctx, heading: String, text: String, readOnly: Bool, destructive: Bool) throws {
    lock.lock()
    let lvl = a["approvalLevel"] as? String == "ask" ? "ask" : level  // the server can make it stricter, never looser
    let auto = readOnly && readOnlyAuto && a["approvalLevel"] as? String != "ask"
    let task = String((a["task"] as? String ?? "").prefix(160))
    grants = grants.filter { Date().timeIntervalSince($0.value) < HandsRunRules.grantSeconds }
    let granted = !destructive && (lvl == "always" || (lvl == "task" && !task.isEmpty && grants[task] != nil))
    if granted { grants[task] = Date() }
    // W0.5: Always allow everything, confirmed on this Mac: every command runs (also the destructive ones).
    // Never as administrator, never sudo: those are refused before this (limits, not approvals).
    let allKey = String((a["allowAll"] as? String ?? "").prefix(160))
    allGrants = allGrants.filter { $0.value > Date() }
    if !allKey.isEmpty && allGrants[allKey] != nil { lock.unlock(); return }
    lock.unlock()
    if auto || granted { return }
    ctx.ev(["state": "asking"])
    ctx.approving(true)
    let answer = HandsRunPanel.ask(title: test ? "TEST Sara: run a command" : "Sara: run a command", heading: heading, text: text,
                                   note: "It runs as you, never as administrator. Stop (Control-Option-Esc) ends it and everything it started. Closing this window means Don't.",
                                   taskChoice: !destructive && lvl == "task" && !task.isEmpty, allChoice: !allKey.isEmpty, cancel: ctx.cancel)
    ctx.approving(false)
    guard answer > 0, !ctx.cancel.isSet else { throw HandsOpError(code: "denied_local", message: "The person at this computer said no.") }
    if answer == 3 && !allKey.isEmpty {
      lock.lock(); allGrants[allKey] = Date().addingTimeInterval(Hands.allowAllSeconds(a["allowAllMs"])); lock.unlock()
      ctx.log("allowall", "Always allow everything")
    } else if answer == 2 && !task.isEmpty { lock.lock(); grants[task] = Date(); lock.unlock() }
  }

  private func runCommand(_ a: [String: Any], _ ctx: Ctx) throws -> [String: Any] {
    let command = (a["command"] as? String ?? "").replacingOccurrences(of: "\r", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    func no(_ m: String) -> HandsOpError { HandsOpError(code: "denied_local", message: m) }
    guard !command.isEmpty else { throw no("command: the zsh command to run.") }
    guard command.count <= HandsRunRules.commandChars else { throw no("That command is longer than 4000 characters.") }
    guard !command.contains("\u{0}") else { throw no("That command has a NUL character.") }
    if HandsRunRules.elevated(command) { throw no("Commands never run as administrator on this computer (no sudo, su or \"with administrator privileges\"). Ask the person here to do that part themselves.") }
    if getuid() == 0 || geteuid() == 0 { throw no("The Sara app is running as root here, so commands are refused (they never run elevated). Start the app normally.") }
    let rawCwd = (a["cwd"] as? String ?? "").trimmingCharacters(in: .whitespaces)
    if rawCwd.hasPrefix("//") || rawCwd.hasPrefix("\\\\") { throw no("cwd: a folder on this computer, not a network share.") }
    if !rawCwd.isEmpty && !rawCwd.hasPrefix("/") && !rawCwd.hasPrefix("~") { throw no("cwd: a full folder path on this Mac (like ~/Projects), or leave it out for the home folder.") }
    let cwd = rawCwd.isEmpty ? NSHomeDirectory() : HandsRunRules.expand(rawCwd)
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: cwd, isDirectory: &isDir), isDir.boolValue else { throw HandsOpError(code: "not_found", message: "That folder doesn't exist on this computer.") }
    let ms = (a["timeoutMs"] as? NSNumber)?.doubleValue ?? 60_000
    let timeout = min(600, max(5, ms / 1000))
    let destructive = HandsRunRules.destructiveCommand(command), readOnly = !destructive && HandsRunRules.readOnlyCommand(command)
    let where_ = rawCwd.isEmpty ? "~ (home)" : rawCwd
    do {
      try approve(a, ctx, heading: destructive ? "Sara wants to run a command that may change or delete things" : "Sara wants to run a command on this Mac",
                  text: "zsh in \(where_)\(destructive ? " (this may change or delete things)" : ""):\n\(command)", readOnly: readOnly, destructive: destructive)
    } catch let e as HandsOpError {
      ctx.log("didn't run a command (\(e.message.prefix(40)))", command)
      throw e
    }
    if ctx.cancel.isSet { throw HandsOpError(code: "stopped", message: "Stopped.") }
    ctx.ev(["state": "running"])
    let r = try HandsRunProcess.run(command: command, cwd: cwd, timeout: timeout, cancel: ctx.cancel) { chunk in ctx.ev(["state": "running", "chunk": chunk]) }
    let out = HandsRunRules.capped(HandsRunRules.masked(r.output))
    ctx.log(r.stopped ? "ran a command (stopped)" : r.timedOut ? "ran a command (timed out)" : "ran a command (exit \(r.code.map(String.init) ?? "?"))", command)
    return ["exitCode": r.stopped || r.timedOut || r.code == nil ? NSNull() : r.code!, "output": out.text, "truncated": out.truncated, "seconds": (r.seconds * 10).rounded() / 10,
            "timedOut": r.timedOut, "stopped": r.stopped]
  }

  private func openThing(_ a: [String: Any], _ ctx: Ctx) throws -> [String: Any] {
    let plan = try HandsRunRules.openPlan(a["target"] as? String ?? "")
    var url: URL
    switch plan.kind {
    case .url:
      guard let u = URL(string: plan.target) else { throw HandsOpError(code: "denied_local", message: "That isn't a web address.") }
      url = u
    case .path:
      let p = HandsRunRules.expand(plan.target)
      var dir: ObjCBool = false
      guard FileManager.default.fileExists(atPath: p, isDirectory: &dir) else { throw HandsOpError(code: "not_found", message: "There is no such file or folder on this computer.") }
      // A program file, an app bundle or a script is never opened (macOS would run it).
      let real = URL(fileURLWithPath: p).resolvingSymlinksInPath()
      if HandsRunRules.openPlanRunnable(real.path) || (!dir.boolValue && FileManager.default.isExecutableFile(atPath: real.path)) || (dir.boolValue && NSWorkspace.shared.isFilePackage(atPath: real.path) && real.pathExtension.lowercased() == "app") {
        throw HandsOpError(code: "denied_local", message: "Opening a program or script file is refused (use a command the person approves, or open the app by its name).")
      }
      url = real
    case .app:
      if HandsRunRules.refusedApp(plan.target) { throw HandsOpError(code: "denied_local", message: "That app is never opened for Sara (it runs commands or changes the system). The person can open it themselves.") }
      guard let found = HandsRun.findApp(plan.target) else { throw HandsOpError(code: "not_found", message: "No app with that name is in Applications here.") }
      url = found
    }
    try approve(a, ctx, heading: "Sara wants to open something on this Mac", text: "Open \(plan.kind == .url ? "this address" : plan.kind == .path ? "this file or folder" : "this app"):\n\(plan.target)", readOnly: false, destructive: false)
    if ctx.cancel.isSet { throw HandsOpError(code: "stopped", message: "Stopped.") }
    var ok = false
    DispatchQueue.main.sync {
      if plan.kind == .app {
        // The launch is asynchronous: a failure is logged, the answer says it was asked to open.
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { app, err in if app == nil { NSLog("Sara run: couldn't open \(url.lastPathComponent): \(String(describing: err))") } }
        ok = true
      } else { ok = NSWorkspace.shared.open(url) }
    }
    guard ok else { throw HandsOpError(code: "error", message: "macOS couldn't open it.") }
    ctx.log(plan.kind == .url ? "opened an address" : plan.kind == .path ? "opened a file or folder" : "opened an app", plan.target)
    return ["opened": true, "kind": plan.kind.rawValue]
  }

  /// An app by its name in Applications (and Utilities, ~/Applications, the system's), never a path.
  static func findApp(_ name: String) -> URL? {
    let want = name.lowercased() + ".app"
    let fm = FileManager.default
    for dir in ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"] {
      guard let items = try? fm.contentsOfDirectory(atPath: dir) else { continue }
      if let hit = items.first(where: { $0.lowercased() == want }) { return URL(fileURLWithPath: dir).appendingPathComponent(hit) }
    }
    return nil
  }
}

extension HandsRunRules {
  static func openPlanRunnable(_ path: String) -> Bool { has(runnable, path) }
}

/// One command in its own process group: zsh -f -c, stdin /dev/null, stdout and stderr together.
enum HandsRunProcess {
  struct Result { var code: Int32?; var output: String; var seconds: Double; var timedOut: Bool; var stopped: Bool }

  static func run(command: String, cwd: String, timeout: Double, cancel: HandsCancel, onChunk: @escaping (String) -> Void) throws -> Result {
    var fds: [Int32] = [0, 0]
    guard pipe(&fds) == 0 else { throw HandsOpError(code: "error", message: "Couldn't start the command (no pipe).") }
    var fa: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&fa)
    posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_adddup2(&fa, fds[1], 1)
    posix_spawn_file_actions_adddup2(&fa, fds[1], 2)
    posix_spawn_file_actions_addchdir_np(&fa, cwd)
    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    // Its own process group (Stop ends the group), and nothing else of this app is inherited.
    posix_spawnattr_setpgroup(&attr, 0)
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
    var env = ProcessInfo.processInfo.environment
    // Opened from Finder an app has a short PATH: add Homebrew's, as a Terminal would have.
    let path = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
    env["PATH"] = (["/opt/homebrew/bin", "/usr/local/bin"].filter { !path.contains($0) } + [path]).joined(separator: ":")
    if env["LANG"] == nil { env["LANG"] = "en_US.UTF-8" }
    env["TERM"] = "dumb"
    for k in env.keys where k.hasPrefix("SARA_") { env[k] = nil }
    let args = ["/bin/zsh", "-f", "-c", command]
    var cargs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) } + [nil]
    var cenv: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer { for p in cargs { free(p) }; for p in cenv { free(p) } }
    var child: pid_t = 0
    let rc = posix_spawn(&child, "/bin/zsh", &fa, &attr, &cargs, &cenv)
    posix_spawn_file_actions_destroy(&fa)
    posix_spawnattr_destroy(&attr)
    Darwin.close(fds[1])
    guard rc == 0 else { Darwin.close(fds[0]); throw HandsOpError(code: "error", message: "Couldn't start zsh (error \(rc)).") }
    let started = Date()
    let om = NSLock()
    var all = Data(), pending = Data()
    let readerDone = DispatchSemaphore(value: 0)
    let reader = Thread {
      defer { readerDone.signal() }
      var buf = [UInt8](repeating: 0, count: 65536)
      while true {
        let n = read(fds[0], &buf, buf.count)
        if n <= 0 { break }
        om.lock()
        if all.count < HandsRunRules.outputChars * 4 { all.append(buf, count: n) }
        pending.append(buf, count: n)
        om.unlock()
      }
    }
    reader.start()
    var live = 0, lastFlush = Date.distantPast
    func flush() {
      om.lock(); let c = pending; pending = Data(); om.unlock()
      guard !c.isEmpty, live < HandsRunRules.liveChars else { return }
      var s = HandsRunRules.masked(String(decoding: c, as: UTF8.self))
      s = String(s.prefix(min(HandsRunRules.chunkChars, HandsRunRules.liveChars - live)))
      live += s.count
      onChunk(s)
    }
    var status: Int32 = 0
    var timedOut = false, stopped = false, exited = false
    var tree: [pid_t: String] = [:]
    var lastScan = Date.distantPast
    while true {
      let w = waitpid(child, &status, WNOHANG)
      if w == child { exited = true; break }
      if w < 0 { break }
      if Date().timeIntervalSince(lastScan) > 0.5 { lastScan = Date(); for (p, n) in descendants(of: child) { tree[p] = n } }
      if cancel.isSet { stopped = true; killTree(child, tree); }
      else if Date().timeIntervalSince(started) > timeout { timedOut = true; killTree(child, tree) }
      if Date().timeIntervalSince(lastFlush) > 0.25 { lastFlush = Date(); flush() }
      if stopped || timedOut { _ = waitpid(child, &status, 0); break }
      usleep(100_000)
    }
    // Whatever the command left running ends with it (c.open is for an app that should stay open).
    for (p, n) in descendants(of: child) { tree[p] = n }
    killTree(child, tree)
    _ = readerDone.wait(timeout: .now() + 3)
    Darwin.close(fds[0])
    flush()
    om.lock(); let text = String(decoding: all, as: UTF8.self); om.unlock()
    let code: Int32? = exited && (status & 0x7f) == 0 ? (status >> 8) & 0xff : nil
    return Result(code: stopped || timedOut ? nil : code, output: text, seconds: Date().timeIntervalSince(started), timedOut: timedOut, stopped: stopped)
  }

  /// Every process below `root` now (its name, to avoid killing a reused process id later).
  static func descendants(of root: pid_t) -> [pid_t: String] {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
    var size = 0
    guard sysctl(&mib, 4, nil, &size, nil, 0) == 0, size > 0 else { return [:] }
    let stride = MemoryLayout<kinfo_proc>.stride
    var procs = [kinfo_proc](repeating: kinfo_proc(), count: size / stride + 32)
    size = procs.count * stride
    guard sysctl(&mib, 4, &procs, &size, nil, 0) == 0 else { return [:] }
    let n = size / stride
    var kids: [pid_t: [pid_t]] = [:]
    var names: [pid_t: String] = [:]
    for i in 0..<n {
      let p = procs[i]
      kids[p.kp_eproc.e_ppid, default: []].append(p.kp_proc.p_pid)
      names[p.kp_proc.p_pid] = withUnsafeBytes(of: p.kp_proc.p_comm) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }
    var out: [pid_t: String] = [:]
    var stack = [root]
    while let p = stack.popLast(), out.count < 2000 {
      for c in kids[p] ?? [] where c != root && out[c] == nil { out[c] = names[c] ?? ""; stack.append(c) }
    }
    return out
  }
  /// The group, then each process that was seen below it (when it is still the same program).
  static func killTree(_ root: pid_t, _ seen: [pid_t: String]) {
    killpg(root, SIGKILL)
    kill(root, SIGKILL)
    let now = descendantsNames()
    for (p, n) in seen where p > 1 && now[p] == n { kill(p, SIGKILL) }
  }
  private static func descendantsNames() -> [pid_t: String] {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
    var size = 0
    guard sysctl(&mib, 4, nil, &size, nil, 0) == 0 else { return [:] }
    let stride = MemoryLayout<kinfo_proc>.stride
    var procs = [kinfo_proc](repeating: kinfo_proc(), count: size / stride + 32)
    size = procs.count * stride
    guard sysctl(&mib, 4, &procs, &size, nil, 0) == 0 else { return [:] }
    var names: [pid_t: String] = [:]
    for i in 0..<(size / stride) {
      let p = procs[i]
      if p.kp_eproc.e_ucred.cr_uid == getuid() { names[p.kp_proc.p_pid] = withUnsafeBytes(of: p.kp_proc.p_comm) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) } }
    }
    return names
  }
}
