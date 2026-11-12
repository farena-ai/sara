# Sara for Mac and Windows (Phase 33)

Native apps around your own Sara server. They use the system's web view (WebKit on a Mac, Microsoft
Edge WebView2 on Windows), so there is no bundled browser. The Windows app is about 0.5 MB. Since
Phase 46d the Mac app also carries Sara's server and its own Node (the DMG is about 105 MB), so the
same download either sets her up on that Mac or connects to a Sara elsewhere (docs/INSTALL.md → Mac).
Since Phase 55 the Windows installer offers the same two choices (below).

What they add over a browser tab:

| | Mac | Windows |
|---|---|---|
| Keeps running when the window is closed | menu bar icon | icon next to the clock |
| Notifications (messages, reminders, calls) when the window isn't in front | ✓ | ✓ |
| Clicking a notification opens that conversation | ✓ | ✓ |
| A call brings the window to the front | ✓ | ✓ |
| Start when you sign in | Login Items | Start with Windows |
| Microphone for calls and voice messages | ✓ (asks once) | ✓ |
| Camera on video calls, if you turn it on (Phase 69; [VIDEO_CALLS.md](VIDEO_CALLS.md)) | ✓ (asks once) | ✓ |
| Settings → Connections → This computer | ✓ | ✓ |
| Several Sara servers, each signed in, switched from a menu (Phase 68) | ✓ (macOS 14+) | ✓ |

## The menus

The tray icon's menu (Windows) and the menu bar icon's menu (Mac) list the same things in the
same order:

| Windows tray | Mac menu bar (and the Sara menu) | What it does |
|---|---|---|
| **Open Sara** (bold: what a click on the icon does) | Open Sara | Shows the window |
| Settings… | Settings… (⌘,) | Opens Settings in the window |
| Your Saras ▸ | Your Saras ▸ | The saved Sara servers (✓ the one in use), *Add a Sara…*; Mac also *Remove …* |
| | Sara on this Mac ▸ | Only on a Mac that carries her server: how she's doing, Start/Stop, Back up now, Open data folder, Change how you reach her…, New owner key…, the `sara` command, Connect to a Sara somewhere else instead…, Uninstall… |
| Start with Windows ✓ | Open at login ✓ | Start quietly when you sign in |
| Help | Help (also the Help menu, ⌘?) | Opens Sara's help in the window |
| Quit Sara | Quit Sara (⌘Q) | Quits (her server, if it runs here, keeps running) |

Settings… and Help are greyed out until the app has a Sara. The Mac's View menu also has *Zoom
In / Zoom Out / Actual Size* (⌘+ / ⌘- / ⌘0, remembered). The Windows menu has no server items
(start, stop, logs): with her server on the same PC, `sara status` and `sara logs` do that.

The app's own pages (*Connect to your Sara*, *Add a Sara*, *Can't reach your Sara*, and on a Mac
the first-launch choice and *Starting Sara…*) use the web app's colours and follow the system's
light or dark mode, with her picture at the top, like the phone apps' setup screens. The app
icons on every platform are made from one picture by `scripts/make-app-icons.py` (Windows `.ico`
with a closer crop of her face at tray sizes, the macOS rounded-square `AppIcon.png`, Android's
adaptive icon).

## Several servers (Phase 68)

Both apps keep a list of Sara servers, each with its own sign-in (Windows: its own WebView2
profile; Mac: its own WebKit data store), and switch without signing out: the tray icon's list
(Windows: *Your Saras ▸*) or the menu bar's *Your Saras ▸* menu (Mac), and the **⇄** button in the app's top bar
once there are two. *Add a Sara…* replaces *Connect to a different Sara…* (which used to sign out
of the old server); *Remove* signs out of one server only. The server used before 1.8 becomes the
first in the list, still signed in. Notifications, the microphone and files you pick go to the
server in use only, and the desktop apps notify for that server only. Details for every app:
[SERVERS.md](SERVERS.md).

## Two ways to use the apps (Phase 55)

The first question, worded the same on both systems: **Run Sara on this computer** (Mac: *this
Mac*; her server and the app) or **Connect to a Sara somewhere else** (the app only, for a Sara on
another computer or server). Remote mode shows everything on that server live, exactly like a local
install: every conversation, notifications, calls bringing the window up, the microphone, opening a
conversation from a notification, start at sign-in. Addresses without `https://` or `http://` get
HTTPS, except `localhost`, `*.local` and IP addresses (a home network, Tailscale's `100.x`), which get
HTTP (the Windows installer, the Windows app and the Mac app use the same rule).

- **Windows:** `Sara-Setup.exe`'s first page. *Connect to a Sara somewhere else* installs only
  `Sara.exe` for you (`%LOCALAPPDATA%\Programs\Sara`, Start menu entry, Settings → Apps entry; no
  administrator, no Node, no server files, no service, no `sara` command on the PATH, no data folder,
  no firewall rule), asks *Where is your Sara?* and writes the address to
  `%LOCALAPPDATA%\Sara\desktop.ini`, so the first start opens her sign-in with a code. Setup starts
  without administrator rights so this question comes first; *Run Sara on this computer* → *as a
  Windows service* starts Setup again as administrator (`/ALLUSERS /MODE=service`). Updates keep the
  mode (the first page pre-selects what's installed); running Setup again and choosing *Run Sara on
  this computer* turns an app-only install into a full one. The other way round, uninstall first (her
  data stays). Uninstalling an app-only install removes the app, its settings and its sign-in here;
  no server's data is touched. Silent: `Sara-Setup.exe /VERYSILENT /MODE=remote
  /SERVER=sara.example.com`.
- **The Windows app** (any install): tray menu → *Your Saras ▸* → *Add a Sara…* and the list of saved servers
  (Phase 68: each in its own web view profile, so no server receives another's sign-in; before 1.8
  this was *Connect to a different Sara…*, which signed out of the old one), and a *Can't reach your
  Sara* page with the address, *Try again*, *Add a Sara* and the other saved servers (it tries
  again by itself every 30 seconds). There are no server items (start, stop, logs) in its
  menu; with her server on the same PC, `sara status` and `sara logs` do that.
- **Mac:** the first launch shows the two choices. The menu bar switches later without
  reinstalling: *Your Saras ▸* has the saved servers (Phase 68) and *Add a Sara…*; *Sara on this
  Mac ▸* has *Set up Sara on this Mac…* when connected elsewhere, and when she runs on the Mac,
  *Connect to a Sara somewhere else instead…* (after a confirm:
  she stops and her LaunchAgent is unregistered; her data stays in
  `~/Library/Application Support/Sara` until `sara uninstall --delete-data`, and *Set up Sara on this
  Mac…* brings her back as she was).

## How the app updates

Sara's server updates itself (Settings → Updates). **The Windows app updates itself too**, which
matters most for the app-only install (*Connect to a Sara somewhere else*): nothing else ever
updated it, so an app could stay on an old version for months while its server moved on.

- **What it trusts.** The app reads the same signed update notice as the server
  (`update-notice.json` on each GitHub release, `src/update-notice.ts`): the version, each
  platform's installer and its SHA-256, signed with the release-notice Ed25519 key. Windows builds
  are not code-signed, so that signature and the SHA-256 are the trust anchor. The app checks the
  signature itself (`desktop/windows/src/ed25519-verify.cpp`: TweetNaCl's public-domain Ed25519
  arithmetic with Windows' own SHA-512, because Windows has no Ed25519 signatures of its own), so it
  never depends on the server it is connected to: an old server, a newer one, or one somebody else
  runs. It refuses a notice that isn't signed by the release key, one older than a notice it has
  already seen, a file that isn't on the release page, and never installs a version older than its own.
- **When it checks.** At start (unless it checked in the last 15 minutes), then every 6 hours, and
  soon after its server says it is newer than the app (at most once an hour). Offline, behind a proxy
  (it uses the system's proxy settings) or blocked: it tries again an hour later and says nothing.
- **Update the app by itself** (Settings → This computer, on by default): a new app is downloaded in
  the background to `%LOCALAPPDATA%\Sara\updates`, checked against the notice's SHA-256 and
  installed when you quit the app, or at a quiet moment (the window is closed to the tray and nobody
  has used the computer for 20 minutes). Never while Sara is using the computer (computer use). Off:
  the tray menu and the window say *Sara app 3.4.6 is ready* with **Update now** and **Later**.
- **Installing.** A copy of `Sara.exe` in the updates folder (the watcher, `Sara.exe --apply-update`)
  waits for the app to close, checks the SHA-256 once more, runs Setup silently in the mode it was
  installed (`/VERYSILENT /MODE=remote`, the same server), puts the app's server settings back as
  they were, checks the new app's version and starts the app again (hidden next to the clock when it
  was). Your sign-in, servers and settings stay: Setup keeps the same address, so the sign-in is never
  cleared.
- **When something goes wrong.** A download that doesn't match the notice is deleted and nothing is
  installed. If Setup fails (or the app is still the old version afterwards), the old app stays, it
  starts again and says so in plain words with the download page. A version that failed is not tried
  by itself again for a while (1 hour, then 2, 4… up to 2 days), so it never loops; **Update now** (or
  the server's **Update it**) tries again at once.
- **Settings → Devices** shows, for each signed-in Sara app, its version and whether it is older
  than the server, with **Update it**: the app updates the next time it checks in (its page checks in
  every 5 minutes while it runs). The owner sees their own apps and their household members' apps;
  a member sees only their own (`/api/app-updates`, a member route). Apps from before this feature
  don't check in and aren't listed: update them once by hand (download Sara-Setup and run it).
- **With Sara's server on the same PC** (*Run Sara on this computer*), the server's own update
  installs the app with her (Settings → Updates; the service install uses the Sara Update task). The
  app then only points there.
- **The Mac app doesn't update itself yet.** The signed notice already lists the Mac download, and
  macOS can check Ed25519 itself (CryptoKit), but replacing a signed `Sara.app` safely needs the Mac
  build and a Mac to test on. Until then: download the new `Sara.dmg` and drag Sara into
  Applications (a Mac running Sara's server updates the whole app from Settings → Updates).
- **Testing it** (never with the real key or a real install): `SARA_TEST_INSTALL=1
  SARA_APP_VERSION=3.4.4 bash desktop/windows/build-installer.sh` builds a test-hooks app in an
  installer of its own (`outputs/windows-updtest`: another AppId, `%LOCALAPPDATA%\Programs\SaraUpdTest`,
  data in `%LOCALAPPDATA%\SaraUpdTest\data`, so a real Sara on the PC is never touched). Run that app
  with `SARA_DESKTOP_TEST_DIR` set to that data folder and `SARA_UPDATE_NOTICE_URL`,
  `SARA_UPDATE_ASSET_BASE` (an `http://127.0.0.1:<port>/` test server) and `SARA_UPDATE_KEY` (a test
  public key); release builds don't contain these. `test/app-update-native.test.ts` checks the
  native notice check against notices Node signed (build `desktop/windows/build-test` first).

## Private: everything on this computer (Phase 67)

In *Run Sara on this computer* mode both installers ask one more thing: **Private: everything on
this computer** or **Use cloud models too** (Windows: the page *Where may Sara's AI run?*, after the
port; Mac: the *Where her AI runs* tick box in the setup sheet; not asked on updates or in *Connect to
a Sara somewhere else*). Private writes `SARA_PRIVATE_LOCAL=start` to her settings file (`sara.env`
on Windows, `service/server.env` on a Mac): *Nothing leaves this computer* is then on from her first
start until the owner turns it off. Silent Windows install: `/PRIVATE=1`. The installer passes it on
as `sara setup … --private start|off`.

The apps themselves need nothing more: Settings → Models → **On this computer** (part of the web
app) finds Ollama, suggests a model for the computer's graphics card or memory and downloads it, and
holds the switch. A **🔒 Only this computer** badge shows in the top bar while it's on. What the
switch guarantees and what it can't (her commands on Windows, the web view's own updates, the system
itself): [PRIVATE_LOCAL.md](PRIVATE_LOCAL.md). Servers can set `SARA_PRIVATE_LOCAL=1` (always on) or
`SARA_PRIVATE_LOCAL=start` themselves.

