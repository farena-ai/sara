# ROADMAP_W (proposal, 2026-11-19): make it solid, make it hers, make it everyone's

ROADMAP_V finished in 3.30.0 (fixes in 3.30.1). Sara now has more features than any other self-hosted
harness. ROADMAP_W is about three things, in this order:

1. **Solid** — what exists works every time, on real models and real devices, in every language.
2. **Hers** — she feels like one person who knows you, not a pile of features.
3. **Everyone's** — anyone can install, run and grow her without help.

Rules as before: free only, every task checks what exists first and improves it, tests first, five
languages, owner checks held to the end. Each wave is 5 builders. Phone-number items stay parked.

## W0 Solid (wave 1): close every known gap

- **W0.1 Real-model qualification, round 2.** Re-run the U1 real-model suite (40 tasks) and add one task
  per V feature (canvas, second opinion, receipts, renewals, interpreter, Bring everything...) on a local
  model and one cloud model; fix what fails. Publish the scores on the benchmark page.
- **W0.2 Every message in six languages.** Server error and status strings that still reach the page in
  English (My apps, checklist "Still to do", D8 "1 points differ", quick-ask bubble) go through t();
  a test fails on any English string returned by an owner route.
- **W0.3 Streaming hearing beyond English.** A multilingual streaming model (free sherpa-onnx), so words
  appear as you speak in es/fr/de/pt/it; interpreter uses it.
- **W0.4 Flake-free suite.** The five tests that fail under load (phase117b email, u4ext, pc-run tree
  kill, business-check, u5-voice-fast) made deterministic; the suite runs twice in a row green.
- **W0.6 She always knows what time it is (bug, first).** Every message she sees carries its exact time
  and "how long ago" (seconds, minutes, hours, days, weeks), computed in code from stored timestamps and
  the owner's time zone, never guessed; the current time is restated each turn; replies that say
  "yesterday" or "earlier today" are checked against the real gap (claim-checker style) and corrected.
  Covers chats, memories, reminders, mail and "since you were away". Owner report 2026-11-19.
- **W0.7 "Always allow" for computer use commands.** Today browser actions have an Always level but
  commands and desktop actions still ask, and some kinds always ask. Add a per-person "Always allow
  everything" override (owner's re-auth to turn on, a clear one-time warning, an off switch on every
  card and in the tray, optional time limit) that lets every command and desktop action run without a
  card. Every action still lands on the Action timeline with its undo, and the override can be turned
  off instantly. Owner request 2026-11-19.
- **W0.5 Mac parity.** Screen companion and Quick ask bubble on the Mac app; Mac voice helper build
  checked on the Ali Mac; the public share and legacy pages get a light theme.

## W1 One Sara (wave 2): she feels like one person

- **W1.1 One memory you can see and steer.** A "What I know about you" page that merges memories, people
  notes, facts, renewals and preferences into one browsable, correctable place, with "forget" and
  "that's wrong" everywhere; duplicates merged; sources shown.
- **W1.2 Proactive but polite.** One daily budget for nudges across all features (briefing, renewals,
  gifts, trimmer, upkeep, workforce...), ranked by value, quiet hours honored, "fewer like this" learns.
- **W1.3 Continuity across devices.** Start on the phone, finish on the PC: the open chat, draft, Talk
  session and canvas follow you; "continue on my phone" card.
- **W1.4 Her own voice and face, steady.** One persona file drives text style, voice, avatar and
  humanizer, so she sounds the same in chat, Talk, email drafts and the receptionist.
- **W1.5 Weekly "how am I doing" with her.** A short review of what she did, what failed, what cost money,
  and three suggestions, with one-tap accept.

## W2 Everyone can run her (wave 3)

- **W2.1 Installer that cannot fail.** One-click installs re-tested on clean Windows 10/11, macOS 13-15,
  Ubuntu/Debian/Fedora/Alma, Docker and Raspberry Pi 5; every failure gets a plain fix-it card.
- **W2.2 First ten minutes.** A guided first run that picks a model by hardware (local GPU, CPU-only,
  free cloud), imports what you have (Bring everything), connects one chat app and shows three wins.
