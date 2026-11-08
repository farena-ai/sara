import AVFoundation
import AppKit
import CryptoKit
import Foundation

// C17 (docs/ops/C17_DESIGN.md, docs/design/WAKE.md §6.2): Hey Sara on the Mac. The engine (sherpa-onnx's
// C API and onnxruntime, Apache-2.0) is inside the signed app (Contents/Frameworks, signed with it; the
// hardened runtime won't load a downloaded library); the 5.4 MB keyword model is downloaded from the
// pinned upstream tarball and every file is checked against these pins (the same as src/wake-pack.ts
// and the Windows and Android apps) before each load. The microphone (AVAudioEngine, 16 kHz mono via
// AVAudioConverter) feeds the spotter in memory; nothing is kept or sent before her phrase. Then the
// quick-ask page claims the wake, this records the question and hands it to the page, which sends it
// to /api/wake/turn with its own sign-in (the native side never holds the cookie, as on Windows).

struct WakeFile { let name: String; let size: Int; let sha256: String; let inTar: String }
let wakeModelDir = "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/"
let wakeFiles: [WakeFile] = [
  WakeFile(name: "encoder.int8.onnx", size: 4599656, sha256: "408bbd740838c42d5bf6d1c5b80b3c88b616c7860b92d980328b5b068c76ae48", inTar: wakeModelDir + "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx"),
  WakeFile(name: "decoder.onnx", size: 759829, sha256: "63a22dd60f40fff082ac3e09afa507f6787da36df76ded2fbe145fa233e22c21", inTar: wakeModelDir + "decoder-epoch-13-avg-2-chunk-16-left-64.onnx"),
  WakeFile(name: "joiner.int8.onnx", size: 86629, sha256: "190d4067b4cc20b72a42a1916e69d92052000fb7051a427ebb1bc72a69207dc1", inTar: wakeModelDir + "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx"),
  WakeFile(name: "tokens.txt", size: 1928, sha256: "2d3f32311f9b692b964da3c90e830258d3e78e013cb0c992dbfb15cd5a1a71b0", inTar: wakeModelDir + "tokens.txt"),
]
let wakeModelTar = (url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2", size: 32_885_699, sha256: "68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6")
let heySaraLines = "HH EY1 S EH1 R AH0 :1.5 #0.25 @W1\nHH EY1 S AA1 R AH0 :1.5 #0.25 @W1"

private typealias CreateFn = @convention(c) (UnsafePointer<SherpaOnnxKeywordSpotterConfig>?) -> OpaquePointer?
private typealias DestroyFn = @convention(c) (OpaquePointer?) -> Void
private typealias StreamFn = @convention(c) (OpaquePointer?) -> OpaquePointer?
private typealias AcceptFn = @convention(c) (OpaquePointer?, Int32, UnsafePointer<Float>?, Int32) -> Void
private typealias ReadyFn = @convention(c) (OpaquePointer?, OpaquePointer?) -> Int32
private typealias DecodeFn = @convention(c) (OpaquePointer?, OpaquePointer?) -> Void
private typealias ResultFn = @convention(c) (OpaquePointer?, OpaquePointer?) -> UnsafePointer<SherpaOnnxKeywordResult>?
private typealias FreeResultFn = @convention(c) (UnsafePointer<SherpaOnnxKeywordResult>?) -> Void

private struct Engine {
  let create: CreateFn, destroy: DestroyFn, stream: StreamFn, destroyStream: DestroyFn, accept: AcceptFn
  let ready: ReadyFn, decode: DecodeFn, result: ResultFn, freeResult: FreeResultFn, reset: DecodeFn

  /// The engine bundled in this app, or nil (a build without it: Hey Sara then says so).
  static let shared: Engine? = {
    guard let dir = Bundle.main.privateFrameworksPath, let h = dlopen(dir + "/libsherpa-onnx-c-api.dylib", RTLD_NOW | RTLD_LOCAL) else { return nil }
    func f<T>(_ name: String, _ type: T.Type) -> T? { dlsym(h, name).map { unsafeBitCast($0, to: type) } }
    guard let c = f("SherpaOnnxCreateKeywordSpotter", CreateFn.self), let d = f("SherpaOnnxDestroyKeywordSpotter", DestroyFn.self),
          let s = f("SherpaOnnxCreateKeywordStream", StreamFn.self), let ds = f("SherpaOnnxDestroyOnlineStream", DestroyFn.self),
          let a = f("SherpaOnnxOnlineStreamAcceptWaveform", AcceptFn.self), let r = f("SherpaOnnxIsKeywordStreamReady", ReadyFn.self),
          let de = f("SherpaOnnxDecodeKeywordStream", DecodeFn.self), let g = f("SherpaOnnxGetKeywordResult", ResultFn.self),
          let fr = f("SherpaOnnxDestroyKeywordResult", FreeResultFn.self), let re = f("SherpaOnnxResetKeywordStream", DecodeFn.self) else { return nil }
    return Engine(create: c, destroy: d, stream: s, destroyStream: ds, accept: a, ready: r, decode: de, result: g, freeResult: fr, reset: re)
  }()
}

final class Wake {
  enum Mode { case off, asleep, recording, speaking }
  static let shared = Wake()

  var onDetected: ((String) -> Void)?
  var onRecorded: (([Int16]) -> Void)?
  var onFailed: ((String) -> Void)?
  private(set) var mode: Mode = .off
  private var audio: AVAudioEngine?
  private let queue = DispatchQueue(label: "com.backstagecoding.sara.wake")
  private var kws: OpaquePointer?
  private var stream: OpaquePointer?
  private var cStrings: [UnsafeMutablePointer<CChar>] = []
  private var recorded: [Int16] = []
  private var floor: Float = 0.006, spoke = false, quietMs = 0.0, totalMs = 0.0

  static var engineInApp: Bool { Engine.shared != nil }
  static var packDir: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Sara/wake/1", isDirectory: true)
  }

  /// Every model file is there and matches its pin (checked each time).
  static func packReady() -> Bool {
    wakeFiles.allSatisfy { f in
      guard let d = try? Data(contentsOf: packDir.appendingPathComponent(f.name)), d.count == f.size else { return false }
      return sha256(d) == f.sha256
    }
  }
  static func sha256(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }

  /// Downloads the pinned model tarball, checks it, unpacks the four files with the system tar and checks each.
  static func installPack(done: @escaping (String?) -> Void) {
    let url = URL(string: wakeModelTar.url)!
    URLSession.shared.downloadTask(with: url) { tmp, _, err in
      guard let tmp, err == nil, let data = try? Data(contentsOf: tmp), data.count == wakeModelTar.size, sha256(data) == wakeModelTar.sha256 else {
        return DispatchQueue.main.async { done("The speech model download didn't match its fingerprint, so it wasn't used.") }
      }
      let fm = FileManager.default
      let work = fm.temporaryDirectory.appendingPathComponent("sara-wake-\(UUID().uuidString)")
      try? fm.createDirectory(at: work, withIntermediateDirectories: true)
      let tar = Process()
      tar.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
      tar.arguments = ["-xjf", tmp.path, "-C", work.path] + wakeFiles.map { $0.inTar }
      do { try tar.run(); tar.waitUntilExit() } catch {}
      try? fm.createDirectory(at: packDir, withIntermediateDirectories: true)
      for f in wakeFiles {
        let dst = packDir.appendingPathComponent(f.name)
        try? fm.removeItem(at: dst)
        try? fm.moveItem(at: work.appendingPathComponent(f.inTar), to: dst)
      }
      try? fm.removeItem(at: work)
      DispatchQueue.main.async { done(packReady() ? nil : "The speech model didn't match what Sara expects, so it wasn't kept.") }
    }.resume()
  }
  static func removePack() { try? FileManager.default.removeItem(at: packDir) }

  var running: Bool { audio != nil }

  /// Asks for the microphone (macOS's own prompt, once), checks the pack, starts the detector.
  func start(keywords: String, done: @escaping (String?) -> Void) {
    guard let eng = Engine.shared else { return done("This build of the Mac app doesn't have the Hey Sara engine.") }
    guard Wake.packReady() else { return done("pack") }
    AVCaptureDevice.requestAccess(for: .audio) { ok in
      DispatchQueue.main.async {
        guard ok else { return done("mic") }
        if self.running { return done(nil) }
        guard self.makeSpotter(eng, keywords) else { return done("The keyword lines were refused.") }
        let a = AVAudioEngine()
        let input = a.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0, let out = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
              let conv = AVAudioConverter(from: inFormat, to: out) else { return done("mic") }
        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buf, _ in
          let cap = AVAudioFrameCount(Double(buf.frameLength) * 16000 / inFormat.sampleRate) + 32
          guard let o = AVAudioPCMBuffer(pcmFormat: out, frameCapacity: cap) else { return }
          var given = false
          _ = conv.convert(to: o, error: nil) { _, status in
            if given { status.pointee = .noDataNow; return nil }
            given = true
            status.pointee = .haveData
            return buf
          }
          guard let ch = o.floatChannelData?[0], o.frameLength > 0 else { return }
          let samples = Array(UnsafeBufferPointer(start: ch, count: Int(o.frameLength)))
          self?.queue.async { self?.take(samples) }
        }
        do { try a.start() } catch { input.removeTap(onBus: 0); return done("mic") }
        self.audio = a
        self.mode = .asleep
        done(nil)
      }
    }
  }

  /// Closes the microphone (the orange dot goes away) and frees the detector.
  func stop() {
    audio?.inputNode.removeTap(onBus: 0)
    audio?.stop()
    audio = nil
    mode = .off
    queue.async { self.freeSpotter() }
  }

  func setMode(_ m: Mode) {
    queue.async {
      if m == .recording { self.recorded = []; self.floor = 0.006; self.spoke = false; self.quietMs = 0; self.totalMs = 0 }
      self.mode = m
    }
  }

  func setKeywords(_ k: String) {
    guard let eng = Engine.shared else { return }
    queue.async { _ = self.makeSpotter(eng, k) }
  }

  private func makeSpotter(_ e: Engine, _ keywords: String) -> Bool {
    freeSpotter()
    let dir = Wake.packDir.path
    func c(_ s: String) -> UnsafePointer<CChar> { let p = strdup(s)!; cStrings.append(p); return UnsafePointer(p) }
    var cfg = SherpaOnnxKeywordSpotterConfig()
    cfg.feat_config.sample_rate = 16000
    cfg.feat_config.feature_dim = 80
    cfg.model_config.transducer.encoder = c(dir + "/encoder.int8.onnx")
    cfg.model_config.transducer.decoder = c(dir + "/decoder.onnx")
    cfg.model_config.transducer.joiner = c(dir + "/joiner.int8.onnx")
    cfg.model_config.tokens = c(dir + "/tokens.txt")
    cfg.model_config.num_threads = 1
    cfg.model_config.provider = c("cpu")
    cfg.max_active_paths = 4
    cfg.num_trailing_blanks = 1
    cfg.keywords_score = 1.5
    cfg.keywords_threshold = 0.25
    let k = keywords.isEmpty ? heySaraLines : keywords
    cfg.keywords_buf = c(k)
    cfg.keywords_buf_size = Int32(k.utf8.count)
    kws = withUnsafePointer(to: &cfg) { e.create($0) }
    if let kws { stream = e.stream(kws) }
    return kws != nil && stream != nil
  }

  private func freeSpotter() {
    if let e = Engine.shared {
      if let stream { e.destroyStream(stream) }
      if let kws { e.destroy(kws) }
    }
    stream = nil
    kws = nil
    cStrings.forEach { free($0) }
    cStrings = []
  }

  /// On the wake queue: the detector while asleep (and "stop" while she speaks), the recording after the phrase.
  private func take(_ s: [Float]) {
    switch mode {
    case .off: return
    case .recording:
      recorded.append(contentsOf: s.map { Int16(max(-1, min(1, $0)) * 32767) })
      var sum: Float = 0
      for x in s { sum += x * x }
      let rms = (sum / Float(max(1, s.count))).squareRoot()
      let ms = Double(s.count) / 16
      totalMs += ms
      if rms > floor * 3 { spoke = true; quietMs = 0 } else { floor = floor * 0.98 + rms * 0.02; if spoke { quietMs += ms } }
      if (spoke && quietMs > 800) || totalMs > 15000 || (!spoke && totalMs > 5000) {
        let out = spoke ? recorded : []
        recorded = []
        mode = .speaking
        DispatchQueue.main.async { self.onRecorded?(out) }
      }
    case .asleep, .speaking:
      guard let e = Engine.shared, let kws, let stream else { return }
      s.withUnsafeBufferPointer { e.accept(stream, 16000, $0.baseAddress, Int32(s.count)) }
      while e.ready(kws, stream) != 0 {
        e.decode(kws, stream)
        guard let r = e.result(kws, stream) else { continue }
        if let k = r.pointee.keyword, k.pointee != 0 {
          let label = String(cString: k)
          e.reset(kws, stream)
          if (mode == .asleep && label.hasPrefix("W")) || (mode == .speaking && label == "STOP") {
            DispatchQueue.main.async { self.onDetected?(label) }
          }
        }
        e.freeResult(r)
      }
    }
  }

  /// A WAV file (16 kHz mono 16-bit) from samples.
  static func wav(_ s: [Int16]) -> Data {
    var d = Data()
    func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
    func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
    let n = UInt32(s.count * 2)
    d.append("RIFF".data(using: .ascii)!); u32(36 + n); d.append("WAVEfmt ".data(using: .ascii)!)
    u32(16); u16(1); u16(1); u32(16000); u32(32000); u16(2); u16(16)
    d.append("data".data(using: .ascii)!); u32(n)
    s.withUnsafeBufferPointer { d.append(Data(buffer: $0)) }
    return d
  }
}

