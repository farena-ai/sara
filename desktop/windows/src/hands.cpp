// Phase 87 (computer use CU1): Sara's hands on Windows. See hands.h and docs/design/COMPUTER_USE.md.
// Phase 89 (CU3): the dev tunnel. c.tunnel opens a listener on 127.0.0.1 only (Winsock); each
// connection the Sara browser makes to it is a stream over the hands connection to the dev server her
// job runs on the server (DevTunnels below). Loopback only, at most 4 tunnels and 64 connections
// each, all closed on c.untunnel, Stop and when the connection drops.
// Phase 88 (CU2): acting in the Sara browser (find, click, type, select, keys, scroll, upload,
// downloads) through the shared page agent and real DevTools input events; the always-on-top
// "Sara is working" badge with Stop / Resume, the global stop shortcut Ctrl+Alt+Esc, takeover (real
// mouse or keyboard input in her window pauses her unless "Let Sara keep control"), the device's
// input rate limit, the local log "What Sara did on this computer", and token renewal.
//
// Threads: one connection thread (connect, hello, receive; reconnects 1, 2, 5, 10, 30 s), one worker
// thread (runs ops one at a time, as the server sends them), and the Sara browser's pipe reader
// (DevTools answers and events: console, network, page loads). Pictures go back as binary frames:
// a 4-byte big-endian header length, a JSON header, then the JPEG bytes.
#include "hands.h"

#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <winhttp.h>
#include <wincrypt.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <map>
#include <mutex>
#include <regex>
#include <set>
#include <thread>
#include <vector>
#include <algorithm>
#include <memory>
#include <fstream>
#include <sstream>

namespace sarahands {
namespace {

// ---------------- a small JSON reader/writer (enough for the protocol and DevTools) ----------------
struct J {
  enum T { Null, Bool, Num, Str, Arr, Obj } t = Null;
  bool b = false;
  double n = 0;
  std::string s;
  std::vector<J> a;
  std::vector<std::pair<std::string, J>> o;
  const J& operator[](const char* k) const {
    static const J none;
    if (t != Obj) return none;
    for (auto& kv : o)
      if (kv.first == k) return kv.second;
    return none;
  }
  bool has(const char* k) const {
    if (t != Obj) return false;
    for (auto& kv : o)
      if (kv.first == k) return true;
    return false;
  }
  std::string str(const std::string& def = "") const {
    if (t == Str) return s;
    if (t == Num) {
      char buf[40];
      if (n == (double)(long long)n) snprintf(buf, sizeof buf, "%lld", (long long)n);
      else snprintf(buf, sizeof buf, "%g", n);
      return buf;
    }
    return def;
  }
  double num(double def = 0) const { return t == Num ? n : t == Str ? atof(s.c_str()) : def; }
  bool truthy() const { return t == Bool ? b : t == Num ? n != 0 : t == Str ? !s.empty() : t != Null; }
};

struct Parser {
  const std::string& x;
  size_t i = 0;
  bool bad = false;
  explicit Parser(const std::string& s) : x(s) {}
  void ws() {
    while (i < x.size() && (x[i] == ' ' || x[i] == '\n' || x[i] == '\r' || x[i] == '\t')) i++;
  }
  static void utf8(std::string& out, unsigned cp) {
    if (cp < 0x80) out += (char)cp;
    else if (cp < 0x800) {
      out += (char)(0xC0 | (cp >> 6));
      out += (char)(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out += (char)(0xE0 | (cp >> 12));
      out += (char)(0x80 | ((cp >> 6) & 0x3F));
      out += (char)(0x80 | (cp & 0x3F));
    } else {
      out += (char)(0xF0 | (cp >> 18));
      out += (char)(0x80 | ((cp >> 12) & 0x3F));
      out += (char)(0x80 | ((cp >> 6) & 0x3F));
      out += (char)(0x80 | (cp & 0x3F));
    }
  }
  unsigned hex4() {
    if (i + 4 > x.size()) {
      bad = true;
      return 0;
    }
    unsigned v = 0;
    for (int k = 0; k < 4; k++) {
      char c = x[i++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= c - '0';
      else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
      else bad = true;
    }
    return v;
  }
  std::string string() {
    std::string out;
    i++;  // "
    while (i < x.size() && x[i] != '"') {
      char c = x[i++];
      if (c != '\\') {
        out += c;
        continue;
      }
      if (i >= x.size()) break;
      char e = x[i++];
      switch (e) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'u': {
          unsigned cp = hex4();
          if (cp >= 0xD800 && cp <= 0xDBFF && i + 6 <= x.size() && x[i] == '\\' && x[i + 1] == 'u') {
            i += 2;
            unsigned lo = hex4();
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          }
          utf8(out, cp);
          break;
        }
        default: out += e;
      }
    }
    if (i >= x.size()) bad = true;
    i++;
    return out;
  }
  J value(int depth = 0) {
    J v;
    ws();
    if (i >= x.size() || depth > 200) {
      bad = true;
      return v;
    }
    char c = x[i];
    if (c == '{') {
      v.t = J::Obj;
      i++;
      ws();
      if (i < x.size() && x[i] == '}') {
        i++;
        return v;
      }
      while (!bad) {
        ws();
        if (i >= x.size() || x[i] != '"') {
          bad = true;
          break;
        }
        std::string k = string();
        ws();
        if (i >= x.size() || x[i] != ':') {
          bad = true;
          break;
        }
        i++;
        v.o.emplace_back(k, value(depth + 1));
        ws();
        if (i < x.size() && x[i] == ',') {
          i++;
          continue;
        }
        if (i < x.size() && x[i] == '}') {
          i++;
          break;
        }
        bad = true;
      }
    } else if (c == '[') {
      v.t = J::Arr;
      i++;
      ws();
      if (i < x.size() && x[i] == ']') {
        i++;
        return v;
      }
      while (!bad) {
        v.a.push_back(value(depth + 1));
        ws();
        if (i < x.size() && x[i] == ',') {
          i++;
          continue;
        }
        if (i < x.size() && x[i] == ']') {
          i++;
          break;
        }
        bad = true;
      }
    } else if (c == '"') {
      v.t = J::Str;
      v.s = string();
    } else if (x.compare(i, 4, "true") == 0) {
      v.t = J::Bool;
      v.b = true;
      i += 4;
    } else if (x.compare(i, 5, "false") == 0) {
      v.t = J::Bool;
      i += 5;
    } else if (x.compare(i, 4, "null") == 0) {
      i += 4;
    } else {
      size_t st = i;
      while (i < x.size() && (isdigit((unsigned char)x[i]) || x[i] == '-' || x[i] == '+' || x[i] == '.' || x[i] == 'e' || x[i] == 'E')) i++;
      if (st == i) bad = true;
      v.t = J::Num;
      v.n = atof(x.substr(st, i - st).c_str());
    }
    return v;
  }
};
J parse(const std::string& s, bool* ok = nullptr) {
  Parser p(s);
  J v = p.value();
  if (ok) *ok = !p.bad;
  return v;
}
/** A JSON string literal. */
std::string q(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) {
          char b[8];
          snprintf(b, sizeof b, "\\u%04x", c);
          o += b;
        } else o += (char)c;
    }
  }
  return o + "\"";
}
std::string dump(const J& v) {
  switch (v.t) {
    case J::Null: return "null";
    case J::Bool: return v.b ? "true" : "false";
    case J::Num: return v.str();
    case J::Str: return q(v.s);
    case J::Arr: {
      std::string o = "[";
      for (size_t k = 0; k < v.a.size(); k++) o += (k ? "," : "") + dump(v.a[k]);
      return o + "]";
    }
    case J::Obj: {
      std::string o = "{";
      for (size_t k = 0; k < v.o.size(); k++) o += (k ? "," : "") + q(v.o[k].first) + ":" + dump(v.o[k].second);
      return o + "}";
    }
  }
  return "null";
}
std::string num(double d) {
  J v;
  v.t = J::Num;
  v.n = d;
  return v.str();
}

std::string u8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}
std::wstring wide(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
  return w;
}

/** Text that looks like a key or token is masked before it leaves this computer. */
std::string mask(std::string t) {
  static const std::vector<std::regex> shapes = {
      std::regex("sk-[A-Za-z0-9_-]{16,}"),
      std::regex("[sr]k_(live|test)_[A-Za-z0-9]{10,}"),
      std::regex("gh[pousr]_[A-Za-z0-9]{20,}"),
      std::regex("github_pat_[A-Za-z0-9_]{20,}"),
      std::regex("xox[abprs]-[A-Za-z0-9-]{10,}"),
      std::regex("AKIA[0-9A-Z]{16}"),
      std::regex("AIza[0-9A-Za-z_-]{30,}"),
      std::regex("xai-[A-Za-z0-9]{20,}"),
      std::regex("sara_(dev|hands|m)\\.[\\w-]+\\.[\\w-]+"),
      std::regex("eyJ[\\w-]{8,}\\.[\\w-]{8,}\\.[\\w-]{8,}"),
  };
  for (auto& re : shapes) t = std::regex_replace(t, re, "[hidden]");
  return t;
}
std::string shortText(const std::string& s, size_t n = 500) {
  std::string o;
  o.reserve(std::min(s.size(), n));
  bool sp = false;
  for (char c : s) {
    bool w = c == ' ' || c == '\n' || c == '\r' || c == '\t';
    if (w) {
      if (!sp && !o.empty()) o += ' ';
      sp = true;
    } else {
      o += c;
      sp = false;
    }
    if (o.size() >= n) break;
  }
  return mask(o);
}

std::vector<BYTE> b64dec(const std::string& b64) {
  DWORD n = 0;
  if (!CryptStringToBinaryA(b64.c_str(), (DWORD)b64.size(), CRYPT_STRING_BASE64, nullptr, &n, nullptr, nullptr)) return {};
  std::vector<BYTE> out(n);
  if (!CryptStringToBinaryA(b64.c_str(), (DWORD)b64.size(), CRYPT_STRING_BASE64, out.data(), &n, nullptr, nullptr)) return {};
  out.resize(n);
  return out;
}

// ---------------- the command set (CU1) and the device's own rules ----------------
const std::set<std::string> kOps = {"b.start", "b.tabs", "b.open", "b.navigate", "b.snapshot", "b.read", "b.screenshot", "b.logs", "b.request", "b.close", "c.ping",
                                    // Phase 88 (CU2)
                                    "b.find", "b.click", "b.type", "b.select", "b.keys", "b.scroll", "b.upload", "b.downloads",
                                    // Phase 89 (CU3): the dev tunnel
                                    "c.tunnel", "c.untunnel"};
/** Ops that act: they count against the input rate limit and stop when the person takes over. */
const std::set<std::string> kInputOps = {"b.click", "b.type", "b.select", "b.keys", "b.scroll", "b.upload"};
const int kMaxChars = 2000;

