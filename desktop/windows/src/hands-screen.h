// Phase 92 (computer use CU5, docs/design/COMPUTER_USE.md §5.1–5.2, §6.2, §7.4, §7.6): desktop look on
// Windows. OS APIs only: GDI (BitBlt of the screen with CAPTUREBLT, PrintWindow PW_RENDERFULLCONTENT for
// one window; both honour SetWindowDisplayAffinity), UI Automation (IUIAutomation, the control view) for
// element lists, WIC for JPEG. The rules are src/hands-desktop.ts's, done here before anything is sent:
// blocked windows (password managers, banking, security, a Sara token in the title, the person's own
// list) are blacked out and left out of lists; Sara's own windows (this process: excluded from the
// capture; any other Sara.exe window: blacked out) never appear; password fields are boxed out and
// never give a value; key-shaped text is masked; at most one picture per 500 ms, 1280 px, 300 elements,
// depth 8; a picture's viewId lasts 20 s.
#pragma once
#include <windows.h>
#include <string>
#include <vector>

namespace sarascreen {

struct Image {
  std::vector<BYTE> jpeg;
  int w = 0, h = 0;
};

struct Result {
  std::string json;  // the result object (JSON), when ok
  std::string code, message;  // the error, when not
  Image shot, thumb;
  std::string viewId;
};

/** The person's own extra list ("Also hide these windows"), one name per line (UTF-8). */
void setExtraBlocklist(const std::string& lines);
/** {screens:[{id, w, h, scale, primary}]} */
std::string screensJson();
/** d.windows: {windows:[{id, title, app, bounds, minimized, focused, screen} | {hidden: kind}]} */
Result windows();
/** d.shot {window | screen | area, maxEdge, marks, thumb} */
Result shot(const std::string& window, const std::string& screen, const std::vector<int>& area, int maxEdge, bool marks, int thumb);
/** d.elements {window?, viewId?, limit} */
Result elements(const std::string& window, const std::string& viewId, int limit);

}  // namespace sarascreen
