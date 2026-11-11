// 3.4.x: the person's own files, read only. See hands-files.h for the rules (src/hands-files.ts is the
// reference the server's tests use; keep the two the same).
#define NOMINMAX
#include "hands-files.h"

#include <windows.h>
#include <shlobj.h>

#include <algorithm>
#include <cwctype>
#include <mutex>
#include <regex>
#include <string>
#include <vector>

#include "hands-screen.h"

namespace sarafiles {
namespace {

constexpr int kMaxEntries = 200;
constexpr DWORD kMaxReadBytes = 1024 * 1024;
constexpr int kMaxChars = 32000;
constexpr size_t kMaxPath = 260;

std::mutex g_m;
std::wstring g_testRoot;

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
std::string jq(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"') o += "\\\"";
    else if (c == '\\') o += "\\\\";
    else if (c == '\n') o += "\\n";
    else if (c == '\r') o += "\\r";
    else if (c == '\t') o += "\\t";
    else if (c < 0x20) {
      char b[8];
      snprintf(b, sizeof b, "\\u%04x", c);
      o += b;
    } else o += (char)c;
  }
  return o + "\"";
}
std::wstring lowerW(std::wstring s) {
  for (auto& c : s) c = (wchar_t)towlower(c);
  return s;
}
Reply fail(const char* code, const std::string& message) { return {{}, code, message}; }

/** The folder's display name and its real path (test runs: inside the test folder). */
bool rootOf(const std::string& folderRaw, std::string& key, std::wstring& path) {
  std::string f;
  for (char c : folderRaw) f += (char)tolower((unsigned char)c);
  if (f.rfind("my ", 0) == 0) f = f.substr(3);
  const KNOWNFOLDERID* id = nullptr;
  if (f == "desktop") key = "desktop", id = &FOLDERID_Desktop;
  else if (f == "documents" || f == "document" || f == "docs") key = "documents", id = &FOLDERID_Documents;
  else if (f == "downloads" || f == "download") key = "downloads", id = &FOLDERID_Downloads;
  else return false;
  {
    std::lock_guard<std::mutex> l(g_m);
    if (!g_testRoot.empty()) {
      path = g_testRoot + L"\\" + (key == "desktop" ? L"Desktop" : key == "documents" ? L"Documents" : L"Downloads");
      return true;
    }
  }
  wchar_t* p = nullptr;
  if (FAILED(SHGetKnownFolderPath(*id, 0, nullptr, &p))) return false;
  path = p;
  CoTaskMemFree(p);
  return true;
}

bool hiddenName(const std::wstring& n) {
  std::wstring l = lowerW(n);
  return n.empty() || n[0] == L'.' || l == L"desktop.ini" || l == L"thumbs.db" || l == L"$recycle.bin" || l.rfind(L"ntuser.dat", 0) == 0;
}
bool secretName(const std::wstring& n) {
  static const std::wregex kSecret[] = {
      std::wregex(LR"(^\.env(\..*)?$)", std::regex::icase), std::wregex(LR"(^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$)", std::regex::icase),
      std::wregex(LR"(\.(pem|key|pfx|p12|ppk|kdbx|kdb|keychain|keychain-db|jks|keystore|gpg|asc|ovpn|sqlite-wal)$)", std::regex::icase),
      std::wregex(LR"(^wallet\.dat$)", std::regex::icase), std::wregex(LR"(^\.?netrc$)", std::regex::icase), std::wregex(LR"(^credentials(\.json)?$)", std::regex::icase),
      std::wregex(LR"(^\.?npmrc$)", std::regex::icase), std::wregex(LR"(^\.?git-credentials$)", std::regex::icase), std::wregex(LR"(passwords?\b)", std::regex::icase),
      std::wregex(LR"(recovery[ _-]?(codes?|key))", std::regex::icase), std::wregex(LR"(seed[ _-]?phrase)", std::regex::icase)};
  for (auto& re : kSecret)
    if (std::regex_search(n, re)) return true;
  return false;
}
bool textType(const std::wstring& name) {
  static const wchar_t* kTypes[] = {L".txt", L".md", L".markdown", L".csv", L".tsv", L".json", L".log", L".xml", L".html", L".htm", L".ini", L".cfg", L".conf", L".yaml", L".yml", L".toml", L".srt", L".vtt", L".text"};
  size_t dot = name.find_last_of(L'.');
  if (dot == std::wstring::npos) return false;
  std::wstring ext = lowerW(name.substr(dot));
  for (auto* t : kTypes)
    if (ext == t) return true;
  return false;
}

/** The relative path's parts, or an error message: no "..", ".", drives, colons, leading slashes, "~", UNC. */
bool cleanParts(const std::string& raw, std::vector<std::wstring>& parts, std::string& why) {
  std::wstring s = wide(raw);
  while (!s.empty() && (s.back() == L' ' || s.back() == L'\t')) s.pop_back();
  while (!s.empty() && (s.front() == L' ' || s.front() == L'\t')) s.erase(s.begin());
  if (s.empty()) return true;
  if (s.size() > kMaxPath) return why = "That path is too long.", false;
  for (wchar_t c : s)
    if (c < 0x20 || c == L'<' || c == L'>' || c == L'"' || c == L'|' || c == L'?' || c == L'*') return why = "That path has characters a file name can't have.", false;
  if (s[0] == L'\\' || s[0] == L'/' || s.find(L':') != std::wstring::npos || s[0] == L'~')
    return why = "Only a path inside Desktop, Documents or Downloads (like \"Projects/notes.txt\"), never a full path or another drive.", false;
  std::wstring cur;
  auto push = [&](std::wstring p) -> bool {
    if (p.empty()) return true;
    if (p.find_first_not_of(L'.') == std::wstring::npos) return why = "Only folders inside Desktop, Documents or Downloads: \"..\" is not allowed.", false;
    if (p.back() == L'.' || p.back() == L' ') return why = "That name ends with a dot or a space, which Windows doesn't allow.", false;
    parts.push_back(p);
    return true;
  };
  for (wchar_t c : s) {
    if (c == L'\\' || c == L'/') {
      if (!push(cur)) return false;
      cur.clear();
    } else cur += c;
  }
  return push(cur);
}

/** The final path of an open handle (links and junctions resolved), without the \\?\ prefix. */
std::wstring finalPath(HANDLE h) {
  wchar_t buf[2048];
  DWORD n = GetFinalPathNameByHandleW(h, buf, 2048, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!n || n >= 2048) return {};
  std::wstring p(buf, n);
  if (p.rfind(L"\\\\?\\UNC\\", 0) == 0) p = L"\\\\" + p.substr(8);
  else if (p.rfind(L"\\\\?\\", 0) == 0) p = p.substr(4);
  return p;
}
std::wstring realOf(const std::wstring& path, bool dir) {
  HANDLE h = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, dir ? FILE_FLAG_BACKUP_SEMANTICS : 0, nullptr);
  if (h == INVALID_HANDLE_VALUE) h = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (h == INVALID_HANDLE_VALUE) return {};
  std::wstring p = finalPath(h);
  CloseHandle(h);
  return p;
}
bool insideOf(const std::wstring& root, const std::wstring& full) {
  std::wstring r = lowerW(root), f = lowerW(full);
  if (!r.empty() && r.back() == L'\\') r.pop_back();
  return f == r || (f.size() > r.size() && f.compare(0, r.size(), r) == 0 && f[r.size()] == L'\\');
}
std::string isoOf(const FILETIME& ft) {
  SYSTEMTIME st;
  FileTimeToSystemTime(&ft, &st);
  char b[40];
  snprintf(b, sizeof b, "%04d-%02d-%02dT%02d:%02d:%02dZ", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
  return b;
}

/** folder + parts → the real path inside the folder's real path, or an error. */
Reply resolve(const std::string& folder, const std::string& path, std::string& key, std::wstring& rootReal, std::wstring& full, std::vector<std::wstring>& parts) {
  std::wstring root;
  if (!rootOf(folder, key, root)) return fail("denied_local", "Only Desktop, Documents or Downloads.");
  std::string why;
  if (!cleanParts(path, parts, why)) return fail("denied_local", why);
  for (auto& p : parts)
    if (hiddenName(p) || secretName(p)) return fail("denied_local", "That file or folder is hidden or looks like it holds secrets (keys, passwords): it is never read.");
  rootReal = realOf(root, true);
  if (rootReal.empty()) return fail("not_found", "That folder isn't on this computer.");
  std::wstring joined = rootReal;
  for (auto& p : parts) joined += L"\\" + p;
  DWORD attrs = GetFileAttributesW(joined.c_str());
  if (attrs == INVALID_FILE_ATTRIBUTES) return fail("not_found", "There is no such file or folder there.");
  if (!parts.empty() && (attrs & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM))) return fail("denied_local", "That file or folder is hidden: it is never read.");
  full = realOf(joined, (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0);
  if (full.empty()) return fail("not_found", "There is no such file or folder there.");
  // A link or junction that leads outside the folder is never followed.
  if (!insideOf(rootReal, full)) return fail("denied_local", "That points outside the folder (a link or junction): it is never followed.");
  return {};
}

std::string joinParts(const std::vector<std::wstring>& parts) {
  std::string o;
  for (auto& p : parts) o += (o.empty() ? "" : "/") + u8(p);
  return o;
}

}  // namespace