/** Now as ISO 8601 (UTC). */
std::string isoNow(int addDays = 0) {
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  ULARGE_INTEGER u{{ft.dwLowDateTime, ft.dwHighDateTime}};
  u.QuadPart += (ULONGLONG)addDays * 86400ULL * 10000000ULL;
  ft = {u.LowPart, u.HighPart};
  SYSTEMTIME st;
  FileTimeToSystemTime(&ft, &st);
  char b[40];
  snprintf(b, sizeof b, "%04d-%02d-%02dT%02d:%02d:%02dZ", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
  return b;
}

struct OpError {
  std::string code, message;
};

std::string lowerA(std::string s) {
  for (auto& c : s) c = (char)tolower((unsigned char)c);
  return s;
}

/** The origin of an http(s) address ("http://host:port"), empty when it isn't one. */
std::string originOfUrl(const std::string& url, std::string* path = nullptr, bool* userinfo = nullptr) {
  std::string l = lowerA(url);
  size_t p = l.find("://");
  if (p == std::string::npos) return {};
  std::string scheme = l.substr(0, p);
  if (scheme != "http" && scheme != "https") return {};
  size_t hs = p + 3;
  size_t he = l.find_first_of("/?#", hs);
  std::string auth = l.substr(hs, he == std::string::npos ? std::string::npos : he - hs);
  if (userinfo) *userinfo = auth.find('@') != std::string::npos;
  if (auth.empty()) return {};
  // Default ports are left out (as browsers write origins).
  if (scheme == "http" && auth.size() > 3 && auth.compare(auth.size() - 3, 3, ":80") == 0) auth.resize(auth.size() - 3);
  if (scheme == "https" && auth.size() > 4 && auth.compare(auth.size() - 4, 4, ":443") == 0) auth.resize(auth.size() - 4);
  if (path) *path = he == std::string::npos ? "/" : url.substr(he);
  return scheme + "://" + auth;
}

bool isPreviewPath(const std::string& path) {
  static const std::regex re("^/preview/[0-9a-f]{32}(/|\\?|#|$)");
  return std::regex_search(path, re);
}

/** Whether the Sara browser may load an address (§4.1); `why` says why not. */
bool addressAllowed(const std::string& url, const std::string& serverOrigin, std::string& why) {
  if (url == "about:blank") return true;
  std::string path;
  bool userinfo = false;
  std::string o = originOfUrl(url, &path, &userinfo);
  if (o.empty()) {
    why = "The Sara browser only opens web addresses (http or https).";
    return false;
  }
  if (userinfo) {
    why = "Addresses with a user name or password are not opened.";
    return false;
  }
  if (o == serverOrigin && !isPreviewPath(path)) {
    why = "Sara's own server is never opened in the Sara browser.";
    return false;
  }
  return true;
}

// ---------------- the Sara browser: Edge or Chrome over a DevTools pipe ----------------
std::wstring regAppPath(const wchar_t* exe) {
  for (HKEY root : {HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE}) {
    wchar_t buf[MAX_PATH];
    DWORD n = sizeof(buf);
    std::wstring key = std::wstring(L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\") + exe;
    if (RegGetValueW(root, key.c_str(), nullptr, RRF_RT_REG_SZ, nullptr, buf, &n) == ERROR_SUCCESS && GetFileAttributesW(buf) != INVALID_FILE_ATTRIBUTES) return buf;
  }
  return {};
}
struct BrowserFound {
  std::wstring path;
  std::string kind, name;
};
BrowserFound findBrowser() {
  BrowserFound f;
  std::wstring p = regAppPath(L"msedge.exe");
  if (p.empty()) {
    for (const wchar_t* c : {L"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", L"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"})
      if (GetFileAttributesW(c) != INVALID_FILE_ATTRIBUTES) {
        p = c;
        break;
      }
  }
  if (!p.empty()) return {p, "edge", "Microsoft Edge"};
  p = regAppPath(L"chrome.exe");
  if (p.empty() && GetFileAttributesW(L"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe") != INVALID_FILE_ATTRIBUTES) p = L"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  if (!p.empty()) return {p, "chrome", "Google Chrome"};
  return f;
}

struct LogEntry {
  long long seq;
  std::string json;  // the entry without seq
  std::string requestId;
  int status = 0;
};

struct Tab {
  std::string id, targetId, sessionId, frameId;
  std::deque<LogEntry> logs;
  int consoleErrors = 0, failedRequests = 0, status = 0;
  long long loads = 0;
  long long starts = 0;  // Phase 88: page loads started (an action that navigates waits for its load)
  std::string dialog;    // Phase 88: the last page dialog, closed with Cancel
  std::map<std::string, std::pair<std::string, std::string>> requests;  // requestId → method, url
};

class Browser {
 public:
  std::string serverOrigin;
  BrowserFound found = findBrowser();
  std::wstring profileDir;
  std::wstring downloadsDir;  // Phase 88

  bool running() {
    std::lock_guard<std::mutex> l(m_);
    return alive_;
  }

  void start(OpError& err) {
    if (running()) return;
    if (found.path.empty()) {
      err = {"perm_missing", "There is no Microsoft Edge or Google Chrome on this computer for the Sara browser."};
      return;
    }
    CreateDirectoryW(profileDir.c_str(), nullptr);
    // Two pipes: the browser reads DevTools commands from its fd 3 and writes answers to fd 4.
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
    HANDLE toRd = nullptr, toWr = nullptr, fromRd = nullptr, fromWr = nullptr;
    if (!CreatePipe(&toRd, &toWr, &sa, 0) || !CreatePipe(&fromRd, &fromWr, &sa, 0)) {
      err = {"error", "Couldn't make the pipe to the Sara browser."};
      return;
    }
    SetHandleInformation(toWr, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(fromRd, HANDLE_FLAG_INHERIT, 0);
    // The C runtime's inherited-handles block (lpReserved2): count, one flag byte each, the handles.
    const int count = 5;
    std::vector<BYTE> block(sizeof(int) + count + count * sizeof(HANDLE), 0);
    *reinterpret_cast<int*>(block.data()) = count;
    BYTE* flags = block.data() + sizeof(int);
    HANDLE* handles = reinterpret_cast<HANDLE*>(flags + count);
    for (int k = 0; k < count; k++) handles[k] = INVALID_HANDLE_VALUE;
    flags[3] = 0x01 | 0x08;  // FOPEN | FPIPE
    flags[4] = 0x01 | 0x08;
    handles[3] = toRd;
    handles[4] = fromWr;

    std::wstring args = L"\"" + found.path + L"\" --user-data-dir=\"" + profileDir + L"\" --remote-debugging-pipe --no-first-run --no-default-browser-check" +
                        L" --disable-extensions --disable-sync --disable-background-networking --disable-component-update --disable-default-apps --disable-breakpad --no-pings" +
                        L" --disable-features=Translate,MediaRouter,OptimizationHints,msEdgeSync,msImplicitSignin,msSignInFRE,EdgeCollections,msShopping,msEdgeShoppingUI" +
                        L" --window-size=1280,860" + (found.kind == "edge" ? L" --edge-skip-compat-layer-relaunch" : L"") + L" about:blank";
    STARTUPINFOEXW si{};
    si.StartupInfo.cb = sizeof(si);
    si.StartupInfo.dwFlags = STARTF_USESHOWWINDOW;
    si.StartupInfo.wShowWindow = SW_SHOWNOACTIVATE;  // never steal the owner's focus
    si.StartupInfo.cbReserved2 = (WORD)block.size();
    si.StartupInfo.lpReserved2 = block.data();
    // Only the two pipe ends are inherited (nothing else of this app).
    SIZE_T attrSize = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &attrSize);
    std::vector<BYTE> attrs(attrSize);
    si.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attrs.data());
    InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &attrSize);
    HANDLE inherit[2] = {toRd, fromWr};
    UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherit, sizeof(inherit), nullptr, nullptr);
    PROCESS_INFORMATION pi{};
    std::vector<wchar_t> cmd(args.begin(), args.end());
    cmd.push_back(0);
    BOOL ok = CreateProcessW(found.path.c_str(), cmd.data(), nullptr, nullptr, TRUE, EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &si.StartupInfo, &pi);
    DeleteProcThreadAttributeList(si.lpAttributeList);
    CloseHandle(toRd);
    CloseHandle(fromWr);
    if (!ok) {
      CloseHandle(toWr);
      CloseHandle(fromRd);
      err = {"error", "The Sara browser didn't start."};
      return;
    }
    CloseHandle(pi.hThread);
    {
      std::lock_guard<std::mutex> l(m_);
      pid_ = pi.dwProcessId;
      proc_ = pi.hProcess;
      wr_ = toWr;
      rd_ = fromRd;
      alive_ = true;
      tabs_.clear();
      results_.clear();
    }
    if (reader_.joinable()) reader_.join();
    reader_ = std::thread([this] { readLoop(); });
    // Attach to the first page (it may take a moment to appear).
    for (int k = 0; k < 50; k++) {
      OpError e2;
      J r = call("Target.getTargets", "{}", "", 10000, e2);
      if (!e2.code.empty()) {
        err = e2;
        return;
      }
      for (auto& t : r["targetInfos"].a)
        if (t["type"].str() == "page") attach(t["targetId"].str(), err);
      if (tabCount()) break;
      Sleep(150);
    }
    if (!tabCount()) newTab(err);
    // Phase 88: downloads land in Downloads\Sara, nowhere else.
    if (!downloadsDir.empty()) {
      CreateDirectoryW(downloadsDir.c_str(), nullptr);
      OpError e3;
      call("Browser.setDownloadBehavior", "{\"behavior\":\"allow\",\"downloadPath\":" + q(u8(downloadsDir)) + "}", "", 10000, e3);
    }
  }
  /** The browser's process id (its windows belong to it): takeover looks for input there. */
  DWORD pid() {
    std::lock_guard<std::mutex> l(m_);
    return alive_ ? pid_ : 0;
  }
  long long starts(const std::string& id) {
    std::lock_guard<std::mutex> l(m_);
    return tabs_.count(id) ? tabs_[id].starts : -1;
  }
  /** Waits for a page load to start after `before` (false after `ms`). */
  bool waitStart(const std::string& id, long long before, DWORD ms, const std::atomic<bool>* cancel) {
    std::unique_lock<std::mutex> l(m_);
    auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
    while (alive_ && tabs_.count(id) && tabs_[id].starts == before) {
      if (cancel && cancel->load()) return false;
      if (std::chrono::steady_clock::now() >= until) return false;
      cv_.wait_for(l, std::chrono::milliseconds(50));
    }
    return alive_ && tabs_.count(id);
  }
  std::string takeDialog(const std::string& id) {
    std::lock_guard<std::mutex> l(m_);
    if (!tabs_.count(id)) return {};
    std::string d = tabs_[id].dialog;
    tabs_[id].dialog.clear();
    return d;
  }

  void close() {
    HANDLE proc = nullptr;
    {
      std::lock_guard<std::mutex> l(m_);
      proc = proc_;
    }
    if (running()) send("Browser.close", "{}", "");
    if (proc) {
      if (WaitForSingleObject(proc, 3000) == WAIT_TIMEOUT) TerminateProcess(proc, 0);  // only the browser this app started
    }
    {
      std::lock_guard<std::mutex> l(m_);
      if (wr_) CloseHandle(wr_);
      wr_ = nullptr;
      alive_ = false;
    }
    if (reader_.joinable()) reader_.join();
    std::lock_guard<std::mutex> l(m_);
    if (rd_) CloseHandle(rd_);
    rd_ = nullptr;
    if (proc_) CloseHandle(proc_);
    proc_ = nullptr;
    tabs_.clear();
  }

  /** Sends a DevTools command without waiting. */
  void send(const std::string& method, const std::string& params, const std::string& session) {
    int id;
    {
      std::lock_guard<std::mutex> l(m_);
      id = next_++;
    }
    write("{\"id\":" + std::to_string(id) + ",\"method\":" + q(method) + ",\"params\":" + params + (session.empty() ? "" : ",\"sessionId\":" + q(session)) + "}");
  }

  /** A DevTools command and its answer (or an error). */
  J call(const std::string& method, const std::string& params, const std::string& session, DWORD timeoutMs, OpError& err, const std::atomic<bool>* cancel = nullptr) {
    int id;
    {
      std::lock_guard<std::mutex> l(m_);
      if (!alive_) {
        err = {"error", "The Sara browser was closed."};
        return {};
      }
      id = next_++;
    }
    if (!write("{\"id\":" + std::to_string(id) + ",\"method\":" + q(method) + ",\"params\":" + params + (session.empty() ? "" : ",\"sessionId\":" + q(session)) + "}")) {
      err = {"error", "The Sara browser was closed."};
      return {};
    }
    std::unique_lock<std::mutex> l(m_);
    auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    while (!results_.count(id)) {
      if (!alive_) {
        err = {"error", "The Sara browser was closed."};
        return {};
      }
      if (cancel && cancel->load()) {
        err = {"stopped", "Stopped."};
        return {};
      }
      if (cv_.wait_until(l, std::min(until, std::chrono::steady_clock::now() + std::chrono::milliseconds(100))) == std::cv_status::timeout && std::chrono::steady_clock::now() >= until) {
        err = {"timeout", method + " took too long."};
        return {};
      }
    }
    J r = std::move(results_[id]);
    results_.erase(id);
    if (r.has("error")) {
      err = {"error", r["error"]["message"].str("DevTools error")};
      return {};
    }
    return r["result"];
  }

  bool attach(const std::string& targetId, OpError& err) {
    J r = call("Target.attachToTarget", "{\"targetId\":" + q(targetId) + ",\"flatten\":true}", "", 10000, err);
    if (!err.code.empty()) return false;
    std::string session = r["sessionId"].str();
    std::string id;
    {
      std::lock_guard<std::mutex> l(m_);
      Tab t;
      t.id = "t" + std::to_string(++tabN_);
      t.targetId = targetId;
      t.sessionId = session;
      tabs_[t.id] = t;
      active_ = t.id;
      id = t.id;
    }
    for (const char* d : {"Page.enable", "Runtime.enable", "Network.enable", "Log.enable"}) call(d, "{}", session, 10000, err);
    // §4.1: the server's own pages are refused even when a page sends the browser there.
    call("Fetch.enable", "{\"patterns\":[{\"urlPattern\":" + q(serverOrigin + "/*") + "}]}", session, 10000, err);
    J tree = call("Page.getFrameTree", "{}", session, 10000, err);
    std::lock_guard<std::mutex> l(m_);
    if (tabs_.count(id)) tabs_[id].frameId = tree["frameTree"]["frame"]["id"].str();
    return err.code.empty();
  }

  std::string newTab(OpError& err) {
    J r = call("Target.createTarget", "{\"url\":\"about:blank\"}", "", 10000, err);
    if (!err.code.empty()) return {};
    attach(r["targetId"].str(), err);
    std::lock_guard<std::mutex> l(m_);
    return active_;
  }

  size_t tabCount() {
    std::lock_guard<std::mutex> l(m_);
    return tabs_.size();
  }

  /** A copy of a tab (the current one when id is empty). */
  bool tab(const std::string& want, Tab& out, OpError& err) {
    std::lock_guard<std::mutex> l(m_);
    auto it = tabs_.find(want.empty() ? active_ : want);
    if (it == tabs_.end() && want.empty() && !tabs_.empty()) it = std::prev(tabs_.end());
    if (it == tabs_.end()) {
      err = {"not_found", want.empty() ? "No tab is open." : "No tab " + want + " (pc_browser_tabs lists them)."};
      return false;
    }
    out = it->second;
    return true;
  }
  void activate(const std::string& id) {
    std::lock_guard<std::mutex> l(m_);
    if (tabs_.count(id)) active_ = id;
  }
  std::string activeId() {
    std::lock_guard<std::mutex> l(m_);
    return active_;
  }
  void resetCounts(const std::string& id, bool clearLogs = false) {
    std::lock_guard<std::mutex> l(m_);
    if (!tabs_.count(id)) return;
    tabs_[id].consoleErrors = tabs_[id].failedRequests = tabs_[id].status = 0;
    // A newly opened page starts with its own logs (the numbers keep counting up).
    if (clearLogs) tabs_[id].logs.clear();
  }
  void forget(const std::string& id) {
    std::lock_guard<std::mutex> l(m_);
    tabs_.erase(id);
    if (active_ == id) active_ = tabs_.empty() ? "" : std::prev(tabs_.end())->first;
  }
  std::vector<Tab> allTabs() {
    std::lock_guard<std::mutex> l(m_);
    std::vector<Tab> v;
    for (auto& kv : tabs_) v.push_back(kv.second);
    return v;
  }
  long long loads(const std::string& id) {
    std::lock_guard<std::mutex> l(m_);
    return tabs_.count(id) ? tabs_[id].loads : -1;
  }
  /** Waits for the tab's next page load after `before` (false on timeout / stop). */
  bool waitLoad(const std::string& id, long long before, DWORD ms, const std::atomic<bool>* cancel) {
    std::unique_lock<std::mutex> l(m_);
    auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
    while (alive_ && tabs_.count(id) && tabs_[id].loads == before) {
      if (cancel && cancel->load()) return false;
      if (std::chrono::steady_clock::now() >= until) return false;
      cv_.wait_for(l, std::chrono::milliseconds(100));
    }
    return alive_ && tabs_.count(id);
  }
  long long lastSeq() {
    std::lock_guard<std::mutex> l(m_);
    return seq_;
  }

 private:
  std::mutex m_;
  std::condition_variable cv_;
  bool alive_ = false;
  HANDLE proc_ = nullptr, wr_ = nullptr, rd_ = nullptr;
  DWORD pid_ = 0;
  std::thread reader_;
  int next_ = 1;
  std::map<int, J> results_;
  std::map<std::string, Tab> tabs_;
  std::string active_;
  int tabN_ = 0;
  long long seq_ = 0;

  bool write(const std::string& msg) {
    HANDLE h;
    {
      std::lock_guard<std::mutex> l(m_);
      h = wr_;
    }
    if (!h) return false;
    static std::mutex wm;
    std::lock_guard<std::mutex> l2(wm);
    std::string data = msg;
    data.push_back('\0');
    DWORD done = 0;
    return WriteFile(h, data.data(), (DWORD)data.size(), &done, nullptr) && done == data.size();
  }

  void readLoop() {
    std::string buf;
    char chunk[65536];
    HANDLE h;
    {
      std::lock_guard<std::mutex> l(m_);
      h = rd_;
    }
    for (;;) {
      DWORD n = 0;
      if (!ReadFile(h, chunk, sizeof chunk, &n, nullptr) || n == 0) break;
      buf.append(chunk, n);
      size_t z;
      while ((z = buf.find('\0')) != std::string::npos) {
        std::string msg = buf.substr(0, z);
        buf.erase(0, z + 1);
        bool ok = false;
        J m = parse(msg, &ok);
        if (!ok) continue;
        if (m.has("id")) {
          std::lock_guard<std::mutex> l(m_);
          results_[(int)m["id"].num()] = std::move(m);
          cv_.notify_all();
        } else event(m);
      }
    }
    std::lock_guard<std::mutex> l(m_);
    alive_ = false;
    tabs_.clear();
    cv_.notify_all();
  }

  Tab* tabOf(const std::string& session) {
    for (auto& kv : tabs_)
      if (kv.second.sessionId == session) return &kv.second;
    return nullptr;
  }
  void log(Tab& t, const std::string& body, const std::string& requestId = "", int status = 0) {
    LogEntry e{++seq_, body, requestId, status};
    t.logs.push_back(e);
    while (t.logs.size() > 500) t.logs.pop_front();
  }

  void event(const J& m) {
    const std::string method = m["method"].str();
    const J& p = m["params"];
    if (method == "Fetch.requestPaused") {
      std::string url = p["request"]["url"].str();
      std::string why;
      bool ok = addressAllowed(url, serverOrigin, why);
      std::string session = m["sessionId"].str();
      send(ok ? "Fetch.continueRequest" : "Fetch.failRequest", ok ? "{\"requestId\":" + q(p["requestId"].str()) + "}" : "{\"requestId\":" + q(p["requestId"].str()) + ",\"errorReason\":\"BlockedByClient\"}", session);
      if (!ok) {
        std::lock_guard<std::mutex> l(m_);
        if (Tab* t = tabOf(session)) log(*t, "\"kind\":\"network\",\"method\":\"GET\",\"url\":" + q(shortText(url)) + ",\"error\":\"blocked by the Sara browser (Sara\\u2019s own server)\"");
      }
      return;
    }
    std::lock_guard<std::mutex> l(m_);
    if (method == "Target.detachedFromTarget") {
      for (auto it = tabs_.begin(); it != tabs_.end(); ++it)
        if (it->second.sessionId == p["sessionId"].str()) {
          if (active_ == it->first) active_.clear();
          tabs_.erase(it);
          if (active_.empty() && !tabs_.empty()) active_ = std::prev(tabs_.end())->first;
          break;
        }
      cv_.notify_all();
      return;
    }
    Tab* t = tabOf(m["sessionId"].str());
    if (!t) return;
    if (method == "Page.loadEventFired") {
      t->loads++;
      cv_.notify_all();
    } else if (method == "Page.frameStartedLoading" || method == "Page.frameRequestedNavigation") {
      t->starts++;
      cv_.notify_all();
    } else if (method == "Page.javascriptDialogOpening") {
      // A page dialog would block everything: it is closed with Cancel (the safe answer) and reported.
      t->dialog = shortText(p["message"].str(), 200);
      send("Page.handleJavaScriptDialog", "{\"accept\":false}", t->sessionId);
    } else if (method == "Page.frameNavigated") {
      if (!p["frame"].has("parentId")) t->frameId = p["frame"]["id"].str();
    } else if (method == "Runtime.consoleAPICalled") {
      std::string type = p["type"].str();
      if (type != "error" && type != "warning" && type != "assert") return;
      std::string text;
      for (auto& a : p["args"].a) text += (text.empty() ? "" : " ") + (a.has("value") ? (a["value"].t == J::Str ? a["value"].s : dump(a["value"])) : a["description"].str());
      if (type != "warning") t->consoleErrors++;
      const J& f = p["stackTrace"]["callFrames"];
      std::string where = f.a.empty() ? "" : ",\"url\":" + q(shortText(f.a[0]["url"].str())) + ",\"line\":" + num(f.a[0]["lineNumber"].num() + 1);
      log(*t, "\"kind\":\"console\",\"level\":" + q(type == "warning" ? "warning" : "error") + ",\"text\":" + q(shortText(text)) + where);
    } else if (method == "Runtime.exceptionThrown") {
      const J& d = p["exceptionDetails"];
      std::string desc = d["exception"]["description"].str(d["text"].str("error"));
      desc = desc.substr(0, desc.find('\n'));
      t->consoleErrors++;
      log(*t, "\"kind\":\"exception\",\"text\":" + q(shortText(desc)) + (d.has("url") ? ",\"url\":" + q(shortText(d["url"].str())) + ",\"line\":" + num(d["lineNumber"].num() + 1) : ""));
    } else if (method == "Log.entryAdded") {
      const J& e = p["entry"];
      std::string level = e["level"].str();
      if ((level != "error" && level != "warning") || e["source"].str() == "network") return;
      if (level == "error") t->consoleErrors++;
      log(*t, "\"kind\":\"console\",\"level\":" + q(level) + ",\"text\":" + q(shortText(e["text"].str())));
    } else if (method == "Network.requestWillBeSent") {
      t->requests[p["requestId"].str()] = {p["request"]["method"].str("GET"), shortText(p["request"]["url"].str())};
      if (t->requests.size() > 2000) t->requests.erase(t->requests.begin());
    } else if (method == "Network.responseReceived") {
      int status = (int)p["response"]["status"].num();
      std::string url = p["response"]["url"].str();
      if (p["type"].str() == "Document" && p["frameId"].str() == t->frameId) t->status = status;
      if (status >= 400 && url.find("/favicon.ico") == std::string::npos) {
        t->failedRequests++;
        std::string rid = p["requestId"].str();
        std::string meth = t->requests.count(rid) ? t->requests[rid].first : "GET";
        log(*t, "\"kind\":\"network\",\"method\":" + q(meth) + ",\"url\":" + q(shortText(url)) + ",\"status\":" + std::to_string(status) + ",\"type\":" + q(p["type"].str()) + ",\"requestId\":" + q(rid), rid, status);
      }
    } else if (method == "Network.loadingFailed") {
      if (p["canceled"].truthy() || p["blockedReason"].str() == "inspector") return;
      t->failedRequests++;
      std::string rid = p["requestId"].str();
      auto it = t->requests.find(rid);
      log(*t, "\"kind\":\"network\",\"method\":" + q(it != t->requests.end() ? it->second.first : "GET") + ",\"url\":" + q(it != t->requests.end() ? it->second.second : "") + ",\"error\":" + q(shortText(p["errorText"].str())) + ",\"type\":" + q(p["type"].str()) + ",\"requestId\":" + q(rid), rid);
    }
  }

 public:
  /** Log entries after `since` of one tab, as JSON objects. */
  std::string logsJson(const std::string& id, long long since, int max = 200) {
    std::lock_guard<std::mutex> l(m_);
    if (!tabs_.count(id)) return "[]";
    std::vector<const LogEntry*> v;
    for (auto& e : tabs_[id].logs)
      if (e.seq > since) v.push_back(&e);
    if ((int)v.size() > max) v.erase(v.begin(), v.end() - max);
    std::string o = "[";
    for (size_t k = 0; k < v.size(); k++) o += (k ? ",{" : "{") + std::string("\"seq\":") + std::to_string(v[k]->seq) + "," + v[k]->json + "}";
    return o + "]";
  }
  int statusOfRequest(const std::string& id, const std::string& rid) {
    std::lock_guard<std::mutex> l(m_);
    if (!tabs_.count(id)) return 0;
    for (auto& e : tabs_[id].logs)
      if (e.requestId == rid) return e.status;
    return 0;
  }
};

