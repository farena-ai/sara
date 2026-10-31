// Isolated native fixture for CU6. No files, accounts, network or shell actions.
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <string>

HWND nameField, statusText;
LRESULT CALLBACK fixtureProc(HWND h, UINT message, WPARAM w, LPARAM l) {
  if (message == WM_COMMAND && LOWORD(w) == 101) {
    wchar_t value[2001]{}; GetWindowTextW(nameField, value, 2001);
    std::wstring text = L"Saved: " + std::wstring(value); SetWindowTextW(statusText, text.c_str()); return 0;
  }
  if (message == WM_CLOSE) { DestroyWindow(h); return 0; }
  if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcW(h, message, w, l);
}
int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR command, int) {
  WNDCLASSW cls{}; cls.hInstance = instance; cls.lpfnWndProc = fixtureProc; cls.lpszClassName = L"SaraCU6Fixture";
  cls.hCursor = LoadCursorW(nullptr, IDC_ARROW); cls.hbrBackground = GetSysColorBrush(COLOR_WINDOW); RegisterClassW(&cls);
  HWND h = CreateWindowW(cls.lpszClassName, L"CU6 isolated test window", WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, 120, 180, 560, 360, nullptr, nullptr, instance, nullptr);
  auto control = [&](const wchar_t* type, const wchar_t* text, int id, int x, int y, int width, int height, DWORD style) {
    HWND c = CreateWindowExW(type == std::wstring(L"EDIT") ? WS_EX_CLIENTEDGE : 0, type, text, WS_CHILD | WS_VISIBLE | style, x, y, width, height, h, (HMENU)(INT_PTR)id, instance, nullptr);
    SendMessageW(c, WM_SETFONT, (WPARAM)GetStockObject(DEFAULT_GUI_FONT), TRUE); return c;
  };
  control(L"STATIC", L"CU6 fixture only: no owner applications", 0, 20, 18, 490, 24, 0);
  control(L"STATIC", L"Name", 0, 20, 58, 130, 24, 0);
  nameField = control(L"EDIT", L"", 100, 150, 54, 340, 30, WS_TABSTOP | ES_AUTOHSCROLL);
  control(L"STATIC", L"Password (fixture)", 0, 20, 110, 130, 24, 0);
  control(L"EDIT", L"fixture-secret", 102, 150, 106, 340, 30, WS_TABSTOP | ES_PASSWORD);
  control(L"BUTTON", L"Save", 101, 150, 164, 150, 44, WS_TABSTOP | BS_PUSHBUTTON);
  statusText = control(L"STATIC", L"Not saved", 103, 20, 242, 480, 42, 0);
  // A render-only snapshot never shows or activates a window on the owner's desktop.
  if (std::wstring(command).rfind(L"--capture ", 0) == 0) {
    std::wstring path(command + 10);
    RECT r{}; GetWindowRect(h, &r); int width = r.right - r.left, height = r.bottom - r.top;
    HDC screen = GetDC(h), dc = CreateCompatibleDC(screen);
    HBITMAP bitmap = CreateCompatibleBitmap(screen, width, height); HGDIOBJ old = SelectObject(dc, bitmap);
    SendMessageW(h, WM_PRINT, (WPARAM)dc, PRF_CLIENT | PRF_CHILDREN | PRF_NONCLIENT | PRF_ERASEBKGND);
    SelectObject(dc, old);
    BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER); info.bmiHeader.biWidth = width; info.bmiHeader.biHeight = height;
    info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 24; info.bmiHeader.biCompression = BI_RGB;
    DWORD size = ((width * 3 + 3) & ~3) * height;
    std::string pixels(size, 0); GetDIBits(screen, bitmap, 0, height, pixels.data(), &info, DIB_RGB_COLORS);
    BITMAPFILEHEADER header{}; header.bfType = 0x4d42; header.bfOffBits = sizeof(header) + sizeof(BITMAPINFOHEADER); header.bfSize = header.bfOffBits + size;
    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    DWORD written = 0;
    if (file != INVALID_HANDLE_VALUE) { WriteFile(file, &header, sizeof(header), &written, nullptr); WriteFile(file, &info.bmiHeader, sizeof(info.bmiHeader), &written, nullptr); WriteFile(file, pixels.data(), size, &written, nullptr); CloseHandle(file); }
    DeleteObject(bitmap); DeleteDC(dc); ReleaseDC(h, screen); DestroyWindow(h); return file == INVALID_HANDLE_VALUE ? 1 : 0;
  }
  ShowWindow(h, SW_SHOWNOACTIVATE);
  MSG msg; while (GetMessageW(&msg, nullptr, 0, 0) > 0) { TranslateMessage(&msg); DispatchMessageW(&msg); }
  return 0;
}
