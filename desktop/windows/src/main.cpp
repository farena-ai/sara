// Sara for Windows (Phase 33): a native window around the owner's own Sara server, using the
// system's Edge WebView2. Tray icon (keeps running when the window is closed), notifications,
// start with Windows, microphone for calls, first-run setup (server address, then the server's own
// /pair page for the sign-in code). No credentials are stored here: the sign-in is the server's
// session cookie, kept in this user's WebView2 profile.
// Phase 55: works the same against a Sara on another computer or server (the installer's
// "Connect to a Sara somewhere else" installs only this app): a different server from the tray menu,
// and a "can't reach your Sara" page with Try again.
// Phase 68: several Sara servers in one app, each with its own sign-in. Every server has its own
// WebView2 profile (cookies, storage, cache: kept apart, encrypted by WebView2 with this Windows
// user's DPAPI key); the first one is the profile used before 1.8, so an update keeps its sign-in.
// The tray menu and the page's ⇄ menu switch between them without signing out.
// Phase 75 (the new look): a dark or light title bar that follows the page's theme (Night / Day),
// Mica behind it on Windows 11 22H2+, the page drawn into the title area (WebView2's non-client
// region support: CSS app-region: drag) with the native minimize / maximize / close buttons kept
// (DWM draws them; snap layouts on the maximize button keep working), and the theme colour from the
// first frame so there is never a white flash. Older Windows or an older WebView2: the normal title
// bar, dark or light. The page learns all of it from window.saraShell (kShellScript below).
// Phase 75 stage 2: worth installing. A global shortcut (Alt+Shift+S by default, changeable from the
// tray menu or the page's settings through the bridge) opens a small floating quick-ask window over
// any app; her face and mood head the tray menu with a "Now" section (background jobs running,
// approvals waiting with Allow / Deny / Open), and the tray tooltip shows her mood. The quick-ask
// page (desktop/shared/quick-ask.html, shared with the Mac app) is served by this app AT the
// server's own address in the same WebView2 profile, so it talks to the server with the same
// sign-in through the normal routes (the AI notice, private mode, household and demo rules apply).
// Phase 75 stage 3: native notifications. Windows toasts (toast.h) for approvals waiting (Allow / Deny
// / Open in Sara, with the command in the text, so an Allow is an informed OK, exactly like the tray's
// Allow; never decided by itself) and reminders (Done / Snooze 10 min), and for the page's own
// notifications (messages, calls), which replace the old tray balloons; a toast for the same event
// replaces the page's instead of adding a second one. Files: "Send to → Sara" in Explorer and
// Sara.exe <files> hand files to the running app (a second start forwards them with WM_COPYDATA);
// they are put into the message box as attachments by the page's own attach code, never sent by
// themselves. The tray menu is dark while the page shows Night.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <commdlg.h>
#include <dwmapi.h>
#include <uxtheme.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <wrl.h>
#include <objbase.h>
#include <string>
#include <map>
#include <vector>
#include <ctime>
#include <windowsx.h>
#include <wincodec.h>
#include <wincrypt.h>
#include "WebView2.h"
#include "resource.h"
#include "page-logo.h"
#include "toast.h"
#include "hands.h"
#include <propkey.h>
#include <propvarutil.h>
#include <set>
#include <mutex>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

// The version is package.json's (CMakeLists.txt passes it in), so Settings → This computer shows
// the release it came with.
#ifndef SARA_APP_VERSION
#define SARA_APP_VERSION "0.0.0-dev"
#endif
#define SARA_WIDEN2(x) L##x
#define SARA_WIDEN(x) SARA_WIDEN2(x)
static const wchar_t* kVersion = SARA_WIDEN(SARA_APP_VERSION);
static const wchar_t* kWindowClass = L"SaraDesktopWindow";
static const UINT WM_APP_TRAY = WM_APP + 1;
static const UINT WM_APP_SHOW = WM_APP + 2;
static const UINT WM_APP_BALLOON = WM_APP + 3;
static const UINT WM_APP_SWITCH = WM_APP + 4;   // switch to g_switchTo (from the message loop)
static const UINT WM_APP_REMOVED = WM_APP + 5;  // finish removing a server (sign-in cleared)
static const UINT WM_APP_TOAST = WM_APP + 6;    // Phase 75 stage 3: a click on a toast (queued)
static const ULONG_PTR kCopyFiles = 0x53415246; // 'SARF': WM_COPYDATA with file paths from a second start
static const size_t kMaxFiles = 10;
static const UINT kTrayId = 1;
static const UINT_PTR kRemoveTimer = 7;
static const UINT_PTR kNowTimer = 8;            // Phase 75 stage 2: "Now" in the tray menu, every 45 s
static const int kHotkeyId = 1;                 // the quick-ask shortcut (RegisterHotKey)
enum MenuId {
  ID_OPEN = 100, ID_LOGIN, ID_QUIT, ID_CHANGE, ID_SETTINGS, ID_HELP, ID_ASK, ID_HEADER, ID_SHORTCUT_OFF, ID_SENDTO, ID_HANDS_STOP, ID_HANDS_OFF, ID_HANDS_RESUME, ID_HANDS_LOG, ID_HANDS_STATUS,
  ID_SERVER0 = 200, ID_NOW0 = 300, ID_ALLOW0 = 340, ID_DENY0 = 380, ID_SHORTCUT0 = 420
};
static const size_t kNowMax = 10;

static HINSTANCE g_inst;
static HWND g_wnd;
static ComPtr<ICoreWebView2Controller> g_controller;
static ComPtr<ICoreWebView2> g_web;
static ComPtr<ICoreWebView2Environment> g_env;
static std::wstring g_profile;       // Phase 68: the server in use (s1, s2, …)
static std::wstring g_switchTo, g_switchPath;
static std::wstring g_removing;      // being signed out and forgotten
static std::wstring g_removeAfterLoad;
static std::wstring g_nextPath = L"/";
static NOTIFYICONDATAW g_tray{};
static std::wstring g_server;        // e.g. https://sara.example.com (origin, no trailing slash)
static std::wstring g_pendingConv;   // conversation to open when a notification is clicked
static bool g_quitting = false;
static bool g_toldAboutTray = false;

// ---------- small helpers ----------
static std::wstring dataDir() {
#ifdef SARA_TEST_HOOKS
  // Test builds only (cmake -DSARA_TEST_HOOKS=ON): a data folder of their own, so a test run never
  // touches the real app's settings or sign-ins on this PC. Release builds don't contain this.
  wchar_t t[MAX_PATH];
  if (GetEnvironmentVariableW(L"SARA_DESKTOP_TEST_DIR", t, MAX_PATH) > 0) {
    CreateDirectoryW(t, nullptr);
    return t;
  }
#endif
  wchar_t* p = nullptr;
  std::wstring dir;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &p))) dir = std::wstring(p) + L"\\Sara";
  CoTaskMemFree(p);
  CreateDirectoryW(dir.c_str(), nullptr);
  return dir;
}
static std::wstring iniPath() { return dataDir() + L"\\desktop.ini"; }
/** A test run (test builds with SARA_DESKTOP_TEST_DIR): its own AUMID, toast activator, single-instance
 *  lock and Send To entry, so it never touches the real app's on this PC. */
static bool testRun() {
#ifdef SARA_TEST_HOOKS
  return GetEnvironmentVariableW(L"SARA_DESKTOP_TEST_DIR", nullptr, 0) > 0;
#else
  return false;
#endif
}
// Phase 75 stage 3: who Sara is to Windows (toasts, taskbar grouping) and the COM class that takes
// clicks on her toasts. The installer's Start-menu shortcut carries the same two (sara.iss).
static const wchar_t* kAumid = L"BackstageCoding.Sara";
static const wchar_t* kToastClsidText = L"{57448757-B168-47CE-9852-892129855C82}";
static const CLSID kToastClsid = {0x57448757, 0xb168, 0x47ce, {0x98, 0x52, 0x89, 0x21, 0x29, 0x85, 0x5c, 0x82}};
static const CLSID kToastClsidTest = {0x06518ab6, 0xe425, 0x4c52, {0xa9, 0x2f, 0xfb, 0x52, 0xbe, 0x78, 0x67, 0xe6}};
static const wchar_t* aumid() { return testRun() ? L"BackstageCoding.Sara.Test" : kAumid; }
static const wchar_t* toastClsidText() { return testRun() ? L"{06518AB6-E425-4C52-A92F-FB52BE7867E6}" : kToastClsidText; }
static const CLSID& toastClsid() { return testRun() ? kToastClsidTest : kToastClsid; }
static std::wstring getPref(const wchar_t* key, const wchar_t* def = L"") {
  wchar_t buf[2048];
  GetPrivateProfileStringW(L"sara", key, def, buf, 2048, iniPath().c_str());
  return buf;
}
static void setPref(const wchar_t* key, const std::wstring& v) { WritePrivateProfileStringW(L"sara", key, v.c_str(), iniPath().c_str()); }
static bool prefOn(const wchar_t* key, bool def) { return getPref(key, def ? L"1" : L"0") == L"1"; }
static std::wstring getIni(const std::wstring& section, const wchar_t* key) {
  wchar_t buf[2048];
  GetPrivateProfileStringW(section.c_str(), key, L"", buf, 2048, iniPath().c_str());
  return buf;
}
static void setIni(const std::wstring& section, const wchar_t* key, const std::wstring& v) { WritePrivateProfileStringW(section.c_str(), key, v.c_str(), iniPath().c_str()); }

static std::wstring exePath() {
  wchar_t buf[MAX_PATH];
  GetModuleFileNameW(nullptr, buf, MAX_PATH);
  return buf;
}
static std::wstring exeDir() {
  std::wstring p = exePath();
  return p.substr(0, p.find_last_of(L'\\'));
}
/** Phase 46c: installed by Sara-Setup.exe together with the server (SaraService.exe beside it). The
 *  installer then owns the program folder, shortcuts and uninstall; the app doesn't install itself. */
static bool fileExists(const std::wstring& p) { return GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES; }
static bool installedWithServer() { return fileExists(exeDir() + L"\\SaraService.exe"); }
/** Phase 55: installed by Sara-Setup.exe (with her server, or the app only for a Sara elsewhere):
 *  the installer owns the folder, shortcut and uninstall entry. */
static bool installedBySetup() { return installedWithServer() || fileExists(exeDir() + L"\\unins000.exe"); }
/** Her port on this computer (sara.env next to SaraService.exe), or "" when she doesn't run here. */
static std::wstring localPort() {
  if (!installedWithServer()) return L"";
  FILE* f = nullptr;
  if (_wfopen_s(&f, (exeDir() + L"\\sara.env").c_str(), L"r, ccs=UTF-8") != 0 || !f) return L"";
  std::wstring port;
  wchar_t line[1024];
  while (fgetws(line, 1024, f)) {
    std::wstring l = line;
    if (l.rfind(L"SARA_PORT=", 0) != 0) continue;
    for (wchar_t c : l.substr(10))
      if (iswdigit(c)) port += c;
      else break;
  }
  fclose(f);
  return port;
}

static std::string toUtf8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}
static std::wstring fromUtf8(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
  return w;
}

static std::wstring jsonEscape(const std::wstring& s) {
  std::wstring o;
  for (wchar_t c : s) {
    switch (c) {
      case L'"': o += L"\\\""; break;
      case L'\\': o += L"\\\\"; break;
      case L'\n': o += L"\\n"; break;
      case L'\r': o += L"\\r"; break;
      case L'\t': o += L"\\t"; break;
      default:
        if (c < 0x20) { wchar_t b[8]; swprintf(b, 8, L"\\u%04x", c); o += b; } else o += c;
    }
  }
  return o;
}

/** Parses a flat JSON object of string / number / boolean values (all the bridge sends). */
static std::map<std::wstring, std::wstring> parseFlatJson(const std::wstring& s) {
  std::map<std::wstring, std::wstring> out;
  size_t i = 0;
  auto ws = [&] { while (i < s.size() && iswspace(s[i])) i++; };
  auto str = [&]() -> std::wstring {
    std::wstring v;
    i++;  // opening quote
    while (i < s.size() && s[i] != L'"') {
      if (s[i] == L'\\' && i + 1 < s.size()) {
        wchar_t e = s[++i];
        if (e == L'n') v += L'\n';
        else if (e == L't') v += L'\t';
        else if (e == L'r') v += L'\r';
        else if (e == L'u' && i + 4 < s.size()) { v += (wchar_t)wcstol(s.substr(i + 1, 4).c_str(), nullptr, 16); i += 4; }
        else v += e;
      } else v += s[i];
      i++;
    }
    i++;  // closing quote
    return v;
  };
  ws();
  if (i >= s.size() || s[i] != L'{') return out;
  i++;
  while (i < s.size()) {
    ws();
    if (s[i] == L'}') break;
    if (s[i] != L'"') break;
    std::wstring k = str();
    ws();
    if (s[i] != L':') break;
    i++;
    ws();
    std::wstring v;
    if (s[i] == L'"') v = str();
    else {
      size_t st = i;
      while (i < s.size() && s[i] != L',' && s[i] != L'}') i++;
      v = s.substr(st, i - st);
      while (!v.empty() && iswspace(v.back())) v.pop_back();
    }
    out[k] = v;
    ws();
    if (i < s.size() && s[i] == L',') i++;
  }
  return out;
}

/** A host that's reached without HTTPS when no scheme is typed: localhost, *.local and IP
 *  addresses (a home network, Tailscale's 100.x addresses). The installer uses the same rule. */
static bool plainHttpHost(const std::wstring& hostPort) {
  if (!hostPort.empty() && hostPort[0] == L'[') return true;  // IPv6
  std::wstring name = hostPort.substr(0, hostPort.find(L':'));
  if (name == L"localhost") return true;
  if (name.size() > 6 && name.compare(name.size() - 6, 6, L".local") == 0) return true;
  int parts = 0, digits = 0, value = 0;
  for (size_t i = 0; i <= name.size(); i++) {
    wchar_t c = i < name.size() ? name[i] : L'.';
    if (c == L'.') {
      if (digits == 0 || value > 255) return false;
      parts++;
      digits = value = 0;
    } else if (iswdigit(c) && digits < 3) {
      value = value * 10 + (c - L'0');
      digits++;
    } else return false;
  }
  return parts == 4;
}

/** "https://host:port/anything" → "https://host:port"; empty if it isn't an http(s) address.
 *  Without a scheme: https, except for plainHttpHost addresses. */
static std::wstring originOf(std::wstring url) {
  while (!url.empty() && iswspace(url.back())) url.pop_back();
  while (!url.empty() && iswspace(url.front())) url.erase(url.begin());
  if (url.find(L"://") == std::wstring::npos) {
    std::wstring host = url.substr(0, url.find_first_of(L"/?#"));
    for (auto& c : host) c = towlower(c);
    url = (plainHttpHost(host) ? L"http://" : L"https://") + url;
  }
  size_t scheme = url.find(L"://");
  std::wstring sch = url.substr(0, scheme);
  for (auto& c : sch) c = towlower(c);
  if (sch != L"https" && sch != L"http") return L"";
  size_t end = url.find_first_of(L"/?#", scheme + 3);
  std::wstring host = url.substr(scheme + 3, end == std::wstring::npos ? std::wstring::npos : end - scheme - 3);
  if (host.empty() || host.find_first_of(L" @\\") != std::wstring::npos) return L"";
  for (auto& c : host) c = towlower(c);
  return sch + L"://" + host;
}
static bool sameOrigin(const std::wstring& uri) {
  if (g_server.empty()) return false;
  std::wstring o = originOf(uri);
  return !o.empty() && o == g_server;
}

// ---------- Phase 68: the saved servers ----------
// desktop.ini: [servers] list=s1,s2 active=s2; [server.s1] url, name, named, emoji, lastUsed.
// No sign-in is stored here: each server's sign-in is its session cookie in its own WebView2
// profile (s1: the default profile, as before 1.8; the others: "sara-<id>").
struct Profile {
  std::wstring id, url, name, emoji;
  bool named = false;
  long long lastUsed = 0;
};
static std::wstring hostOfUrl(const std::wstring& url) {
  size_t p = url.find(L"://");
  return p == std::wstring::npos ? url : url.substr(p + 3);
}
static std::vector<std::wstring> profileIds() {
  std::vector<std::wstring> out;
  std::wstring list = getIni(L"servers", L"list"), cur;
  for (wchar_t c : list + L",") {
    if (c == L',') {
      if (!cur.empty()) out.push_back(cur);
      cur.clear();
    } else if (iswalnum(c)) cur += c;
  }
  return out;
}
static void setProfileIds(const std::vector<std::wstring>& ids) {
  std::wstring list;
  for (auto& i : ids) list += (list.empty() ? L"" : L",") + i;
  setIni(L"servers", L"list", list);
}
static Profile loadProfile(const std::wstring& id) {
  std::wstring sec = L"server." + id;
  Profile p;
  p.id = id;
  p.url = getIni(sec, L"url");
  p.name = getIni(sec, L"name");
  if (p.name.empty()) p.name = hostOfUrl(p.url);
  p.emoji = getIni(sec, L"emoji");
  p.named = getIni(sec, L"named") == L"1";
  p.lastUsed = _wtoi64(getIni(sec, L"lastUsed").c_str());
  return p;
}
static void saveProfile(const Profile& p) {
  std::wstring sec = L"server." + p.id;
  setIni(sec, L"url", p.url);
  setIni(sec, L"name", p.name);
  setIni(sec, L"named", p.named ? L"1" : L"0");
  setIni(sec, L"emoji", p.emoji);
  setIni(sec, L"lastUsed", std::to_wstring(p.lastUsed));
}
static std::vector<Profile> profiles() {
  std::vector<Profile> out;
  for (auto& id : profileIds()) {
    Profile p = loadProfile(id);
    if (!p.url.empty()) out.push_back(p);
  }
  return out;
}
static std::wstring lower(std::wstring s) {
  for (auto& c : s) c = towlower(c);
  return s;
}
/** A name no other saved server uses: "Sara", then "Sara (127.0.0.1:7882)". */
static std::wstring uniqueName(const std::wstring& wanted, const std::wstring& url, const std::wstring& self) {
  auto taken = [&](const std::wstring& n) {
    for (auto& p : profiles())
      if (p.id != self && lower(p.name) == lower(n)) return true;
    return false;
  };
  std::wstring base = wanted.empty() ? hostOfUrl(url) : wanted.substr(0, 60);
  if (!taken(base)) return base;
  std::wstring withHost = base + L" (" + hostOfUrl(url) + L")";
  if (!taken(withHost)) return withHost;
  for (int i = 2;; i++)
    if (!taken(withHost + L" " + std::to_wstring(i))) return withHost + L" " + std::to_wstring(i);
}
/** The saved server at exactly this address, or a new one (not signed in yet). */
static std::wstring profileFor(const std::wstring& url) {
  for (auto& p : profiles())
    if (p.url == url) return p.id;
  auto ids = profileIds();
  std::wstring id;
  for (int i = 1;; i++) {
    id = L"s" + std::to_wstring(i);
    bool used = false;
    for (auto& x : ids) used = used || x == id;
    if (!used && loadProfile(id).url.empty()) break;
  }
  Profile p;
  p.id = id;
  p.url = url;
  p.name = uniqueName(L"", url, id);
  saveProfile(p);
  ids.push_back(id);
  setProfileIds(ids);
  return id;
}
static void updateTrayTip();
static void handsSync();
/** Makes it the one in use (the address is also kept in "server", as before 1.8). */
static void activate(const std::wstring& id) {
  Profile p = loadProfile(id);
  p.lastUsed = (long long)time(nullptr);
  saveProfile(p);
  g_profile = id;
  g_server = p.url;
  setIni(L"servers", L"active", id);
  setPref(L"server", p.url);
  updateTrayTip();
  handsSync();  // Phase 87: Sara's hands follow the server in use
}
/** The one server saved before 1.8 becomes profile s1, with its sign-in, with nothing to do. */
static void migrateProfiles() {
  if (!profileIds().empty() || g_server.empty()) return;
  Profile p;
  p.id = L"s1";
  p.url = g_server;
  p.name = hostOfUrl(g_server);
  p.lastUsed = (long long)time(nullptr);
  saveProfile(p);
  setProfileIds({L"s1"});
  setIni(L"servers", L"active", L"s1");
}
static void forgetProfile(const std::wstring& id) {
  auto ids = profileIds();
  std::vector<std::wstring> keep;
  for (auto& x : ids)
    if (x != id) keep.push_back(x);
  setProfileIds(keep);
  WritePrivateProfileStringW((L"server." + id).c_str(), nullptr, nullptr, iniPath().c_str());
  if (id == g_profile) sarahands::stop();  // Phase 87: its hands token went with it
}
static std::wstring serversJson() {
  std::wstring out = L"{\"servers\":[";
  bool first = true;
  for (auto& p : profiles()) {
    out += (first ? L"" : L",") + std::wstring(L"{\"id\":\"") + jsonEscape(p.id) + L"\",\"name\":\"" + jsonEscape(p.name) + L"\",\"host\":\"" + jsonEscape(hostOfUrl(p.url)) +
           L"\",\"emoji\":\"" + jsonEscape(p.emoji) + L"\",\"active\":" + (p.id == g_profile ? L"true" : L"false") + L"}";
    first = false;
  }
  return out + L"]}";
}

// ---------- start with Windows ----------
static const wchar_t* kRunKey = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
static bool startAtLogin() {
  HKEY k;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, kRunKey, 0, KEY_READ, &k) != ERROR_SUCCESS) return false;
  bool on = RegQueryValueExW(k, L"Sara", nullptr, nullptr, nullptr, nullptr) == ERROR_SUCCESS;
  RegCloseKey(k);
  return on;
}
static void setStartAtLogin(bool on) {
  HKEY k;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, kRunKey, 0, KEY_SET_VALUE, &k) != ERROR_SUCCESS) return;
  if (on) {
    std::wstring cmd = L"\"" + exePath() + L"\" --background";
    RegSetValueExW(k, L"Sara", 0, REG_SZ, (const BYTE*)cmd.c_str(), (DWORD)((cmd.size() + 1) * sizeof(wchar_t)));
  } else RegDeleteValueW(k, L"Sara");
  RegCloseKey(k);
}

