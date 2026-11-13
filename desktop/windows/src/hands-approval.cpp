#define NOMINMAX
#include <windows.h>
#include <thread>
#include "hands-approval.h"
#include "hands-screen.h"  // kInputTag: Sara's own synthetic input is never an answer

namespace sarahands {
namespace {
// The card never takes activation or keyboard focus: activating it would deactivate the window Sara is
// about to act on, and Chromium/Win32 transient UI (Edge's "Remove … from Microsoft Edge?" bubble, menus,
// dropdowns) closes on deactivation, so the approved control would be gone. It stays topmost (re-asserted
// on a timer), answers to the mouse only, ignores Sara's own tagged input, and closing it means Don't.
constexpr UINT_PTR kTopTimer = 1;
struct Panel { std::wstring summary; bool task, test; std::atomic<HWND> window{nullptr}; std::atomic<bool> done{false}; int answer = 0; };
void answer(HWND card, int id) {
  auto p = reinterpret_cast<Panel*>(GetWindowLongPtrW(card, GWLP_USERDATA));
  if (!p) return;
  if (id == 101 || (id == 102 && p->task) || id == IDCANCEL) { p->answer = id == 101 ? 1 : id == 102 ? 2 : 0; DestroyWindow(card); }
}
/** Buttons press without SetFocus (a normal button focuses itself on click, which would activate the card). */
LRESULT CALLBACK buttonProc(HWND b, UINT m, WPARAM w, LPARAM l) {
  auto base = reinterpret_cast<WNDPROC>(GetPropW(b, L"SaraBase"));
  switch (m) {
    case WM_MOUSEACTIVATE: return MA_NOACTIVATE;
    case WM_LBUTTONDOWN: case WM_LBUTTONDBLCLK:
      if (GetMessageExtraInfo() == (LPARAM)sarascreen::kInputTag) return 0;  // Sara can never answer her own card
      SetPropW(b, L"SaraDown", (HANDLE)1); SetCapture(b); SendMessageW(b, BM_SETSTATE, TRUE, 0); return 0;
    case WM_LBUTTONUP: {
      bool down = GetPropW(b, L"SaraDown") != nullptr; RemovePropW(b, L"SaraDown");
      if (GetCapture() == b) ReleaseCapture();
      SendMessageW(b, BM_SETSTATE, FALSE, 0);
      RECT r; GetClientRect(b, &r); POINT pt{(short)LOWORD(l), (short)HIWORD(l)};
      if (down && PtInRect(&r, pt) && GetMessageExtraInfo() != (LPARAM)sarascreen::kInputTag) answer(GetParent(b), GetDlgCtrlID(b));
      return 0;
    }
    case WM_CAPTURECHANGED: RemovePropW(b, L"SaraDown"); SendMessageW(b, BM_SETSTATE, FALSE, 0); break;
    case BM_CLICK: answer(GetParent(b), GetDlgCtrlID(b)); return 0;  // UI Automation Invoke (assistive tech)
    case WM_NCDESTROY: SetWindowLongPtrW(b, GWLP_WNDPROC, (LONG_PTR)base); RemovePropW(b, L"SaraBase"); RemovePropW(b, L"SaraDown"); break;
  }
  return CallWindowProcW(base, b, m, w, l);
}
LRESULT CALLBACK proc(HWND h, UINT m, WPARAM w, LPARAM l) {
  if (m == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
  if (m == WM_TIMER && w == kTopTimer) { SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER); return 0; }
  if (m == WM_COMMAND && HIWORD(w) == BN_CLICKED && LOWORD(w) == IDCANCEL) { answer(h, IDCANCEL); return 0; }
  if (m == WM_CLOSE) { DestroyWindow(h); return 0; }
  if (m == WM_DESTROY) { KillTimer(h, kTopTimer); PostQuitMessage(0); return 0; }
  return DefWindowProcW(h, m, w, l);
}
void show(Panel& p) {
  HINSTANCE inst = GetModuleHandleW(nullptr);
  WNDCLASSEXW wc{sizeof(wc)}; wc.hInstance = inst; wc.lpfnWndProc = proc; wc.lpszClassName = L"SaraDesktopApproval";
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW); wc.hbrBackground = GetSysColorBrush(COLOR_WINDOW); RegisterClassExW(&wc);
  HWND h = CreateWindowExW(WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_DLGMODALFRAME | WS_EX_APPWINDOW, wc.lpszClassName,
    p.test ? L"TEST Sara: desktop action" : L"Sara: desktop action", WS_CAPTION | WS_SYSMENU | WS_POPUP,
    CW_USEDEFAULT, CW_USEDEFAULT, 620, 340, nullptr, nullptr, inst, nullptr);
  if (!h) { p.done = true; return; }
  p.window = h; SetWindowLongPtrW(h, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(&p));
  SetWindowDisplayAffinity(h, 0x11);
  UINT dpi = GetDpiForWindow(h); auto s = [dpi](int n) { return MulDiv(n, dpi, 96); };
  HFONT font = CreateFontW(-s(15), 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
  auto control = [&](const wchar_t* cls, const std::wstring& text, int id, int x, int y, int width, int height, DWORD flags) {
    HWND c = CreateWindowExW(0, cls, text.c_str(), WS_CHILD | WS_VISIBLE | flags, s(x), s(y), s(width), s(height), h, (HMENU)(INT_PTR)id, inst, nullptr);
    SendMessageW(c, WM_SETFONT, (WPARAM)font, TRUE);
    if (id) { SetPropW(c, L"SaraBase", (HANDLE)GetWindowLongPtrW(c, GWLP_WNDPROC)); SetWindowLongPtrW(c, GWLP_WNDPROC, (LONG_PTR)buttonProc); }
    return c;
  };
  control(L"STATIC", L"Sara wants to act on this computer", 0, 20, 18, 570, 28, SS_NOPREFIX);
  control(L"STATIC", p.summary.substr(0, 900), 0, 20, 56, 570, 140, SS_NOPREFIX);
  control(L"STATIC", L"Decide here with the mouse; the window you were using keeps its place. Stop (Ctrl+Alt+Esc) still works. Closing this window means Don't.", 0, 20, 198, 570, 42, SS_NOPREFIX);
  control(L"BUTTON", L"Allow once", 101, 20, 248, 130, 44, BS_PUSHBUTTON);
  if (p.task) control(L"BUTTON", L"Allow for this task", 102, 160, 248, 225, 44, BS_PUSHBUTTON);
  control(L"BUTTON", L"Don't", IDCANCEL, 440, 248, 140, 44, BS_DEFPUSHBUTTON);
  // Shown without activation: no SetForegroundWindow, no SetFocus.
  SetWindowPos(h, HWND_TOPMOST, 140, 100, s(620), s(340), SWP_SHOWWINDOW | SWP_NOACTIVATE);
  SetTimer(h, kTopTimer, 400, nullptr);
  MSG m;
  while (GetMessageW(&m, nullptr, 0, 0) > 0) { TranslateMessage(&m); DispatchMessageW(&m); }
  p.window = nullptr; DeleteObject(font); p.done = true;
}
}
int desktopApproval(const std::wstring& summary, bool taskChoice, bool test, const std::atomic<bool>* cancel) {
  Panel p; p.summary = summary; p.task = taskChoice; p.test = test;
  std::thread ui([&] { show(p); });
  while (!p.done) { if (cancel && cancel->load()) if (HWND h = p.window.load()) PostMessageW(h, WM_CLOSE, 0, 0); Sleep(20); }
  ui.join(); return cancel && cancel->load() ? 0 : p.answer;
}
}