// ---------------- the hands connection (WinHTTP WebSocket) ----------------
struct Request {
  std::string id, op, what;
  J args;
  DWORD deadlineMs = 30000;
  std::shared_ptr<std::atomic<bool>> cancel = std::make_shared<std::atomic<bool>>(false);
  std::shared_ptr<std::atomic<bool>> byTakeover = std::make_shared<std::atomic<bool>>(false);
};

// ---------------- Phase 89 (CU3): the dev tunnel (Winsock, loopback only) ----------------
// c.tunnel {tunnel, port}: a listener on 127.0.0.1 (that port when free here, else any free one).
// Each connection to it becomes a stream: {t:'s', ev:'open', tunnel, sid} to the server, then bytes
// both ways as binary frames with the header {"s":sid}; {ev:'end'} when a side has no more to send,
// {ev:'close'} when it's gone, {ev:'pause'|'resume'} for flow control.
class DevTunnels : public std::enable_shared_from_this<DevTunnels> {
 public:
  static constexpr size_t kMaxTunnels = 4, kMaxStreams = 64;
  DevTunnels() {
    WSADATA w;
    ok_ = WSAStartup(MAKEWORD(2, 2), &w) == 0;
  }
  ~DevTunnels() {
    if (ok_) WSACleanup();
  }
  /** How streams reach the server (set by the hands; cleared by shutdown()). */
  void wire(std::function<bool(const std::string&)> text, std::function<bool(const std::string&, const std::vector<BYTE>&)> bin, std::function<void(const std::wstring&)> log) {
    std::lock_guard<std::mutex> l(fm_);
    text_ = std::move(text);
    bin_ = std::move(bin);
    log_ = std::move(log);
    dead_ = false;
  }
  void shutdown() {
    {
      std::lock_guard<std::mutex> l(fm_);
      dead_ = true;
      text_ = nullptr;
      bin_ = nullptr;
      log_ = nullptr;
    }
    closeAll();
  }

  /** c.tunnel: the local port, or 0 with `e` set. */
  int open(const std::string& id, int port, OpError& e) {
    static const std::regex idRe("^[0-9a-f]{8,64}$");
    if (!ok_) return e = {"unsupported", "Networking isn't available here."}, 0;
    if (!std::regex_match(id, idRe)) return e = {"denied_local", "Not a tunnel id."}, 0;
    if (port < 1024 || port > 65535) return e = {"denied_local", "Dev tunnels use ports 1024 to 65535 only."}, 0;
    std::lock_guard<std::mutex> l(m_);
    if (auto it = tunnels_.find(id); it != tunnels_.end()) return it->second.localPort;
    if (tunnels_.size() >= kMaxTunnels) return e = {"denied_local", "At most 4 dev tunnels at once on this computer."}, 0;
    SOCKET s = listenOn(port);
    if (s == INVALID_SOCKET) s = listenOn(0);
    if (s == INVALID_SOCKET) return e = {"error", "Couldn't open a local port for the dev tunnel."}, 0;
    sockaddr_in a{};
    int al = sizeof(a);
    getsockname(s, (sockaddr*)&a, &al);
    int local = ntohs(a.sin_port);
    tunnels_[id] = Listener{s, port, local, {}};
    auto self = shared_from_this();
    std::thread([self, id, s] { self->acceptLoop(id, s); }).detach();
    say(L"dev tunnel: 127.0.0.1:" + std::to_wstring(local) + L" \u2192 the server's port " + std::to_wstring(port));
    return local;
  }
  /** c.untunnel (or Stop, or the connection dropped): the listener and its connections close. */
  bool close(const std::string& id) {
    std::lock_guard<std::mutex> l(m_);
    auto it = tunnels_.find(id);
    if (it == tunnels_.end()) return false;
    closesocket(it->second.s);
    for (uint32_t sid : it->second.sids) {
      auto st = streams_.find(sid);
      if (st == streams_.end()) continue;
      if (!st->second->closed.exchange(true)) closesocket(st->second->s);
      streams_.erase(st);
    }
    tunnels_.erase(it);
    return true;
  }
  void closeAll() {
    std::vector<std::string> ids;
    {
      std::lock_guard<std::mutex> l(m_);
      for (auto& kv : tunnels_) ids.push_back(kv.first);
    }
    for (auto& id : ids) close(id);
  }
  size_t count() {
    std::lock_guard<std::mutex> l(m_);
    return tunnels_.size();
  }

  /** {t:'s'} from the server. */
  void control(const J& m) {
    uint32_t sid = (uint32_t)m["sid"].num(0);
    std::string ev = m["ev"].str();
    std::shared_ptr<Stream> st = find(sid);
    if (!st) return;
    if (ev == "end") {
      st->serverEnded = true;
      shutdownSend(st);
      if (st->gotEof) drop(sid, false);
    } else if (ev == "close") {
      drop(sid, false);
    } else if (ev == "pause") {
      st->paused = true;
    } else if (ev == "resume") {
      st->paused = false;
    }
  }
  /** Bytes from the server for a stream (written to the Sara browser's connection). */
  void data(uint32_t sid, const BYTE* p, size_t n) {
    std::shared_ptr<Stream> st = find(sid);
    if (!st || st->closed) return;
    std::lock_guard<std::mutex> l(st->wm);
    size_t off = 0;
    while (off < n) {
      int k = send(st->s, (const char*)p + off, (int)std::min<size_t>(n - off, 1 << 20), 0);
      if (k <= 0) {
        drop(sid, true);
        return;
      }
      off += (size_t)k;
    }
  }

