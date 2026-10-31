// Phase 94 (computer use CU7, docs/design/COMPUTER_USE.md §11 "Phase 94"; the rules are
// src/hands-checkup.ts): the READ-ONLY computer check-up on the Mac (op s.check). A fixed list of
// checks through documented APIs only; nothing from the server is run, nothing is written, deleted or
// opened. Startup: the person's and the computer's LaunchAgents (property-list names; the Login Items
// list itself isn't readable by an app without extra permissions); disks: URL volume capacities;
// folders: a bounded walk (entries and time limits, symbolic links never followed) of the person's
// known folders (macOS may ask once before Sara reads Documents, Desktop or Downloads; a refusal is
// "not checked"); updates: `softwareupdate --list --no-scan` (only what macOS found on its own last
// scan: no new scan, nothing installed) with a time limit; battery: IOPSCopyPowerSourcesInfo plus
// the AppleSmartBattery registry entry (cycle count, design and full-charge capacity); extensions:
// the manifests in the person's own Chrome / Edge / Brave profiles (shown, never changed); temporary
// files, caches and the Trash (sizes). This build answers s.apply with "unsupported": check-up
// changes are made by the person (Sara says where).
import Foundation
import IOKit
import IOKit.ps

enum HandsCheckup {
  static let walkEntries = 200_000
  static let walkSeconds = 4.0
  static let items = 100

  struct Size { var id: String; var name: String; var bytes: UInt64 = 0; var files: UInt64 = 0; var partial = false
    var json: [String: Any] { var o: [String: Any] = ["id": id, "name": name, "bytes": bytes, "files": files]; if partial { o["partial"] = true }; return o }
  }

  static func cut(_ s: String, _ n: Int = 120) -> String { String(s.prefix(n)) }
  static func no(_ why: String) -> [String: Any] { ["ok": false, "why": why] }

