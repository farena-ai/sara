// Phase 92 (computer use CU5): desktop look on Windows. See hands-screen.h for the rules.
// Capture is GDI (BitBlt with CAPTUREBLT for a screen or an area, PrintWindow PW_RENDERFULLCONTENT for one
// window), not Windows.Graphics.Capture: GDI needs no Direct3D device, shows no capture border, honours
// WDA_EXCLUDEFROMCAPTURE the same way, and a single still picture is all desktop look needs (documented
// in docs/design/COMPUTER_USE.md, Phase 92 deviations). Element lists come from UI Automation.
#define NOMINMAX
#include "hands-screen.h"

#include <UIAutomation.h>
#include <dwmapi.h>
#include <shellscalingapi.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <algorithm>
#include <cmath>
#include <map>
#include <mutex>
#include <regex>
#include <set>
#include <filesystem>
#include <shlobj.h>
#include <shobjidl.h>
#include <shellapi.h>
#include <winhttp.h>

using Microsoft::WRL::ComPtr;

namespace sarascreen {
namespace {

constexpr int kMaxEdge = 1280, kMaxElements = 300, kMaxDepth = 8, kMaxNodes = 2500;
constexpr ULONGLONG kViewTtl = 20000, kShotEvery = 500;

std::mutex g_m;
std::vector<std::string> g_extra;
std::string g_serverAuthority;
struct View {
  ULONGLONG at = 0;
  int ox = 0, oy = 0;
  double scale = 1;
  HWND hwnd = nullptr;
  std::string title, app;
  RECT frame{};
  int width = 0, height = 0;
  std::vector<std::string> identity;
};
std::map<std::string, View> g_views;
unsigned g_viewN = 0;
ULONGLONG g_lastShot = 0;

std::string u8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}
std::string lower(std::string s) {
  for (auto& c : s) c = (char)tolower((unsigned char)c);
  return s;
}
std::string jq(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"') o += "\\\"";
    else if (c == '\\') o += "\\\\";
    else if (c < 0x20) {
      char b[8];
      snprintf(b, sizeof b, "\\u%04x", c);
      o += b;
    } else o += (char)c;
  }
  return o + "\"";
}
/** Cuts UTF-8 text to n bytes without splitting a character, control characters as spaces. */
std::string clip(std::string s, size_t n) {
  for (auto& c : s)
    if ((unsigned char)c < 0x20) c = ' ';
  if (s.size() <= n) return s;
  size_t i = n;
  while (i > 0 && ((unsigned char)s[i] & 0xC0) == 0x80) i--;
  return s.substr(0, i);
}
/** §7.6: the fixed key shapes (the same list as src/hands-desktop.ts). */
std::string maskText(std::string t) {
  static const std::regex kShapes[] = {
      std::regex(R"(\bsk-[A-Za-z0-9_-]{16,})"), std::regex(R"(\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,})"), std::regex(R"(\bgh[pousr]_[A-Za-z0-9]{20,})"),
      std::regex(R"(\bxox[abprs]-[A-Za-z0-9-]{10,})"), std::regex(R"(\bAKIA[0-9A-Z]{16}\b)"), std::regex(R"(\bxai-[A-Za-z0-9]{20,})"),
      std::regex(R"(\bsara_(?:dev|hands|m)\.[\w-]+\.[\w-]+)"), std::regex(R"(\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,})")};
  for (auto& re : kShapes) t = std::regex_replace(t, re, "[hidden]");
  return t;
}

// §7.4: the default sensitive-windows list (the same as src/hands-desktop.ts DESKTOP_BLOCKLIST).
struct Block {
  const char* kind;
  std::vector<const char*> titles, apps;
};
const Block kBlocks[] = {
    {"password manager",
     {"1password", "bitwarden", "keepass", "lastpass", "dashlane", "proton pass", "keychain access", "credential manager", "enpass", "nordpass", "roboform"},
     {"1password", "bitwarden", "keepass", "keepassxc", "lastpass", "dashlane", "proton pass", "keychain access", "enpass", "nordpass", "roboform"}},
    {"security settings", {"windows security", "privacy & security", "privacy and security", "credential manager", "manage passwords"}, {"securityhealthhost", "securityhealthui"}},
    {"banking",
     {"online banking", "bank of america", "wells fargo", "chase bank", "chase.com", "citibank", "barclays", "hsbc", "santander", "capital one", "paypal", "revolut", "monzo", "n26", "sparkasse", "credit union", "ing banking", "bnp paribas"},
     {}},
    {"sign-in token", {"sara_dev.", "sara_hands.", "sara_m."}, {}},
};
std::string blockedKind(const std::string& title, const std::string& app) {
  std::string t = lower(title), a = lower(app);
  for (auto& b : kBlocks) {
    for (auto x : b.titles)
      if (t.find(x) != std::string::npos) return b.kind;
    for (auto x : b.apps)
      if (a.find(x) != std::string::npos) return b.kind;
  }
  std::lock_guard<std::mutex> l(g_m);
  for (auto& x : g_extra)
    if (x.size() >= 3 && (t.find(x) != std::string::npos || a.find(x) != std::string::npos)) return "your list";
  return {};
}

std::wstring exeOf(DWORD pid) {
  std::wstring out;
  if (HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)) {
    wchar_t buf[MAX_PATH];
    DWORD n = MAX_PATH;
    if (QueryFullProcessImageNameW(p, 0, buf, &n)) {
      out.assign(buf, n);
      size_t s = out.find_last_of(L"\\/");
      if (s != std::wstring::npos) out = out.substr(s + 1);
    }
    CloseHandle(p);
  }
  return out;
}
std::string appName(const std::wstring& exe) {
  std::string a = u8(exe);
  if (a.size() > 4 && lower(a.substr(a.size() - 4)) == ".exe") a.resize(a.size() - 4);
  return a;
}
const std::wstring& ownExe() {
  static std::wstring e = [] {
    std::wstring x = exeOf(GetCurrentProcessId());
    for (auto& c : x) c = (wchar_t)towlower(c);
    return x;
  }();
  return e;
}

