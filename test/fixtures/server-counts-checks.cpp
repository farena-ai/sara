// U2.8/U2.11 native checks (test/u2win-badge.test.ts): the count text, words, sum and the drawn icon.
#include <windows.h>

#include <cstdio>
#include <string>

#include "server-counts.h"

static std::string narrow(const std::wstring& w) {
  std::string s;
  for (wchar_t c : w) s += (char)c;  // ASCII only here
  return s;
}
static std::string list(std::initializer_list<std::wstring> xs) {
  std::string o = "[";
  bool first = true;
  for (auto& x : xs) {
    o += (first ? "\"" : ",\"") + narrow(x) + "\"";
    first = false;
  }
  return o + "]";
}

int wmain() {
  using namespace saracounts;
  std::string out = "{\"text\":" + list({badgeText(0), badgeText(1), badgeText(9), badgeText(10), badgeText(120)});
  out += ",\"desc\":" + list({badgeDescription(0), badgeDescription(1), badgeDescription(9), badgeDescription(10), badgeDescription(120)});
  out += ",\"total\":" + std::to_string(total({{L"s1", 3}, {L"s2", 0}, {L"s3", 4}, {L"s4", -1}}));
  out += ",\"menu\":" + list({menuCount(0), menuCount(3), menuCount(250)});
  out += ",\"icons\":[";
  int sizes[] = {16, 32};
  for (int i = 0; i < 2; i++) {
    int s = sizes[i];
    HICON ic = makeBadgeIcon(i == 0 ? 3 : 12, s);
    bool ok = ic != nullptr && makeBadgeIcon(0, s) == nullptr;
    int corner = -1, middle = -1;
    ICONINFO ii{};
    if (ic && GetIconInfo(ic, &ii)) {
      BITMAPINFO bi{};
      bi.bmiHeader.biSize = sizeof(bi.bmiHeader);
      bi.bmiHeader.biWidth = s;
      bi.bmiHeader.biHeight = -s;
      bi.bmiHeader.biPlanes = 1;
      bi.bmiHeader.biBitCount = 32;
      bi.bmiHeader.biCompression = BI_RGB;
      unsigned int px[32 * 32] = {};
      HDC dc = GetDC(nullptr);
      if (GetDIBits(dc, ii.hbmColor, 0, s, px, &bi, DIB_RGB_COLORS) == s) {
        corner = (int)(px[0] >> 24);
        middle = (int)(px[(s / 2) * s + 1] >> 24);  // left edge of the middle row: the red ring
      }
      ReleaseDC(nullptr, dc);
      DeleteObject(ii.hbmColor);
      DeleteObject(ii.hbmMask);
      DestroyIcon(ic);
    }
    out += std::string(i ? "," : "") + "{\"size\":" + std::to_string(s) + ",\"ok\":" + (ok ? "true" : "false") + ",\"corner\":" + std::to_string(corner) + ",\"middle\":" + std::to_string(middle) + "}";
  }
  out += "]}";
  printf("%s\n", out.c_str());
  return 0;
}
