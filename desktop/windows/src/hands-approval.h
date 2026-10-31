#pragma once
#include <atomic>
#include <string>
namespace sarahands {
// 0: don't, 1: once, 2: this task. This window has no network or web approval path.
int desktopApproval(const std::wstring& summary, bool taskChoice, bool test, const std::atomic<bool>* cancel);
}
