# Roadmap

Sara was built in phases, each one released, tested and documented before the next began. Every
version's details are in the [changelog](../CHANGELOG.md).

## Project continuity and conversational attunement in 2.67.0

Save explicit project checkpoints with current logic, blockers and up to three next steps,
then inspect, replace or clear them. Brief explicit energy/frustration cues and source-aware
follow-up closure improve conversational context; existing privacy, opt-outs and model limits
remain. See [Project continuity](FOR_CODERS.md#project-checkpoints) and [Recent cues and follow-ups](ATTUNEMENT.md).

## Owner-session continuity in 2.68.0

The first slice adds fresh eligible owner-session context, bounded history tools, internal notes,
ordered provider steps and inspect/disable/clear controls. Context stays within the same companion
and eligible owner audience; history and internal handoffs grant no tool permissions or approvals.
Shared multi-person scenes and project coordination are separate future slices.

## Add-ons discovery in existing Settings in 2.69.0

Prepared supplied-data workflow candidates and MCP investigations appear in the existing
Plugins and Other programs pages, with clear prerequisites, permissions, costs and qualification
limits. Local candidates, previews, account requirements and blocked entries stay distinct
from verified signed-store availability. Review, installation and per-companion enablement remain
explicit; nothing is automatically installed, connected or enabled. Image preparation is not image
generation; a supplied home snapshot is not live device control. See [the add-ons library](ADDONS_LIBRARY.md).

## Shared roleplay scenes in 2.70.0

Play one story across your own chats and one shared Discord or Telegram room. Story facts
(canon) are versioned and stay under your control; she can read and save them in your own chats,
and retiring one always asks you. Guests keep every partner rule, and their words become canon
only when you pick a line with Add to scene. See [Shared scenes](SCENES.md).

## Project continuity in 2.71.0

Coding chats on the same project see each other's active work (titles and touched files, never
message text). Check, goal and checkpoint results say whether they are current, stale since a
change, or of unknown basis, and Sara re-runs a stale check before calling it a pass. See
[Project now](FOR_CODERS.md#project-now-other-chats-and-current-checks).

## Honest visual checks in 2.72.0

In web work Sara edits, previews, takes desktop and phone screenshots, fixes what looks wrong and
checks again. Claims about phone width or a finished fix need matching evidence, otherwise the
reply is marked unverified. See [Web pages: look, fix, look again](FOR_CODERS.md#web-pages-look-fix-look-again).

## Watch a file in 2.73.0

Opt-in alerts: pick a log or file in one of your workspaces (or her own log) and a few literal
words; Sara posts a chat card and a notification when a new matching line appears, with strict
rate limits, Check now, Pause and Stop. Reading uses no model and she never fixes anything by
herself. See [Watch a file](WATCHES.md).

## Read together in 2.74.0

Open a text or Markdown document from your library with Sara, share a passage (or let her follow
your place) and she comments on exactly that text at that version. If it changed she says so;
Stop ends sharing at once. See [Read together](LIBRARY.md#read-together).

## Calls work like the chat in 2.75.0

On a voice or video call Sara has the same memories, context and Adult-mode rule as in the chat,
and live calls can use her tools. Anything that needs your OK shows a card on the call screen that
only a tap answers; hanging up or talking over her cancels it. See [Video calls](VIDEO_CALLS.md).

## Developer add-ons in Settings in 2.76.0

Nineteen local-only developer add-ons (API, security, data and code-graph analysis, SQL
rehearsal, visual comparison, localization, structural accessibility checks, staged-cache
inspection and an HTTP/webhook workbench) are signed in the Sara Store and now also appear in
Settings → Plugins beside the twelve workflows. Every public library entry is shown once; account
or cost previews and blocked investigations stay visibly held. Each install stays Off until you
enable it. Watch alerts can also go to your own Telegram or Discord chat (off by default). See
[developer add-ons](DEVELOPER_ADDONS.md) and the [add-ons library](ADDONS_LIBRARY.md).

## A professional new look in 2.77.0

A calm, dense, precise design with nine palettes in Night and Day, your own accent colour,
compact spacing and Reduce decoration (Settings → You → Appearance); Sara Classic keeps the
previous look. Read together can share one item from a news feed you paste. Two developer
add-ons run tests in a disposable copy you approve, and two local developer connections
(Storybook, Qdrant) can be added from Settings. See [Appearance](APPEARANCE.md).

## An advanced look and pictures like a person in 2.79.0

A sidebar that starts with your places, an All settings home with every page one click away,
breadcrumbs, a Ctrl K launcher for everything, a refined glass-and-light look and a richer
Appearance page with new defaults. Approval cards gain *Always allow this tool*, and each tool
server gets one approvals choice. Her photos can come from Grok, OpenAI, your ComfyUI workflow or
another image tool, and she can send a picture on her own now and then (off by default, at most one
a day, monthly limit). Pictures from tool servers now reach the chat, and she no longer says she
sent something that was never attached. See [Appearance](APPEARANCE.md) and [Photos](PHOTOS.md).

## A finished professional look in 2.78.0

Every turn shows who spoke, when and how long she took; one model · workspace chip with a context
meter replaces the separate header controls; Settings opens as a full-height sheet; Projects have
their own sidebar section; usage and runs are real tables. Documentation Doctor, Release Readiness
and Repository Onboarding run documented commands as jobs you approve in a disposable copy (npm
steps need a Linux host with bubblewrap). See [Appearance](APPEARANCE.md) and
[developer add-ons](DEVELOPER_ADDONS.md).

## Notes that never lose what you told her, in 3.4.2

Adding to a note now puts each new thing under a dated heading and never touches what is already there;
a save that would erase a note is refused, and every earlier version is kept with Restore (deleted notes
come back for 30 days). When she says she saved something and didn't, the reply shows it with a button
to make her really save it. The Windows app matches the page's colors at the top, and through the app
she can read your own browser tabs and, with the new Files switch, your Desktop, Documents and Downloads. Long coding
chats stay smooth: in Firefox, button presses answer in about 30 ms instead of 200-330 ms (new Glass blur
setting, calmer background motion, one animated face, drawn once a frame).

## She remembers as much as her model can hold, in 3.4.1

How much of the chat she keeps in mind now follows each model: she looks up its real window (or uses a
dated table of published sizes) instead of a fixed 12,000 tokens, with a cost guard for pay-per-token
services and full use for subscriptions and your own computer. Local Ollama models get a real context
size instead of Ollama's small default, so long local chats keep the thread. Adding a server tries her
own key first and connects at once when it already works.

## Documents, her own name everywhere, and computer use from a server, in 3.4.0

Ask for a Word document, PDF, spreadsheet or slides and she makes the file, with Download, Open and
Make changes, saved in her Library. Rename her and the new name and pronouns show everywhere in all six
languages, with built-in he and they default characters that animate like Sara until you make your own
look. The Sara app for Windows and Mac now connects for computer use to a Sara on a server, says plainly
whether it is connected, and reconnects after sleep. The browser add-on downloads its own browser in one
click, even on Linux servers. A new page lists the few things you may need to do yourself.

## Easy mode, in 3.3.0

Built from a walkthrough with a first-time, non-technical user. Start talking opens a real chat;
setup can't be closed by accident and explains keys. When her AI service, key, credit or mailbox stops
working she says so in plain words with Fix it and Try again. She never promises research she can't do.
Connect the Sara phone app shows a QR code only when the phone can really reach her, and Use Sara away
from home walks through Tailscale and tests it. Gmail starts with the 3-step app password, Check it says
exactly what is wrong, one approval at a time stays in view, search understands everyday words, and you
can ask her to change everyday settings with Undo.

## She comes alive: animated avatar, in 3.2.0

Her portrait now breathes, blinks, glances and moves her lips while she speaks, using her own drawn
mouth and eye frames, and shows listening, thinking, speaking and her mood. It runs in chat, her panel,
Today and calls, on phones too, costs about the same as the orb, and goes still with reduced motion.
Your own picture gets breathing and, after Fit the face, a soft blink and glances. People who have a
3D model can bring a .vrm file (kept in their browser) with blinking, lip-sync and moods.

## Research that keeps going, in 3.1.2

Asking her to research a topic, make a guide or learn something now starts a research run in the
background with a plan you start, live progress, Pause and Resume. She finds pages by searching instead
of guessing addresses, skips sites that block automated readers, retries slow or busy sites, picks up
after a restart, and pauses instead of failing when the model stops answering. A run cut short gives a
report marked Partial, and a finished one can be saved as a skill and kept fresh.

## Moving in from Hermes or OpenClaw, made easy, in 3.1.1

When Hermes Agent or OpenClaw is on the same computer, Sara finds it and brings her over with one
button: personality, memories, what she knew about you, past chats with their dates, skills and
schedules, with a preview first and Undo after. From another computer it is one line to paste (Python
or Node, whichever is there) and Sara's page moves on by itself. Packing is fast and small (seconds,
not minutes), newer OpenClaw versions are read, and running it again only brings what's new.

## Email beyond Gmail in 3.1.0

Outlook.com and Microsoft 365 (mail and calendar), Yahoo, AOL, iCloud, Fastmail, Zoho, GMX, WEB.DE,
Proton Mail (through its Bridge) and any other mail server: she searches, reads whole threads, finds
what needs an answer, drafts and sends replies and organizes, with the same approvals, counts and Undo
as Gmail and never a permanent delete. Several mailboxes at once with one default for Today and the
morning briefing; the Outlook calendar works everywhere Google's does. Each household member can
connect their own mailboxes, private to them. Android: pairing links open the app directly.

## Faster, steadier and easier to find in 3.0.3

Settings opens at once, one search box, and an approval you can always reach (answer it from the bar
above the message box or Ctrl K). Saving her own skills no longer asks first, and a timed-out approval
says so. A red dot marks chats that need you, and her reply says how many new memories she saved.
Adding a phone or computer is easy to find, computer use on your own computer needs no token, and a
model picked during setup stays the default. Store listings for plugins and tool servers are
translated, every store page is refreshed, and the Windows service updates itself.

## Polish, Violet and an easy move-in in 3.0.2

Settings opens as a centered panel, Violet is the default color, and picking a palette resets the color
to that palette's own. Full decoration is clearly richer (edge light, glow, grain) and Today has quiet
motion: cards ease in, lines draw, numbers count up, her orb's glow breathes; all of it off with reduced
motion. Four more relationships that aren't romantic (teammate, tutor, creative partner, gaming buddy),
US spelling in the app's English, and tidy alignment on Today and the message box. Moving in from
another agent is a five-step guide with the exact command for Windows, Mac or Linux, and every install
now includes the collector. New in the gallery: Tess, the practical maker (thanks to @Guilsc).

## Every page in the new look in 3.0.1

Today, Planner, Memory, Library, Scrapbook, Moments, Your story, Team, Findings, Evals and Settings in
the 3.0 look, with her presence orb on Today in place of the large portrait. One project list in the
sidebar: folders that open to show their chats with a status dot each, chat apps like Telegram
included, and a separate button for the project page. Her picture can be the orb, her portrait or your
own picture with a living ring. Run cards under her replies fold to one line (open on their own for an
approval, a problem or a run still going), and the memory line says how many memories she used.
Leaving Sara Classic now switches its rose colour to blue.

## Sara 3.0: a living-system look in 3.0.0

A new look over every page, with nothing removed. A live status strip shows what she is doing now
(workers, runs, triggers armed, the model answering, spend against your limit). Her presence orb
breathes when idle, ripples while listening, swirls while thinking and pulses while speaking. Tool
runs show as a live timeline in her reply, with approvals inside the run and a verified mark only
where a check really passed. A memory map shows what she knows and how it connects. One accent
colour of your choice, her chosen name everywhere, background motion that follows how busy she is
(or none), and Sara Classic unchanged. Android: Hey Sara works on the phone, Google Play's
background-location notice comes before any prompt, and calls work with a server on plain http.

## Coding workspace, Spotify, team pages and Hey Sara everywhere in 2.88.0

Coding tasks can run in their own branch and folder (Merge, Open PR or Discard at the end), with
language-server diagnostics, go-to-definition and references, co-authored commits and a pull-request
helper, and a Workspace view with files, editor, terminal and chat. Spotify connects with your own
developer app (search, now playing, playlists, playback with Premium). Business workspaces get team
pages with history, comments and mentions, and a per-workspace legal hold. Hey Sara now listens on
Mac, Android and Linux with the same offline engine as Windows. Her editor connection was proven with
Zed and the official ACP client.

## Workers, spend control and safer updates in 2.87.0

Bring your companion from Character.AI, Replika, Kindroid or Nomi, with a preview of what comes over.
Prices show before paid steps, with daily and monthly spend limits and a Token Saver mode; add-ons can
update themselves and roll back. Windows and Mac updates are checked against a signed notice and put
the old version back if the new one doesn't start. Workers that stay have their own thread, a job
queue that survives restarts, a failed-jobs list you can replay and one "needs you" alert. Board cards
can wait on a question for you, and a board can be drafted from a description. A new device signing
in from elsewhere waits for a code you approve from a trusted device, Telegram or Discord. She learns
how you like to work (reply length, options or one pick, tone) from evidence, and never anything about
health, religion, politics or sexuality.

## Learn a topic, triggers and tool apps in 2.86.0

Learn a topic: ask her to learn about something, or give her a website; she researches it with
cited sources, keeps what she learned as a skill, and can refresh it daily, weekly or monthly and
tell you what changed. "When this happens" triggers start a job or a crew from an email, a Slack or
Teams message, a webhook or a tool-server event, with caps, budgets and approvals. Her tool
connection speaks MCP 2026-07-28 and shows tool apps in the chat, sealed off from the page. Other
apps can use the Open Responses API (`/v1/responses`), and a single-replica Helm chart is included.
Company sign-in, SCIM, metrics, secret sources, the container sandbox and share links were proven
against the real software (Keycloak, Prometheus and Grafana, OpenBao, Podman).

## Meetings, phone helper and her at work in 2.85.0

Meetings: a room inside Sara where she announces she is an AI taking notes, answers briefly when
named, and writes a summary with decisions and action items (also from an uploaded recording). Your
phone can lend her its camera, location or one screenshot, with a full-screen Allow once or Deny
every time. At work she has her own name, tone, memory and tools in Slack and Teams, with companion
features off. Several chats now get replies at the same time (four by default), household members
can share their own chats, business admins get a spending report, and a legal hold keeps the earlier
text of anything edited.

## Enterprise controls, editors and code mode in 2.84.0

Keys can live in HashiCorp Vault, 1Password, environment variables, mounted secret files or the
system keychain. Zed, JetBrains and other editors that speak the Agent Client Protocol can use Sara
as their coding agent, with approvals inside the editor. Business instances accept SCIM
provisioning from Microsoft Entra ID or Okta; retention, legal hold and per-person export or delete
cover every delete path. A trust report sets what she said against what actually ran, Store entries
show where they were last checked, and a readiness page with a one-click restore drill says whether
an install is ready for real use. Code mode lets her run one short sandboxed script instead of many
tool calls, still through every approval, and a zero-dependency TypeScript SDK covers her API.

## Research, Teams, crews and safer sandboxes in 2.83.0

Research a question: Sara drafts a plan you can edit, lists the pages she read and the ones that
failed, and writes a report in which every sentence cites a page she actually read (PDF, Word or
Markdown, with a 'What is missing' section). Microsoft Teams joins Slack. Crews are standing
helper teams with a lead, schedules and three starter crews; an optional overnight memory tidy
merges duplicates and asks about contradictions, with Undo for every change. Commands and jobs can
run in a rootless Podman or Docker container, sandboxed work can be limited to a list of allowed
sites, conversations can be shared as read-only expiring links, and usage and cost reports cover
every person, workspace and project.

## One-click programs and 21 companions in 2.82.0

When an add-on needs a program the computer lacks (Google Chrome, uv, Node, Python, Blender, ffmpeg),
Settings says what is missing and offers *Install it for me*: you approve the exact command, watch it
run, and the add-on install continues. Twenty-one companions, each with a portrait, a voice and clear
boundaries, are in the signed Store: language tutors, a fitness coach, a chef, a study buddy, a
writing partner, a listener, a budget planner, a music producer, a gardener, a travel planner, a
startup co-founder, a philosopher, a sky-ship captain and more. On Linux, browser tool servers now
find an installed Chrome.

## Ready for work and teams in 2.81.0

Sara joins Slack (direct messages, mentions, threads, Allow and Deny buttons, files both ways).
Business instances can sign in with Microsoft Entra ID, Google Workspace, Okta or Keycloak, with
invitation-only first sign-in and the owner's passkey always kept. One tamper-evident audit trail
records who did what and exports to CSV or JSONL; an admin can pin settings as a policy that the
server enforces; operators can scrape Prometheus metrics and send OpenTelemetry traces that never
carry chat text. The front page has new branded art and current screenshots, and the developer
tool libraries are updated for the latest security advisories.

## Every installer checked end to end in 2.80.0

Every tool server and native add-on in Settings was installed, configured, connected, used and
removed on a real Linux server and a real Windows PC. Fixes: updating a tool server keeps its saved
settings; the Files server can start inside the Linux sandbox; sign-in and connection errors from
tool servers are explained in plain words; a Store add-on removed from its card can be installed
again; retiring a companion right after adding her no longer stops the server.

## Next

How she works with you: Sara notices how you like to work (short answers, one recommendation,
asking first) from your own messages, lets it fade unless she sees it again, never learns anything
about health, religion, politics or sexuality, and tells you once when it changes how she answers.
Built, coming with a later release.

Read-only share links for a conversation (expiring, revocable, scrubbed, never indexed) and usage
and cost reports per person, workspace and project with CSV export and monthly budget warnings are
built and come with the next release.

Expressive speech on calls (laughter and sighs where the voice supports it) follows after
listening tests.

## Coming for work and teams

Planned in this order; each lands as its own release, and anything that costs money stays off until
you switch it on.

- **Sara in Slack**, then Microsoft Teams: DMs, mentions, threads, approvals as buttons and files.
- **Single sign-on** for business workspaces (Microsoft, Google, Okta, Keycloak and other OpenID
  providers), next to passkeys.
- **Policy profiles**: an administrator pins allowed models, network access, tools that always ask and
  add-on sources; nobody can loosen them from the app.
- **One audit trail** of sign-ins, approvals, settings changes and outside effects, with export.
- **Metrics and tracing** for your own monitoring (Prometheus and OpenTelemetry), off by default and
  with no chat text in them.
- **Research runs**: a plan you approve, the sources she read, and a cited report you can export.

After that: a container sandbox so Windows and Mac get real isolation, a network allowlist for her
work, secrets from your password manager or Vault, read-only share links, standing crews of helpers
with their own schedules and budgets, an overnight memory tidy you approve, editor support through
ACP, and usage reports per person and project. Later, as demand shows: directory sync (SCIM),
retention and legal hold, measured scale-out, and voice rooms and meeting notes. In development: a
trust report that puts what she claimed next to what actually ran, and a Qualified badge on every Store
entry saying when and where it last passed a real install.

## Business setup and administration in 2.65.0

Guided first use and mode-specific invitation feedback, safe sibling-tab access refresh, a read-only
local configuration check, scoped recent invitation history/revocation, and repeatable manual
browser/recovery qualification. Existing business authority and separate-instance requirements
remain; configuration evidence is not proof of inference, backup custody or production availability.
See [Business](BUSINESS.md) and [Business installation operations](BUSINESS_OPERATIONS.md).

## Business workspaces in 2.64.0

Optional business mode runs in a separate instance with individual passkeys, explicit workspace
roles, shared text/documents and scoped recovery. The business desk shows audience and model
destination before sharing. Conservative model admission, metadata audit and encrypted generation
recovery preserve access and spending boundaries. Personal/household data stay separate.
Provision business instances through the separate manual source/container workflow; existing
personal installers do not convert them. See [Business](BUSINESS.md) and
[Business installation operations](BUSINESS_OPERATIONS.md). Real installation acceptance and
deployment targets remain separate from synthetic engineering qualification.

## Operations and retention in 2.63.1

Owner-only HTTP/readiness measurements, explicit safe resolved-delivery archival and repeatable
synthetic workload/browser/recovery checks. No background purge or automatic resend; unresolved
records and deduplication identities remain. See [Operations](OPERATIONS.md).

## Recovery improvements in 2.62.0

Durable encrypted job review, explicitly held team recovery and native Telegram/Discord delivery
uncertainty records. Backup/restore and crash fixtures cover interruption boundaries. No automatic
command/message replay; current safety and approval rules remain. See [Recovery](RECOVERY.md).

## Quality improvements in 2.61.5

Focused Settings search with descriptions, page navigation and Back to results; readiness-first
Today with optional setup collapsed before a first reply; visible main-content skip navigation,
larger help targets and reduced-motion tour support. Included in 2.61.5.

## Quality improvements in 2.61.4

First-use recovery after skipped model setup, keyboard navigation in the mobile sidebar, and
clearer reporting of command isolation versus approval prompts. Included in 2.61.4.

## Built

| Phase | What it added | Version |
|---|---|---|
| 1 | Core chat: streaming, conversations, encrypted key vault, providers, the safety layer, Docker and a native installer | 0.1 |
| 2 | Tools and the agent loop: commands, files, git and the web, with approvals, a sandbox and undo | 0.2 |
| 3 | Memory, tasks, reminders and notes | 0.3 |
| 4 | The persona engine: a character sheet, moods and her own life | 0.4 |
| 5 | Voice: speech in and out, local or cloud | 0.5 |
| 6 | Presence: Discord and Telegram, an avatar, an installable app, push, backups | 0.6 |
| 7–9 | Everyday polish, organizer depth, presence | 0.7–0.9 |
| 10 | Make it yours, plus release hardening | 0.10 |
| 11 | Real conversation: a call, not a walkie-talkie | 0.11 |
| 12 | Deeper memory and her life | 0.12 |
| 13 | Coding partner depth | 0.13 |
| 14 | Everywhere: Gmail, Calendar and more through official APIs and MCP | 0.14 |
| 15–16 | A tidy app shell; easy phone sign-in | 0.15–0.16 |
| 17–19 | iPhone and Android apps, polish and store readiness | 0.17–0.19 |
| 20 | Google and GitHub depth | 0.20 |
| 21 | Personalization studio | 0.21 |
| 22 | Find and organize everything | 0.22 |
| 23 | Beginner install and self-care (health checks, repairs) | 0.23 |
| 24 | Security review before 1.0 | 0.24 |
| 26 | Calls both ways: you call her, she calls you | 0.26 |
| 27 | Voice and presence polish | 0.27 |
| 28 | Smarter safety and checks | 0.28 |
| 29 | Home and places | 0.29 |
| 30 | Upkeep: updates, backups, restore drills | 0.30 |
| 31 | More than one companion | 0.31 |
| 32 | "She remembers": memory and continuity | 0.32 |
| 33 | Desktop apps for Windows and macOS | 0.33 |
| 34 | Personality studio: easy, deep, unique | 0.34 |
| 35 | Relationship and intimacy tuning (adults only, with model-enforced limits) | 0.35 |
| 36 | Avatar studio | 0.36 |
| 37 | Her voice and her life | 0.37 |
| 38 | The right model for each job | 0.38 |
| 39 | Sara leads a team of helper agents | 0.39 |
| 40 | Coding workflows: issues, pull requests, reviews | 0.40 |
| 41 | Help everywhere: a ? tip on every setting, guided tours | 0.41 |
| 42 | License and polish | 0.42 |
| 43 | Remote work from Discord and Telegram | 0.43 |
| 44 | Her library: your documents become her memory | 0.44 |
| 45 | Release candidate: code and installers checked end to end | 0.45 |
| 46 | Run Sara's server on Windows and macOS | 0.46 |
| 47 | Working with other bots on Discord, with loop limits | 0.47 |
| 48 | OpenAI live voice, next to Grok | 0.48 |
| 49 | Live preview and testing in a browser | 0.49 |
| 50 | She knows your code: a codebase map and recipes | 0.50 |
| 51 | Bring your ChatGPT or Claude history; the character gallery; a work-mode personality | 0.51 |
| 52 | Terminal client, VS Code extension, cost tracking, project starters | 0.52 |
| 53 | Your story, and the app in six languages | 0.53 |
| 54 | Benchmarks, an extending guide and contributor docs | 0.54 |
| 55 | Desktop apps that connect to a Sara elsewhere | 0.55 |
| 56 | Model lists that stay current by themselves | 0.56 |
| 57 | Plug in anywhere: an OpenAI-compatible API, an MCP server, character cards, Home Assistant, install packages | 0.57 |
| 58 | 1.0: the public release, installers and the Docker image | 1.0 |

## Since 1.0

| Phase | What it added | Version |
|---|---|---|
| 59 | Install anywhere: Homebrew, winget, HACS, Unraid, CasaOS, Umbrel, TrueNAS, Proxmox; first sign-in in the browser; a Docker image for ARM | 1.1 |
| 61 | Fully in your language: the help guide and every server message in all six languages | 1.2 |
| 62 | Smarter checks in every language, and a bigger coding benchmark on real-size projects | 1.3 |
| 63 | Smoothness: tool calls that stream as they happen, a more expressive talking portrait, server logs | 1.4 |
| 65 | Bring her from another app: import chats and characters from other companion apps | 1.5 |
| 66 | Group chats with two or more of your companions | 1.6 |
| 67 | A private local mode in the desktop apps: the model runs on that computer, nothing leaves it | 1.7 |
| 68 | Several servers in one app: the desktop, phone and other apps switch between your Saras without signing out | 1.8 |
| 69 | Video calls with her moving avatar | 1.9 |
| 70 | Our moments: a shared photo album with her captions | 1.10 |
| 71 | Household mode: several people on one server, each with their own companions | 2.0 |
| 72 | Her voice in the home: Alexa, Android's assistant and Google Home, Siri Shortcuts, smart-home presence | 2.1 |
| 73 | Work on your other servers over SSH: password or key; after a password login she makes and uses her own key and keeps the password only if you insist | 2.2 |
| 74 | Big documents: 500–1,000-page PDFs and books in her library, every scanned page read, answers with page numbers | 2.3 |
| 75 | The new look: her work and results on screen, a presence panel, Today as tiles, dark by default; the same on phones; Windows and Mac apps with native glass, a quick-ask window and richer tray menus | 2.5–2.8 |
| 76 | Ranked memory: each note she uses says why it came to mind and how sure that is; old notes fade unless used or pinned | 2.9 |
| 77 | Contradiction check: before she acts, a planned step that goes against something you decided stops and asks | 2.10 |
| 78 | Run snapshots: every step of her work recorded (prompt, tools, files, memory, cost) | 2.11 |
| 79 | Hard cost budgets per task, with a graceful slow-down instead of a surprise bill | 2.12 |
| 80 | Sandbox gate: her code runs in a throwaway copy before it touches your workspace | 2.13 |
| 81 | Security pass: code checks, secret scan and live dependency advisories, with a fix branch for each finding | 2.14 |
| 82 | Threat-model second pass: a dedicated pass that fixes the risky spots it finds in her new code | 2.15 |
| 83 | Time-travel: rewind a run to any step, change one thing, branch | 2.16 |
| 84 | Eval loop: define "done", rerun her, see which prompt, tools or memory setting won, with evidence | 2.17 |
| 85 | Active recall: she brings up what worked last time when a task looks like an earlier one | 2.18 |
| 86 | Red-team mode: before shipping, she tries to break her own app inside the sandbox and fixes what broke | 2.19 |
| 87 | Computer use 1: her own browser on your computer (through the desktop app): look, read, console logs, live view | 2.20 |
| 88 | Computer use 2: she clicks and types in it, with approvals (or *Always allowed*), a Stop button and takeover | 2.21 |
| 89 | Computer use 3: debug your web project in it (your dev server, hot reload) | 2.22 |
| 90 | Computer use 4: saved logins, only when you say so, encrypted on your computer | 2.23 |
| 91 | Computer use 5: use your password manager (Bitwarden, 1Password, KeePassXC…) to fill logins | 2.24 |
| 92 | Computer use 6: she sees your desktop (screenshots and the accessibility tree) | 2.25 |
| 93 | Computer use 7: she uses your mouse and keyboard | 2.26 |
| 94 | Computer use 8: guided "tune up my computer" tasks | 2.27 |
| 95 | Computer use 9: the same on Linux desktops (browser mode) | 2.28 |
| 96 | Skills in the open Agent Skills format (recipes become skills; import and export) | 2.29 |
| 97 | Skills she learns: notices what you ask again and again and offers to make it a skill | 2.30 |
| 98 | Plugins and hooks: installable, each with only the permissions it asks for | 2.31 |
| 99 | Kanban board: hand her a card and she works it in the background | 2.32 |
| 100 | A2A: talk to other agents (and let listed agents talk to her) | 2.33 |
| 101 | People: a card for each person in your life, used by her memory | 2.34 |
| 102 | Webhooks: any service can start a task or tell her something | 2.35 |
| 103 | Her own agenda (opt-in): goals and follow-ups she keeps with you | 2.36 |
| 104 | Move in from another agent 1: Hermes Agent and OpenClaw (personality, memories, profile, history, skills, schedules), preview and Undo | 2.37 |
| 105 | Move in 2: custom memory stores (SQLite, Postgres): she proposes how tables map, you confirm | 2.38 |
| 106 | Move in 3: settings, channels and custom hooks translated (never run), with a full report of what came over | 2.39 |
| 107 | Chat commands everywhere: /new, /reset, /stop, /status, /help in Telegram, Discord and later channels | 2.40 |
| 108 | A tidy session list: a project per channel (Telegram, Discord…), and *See more* in long projects | 2.41 |
| 109 | Session titles that improve as the conversation goes on (your own titles stay) | 2.42 |
| 110 | She keeps up with the room: in Discord channels and Telegram groups she follows the whole conversation (opt-in per channel), so she joins what's happening now, not an hour-old topic, remembers the room and its people over time, and keeps older weeks as a searchable archive in her Library | 2.43 |
| 111 | Today, rethought: a designed layout (your day, needs you, with her, work), tiles you can arrange, a Mail tile that shows what changed | 2.44 |
| 112 | Today on phones: one column in priority order, swipe rows, pull to refresh | 2.45 |
| 113 | Report a problem or suggest something from inside Sara, no GitHub account needed (with an anonymous install count you can switch off) | 2.46 |
| 114 | The polish pass: clearer personality dials with examples, better guidance on every page, visual consistency, a beginner path and a coder path | 2.47 |
| 115 | Chat apps catch up: photos and files both ways, a live progress message | 2.48 |
| 116 | Talk to her while she works (steer, queue, /btw) and a loop guard | 2.49 |
| 117 | Signal and email | 2.50 |
| 118 | Keep going until it's done, and repeating loops | 2.51 |
| 119 | "When it comes up" reminders; pick up a chat in another app | 2.52 |
| 120 | Coding precision: language-server checks after edits, @-references | 2.53 |
| 121 | Beginner setup: a routines gallery and a one-click safety check-up | 2.54 |

## Coming next

In build order; one release per phase. The computer use track is complete (2.20–2.28); the agent staples are complete (2.29–2.36); moving in from other agents is complete (2.37–2.39); chats and sessions are complete (2.40–2.43); Today, rethought, is out (2.44–2.45); reporting a problem from inside Sara (2.46) and the polish pass (2.47) are out; chat apps caught up (2.48) and you can talk to her while she works (2.49), Signal and email (2.50), keep going until it's done (2.51), "when it comes up" reminders (2.52), coding precision (2.53), routines and a safety check-up (2.54), WhatsApp, Matrix and iMessage (2.55); SMS waits for its provider; a lean tool list and `/compact` (2.56), the Sara Store (2.57–2.58), "Hey Sara" on Windows (2.59), companion packs (2.60); next, a second polish pass over everything since 2.47.

| Phase | Plan | Version |
|---|---|---|
| 60 | Phones: locked-screen calls on iPhone (CallKit), one-tap pairing on iPhone, the iPhone app in the App Store (when Apple approves it) | after Apple's approval |
| 64 | Be found: app stores, NAS catalogs, Home Assistant's store and directories | ongoing |
| 122 | WhatsApp (official API), iMessage via BlueBubbles, SMS via AgentText, Matrix | 2.55 |
| 123 | Big tool sets: a lean tool list, /compact | 2.56 |
| 124 | The Sara Store: plugins, skills and MCP servers (ComfyUI, Blender, Playwright…) at backstagecoding.com/sara/store | 2.57 |
| 125 | One-click installs from Settings, and submit your own plugins and MCP entries | 2.58 |
| 126 | "Hey Sara" on desktop and Android | 2.59 |
| 127 | Companion packs to share | 2.60 |
| 128 | A second polish pass | 2.61 |
| V1 | A professional new look: palettes (Graphite, Midnight, Slate, Nord, Solarized, Paper, Ember, High contrast, Sara Classic) in Night and Day, your own accent colour, compact layout | next |
| C5 | Open Responses (`/v1/responses`) for apps on the Responses API, and a single-replica Helm chart for Kubernetes | next |
| C7 | Bring your companion from Character.AI, Replika, Kindroid or Nomi: her character, memories and chats | next |

Ideas and requests are welcome in [Discussions](https://github.com/farena-ai/sara/discussions)
and [issues](https://github.com/farena-ai/sara/issues). See [CONTRIBUTING.md](../CONTRIBUTING.md).