// MARK: the app around it (settings page, quick-ask page, menu)

/// The Hey Sara item in the menu-bar menu (a check mark while it listens; one click turns it off).
var wakeMenuItem: NSMenuItem?

extension AppDelegate {
  var wakeOn: Bool { prefs.bool(forKey: "wakeOn") }

  func wakeStateDict(_ reason: String = "") -> [String: Any] {
    let st: String = Wake.shared.running ? (wakeLockedNow ? "paused" : "asleep") : (wakeOn ? "paused" : "off")
    return ["available": Wake.engineInApp, "on": wakeOn, "state": st, "reason": reason.isEmpty ? (wakeServerPause.isEmpty ? (wakeLockedNow ? "locked" : "") : wakeServerPause) : reason,
            "pack": ["installed": Wake.packReady(), "mb": 5] as [String: Any], "mics": [] as [Any], "mic": "", "sensitivity": prefs.string(forKey: "wakeSens") ?? "normal",
            "chime": prefs.object(forKey: "wakeChime") as? Bool ?? true, "personal": prefs.bool(forKey: "wakePersonal"),
            "locked": prefs.object(forKey: "wakeLocked") as? Bool ?? true, "shortcut": "off", "shortcuts": [["id": "off", "label": "Off"]] as [[String: String]],
            "label": Host.current().localizedName ?? "Mac", "platform": "mac"]
  }

