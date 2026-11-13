// The desktop approval card (desktop/windows/src/hands-approval.cpp) must not take activation or focus from
// the window Sara is about to act on: a transient popup there (Edge's "Remove … from Microsoft Edge?" bubble,
// a menu) closes when its window is deactivated. This shows the TEST card over a window of ours that is in
// front, checks the front window and its focus did not change, that the card is topmost and non-activating,
// that a real-shaped click on Allow answers 1, that Sara's tagged injected clicks never answer, and that
// closing means Don't.   ApprovalCardChecks.exe → "N/N approval card checks"
#include <windows.h>
#include <atomic>
#include <cstdio>
#include <future>
#include "hands-approval.h"
#include "hands-screen.h"

static int pass = 0, total = 0;
static void expect(bool ok, const char* what) { total++; if (ok) pass++; std::printf("%s %s\n", ok ? "ok  " : "FAIL", what); }
static HWND waitCard() { for (int i = 0; i < 200; i++) { if (HWND h = FindWindowW(L"SaraDesktopApproval", L"TEST Sara: desktop action")) return h; Sleep(20); } return nullptr; }
static void pump(int ms) { auto end = GetTickCount64() + ms; MSG m; while (GetTickCount64() < end) { while (PeekMessageW(&m, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&m); DispatchMessageW(&m); } Sleep(10); } }
static POINT centre(HWND b) { RECT r; GetWindowRect(b, &r); return {(r.left + r.right) / 2, (r.top + r.bottom) / 2}; }
static bool clickAt(POINT p, ULONG_PTR tag) {
  int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN), vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  INPUT in[3]{};
  for (auto& i : in) { i.type = INPUT_MOUSE; i.mi.dwExtraInfo = tag; i.mi.dx = (LONG)(((p.x - vx) * 65535.0) / (vw - 1)); i.mi.dy = (LONG)(((p.y - vy) * 65535.0) / (vh - 1)); i.mi.dwFlags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK; }
  in[0].mi.dwFlags |= MOUSEEVENTF_MOVE; in[1].mi.dwFlags |= MOUSEEVENTF_LEFTDOWN; in[2].mi.dwFlags |= MOUSEEVENTF_LEFTUP;
  return SendInput(3, in, sizeof(INPUT)) == 3;
}

int wmain(int argc, wchar_t** argv) {
  bool mouse = argc > 1 && std::wstring(argv[1]) == L"--mouse";  // moves the real pointer: only when nobody is using the PC
  HINSTANCE inst = GetModuleHandleW(nullptr);
  WNDCLASSW wc{}; wc.lpfnWndProc = DefWindowProcW; wc.hInstance = inst; wc.lpszClassName = L"SaraCardTarget"; RegisterClassW(&wc);
  HWND target = CreateWindowExW(0, L"SaraCardTarget", L"Approval card target", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 900, 500, 500, 300, nullptr, nullptr, inst, nullptr);
  HWND edit = CreateWindowExW(0, L"EDIT", L"", WS_CHILD | WS_VISIBLE, 10, 10, 200, 30, target, nullptr, inst, nullptr);
  SetForegroundWindow(target); SetFocus(edit); pump(300);
  bool front = GetForegroundWindow() == target;
  std::printf("  target in front at start: %s\n", front ? "yes" : "no (checks below still compare with whatever was in front)");
  HWND before = GetForegroundWindow();

  // 1. Shown: nothing changes in front; topmost; non-activating; Allow (BM_CLICK, as UI Automation Invoke does) → 1.
  auto run = [] { return std::async(std::launch::async, [] { return sarahands::desktopApproval(L"Click \"Remove\" in Edge", true, true, nullptr); }); };
  auto f = run(); HWND card = waitCard(); pump(600);
  expect(card != nullptr, "the TEST card is shown");
  LONG_PTR ex = card ? GetWindowLongPtrW(card, GWL_EXSTYLE) : 0;
  expect((ex & WS_EX_NOACTIVATE) != 0, "the card is WS_EX_NOACTIVATE");
  expect((ex & WS_EX_TOPMOST) != 0, "the card is topmost");
  expect(card && IsWindowVisible(card), "the card is visible");
  expect(GetForegroundWindow() == before, "the window in front stays in front while the card is shown");
  expect(!front || GetFocus() == edit, "the target keeps keyboard focus");
  if (card) SendMessageW(GetDlgItem(card, 101), BM_CLICK, 0, 0);
  expect(f.wait_for(std::chrono::seconds(5)) == std::future_status::ready && f.get() == 1, "Allow once answers 1");
  expect(GetForegroundWindow() == before, "after Allow the window in front is still in front");

  // 2. Closing the card means Don't.
  f = run(); card = waitCard(); pump(300);
  if (card) PostMessageW(card, WM_CLOSE, 0, 0);
  expect(f.wait_for(std::chrono::seconds(5)) == std::future_status::ready && f.get() == 0, "closing the card means Don't");

  // 3. Cancel (Stop) closes it as Don't.
  std::atomic<bool> cancel{false};
  auto g = std::async(std::launch::async, [&] { return sarahands::desktopApproval(L"x", false, true, &cancel); });
  waitCard(); cancel = true;
  expect(g.wait_for(std::chrono::seconds(5)) == std::future_status::ready && g.get() == 0, "Stop closes the card as Don't");

  if (mouse) {
    // 4. Sara's own tagged injected click on Allow does nothing; a click without her tag answers and keeps the front window.
    SetForegroundWindow(target); SetFocus(edit); pump(300); before = GetForegroundWindow();
    f = run(); card = waitCard(); pump(500);
    POINT allow = centre(GetDlgItem(card, 101));
    clickAt(allow, sarascreen::kInputTag); pump(600);
    expect(f.wait_for(std::chrono::milliseconds(10)) != std::future_status::ready, "Sara's own tagged click on Allow is ignored");
    clickAt(allow, 0);
    expect(f.wait_for(std::chrono::seconds(5)) == std::future_status::ready && f.get() == 1, "a real-shaped click on Allow answers 1");
    pump(300);
    expect(GetForegroundWindow() == before, "clicking Allow does not activate the card");
  }
  DestroyWindow(target);
  std::printf("%d/%d approval card checks\n", pass, total);
  return pass == total ? 0 : 1;
}