## Sara on this Mac (Phase 46d)

On first launch the Mac app asks *Run Sara on this Mac* (how you reach her, the port) or *Connect to
a Sara somewhere else*. How it works:

- `Contents/Resources/server` (src, web, persona, package.json, LICENSE) and
  `Contents/Resources/node` (one universal `node`, lipo'd from the official arm64 and x64 builds of
  the pinned version, SHA-256 checked, plus npm for her commands).
- A launchd job inside the bundle, registered with `SMAppService`:
  `Contents/Library/LaunchAgents/com.backstagecoding.sara.server.plist` ("while you're signed in").
  It runs `Sara --run-server`, a small supervisor in the app's own program: it reads
  `~/Library/Application Support/Sara/service/server.env`, starts Node with the server, restarts it
  after a crash, and honours Stop/Start (a `service/stopped` file) without administrator rights.
  Node's stdout is discarded (the one-time owner key is only in `first-token.txt`); its stderr and
  the supervisor's lines go to `logs/service.log`.
- Phase 55: the "from startup" LaunchDaemon was removed (owner decision for 1.0: only "while you're
  signed in"). An update from a Mac that used it (`SARA_MAC_RUN=daemon`) unregisters the daemon,
  stops it and registers the agent with the same data and settings; `sara setup --mode daemon` says
  the option was removed and uses the agent. The supervisor refuses to run as root.
- Upgrades: when the app's server version differs from `service/version`, the app restarts the
  supervisor (SIGHUP → exit 1 → launchd starts the new copy), which backs her data up to
  `backups/before-<version>-….tar.gz` before the new server starts.
- If Sara's switch in System Settings → General → Login Items is off, the agent answers "Operation
  not permitted" with status *requires approval*; the app opens Login Items and waits.
- `Sara --cli <command>` is the `sara` command (installed from *Sara on this Mac ▸ Install command line tool…* into `~/.local/bin`).

## Signing in

1. Choose *Connect to a Sara somewhere else* (the Windows installer's first page or the Mac app's
   first launch) and type your server address (for example `sara.example.com`).
2. On a device where you're already signed in: Settings → Devices and sign-in → **Add a phone or
   computer**, and type the code in the app.

The app keeps only the server addresses and its own settings. Each sign-in is that server's session
cookie, stored in the app's own web view profile for that server; sign it out from Settings →
Devices and sign-in like any other device, or remove the server in the app (Phase 68). Adult mode can't be turned on from the apps (web browser only).

## Without a connection (works offline)

When her server can't be reached, the app shows the chats and notes it kept, read-only, under
"Offline — showing what this device kept (as of 10:42)", and what you write waits as *Waiting to
send* until she answers again (sent once, in order: "Back online — sent 2 messages"). In the apps
*Keep a copy on this device for offline* is on by default (Settings → Connections → Devices and
sign-in); the copy is encrypted by the app's web view and deleted when you sign out. The app's own
"Can't reach your Sara" page only appears when the page was never loaded on this computer; otherwise
the page's offline page shows the kept copy. See [OFFLINE.md](OFFLINE.md).

## Building

**Windows** (Visual Studio 2022 Build Tools with C++, CMake):

```
bash desktop/windows/build.sh            # → build/Release/Sara.exe and SaraService.exe
bash desktop/windows/build-installer.sh  # → outputs/windows/Sara-Setup-<version>.exe
```

`build.sh` downloads the WebView2 SDK once (pinned version, SHA-256 checked) into
`desktop/windows/third_party/` (not committed). `build-installer.sh` also downloads, once and
checked the same way, Node.js (the version `deploy/install.sh` pins; only `node.exe` is shipped) and
Inno Setup 6 (build time only, unpacked in portable mode inside `third_party/`), stages the server
files (`src`, `web`, `persona`, `package.json`, `LICENSE`) with the two programs and `sara.cmd`, and
compiles `desktop/windows/installer/sara.iss`.

### Sara's hands (Phase 87, computer use CU1)

Both apps carry Sara's hands (docs/design/COMPUTER_USE.md): Windows in `desktop/windows/src/hands.cpp`
(WinHTTP WebSocket, DPAPI, the Sara browser launched with `CreateProcess` and the DevTools pipe on
the C runtime's inherited handles 3 and 4; `winhttp` is linked in `CMakeLists.txt`), Mac in
`desktop/mac/Sources/Hands.swift` (`URLSessionWebSocketTask`, Keychain, `posix_spawn` with the pipe
on fds 3 and 4). Both bundle `desktop/shared/page-agent.js` (Windows: RCDATA `IDR_PAGEAGENT` in
`sara.rc`; Mac: `Contents/Resources/page-agent.js`, copied by `build.sh`). Nothing new to install.

- **Settings → Computer use** in the app: **Let Sara use this computer** (off by default; the first
  time explains what it does, then asks for proof it's you, like letting in an app). The page asks
  the server for a `hands` token and gives it to the app, which keeps it (DPAPI / Keychain) and never
  gives it back. **Screenshots only to models on this computer** keeps pictures on local models.
- The Sara browser is Edge (Windows) or Chrome, then Edge, then Chromium (Mac), visible, with its own
  profile per Sara (`%LOCALAPPDATA%\Sara\hands-browser\<server id>` /
  `~/Library/Application Support/<bundle id>/hands-browser/<server id>`), never the user's.
- The tray / menu bar menu has **Stop Sara on this computer** and **Don't let Sara use this
  computer** while it's on. Quitting the app closes the connection and the Sara browser.
- Check an app's hands: `node scripts/hands-conformance.ts --server <url> --token-file <owner token
  file> --device <computer name>` (75 checks since Phase 89: the command set, refusals on the device, logs, pictures,
  deadlines, acting, the dev tunnel). For a Mac reached over SSH, forward the server and a fixture port with `ssh -R` and pass
  `--fixture-port`.
- **The state in plain words** (Settings → Computer use → This computer): *Connected: Sara can use
  this computer*, *Connecting…*, or *Not connected: <why>* with **Try again**. *Why* is the app's own
  last error (`handsError`): signed out, refused, can't reach the server, or *the web server in front
  of this Sara blocks the connection (WebSocket)* when a reverse proxy drops the upgrade (Sara answers
  426; fix the proxy as in docs/INSTALL.md, *Behind a proxy*). The page checks again every 3 seconds
  while open. The apps reconnect at once after sleep, a network change and Try again (`handsRetry`).
- **A Sara on another server** (hosted, e.g. `https://sara.example.com`): the app there counts as
  another device, so switching it on waits for the owner's OK (a code in the app; *Approve a device?*
  on her other devices and in Today's *Needs you*; or Telegram/Discord). Nothing else differs: the
  hands connect to the same address the app shows.
- Testing the Windows app next to an installed one: build with `-DSARA_TEST_HOOKS=ON` and start it
  with `SARA_DESKTOP_TEST_DIR` (its own data folder, profile, lock and Sara browser profile). On the
  Mac, a copy with another bundle id has its own preferences, WebKit data and Keychain item.

### Sara's hands act (Phase 88, computer use CU2)

- She clicks, types, chooses, presses keys from a short list, scrolls and uploads in the Sara browser
  only, through the shared page agent (`find` by ref, label or picture point) and real DevTools
  input. The app refuses on its own: password fields, key- or token-shaped text, keys not on the list,
  more than 2,000 characters, more than 4 actions a second or 120 a minute, uploads from anywhere but
  `Downloads\Sara` (Mac `~/Downloads/Sara`). Test runs use `hands-downloads` in their data folder.
- **The badge**: top centre, always on top, "Sara is working in her browser · <what>" with **Stop**;
  amber with **Resume** when paused; never in her own pictures. **Stop shortcut**: Ctrl+Alt+Esc
  (Windows) / ⌃⌥Esc (Mac); if another app has it, the tray / menu bar Stop item still works.
- **Takeover** (setting "When you move the mouse", kept as `handsTakeover` in `desktop.ini` /
  `hands.<server>.takeover`): real mouse or keyboard input in her browser pauses her (default) or,
  with **Let Sara keep control**, she carries on and the badge says so.
- **What Sara did on this computer** (tray / menu bar) opens `hands-log.txt` in the app's data folder:
  one line per action, no pictures, 30 days.
- The apps renew their hands token over the connection when under 30 days are left
  (`handsExpires` / `hands.<server>.expires`). The menus show "Connected to Sara at <host>".
- Test hooks: Windows `-DSARA_TEST_HOOKS=ON` builds label the window and badge **TEST**, accept
  `WM_APP` messages to the badge window for "the person moved the mouse" / Resume, and
  `SARA_TEST_BADGE_VISIBLE=1` lets a screenshot see the badge. Mac `SARA_DEBUG=1` builds with another
  bundle id (e.g. `com.backstagecoding.sara.desktop.cu2test`) take `SARA_TEST_HANDS_TOKEN=<file>` (its
  own Keychain item), and a distributed notification `<bundle id>.handsTest` with `input`, `resume`,
  `hotkey`, `shot:<png>` or `off`. Start a test copy with `open -n --env …` (LaunchServices: the GUI
  session's Keychain); a re-signed binary would be asked about its old Keychain item, so delete the
  test item (`security delete-generic-password -s <bundle id>.hands`) before starting a rebuilt copy.
- Conformance: 63 checks (CU2 adds find/click/type/select/keys/scroll/upload/downloads, refusals,
  stale refs, rate limit, Stop within a second).

### Dev tunnel (Phase 89, computer use CU3)

- When she opens her job's app (`pc_browser_open` with `app_port`), the app opens a listener on
  **127.0.0.1 only** on this computer (the same port number when it's free here) and carries each
  connection of the Sara browser as a stream over the hands connection to the dev server on her
  server. The page runs at a real `http://127.0.0.1:<port>`: storage, cookies and hot reload work.
- The server decides what is reachable: only a port a process of her running job listens on, never
  Sara's own. The app keeps at most 4 tunnels and 64 connections each, and closes all of them on
  `c.untunnel`, **Stop** and when the connection drops. Windows: `DevTunnels` (Winsock) in
  `hands.cpp`; Mac: `HandsTunnels` (BSD sockets) in `Hands.swift`.
- Settings → Computer use → **Dev tunnels** lists open tunnels (**Close**) and has **Try the dev
  tunnel**: a test page from the server that should say "All checks passed".
- Conformance: 75 checks (section 9: the test page's storage, WebSocket, upload and large file, the
  tunnel list, refusals, closing).

### Saved logins (Phase 90, computer use CU4)

- Only on this computer. Windows: a DPAPI (current user) file `%LOCALAPPDATA%\Sara\logins.dat`
  (sealed JSON: name, exact sites, username, password, the Sara server it belongs to, dates); test
  builds keep it in their own data folder. Mac: one Keychain generic-password item per login (service
  "Sara logins", `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, never synced; DEBUG test copies use
  "Sara logins (TEST)"). Each login belongs to the Sara server it was saved through.
- `b.login` fills one only when the tab's current origin is exactly a saved one (scheme, host, port),
  through `Input.insertText` on the DevTools pipe after a real click and a focus check by the page
  agent (`loginFields` / `focusLogin`, which never return values); it answers filled / not found /
  site doesn't match. `b.saveLogin` opens the app's own window (**Save a login for Sara?**: the
  warning, Name / Username / Password, an unticked **I understand**, Save stays off until it's
  ticked, **Use what I just typed** when the person signed in on that site in the Sara browser in the
  last 10 minutes: caught by a DevTools binding in an isolated world, memory only). `b.yourTurn`
  shows **Your turn** with **Continue**. Both wait up to 10 minutes. `b.logins` / `b.forgetLogin`
  list and remove (names, sites, dates only). The hello and an `ev logins` after each change carry
  names and sites.
- The app's Settings page (Computer use, This computer) lists this computer's logins with **Remove**
  and has **Ask for Windows Hello / Touch ID before Sara uses a saved login** (off by default;
  Windows `UserConsentVerifier`, Mac `LAContext` with the device password as fallback). The web
  Settings shows each connected computer's list; Remove there is an op the computer carries out.
- Windows: the vault, the two windows and the Hello check are in `hands.cpp` (Phase 90 section);
  Mac: `HandsLogins`, `HandsLoginPanel` and `handsTouchID` in `Hands.swift`.
- Conformance (section 10): 17 CU4 checks; the windows are answered by `--consent-driver` (a UI
  automation script on Windows, the DEBUG test hook `login:<step>` on the Mac).
  `scripts/hands-capture.ts` is a recording relay in front of the server that decodes every hands
  frame both ways, so a test password can be searched for in all of it.

### Password managers (Phase 91, computer use CU4b)

- Bitwarden (`bw`), 1Password (`op`) and KeePassXC (`keepassxc-cli`) are found by checking that the
  command-line tool exists and answers `--version`; nothing else runs until the person turns a
  manager on. Windows looks on PATH and in the usual Program Files folders; the Mac on PATH,
  Homebrew's folders and `KeePassXC.app`. Test builds (Windows `SARA_DESKTOP_TEST_DIR`, Mac DEBUG
  copies with another bundle id) look only in `SARA_PM_PATH`, so they never find the owner's own tools.
- The app's Settings page (Computer use, This computer, **Password managers**) lists them as *Not
  installed here*, *Off*, *On · locked* or *On · unlocked for Sara*, with a switch each, **Lock again
  after** 5 / 15 / 30 / 60 idle minutes (15 by default) and **Lock now**. Turning one on shows the app's
  own warning (a native message box / `NSAlert`; the web page can only ask) and, for KeePassXC, the
  database to use. The choices are in `desktop.ini` (`pmBitwarden`, `pm1password`, `pmKeepassxc`,
  `pmKeepassDb`, `pmRelockMinutes`) / the Mac's preferences, per server.
- Unlocking is always the person's: `b.unlock` opens the manager's own prompt in a window of its own
  (Windows: a console running `bw unlock --raw`, `op signin --raw` or `keepassxc-cli export -f csv
  <db>`, titled "Unlock … for Sara: sign in to <origin> (close this window to say no)"; Mac: a
  Terminal window running the same). Only the command's standard output comes back, through a named
  pipe / FIFO only this user can open: Bitwarden's session key, 1Password's session token, or
  KeePassXC's entries that have a web address. They are kept in memory only, and wiped when locked.
  The unlock window can be shown at most 3 times in 10 minutes per manager.
- `b.login` with `managers: true` fills from Sara's own saved logins first, then Bitwarden, 1Password
  and KeePassXC, only an entry whose address is the page's exact origin (an address without a scheme
  means https). It answers filled (with the source), not found, or locked (the managers by id).
- Locked again by `b.relock` (the server sends it when the chat turn ends), after the idle minutes,
  on Stop (button, hotkey or the server's), when the connection drops, when a manager is turned off or
  its database changed, and when the app closes: `bw lock`, `op signout`, KeePassXC's entries forgotten.
- Windows: `Managers`, `runCli` and `promptCli` in `hands.cpp` (Phase 91 section); Mac:
  `HandsManagers` in `Hands.swift`. Conformance section 11 (CU4b) uses test doubles of the three CLIs
  (`test/fixtures/fake-pm/`) or a real KeePassXC with a new test database; the prompts are answered
  by `--unlock-driver` (Windows: a script that types into that console; Mac: the DEBUG hook
  `pm:type:<pieces>` / `pm:wrong` / `pm:close`).

### Desktop look (Phase 92, computer use CU5)

- **The whole screen** (a second switch under Let Sara use this computer, off by default, with its own
  explainer; `handsDesktop` in `desktop.ini` / `hands.<server>.desktop`): Sara may **look** at the screen
  and windows (`d.screens`, `d.windows`, `d.shot`, `d.elements`). Phase 93 adds locally approved desktop input (draft; see below).
- Windows (`desktop/windows/src/hands-screen.cpp`): pictures with GDI (`BitBlt` + `CAPTUREBLT` for a
  screen or an area, `PrintWindow(PW_RENDERFULLCONTENT)` for one window), element lists with UI Automation
  (control view, depth 8, 300 items, `IsPassword` fields never read), JPEG through WIC. The app's own
  windows are set to `WDA_EXCLUDEFROMCAPTURE` while a picture is taken; any other Sara window is blacked
  out. A locked screen or the screen saver answers "can't see it now" instead of a black picture.
- Mac (`desktop/mac/Sources/HandsScreen.swift`): ScreenCaptureKit (`SCScreenshotManager`, macOS 14+, the
  Sara app left out with `SCContentFilter`), `CGWindowListCopyWindowInfo`, Accessibility (`AXUIElement`,
  `AXSecureTextField` never read). Both need the person's permission in System Settings → Privacy &
  Security (**Screen Recording**, **Accessibility**); without it the op answers `perm_missing` with the
  steps. The page shows the two steps with **Open System Settings** (`handsOpenPerm`) and a tick per
  permission (`handsPerms` in the prefs, polled every 2 s).
- Blocklist (both apps, the same list as `src/hands-desktop.ts`): password managers (KeePass/KeePassXC,
  1Password, Bitwarden, …), security settings, banking, any title with a Sara token, plus **Also hide these
  windows** (`handsBlockExtra` / `hands.<server>.blockExtra`, one per line). Blocked windows are black in
  pictures, absent from element lists and listed by `d.windows` only as `{hidden: kind}`.
- Test copies: Windows test builds take `handsDesktop=1` in their own `desktop.ini`; Mac test copies take
  `SARA_TEST_HANDS_DESKTOP=1` next to `SARA_TEST_HANDS_TOKEN`. Conformance section 12:
  `--desktop --desktop-window "<fixture title>" --desktop-text "<text>" --desktop-blocked-area x,y,w,h` with
  `SARA_CU5_SECRET` (the fixture password field's value); `--ref --desktop` uses the fixture desktop.

### Your own browser tabs and files (3.4.x)

Sara has **her own** browser window on your computer (a separate Edge or Chrome window with its own
profile, opened by her: `pc_browser_*`) and, separately, can look at **yours**:

- **Your open tabs** (`pc_my_tabs`, device op `d.tabs`, needs **The whole screen**): every tab of each
  Edge, Chrome, Firefox or Brave window you have open (title, and the address bar's text for the tab in
  front), read only. Windows: UI Automation over each browser window's tab strip (TabItems; web pages are
  never entered), in `desktop/windows/src/hands-screen.cpp` (`tabs()`); Sara's own browser window is left
  out. Banking and password-manager tabs and windows show only as hidden. Older apps (no `d.tabs`) and the
  Mac app for now: the title of each browser window (its front tab), and Sara says to update the app.
- **Your files** (`pc_files`, ops `f.list` / `f.read`, needs **Files** under Computer use, off by
  default; `handsFiles` in `desktop.ini`): list Desktop, Documents and Downloads and folders inside them,
  and read text files there (.txt, .md, .csv, .json, .log…, up to 1 MB, 32,000 characters back). Nothing
  is ever changed, moved or deleted. Only inside those three folders (links and junctions that lead out
  are never followed; `..`, full paths, other drives and UNC paths are refused); hidden files and
  secret-looking names (keys, certificates, `.env`, password databases, wallets) are left out and never
  read; key-shaped text is masked. Windows: `desktop/windows/src/hands-files.cpp`; the shared rules and
  the reference device: `src/hands-files.ts`. Test builds read `SARA_FILES_TEST_ROOT` (its `Desktop`,
  `Documents`, `Downloads` folders) instead of the person's real folders. Not in the Mac app yet.
- An app that is too old for these says so in `pc_devices` (update the Sara app to the server's version
  from the releases page), and a switch that is off is named exactly.
- The companion's name: every computer-use text from the server uses it ("Fred’s browser"); the app's
  badge shows the name each request carries ("Fred is working in Fred’s browser"). The download
  folder keeps its name on disk (`Downloads\Sara`) so existing installs keep working.

### Commands on this computer (3.5, PC tools)

Off by default. In the Sara app: Settings → Computer use → **Let her run commands on this computer**
(needs *Let Sara use this computer*). Then she can:

- **run one command** (`pc_run`): PowerShell (default) or cmd, in a folder you name or your home
  folder, for up to 10 minutes (60 seconds unless she asks for more). She gets the exit code and the
  start and end of the output (at most 64 KB from the computer, 16,000 characters for her model);
- **open one thing** (`pc_open`): a web address (https, mailto), a file or folder by its full path,
  or an app by its Start-menu name. Never a program or script file, never a command line.

**Every command is shown on this computer** in the app's own card: the shell, the folder and the
whole command, with **Allow once**, **Allow for this task** and **Don't** (closing it is Don't). The
answer exists only on this computer: a phone or the web chat can't approve. *Approvals for commands*
has the same choices as desktop actions (*Ask once per task*, *Ask every time*, *Always allowed*,
which asks you to confirm). Commands that delete, change settings, stop programs or download and run
things always ask, and only offer *Allow once*. **Simple read-only commands without asking** (off by
default) lets a short list run without the card: one `dir` / `Get-ChildItem` / `Get-Content` /
`type` / `Get-Process` / `git status|log|diff|branch`, with pipes only to `Select-Object`,
`Sort-Object`, `Format-*` or `Measure-Object`, no `;`, `&`, redirects or subexpressions.

Commands run as you, **never as administrator**: `runas`, `sudo` and `-Verb RunAs` are refused, and
if the app itself runs as administrator nothing runs. Each command runs in a Windows Job object:
**Stop** (the chat card, the badge, Ctrl+Alt+Esc), the timeout and the end of the command end it and
everything it started (use `pc_open` for an app that should stay open). Nothing new starts while the
computer is locked or you took over. Key-shaped text (API keys, tokens) in the output is replaced by
`[hidden]` here and again on the server. *What Sara did on this computer* lists every command (ran,
stopped, said no), and the server's audit trail has a `pc.run` line for each.

Household members' companions never get these tools; private chats can use them (the command runs
here and its output goes to the model that chat uses). An app older than 3.5 doesn't offer commands:
she says to update it. The Mac app can't run commands yet.

To use this computer's Ollama or LM Studio from a Sara server elsewhere, add it as a model provider
(*Ollama on my computer*, over Tailscale or your home network): see
[CHOOSING_A_MODEL.md](CHOOSING_A_MODEL.md).

### Which folders, your own browser (3.5.2)

- **Files → Which folders** (Windows app): `three` (Desktop, Documents, Downloads; default), `picked`
  (those plus folders chosen with the folder picker), `home` (your user folder) or `drives` (all fixed
  drives). Read only. Refused everywhere: Windows and program folders, other users' folders, and places
  holding keys or credentials (`.ssh`, `.gnupg`, password stores, browser profiles, wallets); key-shaped
  text is masked. The server is told only the root names (`Desktop`, `Folder 2`, `C:`), never the paths.
- **Your own browser:** `pc_my_tabs` lists your tabs; `pc_look` / `pc_click` / `pc_type` work in your browser
  window that is in front through UI Automation. Payment, account and sign-in pages always ask; password fields
  are never typed into; banking and password manager windows stay blocked; Sara's own server and sign-in pages are
  refused. `pc_my_tabs` with `switch` (op `d.tabswitch`) brings another of your tabs to the front, approved on the PC.
  Browser windows are listed 20 levels deep (apps 8), so page links and fields are in the element list.
- **Before the approval card** the target window may be behind other windows (inspect only).
- **After Allow** the app brings that exact window to the front (sharing input with the window in front for that
  one call, as Windows requires) and repeats every check; the target must be the very same control (runtime id),
  the other controls the same type, name, place and state.

### Desktop actions (Phase 93, released in 2.26.0)

With **The whole screen** on, Sara can request clicks, non-secret typing, safe keys, scrolling,
dragging and installed-app launch. She looks first and checks the result after each action. Text-only
models use accessibility refs without taking a picture. Views bind to an exact window/control and
expire after 20 seconds; a slow local approval revalidates that same target before proceeding.

On that computer, Settings → Computer use has **Approvals for her desktop**: **Ask once per task**
(default), **Ask every time**, or **Always allowed** (a native warning first). Desktop cards are
answered there: **Allow once / Allow for this task / Don't**. A phone cannot answer them. Payments,
card fields and account changes still ask once. Task grants end with the task, Stop or disconnect.

**When you move the mouse** also covers keyboard input anywhere during a desktop task. **Pause Sara**
is the default; Resume is on her badge. **Let Sara keep control** continues while you use the computer.
Stop and **Ctrl+Alt+Esc** / **Control-Option-Esc** work in both modes; if the global shortcut or input
monitoring is unavailable, desktop input stays off. Sara ignores only her own tagged synthesized
input. **Keep working when I walk away** is off by default and holds system/display wake requests
for the task. It does not unlock the computer, defeat a security lock policy or force a re-lock.

The computer refuses secure/password fields, elevated windows, locked/secure desktops, protected or
Sara windows, Sara's own browser origin, uncheckable browser addresses, unsafe system keys and
unencrypted non-loopback connections. Terminal/system-settings and Explorer/Finder input are also
conservatively refused. Installed apps are named by Start-menu shortcut on Windows or bundle ID on
Mac; arbitrary paths and commands are not accepted. After an approval, the actual target must again
be in front. Drag endpoints and paths stay inside that target window.

Native implementation: Windows UIA Invoke/Value/Scroll then tagged SendInput; low-level global hooks,
Win32 local card, SetThreadExecutionState. Mac AX actions/values then tagged CGEvents; listen-only
CGEvent tap, NSAlert local card and IOPMAssertions. Input monitoring is registered while the hands
channel runs and observes takeover only during opted-in desktop tasks. This feature is for the
Developer ID Mac app, not an App Store sandbox build.

**Remaining owner acceptance:** use an isolated fixture, never a real password or account. On Mac,
allow the exact test/release app in System Settings → Privacy & Security → Screen Recording and
Accessibility; if macOS requests Input Monitoring, allow that exact app there too, then quit/reopen.
Check the native card's three choices, type into the fixture's Name field, Save, and confirm the
password field is refused. While she works, move your real mouse and press a key in another app:
she must pause within one action; Resume must work. Confirm Stop/the shortcut in a full-screen
fixture, both takeover modes, both display scales, and drag. Verify wake release on Stop and task
end. These are pending; automated tests and successful native compilation do not replace them.

For native checks without any input, build Windows with `SARA_TEST_HOOKS=ON`, target
`CU6NativeChecks`; on Mac compile a separate bundle ID with `swiftc -Onone -D DEBUG -swift-version 5
-target arm64-apple-macos13.0 -o <test-app>/Contents/MacOS/Sara desktop/mac/Sources/*.swift`.
`node scripts/hands-conformance.ts --server <throwaway-server> --token-file <test-owner-token>
--native-desktop-permissions <test-executable> --json <receipt>` runs native policy/precondition
checks. The Mac CLI reports its actual permission state and uses invalid views, so it never posts
an event even if Accessibility happens to be trusted. `--desktop-permissions-only` is the channel
variant for a connected test copy without Accessibility. Do not count either as positive native
input, card interaction or a full-screen Stop test. `--ref --desktop` runs the complete reference
suite. The test-only `CU6Fixture` target is a small native form; no installed app/data is replaced.

### Check-ups (Phase 94, computer use CU7)

With **The whole screen** on, the apps answer `s.check`: a READ-ONLY check-up of the computer through a
fixed list of OS calls (nothing from the server is run, nothing is written, deleted or opened).

- **Windows** (`src/hands-checkup.cpp`): startup apps from the HKCU / HKLM `…\CurrentVersion\Run` keys and
  both Startup folders, with Explorer's `StartupApproved` on/off state; fixed drives (`GetDiskFreeSpaceExW`);
  sizes of Downloads, Documents, Desktop, Pictures, Videos and Music (a bounded walk: 200,000 entries or 4 s per
  folder, reparse points never followed, files never opened); updates waiting from Windows Update's own last
  scan (Windows Update Agent, offline search) and whether a restart is pending; battery charge, health and cycles
  (`GetSystemPowerStatus`, the battery driver's `IOCTL_BATTERY_QUERY_INFORMATION`); extension names from the
  manifests in your own Edge / Chrome / Brave profiles; the temp folder, browser caches and the Recycle Bin.
- **Mac** (`Sources/HandsCheckup.swift`): your and the computer's LaunchAgents, volume capacities, the same
  bounded walk of your folders (macOS may ask once before Sara reads Documents, Desktop or Downloads), updates
  from `softwareupdate --list --no-scan` (macOS's own last scan), battery (IOKit power sources and the
  `AppleSmartBattery` entry), Chrome / Edge / Brave extension manifests, temp, caches and the Trash (needs Full
  Disk Access).
- The apps don't make check-up changes through `s.apply` in this draft (`unsupported`). Instead (3.6.x, "do it
  for them") every suggestion has **Do this**: `pc_checkup_apply` returns the exact steps and Sara does them with
  the approved tools she already has, each step approved on the PC: removing the browser extensions you name
  (she opens the browser's extensions page in your own browser and presses Remove, then confirms), a startup app
  that starts for everyone (Settings → Apps → Startup), files you pick from Downloads (to the Recycle Bin, with
  `pc_run`), the browser cache (Clear browsing data, cached files only), old temp files and the Recycle Bin
  (`pc_run`), and a restore point (she opens System Protection; you press Yes and Create, because that window
  runs as administrator). If a switch is off or the app is old, the reply names the switch and where it is, or
  says to update.
- Testing: the test-hooks build adds `CU7NativeChecks.exe`, which runs the check on this PC and prints counts
  and sizes only (never a name). On a Mac, compile `test/fixtures/cu7-mac-checks.swift` as `main.swift` with
  `Sources/HandsCheckup.swift`. `scripts/hands-conformance.ts --checkup` adds section 14.

### Doing it for you (3.6.x)

If you could do it on your computer, Sara can do it for you, with your approval on that computer for anything
that changes something. The Windows app's desktop rules (`src/hands-screen.cpp`) now allow:

- **Your browser's own settings pages** (`edge://extensions`, `chrome://extensions`, `about:addons`, Clear
  browsing data…): she may click there, and they always ask (Allow once only). On the extensions page (and its
  "Remove …?" confirmation, which may be its own small window: its owner window's address decides) the Remove
  button works; deleting files stays refused everywhere. Your browser's passwords, payment methods, autofill,
  sync, profile/account and security pages stay refused (`internalPage`).
- **The address bar:** while it is being edited, only one address may be typed in (never Sara's own server, never
  a blocked page) and then Enter; before, an address bar being edited refused every action.
- **The Settings app** on its Apps (Installed apps, Startup, Default apps) and Storage pages, told apart by the
  page's header, always asking. Accounts, sign-in, privacy, Windows Security, BitLocker, firewall, family and
  recovery stay refused, as do terminals, the Registry Editor and other protected apps (commands go through
  `pc_run`, which you approve).
- **Windows' administrator prompt:** never answered and never automated. When it is showing (the secure desktop
  with `consent.exe`), her actions stop with "the person presses Yes there", and she tells you "Windows will ask
  you to allow this change — press Yes" and waits. Commands still never ask for administrator rights themselves
  (no `-Verb RunAs`); programs that need them (`winget uninstall`, installers) show Windows' own prompt.

When she can't, she says exactly what is missing: a switch (its name and where: the Sara app → Settings →
Computer use), an older app (update), or which hard limit (passwords, banking, password managers, the
administrator prompt or an administrator window, a locked computer). Words like remove, uninstall, clean, fix,
delete or disable about something on the computer (or a check-up number like "#3") bring her the desktop and
command tools. `CU6NativeChecks.exe` (test-hooks build) checks the new rules natively.

### Sara-Setup.exe: her server and the app together (Phase 46c)

What the Windows installer puts on the computer (details for owners: docs/INSTALL.md → Windows):

| | Service (default) | Only while signed in |
|---|---|---|
| Program | `C:\Program Files\Sara` | `%LOCALAPPDATA%\Programs\Sara` |
| Her data | `C:\ProgramData\Sara` (service account, administrators, SYSTEM only) | `%LOCALAPPDATA%\Sara\data` |
| Starts | service **Sara**, `NT SERVICE\Sara`, delayed automatic start, restart on failure | HKCU Run entry "Sara server" |
| `sara` command | on the system PATH (run it as administrator) | on your PATH |

Inside the program folder: `Sara.exe` (this app), `SaraService.exe`, `node\node.exe`, `server\`
(her code), `bin\sara.cmd`, and `sara.env` (her settings: `SARA_DATA`, `SARA_PORT`, `SARA_HOST`,
`SARA_ACCESS`, `SARA_PUBLIC_URL`, …; changed by `sara access`, read at every start).

`SaraService.exe` (desktop/windows/src/service.cpp) is a small service host: as the Windows service
(`--service`) or in the signed-in session (`--run`) it starts `node\node.exe server\src\main.ts`
with the variables from `sara.env`, starts her again with a growing pause (2 s … 60 s) if she stops by
herself, keeps everything she starts in a job object (it all ends with her), and stops her cleanly by
closing her stdin (`SARA_STOP_ON_STDIN_END=1` makes the server shut down as on SIGTERM; she's killed
only after 20 s). Its own lines and her error output go to `<data>\logs\service.log`; her normal log
is `<data>\logs\sara.log`. Her normal output (where the owner token is printed) is not kept: the
installer reads the token from `<data>\first-token.txt`. Other switches: `--start`, `--stop`,
`--state`, `--install-service`, `--remove-service`, `--port-free N`, `--lan-ip`.

When the app sits next to `SaraService.exe` it doesn't install itself and its *Uninstall* opens the
installer's uninstaller. The installer pre-sets the app's server address to
`http://127.0.0.1:<port>` (`%LOCALAPPDATA%\Sara\desktop.ini`, only when it was empty or already a
local address) and *Open Sara* passes `--server http://127.0.0.1:<port>`. A stand-alone `Sara.exe`
that installed itself into the same folder is taken over (its own uninstall entry is removed). The
stand-alone app's uninstall now keeps a `data` folder it finds in `%LOCALAPPDATA%\Sara` (a server's
data) and removes only its own files.

**Mac** (Xcode command line tools), on the Mac:

```
bash desktop/mac/build.sh            # → desktop/mac/build/Sara.app, Sara.dmg and Sara-<version>.dmg
```

It needs the repository's `src`, `web`, `persona`, `package.json` and `LICENSE` next to `desktop/`
(they go into the app), downloads the two pinned Node builds once into `~/Library/Caches/sara-build`
(`SARA_BUILD_CACHE`) and checks their SHA-256. The app's version is `package.json`'s. It signs with
a "Developer ID Application" certificate when the keychain has one: hardened runtime, Node first with
`node.entitlements` (`allow-jit` and `allow-unsigned-executable-memory`, which V8 needs), then the
app; and notarizes when `NOTARY_PROFILE` names a stored `notarytool` profile (`SARA_NOTARIZE=0`
skips it). Without a certificate it signs ad hoc. There's no Developer ID *Installer* certificate,
so the download is a DMG, not a .pkg.

To keep signing separate from your login keychain, put the certificate and the `notarytool`
profile in a keychain of their own, `~/Library/Keychains/sara-signing.keychain-db`, and point
`SARA_KEYCHAIN_PASS_FILE` at a file (mode 600, outside the repository) holding its password:
`build.sh` then unlocks it, signs with a timestamp, notarizes and staples, so the DMG opens on any
Mac without warnings.

The DMG opens as an install window (2.18): Sara on the left, an arrow, the Applications shortcut on
the right and "Drag Sara to Applications" in the background, 600 × 400, no toolbar or sidebar. The
background is `desktop/mac/dmg/background.png` and `background@2x.png` (made by
`desktop/mac/dmg/make-background.py`); `build.sh` makes a read-write image, has Finder lay out the
window with `desktop/mac/dmg/layout.applescript`, then compresses, signs and notarizes it. That needs
the logged-in Mac session (over SSH, Finder's Automation permission) and **no other volume called
Sara mounted** (eject an older Sara DMG first): Finder finds the volume by its name. Otherwise
`build.sh` stops and says why (`SARA_DMG_PLAIN=1` builds a plain window instead). The read-write image
is made under `/tmp` and the finished layout is checked so it never names the building Mac's user
folder (Finder keeps an alias to the image file in `.DS_Store`); no saved layout is kept in the repo.

## Offering them for download

Put the files in the server's data folder; Settings → Devices and sign-in then shows a
*Download for Mac / Windows* button in a web browser on that kind of computer:

```
/var/lib/sara/downloads/Sara.exe
/var/lib/sara/downloads/Sara.dmg
```

Only the signed-in owner can download them (`GET /api/desktop-apps/windows|mac`).

## Installing

- **Windows, with her server on the same PC:** run `Sara-Setup.exe` (above, and docs/INSTALL.md →
  Windows) and choose *Run Sara on this computer*. It installs the app too.
- **Windows, for a Sara somewhere else:** run `Sara-Setup.exe` and choose *Connect to a Sara
  somewhere else* (the app only, no administrator).
- **Windows, app only, without the installer:** open `Sara.exe`. It copies itself to `%LOCALAPPDATA%\Programs\Sara`, adds a Start
  menu entry, appears in Settings → Apps (with Uninstall) and starts. No administrator rights.
  Until the app is signed with a code-signing certificate, Windows SmartScreen says "Windows
  protected your PC": choose **More info → Run anyway**.
  Uninstall removes the app, its shortcut, the start-with-Windows entry and its data on the PC.
- **Mac:** open `Sara.dmg` and drag Sara to Applications. The DMG is signed with a Developer ID
  and notarized, so it opens like any downloaded app. (An ad-hoc build from a Mac without the
  certificate needs right-click Sara → **Open** the first time.)

## Testing without a screen

The Mac app has test hooks compiled only into `-D DEBUG` builds (`SARA_DEBUG=1 bash
desktop/mac/build.sh`): `SARA_TEST_JS=<file>` runs that script after each page load and appends the
result to `SARA_TEST_OUT`; `SARA_TEST_SETUP=agent,local,7861` runs the first-launch setup without the
sheet and skips the owner-key sheet. Release builds don't contain them. The server side can be
driven entirely over SSH with `Sara.app/Contents/MacOS/Sara --cli setup|status|stop|start|uninstall…`
(`SMAppService.agent` registers fine from an SSH session). The Windows app can be driven with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` and `--portable` (runs
without installing itself). Phase 68: a test build (`cmake -DSARA_TEST_HOOKS=ON`, never for
release) also honours `SARA_DESKTOP_TEST_DIR=<folder>` (its own settings, web view profiles and
single-instance lock), so it runs next to the real app without touching its sign-ins. Phase 55 was checked that way: the installer in remote mode
(`/VERYSILENT /CURRENTUSER /MODE=remote /SERVER=http://127.0.0.1:<port>` against a scratch server),
then pairing with a code, *Connect to a different Sara…*, the unreachable page and the uninstall.

## The page in the title bar (2.5)

The apps tell the page they can host its header in the title bar; the page answers when it draws there.

- Before page scripts run the app sets `<html class="shell-windows">` or `shell-mac`, the CSS variables
  `--shell-titlebar` and `--shell-controls-right` (Windows) / `--shell-controls-left` (Mac), and
  `window.saraShell = { platform, titlebar, controls: { side, width }, theme, backdrop, backdrops, version }`
  (Windows: titlebar 40, controls right 154; Mac: 38, left 90).
- The page posts `{type:'shell', titlebar:true}` once it draws its header in the strip (Windows:
  `window.chrome.webview.postMessage`, Mac: `window.webkit.messageHandlers.sara.postMessage`). Until then,
  for example with an older server, the app draws its own 40 px strip and starts the page below it.
- `{type:'theme', theme:'night'|'day'|'system'}` and `{type:'backdrop', backdrop:'mica'|'vibrancy'|'solid'}`
  are accepted only from the owner's own server. The theme message also carries `frame:'#rrggbb'`,
  the colour of the page's top edge (V4's status strip, or the page background on the sign-in page
  and in Sara Classic); the Windows app paints its top resize band, the place under the caption
  buttons and the caption in it and keeps it in `desktop.ini` (`frameDay` / `frameNight`). Without
  it (an older server), and on the app's own setup / offline pages, the app uses Sara Classic's
  `#faf7f5` / `#0f0d17`.
- Windows: dark title bar (DWM immersive dark mode), optional Mica, WebView2 non-client regions for CSS
  `app-region: drag`, native caption buttons with snap layouts. Falls back to the normal title bar on
  Windows 10 or a WebView2 runtime older than 123. Mac: full-size content view, transparent title bar,
  traffic lights inset; WebKit has no `app-region`, so a press on the strip calls `performDrag`.
- Test in a browser with `?shell=windows&titlebar=32` or `?shell=mac` (stand-in window buttons).
- 3.5.2: the theme message also says `shown:'day'|'night'`, what the page really renders. With
  *Follow the system* the page decides by its own `prefers-color-scheme`, which the app's reading of
  the registry (`AppsUseLightTheme`) can disagree with; the app follows `shown`, so the frame colour
  lands in the right slot. A kept `frameNight` that is light (or a `frameDay` that is dark) is
  ignored at start, and Mica is only on once a page asks for it in this run (no page does today).
- desktop.log: at start `Windows 11 Home (26100.4061), system dark mode, accent on title bars off,
  high contrast off`; then a `frame:` line whenever the theme, colour, whose title strip, backdrop
  or the DWM results change. Test builds: `SARA_TEST_SYSTEM_THEME=dark|light` (the registry reading
  and the web view's colour scheme) and `SARA_TEST_WINBUILD=19045` (the Windows 10 path).
- Check-in (after 3.6.1): the app sends its frame decision with its check-in (`frame` in
  `app-installs.json`; the tooltip on the app's line in Settings → Devices), for example
  `strip page, #0b0c0e page, shown night, pref system, page said 2x, regions yes, mica off, caption ok, dpi 144`:
  who draws the title strip (`page`, `app` = the app's own strip, `windows`), its colour and where it
  came from (`page`, `builtin`, `local`), the theme shown, how often a page said it draws the strip,
  app-region support, Mica, the caption-colour call, the DPI, and `paint fallback` if buffered paint
  failed. `strip app` with `page said 0x` on a server page means the page never announced its title
  strip. Every `{type:'theme'}` message from the page now also carries `titlebar: true`, and a page
  restored from the back/forward cache says `{type:'shell'}` again.

## Her face as the app's icon (3.5.2)

- `/api/session` (signed in, not the demo) says `face: { kind, src, tag }` (`src/app-face.ts`):
  `custom` (an uploaded picture, `/api/sara/avatar`), `look` (a custom look or the he/they default
  look, `/sara-avatar.jpg`), `initial` (another companion without a look) or `builtin` (Sara with
  her own look). `tag` changes with the picture.
- The quick-ask page draws it at 256 px (rounded square) when the tag changes and posts it with its
  state (`icon: 'data:image/png;base64,…'` or `'builtin'`); an older server says nothing and nothing
  changes.
- The Windows app keeps it per server (`icon-<host>.png` in its data folder) and makes from it: the
  window icons (`WM_SETICON`, at the screen's sizes), the tray icon and its Hey Sara dot variants,
  the notifications' icon and name (the AUMID's `IconUri` / `DisplayName`), a `.ico` named after its
  content for the taskbar (`PKEY_AppUserModel_RelaunchIconResource`, removed on `WM_DESTROY`) and for
  the app's own shortcuts (Start menu, desktop, taskbar pin: only ones that point at this exe and
  carry its AUMID). `builtin` puts the exe's icon back on those shortcuts and deletes the files.
  The uninstaller removes the shortcuts as before; the files go with the data folder.
- The window title, the app's own title strip and the tray tooltip use her name (kept per server
  too). Switching servers switches both. Test builds never touch real shortcuts:
  `SARA_TEST_SHORTCUT=<path to a .lnk>` names one to update.

## Quick ask and the tray "Now" (2.6)

- **Shortcut:** Alt+Shift+S (Windows, `RegisterHotKey`) / ⌥⇧S (Mac, Carbon `RegisterEventHotKey`, no
  Accessibility permission). Change it in the tray / menu-bar menu → *Quick ask shortcut* (or Off); if
  another app holds it, the menu says so. The page can read and set it through the bridge:
  `getPrefs().quickAskShortcut(s)`, `setPref({key:'quickAskShortcut', value})`, `SaraDesktop.call('quickAsk')`.
- **Window:** `desktop/shared/quick-ask.html`, served by the app at `<server in use>/__sara_desktop/quick-ask`
  so it shares the main window's sign-in; only that view bypasses the service worker. A new conversation
  per question (follow-ups stay in it); *Open in Sara* continues it in the main window. It never accepts
  the AI notice for you: until the notice is accepted it shows the notice and *Open Sara*; the session
  notice is shown above the question. Off on the demo.
- **Tray / menu bar:** her face and mood at the top, *Ask Sara…*, then *Now*: approvals waiting (Allow /
  Deny / Open in Sara) and running jobs. Refreshed every 45 s, when the menu opens and on job/turn events.

## The keyboard goes to the page (3.5.1)

A window that is activated without a click in its page (at start, from the taskbar or Alt+Tab, when an
approval card, the computer-use badge or another app's window goes away, or when it was shown behind
another app) gets the keyboard on its own frame; WebView2 doesn't take it from there, so keys were
lost while the page still showed its caret. The Windows app passes it on with
`MoveFocus(PROGRAMMATIC)`: on `WM_SETFOCUS`, after `WM_ACTIVATE` / `WM_ACTIVATEAPP`, when the web view
is created, after every hands op (its cards and pictures, `Host::onFocusBack`), when the badge hides,
and when a key still lands on the frame (that key is lost, the next ones arrive). Only when the frame
itself (or nothing) has the keyboard and the window is Sara's main window or quick ask, in front or
the active window of its thread. Quick ask does the same for its own web view.

## Quick ask anywhere: selected text, this window, voice

Windows app (`desktop/windows/src/quick-context.cpp`, `voice-pill.cpp`, glue in `main.cpp`; the page is
`desktop/shared/quick-ask.html`).

- **Selected text:** when the quick-ask shortcut is pressed, the app remembers the window in front and
  reads its selection: UI Automation's `TextPattern` selection of the focused control first (an empty
  selection stays empty); only when that control has no text pattern, a simulated Ctrl+C after the
  shortcut's keys are let go, with every clipboard format saved before and put back right after. If any
  format can't be put back byte for byte (GDI handles other than a DIB-backed bitmap or EMF, over
  64 MB), there is no Ctrl+C. Never for a password field (UI Automation `IsPassword`, `ES_PASSWORD` /
  `EM_GETPASSWORDCHAR` on Edit-based controls, checked again just before the copy), Sara's other
  windows (approval cards, the badge), or a window hidden from her hands' rules (`sarascreen::hiddenKindOf`: password managers,
  banking, security settings, the person's own list). Key-shaped text is masked; at most 8,000
  characters. The page shows a chip `From Notepad: “…”` with ✕; on Send the question carries it as
  `Selected in Notepad:` and a fenced block. The log says the app, the length and how it was read,
  never the text. Tray: *Quick ask includes selected text* (`quickAskSelection`, on); `quickAskCopy=0`
  in `desktop.ini` keeps it to UI Automation only. 3.5.1: with Sara's own main window in front, the
  text selected in her page (or in its message box, never a password field) is read with
  `ExecuteScript` (400 ms limit), masked and capped the same way, and shown as `From Sara: “…”`.
  When it looked and nothing was selected, the page says `Nothing selected in Notepad` in a muted
  line (context `looked: true`). Note: an app that copies (the fallback) may show the
  selection in Windows' clipboard history (Win+V).
- **This window:** the picture button (shown when another app was in front) sends `{a:'window'}`; the
  app takes one picture of that window with hands-screen's `shot()` (PrintWindow, hidden windows
  blacked out, password fields boxed, 1600 px) and hands it to `saraQuick.picture({data, w, h})`. One
  removable thumbnail chip; it goes as a normal photo (`images`) with the question. No second shortcut.
- **Push-to-talk:** the talk shortcut still taps as before (stops after a pause or a second press).
  Held longer than 350 ms (`pttTick`, `GetAsyncKeyState`) the page gets `saraQuick.hold()` (no stop on
  a pause, up to 2 minutes), letting go `saraQuick.release()` sends it to `/api/wake/turn`, Esc
  `saraQuick.cancelTalk()` throws it away (nothing is sent).
- **Spoken replies in the app:** her voice turns already play in the quick-ask web view, which lives in
  the app (not the main window). *Speak her replies* in the tray (`speakReplies`, off) also speaks typed
  quick-ask answers through `/api/voice/speak`, only when her voice is on, not in private local mode
  unless the voice is on this computer, and not in quiet hours (`/api/wake/config` `paused:'quiet'`).
  Clicking elsewhere hides quick ask softly (`saraQuick.hidden({soft:true})`): the turn and her voice go
  on; Esc / ✕ stop them. The quick-ask page's CSP now allows `media-src blob:` (before, her spoken
  pieces there were blocked).
- **The pill:** `SaraVoicePill`, a no-activate topmost window above the notification area, shows
  *Listening…* / *Listening · let go to send* / *Thinking…* / *Speaking · click to stop* while her voice
  state is active and quick ask isn't in front. A click stops her speaking (or shows quick ask).
- **Mac:** not done yet. The page part is shared and degrades cleanly (no context → no chips, no picture
  button). Cheap next steps: `AXUIElementCopyAttributeValue(kAXSelectedTextAttribute)` on the focused
  element (needs the Accessibility permission; no pasteboard fallback without it), `CGWindowListCreateImage`
  / ScreenCaptureKit for the window (Screen Recording permission), and Carbon's `kEventHotKeyReleased`
  for push-to-talk; pass `context` in `saraQuick.show` and answer `{a:'window'}` like Windows.
- **Checked on Windows 11 (test build, throwaway server with a fake model and fake speech API):** text
  selected in Notepad became the chip through UI Automation; with `SARA_QA_FORCE_COPY=1` (test builds
  only) the Ctrl+C path read it and the clipboard (text, a bitmap and a private format) came back
  unchanged; a WinForms password box was skipped on both paths; Sara's own window was skipped; the
  window picture arrived (1107×1018) and the server stored the question with the selection and the
  photo; push-to-talk held 3 s went through transcription, her reply and her voice with the pill
  showing; Esc while holding sent nothing; *Speak her replies* off / on spoke 0 / 1 times. The fake
  microphone was `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>` in
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`.

## Notifications and files (2.7)

- **Notifications:** Windows toasts (app ID `BackstageCoding.Sara`, set on the Start-menu shortcut by the
  installer and the app) and Mac `UNUserNotificationCenter`. Approvals waiting show the command with Allow /
  Deny / Open in Sara; reminders have Done / Snooze 10 min. Allow / Deny call the same approval route as the
  chat card, and only for an approval this app showed, on the server in use, that is still waiting; anything
  else just opens the conversation. Off on the demo, when signed out, with notifications switched off, and
  while Sara's window or quick ask is in front. The page's own notifications go through the app
  (`SaraDesktop.notify`, WebView2 `NotificationReceived`), so nothing shows twice.
- **Files:** Explorer → Send to → Sara (made on first start, a tray switch removes it) and `Sara.exe <files>`
  (a second start hands the paths to the running app, at most 10 files); the Mac Dock icon (50 MB each).
  The app calls the page's `window.saraDesktopAttach(files)`, which puts them in the message box with the
  normal type and size checks; nothing is sent until the owner presses Send.
- **Quick ask voice:** records up to 2 minutes and uses the server's `/api/voice/transcribe`; the mic shows
  only when her hearing is set up.

## Drop files in, save her documents out

**Drop anywhere** (`web/drop.js`, `web/drop-files.js`, in the page, so the browser, the Windows app
and the Mac app all get it): dragging files, folders, pictures, text or a link over her window shows
a full-window "Drop to give these to Sara" with the limits (5 documents and 4 photos per message, the
Library's size limit per document; non-PDFs over 100 MB need to be PDFs). Folders give their files
(up to 20, a few levels deep, hidden files and folders left out; files she can't read are skipped
quietly). Text and links go into the message box at the cursor. Nothing is ever sent by a drop. Her
own drags (a conversation onto a project, a document card) don't open the overlay. The limits come
from `GET /api/library/settings` (`maxBytes`, `maxOtherBytes`; members see theirs).

**Quick ask** (Windows): files dropped on it go to the main window's message box like Send To
(`chrome.webview.postMessageWithAdditionalObjects` → the app reads the paths → the same route as
`Sara.exe <files>`). A folder from Send To, `Sara.exe <folder>` or the quick ask gives its top-level
files (up to 10). Mac: the quick ask says to drop them on her main window (WKWebView can't hand
dropped files to the app); drops on the main window work there as in a browser.

**Save to my PC** (Windows app, `desktop/windows/src/save-files.cpp`): on document cards, files she
shared and the Library's document page, "Save to…" opens the Windows Save window (in the folder used
last, else Documents) and "Save to Downloads" saves straight there (a name that's taken becomes
`Report (2).docx`); then Open and Show in folder. Settings → This computer → "Put her documents in a
folder automatically" (off by default; Choose folder…, Documents\Sara at first) saves each new
document she makes in the live chat (not on reload) and shows "Saved Report.docx to Documents\Sara".
How: the page calls `SaraDesktop.call('saveFile', {url, name, mode})` with one of her own file
addresses (`/api/library/made/<n>/file`, `/api/library/<n>/file`, `/api/files/<id>`; nothing else);
the app starts that download in the page (so the page's own sign-in applies and the server's
household rules decide: members only get their own) and WebView2's `DownloadStarting` writes it to
the chosen path with no download bubble. The page gets back only the file name, a two-part folder
label and a token for `saveOpen`; full paths never leave the app. Prefs in desktop.ini:
`saveLastDir`, `docsAutoOn`, `docsAutoDir`. Test runs save into their own data folder
(`Downloads`, `Documents\Sara` there). Older apps don't send `saveFiles` in `getPrefs`, so the page
shows only the Download links, as in a browser.

**Mac:** Save to… / Downloads / the automatic folder are not in the Mac app yet (its cards keep
Download, which WKWebView saves to Downloads).

**Drag out:** a document card carries Chromium's `DownloadURL`, so in Chrome and Edge it can be
dragged to a folder. In the Windows app this was not verified on a real desktop drag (WebView2 may
not support `DownloadURL` drags); use Save to… there.

**Testing:** `test/desktop-drop.test.ts`. A real run on Windows: a throwaway server and an
OpenAI-compatible fake model that calls `make_document`, the test build (`-DSARA_TEST_HOOKS=ON`,
`SARA_DESKTOP_TEST_DIR`, `--portable`) with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…`,
and CDP's `Input.dispatchDragEvent` with real file paths for the drops.

## Linux hands (CU8 implementation draft)

On the Linux computer you want Sara to use, install Chrome or Chromium and keep a visible terminal
open in your own desktop session. Use the installed Node 24; do **not** use sudo:

```sh
sara hands --server https://sara.example.com
# From a source checkout with Node 24:
node desktop/linux/cli.ts --server https://sara.example.com
```

Confirm browser use locally, then enter the displayed code at `/device` on your Sara server in your
normal browser. That signed-in page names computer control explicitly and asks for fresh owner-token,
two-step or passkey confirmation. It issues a separate revocable `hands` token; no owner token is
stored on the computer. Settings → Devices can revoke it. HTTPS is required except for loopback.

This draft implements **browser mode** and optional **read-only check-ups**, not Linux desktop pictures
or input. The browser is visible, uses CDP over a pipe and its own per-server profile below
`$XDG_DATA_HOME/sara-hands/` (default `~/.local/share/sara-hands/`). It never uses your normal browser
profile. Downloads/uploads stay in that server profile's `Downloads/Sara` folder. The browser's own
password saving and autofill are disabled; sign in yourself and keep the site's session cookies, or
explicitly save a login for Sara. `SARA_HANDS_BROWSER` can select another local Chrome/Chromium binary.

Keep the terminal visible: it is the local activity indicator and consent surface. Type `pause`,
`resume`, `continue` or `stop`; Ctrl+C stops, closes the browser and disconnects. Stop stays stopped
until you run the command again. Browser-page owner input pauses subsequent actions; browser chrome,
other applications and global hotkeys are not monitored. Do not rely on this draft for unattended
work or whole-desktop takeover protection. Matching of Sara's injected browser events is session-
and event-specific with a one-second expiry; indistinguishable simultaneous input remains a limitation.

The hands token and saved logins prefer the Linux Secret Service (GNOME Keyring/KWallet) over D-Bus.
Unlock your default keyring before starting. If it is unavailable, Sara warns and uses an
**unencrypted 0600 file inside a 0700 user-owned folder**. This fallback protects against other users,
not disk access or someone using your account. Save consent says so, requires you to type
`I understand`, and hides username/password entry. Secrets are filled locally on exact matching
origins and are never returned through the hands channel. Terminal consent replaces the native
checkbox window on Linux. Renewed tokens are persisted; a storage failure stops the connector.
A `running.lock` prevents two connectors sharing a profile. After an abnormal termination, verify no
connector/browser is running before removing that profile's stale lock file.

Optional local flags:

```sh
sara hands --server https://sara.example.com --checks --local-only
sara hands --server https://sara.example.com --manager bitwarden
sara hands --server https://sara.example.com --manager 1password
sara hands --server https://sara.example.com --manager keepassxc --keepass-db /path/to/logins.kdbx
```

Each manager remains off unless explicitly requested and confirmed locally, and must have its CLI
installed. You unlock it in its own CLI prompt in this terminal; secrets are captured locally, never
printed or sent to Sara. No manager is unlocked by detection. Existing idle, Stop, disconnect and
turn-end relocking rules apply. Manager desktop-app/extension integration and TOTP filling are not
implemented. Live unlock/fill with real Linux managers still requires owner testing.

`--checks` asks for separate local consent to read autostart `.desktop` files (user entries override
machine entries), Home filesystem free space, bounded known-folder/cache/Trash sizes, battery sysfs,
installed Chromium-family extensions, and `apt list --upgradable` from the **existing local cache**.
No cache refresh, update install, startup change, cleanup or uninstall runs. Other package managers
report updates unavailable. Extensions are listed as installed; enabled state is not independently
verified. Localized/custom XDG user-folder paths are not discovered in this draft.

Before considering Linux release acceptance, try a real Ubuntu desktop on **both X11 and Wayland**:
code pairing, keyring and fallback permissions, visible profile, approvals, masked pictures, manual
sign-in/save/fill/removal, local pause/continue/Stop and each installed manager's own unlock prompt.
The headless AlmaLinux conformance run does not establish those desktop results.