struct Win {
  HWND h = nullptr;
  std::string title, app, hidden;
  RECT r{};
  bool minimized = false, own = false, sara = false, tool = false, shell = false;
};
RECT frameOf(HWND h) {
  RECT r{};
  if (FAILED(DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, &r, sizeof r))) GetWindowRect(h, &r);
  return r;
}
/** Every visible top-level window, front first. */
std::vector<Win> listAll() {
  std::vector<Win> out;
  EnumWindows(
      [](HWND h, LPARAM lp) -> BOOL {
        if (!IsWindowVisible(h)) return TRUE;
        BOOL cloaked = FALSE;
        DwmGetWindowAttribute(h, DWMWA_CLOAKED, &cloaked, sizeof cloaked);
        if (cloaked) return TRUE;
        Win w;
        w.h = h;
        wchar_t t[512];
        int n = GetWindowTextW(h, t, 512);
        w.title = u8(std::wstring(t, std::max(0, n)));
        DWORD pid = 0;
        GetWindowThreadProcessId(h, &pid);
        std::wstring exe = exeOf(pid);
        std::wstring exeL = exe;
        for (auto& c : exeL) c = (wchar_t)towlower(c);
        w.app = appName(exe);
        w.own = pid == GetCurrentProcessId();
        // Sara's own windows: this app, and any other Sara app window (another Sara.exe, e.g. the installed one beside a test copy).
        w.sara = w.own || (!exeL.empty() && exeL == ownExe());
        w.minimized = IsIconic(h) != FALSE;
        w.tool = (GetWindowLongW(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0;
        wchar_t cls[64];
        GetClassNameW(h, cls, 64);
        std::wstring c(cls);
        w.shell = c == L"Progman" || c == L"WorkerW" || c == L"Shell_TrayWnd" || c == L"Shell_SecondaryTrayWnd";
        w.r = frameOf(h);
        if (!w.sara) w.hidden = blockedKind(w.title, w.app);
        reinterpret_cast<std::vector<Win>*>(lp)->push_back(w);
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&out));
  return out;
}
std::string idOf(HWND h) {
  char b[32];
  snprintf(b, sizeof b, "w%llx", (unsigned long long)(uintptr_t)h);
  return b;
}
bool listed(const Win& w) { return !w.sara && !w.shell && !w.title.empty() && !(w.tool && w.hidden.empty()); }
bool intersects(const RECT& a, const RECT& b) {
  RECT x;
  return IntersectRect(&x, &a, &b) != FALSE;
}

struct Mon {
  HMONITOR m;
  RECT r;
  bool primary;
  UINT dpi;
};
std::vector<Mon> monitors() {
  std::vector<Mon> out;
  EnumDisplayMonitors(
      nullptr, nullptr,
      [](HMONITOR m, HDC, LPRECT, LPARAM lp) -> BOOL {
        MONITORINFO mi{sizeof mi};
        GetMonitorInfoW(m, &mi);
        UINT dx = 96, dy = 96;
        GetDpiForMonitor(m, MDT_EFFECTIVE_DPI, &dx, &dy);
        reinterpret_cast<std::vector<Mon>*>(lp)->push_back({m, mi.rcMonitor, (mi.dwFlags & MONITORINFOF_PRIMARY) != 0, dx});
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&out));
  std::stable_sort(out.begin(), out.end(), [](const Mon& a, const Mon& b) { return a.primary && !b.primary; });
  return out;
}
std::string screenOf(HWND h, const std::vector<Mon>& ms) {
  HMONITOR m = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
  for (size_t i = 0; i < ms.size(); i++)
    if (ms[i].m == m) return "s" + std::to_string(i + 1);
  return "s1";
}

// ---------------- pictures ----------------
struct Dib {
  HDC dc = nullptr;
  HBITMAP bmp = nullptr;
  HGDIOBJ old = nullptr;
  BYTE* bits = nullptr;
  int w = 0, h = 0;
  bool make(int W, int H) {
    w = W;
    h = H;
    BITMAPINFO bi{};
    bi.bmiHeader = {sizeof(BITMAPINFOHEADER), W, -H, 1, 32, BI_RGB};
    dc = CreateCompatibleDC(nullptr);
    bmp = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, reinterpret_cast<void**>(&bits), nullptr, 0);
    if (!dc || !bmp) return false;
    old = SelectObject(dc, bmp);
    return true;
  }
  void fill(RECT r, COLORREF c) {
    HBRUSH b = CreateSolidBrush(c);
    FillRect(dc, &r, b);
    DeleteObject(b);
  }
  bool allBlack() const {
    for (int i = 0; i < w * h; i += 7)
      if (bits[i * 4] | bits[i * 4 + 1] | bits[i * 4 + 2]) return false;
    return true;
  }
  ~Dib() {
    if (dc && old) SelectObject(dc, old);
    if (bmp) DeleteObject(bmp);
    if (dc) DeleteDC(dc);
  }
};

bool jpegOf(const Dib& d, int quality, std::vector<BYTE>& out) {
  ComPtr<IWICImagingFactory> f;
  if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&f)))) return false;
  ComPtr<IWICBitmap> bm;
  if (FAILED(f->CreateBitmapFromMemory(d.w, d.h, GUID_WICPixelFormat32bppBGR, d.w * 4, d.w * d.h * 4, d.bits, &bm))) return false;
  ComPtr<IStream> st;
  if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &st))) return false;
  ComPtr<IWICBitmapEncoder> enc;
  if (FAILED(f->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &enc)) || FAILED(enc->Initialize(st.Get(), WICBitmapEncoderNoCache))) return false;
  ComPtr<IWICBitmapFrameEncode> fr;
  ComPtr<IPropertyBag2> bag;
  if (FAILED(enc->CreateNewFrame(&fr, &bag))) return false;
  PROPBAG2 opt{};
  opt.pstrName = const_cast<LPOLESTR>(L"ImageQuality");
  VARIANT v;
  VariantInit(&v);
  v.vt = VT_R4;
  v.fltVal = quality / 100.0f;
  bag->Write(1, &opt, &v);
  if (FAILED(fr->Initialize(bag.Get())) || FAILED(fr->SetSize(d.w, d.h))) return false;
  WICPixelFormatGUID pf = GUID_WICPixelFormat24bppBGR;
  fr->SetPixelFormat(&pf);
  ComPtr<IWICFormatConverter> conv;
  if (FAILED(f->CreateFormatConverter(&conv)) || FAILED(conv->Initialize(bm.Get(), pf, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom))) return false;
  if (FAILED(fr->WriteSource(conv.Get(), nullptr)) || FAILED(fr->Commit()) || FAILED(enc->Commit())) return false;
  HGLOBAL hg = nullptr;
  GetHGlobalFromStream(st.Get(), &hg);
  STATSTG ss{};
  st->Stat(&ss, STATFLAG_NONAME);
  out.resize((size_t)ss.cbSize.QuadPart);
  if (void* p = GlobalLock(hg)) {
    memcpy(out.data(), p, out.size());
    GlobalUnlock(hg);
  }
  return !out.empty();
}
bool scaled(const Dib& src, int maxEdge, Dib& out) {
  double s = std::min(1.0, (double)maxEdge / std::max(src.w, src.h));
  int w = std::max(1, (int)std::lround(src.w * s)), h = std::max(1, (int)std::lround(src.h * s));
  if (!out.make(w, h)) return false;
  SetStretchBltMode(out.dc, HALFTONE);
  SetBrushOrgEx(out.dc, 0, 0, nullptr);
  return StretchBlt(out.dc, 0, 0, w, h, src.dc, 0, 0, src.w, src.h, SRCCOPY) != FALSE;
}

// ---------------- UI Automation ----------------
struct Com {
  bool undo = false;
  Com() { undo = SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED)); }
  ~Com() {
    if (undo) CoUninitialize();
  }
};
ComPtr<IUIAutomation> uia() {
  ComPtr<IUIAutomation> a;
  CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&a));
  ComPtr<IUIAutomation2> a2;
  if (a && SUCCEEDED(a.As(&a2))) {
    a2->put_TransactionTimeout(2000);
    a2->put_ConnectionTimeout(2000);
  }
  return a;
}
const char* roleOf(CONTROLTYPEID t) {
  switch (t) {
    case UIA_ButtonControlTypeId: return "button";
    case UIA_CalendarControlTypeId: return "calendar";
    case UIA_CheckBoxControlTypeId: return "checkbox";
    case UIA_ComboBoxControlTypeId: return "combobox";
    case UIA_EditControlTypeId: return "edit";
    case UIA_HyperlinkControlTypeId: return "link";
    case UIA_ImageControlTypeId: return "image";
    case UIA_ListItemControlTypeId: return "listitem";
    case UIA_ListControlTypeId: return "list";
    case UIA_MenuControlTypeId: return "menu";
    case UIA_MenuBarControlTypeId: return "menubar";
    case UIA_MenuItemControlTypeId: return "menuitem";
    case UIA_ProgressBarControlTypeId: return "progressbar";
    case UIA_RadioButtonControlTypeId: return "radio";
    case UIA_ScrollBarControlTypeId: return "scrollbar";
    case UIA_SliderControlTypeId: return "slider";
    case UIA_SpinnerControlTypeId: return "spinner";
    case UIA_StatusBarControlTypeId: return "statusbar";
    case UIA_TabControlTypeId: return "tablist";
    case UIA_TabItemControlTypeId: return "tab";
    case UIA_TextControlTypeId: return "text";
    case UIA_ToolBarControlTypeId: return "toolbar";
    case UIA_ToolTipControlTypeId: return "tooltip";
    case UIA_TreeControlTypeId: return "tree";
    case UIA_TreeItemControlTypeId: return "treeitem";
    case UIA_GroupControlTypeId: return "group";
    case UIA_DataGridControlTypeId: return "grid";
    case UIA_DataItemControlTypeId: return "row";
    case UIA_DocumentControlTypeId: return "document";
    case UIA_SplitButtonControlTypeId: return "button";
    case UIA_WindowControlTypeId: return "window";
    case UIA_PaneControlTypeId: return "pane";
    case UIA_HeaderControlTypeId: return "header";
    case UIA_HeaderItemControlTypeId: return "columnheader";
    case UIA_TableControlTypeId: return "table";
    case UIA_TitleBarControlTypeId: return "titlebar";
    default: return "element";
  }
}
bool actionable(CONTROLTYPEID t) {
  return t == UIA_ButtonControlTypeId || t == UIA_CheckBoxControlTypeId || t == UIA_ComboBoxControlTypeId || t == UIA_EditControlTypeId || t == UIA_HyperlinkControlTypeId ||
         t == UIA_ListItemControlTypeId || t == UIA_MenuItemControlTypeId || t == UIA_RadioButtonControlTypeId || t == UIA_SliderControlTypeId || t == UIA_TabItemControlTypeId ||
         t == UIA_SplitButtonControlTypeId || t == UIA_TreeItemControlTypeId;
}
std::string bstr(VARIANT& v) {
  std::string s = v.vt == VT_BSTR && v.bstrVal ? u8(std::wstring(v.bstrVal, SysStringLen(v.bstrVal))) : std::string();
  VariantClear(&v);
  return s;
}
bool vbool(VARIANT& v) {
  bool b = v.vt == VT_BOOL && v.boolVal != VARIANT_FALSE;
  VariantClear(&v);
  return b;
}