// ---------- Phase 75 stage 3: shortcuts that say they are Sara (AUMID + toast activator) ----------
/** Puts Sara's AUMID and toast activator on a shortcut, so the taskbar groups the window with its
 *  pin and Windows knows whose toasts they are. */
static bool stampLink(IShellLinkW* link) {
  ComPtr<IPropertyStore> props;
  if (!link || FAILED(link->QueryInterface(IID_PPV_ARGS(&props)))) return false;
  PROPVARIANT v;
  bool ok = SUCCEEDED(InitPropVariantFromString(aumid(), &v));
  if (ok) {
    ok = SUCCEEDED(props->SetValue(PKEY_AppUserModel_ID, v));
    PropVariantClear(&v);
  }
  if (ok && SUCCEEDED(InitPropVariantFromCLSID(toastClsid(), &v))) {
    props->SetValue(PKEY_AppUserModel_ToastActivatorCLSID, v);
    PropVariantClear(&v);
  }
  return ok && SUCCEEDED(props->Commit());
}
/** An existing shortcut to this exe (Start menu, a taskbar pin) made before 2.7: stamped once. */
static void stampShortcut(const std::wstring& lnk, const std::wstring& target) {
  if (!fileExists(lnk)) return;
  ComPtr<IShellLinkW> link;
  ComPtr<IPersistFile> file;
  if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link))) || FAILED(link.As(&file)) || FAILED(file->Load(lnk.c_str(), STGM_READWRITE))) return;
  wchar_t path[MAX_PATH] = L"";
  if (FAILED(link->GetPath(path, MAX_PATH, nullptr, SLGP_RAWPATH)) || _wcsicmp(path, target.c_str()) != 0) return;
  ComPtr<IPropertyStore> props;
  PROPVARIANT v;
  PropVariantInit(&v);
  if (SUCCEEDED(link.As(&props)) && SUCCEEDED(props->GetValue(PKEY_AppUserModel_ID, &v)) && v.vt == VT_LPWSTR && v.pwszVal && wcscmp(v.pwszVal, aumid()) == 0) {
    PropVariantClear(&v);
    return;
  }
  PropVariantClear(&v);
  if (stampLink(link.Get())) file->Save(lnk.c_str(), TRUE);
}
static void stampShortcuts() {
  std::wstring exe = exePath();
  for (auto id : {FOLDERID_Programs, FOLDERID_CommonPrograms}) {
    wchar_t* p = nullptr;
    if (SUCCEEDED(SHGetKnownFolderPath(id, 0, nullptr, &p))) stampShortcut(std::wstring(p) + L"\\Sara.lnk", exe);  // the common one only with the rights to
    CoTaskMemFree(p);
  }
  wchar_t* p = nullptr;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, nullptr, &p))) stampShortcut(std::wstring(p) + L"\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar\\Sara.lnk", exe);
  CoTaskMemFree(p);
}

// ---------- Phase 75 stage 3: "Send to → Sara" in Explorer ----------
// A shortcut in the user's SendTo folder, made on the first start and kept pointing at this exe;
// the tray menu turns it off and on (desktop.ini sendTo=0/1). Explorer starts Sara.exe with the
// files; a running Sara gets them from that second start (WM_COPYDATA) and puts them in the
// message box as attachments.
static std::wstring sendToPath() {
  wchar_t* p = nullptr;
  std::wstring out;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_SendTo, 0, nullptr, &p))) out = std::wstring(p) + (testRun() ? L"\\Sara (test).lnk" : L"\\Sara.lnk");
  CoTaskMemFree(p);
  return out;
}
static bool sendToOn() { return getPref(L"sendTo") == L"1"; }
static void makeSendTo() {
  std::wstring lnk = sendToPath();
  if (lnk.empty()) return;
  ComPtr<IShellLinkW> link;
  if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link)))) return;
  link->SetPath(exePath().c_str());
  link->SetDescription(L"Give these files to Sara: they're attached to your message in her window, and you send it.");
  link->SetIconLocation(exePath().c_str(), 0);
  stampLink(link.Get());
  ComPtr<IPersistFile> file;
  if (SUCCEEDED(link.As(&file))) file->Save(lnk.c_str(), TRUE);
}
static void setSendTo(bool on) {
  setPref(L"sendTo", on ? L"1" : L"0");
  if (on) makeSendTo();
  else if (!sendToPath().empty()) DeleteFileW(sendToPath().c_str());
}
/** First start: on. Later: kept as the owner left it, pointing at this exe (it may have moved). */
static void ensureSendTo() {
  if (getPref(L"sendTo").empty()) return setSendTo(true);
  if (!sendToOn()) return;
  std::wstring lnk = sendToPath();
  ComPtr<IShellLinkW> link;
  ComPtr<IPersistFile> file;
  wchar_t path[MAX_PATH] = L"";
  if (fileExists(lnk) && SUCCEEDED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link))) && SUCCEEDED(link.As(&file)) &&
      SUCCEEDED(file->Load(lnk.c_str(), STGM_READ)) && SUCCEEDED(link->GetPath(path, MAX_PATH, nullptr, SLGP_RAWPATH)) && _wcsicmp(path, exePath().c_str()) == 0)
    return;
  makeSendTo();
}

// ---------- install (a downloaded Sara.exe puts itself in the user's Programs and Start menu) ----------
static bool installIfNeeded() {
  wchar_t* p = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_UserProgramFiles, KF_FLAG_CREATE, nullptr, &p))) return false;
  std::wstring dir = std::wstring(p) + L"\\Sara";
  CoTaskMemFree(p);
  std::wstring target = dir + L"\\Sara.exe";
  std::wstring self = exePath();
  if (_wcsicmp(self.c_str(), target.c_str()) == 0) return false;  // already running the installed copy
  CreateDirectoryW(dir.c_str(), nullptr);
  if (!CopyFileW(self.c_str(), target.c_str(), FALSE)) return false;  // e.g. the installed one is running: just run from here
  // Start menu shortcut.
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Programs, 0, nullptr, &p))) {
    std::wstring lnk = std::wstring(p) + L"\\Sara.lnk";
    CoTaskMemFree(p);
    ComPtr<IShellLinkW> link;
    if (SUCCEEDED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link)))) {
      link->SetPath(target.c_str());
      link->SetDescription(L"Sara, your companion");
      link->SetIconLocation(target.c_str(), 0);
      stampLink(link.Get());  // Phase 75 stage 3: toasts and taskbar pins know it's Sara
      ComPtr<IPersistFile> file;
      if (SUCCEEDED(link.As(&file))) file->Save(lnk.c_str(), TRUE);
    }
  }
  if (startAtLogin()) setStartAtLogin(true);  // point the login entry at the installed copy
  // Listed in Settings → Apps, with Uninstall.
  HKEY k;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SaraDesktop", 0, nullptr, 0, KEY_SET_VALUE, nullptr, &k, nullptr) == ERROR_SUCCESS) {
    auto put = [&](const wchar_t* name, const std::wstring& v) { RegSetValueExW(k, name, 0, REG_SZ, (const BYTE*)v.c_str(), (DWORD)((v.size() + 1) * sizeof(wchar_t))); };
    put(L"DisplayName", L"Sara");
    put(L"DisplayVersion", kVersion);
    put(L"Publisher", L"Backstage Coding");
    put(L"DisplayIcon", target);
    put(L"InstallLocation", dir);
    put(L"UninstallString", L"\"" + target + L"\" --uninstall");
    DWORD one = 1;
    RegSetValueExW(k, L"NoModify", 0, REG_DWORD, (const BYTE*)&one, sizeof(one));
    RegSetValueExW(k, L"NoRepair", 0, REG_DWORD, (const BYTE*)&one, sizeof(one));
    RegCloseKey(k);
  }
  ShellExecuteW(nullptr, L"open", target.c_str(), nullptr, dir.c_str(), SW_SHOWNORMAL);
  return true;
}

/** Settings → Apps → Uninstall: removes the app, its shortcut, login entry and data on this PC. */
static void uninstall() {
  if (installedBySetup()) {
    // Sara-Setup.exe installed the app (with the server, or the app only): its uninstaller removes
    // it (and, with a server, asks about her data).
    std::wstring unins = exeDir() + L"\\unins000.exe";
    if (GetFileAttributesW(unins.c_str()) != INVALID_FILE_ATTRIBUTES) ShellExecuteW(nullptr, L"open", unins.c_str(), nullptr, exeDir().c_str(), SW_SHOWNORMAL);
    else MessageBoxW(nullptr, L"Sara was installed with Sara-Setup. Remove her from Settings → Apps → Sara.", L"Sara", MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST);
    return;
  }
  if (MessageBoxW(nullptr, L"Remove Sara from this computer? Your conversations stay on your Sara server; this only removes the app here.", L"Sara", MB_YESNO | MB_ICONQUESTION | MB_SETFOREGROUND | MB_TOPMOST) != IDYES) return;
  if (HWND other = FindWindowW(kWindowClass, L"Sara")) {
    // Quit the running app and wait for it (and its WebView) to finish, so nothing is rewritten afterwards.
    DWORD pid = 0;
    GetWindowThreadProcessId(other, &pid);
    HANDLE proc = OpenProcess(SYNCHRONIZE, FALSE, pid);
    PostMessageW(other, WM_COMMAND, ID_QUIT, 0);
    if (proc) {
      WaitForSingleObject(proc, 15000);
      CloseHandle(proc);
    }
    Sleep(3000);
  }
  setStartAtLogin(false);
  RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SaraDesktop");
  // Phase 75 stage 3: her Send To entry, her toasts and their registration.
  if (!sendToPath().empty()) DeleteFileW(sendToPath().c_str());
  saratoast::unregisterApp(aumid(), toastClsidText());
  wchar_t* p = nullptr;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Programs, 0, nullptr, &p))) {
    DeleteFileW((std::wstring(p) + L"\\Sara.lnk").c_str());
    CoTaskMemFree(p);
  }
  // The app's own folder and its data are removed once this process has exited.
  std::wstring self = exePath();
  std::wstring dir = self.substr(0, self.find_last_of(L'\\'));
  // (WebView2 can take several seconds to let go of its files, so it keeps trying for up to 30 s.)
  std::wstring data = dataDir();
  std::wstring cmd;
  if (GetFileAttributesW((data + L"\\data").c_str()) != INVALID_FILE_ATTRIBUTES) {
    // A Sara server keeps her data in <this folder>\data (Phase 46c): remove only the app's own files.
    std::wstring wv = data + L"\\WebView";
    cmd = L"/c timeout /t 3 /nobreak >nul & del /q \"" + data + L"\\desktop.ini\" \"" + data + L"\\desktop.log\" 2>nul & for /l %i in (1,1,15) do (if exist \"" + dir +
          L"\" rmdir /s /q \"" + dir + L"\" & if exist \"" + wv + L"\" rmdir /s /q \"" + wv + L"\" & if exist \"" + wv + L"\" timeout /t 2 /nobreak >nul)";
  } else {
    cmd = L"/c timeout /t 3 /nobreak >nul & for /l %i in (1,1,15) do (if exist \"" + dir + L"\" rmdir /s /q \"" + dir +
          L"\" & if exist \"" + data + L"\" rmdir /s /q \"" + data + L"\" & if exist \"" + data + L"\" timeout /t 2 /nobreak >nul)";
  }
  ShellExecuteW(nullptr, L"open", L"cmd.exe", cmd.c_str(), nullptr, SW_HIDE);
}

// ---------- window, tray, notifications ----------
static void showWindow() {
  if (!g_wnd) return;
  ShowWindow(g_wnd, IsIconic(g_wnd) ? SW_RESTORE : SW_SHOW);
  SetForegroundWindow(g_wnd);
  if (g_controller) g_controller->put_IsVisible(TRUE);
}
static bool windowInFront() { return g_wnd && IsWindowVisible(g_wnd) && !IsIconic(g_wnd) && GetForegroundWindow() == g_wnd; }

// ---------- Phase 75: theme, title bar, Mica ----------
// The page's theme is Night (dark, the default) or Day. The page tells the app when it changes
// ({type:'theme', theme:'night'|'day'|'system'}); the app remembers it in desktop.ini so the next
// start opens in the right colours before the page has loaded.
static const COLORREF kNight = RGB(0x0f, 0x0d, 0x17);
static const COLORREF kDay = RGB(0xfa, 0xf7, 0xf5);
static std::wstring g_themePref = L"night";  // night | day | system (as the page said)
static bool g_day = false;                    // what is shown now
static bool g_customFrame = false;            // the page draws into the title area
static bool g_wantCustomFrame = false;        // Windows 11 + a WebView2 that has app-region support
static bool g_mica = false;                   // DWMSBT_MAINWINDOW is set (Windows 11 22H2+)
static bool g_wantMica = false;               // the page asked for Mica (its background is see-through)
// The page said it draws its header in the title strip ({type:'shell', titlebar:true}); until then
// (an older Sara server, a page still loading) the app keeps a plain title strip of its own above it.
static bool g_pageTitle = false;
static std::wstring g_pageTitleOrigin;
static HBRUSH g_bgBrush = nullptr;
static const int kTitlebarDip = 40;           // the page's header strip (CSS px)

