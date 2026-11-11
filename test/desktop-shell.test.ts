// Phase 75 stage 1 (native): the Windows and Mac apps' side of the shell contract
// (docs/design/NEW_LOOK.md → Native apps). The page reads <html class="shell-windows|shell-mac"> and
// window.saraShell = { platform, titlebar, controls, theme, backdrop, backdrops, version }, set before
// its scripts run, and tells the app {type:'shell'|'theme'|'backdrop', …}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

test('Windows app: dark/light title bar, Mica, the page in the title area with native caption buttons', () => {
  const cpp = read('desktop', 'windows', 'src', 'main.cpp');
  const cmake = read('desktop', 'windows', 'CMakeLists.txt');
  assert.match(cmake, /dwmapi uxtheme/);
  // Theme → DWM: immersive dark mode (with the pre-20H1 number as a fallback), Mica on 22H2+,
  // a themed caption colour on Windows 11 (default colour under Mica).
  assert.match(cpp, /DwmSetWindowAttribute\(g_wnd, DWMWA_USE_IMMERSIVE_DARK_MODE/);
  assert.match(cpp, /DwmSetWindowAttribute\(g_wnd, 19,/);
  assert.match(cpp, /build >= 22621[\s\S]{0,200}DWMSBT_MAINWINDOW : DWMSBT_NONE[\s\S]{0,200}DWMWA_SYSTEMBACKDROP_TYPE/);
  assert.match(cpp, /DWMWA_CAPTION_COLOR/);
  assert.match(cpp, /g_mica \? DWMWA_COLOR_DEFAULT : themeColor\(\)/);
  // The page in the title area: WebView2's app-region support, DWM's caption buttons kept.
  assert.match(cpp, /ICoreWebView2Settings9[\s\S]{0,200}put_IsNonClientRegionSupportEnabled\(TRUE\)/);
  assert.match(cpp, /case WM_NCCALCSIZE:/);
  assert.match(cpp, /DwmExtendFrameIntoClientArea/);
  assert.match(cpp, /DwmDefWindowProc\(h, msg, wp, lp, &r\)/);
  assert.match(cpp, /return HTMAXBUTTON;/, 'snap layouts: the maximize button answers HTMAXBUTTON');
  assert.match(cpp, /DWMWA_CAPTION_BUTTON_BOUNDS/);
  assert.match(cpp, /SetWindowRgn\(c, all, TRUE\)/, 'the web view is cut out under the caption buttons');
  // Fallbacks: Windows 10 / an older WebView2 keep the normal title bar.
  assert.match(cpp, /g_wantCustomFrame = windowsBuild\(\) >= 22000 && cmp >= 0/);
  assert.match(cpp, /CompareBrowserVersions\(rt, L"123\.0\.2420\.47", &cmp\)/);
  assert.match(cpp, /if \(!regions && g_wantCustomFrame\)[\s\S]{0,200}setCustomFrame\(false\)/);
  // The test-only switch to the normal title bar is not in release builds.
  const hooks = cpp.slice(cpp.indexOf('#ifdef SARA_TEST_HOOKS\n    wchar_t f[32]'));
  assert.ok(hooks.indexOf('SARA_DESKTOP_FRAME') < hooks.indexOf('#endif'));
});

test('Windows app: no white flash, theme colours from the first frame, the shell contract', () => {
  const cpp = read('desktop', 'windows', 'src', 'main.cpp');
  assert.match(cpp, /kNight = RGB\(0x0f, 0x0d, 0x17\)/);
  assert.match(cpp, /kDay = RGB\(0xfa, 0xf7, 0xf5\)/);
  assert.doesNotMatch(cpp, /0x12, 0x10, 0x16|#121016/, 'the old background is gone');
  assert.match(cpp, /put_DefaultBackgroundColor\(\{\(BYTE\)\(g_mica \? 0 : 255\)/);
  assert.match(cpp, /g_themePref = getPref\(L"theme", L"night"\)/, 'remembered, Night by default');
  // window.saraShell + <html class="shell-windows"> before the page's scripts.
  assert.match(cpp, /AddScriptToExecuteOnDocumentCreated\(shellScript\(\)\.c_str\(\), nullptr\)/);
  assert.ok(cpp.indexOf('AddScriptToExecuteOnDocumentCreated(shellScript()') < cpp.indexOf('AddScriptToExecuteOnDocumentCreated(kShim'));
  assert.match(cpp, /window\.saraShell = \{ platform: 'windows', titlebar: /);
  assert.match(cpp, /classList\.add\('shell-windows'\)/);
  assert.match(cpp, /controls: \{ side: 'right', width: /);
  // The page's messages: theme (night/day/system, also dark/light), backdrop, "I draw the strip".
  assert.match(cpp, /m\[L"type"\] == L"theme"/);
  assert.match(cpp, /m\[L"type"\] == L"backdrop"/);
  assert.match(cpp, /m\[L"type"\] == L"shell"/);
  assert.match(cpp, /if \(pref == L"dark"\) pref = L"night";/);
  // Until the page says it draws the strip (an older server), the app keeps its own title strip.
  assert.match(cpp, /rc\.top \+= g_customFrame && !g_pageTitle \? titlebarPx\(\) : topResizeBand\(\)/);
  assert.match(cpp, /DrawTextW\(t, L"Sara"/);
  // Theme / backdrop only from the owner's server; "shell" from any page (it only moves the view).
  const msg = cpp.slice(cpp.indexOf('static void onMessage('));
  assert.ok(msg.indexOf('L"shell"') < msg.indexOf('if (!fromServer) return;'));
  assert.ok(msg.indexOf('if (!fromServer) return;') < msg.indexOf('m[L"type"] == L"theme"'));
  // wintop: the top band and the place under the caption buttons in the colour the server's page
  // says its top edge is (other palettes than Sara Classic), remembered; strictly #rrggbb; Sara
  // Classic's for a page that doesn't say, the app's own pages and the quick-ask window.
  assert.ok(msg.indexOf('if (!fromServer) return;') < msg.indexOf('setFrameColor(m[L"frame"])'));
  assert.match(cpp, /static COLORREF themeColor\(\) \{ return g_frameSet\[g_day\] && !g_framePageLocal \? g_frame\[g_day\] : baseColor\(\); \}/);
  assert.match(cpp, /if \(s\.size\(\) != 7 \|\| s\[0\] != L'#'\) return false;/);
  assert.match(cpp, /setPref\(i \? L"frameDay" : L"frameNight"/);
  assert.match(cpp, /g_day = resolveDay\(g_themePref\);\n  loadFrameColors\(\);/);
  assert.match(cpp, /setFramePageLocal\(pageOrigin\(u\) == L"local"\)/);
  assert.match(cpp, /CreateSolidBrush\(baseColor\(\)\)/, 'the quick-ask window keeps its own colours');
  // The app's own pages: the new tokens, Night or Day, and a drag strip.
  assert.match(cpp, /--bg:#0f0d17/);
  assert.match(cpp, /html\.day\{--bg:#faf7f5/);
  assert.match(cpp, /app-region:drag/);
  assert.match(cpp, /postMessage\(\{type:'shell',titlebar:true\}\)/);
});

test('Mac app: transparent full-size title bar, inset traffic lights, theme, vibrancy, the shell contract', () => {
  const main = read('desktop', 'mac', 'Sources', 'main.swift');
  const shell = read('desktop', 'mac', 'Sources', 'Shell.swift');
  const setup = read('desktop', 'mac', 'Sources', 'Setup.swift');
  assert.match(main, /\.fullSizeContentView/);
  assert.match(main, /titlebarAppearsTransparent = true/);
  assert.match(main, /setUpWindowChrome\(\)[\s\S]{0,200}makeWebView\(/, 'the window is themed before the web view exists');
  assert.match(main, /web\.setValue\(false, forKey: "drawsBackground"\)/);
  assert.match(shell, /web\.underPageBackgroundColor = /);
  assert.match(shell, /NSAppearance\(named: isDay \? \.aqua : \.darkAqua\)/);
  assert.match(shell, /window\.titleVisibility = pageDrawsTitlebar \? \.hidden : \.visible/);
  assert.match(shell, /let macTitlebar: CGFloat = 38/);
  assert.match(shell, /standardWindowButton\(\.closeButton\)/);
  assert.match(shell, /NSVisualEffectView\(/);
  assert.match(shell, /0x0f \/ 255, green: 0x0d \/ 255, blue: 0x17/);
  assert.match(shell, /0xfa \/ 255, green: 0xf7 \/ 255, blue: 0xf5/);
  assert.match(shell, /window\.saraShell = \{ platform: 'mac', titlebar: /);
  assert.match(shell, /classList\.add\('shell-mac'\)/);
  assert.match(shell, /controls: \{ side: 'left', width: /);
  // WebKit has no CSS app-region: presses on the strip move the window natively.
  assert.match(shell, /window\.performDrag\(with: e\)/);
  assert.match(shell, /AppleActionOnDoubleClick/);
  // Messages: the handler is "sara"; {type:…} as well as {m:…}.
  assert.match(main, /addScriptMessageHandler\(self, contentWorld: \.page, name: "sara"\)/);
  assert.match(main, /\(body\["m"\] \?\? body\["type"\]\) as\? String/);
  assert.match(main, /case "theme", "backdrop":/);
  const handler = main.slice(main.indexOf('func userContentController('));
  assert.ok(handler.indexOf('case "shell", "dragWindow", "zoomWindow":') < handler.indexOf('guard fromServer else'));
  assert.ok(handler.indexOf('guard fromServer else') < handler.indexOf('case "theme", "backdrop":'));
  // Test-only hooks stay out of release builds.
  assert.ok(shell.indexOf('#if DEBUG') < shell.indexOf('func testShellHook') && shell.indexOf('func testShellHook') < shell.lastIndexOf('#endif'));
  assert.match(main, /#if DEBUG\n    case "testShot"/);
  // The native setup sheet and pages follow the theme.
  assert.match(setup, /window\.appearance = Shell\.appearance/);
  assert.match(main, /var pageStyle: String \{ pageCSS \+ Shell\.localPageScript \}/);
  assert.match(main, /--bg:#0f0d17/);
  assert.doesNotMatch(main, /0x12 \/ 255|#121016/);
});
