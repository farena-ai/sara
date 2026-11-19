// W0.5 (docs/design/ROADMAP_W.md): Mac parity and the tray off switch for Always allow.
// (1) The Windows tray menu's "Always allow is on — Turn off" (only while it is on), through the quick-ask
//     page (the same sign-in and route as Settings: DELETE /api/computer/always).
// (2) The Mac app: Always allow everything on its own cards (one confirm, then no cards, capped at 7 days),
//     the screen companion port (same rules as src/screen-companion.ts, same bubble, same prefs bridge,
//     the Accessibility permission explained in plain words), and Turn off in the menu bar menu.
// (3) A light theme for the public share and legacy pages (prefers-color-scheme, theme.css's own variables).
// No Mac on this PC: the Swift parts are checked as source (the release build compiles them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ERROR_WORDS, FORM_WORDS, HANG_WORDS, SCREEN_WATCH } from '../src/screen-companion.ts';
import { shareLightCss } from '../src/routes/share.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const mac = (f: string) => read('desktop', 'mac', 'Sources', f);
const page = () => read('desktop', 'shared', 'quick-ask.html');

// ---------- (1) the quick-ask page tells the apps, and turns it off ----------

test('quick-ask page: the state says whether Always allow is on; alwaysOff() uses the normal route', () => {
  const p = page();
  assert.match(p, /api\('\/computer\/always'\)/, 'reads the switch through the normal route');
  assert.match(p, /always: alwaysOn/, 'the state message carries it');
  assert.match(p, /alwaysOff\(\) \{\s*return api\('\/computer\/always', \{ method: 'DELETE' \}\)/);
  assert.match(p, /saraQuick\.show\(\{theme, solid, shortcut\}\), saraQuick\.refresh\(\), saraQuick\.decide\(id, ok\), saraQuick\.alwaysOff\(\)/, 'documented in the header');
});

test('quick-ask page: alwaysOff() sends DELETE and refreshes; the state then says off', async () => {
  // The page's script in the same small stand-in as test/desktop-quickask-anywhere.test.ts.
  const html = page();
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  const first = script.slice(0, script.indexOf('// V4b: her presence orb'));
  const posted: Record<string, unknown>[] = [];
  const calls: { url: string; method: string }[] = [];
  class El {
    id: string; hidden = false; disabled = false; children: El[] = []; dataset: Record<string, string> = {}; style: Record<string, string> = {};
    textContent = ''; innerHTML = ''; value = ''; title = ''; placeholder = ''; className = ''; src = ''; alt = ''; type = ''; scrollTop = 0; scrollHeight = 0;
    classList = { toggle() {}, add() {}, remove() {} };
    onclick: null | (() => void) = null; onsubmit: null | ((e: unknown) => void) = null;
    constructor(id = '') { this.id = id; }
    append(...c: El[]) { this.children.push(...c); }
    appendChild(c: El) { this.children.push(c); return c; }
    insertBefore(c: El) { this.children.push(c); }
    remove() {}
    setAttribute() {}
    getAttribute() { return undefined; }
    addEventListener() {}
    focus() {}
    closest() { return new El(); }
    querySelector() { return new El(); }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { height: 100 }; }
  }
  const els: Record<string, El> = {};
  const byId = (id: string) => (els[id] ??= new El(id));
  let on = true;
  const respond = (data: unknown) => ({ ok: true, status: 200, json: async () => data, blob: async () => ({}), body: null });
  const fetchFn = async (url: string, opts: { method?: string } = {}) => {
    calls.push({ url, method: opts.method ?? 'GET' });
    if (url === '/api/session') return respond({ authenticated: true, demo: false, disclosureAccepted: true, identity: { name: 'Sara' }, privateLocal: false });
    if (url === '/api/computer/always') {
      if (opts.method === 'DELETE') on = false;
      return respond({ on });
    }
    if (url === '/api/conversations' || url === '/api/jobs') return respond([]);
    return respond({});
  };
  const sandbox: Record<string, unknown> = {
    document: { getElementById: byId, createElement: () => new El(), documentElement: { classList: { toggle() {} } }, body: { dataset: {} }, querySelector: () => new El() },
    window: { chrome: { webview: { postMessage: (m: Record<string, unknown>) => posted.push(m) } } },
    navigator: { userAgent: 'test', mediaDevices: null },
    fetch: fetchFn, ResizeObserver: class { observe() {} }, EventSource: class { addEventListener() {} close() {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, AbortController, TextDecoderStream: class {}, Blob, URL, atob,
    addEventListener() {}, console,
    Image: class { onerror: null | (() => void) = null; set src(_v: string) { queueMicrotask(() => this.onerror?.()); } },
  };
  sandbox.window = Object.assign(sandbox.window as object, sandbox);
  vm.runInNewContext(first, sandbox);
  const sq = (sandbox.window as { saraQuick: Record<string, (...a: unknown[]) => Promise<unknown>> }).saraQuick;
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  await sq.refresh();
  await settle();
  const states = () => posted.filter((m) => m.a === 'state' && m.signedIn === true);
  assert.equal(states().at(-1)?.always, true, 'the state says on');
  await sq.alwaysOff();
  await settle();
  assert.ok(calls.some((c) => c.url === '/api/computer/always' && c.method === 'DELETE'), 'DELETE /api/computer/always');
  assert.equal(states().at(-1)?.always, false, 'and then it says off');
});

// ---------- (1) Windows tray ----------

test('Windows tray: "Always allow is on — Turn off" only while on, through the quick-ask page', () => {
  const c = read('desktop', 'windows', 'src', 'main.cpp');
  assert.match(c, /bool online = false, signedIn = false, demo = false, always = false;/);
  assert.match(c, /n\.always = m\[L"always"\] == L"true";/);
  const menu = c.slice(c.indexOf('HMENU m = CreatePopupMenu();\n  UINT needsServer'), c.indexOf('TrackPopupMenu(m, TPM_RIGHTBUTTON'));
  assert.match(menu, /if \(g_now\.always && g_now\.signedIn && !g_now\.demo\) AppendMenuW\(m, MF_STRING, ID_ALWAYS_OFF, L"Always allow is on \\u2014 Turn off"\);/);
  assert.match(c, /case ID_ALWAYS_OFF: alwaysOffFromTray\(\); break;/);
  const fn = c.slice(c.indexOf('static void alwaysOffFromTray() {'), c.indexOf('static void alwaysOffFromTray() {') + 600);
  assert.match(fn, /saraQuick\.alwaysOff/);
  assert.match(fn, /g_now\.always = false;/, 'the menu drops the item at once');
});

// ---------- (2) Mac: Always allow on its own cards ----------

test('Mac desktop actions: allowAll confirmed once on its own card, then no card (capped at 7 days)', () => {
  const h = mac('Hands.swift');
  assert.match(h, /var allGrants: \[String: Date\] = \[:\]/, 'key -> until');
  const op = h.slice(h.indexOf('private func desktopOp('), h.indexOf('// MARK: the ops'));
  assert.match(op, /let allKey = String\(\(a\["allowAll"\] as\? String \?\? ""\)\.prefix\(160\)\)/);
  assert.match(op, /let allOn = !allKey\.isEmpty && allGrants\[allKey\] != nil/);
  assert.match(op, /if once \|\| !granted, !allOn \{/);
  assert.match(op, /allChoice: !allKey\.isEmpty/);
  assert.match(op, /if answer == 3 && !allKey\.isEmpty \{ lock\.lock\(\); allGrants\[allKey\] = Date\(\)\.addingTimeInterval\(Hands\.allowAllSeconds\(a\["allowAllMs"\]\)\); lock\.unlock\(\)/);
  assert.match(h, /static func allowAllSeconds\(_ v: Any\?\) -> TimeInterval \{/);
  assert.match(h, /min\(max\(ms, 60_000\), 7 \* 24 \* 3_600_000\) \/ 1000/);
  // Expired keys go.
  assert.match(op, /allGrants = allGrants\.filter \{ \$0\.value > Date\(\) \}/);
  // The tab switch (d.tabswitch) follows the same rule.
  const tabs = h.slice(h.indexOf('private func tabsOp('), h.indexOf('private func desktopOp('));
  assert.match(tabs, /allChoice: !allKey\.isEmpty/);
  // The card's button and its answer (3).
  const d = mac('HandsDesktop.swift');
  assert.match(d, /static func ask\(_ summary: String, taskChoice: Bool, allChoice: Bool = false, test: Bool, cancel: HandsCancel\) -> Int \{/);
  assert.match(d, /alert\.addButton\(withTitle: "Always allow everything"\)/);
  assert.match(d, /answer = 3/);
});

test('Mac commands: allowAll runs every command (also destructive) after one confirm on the card', () => {
  const r = mac('HandsRun.swift');
  assert.match(r, /private var allGrants: \[String: Date\] = \[:\]/);
  const ap = r.slice(r.indexOf('private func approve('), r.indexOf('private func runCommand('));
  assert.match(ap, /let allKey = String\(\(a\["allowAll"\] as\? String \?\? ""\)\.prefix\(160\)\)/);
  assert.match(ap, /if !allKey\.isEmpty && allGrants\[allKey\] != nil \{ lock\.unlock\(\); return \}/);
  assert.match(ap, /allChoice: !allKey\.isEmpty/);
  assert.match(ap, /if answer == 3 && !allKey\.isEmpty/);
  assert.match(r, /if allChoice \{ button\("Always allow everything", 3,/);
  // Turning the app's commands off forgets them too.
  assert.match(r, /if level != self\.level \|\| !on \{ grants\.removeAll\(\); allGrants\.removeAll\(\) \}/);
});

test('Mac menu bar: "Always allow is on — Turn off" only while on, through the quick-ask page', () => {
  const q = mac('QuickAsk.swift');
  assert.match(q, /var always = false/);
  assert.match(q, /always = signedIn && !demo && b\["always"\] as\? Bool == true/);
  assert.match(q, /func alwaysOff\(\) \{/);
  assert.match(q, /saraQuick\.alwaysOff/);
  const m = mac('main.swift');
  assert.match(m, /refreshAlwaysItem\(in: menu\)/);
  assert.match(q, /"Always allow is on — Turn off"/);
  assert.match(q, /@objc func alwaysOffFromMenu\(\) \{ quick\?\.alwaysOff\(\) \}/);
  assert.match(q, /guard q\.always, q\.signedIn, !q\.demo else \{ return \}/);
});

// ---------- (2) Mac: the screen companion ----------

test('Mac screen companion: the same word lists and numbers as src/screen-companion.ts', () => {
  const s = mac('ScreenWatch.swift');
  for (const w of [...ERROR_WORDS, ...FORM_WORDS, ...HANG_WORDS]) assert.ok(s.includes(`"${w.replace(/"/g, '\\"')}"`), `missing in ScreenWatch.swift: ${w}`);
  for (const [k, v] of Object.entries(SCREEN_WATCH)) assert.match(s, new RegExp(`static let ${k} = ${v}\\b`), k);
  // FNV-1a over UTF-16 code units, like the reference and the Windows port.
  assert.match(s, /var h: UInt32 = 0x811c9dc5/);
  assert.match(s, /for u in s\.utf16 \{ h \^= UInt32\(u\); h = h &\* 0x01000193 \}/);
  // Never hidden or Sara's own windows, never a secure field or a typed value.
  assert.match(s, /HandsScreen\.blockedKind\(/);
  assert.match(s, /HandsScreen\.isSara\(/);
  assert.match(s, /AXSecureTextField/);
  assert.match(s, /handsMask\(/);
  // Nothing written or sent: no file or network code in the watch.
  assert.doesNotMatch(s, /URLSession|FileManager|\.write\(|UserDefaults|NSLog\(/);
});

test('Mac screen companion: prefs bridge, the bubble, the menu, the permission in plain words', () => {
  const m = mac('main.swift');
  assert.match(m, /case "screenCompanion":/);
  assert.match(m, /case "screenPause":/);
  assert.match(m, /guard n == 0 \|\| n == 60 else \{ return replyHandler\(nil, "0 or 60 minutes\."\) \}/);
  assert.match(m, /screenPrefs\(&d\)/);
  const s = mac('ScreenWatch.swift');
  assert.match(s, /d\["screenCompanion"\] = /);
  assert.match(s, /d\["screenPausedMin"\] = /);
  assert.match(s, /d\["screenNeedsAccess"\] = /);
  // One look every 5 s on a background queue, none while paused, off, or quick ask is open.
  assert.match(s, /Timer\.scheduledTimer\(withTimeInterval: Double\(ScreenRules\.everyMs\) \/ 1000/);
  assert.match(s, /quick\?\.visible == true/);
  // The bubble: the quick-ask panel shown without taking the keyboard, gone after 30 s.
  const q = mac('QuickAsk.swift');
  assert.match(q, /func showOffer\(kind: String, app: String, line: String\) \{/);
  assert.match(q, /panel\.orderFrontRegardless\(\)/);
  assert.match(q, /saraQuick\.offer/);
  assert.match(q, /case "offer":/);
  assert.match(s, /30/);
  // Menu: pause / resume.
  assert.match(s, /"Pause the screen companion for 1 hour"/);
  assert.match(s, /"Resume the screen companion"/);
  // Settings: plain words about the permission and a button to the exact pane.
  const js = read('web', 'screen-companion.js');
  assert.match(js, /p\.screenNeedsAccess/);
  assert.match(js, /handsOpenPerm', \{ which: 'ax' \}/);
  assert.match(js, /Screen Recording is not needed/);
  assert.doesNotMatch(js, /Only in the Windows app for now\./, 'the Mac app has it now');
  const h = read('web', 'index.html');
  assert.match(h, /id="dk-screen-perm" type="button"/);
});

// ---------- (3) light theme for the public pages ----------

test('public pages: theme.css\'s light colours when the visitor\'s system is light', () => {
  const css = shareLightCss(join(ROOT, 'web'));
  assert.match(css, /^@media \(prefers-color-scheme: light\) \{/m);
  assert.match(css, /color-scheme: light;/);
  assert.match(css, /--surface-0: #faf7f5;/, 'the same values as theme.css');
  assert.doesNotMatch(css, /data-theme|data-accent/);
  // The share page shell (also the legacy page and the client portal) links it.
  const src = read('src', 'routes', 'share.ts');
  assert.match(src, /<link rel="stylesheet" href="\/s\/theme-light\.css" media="\(prefers-color-scheme: light\)">/);
  // share.css keeps to theme variables (no colours of its own).
  assert.doesNotMatch(read('web', 'share.css'), /#[0-9a-f]{3,8}\b|rgb\(/i);
});
