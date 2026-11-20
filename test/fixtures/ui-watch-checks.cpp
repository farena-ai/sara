// LAGFIX: the Windows app's slow-message rules (desktop/windows/src/ui-watch.h) on a fake clock.
// Prints "ALL OK" or the first failure; run by test/lagfix.test.ts when the test build exists.
#include <cstdio>
#include <string>

#include "ui-watch.h"

static int fails = 0;
static void check(bool ok, const char* what) {
  if (!ok) {
    std::printf("FAIL %s\n", what);
    ++fails;
  }
}

int main() {
  sarauiwatch::LoopWatch w;
  // A quick message: nothing to say.
  w.begin(WM_TIMER, 7, 1000);
  check(w.end(1010).empty(), "a 10 ms message is not slow");
  // A slow page message says which one and how long.
  w.begin(WM_APP + 1, 0, 2000);
  w.stage(L"page: badge");
  std::wstring line = w.end(2600);
  check(line == L"slow ui: page: badge 600 ms", "slow page message line");
  // Rate limit: a second slow one within 2 s is counted but not logged.
  w.begin(WM_TIMER, 33, 2700);
  check(w.end(3100).empty(), "rate limited within 2 s");
  check(w.slowCount() == 2, "both slow messages counted");
  // After 2 s it logs again, with the timer id when no stage was said.
  w.begin(WM_TIMER, 33, 5000);
  check(w.end(5300) == L"slow ui: timer 33 300 ms", "timer label after the quiet period");
  // The stage is per message: the next one starts clean.
  w.begin(WM_COMMAND, MAKEWPARAM(4020, 0), 9000);
  check(w.end(9400) == L"slow ui: command 4020 400 ms", "stage cleared between messages");
  check(w.worst() == 600, "worst message kept");
  // A title-bar drag or a menu runs its own loop (the window still answers): never logged.
  w.begin(WM_NCLBUTTONDOWN, HTCAPTION, 30000);
  check(w.end(33000).empty(), "title-bar drag is not a stall");
  w.begin(WM_APP + 5, 0, 40000);
  w.modal();
  check(w.end(45000).empty(), "a menu or message box is not a stall");
  // Steps of one handler add up in the label.
  w.begin(WM_APP + 1, 0, 50000);
  w.stage(L"page: servers");
  w.step(L"reply");
  check(w.end(53000) == L"slow ui: page: servers + reply 3000 ms", "steps in the label");
  // Just under the threshold is fine.
  w.begin(WM_PAINT, 0, 20000);
  check(w.end(20000 + sarauiwatch::kSlowMs - 1).empty(), "under the threshold");
  if (!fails) std::printf("ALL OK\n");
  return fails ? 1 : 0;
}