static DWORD windowsBuild() {
  static DWORD build = 0;
  if (build) return build;
  using RtlGetVersionFn = LONG(WINAPI*)(OSVERSIONINFOW*);
  if (HMODULE nt = GetModuleHandleW(L"ntdll.dll")) {
    if (auto fn = reinterpret_cast<RtlGetVersionFn>(reinterpret_cast<void*>(GetProcAddress(nt, "RtlGetVersion")))) {
      OSVERSIONINFOW v{sizeof(v)};
      if (fn(&v) == 0) build = v.dwBuildNumber;
    }
  }
  return build;
}
static bool systemUsesLight() {
  DWORD v = 0, n = sizeof(v);
  if (RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", L"AppsUseLightTheme", RRF_RT_REG_DWORD, nullptr, &v, &n) != ERROR_SUCCESS) return false;
  return v != 0;
}
static bool resolveDay(const std::wstring& pref) { return pref == L"day" || (pref == L"system" && systemUsesLight()); }
static COLORREF themeColor() { return g_day ? kDay : kNight; }
static UINT windowDpi() { return g_wnd ? GetDpiForWindow(g_wnd) : 96; }
/** The resize border at the top while the page draws into the title area (not when maximized). */
static int topResizeBand() {
  if (!g_customFrame || !g_wnd || IsZoomed(g_wnd)) return 0;
  UINT dpi = windowDpi();
  return GetSystemMetricsForDpi(SM_CYSIZEFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
}
static int titlebarPx() { return MulDiv(kTitlebarDip, (int)windowDpi(), 96); }
/** Where DWM draws minimize / maximize / close, in client coordinates (empty without the custom frame). */
static RECT captionButtons() {
  RECT r{};
  if (!g_customFrame || FAILED(DwmGetWindowAttribute(g_wnd, DWMWA_CAPTION_BUTTON_BOUNDS, &r, sizeof(r)))) return RECT{};
  // The bounds are relative to the window; the client area starts after the left border.
  RECT wr;
  GetWindowRect(g_wnd, &wr);
  POINT origin{0, 0};
  ClientToScreen(g_wnd, &origin);
  OffsetRect(&r, wr.left - origin.x, wr.top - origin.y);
  return r;
}

/** The web view fills the window below the top resize band (or below the app's own title strip
 *  while the page doesn't draw one); with the custom frame its window is cut out under the caption
 *  buttons, so DWM's own buttons show (and take the clicks) there. */
static void layoutWebView() {
  if (!g_controller || !g_wnd) return;
  RECT rc;
  GetClientRect(g_wnd, &rc);
  rc.top += g_customFrame && !g_pageTitle ? titlebarPx() : topResizeBand();
  g_controller->put_Bounds(rc);
  RECT btn = captionButtons();
  for (HWND c = GetWindow(g_wnd, GW_CHILD); c; c = GetWindow(c, GW_HWNDNEXT)) {
    if (!g_customFrame || IsRectEmpty(&btn)) {
      SetWindowRgn(c, nullptr, TRUE);
      continue;
    }
    HRGN all = CreateRectRgn(0, 0, rc.right - rc.left, rc.bottom - rc.top);
    HRGN hole = CreateRectRgn(btn.left - rc.left, btn.top - rc.top, btn.right - rc.left, btn.bottom - rc.top);
    CombineRgn(all, all, hole, RGN_DIFF);
    DeleteObject(hole);
    SetWindowRgn(c, all, TRUE);  // the window owns the region now
  }
}

static void extendFrame() {
  if (!g_wnd) return;
  // Mica: the whole window is "frame", so it shows behind every see-through part of the page.
  MARGINS m = g_mica ? MARGINS{-1, -1, -1, -1} : MARGINS{0, 0, g_customFrame ? titlebarPx() : 0, 0};
  DwmExtendFrameIntoClientArea(g_wnd, &m);
}

static void themeMenus();
/** Title bar colours, Mica and the web view's background for the theme shown now. */
static void applyTheme() {
  if (!g_wnd) return;
  BOOL dark = g_day ? FALSE : TRUE;
  // 20 = DWMWA_USE_IMMERSIVE_DARK_MODE (Windows 10 20H1+ and 11); 19 was its number before that.
  if (FAILED(DwmSetWindowAttribute(g_wnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof(dark)))) DwmSetWindowAttribute(g_wnd, 19, &dark, sizeof(dark));
  DWORD build = windowsBuild();
  // Mica only when the page asked for it (it then leaves its background see-through, so Mica shows
  // behind the whole header). Otherwise the frame and the place under the caption buttons are the
  // theme colour, the same as the page's own background, so nothing shows as a box.
  g_mica = false;
  if (build >= 22621) {
    DWM_SYSTEMBACKDROP_TYPE type = g_wantMica ? DWMSBT_MAINWINDOW : DWMSBT_NONE;
    g_mica = SUCCEEDED(DwmSetWindowAttribute(g_wnd, DWMWA_SYSTEMBACKDROP_TYPE, &type, sizeof(type))) && g_wantMica;
  }
  if (build >= 22000) {
    // Windows 11: the caption (and the frame DWM draws its buttons on) in the theme colour.
    // With Mica: the default (DWMWA_COLOR_DEFAULT), or DWM paints the caption strip over Mica.
    COLORREF caption = g_mica ? DWMWA_COLOR_DEFAULT : themeColor();
    COLORREF text = g_mica ? DWMWA_COLOR_DEFAULT : g_day ? RGB(0x24, 0x1c, 0x2b) : RGB(0xee, 0xe9, 0xf3);
    DwmSetWindowAttribute(g_wnd, DWMWA_CAPTION_COLOR, &caption, sizeof(caption));
    DwmSetWindowAttribute(g_wnd, DWMWA_TEXT_COLOR, &text, sizeof(text));
  }
  HBRUSH old = g_bgBrush;
  g_bgBrush = CreateSolidBrush(themeColor());
  SetClassLongPtrW(g_wnd, GCLP_HBRBACKGROUND, (LONG_PTR)g_bgBrush);
  if (old) DeleteObject(old);
  ComPtr<ICoreWebView2Controller2> c2;
  COLORREF c = themeColor();
  if (g_controller && SUCCEEDED(g_controller.As(&c2))) c2->put_DefaultBackgroundColor({(BYTE)(g_mica ? 0 : 255), GetRValue(c), GetGValue(c), GetBValue(c)});
  themeMenus();
  // Windows 10 repaints the caption only when the frame changes.
  extendFrame();
  SetWindowPos(g_wnd, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  InvalidateRect(g_wnd, nullptr, TRUE);
}

/** The page said which theme it shows (or the system's light/dark changed while it follows it). */
static void setTheme(std::wstring pref) {
  if (pref == L"dark") pref = L"night";  // the page's own words for them (localStorage sara.theme)
  if (pref == L"light") pref = L"day";
  if (pref != L"night" && pref != L"day" && pref != L"system") return;
  bool day = resolveDay(pref);
  bool changed = pref != g_themePref || day != g_day;
  g_themePref = pref;
  g_day = day;
  if (getPref(L"theme") != pref) setPref(L"theme", pref);
  if (changed) applyTheme();
}

/** The page draws its header in the title strip (or a new page from another place hasn't said so). */
static void setPageTitle(bool on, const std::wstring& origin) {
  g_pageTitleOrigin = on ? origin : L"";
  if (g_pageTitle == on) return;
  g_pageTitle = on;
  layoutWebView();
  if (g_wnd) InvalidateRect(g_wnd, nullptr, TRUE);
}
/** "https://host" for server pages, "local" for the app's own pages (data: / about:). */
static std::wstring pageOrigin(const std::wstring& uri) {
  if (uri.rfind(L"data:", 0) == 0 || uri.rfind(L"about:", 0) == 0) return L"local";
  return originOf(uri);
}

/** The page asks for Mica behind it ('mica') or its own solid background ('solid'). */
static void setBackdrop(const std::wstring& b) {
  if (b != L"mica" && b != L"solid") return;
  bool want = b == L"mica" && windowsBuild() >= 22621;
  if (getPref(L"backdrop") != b) setPref(L"backdrop", b);
  if (want == g_wantMica) return;
  g_wantMica = want;
  applyTheme();
}

/** Switches the page-in-the-title-area frame on or off (off: the normal title bar). */
static void setCustomFrame(bool on) {
  if (g_customFrame == on || !g_wnd) return;
  g_customFrame = on;
  extendFrame();
  SetWindowPos(g_wnd, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  layoutWebView();
}

/** The page's view of the window (window.saraShell and <html class="shell-windows">), set before
 *  any page script runs. titlebar: the height in CSS px of the strip the page draws its header in
 *  and marks app-region: drag (0 = Windows draws a normal title bar above the page). controls: the
 *  part of that strip the native caption buttons cover, so the page keeps it free. */
static std::wstring shellScript() {
  int title = g_wantCustomFrame ? kTitlebarDip : 0;
  // Windows 11's caption buttons: 3 × 46 px wide at 100%; the real width is measured once the
  // frame is on, this is the start value.
  int controls = g_wantCustomFrame ? 138 : 0;
  RECT b = captionButtons();
  if (!IsRectEmpty(&b)) controls = MulDiv(b.right - b.left, 96, (int)windowDpi()) + 8;
  // backdrops: what this Windows can show behind a see-through page; backdrop: what it shows now.
  std::wstring backdrops = windowsBuild() >= 22621 ? L"['solid', 'mica']" : L"['solid']";
  std::wstring backdrop = g_wantMica ? L"mica" : L"solid";
  return L"(() => {\n"
         L"  if (window.top !== window) return;\n"
         L"  window.saraShell = { platform: 'windows', titlebar: " + std::to_wstring(title) + L", controls: { side: 'right', width: " + std::to_wstring(controls) +
         L" }, theme: '" + g_themePref + L"', backdrop: '" + backdrop + L"', backdrops: " + backdrops + L", version: '" + kVersion + L"' };\n"
         L"  const mark = () => {\n"
         L"    const d = document.documentElement;\n"
         L"    if (!d) return false;\n"
         L"    d.classList.add('shell-windows');\n"
         L"    d.style.setProperty('--shell-titlebar', window.saraShell.titlebar + 'px');\n"
         L"    d.style.setProperty('--shell-controls-right', window.saraShell.controls.width + 'px');\n"
         L"    return true;\n"
         L"  };\n"
         L"  if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, { childList: true });\n"
         L"})();\n";
}

static void logLine(const std::wstring& line) {
  FILE* f = nullptr;
  if (_wfopen_s(&f, (dataDir() + L"\\desktop.log").c_str(), L"a, ccs=UTF-8") == 0 && f) {
    SYSTEMTIME t;
    GetLocalTime(&t);
    fwprintf(f, L"%04d-%02d-%02d %02d:%02d:%02d %s\n", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, line.c_str());
    fclose(f);
  }
}

static std::wstring g_balloonTitle, g_balloonBody;
/** Shown from the message loop (calling the shell from inside a WebView2 callback times out). */
static void trayBalloon(const std::wstring& title, const std::wstring& body) {
  g_balloonTitle = title;
  g_balloonBody = body;
  PostMessageW(g_wnd, WM_APP_BALLOON, 0, 0);
}
static void showBalloonNow() {
  const std::wstring& title = g_balloonTitle;
  const std::wstring& body = g_balloonBody;
  g_tray.uFlags = NIF_INFO;
  wcsncpy_s(g_tray.szInfoTitle, title.c_str(), _TRUNCATE);
  wcsncpy_s(g_tray.szInfo, body.empty() ? L" " : body.c_str(), _TRUNCATE);
  // No extra icon: Windows already shows Sara's icon and name on the notification (NIIF_USER with
  // a custom balloon icon fails here with a timeout).
  g_tray.dwInfoFlags = NIIF_NONE;
  g_tray.uTimeout = 10000;
  if (!Shell_NotifyIconW(NIM_MODIFY, &g_tray)) logLine(L"notification failed (" + std::to_wstring(GetLastError()) + L")");
}

static void addTray() {
  g_tray.cbSize = sizeof(g_tray);
  g_tray.hWnd = g_wnd;
  g_tray.uID = kTrayId;
  g_tray.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
  g_tray.uCallbackMessage = WM_APP_TRAY;
  g_tray.hIcon = (HICON)LoadImageW(g_inst, MAKEINTRESOURCEW(IDI_SARA), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), 0);
  g_tray.hBalloonIcon = (HICON)LoadImageW(g_inst, MAKEINTRESOURCEW(IDI_SARA), IMAGE_ICON, GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON), 0);
  if (!g_tray.szTip[0]) wcscpy_s(g_tray.szTip, L"Sara");
  if (!Shell_NotifyIconW(NIM_ADD, &g_tray)) logLine(L"tray icon failed (" + std::to_wstring(GetLastError()) + L")");
}

// ---------- Phase 75 stage 2: the quick-ask window, its shortcut, "Now" and her face ----------
// The quick-ask page (desktop/shared/quick-ask.html, RCDATA IDR_QUICKASK) is answered by this app at
// <server>/__sara_desktop/quick-ask (WebResourceRequested), in a second web view on the SAME WebView2
// environment and profile as the main window. It is therefore same-origin with the server and uses
// the sign-in the main window has (a household member's own, too). It also polls the server for
// her mood, face and "Now" (asked every 45 s while the app runs, sooner on /api/events) and tells
// the app, which shows them in the tray menu and tooltip.
static const wchar_t* kQuickClass = L"SaraQuickAsk";
static const wchar_t* kQuickPath = L"/__sara_desktop/quick-ask";
static const int kQuickWidthDip = 640;
static HWND g_qa;                                // the quick-ask window (hidden when not in use)
static ComPtr<ICoreWebView2Controller> g_qaCtl;
static ComPtr<ICoreWebView2> g_qaWeb;
static std::wstring g_qaServer;                  // the server the quick-ask page was made for
static bool g_qaReady = false;                   // the page said it's there
static bool g_qaWantShow = false;                // shown as soon as it's ready
static bool g_qaAcrylic = false;                 // Windows 11's acrylic behind it
static DWORD g_qaShownAt = 0;
static int g_qaHeightDip = 132;
static bool g_qaCreating = false;

struct NowItem {
  std::wstring kind, id, conv, text;  // kind: job | approval
};
struct NowState {
  bool online = false, signedIn = false, demo = false;
  std::wstring name = L"Sara", mood;
  std::vector<NowItem> items;
};
static NowState g_now;
static std::vector<NowItem> g_menuNow;            // what the open tray menu shows (stable ids)
static std::vector<BYTE> g_facePng;               // her face as the page drew it (64 px, round)
static HBITMAP g_faceBmp = nullptr;
static int g_faceBmpSize = 0;

// The shortcut: a few combinations that don't clash with Windows' own (Win+Shift+S is the snipping
// tool, Alt+Space the window menu), or off. Kept in desktop.ini (quickAskShortcut).
struct Shortcut {
  const wchar_t* id;
  const wchar_t* label;
  UINT mods;
  UINT vk;
};
static const Shortcut kShortcuts[] = {
    {L"alt+shift+s", L"Alt+Shift+S", MOD_ALT | MOD_SHIFT, 'S'},
    {L"ctrl+alt+s", L"Ctrl+Alt+S", MOD_CONTROL | MOD_ALT, 'S'},
    {L"ctrl+shift+space", L"Ctrl+Shift+Space", MOD_CONTROL | MOD_SHIFT, VK_SPACE},
    {L"ctrl+alt+space", L"Ctrl+Alt+Space", MOD_CONTROL | MOD_ALT, VK_SPACE},
    {L"alt+shift+a", L"Alt+Shift+A", MOD_ALT | MOD_SHIFT, 'A'},
};
static bool g_shortcutTaken = false;  // another app already uses it (RegisterHotKey failed)
static std::wstring shortcutId() {
  std::wstring id = getPref(L"quickAskShortcut", L"alt+shift+s");
  if (id == L"off") return id;
  for (auto& s : kShortcuts)
    if (id == s.id) return id;
  return L"alt+shift+s";
}
static const Shortcut* currentShortcut() {
  std::wstring id = shortcutId();
  for (auto& s : kShortcuts)
    if (id == s.id) return &s;
  return nullptr;
}
static std::wstring shortcutLabel() {
  const Shortcut* s = currentShortcut();
  return s ? s->label : L"";
}
static void notifyPlain(const std::wstring& title, const std::wstring& body);
/** (Re)registers the shortcut; a clash with another app is said once, in plain words. */
static void registerShortcut(bool tell) {
  if (!g_wnd) return;
  UnregisterHotKey(g_wnd, kHotkeyId);
  g_shortcutTaken = false;
  const Shortcut* s = currentShortcut();
  if (!s) return;
  if (!RegisterHotKey(g_wnd, kHotkeyId, s->mods | MOD_NOREPEAT, s->vk)) {
    g_shortcutTaken = true;
    logLine(std::wstring(L"quick ask: ") + s->label + L" is used by another app (" + std::to_wstring(GetLastError()) + L")");
    if (tell) {
      g_pendingConv.clear();
      notifyPlain(L"Choose another shortcut for Ask Sara", std::wstring(s->label) + L" is already used by another app. Right-click Sara's icon next to the clock → Quick ask shortcut to pick another one.");
    }
  }
}
static bool setShortcut(const std::wstring& id) {
  bool known = id == L"off";
  for (auto& s : kShortcuts) known = known || id == s.id;
  if (!known) return false;
  setPref(L"quickAskShortcut", id);
  registerShortcut(true);
  return true;
}
static std::wstring shortcutsJson() {
  std::wstring out = L"[";
  for (auto& s : kShortcuts) out += std::wstring(out.size() > 1 ? L"," : L"") + L"{\"id\":\"" + s.id + L"\",\"label\":\"" + s.label + L"\"}";
  return out + L",{\"id\":\"off\",\"label\":\"Off\"}]";
}

/** The page, from the program's own resources (UTF-8). */
static std::string quickAskHtml() {
  HRSRC r = FindResourceW(g_inst, MAKEINTRESOURCEW(IDR_QUICKASK), RT_RCDATA);
  HGLOBAL g = r ? LoadResource(g_inst, r) : nullptr;
  const char* p = g ? static_cast<const char*>(LockResource(g)) : nullptr;
  return p ? std::string(p, SizeofResource(g_inst, r)) : std::string("<!doctype html><p>Quick ask is missing from this build.</p>");
}

// ---------- Phase 87: Sara's hands on this computer (src/hands.cpp, docs/design/COMPUTER_USE.md) ----------
// Per server: "Let Sara use this computer" (handsOn), its hands token (DPAPI, this Windows user only),
// the device id and "Screenshots only to models on this computer". Off until the owner switches it on
// in Settings → Computer use (the page gets the token from the server after confirming it's them).
static std::wstring handsSection() { return L"server." + g_profile; }
static bool handsOn() { return !g_profile.empty() && getIni(handsSection(), L"handsOn") == L"1"; }
static std::string pageAgentJs() {
  HRSRC r = FindResourceW(g_inst, MAKEINTRESOURCEW(IDR_PAGEAGENT), RT_RCDATA);
  HGLOBAL g = r ? LoadResource(g_inst, r) : nullptr;
  const char* p = g ? static_cast<const char*>(LockResource(g)) : nullptr;
  std::string s = p ? std::string(p, SizeofResource(g_inst, r)) : std::string();
  while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ' || s.back() == ';')) s.pop_back();
  return s;
}
static std::wstring computerName() {
  wchar_t n[256];
  DWORD len = 256;
  if (GetComputerNameExW(ComputerNamePhysicalDnsHostname, n, &len)) return n;
  return L"this computer";
}
/** Phase 88: Downloads\\Sara (test runs: a folder in their own data folder). */
static std::wstring handsDownloads() {
  std::wstring dir;
  if (testRun()) dir = dataDir() + L"\\hands-downloads";
  else {
    wchar_t* p = nullptr;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Downloads, 0, nullptr, &p))) dir = std::wstring(p) + L"\\Sara";
    CoTaskMemFree(p);
  }
  if (!dir.empty()) CreateDirectoryW(dir.c_str(), nullptr);
  return dir;
}
static std::wstring handsBrowserProfile() {
  std::wstring dir = dataDir() + L"\\hands-browser";
  CreateDirectoryW(dir.c_str(), nullptr);
  return dir + L"\\" + (g_profile.empty() ? L"s1" : g_profile);
}
/** Phase 91: "Lock again after … idle minutes" (5, 15, 30 or 60; 15 by default). */
static int pmRelockMinutes() {
  int n = _wtoi(getIni(handsSection(), L"pmRelockMinutes").c_str());
  return n == 5 || n == 15 || n == 30 || n == 60 ? n : 15;
}
/** Phase 91: the ini key of a password manager's on/off choice. */
static const wchar_t* pmKey(const std::wstring& id) { return id == L"bitwarden" ? L"pmBitwarden" : id == L"1password" ? L"pm1password" : id == L"keepassxc" ? L"pmKeepassxc" : nullptr; }
/** Phase 91: the person picks the KeePassXC database Sara may unlock (the app's own Open window). */
static std::wstring pickKeepassDb() {
  wchar_t file[MAX_PATH] = L"";
  OPENFILENAMEW ofn{sizeof(ofn)};
  ofn.hwndOwner = g_wnd;
  ofn.lpstrFilter = L"KeePass database (*.kdbx)\0*.kdbx\0All files\0*.*\0";
  ofn.lpstrFile = file;
  ofn.nMaxFile = MAX_PATH;
  ofn.lpstrTitle = L"Choose the KeePassXC database Sara may use";
  ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | OFN_HIDEREADONLY;
  return GetOpenFileNameW(&ofn) ? std::wstring(file) : std::wstring();
}
/** Phase 90 (CU4): the saved logins of the Sara browser: %LOCALAPPDATA%\\Sara\\logins.dat (test runs: their own folder). */
static std::wstring loginsFile() { return dataDir() + L"\\logins.dat"; }
/** Phase 92: a multi-line value on one ini line (\n and \\ escaped). */
static std::wstring escapeLines(const std::wstring& v) {
  std::wstring o;
  for (wchar_t c : v) {
    if (c == L'\\') o += L"\\\\";
    else if (c == L'\n') o += L"\\n";
    else if (c != L'\r') o += c;
  }
  return o;
}
static std::wstring unescapeLines(const std::wstring& v) {
  std::wstring o;
  for (size_t i = 0; i < v.size(); i++) {
    if (v[i] == L'\\' && i + 1 < v.size()) {
      o += v[i + 1] == L'n' ? L'\n' : v[i + 1];
      i++;
    } else o += v[i];
  }
  return o;
}
/** Starts or stops the hands for the server in use, as its settings say. */
static void handsSync() {
  if (!handsOn() || g_server.empty()) return sarahands::stop();
  std::string token = sarahands::unprotect(getIni(handsSection(), L"handsToken"));
  if (token.rfind("sara_hands.", 0) != 0) return sarahands::stop();
  sarahands::Host h;
  h.server = g_server;
  h.token = token;
  h.computer = computerName();
  h.profileDir = handsBrowserProfile();
  h.pageAgent = pageAgentJs();
  h.appVersion = std::wstring(L"Sara for Windows ") + kVersion;
  h.localOnly = getIni(handsSection(), L"handsLocalOnly") == L"1";
  // Phase 88: her actions: takeover choice, Downloads\Sara, the local log, token renewal, TEST label.
  h.keepControl = getIni(handsSection(), L"handsTakeover") == L"keep";
  h.desktopLevel = getIni(handsSection(), L"handsDesktopLevel") == L"ask" ? 0 : getIni(handsSection(), L"handsDesktopLevel") == L"always" ? 2 : 1;
  h.walkAway = getIni(handsSection(), L"handsWalkAway") == L"1";
  // Phase 92: "The whole screen" (look only) and the person's own hidden windows.
  h.desktopOn = getIni(handsSection(), L"handsDesktop") == L"1";
  h.blockExtra = toUtf8(unescapeLines(getIni(handsSection(), L"handsBlockExtra")));
  h.downloadsDir = handsDownloads();
  h.logFile = dataDir() + L"\\hands-log.txt";
  h.expiresAt = toUtf8(getIni(handsSection(), L"handsExpires"));
  h.testLabel = testRun();
  // Phase 90: saved logins (DPAPI, this Windows user only) and Windows Hello before each use.
  h.loginsFile = loginsFile();
  h.loginsVerify = getIni(handsSection(), L"loginsVerify") == L"1";
  // Phase 91: the password managers the owner turned on here (after the warning), KeePassXC's database
  // and the idle minutes. Test builds may shorten the idle time for the conformance check.
  h.pmOn[0] = getIni(handsSection(), L"pmBitwarden") == L"1";
  h.pmOn[1] = getIni(handsSection(), L"pm1password") == L"1";
  h.pmOn[2] = getIni(handsSection(), L"pmKeepassxc") == L"1";
  h.keepassDb = getIni(handsSection(), L"pmKeepassDb");
  h.pmRelockMinutes = pmRelockMinutes();
#ifdef SARA_TEST_HOOKS
  {
    wchar_t idle[16];
    if (testRun() && GetEnvironmentVariableW(L"SARA_PM_IDLE_SECONDS", idle, 16) > 0) h.pmIdleSeconds = _wtoi(idle);
  }
#endif
  std::wstring section = handsSection();
  h.onToken = [section](const std::string& tok, const std::string& exp) {
    std::wstring sealed = sarahands::protect(tok);
    if (sealed.empty()) return;
    setIni(section, L"handsToken", sealed);
    setIni(section, L"handsExpires", fromUtf8(exp));
  };
  h.log = [](const std::wstring& line) {
    static std::mutex m;
    std::lock_guard<std::mutex> l(m);
    logLine(line);
  };
  sarahands::start(h);
}
static void handsOff() {
  sarahands::stop();
  for (const wchar_t* k : {L"handsOn", L"handsToken", L"handsId", L"handsExpires"}) setIni(handsSection(), k, L"");
}
static std::wstring handsPrefsJson() {
  return std::wstring(L",\"handsSupported\":true,\"handsOptIn\":") + (handsOn() ? L"true" : L"false") + L",\"handsLocalOnly\":" + (getIni(handsSection(), L"handsLocalOnly") == L"1" ? L"true" : L"false") +
         L",\"handsConnected\":" + (sarahands::connected() ? L"true" : L"false") + L",\"handsDeviceId\":\"" + jsonEscape(getIni(handsSection(), L"handsId")) + L"\",\"handsError\":\"" +
         jsonEscape(sarahands::lastError()) + L"\",\"handsBrowser\":" + (sarahands::browserPath().empty() ? L"false" : L"true") + L",\"computerName\":\"" + jsonEscape(computerName()) + L"\"" +
         L",\"handsDesktopLevel\":\"" + (getIni(handsSection(), L"handsDesktopLevel").empty() ? L"task" : getIni(handsSection(), L"handsDesktopLevel")) + L"\",\"handsTakeover\":\"" + (getIni(handsSection(), L"handsTakeover") == L"keep" ? L"keep" : L"pause") + L"\",\"handsWalkAway\":" + (getIni(handsSection(), L"handsWalkAway") == L"1" ? L"true" : L"false") + L",\"handsHotkey\":\"" + jsonEscape(sarahands::hotkeyLabel()) + L"\"" +
         L",\"loginsSupported\":true,\"loginsVerify\":" + (getIni(handsSection(), L"loginsVerify") == L"1" ? L"true" : L"false") +
         L",\"pmSupported\":true" +
         // Phase 92: the whole screen (Windows needs no extra permission to look, so no handsPerms here).
         L",\"handsDesktopSupported\":true,\"handsDesktop\":" + (getIni(handsSection(), L"handsDesktop") == L"1" ? L"true" : L"false") + L",\"handsBlockExtra\":\"" + jsonEscape(unescapeLines(getIni(handsSection(), L"handsBlockExtra"))) + L"\"";
}

// Her face for the tray menu: the page's PNG, decoded and scaled with WIC (premultiplied alpha).
static std::vector<BYTE> base64Decode(const std::string& b64) {
  DWORD n = 0;
  if (!CryptStringToBinaryA(b64.c_str(), (DWORD)b64.size(), CRYPT_STRING_BASE64, nullptr, &n, nullptr, nullptr) || n == 0 || n > 512 * 1024) return {};
  std::vector<BYTE> out(n);
  if (!CryptStringToBinaryA(b64.c_str(), (DWORD)b64.size(), CRYPT_STRING_BASE64, out.data(), &n, nullptr, nullptr)) return {};
  out.resize(n);
  return out;
}
static HBITMAP bitmapFromPng(const std::vector<BYTE>& png, int size) {
  if (png.empty() || size <= 0) return nullptr;
  ComPtr<IWICImagingFactory> f;
  ComPtr<IWICStream> st;
  ComPtr<IWICBitmapDecoder> dec;
  ComPtr<IWICBitmapFrameDecode> frame;
  ComPtr<IWICBitmapScaler> sc;
  ComPtr<IWICFormatConverter> cv;
  if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&f))) || FAILED(f->CreateStream(&st)) ||
      FAILED(st->InitializeFromMemory(const_cast<BYTE*>(png.data()), (DWORD)png.size())) || FAILED(f->CreateDecoderFromStream(st.Get(), nullptr, WICDecodeMetadataCacheOnLoad, &dec)) ||
      FAILED(dec->GetFrame(0, &frame)) || FAILED(f->CreateBitmapScaler(&sc)) || FAILED(sc->Initialize(frame.Get(), (UINT)size, (UINT)size, WICBitmapInterpolationModeFant)) ||
      FAILED(f->CreateFormatConverter(&cv)) || FAILED(cv->Initialize(sc.Get(), GUID_WICPixelFormat32bppPBGRA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom)))
    return nullptr;
  BITMAPINFO bi{};
  bi.bmiHeader.biSize = sizeof(bi.bmiHeader);
  bi.bmiHeader.biWidth = size;
  bi.bmiHeader.biHeight = -size;  // top-down
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HBITMAP bmp = CreateDIBSection(nullptr, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!bmp) return nullptr;
  if (FAILED(cv->CopyPixels(nullptr, (UINT)size * 4, (UINT)(size * size * 4), static_cast<BYTE*>(bits)))) {
    DeleteObject(bmp);
    return nullptr;
  }
  return bmp;
}
/** Cached per server address (face-<host_port>.png), so the menu shows her face from the first click after a start. */
static std::wstring faceCachePath() {
  std::wstring host;
  for (wchar_t c : hostOfUrl(g_server)) host += iswalnum(c) || c == L'.' || c == L'-' ? c : L'_';
  return dataDir() + L"\\face-" + (host.empty() ? L"none" : host.substr(0, 100)) + L".png";
}
static void loadCachedFace() {
  g_facePng.clear();
  if (g_faceBmp) DeleteObject(g_faceBmp);
  g_faceBmp = nullptr;
  FILE* f = nullptr;
  if (_wfopen_s(&f, faceCachePath().c_str(), L"rb") != 0 || !f) return;
  BYTE buf[8192];
  size_t n;
  while ((n = fread(buf, 1, sizeof(buf), f)) > 0 && g_facePng.size() < 512 * 1024) g_facePng.insert(g_facePng.end(), buf, buf + n);
  fclose(f);
}
static HBITMAP faceBitmap() {
  int size = MulDiv(28, (int)(g_wnd ? GetDpiForWindow(g_wnd) : 96), 96);
  if (g_faceBmp && g_faceBmpSize == size) return g_faceBmp;
  if (g_faceBmp) DeleteObject(g_faceBmp);
  g_faceBmp = bitmapFromPng(g_facePng, size);
  g_faceBmpSize = size;
  return g_faceBmp;
}