 private:
  struct Stream {
    SOCKET s = INVALID_SOCKET;
    std::string tunnel;
    std::atomic<bool> closed{false}, paused{false}, gotEof{false}, serverEnded{false};
    std::mutex wm;
  };
  struct Listener {
    SOCKET s = INVALID_SOCKET;
    int port = 0, localPort = 0;
    std::set<uint32_t> sids;
  };
  bool ok_ = false;
  std::mutex m_;
  std::map<std::string, Listener> tunnels_;
  std::map<uint32_t, std::shared_ptr<Stream>> streams_;
  uint32_t nextSid_ = 0;
  std::mutex fm_;
  bool dead_ = true;
  std::function<bool(const std::string&)> text_;
  std::function<bool(const std::string&, const std::vector<BYTE>&)> bin_;
  std::function<void(const std::wstring&)> log_;

  void say(const std::wstring& line) {
    std::lock_guard<std::mutex> l(fm_);
    if (log_) log_(line);
  }
  bool sendText(const std::string& t) {
    std::lock_guard<std::mutex> l(fm_);
    return !dead_ && text_ && text_(t);
  }
  bool sendBin(const std::string& h, const std::vector<BYTE>& d) {
    std::lock_guard<std::mutex> l(fm_);
    return !dead_ && bin_ && bin_(h, d);
  }
  /** Loopback only: nothing on the network can reach it. Not inherited by programs Sara starts. */
  static SOCKET listenOn(int port) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return s;
    BOOL ex = TRUE;
    setsockopt(s, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char*)&ex, sizeof(ex));
    SetHandleInformation((HANDLE)s, HANDLE_FLAG_INHERIT, 0);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons((u_short)port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(s, (sockaddr*)&a, sizeof(a)) != 0 || listen(s, SOMAXCONN) != 0) {
      closesocket(s);
      return INVALID_SOCKET;
    }
    return s;
  }
  std::shared_ptr<Stream> find(uint32_t sid) {
    std::lock_guard<std::mutex> l(m_);
    auto it = streams_.find(sid);
    return it == streams_.end() ? nullptr : it->second;
  }
  void shutdownSend(const std::shared_ptr<Stream>& st) {
    if (!st->closed) ::shutdown(st->s, SD_SEND);
  }
  void drop(uint32_t sid, bool tell) {
    std::shared_ptr<Stream> st;
    {
      std::lock_guard<std::mutex> l(m_);
      auto it = streams_.find(sid);
      if (it == streams_.end()) return;
      st = it->second;
      streams_.erase(it);
      if (auto t = tunnels_.find(st->tunnel); t != tunnels_.end()) t->second.sids.erase(sid);
    }
    if (!st->closed.exchange(true)) closesocket(st->s);
    if (tell) sendText("{\"t\":\"s\",\"ev\":\"close\",\"sid\":" + std::to_string(sid) + "}");
  }
  void acceptLoop(const std::string& id, SOCKET ls) {
    for (;;) {
      SOCKET c = accept(ls, nullptr, nullptr);
      if (c == INVALID_SOCKET) return;  // the listener was closed
      auto st = std::make_shared<Stream>();
      uint32_t sid = 0;
      {
        std::lock_guard<std::mutex> l(m_);
        auto it = tunnels_.find(id);
        if (it == tunnels_.end() || it->second.s != ls || it->second.sids.size() >= kMaxStreams) {
          closesocket(c);
          if (it == tunnels_.end() || it->second.s != ls) return;
          continue;
        }
        sid = ++nextSid_;
        st->s = c;
        st->tunnel = id;
        streams_[sid] = st;
        it->second.sids.insert(sid);
      }
      BOOL nd = TRUE;
      setsockopt(c, IPPROTO_TCP, TCP_NODELAY, (const char*)&nd, sizeof(nd));
      if (!sendText("{\"t\":\"s\",\"ev\":\"open\",\"tunnel\":" + q(id) + ",\"sid\":" + std::to_string(sid) + "}")) {
        drop(sid, false);
        continue;
      }
      auto self = shared_from_this();
      std::thread([self, sid, st] { self->readLoop(sid, st); }).detach();
    }
  }
  void readLoop(uint32_t sid, std::shared_ptr<Stream> st) {
    std::vector<BYTE> buf(64 * 1024);
    const std::string head = "{\"s\":" + std::to_string(sid) + "}";
    for (;;) {
      while (st->paused && !st->closed) Sleep(10);
      if (st->closed) return;
      int n = recv(st->s, (char*)buf.data(), (int)buf.size(), 0);
      if (n > 0) {
        if (!sendBin(head, std::vector<BYTE>(buf.begin(), buf.begin() + n))) return drop(sid, false);
        continue;
      }
      if (n == 0) {
        // The browser sent all it will: tell the server; the stream stays for the answer.
        st->gotEof = true;
        sendText("{\"t\":\"s\",\"ev\":\"end\",\"sid\":" + std::to_string(sid) + "}");
        if (st->serverEnded) drop(sid, false);
        return;
      }
      return drop(sid, !st->closed);
    }
  }
};

const UINT WM_BADGE_UPDATE = WM_APP + 1;
#ifdef SARA_TEST_HOOKS
// Test builds only: a test script posts these to the badge window (class "SaraHandsBadge") to act as
// the person moving the mouse in her window, and pressing Resume. Release builds don't have them.
const UINT WM_BADGE_TEST_INPUT = WM_APP + 77;
const UINT WM_BADGE_TEST_RESUME = WM_APP + 78;
#endif
const int kStopHotkeyId = 1;

class Hands {
 public:
  Host host;
  std::atomic<bool> stopping{false};
  std::atomic<bool> isConnected{false};
  std::atomic<bool> localOnly{false};
  std::mutex errM;
  std::wstring err;
  Browser browser;

  std::atomic<bool> keep{false};      // Phase 88: let Sara keep control when the person uses her window
  std::atomic<bool> isPaused{false};  // Phase 88: the person took over; nothing acts until Resume
  std::atomic<bool> hotkeyOk{false};

  explicit Hands(const Host& h) : host(h) {
    // Phase 89: the dev tunnel's streams go over this connection.
    tunnels_->wire([this](const std::string& t) { return sendText(t); }, [this](const std::string& hd, const std::vector<BYTE>& d) { return sendBinary(hd, d); }, [this](const std::wstring& l) { say(l); });
    localOnly = h.localOnly;
    keep = h.keepControl;
    browser.profileDir = h.profileDir;
    browser.downloadsDir = h.downloadsDir;
    browser.serverOrigin = lowerA(u8(h.server));
    pruneLog();
    wake_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    uiReady_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    ui_ = std::thread([this] { uiLoop(); });
    WaitForSingleObject(uiReady_, 5000);
    conn_ = std::thread([this] { connectLoop(); });
    worker_ = std::thread([this] { workLoop(); });
  }
  ~Hands() {
    stopping = true;
    if (badge_) PostMessageW(badge_, WM_CLOSE, 0, 0);
    if (ui_.joinable()) ui_.join();
    CloseHandle(uiReady_);
    SetEvent(wake_);
    closeSocket();
    {
      std::lock_guard<std::mutex> l(qm_);
      for (auto& r : queue_) r->cancel->store(true);
      if (current_) current_->cancel->store(true);
      qcv_.notify_all();
    }
    if (conn_.joinable()) conn_.join();
    if (worker_.joinable()) worker_.join();
    tunnels_->shutdown();
    browser.close();
    CloseHandle(wake_);
  }

  void say(const std::wstring& line) {
    if (host.log) host.log(L"hands: " + line);
  }
  void setErr(const std::wstring& e) {
    std::lock_guard<std::mutex> l(errM);
    err = e;
  }

  bool sendText(const std::string& s) {
    std::lock_guard<std::mutex> l(sm_);
    if (!ws_) return false;
    return WinHttpWebSocketSend(ws_, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE, (PVOID)s.data(), (DWORD)s.size()) == NO_ERROR;
  }
  bool sendBinary(const std::string& header, const std::vector<BYTE>& data) {
    std::vector<BYTE> buf(4 + header.size() + data.size());
    DWORD n = (DWORD)header.size();
    buf[0] = (BYTE)(n >> 24);
    buf[1] = (BYTE)(n >> 16);
    buf[2] = (BYTE)(n >> 8);
    buf[3] = (BYTE)n;
    memcpy(buf.data() + 4, header.data(), header.size());
    if (!data.empty()) memcpy(buf.data() + 4 + header.size(), data.data(), data.size());
    std::lock_guard<std::mutex> l(sm_);
    if (!ws_) return false;
    return WinHttpWebSocketSend(ws_, WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE, buf.data(), (DWORD)buf.size()) == NO_ERROR;
  }

  void pressStop() {
    {
      std::lock_guard<std::mutex> l(qm_);
      for (auto& r : queue_) r->cancel->store(true);
      if (current_) current_->cancel->store(true);
    }
    sendText("{\"t\":\"ev\",\"kind\":\"stopped\",\"by\":\"user\"}");
    say(L"stopped by the person at the computer");
    // Stop ends the dev tunnels here too.
    tunnels_->closeAll();
    // Stop ends the task: the badge goes, and a pause ends with it.
    if (isPaused.exchange(false)) sendText("{\"t\":\"ev\",\"kind\":\"resumed\"}");
    lastOpAt_ = 0;
    updateBadge();
  }
  /** Phase 88: the person used her window (real input, not hers). */
  void userInput() {
    if (keep) {
      keptAt_ = GetTickCount64();
      updateBadge();
      return;
    }
    if (isPaused.exchange(true)) return;
    {
      std::lock_guard<std::mutex> l(qm_);
      if (current_ && kInputOps.count(current_->op)) {
        current_->byTakeover->store(true);
        current_->cancel->store(true);
      }
    }
    say(L"paused: the person took over the Sara browser");
    sendText("{\"t\":\"ev\",\"kind\":\"takeover\"}");
    updateBadge();
  }
  void resume() {
    if (!isPaused.exchange(false)) return;
    say(L"resumed");
    sendText("{\"t\":\"ev\",\"kind\":\"resumed\"}");
    lastOpAt_ = GetTickCount64();
    updateBadge();
  }
  void tellTakeover(bool keepControl) {
    keep = keepControl;
    if (keepControl) resume();
    sendText(std::string("{\"t\":\"ev\",\"kind\":\"optin\",\"optIn\":{\"browser\":true,\"desktop\":false},\"localOnly\":") + (localOnly ? "true" : "false") + ",\"takeover\":" + (keepControl ? "\"keep\"" : "\"pause\"") + "}");
  }
  std::wstring status() {
    if (isConnected) {
      URL_COMPONENTS uc{sizeof(uc)};
      wchar_t hostName[256];
      uc.lpszHostName = hostName;
      uc.dwHostNameLength = 256;
      std::wstring where = WinHttpCrackUrl(host.server.c_str(), 0, 0, &uc) ? std::wstring(hostName, uc.dwHostNameLength) + (uc.nPort != 80 && uc.nPort != 443 ? L":" + std::to_wstring(uc.nPort) : L"") : host.server;
      return L"Connected to Sara at " + where;
    }
    std::lock_guard<std::mutex> l(errM);
    return err.empty() ? L"Connecting to Sara\u2026" : err;
  }
  void tellLocalOnly(bool on) {
    localOnly = on;
    sendText(std::string("{\"t\":\"ev\",\"kind\":\"optin\",\"optIn\":{\"browser\":true,\"desktop\":false},\"localOnly\":") + (on ? "true" : "false") + ",\"takeover\":" + (keep ? "\"keep\"" : "\"pause\"") + "}");
  }

 private:
  HANDLE wake_;
  std::thread conn_, worker_;
  std::mutex sm_;  // the socket
  HINTERNET ses_ = nullptr, con_ = nullptr, req_ = nullptr, ws_ = nullptr;
  std::mutex qm_;
  std::condition_variable qcv_;
  std::deque<std::shared_ptr<Request>> queue_;
  std::shared_ptr<Request> current_;
  std::map<std::string, std::string> answers_;  // id → the answer (a retried request gets the same)
  std::deque<std::string> answerOrder_;
  std::deque<ULONGLONG> opens_;
  unsigned frameN_ = 0;
  ULONGLONG lastFrameAt_ = 0;
  size_t lastFrameHash_ = 0;
  // Phase 88: the badge, the stop shortcut and takeover.
  std::thread ui_;
  HANDLE uiReady_ = nullptr;
  HWND badge_ = nullptr;
  std::atomic<ULONGLONG> lastOpAt_{0};
  std::atomic<ULONGLONG> keptAt_{0};
  std::atomic<bool> opRunning_{false};
  std::mutex whatM_;
  std::string what_;
  DWORD lastInput_ = 0;
  bool watching_ = false;
  RECT stopRc_{}, resumeRc_{};
  std::deque<ULONGLONG> inputs_;
  std::mutex logM_;
  // Phase 89: the dev tunnels open on this computer.
  std::shared_ptr<DevTunnels> tunnels_ = std::make_shared<DevTunnels>();

