// Drop files in, save her documents out (docs/desktop.md): see save-files.h.
#include "save-files.h"

#include <shlobj.h>
#include <shobjidl.h>
#include <shellapi.h>
#include <wrl.h>

#include <deque>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

namespace sarasave {
namespace {

Host g_host;
ComPtr<ICoreWebView2> g_web;
EventRegistrationToken g_downloadToken{};

/** A save the page asked for, waiting for its download to start, then to finish. */
struct Intent {
  std::wstring id;    // the page's call id (answered when the file is there, or it failed)
  std::wstring uri;   // the full address of her file
  std::wstring name;  // the file name the page showed
  std::wstring mode;  // ask | downloads | auto
  ULONGLONG at = 0;
  bool started = false;  // its download began (the Save window may be open)
  std::wstring path;  // where it goes (once picked)
  ComPtr<ICoreWebView2DownloadOperation> op;
};
std::vector<Intent*> g_intents;
std::map<std::wstring, std::wstring> g_saved;  // token → path (Open / Show in folder)
int g_nextToken = 1;
std::deque<std::function<void()>> g_later;

std::wstring esc(const std::wstring& s) {
  std::wstring o;
  for (wchar_t c : s) {
    if (c == L'"') o += L"\\\"";
    else if (c == L'\\') o += L"\\\\";
    else if (c < 0x20) { wchar_t b[8]; swprintf(b, 8, L"\\u%04x", c); o += b; }
    else o += c;
  }
  return o;
}
void log(const std::wstring& s) { if (g_host.log) g_host.log(L"save: " + s); }
std::wstring pref(const wchar_t* k) { return g_host.getPref ? g_host.getPref(k) : L""; }
void setPref(const wchar_t* k, const std::wstring& v) { if (g_host.setPref) g_host.setPref(k, v); }
void reply(const std::wstring& id, const std::wstring& json, const std::wstring& err = L"") { if (g_host.reply) g_host.reply(id, json, err); }

/** Runs `f` from the message loop (not inside a WebView2 event: the Save window is modal). */
void later(std::function<void()> f) {
  g_later.push_back(std::move(f));
  SetTimer(nullptr, 0, 0, [](HWND, UINT, UINT_PTR t, DWORD) {
    KillTimer(nullptr, t);
    if (g_later.empty()) return;
    auto f = std::move(g_later.front());
    g_later.pop_front();
    f();
  });
}

bool isDir(const std::wstring& p) {
  DWORD a = GetFileAttributesW(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}
std::wstring known(REFKNOWNFOLDERID id) {
  wchar_t* p = nullptr;
  std::wstring out;
  if (SUCCEEDED(SHGetKnownFolderPath(id, KF_FLAG_CREATE, nullptr, &p))) out = p;
  CoTaskMemFree(p);
  return out;
}
std::wstring downloadsDir() {
  if (!g_host.testDir.empty()) {
    std::wstring d = g_host.testDir + L"\\Downloads";
    CreateDirectoryW(d.c_str(), nullptr);
    return d;
  }
  return known(FOLDERID_Downloads);
}
std::wstring documentsDir() {
  if (!g_host.testDir.empty()) {
    std::wstring d = g_host.testDir + L"\\Documents";
    CreateDirectoryW(d.c_str(), nullptr);
    return d;
  }
  return known(FOLDERID_Documents);
}
/** Her folder for documents (made the first time: Documents\Sara). */
std::wstring autoDir(bool create) {
  std::wstring d = pref(L"docsAutoDir");
  if (d.empty()) d = documentsDir() + L"\\Sara";
  if (create) SHCreateDirectoryExW(nullptr, d.c_str(), nullptr);
  return d;
}
std::wstring parentOf(const std::wstring& p) {
  size_t i = p.find_last_of(L'\\');
  return i == std::wstring::npos ? L"" : p.substr(0, i);
}
std::wstring fileOf(const std::wstring& p) {
  size_t i = p.find_last_of(L'\\');
  return i == std::wstring::npos ? p : p.substr(i + 1);
}

std::wstring pickSave(const std::wstring& name) {
  ComPtr<IFileSaveDialog> dlg;
  if (FAILED(CoCreateInstance(CLSID_FileSaveDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg)))) return L"";
  std::wstring start = pref(L"saveLastDir");
  if (start.empty() || !isDir(start)) start = documentsDir();
  ComPtr<IShellItem> folder;
  if (SUCCEEDED(SHCreateItemFromParsingName(start.c_str(), nullptr, IID_PPV_ARGS(&folder)))) dlg->SetFolder(folder.Get());
  dlg->SetFileName(name.c_str());
  size_t dot = name.find_last_of(L'.');
  std::wstring ext = dot == std::wstring::npos ? L"" : name.substr(dot + 1);
  std::wstring spec = L"*." + ext, all = L"*.*";
  std::wstring label = ext.empty() ? L"" : L"." + ext + L" file";
  COMDLG_FILTERSPEC types[2] = {{label.c_str(), spec.c_str()}, {L"All files", all.c_str()}};
  if (!ext.empty()) {
    dlg->SetFileTypes(2, types);
    dlg->SetDefaultExtension(ext.c_str());
  }
  dlg->SetTitle(L"Save to");
  DWORD o = 0;
  dlg->GetOptions(&o);
  dlg->SetOptions(o | FOS_OVERWRITEPROMPT | FOS_FORCEFILESYSTEM | FOS_NOREADONLYRETURN);
  if (dlg->Show(g_host.wnd) != S_OK) return L"";
  ComPtr<IShellItem> item;
  wchar_t* p = nullptr;
  std::wstring out;
  if (SUCCEEDED(dlg->GetResult(&item)) && SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &p))) out = p;
  CoTaskMemFree(p);
  return out;
}

