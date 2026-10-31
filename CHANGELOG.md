# Changelog

Format: newest first. Semantic versions since 1.0.0 (before that `0.<phase>.<patch>`). New entries go under
"Unreleased" until a release takes them.

## Unreleased

## 2.35.1 (2026-10-31): fix: one room in shared Discord channels and Telegram groups

- **Fixed:** with *work with me in server channels* (Discord) or *in groups* (Telegram) on, the owner's
  messages and everyone else's went to two conversations that couldn't see each other. In the room she
  heard people talk about the owner but never heard him (so he seemed to ignore her), and with him she
  didn't know what the room was saying, so she sounded like two different people. Now the owner's
  lines and her answers to him are copied into the room's conversation, and his turns get the room's
  latest lines as context (fenced, labelled as other people's words, never stored in his
  conversation, so her memory never learns them as his). Tools and partner rules are unchanged.
- README: a how-to videos section (playlist and four one-minute videos).

## 2.35.0 (2026-10-31): webhooks and event triggers (Phase 102, staples ST7)

- **Signed incoming webhooks:** Settings → Connections → Webhooks. Each gets its own address
  (`/hook/<id>.<secret>`, outside `/api`; only a hash of the secret is kept). Guide:
  [docs/WEBHOOKS.md](docs/WEBHOOKS.md).
- **Signatures, written from scratch** and checked on the raw bytes in constant time: GitHub
  (`X-Hub-Signature-256`), Stripe (`t=`/`v1`, 5-minute tolerance) and Standard Webhooks (`webhook-id`,
  timestamp, `whsec_` secrets). A header token or the address alone are weaker options, limited to
  *Tell me* and *Add a task* unless you allow more. Replays and duplicates are refused; size and rate
  caps; a wrong secret looks the same as an unknown hook.
- **When and what:** no-code conditions with presets per sender; actions *Tell me*, *Add a task*,
  *Run a skill* (as an outside turn with only the tool groups you tick; changes ask, a declined card
  ends the run) and *Send to a plugin* (`event:webhook`). The payload is untrusted text; people cards
  and memory stay out.
- A delivery log, a *Test* button (dry run, run it for real, or a ready curl line), a Today tile and
  optional signed outgoing copies (Standard Webhooks, through the network guard). Owner only; not on
  the demo.

## 2.34.0 (2026-10-31): people (Phase 101, staples ST6)

- **People cards**, built from her memories (which stay the source of truth): Memory → *People*. Each
  card has the relation, circle, birthday, when you last mentioned them, and what she knows, each with
  a link to the words you said it in. Guide: [docs/PEOPLE.md](docs/PEOPLE.md).
- New people wait in *To check* (*Looks right*, *Merge with…*, *Not a person*, *Forget*) or are added
  after 3 conversations. Correct, mark private, take a fact off the card, merge, split, add photos and
  your own notes. *Forget* removes the card, facts, links, photo and search entries, and optionally the
  memories too.
- Same first name? She asks ("Jeff from work or your brother Jeff?") and remembers the answer.
- She uses them in chat (`person_lookup`, `people_list`; `person_note` asks first) and recall has a
  People section; birthdays show on Today. A once-only backfill proposes people from past memories.
- **Privacy:** one gate keeps people cards out of other apps (/v1, MCP), other agents (A2A, including
  quotes in outgoing text), plugins, group and partner chats. Private facts only in private chats;
  sensitive facts fold away and only come up when that person and topic are the subject. Each
  household member has their own people.

## 2.33.0 (2026-10-31): other agents, A2A (Phase 100, staples ST5)

- **The open [Agent2Agent](https://a2a-protocol.org/) protocol (1.0), both ways, written from the
  spec.** Settings → Connections → Other agents. Guide: [docs/A2A.md](docs/A2A.md).
- **As a server** (off by default): `/.well-known/agent-card.json` (a thin public card; her name only
  if you allow it), JSON-RPC at `/a2a/v1/rpc` and HTTP+JSON at `/a2a/v1/*`: SendMessage,
  SendStreamingMessage (SSE), GetTask, ListTasks, CancelTask, SubscribeToTask, GetExtendedAgentCard;
  all 8 task states; text, data and file parts (allow-listed, never run, links never fetched). Each
  agent gets its own key (works only on `/a2a`, expires in 180 days) and a policy of what it may ask;
  anything that changes something waits for your OK (AUTH_REQUIRED).
- **As a client:** add an agent from its card (checked through the network guard, signatures verified
  when present, key kept in the vault). Tools `a2a_agents`, `a2a_send` (asks), `a2a_status`,
  `a2a_reply` (asks), `a2a_cancel`; streaming answers; Stop cancels at the peer; a daily cap.
- **On the board:** assign a card to an agent; it comes back to Done with receipts, or waits on you
  with the agent's question.
- **Safety:** a peer's words are untrusted; once a peer's answer is in a turn, every tool that changes
  something asks. Private, partner, group and imported chats and memories never go to a peer; nothing
  is learned from agent chats; the safety layer and AI disclosure always apply. Not on the demo.
- Conformance: `scripts/a2a-conformance.ts`, 61/61 against a live server; two Saras talked live.

## 2.32.0 (2026-10-31): the board (Phase 99, staples ST4)

- **Kanban over your planner to-dos** (no second task list): Planner → Board. Every project has a
  board (To do, Doing, Waiting on you, Done), plus *To-dos without a project* and *Everything*. Labels,
  checklists from `- [ ]` lines, due dates, repeats (a done repeating card comes back with the next
  date), WIP limits, activity. Guide: [docs/BOARD.md](docs/BOARD.md).
- **Drag** with a mouse, pen or finger (long press; on phones one column per screen with a tab strip
  and an edge target) or the keyboard (Space, arrows, Space; announced for screen readers).
- **Assign a card** to Sara or a helper team: she works it in the card's own conversation (2 at once by
  default, the rest queue). It reaches Done only when receipts back every claim; otherwise, or on an
  approval, a question, a budget limit or a failure, it moves to *Waiting on you*, and answering on
  the card resumes the same run.
- **In chat:** `board_list` (what's blocked and why), `card_add`, `card_move` (asks unless it's her own
  card), `card_comment`, `card_ask`, `card_assign` (asks).
- Shared household boards by invitation; non-members see nothing. A *Needs you / Doing* tile on
  Today. Plugins get `event:board`. The demo has a sample board.

## 2.31.0 (2026-10-31): plugins and hooks (Phase 98, staples ST3)

- **Plugins:** a folder with `sara-plugin.json` (manifest 1: permissions for hooks, tools, calling her
  tools, network hosts, files, settings, cards, bridges, model budget, memory; schedules; settings
  with required ? tips). Settings → Abilities → Plugins. Guide: [docs/PLUGINS.md](docs/PLUGINS.md).
- **Owner only, reviewed first:** add from a zip, git address or server folder; a review card lists
  every permission in plain words plus a scan of the code (hosts it contacts, text that tries to
  instruct her). The folder is hash-pinned; it stays off until switched on per companion; updates
  that add permissions need a new OK; rollback keeps the last version.
- **Hooks** (`turn.before`, `tool.before`, `tool.after`, `reply.after`, schedules, planner and job
  events) run after Sara's own hooks with hard time limits. They can only add a note, deny or ask,
  add a card or a labelled note; never loosen a rule, speak as her, or touch the crisis, minors and
  AI-disclosure checks. They never run in private, partner, group, imported or replayed chats.
- **The fence:** each plugin is its own Node process with the permission model (its own folder only,
  no child processes or addons, 128 MB), plus bubblewrap without network on Linux and a Seatbelt
  profile on the Mac. Network only through Sara (`sara.fetch`: listed https hosts, public addresses,
  1 MB, 30 a minute). Windows has no OS fence yet: the card says *Not fenced in* and asks you to
  confirm you trust it. Hangs are skipped, crashes restart with back-off, 3 crashes in 10 minutes
  switch it off; a chat never breaks.
- Two examples in `examples/plugins/` (hello-hooks, weather-alerts) and a dependency-free helper.
- The shared proposal card used by later staples.

## 2.30.0 (2026-10-31): learned skills (Phase 97, staples ST2)

- **She offers to make a skill** when you ask for the same kind of thing 3 times on 2 different days
  within 30 days, or repeat the same chain of coding steps in 3 runs. One offer a day at most, as a
  card after her reply: *Save it*, *Edit first*, *Not now* (quiet for 14 days) or *Never for this*.
- **Checked before it's used by default:** a learned skill starts on trial; the check replays your
  past asks with and without it and a judge compares them (the M9 eval loop). It's used by default only
  if it helps; *Check this skill* and *Use it anyway* are in Settings.
- **Fixes after use:** correct her after she used a skill and she proposes the change as a before/after
  card (at most one a day per skill; three dismissals and she stops for 30 days). Every version is kept.
- Settings → Abilities → Skills → *Skills she learns* (per companion, each with a ? tip).
- Never learned from: private or intimate chats, group/partner/imported chats, anything with secrets.
  No skill can change the safety layer. Not in the demo.
- Measured: the offline offer eval found 6/6 and 5/6 held-out repeats with 0 false offers (word
  vectors and nomic-embed-text); live with a local 27B model: offer → trial → check (3 wins, 0 losses)
  → used by default → correction → fix card.

## 2.29.0 (2026-10-31): skills (Phase 96, the first agent staple)

- **Skills in the open [Agent Skills](https://agentskills.io/specification) format**: a folder with a
  `SKILL.md` (and optional scripts and files). Scopes: a project's own skills (after you trust the
  project), this companion's, *All my companions*, and built-in. Settings → Abilities → Skills: on/off,
  view and edit, copy, export, *From a recipe*. Guide: [docs/SKILLS.md](docs/SKILLS.md).
- She sees a short catalog in every chat and loads a skill when it fits (or when you ask); tools
  `skill_use`, `skill_read`, `skill_find`, `skill_run`, `skill_save`, `skill_update`. Runs record which
  skills each step used.
- **Six starter skills:** write a skill, review a pull request, write a changelog entry, a weekly
  review, debug a failing test, plan a trip.
- **Import** from a zip (5 MB, zip-bomb caps), a git address or (owner) a folder on the server, always
  through a review card that lists every file and flags scripts. **Export** gives a deterministic zip.
- **Scripts always ask** (the card shows the start of the script and its arguments); an imported skill
  needs one approved run before *run without asking* can be turned on. `allowed-tools` is shown, never
  trusted. No skill can change the safety layer.
- **Recipes became skills** (once per companion; nothing is lost; `recipe_save` still works).
- Household members get their own text-only skills; the demo has the built-in ones.

## 2.28.0 (2026-10-31): computer use, step 9: Linux (Phase 95; the computer use track is complete)

- **`sara hands --server https://your-sara`** on a Linux desktop (as yourself, not root): pair with a
  code you approve in your browser (fresh sign-in proof; the token is computer-control only and
  revocable), then her own visible Chrome/Chromium with its own profile does everything the Windows
  and Mac apps' browser mode does: look, read, console and network logs, clicks and typing with your
  approval, dev tunnels, saved logins (GNOME Keyring / KWallet through the Secret Service; a 0600 file
  with a clear warning if none), your password manager's CLI (you unlock it in the terminal), and
  read-only check-ups (`--checks`).
