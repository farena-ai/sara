// 3.5 (PC tools): c.run / c.open on Windows. See hands-run.h and docs/design/PC_TOOLS.md; the rules
// match src/hands-run.ts (the server checks the same before it sends, and again after).
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <wincrypt.h>
#include <algorithm>
#include <map>
#include <mutex>
#include <regex>
#include <thread>
#include <vector>
#include "hands-run.h"

namespace sararun {
namespace {

std::mutex g_m;
Settings g_s;
std::map<std::string, ULONGLONG> g_grants;
const ULONGLONG kGrantMs = 15 * 60000;
const size_t kCommandChars = 4000, kOutputChars = 64000, kChunkChars = 4000, kLiveChars = 64000;

std::wstring wide(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
  return w;
}
std::string u8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}
std::string q(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"') o += "\\\"";
    else if (c == '\\') o += "\\\\";
    else if (c == '\n') o += "\\n";
    else if (c == '\t') o += "\\t";
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  return o + "\"";
}
std::string lower(std::string s) {
  for (auto& c : s) c = (char)tolower((unsigned char)c);
  return s;
}

// ---- masking: the key shapes of src/hands-desktop.ts (scanned by hand: no regex over long output) ----
bool isW(char c) { return isalnum((unsigned char)c) || c == '_'; }
bool inSet(char c, const char* set) {
  if (set[0] == 'A') return isalnum((unsigned char)c) != 0;                             // [A-Za-z0-9]
  if (set[0] == 'D') return isalnum((unsigned char)c) || c == '-' || c == '_';          // [\w-]
  if (set[0] == 'H') return isalnum((unsigned char)c) || c == '-';                      // [A-Za-z0-9-]
  if (set[0] == 'U') return isdigit((unsigned char)c) || (c >= 'A' && c <= 'Z');        // [0-9A-Z]
  return false;
}
size_t runOf(const std::string& s, size_t i, const char* set) {
  size_t j = i;
  while (j < s.size() && inSet(s[j], set)) j++;
  return j - i;
}
std::string mask(const std::string& s) {
  struct Shape { const char* prefix; const char* set; size_t min; bool exact; };
  static const Shape shapes[] = {{"sk-", "D", 16, false}, {"sk_live_", "A", 10, false}, {"sk_test_", "A", 10, false}, {"rk_live_", "A", 10, false}, {"rk_test_", "A", 10, false},
                                 {"ghp_", "A", 20, false}, {"gho_", "A", 20, false}, {"ghu_", "A", 20, false}, {"ghs_", "A", 20, false}, {"ghr_", "A", 20, false},
                                 {"xoxa-", "H", 10, false}, {"xoxb-", "H", 10, false}, {"xoxp-", "H", 10, false}, {"xoxr-", "H", 10, false}, {"xoxs-", "H", 10, false},
                                 {"AKIA", "U", 16, true}, {"xai-", "A", 20, false}};
  std::string o;
  o.reserve(s.size());
  for (size_t i = 0; i < s.size();) {
    bool boundary = i == 0 || !isW(s[i - 1]);
    size_t cut = 0;
    if (boundary) {
      for (auto& sh : shapes) {
        size_t n = strlen(sh.prefix);
        if (s.compare(i, n, sh.prefix) != 0) continue;
        size_t r = runOf(s, i + n, sh.set);
        if (sh.exact ? (r == sh.min) : (r >= sh.min)) { cut = n + r; break; }
      }
      // sara_dev. / sara_hands. / sara_m. tokens: two more dotted parts.
      for (const char* p : {"sara_dev.", "sara_hands.", "sara_m."}) {
        if (cut || s.compare(i, strlen(p), p) != 0) continue;
        size_t j = i + strlen(p), a = runOf(s, j, "D");
        if (a && j + a < s.size() && s[j + a] == '.') { size_t b = runOf(s, j + a + 1, "D"); if (b) cut = j + a + 1 + b - i; }
      }
      // JWTs: eyJ…{8,}.…{8,}.…{8,}
      if (!cut && s.compare(i, 3, "eyJ") == 0) {
        size_t j = i + 3, a = runOf(s, j, "D");
        if (a >= 8 && j + a < s.size() && s[j + a] == '.') {
          size_t k = j + a + 1, b = runOf(s, k, "D");
          if (b >= 8 && k + b < s.size() && s[k + b] == '.') { size_t c = runOf(s, k + b + 1, "D"); if (c >= 8) cut = k + b + 1 + c - i; }
        }
      }
    }
    if (cut) { o += "[hidden]"; i += cut; }
    else o += s[i++];
  }
  return o;
}
/** Control characters other than newline and tab go; \r\n becomes \n. */
std::string plain(const std::string& s) {
  std::string o;
  o.reserve(s.size());
  for (unsigned char c : s) if (c == '\n' || c == '\t' || c >= 0x20) if (c != 0x7f) o += (char)c;
  return o;
}
std::string capped(const std::string& s, size_t max, bool& truncated) {
  truncated = s.size() > max;
  if (!truncated) return s;
  size_t head = max / 4, tail = max - head - 80;
  return s.substr(0, head) + "\n[... " + std::to_string(s.size() - head - tail) + " characters left out ...]\n" + s.substr(s.size() - tail);
}

bool elevated() {
  HANDLE tok = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tok)) return false;
  TOKEN_ELEVATION e{};
  DWORD n = 0;
  bool yes = GetTokenInformation(tok, TokenElevation, &e, sizeof e, &n) && e.TokenIsElevated;
  CloseHandle(tok);
  return yes;
}
/** The screen is locked or the secure desktop is up (walk-away): nothing new starts. */
bool locked() {
  HDESK d = OpenInputDesktop(0, FALSE, DESKTOP_SWITCHDESKTOP);
  if (!d) return true;
  bool ok = SwitchDesktop(d) != FALSE;
  CloseDesktop(d);
  return !ok;
}

