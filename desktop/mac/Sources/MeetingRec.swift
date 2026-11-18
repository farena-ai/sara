// U2.7 (docs/MEETINGS.md "Record this computer", the Mac side of desktop/windows/src/meeting-rec.cpp): Library →
// Meetings → Record this computer on a Mac. The microphone (AVAudioEngine) and the Mac's own sound
// (ScreenCaptureKit's audio: Zoom, Teams, Meet or any call; this app's own sound left out) go into one 16 kHz
// 16-bit stereo WAV, microphone left (Speaker 1, the person) and the computer right (Speaker 2, the others),
// in Application Support/<bundle id>/meetings. Like Windows: both are mixed down to mono and resampled to 16 kHz
// here; the microphone is the clock (the computer sends nothing while nothing plays, so its side is padded
// with silence, and a queue more than a second ahead drifts back to a quarter second); at most 3 hours.
// macOS asks the person once for the microphone, and once for Screen & System Audio Recording: without that
// permission it records the microphone only and the page says how to allow it. The page reads the finished
// file by its token in pieces of at most 4 MB, then asks for it to be deleted; leftovers go after a week.
import AVFoundation
import CoreMedia
import ScreenCaptureKit

/// Linear resampling to 16 kHz, carrying its position across buffers (checked by --self-check).
struct RecResampler {
  let step: Double
  var pos = 0.0
  var last: Float = 0
  init(from rate: Double) { step = max(0.01, rate / Double(RecMix.rate)) }
  mutating func push(_ x: [Float]) -> [Float] {
    guard !x.isEmpty else { return [] }
    var out: [Float] = []
    out.reserveCapacity(Int(Double(x.count) / step) + 2)
    var t = pos
    while true {
      let i = Int(t.rounded(.down))
      if i + 1 >= x.count { break }
      let a = i < 0 ? last : x[i], b = x[i + 1]
      out.append(a + (b - a) * Float(t - Double(i)))
      t += step
    }
    pos = t - Double(x.count)
    last = x[x.count - 1]
    return out
  }
}

/// The stereo mix: microphone left, the computer's sound right (checked by --self-check).
final class RecMix {
  static let rate = 16000
  static let maxSeconds = 3 * 3600
  var sys: [Float] = []
  var frames = 0
  func pushSys(_ s: [Float]) {
    sys.append(contentsOf: s)
    if sys.count > RecMix.rate { sys.removeFirst(sys.count - RecMix.rate / 4) }
  }
  /// Each microphone sample takes the next computer sample (or silence); 16-bit little-endian frames.
  func pushMic(_ m: [Float]) -> Data {
    let n = min(m.count, max(0, RecMix.rate * RecMix.maxSeconds - frames))
    guard n > 0 else { return Data() }
    let k = min(n, sys.count)
    var pcm = [Int16](repeating: 0, count: n * 2)
    for i in 0..<n {
      pcm[i * 2] = RecMix.s16(m[i])
      pcm[i * 2 + 1] = i < k ? RecMix.s16(sys[i]) : 0
    }
    sys.removeFirst(k)
    frames += n
    return pcm.withUnsafeBufferPointer { Data(buffer: $0) }
  }
  static func s16(_ v: Float) -> Int16 { v.isFinite ? Int16(max(-32768, min(32767, (v * 32767).rounded()))) : 0 }
  static func header(dataBytes: Int) -> Data {
    var d = Data()
    func s(_ x: String) { d.append(contentsOf: Array(x.utf8)) }
    func u32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { d.append(contentsOf: $0) } }
    func u16(_ v: Int) { withUnsafeBytes(of: UInt16(v).littleEndian) { d.append(contentsOf: $0) } }
    s("RIFF"); u32(36 + dataBytes); s("WAVE")
    s("fmt "); u32(16); u16(1); u16(2); u32(rate); u32(rate * 4); u16(4); u16(16)
    s("data"); u32(dataBytes)
    return d
  }
}

