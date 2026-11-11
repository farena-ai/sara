# PC tools: running things on the owner's own computer (one page)

Status: built for the Windows app and the server (3.5, unreleased); the Mac app has no `c.run` yet.
Tests: `test/pc-run.test.ts`. A real run on Windows (a throwaway server, a scripted model, the test
build of the app with its own data and WebView2 folder) ran `Get-ChildItem $env:TEMP | Select -First 3`
after *Allow once* on the PC's card (exit 0, 0.8 s), then `Start-Sleep 30`, stopped after 3 s from the
web Stop: the turn ended in 8 s and its PowerShell was gone.

Her server may be remote (a VPS, a NAS, a Pi). The Sara app on the owner's PC is already connected
to it over the hands WebSocket (computer use, [COMPUTER_USE.md](COMPUTER_USE.md)). PC tools let her
run a few things **on that PC**, as the owner, only when the owner switched it on there and said
yes there.

## What she can run

| Tool | What it does | Op |
|---|---|---|
| `pc_run` | One PowerShell (default) or cmd command on the PC: `command`, `shell` (`powershell` / `cmd`), `cwd` (a full folder path on the PC; default the user's home), `timeout` (5–600 s, default 60). Output (stdout + stderr) streams live to the chat card; at most 64 KB comes back (head + tail when longer). Exit code, seconds, and *stopped / timed out* are reported. | `c.run` |
| `pc_open` | Open one thing with its default app: a URL (`http`/`https`/`mailto`), a file or folder by full path, or an installed app by name (Start-menu shortcuts, the same list as `pc_open_app`). No arguments, no command lines. | `c.open` |

Later (not in this build): Office/Outlook through their own automation (COM) — useful but each app is
its own surface; for now `pc_run` with PowerShell covers simple cases the owner approves. Mac: the
app has no `c.run`/`c.open` yet (`Process` / `NSWorkspace` is cheap, but the approval panel and the
kill-tree story need their own pass); the tools say so plainly.

**This PC's Ollama / LM Studio for a remote server.** Already covered: Settings → Models → Model
providers → *Ollama on my computer* pointed at the PC over Tailscale (or the home network); see
[CHOOSING_A_MODEL.md](../CHOOSING_A_MODEL.md) and [AWAY_FROM_HOME.md](../AWAY_FROM_HOME.md). LM Studio
works the same way with the OpenAI-compatible template (`http://<pc>:1234/v1`). Tunneling model
traffic through the app's hands socket is not built: it would add a second, always-on path for
prompts through a channel designed for short, supervised ops. Docs only.

## Safety model

- **Off by default.** A third switch in the app, Settings → Computer use: **Let her run commands on
  this computer** (needs *Let Sara use this computer*). The hello says `optIn.run`; the server and the
  app both refuse `c.run`/`c.open` while it is off.
- **Every command is shown on the PC** in the app's own topmost card (the full command, the shell,
  the folder): **Allow once / Allow for this task / Don't**. Closing it is Don't. Same policy choices
  as desktop actions (*Ask every time* / *Once per task* (default) / *Always allowed*, the last with a
  warning box). The server can make it stricter (`approvalLevel: 'ask'`), never looser.
- **Destructive-looking commands always ask** (delete/remove, format, registry edits, shutdown,
  `Set-ExecutionPolicy`, downloads piped to a shell…), even with a task grant or *Always*.
- **A phone can't approve.** No broker card is made on the server; the answer exists only on the PC.
  A device without its own approval surface (`approvalsHere`) gets nothing to run.
- **Read-only allowlist, opt-in.** Only if the owner ticks *Simple read-only commands without asking*:
  `Get-ChildItem`/`dir`/`ls`, `Get-Content`/`type`/`cat` (no redirects), `Get-Location`/`pwd`,
  `Get-Date`, `whoami`, `hostname`, `Get-Process`, `git status|log|diff|branch`. One command, no `;`,
  `|` to anything but `Select-Object`/`Format-*`/`Sort-Object`/`Measure-Object`, no `>`, no `&`, no
  subexpressions. Everything else asks.
- **Never elevated.** Runs as the signed-in user with the app's token; if the app itself is running
  as administrator, `c.run` refuses. No `runas`, no `Start-Process -Verb RunAs` (refused).
- **Stop kills the whole process tree** (a Job object with kill-on-close): Ctrl+Alt+Esc, the badge's
  Stop, the chat card's Stop, the turn's Stop, the deadline. When the command ends, what it left
  running ends too (an app that should stay open is `pc_open`'s job).
- **Walk-away pauses.** While the PC is locked (the owner walked away) or paused (the owner took
  over), no new command starts (`takeover`); running ones keep their deadline and Stop still works.
  Walk-away's *keep awake* never approves anything: an approval still needs the owner at the PC.
- **Output is masked** on the PC before it leaves (the same key shapes as Files and desktop look:
  `sk-…`, `ghp_…`, AWS keys, Sara tokens, JWTs) and the server masks again.
- **Household members can't use the owner's PC**: each person's computers are in their own hands hub,
  and `pc_run`/`pc_open` are owner-space only (a member's companion never gets them).
- **Private chats are fine**: the command runs on the owner's own PC and its output goes to the
  model that chat already uses.
- **Audit log, both sides**: the PC's *What Sara did on this computer* log (command, folder, exit
  code, allowed/denied; 30 days) and the server's audit trail (`pc_run` with the command, the
  computer, the outcome).

## How it reaches the PC

The existing hands WebSocket, two new ops (protocol stays v1; ops are listed in the hello):

```
server → device  {t:'req', id, op:'c.run', args:{command, shell, cwd, timeoutMs, task, approvalLevel?}, deadlineMs}
device → server  {t:'ev', kind:'run', id, state:'asking'|'running', chunk?}   (live output, ≤ 4 KB each, masked)
device → server  {t:'res', id, ok:true, result:{exitCode, output, truncated, seconds, timedOut, stopped}}
server → device  {t:'req', id, op:'c.open', args:{target, kind:'url'|'path'|'app', task}}
                 → {opened:true}
```

`c.run` is a waiting op (up to 10 minutes: the approval plus the command). `{t:'cancel', id}` or
`{t:'cancel', all:true}` ends it (the tree is killed). **Older apps** don't list `c.run`: the tools
say *update the Sara app on <computer> to <version> or later* and nothing is sent.