/** The tray tooltip: "Sara · relaxed" (+ approvals waiting, + which Sara when there are several). */
static void updateTrayTip() {
  std::wstring tip = g_now.name.empty() ? L"Sara" : g_now.name;
  if (!g_now.mood.empty()) tip += L" · " + g_now.mood;
  size_t waiting = 0;
  for (auto& i : g_now.items) waiting += i.kind == L"approval";
  if (waiting) tip += L" · " + std::to_wstring(waiting) + L" waiting for your OK";
  if (profiles().size() > 1 && !g_profile.empty()) tip += L"\n" + loadProfile(g_profile).name;
#ifdef SARA_TEST_HOOKS
  if (tip != g_tray.szTip) logLine(L"tray tooltip: " + tip);  // test builds: the tooltip can't be read from outside
#endif
  wcsncpy_s(g_tray.szTip, tip.c_str(), _TRUNCATE);
  if (g_tray.hWnd) {
    g_tray.uFlags = NIF_TIP;
    Shell_NotifyIconW(NIM_MODIFY, &g_tray);
  }
}

static void postSwitch(const std::wstring& id, const std::wstring& path);
static void notifyApprovals(const std::wstring& lines);
static void notifyReminder(std::map<std::wstring, std::wstring>& m);
static void runToastQueue();
/** {a:'state', …} from the quick-ask page: who she is, her mood and face, and "Now". */
static void takeNow(std::map<std::wstring, std::wstring>& m) {
  NowState n;
  n.online = m[L"online"] == L"true";
  n.signedIn = m[L"signedIn"] == L"true";
  n.demo = m[L"demo"] == L"true";
  if (!m[L"name"].empty()) n.name = m[L"name"].substr(0, 60);
  n.mood = m[L"mood"].substr(0, 40);
  if (!n.online) {
    // Offline for a moment: keep what we knew, say nothing new.
    g_now.online = false;
    return;
  }
  std::wstring lines = m[L"now"];
  size_t start = 0;
  while (start < lines.size() && n.items.size() < kNowMax) {
    size_t end = lines.find(L'\n', start);
    std::wstring line = lines.substr(start, end == std::wstring::npos ? std::wstring::npos : end - start);
    start = end == std::wstring::npos ? lines.size() : end + 1;
    std::vector<std::wstring> f;
    size_t a = 0;
    for (size_t b; (b = line.find(L'\t', a)) != std::wstring::npos; a = b + 1) f.push_back(line.substr(a, b - a));
    f.push_back(line.substr(a));
    if (f.size() == 4 && (f[0] == L"job" || f[0] == L"approval")) n.items.push_back({f[0], f[1], f[2], f[3]});
  }
  std::wstring face = m[L"face"];
  const std::wstring prefix = L"data:image/png;base64,";
  if (face.rfind(prefix, 0) == 0) {
    auto png = base64Decode(toUtf8(face.substr(prefix.size())));
    if (png.size() > 8 && png[1] == 'P' && png[2] == 'N' && png[3] == 'G') {
      g_facePng = png;
      if (g_faceBmp) DeleteObject(g_faceBmp);
      g_faceBmp = nullptr;
      FILE* f = nullptr;
      if (_wfopen_s(&f, faceCachePath().c_str(), L"wb") == 0 && f) {
        fwrite(png.data(), 1, png.size(), f);
        fclose(f);
      }
    }
  }
  g_now = n;
  updateTrayTip();
  // Phase 75 stage 3: approvals waiting → a toast with Allow / Deny (once each); decided ones go away.
  notifyApprovals(n.signedIn && !n.demo ? m[L"asks"] : L"");
  // While a turn runs (an approval can come any moment) ask every 5 s, else every 45 s: the hidden
  // quick-ask page's own timers are slowed down by the web view.
  bool busy = m[L"busy"] == L"true";
  static bool wasBusy = false;
  if (g_wnd && busy != wasBusy) SetTimer(g_wnd, kNowTimer, busy ? 5000 : 45000, nullptr);
  wasBusy = busy;
}

static void layoutQuickAsk() {
  if (!g_qa || !g_qaCtl) return;
  RECT rc;
  GetClientRect(g_qa, &rc);
  g_qaCtl->put_Bounds(rc);
}
/** Frosted where Windows 11 can (acrylic: DWMSBT_TRANSIENTWINDOW), rounded corners, theme colours. */
static void styleQuickAsk() {
  if (!g_qa) return;
  BOOL dark = g_day ? FALSE : TRUE;
  if (FAILED(DwmSetWindowAttribute(g_qa, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof(dark)))) DwmSetWindowAttribute(g_qa, 19, &dark, sizeof(dark));
  DWM_WINDOW_CORNER_PREFERENCE corner = DWMWCP_ROUND;
  DwmSetWindowAttribute(g_qa, DWMWA_WINDOW_CORNER_PREFERENCE, &corner, sizeof(corner));
  g_qaAcrylic = false;
  if (windowsBuild() >= 22621) {
    MARGINS m{-1, -1, -1, -1};
    DwmExtendFrameIntoClientArea(g_qa, &m);
    DWM_SYSTEMBACKDROP_TYPE type = DWMSBT_TRANSIENTWINDOW;
    g_qaAcrylic = SUCCEEDED(DwmSetWindowAttribute(g_qa, DWMWA_SYSTEMBACKDROP_TYPE, &type, sizeof(type)));
  }
  ComPtr<ICoreWebView2Controller2> c2;
  COLORREF c = themeColor();
  if (g_qaCtl && SUCCEEDED(g_qaCtl.As(&c2))) c2->put_DefaultBackgroundColor({(BYTE)(g_qaAcrylic ? 0 : 255), GetRValue(c), GetGValue(c), GetBValue(c)});
  InvalidateRect(g_qa, nullptr, TRUE);
}
static void saveQuickPlace() {
  if (!g_qa || !IsWindowVisible(g_qa)) return;
  RECT r;
  GetWindowRect(g_qa, &r);
  setPref(L"quickAskPlace", std::to_wstring(r.left) + L"," + std::to_wstring(r.top));
}
/** Where it was last time (if that's still on a screen), else centred near the top of the screen
 *  the mouse is on. */
static void placeQuickAsk() {
  POINT cur;
  GetCursorPos(&cur);
  HMONITOR mon = MonitorFromPoint(cur, MONITOR_DEFAULTTONEAREST);
  UINT dpiX = 96, dpiY = 96;
  using GetDpiForMonitorFn = HRESULT(WINAPI*)(HMONITOR, int, UINT*, UINT*);
  if (HMODULE shcore = LoadLibraryW(L"shcore.dll")) {
    if (auto fn = reinterpret_cast<GetDpiForMonitorFn>(reinterpret_cast<void*>(GetProcAddress(shcore, "GetDpiForMonitor")))) fn(mon, 0, &dpiX, &dpiY);
    FreeLibrary(shcore);
  }
  int w = MulDiv(kQuickWidthDip, (int)dpiX, 96), h = MulDiv(g_qaHeightDip, (int)dpiX, 96);
  int x = 0, y = 0;
  std::wstring place = getPref(L"quickAskPlace");
  if (swscanf_s(place.c_str(), L"%d,%d", &x, &y) == 2 && MonitorFromPoint(POINT{x + 40, y + 20}, MONITOR_DEFAULTTONULL)) {
    SetWindowPos(g_qa, HWND_TOPMOST, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
    // The size follows the DPI of the screen it is on (WM_DPICHANGED may not come for a hidden window).
    UINT dpi = GetDpiForWindow(g_qa);
    SetWindowPos(g_qa, HWND_TOPMOST, 0, 0, MulDiv(kQuickWidthDip, (int)dpi, 96), MulDiv(g_qaHeightDip, (int)dpi, 96), SWP_NOMOVE | SWP_NOACTIVATE);
    return;
  }
  MONITORINFO mi{sizeof(mi)};
  GetMonitorInfoW(mon, &mi);
  RECT wa = mi.rcWork;
  x = wa.left + (wa.right - wa.left - w) / 2;
  y = wa.top + (wa.bottom - wa.top) / 6;
  SetWindowPos(g_qa, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE);
}
static bool quickAskVisible() { return g_qa && IsWindowVisible(g_qa); }
static void hideQuickAsk() {
  if (!quickAskVisible()) return;
  saveQuickPlace();
  ShowWindow(g_qa, SW_HIDE);
  if (g_qaWeb) g_qaWeb->ExecuteScript(L"window.saraQuick&&saraQuick.hidden()", nullptr);
}
static void ensureQuickAsk();
/** The shortcut (or the tray's "Ask Sara…"): show it over whatever is in front, typing ready. */
static void showQuickAsk() {
  if (g_server.empty()) return showWindow();  // nothing to ask yet: the window sets her up
  ensureQuickAsk();
  if (!g_qaReady || !g_qaWeb) {
    g_qaWantShow = true;
    return;
  }
  g_qaWantShow = false;
  placeQuickAsk();
  styleQuickAsk();
  g_qaShownAt = GetTickCount();
  ShowWindow(g_qa, SW_SHOW);
  SetWindowPos(g_qa, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
  SetForegroundWindow(g_qa);
  g_qaCtl->put_IsVisible(TRUE);
  g_qaCtl->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
  std::wstring js = std::wstring(L"window.saraQuick&&saraQuick.show({theme:'") + (g_day ? L"day" : L"night") + L"',solid:" + (g_qaAcrylic ? L"false" : L"true") +
                    L",shortcut:'" + jsonEscape(shortcutLabel()) + L"'})";
  g_qaWeb->ExecuteScript(js.c_str(), nullptr);
}
static void toggleQuickAsk() {
  if (quickAskVisible() && GetForegroundWindow() == g_qa) hideQuickAsk();
  else showQuickAsk();
}
/** Asks the page to fetch "Now", her mood and face again (the timer, the tray menu, a decision). */
static void refreshNow() {
  if (g_qaReady && g_qaWeb) g_qaWeb->ExecuteScript(L"window.saraQuick&&saraQuick.refresh()", nullptr);
}
/** Allow / Deny from the tray menu: the same route the approval card in the chat uses. */
static void decideFromTray(const std::wstring& approvalId, bool ok) {
  if (!g_qaReady || !g_qaWeb || approvalId.empty()) return;
  g_qaWeb->ExecuteScript((L"window.saraQuick&&saraQuick.decide(\"" + jsonEscape(approvalId) + L"\"," + (ok ? L"true" : L"false") + L")").c_str(), nullptr);
}
static void openConversation(const std::wstring& conv);

static void onQuickMessage(const std::wstring& json, const std::wstring& source) {
  // Only the quick-ask page this app served for the server in use.
  if (g_qaServer.empty() || g_qaServer != g_server || source.rfind(g_qaServer + kQuickPath, 0) != 0) return;
  auto m = parseFlatJson(json);
  if (m[L"m"] != L"qa") return;
  const std::wstring& a = m[L"a"];
  if (a == L"ready") {
    g_qaReady = true;
    if (g_qaWantShow) showQuickAsk();
    runToastQueue();  // a toast's Allow / Snooze that came before the page was there
  } else if (a == L"hide") {
    hideQuickAsk();
  } else if (a == L"size") {
    int h = std::max(96, std::min(560, _wtoi(m[L"h"].c_str())));
    if (h == g_qaHeightDip) return;
    g_qaHeightDip = h;
    if (!g_qa) return;
    UINT dpi = GetDpiForWindow(g_qa);
    RECT r;
    GetWindowRect(g_qa, &r);
    SetWindowPos(g_qa, nullptr, 0, 0, r.right - r.left, MulDiv(h, (int)dpi, 96), SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
  } else if (a == L"open") {
    // "Open in Sara": the conversation continues in the main window.
    hideQuickAsk();
    showWindow();
    openConversation(m[L"conv"]);
  } else if (a == L"state") {
    takeNow(m);
  } else if (a == L"reminder") {
    notifyReminder(m);  // Phase 75 stage 3: a reminder went off (the page's /api/events)
  }
}

static LRESULT CALLBACK QuickProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_NCCALCSIZE:
      if (wp) return 0;  // no frame: the page draws everything (DWM keeps the shadow and corners)
      break;
    case WM_ACTIVATE:
      // Clicking anywhere else hides it (not in the first moment after showing).
      if (LOWORD(wp) == WA_INACTIVE && GetTickCount() - g_qaShownAt > 400) hideQuickAsk();
      break;
    case WM_EXITSIZEMOVE:
      saveQuickPlace();
      break;
    case WM_SIZE:
      layoutQuickAsk();
      return 0;
    case WM_DPICHANGED: {
      const RECT* r = reinterpret_cast<const RECT*>(lp);
      SetWindowPos(h, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
      return 0;
    }
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT: {
      PAINTSTRUCT ps;
      HDC dc = BeginPaint(h, &ps);
      HBRUSH b = g_qaAcrylic ? (HBRUSH)GetStockObject(BLACK_BRUSH) : CreateSolidBrush(themeColor());
      FillRect(dc, &ps.rcPaint, b);
      if (!g_qaAcrylic) DeleteObject(b);
      EndPaint(h, &ps);
      return 0;
    }
    case WM_CLOSE:
      hideQuickAsk();
      return 0;
  }
  return DefWindowProcW(h, msg, wp, lp);
}

static void closeQuickAskWebView() {
  g_qaReady = false;
  g_qaServer.clear();
  if (g_qaCtl) g_qaCtl->Close();
  g_qaCtl.Reset();
  g_qaWeb.Reset();
}

/** Answers <server>/__sara_desktop/quick-ask with the page from the program's resources; nothing
 *  for that address ever reaches the server. (The quick-ask view bypasses the server's service
 *  worker, which would otherwise forward the navigation with its own fetch: see ensureQuickAsk.) */
static void serveQuickAskFrom(ICoreWebView2* web) {
  if (!web || g_server.empty()) return;
  std::wstring filter = g_server + kQuickPath + L"*";
  ComPtr<ICoreWebView2> w(web);
  ComPtr<ICoreWebView2_22> w22;
  if (SUCCEEDED(w.As(&w22))) w22->AddWebResourceRequestedFilterWithRequestSourceKinds(filter.c_str(), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL);
  else web->AddWebResourceRequestedFilter(filter.c_str(), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
  web->add_WebResourceRequested(Callback<ICoreWebView2WebResourceRequestedEventHandler>([](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* a) -> HRESULT {
    ComPtr<ICoreWebView2WebResourceRequest> req;
    a->get_Request(&req);
    LPWSTR uri = nullptr;
    req->get_Uri(&uri);
    std::wstring u = uri ? uri : L"";
    CoTaskMemFree(uri);
    if (g_server.empty() || u.rfind(g_server + kQuickPath, 0) != 0) return S_OK;
    std::string html = quickAskHtml();
    ComPtr<IStream> body;
    body.Attach(SHCreateMemStream(reinterpret_cast<const BYTE*>(html.data()), (UINT)html.size()));
    ComPtr<ICoreWebView2WebResourceResponse> resp;
    // Its own rules: scripts and styles only from itself, requests only to this server.
    if (g_env && SUCCEEDED(g_env->CreateWebResourceResponse(body.Get(), 200, L"OK",
                                                             L"Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\n"
                                                             L"Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'",
                                                             &resp)))
      a->put_Response(resp.Get());
    return S_OK;
  }).Get(), nullptr);
}

/** The quick-ask window (once) and its web view for the server in use (again after a switch). */
static void ensureQuickAsk() {
  if (!g_qa) {
    WNDCLASSEXW wc{sizeof(wc)};
    wc.lpfnWndProc = QuickProc;
    wc.hInstance = g_inst;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.lpszClassName = kQuickClass;
    RegisterClassExW(&wc);
    // A tool window (no taskbar button), above other apps; WS_THICKFRAME for DWM's shadow and acrylic.
    g_qa = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, kQuickClass, L"Ask Sara", WS_POPUP | WS_THICKFRAME, 0, 0, MulDiv(kQuickWidthDip, (int)windowDpi(), 96),
                           MulDiv(g_qaHeightDip, (int)windowDpi(), 96), nullptr, nullptr, g_inst, nullptr);
    styleQuickAsk();
  }
  if (g_server.empty() || !g_env) return;
  if (g_qaCtl && g_qaServer == g_server) return;
  if (g_qaCreating) return;
  closeQuickAskWebView();
  g_qaCreating = true;
  std::wstring server = g_server;
  auto done = Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([server](HRESULT r, ICoreWebView2Controller* ctl) -> HRESULT {
    g_qaCreating = false;
    if (FAILED(r) || !ctl) {
      logLine(L"quick ask: no web view (" + std::to_wstring(r) + L")");
      return S_OK;
    }
    if (server != g_server) {  // switched meanwhile: make it for the new one
      ctl->Close();
      ensureQuickAsk();
      return S_OK;
    }
    g_qaCtl = ctl;
    g_qaCtl->get_CoreWebView2(&g_qaWeb);
    g_qaServer = server;
    styleQuickAsk();
    layoutQuickAsk();
    ComPtr<ICoreWebView2Settings> settings;
    g_qaWeb->get_Settings(&settings);
    settings->put_AreDevToolsEnabled(FALSE);
    settings->put_IsStatusBarEnabled(FALSE);
    settings->put_AreDefaultContextMenusEnabled(TRUE);
    settings->put_IsZoomControlEnabled(FALSE);
    ComPtr<ICoreWebView2Settings9> s9;
    if (SUCCEEDED(settings.As(&s9))) s9->put_IsNonClientRegionSupportEnabled(TRUE);  // the header moves the window
    ComPtr<ICoreWebView2Settings2> s2;
    if (SUCCEEDED(settings.As(&s2))) {
      LPWSTR ua = nullptr;
      s2->get_UserAgent(&ua);
      std::wstring full = std::wstring(ua ? ua : L"") + L" SaraDesktop/1 (Windows)";
      CoTaskMemFree(ua);
      s2->put_UserAgent(full.c_str());
    }
    // The page itself: answered here, never fetched from the server.
    std::wstring page = g_qaServer + kQuickPath;
    serveQuickAskFrom(g_qaWeb.Get());
    // Nothing else opens in it: links go to the browser.
    g_qaWeb->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>([](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* a) -> HRESULT {
      LPWSTR uri = nullptr;
      a->get_Uri(&uri);
      std::wstring u = uri ? uri : L"";
      CoTaskMemFree(uri);
      if ((!g_qaServer.empty() && u.rfind(g_qaServer + kQuickPath, 0) == 0) || u == L"about:blank") return S_OK;
      a->put_Cancel(TRUE);
      if (u.rfind(L"http", 0) == 0) ShellExecuteW(nullptr, L"open", u.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
      return S_OK;
    }).Get(), nullptr);
    g_qaWeb->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>([](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* a) -> HRESULT {
      a->put_Handled(TRUE);
      return S_OK;
    }).Get(), nullptr);
    // Only ever the quick-ask page: anything else that loads here (it never should) is closed at once.
    g_qaWeb->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>([](ICoreWebView2* w, ICoreWebView2NavigationCompletedEventArgs*) -> HRESULT {
      LPWSTR src = nullptr;
      w->get_Source(&src);
      bool blank = src && wcscmp(src, L"about:blank") == 0;
      CoTaskMemFree(src);
      if (blank) return S_OK;
      w->ExecuteScript(L"typeof window.saraQuick === 'object' && document.title === 'Ask Sara'", Callback<ICoreWebView2ExecuteScriptCompletedHandler>([](HRESULT, LPCWSTR result) -> HRESULT {
        if (result && wcscmp(result, L"true") != 0 && g_qaWeb) {
          logLine(L"quick ask: the page that loaded wasn't the quick-ask page; closed it");
          g_qaReady = false;
          g_qaWeb->Navigate(L"about:blank");
        }
        return S_OK;
      }).Get());
      return S_OK;
    }).Get(), nullptr);
    // Phase 75 stage 3: the microphone for talking instead of typing (its own page only); nothing else.
    g_qaWeb->add_PermissionRequested(Callback<ICoreWebView2PermissionRequestedEventHandler>([](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* a) -> HRESULT {
      LPWSTR uri = nullptr;
      a->get_Uri(&uri);
      std::wstring u = uri ? uri : L"";
      CoTaskMemFree(uri);
      COREWEBVIEW2_PERMISSION_KIND k;
      a->get_PermissionKind(&k);
      bool mic = k == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE && !g_qaServer.empty() && u.rfind(g_qaServer + kQuickPath, 0) == 0;
      a->put_State(mic ? COREWEBVIEW2_PERMISSION_STATE_ALLOW : COREWEBVIEW2_PERMISSION_STATE_DENY);
      return S_OK;
    }).Get(), nullptr);
    g_qaWeb->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>([](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* a) -> HRESULT {
      LPWSTR json = nullptr, src = nullptr;
      a->get_WebMessageAsJson(&json);
      a->get_Source(&src);
      std::wstring j = json ? json : L"", s = src ? src : L"";
      CoTaskMemFree(json);
      CoTaskMemFree(src);
      onQuickMessage(j, s);
      return S_OK;
    }).Get(), nullptr);
    // Escape hides it even when the page has no focus.
    g_qaCtl->add_AcceleratorKeyPressed(Callback<ICoreWebView2AcceleratorKeyPressedEventHandler>([](ICoreWebView2Controller*, ICoreWebView2AcceleratorKeyPressedEventArgs* a) -> HRESULT {
      COREWEBVIEW2_KEY_EVENT_KIND kind;
      UINT key = 0;
      a->get_KeyEventKind(&kind);
      a->get_VirtualKey(&key);
      if (key == VK_ESCAPE && kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN) {
        a->put_Handled(TRUE);
        PostMessageW(g_qa, WM_CLOSE, 0, 0);
      }
      return S_OK;
    }).Get(), nullptr);
    // web/sw.js answers every navigation on her address with its own fetch, which WebView2 doesn't
    // hand to WebResourceRequested: this view (only this one) bypasses service workers, then opens
    // the page. The main window keeps the worker (its offline page).
    std::wstring target = page;
    auto go = [target](HRESULT r2, LPCWSTR) -> HRESULT {
      if (FAILED(r2)) logLine(L"quick ask: couldn't bypass the service worker (" + std::to_wstring(r2) + L")");
      if (g_qaWeb) g_qaWeb->Navigate(target.c_str());
      return S_OK;
    };
    // (setBypassServiceWorker only takes effect with the Network domain on.)
    HRESULT hr = g_qaWeb->CallDevToolsProtocolMethod(L"Network.enable", L"{}", Callback<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler>([go](HRESULT, LPCWSTR) -> HRESULT {
                                                       if (!g_qaWeb || FAILED(g_qaWeb->CallDevToolsProtocolMethod(L"Network.setBypassServiceWorker", L"{\"bypass\":true}",
                                                                                                                 Callback<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler>(go).Get())))
                                                         go(E_FAIL, nullptr);
                                                       return S_OK;
                                                     }).Get());
    if (FAILED(hr)) g_qaWeb->Navigate(page.c_str());
    return S_OK;
  });
  // The same profile as the main window for this server, so it has the same sign-in.
  ComPtr<ICoreWebView2Environment10> env10;
  if (!g_profile.empty() && g_profile != L"s1" && SUCCEEDED(g_env.As(&env10))) {
    ComPtr<ICoreWebView2ControllerOptions> opts;
    if (SUCCEEDED(env10->CreateCoreWebView2ControllerOptions(&opts))) {
      opts->put_ProfileName((L"sara-" + g_profile).c_str());
      env10->CreateCoreWebView2ControllerWithOptions(g_qa, opts.Get(), done.Get());
      return;
    }
  }
  g_env->CreateCoreWebView2Controller(g_qa, done.Get());
}