- **W2.3 Hosting for friends.** A "host a Sara for someone" flow on your server: their own space, their
  own keys, you never see their data; uses the household and Shelton patterns.
- **W2.4 Free models first.** A curated, tested list of free/local models per job with expected quality,
  auto-download on request, and a monthly re-check.
- **W2.5 Docs that answer.** Help search over all docs in six languages, short videos generated from the
  live-check scripts, and "show me" on every How do I.

## W3 Builders and business (wave 4)

- **W3.1 Add-on SDK v1.** The npm SDK grows a typed add-on kit (tools, pages, settings, tests) with a
  template generator and a local test harness; marketplace listing from the CLI.
- **W3.2 MCP everywhere.** One-click install of popular free MCP servers with sandboxing and permission
  cards; Sara itself exposed as an MCP server with scoped tokens.
- **W3.3 Team workspace.** Business mode with shared projects, roles, shared inbox, approvals by role,
  audit export; SSO groups map to roles.
- **W3.4 Agent workforce v2.** Workers with goals and KPIs, hand-offs between workers, a weekly plan
  they propose, and budget caps per goal. DONE (2026-11-19, [W3WORKFORCE.md](W3WORKFORCE.md)).
- **W3.5 Receptionist v2.** Multi-language, takes simple payments links you provide, follows up by email
  after your OK, and learns from your corrections.

## W4 Dreams, round 3 (wave 5)

- **W4.1 Life admin autopilot.** One "handle it" button on bills, renewals, returns and forms that runs
  the existing errands end to end, stopping only for your OK and payments.
- **W4.2 Memory lane.** Photos, journal, moments and chats woven into yearly and trip stories she writes
  and narrates, private by default.
- **W4.3 Learning companion.** Study sets, spaced repetition and the interpreter combined into a
  language-learning mode with speaking practice.
- **W4.4 Health coach (private).** Trends from imports plus the log become gentle weekly goals; never
  medical advice; caregiver view optional.
- **W4.5 Household hub.** One family screen (tablet mode): calendar, chores, meals, shopping, reminders
  and a kid-safe Talk.

- **W4.6 Public-records report (personal use only).** Type a name, address, phone, email or username;
  she searches free public sources (search engines, public social profiles, news, court and property
  records sites that are free to view, business registries), cross-checks matches, and writes a cited
  report: every fact with its link and the date it was seen, confidence per match, and "not found"
  stated plainly. Output is a clean PDF with this header on every page: "NOT FCRA COMPLIANT - This
  information can not be used in housing, loan, employment, or other life altering decisions".
  Limits: free sources only (no paid data brokers, no sign-in-only sites, no bypassing site rules),
  no searches about children, every search kept in the owner's audit log, owner only (not members or
  kids). Not a product or service: personal research only. Owner request 2026-11-19.
  The owner can always say "find more sources" and she keeps digging (still never paid brokers). She keeps
  a growing skill of free places to search, per record type and region: each new source that worked is
  added with what it holds and how to search it, sources that failed or went paid are marked, and the
  next report starts from that list.

## W5 Trust and safety, round 2 (wave 6)

- **W5.1 Second security review** of everything added in V (receptionist, My apps, canvas, teach,
  watch tokens, legacy, offline model sync), with attack tests.
- **W5.2 Local-only mode, proven.** A one-switch mode with a test that runs a full day of features and
  shows zero bytes left (privacy ledger as evidence).
- **W5.3 Backups you can carry.** Encrypted export to a USB drive or another Sara, restore drill on a
  second machine, key recovery with a printed sheet.
- **W5.4 Kid mode v2.** Age bands, school-safe content, parent dashboard, time limits, using the
  caregiver consent patterns.
- **W5.5 Explain every action.** Every timeline row gets "why did you do this?" with the message and
  rule that triggered it.

## Parked
- WhatsApp/Signal/SMS live setup, phone calls and receptionist phone line (needs a phone number).
- App Store / TestFlight, Play upload (held by owner).
- Chatlee.ai (no API; terms forbid automation).

## Order
W0.6 (time) and W0.7 (Always allow) first, as owner-reported fixes, then the rest of W0 (solid), then W1, W2, W3, W4, W5, releasing after each wave as before.
