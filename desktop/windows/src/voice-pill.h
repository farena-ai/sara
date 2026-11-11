// The small floating "Listening / Thinking / Speaking" pill above the clock (docs/desktop.md, Quick ask
// anywhere → Voice). Shown while she is listening, thinking or speaking and the quick-ask window isn't
// in front; it never takes the focus. A click on it calls onClick (stop her / show quick ask).
#pragma once
#include <windows.h>
#include <functional>
#include <string>

namespace sarapill {

/** state: "listening" | "thinking" | "speaking"; text: what the pill says. */
void show(const std::wstring& state, const std::wstring& text);
void hide();
bool visible();
void onClick(std::function<void()> f);
HWND window();

}  // namespace sarapill
