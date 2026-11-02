# Phase 128: the second polish pass (design and audit)

Status: design only. Written 2026-11-02 from a live audit of Sara 2.60.0 (commit d2b2b78) on a
throwaway server (port 7896, empty data, setup off, local Ollama `gemma4:12b` for one real turn),
driven by a headless Edge over CDP. Nothing in the code, tests, changelog, README or roadmap was
changed. Screenshots: `outputs/ui-review/polish2-audit/` (local only, not in git).

Same method as the first pass ([POLISH.md](POLISH.md), Phase 114): findings with evidence, then
releasable slices **PL2a–PL2d**, then the gap review the owner asked for, as a proposed next track.

## 1. The owner's words

> "Once the roadmap is complete, do a full pass over the project and fine tune anything that needs
> it. This is like the sliders in settings that control her personality to have better labels,
> anything that can be graphically better or visual, ways to better explain how to do things, just
> really put the polish on the whole project to dial it in as a premier harness for coders and
> companions. I would also like some suggestions of things that openclaw and hermes have that we do
> not have yet (able to send a voice note for example) that would make this system better, more
> solid, more functional for coders or companion style all the while keeping things neat and tidy
> and easy to use for even beginners into using a harness and doing things."

And on SSH before 2.52.1: *"the process right now seems like a brick wall."* This pass looks at every
setup flow added since with that sentence in mind.

### Scope: what came in after the first pass (2.48.0–2.60.0)

| Release | Phase | What a person sees |
|---|---|---|
| 2.48.0 | 115 | Photos and files both ways in chat apps; one live progress message |
| 2.49.0 | 116 | *Tell her now / After this / Just asking* while she works; `/queue`, `/btw`; loop guard |
| 2.50.0 | 117 | Signal and email as built-in plugins |
| 2.51.0 | 118 | `/goal … done when …`, `/loop every …`; Planner → Repeats |
| 2.52.0 | 119 | "When it comes up" reminders, `/when`; *Continue here*, `/continue` |
| 2.52.1 | — | The easy SSH connect; photos with subscription models fixed |
| 2.53.0 | 120 | Checks after her edits; `@`-references |
| 2.54.0 | 121 | Routines gallery; the safety check-up |
| 2.55.0–2.55.2 | 122 | WhatsApp, Matrix, iMessage as first-party plugins with guided setup |
| 2.56.0 | 123 | Short tool list, `/tools`, `/compact` |
| 2.57.0–2.58.0 | 124–125 | The Sara Store: shelf, *Get more*, updates, *Submit yours*, reports |
| 2.59.0 | 126 | "Hey Sara" (Windows), push-to-talk, Android Talk tile, local voice on Windows |
| 2.60.0 | 127 | Companion packs: *Share her*, install, update with a diff, character cards |

### What was looked at

- **Every new Settings page at 1440×900 and 390×844** (dark), plus light-theme passes of WhatsApp,
  Safety check-up, the Store, SSH, Keep going and Routines: Get more, Tools and approvals, Skills,
  Plugins, Other programs (MCP), Check her edits, Keep going and repeats, When it comes up, Servers
  over SSH, Telegram, Signal, Email, WhatsApp, Matrix, iMessage, Pick up across apps, Safety
  check-up, Hey Sara, Companions, Bring her from another app, About you, Privacy, Voice.
- **The flows behind the first button:** WhatsApp, Matrix, iMessage *Start*; Signal *Add Signal*;
  SSH *Connect* to a host that doesn't exist; Store *Get*, the item page, *Submit yours*; Companions
  ⋯ → *Share her*.
- **Main views:** the 4-step wizard (fresh data), Today before and after it (dark and light),
  Planner → Reminders / Repeats / Routines, Chat empty, after one real reply from `gemma4:12b`, with
  `@` and `/` typed, and the + menu.
- **Settings search:** 49 terms for the new features typed into the search box, the matching pages
  recorded (§2.5).
- **Code and docs read:** CHANGELOG 2.48–2.60, `web/app.js` (Settings nav, wizard, tours),
  `web/refs.js`, `web/whatsapp.js` / `matrix.js` / `imessage.js` / `ssh.js`, `web/howto.json`, the
  plugin folders, the release check logs `check-2550.log` … `check-2600.log`, START_HERE, FOR_CODERS,
  HOW_DO_I, README, GAP_REVIEW, and the two competitors' docs indexes (§5).

Naming: `s-*` desktop Settings, `m-*` phone Settings, `v-*` desktop views, `mv-*` phone views,
`w-*` wizard, `sheet-*` contact sheets (four or five shots side by side). `.txt` files beside some
shots hold the page's visible text.

### Numbers that frame the work

| Measure | Value | Why it matters |
|---|---|---|
| Settings pages in the owner's nav | **58** (61 in `web/index.html`; `desktop-app`, `account` and the retired `ab-recipes` are hidden) | Was 47 at the first pass. Abilities has **16**, Connections **13**. |
| Setup patterns for chat apps | **4** (Telegram form; Signal/Email numbered lines; WhatsApp/Matrix/iMessage guided card; SSH two fields + diagnosis) | Same job, four looks and four levels of help. |
| Settings search, 49 new-feature terms | 3 find nothing (`@`, `funnel`, `takedown`); 9 match 9–21 pages | The new things are hard to find by name. |
| `How do I…?` answers | 158 in `web/howto.json` (START_HERE still says 123) | Good coverage per page; none for Routines, Repeats, `/compact` or `/` commands. |
| Translations | 11,339 strings, 0 missing in es/fr/de/pt-BR/it (`scripts/i18n-extract.ts`) | The new pages are translated. |
| `web/app.js` | 13,323 lines, 660 KB | The biggest file in the repo by far. |
| `sara-plugin.mjs` (plugin SDK) | 15 byte-equal copies; equality tests found for 6 | A drift risk the tests only half cover. |
| Setup-card UI | `whatsapp.js` 450, `matrix.js` 385, `imessage.js` 383 lines; 16 helpers with the same names | Copy-paste that will grow with every new chat app. |
| Tests | 1,732 → 1,857 from 2.55.0 to 2.60.0 (15 skipped); 3 of 10 release check logs had one failure each | Mostly fixed; three timing tests still on the owner's flaky list (§3). |

## 2. Findings

