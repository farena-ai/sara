// U2.7 / U2.8 (docs/design/ROADMAP_U.md, docs/desktop.md → The Mac app catches up (U2)): the Mac app's Dock badge
// (the same one-to-one unread + mentions count as the sidebar pill), Record this computer on a Mac
// (ScreenCaptureKit's audio + the microphone, mic left / computer sound right, the consent tick on the page), and
// quick ask with the selected text or this window. Static checks on the Swift sources (no Swift on this PC; the Mac's
// own `Sara --self-check` runs the Swift rules there) plus the page side of the bridge run in a sandbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const swift = (f: string) => read('desktop', 'mac', 'Sources', f);
const u2 = () => swift('AppU2.swift');
const rec = () => swift('MeetingRec.swift');
const mainSwift = () => swift('main.swift');

/** The JavaScript in a Swift `let name = """ … """` string. */
function swiftString(src: string, name: string): string {
  const a = src.indexOf(`let ${name} = """`);
  assert.ok(a >= 0, `missing ${name}`);
  const start = src.indexOf('\n', a) + 1;
  const end = src.indexOf('"""', start);
  const body = src.slice(start, end);
  assert.ok(!body.includes('\\'), `${name}: no backslashes (Swift would read them as escapes)`);
  return body;
}

/** Runs the Mac shims in a sandbox with a fake WebKit bridge; returns the window and the posted messages. */
function macPage(answer: (m: Record<string, unknown>) => unknown) {
  const posted: Record<string, unknown>[] = [];
  const events: { type: string; detail: unknown }[] = [];
  const win: Record<string, unknown> = {
    webkit: { messageHandlers: { sara: { postMessage: (m: Record<string, unknown>) => (posted.push(m), Promise.resolve(answer(m))) } } },
    dispatchEvent: (e: { type: string; detail: unknown }) => events.push(e),
  };
  win.window = win;
  const ctx = vm.createContext({
    window: win,
    webkit: win.webkit,
    atob: (s: string) => Buffer.from(s, 'base64').toString('latin1'),
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, o: { detail: unknown }) {
        this.type = type;
        this.detail = o.detail;
      }
    },
    Uint8Array,
    Math,
    Number,
    String,
    Date,
    Error,
    Promise,
  });
  vm.runInContext(swiftString(mainSwift(), 'shim'), ctx);
  vm.runInContext(swiftString(u2(), 'u2Shim'), ctx);
  return { win, posted, events, ctx };
}

test('Dock badge: the page sends the sidebar count, the Mac app shows it on the Dock icon', () => {
  // The page: the same number as the sidebar pill (one-to-one unread + community mentions, src/messages.ts).
  const msgs = read('web', 'messages.js');
  const paint = msgs.slice(msgs.indexOf('function paintBadge('), msgs.indexOf('// The tab title keeps'));
  assert.match(paint, /window\.SaraDesktop\?\.badge\?\.\(sentBadge\)/);
  assert.match(read('src', 'messages.ts'), /one-to-one unread plus community mentions/);
  // The app: NSApp.dockTile.badgeLabel, "99+" above 99, nothing at 0; only from her own server's page.
  const s = u2();
  assert.match(s, /NSApp\.dockTile\.badgeLabel = DockBadge\.label\(/);
  assert.match(s, /static func label\(_ n: Int\) -> String\? \{[^}]*n <= 0[^}]*nil[^}]*n > 99 \? "99\+"/s);
  const m = mainSwift();
  const guard = m.indexOf('guard fromServer else');
  assert.ok(guard > 0 && m.indexOf('u2Call(kind, body, replyHandler)') > guard, 'badge and recording only after the fromServer guard');
  // A new page (another server, signed out, reload) starts with no badge until its page says otherwise.
  assert.match(s, /didCommit navigation: WKNavigation!\)[\s\S]{0,200}setDockBadge\(0\)/);
  assert.match(m, /addUserScript\(WKUserScript\(source: u2Shim, injectionTime: \.atDocumentStart, forMainFrameOnly: true\)\)/);
});

test('Dock badge shim: whole numbers only, and only when the count changes', async () => {
  const { win, posted } = macPage(() => true);
  const d = win.SaraDesktop as { badge: (n: unknown) => void; platform: string };
  assert.equal(d.platform, 'mac');
  d.badge(3);
  d.badge(3);
  d.badge('7.9');
  d.badge(-4);
  d.badge('x');
  assert.deepEqual(
    posted.map((p) => p.count),
    [3, 7, 0],
  );
  assert.ok(posted.every((p) => p.m === 'badge'));
});

