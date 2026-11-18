# U2WIN: taskbar message count and one Windows app for several servers (ROADMAP_U U2.8 Windows + U2.11)

Branch `hermes/u2win`, 2026-11-18. One page; the user-facing description is in [SERVERS.md](../SERVERS.md)
and [desktop.md](../desktop.md).

## What already existed (kept, extended)

- **Phase 68 (1.8.0):** the Windows app keeps a list of servers in `desktop.ini` (`[servers]`, `[server.sN]`),
  each signed in through its **own WebView2 profile** (`s1` = the default profile used before 1.8, the others
  `sara-<id>`), the tray's *Your Saras ▸* (✓ in use, *Add a Sara…*), the page's ⇄ dialog (`#servers-dialog`:
  Switch, Rename, Remove, *Add a server* = the first-run address page), migration of the single old server to
  `s1`, toast clicks with `p=<id>` that switch servers. So switching, add/remove and separate sign-ins were done.
- **MSGPOP (3.18):** `web/msg-notice.js` + `web/messages.js` own the unread count (one-to-one + mentions,
  `GET /api/messages` → `unread`), the sidebar pill, the `(n)` title prefix and the browser app badge.
- Missing (BACKLOG "Several servers: live notifications from every server in the desktop apps"): any count or
  message notice from servers not in use, and any taskbar count.

## Built

1. **Taskbar count (U2.8).** `paintBadge(n)` (the sidebar pill's painter) also calls
   `SaraDesktop.call('badge', { n: desktopBadge(n, prefs) })`; `desktopBadge` is 0 when the person turned the
   Messages popup off. Native: `kind == L"badge"` (only from her own server's page) sets `g_unread[active]`;
   `applyBadge()` sums every server and lays a run-time drawn round red count (1–9, 9+;
   `saracounts::makeBadgeIcon`, 4× supersampled GDI, premultiplied alpha) over the taskbar button with
   `ITaskbarList3::SetOverlayIcon(..., "3 unread messages")`; at 0 the overlay is removed. Re-applied on
   `TaskbarButtonCreated` (Explorer restart).
2. **Counts from servers not in use (U2.11).** Every 2 minutes (first ask 15 s after start), one server at a
   time: a hidden WebView2 controller in **that server's own profile** opens
   `<server>/__sara_desktop/counts`, a page the app answers itself (like quick ask; service worker bypassed
   over CDP), which `fetch('/api/messages')` with that profile's sign-in and posts back
   `{unread, title, body, key}`; the controller is closed after each answer (20 s give-up). No cookie or
   token ever leaves WebView2; the app never sees one.
3. **Notifications from them.** A new counted message (its key `chatId:lastIn` differs from the server's
   `told` key in `desktop.ini`) gives a toast *"<sender> / <text> / On <server name>"* whose click
   (`a=open&p=<id>&v=msgs`) switches to that server's Messages. A server just left is "quiet" for its next
   ask, so what was already on its page is not told again. Respects the app's Notifications switch.
4. **Per-server counts in the switchers.** `serversJson` carries `unread`; the ⇄ dialog shows a count pill per
   server and the ⇄ header button the other servers' sum; the tray's *Your Saras ▸* shows `Name  (3)`.
   Removing a server drops its count.

Files: `desktop/windows/src/server-counts.{h,cpp}` (pure helpers), `main.cpp` (badge, poller, bridge,
menu), `web/msg-notice.js` (`desktopBadge`), `web/messages.js`, `web/app.js` (`renderServers`),
`web/index.html` (`#server-btn-count`), `web/style.css` (`.srv-count`). Tests:
`test/u2win-badge.test.ts` (+ `ServerCountsChecks.exe`, `test/fixtures/server-counts-checks.cpp`).

## Not done / later

- A window per server (BACKLOG) and the Mac Dock badge (U2.8 Mac half) are separate items.
- Counts of servers not in use are up to ~2 minutes old; approvals/reminders still come from the server in use only.
- The phone header has no ⇄ button (unchanged, Phase 68 phone apps have their own).