// ---------- Phase 75 stage 3: native notifications (toasts with buttons) ----------
// What shows a toast, and the rule against two notifications for one event:
//   - approvals waiting (the quick-ask page's "Now", asked every 45 s, every few seconds while a turn
//     runs, and on /api/events): one toast each, with what she wants to run (summary + command) and
//     Allow / Deny / Open in Sara. Only while the window isn't in front (the card is there) and the
//     quick-ask window isn't either. Decided anywhere else: the toast goes away. The web app never
//     notifies for approvals, so there is nothing to replace.
//   - reminders going off (the quick-ask page's /api/events 'message' with reason 'reminder'): a
//     toast with Done / Snooze 10 min. The page in the main window also says the same reminder
//     through SaraDesktop.notify(); both carry the same tag (her conversation + the text), so the
//     one with the buttons replaces the page's, and the page's is dropped when ours came first.
//   - everything the page says through SaraDesktop.notify() (messages, calls, sign-in requests) and
//     any web Notification it shows (WebView2 NotificationReceived): a plain toast that opens that
//     conversation. The old tray balloon is the fallback when toasts don't work here.
// Off with the page's Settings → This computer → Notifications switch, signed out, and on the demo.
// A button press is only ever acted on for an approval this app showed, for the server in use, that
// is still waiting: Allow then calls the same route as the tray's Allow and the chat's card. Anything
// else (a click after a restart, another server's) opens the conversation so the owner decides there.
static bool g_toastOk = false;                                   // toasts work on this PC
static std::wstring g_toastProfile;                              // the server the approval toasts are for
static std::map<std::wstring, std::wstring> g_toastApprovals;    // approval id → its toast's tag
struct ToastReminder {
  std::wstring rid, conv, text;
  DWORD at = 0;
};
static std::map<std::wstring, ToastReminder> g_toastReminders;   // tag → a reminder we showed
static std::map<std::wstring, DWORD> g_pageToasts;               // tag → when the page's own notify showed it
static std::vector<std::wstring> g_toastQueue;                   // clicks waiting for the window / the page
static const DWORD kSameEventMs = 5 * 60 * 1000;

/** Ids from the server go into toast arguments as they are only if they're plain. */
static std::wstring plainId(const std::wstring& s, size_t max = 80) {
  std::wstring o;
  for (wchar_t c : s.substr(0, max))
    if (iswalnum(c) || c == L'-' || c == L'_') o += c;
  return o;
}
static std::wstring clip(const std::wstring& s, size_t n) { return s.size() <= n ? s : s.substr(0, n - 1) + L"…"; }
/** A short stable tag (toasts allow 64 characters): FNV-1a 64 of the key. */
static std::wstring toastTag(const wchar_t* prefix, const std::wstring& key) {
  unsigned long long h = 1469598103934665603ULL;
  for (wchar_t c : key) {
    h ^= (unsigned long long)c;
    h *= 1099511628211ULL;
  }
  wchar_t b[24];
  swprintf(b, 24, L"%016llx", h);
  return prefix + std::wstring(b);
}
/** The same event from the page and from us: her conversation and the text. */
static std::wstring messageTag(const std::wstring& conv, const std::wstring& body) { return toastTag(L"m", conv + L"\n" + body.substr(0, 500)); }
static void forgetOld(std::map<std::wstring, DWORD>& m) {
  for (auto it = m.begin(); it != m.end();) it = GetTickCount() - it->second > kSameEventMs ? m.erase(it) : std::next(it);
}

/** Her icon as a PNG for the toast (written once, next to the settings). */
static std::wstring toastIconPath() {
  std::wstring path = dataDir() + L"\\toast-icon.png";
  if (fileExists(path)) return path;
  HICON icon = (HICON)LoadImageW(g_inst, MAKEINTRESOURCEW(IDI_SARA), IMAGE_ICON, 256, 256, 0);
  ComPtr<IWICImagingFactory> f;
  ComPtr<IWICBitmap> bmp;
  ComPtr<IWICStream> st;
  ComPtr<IWICBitmapEncoder> enc;
  ComPtr<IWICBitmapFrameEncode> frame;
  bool ok = icon && SUCCEEDED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&f))) && SUCCEEDED(f->CreateBitmapFromHICON(icon, &bmp)) &&
            SUCCEEDED(f->CreateStream(&st)) && SUCCEEDED(st->InitializeFromFilename(path.c_str(), GENERIC_WRITE)) && SUCCEEDED(f->CreateEncoder(GUID_ContainerFormatPng, nullptr, &enc)) &&
            SUCCEEDED(enc->Initialize(st.Get(), WICBitmapEncoderNoCache)) && SUCCEEDED(enc->CreateNewFrame(&frame, nullptr)) && SUCCEEDED(frame->Initialize(nullptr)) &&
            SUCCEEDED(frame->WriteSource(bmp.Get(), nullptr)) && SUCCEEDED(frame->Commit()) && SUCCEEDED(enc->Commit());
  if (icon) DestroyIcon(icon);
  if (!ok) {
    st.Reset();
    DeleteFileW(path.c_str());
    return L"";
  }
  return path;
}

/** Once at start: who she is to Windows, her toast registration and the activator for clicks. */
static void initToasts() {
  saratoast::registerApp(aumid(), toastClsidText(), testRun() ? L"Sara (test)" : L"Sara", toastIconPath(), exePath());
  saratoast::state().onActivate = [](const std::wstring& who, const std::wstring& args) {
    if (!who.empty() && _wcsicmp(who.c_str(), aumid()) != 0) return;
    if (g_toastQueue.size() < 20) g_toastQueue.push_back(args.substr(0, 2048));
    if (g_wnd) PostMessageW(g_wnd, WM_APP_TOAST, 0, 0);
  };
  if (!saratoast::registerActivator(toastClsid())) logLine(L"toasts: couldn't take clicks on them");
  g_toastOk = saratoast::init(aumid());
  if (!g_toastOk) logLine(L"toasts: not available here; using the tray balloon");
  stampShortcuts();
}

/** Notifications are on, and the owner isn't already looking at Sara. */
static bool notifyNow() { return prefOn(L"notifications", true) && !windowInFront() && !(quickAskVisible() && GetForegroundWindow() == g_qa); }

/** A plain toast (title, text) that opens that conversation; the tray balloon if toasts don't work. */
static bool toastMessage(const std::wstring& title, const std::wstring& body, const std::wstring& conv, const std::wstring& tag, const std::wstring& group) {
  if (g_toastOk) {
    std::wstring launch = L"a=open&p=" + plainId(g_profile) + L"&c=" + plainId(conv, 64);
    std::wstring x = L"<toast launch=\"" + saratoast::xml(launch) + L"\"><visual><binding template=\"ToastGeneric\"><text>" + saratoast::xml(clip(title, 120)) + L"</text><text>" +
                     saratoast::xml(clip(body, 400)) + L"</text></binding></visual></toast>";
    if (saratoast::show(x, tag, group)) return true;
  }
  g_pendingConv = conv;
  trayBalloon(title, body);
  return false;
}
/** The app's own messages ("Sara is still here", a shortcut clash). */
static void notifyPlain(const std::wstring& title, const std::wstring& body) { toastMessage(title, body, L"", toastTag(L"p", title), L"app"); }

/** SaraDesktop.notify() and web notifications from the page: one toast each (see above). */
static void notifyFromPage(const std::wstring& title, const std::wstring& body, const std::wstring& conv) {
  if (!prefOn(L"notifications", true) || windowInFront()) return;
  std::wstring tag = messageTag(plainId(conv, 64), body);
  auto r = g_toastReminders.find(tag);
  if (r != g_toastReminders.end() && GetTickCount() - r->second.at < kSameEventMs) return;  // ours (with Done / Snooze) is there
  forgetOld(g_pageToasts);
  g_pageToasts[tag] = GetTickCount();
  toastMessage(title, body, conv, tag, L"msg");
}

/** Approvals waiting ("id\tconv\tsummary\tcommand" lines from the page): a toast for each new one,
 *  and the toasts of the ones no longer waiting removed. */
static void notifyApprovals(const std::wstring& lines) {
  if (g_toastProfile != g_profile) {
    for (auto& t : g_toastApprovals) saratoast::remove(t.second, L"approval");
    g_toastApprovals.clear();
    g_toastProfile = g_profile;
  }
  std::set<std::wstring> waiting;
  size_t start = 0;
  while (start < lines.size() && waiting.size() < kNowMax) {
    size_t end = lines.find(L'\n', start);
    std::wstring line = lines.substr(start, end == std::wstring::npos ? std::wstring::npos : end - start);
    start = end == std::wstring::npos ? lines.size() : end + 1;
    std::vector<std::wstring> f;
    size_t a = 0;
    for (size_t b; (b = line.find(L'\t', a)) != std::wstring::npos; a = b + 1) f.push_back(line.substr(a, b - a));
    f.push_back(line.substr(a));
    if (f.size() != 4) continue;
    std::wstring id = plainId(f[0]), conv = plainId(f[1], 64);
    if (id.empty() || id != f[0]) continue;
    waiting.insert(id);
    if (g_toastApprovals.count(id) || !notifyNow()) continue;
    std::wstring tag = toastTag(L"a", id);
    std::wstring who = g_now.name.empty() ? L"Sara" : g_now.name;
    std::wstring base = L"&id=" + id + L"&p=" + plainId(g_profile) + L"&c=" + conv;
    // What she wants to do and the command itself, so an Allow from here is an informed OK.
    std::wstring x = L"<toast launch=\"" + saratoast::xml(L"a=open" + base) + L"\"><visual><binding template=\"ToastGeneric\"><text>" + saratoast::xml(clip(who, 60) + L" wants your OK") +
                     L"</text><text>" + saratoast::xml(clip(f[2], 160)) + L"</text>" + (f[3].empty() ? L"" : L"<text>" + saratoast::xml(clip(f[3], 300)) + L"</text>") +
                     L"<text placement=\"attribution\">Allow only if you expected this</text></binding></visual><actions>"
                     L"<action content=\"Allow\" arguments=\"" + saratoast::xml(L"a=allow" + base) + L"\" activationType=\"background\"/>"
                     L"<action content=\"Deny\" arguments=\"" + saratoast::xml(L"a=deny" + base) + L"\" activationType=\"background\"/>"
                     L"<action content=\"Open in Sara\" arguments=\"" + saratoast::xml(L"a=open" + base) + L"\" activationType=\"foreground\"/></actions></toast>";
    if (g_toastOk && saratoast::show(x, tag, L"approval")) g_toastApprovals[id] = tag;
    else if (!g_toastOk) {
      // No toasts here: one balloon (no buttons); the tray menu's "Now" has Allow / Deny.
      g_toastApprovals[id] = L"";
      g_pendingConv = conv;
      trayBalloon(clip(who, 60) + L" wants your OK", clip(f[2], 120) + L". Right-click her icon → Now to allow or deny.");
    }
  }
  for (auto it = g_toastApprovals.begin(); it != g_toastApprovals.end();) {
    if (waiting.count(it->first)) {
      ++it;
      continue;
    }
    saratoast::remove(it->second, L"approval");
    it = g_toastApprovals.erase(it);
  }
}

/** {a:'reminder', conv, rid, text} from the quick-ask page: a toast with Done / Snooze 10 min. */
static void notifyReminder(std::map<std::wstring, std::wstring>& m) {
  if (!g_now.signedIn || g_now.demo || !notifyNow()) return;
  std::wstring conv = plainId(m[L"conv"], 64), rid = plainId(m[L"rid"], 20), text = m[L"text"].substr(0, 2000);
  if (text.empty()) return;
  std::wstring tag = messageTag(conv, text);
  for (auto it = g_toastReminders.begin(); it != g_toastReminders.end();) it = GetTickCount() - it->second.at > 60 * 60 * 1000 ? g_toastReminders.erase(it) : std::next(it);
  g_toastReminders[tag] = ToastReminder{rid, conv, text, GetTickCount()};
  std::wstring base = L"&t=" + tag + L"&r=" + rid + L"&p=" + plainId(g_profile) + L"&c=" + conv;
  std::wstring x = L"<toast scenario=\"reminder\" launch=\"" + saratoast::xml(L"a=open" + base) + L"\"><visual><binding template=\"ToastGeneric\"><text>Reminder</text><text>" +
                   saratoast::xml(clip(text, 400)) + L"</text></binding></visual><actions>"
                   L"<action content=\"Done\" arguments=\"" + saratoast::xml(L"a=done" + base) + L"\" activationType=\"background\"/>"
                   L"<action content=\"Snooze 10 min\" arguments=\"" + saratoast::xml(L"a=snooze" + base) + L"\" activationType=\"background\"/></actions></toast>";
  if (g_toastOk && saratoast::show(x, tag, L"msg")) return;
  forgetOld(g_pageToasts);
  if (!g_pageToasts.count(tag)) toastMessage(L"Reminder", text, conv, tag, L"msg");  // the page didn't say it yet
}

/** "a=allow&id=…&p=…" → its fields. */
static std::map<std::wstring, std::wstring> toastArgs(const std::wstring& s) {
  std::map<std::wstring, std::wstring> out;
  size_t a = 0;
  while (a <= s.size()) {
    size_t b = s.find(L'&', a);
    std::wstring kv = s.substr(a, b == std::wstring::npos ? std::wstring::npos : b - a);
    size_t eq = kv.find(L'=');
    if (eq != std::wstring::npos) out[kv.substr(0, eq)] = kv.substr(eq + 1);
    if (b == std::wstring::npos) break;
    a = b + 1;
  }
  return out;
}

/** One click on a toast. Returns false when it has to wait for the quick-ask page. */
static bool handleToast(const std::wstring& args) {
  auto kv = toastArgs(args);
  const std::wstring& a = kv[L"a"];
  std::wstring p = plainId(kv[L"p"]), conv = plainId(kv[L"c"], 64);
  bool here = !p.empty() && p == g_profile;
  if (a == L"allow" || a == L"deny") {
    std::wstring id = plainId(kv[L"id"]);
    auto it = g_toastApprovals.find(id);
    bool stillWaiting = false;
    for (auto& i : g_now.items) stillWaiting = stillWaiting || (i.kind == L"approval" && i.id == id);
    if (here && it != g_toastApprovals.end() && stillWaiting) {
      if (!g_qaReady) return false;
      // The owner's explicit OK (or no) for exactly what the toast showed: the tray's Allow / Deny.
      logLine(std::wstring(L"toast: ") + (a == L"allow" ? L"allowed " : L"denied ") + id);
      decideFromTray(id, a == L"allow");
      saratoast::remove(it->second, L"approval");
      g_toastApprovals.erase(it);
      return true;
    }
    // Not one we can vouch for (after a restart, another server, already decided): the owner decides on the card.
  } else if (a == L"snooze") {
    if (!here) return true;
    if (!g_qaReady) return false;
    auto it = g_toastReminders.find(kv[L"t"]);
    std::wstring rid = it != g_toastReminders.end() ? it->second.rid : plainId(kv[L"r"], 20);
    std::wstring text = it != g_toastReminders.end() ? it->second.text : L"";
    if (rid.empty() && text.empty()) return true;
    g_qaWeb->ExecuteScript((L"window.saraQuick&&saraQuick.snooze(\"" + jsonEscape(rid) + L"\",\"" + jsonEscape(conv) + L"\",\"" + jsonEscape(text) + L"\")").c_str(), nullptr);
    return true;
  } else if (a == L"done") {
    return true;  // it went off already; the toast is gone
  }
  // The toast itself / Open in Sara: her window with that conversation (switching to its server).
  if (!p.empty() && !here && !loadProfile(p).url.empty()) {
    postSwitch(p, conv.empty() ? L"/" : L"/#c=" + conv);
    return true;
  }
  showWindow();
  if (!conv.empty()) openConversation(conv);
  return true;
}
static void runToastQueue() {
  std::vector<std::wstring> later;
  for (auto& args : std::vector<std::wstring>(g_toastQueue))
    if (!handleToast(args)) later.push_back(args);
  g_toastQueue = later;
}

/** Menu text: '&' would underline the next letter. */
static std::wstring menuText(const std::wstring& s) {
  std::wstring o;
  for (wchar_t c : s) {
    if (c == L'&') o += L"&&";
    else if (c != L'\t') o += c;
  }
  return o;
}

/** A saved server as the tray menu and pages show it: "🌸 Sara (host)", or just the host. */
static std::wstring serverLabel(const Profile& p) {
  std::wstring host = hostOfUrl(p.url);
  std::wstring label = (p.emoji.empty() ? L"" : p.emoji + L" ") + p.name;
  return lower(p.name) == lower(host) ? label : label + L"  (" + host + L")";
}

/** Phase 75 stage 3: the tray menu (and the window's other menus) dark while the page shows Night.
 *  uxtheme's unnamed exports: SetPreferredAppMode (ordinal 135, Windows 10 1903+), AllowDarkModeForWindow
 *  (133) and FlushMenuThemes (136). Older Windows, or a uxtheme without them: the normal light menu. */
