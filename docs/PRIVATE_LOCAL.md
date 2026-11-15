# Nothing leaves this computer (private local mode)

Sara can run entirely on one computer: her server, her model and everything she knows. With the
switch **Nothing leaves this computer** on, she doesn't connect to anything except that computer.
This page says what the switch guarantees, how it's enforced, and what it can't promise.

Where: **Settings → Models & usage → On this computer**. The same page helps you get a model that runs
there. While the switch is on, a **🔒 Only this computer** badge sits in the top bar.

## A model on this computer

Sara uses [Ollama](https://ollama.com/download), a free program that runs AI models on your own
computer.

- **Finding Ollama.** Sara looks for it at `http://127.0.0.1:11434` (its version and its models).
  If it isn't there, the page explains what it is and links to the official download. Sara never
  downloads or installs programs by herself. On Windows there is also **Install Ollama with
  winget**, which runs `winget install Ollama.Ollama` only after you press it and confirm.
- **Looking at the computer.** An NVIDIA graphics card's name and memory (through `nvidia-smi`), a
  Mac's memory (through `sysctl`; Apple silicon shares it with the graphics), or the computer's
  memory when no graphics card is found. Nothing about it is sent anywhere.
- **A suggested model.** From the table in [CHOOSING_A_MODEL.md](CHOOSING_A_MODEL.md) (kept in code
  in `src/local-models.ts` and checked by a test):

  | Memory for the model | Suggested | Download |
  |---|---|---|
  | under 4 GB | `qwen3.5:2b` | about 2.7 GB |
  | 4-8 GB | `qwen3.5:4b` | about 3.4 GB |
  | 8-12 GB | `qwen3.5:9b` | about 6.6 GB |
  | 12-16 GB | `gemma4:12b` | about 7.7 GB |
  | 16-24 GB | `gpt-oss:20b` | about 14 GB |
  | 24 GB and more | `qwen3.8:27b` | about 18 GB |

  "Memory for the model" is the graphics card's memory; on a Mac with Apple silicon about 45% of
  its memory (so a 32 GB Mac gets a 12B model and a 64 GB Mac a 27B one, as in the guide); with no
  graphics card the model runs on the processor, so the suggestion stays small (`qwen3.5:2b`, or
  `qwen3.5:4b` with 16 GB of memory or more). You can pick any row.
- **Download this model** asks Ollama to download it (`/api/pull`) and shows the progress, with
  **Cancel** (Ollama keeps what it has, so pressing Download again carries on). When it's done,
  it becomes her model and the background model (memory notes, summaries), through a provider
  entry for this computer's Ollama marked as local. Models already on the computer have a **Use**
  button.

## What the switch guarantees

While it's on, **Sara's server only connects to this computer**: `127.0.0.0/8`, `::1` (and
`::ffff:127.x.y.z`) and the name `localhost`. Every other address fails with "Blocked by private
local mode" before anything is sent.

How it's enforced, in code:

- **One choke point.** Every outgoing request in the server goes through `src/net-guard.ts`:
  `netFetch` (HTTP), `openWebSocket` (WebSockets) and `checkOutbound` (called right before the few
  raw connections: the testing browser's proxy, web pages she reads, the DevTools connection and
  Apple's push service). While the mode is on, the global `fetch` is wrapped by the same check too.
- **Decided by the address, before any DNS lookup.** Only literal loopback hosts pass, so a name
  that resolves to a local address (or a DNS answer that changes) can't slip through. Ollama on
  another computer at home counts as "not this computer" too: run Ollama on the same computer, or
  turn the mode off to use the other one.
- **A local Ollama can't be used to reach out.** Requests that make the local Ollama go to the
  internet for Sara are blocked as well: downloading a model (`/api/pull`, `/api/push`), Ollama's
  web search, and any request naming an Ollama Cloud model (`…-cloud`, `…:cloud`).
- **A test keeps it that way.** `test/private-local.test.ts` scans `src/` and fails if any module
  calls `fetch`, opens a WebSocket or imports a raw socket outside the guard. The few allowed
  modules are listed in the test, each with its reason, and each must call the check (or, the
  preview proxy, only ever connect to `127.0.0.1`).

Turning it **on** needs a model on this computer (otherwise the page says how to get one). If
neither her default model nor the private-conversation model is on this computer, the first model
there becomes the private-conversation model, which every conversation then uses. Turning it
**off** asks first. The demo server can't change it. `SARA_PRIVATE_LOCAL=1` (on a server, or in the
desktop apps' settings file) keeps it on: it can't be turned off in the app. `SARA_PRIVATE_LOCAL=start`
turns it on until you turn it off; the desktop apps' first-run choice *Private: everything on this
computer* sets this.

## What is paused

The settings page lists these with what you have set up. All of them come back when you turn the
mode off.

| | While the mode is on |
|---|---|
| Cloud models and subscriptions (OpenAI, Anthropic, xAI, OpenRouter, Ollama Cloud, ChatGPT, Claude, Grok) | Refused. Picking one is refused; companions using one show *paused in private local mode*; a conversation uses the model on this computer |
| Web search and web pages (`web_search`, `web_fetch`) | Tools hidden and refused |
| Model list checks | Only lists on this computer are checked |
| Update checks | Refused (also the Linux updater's request) |
| Report a reply (⚑) | Kept here; sending it to the developer is refused |
| Telegram and Discord | Paused (bots stop until the mode is off) |
| Gmail and Google Calendar, GitHub (API and `git push`) | Refused |
| Notifications to phones and browsers (Web Push, Apple push) | Paused (nothing counted as failed, so no device is dropped) |
| Off-server backups (S3) | Refused. A backup folder on this computer still works |
| Pictures of her (Grok Imagine) | Refused |
| Cloud voices, hearing and live calls | Refused. Local voice (Linux) still works |
| Weather and travel times | Refused (the briefing has no weather) |
| Other programs (MCP) | Over HTTP: only on this computer. Programs started on this computer (stdio) still run, without network where the sandbox can enforce it |
| Home Assistant | Only on this computer (`http://127.0.0.1:8123`, `http://localhost:8123`) |
| Her commands (builds, tests, `npm install`, `git`) | No network (see below) |
| Testing browser | Only her own previews |

The mandatory safety layer is unchanged and works offline: the AI notice, the crisis resources
(written into Sara, nothing looked up) and the block on sexual content involving minors run in her
own code. The optional safety check uses the model you picked for it only if that model is on this
computer; otherwise it's skipped (it only ever adds protection).

## What it can't promise

- **Her commands on Windows.** On Linux (bubblewrap) and macOS (the system sandbox) her commands
  run with no network at all. Windows has no such sandbox for her commands: they get settings that
  tell programs not to use the network (`HTTP_PROXY`/`HTTPS_PROXY` to a dead local address,
  `GIT_ALLOW_PROTOCOL=file`, `npm_config_offline=true`, `PIP_NO_INDEX=1`), which git, npm, pip, curl
  and most programs follow, but a program that ignores them can still connect. The same goes for
  add-on programs (MCP over stdio) on Windows and on Linux without bubblewrap. Leave *Allow internet
  access for shell commands* off, and approve commands yourself, if that matters to you.
- **Other programs on the computer.** The switch covers Sara's server. Ollama itself, the operating
  system (updates, time, telemetry), your web browser, the desktop app's web view (WebView2 or WebKit
  may check for their own updates) and anything else you run are outside Sara. To be sure nothing
  leaves, use your firewall or disconnect the computer.
- **Coming in is still possible.** Phones and computers on your home network or Tailscale can still
  open Sara on this computer if you set her up that way (*How you'll reach her*): they connect in,
  Sara doesn't reach out. Tailscale itself talks to its own servers; choose *Just this computer* for
  none of that.
- **`localhost` is trusted as named.** The name `localhost` is allowed as written; the computer's
  hosts file decides where it points.
- **Downloads need the internet.** Downloading a model, installing Ollama and checking for updates
  are refused while the mode is on: turn it off for them, then on again.

See also: [PRIVACY.md](PRIVACY.md) (every connection Sara can make),
[CHOOSING_A_MODEL.md](CHOOSING_A_MODEL.md) and [desktop.md](desktop.md).
