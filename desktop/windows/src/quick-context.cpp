// Quick ask "Selected text" and "This window". See quick-context.h for the rules.
#define NOMINMAX
#include "quick-context.h"

#include "hands-screen.h"

#include <UIAutomation.h>
#include <wincrypt.h>
#include <wrl/client.h>

#include <algorithm>

using Microsoft::WRL::ComPtr;

namespace saractx {
namespace {

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
/** Trimmed, at most kMaxText characters, key-shaped text masked (the same shapes as her hands). */
std::wstring tidy(std::wstring t) {
  size_t a = t.find_first_not_of(L" \t\r\n"), b = t.find_last_not_of(L" \t\r\n");
  if (a == std::wstring::npos) return {};
  t = t.substr(a, b - a + 1);
  if (t.size() > kMaxText) {
    t.resize(kMaxText);
    if (IS_HIGH_SURROGATE(t.back())) t.pop_back();
  }
  return wide(sarascreen::maskSecrets(u8(t)));
}

/** A message-only window that owns the clipboard while we copy (and put it back). */
HWND owner() {
  static HWND h = [] {
    WNDCLASSW wc{};
    wc.lpfnWndProc = DefWindowProcW;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"SaraQuickClip";
    RegisterClassW(&wc);
    return CreateWindowExW(0, wc.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, wc.hInstance, nullptr);
  }();
  return h;
}
bool openClipboard(HWND h) {
  for (int i = 0; i < 10; i++) {
    if (OpenClipboard(h)) return true;
    Sleep(15);
  }
  return false;
}

/** A classic Edit control with ES_PASSWORD focused in that window's thread. */
bool classicPasswordFocus(HWND front) {
  GUITHREADINFO gi{sizeof gi};
  if (!GetGUIThreadInfo(GetWindowThreadProcessId(front, nullptr), &gi) || !gi.hwndFocus) return false;
  wchar_t cls[96];
  GetClassNameW(gi.hwndFocus, cls, 96);
  // Edit and the controls built on it (WinForms' "WindowsForms10.EDIT…", rich edits): the style, or a password character.
  std::wstring c(cls);
  for (auto& ch : c) ch = (wchar_t)towlower(ch);
  if (c.find(L"edit") == std::wstring::npos) return false;
  if (GetWindowLongW(gi.hwndFocus, GWL_STYLE) & ES_PASSWORD) return true;
  DWORD_PTR pc = 0;
  return SendMessageTimeoutW(gi.hwndFocus, EM_GETPASSWORDCHAR, 0, 0, SMTO_ABORTIFHUNG, 200, &pc) && pc != 0;
}

enum class Uia { Read, NoPattern, Password, Unavailable };
/** The focused element's TextPattern selection (in the window in front only). */
Uia uiaSelection(HWND front, std::wstring& out) {
  ComPtr<IUIAutomation> a;
  if (FAILED(CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&a)))) return Uia::Unavailable;
  ComPtr<IUIAutomationElement> el;
  if (FAILED(a->GetFocusedElement(&el)) || !el) return Uia::Unavailable;
  int pid = 0;
  DWORD frontPid = 0;
  GetWindowThreadProcessId(front, &frontPid);
  if (FAILED(el->get_CurrentProcessId(&pid)) || (DWORD)pid != frontPid) return Uia::Unavailable;
  BOOL pw = FALSE;
  if (SUCCEEDED(el->get_CurrentIsPassword(&pw)) && pw) return Uia::Password;
  ComPtr<IUIAutomationTextPattern> tp;
  if (FAILED(el->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&tp))) || !tp) return Uia::NoPattern;
  ComPtr<IUIAutomationTextRangeArray> sel;
  if (FAILED(tp->GetSelection(&sel)) || !sel) return Uia::NoPattern;
  int n = 0;
  sel->get_Length(&n);
  for (int i = 0; i < n && out.size() < kMaxText; i++) {
    ComPtr<IUIAutomationTextRange> r;
    if (FAILED(sel->GetElement(i, &r)) || !r) continue;
    BSTR b = nullptr;
    if (SUCCEEDED(r->GetText((int)(kMaxText + 1), &b)) && b) {
      if (!out.empty()) out += L"\n";
      out.append(b, SysStringLen(b));
      SysFreeString(b);
    }
  }
  return Uia::Read;
}

