// ROADMAP_U U2.8 (Windows) + U2.11: see server-counts.h and docs/design/U2WIN.md.
#include "server-counts.h"

#include <vector>

namespace saracounts {

std::wstring badgeText(int n) {
  if (n <= 0) return L"";
  return n > 9 ? L"9+" : std::to_wstring(n);
}

std::wstring badgeDescription(int n) {
  if (n <= 0) return L"";
  return std::to_wstring(n) + (n == 1 ? L" unread message" : L" unread messages");
}

std::wstring menuCount(int n) {
  if (n <= 0) return L"";
  return L"  (" + (n > 99 ? std::wstring(L"99+") : std::to_wstring(n)) + L")";
}

int total(const std::map<std::wstring, int>& counts) {
  long long sum = 0;
  for (auto& c : counts)
    if (c.second > 0) sum += c.second;
  return sum > 100000 ? 100000 : (int)sum;
}

HICON makeBadgeIcon(int n, int size) {
  if (n <= 0 || size < 8 || size > 256) return nullptr;
  std::wstring text = badgeText(n);
  BITMAPINFO bi{};
  bi.bmiHeader.biSize = sizeof(bi.bmiHeader);
  bi.bmiHeader.biWidth = size;
  bi.bmiHeader.biHeight = -size;  // top-down
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HDC screen = GetDC(nullptr);
  HDC dc = CreateCompatibleDC(screen);
  HBITMAP color = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  ReleaseDC(nullptr, screen);
  if (!dc || !color || !bits) {
    if (dc) DeleteDC(dc);
    if (color) DeleteObject(color);
    return nullptr;
  }
  HGDIOBJ old = SelectObject(dc, color);
  // GDI draws without alpha: draw white on black at 4x for a smooth edge, then build the alpha
  // from the coverage ourselves (circle = red, digits = white).
  const int k = 4, big = size * k;
  std::vector<unsigned char> disc((size_t)big * big), glyph((size_t)big * big);
  const double r = big / 2.0 - 0.5;
  for (int y = 0; y < big; y++)
    for (int x = 0; x < big; x++) {
      double dx = x + 0.5 - big / 2.0, dy = y + 0.5 - big / 2.0;
      disc[(size_t)y * big + x] = dx * dx + dy * dy <= r * r ? 1 : 0;
    }
  {
    // The digits, drawn once at 4x in a temporary DIB.
    BITMAPINFO gb = bi;
    gb.bmiHeader.biWidth = big;
    gb.bmiHeader.biHeight = -big;
    void* gbits = nullptr;
    HDC gdc = CreateCompatibleDC(dc);
    HBITMAP gbmp = CreateDIBSection(dc, &gb, DIB_RGB_COLORS, &gbits, nullptr, 0);
    if (gdc && gbmp && gbits) {
      HGDIOBJ gold = SelectObject(gdc, gbmp);
      memset(gbits, 0, (size_t)big * big * 4);
      int h = text.size() > 1 ? big * 62 / 100 : big * 78 / 100;
      HFONT font = CreateFontW(-h, 0, 0, 0, FW_BOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, NONANTIALIASED_QUALITY, DEFAULT_PITCH, L"Segoe UI");
      HGDIOBJ fold = SelectObject(gdc, font);
      SetBkMode(gdc, TRANSPARENT);
      SetTextColor(gdc, RGB(255, 255, 255));
      RECT rc{0, 0, big, big};
      DrawTextW(gdc, text.c_str(), (int)text.size(), &rc, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
      GdiFlush();
      auto* gp = static_cast<unsigned int*>(gbits);
      for (size_t i = 0; i < (size_t)big * big; i++) glyph[i] = (gp[i] & 0xFF) > 127 ? 1 : 0;
      SelectObject(gdc, fold);
      DeleteObject(font);
      SelectObject(gdc, gold);
    }
    if (gbmp) DeleteObject(gbmp);
    if (gdc) DeleteDC(gdc);
  }
  // Downsample: alpha = disc coverage; colour = red mixed with white by glyph coverage (premultiplied).
  auto* px = static_cast<unsigned int*>(bits);
  const int R = 0xC4, G = 0x2B, B = 0x1C;  // a deep red that reads on light and dark taskbars
  for (int y = 0; y < size; y++)
    for (int x = 0; x < size; x++) {
      int a = 0, w = 0;
      for (int j = 0; j < k; j++)
        for (int i = 0; i < k; i++) {
          size_t at = (size_t)(y * k + j) * big + (x * k + i);
          if (disc[at]) {
            a++;
            if (glyph[at]) w++;
          }
        }
      int alpha = a * 255 / (k * k);
      int rr = a ? (R * (a - w) + 255 * w) / a : 0, gg = a ? (G * (a - w) + 255 * w) / a : 0, bb = a ? (B * (a - w) + 255 * w) / a : 0;
      px[y * size + x] = ((unsigned)alpha << 24) | ((unsigned)(rr * alpha / 255) << 16) | ((unsigned)(gg * alpha / 255) << 8) | (unsigned)(bb * alpha / 255);
    }
  SelectObject(dc, old);
  DeleteDC(dc);
  HBITMAP mask = CreateBitmap(size, size, 1, 1, nullptr);
  ICONINFO ii{TRUE, 0, 0, mask, color};
  HICON icon = CreateIconIndirect(&ii);
  DeleteObject(mask);
  DeleteObject(color);
  return icon;
}

std::string countsPageHtml() {
  // No markup to speak of: it only asks /api/messages with this server's own sign-in and tells the
  // app the count (the same one-to-one + mentions count as the sidebar pill), and the newest chat
  // that counts, for the notification. Never the messages themselves beyond that one line.
  return R"HTML(<!doctype html><html><head><meta charset="utf-8"><title>counts</title></head><body><script>
(async () => {
  const say = (o) => chrome.webview.postMessage(Object.assign({ m: 'counts' }, o));
  try {
    const r = await fetch('/api/messages', { credentials: 'same-origin' });
    if (r.status === 401 || r.status === 403) return say({ error: 'signin' });
    if (!r.ok) return say({ error: 'server' });
    const j = await r.json();
    const popup = !(j.settings && j.settings.popup === false);
    const n = popup ? Math.max(0, Math.floor(Number(j.unread) || 0)) : 0;
    const c = (j.chats || []).find((x) => x && !x.muted && !x.blocked && (x.kind === 'community' ? x.mentions : x.unread) > 0) || null;
    say({ unread: String(n), title: c ? String(c.title || '').slice(0, 120) : '', body: c ? String(c.last || '').slice(0, 300) : '', key: c ? String(c.id || '') + ':' + String(c.lastIn || c.lastAt || '') : '' });
  } catch (e) {
    say({ error: 'offline' });
  }
})();
</script></body></html>)HTML";
}

const wchar_t* countsPageHeaders() {
  return L"Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\n"
         L"Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";
}

}  // namespace saracounts