  void closeSocket() {
    std::lock_guard<std::mutex> l(sm_);
    if (ws_) {
      WinHttpWebSocketClose(ws_, WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
      WinHttpCloseHandle(ws_);
    }
    if (req_) WinHttpCloseHandle(req_);
    if (con_) WinHttpCloseHandle(con_);
    if (ses_) WinHttpCloseHandle(ses_);
    ws_ = req_ = con_ = ses_ = nullptr;
  }

  bool connectOnce() {
    URL_COMPONENTS uc{sizeof(uc)};
    wchar_t hostName[256], path[1024];
    uc.lpszHostName = hostName;
    uc.dwHostNameLength = 256;
    uc.lpszUrlPath = path;
    uc.dwUrlPathLength = 1024;
    std::wstring url = host.server + L"/api/hands";
    if (!WinHttpCrackUrl(url.c_str(), 0, 0, &uc)) {
      setErr(L"That server address isn't valid.");
      return false;
    }
    HINTERNET ses = WinHttpOpen((L"SaraHands/" + host.appVersion).c_str(), WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!ses) return false;
    HINTERNET con = WinHttpConnect(ses, hostName, uc.nPort, 0);
    HINTERNET req = con ? WinHttpOpenRequest(con, L"GET", L"/api/hands", nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, uc.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0) : nullptr;
    auto fail = [&](const std::wstring& why) {
      if (req) WinHttpCloseHandle(req);
      if (con) WinHttpCloseHandle(con);
      WinHttpCloseHandle(ses);
      if (!why.empty()) setErr(why);
      return false;
    };
    if (!req) return fail(L"Couldn't reach the server.");
    // Never cookies: the token is the only sign-in this connection has.
    DWORD noCookies = WINHTTP_DISABLE_COOKIES;
    WinHttpSetOption(req, WINHTTP_OPTION_DISABLE_FEATURE, &noCookies, sizeof(noCookies));
    WinHttpSetOption(req, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0);
    std::wstring auth = L"Authorization: Bearer " + wide(host.token);
    if (!WinHttpSendRequest(req, auth.c_str(), (DWORD)-1, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) || !WinHttpReceiveResponse(req, nullptr)) return fail(L"Couldn't reach the server.");
    DWORD status = 0, sz = sizeof(status);
    WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &sz, WINHTTP_NO_HEADER_INDEX);
    if (status == 401) return fail(L"This computer was signed out: switch \"Let Sara use this computer\" off and on again.");
    if (status == 403) return fail(L"The server refused this computer (computer use is off for you there).");
    if (status != 101) return fail(L"The server doesn't take computer use (HTTP " + std::to_wstring(status) + L"): update Sara there.");
    HINTERNET ws = WinHttpWebSocketCompleteUpgrade(req, 0);
    if (!ws) return fail(L"Couldn't open the connection.");
    std::lock_guard<std::mutex> l(sm_);
    ses_ = ses;
    con_ = con;
    req_ = req;
    ws_ = ws;
    return true;
  }

  std::string hello() {
    std::string ops;
    for (auto& o : kOps) ops += (ops.empty() ? "" : ",") + q(o);
    OSVERSIONINFOW v{sizeof(v)};
    DWORD build = 0;
    if (HMODULE nt = GetModuleHandleW(L"ntdll.dll")) {
      using Rtl = LONG(WINAPI*)(OSVERSIONINFOW*);
      if (auto f = reinterpret_cast<Rtl>(GetProcAddress(nt, "RtlGetVersion")); f && f(&v) == 0) build = v.dwBuildNumber;
    }
    return "{\"t\":\"hello\",\"v\":1,\"app\":" + q(u8(host.appVersion)) + ",\"os\":" + q("Windows (build " + std::to_string(build) + ")") + ",\"computer\":" + q(u8(host.computer)) +
           ",\"screens\":[],\"browser\":{\"found\":" + (browser.found.path.empty() ? "false" : "true") + (browser.found.kind.empty() ? "" : ",\"kind\":" + q(browser.found.kind) + ",\"name\":" + q(browser.found.name)) +
           "},\"perms\":{\"capture\":false,\"input\":false,\"ax\":false},\"optIn\":{\"browser\":true,\"desktop\":false},\"approvalsHere\":false,\"logins\":[],\"busy\":false,\"localOnly\":" + (localOnly ? "true" : "false") +
           ",\"ops\":[" + ops + "],\"takeover\":" + (keep ? "\"keep\"" : "\"pause\"") + ",\"hotkey\":" + (hotkeyOk ? "\"Ctrl+Alt+Esc\"" : "\"\"") + ",\"paused\":" + (isPaused ? "true" : "false") + ",\"renew\":true}";
  }

  void connectLoop() {
    static const DWORD backoff[] = {1, 2, 5, 10, 30};
    size_t attempt = 0;
    while (!stopping) {
      if (connectOnce()) {
        attempt = 0;
        setErr(L"");
        isConnected = true;
        say(L"connected to " + host.server);
        sendText(hello());
        // Phase 88: with under 30 days left on the token, ask for a fresh one over this connection.
        {
          std::lock_guard<std::mutex> l(errM);
          if (!host.expiresAt.empty() && host.expiresAt < isoNow(30)) sendText("{\"t\":\"renew\"}");
        }
        receiveLoop();
        isConnected = false;
        closeSocket();
        // Phase 89: every dev tunnel closes with the connection.
        tunnels_->closeAll();
        // Whatever was running stops with the connection.
        std::lock_guard<std::mutex> l(qm_);
        for (auto& r : queue_) r->cancel->store(true);
        queue_.clear();
        if (current_) current_->cancel->store(true);
        if (!stopping) say(L"disconnected");
      }
      if (stopping) break;
      std::wstring e;
      {
        std::lock_guard<std::mutex> l(errM);
        e = err;
      }
      // Signed out: wait much longer (the owner switches it on again from the page).
      DWORD s = e.find(L"signed out") != std::wstring::npos ? 300 : backoff[std::min(attempt++, std::size(backoff) - 1)];
      WaitForSingleObject(wake_, s * 1000);
    }
  }

  void receiveLoop() {
    std::vector<BYTE> buf(64 * 1024);
    std::string msg;
    std::vector<BYTE> bin;  // Phase 89: dev tunnel bytes (binary frames from the server)
    for (;;) {
      HINTERNET ws;
      {
        std::lock_guard<std::mutex> l(sm_);
        ws = ws_;
      }
      if (!ws || stopping) return;
      DWORD n = 0;
      WINHTTP_WEB_SOCKET_BUFFER_TYPE type;
      if (WinHttpWebSocketReceive(ws, buf.data(), (DWORD)buf.size(), &n, &type) != NO_ERROR) return;
      if (type == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE) return;
      if (type == WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE || type == WINHTTP_WEB_SOCKET_BINARY_FRAGMENT_BUFFER_TYPE) {
        // Phase 89: the only binary the server sends is dev tunnel bytes: header {"s":sid}, then data.
        bin.insert(bin.end(), buf.begin(), buf.begin() + n);
        if (bin.size() > 8 * 1024 * 1024) return;
        if (type == WINHTTP_WEB_SOCKET_BINARY_FRAGMENT_BUFFER_TYPE) continue;
        if (bin.size() >= 4) {
          size_t hl = ((size_t)bin[0] << 24) | ((size_t)bin[1] << 16) | ((size_t)bin[2] << 8) | bin[3];
          if (hl > 0 && hl <= 4096 && bin.size() >= 4 + hl) {
            bool ok = false;
            J h = parse(std::string((const char*)bin.data() + 4, hl), &ok);
            if (ok && h.has("s")) tunnels_->data((uint32_t)h["s"].num(0), bin.data() + 4 + hl, bin.size() - 4 - hl);
          }
        }
        bin.clear();
        continue;
      }
      msg.append(reinterpret_cast<char*>(buf.data()), n);
      if (msg.size() > 4 * 1024 * 1024) return;
      if (type == WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE) continue;
      onText(msg);
      msg.clear();
    }
  }

  void onText(const std::string& raw) {
    bool ok = false;
    J m = parse(raw, &ok);
    if (!ok) return;
    std::string t = m["t"].str();
    if (t == "token") {
      // Phase 88: a fresh token (we asked for it): kept by the app, used from the next connection on.
      std::string tok = m["token"].str();
      if (tok.rfind("sara_hands.", 0) == 0 && tok.size() < 300) {
        {
          std::lock_guard<std::mutex> l(errM);
          host.token = tok;
          host.expiresAt = m["expiresAt"].str();
        }
        if (host.onToken) host.onToken(tok, m["expiresAt"].str());
        say(L"renewed this computer's sign-in");
      }
      return;
    }
    if (t == "cancel") {
      std::lock_guard<std::mutex> l(qm_);
      bool all = m["all"].truthy();
      std::string id = m["id"].str();
      for (auto& r : queue_)
        if (all || r->id == id) r->cancel->store(true);
      if (current_ && (all || current_->id == id)) current_->cancel->store(true);
      return;
    }
    if (t == "s") return tunnels_->control(m);  // Phase 89: a dev tunnel stream's control message
    if (t != "req") return;
    auto r = std::make_shared<Request>();
    r->id = m["id"].str();
    r->op = m["op"].str();
    r->args = m["args"];
    r->what = shortText(m["what"].str(), 120);
    r->deadlineMs = (DWORD)std::min(120000.0, std::max(1000.0, m["deadlineMs"].num(30000)));
    if (r->id.empty() || r->id.size() > 100) return;
    // Phase 89: tunnels open and close at once (never queued behind a slow page).
    if (r->op == "c.tunnel" || r->op == "c.untunnel") {
      OpError e;
      std::string result;
      if (r->op == "c.tunnel") {
        int local = tunnels_->open(r->args["tunnel"].str(), (int)r->args["port"].num(0), e);
        if (e.code.empty()) result = "{\"localPort\":" + std::to_string(local) + ",\"url\":\"http://127.0.0.1:" + std::to_string(local) + "\"}";
      } else {
        result = std::string("{\"closed\":") + (tunnels_->close(r->args["tunnel"].str()) ? "true" : "false") + "}";
      }
      sendText(e.code.empty() ? "{\"t\":\"res\",\"id\":" + q(r->id) + ",\"ok\":true,\"result\":" + result + "}" : "{\"t\":\"res\",\"id\":" + q(r->id) + ",\"ok\":false,\"error\":{\"code\":" + q(e.code) + ",\"message\":" + q(e.message) + "}}");
      return;
    }
    std::lock_guard<std::mutex> l(qm_);
    // A retried request gets the first answer (once it has one; a running one isn't run twice).
    if (answers_.count(r->id)) {
      sendText(answers_[r->id]);
      return;
    }
    if (current_ && current_->id == r->id) return;
    for (auto& x : queue_)
      if (x->id == r->id) return;
    queue_.push_back(r);
    qcv_.notify_all();
  }

  void workLoop() {
    while (!stopping) {
      std::shared_ptr<Request> r;
      {
        std::unique_lock<std::mutex> l(qm_);
        qcv_.wait(l, [this] { return stopping || !queue_.empty(); });
        if (stopping) return;
        r = queue_.front();
        queue_.pop_front();
        current_ = r;
      }
      if (r->op != "c.ping" && r->op != "b.tabs") {
        {
          std::lock_guard<std::mutex> l(whatM_);
          if (!r->what.empty()) what_ = r->what;
        }
        opRunning_ = true;
        lastOpAt_ = GetTickCount64();
        updateBadge();
      }
      // The deadline: the op stops waiting (and answers `timeout`) when it passes.
      std::atomic<bool> done{false};
      std::thread timer([r, &done] {
        auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(r->deadlineMs);
        while (!done && std::chrono::steady_clock::now() < until) std::this_thread::sleep_for(std::chrono::milliseconds(50));
        if (!done) r->cancel->store(true);
      });
      auto started = GetTickCount64();
      std::string answer;
      try {
        OpError e;
        std::string result = run(*r, e);
        if (e.code.empty() && r->cancel->load()) e = {"stopped", "Stopped."};
        if (e.code == "stopped" && r->byTakeover->load()) e = {"takeover", "Paused: the owner took over the Sara browser. Nothing acts until they press Resume."};
        if (!e.code.empty() && e.code == "stopped" && GetTickCount64() - started >= r->deadlineMs) e = {"timeout", "Took longer than " + std::to_string(r->deadlineMs / 1000) + " s."};
        answer = e.code.empty() ? "{\"t\":\"res\",\"id\":" + q(r->id) + ",\"ok\":true,\"result\":" + result + "}" : "{\"t\":\"res\",\"id\":" + q(r->id) + ",\"ok\":false,\"error\":{\"code\":" + q(e.code) + ",\"message\":" + q(mask(e.message).substr(0, 500)) + "}}";
      } catch (...) {
        answer = "{\"t\":\"res\",\"id\":" + q(r->id) + ",\"ok\":false,\"error\":{\"code\":\"error\",\"message\":\"Something went wrong on the computer.\"}}";
      }
      done = true;
      timer.join();
      if (opRunning_.exchange(false)) {
        lastOpAt_ = GetTickCount64();
        updateBadge();
      }
      {
        std::lock_guard<std::mutex> l(qm_);
        current_.reset();
        answers_[r->id] = answer;
        answerOrder_.push_back(r->id);
        while (answerOrder_.size() > 100) {
          answers_.erase(answerOrder_.front());
          answerOrder_.pop_front();
        }
      }
      sendText(answer);
    }
  }

