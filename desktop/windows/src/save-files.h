// Drop files in, save her documents out (docs/desktop.md). Save to… (the Save window, remembering
// the last folder), Save to Downloads and "Put her documents in a folder automatically": the page
// asks, the app lets WebView2 download her file (with the page's sign-in) straight into the place
// picked on this PC. Paths stay here: the page gets a short folder name and a token for Open /
// Show in folder. Also: the files dropped on the quick ask, and folders from Send To (their files).
#pragma once
#include <windows.h>
#include <functional>
#include <map>
#include <string>
#include <vector>
#include "WebView2.h"

namespace sarasave {

struct Host {
  HWND wnd = nullptr;
  std::function<std::wstring(const wchar_t* key)> getPref;
  std::function<void(const wchar_t* key, const std::wstring& value)> setPref;
  /** Answers the page's SaraDesktop.call (result JSON, or an error). */
  std::function<void(const std::wstring& id, const std::wstring& resultJson, const std::wstring& error)> reply;
  /** The server in use, e.g. http://127.0.0.1:7860 (no trailing slash). */
  std::function<std::wstring()> server;
  std::function<void(const std::wstring&)> log;
  /** Test runs: Downloads and Documents are folders in here, never the real ones. */
  std::wstring testDir;
};

/** Hooks the web view's downloads (call again when the web view is made again). */
void attach(ICoreWebView2* web, const Host& host);
/** The page's saveFile / saveOpen / saveSettings calls. */
void onCall(const std::wstring& kind, const std::wstring& id, std::map<std::wstring, std::wstring>& m);
/** A save the page asked for is waiting for its download to start. */
bool pending();
/** Added to getPrefs: ,"saveFiles":true,"docsAuto":…,"docsAutoLabel":"Documents\\Sara". */
std::wstring prefsJson();
/** The paths of files a page posted with postMessageWithAdditionalObjects. */
std::vector<std::wstring> messageFiles(ICoreWebView2WebMessageReceivedEventArgs* args);
/** Folders become their files (top level, no hidden ones), at most `max` paths in all. */
std::vector<std::wstring> expandFolders(const std::vector<std::wstring>& in, size_t max);

// Pure helpers (also used by the checks).
/** A file name Windows takes ("Report: Q4?.docx" → "Report_ Q4_.docx"). */
std::wstring cleanName(const std::wstring& name);
/** dir\name, or dir\name (2).ext … when that file is already there. */
std::wstring uniquePath(const std::wstring& dir, const std::wstring& name);
/** "Documents\Sara" for C:\Users\x\Documents\Sara: the last two parts only. */
std::wstring folderLabel(const std::wstring& dir);
/** Only her own file addresses: /api/library/made/<n>/file, /api/library/<n>/file, /api/files/<id>. */
bool urlOk(const std::wstring& path);

}  // namespace sarasave