struct Item {
  std::string role, name, value;
  bool secret = false, disabled = false, focused = false;
  RECT r{};
  ComPtr<IUIAutomationElement> element;
  std::string identity;
};
ComPtr<IUIAutomationCacheRequest> cacheReq(IUIAutomation* a) {
  ComPtr<IUIAutomationCacheRequest> cr;
  a->CreateCacheRequest(&cr);
  for (PROPERTYID p : {UIA_NamePropertyId, UIA_ControlTypePropertyId, UIA_IsPasswordPropertyId, UIA_IsEnabledPropertyId, UIA_BoundingRectanglePropertyId, UIA_HasKeyboardFocusPropertyId, UIA_IsOffscreenPropertyId, UIA_ValueValuePropertyId}) cr->AddProperty(p);
  return cr;
}
/** The control view of one window: depth ≤ 8, at most `limit` items listed (and how many there were). */
void collect(HWND h, int limit, std::vector<Item>& out, int& total) {
  total = 0;
  auto a = uia();
  if (!a) return;
  auto cr = cacheReq(a.Get());
  ComPtr<IUIAutomationElement> root;
  if (FAILED(a->ElementFromHandleBuildCache(h, cr.Get(), &root)) || !root) return;
  ComPtr<IUIAutomationTreeWalker> walk;
  a->get_ControlViewWalker(&walk);
  int nodes = 0;
  struct Rec {
    static void go(IUIAutomationTreeWalker* walk, IUIAutomationCacheRequest* cr, IUIAutomationElement* el, int depth, int limit, int& nodes, std::vector<Item>& out, int& total) {
      if (depth > kMaxDepth || nodes > kMaxNodes) return;
      ComPtr<IUIAutomationElement> c;
      walk->GetFirstChildElementBuildCache(el, cr, &c);
      while (c && nodes <= kMaxNodes) {
        nodes++;
        CONTROLTYPEID t = 0;
        c->get_CachedControlType(&t);
        VARIANT v;
        c->GetCachedPropertyValue(UIA_IsOffscreenPropertyId, &v);
        bool off = vbool(v);
        RECT r{};
        c->get_CachedBoundingRectangle(&r);
        c->GetCachedPropertyValue(UIA_NamePropertyId, &v);
        std::string name = bstr(v);
        if (!off && r.right > r.left && r.bottom > r.top && (!name.empty() || actionable(t))) {
          total++;
          if ((int)out.size() < limit) {
            Item it;
            it.element = c;
            SAFEARRAY* rid = nullptr;
            if (SUCCEEDED(c->GetRuntimeId(&rid)) && rid) {
              LONG lo = 0, hi = -1; SafeArrayGetLBound(rid, 1, &lo); SafeArrayGetUBound(rid, 1, &hi);
              for (LONG j = lo; j <= hi; ++j) { int n = 0; SafeArrayGetElement(rid, &j, &n); it.identity += std::to_string(n) + ":"; }
              SafeArrayDestroy(rid);
            }

            it.role = roleOf(t);
            it.name = maskText(clip(name, 200));
            it.r = r;
            c->GetCachedPropertyValue(UIA_IsPasswordPropertyId, &v);
            it.secret = vbool(v);
            c->GetCachedPropertyValue(UIA_IsEnabledPropertyId, &v);
            it.disabled = !vbool(v);
            c->GetCachedPropertyValue(UIA_HasKeyboardFocusPropertyId, &v);
            it.focused = vbool(v);
            // Never the value of a password field: it isn't even read.
            if (!it.secret && (t == UIA_EditControlTypeId || t == UIA_ComboBoxControlTypeId || t == UIA_SliderControlTypeId || t == UIA_SpinnerControlTypeId)) {
              c->GetCachedPropertyValue(UIA_ValueValuePropertyId, &v);
              it.value = maskText(clip(bstr(v), 200));
            }
            it.identity += "|" + it.role + "|" + it.name + "|" + std::to_string(r.left) + "," + std::to_string(r.top) + "," + std::to_string(r.right) + "," + std::to_string(r.bottom) + (it.secret ? "|secret" : "") + (it.disabled ? "|disabled" : "");
            out.push_back(it);
          }
        }
        go(walk, cr, c.Get(), depth + 1, limit, nodes, out, total);
        ComPtr<IUIAutomationElement> n;
        walk->GetNextSiblingElementBuildCache(c.Get(), cr, &n);
        c = n;
      }
    }
  };
  Rec::go(walk.Get(), cr.Get(), root.Get(), 1, limit, nodes, out, total);
}
/** The password fields of one window (to box them out of a picture). */
std::vector<RECT> secretRects(HWND h) {
  std::vector<RECT> out;
  auto a = uia();
  if (!a) return out;
  ComPtr<IUIAutomationElement> root;
  if (FAILED(a->ElementFromHandle(h, &root)) || !root) return out;
  VARIANT v;
  VariantInit(&v);
  v.vt = VT_BOOL;
  v.boolVal = VARIANT_TRUE;
  ComPtr<IUIAutomationCondition> cond;
  a->CreatePropertyCondition(UIA_IsPasswordPropertyId, v, &cond);
  ComPtr<IUIAutomationElementArray> arr;
  if (FAILED(root->FindAll(TreeScope_Descendants, cond.Get(), &arr)) || !arr) return out;
  int n = 0;
  arr->get_Length(&n);
  for (int i = 0; i < n && i < 50; i++) {
    ComPtr<IUIAutomationElement> e;
    arr->GetElement(i, &e);
    RECT r{};
    if (e && SUCCEEDED(e->get_CurrentBoundingRectangle(&r)) && r.right > r.left) out.push_back(r);
  }
  return out;
}

std::string itemsJson(const std::vector<Item>& items, const View* v) {
  std::string o = "[";
  for (size_t i = 0; i < items.size(); i++) {
    const Item& it = items[i];
    RECT r = it.r;
    int x = r.left, y = r.top, w = r.right - r.left, h = r.bottom - r.top;
    if (v) {
      x = (int)std::lround((r.left - v->ox) * v->scale);
      y = (int)std::lround((r.top - v->oy) * v->scale);
      w = std::max(1, (int)std::lround(w * v->scale));
      h = std::max(1, (int)std::lround(h * v->scale));
    }
    o += (i ? "," : "") + std::string("{\"ref\":\"e") + std::to_string(i + 1) + "\",\"role\":" + jq(it.role) + (it.name.empty() ? "" : ",\"name\":" + jq(it.name)) +
         (it.secret ? ",\"secret\":true" : it.value.empty() ? "" : ",\"value\":" + jq(it.value)) + (it.disabled ? ",\"disabled\":true" : "") + (it.focused ? ",\"focused\":true" : "") +
         ",\"box\":[" + std::to_string(x) + "," + std::to_string(y) + "," + std::to_string(w) + "," + std::to_string(h) + "]}";
  }
  return o + "]";
}
std::string winJson(const Win& w) { return "{\"id\":" + jq(idOf(w.h)) + ",\"title\":" + jq(maskText(clip(w.title, 160))) + ",\"app\":" + jq(clip(w.app, 80)) + "}"; }

Win* findWin(std::vector<Win>& all, const std::string& id, Result& res) {
  for (auto& w : all)
    if (idOf(w.h) == id) {
      if (w.sara) {
        res.code = "not_found";
        res.message = "That is one of Sara's own windows: she never looks at those.";
        return nullptr;
      }
      if (!w.hidden.empty()) {
        res.code = "blocked_window";
        res.message = "That window is hidden from Sara on this computer (" + w.hidden + ").";
        return nullptr;
      }
      if (w.minimized) {
        res.code = "not_found";
        res.message = "That window is minimized.";
        return nullptr;
      }
      return &w;
    }
  res.code = "not_found";
  res.message = "No such window (pc_windows lists them).";
  return nullptr;
}
/** The window in front: the first listed, visible, not hidden window in that area. */
Win* frontIn(std::vector<Win>& all, const RECT& area) {
  for (auto& w : all)
    if (listed(w) && w.hidden.empty() && !w.minimized && intersects(w.r, area)) return &w;
  return nullptr;
}

/** Marks: a numbered box for each element (picture pixels). */
void drawMarks(Dib& d, const std::vector<Item>& items, const View& v) {
  HPEN pen = CreatePen(PS_SOLID, 2, RGB(230, 30, 30));
  HGDIOBJ op = SelectObject(d.dc, pen), ob = SelectObject(d.dc, GetStockObject(NULL_BRUSH));
  HFONT f = CreateFontW(-12, 0, 0, 0, FW_BOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
  HGDIOBJ of = SelectObject(d.dc, f);
  SetBkMode(d.dc, OPAQUE);
  SetBkColor(d.dc, RGB(230, 30, 30));
  SetTextColor(d.dc, RGB(255, 255, 255));
  for (size_t i = 0; i < items.size(); i++) {
    const RECT& r = items[i].r;
    int x = (int)std::lround((r.left - v.ox) * v.scale), y = (int)std::lround((r.top - v.oy) * v.scale);
    int w = std::max(2, (int)std::lround((r.right - r.left) * v.scale)), h = std::max(2, (int)std::lround((r.bottom - r.top) * v.scale));
    Rectangle(d.dc, x, y, x + w, y + h);
    std::wstring n = std::to_wstring(i + 1);
    TextOutW(d.dc, x + 1, std::max(0, y - 13), n.c_str(), (int)n.size());
  }
  SelectObject(d.dc, of);
  DeleteObject(f);
  SelectObject(d.dc, ob);
  SelectObject(d.dc, op);
  DeleteObject(pen);
}

}  // namespace

