// V4.5 Screen companion native checks (test/v4-screen.test.ts): the Windows port of the rules run on the
// same fake screens as src/screen-companion.ts, and (--live <ScreenWatchFixture.exe>) the real reader on
// the fixture's own fake windows, found by their unique titles. Never the window in front, never anyone's
// real screen.
//   stdin lines (UTF-8, fields split by \x1f, texts by \x1e):
//     F title app dialog(0|1) hidden own(0|1) texts       -> kind \x1f line
//     ON                                                  -> ok
//     P ms now                                            -> paused-for
//     C now title app dialog hidden own texts             -> kind \x1f app \x1f line | -
#include <windows.h>
#include <fcntl.h>
#include <io.h>

#include <cstdio>
#include <iostream>
#include <string>
#include <vector>

#include "screen-watch.h"

static std::wstring wide(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
  return w;
}
static std::string u8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}
static std::vector<std::string> split(const std::string& s, char sep) {
  std::vector<std::string> out;
  size_t a = 0;
  for (size_t i = 0; i <= s.size(); i++)
    if (i == s.size() || s[i] == sep) {
      out.push_back(s.substr(a, i - a));
      a = i + 1;
    }
  return out;
}
static sarawatch::Look lookOf(const std::vector<std::string>& f, size_t at) {
  sarawatch::Look l;
  l.title = wide(f[at]);
  l.app = wide(f[at + 1]);
  l.dialog = f[at + 2] == "1";
  l.hidden = f[at + 3];
  l.own = f[at + 4] == "1";
  if (!f[at + 5].empty())
    for (auto& t : split(f[at + 5], '\x1e')) l.texts.push_back(wide(t));
  return l;
}
static void say(const std::string& s) {
  fwrite(s.data(), 1, s.size(), stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static HWND waitFor(const std::wstring& title) {
  for (int i = 0; i < 100; i++) {
    if (HWND h = FindWindowW(nullptr, title.c_str())) return h;
    Sleep(50);
  }
  return nullptr;
}
static bool anyHas(const sarawatch::Look& l, const wchar_t* s) {
  for (auto& t : l.texts)
    if (t.find(s) != std::wstring::npos) return true;
  return l.title.find(s) != std::wstring::npos;
}

static int live(const std::wstring& fixture) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  std::wstring tag = L"#" + std::to_wstring(GetCurrentProcessId());
  PROCESS_INFORMATION procs[2]{};
  const wchar_t* modes[2] = {L"error", L"form"};
  for (int i = 0; i < 2; i++) {
    std::wstring cmd = L"\"" + fixture + L"\" " + modes[i] + L" " + tag;
    STARTUPINFOW si{sizeof si};
    if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &procs[i])) {
      say("no fixture");
      return 2;
    }
  }
  sarawatch::Watch watch;
  watch.on = true;
  const wchar_t* titles[2] = {L"Invoice Maker ", L"Sign up "};
  for (int i = 0; i < 2; i++) {
    HWND h = waitFor(titles[i] + tag);
    if (!h) {
      say(std::string("no window ") + (i ? "form" : "error"));
      continue;
    }
    sarawatch::Look l = sarawatch::lookAt(h);
    sarawatch::Finding f = sarawatch::finding(l);
    int offers = 0;
    for (int k = 0; k < 6; k++) {
      sarawatch::Offer o;
      if (watch.check(sarawatch::lookAt(h), 1000000LL * (i + 1) + k * sarawatch::kEveryMs, o)) offers++;
    }
    say(std::string(i ? "form" : "error") + "\x1f" + u8(f.kind) + "\x1f" + u8(f.line) + "\x1f" + (l.dialog ? "1" : "0") + "\x1f" + (anyHas(l, L"typed-value-123") ? "1" : "0") + "\x1f" +
        (anyHas(l, L"pw-secret-456") ? "1" : "0") + "\x1f" + std::to_string(offers) + "\x1f" + std::to_string(l.texts.size()));
    PostMessageW(h, WM_CLOSE, 0, 0);
  }
  for (auto& p : procs) {
    if (WaitForSingleObject(p.hProcess, 3000) != WAIT_OBJECT_0) TerminateProcess(p.hProcess, 0);
    CloseHandle(p.hProcess);
    CloseHandle(p.hThread);
  }
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  _setmode(_fileno(stdout), _O_BINARY);
  if (argc > 2 && std::wstring(argv[1]) == L"--live") return live(argv[2]);
  sarawatch::Watch watch;
  std::string line;
  while (std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    auto f = split(line, '\x1f');
    if (f[0] == "F" && f.size() >= 7) {
      auto r = sarawatch::finding(lookOf(f, 1));
      say(u8(r.kind) + "\x1f" + u8(r.line));
    } else if (f[0] == "ON") {
      watch.on = true;
      say("ok");
    } else if (f[0] == "P" && f.size() >= 3) {
      watch.pause(std::stoll(f[1]), std::stoll(f[2]));
      say(std::to_string(watch.pausedFor(std::stoll(f[2]))));
    } else if (f[0] == "C" && f.size() >= 8) {
      sarawatch::Offer o;
      say(watch.check(lookOf(f, 2), std::stoll(f[1]), o) ? u8(o.kind) + "\x1f" + u8(o.app) + "\x1f" + u8(o.line) : "-");
    } else say("?");
  }
  return 0;
}