test('Record this computer on a Mac: ScreenCaptureKit audio + microphone, 16 kHz stereo WAV like Windows', () => {
  const r = rec();
  assert.match(r, /import ScreenCaptureKit/);
  assert.match(r, /capturesAudio = true/);
  assert.match(r, /excludesCurrentProcessAudio = true/, 'her own voice and sounds are not the call');
  assert.match(r, /AVAudioEngine\(\)/, 'the microphone');
  assert.match(r, /static let rate = 16000/);
  assert.match(r, /static let maxSeconds = 3 \* 3600/);
  // The mic is the clock; the computer sound waits in a queue and drifts back after a second.
  assert.match(r, /if sys\.count > RecMix\.rate \{ sys\.removeFirst\(sys\.count - RecMix\.rate \/ 4\) \}/);
  // Leftovers are swept after a week; the page can only read the last recording, by its token, in capped pieces.
  assert.match(r, /7 \* 24 \* 3600/);
  assert.match(r, /token == lastToken/);
  assert.match(r, /min\(len, 4 << 20\)/);
  // Without the Screen & System Audio Recording permission it records the microphone only and says so.
  assert.match(r, /loopback = false/);
  const s = u2();
  for (const op of ['status', 'start', 'stop', 'discard', 'read']) assert.match(s, new RegExp(`case "${op}"`));
  assert.match(s, /window\.__saraMeetingFile\(/);
  // The microphone purpose names meetings now.
  assert.match(read('desktop', 'mac', 'Info.plist'), /NSMicrophoneUsageDescription<\/key><string>[^<]*Record this computer/);
});

test('Record this computer shim: the finished recording reaches the Meetings page as a file it reads in parts', async () => {
  const wav = Buffer.alloc(3 * 1048576 + 1234);
  for (let i = 0; i < wav.length; i++) wav[i] = (i * 7) & 255;
  const reads: { at: number; len: number }[] = [];
  const { win, events } = macPage((m) => {
    if (m.m === 'meetingRec' && m.op === 'read') {
      assert.equal(m.token, 'tok1');
      reads.push({ at: Number(m.at), len: Number(m.len) });
      return wav.subarray(Number(m.at), Number(m.at) + Number(m.len)).toString('base64');
    }
    return true;
  });
  assert.equal((win.SaraDesktop as { meetingRec: boolean }).meetingRec, true);
  (win.__saraMeetingFile as (m: unknown) => void)({ name: 'rec-1.wav', size: wav.length, lastModified: 5, token: 'tok1' });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'sara-meeting-file');
  const file = (events[0].detail as { file: { name: string; size: number; slice: (a: number, b: number) => { size: number; arrayBuffer: () => Promise<ArrayBuffer> } } }).file;
  assert.equal(file.name, 'rec-1.wav');
  assert.equal(file.size, wav.length);
  const part = file.slice(100, 100 + 2 * 1048576 + 10);
  assert.equal(part.size, 2 * 1048576 + 10);
  const got = Buffer.from(await part.arrayBuffer());
  assert.ok(got.equals(wav.subarray(100, 100 + 2 * 1048576 + 10)));
  assert.ok(reads.every((x) => x.len <= 1048576), 'one MiB per bridge call');
  // Past the end is cut to the file.
  assert.equal(file.slice(wav.length - 5, wav.length + 99).size, 5);
});

test('Meetings page: parts are read one at a time (a Mac recording is never all in memory) and the Mac gets its own help text', () => {
  const m = read('web', 'meetings.js');
  const parts = m.slice(m.indexOf('async function wavParts('), m.indexOf('/** Sends a recording part by part'));
  assert.match(parts, /parts\.push\(async \(\) => new Blob\(\[wavHeader\(w\.channels, w\.rate, n\), await file\.slice\(/);
  const send = m.slice(m.indexOf('async function sendRecording('), m.indexOf('// ----', m.indexOf('async function sendRecording(')));
  assert.match(send, /raw: await parts\[i\]\(\)/);
  assert.match(m, /System Settings → Privacy & Security → Microphone/);
  assert.match(m, /Screen & System Audio Recording/);
  assert.match(m, /res\?\.loopback !== false/);
});

test('Quick ask on a Mac: the selected text (never a password field) and this window, like Windows', () => {
  const q = swift('QuickAsk.swift');
  const c = swift('QuickContext.swift');
  assert.match(c, /kAXFocusedUIElementAttribute/);
  assert.match(c, /kAXSelectedTextAttribute/);
  assert.match(c, /AXSecureTextField/, 'never a password field');
  assert.match(c, /HandsScreen\.blockedKind/, 'never a window hidden from her hands (password managers, banking)');
  assert.match(c, /maxChars = 8000/);
  assert.match(c, /mask\(/);
  // The page gets the context on show and asks for the window picture with {a:'window'}.
  assert.match(q, /QuickContext\.capture\(/);
  assert.match(q, /saraQuick\.show\(/);
  assert.match(q, /case "window"/);
  assert.match(q, /saraQuick\.picture\(/);
});
