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
  <img src="https://img.shields.io/badge/tests-1994%20passing-brightgreen" alt="1994 tests passing">
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

<p align="center">
  <a href="docs/START_HERE.md"><img src="https://img.shields.io/badge/I%20just%20installed%20it%2C%20now%20what%3F-B4436C?style=for-the-badge" alt="I just installed it, now what?" height="34"></a>
  <a href="docs/FOR_CODERS.md"><img src="https://img.shields.io/badge/I%27m%20here%20to%20code-6E4BD8?style=for-the-badge" alt="I'm here to code" height="34"></a>
</p>

> **Status:** 2.63.1, MIT licensed, with seventy-four feature releases since 1.0 (all below). 2.5 to 2.8
> gave the whole app a new look. The [Android app](https://play.google.com/store/apps/details?id=com.backstagecoding.sara)
> is on Google Play; the iPhone app and the Mac App Store version are coming as soon as Apple approves them.
> Read [docs/DISCLOSURES.md](docs/DISCLOSURES.md) before using or sharing Sara.

**Operate with evidence:** owner-only HTTP/readiness measurements, safe resolved-delivery archival and repeatable local workload/browser checks. [Operations guide](docs/OPERATIONS.md).

**Recover interrupted work:** Settings → Data & health → Recovery keeps job restart reviews and
native Telegram/Discord delivery uncertainty visible. Nothing is blindly replayed after startup;
current privacy and approvals still apply. [Recovery guide](docs/RECOVERY.md).

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

## Start here

Two short paths through the first ten minutes. Pick yours; every feature stays available either way.

### I just installed it, now what?

<img src="docs/screenshots/first-run.webp" alt="Setup step 1 of 4: a box with the name Alex and three cards for what you will mostly do with her: Company, Coding or Both" width="560">

1. **Sign in** with the setup code from her log (or your owner token).
2. **Tell her your name** and pick *Company* when she asks what you'll mostly do together.
3. **Connect a brain:** she suggests a model for your computer and checks that it answers (*Connected ✓*), or uses a plan you already pay for.
4. **Say hello:** tap *Plan my day with me* or just type. A short tour follows her first reply.
5. **Make her yours** with the personality dials, then let *Getting started* on Today walk you through her voice, your phone and a morning briefing.

The whole walkthrough, with pictures: **[Start here](docs/START_HERE.md)**. Every answer from the app's *How do I…?* boxes in one list: **[How do I…?](docs/HOW_DO_I.md)**.

### I'm here to code

<img src="docs/screenshots/connect-brain.webp" alt="Setup step 3 of 4, Connect a brain: four choice cards (On this computer, Another computer at home, In the cloud, My subscription) and a Picked for you card with the local model qwen3.8 27B, a Good for coding chip and Connected" width="560">

1. **Pick *Coding*** in setup: she suggests a model that's good at code (*Good for coding*) or your Claude Code, Codex or Grok Build plan.
2. **Open a project** with *+ Project*: a workspace folder where she has files, a shell and git.
3. **Ask for something real.** She writes the files, asks before running a command, and shows test results as cards.
4. **Read the line under each reply** for every command and its output; risky commands can run in a sandbox copy first.
5. **Bring her into your tools:** GitHub, `sara-chat`, VS Code, MCP for Claude Code and Cursor, and budgets that stop a long task where you say.

The coder's walkthrough: **[For coders](docs/FOR_CODERS.md)**. From source in three commands: [Install](#install).

## How-to videos

One-minute walkthroughs, recorded on a throwaway test server with a local model. <a href="https://www.youtube.com/playlist?list=PLGtrs9BqXtM8">All of them in one playlist</a>.

<table>
  <tr>
    <td align="center" width="25%"><a href="https://www.youtube.com/watch?v=DTAIW75y7i4&list=PLGtrs9BqXtM8&index=1"><img src="https://i.ytimg.com/vi/DTAIW75y7i4/mqdefault.jpg" alt="Set up Sara" width="200"></a><br><sub>Set up Sara</sub></td>
    <td align="center" width="25%"><a href="https://www.youtube.com/watch?v=_X69x9E3W_k&list=PLGtrs9BqXtM8&index=2"><img src="https://i.ytimg.com/vi/_X69x9E3W_k/mqdefault.jpg" alt="Memory and people cards" width="200"></a><br><sub>Memory and people cards</sub></td>
    <td align="center" width="25%"><a href="https://www.youtube.com/watch?v=wrvNcHkc9O4&list=PLGtrs9BqXtM8&index=3"><img src="https://i.ytimg.com/vi/wrvNcHkc9O4/mqdefault.jpg" alt="The board" width="200"></a><br><sub>The board</sub></td>
    <td align="center" width="25%"><a href="https://www.youtube.com/watch?v=7i48NiAq-jw&list=PLGtrs9BqXtM8&index=4"><img src="https://i.ytimg.com/vi/7i48NiAq-jw/mqdefault.jpg" alt="Coding with Sara" width="200"></a><br><sub>Coding with Sara</sub></td>
  </tr>
</table>

## What's new

- **2.61** ·  Easier chat-app setup: one guided card for WhatsApp, Matrix, iMessage, Signal, Email and Telegram, each step checked, with plain fixes; Sara's own plugins need one OK, not a developer warning.
- **2.60** · Companion packs: share a companion's character, look, voice and starter skills as a file or on the Sara Store, without ever sharing your memories or chats; character cards import too.
- **2.59** · "Hey Sara": say her name to talk hands-free in the Windows app (a small model on your computer listens only for it), a Talk shortcut everywhere, and local hearing and voices on Windows.

<details>
<summary><b>Release history</b>: what each release from 2.4 brought</summary>

| Release | What you get |
|---|---|
| **2.60** · Companion packs | **Share her:** Settings → Her → ⋯ → *Share her* builds a pack of exactly what you tick (her character, dials, look, closet, voice, first message, skills, suggested routines) and shows what never leaves: memories, chats, people, keys, your name (it becomes `{{user}}`), your relationship notes and limits. **Install a pack** as a new companion, never over one you have, through a review card; updates show what the author changed and keep your own edits. Character Card V1/V2/V3 (PNG, JSON, CHARX) import as packs, with a lorebook turned into a few background lines, never memories. The minors check runs when a pack is made, reviewed and installed, with no override; ratings map onto Adult mode. Four starter companions on the store: Juniper, Rowan, Vesper and Jax. Also fixed: exporting a character card no longer includes your name or notes. |
| **2.59** · "Hey Sara" | **Say her name and talk** in the Windows app: a 5 MB model on your computer listens only for "Hey Sara" (or your own words for each companion), and nothing is sent until you say them; recording starts after the phrase, audio is never kept, and a dot on the tray icon shows when she's listening. Off until you switch it on, on each device; pauses while the screen is locked; when two devices hear you, one answers. **Talk to Sara** with Ctrl+Alt+Space or the tray, and on Android a Talk button in the notification and a Quick Settings tile. The AI notice is spoken first and crisis help is read in full. **Local hearing and voices on Windows:** `sara voice install` (about 650 MB, every file checked) where it used to be Linux only. Mac, Linux and the always-listening Android detector come next. |
| **2.58** · Get more | **Settings → Abilities → Get more:** browse and search the Sara Store, open an item, and install with one click through the usual review card (nothing switches on by itself). Tool servers get a card with the exact command (and its Windows form), what it needs, what it can reach and whether it's fenced; keys go to the vault. **Updates** show exactly what changed, with any new permission marked, and you can go back. **My add-ons** lists everything with where it came from. **Submit your own:** `sara pack` checks a plugin, skill or tool server on your computer (manifest, permissions, a secret scan, a fenced smoke test, screenshots), then *Submit* in Settings or `sara submit` sends it, signed with your own author key. The Sara team reviews it before it's listed, and you can follow and answer from *My submissions*. Reports and takedowns switch an add-on off, never delete it. |
| **2.57** · The Sara Store opens | **A signed shelf** at [backstagecoding.com/sara/store](https://backstagecoding.com/sara/store/): Weather alerts, Focus, Home scenes, GitHub digest, Reading list and Webhook notes, plus tool servers for ComfyUI, Blender, a browser (Playwright), GitHub, files on this computer and docs (Context7), each with an exact pinned version. Sara checks the list's signature, every file's fingerprint and its expiry before showing anything; a damaged, old or withdrawn list is refused and the last good one kept. Browsing sends no id or cookie. Installs still go through the usual review card and nothing switches on by itself; add-ons pulled from the store are switched off, never deleted. **Skill tidy-up:** unused skills can be archived and brought back. Installing from inside Sara and submitting your own come next. |
| **2.56** · Lean and tidy | **A short tool list per step:** chosen in code (no model call) from what you're doing: the mode, the words you use, `@`-references, recent use, a loaded skill, a goal's earlier rounds, plus tools that are always kept for safety. She can look up the rest with *find tools*, and every call is still checked against everything she's allowed. Measured: a fresh install goes from 11,871 to 5,471 tokens a step (−54%); with four MCP servers, from 23,476 to 5,438 (−77%). `/tools` shows what's offered. **`/compact`:** folds the older part of a long chat into a summary written on this computer first (private chats never leave it). Your messages stay in the thread, with *Show summary* and *Undo*; it also runs by itself near the limit, and crisis messages stay word for word. Works in every chat app. |
| **2.55.3** · MCP on Windows | Fixed: on Windows, MCP servers started with `npx` (including the built-in presets) failed to start. |
| **2.55.2** · iMessage | **iMessage through BlueBubbles** (Settings → Connections → iMessage, an optional plugin): text her from Messages on your iPhone. Needs a Mac running BlueBubbles with an Apple ID of her own (Sara refuses to run on yours, because she'd see all your chats). Eight guided steps checked with a ✓, plain-language fixes, text, photos and files, and she catches up on anything sent while she was offline. Typing dots and tapbacks only if BlueBubbles' Private API is already on; Sara never asks you to lower your Mac's security for it. |
| **2.55.1** · Matrix | **Matrix** (Settings → Connections → Matrix, an optional plugin): talk to her in Element or any Matrix app through a Matrix account of her own. Five guided steps, each checked with a ✓, and plain-language fixes for every error. Text, photos and voice notes; only you unless you allow others (whole servers too); strangers' invites are declined. Rooms without end-to-end encryption only: in an encrypted room she explains why she can't read it and leaves. |
| **2.55** · WhatsApp | **WhatsApp** (Settings → Connections → WhatsApp, an optional plugin): text her through Meta's official WhatsApp Cloud API on a Meta account and number you own. A 10-step guided card names the exact Meta screens, checks each step with a ✓ and turns every error into one plain sentence with a fix. Photos and files both ways, typing dots and one *Working on it* line with Stop on long jobs, only you unless you list other numbers, and her own first messages only inside WhatsApp's 24-hour window. Meta's terms limit general AI assistants on WhatsApp, so it's off until you install it and tick that you've read them. |
| **2.54** · Routines and a safety check-up | **Routines gallery** (Planner → Routines): morning briefing, weekly review, stretch and bedtime reminders, leave on time, watch my repo's CI, new issues, backup check, inbox triage and price watch. Each card says what it does, what it needs and what it costs, worked out in code (most are free), shows a preview without calling a model, and has an Off switch; paid ones end on a date you pick. Tools keep your approval settings. **Safety check-up** (Settings → Data & health): 17 read-only checks, a verdict in words (*Looks safe*, *Mostly safe*, *Fix these first*), and one-click fixes that can only make things safer, each saying whether it can be undone. Changes to how Sara is reached are guided, never one click. Also `sara doctor --safety`. |
| **2.53** · Coding precision | **Checks after her edits:** when she changes code, Sara runs the project's own checker (tsc, pyright or mypy, cargo check, go vet, eslint), already installed, never `npx`, never installs anything, and hands her only the new errors in the same turn, including files her change broke elsewhere. She fixes them before answering (at most two nudges), and the reply shows *✓ types clean (tsc)* or what's left. One OK per project. **@-references:** type `@` in the chat box for `@file` (with lines), `@folder`, `@diff`, `@branch`, `@problem` or `@url`; chips show what she'll get and its size, and it works as typed text in Telegram, Discord and the other apps. Secret files are refused, and private chats never open web pages. |
| **2.52.1** · Easy server connect, photos fixed | *Connect a server* asks only for the address and user name; Sara makes her key, finds the port and the easiest way in (a cPanel token she deletes herself, your password once, or one line to paste) and explains every failure in plain words. Photos now always reach a model that can see them. |
| **2.52** · When it comes up | **Reminders that wait for a person or a topic:** "when Dan comes up, remind me he owes me $20" or "next time I mention the garden, ask about the tomatoes". She brings it up once, inside her reply, with *Done*, *Again next time* or *Forget*. Matching uses your People cards and plain words, with no AI call, and she never guesses between two Dans. They fire only on your own messages in your own chats, never where Dan could read them, and anything she'd send to someone else that contains one asks first. **Pick up a chat in another app:** start on Telegram, open the app, and *Continue here* brings that chat along (`/continue` anywhere), with *Show* and *Undo*; nothing is copied. |
| **2.51** · Keep going until it's done | **Goals with proof:** "make the tests pass, done when `npm test` is green": she works round by round within caps (rounds, minutes, tokens, dollars) and Sara runs your check, not her, so *done* means it really passed. A green that only came after she edited the tests ends as *done, review*; the same failure twice pauses her as *stuck*. **`/loop every 10m: check the deploy`**: quiet while nothing changes, one message when it does, stops on *until* (with proof), after two failures, at its end time or a daily cap, and never asks for approval unattended. Board cards can carry a *Done when* check. Everything comes back paused after a restart. Also fixed: editing files with Windows line endings failed, and your reminders no longer reach her instructions in shared work rooms. |
| **2.50** · Signal and email | **Two more ways to reach her, both built in.** *Signal* through signal-cli on your own computer: groups as rooms with keep-up, 👀 when she takes your note, a live progress message, files both ways, and your safety number pinned so a changed key pauses her tools until you confirm. *Email* in her own mailbox: one session per thread, replies in the thread, your mail counts as you only when your provider's sender check passes, strangers are never answered, forwarded mail makes every tool ask first, and auto-replies, newsletters and bounces never start a loop. Sara holds the connections for these plugins, only to the addresses you entered. Also fixed: a plugin chat-app reply that took over 5 minutes was cut off. |
| **2.49** · Talk to her while she works | **No more waiting for her to finish.** Send while she works and choose: *Tell her now* (she reads it before her next step and changes course; it can never approve anything), *After this* (it waits and runs as its own turn), or *Just asking* (`/btw`: a quick side answer, nothing saved, the work carries on). The same in Telegram and Discord (`/queue`, `/btw`). A **loop guard** stops her after three identical failing calls and makes her change approach. |
| **2.48** · Chat apps catch up | **Photos and files both ways in Telegram and Discord:** send her a photo (with a caption, an album, or as a file) or a document and she reads it; ask for a selfie, a chart or a file and it arrives (`send_file`). Pictures from other people in a room stay off until you switch them on, and then she only sees a description. **One progress message** updates in place while she works ("✅ Read a file ×3 · ▸ Editing a file…"), has a Stop button, and ends as one summary line. Plugin bridges can carry files too. |
| **2.47.3** · Start here | **Two ways in:** [Start here](docs/START_HERE.md) for "I just installed it, now what?" and [For coders](docs/FOR_CODERS.md), both with the how-to videos. Fresh screenshots, the README's feature tour split into *For company*, *For coding* and *For both*, every *How do I…?* answer in one index (in the guide and on the docs site), and a regrouped docs site. |
| **2.47.2** · One look, and help on every page | **Every page now has a *How do I…?* box** with step-by-step answers (123 of them, with *Show me*), and empty pages say what goes there and offer one clear next step. One card style, icons instead of emoji, one set of spacing and corners, a settings menu that opens one group at a time, a tidier phone layout with no sideways scrolling, a clearer first sign-in screen, and coding setup now prefers a capable model on your own computer. |
| **2.47.1** · A first run that fits you | **Setup asks one question: company, coding or both.** You get a recommended model with a live *Connected ✓* check, a matching six-stop tour (the full tour is still in Help), starter suggestions in an empty chat ("Plan my day with me" or "Fix a failing test") and a getting-started list in the right order for you. Pop-ups never stack, and the anonymous check-in note is part of the last setup step. |
| **2.47** · Personality you can see | **Her personality dials now show what they do:** each one has clear end words ("Keeps her distance ↔ Openly warm"), a word for where it sits, and a line in her voice that changes as you move it (125 of them, no AI call needed). Groups with plain names (How warm she is, How she pushes back, While you code), a "Your Sara so far" summary, and plain words on every other slider. Also fixed: Today refreshes after setup, one model count everywhere with a grouped picker, a persona import renames her everywhere at once, and *Leave by* sits before its event. |
| **2.46** · Report a problem from inside Sara | **Help → Report a problem or Suggest something** (or `/bug` and `/idea` in any chat, or *Report this* on an error): no GitHub account needed. Optional diagnostics are built on your computer, shown in full with a tick box per part, and cleaned of keys, emails and paths before anything is sent. *My reports* shows each report's status and our replies. Sara also sends one small anonymous check-in a day (version, Windows/Mac/Linux, which features are on) so we can support you and plan features; no IP address, name or chats are kept. *Show what's sent* or switch it off in Settings → Data & health → Privacy. |
| **2.45** · Today on phones | **On a phone, Today opens with a Now card** (the next two things with how soon, leave-by, the weather and her mood), then *Needs you*, then your day. Sections fold with a one-line summary and stay as you left them on that device, *With her* and *Work* become swipe rows (with buttons too), and pull to refresh works in the browser and both apps. Tablets get two columns. Optional: a one-sentence "while you were away" note in her voice. |
| **2.44** · Today, designed | **Today is laid out on purpose now:** *Your day* (one timeline of events, reminders and to-dos, with the weather and what's coming up), *Needs you* (approvals, failed work, overdue items and Mail), *With her*, *Work* and *Home & more*. Rows always line up, empty tiles fold away, and *Customise* moves, resizes or hides any tile (drag or keyboard), saved for each companion on every device. Mail shows your inbox, the change since yesterday and what she organised, with Undo, and updates by itself after a clean-up. An opt-in Rooms tile shows what's going on in rooms she keeps up with. |
| **2.43** · She keeps up with the room | **In Discord channels and Telegram groups she follows the whole conversation** (switch it on per room; a plan card shows the model and the daily cap first). When someone calls her she knows what's being talked about right now, who's around and what changed since she last spoke, so she joins the present topic instead of an hour-old one. Each week is archived in her Library as a searchable transcript and folded into a room memory with notes about the people there (proposed People cards). *Forget this room* clears it all. 12 replayed busy channels in 6 languages: on the current topic 12/12. |
| **2.42** · Titles that grow | **Session titles that say what the chat was about.** The first title is a placeholder; after a few exchanges, when the topic clearly moves, and at `/new`, a small model on your own computer names it again ("Starting a Vegetable Garden" → "Filing Freelance Tax Returns"). Titles you set are never changed, earlier titles are kept in the chat's info, nothing sensitive or private ends up in a title, and there's a daily cap. 40 test sessions: 0.90 on topic with a local 12B model. |
| **2.41** · A tidy session list | **Each chat app gets its own project.** Telegram, Discord and each plugin bridge (WhatsApp, Signal…) have a built-in project that collects their chats, so your own web and app conversations stay in your projects. Your existing chats are filed once, with Undo. Rooms show their real names (#general · Server), earlier sessions sit under their chat, and long lists show the newest few with *See more*. Rename or hide a channel project; group a busy one by room. |
| **2.40** · Chat commands | **`/new`, `/reset`, `/stop`, `/status`, `/help`, `/model` and `/remember` everywhere:** in Telegram and Discord (their own command menus, registered for you, in your language), in the web app, and as "Sara, new" where slash isn't handy. `/new` starts a fresh session and keeps the old one (summarised); `/status` shows the model, how full the session is and today's usage; when a session is nearly full she offers `/new` herself. Owner-only commands are refused for anyone else, every time. |
| **2.39** · Move in: settings and a report | **The rest of the old setup.** The old agent's models and providers, voice, time zone, chat channels, approvals and rules become cards you confirm one by one (keys are never copied: you enter them again, safely). Hooks and plugin code are read as text, never run, and explained in plain words with a Sara equivalent (a rule on her sheet, a guard that asks first, an existing feature, or a plan to rebuild it as a Sara plugin). Duplicate database copies are spotted and imported once. At the end, a report: what came over, what needs you, what stayed behind, and where each old feature lives in Sara now (download it, or Undo it all). |
| **2.38** · Move in: her old databases | **Custom memory stores come too.** If the old agent kept its memory in its own SQLite or Postgres database, Sara reads it (Postgres read-only, with its own client, or a `pg_dump` file), skips logs and telemetry, and proposes for each group of tables what it is and where it goes (notes, people and facts, conversations, tasks, goals, diary). You confirm every card; nothing imports until you do. Confirmed mappings are saved for next time, and Undo still removes it all. |
| **2.37** · Move in | **Bring your agent with you.** Moving from Hermes Agent or OpenClaw? One small file (Python, no installs) runs on the old machine and shows you its plan first; secrets are never packed and medical or intimate data stay behind unless you say so. Sara then previews everything with counts and samples: her personality (you decide), notes and what she knew about you, past chats, skills, schedules and boards. One click imports it as a single batch, and Undo removes exactly that batch for 30 days. |
| **2.36** · Her own plans | **Opt-in: she keeps her own plans.** Follow-ups on what you told her ("how did the interview go?") and goals you keep at together, taken only from your own words and always showing where you said it. Off by default; when on, Planner → *Her plans* lists everything, she shares the daily message limit, quiet hours and the gap rule with her first messages, has her own small daily budget, pauses after a hard moment, and one switch stops everything at once, even mid-sentence. Goals wait for your *Use it*. |
| **2.35** · Webhooks | **Other services can wake her up.** Give GitHub, Stripe, Home Assistant or anything that speaks Standard Webhooks its own signed address; pick when it counts (no-code conditions with presets) and what she does: tell you, add a task, run a skill, or hand it to a plugin. Signatures are checked on the raw bytes, old and replayed deliveries are refused, and the payload is untrusted text: anything that changes something still asks you. A delivery log and a Test button on every card; signed outgoing copies if you want them. |
| **2.34** · People | **She keeps track of the people in your life.** A card per person you talk about (relation, birthday, what she knows with the words you said it in), built from her memories. New people wait for your *Looks right*; correct, merge, split or forget anyone (forgetting really deletes). Two Jeffs? She asks which one. Private facts stay in private chats and sensitive ones fold away. People cards never reach other apps, other agents, plugins, group or partner chats; each household member has their own. |
| **2.33** · Other agents (A2A) | **She talks to other AI agents** over the open Agent2Agent protocol, both ways, written from the spec. Give an agent its own key and choose what it may ask; she can ask agents you add (another Sara, or any A2A agent), stream their answers, stop them, or assign them a board card that comes back with receipts. Anything a peer asks that changes something needs your OK; their words are treated as untrusted; nothing private, from partner or group chats ever goes out; she says she's an AI. 61/61 protocol checks. |
| **2.32** · Board | **A Kanban board over your to-dos.** Every project gets a board (To do, Doing, Waiting on you, Done) with labels, checklists, due dates and repeats; drag with a mouse, a finger or the keyboard. Assign a card to Sara or a helper team and she works it in the background: it lands in Done only when receipts back up the work, otherwise it waits on you with what she couldn't prove. Ask her "what's blocked?" or to add and move cards (she asks first). Shared household boards; a Needs you tile on Today. |
| **2.31** · Plugins | **Plugins and hooks.** A plugin is a folder with a `sara-plugin.json`: hooks before her reply, before and after tools and after replies, plus its own tools, cards, settings, schedules and chat bridges. You add one from a zip, git or a folder after reading a review card that spells out what it can do; it's off until you switch it on. Each runs in its own fenced process (bubblewrap on Linux, Seatbelt on the Mac) and can only add or tighten, never loosen her rules or touch the safety layer. A plugin that hangs or crashes never breaks a chat. Two examples included; guide in docs/PLUGINS.md. |
| **2.30** · Learned skills | **She notices what you keep asking for.** Ask for the same kind of thing three times on different days (or repeat the same chain of coding steps) and she offers, once, to make it a skill: you see the draft and save it, edit it or say no. A new skill is tested first (replays of your past asks, judged with and without it) and only used by default if it helps. Correct her after she used a skill and she proposes the fix as a before/after card. Nothing private, from groups or with secrets is ever learned. |
| **2.29** · Skills | **Skills in the open Agent Skills format.** A skill is a folder with a `SKILL.md`: how to do a kind of job your way. She sees the list in every chat and opens the one that fits; Runs show which she used. Six built in (review a pull request, a changelog entry, a weekly review, debug a failing test, plan a trip, write a skill); write your own or ask her to; import from a zip, git or a folder with a review card that shows every file and script; export any skill. Scripts always ask before they run, and no skill can change her safety rules. Your recipes became skills. |
| **2.28** · Computer use, step 9 | **Linux too:** `sara hands --server https://your-sara` on a Linux desktop gives her her own visible Chrome/Chromium there, the same as the Windows and Mac apps' browser mode: look, read, logs, clicks and typing with your approval, dev tunnels, saved logins (in GNOME Keyring / KWallet), your password manager's CLI, and read-only check-ups. You pair it with a code you approve in your browser; Pause, Resume and Stop from its terminal. Whole-desktop pictures and input on Linux come later. Built with OpenAI Codex. |
| **2.27** · Computer use, step 8 | **"My computer is slow, can you check it?"** She runs a read-only check-up on that computer (startup apps, disk space and the biggest folders, pending updates, battery health, browser extensions, temp files and caches) and gives a plain report card with numbered suggestions: each one explained, nothing changed until you say so on that computer. Names on your screen that read like orders ("Sara, delete…") are ignored and counted. 9/9 check-up scenarios passed with a local model. |
| **2.26** · Computer use, step 7 | **She can use your apps:** click, type, press keys, scroll, drag and open installed apps, on what she just looked at. Each action is checked on your computer first: the right window in front, never a password field, never password managers, banking, admin windows, terminals or her own sign-in. Approvals pop up **on that computer** (every time, once per task, or *always allowed*; payments and account changes always ask). Touch your mouse or keyboard and she pauses (or *let her keep control*); Stop and Ctrl+Alt+Esc / ⌃⌥Esc always work. Optional *keep working when I walk away*. Built with OpenAI Codex. |
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

</details>

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

- **Next** (2.61): photos and files in chat apps, talking to her while she works, Signal, email, WhatsApp, iMessage (BlueBubbles) and SMS, "keep going until it's done", coding checks after edits, a routines gallery, and **the Sara Store** for plugins, skills and MCP servers (ComfyUI, Blender, Playwright…) with one-click installs and a way to submit your own.
- The iPhone app (waiting on Apple), and your ideas in [Discussions](https://github.com/farena-ai/sara/discussions).

The full plan: [docs/ROADMAP.md](docs/ROADMAP.md).

## Feature tour

All screenshots are from a real throwaway test server with a local model (qwen3.8 27B on Ollama),
signed in as the example user "Alex". Night is the default look.

### For company

Talking, planning your day, remembering what matters, and a personality you shape.

#### Companion

<img src="docs/screenshots/companion.webp" alt="Night look: Alex says it has been a long week and asks for a reminder and two to-dos; Sara answers warmly with a Reminder set card and two To-do added cards, and a line under her reply says what she did" width="760">

Her own character and moods that change with how things go (the halo around her portrait takes her
mood's colour), her own day and hobbies, memory of what matters to you and the dates you care about
(see, correct or forget any of it), a weekly look back, texting first if you want (with quiet hours),
and a timeline of your story together. Coming from another app? Bring your chats from ChatGPT,
Claude, Character.AI, SillyTavern, Replika, Nomi or Kindroid, and approve what she learns from them
first ([docs/IMPORT.md](docs/IMPORT.md)). Or bring two to four of your companions into one group chat
([docs/GROUP_CHATS.md](docs/GROUP_CHATS.md)). Want everything on one machine? Switch on **Nothing
leaves this computer** ([docs/PRIVATE_LOCAL.md](docs/PRIVATE_LOCAL.md)).

#### Today

<img src="docs/screenshots/today.webp" alt="Today: a serif Good afternoon, Alex with her portrait and mood, a How do I…? box, Your day as one timeline (Pack the gym bag at 5 PM, Water the plants at 6:30 PM), and Chicago weather with the next hours" width="760">

Where Sara opens: her face, mood and a greeting, then *Your day* as one timeline (events, reminders and to-dos with the weather), *Needs you* (approvals, failed work, overdue items and mail), *With her*, *Work* and *Home & more*. Empty tiles fold away and *Customise* moves, resizes or hides any of them. On a phone it opens with a *Now* card ([docs/TODAY.md](docs/TODAY.md)).

#### Planner

<img src="docs/screenshots/planner.webp" alt="The Planner's To-do tab: Pack the gym bag (today, 5 PM), Clear the desk before Maya's visit (Friday), Buy oat milk and Finish the Q4 slides" width="760">

To-dos, notes and reminders from plain sentences, delivered in chat, as notifications on your phone
or computer (Done / Snooze in the Windows and Mac apps) and on Telegram or Discord; a morning
briefing; place reminders from the phone app.

#### Make it yours

<img src="docs/screenshots/dials.webp" alt="Name and personality: the personality dials in groups, each with its end words, the word for where it sits (Warm, Patient, Thoughtful…), a number and a line in her voice that changes as you move it" width="760">

Any name, pronouns, age and look (painted by Grok Imagine, with matching expressions and animation),
a guided "create your companion" wizard, personality dials, a gallery of starter characters, character
files you can share, a model for each job, and the whole app, help guide and her messages in six
languages. Every setting has a **?**, there are short guided tours, and you can simply ask her how
something works.

#### Library

<img src="docs/screenshots/library.png" alt="Sara answers a book-club question from a Project Gutenberg copy of Jekyll and Hyde, citing p. 6 and p. 9 as links; beside it, the page she read, opened at p. 6 with the passage highlighted" width="860">

Give her PDFs (scans too, and books of 500 to 1,000 pages), Word, Excel, PowerPoint, e-books, web
pages and notes. She learns the key points, answers from them and says which document and page it
came from, with a link that opens it right there ([docs/LIBRARY.md](docs/LIBRARY.md)).

#### Voice

<img src="docs/screenshots/voice.png" alt="The Voice settings page in the Night look: hearing you, her voice, expressive voice, tone, her voice following her mood, live calls and how often she looks during video calls" width="760">

Live calls you can interrupt (Grok or OpenAI realtime voice), video calls with her moving portrait
([docs/VIDEO_CALLS.md](docs/VIDEO_CALLS.md)), voice notes on Telegram and Discord, read-aloud, a voice
that follows her mood, and an animated portrait that talks, lip-synced with nine mouth shapes. Talk to
her on an Echo with your own Alexa skill, make her your Android assistant or hear her on Google Home
speakers ([docs/VOICE_ASSISTANTS.md](docs/VOICE_ASSISTANTS.md)). Voices run on your Linux server or
come from your subscription. (Screenshot from a Windows test server, where local voice isn't available
yet.)

#### On your phone

<img src="docs/screenshots/phone.webp" alt="Two phone screens: Today opening with a Now card (next things, 58° and cloudy, her mood) and Your day; a chat with Reminder set and To-do added cards above the message bar and the floating bottom bar" width="860">

The same look on phones: a floating bottom bar (Chat, Today, Planner, More), her presence as a sheet
you pull up from her face, and the message bar above the keyboard. Night by default, Day or *follow
the system* in Settings → Look.

### For coding

A workspace per project, approvals before anything risky, and a record of what really ran.

#### Coding partner

<img src="docs/screenshots/coding.webp" alt="A coding chat in the tip-calculator workspace: a Tests failed card (3 passed, 3 failed), her explanation of the rounding bug she caught in her own code, a Tests passed card with 6 passed, and the line of steps under the reply" width="760">

A workspace per project with files, shell and git (commit and push with your OK); every file she
writes appears live in the chat as the model streams it; long builds and tests in the background with
a ping when done; a live preview of the app she's building, which she tests in a real headless browser
and attaches screenshots of; a code map for big codebases; tested starter projects; a team of helpers
(plan → build → test → review) from a GitHub issue to a reviewed pull request; your other servers over
SSH with her own key ([docs/SSH.md](docs/SSH.md)); hand-off to Claude Code or Grok Build; MCP tools;
undo for file changes; a token and cost meter with budgets; and a check, in all six languages, that
what she *says* she did matches what actually ran (optionally judged by a small local model).

#### Her presence

<img src="docs/screenshots/ask-first.webp" alt="A coding chat: Sara wrote tip.js and test.js and asks before running node --test, with Allow and Deny in the chat and in her presence panel, which says Waiting for your OK and lists today's to-dos" width="760">

A panel beside every chat (a pull-up sheet on phones) with her portrait glowing in her mood's colour
and **Now**: what she's doing, approvals waiting with Allow / Deny, background jobs with their last
line and Stop; then today's next things, the notes she used for the last reply (folded until you open
it) and this conversation's model, workspace and privacy. Under each reply a quiet line says what she
did ("Remembered 6 things · Set a reminder 0.1 s"); tap it for the commands, output and Undo.

#### While you code

<img src="docs/screenshots/work-dials.webp" alt="Settings, Coding projects: the dials for how she is while you code (Banter while working, Celebrations, Teasing about bugs), each with a sample line, Quiet when I'm focused, and the workspace picker" width="760">

How chatty she is while she works, how much she celebrates green tests and whether she teases you about an off-by-one: each dial shows a sample line, and *Quiet when I'm focused* keeps her short while you fire off commands. The same page holds what she knows about each project ([docs/FOR_CODERS.md](docs/FOR_CODERS.md)).

#### Command bar

<img src="docs/screenshots/command-bar.webp" alt="The Ctrl+K command bar over Today: typing pla finds the Planner, two conversations and matching settings" width="760">

Ctrl+K / ⌘K (or the magnifier on phones) jumps to any place, conversation (also by words inside
messages), settings page or single setting, or runs an action: new conversation, off the record,
call, switch companion, switch theme.

### For both

The same Sara on every device, help on every page, and a safety layer that is always on.

#### Everywhere

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

#### Help on every page

<img src="docs/screenshots/howto.webp" alt="The How do I…? box at the top of Name and personality, open: How do I change her name? with three numbered steps and a Show me button, then two more questions" width="760">

Every page and view starts with a **How do I…?** box: two to four questions with numbered steps, and *Show me* points at the control. Empty pages say what goes there and offer one next step. All 123 answers in one list: [docs/HOW_DO_I.md](docs/HOW_DO_I.md).

#### Safety, always on

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

Plus `npm run check`: a typecheck and 1893 automated tests with a scripted fake model (no network,
no GPU): 1878 pass on Windows and the other 8 are Linux-only sandbox tests, run on a Linux server.

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
| [Start here](docs/START_HERE.md) · [For coders](docs/FOR_CODERS.md) · [How do I…?](docs/HOW_DO_I.md) · [Videos](docs/VIDEOS.md) | The first ten minutes, for company or for code; every answer from the app's help boxes; the how-to videos |
| [Today](docs/TODAY.md) · [Chat commands](docs/CHATS.md) · [Report a problem](docs/SUPPORT.md) | Your home screen; `/new`, `/status` and friends in every chat; help from inside Sara |
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