bool anyKeyHeld() {
  for (int vk : {VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN})
    if (GetAsyncKeyState(vk) & 0x8000) return true;
  for (int vk = 'A'; vk <= 'Z'; vk++)
    if (GetAsyncKeyState(vk) & 0x8000) return true;
  return (GetAsyncKeyState(VK_SPACE) & 0x8000) != 0;
}
void sendCopy() {
  INPUT in[4]{};
  WORD keys[4] = {VK_CONTROL, 'C', 'C', VK_CONTROL};
  for (int i = 0; i < 4; i++) {
    in[i].type = INPUT_KEYBOARD;
    in[i].ki.wVk = keys[i];
    in[i].ki.dwFlags = i >= 2 ? KEYEVENTF_KEYUP : 0;
    in[i].ki.dwExtraInfo = sarascreen::kInputTag;  // her hands' own-input tag: never taken for the owner's typing
  }
  SendInput(4, in, sizeof(INPUT));
}

// The copy fallback runs on this thread's timers (it waits for the shortcut's keys to be let go).
struct Job {
  Picked p;
  std::function<void(const Picked&)> done;
  SavedClipboard saved;
  DWORD seq = 0;
  ULONGLONG started = 0, copiedAt = 0;
  int stage = 0;  // 1 waiting for the keys, 2 waiting for the copy
};
Job* g_job = nullptr;
UINT_PTR g_timer = 0;
void finish() {
  if (g_timer) KillTimer(nullptr, g_timer);
  g_timer = 0;
  Job* j = g_job;
  g_job = nullptr;
  if (!j) return;
  j->saved.release();
  auto done = std::move(j->done);
  Picked p = j->p;
  delete j;
  if (done) done(p);
}
void CALLBACK tick(HWND, UINT, UINT_PTR, DWORD) {
  Job* j = g_job;
  if (!j) return finish();
  ULONGLONG now = GetTickCount64();
  if (j->stage == 1) {
    if (anyKeyHeld()) {
      if (now - j->started > 1200) {
        j->p.skipped = L"keys";
        finish();
      }
      return;
    }
    // Still the same window in front, nothing typed into a password field meanwhile.
    if (GetForegroundWindow() != j->p.window) {
      j->p.skipped = L"moved";  // another window came to the front meanwhile
      return finish();
    }
    if (classicPasswordFocus(j->p.window)) {
      j->p.skipped = L"password";
      return finish();
    }
    if (!j->saved.save(owner()) || !j->saved.exact) {
      j->p.skipped = L"clipboard";
      return finish();
    }
    j->seq = GetClipboardSequenceNumber();
    sendCopy();
    j->copiedAt = now;
    j->stage = 2;
    j->p.path += L", copy";
    return;
  }
  if (GetClipboardSequenceNumber() != j->seq) {
    Sleep(30);  // let the app finish putting all its formats there
    std::wstring t = tidy(clipboardText(owner()));
    if (!j->saved.restore(owner())) j->p.skipped = L"clipboard";
    if (!t.empty()) {
      j->p.text = t;
      j->p.via = L"copy";
    }
    return finish();
  }
  if (now - j->copiedAt > 600) {
    j->p.path += L": nothing copied";
    finish();
  }  // nothing was copied (nothing selected): the clipboard is untouched
}

}  // namespace