void setTestRoot(const std::wstring& dir) {
  std::lock_guard<std::mutex> l(g_m);
  g_testRoot = dir;
}

Reply list(const std::string& folder, const std::string& path) {
  std::string key;
  std::wstring rootReal, full;
  std::vector<std::wstring> parts;
  Reply r = resolve(folder, path, key, rootReal, full, parts);
  if (!r.code.empty()) return r;
  DWORD attrs = GetFileAttributesW(full.c_str());
  if (!(attrs & FILE_ATTRIBUTE_DIRECTORY)) return fail("not_found", "That is a file, not a folder (read it instead).");
  struct Entry {
    std::wstring name;
    bool dir;
    ULONGLONG bytes;
    FILETIME at;
  };
  std::vector<Entry> all;
  int hidden = 0;
  WIN32_FIND_DATAW fd;
  HANDLE f = FindFirstFileExW((full + L"\\*").c_str(), FindExInfoBasic, &fd, FindExSearchNameMatch, nullptr, FIND_FIRST_EX_LARGE_FETCH);
  if (f == INVALID_HANDLE_VALUE) return fail("not_found", "That folder can't be read.");
  do {
    std::wstring n = fd.cFileName;
    if (n == L"." || n == L"..") continue;
    if ((fd.dwFileAttributes & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM)) || hiddenName(n) || secretName(n)) {
      hidden++;
      continue;
    }
    bool dir = (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    // Links and junctions: listed only when they stay inside the folder (never followed out).
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
      std::wstring real = realOf(full + L"\\" + n, dir);
      if (real.empty() || !insideOf(rootReal, real)) {
        hidden++;
        continue;
      }
    }
    if (all.size() < 5000) all.push_back({n, dir, dir ? 0 : ((ULONGLONG)fd.nFileSizeHigh << 32) | fd.nFileSizeLow, fd.ftLastWriteTime});
  } while (FindNextFileW(f, &fd));
  FindClose(f);
  std::sort(all.begin(), all.end(), [](const Entry& a, const Entry& b) { return a.dir != b.dir ? a.dir : lowerW(a.name) < lowerW(b.name); });
  std::string o = "{\"folder\":" + jq(key) + ",\"path\":" + jq(joinParts(parts)) + ",\"entries\":[";
  int n = 0;
  for (auto& e : all) {
    if (n >= kMaxEntries) break;
    o += n++ ? "," : "";
    o += "{\"name\":" + jq(sarascreen::maskSecrets(u8(e.name))) + ",\"dir\":" + (e.dir ? "true" : "false") + (e.dir ? std::string() : ",\"bytes\":" + std::to_string(e.bytes)) + ",\"at\":" + jq(isoOf(e.at)) + "}";
  }
  o += "],\"total\":" + std::to_string(all.size()) + ",\"more\":" + ((int)all.size() > kMaxEntries ? "true" : "false") + ",\"hidden\":" + std::to_string(hidden) + "}";
  return {o, {}, {}};
}