// ---- the card (this window has no network or web approval path) ----
struct Panel { std::wstring title, text; bool task, destructive; std::atomic<HWND> window{nullptr}; std::atomic<bool> done{false}; int answer = 0; };
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
  WNDCLASSEXW wc{sizeof(wc)};
  wc.hInstance = inst; wc.lpfnWndProc = proc; wc.lpszClassName = L"SaraRunApproval";
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW); wc.hbrBackground = GetSysColorBrush(COLOR_WINDOW);
  RegisterClassExW(&wc);
  HWND h = CreateWindowExW(WS_EX_TOPMOST | WS_EX_DLGMODALFRAME | WS_EX_CONTROLPARENT, wc.lpszClassName, p.title.c_str(), WS_CAPTION | WS_SYSMENU | WS_POPUP, CW_USEDEFAULT, CW_USEDEFAULT, 680, 420, nullptr, nullptr, inst, nullptr);
  if (!h) { p.done = true; return; }
  p.window = h;
  SetWindowLongPtrW(h, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(&p));
  SetWindowDisplayAffinity(h, 0x11);  // never in her screenshots
  UINT dpi = GetDpiForWindow(h);
  auto s = [dpi](int n) { return MulDiv(n, dpi, 96); };
  HFONT font = CreateFontW(-s(15), 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
  HFONT mono = CreateFontW(-s(14), 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Consolas");
  auto control = [&](const wchar_t* cls, const std::wstring& text, int id, int x, int y, int width, int height, DWORD flags, DWORD ex = 0, HFONT f = nullptr) {
    HWND c = CreateWindowExW(ex, cls, text.c_str(), WS_CHILD | WS_VISIBLE | flags, s(x), s(y), s(width), s(height), h, (HMENU)(INT_PTR)id, inst, nullptr);
    SendMessageW(c, WM_SETFONT, (WPARAM)(f ? f : font), TRUE);
    return c;
  };
  control(L"STATIC", p.destructive ? L"Sara wants to run a command that may change or delete things" : L"Sara wants to run a command on this computer", 0, 20, 16, 630, 26, SS_NOPREFIX);
  std::wstring shown;
  for (wchar_t c : p.text.substr(0, 4200)) { if (c == L'\n') shown += L"\r\n"; else shown += c; }
  control(L"EDIT", shown, 0, 20, 48, 630, 200, ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | WS_VSCROLL | WS_TABSTOP, WS_EX_CLIENTEDGE, mono);
  control(L"STATIC", L"It runs as you, never as administrator. Stop (Ctrl+Alt+Esc) ends it and everything it started. Closing this window means Don't.", 0, 20, 256, 630, 44, SS_NOPREFIX);
  control(L"BUTTON", L"Allow once", 101, 20, 312, 140, 44, WS_TABSTOP | BS_PUSHBUTTON);
  if (p.task) control(L"BUTTON", L"Allow for this task", 102, 172, 312, 230, 44, WS_TABSTOP | BS_PUSHBUTTON);
  HWND deny = control(L"BUTTON", L"Don't", IDCANCEL, 510, 312, 140, 44, WS_TABSTOP | BS_DEFPUSHBUTTON);
  SetWindowPos(h, HWND_TOPMOST, 160, 110, s(680), s(420), SWP_SHOWWINDOW);
  SetForegroundWindow(h);
  SetFocus(deny);
  MSG m;
  while (GetMessageW(&m, nullptr, 0, 0) > 0) if (!IsDialogMessageW(h, &m)) { TranslateMessage(&m); DispatchMessageW(&m); }
  p.window = nullptr;
  DeleteObject(font);
  DeleteObject(mono);
  p.done = true;
}
/** 0 Don't, 1 once, 2 this task. */
int ask(const std::wstring& text, bool taskChoice, bool destructive, bool test, const std::atomic<bool>* cancel) {
  Panel p;
  p.title = test ? L"TEST Sara: run a command" : L"Sara: run a command";
  p.text = text; p.task = taskChoice; p.destructive = destructive;
  std::thread ui([&] { show(p); });
  while (!p.done) { if (cancel && cancel->load()) if (HWND h = p.window.load()) PostMessageW(h, WM_CLOSE, 0, 0); Sleep(20); }
  ui.join();
  return cancel && cancel->load() ? 0 : p.answer;
}

/** The policy: read-only auto (opt-in), destructive always once, then the level and the task grants. */
Reply approve(const Args& a, Ctx& ctx, const std::wstring& text, bool readOnly, bool destructive) {
  Settings s = settings();
  int level = a.approvalLevel == "ask" ? 0 : s.level;  // the server can make it stricter, never looser
  if (readOnly && s.readOnlyAuto && a.approvalLevel != "ask") return {};
  std::string task = a.task.substr(0, 160);
  ULONGLONG now = GetTickCount64();
  {
    std::lock_guard<std::mutex> l(g_m);
    for (auto it = g_grants.begin(); it != g_grants.end();) it = now - it->second > kGrantMs ? g_grants.erase(it) : std::next(it);
    if (!destructive && (level == 2 || (level == 1 && !task.empty() && g_grants.count(task)))) { g_grants[task] = now; return {}; }
  }
  if (ctx.ev) ctx.ev("\"state\":\"asking\"");
  if (ctx.approving) *ctx.approving = true;
  int answer = ask(text, !destructive && level == 1 && !task.empty(), destructive, s.test, ctx.cancel);
  if (ctx.approving) *ctx.approving = false;
  if (!answer || (ctx.cancel && ctx.cancel->load())) return {"", "denied_local", "The person at this computer said no."};
  if (answer == 2 && !task.empty()) { std::lock_guard<std::mutex> l(g_m); g_grants[task] = GetTickCount64(); }
  return {};
}

std::wstring knownFolder(REFKNOWNFOLDERID id) {
  PWSTR p = nullptr;
  std::wstring out;
  if (SUCCEEDED(SHGetKnownFolderPath(id, 0, nullptr, &p))) out = p;
  CoTaskMemFree(p);
  return out;
}
std::wstring systemExe(const wchar_t* rel) {
  wchar_t dir[MAX_PATH]{};
  GetSystemDirectoryW(dir, MAX_PATH);
  return std::wstring(dir) + rel;
}
std::string base64(const std::wstring& w) {
  DWORD n = 0;
  const BYTE* b = reinterpret_cast<const BYTE*>(w.data());
  DWORD len = (DWORD)(w.size() * sizeof(wchar_t));
  CryptBinaryToStringA(b, len, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &n);
  std::string s(n, '\0');
  CryptBinaryToStringA(b, len, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, s.data(), &n);
  s.resize(n);
  return s;
}

Reply runCommand(const Args& a, Ctx& ctx) {
  std::string command = a.command;
  command.erase(std::remove(command.begin(), command.end(), '\r'), command.end());
  while (!command.empty() && isspace((unsigned char)command.back())) command.pop_back();
  while (!command.empty() && isspace((unsigned char)command.front())) command.erase(command.begin());
  if (command.empty()) return {"", "denied_local", "command: the PowerShell or cmd command to run."};
  if (command.size() > kCommandChars) return {"", "denied_local", "That command is longer than 4000 characters."};
  static const std::regex elevate(R"((-verb\s+['"]?runas\b)|(\brunas(\.exe)?\b)|(\bg?sudo\b)|(\bStart-Process\b[^\n]*-Verb\b))", std::regex::icase);
  if (std::regex_search(command, elevate)) return {"", "denied_local", "Commands never run as administrator on this computer (no runas, sudo or -Verb RunAs). Ask the person here to do that part themselves."};
  if (elevated()) return {"", "denied_local", "The Sara app is running as administrator here, so commands are refused (they never run elevated). Start the app normally."};
  bool cmd = lower(a.shell) == "cmd";
  std::wstring cwd = wide(a.cwd);
  if (cwd.empty() || cwd == L"~") cwd = knownFolder(FOLDERID_Profile);
  else if (cwd[0] == L'~') cwd = knownFolder(FOLDERID_Profile) + cwd.substr(1);
  if (cwd.rfind(L"\\\\", 0) == 0 || cwd.rfind(L"//", 0) == 0) return {"", "denied_local", "cwd: a folder on this computer, not a network share."};
  DWORD at = GetFileAttributesW(cwd.c_str());
  if (at == INVALID_FILE_ATTRIBUTES || !(at & FILE_ATTRIBUTE_DIRECTORY)) return {"", "not_found", "That folder doesn't exist on this computer."};
  int timeoutMs = (int)std::min(600000.0, std::max(5000.0, a.timeoutMs));
  bool destructive = destructiveCommand(command), readOnly = !destructive && readOnlyCommand(command);
  std::string where = a.cwd.empty() ? "~ (home)" : a.cwd;
  Reply ok = approve(a, ctx, wide(std::string(cmd ? "Command Prompt" : "PowerShell") + " in " + where + (destructive ? " (this may change or delete things)" : "") + ":\n" + command), readOnly, destructive);
  if (!ok.code.empty()) { if (ctx.log) ctx.log("didn't run a command (said no)", command); return ok; }
  if (ctx.cancel && ctx.cancel->load()) return {"", "stopped", "Stopped."};
  if (ctx.ev) ctx.ev("\"state\":\"running\"");

  // The command line: PowerShell gets it as -EncodedCommand (no quoting), cmd as /s /c "…".
  std::wstring exe, line;
  if (cmd) {
    exe = systemExe(L"\\cmd.exe");
    line = L"\"" + exe + L"\" /d /s /c \"chcp 65001>nul & " + wide(command) + L"\"";
  } else {
    exe = systemExe(L"\\WindowsPowerShell\\v1.0\\powershell.exe");
    std::wstring script = L"[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; " + wide(command);
    line = L"\"" + exe + L"\" -NoLogo -NoProfile -NonInteractive -EncodedCommand " + wide(base64(script));
  }
  SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
  HANDLE rd = nullptr, wr = nullptr;
  if (!CreatePipe(&rd, &wr, &sa, 0)) return {"", "error", "Couldn't start the command (no pipe)."};
  SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
  HANDLE nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
  // Only these two handles are inherited (nothing else of the app leaks into the command).
  SIZE_T attrSize = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attrSize);
  std::vector<BYTE> attrBuf(attrSize);
  auto attrs = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attrBuf.data());
  InitializeProcThreadAttributeList(attrs, 1, 0, &attrSize);
  HANDLE inherit[2] = {wr, nul};
  UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherit, sizeof inherit, nullptr, nullptr);
  STARTUPINFOEXW si{};
  si.StartupInfo.cb = sizeof si;
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = nul;
  si.StartupInfo.hStdOutput = wr;
  si.StartupInfo.hStdError = wr;
  si.lpAttributeList = attrs;
  PROCESS_INFORMATION pi{};
  std::vector<wchar_t> buf(line.begin(), line.end());
  buf.push_back(0);
  BOOL started = CreateProcessW(exe.c_str(), buf.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, nullptr, cwd.c_str(), &si.StartupInfo, &pi);
  DeleteProcThreadAttributeList(attrs);
  CloseHandle(wr);
  if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
  if (!started) { CloseHandle(rd); return {"", "error", "Couldn't start " + std::string(cmd ? "cmd" : "PowerShell") + " (error " + std::to_string(GetLastError()) + ")."}; }
  // A Job object: Stop, the deadline and the end of the command end every process it started.
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION li{};
  li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  bool jobOk = job && SetInformationJobObject(job, JobObjectExtendedLimitInformation, &li, sizeof li) && AssignProcessToJobObject(job, pi.hProcess);
  if (!jobOk) {
    // Without a job the tree can't be stopped: refuse rather than run what can't be stopped.
    TerminateProcess(pi.hProcess, 1);
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess); CloseHandle(rd);
    if (job) CloseHandle(job);
    return {"", "error", "Couldn't put the command where Stop can end it, so it didn't run."};
  }
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);
  std::mutex om;
  std::string all, pending;
  std::thread reader([&] {
    char b[4096];
    DWORD n = 0;
    while (ReadFile(rd, b, sizeof b, &n, nullptr) && n) {
      std::lock_guard<std::mutex> l(om);
      if (all.size() < kOutputChars * 4) all.append(b, n);
      pending.append(b, n);
    }
  });
  ULONGLONG t0 = GetTickCount64(), lastFlush = 0;
  size_t live = 0;
  bool timedOut = false, stopped = false;
  auto flush = [&] {
    std::string c;
    { std::lock_guard<std::mutex> l(om); c.swap(pending); }
    if (c.empty() || live >= kLiveChars || !ctx.ev) return;
    c = mask(plain(c));
    if (c.size() > kChunkChars) c = c.substr(0, kChunkChars);
    if (c.size() > kLiveChars - live) c = c.substr(0, kLiveChars - live);
    live += c.size();
    ctx.ev("\"state\":\"running\",\"chunk\":" + q(c));
  };
  for (;;) {
    DWORD w = WaitForSingleObject(pi.hProcess, 100);
    if (w == WAIT_OBJECT_0) break;
    if (ctx.cancel && ctx.cancel->load()) { stopped = true; TerminateJobObject(job, 1); }
    else if (GetTickCount64() - t0 > (ULONGLONG)timeoutMs) { timedOut = true; TerminateJobObject(job, 1); }
    if (GetTickCount64() - lastFlush > 250) { lastFlush = GetTickCount64(); flush(); }
  }
  DWORD code = 0;
  GetExitCodeProcess(pi.hProcess, &code);
  // Whatever the command left running ends with it (use pc_open to open an app that stays).
  TerminateJobObject(job, 1);
  reader.join();
  flush();
  CloseHandle(rd);
  CloseHandle(pi.hProcess);
  CloseHandle(job);
  bool truncated = false;
  std::string out = capped(mask(plain(all)), kOutputChars, truncated);
  double seconds = (GetTickCount64() - t0) / 100 / 10.0;
  char secs[32];
  snprintf(secs, sizeof secs, "%.1f", seconds);
  if (ctx.log) ctx.log(stopped ? "ran a command (stopped)" : timedOut ? "ran a command (timed out)" : "ran a command (exit " + std::to_string((int)code) + ")", command);
  return {"{\"exitCode\":" + (stopped || timedOut ? std::string("null") : std::to_string((int)code)) + ",\"output\":" + q(out) + ",\"truncated\":" + (truncated ? "true" : "false") + ",\"seconds\":" + secs + ",\"timedOut\":" + (timedOut ? "true" : "false") + ",\"stopped\":" + (stopped ? "true" : "false") + "}", "", ""};
}