bool SavedClipboard::save(HWND h) {
  items.clear();
  exact = true;
  if (!openClipboard(h)) return false;
  size_t total = 0;
  bool hasDib = IsClipboardFormatAvailable(CF_DIB) || IsClipboardFormatAvailable(CF_DIBV5);
  for (UINT f = EnumClipboardFormats(0); f && exact; f = EnumClipboardFormats(f)) {
    if (f == CF_BITMAP && hasDib) continue;            // Windows makes it again from the DIB
    if (f == CF_ENHMETAFILE) {
      HENHMETAFILE e = (HENHMETAFILE)GetClipboardData(f);
      HENHMETAFILE c = e ? CopyEnhMetaFileW(e, nullptr) : nullptr;
      if (!c) exact = false;
      else items.push_back({f, {}, c});
      continue;
    }
    if (f == CF_BITMAP || f == CF_METAFILEPICT || f == CF_PALETTE || f == CF_OWNERDISPLAY || f == CF_DSPBITMAP || f == CF_DSPMETAFILEPICT || f == CF_DSPENHMETAFILE ||
        (f >= CF_GDIOBJFIRST && f <= CF_GDIOBJLAST)) {
      exact = false;  // handles that can't be copied byte for byte: no Ctrl+C then
      break;
    }
    HANDLE d = GetClipboardData(f);
    if (!d) continue;  // a format the owner offers but can't render now: it wasn't there to lose
    SIZE_T n = GlobalSize(d);
    void* p = n ? GlobalLock(d) : nullptr;
    if (!p) {
      exact = false;
      break;
    }
    total += n;
    if (total > 64u * 1024 * 1024) exact = false;  // too big to hold safely: no Ctrl+C
    else items.push_back({f, std::vector<BYTE>((BYTE*)p, (BYTE*)p + n), nullptr});
    GlobalUnlock(d);
  }
  CloseClipboard();
  return true;
}
bool SavedClipboard::restore(HWND h) const {
  if (!openClipboard(h)) return false;
  EmptyClipboard();
  bool ok = true;
  for (auto& it : items) {
    if (it.emf) {
      HENHMETAFILE c = CopyEnhMetaFileW(it.emf, nullptr);
      if (!c || !SetClipboardData(it.format, c)) ok = false;
      continue;
    }
    HGLOBAL g = GlobalAlloc(GMEM_MOVEABLE, std::max<size_t>(1, it.data.size()));
    if (!g) {
      ok = false;
      continue;
    }
    if (void* p = GlobalLock(g)) {
      if (!it.data.empty()) memcpy(p, it.data.data(), it.data.size());
      GlobalUnlock(g);
    }
    if (!SetClipboardData(it.format, g)) {
      GlobalFree(g);
      ok = false;
    }
  }
  CloseClipboard();
  return ok;
}
void SavedClipboard::release() {
  for (auto& it : items)
    if (it.emf) DeleteEnhMetaFile(it.emf);
  items.clear();
}
std::wstring clipboardText(HWND h) {
  std::wstring t;
  if (!openClipboard(h)) return t;
  if (HANDLE d = GetClipboardData(CF_UNICODETEXT))
    if (auto* p = static_cast<const wchar_t*>(GlobalLock(d))) {
      t.assign(p, wcsnlen(p, GlobalSize(d) / sizeof(wchar_t)));
      GlobalUnlock(d);
    }
  CloseClipboard();
  return t;
}

std::wstring appLabel(HWND w) {
  DWORD pid = 0;
  GetWindowThreadProcessId(w, &pid);
  std::wstring path;
  if (HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)) {
    wchar_t buf[MAX_PATH];
    DWORD n = MAX_PATH;
    if (QueryFullProcessImageNameW(p, 0, buf, &n)) path.assign(buf, n);
    CloseHandle(p);
  }
  if (path.empty()) return L"";
  std::wstring name;
  DWORD z = 0, len = GetFileVersionInfoSizeW(path.c_str(), &z);
  std::vector<BYTE> v(len);
  if (len && GetFileVersionInfoW(path.c_str(), 0, len, v.data())) {
    struct Lang { WORD lang, cp; }* tr = nullptr;
    UINT tl = 0;
    if (VerQueryValueW(v.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<void**>(&tr), &tl) && tl >= sizeof(Lang)) {
      wchar_t key[64];
      swprintf_s(key, L"\\StringFileInfo\\%04x%04x\\FileDescription", tr->lang, tr->cp);
      wchar_t* d = nullptr;
      UINT dl = 0;
      if (VerQueryValueW(v.data(), key, reinterpret_cast<void**>(&d), &dl) && d && dl > 1) name.assign(d, wcsnlen(d, dl));
    }
  }
  if (name.empty() || name.size() > 60) {
    size_t s = path.find_last_of(L"\\/");
    name = path.substr(s == std::wstring::npos ? 0 : s + 1);
    if (name.size() > 4 && _wcsicmp(name.c_str() + name.size() - 4, L".exe") == 0) name.resize(name.size() - 4);
  }
  return name;
}

