// V4.5 Screen companion fixture (test/v4-screen.test.ts, ScreenWatchChecks --live): a fake screen.
//   ScreenWatchFixture error <tag>  a classic error dialog (#32770) titled "Invoice Maker <tag>"
//   ScreenWatchFixture form <tag>   a sign-up form titled "Sign up <tag>" whose message says the email is
//                                   required, with a typed value and a password field that must never be read
// Nobody's real windows are involved: the checks find these by their unique titles. The windows sit far
// off every monitor and never take the focus or a taskbar button, so whoever uses this computer sees nothing.
#include <windows.h>

#include <string>

static LRESULT CALLBACK proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_CLOSE) DestroyWindow(h);
  if (msg == WM_DESTROY) PostQuitMessage(0);
  return DefWindowProcW(h, msg, wp, lp);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR, int) {
  int argc = 0;
  wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  std::wstring mode = argc > 1 ? argv[1] : L"error", tag = argc > 2 ? argv[2] : L"(test)";
  bool error = mode == L"error";
  WNDCLASSW wc{};
  wc.lpfnWndProc = proc;
  wc.hInstance = inst;
  wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
  wc.lpszClassName = L"SaraScreenWatchForm";
  RegisterClassW(&wc);
  // The error: the system dialog class (#32770), like a MessageBox. The form: a normal window.
  HWND w = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, error ? L"#32770" : wc.lpszClassName, ((error ? L"Invoice Maker " : L"Sign up ") + tag).c_str(),
                           (error ? WS_POPUP | WS_CAPTION | WS_SYSMENU : WS_OVERLAPPEDWINDOW), -32000 + 400, -32000 + 400, 460, 300, nullptr, nullptr, inst, nullptr);
  if (error) SetWindowLongPtrW(w, GWLP_WNDPROC, (LONG_PTR)proc);
  auto add = [&](const wchar_t* cls, const wchar_t* text, DWORD style, int y, int hgt) {
    return CreateWindowExW(0, cls, text, WS_CHILD | WS_VISIBLE | style, 20, y, 400, hgt, w, nullptr, inst, nullptr);
  };
  if (error) {
    add(L"STATIC", L"Could not save \"march.inv\": the disk is full.", 0, 30, 20);
    add(L"BUTTON", L"OK", BS_DEFPUSHBUTTON, 200, 30);
  } else {
    add(L"STATIC", L"Email", 0, 16, 20);
    add(L"EDIT", L"typed-value-123", WS_BORDER | ES_AUTOHSCROLL, 38, 24);
    add(L"STATIC", L"Email is required.", 0, 68, 20);
    add(L"STATIC", L"Password", 0, 98, 20);
    add(L"EDIT", L"pw-secret-456", WS_BORDER | ES_PASSWORD | ES_AUTOHSCROLL, 120, 24);
    add(L"BUTTON", L"Send", BS_PUSHBUTTON, 160, 30);
  }
  ShowWindow(w, SW_SHOWNOACTIVATE);
  SetTimer(w, 1, 60000, [](HWND h, UINT, UINT_PTR, DWORD) { DestroyWindow(h); });  // never left behind
  MSG m;
  while (GetMessageW(&m, nullptr, 0, 0) > 0) {
    TranslateMessage(&m);
    DispatchMessageW(&m);
  }
  return 0;
}