std::wstring pickFolder(const std::wstring& start) {
  ComPtr<IFileOpenDialog> dlg;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg)))) return L"";
  DWORD o = 0;
  dlg->GetOptions(&o);
  dlg->SetOptions(o | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
  dlg->SetTitle(L"Choose the folder for her documents");
  ComPtr<IShellItem> folder;
  if (isDir(start) && SUCCEEDED(SHCreateItemFromParsingName(start.c_str(), nullptr, IID_PPV_ARGS(&folder)))) dlg->SetFolder(folder.Get());
  if (dlg->Show(g_host.wnd) != S_OK) return L"";
  ComPtr<IShellItem> item;
  wchar_t* p = nullptr;
  std::wstring out;
  if (SUCCEEDED(dlg->GetResult(&item)) && SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &p))) out = p;
  CoTaskMemFree(p);
  return out;
}

void forget(Intent* in) {
  for (auto it = g_intents.begin(); it != g_intents.end(); ++it)
    if (*it == in) { g_intents.erase(it); break; }
  delete in;
}
/** Saves that never started (the server said no, the page went away) fail after a minute. */
void dropStale() {
  ULONGLONG now = GetTickCount64();
  for (auto* in : std::vector<Intent*>(g_intents))
    if (!in->started && now - in->at > 60000) {
      reply(in->id, L"", L"The download didn't start.");
      forget(in);
    }
}

std::wstring settingsJson() {
  bool on = pref(L"docsAutoOn") == L"1";
  return std::wstring(L"{\"docsAuto\":") + (on ? L"true" : L"false") + L",\"docsAutoLabel\":\"" + esc(on ? folderLabel(autoDir(false)) : L"") + L"\"}";
}

/** The download of a save the page asked for: where it goes, then the answer when it's there. */
void startSave(Intent* in, ComPtr<ICoreWebView2DownloadStartingEventArgs> args, ComPtr<ICoreWebView2Deferral> deferral) {
  std::wstring name = cleanName(in->name.empty() ? L"document" : in->name);
  std::wstring path;
  if (in->mode == L"ask") {
    path = pickSave(name);
    if (!path.empty()) setPref(L"saveLastDir", parentOf(path));
  } else if (in->mode == L"downloads") {
    path = uniquePath(downloadsDir(), name);
  } else if (in->mode == L"auto" && pref(L"docsAutoOn") == L"1") {
    path = uniquePath(autoDir(true), name);
  }
  if (path.empty()) {
    args->put_Cancel(TRUE);
    deferral->Complete();
    reply(in->id, L"{\"cancelled\":true}");
    forget(in);
    return;
  }
  in->path = path;
  args->put_ResultFilePath(path.c_str());
  args->put_Handled(TRUE);  // no download bubble: the card and the toast say it
  ComPtr<ICoreWebView2DownloadOperation> op;
  args->get_DownloadOperation(&op);
  in->op = op;
  if (op) {
    op->add_StateChanged(Callback<ICoreWebView2StateChangedEventHandler>([in](ICoreWebView2DownloadOperation* o, IUnknown*) -> HRESULT {
      COREWEBVIEW2_DOWNLOAD_STATE st;
      o->get_State(&st);
      if (st == COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS) return S_OK;
      std::wstring id = in->id, p = in->path;
      if (st == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED) {
        std::wstring token = std::to_wstring(g_nextToken++);
        g_saved[token] = p;
        log(L"saved " + fileOf(p));
        later([id, p, token] { reply(id, L"{\"ok\":true,\"name\":\"" + esc(fileOf(p)) + L"\",\"folder\":\"" + esc(folderLabel(parentOf(p))) + L"\",\"token\":\"" + token + L"\"}"); });
      } else {
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON why = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NONE;
        o->get_InterruptReason(&why);
        log(L"interrupted (" + std::to_wstring((int)why) + L")");
        later([id] { reply(id, L"{\"ok\":false}"); });
      }
      later([in] { forget(in); });
      return S_OK;
    }).Get(), nullptr);
  }
  deferral->Complete();
}

}  // namespace

