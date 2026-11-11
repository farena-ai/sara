// The Windows app updates itself (docs/desktop.md → How the app updates). Mainly for the app-only
// install (Sara-Setup /MODE=remote) connected to a Sara somewhere else, which nothing else updates.
//
// The app reads the same signed update notice the server uses (src/update-notice.ts): its Ed25519
// signature is checked here (ed25519-verify.cpp; Windows builds are not code-signed, so the notice's
// SHA-256 of the installer is the trust anchor), never a notice older than one already seen nor a
// version older than this one. The installer is downloaded to <data>\updates, checked against the
// notice's SHA-256, and run silently by a copy of Sara.exe outside the install folder (the
// "watcher": Sara.exe --apply-update …), which waits for the app to close, runs Setup in the same
// mode (/MODE=remote, same server), restores the app's server settings and starts the app again;
// a failed install leaves the old app and a plain message with the download page.
#pragma once
#include <windows.h>

#include <functional>
#include <string>
#include <utility>
#include <vector>

namespace saraupdate {

/** Dotted versions ("v3.4.5" vs "3.4.4"): negative, zero or positive (same rule as src/updates.ts). */
int compareVersions(const std::string& a, const std::string& b);

struct NoticeAsset {
  std::string name, url, sha256;
  unsigned long long size = 0;
};
struct Notice {
  std::string version, date, minSupported, keyId;
  bool security = false;
  bool hasWin = false;
  NoticeAsset win;  // "win32-x64"
};

/**
 * Checks a signed notice (the raw JSON text) like src/update-notice.ts verifyNotice: the signature
 * against one of `keys` (id → raw public key, base64), every field, each file on `assetBase`
 * v<version>/<name>, and not older than `seen`. False with `why` when it isn't trusted.
 */
bool verifyNotice(const std::string& raw, const std::vector<std::pair<std::string, std::string>>& keys, const std::string& assetBase, const std::string& seen, Notice& out, std::string& why);

/** The release key(s) (src/update-notice.ts NOTICE_KEYS). */
std::vector<std::pair<std::string, std::string>> releaseKeys();
extern const char* kNoticeUrl;
extern const char* kAssetBase;
extern const wchar_t* kDownloadPage;

struct Options {
  std::wstring version;   // this app's
  std::wstring dataDir;   // %LOCALAPPDATA%\Sara (a test run: its own)
  std::wstring iniPath;   // desktop.ini
  std::wstring exePath;   // the running Sara.exe
  std::string noticeUrl = kNoticeUrl;
  std::string assetBase = kAssetBase;
  std::vector<std::pair<std::string, std::string>> keys = releaseKeys();
  /** 'remote' (app only: updates itself), 'server' (Sara's server here updates the app with her), 'manual' (not installed by Setup). */
  std::wstring how = L"remote";
  HWND wnd = nullptr;  // gets `msg` when the status changes (from any thread)
  UINT msg = 0;
  std::function<void(const std::wstring&)> log;
};

enum class State { Idle, Checking, Current, Available, Downloading, Ready, Installing, Failed };

struct Status {
  State state = State::Idle;
  std::wstring latest, message;
  bool security = false;
  bool required = false;  // below the notice's minimum supported version
};

void init(const Options& o);
/** Reads the notice (in the background). Not forced: at most every 6 hours (an hour after a failed read). */
void check(bool force);
/** The connected server's version: a newer one means a check soon (at most once an hour). */
void serverVersion(const std::string& v);
/** Download (if needed) and install as soon as it is quiet (the app asked: Update now, or the server asked). */
void wantInstall(bool fromServer);
/** Forget wantInstall (Later). */
void later();
bool wantsInstall();
/** "Update the app by itself" (default on). */
bool autoOn();
void setAuto(bool on);
Status status();
/** {"state", "version", "latest", "message", "security", "auto", "how", "page", "result"…} for the page. */
std::wstring statusJson();
/** The verified installer is here and may be installed. */
bool ready();
/** Ready, "by itself" is on, and this version didn't just fail to install (no update loops). */
bool mayInstallByItself();
/**
 * Starts the watcher, which installs once this app has closed. "" = started: the caller quits now.
 * Otherwise why it can't (nothing is changed). relaunch: start the app again afterwards
 * (background: hidden next to the clock, as it was).
 */
std::wstring install(bool relaunch, bool background);
/** The outcome of the last install, once (after the app started again): "" when there is none. */
std::wstring takeResult(bool& ok);
/** Sara.exe --apply-update …: the watcher. */
int runWatcher();

}  // namespace saraupdate