  /// A bounded walk: sizes only, never follows symbolic links, never opens a file.
  static func walk(_ id: String, _ name: String, _ url: URL, cancelled: () -> Bool) -> Size? {
    var s = Size(id: id, name: name)
    let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .isSymbolicLinkKey]
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else { return nil }
    guard (try? FileManager.default.contentsOfDirectory(atPath: url.path)) != nil else { return nil }  // no permission: not checked
    guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: keys, options: [], errorHandler: { _, _ in true }) else { return nil }
    let start = Date()
    var n = 0
    for case let f as URL in e {
      n += 1
      if n > walkEntries || (n % 512 == 0 && (Date().timeIntervalSince(start) > walkSeconds || cancelled())) { s.partial = true; break }
      guard let v = try? f.resourceValues(forKeys: Set(keys)) else { continue }
      if v.isSymbolicLink == true { e.skipDescendants(); continue }
      if v.isRegularFile == true { s.bytes += UInt64(v.fileSize ?? 0); s.files += 1 }
    }
    return s
  }

  static func startup() -> [String: Any] {
    var out: [[String: Any]] = []
    let home = FileManager.default.homeDirectoryForCurrentUser
    for (dir, prefix, whereTo) in [(home.appendingPathComponent("Library/LaunchAgents"), "agent:", "agent"), (URL(fileURLWithPath: "/Library/LaunchAgents"), "lagent:", "machine")] {
      guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { continue }
      for f in names.sorted() where f.hasSuffix(".plist") && out.count < items {
        let label = String(f.dropLast(6))
        // A job can be switched off in its own property list (Disabled = true).
        let plist = NSDictionary(contentsOf: dir.appendingPathComponent(f))
        let disabled = plist?["Disabled"] as? Bool == true
        out.append(["id": prefix + cut(label, 70), "name": cut(label), "where": whereTo, "enabled": !disabled])
      }
    }
    return ["ok": true, "items": out, "total": out.count]
  }

  static func disk() -> [String: Any] {
    let keys: [URLResourceKey] = [.volumeNameKey, .volumeTotalCapacityKey, .volumeAvailableCapacityForImportantUsageKey, .volumeAvailableCapacityKey, .volumeIsInternalKey]
    var vols: [[String: Any]] = []
    for u in FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: keys, options: [.skipHiddenVolumes]) ?? [] {
      guard let v = try? u.resourceValues(forKeys: Set(keys)), v.volumeIsInternal != false, let total = v.volumeTotalCapacity, total > 0 else { continue }
      let free = v.volumeAvailableCapacityForImportantUsage.map { Int($0) } ?? v.volumeAvailableCapacity ?? 0
      vols.append(["name": cut(v.volumeName ?? u.lastPathComponent, 40), "total": total, "free": max(0, free)])
      if vols.count >= 16 { break }
    }
    return vols.isEmpty ? no("the volumes could not be read") : ["ok": true, "volumes": vols]
  }

  static func folders(cancelled: () -> Bool) -> [String: Any] {
    let home = FileManager.default.homeDirectoryForCurrentUser
    var list: [[String: Any]] = []
    var denied = 0
    for (id, name) in [("downloads", "Downloads"), ("documents", "Documents"), ("desktop", "Desktop"), ("pictures", "Pictures"), ("videos", "Movies"), ("music", "Music")] {
      if cancelled() { break }
      if let s = walk(id, name, home.appendingPathComponent(name), cancelled: cancelled) { list.append(s.json) } else { denied += 1 }
    }
    return list.isEmpty && denied > 0 ? no("macOS didn't allow reading the folders (Privacy & Security → Files and Folders)") : ["ok": true, "folders": list]
  }

  static func updates() -> [String: Any] {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/softwareupdate")
    // Only what macOS found on its own last scan: no new scan, nothing downloaded or installed.
    p.arguments = ["--list", "--no-scan"]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = Pipe()
    do { try p.run() } catch { return no("Software Update could not be asked") }
    let until = Date().addingTimeInterval(20)
    while p.isRunning && Date() < until { Thread.sleep(forTimeInterval: 0.1) }
    if p.isRunning { p.terminate(); return no("Software Update didn't answer in time") }
    let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    var names: [String] = []
    var reboot = false
    for line in text.split(separator: "\n") {
      let l = line.trimmingCharacters(in: .whitespaces)
      if l.hasPrefix("Title:") {
        let title = l.dropFirst(6).split(separator: ",").first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        if !title.isEmpty && names.count < 20 { names.append(cut(title)) }
        if l.contains("Action: restart") { reboot = true }
      } else if l.hasPrefix("* Label:") && names.count < 20 && !text.contains("Title:") {
        names.append(cut(String(l.dropFirst(8)).trimmingCharacters(in: .whitespaces)))
      }
    }
    let pending = text.components(separatedBy: "* Label:").count - 1
    return ["ok": true, "pending": max(pending, 0), "reboot": reboot, "names": names, "source": "Software Update's last check"]
  }

  static func battery() -> [String: Any] {
    var out: [String: Any] = ["ok": true, "present": false]
    if let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(), let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] {
      for ps in list {
        guard let d = IOPSGetPowerSourceDescription(info, ps)?.takeUnretainedValue() as? [String: Any], d[kIOPSTypeKey] as? String == kIOPSInternalBatteryType else { continue }
        out["present"] = true
        if let cur = d[kIOPSCurrentCapacityKey] as? Int, let max = d[kIOPSMaxCapacityKey] as? Int, max > 0 { out["percent"] = min(100, cur * 100 / max) }
        out["charging"] = d[kIOPSIsChargingKey] as? Bool ?? false
      }
    }
    guard out["present"] as? Bool == true else { return out }
    let svc = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSmartBattery"))
    if svc != 0 {
      defer { IOObjectRelease(svc) }
      var props: Unmanaged<CFMutableDictionary>?
      if IORegistryEntryCreateCFProperties(svc, &props, kCFAllocatorDefault, 0) == KERN_SUCCESS, let p = props?.takeRetainedValue() as? [String: Any] {
        if let c = p["CycleCount"] as? Int { out["cycles"] = c }
        // mAh values: at the top level on Intel Macs, inside BatteryData on Apple silicon (where the top-level
        // MaxCapacity is a percentage, so a value of 100 or less is never taken as a capacity).
        let data = p["BatteryData"] as? [String: Any] ?? [:]
        let int = { (k: String) -> Int? in (p[k] as? Int) ?? (data[k] as? Int) }
        let full = int("AppleRawMaxCapacity") ?? int("NominalChargeCapacity") ?? ((p["MaxCapacity"] as? Int).flatMap { $0 > 100 ? $0 : nil }) ?? 0
        if let design = int("DesignCapacity"), design > 0, full > 100 { out["health"] = min(100, full * 100 / design) }
      }
    }
    return out
  }

  static func extensionName(_ dir: URL) -> String {
    guard let data = try? Data(contentsOf: dir.appendingPathComponent("manifest.json"), options: .alwaysMapped), data.count < 512 * 1024,
          let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let name = m["name"] as? String else { return "" }
    if name.hasPrefix("__MSG_"), name.hasSuffix("__") {
      let key = String(name.dropFirst(6).dropLast(2)).lowercased()
      for loc in [m["default_locale"] as? String ?? "", "en", "en_US"] where !loc.isEmpty {
        guard let d = try? Data(contentsOf: dir.appendingPathComponent("_locales/\(loc)/messages.json")), let msgs = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
        if let hit = msgs.first(where: { $0.key.lowercased() == key })?.value as? [String: Any], let v = hit["message"] as? String { return v }
      }
      return ""
    }
    return name
  }

  static func extensions() -> [String: Any] {
    let support = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
    var browsers: [[String: Any]] = []
    for (browser, path) in [("chrome", "Google/Chrome"), ("edge", "Microsoft Edge"), ("brave", "BraveSoftware/Brave-Browser")] {
      let root = support.appendingPathComponent(path)
      guard let profiles = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { continue }
      for prof in profiles.sorted() where (prof == "Default" || prof.hasPrefix("Profile ")) && browsers.count < 8 {
        let ext = root.appendingPathComponent(prof).appendingPathComponent("Extensions")
        guard let ids = try? FileManager.default.contentsOfDirectory(atPath: ext.path) else { continue }
        var list: [[String: Any]] = []
        for id in ids.sorted() where !id.hasPrefix(".") && id != "Temp" && list.count < 200 {
          let versions = (try? FileManager.default.contentsOfDirectory(atPath: ext.appendingPathComponent(id).path))?.filter { !$0.hasPrefix(".") }.sorted() ?? []
          guard let v = versions.last else { continue }
          let name = extensionName(ext.appendingPathComponent(id).appendingPathComponent(v))
          if !name.isEmpty { list.append(["id": cut(id, 64), "name": cut(name), "enabled": true]) }
        }
        browsers.append(["browser": browser, "profile": cut(prof, 60), "extensions": list])
      }
    }
    return ["ok": true, "browsers": browsers]
  }

  static func temp(cancelled: () -> Bool) -> [String: Any] {
    let home = FileManager.default.homeDirectoryForCurrentUser
    var places: [[String: Any]] = []
    if let s = walk("temp", "Temporary files", URL(fileURLWithPath: NSTemporaryDirectory()), cancelled: cancelled) { places.append(s.json) }
    var caches = Size(id: "browser-cache", name: "Browser caches")
    for p in ["Library/Caches/Google/Chrome", "Library/Caches/Microsoft Edge", "Library/Caches/BraveSoftware"] {
      if let s = walk("x", "x", home.appendingPathComponent(p), cancelled: cancelled) { caches.bytes += s.bytes; caches.files += s.files; caches.partial = caches.partial || s.partial }
    }
    places.append(caches.json)
    if let s = walk("caches", "App caches", home.appendingPathComponent("Library/Caches"), cancelled: cancelled) { places.append(s.json) }
    // The Trash needs Full Disk Access on recent macOS: without it, it is left out.
    if let s = walk("trash", "Trash", home.appendingPathComponent(".Trash"), cancelled: cancelled) { places.append(s.json) }
    return ["ok": true, "places": places]
  }

  /// s.check: the asked checks (empty: all), as src/hands-checkup.ts CheckData.
  static func check(_ asked: [String], cancelled: () -> Bool) -> [String: Any] {
    let want = { (k: String) in asked.isEmpty || asked.contains(k) }
    let v = ProcessInfo.processInfo.operatingSystemVersion
    var c: [String: Any] = [:]
    if want("startup") { c["startup"] = startup() }
    if want("disk") { c["disk"] = disk() }
    if want("folders") { c["folders"] = folders(cancelled: cancelled) }
    if want("updates") { c["updates"] = updates() }
    if want("battery") { c["battery"] = battery() }
    if want("extensions") { c["extensions"] = extensions() }
    if want("temp") { c["temp"] = temp(cancelled: cancelled) }
    return ["os": "mac \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)", "at": ISO8601DateFormatter().string(from: Date()), "checks": c]
  }
}