std::wstring cleanName(const std::wstring& name) {
  std::wstring o;
  for (wchar_t c : name) o += (c < 0x20 || wcschr(L"<>:\"/\\|?*", c)) ? L'_' : c;
  while (!o.empty() && (o.back() == L'.' || o.back() == L' ')) o.pop_back();
  while (!o.empty() && o.front() == L' ') o.erase(0, 1);
  if (o.size() > 150) {
    size_t dot = o.find_last_of(L'.');
    std::wstring ext = dot != std::wstring::npos && o.size() - dot <= 8 ? o.substr(dot) : L"";
    o = o.substr(0, 150 - ext.size()) + ext;
  }
  std::wstring stem = o.substr(0, o.find(L'.'));
  for (auto& c : stem) c = (wchar_t)towupper(c);
  for (const wchar_t* bad : {L"CON", L"PRN", L"AUX", L"NUL", L"COM1", L"COM2", L"COM3", L"COM4", L"LPT1", L"LPT2", L"LPT3"})
    if (stem == bad) o = L"_" + o;
  return o.empty() ? L"document" : o;
}

std::wstring uniquePath(const std::wstring& dir, const std::wstring& name) {
  std::wstring p = dir + L"\\" + name;
  if (GetFileAttributesW(p.c_str()) == INVALID_FILE_ATTRIBUTES) return p;
  size_t dot = name.find_last_of(L'.');
  std::wstring stem = dot == std::wstring::npos || dot == 0 ? name : name.substr(0, dot);
  std::wstring ext = dot == std::wstring::npos || dot == 0 ? L"" : name.substr(dot);
  for (int n = 2; n < 1000; n++) {
    p = dir + L"\\" + stem + L" (" + std::to_wstring(n) + L")" + ext;
    if (GetFileAttributesW(p.c_str()) == INVALID_FILE_ATTRIBUTES) return p;
  }
  return dir + L"\\" + stem + L" (" + std::to_wstring(GetTickCount64()) + L")" + ext;
}

std::wstring folderLabel(const std::wstring& dir) {
  std::wstring d = dir;
  while (d.size() > 3 && d.back() == L'\\') d.pop_back();
  size_t a = d.find_last_of(L'\\');
  if (a == std::wstring::npos || a + 1 >= d.size()) return d;
  size_t b = a == 0 ? std::wstring::npos : d.find_last_of(L'\\', a - 1);
  std::wstring two = b == std::wstring::npos ? d : d.substr(b + 1);
  // Downloads, Documents, Desktop by their own names (no user name in the label).
  std::wstring last = d.substr(a + 1);
  if (d == downloadsDir() || d == documentsDir() || d == known(FOLDERID_Desktop)) return last;
  return two;
}

bool urlOk(const std::wstring& p) {
  if (p.find(L"..") != std::wstring::npos || p.find_first_of(L"?#%\\") != std::wstring::npos) return false;
  auto digitsThen = [&](size_t from, const wchar_t* tail) {
    size_t i = from;
    while (i < p.size() && iswdigit(p[i])) i++;
    return i > from && p.substr(i) == tail;
  };
  if (p.rfind(L"/api/library/made/", 0) == 0) return digitsThen(18, L"/file");
  if (p.rfind(L"/api/library/", 0) == 0) return digitsThen(13, L"/file");
  if (p.rfind(L"/api/files/", 0) == 0) {
    std::wstring id = p.substr(11);
    if (id.empty() || id.size() > 120) return false;
    for (wchar_t c : id)
      if (!(iswalnum(c) || c == L'-' || c == L'_' || c == L'.')) return false;
    return true;
  }
  return false;
}

void attach(ICoreWebView2* web, const Host& host) {
  g_host = host;
  if (g_web) {
    ComPtr<ICoreWebView2_4> old;
    if (SUCCEEDED(g_web.As(&old))) old->remove_DownloadStarting(g_downloadToken);
  }
  g_web = web;
  ComPtr<ICoreWebView2_4> w4;
  if (!web || FAILED(g_web.As(&w4))) return;
  w4->add_DownloadStarting(Callback<ICoreWebView2DownloadStartingEventHandler>([](ICoreWebView2*, ICoreWebView2DownloadStartingEventArgs* a) -> HRESULT {
    ComPtr<ICoreWebView2DownloadOperation> op;
    LPWSTR uri = nullptr;
    if (FAILED(a->get_DownloadOperation(&op)) || !op || FAILED(op->get_Uri(&uri))) return S_OK;
    std::wstring u = uri ? uri : L"";
    CoTaskMemFree(uri);
    Intent* in = nullptr;
    for (auto* x : g_intents)
      if (!x->started && x->uri == u) { in = x; break; }
    if (!in) return S_OK;  // any other download: WebView2's own handling
    in->started = true;    // taken (a second download of the same address is not this save)
    ComPtr<ICoreWebView2Deferral> deferral;
    a->GetDeferral(&deferral);
    ComPtr<ICoreWebView2DownloadStartingEventArgs> args(a);
    later([in, args, deferral] { startSave(in, args, deferral); });
    return S_OK;
  }).Get(), &g_downloadToken);
}