Severity: **bug** (wrong behaviour), **wall** (a beginner gets stuck: the SSH test), **confusing**
(a person misreads or can't find it), **ugly** (looks unfinished or inconsistent), **minor**.
Effort: **S** (≤ half a day), **M** (a day or two), **L** (several days). Every screenshot name is a
file in `outputs/ui-review/polish2-audit/` (add `.png`).

### 2.1 Setup flows, with a beginner's eyes

| # | Page | Issue | Sev | Eff | Screenshot | Fix |
|---|---|---|---|---|---|---|
| N1 | Telegram, Discord, Signal, Email, WhatsApp, Matrix, iMessage, SSH | Four different setup patterns for the same job. Telegram is a bare form (*Bot token* field, no BotFather steps on the page); Signal and Email are three numbered lines and an *Add* button; WhatsApp, Matrix and iMessage are a guided card (*What you need*, time, terms, *Start*, then steps with ✓); SSH is two fields with a step list and the fix under the failing step. A person who learned one learns the next from scratch. | confusing | L | sheet-d2, s-telegram-1440, s-co-signal-1440, s-co-email-1440, s-ab-ssh-1440 | One **setup card** for every chat app and server (§4.1): what you need · about how long · what it costs → numbered steps checked with ✓ → the plain fix right under the failing step → *Test*. Built once (C3), used by all eight. |
| N2 | WhatsApp, Matrix, iMessage *Start*; Signal *Add Signal* | The first button opens the developer-grade plugin review card for Sara's **own** plugin: title *Add a plugin*, an amber *Not fenced in* chip, "This computer can't fence the plugin in. Only add plugins you trust.", a raw settings list (*Graph host, Media host, Template name…*) and an unticked *I trust this plugin's author*. A beginner who just read Meta's terms now meets a security warning about Sara herself. | wall | M | s-whatsapp-start-1440, s-imessage-start-1440, s-signal-add-1440 | First-party plugins (*Comes with Sara*, signature checked as today) get a short consent step inside the setup card: "This adds WhatsApp to Sara. It can reach graph.facebook.com and your phone number's messages; nothing else." One button *Add WhatsApp*; the full review card stays one tap away under *Details*. The fingerprint check in code is unchanged. |
| N3 | Signal | Step 1 is a raw command, `signal-cli -a +… daemon --tcp 127.0.0.1:7583 --receive-mode=manual`, with no word on installing signal-cli, Java, registering a number or linking. This is the SSH brick wall again. | wall | M | s-co-signal-1440, m-co-signal-390 | Guided steps like WhatsApp's: get signal-cli (per OS: winget / brew / a release download; Docker as an option), *Register her number* or *Link to my phone* (show the link QR), start it (Sara offers the exact command for this computer with *Copy*), then a ✓ when Sara reaches the daemon. Plain fixes: Java missing, port in use, number not registered. |
| N4 | Email | "type the address, the servers and the app password" before any of it is on screen; the Gmail / iCloud / Fastmail presets only appear after install. | confusing | S | s-co-email-1440 | Provider pick first (Gmail, iCloud, Fastmail, Other) with the link to that provider's app-password page; then the address; the servers fill themselves. |
| N5 | Telegram | No steps for making the bot; the page opens on *Bot token* and eight checkboxes. The how-to box has them, collapsed. | confusing | S | s-telegram-1440 | Setup card with three steps (open @BotFather → `/newbot` → paste the token, ✓ when Sara reaches it) and *Test*; the options fold under *More*. |
| N6 | WhatsApp | *About Meta's rules* is a 90-word paragraph above the *I understand* box. | minor | S | s-co-whatsapp-1440, s-co-whatsapp-day-1440 | Two bullets ("Meta's rules limit AI assistants on WhatsApp; Meta may restrict the number." / "Use a number you can lose, keep her to you and people you choose.") and the link. |
| N7 | SSH | A failed connect to `nonexistent.invalid` leaves a server row *nonexistent · Needs a look* in *Your servers*; the step card has its own ✕ beside the Settings ✕ (two close buttons on screen). The error text itself is good ("I can't find …", *Edit address*). | minor | S | s-ssh-try-1440 | A server is listed once it has connected (or as *Not connected yet · Remove*); the step card's ✕ becomes a *Cancel* text button. |
| N8 | All guided cards on a phone | Card inside card inside card (three borders) loses ~40 px of width; the page intro plus *How do I…?* fill ~45% of the first screen before the first field. | ugly | S | m-co-whatsapp-390, m-co-imessage-390, m-co-matrix-390 | One level of card on phones (`≤ 480 px`); the intro clamps to two lines with *More*, as the Planner intro already does. |

### 2.2 The Store, plugins and companion packs

| # | Page | Issue | Sev | Eff | Screenshot | Fix |
|---|---|---|---|---|---|---|
| N9 | Get more | *My add-ons* is drawn as the selected (gradient) button while the page shows the shelf; *My add-ons · Submit yours · My submissions* look like tabs but act as buttons. | confusing | S | s-ab-store-1440, s-store-myaddons-1440 | A real segmented control *Browse · My add-ons · Submit*, with *Browse* selected; *My submissions* moves inside *Submit*. |
| N10 | Get more | The same items twice on the first screen (*Popular with beginners* and *Everyday* both start Weather alerts, Focus), and every card has the same generic square icon. | ugly | S | s-ab-store-1440, s-ab-store-day-1440 | One appearance per screen; an icon per kind (plugin, skill, tool server, companion) or the item's own icon from the signed list. |
| N11 | Get more | *Popular* is a sideways scroller with a clipped fourth card and its own scrollbar, inside the page scroll, inside the dialog scroll. | ugly | S | s-ab-store-1440, m-ab-store-390 | A wrapping grid of 3 (1 on phones) with *See all*. |
| N12 | Store item, *Get* | The item page shows "author key ed25519b6c8…b1" to everyone; the install dialog is titled just *Get*. | minor | S | s-store-item-1440, s-store-get-1440, m-store-item-390 | The key goes under *Details*; the title reads "Add Weather alerts". |
| N13 | Store *Get* on Windows | Every plugin card shows two or three amber boxes: "This computer can't fence the plugin in…", "In main.mjs: sends data to api.open-meteo.com", even for a signed add-on the Sara team reviewed. Amber on everything teaches people to ignore amber. | confusing | S | s-store-get-1440 | One calm line for Windows ("Runs with Node's permission limits; no sandbox on Windows. Reviewed by the Sara team.") and the network lines folded into *What it can do*, which already lists them. Amber stays for unreviewed or changed-permission items. |
| N14 | Plugins | The page opens with the amber "can't fence plugins in" box before anything else; *Comes with Sara* lists *Email 1.0.0 · Add Email*, a second door to Connections → Email. | confusing | S | s-ab-plugins-1440 | The warning moves into the review card (N13); *Comes with Sara* rows say "Set up in Connections → Email" and link there. |
| N15 | Share her | *Her personality dials (0 set)* unticked by default; *Routines she suggests* wants ids typed by hand (`bedtime, weekly-review`); *Save the file* is disabled with no reason until *Check it* runs. | confusing | S | s-share-her-1440, m-share-her-390 | Dials ticked (with "uses the defaults" when none are set); routines as chips picked from the gallery; the disabled button says "Check it first". |
| N16 | Companions | *Share her*, *Update from a file* and installing from the Store hide behind ⋯; the visible actions are *Add* and *From a file…*; nothing says the Store has companions. | confusing | S | s-her-companions-1440, s-companions-menu-1440, m-her-companions-390 | A *Share her* button on her row; *Get a companion from the Store* beside *From a file…*. |

### 2.3 Goals, loops, routines, reminders, `/compact` and `@`

| # | Page | Issue | Sev | Eff | Screenshot | Fix |
|---|---|---|---|---|---|---|
| N17 | Keep going and repeats | 16 raw number pick-lists (*Tokens per goal 1,000,000*, *Dollars per day, all repeats $0.5*, *Steps per check 10*, *Stuck after 2*…), and the intro is said twice (page description, then a paragraph with the same words). The owner's dial lesson from PL1, again. | confusing | M | s-ab-persist-1440, s-ab-persist-day-1440, m-ab-persist-390 | Three presets as choice cards (*Careful*, *Normal*, *Long jobs*) with a summary line in words ("Stops after 5 rounds or an hour; about $0 on this computer"); the numbers under *Fine-tune*. One intro. |
| N18 | Check her edits | Leftovers for developers on an everyday page: "Language servers (typescript-language-server, pyright-langserver) are not used in this version…"; "Her next step waits up to (seconds)". | minor | S | s-ab-precise-1440 | Drop the language-server sentence (it belongs in CHECKS.md); "Wait up to 20 s" as the option text. |
| N19 | Chat | There is **no `/` menu** in the app. `/goal`, `/loop`, `/compact`, `/when`, `/continue`, `/tools`, `/btw` work only for people who read the guide (no slash suggestions anywhere in `web/`; typing `/` shows nothing). Telegram and Discord list their commands; the app doesn't. | confusing | M | v-chat-slash-1440, mv-chat-slash-390 | Typing `/` at the start opens a menu built like the `@` menu (`web/refs.js`): each command with one line ("/goal: keep going until a check passes"), filtered by owner/member and chat kind; Enter inserts it with its template. |
| N20 | Chat | Typing `@` in a new chat (workspace *main folder*) showed no menu in this run. `refs.js` closes the menu unless the place has a workspace or a URL; the input was synthetic (CDP), so this needs an owner check before it counts as a bug. | minor (unverified) | S | v-chat-at-1440, mv-chat-at-390 | Owner check first. If it reproduces: when `@` can't be used here, one hint line "@ works in a project chat: open a project". |
| N21 | Planner | The Planner's *How do I…?* (3) covers to-do, reminder and the week review only; nothing for Repeats, Routines or *When it comes up*. Repeats' empty state is three grey lines that spell out "+ → Repeat this…". | confusing | S | v-planner-repeats-1440, mv-planner-tabs-390, v-planner-reminders-1440 | A *How do I…?* per Planner tab; the empty-state component (icon, one line, one button: *Repeat something in a chat*) like Reminders already has. |
| N22 | Planner → Reminders | The *When it comes up* add row is below the fold, with small fields and a clipped placeholder ("When these words cc…"). | ugly | S | v-planner-reminders-1440 | Its own small card with a full-width "Remind me…" field and a person/words switch; the placeholder shortened. |
| N23 | Planner → Routines | Cards that need setup show a pale, disabled-looking *Turn on* with the reasons as red ✗ lines above it; in the light theme the pale gradient is close to the card colour. | minor | S | v-planner-routines-1440, v-planner-routines-day-1440, mv-planner-routines-390 | The button reads *Set up first* and opens the first missing need; enabled-looking. |
| N24 | Tools and approvals | The short tool list speaks tokens: "Right now: 67 tools ≈ 9.9k tokens each step; short list ≈ 2.8k", *Short list above 6,000 tokens*. On phones the first option is clipped ("…when there are many too"). | minor | S | s-ab-tools-1440, m-ab-tools-390 | "She gets the tools that fit each step (saves about 70%)"; the token numbers under the `?`; shorter option labels. |
| N25 | Chat, her panel | The panel's "This conversation is 1% full" ring is good, but nothing in the app offers `/compact` when it fills; it runs by itself at 85%. | minor | S | v-chat-first-1440 | From 70%: the panel line gets a *Tidy this chat* button (the same call as `/compact`), with *Show summary* after. |

### 2.4 Today, first run and the check-in note

| # | Page | Issue | Sev | Eff | Screenshot | Fix |
|---|---|---|---|---|---|---|
| N26 | Today and Chat after the wizard | The anonymous check-in note floats at the bottom and **covers the composer and the + menu** right after setup; on a phone it covers ~40% of Today and of the chat. PL1's first-run queue (F2) keeps it off the wizard but not off the chat box. | bug | S | v-today-after-1440, v-chat-first-1440, v-chat-plus-1440, mv-today-after-390, mv-chat-slash-390 | Show it as a card inside Today (same three buttons), or a one-line banner above the composer on phones with *More*; never over the composer. A rendered test asserts the composer is not covered. |
| N27 | Today, tours | Nothing on Today or in the tours mentions the chat apps (WhatsApp, Signal, Matrix, iMessage, email), the Store or Hey Sara; *Put her on your phone* means the phone app only. The tours (`first`, `company`, `coding`) have no stop for any feature since 2.47. The new features are invisible until someone opens Settings. | confusing | M | v-today-after-1440, v-today-after-day-1440 | When *Getting started* is done it becomes **Next steps**: three cards picked by the use path (company: "Text her from WhatsApp or Signal", "Turn on a routine", "Hey Sara in the Windows app"; coding: "Type / for commands", "Let her keep going until tests pass", "Get tool servers from the Store"). One more stop in the coding tour (the `/` menu). Never more than three at once. |
| N28 | Wizard | The wizard is the PL1 design and works; the routines offer shows as Today's *Add a routine* row. | — | — | w-step2-1440, w-step3-1440 | No change; listed so nobody reworks it. |

### 2.5 Settings: sprawl and search

| # | Page | Issue | Sev | Eff | Screenshot | Fix |
|---|---|---|---|---|---|---|
| N29 | Settings nav | 58 pages. **Abilities (16)** mixes the Store, tools and approvals, five coding pages, *When it comes up* (a reminder), *Keep going*, Gmail and Home Assistant. **Connections (13)** mixes seven chat apps with the phone, computer use, other agents and webhooks. A beginner looking for WhatsApp has to guess "Connections"; one looking for "When it comes up" won't guess "Abilities". | confusing | M | s-nav-all-1440, `settings-nav.json` | Regroup to 8 groups of ≤ 10, **page ids unchanged** (§4.2). |
| N30 | Settings search | Of 49 new-feature terms: `@`, `funnel` and `takedown` find nothing; `tailscale` doesn't find WhatsApp or Matrix (whose step 7 is Tailscale Funnel); `routine` finds Tools and approvals and Home Assistant but not Routines (a Planner tab, outside Settings); `compact` finds only About you; `hey sara` matches 16 pages, `when it comes up` 12, `share her` 11, `pick up` 13, unranked. | confusing | M | s-search-whatsapp-1440, `search-results.json` | Page keywords and synonyms (`tailscale`/`funnel` → WhatsApp, Matrix; `@`/`mention` → Check her edits), the *How do I…?* questions searched too, ranked title → question → label, and an **Elsewhere** group that opens Planner tabs and chat commands. Ctrl+K uses the same index. |

Search results (page ids, from the live run; full list in `search-results.json`):

| Term | Pages | Term | Pages |
|---|---|---|---|
| whatsapp / matrix / imessage / signal | their own page only ✓ | short tool list | ab-tools, co-telegram, co-discord |
| store | models-providers, ab-store, co-phone, co-hooks, dh-movein, dh-privacy | routine | ab-tools, ab-home (no Routines) |
| compact | you-about | safety | her-character, models-routes, ab-tools, dh-safety |
| ssh / cpanel | ab-tools, ab-ssh, dh-movein / ab-ssh ✓ | @ / funnel / takedown | **none** |
| packs / character card | her-companions among them ✓ | voice note | her-voice, her-hey, her-companions, household |

### 2.6 One look

| # | Page | Issue | Sev | Eff | Screenshot | Fix |
|---|---|---|---|---|---|---|
| N31 | Store, Routines, Today | Icons drift again: the Store's one generic square; emoji in Routines and Today's *Add a routine* (☀ 🧘 🗓 🌙 🚗); line icons everywhere else. | ugly | S | s-ab-store-1440, v-planner-routines-1440, v-today-after-1440 | Line icons from `web/icons.js` for kinds and routines (emoji stay inside her messages). |
| N32 | Light theme | Disabled gradient buttons (*Turn on* on Routines, *Save the file* on Share her) are pale pink on near-white. | minor | S | v-planner-routines-day-1440 | A disabled style with a border and grey text that passes 3:1 against the card. |
| N33 | Today (page text) | Section labels are in the text twice ("YOUR DAY / Your day", "NEEDS YOU / Needs you"); the picture shows one. Likely read twice by a screen reader. | minor (check) | S | v-today-after-1440 (`.txt`) | `aria-hidden` on the small-caps label, or one heading. |
| N34 | Dark and light | Otherwise both themes hold on every new page: no unreadable text, cards and amber notes keep contrast. | — | — | sheet-d8, s-dh-safety-day-1440, s-ab-store-day-1440, s-ab-ssh-day-1440 | — |

### 2.7 Docs, guide and README

| # | Where | Issue | Sev | Eff | Fix |
|---|---|---|---|---|---|
| N35 | README first screen | The status line says "**2.47**, … fifty-eight feature releases since 1.0"; the first screen shows the coding demo and the two path buttons but nothing of what came since: seven chat apps, the Store, Hey Sara, goals that end on a real check. | confusing | S | Status line filled from `package.json` at release; under the demo one row "Talk to her in the app, Telegram, Discord, WhatsApp, Signal, Matrix, iMessage or email", and one row of four "new since 2.47" links. |
| N36 | FOR_CODERS.md | Stops at 2.53: nothing on `/goal … done when tests`, `/loop`, steering (*Tell her now*), `/btw`, `/compact` and the short tool list, Store tool servers (Playwright, GitHub, Context7); the easy SSH connect is one table row. | confusing | S | Sections *Long jobs* (goal + loop + budget, one example each), *Big tool sets* (short list, `/tools`, `/compact`), *Get tools* (Store tool servers), and the `/` command table. |
| N37 | START_HERE.md | No chat apps, Store or Hey Sara; says "All 123 answers" (now 158). | minor | S | Section 8 *Talk to her from your phone's apps* (Telegram first as the easiest); the count filled by the docs build from `howto.json`. |
| N38 | In-app guide (`web/help.html`), How do I | 0 mentions of `/compact`, Routines, `@file` or `/btw` in the guide (grep); *How do I…?* has nothing on routines, `/compact` or `/goal`. | confusing | S | Guide sections *Long chats and /compact*, *Routines*, *Commands you can type*; howto entries for each, so HOW_DO_I.md (generated) picks them up. |

## 3. Code health since 2.47 (findings only, nothing changed)

| # | Area | Finding | Sev | Eff | Recommendation |
|---|---|---|---|---|---|
| C1 | `web/app.js` | 13,323 lines (660 KB). The Settings nav and search, the wizard, the tours, chat rendering, devices and much more share one module, so every UI phase edits it and two agents can't work on the web app at once. | debt | L | Mechanical split in PL2d, gated like the router split (§5): `web/settings-nav.js` (groups, order, search; needed by N29/N30 anyway), `web/setup-wizard.js`, `web/tours.js` (the `TOURS` data), with every id, string and test hook unchanged; i18n extract 0 missing before and after. The chat renderer stays for a later pass. |
| C2 | `src/` | Biggest files: `chat.ts` 3,028, `plugins/manager.ts` 2,523, `server.ts` 2,170, `ssh.ts` 1,277 lines. `manager.ts` grew with every bridge contract (1.1 files, 1.2 sockets) since 2.48. | debt | M | Not in PL2. Note for the next code pass: split the bridge-contract part of `manager.ts` (files, sockets, voice) into `src/plugins/bridge.ts`. |
| C3 | Setup-card UI | `web/whatsapp.js` 450, `matrix.js` 385, `imessage.js` 383 lines share 16 helpers by name (`api btn copyRow diagLine el field intro load okLine render side stepBody summary termsBox test tip`). `copyRow`, `diagLine` and `field` are byte-identical in Matrix and iMessage and differ in WhatsApp; `okLine` is identical in all three; `intro`, `termsBox`, `summary` differ in all three. `web/ssh.js` (709) has a fourth step UI. | debt | M | One `web/setup-card.js` (steps with ✓, the fix line under a step, copy rows, the terms box, *Test*) used by the three plugins, then Signal, Email, Telegram and SSH (N1). Each page keeps only its step list and its diagnoses table. |
| C4 | Plugin SDK copies | `sara-plugin.mjs` (257 lines) is byte-equal in **15** places: `examples/plugins` (4), `plugins/*` (5), `store/plugins/*` (6). Equality is tested for 6 of them (phase98, phase117, phase122b, phase122c); `plugins/whatsapp`, `plugins/email`, `examples/plugins/webhook-notes` and the six store copies aren't covered by those tests. `http1.mjs` is byte-equal in 3 plugins (tested). `pace.mjs` exists as **4 different** files (WhatsApp, Matrix, iMessage, Signal). | risk | S | One test that globs every `sara-plugin.mjs` and `http1.mjs` outside `node_modules`/`outputs` and compares hashes with `examples/plugins/sara-plugin.mjs`; a `npm run sdk:sync` that copies it. Decide whether `pace.mjs` should be one file with per-app limits (likely yes) or documented as four. |
| C5 | Flaky tests (owner's list) | Status from the code and the release check logs: **phase80** (sandbox: `sleep 45 &`, `timeoutMs: 1500`, a `ps` count right after; timing-based); **phase86** (red-team probes against seeded apps; long timings, 22–51 s cases); **codemap perf** (`performance.now()` around `refreshAll()` on a copy of `src`, `web` and `test`, which grows every release); **fixb-hardening M4** (ECONNRESET on the Home Assistant token path); **phase76** (notes ranking under load); **phase122** plugin restart race (fixed in 2.55.2; the 2.55.2 log shows the `phase122b` file failing once before the fix); **phase116** Discord turn (fixed in 2.53.0 by waiting for the turn). Other one-off failures in the logs: 2.55.1 "setup: ten steps…" (WhatsApp, fixed in the same release), 2.59.0 "translated tips stay short enough" (a real 264-character Spanish tip, fixed). | risk | M | PL2d: codemap perf asserts per 1,000 files (or moves to `bench/`); phase80 polls for the process state instead of a fixed wait; M4 retries once on ECONNRESET in the test's HTTP helper only; phase76 ranks with a fixed clock and no wall-time budget. Each change keeps the assertion; run each test 10× under `npm test` load before closing. No test was run in this audit. |
| C6 | Release check time | Full suite 181–206 s across 2.55–2.60 with 1,732–1,857 tests. Fine today; it doubles the window for timing flakes when other work runs. | note | — | Keep timed checks out of the main suite (C5). |

## 4. Patterns for this pass

### 4.1 The setup card (one for every chat app and server)

Built from what already works on WhatsApp and SSH:

1. **Header:** the app's icon, name, a *Not set up / Working / Needs a look* chip (as today).
2. **Before you start:** *What you need* (3–4 bullets), *About how long*, *What it costs* (free / your
   plan / a paid number), and, only where there is one, one short *Rules* box with a link (Meta's
   terms, Apple's). One button: *Start*.
3. **First-party consent (N2):** inside the card, one line on what the plugin can reach, *Add
   WhatsApp*, and *Details* for the full review card. Third-party plugins keep the full card.
4. **Steps:** numbered, each with its own fields; ✓ when Sara verified it; the plain fix right under
   a red step (the SSH wording style: "I can't find …" + one button that fixes or edits).
5. **Test** at the end; a sent message the user sees on their phone.
6. **When it works:** the card folds to one line ("WhatsApp: working · last message 2 min ago ·
   *Settings*") and the options appear below it.

Phones: one card level (N8). The step list, the fix line and the copy rows come from `web/setup-card.js`
(C3). Telegram, Discord, Signal, Email, WhatsApp, Matrix, iMessage and SSH all use it.

### 4.2 Settings in 8 groups (page ids unchanged)

| Group | Pages (count) |
|---|---|
| **Her** | Name and personality, Relationship, Look, Pictures from her, Voice, Hey Sara, Calls from her, Companions, Bring her from another app (9) |
| **You** | About you, Morning briefing, Leave-by reminders, *When it comes up*, Adult mode (5) |
| **Models** | Default model, Which model does what, Model providers, Subscriptions, On this computer (5) |
| **Chat apps** (new) | Telegram, Discord, Signal, Email, WhatsApp, Matrix, iMessage, Pick up across apps (8) |
| **Add-ons** | Get more, Skills, Plugins, Other programs (MCP), Web search, Library, Gmail and Calendar, Home Assistant (8) |
| **Coding** | Coding projects, Check her edits, Keep going and repeats, Budgets, GitHub, Servers over SSH, Tools and approvals (7) |
| **Connections** | Phone and notifications, Computer use, This computer (desktop app), Other apps, Other agents, Webhooks (5–6) |
| **Data & health** | Safety check-up, Health, Devices and sign-in, Backups, Export and import, Move in from another agent, Updates, Usage and costs, Privacy, Reports (10) |
| Household | People on this server (1) |

*Tools and approvals* moves to Coding because most of its rows are about commands; it stays linked
from Safety check-up and from every approval card. The guide's "Settings → Abilities → …" paths
change to the new group names (one generated table in the docs build; old paths kept as "also
called" for one release). The tour step `#settings-nav-list [data-page="her-character"]` is unaffected.
Group counts stay ≤ 10, so the accordion never needs a second scroll. Question Q2.

### 4.3 The `/` menu

Same component as the `@` menu (`web/refs.js`: listbox, ↑↓, Enter, Esc, `aria-activedescendant`).
Rows: `/goal`, `/loop`, `/compact`, `/tools`, `/when`, `/continue`, `/btw`, `/queue`, `/stop`,
`/new`, `/reset`, `/status`, `/model`, `/remember`, `/progress`, `/problems`, each with its line from
`docs/CHATS.md`, filtered by who you are (members don't see owner-only ones) and the chat (no
`/goal` in a partner chat). The list lives in one data file used by the menu, the Telegram and
Discord menus and the guide's table, so the three can't drift.

## 5. Build slices

Four slices, each a release, ordered by what a beginner hits first. Phase 128 is 2.61.0 on the
ROADMAP, so the slices ship as **2.61.0 → 2.61.3** (question Q1). Every slice: the bugs it touches
first; desktop and phone screenshots retaken with the throwaway-server method and looked at; strings
through the i18n build for the 6 languages (0 missing); the gates in DEVELOPMENT.md.

### PL2a (2.61.0): no more brick walls

Why first: the owner's SSH sentence; every chat-app setup is a first impression.

- C3 `web/setup-card.js`; N1 for WhatsApp, Matrix, iMessage, Signal, Email, Telegram (Discord and
  SSH may stay as they are if time runs out; SSH already follows the pattern in spirit).
- N2 first-party consent step; N3 Signal guided steps; N4 Email provider pick; N5 Telegram steps;
  N6 Meta's rules in two bullets; N7 SSH draft row and the second ✕; N8 one card level on phones.
- N26 the check-in note never covers the composer.

**Done when (tests):**
- [ ] `test/phase128a.test.ts`: every Connections chat-app page renders a `.setup-card` with *What
      you need*, a time line and a cost line before setup (DOM test over the page templates).
- [ ] Same file: a first-party plugin (`plugins/*`, signature checked) shows the consent step and
      installs with one OK; a third-party plugin still gets the full review card; the plugin
      fingerprint check runs in both cases (spy on the manager).
- [ ] Same file: Signal step texts include an install line for Windows, macOS and Linux and a
      *Copy* row; the "daemon not reachable" diagnosis maps to one plain sentence.
- [ ] Same file: the shared helpers are imported, not copied (`whatsapp.js`, `matrix.js`,
      `imessage.js` contain no `function copyRow|diagLine|field|okLine`).
- [ ] `test/ssh-easy.test.ts` (existing) green; new case: a failed first connect leaves no server row.
- [ ] `test/ui-start-today.test.ts` gains: after the wizard, the check-in note's box does not
      intersect `#input`'s box at 1440×900 and 390×844.
- [ ] Old ids kept: phase117, phase122, phase122b, phase122c setup tests green unchanged.
- [ ] Screenshots retaken: `s-co-*-1440`, `m-co-*-390`, `s-whatsapp-start-1440`, `mv-today-after-390`.

**As built (PL2a, 2.61.0).** `web/setup-card.js` is the shared card (C3); WhatsApp, Matrix, iMessage,
Signal (`web/signal.js`, six steps, the daemon check `POST /api/plugins/signal/probe`, the link QR),
Email (`web/email.js`, provider first) and Telegram (`web/telegram-setup.js`, the old options under
*More* with their ids) use it; Discord and SSH keep their pages (SSH already follows the pattern).
First-party is proven by the server only (`Review.firstParty`: staged from Sara's own plugins folder
with folder = id, or a `first-party` entry in the signed store list); the page sends `consent`, which
counts as the trust tick only for such a review, and `checkFingerprint` runs at every approve. Meta's
rules are two bullets, the link and the tick (owner to-do 3). N7: a Connect that never reached the
server is a hidden `draft`, removed on *Cancel* or the next Connect. N26: the note sits in the page
flow (`#td-checkin`, `#chat-checkin`); measured with Edge after the wizard: note 681–822 / input
836–880 at 1440×900, note 500–702 / input 715–759 at 390×844. Deviation: the Done-when intersect
check is a modelled-layout test in `ui-start-today.test.ts` (the suite has no browser); the live
numbers above come from the screenshot run (`outputs/ui-review/pl2a/`).

### PL2b (2.61.1): find it, and know it's there

- N29 Settings in 8 groups (§4.2) with ids unchanged; N30 search keywords, synonyms, ranking and
  *Elsewhere*; N19 the `/` menu (§4.3); N20 the `@` hint (after the owner check); N27 *Next steps*
  on Today and one coding-tour stop; N16 *Share her* button and the Store link on Companions;
  N25 *Tidy this chat* from 70%.

**Done when (tests):**
- [ ] `test/phase128b.test.ts`: every page id in `SETTINGS_ORDER` is in exactly one group; no group
      has more than 10 pages; `OLD_TABS` and every `openSettings('<id>')` call still resolve.
- [ ] Same file: search returns the expected first page for a table of 30 terms (whatsapp →
      co-whatsapp, tailscale → co-whatsapp/co-matrix, @ → ab-precise, routine → *Elsewhere:
      Planner → Routines*, compact → *Elsewhere: /compact*, hey sara → her-hey first).
- [ ] Same file: the `/` menu opens on `/` at position 0 only, lists owner-only commands only for the
      owner, and its data equals the Telegram command list and the guide's table (drift test).
- [ ] `test/ui-today.test.ts`: *Next steps* shows exactly three cards per use path once
      *Getting started* is complete, never while it isn't.
- [ ] Tour tests: the coding tour's new stop resolves its selector.
- [ ] The guide's Settings paths come from the group table (generated; existing drift test).

### PL2c (2.61.2): forms into choices, the Store and packs

- N17 Keep going presets; N18 Check her edits wording; N24 Tools wording; N21 Planner how-tos and
  Repeats empty state; N22 *When it comes up* row; N23 *Set up first*.
- Store: N9 segmented control, N10 one appearance per screen and kind icons, N11 grid, N12 key under
  *Details*, N13 one calm Windows line; N14 Plugins page.
- Packs: N15 Share her defaults, routine chips, "Check it first".
- Look: N31 line icons, N32 disabled style in the light theme, N33 one heading.

**Done when (tests):**
- [ ] `test/phase128c.test.ts`: each Keep-going preset maps to the exact numbers it shows in words
      (`Careful`, `Normal`, `Long jobs` → rounds, minutes, tokens, dollars); picking *Fine-tune*
      keeps the old fields and ids; settings saved by 2.60 load unchanged and show *Custom*.
- [ ] Same file: the Store's first screen lists each item id once; every card has a kind icon.
- [ ] Same file: a reviewed store plugin on Windows shows one notice line, an unreviewed one or one
      whose permissions changed keeps the amber box (fixture of both).
- [ ] Same file: Share her ticks dials by default; routine chips write the same ids the pack format
      expects (`docs/PACKS.md`); *Save the file* explains why it is disabled.
- [ ] `test/ui-look.test.ts`: disabled buttons pass 3:1 against their card in both themes.
- [ ] Phase 121, 124, 125, 127 tests green unchanged.

### PL2d (2.61.3): docs, README, and the code debt

- N35 README first screen and status line; N36 FOR_CODERS; N37 START_HERE; N38 guide sections and
  how-tos (feeding HOW_DO_I.md).
- C1 split `settings-nav.js`, `setup-wizard.js`, `tours.js` out of `web/app.js` (moves only).
- C4 the SDK-copies hash test and `npm run sdk:sync`; the `pace.mjs` decision.
- C5 flaky-test hardening.

**Done when (tests):**
- [ ] `test/phase128d.test.ts`: the README status line equals `package.json`'s version; the
      START_HERE answer count equals the questions in `howto.json`; every guide link in the new
      sections resolves to a unique id in `web/help.html` (the PL1 unique-id test still passes).
- [ ] Same file: every `sara-plugin.mjs` and `http1.mjs` in the repo (outside `node_modules` and
      `outputs`) has the hash of `examples/plugins/sara-plugin.mjs` / `plugins/whatsapp/http1.mjs`.
- [ ] After the C1 split: the sorted list of `t('…')` keys and of element ids used by `web/*.js` is
      identical to a baseline taken before the move; i18n extract 0 missing; all UI tests green.
- [ ] codemap perf, phase80, fixb-hardening M4 and phase76 each pass 10 runs in a row while the
      full suite runs in parallel (recorded in the release notes, not as a test).

## 6. What Hermes Agent and OpenClaw have that Sara still lacks

Checked 2026-11-02 against their docs indexes ([H0], [O0]) and the pages linked below; Sara's side
checked in the code, not only the docs (file names given). Same rules as
[GAP_REVIEW.md](GAP_REVIEW.md): features only, written from scratch, zero npm runtime dependencies,
safety and approval layers unchanged, anything scheduled or paid off by default (Rule 7).

### 6.1 Already done since GAP_REVIEW (do not rebuild)

| GAP_REVIEW item | Built in | Checked in code |
|---|---|---|
| G1 photos and files both ways | 2.48.0 | `src/bridges/media.ts`, `send_file` tool |
| G2 more chat apps | 2.50.0, 2.55.0–2.55.2 | `plugins/signal`, `email`, `whatsapp`, `matrix`, `imessage` (Slack, SMS not built: §6.2) |
| G3 steer, queue, `/btw` | 2.49.0 | `docs/CHATS.md`, bridge commands |
| G4/G5 goals and loops | 2.51.0 | `web/persist.js`, `/conversations/:id/goal`, `/loops` |
| G6 checks after edits | 2.53.0 | project checkers only; the language-server engine was left out (§6.2 #9) |
| G7 `@`-references | 2.53.0 | `web/refs.js` |
| G8 lean tool list; G20 `/compact` | 2.56.0 | `web/lean.js`, `src/compact.ts` |
| G9 loop guard; G10 progress message | 2.49.0; 2.48.0 | `src/bridges/progress.ts` |
| G11 when it comes up; G12 pick up across apps | 2.52.0 | `src/mentions.ts`, `src/pickup.ts` |
| G13 routines; G16 safety check-up | 2.54.0 | `web/routines.js`, `web/checkup-view.js` |
| G14 the shelf; G15 skill tidy-up | 2.57.0–2.58.0 | `web/store.js` |
| G17 Hey Sara | 2.59.0 (Windows; Android detector, Mac and Linux pending) | WAKE.md |
| G18 companion packs | 2.60.0 | `web/packs.js` |
| **Voice notes** (the owner's example) | long before: Phase 11 | Telegram and Discord hear voice notes and answer with one (`src/bridges/telegram.ts` ~l.525, `discord.ts` `sendVoice`; Settings → Voice *Voice notes on Telegram and Discord*); the web app records with the microphone (`web/voice.js`); WhatsApp, Matrix and iMessage voice notes are **heard** (`src/plugins/manager.ts` ~l.1541). **Not done:** her voice-note *replies* in the plugin chat apps, and Signal voice notes are not transcribed yet (`plugins/signal/main.mjs` l.207). See #1 below. |

### 6.2 Still missing, ranked by value to coders and companion users

| # | What | Who has it | Sara today (checked) | For | Effort | Recommendation |
|---|---|---|---|---|---|---|
| 1 | **Her voice notes in every chat app**: she answers a voice note with one on WhatsApp, Signal, Matrix and iMessage, and Signal's are heard | Hermes TTS delivers voice to Telegram, Discord and WhatsApp [H1]; OpenClaw voice messages and audio [O1][O2] | Telegram/Discord only; plugin bridges get a `voice: true` *in* but the SDK has no voice *out*; Signal skips audio | Companion | M | **Do first.** Bridge contract 1.3: `sendFile({ voice: true })` outward, the same *Voice notes* setting for every app, Signal transcription through the existing hearing path. ffmpeg stays optional (Opus via the voice service when present). |
| 2 | **A `/` command menu and one command list** (in-app) | Both list slash commands in their UIs and Slack manifests [H2][O3] | No `/` menu in `web/` (N19) | Both | M | In PL2b (§4.3), not a new phase. |
| 3 | **Slack** (Socket Mode: no public address) | Both [H3][O4] | None (only move-in readers mention it) | Coders, teams | M | First-party plugin on the 1.2 socket contract; Socket Mode keeps it beginner-friendly (no tunnel). |
| 4 | **SMS** | Both via Twilio [H4][O5] | AgentText on hold (404 on 2026-11-02) | Companion | M | Twilio plugin; needs an owner OK on cost (a paid number). |
| 5 | **ACP: use her inside Zed, JetBrains and other ACP editors** | Both [H5][O6] | VS Code panel, MCP, OpenAI-compatible API; no ACP | Coders | M | Next coder phase after #3; parked in ROADMAP, worth un-parking. |
| 6 | **Ask-me card**: she stops and asks a structured question (pick one, yes/no, a short answer) that renders as buttons in the app and in chat apps | OpenClaw `ask_user` [O7] | No such tool in `src/tools` (grep); approval cards are yes/no for tools only | Both | S–M | Small, high everyday value ("which of these three?"); reuse the approval-card buttons in Telegram/Discord. |
| 7 | **Matrix end-to-end encryption** | OpenClaw [O8] | Refuses encrypted rooms on purpose (2.55.1) | Companion privacy | L | Research only: needs Olm/Megolm without npm runtime deps; propose after a spike. |
| 8 | **Discord voice channels** (live talk in a voice channel) | Both [H6][O9] | Calls in the apps; voice notes in Discord; no voice channel | Companion groups, gaming | L | Keep parked with agent conference calls (owner, 2026-10-30). |
| 9 | **Language-server diagnostics** (pyright, gopls, rust-analyzer) | Hermes [H7] | Project checkers only (2.53.0 left LSP out) | Coders | M | Optional engine behind *Check her edits*, only when a server is installed. |
| 10 | **Widgets and pinned reports**: she builds a small live panel or dashboard card | OpenClaw `show_widget` [O10] | Result cards; phone widgets (`src/routes/her.ts`); no agent-made widget | Both | M–L | After #6; sandboxed HTML in a Today tile with the same CSP as cards. |
| 11 | **Code mode** (one script calls several tools, only the result comes back) | Both [H8][O11] | None | Coders, big MCP sets | L | Still parked; the short tool list already took most of the token win. |
| 12 | **Location in chat apps** ("here's where I am" → leave-by, check-ins) | OpenClaw channels location [O12]; Telegram media [O13] | Telegram location messages not handled (`src/bridges/telegram.ts`, grep) | Companion | S | Small add to the leave-by flow; private by default. |
| 13 | **Telegram Mini App** (open her app inside Telegram) | OpenClaw [O14] | None | Companion, beginners | M | Nice, not urgent; needs a public address like WhatsApp. |
| 14 | **WhatsApp groups and voice replies** | OpenClaw WhatsApp groups [O15]; Hermes WhatsApp [H9] | 2.55.0: no groups, no voice replies | Companion | M | Voice replies come with #1; groups wait for Meta's Cloud API rules. |
| 15 | **Key pools** (several keys per provider, rotate on rate limits) | Hermes credential pools [H10]; OpenClaw failover [O16] | Model fallback across providers; one key each | Coders, heavy use | S–M | Low; fallback covers most of it. |
| 16 | Teams, Google Chat, Mattermost, LINE, WeChat… | Both [H11][O4] | None | Workplaces | M each | Not for this owner's users now. |
| 17 | Mixture-of-agents presets, Apple Watch / HealthKit, extra memory providers (Honcho, Mem0) | Hermes [H12]; OpenClaw [O17][O18] | Not built | Niche | — | Skip for now. |

### 6.3 Proposed next track after Phase 128 (for the owner to approve)

"Reach and depth", one release each, every item needing the owner's OK before it goes on the
ROADMAP (Rule 9) and paid parts separately (Rule 7):

| Phase | Version | What | From §6.2 |
|---|---|---|---|
| 129 | 2.62.0 | Her voice notes in every chat app; Signal voice notes heard; location messages | #1, #12, part of #14 |
| 130 | 2.63.0 | The ask-me card in the app and chat apps | #6 |
| 131 | 2.64.0 | Slack (Socket Mode) | #3 |
| 132 | 2.65.0 | ACP editors | #5 |
| 133 | 2.66.0 | SMS through Twilio (owner OK on cost) | #4 |
| 134 | 2.67.0 | Optional language servers behind *Check her edits* | #9 |
| — | — | Finish Phase 126: Android always-on detector, Mac and Linux Hey Sara | (open) |

Parked as before: Discord voice channels with agent conference calls, code mode, widgets (re-check
after 130), Matrix encryption (spike first).

## 7. Questions for the owner (with defaults)

| # | Question | Default if the owner doesn't say |
|---|---|---|
| Q1 | Versions: four patch releases 2.61.0–2.61.3, or 2.61–2.64 and shift the next track? | 2.61.0–2.61.3, like PL1. |
| Q2 | Regroup Settings into 8 groups (§4.2)? It moves pages people know (WhatsApp leaves Connections for *Chat apps*). | Yes, ids unchanged; the old group shown as "moved to …" in search for one release. |
| Q3 | First-party plugins get the short consent step instead of the full review card (N2)? | Yes; the full card one tap away; third-party plugins unchanged. |
| Q4 | Keep-going presets (N17): may the *Normal* preset keep today's numbers exactly? | Yes: *Normal* = today's defaults, so nobody's limits change. |
| Q5 | `/` menu in the app: include member-only and room commands, or owner commands only at first? | Everything the person may use in that chat. |
| Q6 | *Next steps* on Today (N27): three cards after *Getting started*, or a single line? | Three cards, hideable, never before *Getting started* is done. |
| Q7 | The next track (§6.3): start with voice notes everywhere? | Yes; Phase 129 = voice notes everywhere. |
| Q8 | `pace.mjs`: merge the four into one SDK file with per-app limits? | Merge, with a byte-equal test like `sara-plugin.mjs`. |
| R1 | Settings regroup and setup-card changes can break tests and tours that find things by caption. | Keep every id; grep `test/` and `scripts/` for each caption before renaming it. |
| R2 | A release may run while a slice is built. | Slices work on a branch, never during a release check run. |

## 8. Owner to-do

1. Approve or change Q1–Q8 (one line each is enough).
2. Check N20 by hand: in the app, open a new chat in *main folder* and type `@`. Does a menu open?
3. Read the WhatsApp setup at 390 px on your phone once (N6, N8) and say if the shorter Meta box is
   still enough for you legally.
4. Decide the next track (§6.3): which of #1, #3, #5, #6 you want, and whether SMS (#4) is worth a
   paid Twilio number.
5. Retake the README demo/screens after PL2d if the first screen should show a chat app (your
   phone; the agent can't).
6. Phase 126 leftovers: say when the Android always-on detector and the Mac/Linux Hey Sara should
   come (they are still open on the ROADMAP).

## 9. Top 10, in one place

1. **N2** *Start* on WhatsApp/Matrix/iMessage/Signal opens a scary plugin card about Sara's own
   plugin → a short consent step (wall).
2. **N3** Signal starts with a raw `signal-cli … daemon` command → guided steps (wall).
3. **N1/C3** Four setup patterns for chat apps, the UI copied three times → one setup card.
4. **N26** The check-in note covers the composer after setup, 40% of a phone screen → a card in Today (bug).
5. **N19** No `/` menu: goals, loops, `/compact`, `/when` are invisible in the app → `/` menu.
6. **N29/N30** 58 Settings pages, Abilities 16; search misses `@`, Tailscale, Routines → 8 groups, better search.
7. **N17** Keep going is 16 raw numbers → three presets.
8. **N27** Today and the tours never mention chat apps, the Store or Hey Sara → *Next steps*.
9. **N9–N13** Store: a "selected" button that isn't, duplicates, one icon, amber on every card → calm, clear shelf.
10. **N35–N38/C4** README says 2.47; FOR_CODERS stops at 2.53; 9 of 15 SDK copies untested → docs and a hash test.

## Sources

Read 2026-11-02. Where a claim rests only on the docs index line, it says so.

- [H0] Hermes Agent docs index — https://hermes-agent.nousresearch.com/docs/llms.txt
- [H1] Voice & TTS (platform delivery: Telegram, Discord, WhatsApp; voice message transcription) — https://hermes-agent.nousresearch.com/docs/user-guide/features/tts
- [H2] Slash commands — https://hermes-agent.nousresearch.com/docs/reference/slash-commands
- [H3] Slack (Socket Mode, generated manifest with slash commands) — https://hermes-agent.nousresearch.com/docs/user-guide/messaging/slack
- [H4] SMS via Twilio (index only) — https://hermes-agent.nousresearch.com/docs/user-guide/messaging/sms
- [H5] ACP (index only) — https://hermes-agent.nousresearch.com/docs/user-guide/features/acp
- [H6] Voice mode, Discord voice channels (index only) — https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode
- [H7] LSP semantic diagnostics (index only) — https://hermes-agent.nousresearch.com/docs/user-guide/features/lsp
- [H8] Code execution (index only) — https://hermes-agent.nousresearch.com/docs/user-guide/features/code-execution
- [H9] WhatsApp via Baileys; WhatsApp Cloud API (index only) — https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp · https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp-cloud
- [H10] Credential pools (index only) — https://hermes-agent.nousresearch.com/docs/user-guide/features/credential-pools
- [H11] Messaging overview (Teams, Google Chat, Mattermost, LINE, WeChat…; index only) — https://hermes-agent.nousresearch.com/docs/user-guide/messaging
- [H12] Mixture of agents; memory providers (index only) — https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents · https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers
- [O0] OpenClaw docs index — https://docs.openclaw.ai/llms.txt
- [O1] Discord voice channels and voice messages — https://docs.openclaw.ai/channels/discord/voice-channels
- [O2] Inbound audio and voice notes (index only) — https://docs.openclaw.ai/nodes/audio
- [O3] Slash commands — https://docs.openclaw.ai/tools/slash-commands
- [O4] Chat channels (Slack, Teams, Google Chat, Mattermost…; index only) — https://docs.openclaw.ai/channels · https://docs.openclaw.ai/channels/slack
- [O5] SMS through Twilio (index only) — https://docs.openclaw.ai/channels/sms
- [O6] ACP agents (index only) — https://docs.openclaw.ai/tools/acp-agents
- [O7] `ask_user` (index only) — https://docs.openclaw.ai/tools/ask-user
- [O8] Matrix encryption and verification — https://docs.openclaw.ai/channels/matrix/encryption
- [O9] Discord voice channels — https://docs.openclaw.ai/channels/discord/voice-channels
- [O10] Show widget and pinned dashboard reports — https://docs.openclaw.ai/tools/show-widget
- [O11] Code Mode (index only) — https://docs.openclaw.ai/tools/code-mode
- [O12] Channel location (index only) — https://docs.openclaw.ai/channels/location
- [O13] Telegram media: albums, voice notes, locations (index only) — https://docs.openclaw.ai/channels/telegram/media
- [O14] Telegram Mini App (index only) — https://docs.openclaw.ai/channels/telegram/mini-app
- [O15] WhatsApp group messages (index only) — https://docs.openclaw.ai/channels/group-messages
- [O16] Model failover (index only) — https://docs.openclaw.ai/concepts/model-failover
- [O17] iOS HealthKit (index only) — https://docs.openclaw.ai/platforms/ios-healthkit
- [O18] Honcho memory (index only) — https://docs.openclaw.ai/concepts/memory-honcho