enum RecAudio {
  /// Any float PCM buffer (interleaved or not) as mono.
  static func mono(_ buf: AVAudioPCMBuffer) -> [Float] {
    guard let ch = buf.floatChannelData else { return [] }
    let n = Int(buf.frameLength), c = max(1, Int(buf.format.channelCount)), stride = buf.stride
    var out = [Float](repeating: 0, count: n)
    if buf.format.isInterleaved {
      let p = ch[0]
      for i in 0..<n {
        var v: Float = 0
        for k in 0..<c { v += p[i * stride + k] }
        out[i] = v / Float(c)
      }
    } else {
      for k in 0..<c {
        let p = ch[k]
        for i in 0..<n { out[i] += p[i] }
      }
      if c > 1 { for i in 0..<n { out[i] /= Float(c) } }
    }
    return out
  }
  /// ScreenCaptureKit's audio sample buffer as mono, with its rate.
  static func mono(_ sb: CMSampleBuffer) -> ([Float], Double)? {
    guard let fd = CMSampleBufferGetFormatDescription(sb), let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd),
          let fmt = AVAudioFormat(streamDescription: asbd) else { return nil }
    let n = AVAudioFrameCount(CMSampleBufferGetNumSamples(sb))
    guard n > 0, let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: n) else { return nil }
    buf.frameLength = n
    guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sb, at: 0, frameCount: Int32(n), into: buf.mutableAudioBufferList) == noErr else { return nil }
    return (mono(buf), fmt.sampleRate)
  }
}

final class MeetingRec: NSObject, SCStreamOutput, SCStreamDelegate {
  static let shared = MeetingRec()
  private let q = DispatchQueue(label: "sara.meeting-rec")
  private var engine: AVAudioEngine?
  private var stream: SCStream?
  // On q: the open file, the mix and the resamplers.
  private var file: FileHandle?
  private var bytes = 0
  private var mix = RecMix()
  private var micRs: RecResampler?
  private var sysRs: RecResampler?
  private var path: String?
  private(set) var recording = false
  private(set) var loopback = false
  private var started = Date()
  private var lastPath: String?
  private var lastToken = ""