Reply read(const std::string& folder, const std::string& path, int maxChars) {
  std::string key;
  std::wstring rootReal, full;
  std::vector<std::wstring> parts;
  Reply r = resolve(folder, path, key, rootReal, full, parts);
  if (!r.code.empty()) return r;
  if (parts.empty()) return fail("denied_local", "Say which file (its path inside the folder).");
  DWORD attrs = GetFileAttributesW(full.c_str());
  if (attrs & FILE_ATTRIBUTE_DIRECTORY) return fail("not_found", "That is a folder (list it instead).");
  if (!textType(parts.back())) return fail("denied_local", "Only text files can be read (.txt, .md, .csv, .json, .log, .xml, .html, .ini…). For a Word, PDF or picture file, ask the owner to send it in the chat.");
  // Opened for reading only, never for writing; shared so the person's apps keep working.
  HANDLE h = CreateFileW(full.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return fail("not_found", "That file can't be opened (another app may have it locked).");
  // Check the handle's own path again (the file can't have been swapped for a link in between).
  if (!insideOf(rootReal, finalPath(h))) {
    CloseHandle(h);
    return fail("denied_local", "That points outside the folder (a link or junction): it is never followed.");
  }
  LARGE_INTEGER size{};
  GetFileSizeEx(h, &size);
  if (size.QuadPart > (LONGLONG)kMaxReadBytes) {
    CloseHandle(h);
    return fail("denied_local", "That file is " + std::to_string(size.QuadPart / 1024) + " KB: only text files up to 1 MB are read.");
  }
  std::string buf((size_t)size.QuadPart, '\0');
  DWORD got = 0;
  BOOL ok = buf.empty() || ReadFile(h, buf.data(), (DWORD)buf.size(), &got, nullptr);
  FILETIME at{};
  GetFileTime(h, nullptr, nullptr, &at);
  CloseHandle(h);
  if (!ok) return fail("not_found", "That file can't be read.");
  buf.resize(got);
  if (buf.find('\0') != std::string::npos) {
    // UTF-16 text (Notepad's \"Unicode\") is text too.
    if (buf.size() >= 2 && (unsigned char)buf[0] == 0xFF && (unsigned char)buf[1] == 0xFE) {
      std::wstring w((const wchar_t*)(buf.data() + 2), (buf.size() - 2) / 2);
      buf = u8(w);
    } else return fail("denied_local", "That file is not text (it has binary data).");
  }
  if (buf.size() >= 3 && (unsigned char)buf[0] == 0xEF && (unsigned char)buf[1] == 0xBB && (unsigned char)buf[2] == 0xBF) buf.erase(0, 3);
  int max = std::clamp(maxChars <= 0 ? kMaxChars : maxChars, 500, kMaxChars);
  // Characters, not bytes: cut at a UTF-8 boundary.
  std::wstring w = wide(buf);
  bool more = (int)w.size() > max;
  if (more) w.resize(max);
  std::string o = "{\"folder\":" + jq(key) + ",\"path\":" + jq(joinParts(parts)) + ",\"name\":" + jq(sarascreen::maskSecrets(u8(parts.back()))) + ",\"bytes\":" + std::to_string(size.QuadPart) + ",\"at\":" + jq(isoOf(at)) +
                  ",\"text\":" + jq(sarascreen::maskSecrets(u8(w))) + ",\"more\":" + (more ? "true" : "false") + "}";
  return {o, {}, {}};
}

}  // namespace sarafiles