/** An installed app by its Start-menu name (a shortcut there), never a path or a command line. */
std::wstring findShortcut(const std::wstring& dir, const std::wstring& name, int depth) {
  if (depth > 4) return {};
  WIN32_FIND_DATAW f;
  HANDLE h = FindFirstFileW((dir + L"\\*").c_str(), &f);
  if (h == INVALID_HANDLE_VALUE) return {};
  std::wstring hit;
  do {
    std::wstring n = f.cFileName;
    if (n == L"." || n == L"..") continue;
    if (f.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) { hit = findShortcut(dir + L"\\" + n, name, depth + 1); }
    else if (n.size() > 4 && _wcsicmp(n.substr(n.size() - 4).c_str(), L".lnk") == 0 && _wcsicmp(n.substr(0, n.size() - 4).c_str(), name.c_str()) == 0) hit = dir + L"\\" + n;
  } while (hit.empty() && FindNextFileW(h, &f));
  FindClose(h);
  return hit;
}

Reply openThing(const Args& a, Ctx& ctx) {
  std::string t = a.target;
  while (!t.empty() && isspace((unsigned char)t.back())) t.pop_back();
  while (!t.empty() && isspace((unsigned char)t.front())) t.erase(t.begin());
  if (t.empty() || t.size() > 2000) return {"", "denied_local", "target: a web address, a full file or folder path, or an installed app's name."};
  for (unsigned char c : t) if (c < 0x20) return {"", "denied_local", "That has control characters."};
  static const std::regex scheme(R"(^[a-z][a-z0-9+.-]*://)", std::regex::icase), web(R"(^(https?://|mailto:))", std::regex::icase), drive(R"(^[a-z]:[\\/])", std::regex::icase);
  static const std::regex runnable(R"(\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|pif|lnk|url|reg|hta|cpl|jar|appref-ms|application|gadget|inf|scf)$)", std::regex::icase);
  static const std::regex appName(R"(^[A-Za-z0-9_ .+&'()-]{1,80}$)");
  std::wstring file, kind;
  if (std::regex_search(t, scheme) || lower(t).rfind("mailto:", 0) == 0) {
    if (!std::regex_search(t, web)) return {"", "denied_local", "Only http, https and mailto addresses are opened."};
    file = wide(t); kind = L"url";
  } else if (std::regex_search(t, drive) || t[0] == '~') {
    if (std::regex_search(t, runnable)) return {"", "denied_local", "Opening a program or script file is refused (use a command the person approves, or open the app by its name)."};
    file = wide(t);
    if (file[0] == L'~') file = knownFolder(FOLDERID_Profile) + file.substr(1);
    if (GetFileAttributesW(file.c_str()) == INVALID_FILE_ATTRIBUTES) return {"", "not_found", "There is no such file or folder on this computer."};
    kind = L"path";
  } else {
    if (!std::regex_match(t, appName)) return {"", "denied_local", "An app is opened by its name as in the Start menu (like \"Notepad\"), never a command line."};
    for (auto dir : {knownFolder(FOLDERID_Programs), knownFolder(FOLDERID_CommonPrograms)}) if (file.empty() && !dir.empty()) file = findShortcut(dir, wide(t), 0);
    if (file.empty()) return {"", "not_found", "No app with that name is in the Start menu here."};
    kind = L"app";
  }
  Reply ok = approve(a, ctx, L"Open " + std::wstring(kind == L"url" ? L"this address" : kind == L"path" ? L"this file or folder" : L"this app") + L":\n" + wide(t), false, false);
  if (!ok.code.empty()) return ok;
  if (ctx.cancel && ctx.cancel->load()) return {"", "stopped", "Stopped."};
  SHELLEXECUTEINFOW ei{sizeof(ei)};
  ei.fMask = SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
  ei.lpVerb = L"open";
  ei.lpFile = file.c_str();
  ei.nShow = SW_SHOWNORMAL;
  if (!ShellExecuteExW(&ei)) return {"", "error", "Windows couldn't open it (error " + std::to_string(GetLastError()) + ")."};
  if (ctx.log) ctx.log(kind == L"url" ? "opened an address" : kind == L"path" ? "opened a file or folder" : "opened an app", t);
  return {"{\"opened\":true,\"kind\":" + q(u8(kind)) + "}", "", ""};
}

}  // namespace

