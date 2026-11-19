// V4.5 Screen companion (docs/design/V4SCREEN.md, docs/desktop.md "Screen companion"). Opt-in, local
// only: every few seconds the app looks at the window in front (its title and the names of its controls,
// read through UI Automation on this computer), and when an error dialog or a stuck form shows, offers
// help in one small bubble (the quick-ask page's offer card). The rules are src/screen-companion.ts,
// ported here as fixed lists (test/v4-screen.test.ts keeps them equal; ScreenWatchChecks runs the same
// fake screens). Never a window hidden from Sara or her own, never a password field or a typed value;
// one offer per thing seen (kept as a number), at most one every 2 minutes, none while paused or off.
// Nothing is written to disk or sent: the offer only goes to the bubble.
#pragma once
#include <windows.h>

#include <cstdint>
#include <deque>
#include <string>
#include <vector>

namespace sarawatch {

constexpr int kEveryMs = 5000;        // one look every 5 s while on
constexpr int kCooldownMs = 120000;   // at most one offer every 2 minutes
constexpr int kStuckChecks = 3;       // a form message still there after 3 looks
constexpr int kMaxTexts = 80;         // control names read per look
constexpr int kMaxTextLen = 300;      // longer texts are documents or pages, not messages
constexpr int kLineLen = 160;         // the line shown in the bubble
constexpr int kRemember = 64;         // offers remembered (as hashes) so each shows once

struct Look {
  std::wstring title, app;
  bool dialog = false;
  std::vector<std::wstring> texts;
  std::string hidden;  // why it is hidden from Sara ("password manager", ...); empty: not hidden
  bool own = false;    // one of Sara's own windows
};
struct Finding {
  std::wstring kind;  // L"error" | L"form" | empty (nothing)
  std::wstring line;
};
struct Offer {
  std::wstring kind, app, line;
};

bool hasWord(const std::wstring& text, const wchar_t* const* words, size_t n);
bool errorWord(const std::wstring& text);
bool formWord(const std::wstring& text);
bool hangWord(const std::wstring& text);
Finding finding(const Look& look);
uint32_t hash(const std::wstring& s);

/** Off by default; memory only. check() returns true with the offer to show. */
class Watch {
 public:
  bool on = false;
  void pause(long long ms, long long now) { pausedUntil_ = ms > 0 ? now + ms : 0; }
  long long pausedFor(long long now) const { return pausedUntil_ > now ? pausedUntil_ - now : 0; }
  bool check(const Look& look, long long now, Offer& out);

 private:
  long long pausedUntil_ = 0;
  long long lastOffer_ = -1;
  std::deque<uint32_t> offered_;
  uint32_t streakFp_ = 0;
  int streakN_ = 0;
};

/** Reads one window on this computer (call on a thread with COM initialised): its title, program name,
 *  whether it is a dialog, and the names of up to kMaxTexts controls (never a password field, never a
 *  typed value). Hidden and Sara's own windows come back with only `hidden` / `own` set. */
Look lookAt(HWND w);

}  // namespace sarawatch
