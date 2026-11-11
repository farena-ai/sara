// The voice pill. See voice-pill.h.
#define NOMINMAX
#include "voice-pill.h"

#include <dwmapi.h>

#include <algorithm>

namespace sarapill {
namespace {

HWND g_pill = nullptr;
std::wstring g_state, g_text;
std::function<void()> g_click;
UINT_PTR kPulse = 1;
int g_phase = 0;

COLORREF dotColor() {
  if (g_state == L"listening") return RGB(240, 138, 165);
  if (g_state == L"thinking") return RGB(155, 107, 255);
  return RGB(79, 209, 165);  // speaking
}

/** Above the notification area of the taskbar (bottom right on most PCs), inside the work area. */
void place() {
  UINT dpi = GetDpiForWindow(g_pill);
  int w = MulDiv(220, (int)dpi, 96), h = MulDiv(36, (int)dpi, 96), m = MulDiv(10, (int)dpi, 96);
  HDC dc = GetDC(g_pill);
  HFONT f = CreateFontW(-MulDiv(13, (int)dpi, 96), 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
  HGDIOBJ old = SelectObject(dc, f);
  SIZE sz{};
  GetTextExtentPoint32W(dc, g_text.c_str(), (int)g_text.size(), &sz);
  SelectObject(dc, old);
  DeleteObject(f);
  ReleaseDC(g_pill, dc);
  w = std::clamp((int)sz.cx + MulDiv(46, (int)dpi, 96), MulDiv(120, (int)dpi, 96), MulDiv(360, (int)dpi, 96));
  RECT tray{};
  HWND bar = FindWindowW(L"Shell_TrayWnd", nullptr);
  HWND note = bar ? FindWindowExW(bar, nullptr, L"TrayNotifyWnd", nullptr) : nullptr;
  MONITORINFO mi{sizeof mi};
  GetMonitorInfoW(MonitorFromWindow(bar ? bar : GetDesktopWindow(), MONITOR_DEFAULTTOPRIMARY), &mi);
  RECT wa = mi.rcWork;
  int x = wa.right - w - m, y = wa.bottom - h - m;
  if (note && GetWindowRect(note, &tray)) {
    x = std::clamp((int)tray.right - w, (int)wa.left + m, (int)wa.right - w - m);
    if (tray.top >= wa.bottom - 2) y = wa.bottom - h - m;       // taskbar at the bottom
    else if (tray.bottom <= wa.top + 2) y = wa.top + m;         // at the top
  }
  SetWindowPos(g_pill, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  HRGN r = CreateRoundRectRgn(0, 0, w + 1, h + 1, h, h);
  SetWindowRgn(g_pill, r, TRUE);
}

LRESULT CALLBACK proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_MOUSEACTIVATE:
      return MA_NOACTIVATE;
    case WM_LBUTTONUP:
      if (g_click) g_click();
      return 0;
    case WM_TIMER:
      g_phase = (g_phase + 1) % 20;
      InvalidateRect(h, nullptr, FALSE);
      return 0;
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT: {
      PAINTSTRUCT ps;
      HDC dc = BeginPaint(h, &ps);
      RECT rc;
      GetClientRect(h, &rc);
      UINT dpi = GetDpiForWindow(h);
      HBRUSH bg = CreateSolidBrush(RGB(30, 26, 41));
      FillRect(dc, &rc, bg);
      DeleteObject(bg);
      int d = MulDiv(10, (int)dpi, 96), cx = MulDiv(18, (int)dpi, 96), cy = (rc.bottom - rc.top) / 2;
      int grow = g_state == L"thinking" ? 0 : (g_phase < 10 ? g_phase : 20 - g_phase) * d / 40;
      HBRUSH dot = CreateSolidBrush(dotColor());
      HGDIOBJ ob = SelectObject(dc, dot);
      HGDIOBJ op = SelectObject(dc, GetStockObject(NULL_PEN));
      Ellipse(dc, cx - d / 2 - grow, cy - d / 2 - grow, cx + d / 2 + grow, cy + d / 2 + grow);
      SelectObject(dc, op);
      SelectObject(dc, ob);
      DeleteObject(dot);
      HFONT f = CreateFontW(-MulDiv(13, (int)dpi, 96), 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
      HGDIOBJ of = SelectObject(dc, f);
      SetBkMode(dc, TRANSPARENT);
      SetTextColor(dc, RGB(238, 233, 243));
      RECT tr = rc;
      tr.left = cx + MulDiv(16, (int)dpi, 96);
      tr.right -= MulDiv(10, (int)dpi, 96);
      DrawTextW(dc, g_text.c_str(), (int)g_text.size(), &tr, DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);
      SelectObject(dc, of);
      DeleteObject(f);
      EndPaint(h, &ps);
      return 0;
    }
  }
  return DefWindowProcW(h, msg, wp, lp);
}

void ensure() {
  if (g_pill) return;
  WNDCLASSW wc{};
  wc.lpfnWndProc = proc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursorW(nullptr, IDC_HAND);
  wc.lpszClassName = L"SaraVoicePill";
  RegisterClassW(&wc);
  g_pill = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE, wc.lpszClassName, L"Sara", WS_POPUP, 0, 0, 10, 10, nullptr, nullptr, wc.hInstance, nullptr);
  BOOL dark = TRUE;
  DwmSetWindowAttribute(g_pill, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &dark, sizeof dark);
}

}  // namespace

void show(const std::wstring& state, const std::wstring& text) {
  ensure();
  if (!g_pill) return;
  bool was = IsWindowVisible(g_pill) != FALSE;
  g_state = state;
  g_text = text;
  SetWindowTextW(g_pill, (L"Sara: " + text).c_str());  // what a screen reader says
  place();
  if (!was) ShowWindow(g_pill, SW_SHOWNOACTIVATE);
  SetTimer(g_pill, kPulse, 60, nullptr);
  InvalidateRect(g_pill, nullptr, FALSE);
}
void hide() {
  if (!g_pill || !IsWindowVisible(g_pill)) return;
  KillTimer(g_pill, kPulse);
  ShowWindow(g_pill, SW_HIDE);
  g_state.clear();
}
bool visible() { return g_pill && IsWindowVisible(g_pill); }
void onClick(std::function<void()> f) { g_click = std::move(f); }
HWND window() { return g_pill; }

}  // namespace sarapill
