# Sara in your terminal and in VS Code

Two small clients talk to your own Sara server with the same API as the web app, so it is the
same companion: same memory, same personality, same conversations. Both sign in with a **device
code** (no owner token typed anywhere) and are listed under **Settings → Data & health → Devices
and sign-in**, where signing one out ends it.

## How device sign-in works

1. The app asks the server for a code (`POST /api/device/start` with the app's name). It shows
   the code (like `K7QM-3XTP`) and where to approve it (Settings, or the `/device` page).
2. You approve it, either in **Settings → Data & health → Devices and sign-in** ("Apps asking to
   sign in") or on the `/device` page in a browser where you're signed in. The page names the app;
   nothing happens until you press **Approve**. In 1.0 you type the code yourself (it isn't taken
   from the link, so a link someone sends you can't approve their app) and confirm it's you with
   your owner token, a two-step code or a passkey.
3. The app's next poll (`POST /api/device/poll`) gets its own device token, once. Codes last 10
   minutes and live only in the server's memory.

Device tokens look like `sara_dev.<id>.<secret>`; the server keeps only a hash. They work with
two-step sign-in on (you approved them while signed in), stop after 30 days without use (and, in
1.0, after 90 days at most), and an app can't approve another app or change devices and sign-in
settings (that needs you in the web app). The clients send the token only to the server it was
issued for.

## Terminal: `sara-chat`

The server's admin command on Linux, Windows and macOS installs is already called `sara`
(`sara status`, `sara update`…), so the client is **`sara-chat`**. It needs Node.js 24 or newer
and nothing else.

### Install

From a copy of this repository:

```sh
# any system with npm: puts sara-chat on your PATH
npm install -g ./clients/cli
# or without npm: run it directly
node clients/cli/sara.ts --help
# or put clients/cli/bin on your PATH (sara-chat for Linux/Mac, sara-chat.cmd for Windows)
```

### Use

```sh
sara-chat login https://sara.example.com    # shows a code to approve
sara-chat                                   # chat in her latest conversation
sara-chat --new                             # chat in a new one
sara-chat ask "How do I run the tests?" --dir .
sara-chat send notes.pdf                    # share it in the chat (she reads it for this chat)
sara-chat send manual.pdf --library         # keep it in her library
sara-chat approve                           # answer approvals she's waiting for
sara-chat status
sara-chat logout
sara-chat acp                               # Sara as your editor's coding agent (Zed, JetBrains): see EDITORS.md
```

- Her reply streams as she writes it. **Ctrl+C** while she replies stops her reply (what she
  wrote so far is kept); at the prompt it leaves. `/new` starts a new conversation, `/quit` leaves.
- When she needs your OK (running a command, writing a file, if those are set to *Ask*), the
  question shows inline: `Allow it? [y/N]`. Without a terminal to ask, nothing is allowed.
- `ask --dir <folder>` sends a short overview: the list of files (up to 250 entries, 4 levels)
  and the README (up to 6,000 characters). It never sends `.env` files, keys, certificates,
  credential or password files, `.git`, `node_modules` or build folders, and says on the screen
  what it sent. The question goes into a new coding conversation (add `--continue` to use the last
  one; `sara-chat --help` doesn't list `--continue` yet, but it works).
- The first time, if the AI disclosure hasn't been accepted yet, it is shown and you're asked to
  agree, as in the web app.
- Colors only on a terminal (`--no-color` or `NO_COLOR=1` turns them off). Works in Windows
  Terminal, PowerShell and cmd.

The token is saved in `config.json` in your user's config folder, readable by you only:
`%APPDATA%\sara-chat` on Windows, `~/Library/Application Support/sara-chat` on a Mac,
`~/.config/sara-chat` on Linux (`SARA_CHAT_CONFIG_DIR` overrides it).

### Several servers (Phase 68)

`config.json` holds a list of servers, each with its own device token; one is in use.
`sara-chat servers add <address> [--name Work]` signs in to another one, `sara-chat servers`
lists them, `servers use <name>` switches (no sign-out), `servers rename` and `servers remove`
(signs out of that one only). `--server <name>` (name, id, address or host:port) uses another
saved server for one command; it never sends a saved token to an address it wasn't issued by.
`logout` signs out of the server in use. A config from before 1.8 becomes the first server with
nothing to do. With several servers, `ask --dir` and `send` say which server they send to. More:
[SERVERS.md](SERVERS.md).

## VS Code extension

`clients/vscode/` is a VS Code extension in plain JavaScript (no packages, no build step). Build
the installable file with:

```sh
node scripts/pack-vscode.ts            # → outputs/vscode/sara-vscode-<version>.vsix
code --install-extension outputs/vscode/sara-vscode-<version>.vsix
```

- **Sara: Sign in** asks for your server's address and shows the code (with a button that opens
  the approval page). The token is kept in VS Code's secret storage. **Sara: Sign out of this
  server** removes it.
- Phase 68: **Sara: Add a server** and **Sara: Switch server** (also the status-bar item, which
  names the server in use and says that Sara on it can use the files you send). Each server keeps
  its own token (all in VS Code's secret storage) and each workspace its own conversation per
  server; the sign-in from before 1.8 becomes the first server. [SERVERS.md](SERVERS.md).
- The **Sara** icon in the activity bar opens the chat panel. Approvals show there with Allow /
  Decline; **Stop** stops her reply.
- **Sara: Ask about selection** and **Sara: Explain this file** (also in the editor's right-click
  menu) send the file's name relative to the workspace, its language, the line numbers and the
  code, cut at `sara.maxContextChars` (12,000 characters by default). The panel shows exactly what
  was sent under "Sent with it". Files that look like secrets are never sent.
- **Sara: Send file to her library** (Explorer right-click, or the open file).
- Each VS Code workspace keeps its own conversation (a coding conversation); **New conversation**
  starts another.
- The panel's page has a strict Content-Security-Policy (`default-src 'none'`, only the
  extension's own script with a nonce and its own stylesheet, no network): the extension talks to
  the server, the page only shows what it's given.

The extension isn't published to any marketplace; install it from the `.vsix`.

The clients have their own version numbers (the `version` in `clients/cli/package.json` and
`clients/vscode/package.json`), separate from the server's, so `sara-chat --help` can show a
lower number than your server (Settings → Data & health → Updates shows the server's).

## Usage and budgets from the clients

Every message from the clients is a normal turn, so it's counted by the token meter like any
other (Settings → Data & health → Usage and costs, and the line under each conversation).