static void themeMenus() {
  if (windowsBuild() < 18362) return;
  static HMODULE ux = LoadLibraryExW(L"uxtheme.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!ux) return;
  using SetPreferredAppModeFn = int(WINAPI*)(int);
  using AllowDarkModeForWindowFn = BOOL(WINAPI*)(HWND, BOOL);
  using FlushMenuThemesFn = void(WINAPI*)();
  static auto setMode = reinterpret_cast<SetPreferredAppModeFn>(reinterpret_cast<void*>(GetProcAddress(ux, MAKEINTRESOURCEA(135))));
  static auto allowWindow = reinterpret_cast<AllowDarkModeForWindowFn>(reinterpret_cast<void*>(GetProcAddress(ux, MAKEINTRESOURCEA(133))));
  static auto flush = reinterpret_cast<FlushMenuThemesFn>(reinterpret_cast<void*>(GetProcAddress(ux, MAKEINTRESOURCEA(136))));
  if (!setMode) return;
  setMode(g_day ? 3 : 2);  // 2 = ForceDark, 3 = ForceLight (follows the page, not the system)
  if (allowWindow && g_wnd) allowWindow(g_wnd, g_day ? FALSE : TRUE);
  if (flush) flush();
}

/** The tray menu, the same order as the Mac's menu bar menu:
 *    her face · mood | Ask Sara… | Now (jobs, approvals) |
 *    Open Sara · Settings… | Your Saras ▸ | Start with Windows · Quick ask shortcut ▸ · Help | Quit Sara */
static void trayMenu() {
  HMENU m = CreatePopupMenu();
  UINT needsServer = g_server.empty() ? MF_GRAYED : 0;
  g_menuNow = g_now.signedIn && !g_now.demo ? g_now.items : std::vector<NowItem>{};
  if (!g_server.empty()) {
    // Phase 75 stage 2: her face and mood at the top (a click opens the window).
    std::wstring head = menuText(g_now.name + (g_now.mood.empty() ? L"" : L" · " + g_now.mood));
    MENUITEMINFOW mi{sizeof(mi)};
    mi.fMask = MIIM_STRING | MIIM_ID | MIIM_FTYPE | (faceBitmap() ? MIIM_BITMAP : 0u);
    mi.fType = MFT_STRING;
    mi.wID = ID_HEADER;
    mi.dwTypeData = head.data();
    mi.hbmpItem = faceBitmap();
    InsertMenuItemW(m, 0, TRUE, &mi);
    // Quick ask: off on the demo (read-only) and until she's signed in.
    std::wstring ask = L"Ask " + menuText(g_now.name) + L"…" + (shortcutLabel().empty() || g_shortcutTaken ? L"" : L"\t" + shortcutLabel());
    AppendMenuW(m, MF_STRING | (g_now.demo || !g_now.signedIn ? MF_GRAYED : 0), ID_ASK, ask.c_str());
    if (g_now.signedIn && !g_now.demo) {
      // "Now": background jobs still running and approvals waiting (refreshed every 45 s).
      AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
      AppendMenuW(m, MF_STRING | MF_GRAYED, 0, g_menuNow.empty() ? L"Now: nothing running" : L"Now");
      for (size_t i = 0; i < g_menuNow.size() && i < kNowMax; i++) {
        const NowItem& it = g_menuNow[i];
        if (it.kind == L"approval") {
          HMENU sub = CreatePopupMenu();
          AppendMenuW(sub, MF_STRING, ID_ALLOW0 + i, L"Allow");
          AppendMenuW(sub, MF_STRING, ID_DENY0 + i, L"Deny");
          AppendMenuW(sub, MF_SEPARATOR, 0, nullptr);
          AppendMenuW(sub, MF_STRING, ID_NOW0 + i, L"Open in Sara");
          AppendMenuW(m, MF_POPUP, (UINT_PTR)sub, menuText(it.text).c_str());  // "Wants to: …" ▸ Allow / Deny / Open
        } else {
          AppendMenuW(m, MF_STRING, ID_NOW0 + i, menuText(it.text).c_str());  // "Writing tests… 4 min" (opens its chat)
        }
      }
    }
    AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
  }
  AppendMenuW(m, MF_STRING, ID_OPEN, L"Open Sara");
  AppendMenuW(m, MF_STRING | needsServer, ID_SETTINGS, L"Settings…");
  // Phase 87: Stop her on this computer, and switch "Let Sara use this computer" off.
  if (handsOn()) {
    // Phase 88: "Connected to Sara at …" (or what's wrong), Resume after a takeover, her own log.
    std::wstring status = sarahands::statusLine();
    if (!status.empty()) AppendMenuW(m, MF_STRING | MF_GRAYED, ID_HANDS_STATUS, status.c_str());
    AppendMenuW(m, MF_STRING | (sarahands::connected() ? 0 : MF_GRAYED), ID_HANDS_STOP, L"Stop Sara on this computer\tCtrl+Alt+Esc");
    if (sarahands::paused()) AppendMenuW(m, MF_STRING, ID_HANDS_RESUME, L"Resume Sara");
    AppendMenuW(m, MF_STRING, ID_HANDS_LOG, L"What Sara did on this computer");
    AppendMenuW(m, MF_STRING, ID_HANDS_OFF, L"Don't let Sara use this computer");
  }
  AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
  // Phase 68: the saved servers (✓ the one in use); switching keeps every sign-in.
  HMENU saras = CreatePopupMenu();
  auto list = profiles();
  for (size_t i = 0; i < list.size() && i < 50; i++)
    AppendMenuW(saras, MF_STRING | (list[i].id == g_profile ? MF_CHECKED : 0), ID_SERVER0 + i, serverLabel(list[i]).c_str());
  if (!list.empty()) AppendMenuW(saras, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(saras, MF_STRING, ID_CHANGE, L"Add a Sara…");
  AppendMenuW(m, MF_POPUP, (UINT_PTR)saras, L"Your Saras");
  AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(m, MF_STRING | (startAtLogin() ? MF_CHECKED : 0), ID_LOGIN, L"Start with Windows");
  // Phase 75 stage 2: the quick-ask shortcut (a clash with another app is marked).
  HMENU keys = CreatePopupMenu();
  std::wstring cur = shortcutId();
  for (size_t i = 0; i < std::size(kShortcuts); i++) {
    bool on = cur == kShortcuts[i].id;
    std::wstring label = std::wstring(kShortcuts[i].label) + (on && g_shortcutTaken ? L"  (used by another app)" : L"");
    AppendMenuW(keys, MF_STRING | (on ? MF_CHECKED : 0), ID_SHORTCUT0 + i, label.c_str());
  }
  AppendMenuW(keys, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(keys, MF_STRING | (cur == L"off" ? MF_CHECKED : 0), ID_SHORTCUT_OFF, L"Off");
  AppendMenuW(m, MF_POPUP, (UINT_PTR)keys, L"Quick ask shortcut");
  // Phase 75 stage 3: "Send to → Sara" in Explorer's right-click menu (made on the first start).
  AppendMenuW(m, MF_STRING | (sendToOn() ? MF_CHECKED : 0), ID_SENDTO, L"Send to Sara in Explorer");
  AppendMenuW(m, MF_STRING | needsServer, ID_HELP, L"Help");
  AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(m, MF_STRING, ID_QUIT, L"Quit Sara");
  SetMenuDefaultItem(m, ID_OPEN, FALSE);  // bold: what a click on the icon does
  POINT pt;
  GetCursorPos(&pt);
  SetForegroundWindow(g_wnd);
  themeMenus();
  refreshNow();  // fresh for the next time it opens
  TrackPopupMenu(m, TPM_RIGHTBUTTON, pt.x, pt.y, 0, g_wnd, nullptr);
  PostMessageW(g_wnd, WM_NULL, 0, 0);  // so the menu closes when you click elsewhere
  DestroyMenu(m);  // also destroys the submenus
}

// ---------- pages shown before the server is known or when it can't be reached ----------
// The app's own pages (welcome, add a Sara, can't reach): the new look's tokens (docs/design/
// NEW_LOOK.md, web/theme.css), Night or Day as the page last said, with a drag strip where the
// title bar would be. The same look as the Mac app's pages (desktop/mac/Sources/main.swift).
static const wchar_t* kPageStyle = LR"CSS(<meta name=viewport content='width=device-width'><style>
:root{--bg:#0f0d17;--panel:#17141f;--panel-2:#1e1a29;--text:#eee9f3;--muted:#a9a0b8;--accent:#f08aa5;--grad:linear-gradient(135deg,#e0607e,#9b6bff);--border:rgba(255,255,255,.08);--border-2:rgba(255,255,255,.16);--error:#ff6b7d;--on-accent:#160c14;--glow:0 0 0 1px rgba(224,96,126,.18),0 18px 50px rgba(155,107,255,.14);color-scheme:dark}
html.day{--bg:#faf7f5;--panel:#ffffff;--panel-2:#f6eff2;--text:#241c2b;--muted:#665d70;--accent:#b8436a;--border:rgba(36,28,43,.10);--border-2:rgba(36,28,43,.22);--error:#c0303a;--glow:0 12px 40px rgba(60,30,60,.10);color-scheme:light}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--text);font:15px/1.5 Inter,'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif;display:grid;place-items:center;padding:24px;-webkit-user-select:none;user-select:none}
body::before{content:'';position:fixed;left:0;right:0;top:0;height:var(--tb,0px);app-region:drag;-webkit-app-region:drag}
.c{width:100%;max-width:440px;background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:30px 30px 26px;box-shadow:var(--glow)}
.logo{display:block;width:64px;height:64px;border-radius:50%;margin:0 0 18px;background:var(--panel-2);box-shadow:0 0 0 2px rgba(240,138,165,.35),0 0 24px rgba(155,107,255,.35)}
h1{font-size:22px;line-height:1.25;margin:0 0 8px;font-weight:600;letter-spacing:-.01em}
p{color:var(--muted);margin:0 0 12px}b{color:var(--text);font-weight:600}
label{display:block;font-weight:600;font-size:14px;margin:18px 0 6px}
input{width:100%;font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--border-2);background:var(--panel-2);color:var(--text);-webkit-user-select:text;user-select:text}
input:focus{outline:2px solid var(--accent);outline-offset:-1px}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
button{font:inherit;font-weight:600;padding:9px 18px;min-height:40px;border:0;border-radius:10px;background:var(--grad);color:var(--on-accent);cursor:pointer;transition:filter .15s ease-out}
button:hover{filter:brightness(1.08)}button:focus-visible{outline:2px solid var(--text);outline-offset:2px}
button.g{background:transparent;color:var(--text);border:1px solid var(--border-2);font-weight:500}button.g:hover{border-color:var(--accent);filter:none}
.e{color:var(--error);font-size:14px;margin:8px 0 0}.e:empty{display:none}
.small{font-size:13px}.sep{border-top:1px solid var(--border);margin:22px 0 0;padding-top:14px}.sep p{margin:0 0 8px}
@media (prefers-reduced-motion:reduce){button{transition:none}}
</style>)CSS";
/** <!doctype html><html …><head> with the style: Day or Night, and the drag strip's height. */
static std::wstring pageHead() {
  return std::wstring(L"<!doctype html><html class='") + (g_day ? L"day" : L"night") + L"' style='--tb:" + std::to_wstring(g_customFrame ? kTitlebarDip : 0) + L"px'><head>" + kPageStyle +
         L"<script>chrome.webview.postMessage({type:'shell',titlebar:true})</script></head>";
}
/** Her picture at the top of these pages (page-logo.h is made by scripts/make-app-icons.py). */
static std::wstring logoHtml() { return std::wstring(L"<img class=logo alt='' src='") + kLogoDataUrl + L"'>"; }

static std::wstring htmlEscape(const std::wstring& s) {
  std::wstring o;
  for (wchar_t c : s) {
    if (c == L'&') o += L"&amp;";
    else if (c == L'<') o += L"&lt;";
    else if (c == L'>') o += L"&gt;";
    else if (c == L'\'') o += L"&#39;";
    else if (c == L'"') o += L"&quot;";
    else o += c;
  }
  return o;
}

static void showSetup(const std::wstring& error = L"", const std::wstring& typed = L"") {
  std::wstring port = localPort();
  // Phase 68: with a Sara already here, this page adds another one; Back returns to her.
  Profile here = g_profile.empty() ? Profile{} : loadProfile(g_profile);
  bool adding = !here.url.empty();
  std::wstring html = pageHead() + L"<body><div class=c>" + logoHtml() + L"<h1>" +
                      (adding ? L"Add a Sara" : L"Connect to your Sara") + L"</h1><p>" +
                      (adding ? L"Type the address of another Sara. Your other Saras stay signed in."
                              : L"Type the address you open Sara at in a web browser.") +
                      L"</p><label for=u>Address</label><input id=u autofocus spellcheck=false placeholder='sara.example.com' value='" +
                      htmlEscape(!typed.empty() ? typed : adding ? L"" : getPref(L"lastServer")) + L"'><p class=e id=e role=alert>" + htmlEscape(error) +
                      L"</p><div class=row><button id=b>Continue</button>" +
                      (adding ? L"<button class=g id=k>Back to " + htmlEscape(here.name) + L"</button>" : L"") +
                      L"</div><div class=sep><p class=small>Next you sign in with a code: on a device where you're signed in, open "
                      L"Settings → Data &amp; health → Devices and sign-in → <b>Add a phone or computer</b>.</p>" +
                      (port.empty() ? L"" : L"<button class=g id=l>Use the Sara on this computer</button>") +
                      L"</div></div><script>const $=(i)=>document.getElementById(i);const k=$('k');if(k)k.onclick=()=>chrome.webview.postMessage({m:'retry'});"
                      L"const go=()=>chrome.webview.postMessage({m:'setServer',url:$('u').value});"
                      L"const l=$('l');if(l)l.onclick=()=>chrome.webview.postMessage({m:'useLocal'});"
                      // 2.18: no return value from the key handler (returning false cancelled every
                      // key but Enter, so nothing could be typed into the address).
                      L"$('b').onclick=go;$('u').onkeydown=e=>{if(e.key==='Enter')go();};</script></body></html>";
  if (g_web) g_web->NavigateToString(html.c_str());
}

/** The server is her own on this computer (installed together with this app). */
static bool serverIsLocal() {
  std::wstring port = localPort();
  return !port.empty() && (g_server == L"http://127.0.0.1:" + port || g_server == L"http://localhost:" + port);
}

static void showOffline() {
  std::wstring why = serverIsLocal()
      ? L"She runs on this computer and may still be starting. If she doesn't answer in a minute, open a terminal and run <b>sara status</b> (and <b>sara logs</b>)."
      : L"Check your internet connection, that the address is right, and that Sara is running there. This page tries again by itself.";
  // Phase 68: the other saved Saras are one click away.
  std::wstring others;
  for (auto& p : profiles())
    if (p.id != g_profile) others += L"<button class=g data-id='" + htmlEscape(p.id) + L"'>" + htmlEscape(p.name) + L"</button>";
  std::wstring html = pageHead() + L"<body><div class=c>" + logoHtml() +
                      L"<h1>Can't reach your Sara</h1><p><b>" + htmlEscape(g_server) + L"</b> isn't answering.</p><p>" + why +
                      L"</p><div class=row><button id=r>Try again</button><button class=g id=s>Add a Sara</button></div>" +
                      (others.empty() ? L"" : L"<div class=sep><p class=small>Your other Saras</p><div class=row style='margin-top:0'>" + others + L"</div></div>") +
                      L"</div><script>document.getElementById('r').onclick=()=>chrome.webview.postMessage({m:'retry'});"
                      L"for(const b of document.querySelectorAll('[data-id]'))b.onclick=()=>chrome.webview.postMessage({m:'useServer',id:b.dataset.id});"
                      L"document.getElementById('s').onclick=()=>chrome.webview.postMessage({m:'changeServer'});setTimeout(()=>chrome.webview.postMessage({m:'retry'}),30000);</script></body></html>";
  if (g_web) g_web->NavigateToString(html.c_str());
}

/** Phase 68: "Add a Sara…" (tray menu, the page's ⇄ menu, the offline page): the address page.
 *  Nothing is signed out; the new server gets a WebView2 profile of its own. */
static void changeServerFromMenu() {
  showWindow();
  showSetup();
}

static void openServer(const std::wstring& path = L"/") {
  if (g_server.empty()) return showSetup();
  if (g_web) g_web->Navigate((g_server + path).c_str());
}

/** A conversation in the main window (quick ask's "Open in Sara", the tray's "Now" items). */
static void openConversation(const std::wstring& conv) {
  bool ok = !conv.empty() && conv.size() <= 64;
  for (wchar_t c : conv) ok = ok && (iswxdigit(c) || c == L'-');
  if (!ok || g_server.empty() || !g_web) return;
  LPWSTR src = nullptr;
  g_web->get_Source(&src);
  bool onServer = src && sameOrigin(src);
  CoTaskMemFree(src);
  // On her page the bridge opens it (location.hash = 'c=…'); elsewhere load it.
  if (onServer) g_web->PostWebMessageAsJson((L"{\"open\":\"" + conv + L"\"}").c_str());
  else openServer(L"/#c=" + conv);
}

/** Tray menu → Settings… / Help: opens that view of the web app (its #view= links). */
static void openView(const wchar_t* view) {
  showWindow();
  if (g_server.empty() || !g_web) return;
  LPWSTR src = nullptr;
  g_web->get_Source(&src);
  bool onServer = src && sameOrigin(src);
  CoTaskMemFree(src);
  // replaceState first: setting the hash it already has wouldn't open the view again.
  if (onServer) g_web->ExecuteScript((std::wstring(L"history.replaceState(null,'',location.pathname);location.hash='view=") + view + L"'").c_str(), nullptr);
  else openServer(std::wstring(L"/#view=") + view);
}

static void createController();
/** Phase 68: shows another saved server in its own WebView2 profile; every sign-in is kept. */
static void switchTo(const std::wstring& id, const std::wstring& path = L"/") {
  if (loadProfile(id).url.empty()) return;
  if (id == g_profile && g_web) {
    activate(id);
    return openServer(path);
  }
  activate(id);
  g_nextPath = path;
  hideQuickAsk();
  closeQuickAskWebView();  // its profile belongs to the old server
  if (g_controller) g_controller->Close();
  g_controller.Reset();
  g_web.Reset();
  createController();
}
/** Asks for a switch from the message loop (not from inside a WebView2 callback). */
static void postSwitch(const std::wstring& id, const std::wstring& path = L"/") {
  g_switchTo = id;
  g_switchPath = path;
  PostMessageW(g_wnd, WM_APP_SWITCH, 0, 0);
}

/** Removing the server in use: sign out on the server (from its own page), then clear its
 *  WebView2 profile, forget it and show the most recently used other one. */
static void removeActive() {
  g_removing = g_profile;
  SetTimer(g_wnd, kRemoveTimer, 5000, nullptr);  // offline: forget it here anyway
  if (g_web) g_web->ExecuteScript(L"fetch('/api/logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).catch(()=>{}).finally(()=>chrome.webview.postMessage({m:'loggedOut'}))", nullptr);
}
static void finishRemove() {
  KillTimer(g_wnd, kRemoveTimer);
  if (g_removing.empty()) return;
  std::wstring id = g_removing;
  auto done = [id]() {
    forgetProfile(id);
    logLine(L"forgot server " + id + L" (its sign-in was cleared)");
    g_removing.clear();
    PostMessageW(g_wnd, WM_APP_REMOVED, 0, 0);
  };
  ComPtr<ICoreWebView2_13> w13;
  ComPtr<ICoreWebView2Profile> profile;
  ComPtr<ICoreWebView2Profile2> p2;
  if (g_web && SUCCEEDED(g_web.As(&w13)) && SUCCEEDED(w13->get_Profile(&profile)) && SUCCEEDED(profile.As(&p2))) {
    g_web->NavigateToString((pageHead() + L"<body></body></html>").c_str());
    HRESULT hr = p2->ClearBrowsingDataAll(Callback<ICoreWebView2ClearBrowsingDataCompletedHandler>([done](HRESULT) -> HRESULT {
                    done();
                    return S_OK;
                  }).Get());
    if (SUCCEEDED(hr)) return;
  }
  done();
}
static void removeServer(const std::wstring& id) {
  if (loadProfile(id).url.empty() || !g_removing.empty()) return;
  if (id == g_profile) return removeActive();
  // Its sign-in is in its own profile: open it, then sign out there (see NavigationCompleted).
  g_removeAfterLoad = id;
  postSwitch(id);
}
/** After a removal: the most recently used other server, or the address page. */
static void afterRemove() {
  Profile best;
  for (auto& p : profiles())
    if (best.id.empty() || p.lastUsed > best.lastUsed) best = p;
  if (best.id.empty()) {
    g_profile.clear();
    g_server.clear();
    setPref(L"server", L"");
    setIni(L"servers", L"active", L"");
    return showSetup();
  }
  switchTo(best.id);
}

// ---------- the bridge (window.SaraDesktop in the page) ----------
static const wchar_t* kShim = LR"JS(
(() => {
  if (window.SaraDesktop || !window.chrome || !chrome.webview) return;
  let next = 1;
  const pending = new Map();
  chrome.webview.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error)) : p.resolve(d.result); }
    if (d.open) location.hash = 'c=' + d.open;
    // Phase 75 stage 3: files from Explorer's Send To / Sara.exe <files>: into the message box as
    // attachments (never sent by themselves). The page's own hook when it has one, else its attach
    // button's file input, so the page's own rules (types, sizes, how many) apply as for a drop.
    if (d.attach) attach(e.additionalObjects ? [...e.additionalObjects] : []);
  });
  const attach = async (handles) => {
    const files = [];
    for (const h of handles) {
      try { files.push(h && typeof h.getFile === 'function' ? await h.getFile() : h); } catch (err) { /* gone meanwhile */ }
    }
    let ok = false;
    try {
      if (files.length && typeof window.saraDesktopAttach === 'function') ok = (await window.saraDesktopAttach(files)) !== false;
      else {
        const input = document.getElementById('attach-file');
        if (files.length && input && !document.body.classList.contains('demo')) {
          const dt = new DataTransfer();
          for (const f of files) dt.items.add(f);
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          ok = true;
        }
      }
    } catch (err) { ok = false; }
    post({ m: 'attached', ok, n: files.length });
  };
  const post = (o) => chrome.webview.postMessage(o);
  window.SaraDesktop = {
    platform: 'windows',
    call(m, a = {}) { return new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); post({ id, m, ...a }); }); },
    notify(title, body, conv) { post({ m: 'notify', title: String(title || ''), body: String(body || ''), conv: String(conv || '') }); },
    attention(kind) { post({ m: 'attention', kind: String(kind || '') }); },
  };
})();
)JS";

static void reply(const std::wstring& id, const std::wstring& resultJson, const std::wstring& error = L"") {
  if (id.empty() || !g_web) return;
  std::wstring msg = L"{\"id\":" + id + (error.empty() ? L",\"result\":" + resultJson : L",\"error\":\"" + jsonEscape(error) + L"\"") + L"}";
  g_web->PostWebMessageAsJson(msg.c_str());
}

// ---------- Phase 75 stage 3: files from Explorer (Send To → Sara, Sara.exe <files>) ----------
// The files go to the page as read-only file handles (WebView2 PostWebMessageAsJsonWithAdditionalObjects);
// the bridge script above puts them into the message box. Nothing is uploaded or sent here: the page
// uploads them with its own routes and rules when the owner presses Send.
static std::vector<std::wstring> g_pendingFiles;
static bool g_filesInFlight = false;
/** Only files (not folders) that exist, at most kMaxFiles. */
static std::vector<std::wstring> realFiles(const std::vector<std::wstring>& in) {
  std::vector<std::wstring> out;
  for (auto& f : in) {
    if (out.size() >= kMaxFiles) break;
    if (f.empty() || f.size() > 4096) continue;
    DWORD at = GetFileAttributesW(f.c_str());
    if (at == INVALID_FILE_ATTRIBUTES || (at & FILE_ATTRIBUTE_DIRECTORY)) continue;
    wchar_t full[4096];
    DWORD n = GetFullPathNameW(f.c_str(), 4096, full, nullptr);
    if (n > 0 && n < 4096) out.push_back(full);
  }
  return out;
}
/** Hands the waiting files to her page (once it's her page, signed in). */
static void deliverFiles() {
  if (g_pendingFiles.empty() || g_filesInFlight || !g_web || !g_env) return;
  LPWSTR src = nullptr;
  g_web->get_Source(&src);
  bool onServer = src && sameOrigin(src) && wcsstr(src, L"/pair") == nullptr;
  CoTaskMemFree(src);
  if (!onServer) return;  // the address page, can't reach, the sign-in: they wait
  ComPtr<ICoreWebView2Environment14> e14;
  ComPtr<ICoreWebView2_23> w23;
  if (FAILED(g_env.As(&e14)) || FAILED(g_web.As(&w23))) {
    g_pendingFiles.clear();
    notifyPlain(L"Drag the files into Sara's window", L"This version of Microsoft Edge WebView2 can't hand files to Sara this way. Drag them into her window instead.");
    return;
  }
  std::vector<ComPtr<ICoreWebView2FileSystemHandle>> handles;
  std::vector<IUnknown*> raw;
  for (auto& f : g_pendingFiles) {
    ComPtr<ICoreWebView2FileSystemHandle> h;
    if (SUCCEEDED(e14->CreateWebFileSystemFileHandle(f.c_str(), COREWEBVIEW2_FILE_SYSTEM_HANDLE_PERMISSION_READ_ONLY, &h)) && h) {
      raw.push_back(h.Get());
      handles.push_back(h);
    }
  }
  g_pendingFiles.clear();
  ComPtr<ICoreWebView2ObjectCollection> list;
  if (raw.empty() || FAILED(e14->CreateObjectCollection((UINT32)raw.size(), raw.data(), &list)) || FAILED(w23->PostWebMessageAsJsonWithAdditionalObjects(L"{\"attach\":true}", list.Get()))) {
    logLine(L"files: couldn't hand them to the page");
    return;
  }
  g_filesInFlight = true;
  logLine(L"files: " + std::to_wstring(raw.size()) + L" handed to the page");
}
/** The page took them (or had no message box: not signed in yet, the demo). */
static void filesAttached(bool ok) {
  g_filesInFlight = false;
  if (!ok) notifyPlain(L"Sara couldn't take the files yet", L"Sign in to her in the window first (and not on the demo), then send them again.");
}
/** Files from a second start or the command line: shown in the window, attached when her page is there. */
static void takeFiles(const std::vector<std::wstring>& paths) {
  auto files = realFiles(paths);
  if (files.empty()) return;
  for (auto& f : files)
    if (g_pendingFiles.size() < kMaxFiles) g_pendingFiles.push_back(f);
  showWindow();
  deliverFiles();
}

