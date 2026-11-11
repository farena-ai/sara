// The Windows app updates itself: see app-update.h and docs/desktop.md → How the app updates.
#include "app-update.h"

#include "ed25519-verify.h"

#include <bcrypt.h>
#include <shellapi.h>
#include <wincrypt.h>
#include <winhttp.h>

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <ctime>
#include <memory>
#include <mutex>
#include <thread>

namespace saraupdate {

const char* kNoticeUrl = "https://github.com/farena-ai/sara/releases/latest/download/update-notice.json";
const char* kAssetBase = "https://github.com/farena-ai/sara/releases/download/";
const wchar_t* kDownloadPage = L"https://github.com/farena-ai/sara/releases/latest";

std::vector<std::pair<std::string, std::string>> releaseKeys() {
  // src/update-notice.ts NOTICE_KEYS (the release-notice key; its private half never leaves .secrets/).
  return {{"0bfd41a73239cf88", "nbiVWlh8nPGrGcj1vzjzQD9AAMBCWKtoU6lkiWR3UMY="}};
}

// ---------- small helpers ----------
namespace {

std::string u8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}
std::wstring wide(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), w.data(), n);
  return w;
}
std::wstring jsonEsc(const std::wstring& s) {
  std::wstring o;
  for (wchar_t c : s) {
    if (c == L'"' || c == L'\\') o += L'\\', o += c;
    else if (c == L'\n') o += L"\\n";
    else if (c < 0x20) o += L' ';
    else o += c;
  }
  return o;
}
long long nowSecs() { return (long long)_time64(nullptr); }

std::vector<unsigned char> b64(const std::string& s) {
  DWORD n = 0;
  if (!CryptStringToBinaryA(s.c_str(), (DWORD)s.size(), CRYPT_STRING_BASE64, nullptr, &n, nullptr, nullptr) || n == 0 || n > 4096) return {};
  std::vector<unsigned char> out(n);
  if (!CryptStringToBinaryA(s.c_str(), (DWORD)s.size(), CRYPT_STRING_BASE64, out.data(), &n, nullptr, nullptr)) return {};
  out.resize(n);
  return out;
}
std::string hex(const unsigned char* p, size_t n) {
  static const char* d = "0123456789abcdef";
  std::string s;
  for (size_t i = 0; i < n; i++) s += d[p[i] >> 4], s += d[p[i] & 15];
  return s;
}

/** Incremental SHA-256 (BCrypt). */
struct Sha256 {
  BCRYPT_HASH_HANDLE h = nullptr;
  Sha256() { BCryptCreateHash(BCRYPT_SHA256_ALG_HANDLE, &h, nullptr, 0, nullptr, 0, 0); }
  ~Sha256() {
    if (h) BCryptDestroyHash(h);
  }
  void add(const void* p, size_t n) {
    if (h && n) BCryptHashData(h, (PUCHAR)p, (ULONG)n, 0);
  }
  std::string done() {
    unsigned char out[32];
    if (!h || !BCRYPT_SUCCESS(BCryptFinishHash(h, out, 32, 0))) return {};
    return hex(out, 32);
  }
};
std::string fileSha256(const std::wstring& path) {
  HANDLE f = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (f == INVALID_HANDLE_VALUE) return {};
  Sha256 s;
  std::vector<unsigned char> buf(1 << 20);
  DWORD got = 0;
  bool ok = true;
  while ((ok = ReadFile(f, buf.data(), (DWORD)buf.size(), &got, nullptr) != FALSE) && got) s.add(buf.data(), got);
  CloseHandle(f);
  return ok ? s.done() : std::string();
}
bool fileExists(const std::wstring& p) { return GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES; }
std::wstring dirOf(const std::wstring& p) { return p.substr(0, p.find_last_of(L'\\')); }

