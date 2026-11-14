// N5 (Mac parity with 3.4.x / 3.5.x Files): f.list and f.read on a Mac, READ ONLY. The rules are
// src/hands-files.ts's (the Windows app: desktop/windows/src/hands-files.cpp): only inside the allowed
// places ("roots": Desktop, Documents, Downloads by default; folders the person picks; the home folder;
// or all local volumes), never "..", full paths or "~"; the real path (links resolved) must stay inside
// the root; hidden names (dot names and the Finder's hidden flag) and secret-shaped names are left out
// and never read; system folders, Library (app data, keychains, browser profiles), other people's home
// folders and key stores stay out at any depth; 200 entries, text files up to 1 MB, 32,000 characters,
// key-shaped text masked. Nothing is ever written, moved, renamed, opened or deleted. The server hears
// only the roots' names, never their paths.
import AppKit
import Darwin

enum HandsFiles {
  static let maxEntries = 200, maxReadBytes = 1024 * 1024, maxChars = 32_000, maxPath = 1024
  static let scopes = ["three", "picked", "home", "drives"]
  private static let lock = NSLock()
  private static var scope = 0
  private static var picked: [String] = []
  private static var testRoot = ""

  static func setTestRoot(_ dir: String) { lock.lock(); testRoot = dir; lock.unlock() }
  static func setRoots(scope s: String, picked p: [String]) {
    lock.lock()
    scope = max(0, scopes.firstIndex(of: s) ?? 0)
    picked = Array(p.prefix(20))
    lock.unlock()
  }
  static var scopeName: String { lock.lock(); defer { lock.unlock() }; return scopes[scope] }

  struct Root { let name: String; let path: String }

