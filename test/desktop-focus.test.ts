// 3.5.1: typing always reaches the page in the Windows app. When a window is activated without a click
// in its page (at start, from the taskbar or Alt+Tab, when a card, the badge or another app's window
// goes away), Windows gives the keyboard to the frame itself; nothing passed it on to the web view, so
// keys were lost while the page still showed its caret. Static checks on the sources (the real run is
// in CHANGELOG 3.5.1: SendInput into a test build before/after a computer-use turn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, 'desktop', 'windows', 'src', ...p), 'utf8');
const proc = (src: string, name: string) => {
  const a = src.indexOf(`static LRESULT CALLBACK ${name}(`);
  assert.ok(a > 0, name);
  return src.slice(a, src.indexOf('\n}\n', a));
};

test('the main window: WM_SETFOCUS passes the keyboard to the web view; activation and stray keys check it', () => {
  const w = proc(read('main.cpp'), 'WndProc');
  assert.match(w, /case WM_SETFOCUS:\s+if \(g_controller && !IsIconic\(h\)\) \{\s+g_controller->MoveFocus\(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC\);[^\n]*\n\s+return 0;/);
  assert.match(w, /case WM_ACTIVATE:\s+extendFrame\(\);[\s\S]{0,300}if \(LOWORD\(wp\) != WA_INACTIVE && !HIWORD\(wp\)\) PostMessageW\(h, WM_APP_FOCUSPAGE, 0, 0\);/);
  assert.match(w, /case WM_KEYDOWN:\s+case WM_CHAR:\s+focusPage\(h\);/);
  assert.match(w, /case WM_ACTIVATEAPP:[\s\S]{0,300}if \(wp\) PostMessageW\(h, WM_APP_FOCUSPAGE, 0, 0\);/, 'brought to the front while already active in its thread');
  assert.match(w, /case WM_APP_FOCUSPAGE:\s+focusPageIfFrame\(\);\s+return 0;/);
});

test('only when the frame of Sara\'s window in front has the keyboard', () => {
  const c = read('main.cpp');
  const f = c.slice(c.indexOf('static void focusPageIfFrame() {'), c.indexOf('static LRESULT CALLBACK QuickProc('));
  assert.match(f, /HWND fg = GetForegroundWindow\(\), a = GetActiveWindow\(\);/);
  assert.match(f, /HWND w = fg && \(fg == g_wnd \|\| fg == g_qa\) \? fg : a && \(a == g_wnd \|\| a == g_qa\) \? a : nullptr;\s+if \(!w\) return;/, 'only her main window or quick ask');
  assert.match(f, /HWND f = GetFocus\(\);[^\n]*\n\s+if \(!f \|\| f == w\) focusPage\(w\);/, 'only when the frame itself (or nothing) has the keyboard');
  assert.match(c, /static const UINT WM_APP_FOCUSPAGE = WM_APP \+ 8;/);
  assert.doesNotMatch(c.replace(/static const UINT WM_APP_FOCUSPAGE = WM_APP \+ 8;/, ''), /= WM_APP \+ 8;/, 'its own message number');
});

test('quick ask does the same with its own web view', () => {
  const q = proc(read('main.cpp'), 'QuickProc');
  assert.match(q, /case WM_SETFOCUS:\s+if \(g_qaCtl\) \{\s+g_qaCtl->MoveFocus\(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC\);/);
  assert.match(q, /else if \(LOWORD\(wp\) != WA_INACTIVE && g_wnd\) PostMessageW\(g_wnd, WM_APP_FOCUSPAGE, 0, 0\);/);
  assert.match(q, /case WM_KEYDOWN:\s+case WM_CHAR:\s+focusPage\(h\);/);
});

test('at start, and after computer use (each op with its cards and pictures, and when the badge goes)', () => {
  const c = read('main.cpp');
  assert.match(c, /g_controller = ctl;\s+g_controller->get_CoreWebView2\(&g_web\);\s+PostMessageW\(g_wnd, WM_APP_FOCUSPAGE, 0, 0\);/);
  assert.match(c, /h\.onFocusBack = \[\] \{ if \(g_wnd\) PostMessageW\(g_wnd, WM_APP_FOCUSPAGE, 0, 0\); \};/);
  assert.match(read('hands.h'), /std::function<void\(\)> onFocusBack;/);
  const h = read('hands.cpp');
  assert.match(h, /if \(opRunning_\.exchange\(false\)\) \{[\s\S]{0,200}\}\s+if \(host\.onFocusBack\) host\.onFocusBack\(\);/, 'after every op, also a failed or stopped one');
  assert.match(h, /ShowWindow\(h, SW_HIDE\);\s+if \(self->host\.onFocusBack\) self->host\.onFocusBack\(\);/, 'when the badge goes');
});

test('quick ask over Sara\'s own main window reads her page\'s selection; her other windows stay skipped', () => {
  const c = read('main.cpp');
  const at = c.indexOf('static void quickAskHotkey() {');
  const hk = c.slice(at, c.indexOf('\n}\n', at));
  assert.match(hk, /if \(fg && g_wnd && GetAncestor\(fg, GA_ROOT\) == g_wnd && g_web && read != saractx::kReadNone\) return quickAskFromPage\(\);\s+saractx::pick\(fg, read, quickAskFound\);/);
  const js = c.slice(c.indexOf('static const wchar_t* kPageSelectionJs'), c.indexOf('static bool g_qaPageWaiting'));
  assert.match(js, /selectionEnd>a\.selectionStart/);
  assert.match(js, /\^\(text\|search\|url\|email\|tel\)\$/, 'never a password field');
  assert.match(js, /getSelection\(\)/);
  assert.match(js, /slice\(0,8000\)/);
  const done = c.slice(c.indexOf('static void quickAskPageDone('), c.indexOf('static void quickAskFromPage()'));
  assert.match(done, /p\.app = L"Sara";/);
  assert.match(done, /p\.text = saractx::tidyText\(text\.substr\(0, saractx::kMaxText\)\);/, 'masked and capped like the rest');
  assert.match(c, /SetTimer\(nullptr, 0, 400, \[\]\(HWND, UINT, UINT_PTR, DWORD\) \{ quickAskPageDone\(L"", L"page: no answer in time"\); \}\);/, 'a short time limit');
  assert.match(read('quick-context.cpp'), /std::wstring tidyText\(const std::wstring& t\) \{ return tidy\(t\); \}/);
  assert.match(read('quick-context.cpp'), /if \(hidden == "sara"\) \{\s+p\.skipped = L"sara";/, 'cards and her other windows: still skipped');
  assert.match(c, /L"\\",\\"looked\\":" \+ \(p\.path\.empty\(\) \? L"false" : L"true"\)/);
});