void configure(const Settings& s) {
  std::lock_guard<std::mutex> l(g_m);
  if (s.level != g_s.level || !s.on) g_grants.clear();
  g_s = s;
}
Settings settings() {
  std::lock_guard<std::mutex> l(g_m);
  return g_s;
}
void clearGrants() {
  std::lock_guard<std::mutex> l(g_m);
  g_grants.clear();
}

bool destructiveCommand(const std::string& c) {
  static const std::regex re(
      R"(\b(remove-item|ri|rm|rmdir|rd|del|erase|format(-volume)?|clear-disk|initialize-disk|diskpart|clear-content|set-content|out-file|reg(\.exe)?\s+(add|delete|import|restore)|set-itemproperty|remove-itemproperty|new-itemproperty|stop-computer|restart-computer|shutdown(\.exe)?|logoff|set-executionpolicy|stop-process|spps|taskkill|kill|move-item|mv|move|ren(ame)?(-item)?|copy-item|xcopy|robocopy|cipher|bcdedit|vssadmin|wmic|icacls|takeown|attrib|uninstall(-package)?|msiexec|winget|choco|invoke-webrequest|iwr|curl|wget|invoke-restmethod|irm|invoke-expression|iex|start-bitstransfer|downloadstring|downloadfile|net(\.exe)?\s+(user|localgroup|share)|schtasks|sc(\.exe)?\s+(delete|config|create|stop)|new-service|set-service|disable-|enable-|git\s+(push|reset|clean|checkout|rebase|commit|merge))\b)",
      std::regex::icase);
  return std::regex_search(c, re);
}
bool readOnlyCommand(const std::string& command) {
  std::string c = command;
  while (!c.empty() && isspace((unsigned char)c.back())) c.pop_back();
  while (!c.empty() && isspace((unsigned char)c.front())) c.erase(c.begin());
  if (c.empty() || c.size() > 400 || c.find_first_of(";&<>`{}\r\n") != std::string::npos || c.find("$(") != std::string::npos || c.find("@(") != std::string::npos) return false;
  static const std::regex var(R"(\$(?!env:[A-Za-z_]\w*))", std::regex::icase);
  if (std::regex_search(c, var)) return false;
  static const std::regex head(R"(^(get-childitem|gci|dir|ls|get-content|gc|type|cat|get-location|gl|pwd|get-date|date\s*/t|whoami|hostname|get-process|gps|ps|get-item|gi|test-path|get-volume|get-psdrive|git\s+(status|log|diff|branch|show|remote\s+-v))(\s|$))", std::regex::icase);
  static const std::regex pipe(R"(^(select-object|select|format-table|ft|format-list|fl|sort-object|sort|measure-object|measure|out-string)(\s|$))", std::regex::icase);
  std::vector<std::string> parts;
  size_t s = 0;
  for (size_t p; (p = c.find('|', s)) != std::string::npos; s = p + 1) parts.push_back(c.substr(s, p - s));
  parts.push_back(c.substr(s));
  for (auto& p : parts) {
    while (!p.empty() && isspace((unsigned char)p.back())) p.pop_back();
    while (!p.empty() && isspace((unsigned char)p.front())) p.erase(p.begin());
  }
  if (!std::regex_search(parts[0], head)) return false;
  for (size_t i = 1; i < parts.size(); i++) if (!std::regex_search(parts[i], pipe)) return false;
  return true;
}

Reply handle(const Args& a, Ctx& ctx) {
  if (!settings().on) return {"", "denied_local", "\"Let her run commands on this computer\" is off here: only the person here can switch it on, in the Sara app (Settings, Computer use)."};
  if ((ctx.paused && ctx.paused()) || locked()) return {"", "takeover", "Paused on this computer (the person took over or it is locked): nothing new runs until they are back."};
  if (a.op == "c.run") return runCommand(a, ctx);
  if (a.op == "c.open") return openThing(a, ctx);
  return {"", "unsupported", "This computer doesn't do that."};
}

}  // namespace sararun
