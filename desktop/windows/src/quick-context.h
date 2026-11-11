// Quick ask "Selected text" and "This window" (docs/desktop.md, Quick ask anywhere). When the quick-ask
// shortcut is pressed, the app in front is remembered and the text selected in it is read: UI Automation's
// TextPattern selection first; only when the focused control has no TextPattern, a simulated Ctrl+C with
// the clipboard saved and put back exactly (every format; if any format can't be copied back exactly,
// no Ctrl+C at all). Never for a password field, Sara's own windows, or a window hidden from Sara
// (password managers, banking, the person's own list: the same rules as her hands). Key-shaped text is
// masked. "This window" is one still picture of that window through hands-screen's capture (PrintWindow,
// the same blacking-out of hidden windows and boxing-out of password fields). Nothing leaves the computer
// here: the page shows both as removable chips and sends them only with the question.
#pragma once
#include <windows.h>
#include <functional>
#include <string>
#include <vector>

namespace saractx {

struct Picked {
  HWND window = nullptr;   // the window that was in front (null: Sara's own, the desktop, or hidden)
  std::wstring app;        // "Notepad" (the program's own description)
  std::wstring text;       // the selected text (masked, at most kMaxText characters)
  std::wstring via;        // "uia" | "copy" | "" (nothing selected / not read)
  std::wstring skipped;    // why nothing was read: "password" | "sara" | "hidden" | "clipboard" | "keys" | "moved" | ""
  std::wstring path;       // for the log: how it was looked for ("uia", "uia: no pattern", "copy", "copy: nothing copied")
};

constexpr size_t kMaxText = 8000;

/** Remembers the window in front and reads its selection, then calls done (on this thread, at once or
 *  after up to ~1.5 s when it has to copy). read: kReadNone (the window only), kReadUia (UI Automation
 *  only), kReadAll (UI Automation, then Ctrl+C). */
enum Read { kReadNone = 0, kReadUia = 1, kReadAll = 2 };
void pick(HWND front, Read read, std::function<void(const Picked&)> done);
/** One picture of that window: a JPEG (data: URL), its size, or why not. */
bool captureWindow(HWND w, std::string& dataUrl, int& width, int& height, std::wstring& why);
/** The program's friendly name ("Notepad"), from its version resource or its file name. */
std::wstring appLabel(HWND w);

// Pieces the tests drive directly (test/fixtures and the static checks name them).
struct SavedClipboard {
  struct Item {
    UINT format = 0;
    std::vector<BYTE> data;   // HGLOBAL formats
    HENHMETAFILE emf = nullptr;
  };
  std::vector<Item> items;
  bool exact = true;          // false: something here can't be put back as it was
  bool save(HWND owner);
  bool restore(HWND owner) const;
  void release();
};
std::wstring clipboardText(HWND owner);

}  // namespace saractx