static std::wstring prefsJson() {
  return std::wstring(L"{\"platform\":\"windows\",\"version\":\"") + kVersion + L"\",\"startAtLogin\":" + (startAtLogin() ? L"true" : L"false") +
         L",\"keepRunning\":" + (prefOn(L"keepRunning", true) ? L"true" : L"false") + L",\"notifications\":" + (prefOn(L"notifications", true) ? L"true" : L"false") +
         L",\"server\":\"" + jsonEscape(g_server) + L"\",\"theme\":\"" + g_themePref + L"\",\"titlebar\":" + std::to_wstring(g_customFrame ? kTitlebarDip : 0) +
         // Phase 75 stage 2: the quick-ask shortcut, the choices, and whether another app has it.
         L",\"quickAskShortcut\":\"" + shortcutId() + L"\",\"quickAskShortcutLabel\":\"" + shortcutLabel() + L"\",\"quickAskShortcutFree\":" + (g_shortcutTaken ? L"false" : L"true") +
         L",\"quickAskShortcuts\":" + shortcutsJson() + L",\"sendTo\":" + (sendToOn() ? L"true" : L"false") + L",\"toasts\":" + (g_toastOk ? L"true" : L"false") + handsPrefsJson() + L"}";
}

static void onMessage(const std::wstring& json, const std::wstring& source) {
  auto m = parseFlatJson(json);
  const std::wstring& kind = m[L"m"];
  const std::wstring id = m[L"id"];
  bool fromServer = sameOrigin(source);
  // The local setup/offline pages may only set the server, retry or change server.
  if (kind == L"setServer") {
    std::wstring o = originOf(m[L"url"]);
    if (o.empty()) return showSetup(L"That doesn't look like a web address. Try something like sara.example.com.", m[L"url"]);
    setPref(L"lastServer", o);
    // Phase 68: a saved server again, or a new one next to the others (nobody is signed out).
    return postSwitch(profileFor(o), L"/pair");
  }
  // Phase 75: the page draws its header in the title strip (any page: it only moves the web view up).
  if (m[L"type"] == L"shell" || kind == L"shell") {
    setPageTitle(m[L"titlebar"] == L"true", pageOrigin(source));
    return reply(id, L"true");
  }
  if (kind == L"retry") return openServer();
  if (kind == L"changeServer") return changeServerFromMenu();
  if (kind == L"useServer" && !fromServer) return postSwitch(m[L"id"]);
  if (kind == L"useLocal") {
    std::wstring port = localPort();
    if (port.empty()) return showSetup();
    std::wstring o = L"http://127.0.0.1:" + port;
    setPref(L"lastServer", o);
    return postSwitch(profileFor(o));
  }
  if (!fromServer) return;  // everything else only from the owner's own server
  // Phase 75: the page's theme (Night / Day / follow the system): the title bar, Mica and the
  // background before the next page paints follow it. {type:'theme', theme} or SaraDesktop.call('theme', {theme}).
  if (m[L"type"] == L"theme" || kind == L"theme") {
    setTheme(m[L"theme"]);
    if (!m[L"backdrop"].empty()) setBackdrop(m[L"backdrop"]);
    return reply(id, L"true");
  }
  // {type:'backdrop', backdrop:'mica'|'solid'}: 'mica' once the page's background is see-through.
  if (m[L"type"] == L"backdrop" || kind == L"backdrop") {
    setBackdrop(m[L"backdrop"]);
    return reply(id, g_mica ? L"\"mica\"" : L"\"solid\"");
  }
  if (kind == L"getPrefs") return reply(id, prefsJson());
  // Phase 68: the page's ⇄ menu. Names and hosts only: no sign-in ever goes to a page.
  if (kind == L"servers") return reply(id, serversJson());
  if (kind == L"useServer") {
    reply(id, L"true");
    return postSwitch(m[L"id"]);
  }
  if (kind == L"addServer") {
    reply(id, L"true");
    return showSetup();
  }
  if (kind == L"removeServer") {
    reply(id, L"true");
    return removeServer(m[L"id"]);
  }
  if (kind == L"renameServer" || kind == L"serverName") {
    bool byUser = kind == L"renameServer";
    Profile p = loadProfile(byUser ? m[L"id"] : g_profile);
    std::wstring name = m[L"name"];
    if (!p.url.empty() && !name.empty() && (byUser || !p.named)) {
      p.name = uniqueName(name, p.url, p.id);
      if (byUser) p.named = true;
      saveProfile(p);
      if (p.id == g_profile) activate(p.id);
    }
    return reply(id, serversJson());
  }
  if (kind == L"loggedOut") return finishRemove();
  // Phase 75 stage 2: the page can open the quick-ask window (e.g. to try the shortcut's window).
  if (kind == L"quickAsk") {
    reply(id, L"true");
    return showQuickAsk();
  }
  if (kind == L"setPref") {
    const std::wstring& key = m[L"key"];
    bool on = m[L"value"] == L"true";
    if (key == L"quickAskShortcut") {
      if (!setShortcut(m[L"value"])) return reply(id, L"null", L"Unknown shortcut");
    } else if (key == L"startAtLogin") setStartAtLogin(on);
    else if (key == L"sendTo") setSendTo(on);  // Phase 75 stage 3: "Send to → Sara" in Explorer
    else if (key == L"keepRunning" || key == L"notifications") setPref(key.c_str(), on ? L"1" : L"0");
    else if (key == L"handsLocalOnly") {
      // Phase 87: "Screenshots only to models on this computer" (the server hears it at once).
      setIni(handsSection(), L"handsLocalOnly", on ? L"1" : L"0");
      sarahands::setLocalOnly(on);
    }
    else if (key == L"handsDesktop") {
      // Phase 92: "The whole screen" (desktop look; the page showed its explainer first).
      setIni(handsSection(), L"handsDesktop", on ? L"1" : L"0");
      sarahands::setDesktop(on);
    }
    else if (key == L"handsBlockExtra") {
      // Phase 92: "Also hide these windows" (one per line; kept on one ini line with \n escapes).
      std::wstring v = m[L"value"].substr(0, 2000);
      setIni(handsSection(), L"handsBlockExtra", escapeLines(v));
      sarahands::setBlockExtra(toUtf8(v));
    }
    else if (key == L"loginsVerify") {
      // Phase 90: Windows Hello before Sara uses a saved login (off by default).
      setIni(handsSection(), L"loginsVerify", on ? L"1" : L"0");
      sarahands::setLoginsVerify(on);
    }
    else if (key == L"pmRelockMinutes") {
      // Phase 91: lock the password managers again after this many idle minutes.
      int n = _wtoi(m[L"value"].c_str());
      if (n != 5 && n != 15 && n != 30 && n != 60) return reply(id, L"null", L"5, 15, 30 or 60 minutes.");
      setIni(handsSection(), L"pmRelockMinutes", std::to_wstring(n));
      sarahands::setRelockMinutes(n);
    }
    else if (key == L"handsTakeover") {
      // Phase 88: "When you move the mouse": pause Sara (default) or let her keep control.
      bool keepIt = m[L"value"] == L"keep";
      setIni(handsSection(), L"handsTakeover", keepIt ? L"keep" : L"pause");
      sarahands::setTakeover(keepIt);
    }
    else if (key == L"handsDesktopLevel") {
      std::wstring value = m[L"value"];
      if (value != L"ask" && value != L"task" && value != L"always") return reply(id, L"null", L"Invalid desktop approval level");
      if (value == L"always" && MessageBoxW(g_wnd, L"Sara may act on desktop apps without approval cards. Payments and account changes still ask. Protected windows and password fields stay refused. Stop always works. Allow this on this computer?", L"Desktop actions: Always allowed", MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2) != IDYES) return reply(id, L"null", L"Not allowed on this computer");
      setIni(handsSection(), L"handsDesktopLevel", value);
      sarahands::setDesktopLevel(value == L"ask" ? 0 : value == L"always" ? 2 : 1);
    }
    else if (key == L"handsWalkAway") {
      setIni(handsSection(), L"handsWalkAway", on ? L"1" : L"0");
      sarahands::setWalkAway(on);
    }
    else return reply(id, L"null", L"Unknown setting");
    return reply(id, prefsJson());
  }
  // Phase 87: "Let Sara use this computer". The page made the hands token after the owner confirmed
  // it's them; it is kept here with DPAPI and never given back to any page.
  if (kind == L"handsPair") {
    std::string token = toUtf8(m[L"token"]);
    if (token.rfind("sara_hands.", 0) != 0 || token.size() > 300) return reply(id, L"null", L"That isn't a hands token.");
    std::wstring sealed = sarahands::protect(token);
    SecureZeroMemory(token.data(), token.size());
    if (sealed.empty()) return reply(id, L"null", L"Windows couldn't keep the token safe.");
    setIni(handsSection(), L"handsToken", sealed);
    setIni(handsSection(), L"handsId", m[L"id"]);
    setIni(handsSection(), L"handsExpires", m[L"expiresAt"]);
    setIni(handsSection(), L"handsOn", L"1");
    handsSync();
    return reply(id, prefsJson());
  }
  if (kind == L"handsOff") {
    handsOff();
    return reply(id, prefsJson());
  }
  // Phase 90: this server's saved logins on this computer (names, sites, dates; never a password).
  if (kind == L"loginsList") {
    if (g_server.empty()) return reply(id, L"{\"logins\":[]}");
    return reply(id, sarahands::loginsJson(g_server, loginsFile()));
  }
  if (kind == L"loginsRemove") {
    if (g_server.empty()) return reply(id, L"null", L"Not connected to a Sara server.");
    std::wstring err;
    int n = sarahands::forgetLogin(g_server, loginsFile(), toUtf8(m[L"name"]), m[L"all"] == L"true", err);
    if (!err.empty()) return reply(id, L"null", err);
    return reply(id, L"{\"removed\":" + std::to_wstring(n) + L"}");
  }
  // Phase 91: the password managers here (names and states). Turning one on shows this app's own warning
  // (the page can only ask: a server's page can never turn one on by itself); off locks it at once.
  if (kind == L"pmList") return reply(id, sarahands::managersJson());
  if (kind == L"pmSet") {
    const wchar_t* k = pmKey(m[L"manager"]);
    if (!k || g_server.empty()) return reply(id, L"null", L"Not a password manager Sara knows.");
    std::string mid = toUtf8(m[L"manager"]);
    bool on = m[L"on"] == L"true";
    if (on) {
      if (!sarahands::managerInstalled(mid)) return reply(id, L"null", L"That password manager isn't installed on this computer.");
      std::wstring name = mid == "bitwarden" ? L"Bitwarden" : mid == "1password" ? L"1Password" : L"KeePassXC";
      std::wstring text = sarahands::managerWarning(mid, pmRelockMinutes());
      if (MessageBoxW(g_wnd, text.c_str(), (std::wstring(testRun() ? L"TEST · " : L"") + L"Turn on " + name + L" for Sara?").c_str(), MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_TOPMOST) != IDYES) return reply(id, L"{\"cancelled\":true}");
      if (mid == "keepassxc" && getIni(handsSection(), L"pmKeepassDb").empty()) {
        std::wstring db = pickKeepassDb();
        if (db.empty()) return reply(id, L"{\"cancelled\":true}");
        setIni(handsSection(), L"pmKeepassDb", db);
        sarahands::setKeepassDb(db);
      }
    }
    setIni(handsSection(), k, on ? L"1" : L"0");
    sarahands::setManager(mid, on);
    return reply(id, sarahands::managersJson());
  }
  if (kind == L"pmKeepassDb") {
    std::wstring db = pickKeepassDb();
    if (db.empty()) return reply(id, L"{\"cancelled\":true}");
    setIni(handsSection(), L"pmKeepassDb", db);
    sarahands::setKeepassDb(db);
    return reply(id, sarahands::managersJson());
  }
  if (kind == L"handsStop") {
    sarahands::pressStop();
    return reply(id, L"true");
  }
  if (kind == L"testNotification") {
    g_pendingConv.clear();
    toastMessage(m[L"title"], m[L"body"], L"", toastTag(L"t", std::to_wstring(GetTickCount())), L"test");
    return reply(id, L"true");
  }
  if (kind == L"notify") return notifyFromPage(m[L"title"], m[L"body"], m[L"conv"]);
  if (kind == L"attached") return filesAttached(m[L"ok"] == L"true");
  if (kind == L"attention") {
    // A call: bring the window up (Windows may only flash the taskbar button if another app is busy).
    showWindow();
    FLASHWINFO f{sizeof(f), g_wnd, FLASHW_ALL | FLASHW_TIMERNOFG, 0, 0};
    FlashWindowEx(&f);
    return;
  }
}

/** Phase 68: the web view for the server in use, in that server's own WebView2 profile (s1: the
 *  default profile, the one used before 1.8; others: "sara-<id>"), so sign-ins stay apart. */
static void createController() {
  if (!g_env) return;
  auto done = Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([](HRESULT r2, ICoreWebView2Controller* ctl) -> HRESULT {
          if (FAILED(r2) || !ctl) return S_OK;
          g_controller = ctl;
          g_controller->get_CoreWebView2(&g_web);
          // Phase 75: the theme colour behind every page (no white flash on start, navigation or resize).
          ComPtr<ICoreWebView2Controller2> c2;
          COLORREF bg = themeColor();
          if (SUCCEEDED(g_controller.As(&c2))) c2->put_DefaultBackgroundColor({(BYTE)(g_mica ? 0 : 255), GetRValue(bg), GetGValue(bg), GetBValue(bg)});

          ComPtr<ICoreWebView2Settings> settings;
          g_web->get_Settings(&settings);
          settings->put_AreDevToolsEnabled(FALSE);
          settings->put_IsStatusBarEnabled(FALSE);
          // Phase 75: CSS app-region: drag in the page's header moves the window (double-click
          // maximizes). A WebView2 without it keeps the normal title bar.
          ComPtr<ICoreWebView2Settings9> s9;
          bool regions = SUCCEEDED(settings.As(&s9)) && SUCCEEDED(s9->put_IsNonClientRegionSupportEnabled(TRUE));
          if (!regions && g_wantCustomFrame) {
            logLine(L"this WebView2 has no app-region support: the normal title bar is used");
            g_wantCustomFrame = false;
            setCustomFrame(false);
          }
          layoutWebView();
          // Phase 75 stage 2: the quick-ask page (and "Now") for this server, in the same profile.
          if (g_qaServer != g_server) {
            g_now = NowState{};
            loadCachedFace();
            updateTrayTip();
          }
          ensureQuickAsk();
          ComPtr<ICoreWebView2Settings2> s2;
          if (SUCCEEDED(settings.As(&s2))) {
            LPWSTR ua = nullptr;
            s2->get_UserAgent(&ua);
            std::wstring full = std::wstring(ua ? ua : L"") + L" SaraDesktop/1 (Windows)";
            CoTaskMemFree(ua);
            s2->put_UserAgent(full.c_str());
          }

          // Only the owner's server opens inside the app; other links go to the browser.
          g_web->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>([](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* a) -> HRESULT {
            LPWSTR uri = nullptr;
            a->get_Uri(&uri);
            std::wstring u = uri ? uri : L"";
            CoTaskMemFree(uri);
            if (u.rfind(L"data:", 0) == 0 || u.rfind(L"about:", 0) == 0 || sameOrigin(u)) {
              // Another place (a server, the app's own page): its page says again whether it draws the strip.
              if (g_pageTitle && pageOrigin(u) != g_pageTitleOrigin) setPageTitle(false, L"");
              return S_OK;
            }
            a->put_Cancel(TRUE);
            if (u.rfind(L"http", 0) == 0) ShellExecuteW(nullptr, L"open", u.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
            return S_OK;
          }).Get(), nullptr);
          g_web->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>([](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* a) -> HRESULT {
            LPWSTR uri = nullptr;
            a->get_Uri(&uri);
            std::wstring u = uri ? uri : L"";
            CoTaskMemFree(uri);
            a->put_Handled(TRUE);
            if (u.rfind(L"http", 0) == 0) ShellExecuteW(nullptr, L"open", u.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
            return S_OK;
          }).Get(), nullptr);
          // Can't reach the server: a friendly page with Try again.
          g_web->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>([](ICoreWebView2* w, ICoreWebView2NavigationCompletedEventArgs* a) -> HRESULT {
            BOOL ok = TRUE;
            a->get_IsSuccess(&ok);
            COREWEBVIEW2_WEB_ERROR_STATUS st;
            a->get_WebErrorStatus(&st);
            LPWSTR uri = nullptr;
            w->get_Source(&uri);
            std::wstring u = uri ? uri : L"";
            CoTaskMemFree(uri);
            if (!ok && sameOrigin(u) && st != COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED) showOffline();
            // Phase 75 stage 3: files that came while her page wasn't there yet.
            if (ok && sameOrigin(u)) deliverFiles();
            // Phase 68: removing a server that wasn't in use: now it's open, sign out there.
            if (!g_removeAfterLoad.empty() && g_removeAfterLoad == g_profile && sameOrigin(u)) {
              g_removeAfterLoad.clear();
              removeActive();
            }
            return S_OK;
          }).Get(), nullptr);
          // Microphone (calls, voice messages), the camera (video calls, Phase 69: only after the owner
          // turns it on in the call) and notifications: allowed for the owner's server only.
          g_web->add_PermissionRequested(Callback<ICoreWebView2PermissionRequestedEventHandler>([](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* a) -> HRESULT {
            LPWSTR uri = nullptr;
            a->get_Uri(&uri);
            std::wstring u = uri ? uri : L"";
            CoTaskMemFree(uri);
            COREWEBVIEW2_PERMISSION_KIND k;
            a->get_PermissionKind(&k);
            bool wanted = k == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE || k == COREWEBVIEW2_PERMISSION_KIND_CAMERA || k == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS || k == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ;
            a->put_State(sameOrigin(u) && wanted ? COREWEBVIEW2_PERMISSION_STATE_ALLOW : COREWEBVIEW2_PERMISSION_STATE_DEFAULT);
            return S_OK;
          }).Get(), nullptr);
          g_web->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>([](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* a) -> HRESULT {
            LPWSTR json = nullptr, src = nullptr;
            a->get_WebMessageAsJson(&json);
            a->get_Source(&src);
            std::wstring j = json ? json : L"", s = src ? src : L"";
            CoTaskMemFree(json);
            CoTaskMemFree(src);
            onMessage(j, s);
            return S_OK;
          }).Get(), nullptr);
          // Phase 75 stage 3: a web Notification from the page (new Notification(), a service
          // worker's) becomes the app's own toast, under the same one-per-event rule, never a second one.
          ComPtr<ICoreWebView2_24> w24;
          if (SUCCEEDED(g_web.As(&w24))) {
            w24->add_NotificationReceived(Callback<ICoreWebView2NotificationReceivedEventHandler>([](ICoreWebView2*, ICoreWebView2NotificationReceivedEventArgs* a) -> HRESULT {
              a->put_Handled(TRUE);
              LPWSTR origin = nullptr;
              a->get_SenderOrigin(&origin);
              bool mine = origin && sameOrigin(origin);
              CoTaskMemFree(origin);
              ComPtr<ICoreWebView2Notification> n;
              if (!mine || FAILED(a->get_Notification(&n)) || !n) return S_OK;
              LPWSTR title = nullptr, body = nullptr;
              n->get_Title(&title);
              n->get_Body(&body);
              notifyFromPage(title ? title : L"Sara", body ? body : L"", L"");
              CoTaskMemFree(title);
              CoTaskMemFree(body);
              n->ReportShown();
              return S_OK;
            }).Get(), nullptr);
          }
          // Phase 75: window.saraShell and <html class="shell-windows"> before any page script.
          g_web->AddScriptToExecuteOnDocumentCreated(shellScript().c_str(), nullptr);
          // Open the server only once the bridge script is registered, or the first page misses it.
          g_web->AddScriptToExecuteOnDocumentCreated(kShim, Callback<ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler>([](HRESULT, LPCWSTR) -> HRESULT {
            // Phase 55: the installer set the address of a Sara elsewhere: the first start goes
            // straight to her sign-in with a code.
            if (getPref(L"pairNext") == L"1") {
              setPref(L"pairNext", L"");
              if (!g_server.empty()) {
                openServer(L"/pair");
                return S_OK;
              }
            }
            std::wstring path = g_nextPath;
            g_nextPath = L"/";
            openServer(path);
            return S_OK;
          }).Get());
          return S_OK;
  });
  ComPtr<ICoreWebView2Environment10> env10;
  if (!g_profile.empty() && g_profile != L"s1" && SUCCEEDED(g_env.As(&env10))) {
    ComPtr<ICoreWebView2ControllerOptions> opts;
    if (SUCCEEDED(env10->CreateCoreWebView2ControllerOptions(&opts))) {
      opts->put_ProfileName((L"sara-" + g_profile).c_str());
      env10->CreateCoreWebView2ControllerWithOptions(g_wnd, opts.Get(), done.Get());
      return;
    }
  }
  g_env->CreateCoreWebView2Controller(g_wnd, done.Get());
}

