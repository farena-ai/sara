# Several Saras in one app (Phase 68)

Every Sara app keeps a **list of Sara servers**, each with **its own sign-in**, and switches
between them from a menu without signing out. Useful when you have a Sara at home and one at
work, or several Saras on one computer or server (1.6.1: each on its own port or address, for
example `http://192.168.1.20:7860` and `http://192.168.1.20:7862`).

One server is **in use** at a time in each window. Removing a server signs that app out of that
server only; the others stay signed in.

## What every app keeps (the "server profile")

| | |
|---|---|
| **id** | A short id (`s1`, `s2`, …) that never changes, even when you rename it |
| **name** | Her name on that server (filled in after the first sign-in), until you rename it. Two servers with the same name get the address added: *Sara (192.168.1.20:7862)* |
| **address** | Scheme, host and port: `https://sara.example.com`, `http://127.0.0.1:7882`. A different address is a different server: changing an address means adding it again and signing in there |
| **sign-in** | Kept where the platform keeps secrets (below), never in the list itself and never shown to a page |
| **last used**, **emoji** | For sorting and telling them apart |

Where each sign-in lives:

| App | The list | Each server's sign-in |
|---|---|---|
| Windows app | `%LOCALAPPDATA%\Sara\desktop.ini` (`[servers]`, `[server.s1]`, …) | Its own WebView2 profile (the session cookie; WebView2 encrypts cookies with this Windows user's DPAPI key). `s1` is the profile used before 1.8 |
| Mac app | The app's preferences | Its own WebKit website data store (`s1`: the default store used before 1.8; others: `WKWebsiteDataStore(forIdentifier:)`, macOS 14 or newer) |
| iPhone app | The app's preferences | Its own WebKit website data store (as on the Mac) |
| Android app | The app's private settings | The server in use: the web view's cookie store. The others: their session cookies, encrypted with an AES key kept in the Android Keystore |
| VS Code | VS Code's secret storage (one entry, list and device tokens together) | Same |
| `sara-chat`, MCP bridge | `config.json` in sara-chat's config folder (readable by you only, 0600) | Same file (device tokens) |

A sign-in is only ever sent to the exact address it came from (scheme, host and port), so two
Saras on one host never see each other's sign-in, and a server can't read another server's data
through the app.

**Updating from one server:** nothing to do. The server the app used before becomes the first
in the list, still signed in.

## Adding, switching, removing

### Windows and Mac apps

- **Add:** tray icon (Windows) or menu bar icon (Mac) → *Your Saras* → **Add a Sara…**, or in the
  app: the **⇄** button at the top (shown once you have two) → **Add a server**, or Settings →
  Connections → This computer → **Your Saras…**. Type the address, then sign in with a code from
  that server's Settings → Devices and sign-in → **Add a phone or computer**.
- **Switch:** the tray/menu bar list (✓ = in use), or **⇄** → **Switch**. The "Can't reach your
  Sara" page also lists the other servers.
- **Remove:** **⇄** → **Remove** (Mac: also *Your Saras → Remove …*). The app signs out on that
  server and clears its sign-in here.
- **Rename:** **⇄** → **Rename**.
- On a Mac with macOS 13, the app keeps one server (several need macOS 14).
- **Windows: messages from every server (U2.11).** The app asks each server not in use for its unread
  messages about every 2 minutes, with that server's own sign-in (a hidden web view in its own profile,
  closed after each ask). The ⇄ list and the tray's *Your Saras ▸* show each server's count, the ⇄ button
  the other servers' total, and a new message there brings a notification that names the server;
  clicking it switches to that server's Messages. Approvals and reminders still come from the server in use.
- **Windows: the count on the taskbar button (U2.8).** A small red count (1–9, then 9+) over Sara's
  taskbar button: unread messages on all your servers together, the same count as the sidebar pill.
  It goes away at 0, screen readers hear "3 unread messages", and a server whose Messages popup is
  turned off (Settings → Messages) adds nothing.

### Phone apps (Android, iPhone)

- **Add:** scan the QR code from *Add a phone or computer* on the other server and choose **Open
  in the Sara app**: the app asks **Add this Sara?** (Cancel is the default; only add links you
  made yourself). Or **⇄** → **Add a server** / Settings → Connections → Phone and notifications
  → **Your Saras…**, then type the address and the code.
- **Switch, rename, remove:** the **⇄** button at the top of the chat (shown once you have two).
- **Notifications come from every server:** Android checks each saved server (about every 15
  minutes, each with its own sign-in; *Instant notifications* follow the server in use). The
  iPhone registers for Apple notifications with each server while you use it; each push says
  which server it came from. **Tapping a notification opens the right server**, and **Reply**
  from a notification goes to the server it came from.

### VS Code

- The status bar shows the server in use (`Sara`'s name); click it, or run **Sara: Switch server**.
- **Sara: Add a server** signs in to another one with a device code; **Sara: Sign out of this
  server** removes only the one in use. Each workspace keeps its own conversation on each server.

### `sara-chat`

```sh
sara-chat servers add https://work.example.com --name Work   # sign in with a code
sara-chat servers                 # list (* = in use)
sara-chat servers use Work        # switch (by name, id, address or host:port)
sara-chat ask "hi" --server home  # one command against another server
sara-chat servers rename Work Office
sara-chat servers remove Office   # signs out there, forgets only that one
```

`sara-chat login <address>` still works (it adds the server or signs it in again).

### MCP bridge

`node sara-mcp.ts --server Work` (or `SARA_SERVER=Work`) uses the server saved by `sara-chat`
under that name, with its own sign-in. With an address (`--server https://…`) it works as before
with `SARA_API_KEY`; an API key is never sent to a server picked by name.

## What on your computer follows the selected server

There is no background "remote control" connection from a server into your computer. What a Sara
can use on your computer is what an app sends it while you use it, and that always goes to the
**server in use** only:

| App | What she can use here | Indicator |
|---|---|---|
| Windows / Mac app | Notifications, the microphone in calls, files you pick or download | **⇄** dialog: *"<name> (the server in use) can use this computer …"*; the tray/menu bar tooltip names the server |
| Phone apps | Microphone, camera, location for place reminders, photos you share | **⇄** dialog |
| VS Code | The files and selections you send her | The status bar item and its tooltip: *"Sara on <name> (<host>) can use this computer …"*; "Sent with it" names the server |
| `sara-chat` | `ask --dir` folder overviews, `send` files | With several servers, *"Sending … to <name> on <host>"* |

Never two servers at once: switching moves all of it to the server you pick. (Decision: one at a
time, no switch to allow more; the desktop notification path is the page's, so desktop apps notify
for the server in use only. Since U2.11 the Windows app also tells you about new messages on the
others: only their counts and the newest message line, asked with each server's own sign-in.)

## For developers

- The page asks the app through `window.SaraDesktop.call('servers' | 'useServer' | 'addServer' |
  'removeServer' | 'renameServer' | 'serverName')` (desktop) or `window.SaraPhone.servers()` and
  friends (phones). It only ever gets ids, names and hosts.
- iPhone pushes: `POST /api/push/apns/register` takes an optional `profile` (the app's id for
  that server, `[\w-]{1,40}`); the server sends it back as `profile` in every push to that device.
- Tests: `test/phase68.test.ts` (the sara-chat profile store and its migration, MCP server
  selection, the VS Code profile logic, the push tag).