void setServerOrigin(const std::string& origin) {
  std::lock_guard<std::mutex> l(g_m); g_serverAuthority = lower(origin);
}
void setExtraBlocklist(const std::string& lines) {
  std::lock_guard<std::mutex> l(g_m);
  g_extra.clear();
  size_t a = 0;
  while (a <= lines.size() && g_extra.size() < 40) {
    size_t b = lines.find('\n', a);
    std::string x = lower(lines.substr(a, b == std::string::npos ? std::string::npos : b - a));
    while (!x.empty() && (x.back() == '\r' || x.back() == ' ')) x.pop_back();
    while (!x.empty() && x.front() == ' ') x.erase(0, 1);
    if (x.size() >= 3) g_extra.push_back(x.substr(0, 80));
    if (b == std::string::npos) break;
    a = b + 1;
  }
}

std::string screensJson() {
  auto ms = monitors();
  std::string o = "[";
  for (size_t i = 0; i < ms.size(); i++) {
    char b[200];
    snprintf(b, sizeof b, "%s{\"id\":\"s%zu\",\"w\":%ld,\"h\":%ld,\"x\":%ld,\"y\":%ld,\"scale\":%.2f,\"primary\":%s}", i ? "," : "", i + 1, ms[i].r.right - ms[i].r.left, ms[i].r.bottom - ms[i].r.top, ms[i].r.left, ms[i].r.top,
             ms[i].dpi / 96.0, ms[i].primary ? "true" : "false");
    o += b;
  }
  return o + "]";
}

Result windows() {
  Result res;
  auto all = listAll();
  auto ms = monitors();
  HWND fg = GetForegroundWindow();
  std::string o = "{\"windows\":[";
  int n = 0;
  for (auto& w : all) {
    if (!listed(w) || n >= 60) continue;
    o += n++ ? "," : "";
    if (!w.hidden.empty()) {
      o += "{\"hidden\":" + jq(w.hidden) + "}";
      continue;
    }
    o += "{\"id\":" + jq(idOf(w.h)) + ",\"title\":" + jq(maskText(clip(w.title, 160))) + ",\"app\":" + jq(clip(w.app, 80)) + ",\"bounds\":[" + std::to_string(w.r.left) + "," + std::to_string(w.r.top) + "," +
         std::to_string(w.r.right - w.r.left) + "," + std::to_string(w.r.bottom - w.r.top) + "]" + (w.minimized ? ",\"minimized\":true" : "") + (w.h == fg ? ",\"focused\":true" : "") + ",\"screen\":" + jq(screenOf(w.h, ms)) + "}";
  }
  res.json = o + "]}";
  return res;
}

Result shot(const std::string& window, const std::string& screen, const std::vector<int>& area, int maxEdge, bool marks, int thumb) {
  Result res;
  Com com;
  {
    std::lock_guard<std::mutex> l(g_m);
    ULONGLONG now = GetTickCount64();
    if (now - g_lastShot < kShotEvery) {
      res.code = "rate_limited";
      res.message = "At most one picture every 500 ms.";
      return res;
    }
    g_lastShot = now;
  }
  maxEdge = std::clamp(maxEdge <= 0 ? kMaxEdge : maxEdge, 64, kMaxEdge);
  auto all = listAll();
  auto ms = monitors();
  RECT cap{};
  Win* win = nullptr;
  std::string screenId;
  if (!window.empty()) {
    win = findWin(all, window, res);
    if (!win) return res;
    cap = win->r;
  } else if (area.size() == 4) {
    cap = {area[0], area[1], area[0] + std::max(1, area[2]), area[1] + std::max(1, area[3])};
  } else {
    size_t i = 0;
    if (!screen.empty() && screen[0] == 's') i = (size_t)std::max(0, atoi(screen.c_str() + 1) - 1);
    if (ms.empty()) {
      res.code = "unsupported";
      res.message = "No screen found.";
      return res;
    }
    if (i >= ms.size()) i = 0;
    cap = ms[i].r;
    screenId = "s" + std::to_string(i + 1);
  }
  RECT virt{GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN), 0, 0};
  virt.right = virt.left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
  virt.bottom = virt.top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
  RECT clipped;
  if (!IntersectRect(&clipped, &cap, &virt) && !win) {
    res.code = "not_found";
    res.message = "That area is off the screen.";
    return res;
  }
  if (!win) cap = clipped;
  int cw = cap.right - cap.left, ch = cap.bottom - cap.top;
  if (cw <= 0 || ch <= 0) {
    res.code = "not_found";
    res.message = "That window has no size.";
    return res;
  }
  Dib full;
  if (!full.make(cw, ch)) {
    res.code = "unsupported";
    res.message = "Couldn't make the picture.";
    return res;
  }
  bool viaScreen = true;
  if (win) {
    // One window: PrintWindow draws just that window (whatever covers it); the frame is cut from it.
    RECT wr{};
    GetWindowRect(win->h, &wr);
    Dib whole;
    if (whole.make(std::max(1L, wr.right - wr.left), std::max(1L, wr.bottom - wr.top)) && PrintWindow(win->h, whole.dc, 2 /* PW_RENDERFULLCONTENT */)) {
      BitBlt(full.dc, 0, 0, cw, ch, whole.dc, cap.left - wr.left, cap.top - wr.top, SRCCOPY);
      viaScreen = full.allBlack();
    }
  }
  int blacked = 0, masked = 0;
  if (viaScreen) {
    // Sara's own windows (this app) are left out of the capture itself; other Sara windows are blacked out below.
    std::vector<std::pair<HWND, DWORD>> excluded;
    for (auto& w : all) {
      if (!w.own || !intersects(w.r, cap)) continue;
      DWORD was = 0;
      GetWindowDisplayAffinity(w.h, &was);
      if (was == 0x11 || SetWindowDisplayAffinity(w.h, 0x11 /* WDA_EXCLUDEFROMCAPTURE */)) {
        DWORD now = 0;
        GetWindowDisplayAffinity(w.h, &now);
        if (now == 0x11) excluded.push_back({w.h, was});
      }
    }
    if (!excluded.empty()) {
      DwmFlush();
      DwmFlush();
    }
    HDC sdc = GetDC(nullptr);
    BitBlt(full.dc, 0, 0, cw, ch, sdc, cap.left, cap.top, SRCCOPY | CAPTUREBLT);
    ReleaseDC(nullptr, sdc);
    for (auto& [h, was] : excluded)
      if (was != 0x11) SetWindowDisplayAffinity(h, was);
    // Locked, asleep or the screen saver: GDI gets nothing. Say so instead of sending a black picture.
    if (full.allBlack()) {
      res.code = "not_found";
      res.message = "The screen is locked, asleep or showing the screen saver, so Sara can't see it now (a single window may still work).";
      return res;
    }
    // Hidden windows and any Sara window that couldn't be left out: black, before anything else.
    for (auto& w : all) {
      if (w.minimized || !intersects(w.r, cap) || (win && w.h == win->h)) continue;
      bool exclOk = std::any_of(excluded.begin(), excluded.end(), [&](const std::pair<HWND, DWORD>& e) { return e.first == w.h; });
      if (!w.hidden.empty() || (w.sara && !exclOk)) {
        RECT r = {w.r.left - cap.left, w.r.top - cap.top, w.r.right - cap.left, w.r.bottom - cap.top};
        full.fill(r, RGB(0, 0, 0));
        if (!w.hidden.empty()) blacked++;
      }
    }
  }
  // Password fields: boxed out (the windows in that area, front first, at most 12).
  int looked = 0;
  for (auto& w : all) {
    if (looked >= 12) break;
    if (!listed(w) || !w.hidden.empty() || w.minimized || !intersects(w.r, cap)) continue;
    if (win && w.h != win->h) continue;
    looked++;
    for (RECT r : secretRects(w.h)) {
      OffsetRect(&r, -cap.left, -cap.top);
      full.fill(r, RGB(24, 24, 24));
      masked++;
    }
  }
  Dib pic;
  if (!scaled(full, maxEdge, pic)) {
    res.code = "unsupported";
    res.message = "Couldn't scale the picture.";
    return res;
  }
  View v;
  v.at = GetTickCount64();
  v.ox = cap.left;
  v.oy = cap.top;
  v.scale = (double)pic.w / cw;
  Win* boundWindow = win ? win : frontIn(all, cap);
  v.hwnd = boundWindow ? boundWindow->h : nullptr;
  v.title = boundWindow ? boundWindow->title : ""; v.app = boundWindow ? boundWindow->app : "";
  v.frame = boundWindow ? boundWindow->r : RECT{};
  v.width = pic.w; v.height = pic.h;
  if (boundWindow) { std::vector<Item> items; int total = 0; collect(boundWindow->h, kMaxElements, items, total); for (auto& it : items) v.identity.push_back(it.identity); }
  std::string extra;
  if (marks) {
    Win* target = win ? win : frontIn(all, cap);
    if (target) {
      std::vector<Item> items;
      int total = 0;
      collect(target->h, kMaxElements, items, total);
      drawMarks(pic, items, v);
      extra = ",\"items\":" + itemsJson(items, &v) + ",\"total\":" + std::to_string(total) + ",\"marksOf\":" + winJson(*target);
    }
  }
  if (!jpegOf(pic, 70, res.shot.jpeg)) {
    res.code = "unsupported";
    res.message = "Couldn't encode the picture.";
    return res;
  }
  res.shot.w = pic.w;
  res.shot.h = pic.h;
  if (thumb >= 64 && thumb <= 640) {
    Dib t;
    if (scaled(pic, thumb, t) && jpegOf(t, 55, res.thumb.jpeg)) {
      res.thumb.w = t.w;
      res.thumb.h = t.h;
    }
  }
  {
    std::lock_guard<std::mutex> l(g_m);
    res.viewId = "v" + std::to_string(++g_viewN);
    for (auto it = g_views.begin(); it != g_views.end();) it = v.at - it->second.at > kViewTtl * 3 ? g_views.erase(it) : std::next(it);
    g_views[res.viewId] = v;
  }
  char sc[32];
  snprintf(sc, sizeof sc, "%.4f", v.scale);
  res.json = "{\"viewId\":" + jq(res.viewId) + ",\"w\":" + std::to_string(pic.w) + ",\"h\":" + std::to_string(pic.h) + ",\"scale\":" + sc + ",\"blackedOut\":" + std::to_string(blacked) + ",\"masked\":" + std::to_string(masked) +
             (win ? ",\"window\":" + winJson(*win) : screenId.empty() ? ",\"area\":true" : ",\"screen\":" + jq(screenId)) + extra + "}";
  return res;
}

