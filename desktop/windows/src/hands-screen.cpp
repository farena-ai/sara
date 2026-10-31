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

using Microsoft::WRL::ComPtr;

namespace sarascreen {
namespace {

constexpr int kMaxEdge = 1280, kMaxElements = 300, kMaxDepth = 8, kMaxNodes = 2500;
constexpr ULONGLONG kViewTtl = 20000, kShotEvery = 500;

std::mutex g_m;
std::vector<std::string> g_extra;
struct View {
  ULONGLONG at = 0;
  int ox = 0, oy = 0;
  double scale = 1;
  HWND hwnd = nullptr;
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
  v.hwnd = win ? win->h : nullptr;
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
  res.json = "{\"window\":" + winJson(*w) + ",\"items\":" + itemsJson(items, hasView ? &v : nullptr) + ",\"total\":" + std::to_string(total) + (total > (int)items.size() ? ",\"more\":true" : "") + ",\"coords\":\"" +
             (hasView ? "picture" : "screen") + "\"}";
  return res;
}

}  // namespace sarascreen
