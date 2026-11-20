// LAGFIX (docs/design/LAGFIX.md): how long the app's window thread was busy with one message.
// Windows greys the window and writes "Not responding" when this thread doesn't take a message for
// 5 s. The message loop times every dispatched message; one that ran longer than kSlowMs is logged
// to desktop.log as "slow ui: <what> <ms> ms" (what = the message, and the page or timer that caused
// it), at most once per kSlowEveryMs so a stuck thread can't flood the log. Header-only and pure apart
// from GetTickCount64, so test/fixtures/ui-watch-checks.cpp can drive it with a fake clock.
#pragma once
#include <windows.h>

#include <string>

namespace sarauiwatch {

constexpr unsigned long long kSlowMs = 250;        // a frame-and-a-bit at 4x: anything above is felt
constexpr unsigned long long kSlowEveryMs = 2000;  // at most one line per 2 s

/** What the window thread is doing now (set by handlers that know more than the message id). */
struct Stage {
  std::wstring what;
};

class LoopWatch {
 public:
  /** Start of one dispatched message. */
  void begin(UINT msg, WPARAM wp, unsigned long long now) {
    msg_ = msg;
    wp_ = wp;
    start_ = now;
    stage_.clear();
    modal_ = false;
  }
  /** The message runs a loop of its own that keeps the window answering (a title-bar drag, the system
   *  or tray menu, a message box): its length is not a stall. */
  void modal() { modal_ = true; }
  /** A handler says what it is doing (\"page: badge\", \"timer: now\"). The last one wins. */
  void stage(const std::wstring& what) { stage_ = what; }
  /** A later step of the same handler (\"page: servers + reply\"). */
  void step(const std::wstring& what) { stage_ = label() + L" + " + what; }
  /** End of the message: the log line when it was slow (and the rate limit allows), else empty. */
  std::wstring end(unsigned long long now) {
    unsigned long long took = now - start_;
    if (modal_ || msg_ == WM_NCLBUTTONDOWN || msg_ == WM_NCRBUTTONDOWN || msg_ == WM_NCLBUTTONDBLCLK || msg_ == WM_SYSCOMMAND) return L"";
    if (took > worst_) worst_ = took;
    if (took < kSlowMs) return L"";
    ++slow_;
    if (lastLog_ && now - lastLog_ < kSlowEveryMs) return L"";
    lastLog_ = now;
    return L"slow ui: " + label() + L" " + std::to_wstring(took) + L" ms";
  }
  unsigned long long worst() const { return worst_; }
  unsigned long long slowCount() const { return slow_; }
  std::wstring label() const {
    if (!stage_.empty()) return stage_;
    switch (msg_) {
      case WM_TIMER: return L"timer " + std::to_wstring((unsigned long long)wp_);
      case WM_COMMAND: return L"command " + std::to_wstring((unsigned long long)LOWORD(wp_));
      case WM_PAINT: return L"paint";
      case WM_SIZE: return L"size";
      default: return L"message 0x" + hex(msg_);
    }
  }

 private:
  static std::wstring hex(UINT v) {
    wchar_t b[16];
    swprintf_s(b, L"%04X", v);
    return b;
  }
  UINT msg_ = 0;
  WPARAM wp_ = 0;
  unsigned long long start_ = 0, lastLog_ = 0, worst_ = 0, slow_ = 0;
  std::wstring stage_;
  bool modal_ = false;
};

}  // namespace sarauiwatch
