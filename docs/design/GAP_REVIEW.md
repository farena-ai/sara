# Gap review: what Hermes Agent and OpenClaw have that Sara doesn't (yet)

Status: research and design only, 2026-10-31, against Sara 2.42.0 (Phases 1–109 built; 110–113
planned). Nothing in this file is built or scheduled. ROADMAP Phase 114 says the owner then picks
which of these suggestions become the next phases. No code, schema or wording was taken from Hermes
Agent or OpenClaw: this file only names their **features**, from their public docs, with a link for
each claim ([Sources](#sources)). The owner's two real installs are used only at the level of feature
names already written down in [MOVE_IN.md §2.1](MOVE_IN.md) (Stacy = OpenClaw: Telegram, Discord and
A2A channels, 19 plugins, 43 skills, internal hooks, TTS; Ali = Hermes Agent: ~46 skills, 16 plugins,
hooks, cron, kanban, Discord, Telegram, iMessage and WhatsApp bridges). Nobody logged in to either
machine for this review.

**How it was checked.** Sara's side comes from SOURCE_OF_TRUTH, ARCHITECTURE, CHANGELOG 2.0–2.42,
the README tour, ROADMAP through Phase 114, the design files in this folder, and a grep of `src/` and
`web/` for each item (file names are given where they matter). Hermes Agent's and OpenClaw's side
comes from their docs indexes (`llms.txt`) and the feature pages linked below, read on 2026-10-31.
Where a claim rests on a page title or one-line summary rather than the page body, it says
**(unverified: index only)**.

**What counts as a gap.** Features that a coder, a companion user or a beginner would notice and
miss. Many of the big items people associate with these two agents (skills, learned skills,
plugins and hooks, a Kanban board, A2A, webhooks, cron, MCP both ways, an OpenAI-compatible API,
computer use, password-manager logins, model fallback, checkpoints/undo, several agents in one
room, voice notes) **Sara already has**, mostly from the Staples, Computer use and Harness tracks.
They are listed under [What Sara already does as well or better](#3-what-sara-already-does-as-well-or-better),
not here.

**The rules every suggestion keeps.** Written from scratch; zero npm runtime dependencies (outside
programs such as `git`, `ffmpeg`, `signal-cli` or a language server are optional installs, the way
`bwrap` and Ollama are today); the safety layer in `src/safety.ts` and the approval system in
`src/tools/registry.ts` stay mandatory and can only get stricter; household members keep their own
data folder; the privacy gates (private chats, partner and group chats, people cards, private local
mode in `src/net-guard.ts`) apply to every new path; anything scheduled, polled or paid is off by
default and needs the owner's OK (Rule 7).

---

## 1. The gaps at a glance

Effort: **S** = a small release, **M** = one phase, **L** = more than one phase.

| # | Feature | Who has it | What Sara has today | Why it matters (coders / companion / beginners) | Effort | Risk and safety notes |
|---|---|---|---|---|---|---|
| G1 | **Photos and files in chat apps, both ways**: she sees the photo you send on Telegram/Discord, and sends charts, PDFs, her own photos and moments back as native attachments | Both [H1][O1] | Voice notes in and out (`telegram.ts sendVoice`, Discord voice files); documents from the owner go to her library (`takeChatDocument`). Photos are **not** read: Telegram answers "I can only read text and voice notes here for now" (`telegram.ts:446`), Discord filters images out (`discord.ts:745`). Her photos (`photos.ts`) and moments stay in the app | Companion: sharing a picture is half of texting; she already makes selfies and captions. Coders: a screenshot of an error from the phone. Beginners: it "just works" like any chat | S–M | Pictures go to the chosen model only if it can see and private local mode allows it; the minors block and adult setting apply to images and captions; nothing private goes into partner or group rooms; per-file size caps as today |
| G2 | **More chat apps**: WhatsApp, Signal, iMessage, Slack, Matrix, email, SMS and more | Both, 20+ each [H2][O2] | Telegram and Discord built in; any other app as a **plugin bridge** (ST3, `plugins/manager.ts`; one example, `examples/bridges/line-bridge.ts`); CH2 already reserves channel projects for "WhatsApp, Signal…" (`bridges/rooms.ts`) | Companion: people text in WhatsApp and iMessage, not Discord (Ali used both). Beginners: "she's in the app I already use" | L | WhatsApp: the official Cloud API needs a Meta business account and may charge per conversation (owner OK, Rule 7); unofficial WhatsApp Web libraries can get a number banned (our assessment). iMessage needs a Mac (the Mac app). Each bridge keeps the labelled-bot, owner-only-tools and group rules |
| G3 | **Talk to her while she works**: steer a running turn, queue the next message, or ask a quick side question that isn't saved (`/steer`, `/queue`, `/btw`) | Both [H3][O3][O4] | `/stop` and `/reset` everywhere (CH1); Telegram queues turns; the web app refuses a second message ("Sara is busy in that conversation", `server.ts:504`) | Coders: "use the smaller patch" mid-task without stopping her. Beginners: no error when you type twice | S–M | A steer is a normal owner message: it can't approve anything or loosen a rule; only the owner can steer an owner turn |
| G4 | **Keep going until it's done**: a standing goal per chat; after each turn a small judge checks whether it's met and she carries on (`/goal`) | Both [H4][O5] | Budgets that degrade and stop (M4, `budget.ts`), board cards worked in the background with receipts (ST4, `board-work.ts`), helper team; her own life goals (ST8) are a different thing | Coders: "fix every failing test and get it green" without typing "continue" five times | M | Runaway cost: the M4 budget stays a hard ceiling and *Continue with more* stays the owner's; "done" needs receipts (tests ran), not the model's word; Stop always wins |
| G5 | **Repeat this in the chat**: re-run a prompt on a timer inside the current conversation ("check the deploy every 10 minutes and tell me when it changes") (`/loop`, `/heartbeat`) | Hermes [H5][H6]; OpenClaw lists `/loop` [O6] (unverified: command list only) | Planner repeats, webhooks (ST7), her own follow-ups (ST8), background jobs with a ping; nothing that re-runs a prompt with the chat's context | Coders: watching CI or a long job. Everyone: "keep an eye on the price" | S–M | A scheduled, paid model call: off until asked, an end time and a per-loop cap by default, listed in Planner with Stop, counts against the daily budget; quiet hours apply to pings |
| G6 | **Real language-server diagnostics after each edit** (type errors, missing imports), not just tests | Hermes [H7] | She learns each project's build/test/lint commands (`projectknow.ts`), runs tests, security pass (M6), code map; no language server | Coders: catches the error the moment she writes it, cheaper than a test run; helps local models most | M | Language servers are the owner's own installs (detected, never downloaded silently); run inside the workspace sandbox; a missing or crashing server never breaks a write |
| G7 | **@-references in the message**: `@file:src/app.ts:10-25`, `@diff`, `@url:…` with autocomplete | Hermes [H8] | Attachments, the VS Code panel sends the selection, she can read files with tools | Coders: point at exactly what you mean. Beginners: autocomplete shows what's possible | S | Only inside the conversation's workspace; `@url` uses the guarded fetch (`netFetch`) and respects private local mode; content is untrusted text as today |
| G8 | **A lean tool list**: tools load by search when there are many (MCP servers, plugins), instead of every schema every turn | Both [H9][O7] | Every enabled tool, plus every MCP tool, is offered each turn (grep finds no per-turn selection in `chat.ts`; unverified for every path) | Coders with several MCP servers; anyone on a small local model whose context fills with tool schemas | M | Approvals stay in the registry, so hiding a schema can't skip a check; safety-critical tools (approvals, Stop) never deferred |
| G9 | **Tool-loop guard**: after the same tool fails the same way three times, block that exact call and make her change approach | OpenClaw [O8] | A 40-step / 200k-token budget (M4) and recall of past failures (M10); BACKLOG notes an 80-step stop on a real project | Coders: fewer wasted runs. Everyone: lower bills | S | Purely protective; it can only stop a call |
| G10 | **A live progress message in chat apps**: one message that updates ("✅ read the files ▸ running tests") instead of silence until the answer | OpenClaw [O9] | In the web app, a step line under every reply and a presence panel (2.5/2.6); in Telegram/Discord only "typing…" (`telegram.ts:626`) | Everyone: on a phone you know she's working, not stuck. Coders: see the plan | S | No secrets or tool output in the message (the run scrubber `redact.ts` applies); off in group rooms by default |
| G11 | **"When it comes up" reminders** (event-triggered): "next time I mention my mum, ask how the surgery went"; "when the release comes up, remind me about rollback" | OpenClaw "standing intents" [O10] | Time reminders, place reminders (`planner.ts`), presence (arrive, leave, bedtime: `presence.ts`), webhooks, her follow-ups from dates you mention (ST8, `agenda.ts futureMentions`) | Companion: feels like she really listens. Coders: project guardrails that fire on a topic | S–M | Triggers match in code (like the M2 plan check), not by guessing; private ones fire only in private chats; people-card gate for named people; a visible list with *Forget* |
| G12 | **Pick up where we left off across apps**: move from Telegram to the web app and she still has the thread | OpenClaw "main session" [O11] | One conversation per channel by design (CH2), shared memory, she can search past chats (`recall.ts`) | Companion: one relationship, not five chats. Beginners: no "which chat was that in?" | S–M | Owner's private DMs only: never group rooms, partners, household members or other apps; off-the-record chats never carried |
| G13 | **Ready-made routines**: pick "morning brief", "watch a GitHub repo", "weekly money check", fill two fields, confirm | Hermes "automation blueprints" [H10] | Morning briefing, six built-in skills, webhook presets (ST7), coding starters; each set up separately | Beginners: the fastest way to get value. Everyone: shows what she can do | S–M | Each routine shows its schedule and cost class before it's created; nothing scheduled silently (Rule 7); plugins may add routines only after their review card |
| G14 | **A shelf of reviewed skills and plugins** to browse and install by name | Hermes Skills Hub and plugin catalog [H11][H12]; OpenClaw community plugins, skill registry [O12][O13] | Install from a zip, git URL or folder after a review card (ST1, ST3); six built-in skills, three example plugins | Beginners: find, don't build. Coders: share what they wrote | M | Supply chain: a list kept in Sara's own repo (no hosted service), each entry pinned to a commit hash, the same review card, never auto-updated, scripts still ask |
| G15 | **Skill tidy-up**: unused learned skills go stale and are archived (never deleted), near-duplicates are proposed for merging | Both [H13][O14] | Learned skills are offered, tested (M9) and fixed after corrections (ST2); nothing retires them | Everyone: the skill list stays short, prompts stay small | S | Archive is reversible; built-in and imported skills untouched unless the owner says so |
| G16 | **A safety check-up with safe fixes**: "is my setup safe?" (reachable without HTTPS, a chat bridge open to anyone, commands on *auto* without a sandbox, old tokens) with one-click fixes | OpenClaw `security audit --fix` [O15] | `sara doctor` checks health, data folder permissions, backups, and already lists commands that run without asking (`doctor.ts:120`); SECURITY_CHECKLIST is a manual page | Beginners: the five-minute checklist becomes a button. Everyone: fewer foot-guns | S–M | Read-only by default; each fix is a card you approve; it can only tighten |
| G17 | **Hands-free "Hey Sara"** on the computer and phone | Both [H14][O16] | Alexa skill, Android default assistant, Siri intent (in review), quick ask on a shortcut in the desktop apps | Companion: talk from across the room. Beginners: no buttons | M–L | Always-on microphone: off by default, on-device detection only, nothing sent until after the wake phrase, a visible "listening" indicator, one switch off |
| G18 | **Share a whole companion as a pack** (personality, skills, routines, look; no memories, no keys) that others install and update | Hermes "profile distributions" [H15] | Character cards in and out, skill export, move-in bundles (`.saramove`), backups | Companion community: share a character you built. Coders: share a "pair programmer" setup | M | Never memories, chats, people, secrets or private photos; install shows a review card; the persona validator (age ≥ 18, safety boundaries appended) runs on every pack |
| G19 | **Discord voice channels**: join a voice channel and talk live | Hermes [H16] | Live and video calls in the apps, voice notes in Discord | Companion and gaming groups | L | Discord's voice protocol (UDP, Opus, encryption) is heavy to write from scratch; group recording consent; disclosure in voice. Later, beside the planned agent conference calls |
| G20 | **Tidy this chat now** (`/compact`): summarise the older part of a long session in place instead of dropping it | Both [H17][O17] | When history doesn't fit, the oldest part is left out with this chat's summary if one exists (`chat.ts:1937`); `/new` summarises and starts fresh (CH1) | Coders: long debugging sessions keep their thread | S | The summary is a normal summary memory (visible, forgettable); never pulls in other chats |
| G21 | **Editor protocol (ACP)**: use her inside editors that speak the Agent Client Protocol (Zed, JetBrains and others) | Both [H18][O18] | VS Code panel, MCP server for Claude Code / Cursor, `sara-chat` | Coders outside VS Code | M | Same approvals rendered in the editor; same sharing rule as other apps (`other-apps.ts`) |
| G22 | **Code mode**: the model writes a short script that calls several tools, and only the result returns | Both [H19][O19] | None | Coders on big multi-step jobs; saves tokens | M–L | Every tool call from the script must go through the same registry, approvals and sandbox; listed for completeness, not recommended yet (§2) |
| G23 | **Agent-made widgets**: a small live panel or Today tile she builds ("my build status", "stock I'm watching") | OpenClaw [O20] (unverified: index only) | Result cards (`cards.ts`), Today tiles (TD1/TD2 planned) | Everyone, after Today is rethought | M | Untrusted HTML in a sandboxed frame with a strict content policy; no network except through her server |

---

## 2. Ranked suggestions

Nineteen suggestions, numbered by the order I'd build them in (value for effort, beginners first),
then grouped. Each says what it is in plain words, which parts of Sara it uses (no parallel
architecture), and how it stays simple on screen. G21–G23 are left out on purpose: ACP and code mode
help a smaller group than the items below, and widgets should wait for TD1/TD2.

### Companion

**#1 · Photos and files in Telegram and Discord, both ways** (G1, S–M)
- *Pitch:* send her a photo and she sees it; ask for a chart, a PDF or a picture of her and it
  arrives as a picture or a file, like any other contact.
- *Fits:* the bridges already download documents (`takeChatDocument`) and send voice
  (`sendVoice`, Discord `files[0]`); images join the same path into the turn's image input the web
  app already uses (`buildHistory` `loadImage`); outgoing files come from tool results that already
  produce files (workspace, `photos.ts take_photo`, moments, library). Telegram `sendPhoto` /
  `sendDocument`, Discord attachments.
- *Simple UI:* nothing to set up. One line in Settings → Chat apps: *Send me pictures and files here*
  (on). In groups, off unless the owner turns it on per room.

**#3 · More chat apps, as first-party plugin bridges** (G2, L; split into phases)
- *Pitch:* she's in the app you already text in. Order by value and risk: **Signal** (through the
  owner's own `signal-cli`), **email** (her own mailbox over IMAP/SMTP, written on `node:tls`),
  **Matrix**, then **WhatsApp** (official Cloud API only, with the owner's OK on cost) and
  **iMessage** through the Mac app.
- *Fits:* ST3 plugin bridges and CH1/CH2 were built for exactly this: each bridge gets the chat
  commands, its own channel project, keep-up (CH4) and the bridge rules (`bridges/rules.ts`).
  Shipping them as signed, built-in plugins keeps the core small and each one fenced.
- *Simple UI:* Settings → Chat apps shows a card per app with *Connect*, a three-step guide with
  pictures, and a *Test* button; nothing appears until it's connected.

**#5 · "When it comes up" reminders** (G11, S–M)
- *Pitch:* "next time I mention Jeff's wedding, remind me to RSVP". She keeps it until the topic
  comes up, then brings it up once.
- *Fits:* a new kind in the planner next to place reminders (`planner.ts placeEvent`); matched in code
  per turn the way M2 matches decisions (`contradict.ts`); named people resolve through People
  (ST6); shown in Planner → *Her plans* with ST8's daily cap.
- *Simple UI:* she offers it as a card when you say "next time…" (*Keep it / No*); a "When it comes
  up" list in Planner with Forget.

**#12 · Pick up where we left off across apps** (G12, S–M)
- *Pitch:* start on Telegram on the bus, open the app at home, and she knows what you were just
  talking about.
- *Fits:* not one merged conversation (CH2's tidy lists stay); instead, the first turn in a new place
  within a few hours gets a short "just before, on Telegram: …" note built from the last exchange,
  the same way CH4 builds "what's happening now". Uses `recall.ts` sharing rules.
- *Simple UI:* one switch in Settings → Chats (*Carry our last conversation between apps*, on for the
  owner's private chats), and a small "continued from Telegram" chip she can show.

**#17 · "Hey Sara", hands-free** (G17, M–L)
- *Pitch:* say "Hey Sara" to the computer or the Android phone and talk.
- *Fits:* the desktop apps' quick ask window and the live call path (`live.ts`, `voice.ts`); the
  phone's assistant entry (Phase 72). Detection must run on the device (the OS speech services or a
  small model shipped with the native app, not an npm package).
- *Simple UI:* off by default; one switch per device with a clear "listening for Hey Sara" dot;
  saying "stop" ends it.

**#18 · Share a companion as a pack** (G18, M)
- *Pitch:* turn a companion you made (her character, look, voice settings, skills, routines) into one
  file or git repo others can install and update, without any of your memories.
- *Fits:* extends character cards (`character-cards.ts`, `characterfile.ts`) and the skill export
  (ST1), with the move-in bundle reader's preview-and-batch-Undo pattern (MI1).
- *Simple UI:* *Share her* on the companion page shows exactly what's in the pack (a checklist with
  memories, chats and keys greyed out and locked).

### Coders

**#2 · Talk to her while she works: steer, queue and side questions** (G3, S–M)
- *Pitch:* while she's busy, type "use pnpm, not npm" and she takes it into account at the next step;
  or queue the next thing; or ask "what does that error mean?" without adding it to the session.
- *Fits:* the turn loop already checks Stop between steps (`stopTurn`); a steer note is added at the
  same point as an owner line; queueing reuses the Telegram turn queue for every surface;
  `/btw` runs one cheap turn with the session as read-only context and stores nothing. Commands
  join CH1 (`bridges/commands.ts`).
- *Simple UI:* the composer stays open while she works; Send becomes *Tell her now* with a small menu
  (*Now*, *After this*, *Just asking*). Same words as slash commands in chat apps.

**#6 · Keep going until it's done** (G4, M)
- *Pitch:* "get all the tests green" becomes a goal on the chat; she works, checks, and keeps going
  until it's met, stuck, or out of budget, then tells you which.
- *Fits:* the judge is the existing quick-model call (`cheap.ts`) plus receipts (`receipts.ts`) and
  the claim check, so "done" means the tests actually ran green; the M4 budget is the ceiling; board
  cards (ST4) can carry the same goal in the background.
- *Simple UI:* a *Keep going until…* chip above the composer with the goal, a progress ring and Stop;
  `/goal` in chat apps.

**#7 · Language-server diagnostics after each edit** (G6, M)
- *Pitch:* she sees type errors and missing imports the moment she writes a file, before running
  tests.
- *Fits:* a small LSP client (JSON-RPC over stdio, no dependency) beside the code map
  (`src/codemap/`); servers detected per project by `projectknow.ts` (typescript-language-server,
  pyright, gopls, rust-analyzer…); results feed the step after the write and the run record (M3).
- *Simple UI:* nothing to set; Settings → Abilities → Coding lists the servers found, with *How to
  install* links for missing ones. A "2 type errors, fixed" line under the reply.

**#9 · @-references** (G7, S)
- *Pitch:* type `@` to pick a file, a line range, your uncommitted changes, recent commits or a web
  page, and it's attached to the message.
- *Fits:* workspace tools (`tools/workspace.ts`, git), the guarded fetch, the library's page reader;
  the VS Code panel's selection becomes `@file:…:10-25`.
- *Simple UI:* an `@` menu in the composer with plain names (*a file*, *my changes*, *a web page*);
  chips you can remove before sending.

**#13 · A lean tool list for many tools** (G8, M)
- *Pitch:* with several MCP servers or plugins, she sees a short list and looks up the rest when
  needed, so small local models keep room to think.
- *Fits:* the registry (`tools/registry.ts`) already knows each tool's source; MCP tools
  (`tools/mcp.ts`) and plugin tools become searchable through one *find a tool* entry; the skill
  catalog already uses this pattern (names always, bodies on demand).
- *Simple UI:* automatic above a threshold; a line in the run view says which tools were looked up.

**#14 · Repeat this in the chat** (G5, S–M)
- *Pitch:* "every 10 minutes, check the deploy and tell me when it changes" runs inside the chat with
  its context, until it's done or the end time.
- *Fits:* the job manager (`jobs.ts`) and the planner's repeat timer; each tick is a normal turn with
  the budget; results that change nothing stay quiet.
- *Simple UI:* she proposes it as a card (every …, until …, about N model calls); it shows on Today
  under background work with Stop.

**#19 · Tidy this chat now** (G20, S)
- *Pitch:* `/compact` folds the older part of a long session into a summary right now, so the thread
  stays in view.
- *Fits:* the summary memory kind and the CH1 `/new` summariser; `buildHistory` uses the summary for
  the dropped part (it already does when one exists).
- *Simple UI:* when the context ring is nearly full, she offers *Tidy this chat* next to `/new`.

### Everyone and beginners

**#4 · A live progress message in Telegram and Discord** (G10, S)
- *Pitch:* during a long job you see one message that updates with what she's doing, then turns into
  the answer.
- *Fits:* the same events that draw the web app's step line (`ChatEvent` tool and approval events);
  Telegram `editMessageText`, Discord message edit; approvals keep their buttons.
- *Simple UI:* on for long turns only (over ~10 seconds), in private chats; a switch per chat app.

**#8 · Ready-made routines** (G13, S–M)
- *Pitch:* a gallery: *Morning brief*, *Watch my GitHub repo*, *Bedtime wind-down*, *Weekly review*,
  *Remind me to stretch*. Pick one, answer two questions, confirm.
- *Fits:* each routine is a skill (ST1) plus a schedule (planner repeat) or a webhook (ST7) or a
  presence event; plugins can add routines (ST3). No new engine.
- *Simple UI:* Today's empty state and the Planner offer *Add a routine*; each card says when it runs
  and roughly what it costs.

**#15 · A shelf of reviewed skills and plugins** (G14, M)
- *Pitch:* browse a list of good skills and plugins (with what each can do) and install one by name.
- *Fits:* a catalog file in Sara's own repository, read by the existing import path and review card
  (ST1/ST3), each entry pinned to a commit; updates are offered, never applied by themselves.
- *Simple UI:* Skills and Plugins pages get a *Browse* tab with categories, a search box and badges
  (*built-in*, *reviewed*, *community*).

### Reliability and ops

**#10 · Tool-loop guard** (G9, S)
- *Pitch:* if she tries the same thing three times and it fails the same way, Sara blocks that exact
  call and makes her change course or ask you.
- *Fits:* the run record (`runs.ts`) and the M10 signatures (`triggers.ts sigOf`) already identify "the
  same call, the same error"; the block is a guard in the tool loop, like the plan check.
- *Simple UI:* a quiet line in the run view; in chat she says what she'll try instead.

**#11 · A safety check-up with safe fixes** (G16, S–M)
- *Pitch:* Settings → Data & health → *Check my safety*: a plain report card (reachable without HTTPS,
  Telegram open to strangers, commands on *auto* without a sandbox, owner token never rotated, no
  off-server backup) with a *Fix* button on each.
- *Fits:* grows `sara doctor` (`doctor.ts`), which already checks some of this, and turns
  SECURITY_CHECKLIST into checks; fixes are approval cards.
- *Simple UI:* a green/amber/red list, one sentence each; the same report from `sudo sara doctor`.

**#16 · Skill tidy-up** (G15, S)
- *Pitch:* learned skills nobody used for 60 days move to *Archived*, and two skills that do the same
  job are offered as one.
- *Fits:* `skill-store.ts` usage counts and ST2's before/after card for the merge; Archive is a
  status, not a delete.
- *Simple UI:* a monthly card ("3 skills haven't been used: archive them?") and an *Archived* fold on
  the Skills page.

---

## 3. What Sara already does as well or better

So the comparison is fair. "Better" here means more complete or safer for Sara's audience, not
more features overall.

- **Safety that can't be turned off.** AI disclosure, honesty when sincerely asked, crisis help and
  the minors block run in code around every model call (`safety.ts`), whatever a persona, plugin or
  skill says. Both other agents leave persona and safety mostly to configuration and the model.
- **Proof, not claims.** Receipts and the six-language claim check (with an optional local judge),
  run snapshots, time-travel branches, evals with a sign test, sandbox-first runs with a change
  card, a security pass, threat model and red-team mode that keep only findings that quote the line
  (Harness track). Hermes and OpenClaw have checkpoints and reviews; neither documents this chain of
  evidence.
- **Memory you can see and trust.** Ranked recall with *why it came to mind*, decay and pins, people
  cards with source quotes and privacy gates, a contradiction stop before acting, imports reviewed
  before saving.
- **A companion, not just an agent.** Moods, her own day and threads, a talking and moving portrait,
  video calls, moments with her captions, a voice that follows her mood, group chats of several
  companions, her own opt-in plans with caps and quiet hours. Hermes has personalities and mascot
  pets [H20]; OpenClaw has SOUL/IDENTITY files and dreaming [O21]; neither ships a companion app.
- **One look on every device.** Web/PWA, Windows and Mac apps, Android (live) and iPhone, quick ask,
  notifications with Allow/Deny, all in six languages. The others are CLI/TUI-first with a dashboard
  and desktop app, and more channels.
- **Household mode.** Isolated adults on one server, owner sees usage only. OpenClaw has multi-user
  and team modes [O22]; Hermes has profiles and bots [H21]; Sara's is the one built for a home.
- **Private local mode at one gate.** One switch, enforced in `net-guard.ts`. Both others can run
  local models; neither documents a single code-enforced "nothing leaves" gate (unverified beyond
  the docs read).
- **Computer use with approvals on your own screen**, blocked windows, password-manager fill-only,
  takeover and Stop. Both others have computer use and credential vaults [H22][O23]; Sara's
  approvals live on the device being driven.
- **A library that cites pages** for 1,000-page books, and **moving in** from both Hermes Agent and
  OpenClaw (MI1–MI3). Each of them can import the other [H23][O24]; neither imports companion-app
  histories.
- **Small and readable.** TypeScript Node runs directly, zero runtime dependencies.

Where they are clearly ahead and Sara shouldn't chase: dozens of chat platforms and model providers,
a large plugin and skill ecosystem, terminal UIs, cloud deployment templates (Fly, Railway,
Kubernetes), mixture-of-agents, music and video generation, and enterprise chat (Teams, Slack,
WeCom). Suggestion #3 takes only the chat apps a companion user actually uses.

---

## 4. Recommended order after Phase 114

One release each, in this order. Each needs the owner's OK before it goes on the ROADMAP (Rule 9),
and any paid or scheduled part needs it separately (Rule 7). Versions assume Phase 114 is 2.46.0.

| Phase | Version | What | Suggestions |
|---|---|---|---|
| 114 | 2.47.0 | Chat apps catch up: photos and files both ways, live progress message | #1, #4 |
| 115 | 2.48.0 | Talk while she works: steer, queue, `/btw`, plus the tool-loop guard | #2, #10 |
| 116 | 2.49.0 | Signal and email bridges (first-party plugins) | #3 part 1 |
| 117 | 2.50.0 | Keep going until it's done, and repeat-in-chat loops | #6, #14 |
| 118 | 2.51.0 | "When it comes up" reminders and pick up across apps | #5, #12 |
| 119 | 2.52.0 | Coding precision: language-server diagnostics and @-references | #7, #9 |
| 120 | 2.53.0 | Beginner setup: routines gallery and the safety check-up | #8, #11 |
| 121 | 2.54.0 | WhatsApp (official API, owner OK on cost), Matrix, iMessage via the Mac app | #3 part 2 |
| 122 | 2.55.0 | Big tool sets: lean tool list and `/compact` | #13, #19 |
| 123 | 2.56.0 | The shelf and skill tidy-up | #15, #16 |
| 124 | 2.57.0 | "Hey Sara" on desktop and Android | #17 |
| 125 | 2.58.0 | Companion packs | #18 |

Parked (re-check later): ACP editor protocol (G21; unparked as EC14, built on branch `hermes/ec14`), code mode (G22), agent-made widgets after TD1/TD2
(G23), Discord voice channels next to the agent conference calls idea (G19).

---

## Sources

Read 2026-10-31. Hermes Agent docs index: https://hermes-agent.nousresearch.com/docs/llms.txt ·
OpenClaw docs index: https://docs.openclaw.ai/llms.txt · repos https://github.com/NousResearch/hermes-agent
and https://github.com/openclaw/openclaw.

**Hermes Agent**
- [H1] Deliverable Mode (files as native attachments in chat apps) — https://hermes-agent.nousresearch.com/docs/user-guide/features/deliverable-mode
- [H2] Messaging overview (Telegram, Discord, Slack, WhatsApp, Signal, SMS, Email, Matrix, iMessage via BlueBubbles/Photon, Teams…) — https://hermes-agent.nousresearch.com/docs/user-guide/messaging
- [H3] Slash commands (`/steer`, `/queue`, `/btw`, `/goal`, `/loop`, `/heartbeat`, `/compress`, `/rollback`, `/blueprint`, `/wake`) — https://hermes-agent.nousresearch.com/docs/reference/slash-commands
- [H4] Persistent Goals (`/goal`, judge model after each turn, turn budget) — https://hermes-agent.nousresearch.com/docs/user-guide/features/goals
- [H5] Recurring Loops (`/loop`) — https://hermes-agent.nousresearch.com/docs/user-guide/features/loops
- [H6] Session Heartbeats (`/heartbeat`) — https://hermes-agent.nousresearch.com/docs/user-guide/features/heartbeat
- [H7] LSP — Semantic Diagnostics (language servers feed the post-write check) — https://hermes-agent.nousresearch.com/docs/user-guide/features/lsp
- [H8] Context References (`@file`, `@folder`, `@diff`, `@staged`, `@git`, `@url`) — https://hermes-agent.nousresearch.com/docs/user-guide/features/context-references
- [H9] Tool Search — https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search
- [H10] Automation Blueprints Catalog (pick, fill fields, confirm; never scheduled silently) — https://hermes-agent.nousresearch.com/docs/reference/automation-blueprints-catalog
- [H11] Skills System (Skills Hub, agentskills.io, install from the website) — https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- [H12] Plugin Catalog (curated, human-reviewed, pinned commit) — https://hermes-agent.nousresearch.com/docs/user-guide/features/plugin-catalog
- [H13] Curator (usage tracking, active → stale → archived, never auto-deletes) — https://hermes-agent.nousresearch.com/docs/user-guide/features/curator
- [H14] Wake Word ("Hey Hermes", on-device, off by default) — https://hermes-agent.nousresearch.com/docs/user-guide/features/wake-word
- [H15] Profile Distributions: Share a Whole Agent — https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions
- [H16] Voice Mode (live conversations in Discord voice channels) — https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode
- [H17] Context Compression & Caching (unverified: index only) — https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching
- [H18] ACP Host Integration — https://hermes-agent.nousresearch.com/docs/user-guide/features/acp
- [H19] Code Execution (programmatic tool calling, `execute_code`) — https://hermes-agent.nousresearch.com/docs/user-guide/features/code-execution
- [H20] Personality & SOUL.md; Pets (unverified: index only) — https://hermes-agent.nousresearch.com/docs/user-guide/features/personality · https://hermes-agent.nousresearch.com/docs/user-guide/features/pets
- [H21] Profiles; Bot Mode (unverified: index only) — https://hermes-agent.nousresearch.com/docs/user-guide/profiles · https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode
- [H22] Computer Use; Passwords & Logins (unverified: index only) — https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use · https://hermes-agent.nousresearch.com/docs/user-guide/features/credential-vault
- [H23] Import from Other Agents / Migrate from OpenClaw (unverified: index only) — https://hermes-agent.nousresearch.com/docs/user-guide/import-from-other-agents · https://hermes-agent.nousresearch.com/docs/guides/migrate-from-openclaw

**OpenClaw**
- [O1] Image and media support; Media understanding (unverified: index only) — https://docs.openclaw.ai/nodes/images · https://docs.openclaw.ai/nodes/media-understanding
- [O2] Chat channels (Discord, Google Chat, iMessage, Matrix, Teams, Signal, Slack, Telegram, WhatsApp, SMS, Zalo…) — https://docs.openclaw.ai/channels
- [O3] Steer (`/steer`, `/tell`; versus `/queue`, `/followup`) — https://docs.openclaw.ai/tools/steer
- [O4] BTW side questions (`/btw`, not added to history) — https://docs.openclaw.ai/tools/btw
- [O5] Goal (durable per-session objective, continues after a turn, token budgets) — https://docs.openclaw.ai/tools/goal
- [O6] Slash commands (lists `/loop`, `/compact`, `/btw`, `/steer`, `/goal`) — https://docs.openclaw.ai/tools/slash-commands
- [O7] Tool Search (experimental) — https://docs.openclaw.ai/tools/tool-search
- [O8] Tool-loop detection (three identical tool errors block that call) — https://docs.openclaw.ai/tools/loop-detection
- [O9] Progress drafts (one channel message updated while the agent works) — https://docs.openclaw.ai/concepts/progress-drafts
- [O10] Standing intents (event-conditioned future actions) — https://docs.openclaw.ai/concepts/standing-intents
- [O11] The main session (one rolling conversation across all DMs) — https://docs.openclaw.ai/concepts/main-session
- [O12] Community plugins (unverified: index only) — https://docs.openclaw.ai/plugins/community
- [O13] Skills CLI (`search/install/update/verify`; unverified: index only) — https://docs.openclaw.ai/cli/skills
- [O14] Skill Workshop (learned skills, 30-day unused archive, undo) — https://docs.openclaw.ai/tools/skill-workshop
- [O15] Security CLI (`openclaw security audit --fix`) — https://docs.openclaw.ai/cli/security
- [O16] Voice wake (global wake words across nodes) — https://docs.openclaw.ai/nodes/voicewake
- [O17] Compaction (unverified: index only) — https://docs.openclaw.ai/concepts/compaction
- [O18] ACP agents (unverified: index only) — https://docs.openclaw.ai/tools/acp-agents
- [O19] Code Mode (unverified: index only) — https://docs.openclaw.ai/tools/code-mode
- [O20] Show widget; Session dashboards (unverified: index only) — https://docs.openclaw.ai/tools/show-widget · https://docs.openclaw.ai/web/dashboards
- [O21] Dreaming (background memory consolidation, Dream Diary) — https://docs.openclaw.ai/concepts/dreaming
- [O22] Multi-user mode; Team setup (unverified: index only) — https://docs.openclaw.ai/concepts/multi-user · https://docs.openclaw.ai/start/teams
- [O23] Computer use; Secrets tool (unverified: index only) — https://docs.openclaw.ai/nodes/computer-use · https://docs.openclaw.ai/tools/secrets
- [O24] Migrating from Hermes (unverified: index only) — https://docs.openclaw.ai/install/migrating-hermes