Result elements(const std::string& window, const std::string& viewId, int limit) {
  Result res;
  Com com;
  limit = std::clamp(limit <= 0 ? kMaxElements : limit, 1, kMaxElements);
  View v;
  bool hasView = false;
  if (!viewId.empty()) {
    std::lock_guard<std::mutex> l(g_m);
    auto it = g_views.find(viewId);
    if (it == g_views.end() || GetTickCount64() - it->second.at > kViewTtl) {
      res.code = "stale_view";
      res.message = "That picture is older than 20 seconds (or unknown): look again.";
      return res;
    }
    v = it->second;
    hasView = true;
  }
  auto all = listAll();
  Win* w = nullptr;
  if (!window.empty()) {
    w = findWin(all, window, res);
    if (!w) return res;
  } else {
    RECT big{-100000, -100000, 100000, 100000};
    w = frontIn(all, big);
    if (!w) {
      res.json = "{\"items\":[],\"total\":0}";
      return res;
    }
  }
  std::vector<Item> items;
  int total = 0;
  collect(w->h, limit, items, total);
  std::string vid = viewId;
  if (!hasView) {
    v.at = GetTickCount64(); v.hwnd = w->h; v.title = w->title; v.app = w->app; v.frame = w->r; v.scale = 1; v.width = GetSystemMetrics(SM_CXVIRTUALSCREEN); v.height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    // List-only views have no picture coordinates; refs remain usable without taking a screenshot.
    v.width = 0; v.height = 0;
    for (auto& it : items) v.identity.push_back(it.identity);
    std::lock_guard<std::mutex> l(g_m); vid = "v" + std::to_string(++g_viewN);
    for (auto i = g_views.begin(); i != g_views.end();) i = v.at - i->second.at > kViewTtl * 3 ? g_views.erase(i) : std::next(i);
    g_views[vid] = v;
  } else if (v.hwnd != w->h) { res.code = "stale_view"; res.message = "The window is not the window in this look."; return res; }
  res.json = "{\"viewId\":" + jq(vid) + ",\"window\":" + winJson(*w) + ",\"items\":" + itemsJson(items, hasView ? &v : nullptr) + ",\"total\":" + std::to_string(total) + (total > (int)items.size() ? ",\"more\":true" : "") + ",\"coords\":\"" +
             (hasView ? "picture" : "screen") + "\"}";
  return res;
}