// ---------- a small JSON reader (UTF-8) ----------
struct JV {
  enum T { Null, Bool, Num, Str, Arr, Obj } t = Null;
  bool b = false;
  double n = 0;
  std::string s;
  std::vector<JV> a;
  std::vector<std::pair<std::string, JV>> o;
  const JV* get(const char* k) const {
    for (auto& kv : o)
      if (kv.first == k) return &kv.second;
    return nullptr;
  }
};
struct JsonReader {
  const std::string& s;
  size_t i = 0;
  int depth = 0;
  explicit JsonReader(const std::string& x) : s(x) {}
  void ws() {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
  }
  static void put(std::string& out, unsigned cp) {
    if (cp < 0x80) out += (char)cp;
    else if (cp < 0x800) out += (char)(0xC0 | (cp >> 6)), out += (char)(0x80 | (cp & 0x3F));
    else if (cp < 0x10000) out += (char)(0xE0 | (cp >> 12)), out += (char)(0x80 | ((cp >> 6) & 0x3F)), out += (char)(0x80 | (cp & 0x3F));
    else out += (char)(0xF0 | (cp >> 18)), out += (char)(0x80 | ((cp >> 12) & 0x3F)), out += (char)(0x80 | ((cp >> 6) & 0x3F)), out += (char)(0x80 | (cp & 0x3F));
  }
  bool hex4(unsigned& v) {
    if (i + 4 > s.size()) return false;
    v = 0;
    for (int k = 0; k < 4; k++) {
      char c = s[i++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= c - '0';
      else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
      else return false;
    }
    return true;
  }
  bool str(std::string& out) {
    if (i >= s.size() || s[i] != '"') return false;
    i++;
    while (i < s.size()) {
      unsigned char c = (unsigned char)s[i++];
      if (c == '"') return true;
      if (c < 0x20) return false;
      if (c != '\\') {
        out += (char)c;
        continue;
      }
      if (i >= s.size()) return false;
      char e = s[i++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          unsigned cp;
          if (!hex4(cp)) return false;
          if (cp >= 0xD800 && cp < 0xDC00) {
            unsigned lo;
            if (i + 6 > s.size() || s[i] != '\\' || s[i + 1] != 'u') return false;
            i += 2;
            if (!hex4(lo) || lo < 0xDC00 || lo > 0xDFFF) return false;
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          } else if (cp >= 0xDC00 && cp < 0xE000) return false;
          put(out, cp);
          break;
        }
        default: return false;
      }
    }
    return false;
  }
  bool val(JV& v) {
    ws();
    if (i >= s.size() || ++depth > 20) return false;
    char c = s[i];
    bool ok = false;
    if (c == '{') {
      v.t = JV::Obj;
      i++;
      ws();
      if (i < s.size() && s[i] == '}') {
        i++;
        ok = true;
      } else
        for (;;) {
          ws();
          std::string k;
          if (!str(k)) break;
          ws();
          if (i >= s.size() || s[i] != ':') break;
          i++;
          JV x;
          if (!val(x)) break;
          v.o.emplace_back(std::move(k), std::move(x));
          ws();
          if (i < s.size() && s[i] == ',') {
            i++;
            continue;
          }
          if (i < s.size() && s[i] == '}') {
            i++;
            ok = true;
          }
          break;
        }
    } else if (c == '[') {
      v.t = JV::Arr;
      i++;
      ws();
      if (i < s.size() && s[i] == ']') {
        i++;
        ok = true;
      } else
        for (;;) {
          JV x;
          if (!val(x)) break;
          v.a.push_back(std::move(x));
          ws();
          if (i < s.size() && s[i] == ',') {
            i++;
            continue;
          }
          if (i < s.size() && s[i] == ']') {
            i++;
            ok = true;
          }
          break;
        }
    } else if (c == '"') {
      v.t = JV::Str;
      ok = str(v.s);
    } else if (s.compare(i, 4, "true") == 0) {
      v.t = JV::Bool, v.b = true, i += 4, ok = true;
    } else if (s.compare(i, 5, "false") == 0) {
      v.t = JV::Bool, v.b = false, i += 5, ok = true;
    } else if (s.compare(i, 4, "null") == 0) {
      v.t = JV::Null, i += 4, ok = true;
    } else if (c == '-' || (c >= '0' && c <= '9')) {
      size_t st = i;
      while (i < s.size() && (strchr("+-.eE", s[i]) || (s[i] >= '0' && s[i] <= '9'))) i++;
      v.t = JV::Num;
      v.n = strtod(s.substr(st, i - st).c_str(), nullptr);
      ok = true;
    }
    depth--;
    return ok;
  }
  bool parse(JV& v) {
    if (!val(v)) return false;
    ws();
    return i == s.size();
  }
};

bool isVersion(const std::string& v) {
  int parts = 0;
  size_t i = 0;
  while (true) {
    size_t st = i;
    while (i < v.size() && v[i] >= '0' && v[i] <= '9') i++;
    if (i == st || i - st > 9) return false;
    parts++;
    if (i == v.size()) return parts == 3;
    if (v[i] != '.' || parts == 3) return false;
    i++;
  }
}
bool isName(const std::string& n) {
  if (n.empty() || n.size() > 200) return false;
  for (char c : n)
    if (!(isalnum((unsigned char)c) || c == '_' || c == '.' || c == '-')) return false;
  return true;
}
bool isSha(const std::string& h) {
  if (h.size() != 64) return false;
  for (char c : h)
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  return true;
}
bool isDate(const std::string& d) {
  // ISO: YYYY-MM-DD…
  if (d.size() < 10) return false;
  for (int k : {0, 1, 2, 3, 5, 6, 8, 9})
    if (d[k] < '0' || d[k] > '9') return false;
  return d[4] == '-' && d[7] == '-';
}

}  // namespace

