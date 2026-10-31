<p align="center"><b>English</b> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português (Brasil)</a> · <a href="README.it.md">Italiano</a></p>

# Sara

**An AI companion with the personality you choose, who is also a real coding partner.**
She talks, remembers, plans your day and reads your books; she writes, runs and tests code in her own
sandboxed workspace. All on your own server, with the models you pick, in one app for the web,
Windows, Mac and phones.

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2024-339933" alt="Node 24 or newer">
  <img src="https://img.shields.io/badge/runtime%20dependencies-0-brightgreen" alt="Zero runtime dependencies">
  <img src="https://img.shields.io/badge/tests-1178%20passing-brightgreen" alt="1178 tests passing">
  <a href="docs/RESULTS.md"><img src="https://img.shields.io/badge/HumanEval%20pass%401-96.3%25-informational" alt="HumanEval pass@1 96.3%"></a>
  <a href="https://github.com/farena-ai/sara/releases/latest"><img src="https://img.shields.io/github/v/release/farena-ai/sara?label=release" alt="Latest release"></a>
  <a href="https://github.com/farena-ai/sara/pkgs/container/sara"><img src="https://img.shields.io/badge/docker-amd64%20%7C%20arm64-2496ED" alt="Docker image for amd64 and arm64"></a>
  <img src="https://img.shields.io/badge/languages-6-8A2BE2" alt="Six languages">
  <a href="https://glama.ai/mcp/servers/farena-ai/sara"><img src="https://glama.ai/mcp/servers/farena-ai/sara/badges/score.svg" alt="Sara MCP server on Glama"></a>
</p>

<p align="center">
  <img src="docs/screenshots/demo.png" alt="Animated demo: the user says it was a rough week; Sara answers warmly and suggests three tiny things to build; she writes a module and its test, asks before running a command, finds a real bug through a failing test, fixes it and gets all 7 tests green" width="860">
  <br>
  <sub>A real session on a local model (qwen3.8 27B on Ollama, one RTX 5090) on a throwaway test server, in the Night look: she cheers the user up, writes a small app and its test as the model streams them, asks before running a command, catches a real bug with a failing test and fixes it until all 7 tests pass. Frames picked from the recording; nothing in them was edited.</sub>
</p>

