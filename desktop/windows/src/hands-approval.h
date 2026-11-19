#pragma once
#include <atomic>
#include <string>
namespace sarahands {
// 0: don't, 1: once, 2: this task. This window has no network or web approval path.
/** 0 no, 1 once, 2 for this task (or, with freeChoice, "Let her finish this task": HANDSFREE). */
int desktopApproval(const std::wstring& summary, bool taskChoice, bool test, const std::atomic<bool>* cancel, bool freeChoice = false, bool allChoice = false);
}
