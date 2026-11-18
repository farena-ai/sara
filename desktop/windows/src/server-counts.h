// ROADMAP_U U2.8 (Windows) + U2.11 (docs/design/U2WIN.md): the message count on the taskbar button
// and the unread counts of every saved server. Pure helpers (text, sum, the count icon, the small
// page that asks a server not in use); main.cpp does the WebView2 and taskbar work.
#pragma once
#include <windows.h>

#include <map>
#include <string>

namespace saracounts {

/** The overlay's text: "" for 0, "1"…"9", then "9+". */
std::wstring badgeText(int n);
/** The overlay's words for screen readers: "3 unread messages" ("" for 0). */
std::wstring badgeDescription(int n);
/** Next to a server in the tray menu: "  (3)", "  (99+)", "" for 0. */
std::wstring menuCount(int n);
/** Every saved server's unread count added up (what the taskbar shows). */
int total(const std::map<std::wstring, int>& counts);
/** A round count icon (accent red, white digits) drawn now, size×size px with alpha; nullptr for 0. */
HICON makeBadgeIcon(int n, int size);
/** The page served at <server>/__sara_desktop/counts in a server's own profile: asks /api/messages
 *  with that server's sign-in and posts {m:'counts', unread, title, body, chat} or {m:'counts', error}. */
std::string countsPageHtml();
/** Its Content-Security-Policy: only itself, requests only to that server. */
const wchar_t* countsPageHeaders();

}  // namespace saracounts