namespace {
Result refusal(const std::string& code, const std::string& why) { Result r; r.code = code; r.message = why; return r; }
bool inputDesktop() {
  HDESK d = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS | DESKTOP_SWITCHDESKTOP);
  if (!d) return false;
  wchar_t name[128]{}; DWORD n = 0;
  bool ok = GetUserObjectInformationW(d, UOI_NAME, name, sizeof(name), &n) && _wcsicmp(name, L"Default") == 0;
  CloseDesktop(d); return ok;
}
bool elevated(HWND h) {
  DWORD pid = 0, n = 0; GetWindowThreadProcessId(h, &pid);
  HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid), t = nullptr;
  TOKEN_ELEVATION value{}; bool unknown = true;
  if (p && OpenProcessToken(p, TOKEN_QUERY, &t)) unknown = !GetTokenInformation(t, TokenElevation, &value, sizeof(value), &n);
  if (t) CloseHandle(t); if (p) CloseHandle(p);
  return unknown || value.TokenIsElevated != 0;
}
bool dangerousApp(const std::string& app) {
  static const std::regex re(R"((^|[ ._-])(explorer|cmd|powershell|pwsh|terminal|windowsterminal|conhost|bash|wsl|regedit|mmc|control|systemsettings|sara)([ ._-]|$))", std::regex::icase);
  return std::regex_search(app, re) || !blockedKind(app, app).empty();
}
bool neverAction(const std::string& label) {
  static const std::regex re(R"(\b(delete|remove|erase|trash|recycle|unlink)\b(?!\s+(my |your |this |the )?account\b)|run as administrator|elevat(ed|ion)|\buac\b|delete (a )?(file|folder)|remove (a )?(file|folder)|empty (the )?(trash|recycle)|move to trash|format (disk|drive)|security settings)", std::regex::icase);
  return std::regex_search(label, re);
}
bool onceAction(const std::string& label) {
  static const std::regex re(R"(\b(pay|payment|purchase|buy|checkout|order|donate|card|credit|billing|cvv|cvc|account|password|recovery|privacy|security|send|post|install|uninstall)\b|cc-number|cc-csc|2fa|two.factor)", std::regex::icase);
  return std::regex_search(label, re);
}
std::string authority(std::string raw) {
  raw = lower(raw);
  size_t scheme = raw.find("://"); if (scheme != std::string::npos) raw.erase(0, scheme + 3);
  raw = raw.substr(0, raw.find_first_of("/?#"));
  size_t user = raw.rfind('@'); if (user != std::string::npos) raw.erase(0, user + 1);
  while (!raw.empty() && isspace((unsigned char)raw.back())) raw.pop_back();
  while (!raw.empty() && isspace((unsigned char)raw.front())) raw.erase(0, 1);
  if (raw.size() > 4 && raw.substr(raw.size() - 4) == ":443") raw.resize(raw.size() - 4);
  else if (raw.size() > 3 && raw.substr(raw.size() - 3) == ":80") raw.resize(raw.size() - 3);
  return raw;
}
bool browserAllowed(HWND hwnd, const std::string& app) {
  bool webSurface = std::regex_search(app, std::regex("msedge|chrome|chromium|firefox|brave|opera|vivaldi|arc|zen|duckduckgo", std::regex::icase));
  // Registered browsers are identified by their executable, rather than relying on names.
  for (HKEY hive : {HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE}) {
    HKEY clients = nullptr;
    if (RegOpenKeyExW(hive, L"Software\\Clients\\StartMenuInternet", 0, KEY_READ, &clients) != ERROR_SUCCESS) continue;
    for (DWORD index = 0; index < 100; ++index) {
      wchar_t name[256]{}; DWORD len = 256;
      if (RegEnumKeyExW(clients, index, name, &len, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break;
      std::wstring key = std::wstring(name) + L"\\shell\\open\\command";
      wchar_t command[4096]{}; DWORD bytes = sizeof(command);
      if (RegGetValueW(clients, key.c_str(), nullptr, RRF_RT_REG_SZ, nullptr, command, &bytes) == ERROR_SUCCESS) {
        int count = 0; LPWSTR* argv = CommandLineToArgvW(command, &count);
        if (argv && count > 0 && lower(u8(std::filesystem::path(argv[0]).stem().wstring())) == lower(app)) webSurface = true;
        if (argv) LocalFree(argv);
      }
    }
    RegCloseKey(clients);
  }
  auto u = uia(); ComPtr<IUIAutomationElement> root; ComPtr<IUIAutomationTreeWalker> walk;
  if (!u || FAILED(u->ElementFromHandle(hwnd, &root)) || FAILED(u->get_ControlViewWalker(&walk))) return false;
  std::string own; { std::lock_guard<std::mutex> l(g_m); own = authority(g_serverAuthority); }
  if (own.empty()) return false;
  int nodes = 0; bool found = false, ownPage = false, editingAddress = false;
  std::function<void(IUIAutomationElement*, int)> scan = [&](IUIAutomationElement* e, int depth) {
    if (depth > 8 || ++nodes > 1000 || ownPage) return;
    CONTROLTYPEID type = 0; e->get_CurrentControlType(&type);
    BSTR framework = nullptr; e->get_CurrentFrameworkId(&framework);
    if (framework) { if (std::regex_search(u8(framework), std::regex("chrome|mozilla|webkit|internetexplorer", std::regex::icase))) webSurface = true; SysFreeString(framework); }
    // Page contents cannot impersonate the browser's native address bar.
    if (type == UIA_DocumentControlTypeId) return;
    if (type == UIA_EditControlTypeId || type == UIA_ComboBoxControlTypeId) {
      BSTR id = nullptr, name = nullptr; e->get_CurrentAutomationId(&id); e->get_CurrentName(&name);
      std::string label = lower((id ? u8(id) : "") + " " + (name ? u8(name) : "")); SysFreeString(id); SysFreeString(name);
      if (std::regex_search(label, std::regex("address|omnibox|url|adresse|direcci|endere|indirizzo|location"))) {
        BOOL focused = FALSE; e->get_CurrentHasKeyboardFocus(&focused); editingAddress = editingAddress || focused;
        BOOL secret = TRUE; e->get_CurrentIsPassword(&secret);
        ComPtr<IUIAutomationValuePattern> value;
        if (!secret && SUCCEEDED(e->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&value))) && value) {
          BSTR text = nullptr;
          if (SUCCEEDED(value->get_CurrentValue(&text)) && text) {
            std::string site = authority(u8(text)); found = !site.empty(); ownPage = site == own; SysFreeString(text);
          }
        }
      }
    }
    ComPtr<IUIAutomationElement> child; walk->GetFirstChildElement(e, &child);
    while (child) { scan(child.Get(), depth + 1); ComPtr<IUIAutomationElement> next; walk->GetNextSiblingElement(child.Get(), &next); child = next; }
  };
  scan(root.Get(), 0);
  return !webSurface && !found ? true : found && !ownPage && !editingAddress;
}
bool secureAncestors(IUIAutomation* u, IUIAutomationElement* element, std::string* labels = nullptr) {
  ComPtr<IUIAutomationTreeWalker> walker; if (FAILED(u->get_ControlViewWalker(&walker))) return true;
  ComPtr<IUIAutomationElement> current = element;
  for (int depth = 0; current && depth < 12; ++depth) {
    BOOL password = TRUE;
    if (FAILED(current->get_CurrentIsPassword(&password)) || password) return true;
    if (labels) { BSTR name = nullptr; current->get_CurrentName(&name); if (name) { *labels += " " + maskText(u8(name)); SysFreeString(name); } }
    ComPtr<IUIAutomationElement> parent; walker->GetParentElement(current.Get(), &parent); current = parent;
  }
  return false;
}
struct Bound { View view; Win win; Item item; POINT point{}; };
Result bind(const Action& a, Bound& b, bool activate, bool approvedRefresh = false) {
  if (!inputDesktop()) return refusal("denied_local", "The screen is locked or the secure desktop is active; Sara cannot control it.");
  {
    std::lock_guard<std::mutex> l(g_m); auto i = g_views.find(a.viewId);
    if (i == g_views.end() || GetTickCount64() - i->second.at > (approvedRefresh ? 600000 : kViewTtl)) return refusal("stale_view", "That look is older than 20 seconds: look again.");
    b.view = i->second;
  }
  auto all = listAll(); Result r;
  Win* w = findWin(all, a.window.empty() ? idOf(b.view.hwnd) : a.window, r);
  if (!w) return r;
  if (!w->h || w->h != b.view.hwnd || w->title != b.view.title || w->app != b.view.app || !EqualRect(&w->r, &b.view.frame)) return refusal("stale_view", "The target window changed or is not the window in this look.");
  b.win = *w;
  if (elevated(w->h)) return refusal("denied_local", "I can't control windows running as administrator");
  if (dangerousApp(w->app)) return refusal("denied_local", "Terminal, system settings and protected applications are not desktop input targets.");
  if (!browserAllowed(w->h, w->app)) return refusal("denied_local", "Sara cannot control her own server/sign-in in a browser, or a browser whose address cannot be checked safely.");
  if (activate && GetForegroundWindow() != w->h) SetForegroundWindow(w->h);
  if (GetForegroundWindow() != w->h) return refusal("denied_local", "The target window is not in front. Look again when it is.");
  std::vector<Item> items; int total = 0; collect(w->h, kMaxElements, items, total);
  if (items.size() != b.view.identity.size()) return refusal("stale_view", "The controls changed: look again.");
  for (size_t i = 0; i < items.size(); ++i) if (items[i].identity != b.view.identity[i]) return refusal("stale_view", "A control changed: look again.");
  int index = -1;
  if (!a.ref.empty()) {
    if (!std::regex_match(a.ref, std::regex("e[1-9][0-9]{0,3}"))) return refusal("stale_view", "That ref is not in this look.");
    index = atoi(a.ref.c_str() + 1) - 1;
    if (index < 0 || index >= (int)items.size()) return refusal("stale_view", "That ref is not in this look.");
    RECT f = items[index].r; b.point = {(f.left + f.right) / 2, (f.top + f.bottom) / 2};
  } else {
    if (!std::isfinite(a.x) || !std::isfinite(a.y) || a.x < 0 || a.y < 0 || a.x >= b.view.width || a.y >= b.view.height) return refusal("denied_local", "The point is outside this picture; list-only looks require a ref.");
    b.point = {(LONG)std::lround(b.view.ox + a.x / b.view.scale), (LONG)std::lround(b.view.oy + a.y / b.view.scale)};
    auto u = uia(); ComPtr<IUIAutomationElement> at;
    if (!u || FAILED(u->ElementFromPoint(b.point, &at)) || !at) return refusal("denied_local", "The target cannot be inspected safely.");
    BOOL secure = TRUE; if (FAILED(at->get_CurrentIsPassword(&secure)) || secure) return refusal("denied_local", "That is a password or secure field.");
    for (size_t i = 0; i < items.size(); ++i) { BOOL same = FALSE; if (SUCCEEDED(u->CompareElements(items[i].element.Get(), at.Get(), &same)) && same) { index = (int)i; break; } }
    // Canvas controls may lack a named ref; inspect the actual hit element before using coordinates.
    if (index < 0) {
      b.item.element = at; b.item.r = {b.point.x, b.point.y, b.point.x + 1, b.point.y + 1};
      BSTR title = nullptr; at->get_CurrentName(&title); b.item.name = title ? u8(title) : ""; SysFreeString(title);
      BOOL enabled = FALSE; if (FAILED(at->get_CurrentIsEnabled(&enabled)) || !enabled) b.item.disabled = true;
      CONTROLTYPEID type = 0; at->get_CurrentControlType(&type); b.item.role = roleOf(type);
    }
  }
  if (index >= 0) b.item = items[index];
  auto automation = uia();
  std::string context;
  if (!automation || secureAncestors(automation.Get(), b.item.element.Get(), &context)) return refusal("denied_local", "That is a password or secure field.");
  ComPtr<IUIAutomationElement> actualHit;
  if (FAILED(automation->ElementFromPoint(b.point, &actualHit)) || !actualHit || secureAncestors(automation.Get(), actualHit.Get(), &context)) return refusal("denied_local", "The point is a secure or uninspectable control.");
  BOOL exact = FALSE; automation->CompareElements(b.item.element.Get(), actualHit.Get(), &exact);
  bool pointAction = a.op == "d.drag" || (a.op == "d.click" && (a.right || a.twice));
  if (a.op == "d.click" && !a.right && !a.twice) {
    ComPtr<IUIAutomationInvokePattern> invoke;
    pointAction = FAILED(b.item.element->GetCurrentPatternAs(UIA_InvokePatternId, IID_PPV_ARGS(&invoke))) || !invoke;
  }
  if (pointAction && !exact) return refusal("stale_view", "That container's point hits a different control. Look again and use that control's ref.");
  b.item.name += context;
  if (b.item.secret) return refusal("denied_local", "That is a password field: Sara never types or presses keys into those.");
  if (b.item.disabled) return refusal("denied_local", "That control is disabled.");
  if (GetAncestor(WindowFromPoint(b.point), GA_ROOT) != w->h) return refusal("denied_local", "Another window covers that point. Sara will not act on it.");
  if (neverAction(b.item.name)) return refusal("denied_local", "That protected desktop action is always refused.");
  // Even keys aimed at an innocent ref must not spill into a secure focused control.
  auto u = uia(); ComPtr<IUIAutomationElement> focus;
  if (!u || FAILED(u->GetFocusedElement(&focus)) || !focus) return refusal("denied_local", "The focused control cannot be inspected safely.");
  BOOL secure = TRUE;
  if (FAILED(focus->get_CurrentIsPassword(&secure)) || secure || secureAncestors(u.Get(), focus.Get())) return refusal("denied_local", "A password or secure field is focused. Sara cannot send input.");
  return {};
}
Result launch(const Action& a, bool execute, const std::function<bool()>& cancelled = [] { return false; }) {
  if (!inputDesktop()) return refusal("denied_local", "The screen is locked or the secure desktop is active.");
  if (a.app.empty() || a.app.size() > 100 || a.app.find_first_of("\\/:\"|<>\r\n") != std::string::npos || dangerousApp(a.app)) return refusal("denied_local", "Choose an installed Start-menu app by its name; commands, paths and protected apps are refused.");
  std::wstring path;
  for (const KNOWNFOLDERID* folder : {&FOLDERID_StartMenu, &FOLDERID_CommonStartMenu}) {
    PWSTR root = nullptr; if (FAILED(SHGetKnownFolderPath(*folder, 0, nullptr, &root))) continue;
    std::error_code ec;
    for (auto i = std::filesystem::recursive_directory_iterator(root, std::filesystem::directory_options::skip_permission_denied, ec); !ec && i != std::filesystem::recursive_directory_iterator(); i.increment(ec)) {
      if (i->is_symlink(ec)) { i.disable_recursion_pending(); continue; }
      if (lower(u8(i->path().extension().wstring())) == ".lnk" && lower(u8(i->path().stem().wstring())) == lower(a.app)) { path = i->path().wstring(); break; }
    }
    CoTaskMemFree(root); if (!path.empty()) break;
  }
  if (path.empty()) return refusal("not_found", "No installed Start-menu shortcut has that name.");
  ComPtr<IShellLinkW> link; ComPtr<IPersistFile> persist;
  if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link))) || FAILED(link.As(&persist)) || FAILED(persist->Load(path.c_str(), STGM_READ))) return refusal("denied_local", "That shortcut could not be inspected.");
  wchar_t exe[32768]{}, args[32768]{}; WIN32_FIND_DATAW fd{};
  if (FAILED(link->GetPath(exe, 32768, &fd, SLGP_RAWPATH)) || !*exe || FAILED(link->GetArguments(args, 32768)) || *args || dangerousApp(u8(std::filesystem::path(exe).stem().wstring()))) return refusal("denied_local", "Shortcuts with command arguments or protected targets are refused.");
  ComPtr<IShellLinkDataList> data; DWORD flags = 0;
  if (FAILED(link.As(&data)) || FAILED(data->GetFlags(&flags)) || (flags & SLDF_RUNAS_USER)) return refusal("denied_local", "Administrator shortcuts are refused.");
  HMODULE binary = LoadLibraryExW(exe, nullptr, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
  if (!binary) return refusal("denied_local", "The installed app could not be inspected.");
  bool admin = false;
  HRSRC manifest = FindResourceW(binary, MAKEINTRESOURCEW(1), RT_MANIFEST);
  if (manifest) { HGLOBAL m = LoadResource(binary, manifest); auto bytes = static_cast<const char*>(LockResource(m)); if (bytes) { std::string xml(bytes, SizeofResource(binary, manifest)); admin = xml.find("requireAdministrator") != std::string::npos || xml.find("highestAvailable") != std::string::npos; } }
  FreeLibrary(binary);
  if (admin) return refusal("denied_local", "Administrator applications are refused.");
  if (execute) {
    if (cancelled()) return refusal("stopped", "Stopped before opening the app.");
    if (!inputDesktop()) return refusal("denied_local", "The screen is locked or the secure desktop is active.");
    SHELLEXECUTEINFOW si{sizeof(si)}; si.fMask = SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC; si.lpFile = exe; si.nShow = SW_SHOWNORMAL;
    if (cancelled()) return refusal("stopped", "Stopped before opening the app.");
    if (!ShellExecuteExW(&si)) return refusal("not_found", "That app could not be opened.");
  }
  Result r; r.json = "{\"launched\":" + jq(a.app) + "}"; return r;
}
}