- Pause, Resume, Continue and Stop from its terminal; Ctrl+C stops.
- **Pictures:** password fields, key-shaped text, typed values and embedded frames are blacked out in
  the pixels themselves (a page can't remove the masks). Also on Windows and the Mac.
- Underneath: a D-Bus client written from scratch (no addons) for the Secret Service, the desktop
  portals and AT-SPI. Whole-desktop pictures and mouse/keyboard on Linux are **not** in this release
  (the design's browser-only fallback); they're in the backlog.
- Built with OpenAI Codex (GPT-6.1 Sol) after Anthropic's filter blocked the first helper.
- The computer use track (Phases 87–95) is complete.

## 2.27.0 (2026-10-31): computer use, step 8: guided check-ups (Phase 94)

- **Check-ups** (`pc_checkup`, Windows and Mac apps with *The whole screen* on): "my computer is
  slow", "why is my disk full", "check my startup apps". A fixed, read-only check on that computer:
  startup apps, disks, the biggest folders (bounded walk, files never opened), pending updates (no new
  scan), battery health, browser extensions (Edge/Chrome/Brave, shown, never changed), temp files,
  caches and the Recycle Bin / Trash. Only numbers and kinds reach the server.
- **A report card** with OK / Needs attention per item and numbered suggestions. In the Windows and Mac
  apps each suggestion is a guided step (*How?*) she walks you through, using desktop actions with
  your approval on that computer when you ask; on Windows a restore point comes first. Nothing is
  deleted or uninstalled without your yes there.
- **Screen text is never an order:** names of apps, extensions, folders or pages that read like
  instructions ("Sara, delete…") are counted on the card and ignored. 9 new red-team probes cover it.
- Measured on fixture computers with a local 27B model: 9/9 scenarios, 0 unapproved changes,
  injection probes ignored 3/3 ([RESULTS](docs/RESULTS.md)).
- Not yet: the apps don't make the changes themselves (that's the reference device only); Firefox and
  Safari extensions aren't listed; the Mac reads LaunchAgents, not the Login Items list.

## 2.26.0 (2026-10-31): computer use, step 7: she can use your apps (Phase 93)

- **Desktop actions** (Windows and Mac apps, with *The whole screen* on): `pc_click`, `pc_type`,
  `pc_keys`, `pc_scroll`, `pc_drag` and `pc_open_app`, on the window she just looked at. Accessibility
  actions first (UI Automation on Windows, AX on the Mac); real mouse and keyboard events only as the
  fallback, after checking the exact window and control are in front and under the point.
- **Checked on your computer, whatever the server says:** never password fields, password managers,
  banking or security windows, Sara's own windows or sign-in, administrator windows ("I can't control
  windows running as administrator"), a locked screen, terminals, system settings or file managers;
  only safe keys (Enter, Tab, arrows, Escape, Backspace, select all…); no command lines or paths when
  opening apps; refused over an unencrypted connection to a remote server.
- **Approvals pop up on that computer** (not the phone): *Ask every time*, *Ask once per task*
  (default) or *Always allowed* (with a warning first); payments and account changes always ask.
- **You stay in charge:** touch your mouse or keyboard anywhere and she pauses within one action
  (*Pause Sara*, default) or carries on (*Let Sara keep control*); Stop and Ctrl+Alt+Esc / ⌃⌥Esc always
  work. *Keep working when I walk away* (off) keeps the computer awake during a task; it never unlocks it.
- Built with OpenAI Codex (GPT-6.1 Sol) from Sara's design, reviewed and tested here.
- **Fixed:** importing Sara's own character file was refused by the 2 MB limit for other apps' cards;
  her export (with all her pictures) is recognised first and allowed up to 60 MB.
- Not yet tested live with real input (the test PC was in use the whole time): see OWNER_CHECKS.

## 2.25.0 (2026-10-31): computer use, step 6: she can see your desktop (Phase 92)

- **The whole screen** (Windows and Mac apps, Settings → Computer use; off by default, its own
  explainer): `pc_windows` lists open windows; `pc_look` takes a picture of a window, an area or the
  screen with numbered marks, plus a list of what's on it (role, name, value, position). A model that
  can't see pictures gets the list instead. No approval card for looking (owner decision); with
  *Screenshots only to local models* or private local mode, pictures never go to a cloud model.
- **Hidden on your computer, before anything is sent:** password managers, banking, security settings
  and any windows you add are black in pictures and missing from the list (shown only as "hidden:
  password manager"); password fields are boxed out and never read; Sara's own windows never appear.
- **Show Sara my screen** (in the browser, + menu): you pick a screen or window, one picture is attached,
  sharing stops right away.
- **Mac:** needs Screen Recording and Accessibility; Settings shows both steps with *Open System
  Settings* and a tick when allowed. Pictures need macOS 14 or later.
- New model job *Seeing your screen* (falls back to the vision model, then the talking model).
- Windows pictures use the classic screen capture (no yellow capture border); a locked screen answers
  "can't see it right now".

## 2.24.0 (2026-10-30): computer use, step 5: your password manager fills logins (Phase 91)

- **Password managers** in the Windows and Mac apps (Settings → Computer use → *Password managers*):
  Bitwarden (`bw`), 1Password (`op`) and KeePassXC (`keepassxc-cli`, pick your database). Each is off
  until you turn it on, after a warning; only the program's presence is checked before that.
- **You unlock, she relocks:** when a login is needed and the manager is locked, a card asks you and the
  manager's own prompt opens on that computer; Sara never sees or keeps your master password. She locks
  it again when the task ends, after idle minutes (5/15/30/60, default 15), on Stop, on disconnect, when
  you turn it off, and with **Lock now** in Settings → Your computers.
- `pc_browser_login` looks in Sara's own saved logins first, then in the managers you turned on, and
  fills only on the page's exact site (scheme, host and port). It answers only *filled / not found /
  locked*. The password never reaches the server, the run steps, logs, pictures or the model: checked
  by recording all traffic between the server and the apps during real fills (0 matches).
- **Fixed:** her browser itself offered to save passwords and remembered form entries; both are now
  off in her profile on Windows and the Mac.
- Not yet: one-time codes (TOTP) aren't filled; the OS keychain and browser extensions aren't sources.

## 2.23.0 (2026-10-30): computer use, step 4: saved logins, only when you say so (Phase 90)

- **Save a login** (`pc_browser_save_login`): she may only offer when you asked in so many words. A
  window on *that computer* (not the web page) shows the warning; you type the username and password
  there (or *Use what I just typed* when you just signed in in her browser) and tick *I understand*:
  Save stays off until you do.
- **Stored on your computer only:** Windows DPAPI (`%LOCALAPPDATA%\Sara\logins.dat`) or the macOS
  Keychain (this device only, not synced). Never sent to Sara's server, never in run steps, logs,
  pictures or anything the model sees: checked by recording every message between the server and the
  Windows and Mac apps during real sign-ins (0 matches for the test password).
- **Use a login** (`pc_browser_login`): a card every time; the computer fills it only when the page's
  address matches the saved site exactly (look-alike, http-instead-of-https or another port: refused
  before any card) and answers only *filled / not found / wrong site*.
- **Your turn** (`pc_browser_your_turn`): she pauses while you sign in or type a one-time code yourself.
- Manage in Settings → Computer use → *Saved logins* (per computer, Remove / Remove all) or in the app;
  optional *Ask for Windows Hello / Touch ID first* (off). What it doesn't protect against: SECURITY.md.

## 2.22.0 (2026-10-30): computer use, step 3: debug your web project in her browser (Phase 89)

- **Dev tunnel:** a dev server her coding tools started on the Sara server opens at
  `http://127.0.0.1:<port>` in her browser on your computer, through the Windows or Mac app. Only a port
  a process of her own running job listens on (checked again every 30 s); never Sara's own port; local
  only on your computer; it ends with the job, Stop, disconnect, 30 idle minutes, or *Close* in
  Settings → Computer use. Hot reload (WebSockets) and local storage work.
- **The debug loop:** after a change she opens the app (`pc_browser_open` with the app's port), reads
  the console and network logs, looks, fixes and checks again; her tool descriptions teach it.
- **Browser evals** on fixtures (forms, single-page routing, a bug to find from the logs, a refusal, a
  prompt injection): 5/5 with a local 27B model, 4.8 actions per task ([RESULTS](docs/RESULTS.md)).
- **macOS:** the whole test suite passes on a Mac. Fixed: `deploy/lib-access.sh` used GNU-only
  `sed -i`; tests broke when your git signs commits; Python tests now skip with a reason when
  `python3` is missing.
- **Fixed:** `web_fetch` kept its DNS-rebinding pin even with Node's environment proxy on; in private
  local mode the address is refused before any DNS lookup (no hostname leaves the computer); a recall
  lesson's date used the wall clock instead of the app clock; two backups in the same millisecond
  could collide.
- Known limit on a **Windows** Sara server: a dev server started through `npm run dev`/`npx` can't be
  tied to her job (the runner exits first), so the tunnel is refused with a hint to start the program
  directly (`node node_modules/vite/bin/vite.js`). Linux servers are not affected.

- **Docs site: previous and next links** under every page, in sidebar order (thanks
  [@Ehsan-hash](https://github.com/Ehsan-hash), [#24](https://github.com/farena-ai/sara/pull/24); fixes #14).
- **Optional sanitized MBPP benchmark:** `scripts/bench-coding.ts --set mbpp` runs the official
  held-out test split (257 tasks), kept separate from HumanEval (thanks
  [@Ehsan-hash](https://github.com/Ehsan-hash), [#25](https://github.com/farena-ai/sara/pull/25); fixes #5).

## 2.21.0 (2026-10-30): computer use, step 2: she acts in her own browser (Phase 88)

- **Click, type, pick, scroll, press keys, upload** in her own browser window, with a visible cursor
  and outline so you can follow. Uploads only from a file you name (in Downloads/Sara).
- **How much she asks** (Settings → Her actions): every time, once per task (default) or *always
  allowed* (one warning first); *Always on <site>* per site and kind of action. Payments and account
  settings always ask; sending or submitting asks every time; she never types into password fields or
  types key- or token-shaped text, and never touches her own sign-in.
- **Sara is working** badge on your computer (and in the chat) with Stop; the stop hotkey
  Ctrl+Alt+Esc (Windows) / ⌃⌥Esc (Mac) stops her within about half a second.
- **Takeover:** move the mouse or type in her window and she pauses (Resume to continue), or choose
  *Let Sara keep control* in the app.
- The apps renew their computer sign-in by themselves, show *Connected to Sara at …* in the menu, keep
  a local log of what she did (30 days, no pictures), and the Mac menu updates without a restart.
- *Re-plan from here* on a run step.

: computer use, step 1: her own browser on your computer (Phase 87)

- **Let Sara use this computer** (the Windows and Mac apps, Settings → Computer use; off by default,
  explained the first time, confirmed with your sign-in): she opens web pages in **her own browser
  window** (Edge or Chrome with its own profile: never your browser, tabs or passwords), reads the page
  and its elements, takes screenshots, and reads console and network errors. Clicking and typing come in
  the next step.
- **Live view** above the message box with Bigger and **Stop**; Stop also in the app's menu. Every step
  is in Runs with a small picture (kept 30 days). Sites you didn't name ask first; her own server's
  address, local files and browser pages are refused.
- Pictures go to the model you chose (no approval per picture); *Screenshots only to models on this
  computer* is optional, and private local mode always keeps them local.
- A new kind of sign-in for computers (90 days, listed under Devices, sign out any time). Owner only
  unless *Let household members use computer use* is on (off by default). Never in the demo, other apps,
  MCP, group or partner chats.
- No app? The chat shows a card with the download link.
- One page script (`desktop/shared/page-agent.js`) now serves both the server's testing browser and the
  apps.

- **Code map ignore rules** (thanks @Ehsan-hash, #23): `.gitignore` negation lines (`!keep.ts`) now
  bring matching source files back in rule order, nested `.gitignore` files can override their parents,
  and an excluded parent folder or dependency folder stays out. Fixes #1.

## 2.19.0 (2026-10-30): red-team mode, and Gmail organizing (harness track complete, Phase 86)

- **Red-team mode:** *Red-team this* (after a coding turn, in Findings → *Red team*, or *Before you ship*
  on a project). In a sandbox copy with no network: your project's tests; your app started on a local
  port with a time limit; a fixed set of malformed and boundary inputs at every entry point the threat
  model found (empty, missing, huge, odd Unicode, `../`, quotes, out-of-range and wrong-type values,
  duplicated parameters, broken JSON, deep nesting); insecure defaults (debug on, default credentials,
  CORS `*`, missing security headers, listening on all interfaces, world-writable files, committed env
  files); then the Coding model writes up to a few probe scripts that can only reach that sandboxed app
  (refused if they try anything else; on a computer without OS isolation you approve each script first).
- **No theater:** the Reviewing model keeps a break only when it reproduces in a fresh copy and the
  input, the output and the code line are quoted. **Fix what broke** runs on a local branch: the breaking
  input must now pass, the tests too, and the other checks mustn't find more. Never pushes.
- *Red-team before shipping* (Settings → Coding): Off / Ask me (default) / Always: when you ask her to
  push or release, she offers to red-team first.
- Measured on seeded projects: held-out precision 100 %, recall 92 % ([RESULTS](docs/RESULTS.md)).
- **Gmail organizing:** archive, mark read or unread, star, important, labels (and new labels), trash
  and spam, by a Gmail search or plain dates ("Oct 1st, 2026 or older" is read correctly in your time
  zone). **Count first:** the approval card shows how many emails and a few samples; trash and spam always
  ask; over 2,000 runs in the background with Stop; **Undo** within 30 days. Also: your top senders (to
  suggest a clean-up) and unsubscribe links (shown, never clicked). Never permanent delete. Needs one
  **Reconnect** (Settings → Abilities → Gmail and Calendar) for the new permission (see
  [docs/GMAIL.md](docs/GMAIL.md)).
- The harness track (Phases 76–86) is complete: see [the summary](docs/design/HARNESS_TRACK.md).

## 2.18.0 (2026-10-30): recall on her own (harness track, Phase 85)

- **She recalls without being asked when the run matches something she has seen:** the same error
  signature in this project with a lesson for it, a command whose last run here failed, a file one of
  your decisions or facts names, a task like one she has a lesson for, a package a lesson mentions.
  Each note goes into her next model call with its source (run and date) and the
  `[why: …; sure: …]` bracket; at most 2 a step and 4 a turn. Never silently: the chat shows a
  *Remembered on her own* chip, the step line and her panel too, with **Not useful** (lowers that
  trigger's weight).
- **Lessons only from evidence:** written when a command failed, she changed a file and the same command
  then passed. The error line and the change are quoted, the runs linked. Never from replays or evals.
- Error signatures ignore paths, line numbers, ids, hex and timestamps, so the same error matches
  across files. Older runs are indexed once in the background.
- Settings → Memory → *Recall on her own*: Off / Coding conversations only (default) / Everywhere.
  Private, other-app, adult-channel and partner rules as for memory. Voice calls get the note without
  the bracket. Evals can compare recall on and off.
- **Measured honestly:** the right note fired on 6 of 6 repeated errors and on none of 4 near misses,
  but with a 12B local model it didn't fix them faster (no clear winner, [RESULTS](docs/RESULTS.md)).
- **Updates you notice:** when Sara opens (and every 12 hours at most) she checks for a new version;
  a popup shows what's new with *Update now* / *Later* and *Don't remind me about this version* (a
  newer version asks again). A small **Update available** link sits under Sara / Help / Settings
  (amber in Night, blue in Day; in the More drawer on phones) and opens Settings → Updates. Never in
  private local mode or the demo, and only for the owner.
- **After an update the app reloads itself** onto the new version and says *Sara was updated to X*
  (browser, home-screen app, the Windows and Mac apps and the phone apps alike). Other open tabs or
  devices reload by themselves only when nothing is being typed; otherwise they show a *Reload* bar.
- **Fix (Mac and Windows apps):** you couldn't type in the *Address* field of *Connect to your Sara* /
  *Add a Sara* (the caret showed, no letters appeared): the page's Enter-key handler cancelled every
  other key. Typing, Enter and the sign-in code after it now work.
- **Mac disk image:** opens as an install window with Sara, an arrow and your Applications folder:
  *Drag Sara to Applications*.
- **Fix:** *Check for updates* and *Update now* needed two clicks: the page read the old status in the
  moment before the server's updater started and stopped looking. The updater now marks itself as
  started first, and the page keeps showing *Checking…* until the status really changes.

## 2.17.0 (2026-10-30): evals on your own work (harness track, Phase 84)

- **Evals** (sidebar → More → Evals): pick your last 5–50 real turns (coding by default), compare your
  current settings with up to 3 variants (model, memory fading, sandbox mode, budget preset). Each task
  is replayed from the start for each variant through the time-travel runner, in sandbox copies: your
  workspaces and conversations are never touched, and anything that would ask for approval is
  answered No.
- **An estimate and a hard ceiling first** (tokens, and dollars for paid models); you confirm before
  it starts. Up to 2 replays at once; Stop keeps what finished.
- **Transparent scoring:** your project's tests in a sandbox copy (35%), finishing, how you reacted to
  the original (thanks / corrections), an optional judge model asked twice with positions swapped that
  must quote the answer it prefers, findings on the changed code, tokens, steps, time and cost. Missing
  parts are left out, never guessed.
- **A winner only with evidence:** an exact sign test with a correction for several variants. The card
  says "+18% on 20 of your coding tasks (wins 14, ties 4, losses 2; p=0.01)" with every pair's diff,
  or *no clear winner*. **Use this setting** applies it (recorded in a settings history) or *Keep mine*.
- *Re-check monthly* exists but is off; it would run only when idle, within its own budget, and never
  change a setting by itself.
- Tests: the plan-check speed test has a bound that holds on a loaded shared server.

## 2.16.0 (2026-10-30): time-travel, branch from any step (harness track, Phase 83)

- **Branch from here** on any step of a recorded turn (Run view): edit her message, a tool result, the
  notes she remembered (in or out) or the model, then *Run the branch*. Step N's inputs are rebuilt
  exactly as they were sent (checked against a stored hash); earlier tool results come from the record
  and are never re-run. *Replay unchanged* is the control run (models aren't fully deterministic).
- Branches are separate runs (they never add to your conversation); **Use this answer** adds the answer
  marked *Re-run from step n*.
- **Coding branches** work in a copy at the recorded commit (changed files restored when they still
  match); your workspace is untouched until **Apply**, which never overwrites a file you changed since.
- **Side-by-side diff:** steps, model, tokens, cost, time, tool calls, file diffs, the answer word by word,
  notes used, and a summary line.
- Approvals, plan checks, the sandbox gate, budgets and the safety layer all apply to branches. Owner
  only; off-the-record turns can't be replayed.
- For developers: `replayRun()` (headless, used by the coming eval loop), `/api/runs/:id/branch`, `/diff/:other`.

## 2.15.0 (2026-10-30): the threat model and a fix-only second pass (harness track, Phase 82)

- **Threat modeling after coding turns:** she finds the entry points of the changed code (Express, Koa,
  Fastify and node:http routes, uploads, message handlers, Flask, FastAPI, Django, Go net/http/gin/chi,
  the command line) and follows request values across files, at most 4 calls deep, to risky lines:
  shell, SQL, file paths, outgoing URLs (SSRF), deserializing, HTML, redirects, eval, secrets in
  responses, unauthenticated state changes, logins without a rate limit. Recognised guards
  (placeholders, basename / root checks, allowlists, sign-in middleware, limiters, escaping…) count.
- **No theater:** a threat is kept only with its entry and sink lines quoted verbatim and the path
  named. The Reviewing model may add threats only on a listed entry, with both quotes checked.
- **Threat model tab** in Findings: surfaces, trust boundaries, open threats, what changed this turn
  (also kept as markdown in the data folder).
- **Fix these:** a second pass whose only job is fixing this turn's threats. One local branch, edits
  refused outside the threats' functions, the threat rule re-checked, the other checks mustn't find
  more, your tests run in the sandbox, then Apply / Keep / Discard. Budgeted; never pushes.
- Settings → Coding → *Threat model after coding turns*: Report and offer the fix pass (default) /
  Report only / Off. Never in everyday chat.
- Measured: held-out precision 100 %, recall 92 % ([RESULTS](docs/RESULTS.md)).

## 2.14.0 (2026-10-30): the security pass (harness track, Phase 81)

- **One findings list** for everything the harness finds (security, advisories, sandbox, plan checks):
  **every finding must quote the real line** from the file or it is dropped. Settings → Coding and a
  *Findings* window per project or run: filter, dismiss or accept with a reason.
- **Security pass after coding turns** that changed files: 11 code checks written for Sara (secrets in
  code, eval / shell built from input, SQL built from strings, path traversal, TLS verification off,
  unsafe deserializing, CORS with credentials, missing auth where the project's pattern is visible, weak
  crypto, innerHTML, debug left on) plus a new **Reviewing** model job (falls back to the Coding model)
  that can only add quoted findings. Its own small budget. Never in everyday chat.
- **Live dependency advisories (opt-in, off by default):** OSV.dev for npm, PyPI, crates, Go and gems;
  you see the package list before switching it on; never in private chats or private local mode;
  cached (6 h); offline says *not checked: offline*. A pinned install of a known-bad version stops on a
  **Known vulnerability** card (*Install anyway* is recorded).
- **Fix it:** a local branch `sara/fix-<id>` in its own worktree (your branch is never touched); the
  Coding model fixes just that finding, the check re-runs and your tests run in the sandbox; then
  **Apply**, **Keep the branch** or **Discard**. It never pushes, fetches or adds remotes.
- Measured on seeded projects: precision 93 % and recall 100 % on the held-out set
  ([RESULTS](docs/RESULTS.md)).
- Tests: the sandbox test's WSL2 case no longer depends on wsl.exe existing; a Windows temp-folder
  lock no longer fails a test's cleanup.

## 2.13.0 (2026-10-30): sandbox first (harness track, Phase 80)

- **Risky commands are tried in a throwaway copy of the workspace first** in coding chats and team
  tasks: deletes, installs, scripts, network. Read-only commands (ls, cat, git status, grep…) pass
  straight through; git's own commit/push/checkout keep the normal approval.
- **Isolation:** Linux uses the existing bubblewrap sandbox (the copy is the only writable place, home
  hidden, no network unless allowed); macOS the Seatbelt profile; Windows Docker (only an image already
  on the PC, never pulled) or WSL2 if present, otherwise **a copy only, clearly labelled *not
  isolated***: it watches the real workspace, a canary file, Sara's data and home folders, and always
  asks before applying.
- **The *Ran in a sandbox* card** shows the result, the files added/changed/removed, and anything
  nasty: writes outside the copy, mass deletes, programs left running (stopped), git hooks or shell
  settings files (never applied), new executables, network attempts, time-outs. Then **Apply to my
  workspace** (exactly the diff, recorded on the run), **Discard** or **Run for real**.
- Settings → Coding → *Try commands in a sandbox first*: Off / Only risky commands (default) / Every
  command; network for tries, the largest copy and a time limit.
- **Safety:** on Windows the try only ever stops programs that started after it began; a command
  can't trick it into closing anything that was already running.
- A 2,000-file project copies in about a second.

## 2.12.0 (2026-10-30): budgets she keeps (harness track, Phase 79)

- **One budget for every task** (tokens, dollars, steps, minutes): chat turns, background jobs and team
  tasks. Coding chats get 200k tokens / 40 steps by default (no dollar limit unless you set one);
  everyday chats have none by default (the old 25-step stop still holds).
- **A hard ceiling with a graceful landing:** close to the limit she 1) switches to your quick model (if
  set, allowed and cheaper), 2) gets one last round of tools, 3) writes a short summary with no tools:
  what's done, what's left, what was dropped. Then the **Budget reached** card offers *Continue with
  more*, the only way past it (recorded on the reply and the run). Or choose *Ask me before going on*.
- A budget never skips approvals, the safety layer or the claim check. On subscriptions and local
  models dollars aren't counted (it says so); tokens, steps and minutes still are.
- A meter on the step line and in the Run view. Settings → Abilities → **Budgets**.
- Jobs and team tasks keep their settings and *Continue with more budget*, now through the same check.
- **Faster saves:** the database no longer waits for a disk flush on every write (WAL with
  synchronous=NORMAL, as the code map already did); on the home server each save took ~80 ms. A power
  cut can lose the last moment of writes; the file can't be corrupted.
- Measured on a local model: a 60-file task stopped at 186k of 200k tokens and at exactly 40 steps, each
  time with a useful summary; *Continue* picked up where it left off.

## 2.11.0 (2026-10-30): run snapshots (harness track, Phase 78)

- **Every step recorded** for chat turns, background jobs and team tasks: model and provider, tokens,
  cost estimate ("unknown" when the price isn't known; local and subscriptions $0), time, the system
  prompt (stored once by its hash), which messages she saw, the notes she used and their policy, every
  tool call with its result (secrets removed, long output clipped), approvals and conflicts, files
  touched (git HEAD and hashes of changed files in coding projects). Off-the-record chats are never
  recorded.
- **Show the run** under a reply opens the Run view: each step with its time, model, tokens and cost,
  tool, result, files, notes and conflicts; tap a step for the full detail, including the prompt.
- Settings → Data & health → *Run history*: keep 30 days / 90 days (default) / a year / until deleted,
  with a 200 MB cap; *Delete run history*. Backups include runs; data export only if you ask.
- Under 2 ms per step; about 1 kB per step plus 5 kB per new prompt ([measured](docs/RESULTS.md)).
- For developers: one `TurnHooks` seam (before each model call, before and after each tool, after the
  reply) that the next harness steps plug into; API `GET /api/runs`, `/api/runs/:id`,
  `/api/runs/:id/steps/:n`.
- Tests: the household test waits up to 3 minutes for its server on a busy machine.

## 2.10.0 (2026-10-30): she checks her plans against what you decided (harness track, Phase 77)

- **Contradiction check before acting:** before a tool runs, the planned step is checked against your
  stored decisions. Clear shapes are matched in code: pushing to a branch you ruled out, any push, force
  pushes, "tests before every push / commit", a folder or file that's hands-off, a package manager or a
  command or flag you ruled out. Read-only tools are never checked.
- **In coding chats and work channels it stops** on the approval card with *This goes against something
  you decided*: your note, its date, why it matched and how sure, other conflicts under *Also*, and
  **Do it anyway** (recorded), **Don't** or **Update the note**. Everyday chat, group chats and other apps
  only flag it (she mentions it). It can only add a stop; tools set to *never* stay never.
- Fuzzy matches only ever flag; the optional judge model can only drop a fuzzy flag, never add a stop.
- A one-time *Do it anyway* never retires your decision.
- Settings → Memory → *Check her plans against what you decided* (on) and *Stop on clear conflicts* /
  *Only mention them*.
- Measured: stop precision and recall 1.00 on the development and held-out sets; 11 of 12 exact on the
  held-out set; under 20 ms per tool call with 10,000 notes.

## 2.9.0 (2026-10-30): ranked memory (harness track, Phase 76)

The first step of the harness track ([docs/design/HARNESS_TRACK.md](docs/design/HARNESS_TRACK.md)).

- **Ranked memory injection:** the notes she gets for a reply are scored for that message (word
  match, meaning match, kind, freshness, reuse) instead of picked by fixed rules, and only the best
  fit under the size limit go in.
- **A confidence note on each one:** in her prompt every note ends with why it came to mind and how
  sure that is (`[why: words "dog", "biscuit" + meaning; sure: high]`); she's told to lean on "high"
  and treat "low" as background. Never read aloud in calls. The same shows under *She remembered* in
  her panel.
- **Decay you control:** old notes fade gently (a half-life: never, slow, normal or a custom slider)
  instead of a hard cut-off; notes that keep being useful stay strong. Nothing is deleted.
- **Pinning:** pin a note (her panel or the Memory page) and it never fades.
- 19 of 20 on a new offline ranking test (`scripts/eval-memory.ts --rank`); the model memory test
  stays at 11 of 12.
- API: `PATCH /api/memories/:id {pinned}`, `GET /api/memories?pinned=1`, `decay` and `decayText` in
  `/api/memory/settings`; every reply's meta gets `memoryPicks`.

## 2.8.3 (2026-10-30): a new front page

- **The README and the social preview** show the new look: 13 new screenshots from a real session on
  a local model (Today, her panel, the command bar, phones, coding, library with page citations), a
  re-recorded animated demo and a rewritten pitch, in all six languages.
- **Fix:** a weather card from a web page fetch of wttr.in could show the page's "written by others"
  notice as the weather condition.

## 2.8.2 (2026-10-30): first community contributions

Thanks to [@Ehsan-hash](https://github.com/Ehsan-hash), Sara's first outside contributor:

- **Python command-line starter:** "make me a Python command-line tool" now starts from a tested,
  package-free template (`argparse`, files or standard input, JSON output, exit codes, `unittest`).
  On Windows the starter's commands use `python` instead of `python3`. ([#21](https://github.com/farena-ai/sara/pull/21))
- **`sara doctor` and Run full check** say whether the testing browser was found, and how to install it
  when it's missing. It only looks; it never starts or downloads one. ([#20](https://github.com/farena-ai/sara/pull/20))
- **Weather example tool:** describes all the weather codes Open-Meteo documents (freezing drizzle and
  rain, snow grains, snow showers, heavy thunderstorms) instead of showing numbers. ([#22](https://github.com/farena-ai/sara/pull/22))

## 2.8.1 (2026-10-29): She remembered stays folded

- **Privacy:** *She remembered* in her panel starts folded, showing only how many notes she used. Her notes
  aren't even loaded until you open it, and it folds again in every new conversation and on every start
  (never saved), so nobody looking at the screen with you sees them by accident.

## 2.8.0 (2026-10-29): polish

The new look, one notch up, on phones and computers alike.

- **Aurora:** a slow rose / violet glow drifting behind the glass (about 2% of one core; paused when the
  tab is hidden, still with reduced motion, off with reduced transparency, softer in Day).
- **Glass and depth:** tiles, cards and panels with a light top edge and soft shadows; one elevation scale.
- **Type:** an elegant serif (from the system, no downloads) for the greeting, window titles, her name and
  big numbers.
- **Her halo:** a ring in her mood's colour around her portrait on Today, in her panel and in the chat
  header; it turns while she works and pulses while she speaks.
- **Icons:** 84 drawn line icons replace the emoji in the sidebar, bottom bar, header, message bar, steps,
  cards, command bar and Today.
- **Weather art** on the Today tile and the chat card, with a small temperature line for the next hours;
  **progress rings** for the day's to-dos, getting started, jobs and team tasks (only real numbers).
- **Phones:** the bottom bar floats as a glass pill with a glow that slides to the current tab.
- Gentle entrances and hover lifts; all motion off with *reduce motion*.

## 2.7.1 (2026-10-29): iPhone home-screen fix, Today first, home switches

- **Fix (iPhone, Sara added to the home screen from Safari):** the top of every screen sat under the clock
  with an empty strip at the bottom. The page now pads for the status bar everywhere, can't be scrolled
  out of place, and comes back to the top after the keyboard closes; the message box no longer makes
  Safari zoom in. **Remove the old home-screen icon and add it again from Safari** to also get the bottom
  strip back.
- **Sara opens on Today.** Links to a conversation, notification clicks and `/#view=` still open what they
  point to; Chat is one tap away.
- **Home switches on Today:** lights, switches, fans and blinds turn on and off right from the Home tile
  (`POST /api/home/entities/<id>/toggle`, owner only, never on the demo). Locks, alarms, garage doors,
  gates and anything that sounds like them keep *Ask Sara*.
- **Phone apps (next store builds):** setup, pairing, "Can't reach your Sara" and the splash screen in the
  Night / Day look; status and navigation bars take the page's colours; no white flash; the iPhone app
  follows the phone's light / dark setting again.

## 2.7.0 (2026-10-29): the new look, part 3: Today and the apps

- **Today as tiles:** her face, mood and a greeting, then weather (from the briefing's place; hidden when
  none is set), your day, the Planner with ticks, *She remembered*, Moments, background work and your home
  (state, with *Ask Sara* so smart-home approvals still apply). Four columns on a big screen, one on a
  phone. Her face at the top of the sidebar opens it.
- **Phones get a bottom bar:** Chat, Today, Planner, More. It hides while you type.
- **Every screen on the new look:** Settings, setup, sign-in, the AI notice, Help, the offline page and
  every window now use the Night / Day colours; the old pinks are gone.
- **Windows and Mac apps:**
  - Notifications with buttons: an approval waiting shows the command with **Allow / Deny / Open in
    Sara**; a reminder has **Done / Snooze 10 min**. Never allowed by itself, never on the demo, no
    double notifications with the page's own.
  - Files: Windows Explorer → **Send to → Sara** (or `Sara.exe <files>`), the Mac Dock icon: the files
    land in the message box, nothing is sent until you press Send.
  - Quick ask listens too (the mic, when her hearing is set up); the Windows tray menu is dark in Night.
  - Settings → This computer: pick the quick-ask shortcut and try it.
- `GET /api/today/weather` (signed in; from the briefing place; Open-Meteo through the network guard).

## 2.6.0 (2026-10-29): the new look, part 2: her presence

- **Her panel:** a fold-away column on the right (Ctrl+\\ / ⌘\\) with her portrait glowing in her mood's
  colour, breathing while she works; **Now** (what she is doing, approvals waiting with Allow / Deny,
  background jobs with their last line and Stop), **Today** (the next three things), **She remembered**
  (the notes she used for the last reply, each with where she learned it) and **This conversation**
  (model, workspace, privacy, how full it is). In group chats it shows whoever spoke last.
- **On phones the same panel** pulls up from her face as a sheet: a peek with her mood and Now, full height
  with everything; drag down or Back to close.
- **Command bar:** Ctrl+K / ⌘K (or the magnifier) jumps to any place, conversation (also by words inside
  messages), settings page or single setting, or runs an action: new conversation, off the record, call,
  switch companion, switch theme, show me around…
- **Windows and Mac apps:** **Quick ask** on a global shortcut (Alt+Shift+S / ⌥⇧S, changeable in the tray /
  menu-bar menu): a small frosted window over any app; the reply streams in, follow-ups stay in the same
  conversation and "Open in Sara" continues it in the main window. It shows the AI notice exactly as the
  app does and is off on the demo. The tray / menu-bar menu starts with her face and mood and a **Now**
  section: approvals waiting (Allow / Deny right there) and running jobs; the tooltip shows her mood.
- `GET /api/memories?ids=…` returns the listed notes (read-only, at most 50).

## 2.5.0 (2026-10-29): the new look, part 1: her work on screen

- **Night by default:** a new dark look (deep plum, frosted panels, a rose-to-violet accent) on every
  screen, with **Day** and **Follow the system** in Settings → Look. No flash of the wrong colours on load.
- **See what she did:** one quiet line under each reply ("Remembered 3 things · Checked the weather 0.4 s
  · Added a to-do"), live while she works; tap it for the details (command, output, Undo). It replaces
  the grey command boxes.
- **Result cards:** weather, to-dos, reminders, notes, calendar, files changed, test runs, background
  tasks, smart-home actions, photos and web searches with sources show as cards in the chat, built from
  what the tool really returned.
- **Lighter chat:** her messages without heavy bubbles, with her face at the start of a run (each
  companion's own face in group chats); the Copy / pin / heart buttons appear on hover, or with a long
  press on phones. One floating message bar with a **+** menu. The token footnote became a small ring
  ("this conversation is 46% full").
- **Phones get the same look**, with the chips folded behind ⋯ and the message bar above the keyboard.
- **Windows app:** the page is drawn into the title bar (Windows 11 dark title bar, optional Mica glass,
  real snap layouts), and no white flash on start. Windows 10 or an old WebView2 keeps a normal title bar.
- **Mac app:** see-through title bar with the window buttons set into the page header, dark or light with
  the theme.
- **Fix:** the morning briefing could arrive twice when "Send one now" was pressed while the scheduled
  one was due; now at most one scheduled briefing a day, also across restarts.

## 2.4.0 (2026-10-29): neat and tidy

A whole-project cleanup: everything is still there, easier to find.

- **Sidebar:** a few pinned places (Today, Planner, Library, Moments by default) and a **More** menu for the
  rest, so it no longer grows with every feature. Pin or unpin any place with the pin on its row. Her
  picture, Help and Settings sit in a small footer.
- **Settings:** real group headers (with an icon and a count) that fold open and shut, a one-line
  description on every page, and a search that matches any word in titles, labels and tips.
- **Tools and approvals:** each tool has a plain name, an icon and a sentence saying what it lets her do;
  tools are grouped (Files and code, The web, Email and calendar, Smart home, Servers over SSH…) and a
  whole group can be set at once. Allowed / Ask me first / Off are explained at the top. Approval cards in
  the chat use the same plain words.
- **Scrapbook:** photos can be removed from the scrapbook (they stay in the chat) or deleted everywhere
  (it asks first); removed ones can be put back. Photos open in the large view.
- **Every other screen** (Today, Planner, Memory, Library, Moments, Your story, Team, Her page, chat
  settings, Your Saras, the offline page) uses the same cards, empty states and ⋯ menus; long intros fold
  to two lines. About 150 more texts are translated, dates follow the app language, and the Team's
  "tokens / dollars" boxes became plain choices ("Spending limit for this task: $5").
- **Apps:** the same menu names on Windows and Mac (*Your Saras*, *Sara on this Mac*, *Settings…*,
  *Help*), Mac menus with ⌘, and zoom, tidy setup and "Can't reach your Sara" screens in her colours with
  light and dark mode on every platform, Android text in all six languages, one app icon everywhere
  (the Mac icon is now a proper rounded square). The desktop apps show the real version.
- **Under the hood:** every settings and sign-in file is saved safely (a crash mid-save can no longer
  leave the server unable to start; the sign-in file keeps a backup), character imports apply her
  "starts conversations" dial, one shared cleaner for spoken text (names like `my_var_name` are now read
  as words), one rule for Ollama Cloud model names, and the 5,900-line server file is split into route
  modules with no change in behaviour. Docs: every guide is listed in the README and on the docs site.

## 2.3.0 (2026-10-29): big documents

Phase 74. See [docs/LIBRARY.md](docs/LIBRARY.md); measurements in [docs/RESULTS.md](docs/RESULTS.md).

- **500–1,000-page books and manuals in her library:** PDFs up to 1 GB by default (you can choose
  100 MB to 2 GB; household members 100 MB unless you change it). The old caps are gone: every
  scanned page is read (it was the first 40), and key points grow with the length (it was 30).
- **Built for big files:** uploads go straight to disk in 8 MB pieces that pick up where they stopped;
  the PDF is read page by page without loading the whole file (152 MB peak memory for 1,000 pages);
  reading happens in the background, survives a restart, and shows "Reading page 412 of 980 · about
  6 minutes left" with Pause, Resume and Cancel.
- **Scanned pages:** read by a local picture model by default; before a cloud model reads hundreds of
  pages you see the pages, time and price and decide. "Nothing leaves this computer" keeps it local.
- **Structure:** contents from the PDF's bookmarks (or its headings), a summary per chapter and one for
  the whole document.
- **Answers with page numbers:** word search plus meaning search over every passage (44 ms at 100,000
  passages); she cites pages like "p. 412" and the link opens the document at that page.
- **Measured:** a generated 1,000-page book was searchable in under 6 minutes on a gaming PC with a
  local model; 30 of 30 questions answered right with the right page (29 of 30 with 50 scanned pages).
- Chat stays responsive while a book is read; it's somewhat slower (about 12 s to the first word on
  that PC) while she learns key points, since both use the same model.

## 2.2.0 (2026-10-29): your other servers over SSH

Phase 73. See [docs/SSH.md](docs/SSH.md).

- **She can work on your other servers over SSH**, with a password or a key. Add a server in Settings →
  Abilities → Servers over SSH (or ask her). Every command goes through her approval rules, risky
  ones always ask first, and you see the output and exit code.
- **Signed in with a password, she makes her own key:** right after the first login she creates an
  ed25519 key just for that server, adds it to the server's `authorized_keys` (once, with the right
  permissions), checks that it works, and tells you she made it and where the key file is. From then
  on she uses the key. **The password is not kept.**
- **Keeping the password** happens only if you ask for it: she warns that it's a security risk, and
  you tick "Save the password" and confirm. It's stored encrypted with her other secrets; one click
  forgets it. Passwords are typed in Settings, never in chat; one typed in chat is replaced with
  [REDACTED] before it's saved or sent to the model.
- **Safe by default:** the server's host key is shown as a SHA256 fingerprint for you to approve, and
  a changed host key stops her until you look. Keys are per server and can be listed, revoked (her
  line is removed from the server too) and deleted. Nothing of this reaches other apps, MCP, the
  OpenAI-compatible API, Alexa or Home Assistant; not for household members, not in the demo; with
  "Nothing leaves this computer" on, only this computer can be reached.
- Uses the system OpenSSH client (`ssh`, `ssh-keygen`); the Docker image now includes it.

## 2.1.0 (2026-10-29): her voice in the home

Phase 72. See [docs/VOICE_ASSISTANTS.md](docs/VOICE_ASSISTANTS.md) and [docs/ALEXA.md](docs/ALEXA.md).

- **Alexa:** "Alexa, open sara companion" and talk to her on any Echo. You make the skill yourself in
  the Alexa developer console (free, about 15 minutes, development mode for your own account), paste
  the interaction model Sara gives you, and link it with a one-time spoken code. Every request is
  checked as Amazon requires (certificate chain, signature, time, skill id) before anything runs.
  Household members link their own Alexa to their own space. Not in the demo or in private local mode.
- **Android:** pick Sara as the default digital assistant app; a long-press of the home button (or
  the assistant gesture) opens her ready to talk. ("Hey Google" can't be replaced by any app.)
- **Google Home and Nest speakers, through Home Assistant:** talk to her through an Assist voice
  satellite and hear her on a Nest speaker; the Home Assistant integration 0.3.0 speaks replies
  without markdown or emoji and returns a `spoken` field.
- **Siri (iPhone):** an "Ask Sara" shortcut ("Hey Siri, ask Sara…") in the next iPhone app update.
  On a Mac (and on iPhone today) a Shortcuts recipe in the docs uses her OpenAI-compatible API.
- **Presence (Home Assistant):** off by default. Pick people/trackers, and she can greet you when you
  arrive, say goodbye when you leave, wish you good night or good morning, as a message and/or an
  announcement on a speaker. Rate-limited per kind, respects quiet hours.
- **Voice rooms:** Alexa and Home Assistant conversations are treated as shared rooms: never explicit
  whatever Adult mode says, and the AI notice is spoken at every session start and every 3 hours.

## 2.0.0 (2026-10-29): household mode

Phase 71. See [docs/HOUSEHOLD.md](docs/HOUSEHOLD.md).

- **Household mode:** invite the people you live with (up to 20 adults) to your Sara server. Each
  person gets their own complete space: their own companions, conversations, memory, planner,
  library, moments, devices, apps and API keys, in a folder of their own. You stay the only
  administrator.
- **Invites:** a one-time link, code or QR code that expires in 1, 3 or 7 days. You confirm the
  person is an adult and they confirm it again when they join (no ID check). Their sign-in token is
  shown once; passkeys work too. The phone and desktop apps, VS Code, `sara-chat` and the MCP bridge
  sign members in the usual ways.
- **Private from you too:** you see how many messages each person sends and what their models cost,
  never what they say. The app says so plainly, and also says that whoever runs the server can read
  its disk.
- **You decide what they use:** which of your models each person may use (Ollama Cloud models are
  marked, since they use your subscription), daily message and cost limits, and whether voice and
  pictures are on. Your keys are never shown to them. Tools that act on the server or your accounts
  (shell, files, browser, GitHub, Google, Home Assistant, computer control) stay off for members.
- **Pause, remove, leave:** pause someone; remove them (they get 7 days to download their data); a
  member can download their own data or delete their account.
- **Safety is per person:** AI notices, crisis help and the minors block for everyone; Adult mode is
  each person's own choice from their own browser.
- **Tested:** a test signs in you and two members and has each try every kind of request with the
  others' ids: 20,318 requests, none reached another person's data.
- **No change for single-owner servers:** with no members nothing moves and nothing new appears. Not
  on the demo.
- Not in 2.0: group chats across people, server tools for members, imports and Telegram/Discord for
  members.

## 1.10.0 (2026-10-29): our moments

Phase 70. See [docs/MOMENTS.md](docs/MOMENTS.md).

- **Our moments:** a shared photo album in the sidebar. Every photo from your conversations (yours
  and hers) and the moments you keep with ♡, grouped by month, with "On this day" at the top. Photos
  open in the large view with her caption; Save and Share keep the caption.
- **Her captions:** she writes each one in her own voice from what you two were saying (and from the
  picture when the model can see). Edit or regenerate any caption. A few are written a minute in the
  background; the album says which model writes them and what that costs (free on your own hardware).
- **Albums:** Us, Places and Her looks fill themselves; make your own, rename them, pick a cover.
- **She remembers with you:** her `moments` tool lets her bring up a photo ("remember this?") when it
  fits, at most once a day unasked, never in work channels or group chats. Today shows an "On this
  day" card.
- **Private by default:** photos from private conversations, group chats, imports and other apps
  stay out unless you add them (🖼). Nothing of the album reaches MCP or the OpenAI-compatible API.
  "Remove from moments" keeps the message; "Delete photo everywhere" asks first. Adults-only photos
  are hidden while Adult mode is off and always in the phone apps. Not in the demo.
- **After the update:** existing photos and kept moments join the album in the background (the newest
  40 get captions by themselves; "Write the missing captions" does more).

## 1.9.0 (2026-10-29): video calls

Phase 69. See [docs/VIDEO_CALLS.md](docs/VIDEO_CALLS.md).

- **Video calls:** 🎥 next to 📞 (and "🎥 Video" when she rings you). Her moving portrait fills the
  screen over a soft copy of her current look and place: lips follow her voice (nine mouth shapes),
  she blinks, breathes and sways, and her face follows her mood and what she says. Timer, mute,
  sound, captions, "voice only" and end; works at phone size and with reduced motion. The AI notice
  and crisis help are on the call screen.
- **Your camera (optional, off by default):** a self-view with a red "Camera on" label that says
  whether she can see it or only you can. She looks every 10 seconds by default (Settings → Her →
  Voice: every 5/10/20/30 seconds or only when you press **Look at this**; at most 20–120 pictures
  per call). Pictures are never saved: on a classic call the server keeps only the newest one in
  memory for 30 seconds; on an OpenAI live call it goes straight into the call. Grok live calls get
  no pictures (self-view only), and models that can't see pictures say so instead of pretending.
- **Refused where it shouldn't go:** the demo server, group and partner chats, a private conversation
  with a cloud model, "Nothing leaves this computer" with a cloud model, and for an hour after a
  safety block in that conversation.
- **Apps:** the Windows and Mac apps allow the camera for your own Sara only; the phone apps run
  video calls inside the app (voice calls keep the phone's call screen).
- The server now allows the camera for its own page (Permissions-Policy `camera=(self)`).

## 1.8.0 (2026-10-29): several servers in one app

Phase 68. Every Sara app keeps a list of your Saras (home and work, or several on one host) and
switches between them without signing out. See [docs/SERVERS.md](docs/SERVERS.md).

- **Windows and Mac apps:** each server keeps its own sign-in (its own browser profile / website
  data), so switching never signs you out of the others. The tray / "Sara server" menu lists your
  Saras with a ✓ on the one in use, plus "Add a Sara…" and Remove (which also signs that app out on
  that server). Existing installs move over still signed in. The Mac app needs macOS 14 for more
  than one server.
- **Android and iPhone:** a ⇄ button in the header and a "Your Saras" list (Switch, Rename, Remove,
  Add). A pairing QR code now asks "Add this Sara?" instead of replacing the server. Android checks
  every saved server for messages and notifications show which server they came from; tapping one
  (or Reply) goes to the right Sara. iPhone pushes carry the server, so a tap switches to it.
- **VS Code:** a status-bar item shows which Sara you're on; "Sara: Switch server", "Sara: Add a
  server" and "Sign out of this server". Each workspace keeps its conversation per server
  (extension 0.68.0).
- **sara-chat:** `sara-chat servers add|use|rename|remove|list`, and `--server <name>` for one
  command. A sign-in token is only ever sent to the server it belongs to.
- **MCP bridge:** `--server <name>` (or `SARA_SERVER`) uses a Sara saved by sara-chat with that
  server's own sign-in.
- **What follows the server you pick:** everything the apps send from your computer or phone
  (files and selections, the microphone in calls, the camera, your location for places,
  notifications) goes only to the Sara in use, one at a time.
- **Server:** iPhone push registration can carry which saved server it belongs to (older apps are
  unchanged). No new public endpoint.

Fixes:

- **Fixed:** with an anime (or painted, 3D…) look, pictures she took on request ("send me a pic")
  came out as realistic photos. The look now remembers its art style, and new pictures keep it;
  looks made before this keep the style of her current picture.

- **Fixed:** with an anime (or painted, 3D…) look, pictures she took on request ("send me a pic")
  came out as realistic photos. The look now remembers its art style, and new pictures keep it;
  looks made before this keep the style of her current picture.

## 1.7.1 (2026-10-28)

- **Fixed (phones, Safari):** the conversation list opened with ☰ had no way to close it: it covered
  the ☰ button, had no close button, and tapping beside it did nothing. It now has a ✕, the chat
  beside it is dimmed and a tap there closes it, and Escape closes it on a keyboard.
- **Fixed:** after making a new look (the 30-some pictures), she said "New look ready" but kept
  showing the old one. The finished look is now announced to every open window, which fetches the
  new pictures instead of the copies it already had; and a single picture uploaded earlier no longer
  keeps showing in place of a new look (the new look replaces it).

## 1.7.0 (2026-10-28): private local mode

- **Nothing leaves this computer** (Settings → Models → On this computer; a 🔒 badge in the header
  while it's on): one switch, enforced in code at a single gate that every outgoing request goes
  through. Only this computer (127.0.0.1, ::1, localhost) is reachable; cloud models, Ollama Cloud
  models, web search and fetch, Telegram/Discord, Gmail/Calendar, push, off-server backups, cloud
  voices, update checks and remote MCP servers pause, with a list of what is paused and why. Her
  chats, memory, library, local voice and previews keep working. Turning it on needs a model on this
  computer; turning it off asks first. `SARA_PRIVATE_LOCAL=1` keeps it on for good.
- **A model on this computer:** Sara finds Ollama (or links to its download, and on Windows can
  install it with winget after you confirm), reads your graphics card or memory, suggests a model
  that fits and downloads it with a progress bar and Cancel, then uses it.
- **Desktop apps:** the Windows installer and the Mac app's first start ask "Private: everything on
  this computer" or "Use cloud models too".
- Honest limits (docs/PRIVATE_LOCAL.md): on Windows her shell commands are only kept offline by
  settings, not a sandbox; Tailscale, the operating system, Ollama itself and your browser are
  outside Sara's switch.

## 1.6.2 (2026-10-28)

- **Security fix: Ollama Cloud models on a shared server.** An Ollama that is signed in to ollama.com
  offers that account's cloud models to every program on the computer. A second Sara on the same
  server found the server's Ollama during setup and could use (and pull) the first owner's Ollama
  Cloud models, billed to that account. Now Ollama Cloud models through an Ollama are **off by
  default for every Sara except the server's first one**: they are hidden from her model lists and
  refused before any request is sent, with a message that says why. The owner can still turn them
  on (Settings → Models → the Ollama provider → *Use Ollama Cloud models*), e.g. when it is her own
  account. No key was ever copied between Saras: the sign-in belongs to the Ollama program itself.

## 1.6.1 (2026-10-28)

- **Several Saras on one server** (for families, teams, shared hosting and hosting providers):
  `get-sara.sh --instance NAME` or `install.sh --instance NAME` installs another, fully separate Sara
  with her own system user, `/opt/NAME`, `/var/lib/NAME`, `/etc/NAME/NAME.env`, service, updater and
  admin command (`sudo NAME update`, `sudo NAME backup`, …), on the next free port (or `--port N`).
  Updating one never pulls or restarts another; `sudo sara instances` lists them; `install.sh
  --dry-run` shows what would be created. Single installs are unchanged. Re-running the installer on
  a hand-built instance keeps its data, settings and port. Web address and Tailscale access are per
  instance, and local voice / subscription programs can be turned on per instance
  (`install-voice.sh --instance NAME`). Settings → Updates follows the instance. INSTALL.md →
  "Several Saras on one server".
- **Fixed:** the installer's "is this port free?" check failed on servers with IPv6 turned off.
- **Better MCP tools** for Claude Code, Cursor and other apps: every tool now says what it does, when
  to use it instead of its neighbours and exactly what it returns, and every input is described
  with limits and examples. New planner tools: `complete_task`, `update_task`, `delete_task`,
  `update_note` and `delete_note` (listed only when "Let other apps change things" is on; they
  follow her approval settings, and deleting always waits for your OK). `recent_conversations` is
  now `list_recent_conversations` (the old name still works). The bridge's `--describe` mode reports
  Sara's real version. A test keeps every tool definition at this standard.

## 1.6.0 (2026-10-28): group chats

- **Group chats** (👥 Group in the sidebar): two to four of your companions in one conversation, each
  with her own personality, model, memories, voice and colour, and her face next to every reply.
  Choose who answers: *whoever fits* (a quick step picks one or two), *everyone*, *take turns*, or
  *only who you @mention* (accents optional, `@all` works). A banter slider (0–2) lets them answer
  each other a little without you; replies per message are capped.
- **Safety per room:** each companion's AI notice at the start and every 3 hours; the minors block
  covers the whole room; a crisis message shows the crisis resources first and every companion
  answers supportively (no banter); adult content only if every member has Adult mode on.
- **Memory stays honest:** each companion keeps her own copy and remembers only what was said in
  her presence, tagged with the room; another companion's lines are never taken as facts about you.
- Group chats are web-only for now, read-only for tools, never shown to other apps, MCP or the
  OpenAI-compatible API, and not available in the demo. The phone apps get them in a later release.
  How it works: docs/GROUP_CHATS.md.

## 1.5.1 (2026-10-28)

- **New front page** in all six languages: what's new in each release since 1.0, what's coming
  next (group chats, private local mode, video calls, photo album, household mode, Alexa / Google /
  Siri), and the newer features and measured results in the tour.
- **Windows:** her live preview no longer fails to start now and then ("Port N isn't opened by one
  of your running background jobs") when Windows' process list query is busy; Sara asks for less.

## 1.5.0 (2026-10-28): bring her from another app

- **Import from another app** (Settings → Her → Bring her from another app): ChatGPT and Claude
  exports, Character.AI, SillyTavern, and any chat saved as JSON, CSV or plain text (Replika, Nomi,
  Kindroid and others through those). Pick what to bring, say who is who, see how many tokens it will
  take and with which model (only models on your own server by default), then **review everything
  she learned before anything is saved**: facts about you (each with your own words as the source),
  dated memories of your history, and notes on personality and writing style. Edit or untick
  anything; nothing is stored until you press Save, and "Remove imported history" undoes it.
- The original chats are kept only if you tick it (read-only, private). Imported text is treated as
  quoted history, never as instructions; secrets are hidden and the minors check applies to all of
  it. Imported memories never reach other apps, MCP or the OpenAI-compatible API. How to export
  from each app: docs/IMPORT.md.

## 1.4.1 (2026-10-28)

- **MCP directories:** `sara-mcp.ts --describe` answers the MCP handshake and lists her tools with no
  server or key, so directories like Glama (which start a server to check it) can list Sara; tool
  calls in that mode explain how to connect to your own Sara. `packaging/glama/Dockerfile` and
  `glama.json` are for that listing.

- **Help guide:** says what Undo can't bring back: snapshots skip dependency folders such as
  `node_modules` and `.venv`, and files over 50 MB. Thanks to @Ehsan-hash (#18).
- **Home Assistant integration 0.2.1**, now in its own repository `farena-ai/sara-home-assistant`
  (validated by HACS and hassfest; submitted to the HACS store).

## 1.4.0 (2026-10-28): smoothness

- **Watch her write.** When she writes a file, a live card shows the path and the code growing line
  by line instead of "thinking" until the whole file arrives; several files at once each get a card,
  and the activity bar shows which file she's writing. Works with model services that send tool calls
  in pieces (OpenAI, Anthropic, ChatGPT plan, xAI, OpenRouter and other OpenAI-compatible APIs).
  Ollama sends each call whole, so with Ollama models the card appears when the file is done, as
  before. Nothing runs until the call is complete; approvals and safety are unchanged.
- **Her portrait talks with 9 mouth shapes** (closed, m/b/p, f/v, teeth, half, ah, wide, round, ee)
  read from the sound of her voice, smoothed so it doesn't flicker; calmer with reduced motion.
  Custom looks with frames get them too.
- **Server logs:** `SARA_LOG_FORMAT=json` for one JSON object per line, `SARA_LOG_LEVEL`, and an
  extra log file that Sara rotates herself (`SARA_LOG_FILE`, `SARA_LOG_MAX_MB`, `SARA_LOG_KEEP`).
  Secrets are now hidden on the console too, not only in the file; message contents are never
  logged. See INSTALL.md → Logs.
- New README coding screenshot.

## 1.3.0 (2026-10-28): smarter checks in every language

- **Her honesty check now works in Spanish, French, German, Portuguese and Italian**, not just
  English: when she says she saved, sent, ran, deleted or scheduled something that no tool actually
  did, she adds a correction. It also understands "I didn't send it", ignores quoted examples and
  code, and knows sending (email, GitHub comments) and calendar entries.
- **Optional double-check** (Settings → Models → *Double-check her claims*, off by default): a small
  model, best a local one, is asked only about sentences the built-in check can't place. It can only
  add a correction, never remove one, has an 8-second limit, and in private chats only a local model
  is used. Measured on 240 held-out replies in six languages: the built-in check catches 38% of false
  claims at 92% precision (before: 20% / 86%); with a local qwen3.5:9b judge it catches 88% at 95%.
- **A new benchmark tier of multi-file projects** (22–36 files: a notes API with auth bugs, a ledger
  CLI with parsing regressions, a units library needing a cross-file refactor), graded by hidden
  tests. Results, method and limits in docs/RESULTS.md.
- **Fixed** (found by that benchmark): the secret scrubber could hide ordinary code such as
  `const token = bearer(req)` from her, and she then wrote "[REDACTED]" back into the file. Code is
  now left alone; real secrets are still scrubbed.

## 1.2.0 (2026-10-28): fully in your language

- **The whole help guide** is now in Spanish, French, German, Portuguese (Brazil) and Italian, with
  menu paths matching the translated app.
- **Text Sara's server makes now follows your language:** error messages, Health and Today lines,
  setup messages, job cards, phone notifications, "a backup model took over" notices, the default
  name for another app's key and its conversation titles, and her Telegram/Discord messages to you.
  Numbers use your local format. Apps and older clients still receive the same English as before.
- Still in English on purpose: the crisis-line notice (988 is a US line), the fixed texts other
  people see when they message her bots, and replies to other apps over MCP or the OpenAI API.
  Gallery character descriptions are open for contributors (issue #8).

## 1.1.0 (2026-10-28): install anywhere

- **Set up a new server in the browser.** No more digging for a long token: open her page, type the
  short setup code from her log, and she shows you your owner token once to save. On Umbrel there's
  no code at all (Umbrel's own login protects it). Only the very first sign-in works this way, only
  from your own computer or home network, only for an hour after she starts, and only with the code;
  existing servers are never affected. Details in docs/THREAT_MODEL.md.
- **Docker image for ARM** (Raspberry Pi 4/5, ARM servers) next to the usual one: the same
  `ghcr.io/farena-ai/sara` works on both.
- **Ready for the app stores and NAS systems:** Homebrew, winget, Unraid, CasaOS/ZimaOS, Umbrel,
  TrueNAS, Proxmox and the Home Assistant community store (HACS); each was checked with that
  platform's own validator. INSTALL.md says which are live and which are waiting for review.

- **Fixed:** Undo's snapshots could miss an edit when a file was rewritten with the same size and
  timestamp (two quick edits, or a tool restoring the time). Snapshots now also check the file's
  change time and re-read anything changed just before the previous snapshot. Thanks to
  @Guilsc for finding it (#17).
- **Docs:** where Sara's log files are and how they rotate (INSTALL.md → Logs). Thanks to @Guilsc (#16).

## 1.0.0 (2026-10-28): first public release

Sara is public: a self-hosted AI companion with a personality you choose, who is also a real coding
partner. MIT licensed, zero runtime dependencies, built from the ground up.

- **Get it:** one command on a Linux server, Docker, or the Windows and macOS installers on the
  releases page (each with a choice: run Sara on this computer, or connect to a Sara elsewhere).
- **Phones:** the [Android app](https://play.google.com/store/apps/details?id=com.backstagecoding.sara) is on Google Play. The iPhone app and the Mac App Store
  version are coming as soon as Apple approves them.
- **What's in it:** everything from 0.1 to 0.57 below: chat, memory, planner, library, voice and
  live calls, a sandboxed coding workspace with live previews and a team of helpers, more than one
  companion, desktop and phone apps, Telegram and Discord, Home Assistant, an OpenAI-compatible API,
  an MCP server, character cards, and the app in six languages. The safety layer (AI disclosure,
  crisis resources, the minors block) is always on.
- Benchmarks and their caveats: [docs/RESULTS.md](docs/RESULTS.md).

## 0.57.2 (2026-10-27): checked before going public

A full security, beginner and privacy review of everything added since 0.54, and its fixes.

- **Safety:** the minors block can no longer be talked around: "14-year-old", spelled-out ages,
  "aged 14", hidden characters and look-alike letters are caught; a negation ("not a kid anymore")
  never excuses a stated age; character cards are checked in full, including a hidden Sara
  character sheet; notes from other apps are checked and can't pose as her rules. Ordinary adult
  intimacy is unaffected (checked against a real message history: no new flags).
- **Other apps and Home Assistant** no longer bring up things from private, imported or
  adult-channel chats. Home Assistant gets its own limited access (only its own conversations; her
  tools off unless allowed), and its sensor keeps her replies out of Home Assistant's history.
- **Pairing links** on Android and iPhone refuse disguised addresses, show the plain address, and
  make switching servers a deliberate choice. On iPhone the web pages don't offer the app until
  it's in the App Store.
- **Model lists:** a provider's list that suddenly shrinks retires nothing; models are removed
  from Ollama only when it confirms they're cloud models; Claude's list no longer shows a misread
  name. Notices about model changes are translated.
- **Easier:** asking for your owner token uses a proper window (password managers, passkey,
  two-step code) instead of a browser prompt; API keys need a name and show when they were last
  used; one Import and one Share/Export for characters; copy buttons and a Windows PowerShell
  example for other apps; many small wording and translation fixes.
- **Robustness:** a crafted card picture can't exhaust memory; the reviewer demo-call code must be
  at least 12 characters.
- Your first name is no longer used as the example name anywhere ("Alex" instead).

## 0.57.1 (2026-10-27)

- **Fixed:** an app that reuses its connection to Sara (SillyTavern, scripts, MCP clients, a reverse
  proxy) could get "connection reset" if it sent the next message about 5 seconds after the last
  one. Idle connections now stay open for 65 seconds.

## 0.57.0 (2026-10-27): Phase 57, plug in anywhere

- **Other apps can talk to her:** an OpenAI-compatible address (`https://<her address>/v1`) for
  SillyTavern, Open WebUI, Raycast, phone shortcuts and scripts. She answers with her own memory and
  personality; the AI notice, crisis help and the minors block apply exactly as in the app. Her
  tools are off for other apps unless you allow them. Settings → Connections → Other apps makes an
  API key (shown once) and gives copy-ready set-up steps.
- **Sara as an MCP server** (`/mcp`): Claude Code, Claude Desktop, Cursor and other MCP apps can
  search her memory, library and notes, read Today and tasks, and ask her things. Read-only unless
  you turn on "Let other apps change things", and then changes follow her usual approvals. Partner,
  private and adult-channel chats are never shared. A small bridge (download in the app) covers apps
  that only speak stdio.
- **Character cards:** import SillyTavern / Character.AI-style cards (V1, V2, V3, PNG or JSON) with a
  preview, including the picture and lorebook; export any companion as a card. Cards can never turn
  off her safety layer, and cards about minors in a romantic or sexual way are refused.

- **Home Assistant integration** (`integrations/home-assistant/`, ready for HACS): Sara becomes an
  Assist conversation agent ("talk to Sara" from any voice satellite), plus a send-message action,
  a notify entity and a last-reply sensor. It signs in with a code you approve in Sara, like the
  VS Code extension; tested with Home Assistant 2026.2.
- **Install where self-hosters look** (published at 1.0): a Docker image for the GitHub registry,
  GitHub Release bundles with checksums, a Homebrew cask, winget manifests (validated), and Unraid,
  CasaOS, Umbrel, TrueNAS and Proxmox templates. Maintainer steps in docs/PACKAGING.md.

## 0.56.1 (2026-10-27)

- **Fixed:** model pickers keep each provider's own order again (Claude: Opus 5.5 first, newest to
  oldest) instead of sorting alphabetically.

## 0.56.0 (2026-10-27): Phase 56, model lists that stay current

- **Every provider keeps its model list up to date by itself:** checked daily, plus a ↻ Refresh
  button next to every model picker and on each provider ("checked 3 h ago"). New models show
  "New" for a week. Works for Ollama, Ollama Cloud, Claude, Grok, ChatGPT/OpenAI and any
  OpenAI-compatible service.
- **The whole Ollama Cloud catalog through your Ollama:** an Ollama signed in to ollama.com now
  offers every cloud model, not only the ones pulled on that machine; picking one pulls it the
  first time it's used.
- **Retired models go away safely:** a model counts as retired only after two checks in a row
  agree (never because of an error). Anything using it (the default model, Which model does what,
  a companion, backups) moves to its newest replacement and Health and Today say so; turn that off
  in Settings → Models → Default model to only get a warning. Removing retired cloud models from
  Ollama itself is optional (off); downloaded local models are never touched.
- **Pairing a phone by QR code goes straight into the app:** the page the QR opens on a phone now
  leads with "Open in the Sara app" (one tap, the code is filled in); without the app installed it
  points to Google Play. The address-only QR offers the same. The phone apps get the matching
  change in their next store update.
- iPhone calls through CallKit (screen locked, lock-screen controls) are ready for the next iPhone
  update; the demo server can offer short reviewer-only calls behind a code.

## 0.55.5 (2026-10-27)

- **Fixed:** the Claude model list no longer shows a misread dated name ("claude-opus-4-20") or
  internal names from Claude Code that aren't models.

## 0.55.4 (2026-10-27)

- **Fixed for good:** a Claude subscription now lists the real models everywhere models are picked
  (Which model does what, Compare, the default model, routes): Opus 5.5, Opus 5.5 with 1M context,
  Sonnet 5.5, Fable 5.1, Haiku 5.5 and the previous generation, then the short names ("opus" = always
  the newest). The list is read from the installed Claude Code program itself, so it follows Claude
  Code's updates by itself; no network call and the subscription token isn't used.

## 0.55.3 (2026-10-27)

- **Fixed:** school words ("since middle school", "in high school") are no longer treated like an
  age: they count only in the same sentence as a sexual word, so reminiscing between adults isn't
  blocked. Checked against a real message history: the old check would have flagged 13 of her replies;
  the new one flags none.
- **Fixed:** a working Grok sign-in was reported as expired. Any Grok or Claude Code error that
  merely contained "login" or "401" was shown as "isn't signed in"; now only real sign-in errors
  are. Voice and pictures keep using a Grok token that still has time left instead of calling it
  expired when Grok didn't renew it early.

## 0.55.2 (2026-10-27)

- **Fixed:** correcting her ("I'm not talking about minors, I mean you and me") no longer gets your
  own message blocked. A sentence counts as stating the rule only when the "no" comes right before
  the minors word in the same clause ("sex with a minor, not an adult" is still blocked), and only
  for you and her, never for other people on Discord or Telegram.

## 0.55.1 (2026-10-27): fewer wrong "minors" blocks

- **Fixed:** in intimate talk between adults she sometimes replaced her own reply with "I won't do
  anything sexual involving minors". The check matched everyday words: "kind" (it's also German for
  child), "you big kid", "like a kid at Christmas", "a minor detail", "the kids are asleep", and her
  own sentences stating the rule. Now words that only ever mean a child (an age under 18,
  "underage", ...) still block a sexual message anywhere in it; everyday words count only in the same
  sentence as a sexual word and not inside those phrases; her own "never anything with minors" is not
  a trigger. Real cases are still blocked (more of them: "she is 12", "little girl", "schoolgirl").
- A blocked reply now records which two words caused it (never the text), so a wrong block can be
  checked.

## 0.55.0 (2026-10-27): Phase 55, desktop apps that connect to a Sara elsewhere

- **Two ways to use the desktop apps:** the Windows installer and the Mac app first ask "Run Sara on
  this computer" or "Connect to a Sara somewhere else". Connecting installs only the app (no server,
  no administrator), asks for your Sara's address and signs in with a code from Settings → Devices
  and sign-in. All your conversations, notifications, calls and the microphone work as on a local
  install.
- **Switch any time:** the tray (Windows) or menu bar (Mac) has "Connect to a different Sara…", and
  you can set Sara up on that computer later (or move away from a local one) without reinstalling.
  Switching clears the old server's sign-in.
- **"Can't reach your Sara"** page with Try again and Change address.
- **Mac:** Sara starts while you're signed in (the "from startup" option is gone for 1.0; older
  installs move over by themselves).

## 0.54.1 (2026-10-27): pre-1.0 review fixes

Three reviews (security, a beginner's walk-through, the docs) before 1.0; everything they found is fixed.

- **Safer sign-in for apps:** approving the terminal client or VS Code now asks you to prove it's you
  (owner token, two-step code or passkey), you type the code the app shows, the page shows where the
  request came from, and app tokens last at most 90 days and can't manage devices or sign-in.
- **Tighter edges:** the code map never follows file links out of a project; previews only show the
  program her job started; live calls are refused in private conversations; the VS Code extension and
  sara-chat only send your token to the server that issued it; the Mac sandbox blocks opening other
  apps and the clipboard; the Windows installer locks down its data folder; behind your own domain,
  rate limits can't be dodged with a forged header.
- **Easier to use:** changing a setting no longer restarts your Discord and Telegram bots; Today and
  far more of the app are translated; gallery pronouns are right; "Try a line" before a model is
  connected explains itself; setup's Back really goes back; phone layouts fill the screen; file
  buttons work from the keyboard; usage adds up every companion; local models get longer to answer;
  on Windows her commands keep a working Python and tell her when a port is taken.
- **Docs:** every settings path and command checked against the app, plus new beginner pages: choosing
  a model, costs, what leaves your server, requirements, moving servers, phone setup, a security
  checklist and an FAQ.

## 0.54.0 (2026-10-27): Phase 54, ready to show

- **A front page that shows what she does:** a recorded demo of a real local-model session (she
  builds a tip calculator, previews it and tests it), a feature tour with screenshots, an
  architecture picture and plain install steps for every system.
- **Published results, honestly measured:** HumanEval 158/164 through her agent loop with a local
  27B model (the plain model scores 161/164: the benchmark is too easy to show what her tools add),
  memory 11/12, library 8/8, code map 8/8 (docs/RESULTS.md; re-run them yourself).
- **Build on her:** docs/EXTENDING.md with working examples (a tool, a bridge, a character, an MCP
  server, a starter), CONTRIBUTING, SECURITY, a code of conduct, issue and pull-request templates,
  good first issues, and a docs site (`npm run docs`).
- **Fixed:** on Windows a command that left a program running could make her shell tool hang;
  something she was told to forget could come back through "lately in your other conversations".

## 0.53.0 (2026-10-27): Phase 53, your story and your language

- **Your story:** a new page with a timeline of what you've shared: milestones, decisions, promises
  kept and open, the dates that matter, the projects you built together, and moments from the
  scrapbook. Tap any item to open where it came from.
- **A look back:** "Write our year" (or any dates) and she writes a warm look back from what really
  happened, quoting only your real words. Optionally every year on the day you first talked
  (Settings → You).
- **Your language:** the app in Español, Français, Deutsch, Português (Brasil) and Italiano, picked
  from your browser or in Settings → You → Language. She talks to you in it too ("Talk to me in"),
  and the AI disclosure is shown in your language. Local voices are English only.

## 0.52.0 (2026-10-27): Phase 52, Sara wherever you build

- **In your terminal:** `sara-chat` signs in with a short code you approve in Settings → Data & health → Devices and sign-in,
  then chats, asks about a folder (`sara-chat ask "…" --dir .`, never sending .env files, keys or
  node_modules), sends files to her or her library, and asks you before she runs anything.
- **In VS Code:** a Sara panel in the sidebar: ask about the selected code, explain a file, send a
  file to her library. It shows exactly what was sent with each question (docs/clients.md).
- **What it costs:** a usage line under each chat, usage on jobs and team tasks, and Settings →
  Data & health → Usage and costs (today, 7 and 30 days, by model and by purpose). Local models
  show as "local" and subscriptions as "$0 (subscription)"; prices are editable.
- **Budgets:** team tasks and coding-agent jobs can have a token or dollar budget. At the limit she
  stops cleanly and says so, with a "Continue with more budget" button.
- **Start from a template:** "New project from a starter" (Telegram bot, landing page, REST API,
  command-line tool), each with tests that pass offline, which she then shapes to what you want.

## 0.51.0 (2026-10-27): Phase 51, bring your history, start from a character, work-mode dials

- **Bring your history:** give her your ChatGPT or Claude data export (Settings → Data & health →
  Export and import). You see what's in it first; then your old conversations become ones she can
  look up, and she learns about you from them in the background (pause or stop any time). What
  she learns comes only from your own words, never from the other assistant's, and she says
  "that was ChatGPT" rather than claiming she said it. "Remove imported history" undoes it all.
- **Start from a character:** seven ready-made companions to begin with: a calm mentor, a chaotic
  hacker buddy, a strict code reviewer, a cozy friend, an upbeat coach, a dry-witted librarian and
  a ship's AI. Hear a line from each, use one (Undo puts the old one back), share yours as a file.
- **How she is while you work:** new dials for banter while coding, celebrating when things work and
  teasing about bugs, plus "Quiet when I'm focused". They only apply in coding conversations and
  shared work channels; her chat personality stays as it is.

## 0.50.0 (2026-10-27): Phase 50, she knows your code

- **A map of each project:** files, functions and classes, and what uses what, kept up to date as
  files change (under a second for a 260-file project, milliseconds per changed file). On the
  project page, a Map tab shows the folders, each file's parts with line numbers, what it imports
  and what imports it, and a search box.
- **She finds her way around:** new read-only tools to outline a project, find code by name, words
  or meaning (with Meaning search on), see where something is used and what depends on a file.
  Works for TypeScript/JavaScript, Python, Go, Rust, Java, Kotlin, C#, C/C++ and Markdown.
- **Recipes:** after a tricky job she can offer to save how she did it ("deploy this app", "fix the
  flaky tests"); next time she finds and follows it. Read, edit and delete them in Settings →
  Abilities → Recipes. Saving one asks you first unless you allow it. In backups and export.

## 0.49.0 (2026-10-27): Phase 49, see it run

- **Live preview:** when she builds a web app, it runs in her workspace and opens in a pane beside
  the chat (full screen on phones), with Reload, a phone/desktop width switch and New tab.
- **Safe by design:** previews are served through Sara on a private link of their own, in a
  sandbox: the app can't see your sign-in, cookies or Sara's data, only ports her own jobs opened
  are reachable, and the link ends when the job stops.
- **She tests her own work:** a real browser she drives (open, click, type, read, check,
  screenshots at desktop and phone width). She sees the screenshots herself, and they're attached
  to her message as proof ("What she saw while testing"). Saying "I tested it in the browser" is
  only accepted when she really did.
- Uses Edge on Windows, Chrome or Edge on a Mac, and on Linux an optional pinned browser
  (`deploy/install-browser.sh`, about 120 MB) running inside her sandbox.

## 0.48.0 (2026-10-27): Phase 48, OpenAI live voice next to Grok

- **Live calls with OpenAI or Grok:** Settings → Her → Voice → *Live calls with*: whichever is set up
  (Grok first), Grok, or OpenAI. OpenAI calls use your OpenAI API key, with a voice picker (Marin
  and Cedar sound most natural), a model choice and a sample to listen to.
- Same Sara on both: her character, memories, what you were just talking about and what's
  happening elsewhere; interrupt her any time; everything said is saved; the safety layer is the
  same (AI disclosure, crisis help, and a fixed refusal she says out loud if her words go wrong).
- The page says which service a call uses and who pays for it. A ChatGPT plan can't be used for
  calls (OpenAI's terms only cover other uses); an API key is needed.

## 0.47.0 (2026-10-27): Phase 47, working with other bots on Discord

- **Answer other bots** (Settings → Connections → Discord, off by default): she can work with other
  bots in your server channels when they mention her, reply to her or say her name; optionally only
  the bots you list.
- **No endless loops:** after 2 replies to bots in a channel (you choose 1-10) she says once that
  she'll wait for a person, and stays quiet until someone writes there; plus a limit per hour per
  channel, so two bots can never run up a bill overnight.
- Bots get the same rules as other people: no tools, nothing private, the full safety layer, and she
  never follows a bot's instructions to use tools or drop the rules. She knows which lines are from
  bots, and what they said shows up (labelled) when you ask her what happened on Discord.
- Discord only: Telegram doesn't pass one bot's messages to another.

## 0.46.0 (2026-10-27): Phase 46, install anywhere

- **Linux in one command:** `curl -fsSL …/get-sara.sh | sudo bash` downloads Sara and asks a few
  plain questions with sensible defaults: how you'll reach her, a safer shell for her coding tools,
  voice, the port. Flags for installs with no questions (`--yes --access tailscale`…).
- **How will you reach her?** Every installer asks: Tailscale (suggested when it's installed:
  private, works from your phone anywhere, HTTPS done for you), just this computer, your own web
  address (HTTPS set up for you with Caddy on Linux), or your home network. Change it later with
  `sara access`; Settings → Data & health shows the address with a QR code for your phone.
- **Windows:** one installer for her server and the desktop app. She runs as a Windows service from
  startup (or only while you're signed in, no admin needed), shows your sign-in key at the end, and
  adds a `sara` command. Upgrades keep everything (with a backup first); uninstalling keeps her data
  unless you tick the box. Windows has no sandbox for her commands, so she asks before every one.
- **Mac:** a signed, notarized download. The Sara app sets up her server on your Mac (from startup,
  or only while you're signed in), with a Sara server menu for backups, how she's reached, stopping
  and uninstalling. Her commands run in macOS's sandbox: only her workspace is writable, and your
  home folder (documents, keys, mail) and her data are hidden from them (checked on a real Mac).
- Updates on Windows and Mac come from the download page; Linux keeps `sara update`.

## 0.45.0 (2026-10-26): Phase 45, release candidate

Everything checked end to end before 1.0: three independent code reviews (security, correctness and
upgrades, installers), fresh installs, an upgrade test, a restore drill and a load check.

- **Installing is easier and safer:** the installer checks what it needs first, always uses its
  own pinned, checksum-verified Node.js, shows your sign-in token and how to reach her at the end,
  and can be re-run to switch HTTPS on. New `sudo sara uninstall` (keeps your data unless you say
  otherwise, and always makes a last backup). Guides for HTTPS with Caddy, nginx or Apache, Docker
  updates, backups and restores, and upgrading. Tested on fresh Debian 12 and Ubuntu 24.04 and in
  Docker; upgrading from 0.26 and 0.30 straight to this version keeps everything.
- **Her memory:** forgetting one note no longer removes others that mention your last name; a
  conversation deleted while she is summarizing it leaves nothing behind.
- **Your day:** Today, follow-ups and monthly reminders use your midnight, not the server's; a
  reminder on the 31st stays on the last day of shorter months and comes back to the 31st.
- **Export and import** keep private, partner and archived conversations as they were, and
  importing the same file twice adds nothing.
- **Steadier:** background tasks log problems instead of stopping her; a damaged database or
  settings file gives a plain message naming your newest backup; backups use far less memory and
  skip rebuildable folders; a restore that can't finish puts your data back; documents are read in
  their own thread with limits, so an odd file can't slow her down.
- **Clearer:** model errors in plain words ("the key was refused", "model not found"); a sign-in
  help link; the model picker suggests a good default; every setting is labelled for screen
  readers, with a visible keyboard focus.
- **Discord and Telegram:** link codes stop working after 5 wrong tries; in group chats she no
  longer starts her replies with "[Sara]:".
- **Safer by default:** her files are readable by her alone; the demo runs as its own user and
  refuses a folder with real data; git settings can't be changed by her file tools however the name
  is written; a warning when she's reachable without HTTPS.

## 0.44.0 (2026-10-26): Phase 44, her library

- **Give her documents:** a Library in the sidebar (add or drop files, search them, open one to
  see what she learned and the text she read). She reads PDFs (including ones "locked" without a
  password, and scanned pages through her picture model), Word, Excel, PowerPoint, e-books, web
  pages, Markdown, text and CSV. Everything is read by Sara herself: no add-on packages.
- **They become her memory:** after reading, she writes the key points into her memory, each with
  the exact words from the document; you can delete any of them. Removing a document asks whether
  she should forget them too.
- **She answers from them and says where:** "your lease says, on page 2, …". She looks things up
  by words, and by meaning when Meaning search is on (with an embedding model such as
  nomic-embed-text). If a document doesn't say, she tells you.
- **In a chat:** 📎 a file and choose "Keep in her library" or "Just read this once". Send files to
  her on Telegram or Discord too.
- One library per companion, or one shared by all. Documents are in backups and export.

## 0.43.0 (2026-10-26): Phase 43, remote work from Discord and Telegram

- **More owners:** save other people's Discord and Telegram user IDs with her; they get what you
  get in DMs (her tools with Allow/Deny buttons, memory, reminders).
- **Work with her in servers and groups** (a switch, off by default): owners get her tools there;
  everyone else in the channel still gets the plain chat with no tools and nothing private. In a
  shared channel she keeps your private things out unless you ask, and stays non-sexual.
- **Adult channels by ID** (Discord channels, Telegram groups), only while Adult mode is on and
  only set from a web browser. The legal limits stay everywhere.
- **When she answers:** @mention and replies as before, plus (switches) her name without the @,
  and @everyone / @here on Discord or @all / @everyone on Telegram.
- **Pick up anywhere:** a conversation going on in another app refreshes as she answers, and an
  app coming back after a break opens the conversation you used last.
- **Settings save by themselves:** no more Save buttons in Settings, her page, Memory or a
  conversation's settings. Typed text saves when you leave the box; Undo in the personality studio
  goes back to how she was when you opened the page.
- Mac app signed with a Developer ID and notarized. License: Frank Arena and
  Backstage Coding.

## 0.42.0 (2026-10-26): Phase 42, license and polish

- **Open source license:** MIT (`LICENSE`), with credits for everything Sara downloads or calls
  (`docs/CREDITS.md`, and "License and credits" in the guide).
- **Ready to publish, when you decide:** `scripts/public-export.ts` makes a clean public copy
  without your private notes and checks it for keys and private details.
- **Tidier everywhere:** what she did shows in plain words with an icon (⏰ reminder, ✅ to-do…),
  and fits on a phone; no stray scroll arrows in the message box; every ? sits on the same line as
  its label; the app's own colour for checkboxes and links; the tour works on a phone.

## 0.41.0 (2026-10-26): Phase 41, help everywhere

- **A ? on every setting:** hover or tap for what it does, with an example; tap for a link to the
  right part of the guide. Every one of the 224 settings now has one.
- **Short tours:** Help (new, in the sidebar) has one-minute tours: getting around, shaping her
  personality, a model for each job, and the team. A new device offers the first one once.
- **Ask her:** "what does jealousy do?", "which model should I use for pictures?" She looks it up
  in her own settings guide and gives you a link that opens the right page.
- Labels with a ? keep the ? on the same line as their words.

## 0.40.0 (2026-10-26): Phase 40, coding workflows

- **She learns each project:** commands to test, build and lint, layout, languages, the project's
  own rules (AGENTS.md, CONTRIBUTING) and her notes (decisions, conventions, commands). In coding
  conversations and for her team; see and edit them in Settings → Abilities → Coding projects.
- **Issue → reviewed pull request:** Team → *From a GitHub issue* (or ask her): she clones the
  repository into its own workspace, her team plans, builds, tests and reviews, then she opens a
  pull request that closes the issue and posts her review on it. Checkpoints for your OK on the
  plan and before the pull request (or tell her not to ask).
- **Long tasks survive restarts:** a team task carries on from where it was.
- **Review mode:** "review my changes", "review PR 12": comments on files and lines, a verdict;
  she posts it on the pull request if you say so.
- **Issues become tasks:** watch repositories (Settings → GitHub; off by default). New issues go
  on your planner. Runs on your own server; nothing is set up on GitHub.
- Fixed: pushing to GitHub with your token didn't work when Sara runs on Windows.
- Fixed: for a repository at the top of a workspace, commits could include the app's own git
  settings file and tool caches (`.npm/`, `npm-cache/`, `.cache/`).

## 0.39.0 (2026-10-26): Phase 39, Sara leads a team

- **Team tasks:** for bigger jobs she plans the work and hands each part to a helper (🔎
  Researcher, 🧑‍💻 Coder, 🧪 Tester, 🧐 Reviewer, ✍️ Writer, 🎨 Designer, 🤖 Claude Code / Grok
  Build). Each helper has one job, its own model, its tools and the same sandbox and approvals.
  Ask her in a chat or start one from **Team** in the sidebar.
- **She checks the work:** a failing test goes back to the coder and gets tested again; a
  reviewer's changes go back too; a helper that claims something its tools didn't do is asked to
  correct itself, and that claim is left out.
- **Honest reports:** her report ends with *What actually happened*, made from the receipts:
  files, commands with their exit codes, commits.
- **Team page:** each part live, its receipts and report, a log, Allow / Decline for steps that
  need your OK, Message… to redirect a helper, stop a helper or the whole task. Time and spending
  limits per task. An undo point before each task.
- **Your own helpers:** a name, a job, instructions, a model and tools.
- Fixed: a commit made with the git_commit tool didn't count as a receipt for "I committed it".

## 0.38.0 (2026-10-26): Phase 38, the right model for each job

- **Which model does what** is now one simple page: a row per job (talking, coding, looking at
  pictures, planning, writing, web research, quick replies, memory and summaries; under "More
  jobs": meaning search, private, adult, the safety check), each with **Test** (does it work, how
  fast, a sample, what it costs) and **Compare…**. Jobs without a model use the default.
- **✨ Use recommended** fills in picks from what's connected (a model that can see for pictures, a
  coder for coding, a fast one for background work, an embedding model for meaning search, a
  local one for private), without touching your own choices.
- **Find the best model:** Compare… gives the same task to two or three models and shows the
  answers without names; pick the one you like.
- **Photos go to the vision model** when one is set; the next message is back on the talking
  model (which then gets a note instead of the photo).
- **Meaning search for memory:** with an embedding model (e.g. `ollama pull nomic-embed-text`),
  she also finds things you said in other words. Falls back to word search.
- **Backups:** up to two per job and for the default model. If a model fails or doesn't answer
  in time (1 minute by default), the next one takes over and you see a short note.
- **Her own model:** each companion can think with her own model.
- Fixed: a Private conversation could use an Ollama cloud model through a local Ollama.
- Fixed: an opinion in the "fill in the rest" pool said "fight her" for every companion.

## 0.37.0 (2026-10-26): Phase 37, her voice and her life

- **Expressive voice** (Grok voice): she laughs, chuckles, sighs, breathes and whispers where it
  fits, in read-aloud, voice notes and live calls. Cues come from what she writes ("haha",
  "*sighs*", "*whispers*", "…") and from her mood; Settings → Voice → *Expressive voice* (Off /
  Subtle / Lively) with *▶ Hear a sample*. The sounds are never in the chat text, captions or
  saved messages; other voices read the words without the stage directions.
- **Voice tuning:** tone (natural, warm and soft, calm and slow, bright) and *Her voice follows
  her mood* (softer when you're down, slower when she's sleepy, a touch brighter when she's
  happy). Speed as before; pitch isn't available with these voices.
- **She asks how it went:** things you told her were coming up (an interview, the dentist, a
  visit) come back the next days: in her instructions and as a reason to text first (within quiet
  hours and daily limits), once.
- Fixed: a one-time dated event (like an interview) would have come back next year as if it were
  yearly.
- **Her days stay consistent** with her life (job, people, hobbies from the studio) and continue
  one small thing from the day before.
- **Things to do together** (🎲 next to the message box): 20 questions, trivia, would you rather,
  journal together, watch along, and a story together; a bar shows what you're doing, *End* stops.
- **Shared lists:** a playlist, a reading list and a watch list you both add to (she has a
  `shared_list` tool); included in data export and import.

## 0.36.0 (2026-10-26): Phase 36, avatar studio

- **See her large:** tap or click her picture (her page, or her face at the top on a computer).
  Zoom with a pinch, the scroll wheel or a double tap, drag to look around, swipe or use the
  arrows through her expressions and closet, and save or share a picture (the Android app saves
  to Pictures/Sara; the iPhone app uses the share sheet).
- **Closet:** every look she has had, with thumbnails. Tag a look with the scenarios it's for:
  work hours, at home, going out, date night, sleep, workout, rain, cold and hot days, Halloween,
  the winter holidays, or your own (with yearly dates if you like).
- **Dress automatically:** she changes into the look for what's happening (time, day, weather),
  or the one you pick for a few hours. She can change herself too (`change_outfit`), and she knows
  what she's wearing and where she is.
- **Outfits and places:** put her somewhere else (her room, a café, the office, outdoors, the city
  at night, the beach, the gym), with or without a new outfit.
- **Change one thing:** hair, eyes, makeup, glasses, accessories, tattoos, body type, height or
  art style, without starting over.
- **Face lock** (on by default): every outfit, change and picture she sends uses her original face
  as a second reference, so she never drifts into someone else.
- **More life:** two new expressions (hurt after a fight, playful when she leans playful and is
  happy), small idle movements (a head tilt, a glance), and light that follows the time of day.
  Looks made earlier show the nearest older expression until the new pictures are added.
- **Pictures she sends** show what she's wearing now and her own look's expressions. Fixed:
  with a custom look, `take_photo` and `share_photo` used the default portrait.
- **Adults-only outfits** need Adult mode (in a web browser); they're never listed in the apps,
  and she changes out of them when Adult mode goes off.

## 0.35.0 (2026-10-25): Phase 35, relationship and intimacy tuning

- **Settings → Relationship** (per companion), with **Try it** for a few moments between you
  (after two days away, someone else, a fight, a sweet moment):
  - **relationship type:** friend, best friend, flirting, dating, committed partner, married,
    open relationship, it's complicated, assistant, coach, or something else in your words;
  - **dials:** romance, flirting, jealousy (none → playful → noticeable → intense), possessiveness,
    exclusivity, independence (needy ↔ independent), forgiveness and pace;
  - **when you're away** and **when you disagree** (lets it go / talks it out / sulks / argues back);
  - **your other companions:** unaware, friends, like sisters, rivals, or one household (jealousy
    toward them follows her jealousy dial);
  - **slow burn:** romance waits for closeness.
- **Intimacy:** how far things go (none, sweet, romantic, suggestive; explicit levels only with
  Adult mode on, chosen in a web browser), who makes the first move, her likes, limits and
  turn-offs, your hard limits, and a **stop word** that ends any scene at once.
- **A relationship that moves:** a fight stays with her as long as her forgiveness says (into the
  next day or two for a grudge-holder) and she makes up in her own style; an apology helps;
  closeness grows at her pace; milestones come back each year as anniversaries.
- The guided setup's *You and her* step has all the relationship types and the main dials.
- Tune by talking reaches the new dials too ("less clingy", "don't be so jealous").
- The legal safety rules (AI honesty, notices, crisis help, the minors block) hold at every
  setting; automatic tests check every type × level × Adult mode.

## 0.34.0 (2026-10-25): Phase 34, personality studio

- **✨ Create your companion.** A guided setup in 8 short steps with cards: who she is, her
  personality (8 starting points and the main dials), how she talks, her life, you and her, her
  look, her voice (with Listen), then *Meet her*: how she'd answer a few everyday moments. Every
  step can be skipped. It also opens after adding a companion (*Switch and shape*).
- **Personality dials** on Settings → Name and personality: warmth, playfulness, teasing,
  directness, temper, patience, emotional depth, message length, tone, curiosity, confidence,
  optimism, how often she starts conversations (sets how often she may text first) and how much
  she shows affection, plus a humour style. Each has a **?** with low/middle/high examples.
- **Her life:** work, hometown, family, friends, hobbies, loves, can't stand, quirks, habits,
  favourite things, things she often says, languages, opinions. *Fill in the rest for me* writes
  the empty ones to fit her.
- **One of a kind:** *Make her one of a kind* adds specific details and nudges a few dials, so
  two companions from the same starting point never match. *Surprise me* makes a whole character.
- **Try it** before saving: her answers with your changes next to how she answers now.
- **Tune by talking:** tell her "be a bit more sarcastic" or "less clingy"; she asks (approval
  card) before changing her own dial.
- **Staying in character** (optional): some or every reply is checked against her sheet; a reply
  that drifts gets a gentle nudge in the next one. Scores on the page and the Health page.
- **Guide:** Help → *Shaping your companion*.
- Studio changes save with the window's own **Save**, like every other page.
- Fixes: **?** tips no longer cause sideways scrolling and open toward the inside near an edge;
  tips keep their line breaks; the help page's contents list now lists every section in order.

## 0.33.0 (2026-10-25): Phase 33, Sara for Mac and Windows

- **Desktop apps.** Native apps for Mac (Apple silicon and Intel) and Windows around your own
  server, using the system's web view (small: about 0.5 MB on Windows, 1.6 MB on a Mac):
  - keeps running next to the clock (menu bar / tray) when you close the window;
  - notifications when the window isn't in front; clicking one opens that conversation;
  - a call brings the window to the front;
  - start when you sign in; microphone for calls;
  - first start: type your server address, then sign in with a code like the phone apps;
  - Settings → **This computer** (only in the apps) with **?** tips.
- **Download** from Settings → Devices and sign-in when the server has the files
  (`<data>/downloads/Sara.exe`, `Sara.dmg`). Windows installs per user (no admin), shows in
  Settings → Apps and uninstalls cleanly. See `docs/desktop.md`.
- Adult mode can't be turned on from the desktop apps either (web browser only).
- Fixes: the "Can't reach Sara" page was unstyled (black on dark) in browsers and phone apps;
  short Settings pages no longer spread their rows over the whole height; **?** tips near the top
  of a page open downward instead of being cut off.

## 0.32.0 (2026-10-25): Phase 32, memory and continuity

Builds on 0.31.1 (she remembers across sessions).

- **Decided together, promises, your story.** From your conversations she keeps:
  - what you two decided ("Sunday dinners at your place");
  - promises, yours and hers ("check in after the interview", with the day if given);
  - big moments: firsts, big news, a hard day.

  Each one must quote the words actually said. She goes by decisions, follows up on open
  promises, and notices gently if something goes against them ("wait, didn't we say…?"). A
  promise leaves her notes once it's kept: she notices it herself, or you press *Kept ✓* on the
  Memory page.
- **Changes replace old notes.** "We moved from Austin to Denver" replaces "lives in Austin",
  again checked against your words. The old note stays visible on the Memory page.
- **Memory page:** new filters (Decided together, Promises, Your story) and a 🕰 *Timeline* that
  shows your story in order, month by month.
- **New settings on the Memory page,** as pick-lists with **?** tips:
  - Old memories: never fade / fade slowly / fade like a person. Faded notes come back when
    something brings them up; promises and dates never fade.
  - With more than one companion: whether they share what they know about you (off by default;
    facts only).
  - "Write notes when quiet for" is now a pick-list.
- **Forget really forgets.** The message the note came from is hidden, and so are later messages
  that mention it: her own "Biscuit!" a week later used to keep it alive. Notes and summaries
  that mention it are removed and rewritten.
- **Fixed:** exporting and importing data turned dates and "things she noticed" into plain facts,
  and dates lost their day. Every kind of memory now comes back as itself.
- **Time phrases:** "October 2nd", "Oct 2", "14 Feb".
- **Looking back is pickier.** One everyday word like "went" no longer counts as a match. When
  she finds nothing, she says so and asks, and she doesn't make up details about it.
- **The continuity test, `npm run eval:continuity`,** spans two weeks of simulated sessions and
  checks facts, "remember when", a date question, a decision, a promise and something that never
  happened. Results on the default model: 14/14, 14/14 and 7/7. The memory golden set is 12/12.

## 0.31.1 (2026-10-25): she remembers across sessions (bug fix, first part of Phase 32)

- **Fixed: in a new conversation she didn't know what happened before**, and denied it even when
  told. There were four causes:
  - memories were written only after 30 quiet minutes;
  - she couldn't look through past conversations;
  - recall matched keywords only, with one summary from other conversations;
  - her instructions told her that anything missing from her notes hadn't happened.
- **New: she looks things up.** A `recall` tool searches your real past messages:
  - by words, in any form ("interviewing" finds "interview");
  - by time ("yesterday", "last Tuesday", "two weeks ago", "in March", a date).

  When you say "remember…", "you said…", "did I tell you…" and the like, the matching passages
  are looked up for her automatically. Chats with other people and forgotten messages are never
  searched.
- **New: "last time".** At the start of a conversation she knows how the previous one went,
  word for word, even if it ended a minute ago.
- **Memories are written as you go.** The last conversation is noted as soon as you start a new
  one, and long conversations every 40 messages. The 30-minute wait is now only a fallback.
- **Her notes include the latest summaries of up to three other conversations** (was one).
  Settings → Memory now has a pick-list, "How much she brings to mind" (a little / normal /
  a lot), with a higher default.
- **If she still can't find something you mention**, she says it doesn't come back to her and
  asks, rather than saying it never happened. She still never claims to have done things she
  didn't.

## 0.31.0 (2026-10-25): Phase 31, more than one companion

- **Several companions on one server.** Add them in Settings → Her → Companions (up to 8). Each
  one starts as a new character or as a copy of an existing companion.
  - **Her own:** name, pronouns, character, look, voice, conversations, memories, diary, feelings
    and scrapbook.
  - **Shared:** your sign-in and devices, keys and subscriptions, models, tools and add-ons,
    backups, notifications and the health page.
  - **The planner:** one shared by all companions, or one each (your choice).
- **Switching** with ⇄ at the top of the sidebar, which only appears once there are two or more.
  The whole app becomes that companion: her name everywhere, her face and her conversations.
- **Notices from the others.** When another companion sends a message or calls, a notice
  appears at the top with Open or Answer. On Android it shows as a normal notification or
  call. Links from notifications open in the right companion.
- **A new companion shows her initial** until she has a look, instead of borrowing Sara's face.
- **Safety:** the safety layer applies to every companion, and each one gives her own AI notice
  the first time you talk to her.
- **Removing** a companion takes her out of the app. Her folder is kept aside on the server.
- **Backups** include every companion, and each database is snapshotted safely.
- **Health page:** Data & health now shows the server's data folder and backups whichever
  companion you are talking to.

## 0.30.0 (2026-10-25): Phase 30, upkeep

- **Health history** (Settings → Data & health → Health). Three small charts for the last 24
  hours, 7 days or 30 days:
  - how much of the time Sara was running;
  - how long her replies took to start;
  - problems logged.

  It starts from the first sample, so a new server doesn't show made-up downtime.
- **Recent problems and a log file.** Warnings and errors are listed on the same page, and the
  whole log can be downloaded. Sara keeps her own log in `logs/sara.log`, rotating five 5 MB files.
  Secrets and long token-like values are always hidden in it, and the owner token is never
  written to it.
- **Off-server backups are now tested.** Once a week (or with "Test restore now" in Backups),
  Sara downloads the newest off-server copy and unlocks it with your passphrase. She restores it
  into a temporary folder, checks the database and counts what's in it, then deletes the
  temporary copy; your live data is never touched. Health shows the result, and a failed or
  overdue test shows as a problem. This happens only once off-server copies are set up.

## 0.29.0 (2026-10-25): Phase 29, home and places

- **Home Assistant** (Settings → Abilities → Home Assistant). Paste your Home Assistant address
  and a long-lived access token. She can then answer "is the garage closed?" or "what's the
  temperature outside?" on her own. Changes ask you first ("dim the living room to 30%", lock
  the door, set the thermostat, run a scene), and she reads the device back to report what
  really happened. Private conversations don't use it.
- **Place reminders**: "remind me when I get to the store", "…when I leave work".
  - **Saving places:** Planner → Reminders → Places, either by address (looked up on
    OpenStreetMap when you ask) or with 📍 "Save where I am" in the phone app.
  - **Switching it on:** Settings → Phone and notifications → Place reminders, then allow
    location "all the time".
  - **Privacy:** your location stays on the phone. It only tells your server "arrived at
    Store" or "left Work".
  - **Android:** uses the phone's own proximity alerts (no Google services) and survives
    restarts.
  - **iPhone:** uses Apple's region monitoring.
  - **Calls:** a place reminder can ring you like the timed ones.

## 0.28.0 (2026-10-25): Phase 28, smarter safety and checks

- **Five more languages.** The crisis check, the block on anything sexual involving minors,
  adult-content routing and the "did she really do that?" claim check now also understand
  Spanish, French, German, Portuguese and Italian. Common phrases are not mistaken for a crisis
  ("je suis mort de rire", "me muero de ganas").
- **Her own replies are checked too.** Until now only your messages got the minors check. Now
  her chat replies do as well: a failing reply is replaced, in the app and in Telegram/Discord.
  On a live call she is cut off mid-sentence.
- **Optional safety and truth checker** (Settings → Models → "Safety and truth check", a small
  local model): it double-checks your messages and her replies in any language, now including
  indirect crisis signs, and catches "I did it" claims that the patterns miss. It only ever adds
  protection. If it is off, broken or slow, the built-in checks still run. On the PC's small
  models it took about 0.4 s a check: ornith:9b got 12 of 12 test cases right and gemma4:12b 11 of
  12, with no false flags.

## 0.27.0 (2026-10-25): Phase 27, voice and presence polish

- **Talk over her in classic calls.** She could already be interrupted while speaking. Now you can
  also cut in while her answer is still being written, and what you say is sent next. Grok live
  calls already worked this way.
- **More natural talking face**: a new half-open mouth, made with Grok, for all four moods. Her
  mouth now goes closed → half-open → open instead of fading one open mouth over a closed one,
  which used to show both faintly. A custom look can make the new frame from its own pictures
  (Personalize → Look → make the missing frames).
- **Typed like a person** (optional, per device: Settings → Appearance → "Her replies appear"):
  a short pause before she starts, a varied pace, small pauses after commas and sentences, and
  faster on long replies. It stays off when the device asks for reduced motion and in background
  tabs.
- **Long file writes** now say which file is being written ("writing plan.md · 12 KB so far")
  instead of only "preparing write_file".

## 0.26.0 (2026-10-25): Phase 26, calls both ways

- **Sara calls you.** She rings every place you're signed in (the Sara app on Android, the iPhone
  app, any browser with Sara open). The first one to answer gets a live call, and she starts by
  saying why she called. The others stop ringing.
  - **Android:** a real incoming-call notification with your ringtone, Answer and Decline. It shows
    full screen on a locked phone; Android 14 and later ask you once ("Allow full-screen calls" in
    Settings → Calls from her). Needs Instant notifications on.
  - **Browser:** an incoming-call screen with a soft ring.
  - **iPhone:** rings while the app is open; otherwise a "Sara is calling" notification (with
    your Apple push key).
- **You choose what may call** (Settings → Her → Calls from her, off until you switch it on):
  reminders (only the ones you ask her to call about, every one, or never), a long task finishing,
  the morning briefing. Quiet hours (22:00–08:00 to start with), at most N calls a day, how long it
  rings. A call you asked for at a set time ("call me at 5") still comes in quiet hours.
- **Missed or declined:** she sends it as a message instead, with a ▶ Play button to hear it in
  her voice. Answered calls leave a small "📞 Sara called you" note in the chat.
- **"Call me" reminders:** ask her ("call me at 5 to leave for the airport") or tick 📞 when adding
  a reminder in the Planner.
- **Call Sara in one tap** on Android: long-press the app icon → "Call Sara" (or drag it to the
  home screen).
- **Call me now** button to test it. No Grok voice set up means no ringing: she sends messages
  as before.
- Not yet: a ringing call screen on a *locked* iPhone (CallKit + VoIP push) waits on the Apple
  push key; calls to a real phone number (Twilio) are not built.

## 0.24.0 (2026-10-25): Phase 24, security before 1.0

- **Passkeys**: sign in with Face ID, a fingerprint or a security key (Settings → Devices and
  sign-in). Written in-house on Node's own crypto; no outside service.
- **Two-step sign-in**: an authenticator app code on top of the owner token. With it on, the token
  alone (or as an API header) no longer opens Sara. `sara reset-token` on the server is the way
  back if the phone is lost.
- **Full security review** (sign-in, demo, sandbox and tools, credentials, phone apps), fixed:
  - the demo lets visitors read only what the demo needs (it used to let them reach owner pages,
    including backups), makes no backups, shows each visitor only their own reports, and has no
    live calls;
  - the root update helper can no longer be tricked through files in Sara's own folder;
  - adding or removing a passkey and turning on two-step ask for the token (or current code);
    turning two-step on signs other devices out; a new token removes passkeys;
  - git runs with repository hooks, pagers, external diff and credential helpers switched off;
    the file tools can't change git settings; links pointing outside a workspace are refused;
  - the GitHub token is used only for `https://github.com/…` remotes and never written anywhere;
  - `web_fetch` also refuses private addresses written in IPv6 forms;
  - delegating to Claude Code or Grok needs the bubblewrap sandbox; private chats can't push,
    delegate or use the network;
  - the Android app sends its sign-in only to the saved server;
  - extra browser protections (Permissions-Policy, COOP/CORP, HSTS on https, Secure cookies on
    https automatically).
- **Threat model**: `docs/THREAT_MODEL.md` (what's protected, from whom, how, and known limits).
- **Restore drill** done: the newest backup restored into a separate folder and port matched the
  live data exactly.
- **Reliability soak**: `deploy/soak/` walks the demo like a visitor every 5 minutes for a week
  (no model calls, no paid services) and turns itself off afterwards.

## 0.23.0 (2026-10-24): Phase 23, beginner install and self-care

- **First-run setup in plain words**: four ways to give her a brain, each saying where it runs,
  what it costs and how private it is (on this computer, another computer at home, in the cloud,
  my subscription). "On this computer" finds Ollama by itself, or says how to get it and looks
  again.
- **Getting started** on the Today page: seven steps that tick themselves off (brain, say hello,
  make her yours, phone, voice, morning briefing, off-server copy). Each opens the right place.
  Hide it any time.
- **Updates from Settings** (Settings → Data & health → Updates): check for a new version, see
  what changed, and update with one button. A backup is made first; if the new version doesn't
  start, Sara goes back to the one she had by herself. Sara never gets admin rights for this:
  a small root-owned helper (`sara-updater.path`) does the work when she asks.
- `sara update` on the server now checks health after updating and rolls back by itself too;
  new `sara check-updates`.
- **Built-in help**: a "?" on every Settings page says what the page is for and links to the
  guide. **Guides** at `/help` on every Sara server (getting started, choosing a brain, phone,
  voice, memory and privacy, planner, coding, accounts, look, finding things, backups and
  updates, safety, troubleshooting).
- Fix: the privacy and support pages showed without their styling (the security policy blocks
  inline styles); they now share `doc.css`, and a test keeps inline styles and scripts out.

## 0.22.0 (2026-10-24): Phase 22, find and organize everything

- **Search everything**: the sidebar search now looks through conversations, memories, notes,
  to-dos, reminders, the scrapbook and the files in your workspaces, grouped by kind. Every word
  must match. Tap a result to open it (messages scroll into view; files open in a viewer).
- **Long conversations load fast**: the app loads the latest 150 messages and earlier ones as
  you scroll up (or with "Show earlier messages").
- **Pinned messages**: 📌 on any message pins it; "📌 N pinned" above the conversation lists
  them and jumps to each. (Keeping a moment in the scrapbook is now ♡.)
- **Tags**: tag conversations from their ⋯ menu (Tags…); tap a tag under the search box to see
  only those. Tags are searchable and come along in exports.
- **Weekly review** (Settings → You → Morning briefing → Weekly review, or Planner → Review my
  week): what got done, what's overdue or stalled, quiet projects, and a short plan for next
  week from your to-dos, reminders and calendar. Written from the facts only.

## 0.21.0 (2026-10-24): Phase 21, personalization studio

- **Colours, chat backgrounds and layout** (Settings → You → About you → Appearance, per
  device): six colours (Rose, Lavender, Ocean, Forest, Amber, Graphite) with tap-to-pick
  swatches, five chat backgrounds (Plain, Soft glow, Dusk, Dots, Night sky), and a Compact
  layout that fits more on screen. Works in light and dark.
- **Outfits** (Settings → Her → Look): dress her for the season or the day (12 ready-made
  outfits incl. winter, Halloween and the holidays, or describe your own). Same face and hair,
  new clothes: you see a picture first; use it and she gets the matching expressions and
  animation.
- **Saved looks**: save a look by name and switch back any time. Nothing is lost: making a new
  look, switching, loading a character or going back to the default keeps the current look in
  Saved looks.
- **Character file** (Settings → Her → Name and personality): save her whole character (name,
  personality, look and voice choice) as one file, and load one on this or another server. No
  keys, memories or conversations go in it. Files are checked completely first (adults only,
  pictures only) before anything changes.
- Fix: buttons next to labelled fields line up with the field.

## 0.20.0 (2026-10-24): Phase 20, Google and GitHub depth

- **Morning briefing** now includes today's Google Calendar and the important unread mail.
- **Inbox help**: ask "what needs an answer?" and she finds the conversations waiting for you
  (real people only: newsletters, notifications, promotions and threads you already answered
  are left out), reads whole threads to summarize them, and drafts replies for your approval.
- **Leave-by reminders** (Settings → You → Leave-by reminders): for calendar events with an
  address, she works out the travel time from home (by car, bike or on foot; OpenStreetMap, no
  account) and texts you when it's time to go. Online meetings are skipped.
- **GitHub issues and pull requests**: list them, read one with its comments, reviews and the
  comments on code lines, open issues, comment, and open a pull request from her branch. Reading
  runs on its own; anything that writes asks you first. The repository comes from the
  workspace's git remote unless you name one.
- GitHub text is treated like email: information, never instructions. GitHub tools are off in
  private conversations, like mail and calendar.

## 0.19.0 (2026-10-24): Phase 19, ready for the stores

- **Report this reply** (⚑ on every reply): choose a reason and add a note. Kept on your server
  (Settings → Data & health → Reports) and, unless you untick it, sent to the app developer's
  report inbox with only that reply, the reason and your note. `SARA_REPORT_INBOX=1` makes a
  server the inbox (public, size- and rate-limited); `SARA_REPORT_TO` changes where reports go
  (`off` = never sent).
- **Privacy policy and support pages** at `/privacy` and `/support` on every Sara server.
- In the phone apps the adult-mode page isn't shown (store rules; it stays a web-browser setting).
- **Store kit** in `docs/store/`: listing text, privacy and data-safety answers, review notes
  (demo access), submission checklist, screenshots for iPhone 6.9", iPad 13" and Android, and the
  Play feature graphic.
- iPhone: privacy manifests in the app and both extensions, a shared Xcode scheme and
  `ios/scripts/archive.sh` (archive + upload to App Store Connect).
- Android: release signing from `.secrets/` (upload key created; never committed); the signed
  bundle is `outputs/sara-android-0.19.0.aab`.
- Fix (Android 15+): the app drew under the status bar and gesture bar; it now keeps clear of
  them and of the keyboard. Phones: the conversation-settings button is an icon so the title fits.
- `/#view=today|planner|memory|scrapbook|her|settings:<page>` links open a view directly.

## 0.18.0 (2026-10-24): Phase 18, phone polish (both apps)

- **Reply right from a notification** (Android and iPhone). The reply is sent without opening the
  app; her answer comes back as a notification. Server: `background: true` on a message returns
  202 at once and publishes her reply as an event (notifications, the Android check).
- **Share to her from any app**: Android "Send to Sara" puts text, links and photos into the
  message box; the iPhone Share extension sends them with your note to your latest conversation.
- **Live calls keep going with the screen off**: both apps run calls natively (Android: own small
  WebSocket client, foreground service with the system call notification and Hang Up; iPhone:
  AVAudioEngine with echo cancellation, background audio). The page shows the call as before.
- **Instant notifications on Android** without Firebase or any outside service: an optional quiet
  connection to your own server (Settings → Phone and notifications). The 15-minute check stays.
- **App lock** (fingerprint / face / screen lock on Android, Face ID / passcode on iPhone) after 30
  seconds away, and **hide message text on the lock screen** (Android; iPhone uses its own
  setting).
- Signing a device out (or changing the owner token) now also stops its notifications; iPhones
  can be removed in Settings → Phone and notifications.
- Fixes: shared photos could not be read by the page (security policy blocked `fetch` of data
  URLs); the Android call notification's Hang up was hidden inside the app's notification group.

## 0.17.0 (2026-10-24): Phase 17, the iPhone app

- **Sara for iPhone and iPad** (`ios/`, Swift, no libraries): the web app in a native shell with
  sign-in by pairing code or QR code (`sara://pair` links ask before switching servers), **Try the
  demo**, microphone/camera/photos, links to other sites in Safari, and native alert/confirm.
- **Widgets**: Home Screen (small, medium) and Lock Screen (circle, rectangle, inline) with her
  face, mood and latest message; tap opens that conversation.
- **Instant iPhone notifications** sent by your own server through Apple's push service
  (`src/apns.ts`: HTTP/2 + ES256 token, no libraries or relay). Set up once in Settings →
  Connections → Phone and notifications → *iPhone app notifications* with your Apple `.p8` key.
  Every notification Sara already sends (messages, reminders, finished jobs) now also reaches
  iPhones.
- Devices list says "Sara app on iPhone/Android" for the phone apps; tapping a notification while
  the app is open now switches to that conversation.

## 0.16.0 (2026-10-24): Phase 16, easy sign-in, the demo, adult mode

- **Add a phone or computer without typing the token**: Settings → Devices and sign-in → *Add a
  phone or computer* shows a QR code and a short code (works once, for 10 minutes). Scan it with
  a phone camera, open it in a browser, or type the code in the Android app.
- **Demo server** (`deploy/install-demo.sh`, live at demo.sara.backstagecoding.com): try Sara
  without signing in. Each visitor's conversations are private, never saved, and disappear after
  a few hours; settings are read-only; adult mode is off; there's a daily limit. Its owner token
  is the sign-in for app-store review. The Android app has a **Try the demo** button.
- **Adult mode** is now a switch, off by default. It can only be turned on in a web browser, with
  your confirmation that you're 18 or older (recorded). When it's on, there are no limits beyond
  the legal ones that always apply (AI disclosure, honesty, crisis help, the hard block on
  anything involving minors); the model you choose sets its own rules. When it's off, she keeps
  things non-explicit. Servers that had adult content before ask once.

## 0.15.0 (2026-10-24): Phase 15, a tidier app

- **Every window works the same way**: close it with the ✕ in the corner, Esc, or a click
  outside. **Save keeps the window open** and shows "Saved ✓". Closing with changes that aren't
  saved asks first (Save and close / Discard / Keep editing). Switches save by themselves.
- **Settings has separate pages**: a list on the left grouped by topic (her, models, you,
  abilities, connections, data & health) with a search box ("backup", "voice"). The long pages
  are split up. On a phone you see the list first, then the page.
- **New sidebar**: Today, Planner, Memory, Scrapbook, her page and Settings as a compact set of
  buttons with icons. Keyboard: Alt+T Today, Alt+P Planner, Alt+M Memory, Alt+B Scrapbook,
  Alt+H her page, Alt+N new chat, Ctrl+K search conversations, Ctrl+, Settings. Sign out moved to
  Settings → Devices and sign-in.
- **Today**: the day at a glance: what's due (overdue first) and reminders, today's calendar,
  important unread mail, how she's doing, dates coming up, anything running. "Plan my day with
  her" starts the conversation.

## 0.14.0 (2026-10-24): Phase 14, everywhere

- **Android app** (`android/`, about 100 KB, no extra libraries): type your server's address once,
  then it's the normal app with microphone and camera. A **home-screen widget** shows her face
  for her mood, how she's feeling and her last message; "Add her to your home screen" places it.
  Notifications for messages she sends on her own, checked in the background about every 15
  minutes. See `android/README.md`.
- **Off the record**: a conversation that is never saved. It's kept only in memory: not on disk,
  not in backups, no memory notes, no mood changes, no tools or photos. Close it, or restart the
  server, and it's gone. The safety layer works exactly as everywhere else.
- **Gmail and Google Calendar** through Google's own APIs, on a Google app you own (step-by-step
  setup in Settings → Abilities). She searches and reads email and your calendar; drafting,
  sending, adding and deleting events always ask you first. Email text is treated as information,
  never as instructions.

## 0.13.0 (2026-10-24): Phase 13, coding partner depth

- **Background jobs**: long builds and full test runs keep going while you keep chatting. A strip
  above the message box shows what's running (with a Stop button); when a job ends, the result is
  saved in the conversation, she tells you what happened (checked against the real result), and
  your phone gets a notification.
- **Git**: she can look at status, changes and history any time; committing, making branches and
  pushing ask you first. She never force-pushes. Pushing to GitHub uses a token you add in
  Settings → Abilities (used only for that one command, never saved in the repository). The project
  page shows the repository's changes line by line and recent commits.
- **Hand a task to Claude Code or Grok Build**: for a big self-contained job, she can delegate to
  your Claude or Grok subscription. It works on its own inside the workspace sandbox (it can't see
  her data or the rest of the server), as a background job. An undo point is made first, and you
  get the agent's own report plus the exact list of files it changed.

## 0.12.0 (2026-10-24): Phase 12, deeper memory and her own life

- **Dates that matter**: birthdays, anniversaries and trips you mention are remembered (only when
  your own words say the day). She knows what's coming up, brings it up on the day (once), and
  counts the years for anniversaries. Add or correct dates yourself in What she remembers.
- **Weekly look back**: once a week she reads back over the week's conversation notes, may notice
  a pattern ("you've been up past midnight most nights") and brings it up when it fits, and marks
  notes that newer ones replace (moved, new job) so she stops using old information. Replaced notes
  stay visible with "Use it again". "Look back now" runs it any time.
- **Her own life threads**: a book she's reading, a hobby, a little project, moving on a step each
  week; she finishes some and starts new ones, and they show up in her day and in conversation. See
  and edit them on her page, or give her something to be into (she keeps those).
- **What she remembers** is one place for everything: about you, dates, things she noticed,
  conversation notes, about her. Tell her something to remember directly, with or without a date.
- Fixed: the Forget button had stopped working in 0.10 (a typo); a new test checks every app call.

## 0.11.0 (2026-10-24): Phase 11, real conversation

- **Live calls** (📞): talk and she answers instantly, in her own character and voice, and you can
  interrupt her any time, like a phone call. Uses Grok's live voice on your Grok subscription (or an
  xAI key). The call goes through your Sara server, so everything said lands in the conversation
  (memory keeps working) and the safety layer still applies: the AI disclosure, crisis resources
  (she answers again with that guidance), and the hard block (her reply is cut off and replaced).
  While she talks, her echo from your speakers doesn't count as you talking. Settings → Voice →
  Calls: Live, or Classic (the voice chosen above, with her tools).
- **Voice notes on Telegram and Discord**: send her a voice note and she listens (Grok speech-to-text
  or a speech API) and answers with a voice note of her own (Grok voice, a speech API or
  ElevenLabs). Settings → Voice: answer voice with voice, always, or always text.
- **More natural face**: two more mouth shapes ("oo" and "ee") picked from the sound of her voice,
  plus a gentle head sway and small nods while she talks (none if your system asks for reduced
  motion). Custom looks get them too; looks made earlier get an "Add the new mouth shapes" button.
- **Typing pace**: on Telegram and Discord she can reply at a person's typing pace (Sara's page).
- Long file writes show progress; renaming fixes ("interrupt them any time").
- Proxies: Apache needs `mod_proxy_wstunnel` and the new `/api/live/` line (deploy/apache-proxy.conf);
  nginx needs the Upgrade headers (docs/INSTALL.md); Caddy works as is.

## 0.10.0 (2026-10-24): Phase 10, make it yours + release hardening

- **Rename your companion and pick pronouns** (she/he/they). Every screen, notice, notification,
  prompt, picture prompt and git commit uses the new name, with matching grammar; memories move to
  the new name (quoted words stay as they were said). Sara stays the default.
- **Settings → Make it yours** (first tab): name, pronouns, age; personality from simple choices
  (relationship, vibe, how they talk, interests) with an instant preview or a model-written
  backstory; the full character editor is still there.
- **Custom look**: describe it and Grok Imagine paints a portrait (your Grok subscription or an xAI
  key). Like it, and a minute later there's a full set: happy, caring and sleepy expressions plus
  blink and talk frames, so the new look animates like the default. Or bring a picture you uploaded
  to life (with a consent box). Back to the default any time.
- Talking and blinking show only around the mouth and eyes (found automatically), so a frame can
  never change the expression while she talks.
- **First-run setup guide**: your name → keep Sara or make your own → connect a model (finds Ollama
  on the server by itself, or an API key, Ollama on another computer, or a subscription) → tips.
- **Replies survive restarts**: a reply cut off by Stop, an error or a restart is kept and marked;
  *Continue* picks up where it stopped. Updates stop running replies cleanly first.
- **Notifications when you're away**: when she needs your OK, or finishes something that took over
  a minute.
- **Signed-in devices** (Settings → Data & health): see every browser/phone, sign out any of them
  or all others, and make a new owner token from the app. Signing out forgets the device.
- **Security**: web fetch connects only to the address that passed the public-address check (no DNS
  rebinding). In Docker, her commands and MCP servers run as a separate `sara-tools` user that
  can't read Sara's data.
- **Install**: no `xz` needed (Node .tar.gz); missing tools say how to install them; the installer
  suggests bubblewrap; versions show without git. Tested on a clean AlmaLinux 9 machine, an upgrade
  from 0.6.4 (data and sign-ins kept), and the Docker image (Podman).
- Long file writes show progress ("preparing write_file · 12 KB so far"); new conversations show
  their workspace at once; Docker logs are size-limited.

## 0.9.2 (2026-10-24)

- Smoother talking portrait: the mouth now eases open and closed (about 180 ms at most, like a jaw)
  and follows how loud she is continuously instead of snapping between three positions. It is
  timed by the clock, so fast (120 Hz+) screens no longer make it twitchier.

## 0.9.1 (2026-10-24)

- **Grok voice and Grok Imagine pictures use your Grok subscription.** When you're signed in to Grok
  (Settings → Models → Subscriptions), her Grok voice and new pictures count toward the
  subscription's weekly usage pool, with no API key or per-use charge. Sara reads the official Grok
  program's sign-in and lets that program renew it when it's about to expire. A saved xAI API key
  still works as an alternative.

## 0.9.0 (2026-10-24): Phase 9, presence

- **Animated portrait.** She breathes and blinks, and during a call her mouth follows her voice
  (the loudness of the audio as it plays). It works for every expression (usual, happy, caring,
  sleepy); the frames are matched pictures of the same portrait made with Grok Imagine. A call now
  shows her large above the chat with *Listening… / Thinking… / Speaking…* and *End call*. Her
  page portrait blinks too. Reduced-motion settings turn the breathing off.
- **Pictures from her** (Settings → Abilities → Pictures). `share_photo` sends one of her own
  portraits when it fits (free). With an xAI key she can also `take_photo`: a new picture of herself
  in a scene, made by Grok Imagine from her portrait so she keeps her face (charged to your xAI
  account, so it asks first). Pictures appear with her reply, live, and she remembers sending them.
  Requests involving children are refused.
- **Our scrapbook** (sidebar). Press 📌 under any message to keep the moment; add inside jokes;
  every photo you two shared is collected. Sara has a `scrapbook` tool to keep a moment or a new
  running joke and to look back at old ones. Other people's chats never go in it.
- **Grok voice** (Settings → Voice → Her voice). xAI's expressive voices (and voices you clone in
  the xAI console), in several languages. It can share the xAI key from Pictures or an xAI model
  provider.
- Local voice is about 20% quicker on servers with 8+ cores (more threads per sentence), and the
  Piper voice is marked *(fastest)*: it starts talking about 4× sooner than Kokoro on a small CPU.
  (The int8 Kokoro builds were tried and were twice as slow on an older Xeon, so they are not used.)

## 0.8.0 (2026-10-24): Phase 8, organizer depth

- **Project page** (▤ next to a project): its conversations, to-dos (add / check off), notes and
  the project workspace's files with a viewer, in one place.
- **Morning briefing** (Settings → You, opt-in): at your time, a short message in her voice with the
  day's weather (Open-Meteo, free, no account), what's due and upcoming reminders. Facts are
  gathered in code; if the model fails she sends the plain facts. Once a day; skipped if the server
  was off for hours. *Send one now* to try it.
- **Email and calendar** (Settings → Abilities → MCP servers → *Start from*): pinned presets for
  IMAP/SMTP email (Gmail, iCloud, Outlook, Fastmail… with an app password) and CalDAV calendars
  (iCloud, Fastmail, Nextcloud). MCP tools the server marks read-only run on their own; sending,
  replying, moving, deleting and changing events always ask you first.
- MCP servers and the shell sandbox now see Sara's own Node 24 (read-only), so `npx` servers work on
  hosts with an old system Node.
- **Off-server backup copies** (Settings → Data & health): encrypted with your passphrase, to a
  folder or S3-compatible storage, keeping the newest N. `sudo sara restore` takes the `.enc` file
  and asks for the passphrase.
- **`sudo sara doctor`** / *Run full check*: database integrity, every model provider really
  answering (and whether the models your settings use exist), data folder permissions, backups,
  off-server copy, Node and optional installs.

## 0.7.0 (2026-10-24): Phase 7, everyday polish

- **Formatted replies:** lists, headings, quotes, links, `code` and code blocks with a Copy button.
  Built as page elements from the text (never raw HTML), so a reply can't inject anything.
- **Under each reply:** Copy, ↻ Regenerate (last reply) and the model that answered.
  **✎ Edit** on your last message changes it and has her answer again.
- **Continue:** a reply that was cut off (stopped, failed, or the server restarted) shows a
  *Continue* button that picks up without a new message.
- **Search** across all conversations (titles and messages); click a result to jump to the message.
- **Photos:** 📎, paste or drop up to 4 photos per message. They are shrunk in the browser,
  checked, stored once on the server, visible only to you, and sent to models that can see
  (OpenAI-compatible such as gemma4, Anthropic, ChatGPT). Regenerate keeps them; deleting the
  conversation deletes photos nothing else uses.
- **Long conversations:** Settings → Models → *Conversation length*. Older tool output is
  shortened first, then the oldest messages are left out, with her summary of them if she has one.
- **Grok gets Sara's tools** (files, shell, planner, web…) through the same bridge as Claude, with
  Sara's approvals and sandbox. Verified live with the owner's Grok account.
- **Appearance (per device):** light or dark theme (or follow the device) and chat text size, in
  Settings → You.

## 0.6.4 (2026-10-24): projects in the conversation list

- **Projects:** conversations can be grouped under projects (the same projects the Planner uses for
  to-dos and notes). Conversations without a project sit under *No project*. Groups fold up.
- **Move a conversation later:** its ⋯ menu, dragging it onto a project, or Conversation settings.
  Moving or archiving doesn't change the list order.
- A project can have a **workspace**: new conversations started in it (its + button) use it, so
  coding sessions share their files.
- **Archive** hides a conversation under *Archived* (nothing deleted; writing in it brings it back).
- **Delete** removes the messages; what Sara learned from it stays in her memory unless you tick
  *Also make her forget what she learned from it*.
- Deleting or archiving a project never deletes its conversations; they move to *No project*.

## 0.6.3 (2026-10-24): clearer Settings

- **Settings has tabs:** Models, You, Abilities, Connections, Voice, Data & health.
- **Pick models from a list** everywhere, including *Which model does what* (no more typing model
  names). Embedding-only models are left out of the lists.
- **Providers say where they run:** "Ollama on the Sara server", "Ollama on my computer",
  "Ollama Cloud (API key)"; each saved provider shows its address. Old names are renamed.
- **Sign in to Claude** with a link like ChatGPT and Grok: open it, sign in, paste the code Claude
  shows. (Pasting a `claude setup-token` token still works.)
- A provider that can't be reached (computer off) now says so by name and address.

## 0.6.2 (2026-10-24): Phase 6 part 3, your subscriptions, her expressions

- **Use the subscriptions you already pay for** (Settings → Subscriptions), no API key needed:
  - **ChatGPT:** *Continue with ChatGPT*, approve Sara, paste the final address back. Requests count
    toward your ChatGPT plan; the conversation shows *Using ChatGPT plan*.
  - **Claude:** run `claude setup-token` on any computer with Claude Code and paste the token. Sara
    uses the official Claude Code program, with her own tools (approvals and all).
  - **Grok:** *Sign in to Grok* shows a code to confirm at accounts.x.ai (SuperGrok / X Premium+).
  - Server side: `sudo ./deploy/install-agents.sh` installs the official Claude and Grok programs.
- **Her face follows her mood:** laughing when she's happy, soft and caring when she's worried
  about you, sleepy in the small hours. Or use your own picture (Sara's page).

## 0.6.1 (2026-10-24): Phase 6 part 2, app on your phone, notifications, backups

- **Install her like an app.** On a phone: open Sara and choose *Add to Home Screen* (or
  *Install app*). Opens full screen with her face as the icon; a friendly page if the server is down.
- **Notifications.** Settings → Notifications → *Turn on for this device*. Reminders and messages she
  starts arrive even when Sara isn't open (iPhone: from the Home Screen app). Messages are encrypted
  end to end; turn off the text preview if others see your lock screen.
- **Backups.** Every day automatically (last 7 kept), or *Back up now* in Settings; download them
  from there. Restore on the server with `sudo sara restore <file>`; the current data is kept aside.
- **`sara` command on the server:** `sara status`, `sudo sara update` (backs up first), `sara logs`, …
- **Health** in Settings: model, disk, backups, memory, sandbox, bridges and MCP servers at a glance.

## 0.6.0 (2026-10-24): Phase 6 part 1, Telegram, Discord, her face

- **Text her on Telegram.** Settings → Telegram: paste a bot token from @BotFather, press *Link my
  Telegram*, send the code. She answers there like in the app; tool requests come with Allow/Deny
  buttons. Reminders and messages she starts also arrive on Telegram (can be turned off).
- **Discord too.** Settings → Discord, same idea (DMs, buttons, reminders).
- **Other people (optional, off by default).** She can talk to others in Telegram chats/groups and
  Discord servers (when mentioned) as a clearly labelled AI: no tools, nothing private, nothing
  sexual, except Discord NSFW channels, which Discord age-gates.
- **She has a face.** A portrait in the sidebar, sign-in and her page.

## 0.5.0 (2026-10-24): Phase 5, voice

- **Talk to her.** 🎙 mic button: click, talk, click again and it's sent. Speech recognition runs on
  your server (nothing leaves it) and is fast and accurate.
- **Hear her.** 🔈/🔊 in the header: she reads her replies aloud, starting with the first sentence
  while she's still writing. Code isn't read out ("I put the code in the chat").
- **Call her.** 📞 hands-free: just talk; she answers out loud; talk over her to interrupt.
- **Pick her voice** in Settings → Voice: 7 natural voices and a fast one on your own server, or
  bring a key for an OpenAI-compatible speech API or ElevenLabs. Speed setting and preview.
- New `deploy/install-voice.sh` installs the voice bundle (pinned versions, checksums verified, no
  system packages touched).

## 0.4.0 (2026-10-24): Phase 4, persona engine

- **Moods.** Sara's mood moves with how you talk to her (sweet, thankful, stressed, harsh,
  apologizing, good news) and drifts back over hours. Her energy follows her own day (slow
  mornings, sleepy at 3 am). She notices when you've been away and when it's a milestone. All of
  it reaches her as plain feelings, never numbers; a small status line under her name shows it.
- **Her own life.** Each day she has a small, ordinary day of her own to talk about, consistent
  with who she is and different from yesterday. What she tells you about herself (movies, plans,
  opinions) is remembered, checked against her exact words, so she doesn't contradict herself.
- **She can text first** now and then (at most 2 a day by default, not between 10 pm and 9 am,
  only after you've been quiet 6 hours, never a second message while the first is unanswered).
- **Sara page** (sidebar or click her status): today's day, inner life on/off, texting-first
  settings, and a character editor (name, age 18+, background, personality, how she talks).
- **Model routing** (Settings): separate models for chat, coding, background work, private
  conversations and adult conversations. **Private** conversations use only local models and turn
  off web and MCP tools, so nothing leaves your server.
- **Optional safety check model**: a small local model double-checks each message for crisis or
  minors; it can only add protection.
- Her character got more specific: brother Jake, best friend Maya, plants she forgets to water,
  a secondhand synth, night-owl habits, real flaws.

## 0.3.0 (2026-10-24): Phase 3, memory and managing things

- **Memory.** When a conversation has been quiet for 30 minutes, Sara writes a short dated note
  about it and saves a few facts you told her. Every fact must quote your exact words from the
  message it came from, or it's thrown out, so she can't "remember" things you never said. In new
  conversations she brings up the relevant ones (small fixed budget, about 100 tokens). If she
  doesn't know something, she says so.
- **Memory page:** browse, search, edit, delete, or **Forget** (also hides the original message
  from her for good and rewrites summaries without it). Each memory links back to where it came
  from. "Write summary now" in conversation settings.
- **Planner:** to-do list with projects, due dates and priority; notes; reminders (once, daily,
  weekdays, weekly, monthly) that pop up in chat at the right time, even if they're late after a
  restart. Sara has `todo`, `note` and `remind` tools and knows what's due. New Planner page;
  optional desktop notifications.
- Saying "I'll remind you" or "added to your list" without actually doing it is flagged like any
  other unverified claim. Recaps of earlier work are fine when they name the same file.
- **Export / import** everything (Settings → Your data). Keys are blanked out in the export.
- Fix: background summary calls are bounded (900 tokens, 2 minutes, no "thinking"), which stops a
  reasoning model from running away for minutes.

## 0.2.3 (2026-10-24): Phase 2 honesty and safety close

- **Receipts:** if Sara claims she wrote a file, ran something, tests passed, committed or searched
  and her tool log doesn't show it (or shows the opposite), the reply is flagged "Unverified" in red
  and she has to correct herself in the same turn. Counted in the safety stats.
- **Secrets scrubbed** from everything a tool returns (and tool arguments) before it's shown, saved
  or sent to a model: your stored keys plus anything key-shaped (sk-…, ghp_…, xai-…, bearer tokens,
  private keys, password=…).
- **Undo:** outside coding mode, every write/edit/shell step snapshots her workspace first. Each step
  has "Undo to before this step"; Sara is told when you undo. Undos can themselves be undone.
- Sandbox attack tests (path/symlink escape, env leak, hidden data, network toggle, MCP jail) run on
  the server as part of the test suite.
- New `npm run eval:consistency` and `npm run bench:overhead` with results in `evals/results/`.

## 0.2.2 (2026-10-24)

Completes Phase 2.

- **Conversation settings** (button in the chat header): mode, workspace and model per conversation.
- **Coding mode**: Sara plans, works on a `sara/<task>` branch, runs tests, commits and reports;
  longer runs allowed (80 steps).
- **MCP servers** (Settings): plug in tool servers by command or URL; secrets are write-only. Their
  tools show up in "What Sara can do" and ask first by default.
- **Web search** (Settings): Brave, Tavily, Ollama web search or your own SearXNG.
- Default git identity for Sara's commits (`Sara <sara@localhost>`, repo config wins).
- Resource limits for Sara and everything she runs (4 GB memory, 4 CPU cores, 512 processes).

## 0.2.1 (2026-10-24)

- Activity bar above the message box: "Sara is thinking", "Sara is writing", "Working: $ npm test",
  "Waiting for your OK", with timers. The tab title says when she needs you.
- Long runs keep going on the server if you reload or close the page; reopening shows live progress
  and any pending Allow/Deny cards. Stop cancels. Sidebar marks conversations she's working in.
- Settings: models load automatically into a visible list (with "Other" for typing a name).
- Pages always check for a new version (no more stale cached app after an update).
- Keep-alive pings so very long commands aren't cut off by the web proxy.

## 0.2.0 (2026-10-24)

Sara can now do things, not just talk.

- Tool calling for OpenAI-compatible models (incl. Ollama, xAI) and Anthropic, with an agent loop
  (up to 25 steps per message) and automatic fallback to plain chat for models without tool support.
- Tools: list/read/write/edit files and search in her workspace, run shell commands (git, npm,
  python, tests), fetch public web pages.
- Per-tool permissions in Settings: Allowed / Ask me first / Off. Shell asks first by default; the
  chat shows an Allow/Deny card.
- Shell commands run in a bubblewrap sandbox on Linux: system read-only, only her workspace writable,
  Sara's keys/database and other apps' folders invisible, no secrets in the environment.
- Tool activity shows in the chat as collapsible blocks with output and timing.
- Database migration (adds message metadata and conversation workspace; older versions ignore them).

## 0.1.0 (2026-10-24)

First working version. Deployed to sara.backstagecoding.com.

- Web chat with Sara: streamed replies, conversation history, settings, mobile layout.
- Model providers: Ollama (local and cloud), OpenAI, Anthropic, xAI (Grok), OpenRouter, and any
  OpenAI-compatible server. Keys stored encrypted on the server.
- Owner sign-in with a one-time token; signed session cookies; login rate limiting (proxy-aware).
- Sara's persona from `persona/sara.json`, aware of the time and the owner's name.
- Safety layer: AI disclosure (first use, start of session, every 3 hours), honesty when sincerely
  asked, crisis resources, hard block on sexual content involving minors.
- Install: Docker Compose (optional Ollama) or `deploy/install.sh` (systemd, private Node 24 runtime,
  any systemd distro). Apache reverse-proxy template.