  // ---------------- the ops ----------------
  struct Shot {
    std::vector<BYTE> jpeg;
    int w = 0, h = 0;
  };
  Shot shot(const Tab& t, int maxWidth, int quality, OpError& e, const std::atomic<bool>* cancel) {
    Shot s;
    J m = browser.call("Page.getLayoutMetrics", "{}", t.sessionId, 10000, e, cancel);
    if (!e.code.empty()) return s;
    double vw = std::max(1.0, m["cssVisualViewport"]["clientWidth"].num(1280)), vh = std::max(1.0, m["cssVisualViewport"]["clientHeight"].num(800));
    double scale = std::min(1.0, maxWidth / vw);
    J r = browser.call("Page.captureScreenshot", "{\"format\":\"jpeg\",\"quality\":" + std::to_string(quality) + ",\"clip\":{\"x\":0,\"y\":0,\"width\":" + num(vw) + ",\"height\":" + num(vh) + ",\"scale\":" + num(scale) + "}}", t.sessionId, 30000, e, cancel);
    if (!e.code.empty()) return s;
    s.jpeg = b64dec(r["data"].str());
    s.w = (int)(vw * scale + 0.5);
    s.h = (int)(vh * scale + 0.5);
    return s;
  }
  void thumb(const std::string& id, const Tab& t, const J& args, const std::atomic<bool>* cancel) {
    int w = (int)args["thumb"].num(0);
    if (w < 64 || w > 640) return;
    OpError e;
    Shot s = shot(t, w, 55, e, cancel);
    if (e.code.empty() && !s.jpeg.empty()) sendBinary("{\"id\":" + q(id) + ",\"kind\":\"thumb\",\"mime\":\"image/jpeg\",\"w\":" + std::to_string(s.w) + ",\"h\":" + std::to_string(s.h) + "}", s.jpeg);
  }
  /** §3.5: a live-view frame after a change (at most one per 500 ms, only when the picture changed). */
  void frame(const Tab& t) {
    if (GetTickCount64() - lastFrameAt_ < 500) return;
    OpError e;
    Shot s = shot(t, 960, 60, e, nullptr);
    if (!e.code.empty() || s.jpeg.empty()) return;
    size_t h = std::hash<std::string>()(std::string(s.jpeg.begin(), s.jpeg.end()));
    if (h == lastFrameHash_) return;
    lastFrameHash_ = h;
    lastFrameAt_ = GetTickCount64();
    sendBinary("{\"frame\":" + std::to_string(++frameN_) + ",\"mime\":\"image/jpeg\",\"w\":" + std::to_string(s.w) + ",\"h\":" + std::to_string(s.h) + "}", s.jpeg);
  }
  std::string pageInfo(const Tab& t, OpError& e) {
    J r = browser.call("Target.getTargetInfo", "{\"targetId\":" + q(t.targetId) + "}", "", 10000, e);
    return "\"url\":" + q(r["targetInfo"]["url"].str()) + ",\"title\":" + q(mask(r["targetInfo"]["title"].str()));
  }
  std::string counts(const std::string& id) {
    Tab t;
    OpError e;
    if (!browser.tab(id, t, e)) return "\"consoleErrors\":0,\"failedRequests\":0";
    return "\"consoleErrors\":" + std::to_string(t.consoleErrors) + ",\"failedRequests\":" + std::to_string(t.failedRequests);
  }
  /** Runs one page-agent function in an isolated world (the page's own scripts can't touch it). */
  J agent(const Tab& t, const std::string& fn, const std::string& argsJson, OpError& e, const std::atomic<bool>* cancel) {
    J tree = browser.call("Page.getFrameTree", "{}", t.sessionId, 10000, e, cancel);
    if (!e.code.empty()) return {};
    J w = browser.call("Page.createIsolatedWorld", "{\"frameId\":" + q(tree["frameTree"]["frame"]["id"].str()) + ",\"worldName\":\"sara-page-agent\"}", t.sessionId, 10000, e, cancel);
    if (!e.code.empty()) return {};
    std::string expr = "(" + host.pageAgent + ").call(" + q(fn) + ", " + argsJson + ")";
    J r = browser.call("Runtime.evaluate", "{\"expression\":" + q(expr) + ",\"contextId\":" + num(w["executionContextId"].num()) + ",\"returnByValue\":true}", t.sessionId, 20000, e, cancel);
    if (!e.code.empty()) return {};
    if (r.has("exceptionDetails")) {
      e = {"error", "The page couldn't be read."};
      return {};
    }
    return r["result"]["value"];
  }
  bool countOpen(OpError& e) {
    ULONGLONG now = GetTickCount64();
    while (!opens_.empty() && now - opens_.front() > 60000) opens_.pop_front();
    if (opens_.size() >= 20) {
      e = {"rate_limited", "At most 20 pages a minute in the Sara browser."};
      return false;
    }
    opens_.push_back(now);
    return true;
  }
  std::string tabsJson() {
    std::string o = "[";
    std::string act = browser.activeId();
    bool first = true;
    for (auto& t : browser.allTabs()) {
      OpError e;
      std::string info = pageInfo(t, e);
      o += (first ? "{" : ",{") + std::string("\"tab\":") + q(t.id) + "," + info + ",\"active\":" + (t.id == act ? "true" : "false") + "}";
      first = false;
    }
    return o + "]";
  }