Result inspect(const Action& a, ActionInfo& info) {
  Com com;
  if (a.op == "d.launch") { info.target = "Open installed app: " + a.app; info.once = onceAction(a.app); return launch(a, false); }
  Bound b; auto r = bind(a, b, false); if (!r.code.empty()) return r;
  if (a.op == "d.keys" && !std::regex_match(lower(a.combo), std::regex("enter|tab|shift\\+tab|escape|arrowleft|arrowright|arrowup|arrowdown|home|end|pageup|pagedown|backspace|ctrl\\+a"))) return refusal("denied_local", "That key combination is not on the safe desktop key list.");
  if (a.text.size() > 8000 || maskText(a.text) != a.text) return refusal("denied_local", "That text is too long or looks like a secret.");
  info.target = a.op + " in " + b.win.title + " / " + b.item.role + " " + b.item.name;
  if (a.op == "d.type") info.target += "\nText: " + a.text;
  if (a.op == "d.keys") info.target += "\nKeys: " + a.combo;
  info.once = onceAction(b.win.title + " " + b.item.name + " " + a.text);
  if (a.op == "d.drag") {
    Action destination = a; destination.ref.clear(); destination.x = a.toX; destination.y = a.toY;
    Bound end; auto checked = bind(destination, end, false); if (!checked.code.empty()) return checked;
    info.target += "\nDrop on: " + end.item.role + " " + end.item.name;
    info.once = info.once || onceAction(end.item.name);
  }
  return {};
}

Result refreshApproved(Action& a) {
  Com com; Bound b; auto r = bind(a, b, true, true); if (!r.code.empty()) return r;
  b.view.at = GetTickCount64();
  std::lock_guard<std::mutex> l(g_m); a.viewId = "v" + std::to_string(++g_viewN); g_views[a.viewId] = b.view;
  return {};
}