int compareVersions(const std::string& a, const std::string& b) {
  auto parts = [](std::string v) {
    std::vector<long> out;
    size_t i = 0;
    while (i < v.size() && (v[i] == ' ' || v[i] == '\t')) i++;
    if (i < v.size() && (v[i] == 'v' || v[i] == 'V')) i++;
    std::string cur;
    for (; i <= v.size() && out.size() < 3; i++) {
      char c = i < v.size() ? v[i] : '.';
      if (c == '.' || c == '+' || c == '-') {
        out.push_back(cur.empty() ? 0 : strtol(cur.c_str(), nullptr, 10));
        cur.clear();
        if (i == v.size()) break;
      } else cur += c;
    }
    while (out.size() < 3) out.push_back(0);
    return out;
  };
  auto x = parts(a), y = parts(b);
  for (int i = 0; i < 3; i++)
    if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

bool verifyNotice(const std::string& raw, const std::vector<std::pair<std::string, std::string>>& keys, const std::string& assetBase, const std::string& seen, Notice& out, std::string& why) {
  JV n;
  if (raw.size() > 256 * 1024 || !JsonReader(raw).parse(n) || n.t != JV::Obj) return why = "the notice is not readable", false;
  const JV* payload = n.get("payload");
  const JV* signature = n.get("signature");
  if (!payload || payload->t != JV::Str || !signature || signature->t != JV::Str || signature->s.empty()) return why = "the notice is not signed", false;
  auto sig = b64(signature->s);
  const JV* kid = n.get("keyId");
  std::vector<std::pair<std::string, std::string>> tryKeys;
  for (auto& k : keys)
    if (kid && kid->t == JV::Str && k.first == kid->s) tryKeys.push_back(k);
  if (tryKeys.empty()) tryKeys = keys;
  std::string keyId;
  for (auto& k : tryKeys) {
    auto pk = b64(k.second);
    if (sig.size() == 64 && pk.size() == 32 && ed25519Verify(sig.data(), (const unsigned char*)payload->s.data(), payload->s.size(), pk.data())) {
      keyId = k.first;
      break;
    }
  }
  if (keyId.empty()) return why = "the signature does not match the release key", false;
  JV p;
  if (!JsonReader(payload->s).parse(p) || p.t != JV::Obj) return why = "the notice is not readable", false;
  auto strOf = [&](const char* k) -> std::string {
    const JV* v = p.get(k);
    return v && v->t == JV::Str ? v->s : std::string();
  };
  Notice r;
  r.keyId = keyId;
  r.version = strOf("version");
  r.minSupported = strOf("minSupported");
  r.date = strOf("date");
  if (!isVersion(r.version)) return why = "the notice has no version", false;
  if (!isVersion(r.minSupported)) return why = "the notice has no minimum version", false;
  if (!isDate(r.date)) return why = "the notice has no date", false;
  const JV* sec = p.get("security");
  if (!sec || sec->t != JV::Bool) return why = "the notice has no security flag", false;
  r.security = sec->b;
  const JV* assets = p.get("assets");
  if (!assets || assets->t != JV::Obj) return why = "the notice lists no files", false;
  std::string prefix = assetBase + "v" + r.version + "/";
  for (auto& kv : assets->o) {
    const JV& a = kv.second;
    const JV* name = a.get("name");
    const JV* url = a.get("url");
    const JV* sha = a.get("sha256");
    if (a.t != JV::Obj || !name || name->t != JV::Str || !isName(name->s) || !url || url->t != JV::Str || url->s != prefix + name->s) return why = "a file in the notice is not on the release page", false;
    if (!sha || sha->t != JV::Str || !isSha(sha->s)) return why = "a file in the notice has no SHA-256", false;
    if (kv.first == "win32-x64") {
      r.hasWin = true;
      r.win.name = name->s;
      r.win.url = url->s;
      r.win.sha256 = sha->s;
      const JV* size = a.get("size");
      if (size && size->t == JV::Num && size->n > 0) r.win.size = (unsigned long long)size->n;
    }
  }
  if (r.hasWin && (r.win.name.size() < 5 || _stricmp(r.win.name.c_str() + r.win.name.size() - 4, ".exe") != 0)) return why = "the Windows file in the notice is not an installer", false;
  if (!seen.empty() && compareVersions(r.version, seen) < 0) return why = "the notice (" + r.version + ") is older than one already seen (" + seen + ")", false;
  out = r;
  return true;
}

// ---------- the updater (one per app) ----------
namespace {

struct G {
  Options o;
  std::mutex m;
  Status st;
  Notice notice;
  bool haveNotice = false;
  bool working = false;  // a check or download thread runs
  bool want = false;     // install as soon as it's quiet
  bool wantFromServer = false;
  long long lastServerCheck = 0;
};
G* g = nullptr;

std::wstring iniGet(const wchar_t* key) {
  wchar_t buf[2048] = L"";
  GetPrivateProfileStringW(L"update", key, L"", buf, 2048, g->o.iniPath.c_str());
  return buf;
}
void iniSet(const wchar_t* key, const std::wstring& v) { WritePrivateProfileStringW(L"update", key, v.empty() ? nullptr : v.c_str(), g->o.iniPath.c_str()); }
long long iniNum(const wchar_t* key) { return _wtoi64(iniGet(key).c_str()); }
std::wstring updatesDir() { return g->o.dataDir + L"\\updates"; }
void log(const std::wstring& line) {
  if (g && g->o.log) g->o.log(L"app update: " + line);
}
void changed() {
  if (g && g->o.wnd && g->o.msg) PostMessageW(g->o.wnd, g->o.msg, 0, 0);
}
bool allowedUrl(const std::string& url) {
  if (url.rfind("https://", 0) == 0) return true;
#ifdef SARA_TEST_HOOKS
  // Test builds only: a notice and installer from a local test server.
  if (url.rfind("http://127.0.0.1:", 0) == 0) return true;
#endif
  return false;
}

/** GET through WinHTTP (the system's proxy settings), each piece to `sink`; false with `err`. */
bool httpGet(const std::string& url, unsigned long long max, const std::function<bool(const unsigned char*, DWORD)>& sink, std::wstring& err, DWORD readTimeoutMs) {
  if (!allowedUrl(url)) return err = L"not an https address", false;
  std::wstring w = wide(url);
  URL_COMPONENTS uc{sizeof(uc)};
  wchar_t host[256], path[2048];
  uc.lpszHostName = host;
  uc.dwHostNameLength = 256;
  uc.lpszUrlPath = path;
  uc.dwUrlPathLength = 2048;
  if (!WinHttpCrackUrl(w.c_str(), 0, 0, &uc)) return err = L"not a web address", false;
  std::wstring ua = L"SaraApp/" + g->o.version + L" (Windows)";
  HINTERNET s = WinHttpOpen(ua.c_str(), WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!s) s = WinHttpOpen(ua.c_str(), WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!s) return err = L"no network", false;
  WinHttpSetTimeouts(s, 15000, 15000, 30000, (int)readTimeoutMs);
  HINTERNET c = WinHttpConnect(s, host, uc.nPort, 0);
  HINTERNET r = c ? WinHttpOpenRequest(c, L"GET", path, nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, uc.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0) : nullptr;
  bool ok = false;
  if (r && WinHttpSendRequest(r, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) && WinHttpReceiveResponse(r, nullptr)) {
    DWORD code = 0, len = sizeof(code);
    WinHttpQueryHeaders(r, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &code, &len, WINHTTP_NO_HEADER_INDEX);
    if (code != 200) err = L"HTTP " + std::to_wstring(code);
    else {
      std::vector<unsigned char> buf(64 * 1024);
      unsigned long long total = 0;
      ok = true;
      for (;;) {
        DWORD got = 0;
        if (!WinHttpReadData(r, buf.data(), (DWORD)buf.size(), &got)) {
          err = L"the connection broke (" + std::to_wstring(GetLastError()) + L")";
          ok = false;
          break;
        }
        if (!got) break;
        total += got;
        if (total > max) {
          err = L"the file is larger than expected";
          ok = false;
          break;
        }
        if (!sink(buf.data(), got)) {
          err = L"couldn't save it";
          ok = false;
          break;
        }
      }
    }
  } else
    err = L"offline or blocked (" + std::to_wstring(GetLastError()) + L")";
  if (r) WinHttpCloseHandle(r);
  if (c) WinHttpCloseHandle(c);
  WinHttpCloseHandle(s);
  return ok;
}

void setState(State s, const std::wstring& msg) {
  g->st.state = s;
  g->st.message = msg;
}
std::wstring V(const std::string& v) { return wide(v); }

/** Records a failed download or install of v: tried again later (1 h, 2 h, 4 h … at most 2 days). */
void recordFail(const std::string& v) {
  long long n = iniGet(L"failVersion") == V(v) ? iniNum(L"failCount") + 1 : 1;
  iniSet(L"failVersion", V(v));
  iniSet(L"failCount", std::to_wstring(n));
  long long wait = std::min<long long>(3600LL << std::min<long long>(n - 1, 10), 48 * 3600);
  iniSet(L"failUntil", std::to_wstring(nowSecs() + wait));
}
bool backingOff(const std::string& v) { return iniGet(L"failVersion") == V(v) && nowSecs() < iniNum(L"failUntil"); }

/** The verified installer for n, if it is downloaded (hashed again). */
bool readyFor(const Notice& n) {
  std::wstring path = iniGet(L"readyPath");
  return iniGet(L"readyVersion") == V(n.version) && iniGet(L"readySha") == V(n.win.sha256) && !path.empty() && fileExists(path) && fileSha256(path) == n.win.sha256;
}

/** Downloads n's installer (worker thread, lock not held). */
void download(Notice n) {
  {
    std::lock_guard<std::mutex> l(g->m);
    setState(State::Downloading, L"Downloading Sara app " + V(n.version) + L"\u2026");
  }
  changed();
  CreateDirectoryW(updatesDir().c_str(), nullptr);
  std::wstring dest = updatesDir() + L"\\" + V(n.win.name);
  std::wstring part = dest + L".part";
  HANDLE f = CreateFileW(part.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  std::wstring err;
  bool ok = false;
  std::string got;
  if (f == INVALID_HANDLE_VALUE) err = L"couldn't write to " + updatesDir();
  else {
    Sha256 h;
    unsigned long long max = n.win.size ? n.win.size : 1024ULL * 1024 * 1024;
    ok = httpGet(n.win.url, max, [&](const unsigned char* p, DWORD k) {
      DWORD w = 0;
      h.add(p, k);
      return WriteFile(f, p, k, &w, nullptr) && w == k;
    }, err, 120000);
    CloseHandle(f);
    got = h.done();
  }
  std::lock_guard<std::mutex> l(g->m);
  if (!ok) {
    DeleteFileW(part.c_str());
    recordFail(n.version);
    log(L"downloading " + V(n.version) + L" failed: " + err);
    setState(State::Available, L"Sara app " + V(n.version) + L" is out, but it couldn't be downloaded (" + err + L"). Sara tries again later.");
  } else if (got != n.win.sha256) {
    DeleteFileW(part.c_str());
    recordFail(n.version);
    log(L"the download of " + V(n.version) + L" didn't match the signed notice (" + V(got) + L"): deleted");
    setState(State::Failed, L"The download of Sara app " + V(n.version) + L" didn't match the signed update notice, so it was deleted and nothing was installed. Sara tries again later.");
  } else if (!MoveFileExW(part.c_str(), dest.c_str(), MOVEFILE_REPLACE_EXISTING)) {
    DeleteFileW(part.c_str());
    setState(State::Available, L"Sara app " + V(n.version) + L" is out, but it couldn't be saved. Sara tries again later.");
  } else {
    iniSet(L"readyVersion", V(n.version));
    iniSet(L"readySha", V(n.win.sha256));
    iniSet(L"readyPath", dest);
    log(L"Sara app " + V(n.version) + L" downloaded and checked (SHA-256 " + V(n.win.sha256.substr(0, 12)) + L"\u2026)");
    setState(State::Ready, L"Sara app " + V(n.version) + L" is ready.");
  }
}

/** Reads and checks the notice, then downloads when it should (worker thread). */
void runCheck() {
  std::string body;
  std::wstring err;
  bool got = httpGet(g->o.noticeUrl, 256 * 1024, [&](const unsigned char* p, DWORD k) { body.append((const char*)p, k); return true; }, err, 30000);
  Notice n;
  bool doDownload = false;
  {
    std::lock_guard<std::mutex> l(g->m);
    long long now = nowSecs();
    iniSet(L"lastCheck", std::to_wstring(now));
    std::string why;
    std::string cur = u8(g->o.version);
    if (!got) {
      iniSet(L"nextCheck", std::to_wstring(now + 3600));
      log(L"couldn't read the update notice: " + err);
      if (g->st.state == State::Checking) setState(g->haveNotice ? State::Available : State::Idle, L"Couldn't check for a new app (" + err + L"). Sara tries again later.");
      if (g->st.state == State::Available && g->haveNotice && readyFor(g->notice)) setState(State::Ready, L"Sara app " + V(g->notice.version) + L" is ready.");
    } else if (!verifyNotice(body, g->o.keys, g->o.assetBase, u8(iniGet(L"seen")), n, why)) {
      iniSet(L"nextCheck", std::to_wstring(now + 6 * 3600));
      log(L"the update notice wasn't trusted: " + wide(why));
      setState(State::Failed, L"The update notice wasn't trusted (" + wide(why) + L"), so nothing was downloaded.");
    } else {
      iniSet(L"nextCheck", std::to_wstring(now + 6 * 3600));
      if (iniGet(L"seen").empty() || compareVersions(n.version, u8(iniGet(L"seen"))) > 0) iniSet(L"seen", V(n.version));
      g->notice = n;
      g->haveNotice = true;
      g->st.latest = V(n.version);
      g->st.security = n.security;
      g->st.required = compareVersions(cur, n.minSupported) < 0;
      if (compareVersions(n.version, cur) <= 0) {
        setState(State::Current, L"The Sara app is up to date (" + g->o.version + L").");
        g->want = false;
      } else if (!n.hasWin) {
        setState(State::Failed, L"Sara " + V(n.version) + L" has no installer for Windows yet.");
      } else if (g->o.how == L"server") {
        setState(State::Available, L"Sara " + V(n.version) + L" is out. Sara's server on this computer updates this app with her: Settings \u2192 Updates.");
      } else if (g->o.how == L"manual") {
        setState(State::Available, L"Sara app " + V(n.version) + L" is out. This copy wasn't installed with Sara-Setup: download it from " + kDownloadPage + L".");
      } else if (readyFor(n)) {
        setState(State::Ready, L"Sara app " + V(n.version) + L" is ready.");
      } else {
        setState(State::Available, L"Sara app " + V(n.version) + L" is out.");
        bool autoOk = iniGet(L"auto") != L"0" && !backingOff(n.version);
        doDownload = g->want || autoOk;
      }
    }
    if (!doDownload) g->working = false;
  }
  if (doDownload) {
    download(n);
    std::lock_guard<std::mutex> l(g->m);
    g->working = false;
  }
  changed();
}

void startWorker(std::function<void()> fn) {
  std::thread([fn] { fn(); }).detach();
}

}  // namespace

void init(const Options& o) {
  if (!g) g = new G();
  g->o = o;
  std::wstring rv = iniGet(L"readyVersion");
  if (!rv.empty()) {
    if (compareVersions(u8(rv), u8(o.version)) > 0 && fileExists(iniGet(L"readyPath"))) {
      g->st.latest = rv;
      setState(State::Ready, L"Sara app " + rv + L" is ready.");
    } else {
      // Installed (or older): the download isn't needed any more.
      std::wstring p = iniGet(L"readyPath");
      if (!p.empty()) DeleteFileW(p.c_str());
      iniSet(L"readyVersion", L"");
      iniSet(L"readySha", L"");
      iniSet(L"readyPath", L"");
    }
  }
  DeleteFileW((updatesDir() + L"\\SaraUpdater.exe").c_str());  // the last watcher's copy (gone when it has finished)
  // On start: a check soon (the first tick), unless one ran in the last 15 minutes.
  if (nowSecs() - iniNum(L"lastCheck") > 15 * 60) iniSet(L"nextCheck", L"");
}

void check(bool force) {
  if (!g) return;
  {
    std::lock_guard<std::mutex> l(g->m);
    if (g->working || g->st.state == State::Installing) return;
    if (!force && nowSecs() < iniNum(L"nextCheck")) return;
    g->working = true;
    if (g->st.state != State::Ready) g->st.state = State::Checking;
  }
  changed();
  startWorker(runCheck);
}

void serverVersion(const std::string& v) {
  if (!g || !isVersion(v) || compareVersions(v, u8(g->o.version)) <= 0) return;
  {
    std::lock_guard<std::mutex> l(g->m);
    long long now = nowSecs();
    if (now - g->lastServerCheck < 3600) return;
    g->lastServerCheck = now;
  }
  log(L"the server is on " + wide(v) + L": checking for a newer app");
  check(true);
}

void wantInstall(bool fromServer) {
  if (!g) return;
  {
    std::lock_guard<std::mutex> l(g->m);
    g->want = true;
    g->wantFromServer = fromServer;
  }
  // A fresh notice first (it downloads what it vouches for, as asked, even after a failed try).
  if (status().state != State::Ready) check(true);
  changed();
}
void later() {
  if (!g) return;
  std::lock_guard<std::mutex> l(g->m);
  g->want = false;
  if (g->haveNotice) iniSet(L"laterVersion", V(g->notice.version));
}
bool wantsInstall() {
  if (!g) return false;
  std::lock_guard<std::mutex> l(g->m);
  return g->want;
}
bool autoOn() { return g && iniGet(L"auto") != L"0"; }
void setAuto(bool on) {
  if (!g) return;
  iniSet(L"auto", on ? L"1" : L"0");
  if (on) check(true);
}
Status status() {
  if (!g) return {};
  std::lock_guard<std::mutex> l(g->m);
  return g->st;
}
bool ready() {
  if (!g) return false;
  std::lock_guard<std::mutex> l(g->m);
  return g->st.state == State::Ready && g->o.how == L"remote";
}

bool mayInstallByItself() {
  if (!ready()) return false;
  std::lock_guard<std::mutex> l(g->m);
  // After a failed install of this version: only when the person (or the server) asks again.
  return iniGet(L"auto") != L"0" && !backingOff(u8(iniGet(L"readyVersion")));
}

std::wstring statusJson() {
  if (!g) return L"null";
  std::lock_guard<std::mutex> l(g->m);
  static const wchar_t* names[] = {L"idle", L"checking", L"current", L"available", L"downloading", L"ready", L"installing", L"failed"};
  long long last = iniNum(L"lastCheck");
  return std::wstring(L"{\"state\":\"") + names[(int)g->st.state] + L"\",\"version\":\"" + jsonEsc(g->o.version) + L"\",\"latest\":\"" + jsonEsc(g->st.latest) + L"\",\"message\":\"" + jsonEsc(g->st.message) +
         L"\",\"security\":" + (g->st.security ? L"true" : L"false") + L",\"required\":" + (g->st.required ? L"true" : L"false") + L",\"auto\":" + (iniGet(L"auto") != L"0" ? L"true" : L"false") +
         L",\"want\":" + (g->want ? L"true" : L"false") + L",\"how\":\"" + g->o.how + L"\",\"page\":\"" + kDownloadPage + L"\",\"later\":\"" + jsonEsc(iniGet(L"laterVersion")) + L"\",\"checkedAt\":" + std::to_wstring(last * 1000) + L"}";
}

std::wstring install(bool relaunch, bool background) {
  if (!g) return L"The updater isn't running.";
  std::wstring path, sha, to;
  {
    std::lock_guard<std::mutex> l(g->m);
    if (g->o.how == L"server") return L"Sara's server on this computer updates this app with her: Settings \u2192 Updates.";
    if (g->o.how != L"remote") return std::wstring(L"This copy of the app wasn't installed with Sara-Setup: download it from ") + kDownloadPage + L".";
    if (g->st.state != State::Ready) return L"The new app isn't downloaded yet.";
    path = iniGet(L"readyPath");
    sha = iniGet(L"readySha");
    to = iniGet(L"readyVersion");
  }
  if (path.empty() || fileSha256(path) != u8(sha)) {
    std::lock_guard<std::mutex> l(g->m);
    DeleteFileW(path.c_str());
    iniSet(L"readyVersion", L"");
    setState(State::Failed, L"The downloaded app didn't match the signed update notice any more, so it was deleted and nothing was installed.");
    changed();
    return g->st.message;
  }
  // The watcher runs from a copy outside the install folder (Setup replaces Sara.exe there).
  std::wstring watcher = updatesDir() + L"\\SaraUpdater.exe";
  if (!CopyFileW(g->o.exePath.c_str(), watcher.c_str(), FALSE)) return L"Couldn't prepare the update (" + std::to_wstring(GetLastError()) + L"). Nothing was changed.";
  std::wstring cmd = L"\"" + watcher + L"\" --apply-update --installer \"" + path + L"\" --sha " + sha + L" --to " + to + L" --from " + g->o.version + L" --app \"" + g->o.exePath + L"\" --ini \"" + g->o.iniPath +
                     L"\" --parent " + std::to_wstring(GetCurrentProcessId()) + (relaunch ? L" --relaunch" : L"") + (background ? L" --background" : L"");
  STARTUPINFOW si{sizeof(si)};
  PROCESS_INFORMATION pi{};
  if (!CreateProcessW(watcher.c_str(), cmd.data(), nullptr, nullptr, FALSE, CREATE_NEW_PROCESS_GROUP, nullptr, updatesDir().c_str(), &si, &pi)) return L"Couldn't start the update (" + std::to_wstring(GetLastError()) + L"). Nothing was changed.";
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  {
    std::lock_guard<std::mutex> l(g->m);
    setState(State::Installing, L"Installing Sara app " + to + L"\u2026");
  }
  log(L"installing " + to + (relaunch ? L" (the app closes and comes back)" : L" (as the app closes)"));
  return L"";
}

std::wstring takeResult(bool& ok) {
  if (!g) return L"";
  std::wstring r = iniGet(L"result");
  if (r.empty()) return L"";
  std::wstring to = iniGet(L"resultVersion"), from = iniGet(L"resultFrom"), code = iniGet(L"resultCode"), why = iniGet(L"resultWhy");
  iniSet(L"result", L"");
  ok = r == L"ok";
  if (ok) return L"The Sara app is updated to " + to + L".";
  std::wstring msg = L"Sara app " + to + L" didn't install (" + (why.empty() ? L"Setup ended with code " + code : why) + L"), so this app stays at " + from + L". You can download it from " + kDownloadPage + L" and run it.";
  std::lock_guard<std::mutex> l(g->m);
  g->st.latest = to;
  setState(State::Failed, msg);  // the next check shows the download as ready again; it isn't installed by itself for a while
  return msg;
}

// ---------- the watcher: Sara.exe --apply-update … (a copy in <data>\updates) ----------
int runWatcher() {
  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  std::wstring installer, sha, to, from, app, ini;
  DWORD parent = 0;
  bool relaunch = false, background = false;
  for (int i = 1; argv && i < argc; i++) {
    std::wstring a = argv[i];
    auto next = [&]() { return i + 1 < argc ? std::wstring(argv[++i]) : std::wstring(); };
    if (a == L"--installer") installer = next();
    else if (a == L"--sha") sha = next();
    else if (a == L"--to") to = next();
    else if (a == L"--from") from = next();
    else if (a == L"--app") app = next();
    else if (a == L"--ini") ini = next();
    else if (a == L"--parent") parent = (DWORD)_wtoi(next().c_str());
    else if (a == L"--relaunch") relaunch = true;
    else if (a == L"--background") background = true;
  }
  if (argv) LocalFree(argv);
  if (installer.empty() || app.empty() || ini.empty() || sha.size() != 64) return 64;
  Options o;
  o.iniPath = ini;
  o.dataDir = dirOf(ini);
  o.version = from;
  if (!g) g = new G();
  g->o = o;
  std::wstring logFile = o.dataDir + L"\\desktop.log";
  auto wlog = [&](const std::wstring& line) {
    FILE* f = nullptr;
    if (_wfopen_s(&f, logFile.c_str(), L"a, ccs=UTF-8") == 0 && f) {
      SYSTEMTIME t;
      GetLocalTime(&t);
      fwprintf(f, L"%04d-%02d-%02d %02d:%02d:%02d app update: %s\n", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, line.c_str());
      fclose(f);
    }
  };
  // 1. The app closes first (it started us and is quitting).
  if (HANDLE p = parent ? OpenProcess(SYNCHRONIZE, FALSE, parent) : nullptr) {
    if (WaitForSingleObject(p, 60000) == WAIT_TIMEOUT) wlog(L"the app didn't close within a minute; Setup closes it");
    CloseHandle(p);
  }
  Sleep(1000);  // its web view lets go of its files
  auto finish = [&](bool ok, DWORD code, const std::wstring& why) {
    iniSet(L"result", ok ? L"ok" : L"failed");
    iniSet(L"resultVersion", to);
    iniSet(L"resultFrom", from);
    iniSet(L"resultCode", std::to_wstring(code));
    iniSet(L"resultWhy", why);
    iniSet(L"resultAt", std::to_wstring(nowSecs()));
    if (ok) {
      DeleteFileW(installer.c_str());
      iniSet(L"readyVersion", L"");
      iniSet(L"readySha", L"");
      iniSet(L"readyPath", L"");
      iniSet(L"failVersion", L"");
      iniSet(L"failCount", L"");
      iniSet(L"failUntil", L"");
    } else
      recordFail(u8(to));
    wlog(ok ? L"Sara app " + to + L" installed" : L"Sara app " + to + L" didn't install: " + (why.empty() ? L"code " + std::to_wstring(code) : why) + L"; the app stays at " + from);
    // The app comes back: always after a failure the person started (relaunch), and after a success when it was open.
    if (relaunch && fileExists(app)) {
      std::wstring args = std::wstring(L"--after-update") + (background ? L" --background" : L"");
      ShellExecuteW(nullptr, L"open", app.c_str(), args.c_str(), dirOf(app).c_str(), SW_SHOWNORMAL);
    }
    return ok ? 0 : 1;
  };
  // 2. The installer is still the one the signed notice vouched for.
  if (fileSha256(installer) != u8(sha)) {
    DeleteFileW(installer.c_str());
    return finish(false, 0, L"the downloaded installer didn't match the signed update notice, so it was deleted");
  }
  // 3. The app's own server settings, put back after Setup (it must never sign anyone out).
  auto sara = [&](const wchar_t* k) {
    wchar_t b[2048] = L"";
    GetPrivateProfileStringW(L"sara", k, L"", b, 2048, ini.c_str());
    return std::wstring(b);
  };
  std::wstring server = sara(L"server"), lastServer = sara(L"lastServer"), pairNext = sara(L"pairNext");
  // 4. Setup, silently, the app only (as it was installed), for the same server.
  std::wstring args = L"\"" + installer + L"\" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /MODE=remote /LOG=\"" + o.dataDir + L"\\updates\\install.log\"";
  if (server.empty()) {
    if (lastServer.empty()) return finish(false, 0, L"this app has no server address for Setup");
    args += L" /SERVER=\"" + lastServer + L"\"";
  }
  wlog(L"running Setup for " + to + L" (from " + from + L")");
  STARTUPINFOW si{sizeof(si)};
  PROCESS_INFORMATION pi{};
  if (!CreateProcessW(installer.c_str(), args.data(), nullptr, nullptr, FALSE, 0, nullptr, dirOf(installer).c_str(), &si, &pi)) return finish(false, GetLastError(), L"Windows didn't start Setup (" + std::to_wstring(GetLastError()) + L")");
  CloseHandle(pi.hThread);
  DWORD code = 1;
  if (WaitForSingleObject(pi.hProcess, 15 * 60000) == WAIT_TIMEOUT) {
    CloseHandle(pi.hProcess);
    return finish(false, 0, L"Setup didn't finish within 15 minutes");
  }
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hProcess);
  WritePrivateProfileStringW(L"sara", L"server", server.empty() ? nullptr : server.c_str(), ini.c_str());
  WritePrivateProfileStringW(L"sara", L"lastServer", lastServer.empty() ? nullptr : lastServer.c_str(), ini.c_str());
  WritePrivateProfileStringW(L"sara", L"pairNext", pairNext.empty() ? nullptr : pairNext.c_str(), ini.c_str());
  if (code != 0) return finish(false, code, L"");
  // 5. The new app is really there (its file version is the notice's version).
  DWORD h = 0, n = GetFileVersionInfoSizeW(app.c_str(), &h);
  std::vector<BYTE> vi(n ? n : 1);
  VS_FIXEDFILEINFO* ffi = nullptr;
  UINT len = 0;
  std::wstring got;
  if (n && GetFileVersionInfoW(app.c_str(), 0, n, vi.data()) && VerQueryValueW(vi.data(), L"\\", (void**)&ffi, &len) && ffi)
    got = std::to_wstring(HIWORD(ffi->dwFileVersionMS)) + L"." + std::to_wstring(LOWORD(ffi->dwFileVersionMS)) + L"." + std::to_wstring(HIWORD(ffi->dwFileVersionLS));
  if (compareVersions(u8(got), u8(to)) != 0) return finish(false, code, L"Setup finished but the app is still " + (got.empty() ? L"the old one" : got));
  return finish(true, 0, L"");
}

}  // namespace saraupdate