  // ---------------- Phase 88: acting ----------------
  /** The target arguments of an op (a ref checked against the last look, a label, or a picture point). */
  static std::string targetArgs(const J& a) {
    std::string o = "{";
    for (const char* k : {"ref", "expect", "text", "field", "x", "y", "w", "h", "focused", "clear", "option", "dy"})
      if (a.has(k)) o += (o.size() > 1 ? "," : "") + q(k) + ":" + dump(a[k]);
    return o + "}";
  }
  /** A real left click at a page point (mouse moved, pressed, released). */
  void mouseClick(const Tab& t, double x, double y, OpError& e, const std::atomic<bool>* cancel) {
    std::string at = "\"x\":" + num(x) + ",\"y\":" + num(y);
    browser.call("Input.dispatchMouseEvent", "{\"type\":\"mouseMoved\"," + at + ",\"button\":\"none\"}", t.sessionId, 10000, e, cancel);
    if (!e.code.empty()) return;
    browser.call("Input.dispatchMouseEvent", "{\"type\":\"mousePressed\"," + at + ",\"button\":\"left\",\"buttons\":1,\"clickCount\":1}", t.sessionId, 10000, e, cancel);
    if (!e.code.empty()) return;
    browser.call("Input.dispatchMouseEvent", "{\"type\":\"mouseReleased\"," + at + ",\"button\":\"left\",\"buttons\":0,\"clickCount\":1}", t.sessionId, 10000, e, cancel);
  }
  /** The keys of a combination, as the page agent's list allows (anything else is refused here). */
  bool pressKeys(const Tab& t, const std::string& combo, OpError& e, const std::atomic<bool>* cancel) {
    J plan = agent(t, "keys", "{\"combo\":" + q(combo) + "}", e, cancel);
    if (!e.code.empty()) return false;
    if (plan["events"].t != J::Arr) {
      e = {"denied_local", plan["error"].str("Not a key Sara presses.")};
      return false;
    }
    for (auto& ev : plan["events"].a) {
      browser.call("Input.dispatchKeyEvent", dump(ev), t.sessionId, 10000, e, cancel);
      if (!e.code.empty()) return false;
    }
    return true;
  }
  /** After an action: waits for a page load it started (if any). */
  void settle(const Tab& t, long long startsBefore, const std::atomic<bool>* cancel) {
    long long loadsBefore = browser.loads(t.id);
    if (browser.waitStart(t.id, startsBefore, 500, cancel)) browser.waitLoad(t.id, loadsBefore, 15000, cancel);
    for (int k = 0; k < 5 && !(cancel && cancel->load()); k++) Sleep(50);
  }
  /** §7.7: at most 4 actions a second and 120 a minute. */
  bool countInput(OpError& e) {
    ULONGLONG now = GetTickCount64();
    std::lock_guard<std::mutex> l(logM_);
    while (!inputs_.empty() && now - inputs_.front() > 60000) inputs_.pop_front();
    int lastSecond = 0;
    for (auto x : inputs_) lastSecond += now - x < 1000;
    if (lastSecond >= 4 || inputs_.size() >= 120) {
      e = {"rate_limited", "At most 4 actions a second and 120 a minute in the Sara browser."};
      return false;
    }
    inputs_.push_back(now);
    return true;
  }
  /** "What Sara did on this computer": one plain line per action (no pictures), kept 30 days. */
  void localLog(const std::string& op, const std::string& what, const std::string& target) {
    if (host.logFile.empty()) return;
    std::lock_guard<std::mutex> l(logM_);
    std::ofstream f(host.logFile, std::ios::app | std::ios::binary);
    std::string at = isoNow();
    at[10] = ' ';
    at.resize(19);
    f << at << "  " << mask(what.empty() ? op : what) << (target.empty() ? "" : "  (" + mask(target) + ")") << "  [" << op << "]\r\n";
  }
  void pruneLog() {
    if (host.logFile.empty()) return;
    std::ifstream in(host.logFile, std::ios::binary);
    if (!in) return;
    std::string cut = isoNow(-30).substr(0, 10), line, kept;
    while (std::getline(in, line))
      if (line.size() >= 10 && line.compare(0, 10, cut) >= 0) kept += line + "\n";
    in.close();
    std::ofstream(host.logFile, std::ios::trunc | std::ios::binary) << kept;
  }
  /** A page-agent function that returns an element: its object id ("" when it isn't one). */
  std::string agentNode(const Tab& t, const std::string& fn, const std::string& argsJson, OpError& e, const std::atomic<bool>* cancel) {
    J tree = browser.call("Page.getFrameTree", "{}", t.sessionId, 10000, e, cancel);
    if (!e.code.empty()) return {};
    J w = browser.call("Page.createIsolatedWorld", "{\"frameId\":" + q(tree["frameTree"]["frame"]["id"].str()) + ",\"worldName\":\"sara-page-agent\"}", t.sessionId, 10000, e, cancel);
    if (!e.code.empty()) return {};
    std::string expr = "(" + host.pageAgent + ").call(" + q(fn) + ", " + argsJson + ")";
    J r = browser.call("Runtime.evaluate", "{\"expression\":" + q(expr) + ",\"contextId\":" + num(w["executionContextId"].num()) + ",\"returnByValue\":false}", t.sessionId, 20000, e, cancel);
    if (!e.code.empty()) return {};
    return r["result"]["subtype"].str() == "node" ? r["result"]["objectId"].str() : std::string();
  }
  static std::string safeName(const std::string& raw) {
    std::string n = raw.substr(raw.find_last_of("/\\") == std::string::npos ? 0 : raw.find_last_of("/\\") + 1);
    for (auto& c : n)
      if ((unsigned char)c < 0x20 || strchr("<>:\"|?*", c)) c = '_';
    if (n.size() > 120) n.resize(120);
    return n;
  }
  std::string downloadsJson() {
    std::string o = "[";
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW((host.downloadsDir + L"\\*").c_str(), &fd);
    int n = 0;
    if (h != INVALID_HANDLE_VALUE) {
      do {
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
        std::wstring name = fd.cFileName;
        if (name.size() > 11 && name.compare(name.size() - 11, 11, L".crdownload") == 0) continue;
        SYSTEMTIME st;
        FileTimeToSystemTime(&fd.ftLastWriteTime, &st);
        char at[40];
        snprintf(at, sizeof at, "%04d-%02d-%02dT%02d:%02d:%02dZ", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
        ULONGLONG bytes = ((ULONGLONG)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
        o += (n++ ? ",{" : "{") + std::string("\"name\":") + q(u8(name)) + ",\"bytes\":" + std::to_string(bytes) + ",\"at\":" + q(at) + "}";
      } while (n < 100 && FindNextFileW(h, &fd));
      FindClose(h);
    }
    return o + "]";
  }
  /** One acting op: the target, her highlight, the real input, then the after-state (§6.3). */
  std::string act(Request& r, const Tab& t, OpError& e) {
    const std::atomic<bool>* cancel = r.cancel.get();
    const J& a = r.args;
    browser.activate(t.id);
    std::string beforeUrl;
    {
      OpError e0;
      J info = browser.call("Target.getTargetInfo", "{\"targetId\":" + q(t.targetId) + "}", "", 10000, e0);
      beforeUrl = info["targetInfo"]["url"].str();
    }
    browser.takeDialog(t.id);
    int errs0 = t.consoleErrors, failed0 = t.failedRequests;
    long long starts0 = browser.starts(t.id);
    std::string tArgs = targetArgs(a);
    J target;
    std::string extra;
    auto need = [&]() -> bool {
      target = agent(t, "target", tArgs, e, cancel);
      if (!e.code.empty()) return false;
      if (!target["found"].truthy()) {
        e = {target["stale"].truthy() ? "stale_view" : "not_found", target["error"].str("That is not on the page.")};
        return false;
      }
      if (target["disabled"].truthy()) {
        e = {"not_found", target["desc"].str() + " is disabled."};
        return false;
      }
      if (!target["covered"].str().empty()) {
        e = {"not_found", target["desc"].str() + " is covered by " + target["covered"].str() + ": close that first."};
        return false;
      }
      OpError em;
      agent(t, "mark", "{\"x\":" + num(target["x"].num()) + ",\"y\":" + num(target["y"].num()) + ",\"box\":" + dump(target["box"]) + ",\"label\":" + q(host.testLabel ? "Sara (TEST)" : "Sara") + "}", em, cancel);
      return true;
    };
    if (r.op == "b.click") {
      if (!need()) return {};
      mouseClick(t, target["x"].num(), target["y"].num(), e, cancel);
    } else if (r.op == "b.type") {
      std::string value = a["value"].str();
      if ((int)value.size() > kMaxChars * 4 || MultiByteToWideChar(CP_UTF8, 0, value.data(), (int)value.size(), nullptr, 0) > kMaxChars) {
        e = {"denied_local", "At most 2000 characters per action."};
        return {};
      }
      if (mask(value) != value) {
        e = {"denied_local", "That text looks like a key or a sign-in token: Sara never types those."};
        return {};
      }
      if (!need()) return {};
      if (target["secret"].truthy()) {
        e = {"denied_local", "That is a password field: Sara never types into those."};
        return {};
      }
      if (!target["editable"].truthy()) {
        e = {"not_found", target["desc"].str() + " is not a text field."};
        return {};
      }
      mouseClick(t, target["x"].num(), target["y"].num(), e, cancel);
      if (!e.code.empty()) return {};
      std::string fArgs = tArgs.substr(0, tArgs.size() - 1) + (tArgs.size() > 2 ? "," : "") + "\"clear\":" + (a.has("clear") && !a["clear"].truthy() ? "false" : "true") + "}";
      J f = agent(t, "focusFor", fArgs, e, cancel);
      if (!e.code.empty()) return {};
      if (f.has("error") || !f["focused"].truthy()) {
        e = {f["secret"].truthy() ? "denied_local" : "not_found", f["error"].str("That field could not be focused.")};
        return {};
      }
      if (!value.empty()) browser.call("Input.insertText", "{\"text\":" + q(value) + "}", t.sessionId, 20000, e, cancel);
      if (e.code.empty() && a["submit"].truthy()) pressKeys(t, "Enter", e, cancel);
    } else if (r.op == "b.select") {
      std::string cArgs = tArgs.substr(0, tArgs.size() - 1) + (tArgs.size() > 2 ? "," : "") + "\"option\":" + q(a["option"].str()) + "}";
      J c = agent(t, "choose", cArgs, e, cancel);
      if (!e.code.empty()) return {};
      if (c.has("error")) {
        e = {c["stale"].truthy() ? "stale_view" : "not_found", c["error"].str()};
        return {};
      }
      OpError em;
      agent(t, "mark", "{\"x\":" + num(c["x"].num()) + ",\"y\":" + num(c["y"].num()) + ",\"label\":\"Sara\"}", em, cancel);
      target = c;
      extra = ",\"selected\":" + q(c["selected"].str());
    } else if (r.op == "b.keys") {
      pressKeys(t, a["combo"].str(), e, cancel);
      extra = ",\"combo\":" + q(a["combo"].str());
    } else if (r.op == "b.upload") {
      std::string name;
      if (a["file"].t == J::Obj) {
        name = safeName(a["file"]["name"].str());
        std::vector<BYTE> data = b64dec(a["file"]["data"].str());
        if (name.empty() || name[0] == '.' || data.size() > 2 * 1024 * 1024) {
          e = {"denied_local", "Uploads from the server are at most 2 MB."};
          return {};
        }
        CreateDirectoryW(host.downloadsDir.c_str(), nullptr);
        HANDLE fh = CreateFileW((host.downloadsDir + L"\\" + wide(name)).c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        DWORD wrote = 0;
        bool ok = fh != INVALID_HANDLE_VALUE && WriteFile(fh, data.data(), (DWORD)data.size(), &wrote, nullptr) && wrote == data.size();
        if (fh != INVALID_HANDLE_VALUE) CloseHandle(fh);
        if (!ok) {
          e = {"error", "Couldn't put the file in Downloads\\Sara."};
          return {};
        }
      } else {
        name = a["name"].str();
        if (name.empty() || name != safeName(name) || name[0] == '.') {
          e = {"denied_local", "Only a file name in Downloads\\Sara."};
          return {};
        }
      }
      std::wstring path = host.downloadsDir + L"\\" + wide(name);
      DWORD attr = GetFileAttributesW(path.c_str());
      if (attr == INVALID_FILE_ATTRIBUTES || (attr & FILE_ATTRIBUTE_DIRECTORY)) {
        e = {"not_found", "There is no " + name + " in Downloads\\Sara on this computer."};
        return {};
      }
      if (!need()) return {};
      std::string objectId = agentNode(t, "fileInput", tArgs, e, cancel);
      if (!e.code.empty()) return {};
      if (objectId.empty()) {
        e = {"not_found", "That is not a file upload field."};
        return {};
      }
      browser.call("DOM.setFileInputFiles", "{\"files\":[" + q(u8(path)) + "],\"objectId\":" + q(objectId) + "}", t.sessionId, 15000, e, cancel);
      extra = ",\"name\":" + q(name);
    }
    if (!e.code.empty()) return {};
    settle(t, starts0, cancel);
    if (cancel->load()) {
      e = {"stopped", "Stopped."};
      return {};
    }
    OpError es;
    J st = agent(t, "state", "{}", es, cancel);
    std::string desc = target["desc"].str();
    localLog(r.op, r.what, desc.empty() ? a["combo"].str() : desc);
    thumb(r.id, t, a, cancel);
    Tab now;
    OpError e2;
    browser.tab(t.id, now, e2);
    frame(now);
    std::string dialog = browser.takeDialog(t.id);
    bool navigated = st["url"].str(beforeUrl) != beforeUrl;
    return "{\"tab\":" + q(t.id) + ",\"target\":{\"desc\":" + q(desc) + ",\"role\":" + q(target["role"].str()) + ",\"name\":" + q(target["name"].str()) + "},\"state\":" + (st.t == J::Obj ? dump(st) : "{}") +
           ",\"navigated\":" + (navigated ? "true" : "false") + ",\"newErrors\":" + std::to_string(now.consoleErrors - errs0) + ",\"newFailed\":" + std::to_string(now.failedRequests - failed0) +
           (dialog.empty() ? "" : ",\"dialog\":" + q(dialog)) + ",\"consoleErrors\":" + std::to_string(now.consoleErrors) + ",\"failedRequests\":" + std::to_string(now.failedRequests) + extra + "}";
  }

  // ---------------- Phase 88: the badge, the stop shortcut, takeover ----------------
  void updateBadge() {
    if (badge_) PostMessageW(badge_, WM_BADGE_UPDATE, 0, 0);
  }
  /** Shown while an op runs, for 30 s after one, and while paused. */
  bool badgeActive() { return isPaused || opRunning_ || (lastOpAt_ && GetTickCount64() - lastOpAt_ < 30000); }
  std::wstring badgeText() {
    std::wstring pre = host.testLabel ? L"TEST \u00b7 " : L"";
    if (isPaused) return pre + L"Paused: you're in control of the Sara browser";
    std::string w;
    {
      std::lock_guard<std::mutex> l(whatM_);
      w = what_;
    }
    std::wstring line = pre + L"Sara is working in her browser" + (w.empty() ? L"" : L" \u00b7 " + wide(w));
    if (keep && keptAt_ && GetTickCount64() - keptAt_ < 8000) line += L" \u00b7 she keeps control";
    return line;
  }
  /** Real input (not hers: DevTools input never reaches Windows' input queue) in her window? */
  void watchTakeover() {
    DWORD pid = browser.pid();
    if (!badgeActive() || !pid || isPaused) {
      watching_ = false;
      return;
    }
    LASTINPUTINFO li{sizeof(li)};
    if (!GetLastInputInfo(&li)) return;
    if (!watching_) {
      watching_ = true;
      lastInput_ = li.dwTime;
      return;
    }
    if (li.dwTime == lastInput_) return;
    lastInput_ = li.dwTime;
    POINT pt;
    DWORD under = 0, front = 0;
    if (GetCursorPos(&pt))
      if (HWND w = WindowFromPoint(pt)) GetWindowThreadProcessId(GetAncestor(w, GA_ROOT), &under);
    if (HWND fg = GetForegroundWindow()) GetWindowThreadProcessId(fg, &front);
    if (under == pid || front == pid) userInput();
  }
  void layoutBadge(HWND h) {
    std::wstring text = badgeText();
    UINT dpi = GetDpiForWindow(h);
    auto S = [dpi](int v) { return MulDiv(v, dpi ? dpi : 96, 96); };
    HDC dc = GetDC(h);
    HFONT f = CreateFontW(-S(14), 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    HGDIOBJ old = SelectObject(dc, f);
    SIZE sz{};
    GetTextExtentPoint32W(dc, text.c_str(), (int)text.size(), &sz);
    SelectObject(dc, old);
    DeleteObject(f);
    ReleaseDC(h, dc);
    int btn = S(76), gap = S(8), hgt = S(44);
    int w = S(16) + S(12) + gap + std::min((int)sz.cx, S(560)) + gap + btn + (isPaused ? gap + btn : 0) + S(8);
    MONITORINFO mi{sizeof(mi)};
    GetMonitorInfoW(MonitorFromWindow(GetDesktopWindow(), MONITOR_DEFAULTTOPRIMARY), &mi);
    int x = mi.rcWork.left + (mi.rcWork.right - mi.rcWork.left - w) / 2, y = mi.rcWork.top + S(8);
    SetWindowPos(h, HWND_TOPMOST, x, y, w, hgt, SWP_NOACTIVATE);
    HRGN rgn = CreateRoundRectRgn(0, 0, w + 1, hgt + 1, hgt, hgt);
    SetWindowRgn(h, rgn, TRUE);
    int right = w - S(6);
    stopRc_ = {right - btn, S(5), right, hgt - S(5)};
    resumeRc_ = isPaused ? RECT{stopRc_.left - gap - btn, S(5), stopRc_.left - gap, hgt - S(5)} : RECT{};
  }
  void paintBadge(HWND h) {
    PAINTSTRUCT ps;
    HDC dc = BeginPaint(h, &ps);
    RECT rc;
    GetClientRect(h, &rc);
    UINT dpi = GetDpiForWindow(h);
    auto S = [dpi](int v) { return MulDiv(v, dpi ? dpi : 96, 96); };
    HBRUSH bg = CreateSolidBrush(RGB(32, 24, 38));
    FillRect(dc, &rc, bg);
    DeleteObject(bg);
    COLORREF accent = isPaused ? RGB(240, 170, 60) : RGB(255, 61, 139);
    HBRUSH dot = CreateSolidBrush(accent);
    HGDIOBJ ob = SelectObject(dc, dot);
    HGDIOBJ op = SelectObject(dc, GetStockObject(NULL_PEN));
    int cy = (rc.bottom - rc.top) / 2;
    Ellipse(dc, S(16), cy - S(6), S(28), cy + S(6));
    SelectObject(dc, op);
    SelectObject(dc, ob);
    DeleteObject(dot);
    HFONT f = CreateFontW(-S(14), 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    HGDIOBJ of = SelectObject(dc, f);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, RGB(245, 240, 248));
    std::wstring text = badgeText();
    RECT tr{S(36), 0, (isPaused ? resumeRc_.left : stopRc_.left) - S(8), rc.bottom};
    DrawTextW(dc, text.c_str(), (int)text.size(), &tr, DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);
    auto button = [&](const RECT& b, COLORREF fill, const wchar_t* label) {
      HBRUSH br = CreateSolidBrush(fill);
      HGDIOBJ o1 = SelectObject(dc, br);
      HGDIOBJ o2 = SelectObject(dc, GetStockObject(NULL_PEN));
      RoundRect(dc, b.left, b.top, b.right, b.bottom, b.bottom - b.top, b.bottom - b.top);
      SelectObject(dc, o2);
      SelectObject(dc, o1);
      DeleteObject(br);
      RECT lb = b;
      SetTextColor(dc, RGB(255, 255, 255));
      DrawTextW(dc, label, -1, &lb, DT_SINGLELINE | DT_VCENTER | DT_CENTER | DT_NOPREFIX);
    };
    button(stopRc_, RGB(210, 50, 70), L"Stop");
    if (isPaused) button(resumeRc_, RGB(70, 60, 90), L"Resume");
    SelectObject(dc, of);
    DeleteObject(f);
    EndPaint(h, &ps);
  }
  static LRESULT CALLBACK BadgeProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    Hands* self = reinterpret_cast<Hands*>(GetWindowLongPtrW(h, GWLP_USERDATA));
    switch (msg) {
      case WM_MOUSEACTIVATE: return MA_NOACTIVATE;
      case WM_PAINT:
        if (self) self->paintBadge(h);
        else ValidateRect(h, nullptr);
        return 0;
      case WM_LBUTTONUP: {
        if (!self) break;
        POINT pt{(short)LOWORD(lp), (short)HIWORD(lp)};
        if (PtInRect(&self->stopRc_, pt)) self->pressStop();
        else if (self->isPaused && PtInRect(&self->resumeRc_, pt)) self->resume();
        return 0;
      }
      case WM_HOTKEY:
        // Ctrl+Alt+Esc anywhere: stop her at once.
        if (self && wp == kStopHotkeyId) self->pressStop();
        return 0;
      case WM_TIMER:
        if (self) {
          self->watchTakeover();
          bool on = self->badgeActive();
          if (on != (IsWindowVisible(h) != FALSE)) {
            if (on) {
              self->layoutBadge(h);
              ShowWindow(h, SW_SHOWNOACTIVATE);
            } else ShowWindow(h, SW_HIDE);
          }
        }
        return 0;
      case WM_BADGE_UPDATE:
        if (self && self->badgeActive()) {
          self->layoutBadge(h);
          InvalidateRect(h, nullptr, FALSE);
          ShowWindow(h, SW_SHOWNOACTIVATE);
        } else ShowWindow(h, SW_HIDE);
        return 0;
#ifdef SARA_TEST_HOOKS
      case WM_BADGE_TEST_INPUT:
        if (self && self->host.testLabel) self->userInput();
        return 0;
      case WM_BADGE_TEST_RESUME:
        if (self && self->host.testLabel) self->resume();
        return 0;
#endif
      case WM_CLOSE: DestroyWindow(h); return 0;
      case WM_DESTROY:
        UnregisterHotKey(h, kStopHotkeyId);
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(h, msg, wp, lp);
  }
  void uiLoop() {
    HINSTANCE inst = GetModuleHandleW(nullptr);
    WNDCLASSEXW wc{sizeof(wc)};
    wc.lpfnWndProc = BadgeProc;
    wc.hInstance = inst;
    wc.hCursor = LoadCursorW(nullptr, IDC_HAND);
    wc.lpszClassName = L"SaraHandsBadge";
    RegisterClassExW(&wc);
    badge_ = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, L"SaraHandsBadge", host.testLabel ? L"TEST Sara is working" : L"Sara is working", WS_POPUP, 0, 0, 10, 10, nullptr, nullptr, inst, nullptr);
    if (badge_) {
      SetWindowLongPtrW(badge_, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));
      // Her pictures never show her own badge.
      bool exclude = true;
#ifdef SARA_TEST_HOOKS
      wchar_t v[8];
      if (GetEnvironmentVariableW(L"SARA_TEST_BADGE_VISIBLE", v, 8) > 0) exclude = false;  // test screenshots of the badge
#endif
      if (exclude) SetWindowDisplayAffinity(badge_, 0x11 /* WDA_EXCLUDEFROMCAPTURE */);
      hotkeyOk = RegisterHotKey(badge_, kStopHotkeyId, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_ESCAPE) != FALSE;
      say(hotkeyOk ? L"stop shortcut Ctrl+Alt+Esc ready" : L"stop shortcut Ctrl+Alt+Esc is taken by another app");
      SetTimer(badge_, 1, 150, nullptr);
    }
    SetEvent(uiReady_);
    MSG m;
    while (badge_ && GetMessageW(&m, nullptr, 0, 0) > 0) {
      TranslateMessage(&m);
      DispatchMessageW(&m);
    }
    badge_ = nullptr;
  }

  std::string run(Request& r, OpError& e) {
    const std::atomic<bool>* cancel = r.cancel.get();
    const J& a = r.args;
    if (!kOps.count(r.op)) {
      e = {"unsupported", "This computer doesn't do \"" + r.op.substr(0, 40) + "\" (not in its command set)."};
      return {};
    }
    if (r.op == "c.ping") return "{\"pong\":true,\"at\":" + std::to_string(GetTickCount64()) + "}";
    // Phase 88: nothing acts while the person has taken over; and the device's own rate limit.
    if (kInputOps.count(r.op)) {
      if (isPaused) {
        e = {"takeover", "Paused: the owner took over the Sara browser. Nothing acts until they press Resume."};
        return {};
      }
      if (!countInput(e)) return {};
    }
    if (r.op == "b.downloads") return "{\"files\":" + downloadsJson() + "}";
    if (r.op != "b.tabs" || browser.running()) {
      browser.start(e);
      if (!e.code.empty()) return {};
    }
    if (r.op == "b.start") return "{\"browser\":{\"kind\":" + q(browser.found.kind) + ",\"name\":" + q(browser.found.name) + "},\"tabs\":" + tabsJson() + "}";
    if (r.op == "b.tabs") return std::string("{\"tabs\":") + (browser.running() ? tabsJson() : "[]") + "}";
    if (r.op == "b.open") {
      std::string url = a["url"].str(), why;
      if (!addressAllowed(url, browser.serverOrigin, why)) {
        e = {"denied_local", why};
        return {};
      }
      if (!countOpen(e)) return {};
      std::string id = a["newTab"].truthy() || !browser.tabCount() ? browser.newTab(e) : "";
      if (!e.code.empty()) return {};
      Tab t;
      if (!browser.tab(id, t, e)) return {};
      browser.activate(t.id);
      browser.resetCounts(t.id, true);
      long long before = browser.loads(t.id);
      J nav = browser.call("Page.navigate", "{\"url\":" + q(url) + "}", t.sessionId, 30000, e, cancel);
      if (!e.code.empty()) return {};
      if (nav.has("errorText")) {
        e = {"not_found", "The page didn't open: " + nav["errorText"].str()};
        return {};
      }
      if (!browser.waitLoad(t.id, before, std::min<DWORD>(r.deadlineMs, 60000), cancel)) {
        if (cancel->load()) e = {"stopped", "Stopped."};
        // A page that never finishes loading is still shown: answer with what is there.
      }
      if (!e.code.empty()) return {};
      Sleep(250);
      Tab now;
      browser.tab(t.id, now, e);
      std::string info = pageInfo(now, e);
      thumb(r.id, now, a, cancel);
      frame(now);
      return "{\"tab\":" + q(now.id) + "," + info + ",\"status\":" + std::to_string(now.status) + "," + counts(now.id) + "}";
    }
    Tab t;
    if (!browser.tab(a["tab"].str(), t, e)) return {};
    if (r.op == "b.navigate") {
      browser.activate(t.id);
      std::string action = a["action"].str("reload");
      long long before = browser.loads(t.id);
      if (action == "reload") {
        browser.resetCounts(t.id);
        browser.call("Page.reload", "{}", t.sessionId, 30000, e, cancel);
      } else if (action == "back" || action == "forward") {
        J h = browser.call("Page.getNavigationHistory", "{}", t.sessionId, 10000, e, cancel);
        if (!e.code.empty()) return {};
        int i = (int)h["currentIndex"].num() + (action == "back" ? -1 : 1);
        if (i < 0 || i >= (int)h["entries"].a.size()) {
          e = {"not_found", "There is no page to go " + action + " to."};
          return {};
        }
        std::string why;
        if (!addressAllowed(h["entries"].a[i]["url"].str(), browser.serverOrigin, why)) {
          e = {"denied_local", "That page isn't opened in the Sara browser."};
          return {};
        }
        browser.call("Page.navigateToHistoryEntry", "{\"entryId\":" + num(h["entries"].a[i]["id"].num()) + "}", t.sessionId, 15000, e, cancel);
      } else {
        e = {"unsupported", "action: back, forward or reload."};
        return {};
      }
      if (!e.code.empty()) return {};
      browser.waitLoad(t.id, before, std::min<DWORD>(r.deadlineMs, 15000), cancel);
      Sleep(200);
      std::string info = pageInfo(t, e);
      thumb(r.id, t, a, cancel);
      frame(t);
      return "{\"tab\":" + q(t.id) + "," + info + "," + counts(t.id) + "}";
    }
    if (r.op == "b.snapshot") {
      J v = agent(t, "snapshot", "{\"from\":" + num(a["from"].num(0)) + ",\"limit\":400}", e, cancel);
      if (!e.code.empty()) return {};
      thumb(r.id, t, a, cancel);
      std::string body = dump(v);
      if (body.size() < 2 || body[0] != '{') body = "{}";
      return "{\"tab\":" + q(t.id) + ",\"viewId\":" + q("v" + std::to_string(GetTickCount64())) + "," + counts(t.id) + (body.size() > 2 ? "," + body.substr(1) : "}");
    }
    if (r.op == "b.read") {
      std::string args = "{\"max\":" + num(a["max"].num(8000)) + (a.has("ref") ? ",\"ref\":" + q(a["ref"].str()) : "") + "}";
      J v = agent(t, "text", args, e, cancel);
      if (!e.code.empty()) return {};
      if (v.has("error")) {
        e = {"not_found", v["error"].str()};
        return {};
      }
      std::string body = dump(v);
      return "{\"tab\":" + q(t.id) + (body.size() > 2 ? "," + body.substr(1) : "}");
    }
    if (r.op == "b.screenshot") {
      int mw = (int)std::min(1920.0, std::max(160.0, a["maxWidth"].num(1280)));
      int ql = (int)std::min(90.0, std::max(30.0, a["quality"].num(70)));
      Shot s = shot(t, mw, ql, e, cancel);
      if (!e.code.empty()) return {};
      std::string viewId = "v" + std::to_string(GetTickCount64());
      sendBinary("{\"id\":" + q(r.id) + ",\"kind\":\"shot\",\"mime\":\"image/jpeg\",\"w\":" + std::to_string(s.w) + ",\"h\":" + std::to_string(s.h) + ",\"viewId\":" + q(viewId) + "}", s.jpeg);
      return "{\"tab\":" + q(t.id) + ",\"w\":" + std::to_string(s.w) + ",\"h\":" + std::to_string(s.h) + ",\"viewId\":" + q(viewId) + "}";
    }
    if (r.op == "b.logs") {
      std::string info = pageInfo(t, e);
      long long since = (long long)a["since"].num(0);
      return "{\"tab\":" + q(t.id) + "," + info + ",\"entries\":" + browser.logsJson(t.id, since) + ",\"last\":" + std::to_string(browser.lastSeq()) + "}";
    }
    if (r.op == "b.request") {
      std::string rid = a["requestId"].str();
      OpError e2;
      J body = browser.call("Network.getResponseBody", "{\"requestId\":" + q(rid) + "}", t.sessionId, 15000, e2, cancel);
      if (!e2.code.empty()) {
        e = {"not_found", "That response is no longer kept by the browser (reload and look again)."};
        return {};
      }
      int status = browser.statusOfRequest(t.id, rid);
      std::string st = status ? std::to_string(status) : "null";
      if (body["base64Encoded"].truthy()) return "{\"status\":" + st + ",\"mime\":\"binary\",\"body\":\"(not text)\",\"truncated\":false}";
      std::string text = mask(body["body"].str());
      bool cut = text.size() > 64 * 1024;
      if (cut) text.resize(64 * 1024);
      return "{\"status\":" + st + ",\"mime\":\"text\",\"body\":" + q(text) + ",\"truncated\":" + (cut ? "true" : "false") + "}";
    }
    if (r.op == "b.find") {
      if (a["focused"].truthy()) {
        J st = agent(t, "state", "{}", e, cancel);
        if (!e.code.empty()) return {};
        return "{\"found\":true,\"role\":\"page\",\"name\":" + q(st["focus"].str()) + ",\"desc\":" + q(st["focus"].str("the page")) + ",\"page\":{\"url\":" + q(st["url"].str()) + ",\"title\":" + q(st["title"].str()) + "}}";
      }
      J v = agent(t, "target", targetArgs(a), e, cancel);
      if (!e.code.empty()) return {};
      return v.t == J::Obj ? dump(v) : "{\"found\":false}";
    }
    if (r.op == "b.click" || r.op == "b.type" || r.op == "b.select" || r.op == "b.keys" || r.op == "b.upload") return act(r, t, e);
    if (r.op == "b.scroll") {
      J v = agent(t, "scroll", targetArgs(a), e, cancel);
      if (!e.code.empty()) return {};
      if (v.has("error")) {
        e = {v["stale"].truthy() ? "stale_view" : "not_found", v["error"].str()};
        return {};
      }
      Sleep(150);
      thumb(r.id, t, a, cancel);
      frame(t);
      return "{\"tab\":" + q(t.id) + ",\"scrollY\":" + num(v["scrollY"].num()) + ",\"maxY\":" + num(v["maxY"].num()) + "}";
    }
    if (r.op == "b.close") {
      browser.call("Target.closeTarget", "{\"targetId\":" + q(t.targetId) + "}", "", 10000, e, cancel);
      browser.forget(t.id);
      return "{\"closed\":" + q(t.id) + "}";
    }
    e = {"unsupported", "This computer doesn't do \"" + r.op + "\"."};
    return {};
  }
};

std::mutex g_m;
std::unique_ptr<Hands> g_hands;

}  // namespace

void start(const Host& host) {
  std::unique_ptr<Hands> old;
  {
    std::lock_guard<std::mutex> l(g_m);
    old = std::move(g_hands);
  }
  old.reset();  // closes the old connection and its Sara browser first
  std::lock_guard<std::mutex> l(g_m);
  g_hands = std::make_unique<Hands>(host);
}
void stop() {
  std::unique_ptr<Hands> old;
  {
    std::lock_guard<std::mutex> l(g_m);
    old = std::move(g_hands);
  }
}
void pressStop() {
  std::lock_guard<std::mutex> l(g_m);
  if (g_hands) g_hands->pressStop();
}
void setLocalOnly(bool on) {
  std::lock_guard<std::mutex> l(g_m);
  if (g_hands) g_hands->tellLocalOnly(on);
}
void setTakeover(bool keepControl) {
  std::lock_guard<std::mutex> l(g_m);
  if (g_hands) g_hands->tellTakeover(keepControl);
}
void resume() {
  std::lock_guard<std::mutex> l(g_m);
  if (g_hands) g_hands->resume();
}
bool paused() {
  std::lock_guard<std::mutex> l(g_m);
  return g_hands && g_hands->isPaused;
}
std::wstring statusLine() {
  std::lock_guard<std::mutex> l(g_m);
  return g_hands ? g_hands->status() : std::wstring();
}
std::wstring hotkeyLabel() {
  std::lock_guard<std::mutex> l(g_m);
  return g_hands && g_hands->hotkeyOk ? L"Ctrl+Alt+Esc" : L"";
}
bool running() {
  std::lock_guard<std::mutex> l(g_m);
  return g_hands != nullptr;
}
bool connected() {
  std::lock_guard<std::mutex> l(g_m);
  return g_hands && g_hands->isConnected;
}
std::wstring lastError() {
  std::lock_guard<std::mutex> l(g_m);
  if (!g_hands) return {};
  std::lock_guard<std::mutex> l2(g_hands->errM);
  return g_hands->err;
}
std::wstring browserPath() { return findBrowser().path; }

std::wstring protect(const std::string& secret) {
  DATA_BLOB in{(DWORD)secret.size(), (BYTE*)secret.data()}, out{};
  static const char kEntropy[] = "Sara hands";
  DATA_BLOB ent{sizeof(kEntropy) - 1, (BYTE*)kEntropy};
  if (!CryptProtectData(&in, L"Sara hands", &ent, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out)) return {};
  DWORD n = 0;
  CryptBinaryToStringW(out.pbData, out.cbData, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &n);
  std::wstring s(n, L'\0');
  CryptBinaryToStringW(out.pbData, out.cbData, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, s.data(), &n);
  s.resize(n);
  LocalFree(out.pbData);
  return s;
}
std::string unprotect(const std::wstring& b64) {
  if (b64.empty()) return {};
  DWORD n = 0;
  if (!CryptStringToBinaryW(b64.c_str(), (DWORD)b64.size(), CRYPT_STRING_BASE64, nullptr, &n, nullptr, nullptr)) return {};
  std::vector<BYTE> raw(n);
  if (!CryptStringToBinaryW(b64.c_str(), (DWORD)b64.size(), CRYPT_STRING_BASE64, raw.data(), &n, nullptr, nullptr)) return {};
  DATA_BLOB in{n, raw.data()}, out{};
  static const char kEntropy[] = "Sara hands";
  DATA_BLOB ent{sizeof(kEntropy) - 1, (BYTE*)kEntropy};
  if (!CryptUnprotectData(&in, nullptr, &ent, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out)) return {};
  std::string s((char*)out.pbData, out.cbData);
  SecureZeroMemory(out.pbData, out.cbData);
  LocalFree(out.pbData);
  return s;
}

}  // namespace sarahands
