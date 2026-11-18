# Check her edits, and attach with @ (2.53.0)

Two things that make Sara more precise when you code together.

## Check her edits

After Sara changes a file, **your project's own** type checker or linter looks at it, and she reads
the errors in the same reply, before she tells you she's done.

- **Which checkers.** Only tools your project already has, found from its files: `tsc` (a
  `tsconfig.json` and `node_modules/typescript`), `pyright` or `mypy` (their config and the project's
  own install; pyright wins when both are set up), `cargo check --offline` (`Cargo.toml` and `cargo` on
  the PATH), `go vet` (`go.mod` and `go`), and `eslint` (an ESLint config and `node_modules/eslint`).
  Sara never runs `npx`, `pip`, `cargo install` or `go install`, and never installs a missing checker:
  Settings shows the install command as text to copy.
- **The OK per project.** The first time she changes a file in a project, nothing runs: a card asks
  *Check her edits here*, *Not now* (asked again another day) or *Never in this project*. The card
  names the exact command and says which checkers run code from your project (an ESLint config, mypy
  plugins, Rust build scripts). On Windows it says they run directly on this computer (no sandbox).
- **What she reads.** Only new errors in the files she changed are written out (≤ 20), the rest is a
  count; an error her change caused in another file (a renamed export) is named with its first line.
  The block is part of the tool result, so the run record and replays see it too.
