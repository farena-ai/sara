// Phase 87 (computer use CU1, docs/design/COMPUTER_USE.md §2–§4): Sara's hands on this computer.
// When the owner switches on "Let Sara use this computer" (Settings → Computer use in the app), the
// page gets a `hands` token from the server and hands it to this app; the app keeps it with DPAPI,
// opens its own WebSocket to <server>/api/hands (Authorization header, never a cookie) and runs only
// CU1's command set (Phase 88: and CU2's acting ops) in the Sara browser: a visible Edge or Chrome window with its own profile,
// driven over the DevTools protocol through a pipe (no port). Reading pages goes through the one
// shared page agent (desktop/shared/page-agent.js, in sara.rc). This module enforces its own limits
// whatever the server asks: the op allowlist, http(s) only, never the Sara server's own pages (except
// preview links), 20 page loads a minute, password fields never read, key-shaped text masked.
#pragma once
#include <functional>
#include <string>

namespace sarahands {

struct Host {
  std::wstring server;      // the Sara server's origin, e.g. http://127.0.0.1:7881
  std::string token;        // sara_hands.<id>.<secret>
  std::wstring computer;    // this computer's name (hello)
  std::wstring profileDir;  // the Sara browser's own profile folder
  std::string pageAgent;    // desktop/shared/page-agent.js (UTF-8, one expression)
  std::wstring appVersion;  // "Sara for Windows 2.19.0"
  bool localOnly = false;   // screenshots only to models on this computer
  std::function<void(const std::wstring&)> log;
  // Phase 88 (CU2): acting in the Sara browser.
  bool keepControl = false;   // "When you move the mouse": false = pause Sara (default), true = let her keep control
  std::wstring downloadsDir;  // Downloads\Sara: where downloads go and uploads come from
  std::wstring logFile;       // "What Sara did on this computer" (plain lines, 30 days, no pictures)
  std::string expiresAt;      // when the token ends (ISO); with under 30 days left it is renewed on connect
  bool testLabel = false;     // test runs: the badge says TEST
  /** A fresh token came over the connection (keep it instead of the old one). Called on the hands thread. */
  std::function<void(const std::string& token, const std::string& expiresAt)> onToken;
  // Phase 90 (CU4): saved logins (a DPAPI CurrentUser file; %LOCALAPPDATA%\Sara\logins.dat).
  std::wstring loginsFile;
  bool loginsVerify = false;  // Windows Hello before a saved login is used (off by default)
  // Phase 91 (CU4b): the owner's password managers, each off until turned on in the app (after the warning):
  // [0] Bitwarden, [1] 1Password, [2] KeePassXC (with the database the person chose).
  bool pmOn[3] = {false, false, false};
  std::wstring keepassDb;
  int pmRelockMinutes = 15;  // lock again after this many idle minutes (5, 15, 30, 60)
  int pmIdleSeconds = 0;     // test builds only (SARA_PM_IDLE_SECONDS): the idle time in seconds instead
  // Phase 92 (CU5): "The whole screen" (desktop look, off by default) and "Also hide these windows" (one per line).
  bool desktopOn = false;
  std::string blockExtra;
};

/** Connects (and keeps reconnecting) with these settings; a running connection is replaced. */
void start(const Host& host);
/** Disconnects and closes the Sara browser (switching off, quitting, another server). */
void stop();
/** Stop pressed on this computer: everything running is cancelled and the server is told. */
void pressStop();
/** "Screenshots only to models on this computer" changed (the server hears it at once). */
void setLocalOnly(bool on);
/** Phase 92: "The whole screen" changed (the server hears it at once). */
void setDesktop(bool on);
/** Phase 92: "Also hide these windows" changed (one app or title per line, UTF-8). */
void setBlockExtra(const std::string& lines);
/** Phase 88: "When you move the mouse" changed (true = let Sara keep control). */
void setTakeover(bool keepControl);
/** Phase 88: Resume after the person took over (the badge's button, the tray menu). */
void resume();
bool paused();
/** Phase 88: one line for the tray menu: "Connected to Sara at …", "Connecting to Sara…" or the problem. */
std::wstring statusLine();
/** Phase 88: the stop shortcut ("Ctrl+Alt+Esc"), empty when another app has those keys. */
std::wstring hotkeyLabel();
bool running();
bool connected();
/** The last connection problem, if any ("signed out", "can't reach the server"). */
std::wstring lastError();
/** Where the Sara browser is (empty when there is none on this computer). */
std::wstring browserPath();

/** Phase 90: this server's saved logins here as JSON {logins:[{name, sites, created, lastUsed}]} (never a password). */
std::wstring loginsJson(const std::wstring& server, const std::wstring& file);
/** Phase 90: removes one of this server's saved logins here (or all); how many went. */
int forgetLogin(const std::wstring& server, const std::wstring& file, const std::string& name, bool all, std::wstring& err);
/** Phase 90: "Ask for Windows Hello before Sara uses a saved login" changed. */
void setLoginsVerify(bool on);

/** Phase 91: the password managers here as JSON {managers:[{id, name, installed, on, state}], relockMinutes, keepassDb, detected}. */
std::wstring managersJson();
/** Phase 91: is that manager's tool on this computer (found and answering --version)? */
bool managerInstalled(const std::string& id);
/** Phase 91: turned on or off in the app (after the warning); off locks it and forgets its session. */
void setManager(const std::string& id, bool on);
/** Phase 91: the KeePassXC database the person chose (locks KeePassXC if it was unlocked). */
void setKeepassDb(const std::wstring& path);
/** Phase 91: "Lock again after … idle minutes" changed. */
void setRelockMinutes(int minutes);
/** Phase 91: the plain warning shown before a manager is turned on. */
std::wstring managerWarning(const std::string& id, int minutes);

/** DPAPI (this Windows user only): protect / unprotect a small secret as base64 text. */
std::wstring protect(const std::string& secret);
std::string unprotect(const std::wstring& b64);

}  // namespace sarahands