static void createWebView() {
  std::wstring userData = dataDir() + L"\\WebView";
  HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
      nullptr, userData.c_str(), nullptr,
      Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([](HRESULT res, ICoreWebView2Environment* env) -> HRESULT {
        if (FAILED(res) || !env) {
          if (MessageBoxW(g_wnd, L"Sara needs Microsoft Edge WebView2, which is part of Windows 11 and most Windows 10 PCs. Open the download page?", L"Sara", MB_YESNO | MB_ICONWARNING | MB_SETFOREGROUND) == IDYES)
            ShellExecuteW(nullptr, L"open", L"https://developer.microsoft.com/microsoft-edge/webview2/", nullptr, nullptr, SW_SHOWNORMAL);
          PostQuitMessage(1);
          return S_OK;
        }
        g_env = env;
        createController();
        return S_OK;
      }).Get());
  if (FAILED(hr)) {
    MessageBoxW(g_wnd, L"Sara couldn't start Microsoft Edge WebView2.", L"Sara", MB_ICONERROR);
    PostQuitMessage(1);
  }
}

static void saveWindowPlace() {
  WINDOWPLACEMENT wp{sizeof(wp)};
  if (!GetWindowPlacement(g_wnd, &wp)) return;
  RECT& r = wp.rcNormalPosition;
  setPref(L"window", std::to_wstring(r.left) + L"," + std::to_wstring(r.top) + L"," + std::to_wstring(r.right) + L"," + std::to_wstring(r.bottom) + L"," + (wp.showCmd == SW_SHOWMAXIMIZED ? L"1" : L"0"));
}

/** Phase 75: the window's own hit test while the page draws into the title area. DWM answers for
 *  its caption buttons first (hover, clicks and the snap layouts flyout on maximize). */
static LRESULT customFrameHitTest(HWND h, WPARAM wp, LPARAM lp) {
  LRESULT hit = DefWindowProcW(h, WM_NCHITTEST, wp, lp);
  if (hit != HTCLIENT) return hit;  // the side and bottom borders stay Windows' own
  POINT pt{GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
  ScreenToClient(h, &pt);
  RECT rc;
  GetClientRect(h, &rc);
  // DWM doesn't always answer for its buttons (maximized, the window hangs over the screen edge):
  // the same three buttons by position, so clicks, the restore button and snap layouts still work.
  RECT btn = captionButtons();
  if (!IsRectEmpty(&btn) && PtInRect(&btn, pt)) {
    int third = (btn.right - btn.left) / 3;
    if (pt.x < btn.left + third) return HTMINBUTTON;
    if (pt.x < btn.left + 2 * third) return HTMAXBUTTON;
    return HTCLOSE;
  }
  int band = topResizeBand();
  if (band > 0 && pt.y < band) {
    UINT dpi = windowDpi();
    int corner = GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi) + GetSystemMetricsForDpi(SM_CXSIZE, dpi) / 2;
    if (pt.x < corner) return HTTOPLEFT;
    if (pt.x >= rc.right - corner) return HTTOPRIGHT;
    return HTTOP;
  }
  // The strip beside the caption buttons (the page covers the rest and answers with app-region).
  if (pt.y < titlebarPx()) return HTCAPTION;
  return HTCLIENT;
}

static LRESULT CALLBACK WndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  if (g_customFrame) {
    LRESULT r = 0;
    if (DwmDefWindowProc(h, msg, wp, lp, &r)) return r;  // the caption buttons
  }
  switch (msg) {
    case WM_NCCALCSIZE:
      if (g_customFrame && wp) {
        // Keep Windows' left, right and bottom borders; take the title bar away (the page draws
        // there). Maximized, the window hangs over the screen edge by the border: keep it visible.
        auto* p = reinterpret_cast<NCCALCSIZE_PARAMS*>(lp);
        LONG top = p->rgrc[0].top;
        DefWindowProcW(h, msg, wp, lp);
        p->rgrc[0].top = top;
        if (IsZoomed(h)) {
          UINT dpi = GetDpiForWindow(h);
          p->rgrc[0].top += GetSystemMetricsForDpi(SM_CYSIZEFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
        }
        return 0;
      }
      break;
    case WM_NCHITTEST:
      if (g_customFrame) return customFrameHitTest(h, wp, lp);
      break;
    case WM_ACTIVATE:
      extendFrame();
      break;
    case WM_ERASEBKGND:
      return 1;  // WM_PAINT fills it (no flash of the old colour)
    case WM_PAINT: {
      // The top resize band and the place under the caption buttons: the theme colour, fully
      // opaque (plain GDI leaves alpha 0, which DWM shows see-through in the extended frame).
      PAINTSTRUCT ps;
      HDC dc = BeginPaint(h, &ps);
      HDC buf = nullptr;
      HPAINTBUFFER pb = BeginBufferedPaint(dc, &ps.rcPaint, BPBF_TOPDOWNDIB, nullptr, &buf);
      // With Mica all of it is see-through (black, alpha 0) and Mica shows.
      HBRUSH b = g_mica ? (HBRUSH)GetStockObject(BLACK_BRUSH) : CreateSolidBrush(themeColor());
      FillRect(pb ? buf : dc, &ps.rcPaint, b);
      if (!g_mica) DeleteObject(b);
      if (pb && g_customFrame && !g_pageTitle && !g_mica) {
        // The app's own title strip (the page doesn't draw one): her icon and "Sara".
        HDC t = buf;
        UINT dpi = windowDpi();
        int strip = titlebarPx(), icon = GetSystemMetricsForDpi(SM_CXSMICON, dpi), pad = MulDiv(14, (int)dpi, 96);
        int top = topResizeBand();
        int mid = top + (strip - top) / 2;
        if (HICON ic = (HICON)LoadImageW(g_inst, MAKEINTRESOURCEW(IDI_SARA), IMAGE_ICON, icon, icon, 0)) {
          DrawIconEx(t, pad, mid - icon / 2, ic, icon, icon, 0, nullptr, DI_NORMAL);
          DestroyIcon(ic);
        }
        NONCLIENTMETRICSW ncm{sizeof(ncm)};
        SystemParametersInfoForDpi(SPI_GETNONCLIENTMETRICS, sizeof(ncm), &ncm, 0, dpi);
        HFONT f = CreateFontIndirectW(&ncm.lfCaptionFont);
        HGDIOBJ oldFont = SelectObject(t, f);
        SetBkMode(t, TRANSPARENT);
        SetTextColor(t, g_day ? RGB(0x24, 0x1c, 0x2b) : RGB(0xee, 0xe9, 0xf3));
        RECT tr{pad + icon + MulDiv(10, (int)dpi, 96), top, MulDiv(400, (int)dpi, 96), strip};
        DrawTextW(t, L"Sara", -1, &tr, DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX);
        SelectObject(t, oldFont);
        DeleteObject(f);
      }
      if (pb) {
        BufferedPaintSetAlpha(pb, &ps.rcPaint, g_mica ? 0 : 255);
        // Under DWM's caption buttons: see-through (the frame there is the theme colour), or the
        // paint hides them.
        RECT btn = captionButtons();
        if (!IsRectEmpty(&btn)) {
          FillRect(buf, &btn, (HBRUSH)GetStockObject(BLACK_BRUSH));
          BufferedPaintSetAlpha(pb, &btn, 0);
        }
        EndBufferedPaint(pb, TRUE);
      }
      EndPaint(h, &ps);
      return 0;
    }
    case WM_DPICHANGED: {
      const RECT* r = reinterpret_cast<const RECT*>(lp);
      SetWindowPos(h, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
      extendFrame();
      layoutWebView();
      return 0;
    }
    case WM_SETTINGCHANGE:
      // Windows switched light/dark while the page follows the system.
      if (g_themePref == L"system" && lp && wcscmp(reinterpret_cast<const wchar_t*>(lp), L"ImmersiveColorSet") == 0 && resolveDay(L"system") != g_day) {
        g_day = !g_day;
        applyTheme();
      }
      break;
    case WM_SIZE:
      extendFrame();
      layoutWebView();
      return 0;
    case WM_CLOSE:
      saveWindowPlace();
      if (!g_quitting && prefOn(L"keepRunning", true)) {
        ShowWindow(h, SW_HIDE);
        if (!g_toldAboutTray && getPref(L"toldTray") != L"1") {
          g_toldAboutTray = true;
          setPref(L"toldTray", L"1");
          g_pendingConv.clear();
          notifyPlain(L"Sara is still here", L"She keeps running next to the clock so she can reach you. Right-click her icon to quit.");
        }
        return 0;
      }
      DestroyWindow(h);
      return 0;
    case WM_QUERYENDSESSION:
      return TRUE;
    case WM_ENDSESSION:
      // Windows is signing out, or an installer asks the app to close (Restart Manager): really quit.
      if (wp) {
        g_quitting = true;
        saveWindowPlace();
        DestroyWindow(h);
      }
      return 0;
    case WM_HOTKEY:
      // Phase 75 stage 2: the quick-ask shortcut, from any app.
      if (wp == kHotkeyId) toggleQuickAsk();
      return 0;
    case WM_DESTROY:
      UnregisterHotKey(h, kHotkeyId);
      sarahands::stop();  // Phase 87: the connection and the Sara browser close with the app
      saratoast::unregisterActivator();
      KillTimer(h, kNowTimer);
      closeQuickAskWebView();
      if (g_qa) DestroyWindow(g_qa);
      Shell_NotifyIconW(NIM_DELETE, &g_tray);
      PostQuitMessage(0);
      return 0;
    case WM_APP_SHOW:
      showWindow();
      return 0;
    case WM_APP_BALLOON:
      showBalloonNow();
      return 0;
    case WM_APP_SWITCH:
      if (!g_switchTo.empty()) {
        std::wstring id = g_switchTo, path = g_switchPath;
        g_switchTo.clear();
        showWindow();
        switchTo(id, path.empty() ? L"/" : path);
      }
      return 0;
    case WM_APP_REMOVED:
      afterRemove();
      return 0;
    case WM_APP_TOAST:
      runToastQueue();  // Phase 75 stage 3: clicks on her toasts
      return 0;
    case WM_COPYDATA: {
      // Phase 75 stage 3: a second start (Send To, Sara.exe <files>) hands its files over.
      auto* cd = reinterpret_cast<const COPYDATASTRUCT*>(lp);
      if (!cd || cd->dwData != kCopyFiles || !cd->lpData || cd->cbData == 0 || cd->cbData > 64 * 1024 || cd->cbData % sizeof(wchar_t)) return FALSE;
      std::wstring all(static_cast<const wchar_t*>(cd->lpData), cd->cbData / sizeof(wchar_t));
      std::vector<std::wstring> paths;
      size_t a = 0;
      for (size_t b; (b = all.find(L'\n', a)) != std::wstring::npos; a = b + 1) paths.push_back(all.substr(a, b - a));
      paths.push_back(all.substr(a));
      takeFiles(paths);
      return TRUE;
    }
    case WM_TIMER:
      if (wp == kRemoveTimer) finishRemove();
      if (wp == kNowTimer) refreshNow();
      return 0;
    case WM_APP_TRAY:
      switch (LOWORD(lp)) {
        case WM_LBUTTONUP:
        case NIN_SELECT:
        case NIN_KEYSELECT:
          showWindow();
          break;
        case WM_CONTEXTMENU:
        case WM_RBUTTONUP:
          trayMenu();
          break;
        case NIN_BALLOONUSERCLICK:
          showWindow();
          if (!g_pendingConv.empty() && g_web) g_web->PostWebMessageAsJson((L"{\"open\":\"" + jsonEscape(g_pendingConv) + L"\"}").c_str());
          g_pendingConv.clear();
          break;
      }
      return 0;
    case WM_COMMAND:
      switch (LOWORD(wp)) {
        case ID_OPEN: showWindow(); break;
        case ID_LOGIN: setStartAtLogin(!startAtLogin()); break;
        case ID_SETTINGS: openView(L"settings"); break;
        case ID_HELP: openView(L"help"); break;
        case ID_CHANGE: changeServerFromMenu(); break;
        case ID_HEADER: showWindow(); break;
        case ID_ASK: showQuickAsk(); break;
        case ID_SHORTCUT_OFF: setShortcut(L"off"); break;
        case ID_SENDTO: setSendTo(!sendToOn()); break;
        case ID_HANDS_STOP: sarahands::pressStop(); break;
        case ID_HANDS_OFF: handsOff(); break;
        case ID_HANDS_RESUME: sarahands::resume(); break;
        case ID_HANDS_LOG: {
          // Phase 88: her local record (plain text, no pictures), opened for the owner.
          std::wstring f = dataDir() + L"\\hands-log.txt";
          if (GetFileAttributesW(f.c_str()) == INVALID_FILE_ATTRIBUTES) CloseHandle(CreateFileW(f.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
          ShellExecuteW(nullptr, L"open", f.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
          break;
        }
        default:
          if (LOWORD(wp) >= ID_NOW0 && LOWORD(wp) < ID_NOW0 + kNowMax) {
            size_t i = LOWORD(wp) - ID_NOW0;
            if (i < g_menuNow.size()) {
              showWindow();
              openConversation(g_menuNow[i].conv);
            }
          } else if (LOWORD(wp) >= ID_ALLOW0 && LOWORD(wp) < ID_DENY0 + kNowMax) {
            // Allow / Deny an approval from the tray, as on its card in the chat.
            bool allow = LOWORD(wp) < ID_DENY0;
            size_t i = LOWORD(wp) - (allow ? ID_ALLOW0 : ID_DENY0);
            if (i < g_menuNow.size() && g_menuNow[i].kind == L"approval") decideFromTray(g_menuNow[i].id, allow);
          } else if (LOWORD(wp) >= ID_SHORTCUT0 && LOWORD(wp) < ID_SHORTCUT0 + std::size(kShortcuts)) {
            setShortcut(kShortcuts[LOWORD(wp) - ID_SHORTCUT0].id);
          }
          if (LOWORD(wp) >= ID_SERVER0 && LOWORD(wp) < ID_SERVER0 + 50) {
            auto list = profiles();
            size_t i = LOWORD(wp) - ID_SERVER0;
            if (i < list.size()) {
              showWindow();
              switchTo(list[i].id);
            }
          }
          break;
        case ID_QUIT:
          g_quitting = true;
          SendMessageW(h, WM_CLOSE, 0, 0);
          break;
      }
      return 0;
  }
  return DefWindowProcW(h, msg, wp, lp);
}

/** Phase 75 stage 3: the running Sara's window, for a second start (shared by name, so a test run
 *  and the real app never find each other's window by its class). */
static HANDLE g_windowShare = nullptr;
static const wchar_t* windowShareName() { return testRun() ? L"Local\\SaraDesktopAppTestWindow" : L"Local\\SaraDesktopAppWindow"; }
static void shareWindow(HWND w) {
  g_windowShare = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(unsigned long long), windowShareName());
  if (!g_windowShare) return;
  if (auto* v = static_cast<unsigned long long*>(MapViewOfFile(g_windowShare, FILE_MAP_WRITE, 0, 0, sizeof(unsigned long long)))) {
    *v = (unsigned long long)(ULONG_PTR)w;
    UnmapViewOfFile(v);
  }
}
static HWND sharedWindow() {
  HWND w = nullptr;
  if (HANDLE m = OpenFileMappingW(FILE_MAP_READ, FALSE, windowShareName())) {
    if (auto* v = static_cast<unsigned long long*>(MapViewOfFile(m, FILE_MAP_READ, 0, 0, sizeof(unsigned long long)))) {
      w = (HWND)(ULONG_PTR)*v;
      UnmapViewOfFile(v);
    }
    CloseHandle(m);
  }
  wchar_t cls[64] = L"";
  if (w && (!IsWindow(w) || !GetClassNameW(w, cls, 64) || wcscmp(cls, kWindowClass) != 0)) w = nullptr;
  // A Sara from before 2.7 doesn't share it: found by its class, as before (never for a test run).
  if (!w && !testRun()) w = FindWindowW(kWindowClass, nullptr);
  return w;
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, LPWSTR cmd, int show) {
  g_inst = inst;
  bool background = wcsstr(cmd, L"--background") != nullptr;
  bool portable = wcsstr(cmd, L"--portable") != nullptr;
  // Phase 75 stage 3: who she is to Windows (toasts, taskbar); started by a click on a toast
  // (-ToastActivated, COM's -Embedding); files from Send To or "Sara.exe <files>".
  SetCurrentProcessExplicitAppUserModelID(aumid());
  bool fromToast = wcsstr(cmd, L"-ToastActivated") != nullptr || wcsstr(cmd, L"-Embedding") != nullptr;
  if (fromToast) background = true;  // the click itself says whether to show the window
  std::vector<std::wstring> files;
  {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    for (int i = 1; argv && i < argc; i++) {
      if (wcscmp(argv[i], L"--server") == 0) {
        i++;
        continue;
      }
      if (argv[i][0] == L'-') continue;  // --background, --portable, -ToastActivated, …
      files.push_back(argv[i]);
    }
    if (argv) LocalFree(argv);
    files = realFiles(files);
  }
  if (wcsstr(cmd, L"--uninstall")) {
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    uninstall();
    return 0;
  }
  // One Sara at a time: a second start just shows the first.
  HANDLE single = CreateMutexW(nullptr, TRUE, testRun() ? L"Local\\SaraDesktopAppTest" : L"Local\\SaraDesktopApp");
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    // Phase 75 stage 3: files go to the running Sara (WM_COPYDATA); otherwise she just shows up.
    if (HWND other = sharedWindow()) {
      DWORD pid = 0;
      GetWindowThreadProcessId(other, &pid);
      AllowSetForegroundWindow(pid);
      if (!files.empty()) {
        std::wstring all;
        for (auto& f : files) all += (all.empty() ? L"" : L"\n") + f;
        COPYDATASTRUCT cd{kCopyFiles, (DWORD)(all.size() * sizeof(wchar_t)), all.data()};
        DWORD_PTR r = 0;
        SendMessageTimeoutW(other, WM_COPYDATA, 0, (LPARAM)&cd, SMTO_ABORTIFHUNG, 5000, &r);
      } else if (!fromToast) PostMessageW(other, WM_APP_SHOW, 0, 0);
    }
    return 0;
  }
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (!portable && !installedBySetup() && installIfNeeded()) {
    CloseHandle(single);
    return 0;
  }
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  g_server = getPref(L"server");
  // Phase 46c: the installer's "Open Sara" passes the address of the server it just installed.
  {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    for (int i = 1; argv && i + 1 < argc; i++) {
      if (wcscmp(argv[i], L"--server") != 0) continue;
      std::wstring o = originOf(argv[i + 1]);
      if (!o.empty()) {
        g_server = o;
        setPref(L"server", o);
        setPref(L"lastServer", o);
      }
    }
    if (argv) LocalFree(argv);
  }
  // Phase 68: the saved servers. Before 1.8 there was one: it becomes s1 with its sign-in. An
  // address set by the installer or --server is a saved one again, or added next to the others.
  migrateProfiles();
  if (!g_server.empty()) activate(profileFor(g_server));
  else {
    std::wstring act = getIni(L"servers", L"active");
    if (!act.empty() && !loadProfile(act).url.empty()) activate(act);
  }

  // Phase 75: the last theme the page showed, and whether the page can draw into the title area:
  // Windows 11 (DWM draws the caption buttons over the page) and a WebView2 runtime with CSS
  // app-region support (ICoreWebView2Settings9, runtime 123+); otherwise the normal title bar.
  g_themePref = getPref(L"theme", L"night");
  if (g_themePref != L"day" && g_themePref != L"system") g_themePref = L"night";
  g_day = resolveDay(g_themePref);
  g_wantMica = getPref(L"backdrop") == L"mica" && windowsBuild() >= 22621;
  {
    LPWSTR rt = nullptr;
    int cmp = -1;
    if (SUCCEEDED(GetAvailableCoreWebView2BrowserVersionString(nullptr, &rt)) && rt) CompareBrowserVersions(rt, L"123.0.2420.47", &cmp);
    logLine(std::wstring(L"WebView2 runtime ") + (rt ? rt : L"(none)") + L", Windows build " + std::to_wstring(windowsBuild()));
    CoTaskMemFree(rt);
    g_wantCustomFrame = windowsBuild() >= 22000 && cmp >= 0;
#ifdef SARA_TEST_HOOKS
    wchar_t f[32];
    if (GetEnvironmentVariableW(L"SARA_DESKTOP_FRAME", f, 32) > 0 && wcscmp(f, L"classic") == 0) g_wantCustomFrame = false;
#endif
    g_customFrame = g_wantCustomFrame;
  }
  BufferedPaintInit();

  WNDCLASSEXW wc{sizeof(wc)};
  wc.lpfnWndProc = WndProc;
  wc.hInstance = inst;
  wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(IDI_SARA));
  wc.hIconSm = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(IDI_SARA), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), 0);
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  g_bgBrush = CreateSolidBrush(themeColor());
  wc.hbrBackground = g_bgBrush;
  wc.lpszClassName = kWindowClass;
  RegisterClassExW(&wc);

  int x = CW_USEDEFAULT, y = CW_USEDEFAULT, w = 1100, hgt = 780;
  bool maximized = false;
  std::wstring place = getPref(L"window");
  int l, t, r, b, mx;
  if (swscanf_s(place.c_str(), L"%d,%d,%d,%d,%d", &l, &t, &r, &b, &mx) == 5 && r - l > 300 && b - t > 300) {
    x = l; y = t; w = r - l; hgt = b - t; maximized = mx == 1;
  }
  g_wnd = CreateWindowExW(0, kWindowClass, testRun() ? L"Sara (TEST)" : L"Sara", WS_OVERLAPPEDWINDOW, x, y, w, hgt, nullptr, nullptr, inst, nullptr);
  applyTheme();
  if (g_customFrame) {
    extendFrame();
    SetWindowPos(g_wnd, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  }
  addTray();
  shareWindow(g_wnd);
  // Phase 75 stage 3: toasts (and clicks on them, also the one that started us) and Send To.
  initToasts();
  ensureSendTo();
  // Phase 75 stage 2: the quick-ask shortcut (a clash is said once per start), "Now" every 45 s.
  registerShortcut(true);
  SetTimer(g_wnd, kNowTimer, 45000, nullptr);
  if (!background || !files.empty()) ShowWindow(g_wnd, maximized ? SW_SHOWMAXIMIZED : show);
  createWebView();
  if (!files.empty()) takeFiles(files);  // attached once her page has loaded
  if (!g_toastQueue.empty()) PostMessageW(g_wnd, WM_APP_TOAST, 0, 0);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0)) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  BufferedPaintUnInit();
  CoUninitialize();
  if (g_windowShare) CloseHandle(g_windowShare);
  CloseHandle(single);
  return (int)msg.wParam;
}
