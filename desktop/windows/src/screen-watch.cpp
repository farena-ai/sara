// V4.5 Screen companion. See screen-watch.h for the rules (the reference is src/screen-companion.ts).
#define NOMINMAX
#include "screen-watch.h"

#include "hands-screen.h"
#include "quick-context.h"

#include <UIAutomation.h>
#include <wrl/client.h>

#include <algorithm>

using Microsoft::WRL::ComPtr;

namespace sarawatch {
namespace {

// The word lists (lower case), the same as src/screen-companion.ts ERROR_WORDS / FORM_WORDS / HANG_WORDS.
const wchar_t* const kErrorWords[] = {
    L"error", L"failed", L"failure", L"could not", L"couldn't", L"cannot", L"can't", L"unable to", L"exception", L"has stopped working",
    L"something went wrong", L"access is denied", L"access denied", L"permission denied", L"timed out", L"not found", L"crashed", L"fatal",
    L"no se pudo", L"no se puede", L"falló", L"ha fallado", L"acceso denegado",
    L"erreur", L"échec", L"impossible de", L"a échoué", L"accès refusé",
    L"fehler", L"fehlgeschlagen", L"konnte nicht", L"kann nicht", L"zugriff verweigert",
    L"erro", L"falhou", L"falha", L"não foi possível", L"acesso negado",
    L"errore", L"impossibile", L"non è stato possibile", L"accesso negato"};
const wchar_t* const kFormWords[] = {
    L"required", L"is missing", L"please enter", L"please fill", L"must be", L"invalid", L"not valid", L"incorrect",
    L"obligatorio", L"no es válido", L"obligatoire", L"n'est pas valide", L"erforderlich", L"pflichtfeld", L"ungültig",
    L"obrigatório", L"inválido", L"obbligatorio", L"non valido"};
const wchar_t* const kHangWords[] = {L"not responding", L"no responde", L"ne répond pas", L"reagiert nicht", L"não responde", L"non risponde"};

bool wordChar(wchar_t c) { return c && IsCharAlphaNumericW(c); }
std::wstring fold(std::wstring t) {
  if (!t.empty()) CharLowerBuffW(t.data(), (DWORD)t.size());
  for (auto& c : t)
    if (c == 0x2018 || c == 0x2019) c = L'\'';
  return t;
}
/** Control characters and runs of white space become one space; trimmed. */
std::wstring tidy(const std::wstring& s) {
  std::wstring o;
  bool space = false;
  for (wchar_t c : s) {
    if (c < 0x20 || c == 0x7f || iswspace(c)) {
      space = !o.empty();
      continue;
    }
    if (space) o += L' ';
    space = false;
    o += c;
  }
  return o;
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
/** Key-shaped text masked (her hands' shapes), at most kLineLen characters. */
std::wstring cut(const std::wstring& s) {
  std::wstring m = wide(sarascreen::maskSecrets(u8(s)));
  if ((int)m.size() > kLineLen) {
    m.resize(kLineLen - 1);
    m += L"\u2026";
  }
  return m;
}

}  // namespace

bool hasWord(const std::wstring& text, const wchar_t* const* words, size_t n) {
  std::wstring t = fold(text);
  for (size_t k = 0; k < n; k++) {
    std::wstring w = words[k];
    for (size_t i = t.find(w); i != std::wstring::npos; i = t.find(w, i + 1)) {
      wchar_t before = i ? t[i - 1] : 0, after = i + w.size() < t.size() ? t[i + w.size()] : 0;
      if (!wordChar(before) && !wordChar(after)) return true;
    }
  }
  return false;
}
bool errorWord(const std::wstring& t) { return hasWord(t, kErrorWords, std::size(kErrorWords)); }
bool formWord(const std::wstring& t) { return hasWord(t, kFormWords, std::size(kFormWords)); }
bool hangWord(const std::wstring& t) { return hasWord(t, kHangWords, std::size(kHangWords)); }

Finding finding(const Look& look) {
  if (look.own || !look.hidden.empty()) return {};
  std::wstring title = tidy(look.title);
  std::vector<std::wstring> texts;
  for (size_t i = 0; i < look.texts.size() && i < (size_t)kMaxTexts; i++) {
    std::wstring t = tidy(look.texts[i]);
    if (!t.empty() && (int)t.size() <= kMaxTextLen) texts.push_back(t);
  }
  if (look.dialog) {
    for (auto& t : texts)
      if (errorWord(t)) return {L"error", cut(t)};
    if (!title.empty() && errorWord(title)) return {L"error", cut(title)};
  }
  if (!title.empty() && hangWord(title)) return {L"error", cut(title)};
  for (auto& t : texts)
    if (formWord(t)) return {L"form", cut(t)};
  return {};
}

uint32_t hash(const std::wstring& s) {
  uint32_t h = 0x811c9dc5u;
  for (wchar_t c : s) {
    h ^= (uint32_t)(uint16_t)c;
    h *= 0x01000193u;
  }
  return h;
}

bool Watch::check(const Look& look, long long now, Offer& out) {
  Finding f = on && now >= pausedUntil_ ? finding(look) : Finding{};
  if (f.kind.empty()) {
    streakFp_ = 0;
    streakN_ = 0;
    return false;
  }
  std::wstring app = tidy(look.app).substr(0, 80);
  uint32_t fp = hash(f.kind + L"\n" + app + L"\n" + f.line);
  if (streakFp_ == fp) streakN_++;
  else {
    streakFp_ = fp;
    streakN_ = 1;
  }
  if (f.kind == L"form" && streakN_ < kStuckChecks) return false;
  if (std::find(offered_.begin(), offered_.end(), fp) != offered_.end()) return false;
  if (lastOffer_ >= 0 && now - lastOffer_ < kCooldownMs) return false;
  offered_.push_back(fp);
  if ((int)offered_.size() > kRemember) offered_.pop_front();
  lastOffer_ = now;
  out = {f.kind, app, f.line};
  return true;
}

Look lookAt(HWND w) {
  Look look;
  if (!w || !IsWindow(w)) return look;
  std::string kind = sarascreen::hiddenKindOf(w);
  if (kind == "sara") {
    look.own = true;
    return look;
  }
  if (!kind.empty()) {
    look.hidden = kind;
    return look;
  }
  wchar_t t[512];
  int n = InternalGetWindowText(w, t, 512);  // never sends WM_GETTEXT
  look.title.assign(t, std::max(0, n));
  look.app = saractx::appLabel(w);
  wchar_t cls[64] = {};
  GetClassNameW(w, cls, 64);
  RECT r{};
  GetWindowRect(w, &r);
  LONG style = GetWindowLongW(w, GWL_STYLE);
  bool compact = (r.right - r.left) < 1000 && (r.bottom - r.top) < 700;
  look.dialog = std::wstring(cls) == L"#32770" || (GetWindow(w, GW_OWNER) && (style & WS_POPUP) && compact);

  // The names of its controls (labels, messages, buttons), depth-first, with a time limit.
  ComPtr<IUIAutomation> a;
  if (FAILED(CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&a)))) return look;
  ComPtr<IUIAutomationElement> root;
  ComPtr<IUIAutomationTreeWalker> walker;
  if (FAILED(a->ElementFromHandle(w, &root)) || !root || FAILED(a->get_ControlViewWalker(&walker)) || !walker) return look;
  ULONGLONG until = GetTickCount64() + 1500;
  struct Item {
    ComPtr<IUIAutomationElement> el;
    int depth;
  };
  std::vector<Item> stack{{root, 0}};
  int visited = 0;
  while (!stack.empty() && (int)look.texts.size() < kMaxTexts && visited < 400 && GetTickCount64() < until) {
    Item it = stack.back();
    stack.pop_back();
    visited++;
    if (it.depth > 0) {
      BOOL pw = FALSE;
      if (SUCCEEDED(it.el->get_CurrentIsPassword(&pw)) && pw) continue;  // never a password field
      BSTR b = nullptr;
      if (SUCCEEDED(it.el->get_CurrentName(&b)) && b) {
        std::wstring name(b, SysStringLen(b));
        SysFreeString(b);
        if (!name.empty() && name != look.title) look.texts.push_back(name);
      }
    }
    if (it.depth >= 6) continue;
    std::vector<Item> kids;
    ComPtr<IUIAutomationElement> c;
    if (FAILED(walker->GetFirstChildElement(it.el.Get(), &c))) continue;
    while (c && kids.size() < 100) {
      kids.push_back({c, it.depth + 1});
      ComPtr<IUIAutomationElement> next;
      if (FAILED(walker->GetNextSiblingElement(c.Get(), &next))) break;
      c = next;
    }
    for (auto k = kids.rbegin(); k != kids.rend(); ++k) stack.push_back(*k);  // keep reading order
  }
  return look;
}

}  // namespace sarawatch