  static var folder: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent(Bundle.main.bundleIdentifier ?? "Sara").appendingPathComponent("meetings")
  }

  var status: [String: Any] {
    ["recording": recording, "seconds": recording ? Int(Date().timeIntervalSince(started)) : 0, "loopback": loopback]
  }

  /// Starts after the microphone permission; done(result, error) on the main thread. "mic": no microphone.
  func start(_ done: @escaping ([String: Any]?, String?) -> Void) {
    guard !recording else { return done(nil, "Already recording.") }
    AVCaptureDevice.requestAccess(for: .audio) { ok in
      DispatchQueue.main.async {
        guard ok else { return done(nil, "mic") }
        if let why = self.begin() { return done(nil, why) }
        self.startComputerSound { lb in
          done(["loopback": lb, "startedAt": ISO8601DateFormatter().string(from: self.started)], nil)
        }
      }
    }
  }

  private func begin() -> String? {
    sweep()
    let dir = MeetingRec.folder
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let f = DateFormatter()
    f.dateFormat = "yyyyMMdd-HHmmss"
    let p = dir.appendingPathComponent("rec-\(f.string(from: Date())).wav").path
    guard FileManager.default.createFile(atPath: p, contents: RecMix.header(dataBytes: 0), attributes: [.posixPermissions: 0o600]),
          let h = FileHandle(forWritingAtPath: p) else { return "Recording could not start: the file could not be made." }
    h.seekToEndOfFile()
    let eng = AVAudioEngine()
    let input = eng.inputNode
    let fmt = input.outputFormat(forBus: 0)
    guard fmt.channelCount > 0, fmt.sampleRate > 0 else {
      try? h.close()
      try? FileManager.default.removeItem(atPath: p)
      return "mic"
    }
    q.sync {
      file = h
      path = p
      bytes = 0
      mix = RecMix()
      micRs = RecResampler(from: fmt.sampleRate)
      sysRs = nil
    }
    input.installTap(onBus: 0, bufferSize: 4096, format: fmt) { [weak self] buf, _ in
      let m = RecAudio.mono(buf)
      self?.q.async { self?.takeMic(m) }
    }
    do { try eng.start() } catch {
      input.removeTap(onBus: 0)
      q.sync { try? file?.close(); file = nil }
      try? FileManager.default.removeItem(atPath: p)
      return "mic"
    }
    engine = eng
    started = Date()
    recording = true
    loopback = false
    return nil
  }

  /// The Mac's own sound through ScreenCaptureKit (needs Screen & System Audio Recording).
  private func startComputerSound(_ done: @escaping (Bool) -> Void) {
    guard CGPreflightScreenCaptureAccess() else {
      _ = CGRequestScreenCaptureAccess()  // macOS asks once; then the person allows it in System Settings
      return done(false)
    }
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, _ in
      DispatchQueue.main.async {
        guard self.recording, let content, let display = content.displays.first else { return done(false) }
        let me = content.applications.filter { $0.processID == getpid() }
        let filter = SCContentFilter(display: display, excludingApplications: me, exceptingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.excludesCurrentProcessAudio = true
        cfg.sampleRate = 48000
        cfg.channelCount = 2
        // The picture is not used: the smallest, slowest one.
        cfg.width = 2
        cfg.height = 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        cfg.showsCursor = false
        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        do {
          try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: self.q)
          try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.q)
        } catch { return done(false) }
        s.startCapture { err in
          DispatchQueue.main.async {
            guard err == nil else { return done(false) }
            guard self.recording else { s.stopCapture { _ in }; return done(false) }
            self.stream = s
            self.loopback = true
            done(true)
          }
        }
      }
    }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    // On q.
    guard type == .audio, file != nil, sb.isValid, let (m, rate) = RecAudio.mono(sb) else { return }
    if sysRs == nil { sysRs = RecResampler(from: rate) }
    mix.pushSys(sysRs!.push(m))
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    DispatchQueue.main.async { if self.stream === stream { self.stream = nil } }
  }

  private func takeMic(_ m: [Float]) {
    guard let h = file, var rs = micRs else { return }
    let s = rs.push(m)
    micRs = rs
    let d = mix.pushMic(s)
    guard !d.isEmpty else { return }
    h.write(d)
    bytes += d.count
  }

  /// Stops and finishes the file; the page reads it by the token.
  func stop() -> (path: String, size: Int, seconds: Int, token: String)? {
    guard recording else { return nil }
    recording = false
    engine?.inputNode.removeTap(onBus: 0)
    engine?.stop()
    engine = nil
    stream?.stopCapture { _ in }
    stream = nil
    return q.sync {
      guard let h = file, let p = path else { return nil }
      h.seek(toFileOffset: 0)
      h.write(RecMix.header(dataBytes: bytes))
      try? h.close()
      file = nil
      lastPath = p
      lastToken = UUID().uuidString
      return (p, 44 + bytes, mix.frames / RecMix.rate, lastToken)
    }
  }

  /// A piece of the last recording for the page (base64), only with its token.
  func read(token: String, at: Int, len: Int) -> String? {
    guard !token.isEmpty, token == lastToken, let p = lastPath, at >= 0, len > 0, let h = FileHandle(forReadingAtPath: p) else { return nil }
    defer { try? h.close() }
    h.seek(toFileOffset: UInt64(at))
    return h.readData(ofLength: min(len, 4 << 20)).base64EncodedString()
  }

  func discard() {
    if let p = lastPath { try? FileManager.default.removeItem(atPath: p) }
    lastPath = nil
    lastToken = ""
  }

  /// Recordings left behind (the page never sent them) go after a week.
  func sweep() {
    let dir = MeetingRec.folder
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
    for n in names where n.hasPrefix("rec-") && n.hasSuffix(".wav") {
      let p = dir.appendingPathComponent(n).path
      if let m = (try? FileManager.default.attributesOfItem(atPath: p))?[.modificationDate] as? Date, Date().timeIntervalSince(m) > 7 * 24 * 3600 {
        try? FileManager.default.removeItem(atPath: p)
      }
    }
  }
}
