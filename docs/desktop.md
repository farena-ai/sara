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
  are accepted only from the owner's own server.
- Windows: dark title bar (DWM immersive dark mode), optional Mica, WebView2 non-client regions for CSS
  `app-region: drag`, native caption buttons with snap layouts. Falls back to the normal title bar on
  Windows 10 or a WebView2 runtime older than 123. Mac: full-size content view, transparent title bar,
  traffic lights inset; WebKit has no `app-region`, so a press on the strip calls `performDrag`.
- Test in a browser with `?shell=windows&titlebar=32` or `?shell=mac` (stand-in window buttons).

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
