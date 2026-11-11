// The app's update checks (desktop/windows/src/app-update.cpp) run natively, driven by
// test/app-update-native.test.ts with notices Node signed with a TEST key. Test builds only.
//   AppUpdateNativeChecks verify <notice file> <public key b64> <asset base> <seen>  -> "ok <version> <win sha256> <security>" | "no <why>"
//   AppUpdateNativeChecks cmp <a> <b>                                               -> -1 | 0 | 1
#include <windows.h>

#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>

#include "app-update.h"

static std::string narrow(const wchar_t* w) {
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}

int wmain(int argc, wchar_t** argv) {
  if (argc >= 4 && std::wstring(argv[1]) == L"cmp") {
    int c = saraupdate::compareVersions(narrow(argv[2]), narrow(argv[3]));
    printf("%d\n", c < 0 ? -1 : c > 0 ? 1 : 0);
    return 0;
  }
  if (argc >= 6 && std::wstring(argv[1]) == L"verify") {
    std::ifstream f(argv[2], std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    saraupdate::Notice n;
    std::string why;
    if (saraupdate::verifyNotice(ss.str(), {{"test", narrow(argv[3])}}, narrow(argv[4]), narrow(argv[5]), n, why))
      printf("ok %s %s %s\n", n.version.c_str(), n.hasWin ? n.win.sha256.c_str() : "-", n.security ? "security" : "plain");
    else
      printf("no %s\n", why.c_str());
    return 0;
  }
  fprintf(stderr, "usage: verify <notice> <key> <base> <seen> | cmp <a> <b>\n");
  return 64;
}
