// Phase 75 stage 2 (native): the Windows and Mac apps' quick-ask window (a global shortcut, a small
// floating window over any app), her face, mood and "Now" in the tray / menu bar menu, her mood in
// the tooltip (docs/design/NEW_LOOK.md → Native apps). Static checks on the sources: the page is
// shared, it talks to the server only through its normal routes with the main window's sign-in, it
// never accepts the AI notice itself, the demo disables it, and the shortcut is registered,
// unregistered and changeable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const page = () => read('desktop', 'shared', 'quick-ask.html');
const cpp = () => read('desktop', 'windows', 'src', 'main.cpp');
const swift = () => read('desktop', 'mac', 'Sources', 'QuickAsk.swift');
const mainSwift = () => read('desktop', 'mac', 'Sources', 'main.swift');

test('one quick-ask page for both apps, in both builds', () => {
  assert.match(read('desktop', 'windows', 'src', 'sara.rc'), /IDR_QUICKASK RCDATA "\.\.\/\.\.\/shared\/quick-ask\.html"/);
  assert.match(read('desktop', 'windows', 'src', 'resource.h'), /#define IDR_QUICKASK 102/);
  assert.match(read('desktop', 'windows', 'CMakeLists.txt'), /OBJECT_DEPENDS "\$\{CMAKE_SOURCE_DIR\}\/\.\.\/shared\/quick-ask\.html"/);
  assert.match(read('desktop', 'windows', 'CMakeLists.txt'), /windowscodecs crypt32/);
  assert.match(read('desktop', 'mac', 'build.sh'), /cp \.\.\/shared\/quick-ask\.html "\$APP\/Resources\/quick-ask\.html"/);
  assert.match(swift(), /Bundle\.main\.url\(forResource: "quick-ask", withExtension: "html"\)/);
  assert.match(cpp(), /FindResourceW\(g_inst, MAKEINTRESOURCEW\(IDR_QUICKASK\), RT_RCDATA\)/);
  // No inline style attributes or external code in the page; the night / day tokens of the new look.
  const html = page();
  assert.doesNotMatch(html, /\sstyle=["']/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/);
  assert.match(html, /#e0607e,#9b6bff/);
  assert.match(html, /--solid:#0f0d17/);
  assert.match(html, /--solid:#faf7f5/);
});

test('the page is served at the server address with the main window\'s sign-in', () => {
  const c = cpp();
  // Windows: answered by the app (never fetched), in the same environment and profile as the main window.
  assert.match(c, /kQuickPath = L"\/__sara_desktop\/quick-ask"/);
  assert.match(c, /AddWebResourceRequestedFilterWithRequestSourceKinds\(filter\.c_str\(\), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL/);
  assert.match(c, /serveQuickAskFrom\(g_qaWeb\.Get\(\)\);/);
  assert.match(c, /CreateWebResourceResponse\(body\.Get\(\), 200, L"OK"/);
  assert.match(c, /connect-src 'self'/);
  const ensure = c.slice(c.indexOf('static void ensureQuickAsk() {'), c.indexOf('/** Menu text:'));
  assert.match(ensure, /put_ProfileName\(\(L"sara-" \+ g_profile\)\.c_str\(\)\)/, 'the same WebView2 profile as the main window');
  assert.match(ensure, /g_env->CreateCoreWebView2Controller\(g_qa, done\.Get\(\)\)/);
  // The server's service worker would otherwise answer the navigation: this view bypasses it, and
  // anything else that loads there is closed.
  assert.match(ensure, /Network\.setBypassServiceWorker/);
  assert.match(ensure, /wasn't the quick-ask page; closed it/);
  // Only messages from the page this app served for the server in use.
  assert.match(c, /source\.rfind\(g_qaServer \+ kQuickPath, 0\) != 0\) return;/);
  // A server switch drops the old server's quick ask (its profile).
  const sw = c.slice(c.indexOf('static void switchTo('), c.indexOf('/** Asks for a switch'));
  assert.match(sw, /closeQuickAskWebView\(\)/);
  // Mac: the main window's data store, the page given the server's address as its own.
  const s = swift();
  assert.match(s, /config\.websiteDataStore = Servers\.dataStore\(Servers\.active\)/);
  assert.match(s, /w\.loadHTMLString\(html, baseURL: base\)/);
  assert.match(s, /origin == server, pageServer == server/);
  assert.match(mainSwift(), /quick\?\.reset\(\)/, 'a new server gets a new quick-ask page');
});

test('asking: a new conversation per question, the normal chat route, "Open in Sara"', () => {
  const html = page();
  assert.match(html, /api\('\/conversations', \{ method: 'POST', body: \{\} \}\)/);
  assert.match(html, /'\/conversations\/' \+ encodeURIComponent\(conv\.id\) \+ '\/messages'/);
  assert.match(html, /credentials: 'same-origin'/);
  assert.match(html, /ev\.type === 'token'/);
  assert.match(html, /post\(\{ a: 'open', conv: conv \? conv\.id : '' \}\)/);
  // The app opens that conversation in the main window (the page's own #c= link).
  assert.match(cpp(), /openServer\(L"\/#c=" \+ conv\)/);
  assert.match(cpp(), /PostWebMessageAsJson\(\(L"\{\\"open\\":\\"" \+ conv/);
  assert.match(swift(), /location\.hash = 'c=\\\(conv\)'/);
});

test('AI disclosure: shown as the server words it, never accepted from the quick-ask window', () => {
  const html = page();
  // Before the notice is accepted: the notice and "Open Sara", no box to type in.
  assert.match(html, /if \(!session\.disclosureAccepted\) return 'disclosure';/);
  assert.match(html, /esc\(session\.disclosure \|\| ''\)/);
  assert.match(html, /\$\('ask'\)\.hidden = \$\('foot'\)\.hidden = q\.disabled;/);
  // The notice the server sends at the start of a session (and every few hours) is shown before her reply.
  assert.match(html, /ev\.type === 'notice'/);
  assert.match(html, /n\.textContent = ev\.text;/);
  // A 403 "accept the disclosure first" puts the notice back.
  assert.match(html, /res\.status === 403 && \/disclosure\/i/);
  // Nothing here accepts it: no call to the accept route in the page or the apps' quick-ask code.
  for (const src of [html, swift(), cpp()]) assert.doesNotMatch(src, /disclosure\/accept/);
});

test('demo server, signed out, private mode, household members', () => {
  const html = page();
  assert.match(html, /if \(session\.demo\) return 'demo';/);
  assert.match(html, /Quick ask is off on the demo\./);
  assert.match(html, /if \(!session\.authenticated\) return 'signin';/);
  assert.match(html, /\$\('private'\)\.hidden = !session\.privateLocal;/);
  // No polling or event stream for the demo.
  assert.match(html, /if \(es \|\| !session \|\| !session\.authenticated \|\| session\.demo\) return;/);
  // The tray / menu bar greys "Ask Sara…" out on the demo and hides "Now".
  assert.match(cpp(), /ID_ASK, ask\.c_str\(\)\);/);
  assert.match(cpp(), /g_now\.demo \|\| !g_now\.signedIn \? MF_GRAYED : 0/);
  assert.match(swift(), /action: q\.signedIn && !q\.demo \? #selector\(askFromMenu\) : nil/);
  // Household members: their own session (cookie), no owner-only routes are called.
  assert.doesNotMatch(html, /\/api\/(settings|household|providers)/);
});

test('Windows: the shortcut is registered, unregistered, changeable; clashes are said', () => {
  const c = cpp();
  assert.match(c, /\{L"alt\+shift\+s", L"Alt\+Shift\+S", MOD_ALT \| MOD_SHIFT, 'S'\}/);
  assert.match(c, /RegisterHotKey\(g_wnd, kHotkeyId, s->mods \| MOD_NOREPEAT, s->vk\)/);
  assert.match(c, /UnregisterHotKey\(g_wnd, kHotkeyId\);/);
  assert.match(c, /case WM_DESTROY:\s+UnregisterHotKey\(h, kHotkeyId\);/);
  assert.match(c, /case WM_HOTKEY:[\s\S]{0,120}quickAskHotkey\(\)/);
  // A second press while it's in front hides it, as toggleQuickAsk() does.
  assert.match(c, /static void quickAskHotkey\(\) \{\s+if \(quickAskVisible\(\) && GetForegroundWindow\(\) == g_qa\) return hideQuickAsk\(\);/);
  assert.match(c, /is already used by another app\. Right-click Sara's icon/);
  assert.match(c, /L"  \(used by another app\)"/);
  assert.match(c, /L"Quick ask shortcut"/);
  // The page's settings can change it through the bridge (and read the choices).
  assert.match(c, /if \(key == L"quickAskShortcut"\) \{\s+if \(!setShortcut\(m\[L"value"\]\)\) return reply\(id, L"null", L"Unknown shortcut"\);/);
  assert.match(c, /quickAskShortcutFree/);
});

test('Windows: the floating window hides on Escape and when it loses focus, and remembers its place', () => {
  const c = cpp();
  assert.match(c, /key == VK_ESCAPE && kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN/);
  assert.match(c, /LOWORD\(wp\) == WA_INACTIVE && GetTickCount\(\) - g_qaShownAt > 400\) hideQuickAsk\(true\)/);
  assert.match(c, /setPref\(L"quickAskPlace"/);
  assert.match(c, /WS_EX_TOOLWINDOW \| WS_EX_TOPMOST/);
  assert.match(c, /DWMSBT_TRANSIENTWINDOW/, 'frosted (acrylic) on Windows 11');
  assert.match(c, /DWMWCP_ROUND/);
  assert.match(page(), /e\.key === 'Escape'[\s\S]{0,60}post\(\{ a: 'hide' \}\)/);
});

test('Mac: Carbon hot key (no Accessibility permission), Escape and focus loss hide, vibrancy', () => {
  const s = swift();
  assert.match(s, /import Carbon\.HIToolbox/);
  assert.match(s, /QuickShortcut\(id: "opt\+shift\+s", label: "⌥⇧S", key: UInt32\(kVK_ANSI_S\), mods: UInt32\(optionKey \| shiftKey\)\)/);
  assert.match(s, /RegisterEventHotKey\(s\.key, s\.mods/);
  assert.match(s, /UnregisterEventHotKey\(ref\)/);
  assert.doesNotMatch(s, /addGlobalMonitorForEvents|AXIsProcessTrusted/, 'no Accessibility permission needed');
  assert.match(s, /override func cancelOperation\(_ sender: Any\?\) \{ onCancel\?\(\) \}/);
  assert.match(s, /func windowDidResignKey[\s\S]{0,120}hide\(\)/);
  assert.match(s, /prefs\.set\(NSStringFromPoint\(panel\.frame\.origin\), forKey: "quickAskOrigin"\)/);
  assert.match(s, /NSVisualEffectView/);
  assert.match(s, /\.nonactivatingPanel/);
  assert.match(mainSwift(), /case "quickAskShortcut":/);
  assert.match(mainSwift(), /title: "Quick ask shortcut"/);
});

test('tray / menu bar: her face and mood, "Now" with Allow / Deny / Open, mood in the tooltip', () => {
  const html = page();
  // Data: the normal routes, every 45 s while the app runs and sooner on /api/events.
  assert.match(html, /api\('\/sara\/state'\)/);
  assert.match(html, /api\('\/jobs'\)/);
  assert.match(html, /d\.activity && d\.activity\.approvals/);
  assert.match(html, /new EventSource\('\/api\/events'\)/);
  assert.match(html, /'\/approvals\/' \+ encodeURIComponent\(id\)/);
  const c = cpp();
  assert.match(c, /SetTimer\(g_wnd, kNowTimer, 45000, nullptr\)/);
  assert.match(c, /mi\.hbmpItem = faceBitmap\(\);/);
  assert.match(c, /GUID_WICPixelFormat32bppPBGRA/);
  assert.match(c, /L"Now: nothing running" : L"Now"/);
  assert.match(c, /AppendMenuW\(sub, MF_STRING, ID_ALLOW0 \+ i, L"Allow"\)/);
  assert.match(c, /AppendMenuW\(sub, MF_STRING, ID_DENY0 \+ i, L"Deny"\)/);
  assert.match(c, /AppendMenuW\(sub, MF_STRING, ID_NOW0 \+ i, L"Open in Sara"\)/);
  assert.match(c, /tip \+= L" · " \+ g_now\.mood;/);
  // Every item the tray menu had before stays.
  for (const item of ['Open Sara', 'Settings…', 'Your Saras', 'Add a Sara…', 'Start with Windows', 'Help', 'Quit Sara']) assert.ok(c.includes(`L"${item}"`), item);
  const s = swift();
  assert.match(s, /head\.attributedTitle = title/);
  assert.match(s, /head\.image = img/);
  assert.match(s, /for \(label, sel\) in \[\("Allow", #selector\(allowNowItem\(_:\)\)\), \("Deny", #selector\(denyNowItem\(_:\)\)\)\]/);
  assert.match(s, /statusItem\?\.button\?\.toolTip = tip/);
  assert.match(s, /Timer\.scheduledTimer\(withTimeInterval: 45, repeats: true\)/);
  const m = mainSwift();
  for (const item of ['Open Sara', 'Settings…', 'Open at login', 'Help', 'Quit Sara']) assert.ok(m.includes(`"${item}"`), item);
  assert.match(m, /refreshNowItems\(in: menu\)/);
});

test('test hooks stay out of release builds', () => {
  const c = cpp();
  const tip = c.slice(c.indexOf('static void updateTrayTip() {'));
  assert.ok(tip.indexOf('#ifdef SARA_TEST_HOOKS') < tip.indexOf('tray tooltip: '));
  const s = swift();
  assert.ok(s.indexOf('#if DEBUG\nextension AppDelegate {\n  /// Test builds only: SARA_TEST_QUICK') > 0);
  assert.match(mainSwift(), /#if DEBUG\n    runQuickTest\(\)/);
});
