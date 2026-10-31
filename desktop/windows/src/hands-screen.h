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
#include <functional>

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
void setServerOrigin(const std::string& origin);
void setExtraBlocklist(const std::string& lines);
/** {screens:[{id, w, h, scale, primary}]} */
std::string screensJson();
/** d.windows: {windows:[{id, title, app, bounds, minimized, focused, screen} | {hidden: kind}]} */
Result windows();
/** d.shot {window | screen | area, maxEdge, marks, thumb} */
Result shot(const std::string& window, const std::string& screen, const std::vector<int>& area, int maxEdge, bool marks, int thumb);
/** d.elements {window?, viewId?, limit} */
Result elements(const std::string& window, const std::string& viewId, int limit);

// All coordinates are in the named view, including drag endpoints. The callback is checked
// before each synthesized event as well as before accessibility actions.
constexpr ULONG_PTR kInputTag = 0x53415241;
inline bool ownMouseInput(DWORD flags, ULONG_PTR tag) { return (flags & LLMHF_INJECTED) && tag == kInputTag; }
inline bool ownKeyInput(DWORD flags, ULONG_PTR tag) { return (flags & LLKHF_INJECTED) && tag == kInputTag; }
#ifdef SARA_TEST_HOOKS
std::string policyConformance();
#endif
struct Action {
  std::string op, window, viewId, ref, text, combo, app;
  double x = -1, y = -1, toX = -1, toY = -1, dx = 0, dy = 0;
  bool right = false, twice = false;
};
struct ActionInfo { std::string target; bool once = false; };
Result inspect(const Action& a, ActionInfo& info);
Result refreshApproved(Action& a);
Result input(const Action& a, const std::function<bool()>& cancelled);

}  // namespace sarascreen