void onCall(const std::wstring& kind, const std::wstring& id, std::map<std::wstring, std::wstring>& m) {
  dropStale();
  if (kind == L"saveFile") {
    std::wstring path = m[L"url"], mode = m[L"mode"];
    if (!urlOk(path) || (mode != L"ask" && mode != L"downloads" && mode != L"auto") || !g_web || !g_host.server) return reply(id, L"", L"That file can't be saved from here.");
    if (mode == L"auto" && pref(L"docsAutoOn") != L"1") return reply(id, L"{\"cancelled\":true}");
    auto* in = new Intent{id, g_host.server() + path, m[L"name"], mode, GetTickCount64()};
    g_intents.push_back(in);
    // The page's own sign-in downloads it; DownloadStarting above sends it to the place picked.
    std::wstring js = L"(()=>{const a=document.createElement('a');a.href=\"" + esc(path) + L"\";a.download='';a.hidden=true;document.body.append(a);a.click();a.remove();})()";
    g_web->ExecuteScript(js.c_str(), nullptr);
    return;
  }
  if (kind == L"saveOpen") {
    auto it = g_saved.find(m[L"token"]);
    if (it == g_saved.end() || GetFileAttributesW(it->second.c_str()) == INVALID_FILE_ATTRIBUTES) return reply(id, L"", L"That file isn't there any more.");
    if (m[L"how"] == L"folder") {
      PIDLIST_ABSOLUTE pidl = ILCreateFromPathW(it->second.c_str());
      if (pidl) {
        SHOpenFolderAndSelectItems(pidl, 0, nullptr, 0);
        ILFree(pidl);
      }
    } else {
      ShellExecuteW(g_host.wnd, L"open", it->second.c_str(), nullptr, parentOf(it->second).c_str(), SW_SHOWNORMAL);
    }
    return reply(id, L"true");
  }
  if (kind == L"saveSettings") {
    if (m[L"pick"] == L"1") {
      std::wstring d = pickFolder(autoDir(false));
      if (!d.empty()) {
        setPref(L"docsAutoDir", d);
        setPref(L"docsAutoOn", L"1");
      }
    } else if (m[L"auto"] == L"1") {
      autoDir(true);
      setPref(L"docsAutoOn", L"1");
    } else if (m[L"auto"] == L"0") {
      setPref(L"docsAutoOn", L"0");
    }
    return reply(id, settingsJson());
  }
  reply(id, L"", L"Unknown request");
}

bool pending() {
  for (auto* in : g_intents)
    if (!in->started) return true;
  return false;
}

std::wstring prefsJson() {
  std::wstring s = settingsJson();
  return L",\"saveFiles\":true," + s.substr(1, s.size() - 2);
}

std::vector<std::wstring> messageFiles(ICoreWebView2WebMessageReceivedEventArgs* args) {
  std::vector<std::wstring> out;
  ComPtr<ICoreWebView2WebMessageReceivedEventArgs2> a2;
  ComPtr<ICoreWebView2ObjectCollectionView> list;
  if (!args || FAILED(args->QueryInterface(IID_PPV_ARGS(&a2))) || FAILED(a2->get_AdditionalObjects(&list)) || !list) return out;
  UINT32 n = 0;
  list->get_Count(&n);
  for (UINT32 i = 0; i < n && i < 50; i++) {
    ComPtr<IUnknown> o;
    ComPtr<ICoreWebView2File> f;
    LPWSTR p = nullptr;
    if (SUCCEEDED(list->GetValueAtIndex(i, &o)) && o && SUCCEEDED(o.As(&f)) && SUCCEEDED(f->get_Path(&p)) && p) out.push_back(p);
    CoTaskMemFree(p);
  }
  return out;
}

std::vector<std::wstring> expandFolders(const std::vector<std::wstring>& in, size_t max) {
  std::vector<std::wstring> out;
  for (auto& p : in) {
    if (out.size() >= max) break;
    if (!isDir(p)) {
      out.push_back(p);
      continue;
    }
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW((p + L"\\*").c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) continue;
    do {
      if (fd.cFileName[0] == L'.' || (fd.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM))) continue;
      out.push_back(p + L"\\" + fd.cFileName);
    } while (out.size() < max && FindNextFileW(h, &fd));
    FindClose(h);
  }
  return out;
}

}  // namespace sarasave