void pick(HWND front, Read read, std::function<void(const Picked&)> done) {
  if (g_job) finish();  // a second press while copying: the first one ends now
  Picked p;
  HWND root = front ? GetAncestor(front, GA_ROOT) : nullptr;
  wchar_t cls[64] = L"";
  if (root) GetClassNameW(root, cls, 64);
  bool shell = !root || !wcscmp(cls, L"Progman") || !wcscmp(cls, L"WorkerW") || !wcscmp(cls, L"Shell_TrayWnd") || !wcscmp(cls, L"Shell_SecondaryTrayWnd");
  if (shell) return done(p);
  std::string hidden = sarascreen::hiddenKindOf(root);
  if (hidden == "sara") {
    p.skipped = L"sara";  // Sara's own windows: nothing read, no picture
    return done(p);
  }
  p.app = appLabel(root);
  if (!hidden.empty()) {
    p.skipped = L"hidden";  // password managers, banking, the person's own list
    return done(p);
  }
  p.window = root;
  if (read == kReadNone) return done(p);
  if (classicPasswordFocus(root)) {
    p.skipped = L"password";
    return done(p);
  }
  std::wstring text;
  Uia u = Uia::Unavailable;
#ifdef SARA_TEST_HOOKS
  // Test builds: SARA_QA_FORCE_COPY=1 skips UI Automation so the Ctrl+C path can be checked.
  if (GetEnvironmentVariableW(L"SARA_QA_FORCE_COPY", nullptr, 0) == 0)
#endif
    u = uiaSelection(root, text);
  if (u == Uia::Password) {
    p.skipped = L"password";
    return done(p);
  }
  p.path = u == Uia::Read ? L"uia" : u == Uia::NoPattern ? L"uia: no pattern" : L"uia: unavailable";
  if (u == Uia::Read) {
    // It has a text pattern: what it says is selected is the answer (an empty selection stays empty;
    // no Ctrl+C, which in some editors would copy the whole line).
    p.text = tidy(text);
    if (!p.text.empty()) p.via = L"uia";
    return done(p);
  }
  if (read != kReadAll) return done(p);
  g_job = new Job{p, std::move(done)};
  g_job->started = GetTickCount64();
  g_job->stage = 1;
  g_timer = SetTimer(nullptr, 0, 25, tick);
  if (!g_timer) finish();
}

bool captureWindow(HWND w, std::string& dataUrl, int& width, int& height, std::wstring& why) {
  if (!w || !IsWindow(w)) {
    why = L"That window is gone.";
    return false;
  }
  sarascreen::Result r = sarascreen::shot(sarascreen::windowId(w), "", {}, 1600, false, 0);
  if (r.shot.jpeg.empty()) {
    why = wide(r.message.empty() ? std::string("Couldn't take a picture of that window.") : r.message);
    return false;
  }
  DWORD len = 0;
  CryptBinaryToStringA(r.shot.jpeg.data(), (DWORD)r.shot.jpeg.size(), CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &len);
  std::string b64(len, '\0');
  CryptBinaryToStringA(r.shot.jpeg.data(), (DWORD)r.shot.jpeg.size(), CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, b64.data(), &len);
  b64.resize(len);
  dataUrl = "data:image/jpeg;base64," + b64;
  width = r.shot.w;
  height = r.shot.h;
  return true;
}

}  // namespace saractx
