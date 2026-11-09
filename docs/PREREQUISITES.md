# Programs add-ons need

Some add-ons need a program on the computer where Sara runs: the Playwright and Chrome DevTools
tool servers need **Google Chrome**, MarkItDown and Qdrant need **uv**, GitHub's tool server needs
**Docker**, the npm-based ones need **Node.js**, Blender's needs **Blender** (and uv). Sara shows what
is missing and can install it for you with this system's normal installer.

## Where you see it

- **On the tool server's card** (Settings → Add-ons → Get more → an item → Get): *It needs: node
  (found) · Google Chrome (not found)* with **Install it for me** next to anything missing.
- **Settings → Add-ons → Other programs (MCP) → Programs add-ons need**: every program Sara knows,
  found or not (with its version), and the same button.

## What happens when you press Install it for me

1. **A card with the exact commands**, before anything runs: where the program comes from (for
   example *winget, Microsoft's package manager: package Google.Chrome*), each command line, each
   download with its checksum, and whether Windows may ask you to allow it (a User Account Control
   prompt) or the command runs with `sudo`.
2. **Install**: the progress shows the step, the installer's last lines and **Stop** (it ends the
   installer at once). After 20 minutes it is stopped on its own.
3. **The check**: Sara looks for the program again. On the tool server's card, the needs line then
   says *found* and the button reads **Continue install**.

| Computer | How Sara installs |
|---|---|
| Windows | `winget install --id <package> --exact --source winget` (Google.Chrome, astral-sh.uv, OpenJS.NodeJS.LTS, Python.Python.3.12, BlenderFoundation.Blender, Gyan.FFmpeg) |
| macOS | Homebrew, if it is installed (`brew install uv`, `brew install --cask google-chrome`, …) |
| Linux | The system's package manager (apt, dnf/yum, zypper, pacman); Chrome from Google's own repository; uv and Node.js from the vendor's official archive, checked against a pinned sha256 |

Sara never pipes a downloaded script into a shell, and only ever runs commands from its own list:
nothing you type and nothing from a web page becomes part of a command.

## When Sara can't install it

The card then says why and shows the steps to do it yourself, with a link to the vendor's page:

- **Docker on Windows and macOS**: install Docker Desktop yourself (it needs its licence accepted and
  often a restart), start it, then press **Check again**.
- **Linux without administrator rights**: if Sara runs as an ordinary user and `sudo` would ask for a
  password, Sara shows the exact commands to run in a terminal. uv and Node.js can still go into your
  own `~/.local` folder; tool servers in the Linux sandbox may not see programs there.
- **No winget, no Homebrew, an unsupported system or processor**: the vendor's page.
- **Blender**: after Blender is installed, its add-on is switched on inside Blender (Edit →
  Preferences → Add-ons → Install from disk, then Connect in its side panel).

## Who can do this

Only the owner, in the web app. Household members, the demo and apps signed in with a device code
can't. **Program installs** (on the same page) is *Ask first* (default: the card, then Install),
*Allowed* (one click starts it; you still see every command) or *Off*. An admin can pin it to *Ask
first* or *Off* for the whole server (Household → Policy → Program installs, see
[AUDIT_AND_POLICY.md](AUDIT_AND_POLICY.md)). Every install, refusal, stop or failure is one row in
the audit trail (`prereq.install`: the program, the method and the outcome).

**Private local mode** is on? Installing needs the internet: the card says so and Sara won't run it
until you turn *Nothing leaves this computer* off for the install (then turn it on again).
