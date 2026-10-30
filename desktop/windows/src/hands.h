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
};

/** Connects (and keeps reconnecting) with these settings; a running connection is replaced. */
void start(const Host& host);
/** Disconnects and closes the Sara browser (switching off, quitting, another server). */
void stop();
/** Stop pressed on this computer: everything running is cancelled and the server is told. */
void pressStop();
/** "Screenshots only to models on this computer" changed (the server hears it at once). */
void setLocalOnly(bool on);
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

/** DPAPI (this Windows user only): protect / unprotect a small secret as base64 text. */
std::wstring protect(const std::string& secret);
std::string unprotect(const std::wstring& b64);

}  // namespace sarahands