  /// SaraDesktop.call('wake', {op, key, value}) from Settings → Hey Sara.
  func wakeCall(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
    let op = body["op"] as? String ?? ""
    if op == "state" { return reply(wakeStateDict(), nil) }
    if op == "try" { return reply(["hits": [] as [Any]] as [String: Any], nil) }
    guard op == "set" else { return reply(nil, "unknown") }
    let key = body["key"] as? String ?? ""
    let v = body["value"] as? String ?? ""
    switch key {
    case "on":
      if v == "1" && !Wake.packReady() {
        return Wake.installPack { err in
          if let err { return reply(nil, err) }
          prefs.set(true, forKey: "wakeOn")
          self.wakeApply()
          reply(self.wakeStateDict(), nil)
        }
      }
      prefs.set(v == "1", forKey: "wakeOn")
    case "remove":
      Wake.shared.stop()
      Wake.removePack()
      prefs.set(false, forKey: "wakeOn")
    case "sensitivity": prefs.set(v, forKey: "wakeSens")
    case "chime": prefs.set(v == "1", forKey: "wakeChime")
    case "personal": prefs.set(v == "1", forKey: "wakePersonal")
    case "locked": prefs.set(v == "1", forKey: "wakeLocked")
    default: break
    }
    wakeApply()
    reply(wakeStateDict(), nil)
  }

