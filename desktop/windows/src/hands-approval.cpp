#define NOMINMAX
#include <windows.h>
#include <thread>
#include "hands-approval.h"

namespace sarahands {
namespace {
struct Panel { std::wstring summary; bool task, test; std::atomic<HWND> window{nullptr}; std::atomic<bool> done{false}; int answer = 0; };
LRESULT CALLBACK proc(HWND h, UINT m, WPARAM w, LPARAM l) {
  auto p = reinterpret_cast<Panel*>(GetWindowLongPtrW(h, GWLP_USERDATA));
  if (m == WM_COMMAND && p && HIWORD(w) == BN_CLICKED) {
    int id = LOWORD(w);
    if (id == 101 || (id == 102 && p->task) || id == IDCANCEL) { p->answer = id == 101 ? 1 : id == 102 ? 2 : 0; DestroyWindow(h); return 0; }
  }
  if (m == WM_CLOSE) { DestroyWindow(h); return 0; }
  if (m == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcW(h, m, w, l);
}
void show(Panel& p) {
  HINSTANCE inst = GetModuleHandleW(nullptr);
  WNDCLASSEXW wc{sizeof(wc)}; wc.hInstance = inst; wc.lpfnWndProc = proc; wc.lpszClassName = L"SaraDesktopApproval";
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW); wc.hbrBackground = GetSysColorBrush(COLOR_WINDOW); RegisterClassExW(&wc);
  HWND h = CreateWindowExW(WS_EX_TOPMOST | WS_EX_DLGMODALFRAME | WS_EX_CONTROLPARENT, wc.lpszClassName,
    p.test ? L"TEST Sara: desktop action" : L"Sara: desktop action", WS_CAPTION | WS_SYSMENU | WS_POPUP,
    CW_USEDEFAULT, CW_USEDEFAULT, 620, 340, nullptr, nullptr, inst, nullptr);
  if (!h) { p.done = true; return; }
  p.window = h; SetWindowLongPtrW(h, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(&p));
  SetWindowDisplayAffinity(h, 0x11);
  UINT dpi = GetDpiForWindow(h); auto s = [dpi](int n) { return MulDiv(n, dpi, 96); };
  HFONT font = CreateFontW(-s(15), 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
  auto control = [&](const wchar_t* cls, const std::wstring& text, int id, int x, int y, int width, int height, DWORD flags) {
    HWND c = CreateWindowExW(0, cls, text.c_str(), WS_CHILD | WS_VISIBLE | flags, s(x), s(y), s(width), s(height), h, (HMENU)(INT_PTR)id, inst, nullptr);
    SendMessageW(c, WM_SETFONT, (WPARAM)font, TRUE); return c;
  };
  control(L"STATIC", L"Sara wants to act on this computer", 0, 20, 18, 570, 28, SS_NOPREFIX);
  control(L"STATIC", p.summary.substr(0, 900), 0, 20, 56, 570, 140, SS_NOPREFIX);
  control(L"STATIC", L"Decide here. Stop (Ctrl+Alt+Esc) still works. Closing this window means Don't.", 0, 20, 198, 570, 42, SS_NOPREFIX);
  control(L"BUTTON", L"Allow once", 101, 20, 248, 130, 44, WS_TABSTOP | BS_PUSHBUTTON);
  if (p.task) control(L"BUTTON", L"Allow for this task", 102, 160, 248, 225, 44, WS_TABSTOP | BS_PUSHBUTTON);
  HWND deny = control(L"BUTTON", L"Don't", IDCANCEL, 440, 248, 140, 44, WS_TABSTOP | BS_DEFPUSHBUTTON);
  SetWindowPos(h, HWND_TOPMOST, 140, 100, s(620), s(340), SWP_SHOWWINDOW); SetForegroundWindow(h); SetFocus(deny);
  MSG m;
  while (GetMessageW(&m, nullptr, 0, 0) > 0) { if (!IsDialogMessageW(h, &m)) { TranslateMessage(&m); DispatchMessageW(&m); } }
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