  private static func known(_ key: String) -> String {
    lock.lock(); let t = testRoot; lock.unlock()
    if !t.isEmpty { return key == "home" ? t : t + "/" + ["desktop": "Desktop", "documents": "Documents", "downloads": "Downloads"][key, default: ""] }
    let fm = FileManager.default
    switch key {
    case "desktop": return fm.urls(for: .desktopDirectory, in: .userDomainMask)[0].path
    case "documents": return fm.urls(for: .documentDirectory, in: .userDomainMask)[0].path
    case "downloads": return fm.urls(for: .downloadsDirectory, in: .userDomainMask)[0].path
    default: return NSHomeDirectory()
    }
  }
  static func cleanName(_ raw: String) -> String {
    let o = String(raw.map { $0.unicodeScalars.first!.value < 0x20 || "\\/:*?\"<>|".contains($0) ? " " : $0 })
    return String(o.trimmingCharacters(in: .whitespaces).prefix(60))
  }
  /// The allowed places by name (the same naming as the Windows app: "Projects 2" for a second one).
  static func roots() -> [Root] {
    lock.lock(); let s = scope, p = picked, t = testRoot; lock.unlock()
    var out = ["desktop", "documents", "downloads"].map { Root(name: $0, path: known($0)) }
    func add(_ raw: String, _ path: String) {
      let base = raw.isEmpty ? "folder" : raw
      var n = base, i = 2
      while out.contains(where: { $0.name.lowercased() == n.lowercased() }) { n = "\(base) \(i)"; i += 1 }
      out.append(Root(name: n, path: path))
    }
    if s == 1 { for f in p { add(cleanName(URL(fileURLWithPath: f).lastPathComponent), f) } }
    if s >= 2 { out.append(Root(name: "home", path: known("home"))) }
    if s == 3 {
      if !t.isEmpty { add("drive T", t) } else {
        // Local volumes only (the startup disk and other disks on this Mac; never network volumes).
        let keys: [URLResourceKey] = [.volumeLocalizedNameKey, .volumeIsLocalKey, .volumeIsBrowsableKey]
        for v in FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: keys, options: [.skipHiddenVolumes]) ?? [] {
          guard let r = try? v.resourceValues(forKeys: Set(keys)), r.volumeIsLocal == true, r.volumeIsBrowsable != false else { continue }
          add(cleanName(r.volumeLocalizedName ?? v.lastPathComponent), v.path)
        }
      }
    }
    return out
  }
  static func rootList() -> String {
    roots().map { ["desktop": "Desktop", "documents": "Documents", "downloads": "Downloads"][$0.name] ?? $0.name }.joined(separator: ", ")
  }
  /// The roots for the hello (names only).
  static func rootNames() -> [String] { roots().map(\.name) }

  /// A root as given ("Desktop", "my documents", "projects", "home folder") → the root.
  static func rootOf(_ raw: String) -> Root? {
    var f = raw.lowercased().trimmingCharacters(in: .whitespaces)
    while let c = f.last, c == " " || c == ":" || c == "/" || c == "\\" { f.removeLast() }
    if f.hasPrefix("my ") { f = String(f.dropFirst(3)) }
    if f == "document" || f == "docs" { f = "documents" }
    if f == "download" { f = "downloads" }
    if f == "user folder" || f == "home folder" { f = "home" }
    return roots().first { $0.name.lowercased() == f }
  }

  static func hiddenName(_ n: String) -> Bool {
    let l = n.lowercased()
    return n.isEmpty || n.hasPrefix(".") || l == "desktop.ini" || l == "thumbs.db" || l == "$recycle.bin" || l.hasPrefix("ntuser.dat") || l == "icon\r"
  }
  private static let secretRes: [NSRegularExpression] = [
    "^\\.env(\\..*)?$", "^id_(rsa|dsa|ecdsa|ed25519)(\\.pub)?$", "\\.(pem|key|pfx|p12|ppk|kdbx|kdb|keychain|keychain-db|jks|keystore|gpg|asc|ovpn|sqlite-wal)$",
    "^wallet\\.dat$", "^\\.?netrc$", "^credentials(\\.json)?$", "^\\.?npmrc$", "^\\.?git-credentials$", "passwords?\\b", "recovery[ _-]?(codes?|key)", "seed[ _-]?phrase",
  ].map { try! NSRegularExpression(pattern: $0, options: [.caseInsensitive]) }
  static func secretName(_ n: String) -> Bool { secretRes.contains { $0.firstMatch(in: n, range: NSRange(n.startIndex..., in: n)) != nil } }
  /// src/hands-files.ts BLOCKED_DIRS plus the Mac's own system folders.
  static let blockedDirs: Set<String> = [
    "windows", "program files", "program files (x86)", "programdata", "appdata", "application data", "local settings", "$recycle.bin", "system volume information", "recovery", "perflogs", "config.msi", "msocache", "$windows.~bt", "$windows.~ws", "windows.old", "documents and settings", "boot", "efi",
    "library", "user data", "mozilla", "thunderbird",
    "1password", "bitwarden", "keepass", "keepassxc", "lastpass", "dashlane", "enpass", "password store", "passwords", "electrum", "exodus", "wallets", "wallet", "bitcoin", "ethereum", "monero",
    // macOS
    "system", "private", "usr", "bin", "sbin", "cores", "dev", "etc", "var", "tmp", "opt", "volumes", "network", "applications", "mobilebackups", "backups.backupdb", "keychains",
  ]
  static func blockedDir(_ n: String) -> Bool { blockedDirs.contains(n.lowercased().trimmingCharacters(in: .whitespaces)) }

  /// The Finder's hidden flag or a hidden/system file (stat flags), without following a link.
  static func flaggedHidden(_ path: String) -> Bool {
    var st = stat()
    guard lstat(path, &st) == 0 else { return false }
    return st.st_flags & UInt32(UF_HIDDEN) != 0
  }
  static func realPath(_ p: String) -> String? {
    guard let r = realpath(p, nil) else { return nil }
    defer { free(r) }
    return String(cString: r)
  }
  static func inside(_ root: String, _ full: String) -> Bool {
    let r = root.hasSuffix("/") && root.count > 1 ? String(root.dropLast()) : root
    if r == "/" { return full.hasPrefix("/") }
    return full == r || full.hasPrefix(r + "/")
  }
  /// Another person's home folder (/Users/robin…): never entered. The person's own and Shared are fine.
  static func otherUser(_ full: String) -> Bool {
    lock.lock(); let t = testRoot; lock.unlock()
    if !t.isEmpty { return false }
    guard let home = realPath(NSHomeDirectory()) else { return false }
    let users = (home as NSString).deletingLastPathComponent, me = (home as NSString).lastPathComponent.lowercased()
    guard full.lowercased().hasPrefix(users.lowercased() + "/") else { return false }
    let who = String(full.dropFirst(users.count + 1).split(separator: "/").first ?? "").lowercased()
    return !who.isEmpty && who != me && who != "shared"
  }
  /// Below the root: a blocked folder, a hidden or secret name at any depth, or another person's folder.
  static func blockedArea(_ rootReal: String, _ full: String) -> Bool {
    let r = rootReal == "/" ? "" : rootReal
    if full.count > r.count + 1 {
      for part in full.dropFirst(r.count + 1).split(separator: "/") {
        let p = String(part)
        if blockedDir(p) || hiddenName(p) || secretName(p) { return true }
      }
    }
    return otherUser(full)
  }
  static let blockedWhy = "That is a system folder, another person's folder or a place that holds keys or passwords: it is never read."

  /// The relative path's parts: no "..", ".", leading slashes, "~", colons or backslashes.
  static func cleanParts(_ raw: String) throws -> [String] {
    let s = raw.trimmingCharacters(in: .whitespaces)
    if s.isEmpty { return [] }
    func no(_ m: String) -> HandsOpError { HandsOpError(code: "denied_local", message: m) }
    guard s.count <= maxPath else { throw no("That path is too long.") }
    if s.unicodeScalars.contains(where: { $0.value < 0x20 }) || s.contains(where: { "<>\"|?*".contains($0) }) { throw no("That path has characters a file name can't have.") }
    if s.hasPrefix("/") || s.hasPrefix("\\") || s.hasPrefix("~") || s.contains(":") { throw no("Only a path inside one of the allowed folders (like \"Projects/notes.txt\"), never a full path or another disk.") }
    var parts: [String] = []
    for p in s.split(whereSeparator: { $0 == "/" || $0 == "\\" }).map(String.init) where !p.isEmpty {
      if p.allSatisfy({ $0 == "." }) { throw no("Only folders inside the allowed folders: \"..\" is not allowed.") }
      parts.append(p)
    }
    return parts
  }

  struct Resolved { let root: Root; let rootReal: String; let full: String; let parts: [String]; let isDir: Bool }
  static func resolve(_ folder: String, _ path: String) throws -> Resolved {
    guard let root = rootOf(folder) else { throw HandsOpError(code: "denied_local", message: "Only these folders: \(rootList()).") }
    let parts = try cleanParts(path)
    for p in parts where hiddenName(p) || secretName(p) { throw HandsOpError(code: "denied_local", message: "That file or folder is hidden or looks like it holds secrets (keys, passwords): it is never read.") }
    for p in parts where blockedDir(p) { throw HandsOpError(code: "denied_local", message: blockedWhy) }
    guard let rootReal = realPath(root.path) else { throw HandsOpError(code: "not_found", message: "That folder isn't on this computer.") }
    let joined = ([rootReal == "/" ? "" : rootReal] + parts).joined(separator: "/")
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: joined.isEmpty ? "/" : joined, isDirectory: &isDir) else { throw HandsOpError(code: "not_found", message: "There is no such file or folder there.") }
    if !parts.isEmpty && flaggedHidden(joined) { throw HandsOpError(code: "denied_local", message: "That file or folder is hidden: it is never read.") }
    guard let full = realPath(joined.isEmpty ? "/" : joined) else { throw HandsOpError(code: "not_found", message: "There is no such file or folder there.") }
    // A link that leads outside the folder is never followed.
    guard inside(rootReal, full) else { throw HandsOpError(code: "denied_local", message: "That points outside the folder (a link): it is never followed.") }
    if blockedArea(rootReal, full) { throw HandsOpError(code: "denied_local", message: blockedWhy) }
    return Resolved(root: root, rootReal: rootReal, full: full, parts: parts, isDir: isDir.boolValue)
  }
  static func iso(_ t: timespec) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f.string(from: Date(timeIntervalSince1970: TimeInterval(t.tv_sec)))
  }

  static func list(_ folder: String, _ path: String) throws -> [String: Any] {
    let r = try resolve(folder, path)
    guard r.isDir else { throw HandsOpError(code: "not_found", message: "That is a file, not a folder (read it instead).") }
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: r.full) else { throw HandsOpError(code: "not_found", message: "That folder can't be read.") }
    struct Entry { let name: String; let dir: Bool; let bytes: Int64; let at: timespec }
    var all: [Entry] = []
    var hidden = 0
    for n in names {
      let p = (r.full == "/" ? "" : r.full) + "/" + n
      var st = stat()
      guard lstat(p, &st) == 0 else { continue }
      if hiddenName(n) || secretName(n) || blockedDir(n) || st.st_flags & UInt32(UF_HIDDEN) != 0 || otherUser(p) { hidden += 1; continue }
      var dir = (st.st_mode & S_IFMT) == S_IFDIR
      // Links: listed only when they stay inside the folder (never followed out).
      if (st.st_mode & S_IFMT) == S_IFLNK {
        guard let real = realPath(p), inside(r.rootReal, real), !blockedArea(r.rootReal, real) else { hidden += 1; continue }
        var t = stat()
        if stat(real, &t) == 0 { dir = (t.st_mode & S_IFMT) == S_IFDIR }
      }
      if all.count < 5000 { all.append(Entry(name: n, dir: dir, bytes: dir ? 0 : Int64(st.st_size), at: st.st_mtimespec)) }
    }
    all.sort { $0.dir != $1.dir ? $0.dir : $0.name.lowercased() < $1.name.lowercased() }
    let entries: [[String: Any]] = all.prefix(maxEntries).map { e in
      var o: [String: Any] = ["name": handsMask(e.name), "dir": e.dir, "at": iso(e.at)]
      if !e.dir { o["bytes"] = e.bytes }
      return o
    }
    return ["folder": r.root.name, "path": r.parts.joined(separator: "/"), "entries": entries, "total": all.count, "more": all.count > maxEntries, "hidden": hidden]
  }

  static let textTypes: Set<String> = ["txt", "md", "markdown", "csv", "tsv", "json", "log", "xml", "html", "htm", "ini", "cfg", "conf", "yaml", "yml", "toml", "srt", "vtt", "text"]

  static func read(_ folder: String, _ path: String, maxChars mc: Int = 0) throws -> [String: Any] {
    let r = try resolve(folder, path)
    guard let last = r.parts.last else { throw HandsOpError(code: "denied_local", message: "Say which file (its path inside the folder).") }
    guard !r.isDir else { throw HandsOpError(code: "not_found", message: "That is a folder (list it instead).") }
    guard textTypes.contains((last as NSString).pathExtension.lowercased()) else { throw HandsOpError(code: "denied_local", message: "Only text files can be read (.txt, .md, .csv, .json, .log, .xml, .html, .ini…). For a Word, PDF or picture file, ask the owner to send it in the chat.") }
    // Opened for reading only, never for writing; links are not followed at this step.
    let fd = open(r.full, O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else { throw HandsOpError(code: "not_found", message: "That file can't be opened.") }
    defer { close(fd) }
    // The open file's own path again (it can't have been swapped for a link in between).
    var buf = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    guard fcntl(fd, F_GETPATH, &buf) != -1 else { throw HandsOpError(code: "not_found", message: "That file can't be opened.") }
    let opened = String(cString: buf)
    guard inside(r.rootReal, opened), !blockedArea(r.rootReal, opened) else { throw HandsOpError(code: "denied_local", message: "That points outside the folder (a link): it is never followed.") }
    var st = stat()
    fstat(fd, &st)
    guard st.st_size <= maxReadBytes else { throw HandsOpError(code: "denied_local", message: "That file is \(st.st_size / 1024) KB: only text files up to 1 MB are read.") }
    var data = Data(count: Int(st.st_size))
    let got = data.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, Int(st.st_size)) }
    guard got >= 0 else { throw HandsOpError(code: "not_found", message: "That file can't be read.") }
    data = data.prefix(got)
    var text: String
    if data.count >= 2 && data[0] == 0xFF && data[1] == 0xFE { text = String(data: Data(data.dropFirst(2)), encoding: .utf16LittleEndian) ?? "" }  // UTF-16 text is text too
    else if data.contains(0) { throw HandsOpError(code: "denied_local", message: "That file is not text (it has binary data).") }
    else {
      if data.count >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF { data = data.dropFirst(3) }
      text = String(decoding: data, as: UTF8.self)
    }
    let maxC = min(maxChars, max(500, mc <= 0 ? maxChars : mc))
    let more = text.count > maxC
    if more { text = String(text.prefix(maxC)) }
    return ["folder": r.root.name, "path": r.parts.joined(separator: "/"), "name": handsMask(last), "bytes": Int64(st.st_size), "at": iso(st.st_mtimespec), "text": handsMask(text), "more": more]
  }

  /// A folder the person picked: a local folder, not inside a blocked area.
  static func pickable(_ path: String) -> String? {
    guard let real = realPath(path) else { return "That folder can't be read." }
    if let v = try? URL(fileURLWithPath: real).resourceValues(forKeys: [.volumeIsLocalKey]), v.volumeIsLocal == false { return "Only folders on this Mac's own disks (not network folders)." }
    // Another disk's folders are checked from that disk's top (/Volumes/<disk>).
    let parts = real.split(separator: "/").map(String.init)
    let base = parts.count >= 2 && parts[0] == "Volumes" ? "/Volumes/" + parts[1] : "/"
    if real != base && blockedArea(base, real) { return blockedWhy }
    return nil
  }
}