  /// From the quick-ask page: {a:'wake', what: claimed | speaking | done | config}.
  func wakeFromQuick(_ b: [String: Any]) {
    switch b["what"] as? String ?? "" {
    case "claimed": Wake.shared.setMode(.recording)
    case "speaking": Wake.shared.setMode(.speaking)
    case "done":
      if Wake.shared.running && prefs.object(forKey: "wakeChime") as? Bool ?? true { NSSound(named: "Pop")?.play() }
      Wake.shared.setMode(.asleep)
    case "config":
      let lines = b["lines"] as? String ?? ""
      if lines != wakeLines { wakeLines = lines; if Wake.shared.running { Wake.shared.setKeywords(lines) } }
      wakeCompanions = Dictionary((b["map"] as? String ?? "").split(separator: ";").compactMap { kv -> (String, String)? in
        let p = kv.split(separator: "=", maxSplits: 1).map(String.init)
        return p.count == 2 ? (p[0], p[1]) : nil
      }, uniquingKeysWith: { first, _ in first })
      wakeServerPause = b["paused"] as? String ?? ""
      if b["on"] as? String == "0" && b["known"] as? String == "1" && wakeOn {
        prefs.set(false, forKey: "wakeOn")  // switched off from another of his devices (or everywhere)
        postNotification(title: "Hey Sara is off on this Mac", body: "It was switched off from another of your devices. Switch it on again in Sara's Settings → Hey Sara.", conv: "")
      }
      wakeApply()
    default: break
    }
  }