Result input(const Action& a, const std::function<bool()>& cancelled) {
  Com com;
  if (cancelled()) return refusal("stopped", "Stopped before desktop input.");
  if (a.op == "d.launch") return launch(a, true, cancelled);
  Bound b; auto r = bind(a, b, true); if (!r.code.empty()) return r;
  bool dragging = false;
  auto guard = [&]() {
    if (cancelled()) return false;
    if (!dragging) {
      Bound check; if (!bind(a, check, false).code.empty()) return false;
      auto u = uia(); BOOL same = FALSE;
      return u && SUCCEEDED(u->CompareElements(b.item.element.Get(), check.item.element.Get(), &same)) && same && b.item.name == check.item.name && b.item.role == check.item.role;
    }
    // A dragged widget may move its bounds. Keep the native source identity and recheck
    // the window and sensitive state instead of treating our own movement as a stale look.
    auto all = listAll(); Result check; auto w = findWin(all, idOf(b.win.h), check);
    auto u = uia(); BOOL enabled = FALSE;
    return w && w->h == GetForegroundWindow() && inputDesktop() && !elevated(w->h) && browserAllowed(w->h, w->app) && u &&
      SUCCEEDED(b.item.element->get_CurrentIsEnabled(&enabled)) && enabled && !secureAncestors(u.Get(), b.item.element.Get());
  };
  auto send = [&](std::vector<INPUT> events) {
    if (!guard()) return false;
    for (auto& e : events) { if (e.type == INPUT_MOUSE) e.mi.dwExtraInfo = kInputTag; else e.ki.dwExtraInfo = kInputTag; }
    return SendInput((UINT)events.size(), events.data(), sizeof(INPUT)) == events.size();
  };
  auto move = [&](POINT p) {
    if (GetAncestor(WindowFromPoint(p), GA_ROOT) != b.win.h) return false;
    if (dragging) {
      auto u = uia(); ComPtr<IUIAutomationElement> hit; std::string labels;
      if (!u || FAILED(u->ElementFromPoint(p, &hit)) || !hit || secureAncestors(u.Get(), hit.Get(), &labels) || neverAction(labels)) return false;
    }
    INPUT e{}; e.type = INPUT_MOUSE; e.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    e.mi.dx = MulDiv(p.x - GetSystemMetrics(SM_XVIRTUALSCREEN), 65535, std::max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN) - 1));
    e.mi.dy = MulDiv(p.y - GetSystemMetrics(SM_YVIRTUALSCREEN), 65535, std::max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN) - 1));
    return send({e});
  };
  auto mouse = [&](DWORD flag) { INPUT e{}; e.type = INPUT_MOUSE; e.mi.dwFlags = flag; return e; };
  bool done = false;
  if (a.op == "d.click" && !a.right && !a.twice) {
    ComPtr<IUIAutomationInvokePattern> pattern;
    if (SUCCEEDED(b.item.element->GetCurrentPatternAs(UIA_InvokePatternId, IID_PPV_ARGS(&pattern))) && pattern) {
      if (!guard()) return refusal("stopped", "Stopped before Invoke.");
      if (FAILED(pattern->Invoke())) return refusal("denied_local", "The control refused its accessibility action.");
      done = true;
    }
  }
  if (a.op == "d.type") {
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, a.text.data(), (int)a.text.size(), nullptr, 0);
    if ((!a.text.empty() && n == 0) || n > 2000 || maskText(a.text) != a.text) return refusal("denied_local", "Text must be valid, non-secret and at most 2,000 characters.");
    std::wstring text(n, 0); MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, a.text.data(), (int)a.text.size(), text.data(), n);
    ComPtr<IUIAutomationValuePattern> pattern;
    if (SUCCEEDED(b.item.element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&pattern))) && pattern) {
      if (!guard()) return refusal("stopped", "Stopped before SetValue.");
      BSTR value = SysAllocStringLen(text.data(), (UINT)text.size()); HRESULT set = pattern->SetValue(value); SysFreeString(value);
      if (FAILED(set)) return refusal("denied_local", "The field refused its accessibility value action.");
      done = true;
    } else {
      if (FAILED(b.item.element->SetFocus())) return refusal("denied_local", "The target could not receive keyboard focus.");
      auto u = uia(); ComPtr<IUIAutomationElement> focus; BOOL same = FALSE;
      if (!u || FAILED(u->GetFocusedElement(&focus)) || FAILED(u->CompareElements(focus.Get(), b.item.element.Get(), &same)) || !same) return refusal("denied_local", "Focus is not on the target field.");
      for (wchar_t ch : text) { INPUT down{}; down.type = INPUT_KEYBOARD; down.ki.wScan = ch; down.ki.dwFlags = KEYEVENTF_UNICODE; INPUT up = down; up.ki.dwFlags |= KEYEVENTF_KEYUP; if (!send({down, up})) return refusal("stopped", "Text input was interrupted; some characters may have been entered."); }
      done = true;
    }
  }
  if (a.op == "d.keys") {
    static const std::map<std::string, int> keys = {{"enter", VK_RETURN}, {"tab", VK_TAB}, {"shift+tab", VK_TAB}, {"escape", VK_ESCAPE}, {"arrowleft", VK_LEFT}, {"arrowright", VK_RIGHT}, {"arrowup", VK_UP}, {"arrowdown", VK_DOWN}, {"home", VK_HOME}, {"end", VK_END}, {"pageup", VK_PRIOR}, {"pagedown", VK_NEXT}, {"backspace", VK_BACK}, {"ctrl+a", static_cast<WORD>('A')}};
    auto key = keys.find(lower(a.combo)); if (key == keys.end()) return refusal("denied_local", "That key combination is not on the safe desktop key list.");
    if (FAILED(b.item.element->SetFocus())) return refusal("denied_local", "The target could not receive keyboard focus.");
    auto u = uia(); ComPtr<IUIAutomationElement> focus; BOOL same = FALSE;
    if (!u || FAILED(u->GetFocusedElement(&focus)) || FAILED(u->CompareElements(focus.Get(), b.item.element.Get(), &same)) || !same) return refusal("denied_local", "Focus is not on the target control.");
    std::vector<INPUT> events;
    auto k = [&](WORD vk, bool up) { INPUT e{}; e.type = INPUT_KEYBOARD; e.ki.wVk = vk; e.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0; events.push_back(e); };
    WORD modifier = lower(a.combo) == "ctrl+a" ? VK_CONTROL : lower(a.combo) == "shift+tab" ? VK_SHIFT : 0;
    if (modifier) k(modifier, false); k(static_cast<WORD>(key->second), false); k(static_cast<WORD>(key->second), true); if (modifier) k(modifier, true);
    done = send(events);
  }
  if (a.op == "d.scroll") {
    if (!std::isfinite(a.dx) || !std::isfinite(a.dy) || std::abs(a.dx) > 2400 || std::abs(a.dy) > 2400) return refusal("denied_local", "Scroll amount is outside the limit.");
    ComPtr<IUIAutomationScrollPattern> pattern;
    if (SUCCEEDED(b.item.element->GetCurrentPatternAs(UIA_ScrollPatternId, IID_PPV_ARGS(&pattern))) && pattern) {
      if (!guard()) return refusal("stopped", "Stopped before Scroll.");
      auto amount = [](double n) { return n == 0 ? ScrollAmount_NoAmount : n > 0 ? ScrollAmount_SmallIncrement : ScrollAmount_SmallDecrement; };
      if (FAILED(pattern->Scroll(amount(a.dx), amount(a.dy)))) return refusal("denied_local", "The control refused its accessibility scroll action."); done = true;
    } else if (move(b.point)) {
      INPUT v = mouse(MOUSEEVENTF_WHEEL); v.mi.mouseData = (DWORD)-(LONG)a.dy;
      INPUT h = mouse(MOUSEEVENTF_HWHEEL); h.mi.mouseData = (DWORD)(LONG)a.dx;
      done = send({v, h});
    }
  }
  if (!done && a.op == "d.click") {
    if (!move(b.point)) return refusal("stopped", "The click target is no longer available.");
    done = true;
    for (int i = 0; i < (a.twice ? 2 : 1); ++i) if (!send({mouse(a.right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN), mouse(a.right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP)})) { done = false; break; }
  }
  if (a.op == "d.drag") {
    if (!std::isfinite(a.toX) || !std::isfinite(a.toY) || a.toX < 0 || a.toY < 0 || a.toX >= b.view.width || a.toY >= b.view.height) return refusal("denied_local", "The drag endpoint is outside this picture.");
    POINT end{(LONG)std::lround(b.view.ox + a.toX / b.view.scale), (LONG)std::lround(b.view.oy + a.toY / b.view.scale)};
    // Reject secure fields at the destination as well as the source.
    auto u = uia(); ComPtr<IUIAutomationElement> hit; BOOL secure = TRUE;
    std::string labels;
    if (!u || FAILED(u->ElementFromPoint(end, &hit)) || !hit || FAILED(hit->get_CurrentIsPassword(&secure)) || secure || secureAncestors(u.Get(), hit.Get(), &labels) || neverAction(labels)) return refusal("denied_local", "The drag endpoint is protected, secure or uninspectable.");
    if (!move(b.point) || !send({mouse(MOUSEEVENTF_LEFTDOWN)})) return refusal("stopped", "The drag could not start.");
    dragging = true;
    done = true;
    for (int i = 1; i <= 8; ++i) { POINT p{b.point.x + MulDiv(end.x - b.point.x, i, 8), b.point.y + MulDiv(end.y - b.point.y, i, 8)}; if (!move(p)) { done = false; break; } }
    // Always release Sara's held button, even after takeover, to avoid leaving the user dragging.
    INPUT up = mouse(MOUSEEVENTF_LEFTUP); up.mi.dwExtraInfo = kInputTag; if (SendInput(1, &up, sizeof(INPUT)) != 1) done = false;
  }
  if (!done) return refusal("stopped", "Desktop input was interrupted or refused; look again before trying.");
  Result after = elements(idOf(b.win.h), "", kMaxElements);
  if (!after.code.empty()) return refusal(after.code, "The action ran, but verification failed: " + after.message);
  after.json = "{\"changed\":true,\"method\":\"accessibility-or-tagged-input\",\"after\":" + after.json + "}"; return after;
}
#ifdef SARA_TEST_HOOKS
std::string policyConformance() {
  std::vector<std::pair<std::string, bool>> checks;
  for (const char* label : {"Pay", "Card number", "Credit card", "Account settings"}) checks.push_back({std::string(label) + " requires approve-once", onceAction(label)});
  checks.push_back({"File deletion is refused", neverAction("Delete file")});
  checks.push_back({"Account removal remains approve-once", !neverAction("Delete account") && onceAction("Delete account")});
  checks.push_back({"Real mouse input is not Sara", !ownMouseInput(0, kInputTag)});
  checks.push_back({"Other injected mouse input is not Sara", !ownMouseInput(LLMHF_INJECTED, 123)});
  checks.push_back({"Tagged injected mouse input is Sara", ownMouseInput(LLMHF_INJECTED, kInputTag)});
  checks.push_back({"Real keyboard input is not Sara", !ownKeyInput(0, kInputTag)});
  checks.push_back({"Other injected keyboard input is not Sara", !ownKeyInput(LLKHF_INJECTED, 123)});
  checks.push_back({"Tagged injected keyboard input is Sara", ownKeyInput(LLKHF_INJECTED, kInputTag)});
  checks.push_back({"Own server authority canonicalizes", authority("http://localhost:7885/sign-in") == authority("localhost:7885")});
  int failed = 0; std::string out = "{\"checks\":[";
  for (size_t i = 0; i < checks.size(); ++i) { if (!checks[i].second) failed++; out += (i ? "," : "") + std::string("{\"name\":") + jq(checks[i].first) + ",\"ok\":" + (checks[i].second ? "true" : "false") + "}"; }
  return out + "],\"passed\":" + std::to_string(checks.size() - failed) + ",\"failed\":" + std::to_string(failed) + "}";
}
#endif
}  // namespace sarascreen
