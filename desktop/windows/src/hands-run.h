// 3.5 (PC tools, docs/design/PC_TOOLS.md): c.run / c.open on Windows, only with "Let her run commands on
// this computer" on (Settings → Computer use; off by default). The rules are src/hands-run.ts's, done
// here before anything runs: every command is shown in this app's own card (Allow once / Allow for this
// task / Don't); destructive-looking commands always ask; never as administrator; a Job object kills
// the whole process tree on Stop or the deadline; output is masked (key shapes) and capped.
#pragma once
#include <atomic>
#include <functional>
#include <string>

namespace sararun {

struct Settings {
  bool on = false;
  int level = 1;  // 0 ask every time, 1 once per task, 2 always
  bool readOnlyAuto = false;
  bool test = false;  // test runs: the card's title says TEST
};

struct Args {
  std::string op;  // c.run | c.open
  std::string command, shell, cwd, target, task, approvalLevel;
  double timeoutMs = 60000;
};

struct Ctx {
  /** Sends {"t":"ev","kind":"run","id":…, <fragment>} (the caller adds the frame). */
  std::function<void(const std::string& fragment)> ev;
  const std::atomic<bool>* cancel = nullptr;
  /** Paused (the person took over) — nothing new starts. */
  std::function<bool()> paused;
  /** True while the card is up (the input hooks don't count the person's clicks on it as a takeover). */
  std::atomic<bool>* approving = nullptr;
  std::function<void(const std::string& what, const std::string& target)> log;
};

struct Reply {
  std::string json;           // the result object, when ok
  std::string code, message;  // the error, when not
};

void configure(const Settings& s);
Settings settings();
/** Stop / turning it off: every "Allow for this task" ends. */
void clearGrants();
Reply handle(const Args& a, Ctx& ctx);

/** Shared with tests and the app: is this one simple read-only command; must it always ask. */
bool readOnlyCommand(const std::string& command);
bool destructiveCommand(const std::string& command);

}  // namespace sararun