  /// Listens when he switched it on and nothing pauses it (the server's word, his quiet hours, the locked screen).
  func wakeApply() {
    wakeWire()
    let want = wakeOn && wakeServerPause.isEmpty && !wakeLockedNow && Wake.engineInApp
    if want && !Wake.shared.running {
      Wake.shared.start(keywords: wakeLines) { err in
        if let err, err != "pack" { self.postNotification(title: "Hey Sara can't listen", body: err == "mic" ? "Allow the microphone for Sara: System Settings → Privacy & Security → Microphone." : err, conv: "") }
        wakeMenuItem?.state = Wake.shared.running ? .on : .off
      }
    } else if !want && Wake.shared.running {
      Wake.shared.stop()
    }
    wakeMenuItem?.state = want ? .on : .off
  }

  private func wakeWire() {
    guard Wake.shared.onDetected == nil else { return }
    Wake.shared.onDetected = { [weak self] label in
      guard let self, let quick = self.quick else { return }
      if label == "STOP" { quick.web?.evaluateJavaScript("window.saraQuick&&saraQuick.stopSpeaking()"); return }
      if prefs.object(forKey: "wakeChime") as? Bool ?? true { NSSound(named: "Tink")?.play() }
      Wake.shared.setMode(.off)  // nothing is kept until the page's claim wins (then "claimed" starts the recording)
      quick.show()
      let companion = self.wakeCompanions[label] ?? ""
      quick.web?.evaluateJavaScript("window.saraQuick&&saraQuick.woken({label:'\(label)',companion:'\(companion.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })'})")
    }
    Wake.shared.onRecorded = { [weak self] samples in
      guard let web = self?.quick?.web else { return }
      // Nothing said: a tenth of a second of silence, so the server ends it as "nothing" in the usual way.
      let s = samples.isEmpty ? [Int16](repeating: 0, count: 1600) : samples
      web.evaluateJavaScript("window.saraQuick&&saraQuick.heard('\(Wake.wav(s).base64EncodedString())')")
    }
    let dn = DistributedNotificationCenter.default()
    dn.addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in self?.wakeLockedNow = prefs.object(forKey: "wakeLocked") as? Bool ?? true; self?.wakeApply() }
    dn.addObserver(forName: Notification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in self?.wakeLockedNow = false; self?.wakeApply() }
  }

  @objc func toggleWakeFromMenu() {
    // One click off; on again only from Settings → Hey Sara (where the download and the notice are).
    if wakeOn { prefs.set(false, forKey: "wakeOn"); wakeApply() } else { openSettings() }
  }
}

/// Wake state the extension needs (an extension can't add stored properties).
private var wakeLinesStore = ""
private var wakeCompanionsStore: [String: String] = [:]
private var wakeServerPauseStore = ""
private var wakeLockedStore = false
extension AppDelegate {
  var wakeLines: String { get { wakeLinesStore } set { wakeLinesStore = newValue } }
  var wakeCompanions: [String: String] { get { wakeCompanionsStore } set { wakeCompanionsStore = newValue } }
  var wakeServerPause: String { get { wakeServerPauseStore } set { wakeServerPauseStore = newValue } }
  var wakeLockedNow: Bool { get { wakeLockedStore } set { wakeLockedStore = newValue } }
}