- **Before she says "done".** If her own new errors are left, the app tells her once more (up to 2 times
  per reply, inside the reply's budget). Whatever is left is on the reply: *⚠ 2 type errors left*. A
  clean result shows *✓ types clean (tsc)*. Say "leave the errors, it's WIP" and she isn't reminded.
- **Bounded.** Her next step waits up to 20 s; a check is stopped after 60 s; output is capped at 400 kB;
  one check per step and per project; network off; no model call.
- **Off.** Settings → Abilities → **Check her edits** (the switch, the limits, and per project *On /
  Off / Ask*, a tick per checker, *Run now*, *Problems*). In Telegram or Discord: `/problems`,
  `/problems check`, `/problems off`, `/problems on`.
- **Goals.** *Types check* is a check you can pick for *Keep going until it's done*.
- **Not in this version.** Language servers (typescript-language-server, pyright-langserver, gopls,
  rust-analyzer) are not used: the project's own command runs instead.

## Attach with @

Type `@` in the message box and pick **A file**, **A folder**, **My changes**, **This branch**,
**Problems** or **A web page**. Or type them:

| You type | She gets |
|---|---|
| `@file:src/app.ts` · `@file:src/app.ts:40-60` · `@file:src/app.ts:42` | the file (numbered lines), those lines, or 5 lines around one |
| `@file:"docs/My notes.md":3-9` | a path with spaces, in quotes |
| `@folder:src` | the folder's file list (≤ 200) |
| `@diff` · `@diff:staged` | your uncommitted (or staged) changes |
| `@branch` · `@branch:feature/x` | the branch's commits and diff against the default branch |
| `@problem` · `@problem:src/a.ts` | the latest problems from the checks |
| `@url:https://…` | the page as text, through the same guard as her web tool |

- Read **once**, when you send. Chips under your message show what was attached; *What she got* shows
  the exact text. Older messages keep a one-line note instead of the whole text.
- **Safe by design:** only your own messages in your own chats and work rooms; only the chat's
  project folder (no `..`, no links out); never secrets (`.env`, keys, `.git/`, `.npmrc`…); every text is
  scrubbed of keys and fenced as information, not instructions. `@url` never runs in private chats or
  with private local mode on, and never reaches private network addresses.
- **Caps:** one reference ≤ 40,000 characters (ask for a range); all of a message's references ≤ half
  of her memory for the chat (the biggest are dropped first, with a note).
- **Chat apps:** type the same forms in Telegram, Discord, Signal or email. If one can't be attached,
  she says so in one line before her answer. `/help refs` lists them.


## Live checks you can run yourself: accounts and two linked servers (U1.2, U1.4)

Two scripts check, end to end, the parts of Sara that talk to the outside: your mail and calendar
accounts, and linked Sara servers. Each starts its own **throwaway** Sara in a temporary folder on a
free loopback port with a scripted stand-in model: never your running Sara, its data or your servers.
Each writes a plain report to `outputs/checks/` and exits with 1 when a step failed.

```
node scripts/check-accounts.ts     # outputs/checks/accounts-<date>.md
node scripts/check-pair.ts         # outputs/checks/pair-<date>.md
```

**Accounts** (`check-accounts.ts`). Through Sara's own pages (the same HTTP calls Settings makes) and
real chat turns, with every send and draft card answered like you would:

- Every mail kind: Gmail signed in with Google (two of them), app-password mailboxes (IMAP + SMTP,
  two), Outlook / Microsoft 365. For each: send an email to itself (the card must name the mailbox),
  find it with a search, read it, save a reply draft (nothing sent).
- Re-adding the same address (no duplicate), a wrong password refused in plain words, switching the
  default mailbox, the combined inbox (one search covers every mailbox in it; leaving one out narrows
  it), removing one Gmail and the default mailbox (choices and passwords go too).
- Every calendar kind in one read: Google (both accounts), Outlook, CalDAV on an app-password mailbox,
  a calendar link (`webcal://`); a new event asks which calendar, then goes to the default one at the
  time you asked; a Gmail app password can't open Google Calendar and says so.
- Nothing secret in any page answer.

Always run against stand-ins on this computer (a test IMAP/SMTP server, a fake Google, a fake
Microsoft Graph, a fake CalDAV server and calendar link). **Your real test accounts** are used only
when you make `.secrets/test-accounts.json` in the Sara folder (it is never committed). Use
throwaway test accounts, not your everyday ones. Every part is optional; what is missing is listed as
skipped:

```json
{
  "gmail": [{ "address": "test1@gmail.com", "appPassword": "…" }, { "address": "test2@gmail.com", "appPassword": "…" }],
  "outlook": { "address": "test@outlook.com", "password": "…" },
  "imap": { "address": "test@fastmail.com", "password": "…", "imapHost": "imap.fastmail.com", "smtpHost": "smtp.fastmail.com", "preset": "fastmail" },
  "caldav": { "url": "https://caldav.fastmail.com/dav/" },
  "icalLink": { "url": "webcal://…/basic.ics" },
  "google": { "clientId": "…", "clientSecret": "…", "refreshToken": "…", "address": "test1@gmail.com" }
}
```

The real run is a second process without the stand-ins. It only ever sends to the same test
address, removes every account it added at the end, and never prints or writes a password, token or
calendar address (they show as •••).

**Two linked servers** (`check-pair.ts`). Two throwaway servers, Hank (helped) and Sam (helper), each
with its own folder and port, linked and checked through their real HTTP APIs and the signed calls
between them: link code → link (a used code fails), messages both ways with the notice on the other
side, unread and read, popups off; a community (create, invite, a quiet post, an @mention notice, a
reply, kick and rejoin, ban and no rejoin); retention (a chat kept 1 day loses old messages, the
30-day one keeps them); a help pass (grant, look, propose, approve, revoke); a fix pass (request,
accept, look, a plan approved step by step, undo, a plan approved once and stopped mid-way); unlink
(the other side's chat ends, sending and fix passes are refused).

## Windows install and update matrix (U1.3)

A real run of Setup on a Windows PC, with **only the TestInstall build** (*Sara update test*, its own
AppId `8C1D7E52…`, folder `%LOCALAPPDATA%\Programs\SaraUpdTest`, data `%LOCALAPPDATA%\SaraUpdTest`). A real
Sara on the PC is never installed, changed or removed: its uninstall entries are read first and must be the
same after every step. Free and local: no CI, no hosted services.

1. Build two or three test installers (any versions; the newest is the update):
   `SARA_TEST_INSTALL=1 SARA_APP_VERSION=3.90.1 bash desktop/windows/build-installer.sh` (and 3.90.0, 3.90.2).
2. `node scripts/check-windows-install.ts` (options: `--setups <folder>`, `--report <file>`).

Per-user steps: fresh install (the app only, connected to a loopback test server) → the app updates itself
(a notice signed with a throwaway key, served on 127.0.0.1, installed while nobody uses it) → silent
reinstall of the same version → downgrade to the oldest build → a manual run of Setup with no switches
(must stay *app only, this user*) → a simulated stale `SaraDesktop` entry (only when the PC has none; the
test build must leave it alone, the release build's removal is a unit test) → uninstall `/KEEPDATA` →
reinstall over the kept data, then the full uninstall. After each step: exactly one uninstall entry
(HKCU + HKLM), the files (and no server files), the app starts hidden, the data where expected.

The all-users cases (the service, a per-user copy next to it removed on start, the all-users uninstall)
need an administrator. Without one the report lists them; run, in an administrator PowerShell,
`powershell -ExecutionPolicy Bypass -File scripts\check-windows-install-admin.ps1`. It refuses when a
`Sara` service, the `\Sara\Update` task, `C:\ProgramData\Sara` or a real install is on the PC (the test
build still uses those service and task names), uses its own data folder and port, and removes everything.

Reports: `outputs/checks/windows-<date>.md` and `outputs/checks/windows-admin-<date>.md` (Setup logs next to
them). Everything the run installed is removed at the end, also when a step fails.
