// Phase 94 (CU7): the read-only check-up on Windows. See hands-checkup.h.
#include "hands-checkup.h"

#include <shlobj.h>
#include <knownfolders.h>
#include <shellapi.h>
#include <setupapi.h>
#include <batclass.h>
#include <wuapi.h>

#include <algorithm>
#include <cstdio>
#include <vector>

namespace saracheckup {
namespace {

std::string utf8(const std::wstring& w) {
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
std::string q(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"') o += "\\\"";
    else if (c == '\\') o += "\\\\";
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  return o + "\"";
}
std::string cut(const std::string& s, size_t n = 120) {
  if (s.size() <= n) return s;
  size_t i = n;
  while (i > 0 && ((unsigned char)s[i] & 0xC0) == 0x80) i--;  // never split a UTF-8 character
  return s.substr(0, i);
}
std::wstring known(REFKNOWNFOLDERID id) {
  PWSTR p = nullptr;
  std::wstring out;
  if (SUCCEEDED(SHGetKnownFolderPath(id, KF_FLAG_DONT_VERIFY, nullptr, &p)) && p) out = p;
  CoTaskMemFree(p);
  return out;
}
std::wstring env(const wchar_t* name) {
  wchar_t buf[MAX_PATH * 2]{};
  DWORD n = GetEnvironmentVariableW(name, buf, (DWORD)std::size(buf));
  return n && n < std::size(buf) ? std::wstring(buf, n) : std::wstring();
}
bool isDir(const std::wstring& p) {
  DWORD a = GetFileAttributesW(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

// ---- startup apps: the Run keys and the Startup folders, with Explorer's StartupApproved state ----
bool approved(HKEY root, const wchar_t* sub, const std::wstring& name) {
  // Explorer (Task Manager's Startup apps page) keeps the person's on/off choice here: an even first
  // byte (02, 06) is on, an odd one (03) is off; no value means on.
  HKEY k;
  if (RegOpenKeyExW(root, sub, 0, KEY_READ, &k) != ERROR_SUCCESS) return true;
  BYTE data[16]{};
  DWORD type = 0, size = sizeof data;
  LSTATUS st = RegQueryValueExW(k, name.c_str(), nullptr, &type, data, &size);
  RegCloseKey(k);
  if (st != ERROR_SUCCESS || type != REG_BINARY || size < 1) return true;
  return (data[0] & 1) == 0;
}
void runKey(Report& r, HKEY root, REGSAM view, const wchar_t* approvedKey, const char* prefix, const char* where) {
  HKEY k;
  if (RegOpenKeyExW(root, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", 0, KEY_READ | view, &k) != ERROR_SUCCESS) return;
  for (DWORD i = 0; r.startup.size() < kItems; i++) {
    wchar_t name[512];
    DWORD n = (DWORD)std::size(name);
    LSTATUS st = RegEnumValueW(k, i, name, &n, nullptr, nullptr, nullptr, nullptr);
    if (st == ERROR_NO_MORE_ITEMS) break;
    if (st != ERROR_SUCCESS || !n) continue;
    std::wstring nm(name, n);
    r.startup.push_back({std::string(prefix) + cut(utf8(nm), 70), cut(utf8(nm)), where, approved(root, approvedKey, nm)});
  }
  RegCloseKey(k);
}
void startupFolder(Report& r, const std::wstring& dir, HKEY approvedRoot, const char* prefix, const char* where) {
  if (dir.empty()) return;
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileExW((dir + L"\\*").c_str(), FindExInfoBasic, &fd, FindExSearchNameMatch, nullptr, 0);
  if (h == INVALID_HANDLE_VALUE) return;
  do {
    std::wstring f = fd.cFileName;
    if (f == L"." || f == L".." || _wcsicmp(f.c_str(), L"desktop.ini") == 0 || (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
    std::wstring shown = f;
    if (shown.size() > 4 && _wcsicmp(shown.c_str() + shown.size() - 4, L".lnk") == 0) shown.resize(shown.size() - 4);
    r.startup.push_back({std::string(prefix) + cut(utf8(f), 70), cut(utf8(shown)), where, approved(approvedRoot, L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder", f)});
  } while (r.startup.size() < kItems && FindNextFileW(h, &fd));
  FindClose(h);
}
void checkStartup(Report& r) {
  r.startupRan = true;
  runKey(r, HKEY_CURRENT_USER, 0, L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run", "run:", "user");
  runKey(r, HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY, L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run", "hklm:", "machine");
  runKey(r, HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY, L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32", "hklm32:", "machine");
  startupFolder(r, known(FOLDERID_Startup), HKEY_CURRENT_USER, "folder:", "folder");
  startupFolder(r, known(FOLDERID_CommonStartup), HKEY_LOCAL_MACHINE, "cfolder:", "machine");
  r.startupOk = true;
}

// ---- disks ----
void checkDisk(Report& r) {
  r.diskRan = true;
  wchar_t drives[512]{};
  DWORD n = GetLogicalDriveStringsW((DWORD)std::size(drives) - 1, drives);
  if (!n || n >= std::size(drives)) { r.diskWhy = "the drives could not be listed"; return; }
  for (const wchar_t* d = drives; *d && r.volumes.size() < 16; d += wcslen(d) + 1) {
    if (GetDriveTypeW(d) != DRIVE_FIXED) continue;
    ULARGE_INTEGER avail{}, total{}, freeAll{};
    if (!GetDiskFreeSpaceExW(d, &avail, &total, &freeAll)) continue;
    std::wstring name = d;
    if (!name.empty() && name.back() == L'\\') name.pop_back();
    r.volumes.push_back({utf8(name), total.QuadPart, avail.QuadPart});
  }
  r.diskOk = true;
}

// ---- a bounded folder walk (sizes only; never follows reparse points; never opens a file) ----
Size walk(const std::string& id, const std::string& name, const std::wstring& root, const std::function<bool()>& cancelled) {
  Size s{id, name};
  if (root.empty() || !isDir(root)) return s;
  const ULONGLONG start = GetTickCount64();
  size_t entries = 0;
  std::vector<std::wstring> stack{root};
  while (!stack.empty()) {
    std::wstring dir = std::move(stack.back());
    stack.pop_back();
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileExW((dir + L"\\*").c_str(), FindExInfoBasic, &fd, FindExSearchNameMatch, nullptr, FIND_FIRST_EX_LARGE_FETCH);
    if (h == INVALID_HANDLE_VALUE) continue;
    do {
      if (fd.cFileName[0] == L'.' && (!fd.cFileName[1] || (fd.cFileName[1] == L'.' && !fd.cFileName[2]))) continue;
      if (++entries > kWalkEntries || (entries % 512 == 0 && (GetTickCount64() - start > kWalkMs || (cancelled && cancelled())))) {
        s.partial = true;
        break;
      }
      if (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) continue;  // junctions, links, cloud placeholders' folders
      if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) stack.push_back(dir + L"\\" + fd.cFileName);
      else {
        s.bytes += ((uint64_t)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
        s.files++;
      }
    } while (FindNextFileW(h, &fd));
    FindClose(h);
    if (s.partial) break;
  }
  return s;
}
void checkFolders(Report& r, const std::function<bool()>& cancelled) {
  r.foldersRan = true;
  const struct { const char* id; const char* name; const KNOWNFOLDERID* kf; } list[] = {
      {"downloads", "Downloads", &FOLDERID_Downloads}, {"documents", "Documents", &FOLDERID_Documents}, {"desktop", "Desktop", &FOLDERID_Desktop},
      {"pictures", "Pictures", &FOLDERID_Pictures},    {"videos", "Videos", &FOLDERID_Videos},          {"music", "Music", &FOLDERID_Music}};
  for (auto& f : list) {
    if (cancelled && cancelled()) break;
    r.folders.push_back(walk(f.id, f.name, known(*f.kf), cancelled));
  }
  r.foldersOk = true;
}

// ---- updates: Windows Update's last check (offline search of what it already found) ----
template <class T> void release(T*& p) { if (p) { p->Release(); p = nullptr; } }
void checkUpdates(Report& r) {
  r.updatesRan = true;
  HRESULT init = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  IUpdateSession* session = nullptr;
  IUpdateSearcher* searcher = nullptr;
  ISearchResult* result = nullptr;
  IUpdateCollection* updates = nullptr;
  ISystemInformation* sys = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(UpdateSession), nullptr, CLSCTX_INPROC_SERVER, __uuidof(IUpdateSession), (void**)&session);
  if (SUCCEEDED(hr)) hr = session->CreateUpdateSearcher(&searcher);
  // Offline: only what Windows Update already found on its own last check (no new scan, nothing downloaded).
  if (SUCCEEDED(hr)) hr = searcher->put_Online(VARIANT_FALSE);
  BSTR criteria = SysAllocString(L"IsInstalled=0 and IsHidden=0");
  if (SUCCEEDED(hr)) hr = searcher->Search(criteria, &result);
  SysFreeString(criteria);
  if (SUCCEEDED(hr)) hr = result->get_Updates(&updates);
  if (SUCCEEDED(hr)) {
    LONG n = 0;
    updates->get_Count(&n);
    r.pending = n;
    for (LONG i = 0; i < n && i < 20; i++) {
      IUpdate* u = nullptr;
      if (SUCCEEDED(updates->get_Item(i, &u)) && u) {
        BSTR title = nullptr;
        if (SUCCEEDED(u->get_Title(&title)) && title) r.updateNames.push_back(cut(utf8(title)));
        SysFreeString(title);
        u->Release();
      }
    }
    r.updatesOk = true;
  } else {
    char b[96];
    snprintf(b, sizeof b, "Windows Update has no list from its last check here (0x%08lx)", (unsigned long)hr);
    r.updatesWhy = b;
  }
  if (SUCCEEDED(CoCreateInstance(__uuidof(SystemInformation), nullptr, CLSCTX_INPROC_SERVER, __uuidof(ISystemInformation), (void**)&sys))) {
    VARIANT_BOOL reboot = VARIANT_FALSE;
    if (SUCCEEDED(sys->get_RebootRequired(&reboot))) r.reboot = reboot == VARIANT_TRUE;
  }
  release(sys);
  release(updates);
  release(result);
  release(searcher);
  release(session);
  if (SUCCEEDED(init)) CoUninitialize();
}

// ---- battery: GetSystemPowerStatus, then the battery driver's capacities (IOCTL_BATTERY_QUERY_INFORMATION) ----
const GUID kBatteryClass = {0x72631e54, 0x78a4, 0x11d0, {0xbc, 0xf7, 0x00, 0xaa, 0x00, 0xb7, 0xb3, 0x2a}};  // GUID_DEVCLASS_BATTERY
void checkBattery(Report& r) {
  r.batteryRan = true;
  SYSTEM_POWER_STATUS ps{};
  if (!GetSystemPowerStatus(&ps)) { r.batteryWhy = "the power status could not be read"; return; }
  r.batteryOk = true;
  r.batteryPresent = !(ps.BatteryFlag & 128) && ps.BatteryFlag != 255;
  if (!r.batteryPresent) return;
  if (ps.BatteryLifePercent <= 100) r.percent = ps.BatteryLifePercent;
  r.charging = (ps.BatteryFlag & 8) != 0;
  HDEVINFO dev = SetupDiGetClassDevsW(&kBatteryClass, nullptr, nullptr, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
  if (dev == INVALID_HANDLE_VALUE) return;
  SP_DEVICE_INTERFACE_DATA did{sizeof did};
  if (SetupDiEnumDeviceInterfaces(dev, nullptr, &kBatteryClass, 0, &did)) {
    DWORD need = 0;
    SetupDiGetDeviceInterfaceDetailW(dev, &did, nullptr, 0, &need, nullptr);
    std::vector<BYTE> buf(need + sizeof(WCHAR));
    auto* detail = reinterpret_cast<SP_DEVICE_INTERFACE_DETAIL_DATA_W*>(buf.data());
    detail->cbSize = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W);
    if (need && SetupDiGetDeviceInterfaceDetailW(dev, &did, detail, need, nullptr, nullptr)) {
      HANDLE b = CreateFileW(detail->DevicePath, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
      if (b != INVALID_HANDLE_VALUE) {
        ULONG wait = 0, tag = 0;
        DWORD got = 0;
        if (DeviceIoControl(b, IOCTL_BATTERY_QUERY_TAG, &wait, sizeof wait, &tag, sizeof tag, &got, nullptr) && tag) {
          BATTERY_QUERY_INFORMATION bqi{};
          bqi.BatteryTag = tag;
          bqi.InformationLevel = BatteryInformation;
          BATTERY_INFORMATION bi{};
          if (DeviceIoControl(b, IOCTL_BATTERY_QUERY_INFORMATION, &bqi, sizeof bqi, &bi, sizeof bi, &got, nullptr)) {
            if (bi.DesignedCapacity > 0 && bi.FullChargedCapacity > 0) r.health = (int)std::min<ULONGLONG>(100, (ULONGLONG)bi.FullChargedCapacity * 100 / bi.DesignedCapacity);
            if (bi.CycleCount > 0) r.cycles = (long)bi.CycleCount;
          }
        }
        CloseHandle(b);
      }
    }
  }
  SetupDiDestroyDeviceInfoList(dev);
}

// ---- extensions in the person's own browsers (manifest names only; nothing is changed) ----
std::string readSmall(const std::wstring& path, size_t max = 256 * 1024) {
  HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return {};
  std::string s(max, '\0');
  DWORD got = 0;
  if (!ReadFile(h, s.data(), (DWORD)max, &got, nullptr)) got = 0;
  CloseHandle(h);
  s.resize(got);
  if (s.size() >= 3 && (unsigned char)s[0] == 0xEF && (unsigned char)s[1] == 0xBB && (unsigned char)s[2] == 0xBF) s.erase(0, 3);
  return s;
}
/** The string value of the first "key": "…" in a JSON text (enough for a manifest's top-level name). */
std::string field(const std::string& j, const std::string& key) {
  size_t at = j.find("\"" + key + "\"");
  if (at == std::string::npos) return {};
  at = j.find(':', at + key.size() + 2);
  if (at == std::string::npos) return {};
  at = j.find_first_not_of(" \t\r\n", at + 1);
  if (at == std::string::npos || j[at] != '"') return {};
  std::string out;
  for (size_t i = at + 1; i < j.size() && out.size() < 400; i++) {
    if (j[i] == '\\' && i + 1 < j.size()) { out += j[++i] == 'n' ? ' ' : j[i]; continue; }
    if (j[i] == '"') break;
    out += j[i];
  }
  return out;
}
std::string lower(std::string s) { for (auto& c : s) c = (char)tolower((unsigned char)c); return s; }
std::string extensionName(const std::wstring& dir) {
  std::string m = readSmall(dir + L"\\manifest.json");
  std::string name = field(m, "name");
  if (name.rfind("__MSG_", 0) == 0 && name.size() > 8) {
    std::string key = lower(name.substr(6, name.size() - 8));
    std::string loc = field(m, "default_locale");
    for (const std::string& l : {loc, std::string("en"), std::string("en_US")}) {
      if (l.empty()) continue;
      std::string msgs = readSmall(dir + L"\\_locales\\" + wide(l) + L"\\messages.json");
      // Keys are case-insensitive: find it in a lower-cased copy, read the message from the same place.
      std::string low = lower(msgs);
      size_t at = low.find("\"" + key + "\"");
      if (at == std::string::npos) continue;
      std::string v = field(msgs.substr(at), "message");
      if (!v.empty()) return v;
    }
    return {};
  }
  return name;
}
void browserProfiles(Report& r, const char* browser, const std::wstring& userData) {
  if (userData.empty() || !isDir(userData)) return;
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileExW((userData + L"\\*").c_str(), FindExInfoBasic, &fd, FindExSearchNameMatch, nullptr, 0);
  if (h == INVALID_HANDLE_VALUE) return;
  do {
    std::wstring prof = fd.cFileName;
    if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (prof != L"Default" && prof.rfind(L"Profile ", 0) != 0)) continue;
    std::wstring ext = userData + L"\\" + prof + L"\\Extensions";
    if (!isDir(ext)) continue;
    Browser b{browser, utf8(prof)};
    WIN32_FIND_DATAW e;
    HANDLE he = FindFirstFileExW((ext + L"\\*").c_str(), FindExInfoBasic, &e, FindExSearchNameMatch, nullptr, 0);
    if (he != INVALID_HANDLE_VALUE) {
      do {
        std::wstring id = e.cFileName;
        if (!(e.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || id == L"." || id == L".." || id == L"Temp") continue;
        // The newest version folder holds the manifest.
        std::wstring best;
        WIN32_FIND_DATAW v;
        HANDLE hv = FindFirstFileExW((ext + L"\\" + id + L"\\*").c_str(), FindExInfoBasic, &v, FindExSearchNameMatch, nullptr, 0);
        if (hv != INVALID_HANDLE_VALUE) {
          do if ((v.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && v.cFileName[0] != L'.' && std::wstring(v.cFileName) > best) best = v.cFileName;
          while (FindNextFileW(hv, &v));
          FindClose(hv);
        }
        if (best.empty()) continue;
        std::string name = extensionName(ext + L"\\" + id + L"\\" + best);
        if (!name.empty()) b.extensions.push_back({cut(utf8(id), 64), cut(name)});
      } while (b.extensions.size() < 200 && FindNextFileW(he, &e));
      FindClose(he);
    }
    r.browsers.push_back(std::move(b));
  } while (r.browsers.size() < 8 && FindNextFileW(h, &fd));
  FindClose(h);
}
void checkExtensions(Report& r) {
  r.extensionsRan = true;
  std::wstring local = known(FOLDERID_LocalAppData);
  if (local.empty()) { r.extensionsWhy = "no local app data folder"; return; }
  browserProfiles(r, "edge", local + L"\\Microsoft\\Edge\\User Data");
  browserProfiles(r, "chrome", local + L"\\Google\\Chrome\\User Data");
  browserProfiles(r, "brave", local + L"\\BraveSoftware\\Brave-Browser\\User Data");
  r.extensionsOk = true;
}

// ---- temporary files, browser caches, the Recycle Bin ----
void checkTemp(Report& r, const std::function<bool()>& cancelled) {
  r.tempRan = true;
  wchar_t tmp[MAX_PATH + 2]{};
  DWORD n = GetTempPathW((DWORD)std::size(tmp), tmp);
  std::wstring t = n ? std::wstring(tmp, n) : std::wstring();
  while (!t.empty() && t.back() == L'\\') t.pop_back();
  r.temp.push_back(walk("temp", "Temporary files", t, cancelled));
  std::wstring local = known(FOLDERID_LocalAppData);
  Size caches{"browser-cache", "Browser caches"};
  for (const wchar_t* b : {L"\\Microsoft\\Edge\\User Data\\Default", L"\\Google\\Chrome\\User Data\\Default", L"\\BraveSoftware\\Brave-Browser\\User Data\\Default"}) {
    for (const wchar_t* c : {L"\\Cache", L"\\Code Cache"}) {
      Size s = walk("x", "x", local.empty() ? std::wstring() : local + b + c, cancelled);
      caches.bytes += s.bytes;
      caches.files += s.files;
      caches.partial = caches.partial || s.partial;
    }
  }
  r.temp.push_back(caches);
  SHQUERYRBINFO rb{sizeof rb};
  if (SUCCEEDED(SHQueryRecycleBinW(nullptr, &rb))) r.temp.push_back({"trash", "Recycle Bin", (uint64_t)rb.i64Size, (uint64_t)rb.i64NumItems});
  r.tempOk = true;
}

bool wants(const std::vector<std::string>& checks, const char* k) {
  return checks.empty() || std::find(checks.begin(), checks.end(), k) != checks.end();
}
std::string sizesJson(const std::vector<Size>& v) {
  std::string o = "[";
  for (auto& s : v) o += (o.size() > 1 ? "," : "") + std::string("{\"id\":") + q(s.id) + ",\"name\":" + q(s.name) + ",\"bytes\":" + std::to_string(s.bytes) + ",\"files\":" + std::to_string(s.files) + (s.partial ? ",\"partial\":true" : "") + "}";
  return o + "]";
}
std::string no(const std::string& why) { return "{\"ok\":false,\"why\":" + q(why.empty() ? "not available on this computer" : why) + "}"; }

}  // namespace

Report collect(const std::vector<std::string>& checks, const std::function<bool()>& cancelled) {
  Report r;
  OSVERSIONINFOEXW v{sizeof v};
  // RtlGetVersion tells the real build (GetVersionEx is shimmed for apps without a manifest entry).
  if (auto fn = (LONG(WINAPI*)(OSVERSIONINFOEXW*))GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion")) fn(&v);
  r.os = "windows " + std::to_string(v.dwMajorVersion) + "." + std::to_string(v.dwMinorVersion) + "." + std::to_string(v.dwBuildNumber);
  if (wants(checks, "startup")) checkStartup(r);
  if (wants(checks, "disk")) checkDisk(r);
  if (wants(checks, "folders")) checkFolders(r, cancelled);
  if (wants(checks, "updates")) checkUpdates(r);
  if (wants(checks, "battery")) checkBattery(r);
  if (wants(checks, "extensions")) checkExtensions(r);
  if (wants(checks, "temp")) checkTemp(r, cancelled);
  return r;
}

std::string toJson(const Report& r) {
  SYSTEMTIME st;
  GetSystemTime(&st);
  char at[40];
  snprintf(at, sizeof at, "%04u-%02u-%02uT%02u:%02u:%02uZ", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
  std::string c;
  auto add = [](std::string& c, const char* k, const std::string& v) { c += (c.empty() ? "" : ",") + std::string("\"") + k + "\":" + v; };
  if (r.startupRan) {
    std::string items = "[";
    for (auto& s : r.startup) items += (items.size() > 1 ? "," : "") + std::string("{\"id\":") + q(s.id) + ",\"name\":" + q(s.name) + ",\"where\":" + q(s.where) + ",\"enabled\":" + (s.enabled ? "true" : "false") + "}";
    add(c, "startup", r.startupOk ? "{\"ok\":true,\"items\":" + items + "],\"total\":" + std::to_string(r.startup.size()) + "}" : no(r.startupWhy));
  }
  if (r.diskRan) {
    std::string vols = "[";
    for (auto& v : r.volumes) vols += (vols.size() > 1 ? "," : "") + std::string("{\"name\":") + q(v.name) + ",\"total\":" + std::to_string(v.total) + ",\"free\":" + std::to_string(v.free) + "}";
    add(c, "disk", r.diskOk ? "{\"ok\":true,\"volumes\":" + vols + "]}" : no(r.diskWhy));
  }
  if (r.foldersRan) add(c, "folders", r.foldersOk ? "{\"ok\":true,\"folders\":" + sizesJson(r.folders) + "}" : no(r.foldersWhy));
  if (r.updatesRan) {
    std::string names = "[";
    for (auto& n : r.updateNames) names += (names.size() > 1 ? "," : "") + q(n);
    add(c, "updates", r.updatesOk ? "{\"ok\":true,\"pending\":" + std::to_string(r.pending) + ",\"reboot\":" + (r.reboot ? "true" : "false") + ",\"names\":" + names + "],\"source\":\"Windows Update's last check\"}" : no(r.updatesWhy));
  }
  if (r.batteryRan) {
    std::string b = "{\"ok\":true,\"present\":" + std::string(r.batteryPresent ? "true" : "false");
    if (r.batteryPresent) {
      if (r.percent >= 0) b += ",\"percent\":" + std::to_string(r.percent);
      b += std::string(",\"charging\":") + (r.charging ? "true" : "false");
      if (r.health >= 0) b += ",\"health\":" + std::to_string(r.health);
      if (r.cycles >= 0) b += ",\"cycles\":" + std::to_string(r.cycles);
    }
    add(c, "battery", r.batteryOk ? b + "}" : no(r.batteryWhy));
  }
  if (r.extensionsRan) {
    std::string bs = "[";
    for (auto& b : r.browsers) {
      std::string ex = "[";
      for (auto& e : b.extensions) ex += (ex.size() > 1 ? "," : "") + std::string("{\"id\":") + q(e.id) + ",\"name\":" + q(e.name) + ",\"enabled\":true}";
      bs += (bs.size() > 1 ? "," : "") + std::string("{\"browser\":") + q(b.browser) + ",\"profile\":" + q(b.profile) + ",\"extensions\":" + ex + "]}";
    }
    add(c, "extensions", r.extensionsOk ? "{\"ok\":true,\"browsers\":" + bs + "]}" : no(r.extensionsWhy));
  }
  if (r.tempRan) add(c, "temp", r.tempOk ? "{\"ok\":true,\"places\":" + sizesJson(r.temp) + "}" : no(r.tempWhy));
  return "{\"os\":" + q(r.os) + ",\"at\":" + q(at) + ",\"checks\":{" + c + "}}";
}

}  // namespace saracheckup