> **Status:** 2.25, MIT licensed, with thirty-six feature releases since 1.0 (all below). 2.5 to 2.8
> gave the whole app a new look. The [Android app](https://play.google.com/store/apps/details?id=com.backstagecoding.sara)
> is on Google Play; the iPhone app and the Mac App Store version are coming as soon as Apple approves them.
> Read [docs/DISCLOSURES.md](docs/DISCLOSURES.md) before using or sharing Sara.

## Why Sara

- **A personality you set, and keep.** Name her anything, pick she/he/they, start from a ready-made
  character or turn simple dials (playful, blunt, brief, curious…). She keeps it: moods that change
  with how things go, her own day, running jokes, and memories of what you told her that you can see,
  correct and forget.
- **A real coding harness.** A sandboxed workspace per project with files, shell and git, background
  jobs, live previews she tests in her own browser, a team of helpers (plan → build → test → review),
  her OK-first rule for risky steps, and a check that what she *says* she did matches what actually ran.
- **A beautiful app on every device.** A calm Night look (Day if you prefer) with her presence beside
  every chat, a line under each reply showing what she did, and results as cards. On the web and as an
  installable app, in the Windows and Mac apps (with *quick ask* on a shortcut over any app), on
  Android, and on iPhone (the app is waiting on Apple; the home-screen web app works today).
- **Private and yours.** One owner per server; chats, memories and keys stay there. Any model: local
  (Ollama, vLLM, llama.cpp), cloud (OpenAI, Anthropic, xAI, OpenRouter) or the plans you already pay
  for (ChatGPT, Claude Pro/Max, SuperGrok / X Premium+). One switch keeps everything on one computer.
  Ships with **no credentials of any kind**.
- **Small and readable.** TypeScript that Node runs directly: no build step, zero runtime
  dependencies, built from the ground up (not based on Hermes Agent or OpenClaw). Easy to
  [extend](docs/EXTENDING.md).

**Also in the box:** [quick ask](docs/desktop.md) on a global shortcut · her [presence panel](#her-presence) ·
[Today as tiles](#today) · Ctrl+K [command bar](#command-bar) · [household mode](docs/HOUSEHOLD.md) for the
people you live with · [video calls](docs/VIDEO_CALLS.md) with her moving portrait ·
[Alexa, Google Home and Android assistant](docs/VOICE_ASSISTANTS.md) · your other servers
[over SSH](docs/SSH.md) · [1,000-page books](docs/LIBRARY.md) with answers that cite the page ·
[private local mode](docs/PRIVATE_LOCAL.md) · [group chats](docs/GROUP_CHATS.md) ·
[moving in from ChatGPT, Character.AI, Replika and others](docs/IMPORT.md).

## What's new

| Release | What you get |
|---|---|
| **2.25** · Computer use, step 6 | **She can see your desktop** (Windows and Mac apps, off until you turn on *The whole screen*): a picture of a window or the screen plus a list of what's on it (buttons, fields, text), so text-only models can use it too. Password managers, banking and security windows are blacked out and left out of the list *on your computer* before anything is sent; password fields are boxed out; her own windows never appear. Pictures go to the model you chose without asking (or *local models only*). In the browser: **Show Sara my screen** sends one picture. The Mac needs Screen Recording and Accessibility, with guided steps. |
| **2.24** · Computer use, step 5 | **Your password manager fills logins in her browser:** Bitwarden, 1Password or KeePassXC, each off until you turn it on. You unlock it yourself in the manager's own prompt (she never sees your master password); every use asks first; it fills only on the exact site the login is for; she locks it again after the task, after 15 idle minutes, on Stop or with *Lock now*. Nothing reaches Sara's server or the model. Her browser no longer offers to save passwords itself. |
| **2.23** · Computer use, step 4 | **Saved logins, only when you say so:** she offers, and a window on *your computer* asks you to type the login and tick *I understand* (or *Use what I just typed*). It's encrypted there (Windows DPAPI / macOS Keychain), never on Sara's server, and she never sees it: she can only ask that computer to fill it in, on exactly that site (look-alike sites get nothing), and every use asks first. Optional Windows Hello / Touch ID. **Your turn:** she pauses while you sign in or type a code yourself. |
| **2.22** · Computer use, step 3 | **She debugs your web project in her browser:** the dev server her coding tools started on your Sara server opens at `127.0.0.1` in her browser on your computer, through the app (only a port her own job opened; it ends when the job stops), with hot reload and local storage working. After a change she opens the app, reads the console, looks, fixes and checks again. Browser evals: 5/5 tasks with a local model. Also: the test suite now passes on macOS, and two network privacy fixes. |
| **2.21** · Computer use, step 2 | **She can act in her own browser:** click, type, pick from lists, scroll, press keys and upload a file you name, with a visible cursor. You choose how much she asks: every time, once per task (default) or *always allowed* per site; payments and account settings always ask, sending asks every time, and passwords are never typed by her. A **Sara is working** badge with Stop and a stop hotkey (Ctrl+Alt+Esc / ⌃⌥Esc); touching her window pauses her (or *Let Sara keep control*). |
| **2.20** · Computer use, step 1 | With the Windows or Mac app, **she opens web pages in her own browser window on your computer** (her own profile, never your browser or passwords), reads them, takes screenshots and reads console and network errors: say "my app on localhost is broken" and she looks. Off until you switch on *Let Sara use this computer*; a live view in the chat with Stop; every step in Runs with a picture. Clicking and typing come next. [The plan](docs/design/COMPUTER_USE.md) |
| **2.19** · Red-team mode | **Before you ship, she tries to break her own work:** in a sandbox copy she runs your tests, starts your app and throws malformed and boundary inputs at every entry point, checks insecure defaults, and lets the coding model write small attack scripts that can only reach that sandboxed app. A stronger reviewing model keeps only breaks that reproduce, with the input, the output and the code line quoted. Then **Fix what broke** on a local branch. Also in 2.19: **Gmail organizing** (archive, mark read, labels, trash… by search or date, count first, Undo). [How it works](docs/design/HARNESS_TRACK.md) |
| **2.18** · Recall on her own | **She remembers without being asked when the situation matches:** the same error came back in this project ("last time the fix was…"), a command that failed here before, a file you have a decision about, a task like one she has a lesson for. Lessons are written only from what really happened (the error line and the fixing change, quoted). Each note says where it came from and how sure, at most 2 a step, and *Not useful* teaches her. [How it works](docs/design/HARNESS_TRACK.md) |
| **2.17** · Evals on your own work | **Which setting is actually better for you?** Pick up to 3 variants (model, memory fading, sandbox mode, budget) and she replays your last real tasks with each one in sandbox copies. Each run is scored on whether your tests pass, how you reacted, findings, tokens, time and cost, plus an optional judge that must quote. A winner is named only when a sign test says it's real ("+18% on 20 of your coding tasks, p=0.01"), with every pair's diff as evidence. Otherwise: *no clear winner*. [How it works](docs/design/HARNESS_TRACK.md) |
| **2.16** · Time-travel | **Branch any past task from any step:** change her message, a tool result, the notes she remembered or the model at that step, and run it again. Earlier steps come from the record (nothing is re-run). Coding branches work in a copy at the recorded commit, never in your files. A side-by-side diff shows steps, tokens, cost, file edits and the answer. *Replay unchanged* is the control. Keep the answer or apply the files only if you want. [How it works](docs/design/HARNESS_TRACK.md) |
| **2.15** · Threat model | **She maps how the outside world reaches your code:** after a coding turn she finds the entry points (routes, uploads, message handlers, command line in Express, Koa, Fastify, Flask, FastAPI, Django, Go) and follows request values across files to risky lines (shell, SQL, file paths, outgoing URLs, redirects, HTML, eval). A threat is reported only with both lines quoted and the path named. A **Threat model** tab per project, and **Fix these**: a second pass that only fixes them, on a local branch, with your tests re-run. [How it works](docs/design/HARNESS_TRACK.md) |
| **2.14** · Security pass | **After a coding turn she checks her own work:** 11 code checks (secrets, SQL built from strings, path traversal, TLS off, eval, unsafe deserializing, CORS, missing auth…) plus a reviewing model, run in parallel. Every finding quotes the real line or it's dropped, so there's no theater. Opt-in **live advisories** (OSV.dev) check the packages she installs and stop a known-bad version on a card. **Fix it** makes a local branch, fixes just that, re-runs your tests in the sandbox and shows the diff. It never pushes. [How it works](docs/design/HARNESS_TRACK.md) |
| **2.13** · Sandbox first | **Risky commands run in a throwaway copy of your project first.** Deletes, installs, scripts and network calls happen in the copy (inside bubblewrap on Linux, Seatbelt on macOS, Docker or WSL2 on Windows when you have them). The **Ran in a sandbox** card shows what changed and anything nasty: files deleted en masse, writes outside the copy, programs left running, git hooks. Then *Apply to my workspace*, *Discard* or *Run for real*. [How it works](docs/design/HARNESS_TRACK.md) |
| **2.12** · Budgets she keeps | **A hard ceiling, not a report:** coding tasks get a budget (200k tokens / 40 steps by default, optional dollars). Near the limit she switches to your quick model, cuts tool rounds, then writes a short summary of what's done and what's left, and stops. Going further takes your **Continue with more**. Jobs and team tasks use the same budget. [How it works](docs/design/HARNESS_TRACK.md) |
| **2.11** · Run snapshots | **Every step of her work is recorded:** which model, the prompt, each tool call and result (secrets removed), the files she touched (git HEAD and changed files in coding projects), the notes she used, the conflicts she hit, tokens, cost and time. Open **Show the run** under any reply to see it step by step. Kept 90 days by default; nothing leaves your server. The base for budgets, time-travel and evals. [How it works](docs/design/HARNESS_TRACK.md) |
| **2.10** · Checks her plans against yours | **Before she acts, she checks the step against what you decided.** Told her "never push to main", "tests before every push", "use pnpm" or "hands off the prod config"? A planned step that goes against it **stops on a card** that quotes your decision, with *Do it anyway*, *Don't* or *Update the note*. In everyday chat she just mentions it. Rules are matched in code (no guessing), and it can only add a stop, never remove one. [How it works](docs/design/HARNESS_TRACK.md) |
| **2.9** · Ranked memory | **She tells you why she remembered something:** each note she uses is scored for your message and carries *why it came to mind* and *how sure* that is (in her panel too). Old notes fade gently instead of vanishing, notes she keeps using stay strong, and you can **pin** the ones that must never fade. The fading is a slider you control. [How it works](docs/design/HARNESS_TRACK.md) |
| **2.8** · Polish | **One notch more premium:** a slow aurora behind frosted glass, an elegant serif for headings, a glowing mood halo around her portrait, a hand-drawn icon set, weather art and progress rings, and a floating glass tab bar on phones (all motion off with *reduce motion*). [The plan](docs/design/NEW_LOOK.md) |
| **2.7** · The new look, part 3 | **Today as tiles** (weather, your day, Planner, what she remembered, moments, background work, home), a bottom bar on phones, every screen on the new look, and in the Windows and Mac apps **notifications with Allow / Deny and Done / Snooze**, *Send to → Sara* for files, and voice in quick ask. [The plan](docs/design/NEW_LOOK.md) |
| **2.6** · The new look, part 2 | **Her presence:** a side panel (a pull-up sheet on phones) with her mood, what she's doing now, approvals, jobs, today and what she remembered; Ctrl+K to jump anywhere; and in the Windows and Mac apps a **quick-ask window on a shortcut** over any app, plus her mood and approvals in the tray menu. [The plan](docs/design/NEW_LOOK.md) |
| **2.5** · The new look, part 1 | **Dark by default and her work on screen:** a line under each reply shows what she did, results arrive as cards (weather, to-dos, files changed, test runs, searches), a lighter chat on phones and computers, and the Windows and Mac apps draw the page into the title bar. [The plan](docs/design/NEW_LOOK.md) |
| **2.4** · Neat and tidy | **Everything easier to find:** a short sidebar with a *More* menu you can pin from, Settings with real headers that fold, Tools and approvals explained in plain words, photos you can delete from the scrapbook, tidier screens and menus in every app, and safer saving under the hood. [What changed](CHANGELOG.md) |

<details>
<summary><b>Earlier releases: 1.1 to 2.3</b> (big documents, SSH, Alexa and Google Home, household mode, moments, video calls, several servers, private local mode, group chats, moving in from other apps…)</summary>

| Release | What you get |
|---|---|
| **2.3** · Big documents | **500–1,000-page books and manuals** (PDFs up to 1 GB) in her library: uploads that resume, every scanned page read, contents and chapter summaries, and answers that cite the page ("p. 412") with a link straight to it. 30 of 30 questions right on a 1,000-page test book. [How it works](docs/LIBRARY.md) |
| **2.2** · Your other servers over SSH | **She can work on your other machines** with a password or a key. After a password login she **makes her own key, tells you where it is and forgets the password** (kept only if you insist, after a warning). Host keys are checked, every command follows her approval rules, and you can revoke her key any time. [How it works](docs/SSH.md) |
| **2.1** · Her voice in your home | **"Alexa, open sara companion"**: talk to her on any Echo through your own free skill (checked the way Amazon requires). Make her your **Android assistant** (long-press home), hear her on **Google Home / Nest** speakers through Home Assistant, and let her **greet you when you get home**. Siri on iPhone comes with the next app update. [How it works](docs/VOICE_ASSISTANTS.md) |
| **2.0** · Household mode | **Share your Sara server with the people you live with.** Invite an adult with a one-time link; they get their own companions, chats, memory, library and apps in a space of their own. You stay the admin: you choose which models they use and set daily limits, and you see usage and cost, never what they say. [How it works](docs/HOUSEHOLD.md) |
| **1.10** · Our moments | **A shared photo album** of your photos and the ones she sends, each with a caption she writes in her own voice from what you were talking about. Albums that fill themselves (Us, Places, Her looks), "On this day", and she sometimes brings one up: *remember this?* Private chats stay out unless you add them. [How it works](docs/MOMENTS.md) |
| **1.9** · Video calls | **See her while you talk:** a video call shows her moving portrait full-size, lips in sync with her voice, her face following her mood, in her current outfit and place. Turn your camera on if you like and she looks every few seconds (or when you press *Look at this*); nothing is recorded. [How it works](docs/VIDEO_CALLS.md) |
| **1.8** · Several servers in one app | Keep **all your Saras in one app** (home and work, or several on one server) and switch from a menu without signing out: the Windows and Mac apps, Android and iPhone, VS Code, `sara-chat` and the MCP bridge. Each keeps its own sign-in; files, microphone and camera go only to the one in use. [How it works](docs/SERVERS.md) |
| **1.7** · Private local mode | One switch, **Nothing leaves this computer**, enforced in code at a single gate: only this computer is reachable, cloud models and online tools pause, and her chats, memory and library keep working. The Windows and Mac apps find (or help you set up) Ollama, suggest a model that fits your graphics card and download it with a progress bar. [What it guarantees](docs/PRIVATE_LOCAL.md) |
| **1.6** · Group chats | Put **two to four of your companions in one conversation**: each answers in her own personality, voice and colour; pick who answers (whoever fits, everyone, take turns, or only who you @mention) and how much they banter with each other. Safety, AI notices and the strictest adult setting apply to the whole room. [How it works](docs/GROUP_CHATS.md) |
| **1.5** · Bring her from another app | Move in from **ChatGPT, Claude, Character.AI, SillyTavern, Replika, Nomi or Kindroid**. She reads the export on your own server, then shows you what she learned (facts in your own words, your history together, her style) and saves only what you approve. [How to export from each app](docs/IMPORT.md) |
| **1.4** · Smoothness | Watch each file she writes **grow live in the chat** as the model streams it (OpenAI, Anthropic, xAI, OpenRouter and ChatGPT plans; Ollama sends it in one piece); a talking portrait that lip-syncs with nine mouth shapes; logs in plain text or JSON |
| **1.3** · Smarter checks | Her "did she really do what she says?" check now works in all six languages; an optional small local model as judge raises what it catches from 38% to **88%** at 95% precision ([measured](docs/RESULTS.md)) |
| **1.2** · Fully in your language | The whole app, the help guide and her server messages in English, Español, Français, Deutsch, Português (Brasil) and Italiano |
| **1.1** · Install anywhere | Set up a new server in the browser with a short code; a Docker image for **ARM** (Raspberry Pi 4/5) too; Homebrew, Unraid, TrueNAS, Proxmox and Home Assistant (HACS) |

</details>

Every release: [CHANGELOG.md](CHANGELOG.md) · [releases](https://github.com/farena-ai/sara/releases).

### Coming next

In build order, one release each ([the full list](docs/ROADMAP.md)):

- **Computer use** (2.26–2.28, under way): using your desktop, guided "tune up my computer" tasks, Linux.
- **Agent staples** (2.29–2.36): skills in the open Agent Skills format and skills she learns from what you repeat, plugins and hooks, a Kanban board she works, A2A with other agents, people cards, webhooks, her own agenda (opt-in).
- **Move in from another agent** (2.37–2.39): bring a whole Hermes Agent or OpenClaw companion over: personality, memories, people, skills, history and settings, with a report of what came over.
- **Chats and sessions** (2.40–2.42): /new, /reset and other commands in Telegram and Discord, a project per channel, titles that grow with the session.
- **Today, rethought** (2.43–2.44): a designed layout you can arrange, on big screens and phones.
- The iPhone app (waiting on Apple), and your ideas in [Discussions](https://github.com/farena-ai/sara/discussions).

The full plan: [docs/ROADMAP.md](docs/ROADMAP.md).

## Feature tour

All screenshots are from a real throwaway test server with a local model (qwen3.8 27B on Ollama),
signed in as the example user "Alex". Night is the default look.

### Companion

<img src="docs/screenshots/companion.png" alt="Night look: Sara answers a tired user warmly, checks the weather for tomorrow's run and shows it as a card; her presence panel on the right shows her portrait with a mood halo, what she's doing, today's to-dos and the notes she remembered" width="760">

Her own character and moods that change with how things go (the halo around her portrait takes her
mood's colour), her own day and hobbies, memory of what matters to you and the dates you care about
(see, correct or forget any of it), a weekly look back, texting first if you want (with quiet hours),
and a timeline of your story together. Coming from another app? Bring your chats from ChatGPT,
Claude, Character.AI, SillyTavern, Replika, Nomi or Kindroid, and approve what she learns from them
first ([docs/IMPORT.md](docs/IMPORT.md)). Or bring two to four of your companions into one group chat
([docs/GROUP_CHATS.md](docs/GROUP_CHATS.md)). Want everything on one machine? Switch on **Nothing
leaves this computer** ([docs/PRIVATE_LOCAL.md](docs/PRIVATE_LOCAL.md)).

### Her presence

<img src="docs/screenshots/presence.png" alt="A coding chat: a Files changed card, then an approval card asking to run npm test; the presence panel shows Waiting for your OK with Allow and Deny, and two background jobs with their last line and a Stop button" width="760">

A panel beside every chat (a pull-up sheet on phones) with her portrait glowing in her mood's colour
and **Now**: what she's doing, approvals waiting with Allow / Deny, background jobs with their last
line and Stop; then today's next things, the notes she used for the last reply (folded until you open
it) and this conversation's model, workspace and privacy. Under each reply a quiet line says what she
did ("Remembered 6 things · Set a reminder 0.1 s"); tap it for the commands, output and Undo.

### Coding partner

<img src="docs/screenshots/coding.png" alt="A coding chat in a project workspace: she explains her plan, edits five files (a Files changed card), runs the tests, finds three failures, fixes them and ends with a green Tests passed card showing 11; the panel shows two background jobs" width="760">

A workspace per project with files, shell and git (commit and push with your OK); every file she
writes appears live in the chat as the model streams it; long builds and tests in the background with
a ping when done; a live preview of the app she's building, which she tests in a real headless browser
and attaches screenshots of; a code map for big codebases; tested starter projects; a team of helpers
(plan → build → test → review) from a GitHub issue to a reviewed pull request; your other servers over
SSH with her own key ([docs/SSH.md](docs/SSH.md)); hand-off to Claude Code or Grok Build; MCP tools;
undo for file changes; a token and cost meter with budgets; and a check, in all six languages, that
what she *says* she did matches what actually ran (optionally judged by a small local model).

### Planner

<img src="docs/screenshots/planner.png" alt="One message becomes a reminder and two to-dos, each shown as a card with its time and an Open the Planner link" width="760">

To-dos, notes and reminders from plain sentences, delivered in chat, as notifications on your phone
or computer (Done / Snooze in the Windows and Mac apps) and on Telegram or Discord; a morning
briefing; place reminders from the phone app.

### Today

<img src="docs/screenshots/today.png" alt="The Today page: a serif greeting with her portrait and mood, then tiles for the weather in Chicago with the next hours, your day, the Planner with a progress ring, what she remembered, moments with captions she wrote, background work and coming up" width="760">

Where Sara opens: her face, mood and a greeting, then tiles for the weather (from your briefing's
place), your day, the Planner with ticks, what she remembered, your shared moments, background work,
coming up and your home (lights and switches right from the tile). Four columns on a big screen, one
on a phone.

### Library

<img src="docs/screenshots/library.png" alt="Sara answers a book-club question from a Project Gutenberg copy of Jekyll and Hyde, citing p. 6 and p. 9 as links; beside it, the page she read, opened at p. 6 with the passage highlighted" width="860">

Give her PDFs (scans too, and books of 500 to 1,000 pages), Word, Excel, PowerPoint, e-books, web
pages and notes. She learns the key points, answers from them and says which document and page it
came from, with a link that opens it right there ([docs/LIBRARY.md](docs/LIBRARY.md)).

### Command bar

<img src="docs/screenshots/command-bar.png" alt="The Ctrl+K command bar over Today: typing 'pa' finds her page, two conversations and five settings" width="760">

Ctrl+K / ⌘K (or the magnifier on phones) jumps to any place, conversation (also by words inside
messages), settings page or single setting, or runs an action: new conversation, off the record,
call, switch companion, switch theme.

### Voice

<img src="docs/screenshots/voice.png" alt="The Voice settings page in the Night look: hearing you, her voice, expressive voice, tone, her voice following her mood, live calls and how often she looks during video calls" width="760">

Live calls you can interrupt (Grok or OpenAI realtime voice), video calls with her moving portrait
([docs/VIDEO_CALLS.md](docs/VIDEO_CALLS.md)), voice notes on Telegram and Discord, read-aloud, a voice
that follows her mood, and an animated portrait that talks, lip-synced with nine mouth shapes. Talk to
her on an Echo with your own Alexa skill, make her your Android assistant or hear her on Google Home
speakers ([docs/VOICE_ASSISTANTS.md](docs/VOICE_ASSISTANTS.md)). Voices run on your Linux server or
come from your subscription. (Screenshot from a Windows test server, where local voice isn't available
yet.)

### On your phone

<img src="docs/screenshots/phone.png" alt="Four phone screens: Today with the weather tile; a chat with a weather card; her presence sheet pulled up from her face; Today in the Day theme. A floating bottom bar with Chat, Today, Planner and More" width="860">

The same look on phones: a floating bottom bar (Chat, Today, Planner, More), her presence as a sheet
you pull up from her face, and the message bar above the keyboard. Night by default, Day or *follow
the system* in Settings → Look.

### Everywhere

<img src="docs/screenshots/everywhere.png" alt="Sara on a phone answering a book-club question from her library, citing the page" width="260">

Web app and installable PWA, Android and iPhone apps ([android/](android/README.md),
[ios/](ios/README.md)), desktop apps for Windows and macOS with the page drawn into the title bar,
quick ask on a shortcut, notifications with Allow / Deny and *Send to → Sara* for files
([docs/desktop.md](docs/desktop.md)), Telegram and Discord bridges, `sara-chat` in any terminal and a
VS Code panel ([docs/clients.md](docs/clients.md)), Gmail and Google Calendar on your own Google app,
Home Assistant, off-the-record conversations that are never saved, several Saras in one app
([docs/SERVERS.md](docs/SERVERS.md)), a shared server for your household with a space for each adult
([docs/HOUSEHOLD.md](docs/HOUSEHOLD.md)), and other apps with her own memory and personality: an
OpenAI-compatible API (SillyTavern, Open WebUI, scripts), an MCP server (Claude Code, Cursor, Claude
Desktop; [listed on Glama](https://glama.ai/mcp/servers/farena-ai/sara)) and character cards in and out
([docs/OTHER_APPS.md](docs/OTHER_APPS.md)).

### Make it yours

<img src="docs/screenshots/make-it-yours.png" alt="Name and personality settings: her name, pronouns and age, a Create your companion button and a gallery of starter characters; beside it the personality dials (playfulness, teasing, directness, temper, confidence, message length, tone, curiosity, optimism) and her life" width="760">

Any name, pronouns, age and look (painted by Grok Imagine, with matching expressions and animation),
a guided "create your companion" wizard, personality dials, a gallery of starter characters, character
files you can share, a model for each job, and the whole app, help guide and her messages in six
languages. Every setting has a **?**, there are short guided tours, and you can simply ask her how
something works.

### Safety, always on

<img src="docs/screenshots/safety.png" alt="An approval card: Sara asks before running npm test, with Allow and Deny, after a Tests failed card; the status bar says Waiting for your OK" width="760">

Risky actions wait for your OK (on Windows, which has no command sandbox, every command does), in the
chat, in her panel, or as a notification with Allow / Deny in the Windows and Mac apps. The safety
layer runs in code around every model call and **cannot be switched off**: AI disclosure at the start
and regularly after, an honest answer whenever she's sincerely asked if she's an AI, crisis resources,
and a hard block on sexual content involving minors ([docs/COMPLIANCE.md](docs/COMPLIANCE.md),
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)). Daily backups (plus encrypted off-server copies),
one-command restore and update, and `sara doctor` keep her healthy.

## How it fits together

<img src="docs/architecture.svg" alt="Architecture: apps and bridges talk to one Sara server; each turn passes the always-on safety layer, gathers memory and library context, calls the chosen model provider and runs tools in a sandboxed workspace; data stays in one folder on your server" width="860">

More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tested, with published results

Everything below was run for real; the scripts are in the repository, so you can re-run them on
your own models. Dates, setup and the result files: **[docs/RESULTS.md](docs/RESULTS.md)**.

| Benchmark | Model | Score | Date |
|---|---|---|---|
| [HumanEval](https://github.com/openai/human-eval), through her agent loop (164 problems, hidden tests) | qwen3.8 27B, local | **158/164** (pass@1 96.3%) | 2026-10-27 |
| HumanEval, same model with no tools (baseline) | qwen3.8 27B, local | **161/164** (pass@1 98.2%) | 2026-10-27 |
| Repository tasks: 14 original multi-file bug fixes, features and refactors (hidden tests), through her agent loop | qwen3.8 27B, local | **11/14** (both runs) | 2026-10-28 |
| Repository tasks, same model with every file in one prompt and no tools (baseline) | qwen3.8 27B, local | **12/14** (both runs) | 2026-10-28 |
| Real-size projects: 3 original projects of 22–36 files (hidden tests), through her agent loop | qwen3.8 27B, local | **2/3**, then **3/3** | 2026-10-28 |
| Real-size projects, same model with every file in one prompt and no tools (baseline) | qwen3.8 27B, local | **3/3** (both runs) | 2026-10-28 |
| Claim check in 6 languages (240 held-out replies): patterns only → with a local judge | qwen3.5 9B, local, as judge | caught **38% → 88%**, precision 92% → 95% | 2026-10-28 |
| Memory across sessions (recall, no inventing, forgetting) | qwen3.8 27B, local | **11/12** checks | 2026-10-27 |
| Library: answers from documents and says where | qwen3.8 27B, local | **8/8** in both runs | 2026-10-27 |
| Code map: questions about her own code | qwen3.8 27B, local | **8/8** | 2026-10-27 |

The honest reading: her agent loop doesn't add points on either coding benchmark yet. The plain
model already aces the short HumanEval problems, and the 14 repository tasks are small enough (5 to
7 files) to paste whole into one prompt (so are the three real-size projects, at under 1,100 lines); the misses in both modes were rules written only in a
README or SPEC that no test checked. What she adds today is the way of working (she runs the tests,
asks before risky steps, shows what ran), not a higher score on these sets. Details, per-task
results and how to re-run: [docs/RESULTS.md](docs/RESULTS.md).

Plus `npm run check`: a typecheck and 1190 automated tests with a scripted fake model (no network,
no GPU): 1178 pass on Windows and the other 8 are Linux-only sandbox tests, run on a Linux server.

## How Sara compares

A general comparison with the usual kinds of alternatives (individual products vary):

| | Sara | Hosted AI companion apps | Coding CLIs and agents | Self-hosted chat UIs |
|---|:-:|:-:|:-:|:-:|
| Runs on your own computer or server | ✅ | ❌ | ✅ | ✅ |
| Use any model, including local ones | ✅ | ❌ usually theirs | varies | ✅ |
| Lasting personality and memory you can see and edit | ✅ | ✅ | ❌ | varies |
| Writes, runs and tests code, asks before risky steps | ✅ | ❌ | ✅ | varies (plug-ins) |
| Planner, reminders, documents, voice calls | ✅ | some | ❌ | some |
| Phone apps, Telegram and Discord | ✅ | phone apps | ❌ | varies |
| Bring your chats from other companion apps, reviewed before saving | ✅ | ❌ usually | ❌ | varies |
| The whole app in six languages | ✅ | varies | varies | varies |
| Safety layer that no setting can turn off | ✅ | their own policies | n/a | usually not |
| Price | free (MIT); you pay for your models | subscription | varies | usually free |

## Install

**Linux server** (Debian/Ubuntu, Fedora/RHEL/Alma/Rocky, Arch, openSUSE), one command that asks a
few plain questions (press Enter for the suggestion):

```sh
curl -fsSL https://raw.githubusercontent.com/farena-ai/sara/main/deploy/get-sara.sh | sudo bash
# it ends with the address to open and your one-time owner token
sudo sara status
```

**Docker:**

```sh
git clone https://github.com/farena-ai/sara && cd sara
sudo docker compose up -d                       # or: sudo docker compose --profile ollama up -d  (with a local Ollama)
sudo docker compose logs sara | grep -A1 'owner token'   # or: open her page and enter the setup code from this log
```

**App stores and NAS:** the image `ghcr.io/farena-ai/sara` (amd64 and ARM),
`brew install --cask farena-ai/tap/sara`, TrueNAS, Proxmox and HACS (as a custom repository) work
now; Unraid is approved, and winget, CasaOS/ZimaOS, Umbrel and the HACS store list are waiting for
review
([which is which](docs/INSTALL.md#other-ways-to-install)). A new server is set up in the browser
with a short code from her log (one click on Umbrel), no long token to copy.

**Windows and macOS:** download `Sara-Setup-<version>.exe` or `Sara-<version>.dmg` from the
[releases page](https://github.com/farena-ai/sara/releases/latest). The first question: run Sara on
this computer (her server and the desktop app together) or connect to a Sara somewhere else (the app
only).

**Phones:** the [Android app](https://play.google.com/store/apps/details?id=com.backstagecoding.sara) is on Google Play; pair it by scanning the QR code under
Settings → Data & health → Devices and sign-in → Add a phone or computer. The iPhone app is coming to the App Store soon (until then, add Sara to
your home screen from Safari).

**From source** (any computer with Node 24+):

```sh
git clone https://github.com/farena-ai/sara && cd sara
npm ci
npm start                                       # http://127.0.0.1:7860; the token is in the output
```

Sign in with the token (or the setup code), and a setup guide asks your
name, helps you shape your companion and connects a model. Reaching her from your phone (Tailscale,
your own web address with HTTPS, or your home network), updates, backups and troubleshooting:
**[docs/INSTALL.md](docs/INSTALL.md)**.

## Day to day

```sh
sudo sara status       # is she running, last backup
sudo sara update       # backs up, updates, restarts
sudo sara backup       # back up now
sudo sara restore FILE # restore a backup
sudo sara access       # how you reach her (change: tailscale, local, domain, lan)
```

## Documentation

| | |
|---|---|
| [Install](docs/INSTALL.md) | Linux, Docker, Windows, macOS, HTTPS, updates, troubleshooting |
| [What computer do I need?](docs/REQUIREMENTS.md) · [Choosing a model](docs/CHOOSING_A_MODEL.md) · [What it costs](docs/COSTS.md) | Before you start: hardware, models with GPU sizes, running costs |
| [Your phone](docs/PHONE.md) · [Moving to a new computer](docs/MOVING.md) | Phone setup start to finish; backup, install, restore |
| [Security checklist](docs/SECURITY_CHECKLIST.md) · [What leaves your server](docs/PRIVACY.md) | Five minutes after installing; every outgoing connection and how to turn it off |
| [FAQ and glossary](docs/FAQ.md) | Common questions, and what the words mean |
| [Apps and clients](docs/clients.md) · [Desktop apps](docs/desktop.md) · [Home Assistant](docs/HOME_ASSISTANT.md) | Terminal, VS Code, Windows and macOS; Sara in Home Assistant and Home Assistant in Sara |
| [Other apps](docs/OTHER_APPS.md) · [Bring her from another app](docs/IMPORT.md) | OpenAI-compatible API (SillyTavern, Open WebUI, scripts), MCP (Claude Code, Cursor, Claude Desktop), character cards; importing chats from Character.AI, SillyTavern, Replika, Nomi, Kindroid, ChatGPT or Claude |
| [Several Saras in one app](docs/SERVERS.md) · [Private local mode](docs/PRIVATE_LOCAL.md) · [Household mode](docs/HOUSEHOLD.md) | Switch between servers; keep everything on one computer; share a server with the people you live with |
| [Group chats](docs/GROUP_CHATS.md) · [Video calls](docs/VIDEO_CALLS.md) · [Our moments](docs/MOMENTS.md) · [Big documents](docs/LIBRARY.md) | Several companions in one chat; calls with her moving portrait; the shared photo album; 1,000-page books in her library |
| [Voice assistants](docs/VOICE_ASSISTANTS.md) · [Alexa](docs/ALEXA.md) · [Servers over SSH](docs/SSH.md) · [Packages](docs/PACKAGING.md) | Alexa, Android assistant, Google Home, Siri; working on your other servers; Homebrew, winget, Unraid and the rest |
| [Extending Sara](docs/EXTENDING.md) | Add tools, bridges, characters, MCP servers, languages, starters |
| [Architecture](docs/ARCHITECTURE.md) | How the pieces fit, module by module |
| [Results](docs/RESULTS.md) | Benchmarks and evals, and how to re-run them |
| [Translating](docs/TRANSLATING.md) | The app in your language |
| [Compliance](docs/COMPLIANCE.md) · [Threat model](docs/THREAT_MODEL.md) · [Disclosures](docs/DISCLOSURES.md) | Safety, security, what to know first |
| [Roadmap](docs/ROADMAP.md) · [Changelog](CHANGELOG.md) · [Releases](https://github.com/farena-ai/sara/releases) | Where it's going, what changed |

All of these also build into a small searchable website with a dark mode:
`node scripts/build-docs.ts` writes it to `outputs/site/` (open `index.html`; it's ready for GitHub
Pages).

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the
[good first issues](docs/GOOD_FIRST_ISSUES.md); please follow the
[code of conduct](CODE_OF_CONDUCT.md) and report security problems privately as described in
[SECURITY.md](SECURITY.md).

```sh
npm ci
npm run dev        # http://127.0.0.1:7860, restarts on save
npm run check      # typecheck + all tests
```

## License

MIT, see [LICENSE](LICENSE). Credits for the pieces Sara downloads or calls:
[docs/CREDITS.md](docs/CREDITS.md).
