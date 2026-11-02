# iMessage, SMS and Matrix as chat apps: BlueBubbles, AgentText and a Matrix bot (design, Phase 122 part 2, versions 2.55.1–2.55.3)

Status: design study, 2026-11-02. Nothing here is built. It is a read-only study of the code at
2.54.0 plus the WhatsApp work in progress on `main`'s working tree (`src/webhooks.ts`,
`src/webhook-verify.ts`, `src/plugins/manager.ts`, `manifest.ts`, `bridge-db.ts` are being edited
for docs/design/WHATSAPP.md while this was written), and of the official BlueBubbles, AgentText,
Matrix, Twilio and Apple documents listed in §17. It is a ground-up design: no code, schema,
protocol detail or wording is taken from Hermes Agent, OpenClaw or any other agent, and no code from
BlueBubbles' own clients, matrix-js-sdk, matrix-bot-sdk, the AgentText SDK or its MCP server. Zero new
npm runtime dependencies. All three are **first-party plugins** (`plugins/imessage`, `plugins/sms`,
`plugins/matrix`), like Signal, email and WhatsApp; the only core code is what the plugin contract,
the webhook layer and the socket broker need to carry them.

**Why a new file.** docs/design/BRIDGES3.md is the Phase 117 design (Signal and email, built in
2.50.0 with its *As built* notes) and docs/design/WHATSAPP.md is Phase 122 part 1. This document is
**Phase 122 part 2**: everything the ROADMAP line lists beyond WhatsApp. WHATSAPP.md said so in its
opening ("iMessage …, SMS through AgentText, Matrix get their own design; they reuse the same building
blocks").

**The owner's words.** 2026-10-31, approving the gap review: "We can have Whatsapp as an option for
people, iMessage maybe bluebubbles and/or agenttext (https://www.agenttext.dev/) integrated?" The
ROADMAP line he approved (docs/ROADMAP.md, Phase 122):

- *Phase 122 (2.55.0):* "More chat apps: **WhatsApp** (…), **iMessage through BlueBubbles** (the user's
  own Mac running the BlueBubbles server; REST + webhooks) and through the Sara Mac app where possible,
  **SMS through AgentText** (agenttext.dev, the user's own account and key; paid past its free tier, so
  it's off until they add it), and Matrix. Each a first-party plugin bridge with the same rules as
  Telegram/Discord (owner, partners, rooms, commands, keep-up where the platform allows) (#3 part 2)."

And DECISIONS.md (2026-10-31): "AgentText and other paid services stay off until the user adds their
own account." **Twilio is not in the ROADMAP line**; it is covered in §2.8 only as the common
alternative and the reason AgentText was picked, and it is not built (§14 Q12).

**The brief (from the parent, on the owner's behalf):** "Read the repo before you design anything. Do
not invent a parallel architecture." Reuse WhatsApp's new pieces: the webhook `bridge` delivery mode
and verify kinds, the socket broker for plugins, the public `/hook/` door, and the setup card with
plain-language diagnostics. He called the old SSH setup "a brick wall" (SSH_EASY.md), so **each app
gets a guided, step-by-step card that names the exact screens and explains every failure in plain
words**. Research BlueBubbles (the server on a Mac, REST, webhooks and its socket, password auth, the
Private API and its SIP-off risks, and what happens with no Mac), AgentText (API, HMAC webhooks,
numbers, compliance, pricing), Twilio's A2P 10DLC burden, and Matrix (client-server API, bot login
with an access token, E2EE, sync long-poll, media).

**Goal:** the owner texts her from **Messages on his iPhone** (blue bubbles, to her own Apple ID), from
**any phone by SMS** (to her own US number), or from **Element** (to her own Matrix account), the way he
does on Telegram: words, photos where the app carries them, `/new`, "use pnpm" while she works,
`/stop`. Each takes a beginner 10–40 minutes with the card open, costs nothing except AgentText's
texts past its credit, adds no way for a stranger to reach her tools, and is off until he installs it.

**The rule of this track: build on what is there.** Every app is a plugin bridge on contract v1.2, so
every turn goes through `#bridgeInbound` → `#bridgeTake` → `#bridgeTurn` (`src/plugins/manager.ts`)
and so through the CH1 commands, the CH2 channel project ("iMessage", "SMS" and "Matrix" are already
in `PLUGIN_NAMES`, `src/bridges/rooms.ts`), BR1 media, BR2's one queue, P4 link codes, P5 the edit
budget, P6 long turns, and the safety layer, unchanged. Outgoing calls use **the socket broker** (P1)
and WhatsApp's **HTTP/1.1 client in the plugin** (WHATSAPP §3.1 W3). Incoming messages arrive through
what each platform does best, and **none of the three needs the public door by default**:

| App | How her messages arrive | Needs a public address? |
|---|---|---|
| iMessage (BlueBubbles) | a *doorbell* webhook from BlueBubbles to Sara over his own network, then Sara fetches the message from BlueBubbles' REST API; polling when the doorbell can't reach Sara | **No** (Mac and Sara on one computer, one home network or one tailnet) |
| SMS (AgentText) | AgentText's long-poll `wait` endpoint over the broker; signed webhooks (`standard` kind) later, if he wants them | **No** (yes only for the optional webhook) |
| Matrix | the client-server `/sync` long-poll over the broker | **No** |

> **Read this first: the three sets of terms.**
> - **Apple.** iMessage has no API for bots. BlueBubbles drives the Messages app on a Mac through
>   AppleScript and reads its database; it says it is "in no way affiliated with or endorsed by Apple"
>   and that Apple disabled its developer account [B1, B5]. Apple's macOS licence allows macOS only on
>   Apple-branded computers (VMs only on a Mac, for personal non-commercial use) and forbids using the
>   software "to spam, defraud, harass …" [A1]. Sara therefore supports **only the owner's own Mac**,
>   recommends **a separate Apple ID for her**, never asks him to switch off System Integrity
>   Protection (§2.3), and never offers Hackintosh or Docker-OSX routes in the guide (§14 Q2, Q3).
> - **AgentText.** Its site claims "A2P compliance handled" and "We handle carrier registration and
>   A2P 10DLC compliance on your behalf" [G1], but publishes **no terms of service, no privacy policy
>   and no webhook documentation** (the `/terms` and `/privacy` pages answer 404), and on 2026-11-02
>   the documented API host answered **"Application not found"** to every request [G2]. SMS through
>   AgentText is therefore designed in full but **gated**: it ships only when the owner's own test
>   (§12) passes and he answers §14 Q1.
> - **Matrix.** An open protocol with no platform terms of its own; the homeserver's terms apply (for
>   matrix.org, its Terms of Service and Code of Conduct, not re-read here; §17 [M9]). An own
>   homeserver avoids them.

> **A correction to the brief.** The parent's context says AgentText's free tier has "5 inboxes plus
> 2,000 texts a month". AgentText's own pricing says otherwise [G1, G3]: **free = $5 credit, 1 inbox,
> ~100 texts, $0.05 a text after the credit; a number costs $1.15 of that credit**; *Builder* is **$29 a
> month** for 5 inboxes and 2,000 texts ($0.03 over); *Scale* $149 a month for 25 inboxes and 15,000
> texts. This design uses AgentText's figures and shows them on the card (§5.11).

Contents: 1 what exists today · 2 platform facts · 3 the shape and shared building blocks · 4 IM
iMessage through BlueBubbles (and the Sara Mac app) · 5 TX SMS through AgentText · 6 MX Matrix · 7
the guided setup cards and plain-language diagnostics · 8 tables, routes, UI at 1440 and 390, ? tips ·
9 security, safety, household, terms boxes · 10 reuse vs build · 11 done when (`test/phase122b.test.ts`,
`phase122c`, `phase122d`) · 12 owner to-dos · 13 risks · 14 blocking questions with defaults · 15 order
and release split · 16 key choices · 17 sources.

---

## 1. What exists today (mapped from the code)

| Piece | Where | What it does today | Matters here because |
|---|---|---|---|
| Plugin bridges v1.2 | `src/plugins/manager.ts`: `#bridgeInbound`, `#bridgeTake`, `#bridgeTurn`, `bridge.who`, `bridge.file`, `bridge.send {ref, files, replyTo, thread}`, `bridge.sent`, `bridge.status`, `bridge.typing`, `bridge.react`, `bridge.log`, `bridge.skip`; `ready.bridge {places, typing, react, log, threads, oneMessage, edit, editLimit, editEveryMs, textMax, ack, link}` | Signal and email run on it (BRIDGES3 *As built*). | All three apps are one more v1.2 plugin each. Matrix uses nearly every field; iMessage uses them **depending on the Private API**; SMS uses the fewest. |
| WhatsApp pieces (being built for 2.55.0) | WHATSAPP §3.1: W1 bridge hooks (`owner_plugin`, mode `bridge`, `ensureBridgeHook`, kind `meta` + GET handshake, `200` answers, no bodies in the log), W2 the door, W3 `http1.mjs`, W4 the reply window (`bridge_windows`), W5 reply buttons, W6 `diagnose()` + the stepper `web/setup-steps.js` | In the working tree today: `VERIFY_KINDS` has `meta`; `ensureBridgeHook(plugin, companion, appSecret)` always makes a `meta` hook; `BRIDGE_LIMITS`; `owner_plugin` in `EXTRA_COLUMNS`. | This design **grows** W1 (two more kinds for bridge hooks, §3.1 B1), **copies** W3, **reuses** W6 and the stepper, and does **not** need W2, W4 or W5 (no app here has a reply window or reply buttons). |
| Socket broker (P1) | `src/plugins/net.ts` (`addressAllowed`, `isLoopbackAddress`, `isHomeNetworkAddress`; `where: local \| public`, `tls: none \| required`, the `onOtherMachine` switch, pinning, caps, private local mode) | `local` = loopback, or RFC 1918 / IPv6 ULA with the switch; `public` = public only (`isPrivateAddress` from `tools/builtin.ts`). | BlueBubbles runs on **his Mac**: loopback when Sara runs on the same Mac, the home network otherwise, and often **his tailnet** (100.64.0.0/10, `fd7a:115c:a1e0::/48`), which today is neither "home" nor "public" and is refused (§3.1 B3). A self-hosted Matrix homeserver is the same case. |
| Webhooks (ST7) | `src/webhooks.ts`, `src/webhook-verify.ts` (`github`, `stripe`, `standard`, `header`, `url`, `meta`; `weakKind` = `url`/`header`), route `POST /hook/<id>.<secret>` | `standard` = Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`, 300 s), the format Svix uses. `url` = the URL secret only. | AgentText says its webhooks have "Svix-compatible headers" [G1] → `standard`. BlueBubbles' webhooks are **unsigned** [B3] → `url`, which is why Sara treats them as a doorbell only (§3.1 B2). |
| Reaching her | `src/platform.ts` `accessInfo()` (`local \| tailscale \| domain \| lan`), `deploy/lib-access.sh`, `src/tailscale.ts` | How phones and browsers reach Sara. | BlueBubbles must reach Sara for the doorbell: same computer (`local`), home network (`lan`), tailnet (`tailscale`), or her domain. The card works out which (§7.1). |
| The Sara Mac app | `desktop/mac/Sources/*.swift` (~7,300 lines): `Server.swift` runs the Sara server on the Mac; `Hands*.swift` (Phases 87–95) holds a WebSocket to `/api/hands` and asks for Accessibility and Screen Recording | Entitlements: audio input and camera only; no Full Disk Access, no Automation (Apple Events) for Messages. Mac DMGs for 2.50.0–2.54.0 wait for the Mac build machine (SOURCE_OF_TRUTH). | "Through the Sara Mac app where possible" (ROADMAP): the app could read Messages' database and send through AppleScript itself (§4.13). Not in this part: it needs new macOS permissions, a Mac build, and an owner decision (§14 Q4). |
| Commands (CH1), one queue (BR2), `/goal`, `/loop`, `/when`, `/continue` | `src/bridges/commands.ts`, `src/pending.ts`, `src/btw.ts`, `src/pickup.ts` | Typed commands on every bridge; steer at the safe point; `/btw`. | Unchanged. SMS has one trap: **a lone `STOP` is a carrier opt-out**, so SMS never treats it as `/stop` (§5.9). |
| Progress (BR1, P5) | `src/bridges/progress.ts` (`ProgressMessage`, `editLimit`, `editEveryMs`) | One edited message, with an edit budget. | Matrix edits freely; iMessage allows 5 edits within 15 minutes and only with the Private API [A3, B2]; SMS can't edit (and each message costs). |
| Partners and safety | `src/safety.ts` (`partnerNote`, `disclosureDue`, `minorSexualMatch`, `MINOR_BLOCK_REPLY`), `meta.untrusted` (Phase 117) | | Unchanged on every new path; SMS turns are **untrusted by default** because caller ID can be faked (§5.4). |
| Vault | `src/vault.ts`; `plugin:<id>:<key>` for `secret` settings; `webhook:<id>` for hook secrets | | BlueBubbles password, AgentText key, Matrix access token. The Matrix password is never stored (§6.2). |
| Tables | `src/plugins/bridge-db.ts`: `bridge_threads`, `bridge_identities`, `bridge_skips` (+ `bridge_windows` for WhatsApp) | | Reused. One new table: `bridge_spend` (SMS costs, §8.1). |
| Private local mode, network guard | `src/private-local.ts`, `src/net-guard.ts` | Nothing leaves the computer. | AgentText and a public Matrix homeserver pause. **iMessage on the same Mac keeps working** only if it never leaves the computer: it does leave (Apple's servers carry iMessages), so it pauses too (§9.5). |
| Hub ping | `src/hub.ts` `BRIDGE_IDS` (`plugin_bridge`) | | No change (§14 Q15). |

What does **not** exist: any iMessage, SMS or Matrix code; a bridge hook of another kind than `meta`;
a rule that a webhook may only *wake* a plugin (the doorbell); tailnet addresses in the broker; a
long-poll reader in any plugin; a notion of money per message in a chat bridge; any check that a
platform's "STOP" word must never reach the command parser.

---

## 2. Platform facts (from the official documentation, read 2026-11-02)

### 2.1 BlueBubbles: a server app on his Mac [B1, B4, B5]

- **What it is.** BlueBubbles Server is an open-source macOS app (TypeScript, Apache-2.0 tools) that
  turns a Mac signed in to iMessage into a server: it "uses AppleScript to perform simple functions
  like sending messages & attachments and creating chats, and polls the `chat.db` database to see when
  new messages come in" [B1]. It runs on "any macOS device running Sierra and newer, with iMessage
  activated successfully" and "cannot run as an ordinary Linux or Windows container" [B1].
- **Install** (Manual Setup [B4]): download the `.dmg` from GitHub Releases, right-click → **Open**
  (the app is **unsigned**: "Apple disabled our Developer Account with no further explanation"), drag
  to Applications, then the welcome screens: **Intro** → **Permissions** (Full Disk Access is needed;
  Accessibility "is not required") → **Notifications** (the *Manual Setup* tab avoids Google, but asks
  for two Firebase files; §7.1 shows how Sara's card skips this) → **Connection**: "Set a strong server
  password, and make sure to use the floppy disk icon to save it", and a proxy choice (Cloudflare,
  zrok, Ngrok, or *Dynamic DNS / Custom URL*) [B4].
- **Its port.** The local web server listens on **1234** by default [B6].
- **Staying up.** Its guides cover preventing the Mac from sleeping and restarting the app after a
  crash [B1 index]; Sara's card links to both (§7.1 step 2).

### 2.2 BlueBubbles' REST API, webhooks and socket [B2, B3, B7]

- **Auth.** "Simply add the query parameter `guid` (aliases include `password` & `token`) to the end of
  the request URL, with the server password as the value", e.g. `/api/v1/ping?guid=password` [B2]. The
  password is the only credential, and it travels **in the URL** (§9.1).
- **Responses** are `{status, message, data}` or `{status, message, error: {type, error}}` [B2].
- **Routes Sara uses** (from the server's route table [B7]; the Postman collection is the reference):

| Need | Route | Private API? |
|---|---|---|
| Is it up, which version, Private API on? | `GET /api/v1/ping`, `GET /api/v1/server/info` | no |
| Which Apple ID is signed in | `GET /api/v1/icloud/account` (the `account` route under the iCloud group) | no |
| New messages since a time (catch-up, polling) | `POST /api/v1/message/query` (`after`, `with: [chat, handle, attachment]`, `sort`, `limit`) | no |
| One message by id (the doorbell check, §3.1 B2) | `GET /api/v1/message/:guid?with=chat,handle,attachment` | no |
| Send text | `POST /api/v1/message/text {chatGuid, tempGuid, message, method}`; `method` defaults to `apple-script`, which **requires** `tempGuid` and `message` [B8] | no |
| Send a reply to a message (`selectedMessageGuid`), a subject, an effect | same route; any of these forces `method: private-api` [B8] | **yes** |
| Send a file | `POST /api/v1/message/attachment` (multipart: `chatGuid`, `tempGuid`, `name`, the file; `isAudioMessage`) [B8] | no |
| Download a file | `GET /api/v1/attachment/:guid/download` | no |
| Typing on / off | `POST` / `DELETE /api/v1/chat/:guid/typing` | **yes** |
| Tapback | `POST /api/v1/message/react {chatGuid, selectedMessageGuid, reaction}` | **yes** |
| Edit / unsend | `POST /api/v1/message/:guid/edit {editedMessage, backwardsCompatibilityMessage, partIndex}`, `…/unsend` | **yes** (macOS 13+) |
| Mark read | `POST /api/v1/chat/:guid/read` | **yes** [B9] |
| Make / remove webhooks | `GET`, `POST`, `DELETE /api/v1/webhook` | no |

- **Webhooks** (server 1.0.0+): events for new messages, message updates (delivered, read), message
  errors, group name changes, participants, read status, typing indicators, server updates, URL
  changes and a *Hello World* test, or `*` for all [B3]. The event names are `new-message`,
  `updated-message`, `message-send-error`, `typing-indicator`, `hello-world`, … [B10]. A webhook is a
  plain `POST` with `Content-Type: application/json` and a `{type, data}` body: **no signature, no
  secret header, and no retries** (the server fires and doesn't wait: "We don't need to await this";
  15 s timeout) [B11]. Webhooks can be added in the app (*API & Webhooks → Manage → Add Webhook*) [B3]
  **or through the REST API** (`POST /api/v1/webhook {url, events}`), which is what Sara's card uses.
- **Socket.IO.** Its own clients get live events over Socket.IO. Speaking Socket.IO from scratch
  (Engine.IO framing, polling upgrade, pings) is several hundred lines for what the doorbell plus REST
  already give; Sara doesn't use it (§14 Q6).
- **Proxies.** The docs warn the REST API in a *browser* needs a proxy with a valid certificate; "in a
  non-browser environment, it should work as expected" [B2]. Sara is not a browser, so plain HTTP on
  the same Mac, the home network or the tailnet works.

### 2.3 The Private API, System Integrity Protection and its risks [B9, B12]

- The Private API is a **helper bundle injected into Messages** that calls Apple's private IMCore
  functions. It adds: reactions, typing indicators (send and receive), mark read/unread, replies,
  effects, subjects, mentions, **edits and unsend (macOS 13+)**, group management, and more [B9].
- **It needs System Integrity Protection off.** "In order to get Private API features, you must disable
  MacOS extra security measures, called System Integrity Protection (SIP) … In a way, disabling SIP is
  similar to Jailbreaking your iPhone." The steps: `sudo defaults write
  /Library/Preferences/com.apple.security.libraryvalidation.plist DisableLibraryValidation -bool true`,
  then Recovery Mode → Terminal → `csrutil disable`, restart, then the Private API switch [B12].
- **The risks, in its own words:** "Disable SIP at your own risk! We are not responsible for any
  damages, issues, or glitches"; "Disabling SIP on an Apple Silicon Mac disables the ability to install
  and run *iOS Apps* on your Mac"; tested on macOS 10.13–13 only ("It could work on higher … but we do
  not know for sure") [B9, B12]. SIP off also turns off library validation for the whole Mac, so any
  malware that gets in can do more.
- **Is it needed for Sara?** **No.** Without it, Sara can receive messages, send text and files, and
  answer. What is lost: typing dots, tapbacks (the BR2 👀), edited progress, quoted replies, read
  marks. Sara's iMessage plugin works in **basic mode** by default and **uses the Private API only if
  BlueBubbles reports it on** (`server/info`); the card never tells him to switch off SIP and shows
  the risks above if he asks (§4.7, §14 Q3).

### 2.4 With no Mac [B1, B13, A1]

BlueBubbles needs macOS with iMessage activated. Without a Mac the documented routes are a macOS
virtual machine or Docker-OSX on a Linux host, which need "spoofing your hardware to seem like a real
Mac" [B1, B13]. Apple's licence allows macOS **only on Apple-branded computers**, and VMs only "on each
Apple-branded computer you own or control that is already running the Apple Software" [A1]. So: **no
Mac, no iMessage in Sara.** The iMessage card says so in its first line and points to SMS (§5) or
Telegram/Signal instead. A cheap used Mac mini that stays on is the honest answer and the card says
that too. (A Mac VM *on a Mac* is allowed by the licence; the guide doesn't cover it.)

### 2.5 Apple's terms [A1, A2]

- macOS licence: one copy "on a single Apple-branded computer"; no running it "on any non-Apple-branded
  computer"; the virtualised copies may not be used "in connection with service bureau, time-sharing,
  terminal sharing, relay service or other similar types of services"; and "You further agree not to
  use the Apple Software and Services in any manner to spam, defraud, harass, abuse …" [A1].
- Apple publishes no iMessage bot API; *Messages for Business* is Apple's official channel for
  companies and needs a registered messaging service provider [A2]; it is not for a person's own
  companion and not designed here.
- **Sara's reading:** a person using **his own Mac** to let **his own companion** answer **him and
  people he chose** is personal use; it is not a relay service for others. The risks are Apple's
  discretion over an Apple ID (a new Apple ID that sends many messages can be flagged) and
  BlueBubbles' unofficial status. Hence: her own Apple ID, owner-first, no first messages to anyone
  but him, low pace (§4.10), and the terms box (§9.6).

### 2.6 AgentText: the API [G1, G2, G4]

- **What it is.** "Text messaging inboxes for AI agents": each **inbox** is "a real US phone number
  provisioned on demand", with a REST API, an MCP server (`npx agenttext-mcp`) and TypeScript/Python
  SDKs [G1, G2]. Built by *shoperators* [G1].
- **Base URL** (documented): `https://agenttext-api-production.up.railway.app/v0` [G2].
- **Auth:** `Authorization: Bearer atx_live_…` on every request "except signup and webhooks"; the key
  "is returned once at signup. It cannot be retrieved again" [G2].
- **Endpoints** [G2]: `POST /v0/signup {name, email}` → key and `$5.00` credit; `POST|GET /v0/inboxes`,
  `GET|PATCH|DELETE /v0/inboxes/:id` ("Delete inbox (release number)"); `POST /v0/inboxes/:id/messages
  {to, body, labels?}` → `201 {message_id, conversation_id, direction, from_number, to_number, body,
  status: "queued", segments, created_at}`; `GET /v0/inboxes/:id/messages` (`?direction=inbound`,
  `?category=`, `?label=unread`, `?limit=`); `GET /v0/inboxes/:id/conversations`, `GET
  /v0/conversations/:id`, `POST /v0/conversations/:id/reply`; **`POST /v0/inboxes/:id/wait {timeout
  (default 60), category?, since?}`** → `200 {message}` or `408 {error: "timeout"}`; billing through
  Stripe Checkout (`POST /v0/billing/checkout {plan: "builder" | "scale"}`).
- **Inbound messages** are parsed: `category` (e.g. `otp`), `otp_code`, `sender_name`, `links`,
  **`opt_out_detected`**, `labels: ["unread"]`, `segments` [G2].
- **Errors:** `401 auth_error`, `402 payment_required` ("Credits exhausted, upgrade needed"), `403
  forbidden` ("Plan limit reached"), `404`, `422 validation_error`, `429 rate_limited` [G2].
- **Not documented:** pictures (MMS), delivery statuses after `queued`, rate-limit numbers, how to
  register a webhook, the webhook's event list and signing secret, numbers outside the US ("More
  regions coming") [G1].

### 2.7 AgentText: webhooks, numbers, compliance, pricing and its state today [G1, G2, G3]

- **Webhooks:** "HMAC-signed callbacks when texts arrive. Built-in retry logic. Svix-compatible
  headers", example body `{type: "message.received", inbox_id, body, otp_code, category}`; plans list
  "5 webhook endpoints" (Builder) and 15 (Scale) [G1]. "Svix-compatible" means the Standard Webhooks
  headers (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`), which Sara's
  `standard` kind already checks. How to create one and where its secret is shown are **not
  documented**; the build checks AgentText's dashboard (§12).
- **Numbers:** US only, area code selectable; `$1.15` from the free credit per number; paid plans
  include numbers [G1, G2].
- **Compliance:** "Is A2P compliance handled? Yes. We handle carrier registration and A2P 10DLC
  compliance on your behalf" [G1]. Not verifiable from outside (no brand/campaign is shown to the
  user); carriers still filter content they consider spam (§13 risk 8).
- **Pricing** (§1's correction box): free $0 + $5 credit, 1 inbox, ~100 texts, $0.05 a text after
  the credit, 30-day retention; Builder $29/month, 5 inboxes, 2,000 texts, $0.03 over, 90 days;
  Scale $149/month, 25 inboxes, 15,000 texts, $0.025 over, 1 year [G1, G3]. Whether a "text" means a
  message or a **segment** (160 GSM-7 characters, 70 with any emoji) is not stated; the API reports
  `segments` [G2], so Sara counts segments to be safe (§5.11).
- **Its state on 2026-11-02:** every request to the documented base URL (`/`, `/v0`, `/v0/inboxes`
  without a key, `/health`) answered `404 {"message":"Application not found"}` from Railway's edge,
  which is what Railway answers for an app that isn't deployed [G2 probe]; `www.agenttext.dev/terms`
  and `/privacy` answered 404; the npm package `agenttext` has no published versions and
  `agenttext-mcp` is at 0.1.0 [G4]. **A young or paused service.** §13 risk 1, §14 Q1.

### 2.8 Twilio, the common alternative (not in the ROADMAP line) [T1, T2, T3]

- "Anyone sending SMS/MMS messages over a 10DLC number from an application to the US must register
  for A2P 10DLC … This includes individuals and hobbyists using Twilio" [T1]: a **Brand** (who sends)
  and a **Campaign** (how people opt in and out, what the messages are), in the Twilio Console;
  without a tax ID he registers as a **Sole Proprietor** [T1].
- **Fees** (TCR, passed through): Sole Proprietor brand $4.50 once; campaign vetting $15; then $2 a
  month (Sole Prop) on top of per-message prices and carrier fees, and T-Mobile also charges for
  inbound [T2]. Unregistered traffic gets extra fees and filtering [T1].
- **Webhooks** are signed with `X-Twilio-Signature`, HMAC-**SHA1** over the full URL plus the sorted
  form parameters, with the account's auth token [T3]: a fifth verify kind, URL-exact, and Twilio asks
  integrators to use its SDK rather than their own check [T3].
- **For a beginner** that is a registration form, a review that can take days, and monthly fees
  before the first text. That is the burden AgentText claims to remove, and the reason the owner
  named AgentText. Twilio is **not built** (§14 Q12); the SMS plugin keeps a `provider` setting so a
  Twilio (or Telnyx) provider can be added later without a new plugin.

### 2.9 Matrix: the client-server API [M1, M2, M9]

- **Versions.** The specification is at **v1.19**; matrix.org's homeserver advertises up to v1.17
  (`GET /_matrix/client/versions`) [M1, M2 probe].
- **Logging in a bot.** `GET /_matrix/client/v3/login` lists the flows; matrix.org answers
  `m.login.password`, `m.login.sso` (`oauth_aware_preferred: true`) and `m.login.token` [M2 probe].
  `POST /_matrix/client/v3/login {type: "m.login.password", identifier: {type: "m.id.user", user},
  password, initial_device_display_name}` returns `access_token`, `device_id`, `user_id`, and
  optionally `refresh_token` + `expires_in_ms` (only when the client asks for refresh) [M1]. Every
  call then sends `Authorization: Bearer <token>`. Since v1.15 the spec also has an **OAuth 2.0 API**,
  including the **device authorisation flow** (RFC 8628: the client shows a code, the user approves it
  in a browser) [M1]; homeservers running the Matrix Authentication Service may offer only that.
- **Sync.** `GET /_matrix/client/v3/sync?since=<next_batch>&timeout=<ms>&filter=…`: "The maximum time
  to wait, in milliseconds, before returning this request. If no events … become available before
  this time elapses, the server will return a response with empty fields. By default, this is 0"
  [M1]. A long-poll with `timeout=30000` and a filter (timeline of `m.room.message`, reactions,
  membership; no presence, no ephemeral events but typing in DMs) is the whole inbound path.
- **Sending:** `PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}` (idempotent by
  `txnId`). **Edits** are `m.replace` relations with `m.new_content`; **reactions** are `m.annotation`
  relations (`m.reaction` events); **replies** are `m.in_reply_to`; **threads** `m.thread`; **mentions**
  `m.mentions.user_ids` [M1]. **Typing:** `PUT /rooms/{roomId}/typing/{userId} {typing, timeout}`;
  **receipts:** `POST /rooms/{roomId}/receipt/m.read/{eventId}` [M1].
- **Media.** Authenticated media (v1.11): `GET /_matrix/client/v1/media/download/{serverName}/{mediaId}`
  with the bearer token, `GET /_matrix/client/v1/media/config` (`m.upload.size`), upload with `POST
  /_matrix/media/v3/upload` (→ an `mxc://` URI) [M1].
- **Rate limits.** `429` with `errcode: "M_LIMIT_EXCEEDED"`; "Homeservers SHOULD include a Retry-After
  header"; `retry_after_ms` is deprecated [M1]. A dead token answers `M_UNKNOWN_TOKEN` (`401`, maybe
  `soft_logout`) [M1].
- **End-to-end encryption.** An encrypted room has an `m.room.encryption` state event (Megolm keys
  shared over Olm) [M1], and its messages arrive as `m.room.encrypted`. Reading them needs an Olm/Megolm
  implementation (vodozemac or libolm), device keys, key backup and verification: a cryptographic
  library Sara would either depend on (breaks zero dependencies) or write from scratch (a security
  project of its own). **Out of scope for Phase 122:** Sara works in **unencrypted rooms only** and
  says so plainly in encrypted ones (§6.5, §14 Q8). Element creates DMs **encrypted by default**, so
  the card's step makes a room with encryption **off** (§7.3).
- **Matrix's terms:** none at protocol level; the homeserver's apply. For matrix.org: its Terms of
  Service and Code of Conduct (not re-read in full here; the build reads them) [M9].

---

## 3. The shape

```
 His iPhone (Messages) ─► Apple ─► his Mac: Messages + BlueBubbles Server (:1234)
                                        │ doorbell: POST /hook/<id>.<secret> {type:'new-message', data:{guid}}
                                        │   (unsigned, kind `url`, his network only)          ▲ REST ?guid=<password>
                                        ▼                                                     │ (P1 `local`: loopback,
 Sara: ST7 bridge hook (mode `bridge`) ─► plugins/imessage ── B2: fetch GET /message/<guid> ──┘  home or tailnet, B3)

 Any phone (SMS) ─► carrier ─► AgentText (her US number)
                                        ▲ POST /v0/inboxes/<id>/wait {timeout: 50, since}  ◄── plugins/sms (P1 `public`, TLS)
                                        └─ POST /v0/inboxes/<id>/messages {to, body}

 Element (his account) ─► his homeserver ─► federation ─► her homeserver (@sara:example.org)
                                        ▲ GET /_matrix/client/v3/sync?since&timeout=30000  ◄── plugins/matrix (P1 public or local)
                                        └─ PUT /rooms/<room>/send/m.room.message/<txn> · m.replace edits · typing · reactions

 every plugin ─► P2 bridge.inbound {messageId, fromId, chat, addressed, auth} ─► #bridgeInbound: P4 link code / owner
   ─► CH1 commands ─► place (owner-dm · partner-dm · room · work-room) ─► BR1 media ─► BR2 #bridgeTake ─► #bridgeTurn
   ─► reply + notices + files (per app's textMax / oneMessage) · progress (Matrix: edits; iMessage: edits only with
      the Private API; SMS: none) · typing · 👀 (where the app has them)
```

### 3.1 Shared building blocks

1. **B1 · Bridge hooks of other kinds** (`src/webhooks.ts`, `src/webhook-verify.ts`; grows WHATSAPP W1).
   `ensureBridgeHook(plugin, companion, opts)` today always makes kind `meta`. It takes
   `opts.kind: 'meta' | 'url' | 'standard'` (default `meta`, so WhatsApp's call is unchanged) and the
   plugin's manifest says which it may ask for: `permissions.webhooks: "bridge"` grows to
   `{"bridge": ["url"]}` / `{"bridge": ["standard"]}` (the string form still means `["meta"]`).
   - `meta`: as WHATSAPP W1 (GET handshake, `200`, App Secret).
   - `standard`: Standard Webhooks with the sender's `whsec_…` secret in `webhook:<id>` (AgentText's
     optional webhook, §5.3); `200` on success like `meta` (Svix-style senders retry on non-2xx, so the
     `202` would also do; `200` keeps one rule for bridge hooks).
   - `url`: **no signature exists** (BlueBubbles). Allowed for a bridge hook **only** with the
     doorbell rule (B2): the plugin's manifest must also say `"doorbell": true`, Sara passes the
     plugin only the event **type and ids** pulled from the body (≤ 20 ids, ≤ 120 characters each,
     validated shapes), never the body itself, and the review card says "Is woken by BlueBubbles on
     your network; checks every message with BlueBubbles before reading it".
   - All bridge hooks keep W1's rules: hashed URL secret (`404` for wrong), 256 KB, mode `bridge`,
     `503` while the plugin is stopped or private local mode is on, no bodies in the delivery log,
     locked rows on the Webhooks page, removed with the plugin.
2. **B2 · The doorbell rule: a webhook may wake a plugin, never feed it** (`webhooks.ts` mode `bridge`
   + the plugin). For `url` bridge hooks Sara hands the plugin `{type: 'bridge.webhook', hook, ping:
   {event, ids}}` and the plugin **fetches each id from the platform's authenticated API** before
   anything reaches `bridge.inbound` (BlueBubbles: `GET /api/v1/message/<guid>` with the password).
   A forged doorbell therefore costs one REST call and is dropped (`bridge_skips` reason `unknown-id`
   when the id doesn't exist). Missed doorbells don't lose messages either: the plugin's **catch-up**
   (`message/query after:<last seen>`) runs at start, every 60 s while idle and after every gap.
   The same rule is available to any later plugin whose platform can't sign webhooks.
3. **B3 · "My network" includes my tailnet** (`src/plugins/net.ts` `addressAllowed`). The
   `onOtherMachine` switch ("runs on another machine on my network") also allows Tailscale's ranges,
   **100.64.0.0/10 and fd7a:115c:a1e0::/48**, when `src/tailscale.ts` reports this computer is on a
   tailnet (else they stay refused, because 100.64/10 is also carriers' shared address space). The
   review card line is unchanged; the switch's ? tip names "your home network or your Tailscale
   network". MagicDNS names (`mac-mini.tailnet-name.ts.net`) resolve to those addresses and are pinned
   like any host. Signal's daemon on another machine benefits too.
4. **B4 · HTTP/1.1 in the plugin** (WHATSAPP W3's `http1.mjs`, unchanged). Each plugin folder carries an
   identical copy, as with `sara-plugin.mjs` ("Every copy … is the same file"), and a test checks the
   copies are byte-equal. Two additions any user benefits from: **long-poll reads** (a request whose
   answer may take up to `timeoutMs`, default 30 s; AgentText's `wait` and Matrix's `sync` need 60 s
   and 40 s) and **plain HTTP** when the endpoint is `tls: none` (BlueBubbles on loopback or the home
   network). The query-string password (BlueBubbles) is added by `http1.mjs` from `init.secrets` at
   send time and scrubbed from every log line, error and `bridge.status`.
5. **B5 · The setup stepper and `diagnose()`** (WHATSAPP W6 and `web/setup-steps.js`, reused). Each
   plugin ships `guide.json` (steps, exact screen paths, pictures per language) and `diagnose.mjs`
   (`{code, title, fix, actions[]}`); Sara's routes are the WhatsApp ones with the plugin id in the
   path (`/api/plugins/:id/setup`, `/check`, `/fix`), so the generic code is written once, in 2.55.0,
   and these plugins only add data and checks (§7, §8.2).
6. **B6 · Paid messages: a spend meter and a hard cap** (`manager.ts`, contract v1.2 field). A plugin
   whose platform charges per message says `ready.bridge.cost: {unit: 'segment', per: 0.05, currency:
   'USD', free: <remaining credit, if the platform reports it>}`. Sara keeps `bridge_spend` (§8.1),
   counts every send's units (`bridge.sent {units}`), shows today / this month on the card, and
   **refuses to send** past the owner's monthly cap (*Spend at most per month*, default **$2**, §14
   Q10): the reply stays in the app with "Not sent by text: this month's limit for texts is used up."
   Strangers and partners never cost anything unless he allowed them (§5.5). The cost of each reply
   is estimated before sending (segments of the final text) and long replies are cut to a budget
   (`textBudget`, §5.7).
7. **B7 · Who the sender really is: `auth.level`** (`bridge.inbound.auth`, Phase 117's field, grown).
   Email already sends header readings. The new plugins say how strong their sender identity is:
   `strong` (Matrix: the homeserver signs the sender; iMessage: Apple's account system), `weak` (SMS:
   caller ID can be spoofed). Sara runs owner turns from a `weak` sender as **`meta.untrusted`** (Phase
   117: every automatic tool asks first, in the app) unless he switches on *Trust texts from my
   number* (§5.4). Nothing else in the owner's powers changes.

### 3.2 Where data lives

Everything lives in the data of **the one companion each plugin is switched on for** (§9.4). Tables are
additive (`CREATE TABLE IF NOT EXISTS`), so a 2.55.0 Sara opens a 2.55.3 database and ignores them.

| Data | Where | Who writes it |
|---|---|---|
| Conversations `plugin-imessage`, `plugin-sms`, `plugin-matrix` (CH2 projects "iMessage", "SMS", "Matrix") | `store.db` | Sara (as today) |
| Matrix rooms and iMessage group chats as rooms, room lines, summaries (CH4) | `store.db` `rooms` (`bridge = 'plugin-matrix'` / `'plugin-imessage'`), `room_lines` | Sara (existing tables) |
| `bridge_identities` (the owner's Matrix device list hash; his iMessage handles) | `store.db` (existing) | Sara |
| `bridge_skips` (strangers, encrypted rooms, unknown ids, opt-outs, over-budget) | `store.db` (existing) | Sara |
| `bridge_spend` (SMS units and money per day) | `store.db` (new, §8.1) | Sara |
| The bridge hooks (`url` for BlueBubbles, `standard` for AgentText if used) and their logs (no bodies) | owner's `hooks` tables (ST7) + `owner_plugin` | Sara |
| `ownerChats`, `ownerIds`, `others`, `allow`, `workInGroups`, `nameCalls` | companion settings `plugins.<id>.bridge` | the owner |
| BlueBubbles password | vault `plugin:imessage:password` | the owner (write-only) |
| AgentText API key | vault `plugin:sms:apiKey` | the owner (write-only) |
| AgentText webhook secret (optional) | vault `webhook:<id>` | the owner |
| Matrix access token (and refresh token if the server gave one) | vault `plugin:matrix:token`, `plugin:matrix:refresh` | Sara at login, or the owner pasting a token |
| Matrix password | **nowhere**: typed once for *Log her in*, sent once, forgotten | — |
| BlueBubbles' last-seen message time, the sent-`tempGuid` map; AgentText's `since` cursor; Matrix `next_batch`, `txnId` counter, room list cache | the plugin's own data folder and `kv` | the plugin |
| The Messages database, Apple ID, attachments on the Mac | **the Mac**, owned by Messages/BlueBubbles | Sara never reads them directly |

### 3.3 Settings shape

Core (owner-only, `OWNER_SETTINGS`), the existing bridge block; new only `spendCap` and `trustWeak`:
```ts
chats.progress.apps: { …, 'plugin-imessage'?: boolean, 'plugin-matrix'?: boolean }  // SMS has no progress
plugins.<id>.bridge: {
  ownerChats: string[],   // iMessage chat guids / Matrix room ids / SMS: his E.164 number
  ownerIds: string[],     // his iMessage handles (+1555…, a@b.c) / his MXIDs / his number
  others: boolean,        // let other people talk to her there (default false)
  allow: string[],        // who "others" means (handles, MXIDs or @server, numbers); empty = nobody
  workInGroups: boolean,  // owners can use her tools in groups (iMessage, Matrix; default false)
  nameCalls: boolean,     // answer when her name is said in a group (default false)
  trustWeak?: boolean,    // SMS: "Trust texts from my number" (default false, B7)
  spendCap?: number,      // SMS: dollars a month (default 2, B6)
}
```
Everything else is a **manifest setting** of each plugin (§4.12, §5.12, §6.11), shown on its settings
window with a ? tip (§8.4).

---

## 4. IM · iMessage through BlueBubbles (`plugins/imessage`, bridge `imessage`, channel `plugin-imessage`)

### 4.1 Scope

1. He texts her from Messages on his iPhone, iPad or another Mac: a 1:1 chat with **her Apple ID**
   (an email address such as `sara.frank@icloud.com`), blue bubbles.
2. Pictures and files in and out (BR1 rules, §4.6); voice messages in when their format can be
   transcribed, else a mark.
3. CH1 commands, BR2 steer / queue / `/btw`, `/stop`, `/goal`, `/loop`, `/when`, `/continue`.
4. **Basic mode** (no Private API): answers, files, a *Working on it* line on long turns. **With the
   Private API** (only if he already turned it on in BlueBubbles): typing dots, a tapback on a steer,
   the edited progress message, quoted replies, read marks (§4.7).
5. Group chats she is added to, as rooms (answer when named or replied to; keep-up where he allows;
   tools only with *Owners can use her tools in groups*), like Signal.
6. Partners: off by default, then only handles on his list.
7. The guided card (§7.1), *Test*, the status chip; nothing appears until it's connected.

Not in Phase 122: SMS (green bubbles) through the Mac (her Apple ID has no phone, and Text Message
Forwarding needs his iPhone; SMS is §5's job), FaceTime, her voice out, message effects, Find My, the
Private API's group management, and any setup on a Mac VM or Hackintosh. The Sara Mac app as the
transport is §4.13 (later).

### 4.2 Setup in short

The exact screens are §7.1. In short: a Mac that stays on → **a new Apple ID for her** signed in to
Messages on that Mac → install BlueBubbles, give it Full Disk Access, skip notifications, set a server
password → Sara's card finds the server (same Mac, home network or tailnet) → paste the password →
Sara adds its doorbell webhook in BlueBubbles by itself → *Link my iMessage* and send the code from his
iPhone to her address → *Test*.

### 4.3 The connection

- **Out:** HTTP/1.1 (B4) over the broker's `local` endpoint `{id: 'bb', host: 'setting:server', ports:
  'setting', where: 'local', tls: 'optional'}` (`optional` is new and only allowed with `local`:
  BlueBubbles serves plain HTTP on its port unless he gave it a certificate). With *runs on another
  machine on my network* on (B3), the home network and the tailnet are allowed. One keep-alive socket;
  the password goes in the `guid` query parameter (BlueBubbles' only way [B2]), so on the home network
  the card recommends the tailnet (WireGuard-encrypted) or Sara on the same Mac (§9.1).
- **In, the doorbell:** at setup Sara makes a `url` bridge hook (B1) and the plugin registers it in
  BlueBubbles with `POST /api/v1/webhook {url: <Sara's address for BlueBubbles>/hook/<id>.<secret>,
  events: ['new-message', 'updated-message', 'message-send-error']}`. *Sara's address for BlueBubbles*
  is `http://127.0.0.1:<port>` when they share a Mac, her tailnet name or LAN address otherwise (§7.1
  step 5 works it out and tests it with BlueBubbles' `hello-world` event). Each ring gives the plugin
  `{event, ids: [guid]}` (B2); it fetches `GET /api/v1/message/<guid>?with=chat,handle,attachment`.
- **In, without a doorbell:** when BlueBubbles can't reach Sara (Sara on a cloud server and the Mac at
  home with no tailnet), the plugin **polls** `POST /api/v1/message/query {after: <last seen>, with:
  [chat, handle, attachment], sort: ASC, limit: 50}` every **5 s** while a chat with him was active in
  the last 10 minutes and every **30 s** otherwise. The card shows "Polling (answers take a few
  seconds)" and offers the tailnet as the fix.
- **Catch-up:** at start and after any gap, the same query from the last seen time (at most the last
  24 hours; older messages are filed with a note, not answered).
- **Which messages:** `isFromMe` messages are skipped (her own sends come back as new messages; skipping
  them is the loop guard), so are tapbacks from others except as `bridge.log` lines (`associatedMessage…`
  fields), edits by him (`updated-message` → the room log only), and anything in a chat that isn't
  his DM, a partner's DM or a group she answers in.
- **Down and back:** BlueBubbles doesn't retry webhooks [B11], so the catch-up *is* the retry. Messages
  older than 6 hours get WHATSAPP §4.3's "while I was away" handling.
- **Status chip:** *Connected* = `ping` answers with the password, `server/info` shows Messages signed
  in, and the doorbell or polling worked within the last 2 minutes. *Connected (basic)* when the
  Private API is off (with a ? explaining what that means), *Connected (Private API)* when on.

### 4.4 Who is who: owner identity and her Apple ID

- **Her own Apple ID** is the default and the recommendation. If the Apple ID on the Mac is **his**,
  BlueBubbles sees **all of his conversations**, and her replies go out **as him**. The card checks
  `GET /api/v1/icloud/account` and his linked handles: when they match (or the account owns his
  iPhone's number) it stops with: "This Mac is signed in to Messages with your own Apple ID. Sara would
  see all your chats and answer as you. Make a separate Apple ID for her (step 1)." and the plugin
  refuses to run (§14 Q5 lets him override on purpose; default no override).
- **The owner** is the set of his **handles** (his phone number in E.164 and his Apple ID emails, as
  Messages shows them in `handle.address`), recorded by linking. **Linking:** *Link my iMessage* → a
  6-digit code (P4) → he sends `/link 123456` to her address from his iPhone → "Linked. It's me, Sara."
  + the AI notice; the chat guid goes to `ownerChats`, the handle to `ownerIds`. He can link a second
  handle (his email) the same way.
- **Strength:** iMessage senders are Apple-authenticated accounts; `auth.level: 'strong'` (B7). A handle
  that changes devices doesn't change; there is no identity key to pin (Apple exposes none to
  BlueBubbles), so `bridge_identities` only records the handles and when they linked.
- **Partners:** `others` on + `allow` (handles). **Strangers** (anyone who finds her address): with
  `others` off, one line once per handle ("Hi! I'm Sara, an AI companion. I only chat with the person
  who runs me here."), then nothing, counted (`stranger`). Spam from unknown senders often lands in
  Messages' *Unknown Senders* filter on the Mac; Sara treats them the same way.

### 4.5 Places: private chats, group chats, keep-up

| Place | Chat | What she does |
|---|---|---|
| Owner 1:1 (`owner-dm`) | `iMessage;-;<his handle>` linked | Everything an owner chat does. |
| Partner 1:1 (`partner-dm`) | a listed handle's DM | `partnerNote` rules, no tools, the AI notice first and every 3 hours. |
| Group (`room`) | `iMessage;+;chat…` she is in | Answers only when `addressed`: her name at the start ("Sara, …"), or a reply to her (Private API only; basic mode can't see threads). Keep-up (CH4 `bridge.log`) only when he switches on *Keep up with this group* for it. |
| Group with him in it, tools on (`work-room`) | as above, `workInGroups` on, the sender is him | Owner tools in that group. |

- Group membership comes from the chat's `participants`; *he is in the group* = one of his `ownerIds`
  is a participant (Signal's rule, Sara decides, not the plugin).
- Being added to a group by a stranger: she reads nothing and says nothing until he presses *Answer
  here* for it in the plugin's settings window (the Signal group list, reused). *Leave this group*
  needs the Private API (`chat/:guid/leave`); without it the card says "Leave it from Messages on the
  Mac" with the path.

### 4.6 Pictures, files and voice

- **In:** each attachment (`mimeType`, `transferName`, `totalBytes`) → `bridge.who` first (BR1 rules:
  owner pictures ≤ 8 MB, up to 4 a message; partners' pictures only with *Look at pictures other people
  send*; documents from him only, ≤ 20 MB) → `GET /api/v1/attachment/<guid>/download` → `bridge.file`
  chunks. **HEIC** photos (iPhone's default): if BlueBubbles' download returns JPEG for them (the
  download route takes `width`/`height`/`quality` options; whether it converts HEIC is checked at build
  against a real server, §12), they go in as pictures; otherwise they are filed as a document and she
  says once: "I can't see HEIC photos yet. On your iPhone: Settings → Camera → Formats → *Most
  Compatible*, or send it as a file."
- **Voice messages** (`isAudioMessage`, CAF): transcribed with `speechOf(app).hearNote` when the format
  is one it takes (checked at build); else the mark `[voice message]` and "I can't play voice messages
  from iMessage yet; type it or use the app."
- **Out:** `POST /api/v1/message/attachment` (multipart, `tempGuid`, `name`), the caption as the next
  text message. Stickers, Memoji, Digital Touch and handwriting come in as marks.
- **Formatting:** iMessage shows plain text. Markdown is flattened: `**bold**` → bold-free text,
  headings as their own line, lists with `•`, tables as `a — b` lines, code blocks kept as plain lines,
  links as `text: url` (Messages makes them tappable).

### 4.7 Basic mode and Private API mode

| Feature | Basic (default) | Private API (if he turned it on in BlueBubbles) |
|---|---|---|
| Answer, files, commands, groups by name | ✓ | ✓ |
| Typing dots while she works | — | ✓ (`chat/:guid/typing`, renewed every 20 s, off on reply) |
| Steer acknowledgement | a short line "👀 got it" (`ack: 'line'`, only when the message steers) | a tapback on his message (`ack: 'react'`, BR2's 👀 → the **‼** tapback, the nearest of the classic six) |
| Live progress | the working line (WHATSAPP §4.8 without buttons: "Working on it: … Send /stop to stop.") at 20 s | one edited message (P5, `editLimit: 4` = Apple's 5 edits minus one spare, `editEveryMs: 20000`, and only within **15 minutes** of sending [A3]; after that, no more edits) |
| Quote his message in a reply (`/btw`, the answer in a group) | text form "↪ …" | `selectedMessageGuid` |
| Read marks | — | *Send read receipts* (default off) |
| Leave a group | from the Mac | ✓ |

`ready.bridge` is sent **after** the plugin reads `server/info`, so Sara gets the right features;
when the Private API turns off or on, the plugin restarts its bridge (`bridge.status` explains why).
Sara **never** asks him to switch it on. The card's *What's the Private API?* ? opens §2.3's facts in
plain words ("It needs a Mac security feature turned off, which BlueBubbles compares to jailbreaking.
Sara works without it.").

### 4.8 Progress, commands, steer, queue, `/btw`, `/continue`

- Progress: the table above; partners never see progress; `/progress off` works as everywhere.
- Commands are typed (`/new`, `/stop`, …) or the name form when *Her name works as a command* is on.
  iOS may turn `--` into `—` and add a capital first letter: the parser already ignores case; the
  plugin also maps smart quotes and dashes back before `parseCommand`.
- Steer/queue/`/btw` as BR2. The `/continue` offer (Phase 119) is a text line: "Pick up where you left
  off in the app? Reply /continue." (no buttons on iMessage).
- Approvals asked in his chat: "Reply *yes* to allow or *no* to deny (expires in 10 minutes)." The
  bare words `yes`/`no` from his DM resolve the one open approval, as the text fallback for plugins
  without buttons (WHATSAPP W5's text form).

### 4.9 Her messages first

iMessage has no reply window. Reminders, briefings, finished jobs and goal endings go to his iMessage
**only** with *Send reminders and messages she starts to my iMessage too* (default off; Signal and
email left `mirror` unbuilt, BRIDGES3 *As built*; iMessage is where it is most wanted, §14 Q7). Never to
a partner or a group.

### 4.10 Pace and the rules Sara keeps

| Rule | Value | Why |
|---|---|---|
| Pace to one chat | ≤ 1 message every 2 s, bursts of ≤ 4 (the reply's parts and files) | AppleScript sends one at a time; Messages and Apple dislike floods |
| Reply length | ≤ 4 messages of ≤ 2,000 characters each; the rest "…(continued in the app)" | long walls of text in Messages; the edit window |
| Total sends | ≤ 150 an hour, 600 a day across iMessage (constants; the card shows today's count) | a new Apple ID that sends a lot can be flagged by Apple |
| Who she writes to first | only him, only with the switch | Apple's spam rules [A1] |
| Accounts | Sara never creates Apple IDs, never signs in to iCloud, never touches SIP | his accounts, his Mac |

### 4.11 When things go wrong

`diagnose()` (§7.4) for everything; a failed send (`message-send-error`, or BlueBubbles' error answer)
is retried once after 10 s, then kept in the app with "iMessage didn't deliver this: <title>. It's here
instead." Failures that need him (Mac asleep, Messages signed out, password changed) go to Today's
*Needs you* once and to the safety check-up's list.

### 4.12 The manifest (`plugins/imessage/sara-plugin.json`, abridged)

```json
{
  "manifest": 1, "id": "imessage", "name": "iMessage", "version": "1.0.0",
  "description": "Talk to her in Messages through BlueBubbles on your own Mac.",
  "sara": ">=2.55.2", "main": "main.mjs",
  "permissions": {
    "bridges": ["imessage"], "bridgeFiles": true, "settings": true,
    "webhooks": { "bridge": ["url"], "doorbell": true },
    "connect": [ { "id": "bb", "host": "setting:server", "ports": "setting", "where": "local", "tls": "optional" } ],
    "files": { "read": ["plugin-data"], "write": ["plugin-data"] }
  },
  "settings": [
    { "key": "server", "type": "text", "label": "BlueBubbles address", "default": "127.0.0.1", "tip": "…" },
    { "key": "port", "type": "number", "label": "BlueBubbles port", "default": 1234, "tip": "…" },
    { "key": "onOtherMachine", "type": "switch", "label": "BlueBubbles runs on another computer on my network", "default": false, "tip": "…" },
    { "key": "password", "type": "secret", "label": "BlueBubbles server password", "tip": "…" },
    { "key": "readReceipts", "type": "switch", "label": "Send read receipts (Private API only)", "default": false, "tip": "…" },
    { "key": "mirror", "type": "switch", "label": "Send reminders and messages she starts to my iMessage too", "default": false, "tip": "…" },
    { "key": "pollSeconds", "type": "number", "label": "Check for messages every (seconds, when not woken)", "default": 5, "advanced": true, "tip": "…" }
  ]
}
```
New in the manifest: `webhooks.bridge` as a list of kinds and `doorbell` (B1), `tls: "optional"`
for `local` endpoints (§4.3).

### 4.13 Through the Sara Mac app (later, where possible)

The ROADMAP adds "and through the Sara Mac app where possible". What that would take, so the owner
can decide (§14 Q4):

- **Reading:** Messages keeps its database at `~/Library/Messages/chat.db`; reading it needs **Full
  Disk Access** for Sara.app (the same permission BlueBubbles asks for [B4]); the app would watch the
  file and read new rows (SQLite through the system `libsqlite3`, no dependency).
- **Sending:** `osascript`/`NSAppleScript` telling Messages to `send` to a participant needs the
  **Automation** permission for Messages (`NSAppleEventsUsageDescription` in `Info.plist`, which the app
  doesn't have today) and, under the hardened runtime, the `com.apple.security.automation.apple-events`
  entitlement. Files through AppleScript are fragile; typing, tapbacks and edits are impossible
  without the Private API.
- **Transport to Sara:** the Mac app already keeps a WebSocket to `/api/hands`. A small `msg.*` op set
  on it (new, owner-only, the hands token) would carry `{new message}` up and `{send}` down; the
  iMessage plugin would gain a second *source* (`bridge.webhook` lines from core instead of the
  doorbell; sends through a core relay instead of the broker).
- **Why not now:** it duplicates BlueBubbles' basic mode, adds two macOS permissions to an app that
  also has computer-use powers (Full Disk Access + Accessibility in one app is a large blast radius),
  needs a Mac build and notarisation (the build Mac has been asleep since 2026-11-01), and only works
  when Sara runs on that Mac (or the Mac app is connected to a remote Sara). Default: **design it as
  its own slice after 2.55.3** with its own design note, using this plugin's `source: 'mac-app'`
  setting so nothing above changes.

---

## 5. TX · SMS through AgentText (`plugins/sms`, bridge `sms`, channel `plugin-sms`)

The plugin is called **SMS** (its channel project is "SMS", already in `PLUGIN_NAMES`) and has one
*provider* today, AgentText. The provider is a setting so a later provider (Twilio, Telnyx) is a new
module in the same plugin, not a new bridge (§2.8, §14 Q12).

### 5.1 Scope

1. He texts her **US number** from any phone (no app, no data: a plain SMS), and she answers by SMS.
2. Text only: AgentText documents no pictures (MMS) [G2]. A picture he sends doesn't arrive or arrives
   as a link; she says once a day "Pictures don't come through by text. Send them in the app."
3. Typed commands with a slash (`/new`, `/stop`, `/status`, `/btw`, `/continue`…); **never** the bare
   carrier words (§5.9).
4. Short replies by design (each segment costs, §5.7), the rest in the app.
5. Partners: off by default; when on, only listed numbers, and he chooses whether their texts may
   cost money (§5.5).
6. The card shows **what it costs**, today and this month, and a monthly cap that stops sending.

Not in Phase 122: MMS, group texts, numbers outside the US, short codes, toll-free numbers, her voice by
phone call, an AgentText MCP server inside Sara (the bridge is enough; Sara's own MCP installer can add
`agenttext-mcp` for other uses, §14 Q13), OTP reading for her own sign-ups (§14 Q14).

### 5.2 Setup in short

The exact screens are §7.2. In short: install the plugin (the review card; the card says it costs money
past the free credit) → sign up at agenttext.dev (or *Sign up for me* runs the documented `POST
/v0/signup` with his name and email, §14 Q11) → paste the **API key** (shown once by AgentText) → *Get
her a number* (one `POST /v0/inboxes`, with an area code he types; $1.15 of the credit) → set the
monthly cap → *Link my phone*: he texts `/link 123456` to her new number → *Test*.

### 5.3 The connection

- **Out:** HTTP/1.1 (B4) over one broker endpoint `{id: 'api', host: 'setting:apiHost', ports: [443],
  where: 'public', tls: 'required'}` (default `agenttext-api-production.up.railway.app`, under
  *Advanced*). Sends: `POST /v0/inboxes/<inbox>/messages {to, body}` → `message_id`, `segments`.
- **In, the long-poll** (default, no public address needed): `POST /v0/inboxes/<inbox>/wait {timeout:
  50, since: <cursor>}` in a loop on its own keep-alive socket; `200` → one message (then immediately
  the next `wait`), `408` → again. The cursor is the last message's `created_at`. Because `wait`
  returns **one** message, a burst is drained with `GET /v0/inboxes/<inbox>/messages?direction=inbound
  &limit=20` after each hit, newest first, deduped by `message_id`.
- **Catch-up:** at start and after a gap, the same list call; messages older than 6 hours get the
  "while I was away" handling, older than 24 hours are filed, not answered (and cost nothing).
- **In, the webhook** (optional, *Advanced*, needs the public door of WHATSAPP W2): a `standard` bridge
  hook (B1) with AgentText's signing secret; Sara checks `webhook-signature` on the raw bytes and
  hands the plugin the body (signed, so not a doorbell). When on, the long-poll stops; it restarts if
  no signed delivery arrives within 10 minutes of a `wait` that would have returned one. Because the
  webhook's registration and secret aren't documented, this mode ships **only after** the owner's
  §12 check finds them; until then the setting is hidden.
- **Idle cost:** the long-poll is one request every 50 s (~1,700 a day). AgentText documents no
  request limit [G2]; if `429` comes back, the loop backs off (5 s, 30 s, 2 min) and the card says
  "AgentText asked Sara to check less often."
- **Status chip:** *Connected* = `GET /v0/inboxes/<inbox>` answers with `status: active` and the last
  `wait` returned within 2 minutes. *Paused: spending limit reached* when B6's cap is hit (receiving
  continues; sending stops).

### 5.4 Who is who: weak identity, untrusted by default

- **The owner** is his phone number (E.164), recorded by linking (*Link my phone* → `/link 123456`
  texted to her number). `ownerChats` = `ownerIds` = that number.
- **Caller ID can be faked.** SMS has no sender authentication a receiver can check; spoofed numbers
  are a known abuse. So `auth.level: 'weak'` (B7): his SMS turns are **owner turns with memory and
  his context, but `meta.untrusted`**: every tool that would run on its own **asks first, in the app**
  ("Run *shell* from a text message?"), and owner-only commands that change settings (`/model`,
  `/goal`, `/loop`) answer "Do that from the app; texts can be faked." *Trust texts from my number*
  (default **off**, §14 Q9) removes this, with a red warning in the switch's tip.
- **Partners:** `others` on + `allow` (numbers). **Strangers:** with `others` off, **no reply at all**
  (an answer costs money and confirms the number is live to spammers); counted (`stranger`). This
  differs on purpose from Telegram/WhatsApp's one hello line (§14 Q16).
- **Opt-outs:** a message with `opt_out_detected: true` [G2], or one of the carrier keywords alone
  (§5.9), from **anyone** mutes that number for her (`bridge_skips` `opt-out`) and she sends nothing
  more to it, ever, until that person texts `START` (or he unmutes a partner in Settings). For **him**
  the card shows a red banner: "You texted STOP, so the phone company blocks her texts to you. Text
  START to her number to undo it."

### 5.5 Places and who pays

| Place | Who | What she does | Cost |
|---|---|---|---|
| Owner (`owner-dm`) | his linked number | owner turn, untrusted by default (§5.4) | her replies count toward the cap |
| Partner (`partner-dm`) | listed numbers, `others` on | partner rules, the AI notice first (it costs one segment) | only with *Partners' texts may cost money* on (default off): off = she reads their text and files it, replying "I can only text with <his name> here." **once**, then nothing |
| Stranger | anyone else | nothing | none |

No group texts: AgentText's conversations are "auto-threaded … by contact number" [G2]; a group MMS
doesn't exist in its API.

### 5.6 Pictures and files

None in v1. `bridgeFiles` is **not** requested (the review card says so: "Text only"). Her outgoing
files stay in the app with "I put the file in the app: <link>" when `accessInfo().url` exists.

### 5.7 Her replies: short by design

- **Segments:** 160 GSM-7 characters per single SMS, 153 per part when split; any character outside
  GSM-7 (most emoji, curly quotes in some encoders) switches the whole message to UCS-2: 70 / 67. The
  plugin **normalises** her text before sending (curly quotes → straight, `—` → `-`, `…` → `...`, emoji
  kept only when the owner turned on *Allow emoji (costs more)*, default off) and computes the segments
  itself; `segments` in AgentText's answer is recorded as the truth.
- **Budget:** *Longest reply* (`textBudget`, default **3 segments**, about 450 characters). The model
  is told in the turn's channel note: "This is SMS: answer in 1–3 short sentences, no lists or
  Markdown." (the existing per-channel style hint, like email's). Longer answers are cut at a sentence
  end and end with "(more in the app)". Code blocks, tables and long lists are never texted.
- **Markdown** is stripped to plain text; links stay as bare URLs (phones make them tappable).
- **One reply = one send** (`oneMessage: true`, Phase 117's field): the AI notice, crisis help and the
  reply are joined, so a turn costs one multi-segment message, not several.

### 5.8 Progress

None: no edits, no typing over SMS, and every *Working on it* would cost a segment. `edit: false`,
`typing: false`, `react: false`. P6 handles long turns (no partial reply; the answer when it's done).
BR2 acknowledges a steer with **nothing** (`ack: 'none'`): his next message is simply taken at the
safe point; `/status` answers "Working on it (3 steps so far)." if he wants to know.

### 5.9 Commands, and the words that belong to the phone company

- US carriers reserve **STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT** (opt-out), **START, UNSTOP**
  (opt back in) and **HELP, INFO** for every A2P number (the CTIA principles AgentText's compliance
  claims to follow [G1, T1]). The plugin and Sara treat any of them **alone in a message, any case**,
  as the carrier action, **never** as a Sara command: STOP is never `/stop`.
- Sara's commands on SMS always need the slash (`/stop`, `/new`), and the name form is **off** on SMS
  ("Sara stop" is too close to "STOP").
- `HELP` alone gets one fixed, free-of-model answer (one segment): "Sara, an AI companion run by <his
  first name>. Reply STOP to stop texts." (§14 Q17 for the exact words).
- The `/continue` offer and approvals use the text forms (§4.8), with the approval answer as `/yes` /
  `/no` (a bare "yes" in a text is too easy to send by accident).

### 5.10 Pace and the rules Sara keeps

| Rule | Value | Why |
|---|---|---|
| Pace | ≤ 1 message every 3 s; one message a reply (`oneMessage`) | carriers filter bursts from 10DLC numbers |
| Total sends | ≤ 60 an hour, 200 a day (constants) **and** the money cap | a loop can't run up a bill |
| Who she writes to first | only him, only with *Send reminders … to my phone too* (default off), and each counts toward the cap | consent; cost |
| Content | no links to unknown sites in texts she starts; no URL shorteners | carrier spam filters (§13 risk 8) |
| `402 payment_required` | sending stops, the card says "Your AgentText credit is used up" with *Add credit* (AgentText's billing page) | money is his decision |

### 5.11 What it costs, shown on the card

"Free credit: $3.85 left (about 77 texts). This month: 23 texts, $1.15 (the number) + $0.00. Limit:
$2.00 a month. Over the limit she keeps your messages in the app." Prices come from the plugin's
price table for the account's plan (free $0.05 a text after credit; Builder $0.03 over 2,000; Scale
$0.025 over 15,000 [G1]) and are labelled "estimated; AgentText's bill is what counts". The cap
counts **segments** (§2.7). The plan is read from the account when the API says it, else he picks it.

### 5.12 The manifest (`plugins/sms/sara-plugin.json`, abridged)

```json
{
  "manifest": 1, "id": "sms", "name": "SMS", "version": "1.0.0",
  "description": "Text her by SMS on her own US number through AgentText (paid past the free credit).",
  "sara": ">=2.55.3", "main": "main.mjs",
  "permissions": {
    "bridges": ["sms"], "settings": true, "webhooks": { "bridge": ["standard"] },
    "connect": [ { "id": "api", "host": "setting:apiHost", "ports": [443], "where": "public", "tls": "required" } ],
    "files": { "read": ["plugin-data"], "write": ["plugin-data"] }
  },
  "settings": [
    { "key": "provider", "type": "choice", "label": "Text service", "options": ["agenttext"], "default": "agenttext", "tip": "…" },
    { "key": "apiKey", "type": "secret", "label": "AgentText API key", "tip": "…" },
    { "key": "inboxId", "type": "text", "label": "Her inbox", "tip": "…" },
    { "key": "areaCode", "type": "text", "label": "Area code for her number", "tip": "…" },
    { "key": "textBudget", "type": "number", "label": "Longest reply (texts)", "default": 3, "tip": "…" },
    { "key": "emoji", "type": "switch", "label": "Allow emoji (costs more)", "default": false, "tip": "…" },
    { "key": "partnersPay", "type": "switch", "label": "Partners' texts may cost money", "default": false, "tip": "…" },
    { "key": "mirror", "type": "switch", "label": "Send reminders and messages she starts to my phone too", "default": false, "tip": "…" },
    { "key": "apiHost", "type": "text", "label": "AgentText API host", "default": "agenttext-api-production.up.railway.app", "advanced": true, "tip": "…" }
  ]
}
```
The monthly cap and *Trust texts from my number* are **core** bridge settings (§3.3), not manifest
ones, so a plugin can't raise its own spending limit.

---

## 6. MX · Matrix (`plugins/matrix`, bridge `matrix`, channel `plugin-matrix`)

### 6.1 Scope

1. **Her own Matrix account** (a bot account such as `@sara-frank:matrix.org`, or on his own
   homeserver), talking with him in an **unencrypted** room from Element (or any client).
2. Pictures and files both ways (BR1), voice messages in (`m.audio`, transcribed when the format is
   one `hearNote` takes).
3. Everything Telegram has: commands, steer/queue/`/btw`, the **edited progress message** (Matrix edits
   are unlimited by the spec; Sara's P5 budget applies), typing, reactions, read receipts, replies.
4. Rooms she is invited to by him: answer when mentioned or replied to; keep-up (CH4) per room when he
   allows; `work-room` with *Owners can use her tools in rooms*.
5. Partners: off by default; then MXIDs or whole servers (`@example.org`) he lists.
6. The guided card (§7.3), *Test*, the status chip.

Not in Phase 122: **encrypted rooms** (§6.5), spaces, threads beyond replying in the thread she was
addressed in, voice/video calls, widgets, application-service (bridge) registration, her own
homeserver hosted by Sara.

### 6.2 Logging her in

Three ways, the first offered by default:

1. **Password once.** He makes the bot account (§7.3 step 1), types its MXID and password into the
   card; Sara (through the plugin) reads `GET /_matrix/client/v3/login`; if `m.login.password` is
   listed it posts `/login` with `initial_device_display_name: "Sara (bot)"` and **no refresh**, stores
   the `access_token` and `device_id` in the vault, and **forgets the password**.
2. **Approve on your server** (device authorisation, OAuth 2.0 API, spec v1.15 [M1]): when the server
   lists no password flow (Matrix Authentication Service), the card shows the server's verification
   link and code; he approves in a browser where he is logged in **as her**; the plugin polls the token
   endpoint, then keeps the access and refresh tokens and refreshes before expiry. Built only if the
   owner's homeserver needs it (§14 Q18); matrix.org offers passwords today [M2 probe].
3. **Paste an access token** (*Advanced*): from Element as her → *Settings → Help & About → Advanced →
   Access Token*, for people who already have one. The card warns that logging out of that Element
   session kills the token.

`M_UNKNOWN_TOKEN` later → `TOKEN_GONE` (§7.4) and *Log her in again*. *Log out* on the card calls
`POST /logout` and deletes the vault entries.

### 6.3 The connection

- **Out and in:** HTTP/1.1 (B4) over the broker. Two endpoints so one plugin covers both kinds of
  homeserver: `{id: 'hs', host: 'setting:homeserver', ports: [443, 8448], where: 'public', tls:
  'required'}` and `{id: 'hsLocal', host: 'setting:homeserver', ports: 'setting', where: 'local', tls:
  'optional'}`; the plugin uses `hsLocal` only when *My homeserver runs on my network* is on (B3 covers
  tailnet homeservers). The homeserver is found from the MXID with `GET
  https://<server>/.well-known/matrix/client` (`m.homeserver.base_url`), shown on the card for him to
  confirm (the host setting is what the broker allows, so a changed well-known can't move her).
- **Sync loop:** a filter is uploaded once (`POST /user/<me>/filter`: room timeline `m.room.message`,
  `m.reaction`, `m.room.redaction`, `m.room.encryption`, `m.room.member`, `m.room.name`; ephemeral
  `m.typing` off, `m.receipt` off; no presence; `lazy_load_members`). Then `GET /sync?filter=<id>&
  since=<next_batch>&timeout=30000` forever on its own socket; `next_batch` is saved after every
  answer is handled.
- **First start:** the first sync uses `timeline.limit: 1` and **nothing in it is answered** (old
  history is not a request); only events after that `next_batch` count. Restarts resume from the saved
  token; anything older than 6 hours gets the "while I was away" handling.
- **Dedupe:** by `event_id`; her own events (`sender` = her MXID) are skipped (the loop guard).
- **Invites:** `rooms.invite` in sync. An invite **from one of his MXIDs** is joined (`POST
  /join/<room>`); from a listed partner, joined only with `others` on; from anyone else, declined
  silently (`POST /rooms/<room>/leave`), counted (`stranger-invite`). An invite whose stripped state
  shows `m.room.encryption` is joined only to say the encrypted-room line once and leave (§6.5).
- **Status chip:** *Connected* = `GET /account/whoami` answers her MXID and the last sync returned
  within 60 s.

### 6.4 Who is who

- **The owner** is his **MXID(s)**, recorded by linking: he invites her to a room (or opens a DM room
  with encryption off), sends `/link 123456`; Sara stores the `room_id` in `ownerChats` and the sender
  in `ownerIds`. Matrix senders are authenticated by their homeserver and federation signatures, so
  `auth.level: 'strong'` (B7).
- **His devices** are not pinned: in unencrypted rooms device keys play no part. What *is* checked:
  the sender's server. If his account's server ever changes (a new MXID), that is a new link.
- **Partners:** `others` on + `allow` (MXIDs, or `@server.name` for everyone on a server he trusts,
  e.g. his family's homeserver). **Strangers:** their invites are declined; a stranger who joins a room
  he shares with her is a room member like on Discord: answered only when addressing her, as a
  partner, never with tools.

### 6.5 Places, and encrypted rooms

| Place | Room | What she does |
|---|---|---|
| Owner DM (`owner-dm`) | linked room, two members (him and her) | Everything an owner chat does. |
| Partner DM (`partner-dm`) | two members, the other listed | partner rules |
| Room (`room`) | more members | answers when `addressed`: an `m.mentions.user_ids` with her MXID, a reply to her event, or her name at the start (`nameCalls`); keep-up (CH4 `bridge.log`) when he switches on *Keep up with this room* |
| Room with tools (`work-room`) | as above, `workInGroups` on, sender is him | owner tools |
| **Encrypted room** | has `m.room.encryption` | she **can't read it**. Once per room, in plain text: "I can't read encrypted rooms yet. To talk with me, make a room with encryption off (it can't be switched off later)." Then she leaves (if she just joined from an invite) or stays silent (if encryption was turned on later: Matrix never lets a room go back), and the card lists the room under *Rooms she can't read*. Counted (`encrypted`). |

**Why no encryption** (§14 Q8): reading `m.room.encrypted` needs Olm/Megolm (vodozemac or libolm),
device keys, one-time keys, key sharing and verification. That is a cryptographic library: Sara would
either take a dependency (against the zero-dependency rule) or write one from scratch (a security
project needing its own audit). The privacy line on the card says it plainly: "Your room with her is
not end-to-end encrypted: whoever runs the homeservers can read it. For private chats use Signal."

### 6.6 Pictures, files and voice

- **In:** `m.image`, `m.file`, `m.audio`, `m.video` (video as a document) → `bridge.who` first (BR1 rules)
  → `GET /_matrix/client/v1/media/download/<server>/<mediaId>` with the bearer token (authenticated
  media, v1.11 [M1]); a server older than v1.11 gets the unauthenticated `/_matrix/media/v3/download`
  path as a fallback only if `/versions` lacks v1.11. Encrypted attachments (`file` instead of `url`)
  don't occur in unencrypted rooms; if seen, they are marks.
- **Out:** `POST /_matrix/media/v3/upload` (respecting `m.upload.size` from `/media/config`) → `mxc://` →
  an `m.image` (with `info.w/h/mimetype/size`, read by Sara's existing image header reader) or `m.file`.
- **Voice:** `m.audio` with `org.matrix.msc3245.voice` (Element's voice messages are OGG/Opus) →
  `hearNote`, like Telegram's.

### 6.7 Typing, receipts, reactions, edits, replies

- **Typing:** `PUT /rooms/<room>/typing/<me> {typing: true, timeout: 30000}` when a turn starts, renewed
  every 25 s, `false` on reply. On by default in his DM; off for partners and rooms (§14 Q19).
- **Read receipts:** `m.read` on his message when she takes it (*Send read receipts*, default on in his
  DM; Matrix users expect them; off elsewhere).
- **Reactions:** BR2's 👀 on a steer (`m.annotation`), `ack: 'react'`. His reaction ⏹ (or ❌) on her
  progress message = `/stop` for that turn: a free "button", announced in the progress message's last
  line ("React ⏹ to stop").
- **Replies:** `/btw` answers and room answers quote his event (`m.in_reply_to`); in a thread she
  answers in that thread (`m.thread`).
- **Edits:** the progress message (§6.8). Her final replies are never edited later.

### 6.8 Progress

P5's `ProgressMessage` with `edit: true`, `editLimit: 30`, `editEveryMs: 3000` (the spec sets no edit
limit; the budget keeps rate limits away), `m.replace` with `m.new_content` and a `* `-prefixed
fallback body (the spec's convention). The final answer is a **new** message (so notifications fire),
and the progress message's last edit becomes the *Done · 6 steps · 1:12* summary, as on Telegram.

### 6.9 Commands, steer, queue, `/btw`, `/continue`, formatting

- Commands typed, with or without a mention in rooms (`@sara: /new`); the name form when on. Element's
  own `/commands` (e.g. `/me`, `/help`) are handled by Element before sending: `/help` opens Element's
  own help, and a command Element doesn't know (`/new`, `/link`) first asks *Unknown command* with a
  **Send as message** button. The card says so, and the name form (`Sara help`, `Sara new`) is **on by
  default on Matrix** so he never has to fight the prompt (checked in the owner's run, §12).
- The `/continue` offer is a text line with a ✅ reaction pre-placed by her; his ✅ reaction (or
  `/continue`) takes it. Approvals: her message with ✅ and ❌ pre-reacted; his reaction decides.
  This is the Matrix form of WHATSAPP W5's buttons (`ready.bridge.buttons: 'reactions'`).
- **Formatting:** `body` is plain text; `format: org.matrix.custom.html` with a `formatted_body` made by
  a small, **escape-first** Markdown converter in the plugin (bold, italic, code, pre, lists, links,
  headings, tables as `<table>`); every other character is HTML-escaped, no raw HTML from the model
  passes (the spec's allowed-tags list is the ceiling).

### 6.10 Pace and the rules Sara keeps

| Rule | Value | Why |
|---|---|---|
| Pace per room | ≤ 1 message a second, bursts of ≤ 5; edits ≤ 1 every 3 s | homeserver rate limits (matrix.org limits new accounts) |
| `429 M_LIMIT_EXCEEDED` | wait `Retry-After` (else `retry_after_ms`, else 5 s), keep order | the spec [M1] |
| Total sends | ≤ 600 an hour, 3,000 a day across Matrix | a loop stops itself |
| Rooms | she joins only his invites (and listed partners'); at most 50 joined rooms | no room-spam bot |
| Who she writes to first | only his DM, only with the *mirror* switch | consent |

### 6.11 The manifest (`plugins/matrix/sara-plugin.json`, abridged)

```json
{
  "manifest": 1, "id": "matrix", "name": "Matrix", "version": "1.0.0",
  "description": "Talk to her in Element or any Matrix app through her own Matrix account.",
  "sara": ">=2.55.1", "main": "main.mjs",
  "permissions": {
    "bridges": ["matrix"], "bridgeFiles": true, "settings": true,
    "connect": [
      { "id": "hs", "host": "setting:homeserver", "ports": [443, 8448], "where": "public", "tls": "required" },
      { "id": "hsLocal", "host": "setting:homeserver", "ports": "setting", "where": "local", "tls": "optional" }
    ],
    "files": { "read": ["plugin-data"], "write": ["plugin-data"] }
  },
  "settings": [
    { "key": "mxid", "type": "text", "label": "Her Matrix ID", "tip": "…" },
    { "key": "homeserver", "type": "text", "label": "Her homeserver", "tip": "…" },
    { "key": "onOtherMachine", "type": "switch", "label": "My homeserver runs on my network", "default": false, "tip": "…" },
    { "key": "token", "type": "secret", "label": "Access token", "tip": "…" },
    { "key": "typing", "type": "switch", "label": "Show typing", "default": true, "tip": "…" },
    { "key": "readReceipts", "type": "switch", "label": "Send read receipts", "default": true, "tip": "…" },
    { "key": "mirror", "type": "switch", "label": "Send reminders and messages she starts to my Matrix room too", "default": false, "tip": "…" }
  ]
}
```

### 6.12 Which homeserver

- **matrix.org** (free, the default suggestion): a new account at app.element.io → *Create account*.
  Its terms and code of conduct apply (§17 [M9]); a bot account that only talks to its owner is the
  mildest use there is, and the card says "Use a separate account for her, not your own."
- **His own homeserver** (Synapse, Conduit, Dendrite on his server or Docker): the card's *My
  homeserver runs on my network* covers it; nothing else differs.
- Sara **never hosts** a homeserver or registers accounts for him (registration needs CAPTCHA and
  terms acceptance, which are his to do).


### 6.13 As built (2.55.1)

Built as designed, with these differences:

- **Login:** password once and pasted tokens; the OAuth device flow (§6.2 way 2) is not built (§14 Q18
  default). `NO_PASSWORD_LOGIN` points to *Paste a token*. A pasted token that fails `whoami` is not kept.
- **Discovery:** a new Matrix ID sets *Her homeserver* to its server part; `.well-known` moving her is
  applied to the setting at *Log her in* (the card shows the host) rather than asked as a separate tick.
- **Endpoints:** `hs` (public, TLS, 443/8448) and `hs-local` (connect ids are lower-case with hyphens;
  local, `tls: optional`: TLS on 443/8448, plain otherwise). `net.open {tls}` carries the choice.
- **Chat ids:** Sara's ids can't hold `!`, so a room `!abc:server` is the chat `abc:server` (the plugin
  adds the `!` back).
- **Setup invite:** before anything is linked, step 3 makes the link code; while it waits, his invite is
  the setup's own (`bridge.who {invite: true}` → `setup`) and she joins it.
- **Buttons as reactions** (§6.9 approvals and the `/continue` ✅) are not built: only ⏹/❌ on the
  progress message (= Stop) and BR2's 👀. `/btw` answers in his room are not quoted.
- **Typing/receipts:** on in his two-person room only; the look-ups behind them don't count as skips.
- **Pictures for the steps** (the owner's run, §12) are not in the card yet: each step shows its exact
  path as a numbered list and a link to Element.
- **Line texts from the plugin** (the encrypted-room line) are English.

---

## 7. The guided setup cards (the exact screens) and plain-language diagnostics

All three use WHATSAPP §5.1's stepper (`web/setup-steps.js`): Settings → Connections → **iMessage**
(`co-imessage`) / **SMS** (`co-sms`) / **Matrix** (`co-matrix`). One step open at a time; the exact path
in bold; a picture of the screen with the spot circled (our own screenshots from the owner's run,
§12, ids blurred); the value to copy or paste; a check that runs as he pastes. A step is ✓ only when
Sara has **checked** it. *This screen looks different?* reports the step id (Phase 113). Steps live in
each plugin's `guide.json`. Before *Start*: what it is, how long, what he needs, and the terms box
(§9.6) with its tick.

### 7.1 iMessage (about 30–40 minutes, at the Mac)

**Before you start (in the card):** "You need a Mac that can stay on (any Mac from the last ten years
works; macOS 11 or newer is easiest), about 40 minutes at that Mac, and an email address for her new
Apple ID. **No Mac?** iMessage only works through a Mac. Try SMS or Signal instead." [B1, §2.4]

| # | Step (card title) | Exactly where | What he does | Sara's check (✓ when) |
|---|---|---|---|---|
| 1 | **Give her an Apple ID** | On any browser: **account.apple.com** → **Create Your Apple Account** → name *Sara*, a birthday, **an email address for her** (a new one; iCloud can make one later), a password, his own phone number for verification → the codes Apple sends | a new Apple ID for her | after step 4 (the account BlueBubbles reports isn't one of his handles) |
| 2 | **Give her a place on the Mac** | If the Mac is **his own** Mac: **System Settings → Users & Groups → Add User…** → *Standard*, name *Sara* → **Create User**; then  → **Log Out** and log in as *Sara* (or use fast user switching from the menu bar). If the Mac is a spare one, skip this. | a separate macOS user, so his own Messages stay his [B1 *Multiple users on the same Mac*] | — |
| 3 | **Sign her in to Messages and keep the Mac awake** | As *Sara* on the Mac: **Messages → Settings… → iMessage** → sign in with her Apple ID → tick her email under *You can be reached for messages at*. Then **System Settings → Energy** (laptops: *Battery → Options*) → **Prevent automatic sleeping when the display is off** on. | iMessage working on the Mac | step 5's `server/info` shows iMessage signed in |
| 4 | **Install BlueBubbles** | **github.com/BlueBubblesApp/bluebubbles-server/releases/latest** → the `.dmg` under *Assets* → in **Finder → Downloads**, **right-click → Open** (it's unsigned; Apple disabled the developer's account [B4]) → drag to **Applications** → open it → **Intro** → **Permissions**: **System Settings → Privacy & Security → Full Disk Access** → switch on *BlueBubbles* (Accessibility is not needed) → **Notifications**: Sara doesn't need phone notifications; continue without them if the screen allows (the owner's run records whether it does, §12) → **Connection**: type a **server password** and press the **floppy-disk icon** to save it [B4]; for *Proxy service* choose **Dynamic DNS / Custom URL** and leave the address empty (Sara talks to it directly) | the server password, pasted into the card (vault) | `GET /api/v1/ping?guid=…` answers |
| 5 | **Tell Sara where BlueBubbles is** | The card tries **this computer** first (`127.0.0.1:1234`, when Sara runs on this Mac). Otherwise: **the Mac's address**: on the Mac, **System Settings → Wi-Fi → Details… → IP address** (home network) or the **Tailscale menu → This Device** name (tailnet), and the card switches on *BlueBubbles runs on another computer on my network* (B3) | the address, typed or picked | `server/info` answers: "✓ BlueBubbles 1.9.x on macOS 15, signed in as sara.frank@icloud.com, Private API off (that's fine)"; `icloud/account` isn't his (`OWN_APPLE_ID` otherwise) |
| 6 | **Let BlueBubbles ring Sara** | — (Sara's side): the card shows which address BlueBubbles will use to reach Sara and presses **Ring** | nothing; on failure the card offers polling ("It works without this; answers take a few seconds longer.") | Sara registers the webhook (`POST /api/v1/webhook`) and BlueBubbles' `hello-world` event arrives: "✓ BlueBubbles reached Sara" |
| 7 | **Say hello from your iPhone** | **Messages → ✎ New message → To:** her email (the card shows it with a *Copy*) | *Link my iMessage* gives a code; he sends `/link 123456` | the message arrives, the link is made: "✓ Linked. Say hi to her." |
| 8 | **Test** | — | *Test* (§7.5) | all lines ✓ |

After that: optional cards **Let other people talk to her** (handles), **Group chats**, and **About
the Private API** (facts only, §2.3; no instructions to switch SIP off, §14 Q3).

### 7.2 SMS (about 10 minutes)

**Before you start:** "Gives her a US phone number through AgentText, a paid service with $5 of free
credit (about 100 texts after the number). You need an email address and a US mobile number. Sara
stops sending when this month's limit is reached." Plus AgentText's state when the check in §2.7 fails:
"AgentText isn't answering right now. Try again later." (no *Start* until it answers).

| # | Step | Exactly where | What he does | Sara's check |
|---|---|---|---|---|
| 1 | **Add SMS to Sara** | — | the review card: *Comes with Sara*; "Carries chats with her for sms"; "Connects to agenttext-api-production.up.railway.app (port 443, always encrypted)"; "Text only: no pictures or files"; "Costs money past AgentText's free credit" → *Install* | the plugin runs |
| 2 | **Set a spending limit** | — | *Spend at most per month* (default $2.00) | saved |
| 3 | **Make an AgentText account** | **agenttext.dev → Get started** → his name and email → **copy the API key now** ("Save this API key — it will not be shown again" [G2]) | paste the key (`atx_live_…`) into the card (vault) | `GET /v0/inboxes` answers `200`: "✓ Key works. Free credit: $5.00" |
| 4 | **Get her a number** | — (Sara's side) | an area code (optional) → **Get her a number** ("Uses $1.15 of your credit") | `POST /v0/inboxes {display_name: "Sara", area_code}` → "✓ Her number: +1 415 555 0142" (shown with *Copy* and a contact card to save on his phone) |
| 5 | **Text her from your phone** | his phone's Messages → new message → her number | *Link my phone* gives a code; he texts `/link 123456` | the `wait` returns it, the link is made, she answers once: "Linked. It's me, Sara. Texts cost a little; I keep answers short." |
| 6 | **Test** | — | *Test* | all lines ✓ |

### 7.3 Matrix (about 15 minutes)

| # | Step | Exactly where | What he does | Sara's check |
|---|---|---|---|---|
| 1 | **Make her a Matrix account** | **app.element.io** in a private browser window → **Create account** → server **matrix.org** (or *Edit* for his own) → username e.g. *sara-frank*, a password → the terms and CAPTCHA → **Sign out** afterwards | her MXID and password | — |
| 2 | **Log her in to Sara** | — | MXID + password → **Log her in** (the password is used once and not kept) | `GET /login` flows read; `/login` → `whoami` = her MXID: "✓ Logged in as @sara-frank:matrix.org (device *Sara (bot)*)" |
| 3 | **Make a room for the two of you, without encryption** | In **Element on the web or desktop**, as **himself**: **+** next to *Rooms* → **New room** → name *Sara* → keep *Private room* → switch **Enable end-to-end encryption** **off** ("You can't disable this later") → **Create room** → **Invite** → her MXID | a room with her invited | the invite reaches her (sync) and she joins: "✓ She joined *Sara*" |
| 4 | **Say hello** | in that room | *Link my Matrix* gives a code; he sends `/link 123456` (Element asks *Unknown command*: press **Send as message**; `Sara link 123456` also works) | linked: "✓ Linked" |
| 5 | **Test** | — | *Test* | all lines ✓ |

Element X (the newer mobile app) may not offer the encryption switch when creating rooms; the card
says "Do step 3 on a computer" (checked in the owner's run). If he starts a normal DM instead, she
answers with the encrypted-room line (§6.5), and the card's step 3 turns amber with *ENCRYPTED_ROOM*.

### 7.4 Plain-language diagnostics (`diagnose()`, per plugin)

One line each: **title**, then the fix, then buttons. *Details* shows the code and the platform's own
words (scrubbed).

**iMessage**

| Code | How Sara knows | What she says | Buttons |
|---|---|---|---|
| `BB_UNREACHABLE` | connect refused / timeout to the address | **Sara can't reach BlueBubbles at <address>.** Is the Mac on and awake, and BlueBubbles open? On another computer, check the address in step 5. | Check again · Show step 5 |
| `BB_PASSWORD` | `401` from `ping` | **BlueBubbles didn't accept the password.** Copy it again from BlueBubbles → Settings → *Server password*. | Paste the password |
| `MESSAGES_SIGNED_OUT` | `server/info` without an iMessage account | **Messages on the Mac isn't signed in to iMessage.** On the Mac: Messages → Settings → iMessage → sign in with her Apple ID. | Show step 3 |
| `OWN_APPLE_ID` | `icloud/account` matches his handles | **This Mac is signed in with your own Apple ID.** Sara would see all your chats and answer as you. Give her her own Apple ID and macOS user (steps 1–2). | Show step 1 |
| `NETWORK_SWITCH` | the address is on his network but the switch is off | **That address is on your network.** Switch on *BlueBubbles runs on another computer on my network*. | Switch it on |
| `TAILNET_OFF` | a 100.x address and this computer isn't on a tailnet | **That's a Tailscale address, but this computer isn't on Tailscale.** | — |
| `NO_DOORBELL` | `hello-world` never arrives | **BlueBubbles can't reach Sara, so she checks every few seconds instead.** That works; for faster answers put both on Tailscale. | Use polling · Try again |
| `MAC_ASLEEP` | three failed polls in a row after working | **The Mac seems asleep or BlueBubbles closed.** Keep it awake (step 3) and BlueBubbles open. | Show step 3 |
| `SEND_FAILED` | `message-send-error` / error answer | **iMessage didn't send this.** Is she still signed in on the Mac? It's in the app. | Open in the app |
| `NOT_IMESSAGE` | a handle that isn't on iMessage (green) | **That number isn't on iMessage, and Sara can only send blue messages.** | — |
| `HEIC` | a HEIC picture not converted | **She can't see HEIC photos yet.** iPhone: Settings → Camera → Formats → *Most Compatible*. | — |
| `PRIVATE_LOCAL` | private local mode | **Paused: "Nothing leaves this computer" is on.** Messages wait on the Mac; she reads them when it's off. | Settings |

**SMS**

| Code | How Sara knows | What she says | Buttons |
|---|---|---|---|
| `SERVICE_DOWN` | the host answers Railway's "Application not found", or no connection | **AgentText isn't answering.** It may be down; Sara tries again every few minutes. | Check again |
| `KEY_WRONG` | `401 auth_error` | **AgentText didn't accept the key.** Keys are shown once; if it's lost, make a new account or ask AgentText. | Paste a new key |
| `NO_CREDIT` | `402 payment_required` | **Your AgentText credit is used up.** Add credit or a plan on agenttext.dev; she keeps your messages in the app meanwhile. | Open AgentText |
| `PLAN_LIMIT` | `403 forbidden` | **Your AgentText plan doesn't allow that** (the free plan has one number). | Open AgentText |
| `CAP_REACHED` | B6 | **This month's limit for texts is used up.** She'll text again on the 1st, or raise the limit. | Raise the limit |
| `OPTED_OUT` | his own STOP / `opt_out_detected` | **You texted STOP, so the phone company blocks her texts to you.** Text START to her number. | — |
| `RATE_LIMITED` | `429` | **AgentText asked Sara to slow down.** | — |
| `NUMBER_GONE` | the inbox `404`s | **Her number is gone from AgentText** (deleted, or the account changed). | Get her a number |

**Matrix**

| Code | How Sara knows | What she says | Buttons |
|---|---|---|---|
| `HS_NOT_FOUND` | no `.well-known`, no `/versions` | **Couldn't find a Matrix server for <server>.** Check the part after the colon in her Matrix ID. | Show step 1 |
| `NO_PASSWORD_LOGIN` | `/login` flows lack `m.login.password` | **Her server doesn't take passwords from apps.** Approve Sara in the browser instead, or paste an access token. | Approve in the browser · Paste a token |
| `LOGIN_WRONG` | `403 M_FORBIDDEN` on `/login` | **Wrong Matrix ID or password for her account.** | Try again |
| `TOKEN_GONE` | `401 M_UNKNOWN_TOKEN` | **Her login ended** (someone logged that session out). Log her in again. | Log her in again |
| `ENCRYPTED_ROOM` | `m.room.encryption` in his room | **That room is encrypted, so she can't read it.** Make a new room with encryption off (step 3). | Show step 3 |
| `NOT_INVITED` | no invite 2 minutes after step 3 | **She hasn't been invited yet.** In the room: *Invite* → her Matrix ID. | Copy her Matrix ID |
| `RATE_LIMITED` | `429 M_LIMIT_EXCEEDED` | **Her server asked her to slow down.** She'll send the rest shortly. | — |
| `MEDIA_TOO_BIG` | over `m.upload.size` | **That file is bigger than her server allows** (<n> MB). It's in the app. | — |

### 7.5 What *Test* does

One press, a checklist, the first failing line opened with its diagnosis, **nothing sent to anyone**
(*Send me a test message* is separate; on SMS it says what it costs first). iMessage: plugin running →
BlueBubbles reachable → password → Messages signed in → not his Apple ID → doorbell or polling →
Private API state (info only) → linked. SMS: plugin running → AgentText answering → key → number
active → credit left / plan → this month's spend vs the limit → linked → not opted out. Matrix: plugin
running → homeserver found → token valid (`whoami`) → sync running → his room joined and **not
encrypted** → linked → media limit read.

---

## 8. Tables, routes, UI and ? tips

### 8.1 Tables (additive)

`store.db` of the companion the plugin runs for, one new table:
```sql
CREATE TABLE IF NOT EXISTS bridge_spend (
  bridge TEXT NOT NULL,        -- 'plugin-sms' (any plugin with ready.bridge.cost)
  day TEXT NOT NULL,           -- YYYY-MM-DD in the owner's time zone
  units INTEGER NOT NULL,      -- segments sent that day (from bridge.sent.units, else Sara's estimate)
  cents INTEGER NOT NULL,      -- estimated cost in cents (price table × units, plus one-off costs like a number)
  sends INTEGER NOT NULL,      -- messages sent
  PRIMARY KEY (bridge, day)
);
```
Existing tables, new values: `bridge_identities` (`plugin-imessage`: his handles, linked-at;
`plugin-matrix`: his MXIDs); `bridge_skips` reasons `unknown-id` (a doorbell for a message that
doesn't exist), `encrypted`, `stranger-invite`, `opt-out`, `over-cap`, `own-apple-id`, `from-me`;
`rooms` with `bridge = 'plugin-imessage'` / `'plugin-matrix'` (CH4, unchanged schema).

The owner's database, ST7's `hooks`: no new columns (WhatsApp's `owner_plugin` and `verified_at`
cover it); `verify` takes `url` and `standard` for bridge hooks (B1). `bridge_spend` rows are kept 400
days (a year of monthly totals), the rest as today.

### 8.2 Routes (owner only; `plugins` and `hooks` are not member route families, as today)

The WhatsApp routes become generic per plugin in 2.55.0 (`/api/plugins/:id/setup`, `/check`, `/fix`,
`/webhook`), so these plugins add **no new route families**:

- `POST /api/plugins/install {builtin: 'imessage' | 'sms' | 'matrix'}` → the review card (P3).
- `GET /api/plugins/:id/setup?companion=` → the stepper state (`{steps, …}` as WHATSAPP §6.2), plus per
  plugin: iMessage `{server: {address, version, privateApi, account}, doorbell: 'ok' | 'polling'}`, SMS
  `{number, credit, plan, month: {units, cents, cap}, optedOut}`, Matrix `{mxid, homeserver, rooms:
  [{id, name, encrypted, place}]}`.
- `POST /api/plugins/:id/check {companion, step}` → one step's check through the plugin
  (`bridge.check`), `{ok, diagnosis?}`, 20 s, read-only calls only.
- `POST /api/plugins/:id/fix {companion, fix}` → the one-tap actions, each confirmed first: iMessage
  `doorbell` (create or recreate the BlueBubbles webhook) and `polling`; SMS `number` (`POST
  /v0/inboxes`, shows the $1.15 first); Matrix `login {mxid, password}` (the password excluded from
  the access log like a PIN, never stored), `logout`, `join {room}`, `leave {room}`.
- `POST /api/plugins/:id/webhook {companion, kind}` → the bridge hook for kinds `url` (iMessage, made
  automatically in step 6) and `standard` (SMS, *Advanced*, with the pasted secret).
- `PUT /api/plugins/sms/cap {companion, dollars}` → the monthly cap (core setting; 0–100, default 2).
- Existing, reused: `POST /api/plugins/:id/link`, `DELETE /api/plugins/:id/link/:chat`, `POST
  /api/plugins/:id/test`, `GET /api/plugins/:id/bridge`, `POST /api/plugins/:id/group`, `/leave`.
- Public: `POST /hook/<id>.<secret>` only if he turns on SMS's optional webhook (through the door).
  The iMessage doorbell uses the same `/hook/` route but is reached on his own network.

### 8.3 UI at 1440 and 390

**Settings → Connections** gains three rows under WhatsApp (*iMessage*, *SMS*, *Matrix*), each with its
status chip; the list stays in the order of the CH2 projects. Nothing about them appears anywhere
else until one is connected.

**1440 × 900, iMessage, before it's connected.** The WhatsApp layout (WHATSAPP §6.3): stepper left
(≈ 560 px), the screen picture right (≈ 420 px).

```
┌ iMessage ···················································· [Not set up] ┐
│ ┌ Set up iMessage ─────────────────── 4 of 8 ┐ ┌ The screen you need ────────────┐ │
│ │ ✓ 1 Give her an Apple ID                   │ │ [picture: BlueBubbles Connection │ │
│ │ ✓ 2 Give her a place on the Mac            │ │  screen, password + floppy disk  │ │
│ │ ✓ 3 Sign her in to Messages, keep awake    │ │  circled]                        │ │
│ │ ● 4 Install BlueBubbles                    │ │ github.com/BlueBubblesApp/…      │ │
│ │   Finder → Downloads → right-click → Open  │ │ [Open the download page ↗]       │ │
│ │   … Connection → server password → 💾      │ │ This screen looks different?     │ │
│ │   Server password [••••••••••••]  ?        │ └──────────────────────────────────┘ │
│ │   ✓ BlueBubbles answered (1.9.x)           │ ┌ Good to know ────────────────────┐ │
│ │   [Next]                                   │ │ Needs a Mac that stays on.       │ │
│ │ ○ 5 Tell Sara where BlueBubbles is         │ │ Works without the Private API.   │ │
│ │ ○ … 8 Test                                 │ │ Apple's rules: [read the box]    │ │
│ └────────────────────────────────────────────┘ └──────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**1440, iMessage connected:** the summary card "sara.frank@icloud.com on *Mac mini* · Connected (basic) ·
linked to you · doorbell ✓", *Test*, *Send me a test message*, *Unlink*; then the shared v1.2 cards
(**Who can reach her**, **Group chats** with *Answer here* / *Keep up* / *Leave*, **Commands**,
**Pictures and files** with the HEIC tip, **While she works** showing basic vs Private API with a ?,
**Her messages first**, **Today**, **Advanced**: address, port, polling seconds, the doorbell's
address with *Ring again*).

**1440, SMS:** the stepper is short (6 steps), so the right column shows the **cost panel** from the
start: credit left, this month's texts and dollars as a thin bar against the limit, the price table
("Free plan: $0.05 a text after the credit. Builder: $29/month for 2,000.") and *Spend at most per
month* [$2.00] ?. Connected: the summary "+1 415 555 0142 · linked to you · $0.40 of $2.00 this month",
*Trust texts from my number* (off, with the red ? warning), *Longest reply* [3 texts], *Allow emoji
(costs more)*, the STOP banner when it applies.

**1440, Matrix:** stepper (5 steps) left; right: the picture for step 3 (Element's *New room* dialog
with the encryption switch circled) and *Good to know*: "Rooms with her are not end-to-end encrypted."
Connected: "@sara-frank:matrix.org · Connected · linked to you in *Sara*", the **Rooms** card (each room:
name, members count, place, *Answer here* / *Keep up* / *Leave*; encrypted ones greyed under *Rooms she
can't read*), *Log her out*.

**390 × 844 (phone).** As WHATSAPP §6.3: one column, the head keeps the chip, the open step expands in
place with its picture above the fields (tap to zoom), the path as a wrapping bold breadcrumb, fields
full width with ? popovers, a sticky *Back · Next* bar above the safe area, 44 px *Copy* targets. Per
app: iMessage says at the top "Do this at the Mac" with *Send these steps to my email* (a `mailto:`);
SMS's cost panel sits **above** the stepper as a compact two-line bar ("$3.85 credit · $0.40 of $2.00
this month"); Matrix's step 3 says "Easier on a computer: Element's mobile app may not let you switch
encryption off." Connected: summary first, shared cards stacked, *Advanced* folded.

**The chat itself:** sessions file into the *iMessage*, *SMS* and *Matrix* channel projects (CH2). The
session's info panel says "From iMessage (basic)", "From SMS · 23 texts this month", "From Matrix ·
room *Sara*, not encrypted". A reply that wasn't sent shows a quiet line under it ("Not sent by text:
the monthly limit is used up. It's here.").

### 8.4 ? tips (every setting; each ≤ 260 characters)

iMessage:
- *BlueBubbles address*: "Where BlueBubbles runs. 127.0.0.1 if Sara runs on the same Mac; otherwise the
  Mac's address on your home network or its Tailscale name."
- *BlueBubbles port*: "BlueBubbles listens on 1234 unless you changed it in its settings."
- *BlueBubbles runs on another computer on my network*: "Lets Sara talk to BlueBubbles on another
  computer at home or on your Tailscale network. Never anything on the internet."
- *BlueBubbles server password*: "The password you saved in BlueBubbles' Connection step. Kept encrypted in
  Sara's vault. Anyone with it can read and send her messages."
- *Send read receipts (Private API only)*: "Shows 'Read' under your messages when she has them. Only works
  if BlueBubbles' Private API is on."
- *Send reminders and messages she starts to my iMessage too*: "Her reminders and messages she starts also
  come to Messages on your iPhone. Only to you."
- *Check for messages every*: "Only used when BlueBubbles can't ring Sara. Lower is faster but asks the Mac
  more often."
- *What's the Private API?* (card): "A BlueBubbles add-on for typing dots, tapbacks and edits. It needs a Mac
  security feature (SIP) turned off. Sara works without it and never asks you to turn SIP off."

SMS:
- *AgentText API key*: "The key AgentText showed once when you signed up (starts with atx_live_). Kept
  encrypted in Sara's vault. Anyone with it can text from her number and spend your credit."
- *Her inbox*: "Her number's id at AgentText. Sara fills this in when you press Get her a number."
- *Area code for her number*: "Optional. A US area code, so her number looks local to you (415, 212…)."
- *Longest reply (texts)*: "Each text is about 150 letters and costs money. Longer answers are cut and the
  rest stays in the app. 3 is a good start."
- *Allow emoji (costs more)*: "One emoji makes a text hold 70 letters instead of 160, so replies cost about
  twice as much. Off by default."
- *Partners' texts may cost money*: "When off, people you allow get one short note that she only texts
  with you, and nothing else. When on, she answers them and it counts toward your limit."
- *Spend at most per month* (core): "Sara stops texting when this much is used this month and keeps
  answers in the app. Estimated from AgentText's prices; their bill is what counts."
- *Trust texts from my number* (core): "Text messages can be faked to look like they come from your number.
  When off, she asks in the app before using tools for a text. Turn on only if you accept that risk."
- *Send reminders and messages she starts to my phone too*: "Her reminders also come by text. Each one
  costs a text and counts toward your monthly limit."
- *Text service*: "The company that gives her a phone number. Only AgentText for now."
- *AgentText API host*: "Where AgentText's service lives. Leave it unless AgentText or a Sara update says
  it moved."

Matrix:
- *Her Matrix ID*: "Her own account, like @sara-frank:matrix.org. Make a separate account for her, not
  your own."
- *Her homeserver*: "The server her account lives on. Sara finds it from her Matrix ID; change it only if
  your server uses a different address for apps."
- *My homeserver runs on my network*: "Turn on if her account is on a Matrix server in your home or on your
  Tailscale network, not on the internet."
- *Access token*: "Her login key, made when you pressed Log her in (her password isn't kept). Kept encrypted
  in Sara's vault."
- *Show typing*: "Shows '<her name> is typing…' in your room while she works. Only in your room with her."
- *Send read receipts*: "Shows that she has read your message. Only in your room with her."
- *Send reminders and messages she starts to my Matrix room too*: "Her reminders also come to your room with
  her. Never to other rooms."

Shared (core, every plugin, as on Signal): *Let other people talk to her*, *Who may talk to her* (per app:
handles / numbers / Matrix IDs or @servers), *Owners can use her tools in groups*, *Answer when her name
is said*, *Keep up with this group/room*: the Phase 117 tips with the app's word for its people and
places.

---

## 9. Security, safety and household isolation

### 9.1 Credentials

- **BlueBubbles password** → vault `plugin:imessage:password` (a `secret` setting), write-only, reaches
  the plugin in `init.secrets`, added to the `guid` query parameter by `http1.mjs` at send time only.
  Because BlueBubbles takes it **in the URL** [B2], every URL the plugin logs, reports or puts in a
  diagnosis is cut at `?`; the vault's values are in `opts.scrub` as for every plugin. On the home
  network the request travels in plain HTTP: the card says so ("On your home network the password
  travels unencrypted; Tailscale or running Sara on the same Mac avoids that") and recommends either.
  BlueBubbles' own HTTPS (a certificate he made with certbot [B1]) works with `tls: optional` when the
  certificate is valid for the name he typed.
- **AgentText key** → vault `plugin:sms:apiKey`, TLS-only, scrubbed; the `atx_live_[A-Za-z0-9]{8,}`
  shape added to `KEY_SHAPED` so it is refused in ordinary settings and masked in logs. *Paste a new
  key* doesn't revoke the old one at AgentText (no documented revoke); the card says to contact
  AgentText to cancel a leaked key.
- **AgentText webhook secret** (optional) → `webhook:<id>`; only Sara's `standard` check reads it.
- **Matrix token** → vault `plugin:matrix:token` (+ `:refresh`), TLS-only on `hs`; **the password is
  never stored** (sent once to `/login`, excluded from the access log). *Log her out* revokes the token
  at the homeserver (`POST /logout`), which is a real revoke.
- **The URL secret** of each bridge hook is the ST7 one (hashed; `404` when wrong).
- **Settings never hold a credential:** pasting a key-shaped value into *BlueBubbles address*, *Her
  inbox* or *Her Matrix ID* is refused with the field to use instead.

### 9.2 Strangers, partners and prompt injection

- **No tools from strangers, ever**: iMessage strangers get one hello line once; SMS strangers get
  nothing (cost); Matrix strangers' invites are declined and in shared rooms they are room members
  without tools.
- **Owner powers need proof**: iMessage = his linked handle (Apple-authenticated); Matrix = his linked
  MXID (homeserver-authenticated); SMS = his number, **weak**, so untrusted by default (B7, §5.4).
- **Doorbells carry no content** (B2): a forged BlueBubbles webhook can at most make the plugin ask
  BlueBubbles about an id.
- **Forwarded and quoted text** (an iMessage forward is just text; Matrix replies carry the quoted
  event's fallback) is fenced as `FORWARDED` / quoted where the platform marks it, and makes the turn
  `meta.untrusted` (Phase 117's rule).
- **Room keep-up** (CH4) in iMessage groups and Matrix rooms keeps the existing rules: off by default per
  room, lines fenced as others' words, never treated as instructions.
- **Matrix HTML in** (`formatted_body` from others) is never rendered or trusted; the plugin uses `body`.
  **HTML out** is built escape-first (§6.9).

### 9.3 The mandatory safety layer

Untouched and on every new path: the AI disclosure first in a new partner chat and every 3 hours (on
SMS it is inside the one joined message, `oneMessage`), honesty when sincerely asked; crisis resources
(a crisis line from him or a partner gets them on every app; on SMS the crisis text is **never cut** by
`textBudget` and never blocked by the spending cap: crisis help always sends, and its cost is still
counted); the minors block (`minorSexualMatch` on every incoming text, caption, voice transcript and
outgoing reply; `MINOR_BLOCK_REPLY`); no adult content on any of the three (`adult: false`, as for every
plugin bridge); BR1's describe-first for partners' pictures. Her Matrix display name is "Sara (AI)"
and her iMessage contact card name (set by him in step 1) is suggested as "Sara (AI)". Nothing in this
phase can turn any of it off.

### 9.4 Household isolation

- **One companion per account**: each plugin can be on for one companion at a time (Phase 117's rule).
  A second companion needs her own Apple ID (and macOS user, and BlueBubbles server on another port),
  her own AgentText inbox (the same key can hold several inboxes; the plugin skips the other inbox),
  her own Matrix account.
- **Each companion's own data**: conversations, `bridge_spend`, `bridge_identities`, `bridge_skips`,
  rooms; plugin folders `plugin-data/<plugin>/<companion>/`; the spending cap is per companion.
- **Members** never see plugins, hooks or spend (owner-only routes); a member's handle/number/MXID on an
  allow-list is just a partner and can't link as owner.
- **Other apps** (`/v1`, MCP, A2A, automations) never see these conversations; the bridge hooks'
  deliveries never reach `event:webhook` hooks.

### 9.5 Private local mode and the network guard

- **Private local mode on** → P1 refuses and closes every socket of all three plugins (iMessage too:
  iMessage goes through Apple's servers even when BlueBubbles is on this Mac; Matrix too, even with a
  home homeserver, because federation carries the room off the computer). The chips say *Paused
  (Nothing leaves this computer)*. Nothing is lost: Messages keeps messages on the Mac (catch-up reads
  them), AgentText keeps them (the list call reads them), Matrix keeps them (sync resumes from
  `next_batch`). Messages older than 24 hours when the mode turns off are filed, not answered.
- **The network guard** sees every connection (P1 calls `checkOutbound`); a guard rule that blocks a host
  shows in *Test* ("Your network rules block matrix-client.matrix.org").
- **The demo** refuses all three plugins.

### 9.6 The terms boxes (shown before *Start*, and in each connected card's footer)

> **About Apple and BlueBubbles.** iMessage has no official way for apps like Sara to use it.
> BlueBubbles is a free, open-source app that is **not made or approved by Apple**; it works the
> Messages app on your Mac for you. Use it on **your own Mac**, with **a separate Apple ID for her**,
> and keep her to you and people you choose. Apple's software licence forbids using it to spam or
> harass anyone, and Apple can lock an Apple ID that misbehaves. Sara never asks you to turn off your
> Mac's security (SIP). ☐ *I understand and want to continue.*

> **About AgentText and costs.** AgentText is a paid service that gives her a US phone number. Texts
> cost money after the free credit; Sara stops at your monthly limit. AgentText says it handles the
> phone companies' rules for business texting. Texts are not encrypted: AgentText and the phone
> companies can read them. AgentText has not published terms of service or a privacy policy yet.
> ☐ *I understand and want to continue.*

> **About Matrix.** Her room with you is **not end-to-end encrypted**, so whoever runs the servers
> (matrix.org, or yours) can read it. Use a separate account for her, and follow your server's rules.
> ☐ *I understand and want to continue.*

Each tick is stored with its date and the box's version; a changed box asks again (WHATSAPP §7.6).

### 9.7 Threat model additions (`docs/THREAT_MODEL.md` in each release)

| Threat | Defence |
|---|---|
| A forged BlueBubbles webhook (someone on his network found the URL) | URL secret (`404`), and the doorbell rule: ids only, each fetched from BlueBubbles with the password before use |
| The BlueBubbles password sniffed on the home network | the card's recommendation (same Mac or tailnet), HTTPS when he has a certificate; the password only reads/sends her Apple ID's messages, not his |
| Sara reading his own iMessages | `OWN_APPLE_ID` refusal; her own Apple ID and macOS user in the guide |
| A faked SMS from his number | `auth.level: weak` → untrusted turns, no settings commands by text |
| A stranger texting her number to run up costs | no replies to strangers; partners cost only with his switch; the monthly cap; hourly/daily send caps |
| A loop between her and another bot | her own messages skipped (`isFromMe`, own MXID); send caps; the loop guard |
| An AgentText outage or shutdown | messages wait or are lost at AgentText (not Sara's); the chip says so; the plugin can be removed in one tap |
| A leaked Matrix token | revoke with *Log her out*; scrubbed; TLS-only |
| Encrypted rooms quietly unread | explicit line once, listed on the card |
| HTML injection in Matrix messages | `body` only in; escape-first HTML out |
| Over-reach by the Mac app route (later) | not built here; its own design with the permission blast radius (§4.13) |

---

## 10. Reuse vs build

| Reused as is | Grown | New |
|---|---|---|
| `#bridgeInbound` / `#bridgeTake` / `#bridgeTurn`, CH1, CH2 (`PLUGIN_NAMES` has all three), CH4 rooms and keep-up, BR1 media and quotas, BR2 queue and `btw.ts`, P4 link codes, P5 edit budget, P6 long turns, Phase 118–119 commands | `ensureBridgeHook(…, {kind})` with `url` (doorbell only) and `standard` (B1); mode `bridge` passes ids-only for doorbells (B2) | `plugins/imessage/` (`main.mjs`, `bb.mjs` REST client, `poll.mjs`, `format.mjs`, `checks.mjs`, `diagnose.mjs`, `guide.json`, `http1.mjs`, `sara-plugin.mjs`) |
| P1 broker (`net.ts`), its loopback test override, `checkOutbound`, private local mode | `addressAllowed`: tailnet ranges under `onOtherMachine` (B3); `tls: 'optional'` for `local` endpoints | `plugins/sms/` (`main.mjs`, `agenttext.mjs`, `segments.mjs` GSM-7/UCS-2 counter, `keywords.mjs`, `checks.mjs`, `diagnose.mjs`, `guide.json`, …) |
| WHATSAPP W3 `http1.mjs` (copied byte-equal), W6 `diagnose()` pattern, `web/setup-steps.js`, generic `/api/plugins/:id/{setup,check,fix,webhook}` | `http1.mjs`: long-poll timeouts and plain HTTP (B4), query-secret scrubbing | `plugins/matrix/` (`main.mjs`, `cs.mjs` client-server calls, `sync.mjs`, `html.mjs` escape-first Markdown, `checks.mjs`, `diagnose.mjs`, `guide.json`, …) |
| `bridge_identities`, `bridge_skips`, the v1.2 settings window, the Signal group list (*Answer here*, *Leave*) | `bridge.inbound.auth.level` + untrusted weak senders (B7); `ready.bridge.cost` + `bridge.sent.units` (B6); `ready.bridge.buttons: 'reactions'` (Matrix) | `bridge_spend` + the cap check; `co-imessage`, `co-sms`, `co-matrix` pages (data for the stepper) |
| `partnerNote`, `disclosureDue`, `minorSexualMatch`, `fenceLines`, `meta.untrusted`, `KEY_SHAPED`, vault | `KEY_SHAPED` + `atx_live_`; the per-channel style hint for SMS | the guide pictures (`docs/screenshots/{imessage,sms,matrix}/`, ours, ids blurred) |

Nothing needs an npm package: HTTP/1.1 and multipart by hand (already in W3), JSON, a GSM-7 table
(~40 lines), an escape-first Markdown-to-HTML converter (~150 lines), RFC 8628 device polling (~60
lines, only if Q18 says build it).

---

## 11. Done when (one test file per release, plus every existing suite green)

Common to all three: the real plugin process from `plugins/<id>`, a fake model that records what it was
sent, a fake clock, and stand-in servers on `127.0.0.1` started by the test, reached through P1's
existing test-only loopback override (`netTestLoopback` under `node --test`; HTTPS stand-ins use a
test CA). No test touches the internet. Recorded real answers (from the owner's run, §12) live in
`test/fixtures/<app>/` with ids and secrets replaced.

### 11.1 `test/phase122b.test.ts`: Matrix (2.55.1)

**Stand-in homeserver** (`test/fixtures/matrix/hs.mjs`, HTTPS): `/.well-known/matrix/client`,
`/_matrix/client/versions`, `GET|POST /login` (password flow on/off by switch), `/account/whoami`,
`/user/<me>/filter`, `/sync` (long-polls up to `timeout`, serves scripted batches: invites incl. one
with `m.room.encryption` in stripped state, messages, images, voice, reactions, redactions, an
encrypted event), `/join`, `/rooms/<r>/leave`, `PUT …/send/<type>/<txn>` (records, dedupes by txn),
`PUT …/typing/<me>`, `POST …/receipt/m.read/<e>`, `POST /_matrix/media/v3/upload`, `GET
/_matrix/client/v1/media/download/<s>/<id>` (bearer required), `/media/config`, `/logout`; can answer
`429 M_LIMIT_EXCEEDED` with `Retry-After`, `401 M_UNKNOWN_TOKEN`, and drop the connection mid-sync.

- **Login:** MXID + password → one `/login` with `initial_device_display_name: "Sara (bot)"`; the token
  is in the vault, the password appears in **no** log, table, settings file or access-log line; a
  server without the password flow → `NO_PASSWORD_LOGIN`; a pasted token works; *Log her out* calls
  `/logout` and empties the vault entries.
- **First sync:** history in the first batch is **not** answered; only later events are.
- **Invites:** from his MXID → joined; from a stranger → left, `stranger-invite` counted; with
  `m.room.encryption` → joined, the one encrypted-room line sent, left; `ENCRYPTED_ROOM` on the card.
- **Linking and turns:** `/link 123456` and `Sara link 123456` link; an owner message → one turn on
  `plugin-matrix` in the *Matrix* project; typing `PUT` before, renewed every 25 s of a 70-s turn,
  `false` after; a read receipt on his event; her own events in sync never start a turn.
- **Progress:** a 3-minute fake turn → one progress event and edits (`m.replace`, `* ` fallback) ≤ 1
  every 3 s and ≤ 30, the final answer as a new event, the last edit = the *Done* summary; his ⏹
  reaction on the progress event stops the turn.
- **Steer and `/btw`:** his message mid-turn → a 👀 `m.annotation` on it, taken at the safe point;
  `/btw` → an `m.in_reply_to` reply.
- **Rooms:** a room message without mention → not answered (logged only when keep-up is on); with
  `m.mentions.user_ids` = her → answered as `room`; him with `workInGroups` → `work-room` with tools; a
  partner MXID with `others` on → partner rules, no tools offered, AI notice first; `@server` allow
  entries match.
- **Media:** his `m.image` → authenticated download with the bearer → the fake model's message carries
  it; over `m.upload.size` → `MEDIA_TOO_BIG`; her picture out → upload then `m.image` with `info`;
  `m.audio` voice → `hearNote`.
- **HTML out:** a model reply containing `<script>`, `<img onerror>` and Markdown → `formatted_body` has
  the Markdown as tags and the HTML **escaped**.
- **Pace:** 10 queued messages → ≤ 5 at once then ≤ 1 a second; one `429` with `Retry-After: 2` → waits
  2 s, order kept; `M_UNKNOWN_TOKEN` → `TOKEN_GONE`, sync stops, *Needs you* once.
- **B3:** a homeserver on a 100.64.x address with `onOtherMachine` on and the (faked) tailnet up →
  allowed; tailnet down → refused with `TAILNET_OFF`; public endpoint `hs` can't reach a private one.
- **B4:** `http1.mjs` copies in `plugins/whatsapp`, `plugins/matrix` (and later the other two) are
  byte-equal; a 40-s long-poll isn't cut at the default 30 s.

### 11.2 `test/phase122c.test.ts`: iMessage through BlueBubbles (2.55.2)

**Stand-in BlueBubbles** (`test/fixtures/imessage/bb.mjs`, plain HTTP on loopback, and once over a
test-CA HTTPS): `GET /api/v1/ping`, `/server/info` (Private API on/off, signed in or not), `/icloud/account`,
`POST /message/query` (`after`, `limit`), `GET /message/<guid>`, `POST /message/text` (requires
`tempGuid` for `apple-script`), `POST /message/attachment` (multipart), `GET /attachment/<guid>/download`
(JPEG or HEIC fixture), `POST|DELETE /chat/<guid>/typing`, `POST /message/react`, `POST
/message/<guid>/edit`, `POST /chat/<guid>/read`, `GET|POST|DELETE /webhook`; the `guid` query password
required everywhere (`401` otherwise); a **ringer** that POSTs `{type, data}` webhooks to whatever URL
was registered, exactly as unsigned JSON, and can send a forged one with a made-up guid.

- **Doorbell (B1, B2):** step 6 creates a `url` bridge hook and registers it with `POST /webhook`; the
  `hello-world` ring marks it ✓. A ring for a real guid → the plugin gets **only** `{event, ids}` (the
  test asserts the plugin's stdin never contains the message text) → fetches `GET /message/<guid>` →
  one turn. A forged ring (unknown guid) → `unknown-id` skip, no turn. A ring for an `isFromMe`
  message → `from-me` skip. The hook's log has no bodies.
- **Polling and catch-up:** no doorbell → `message/query` every 5 s while active, 30 s idle; plugin
  restarted after 3 fake minutes → the missed messages are taken once, in order; a 25-hour-old one is
  filed, not answered.
- **Password:** wrong → `BB_PASSWORD`; the password appears in no log line, diagnosis, `bridge.status`
  or error text (grep across the plugin log and Sara's logs for the fixture password finds nothing).
- **Own Apple ID:** `icloud/account` equal to a linked handle → `OWN_APPLE_ID`, plugin refuses to run.
- **Basic mode:** Private API off → no typing/react/edit calls ever; a 3-minute turn → one working line
  at 20 s ("… Send /stop to stop.") and the reply; a steer → a "👀 got it" line.
- **Private API mode:** on → typing every 20 s and `DELETE` on reply; a steer → `react`; progress via
  `edit` ≤ 4 times, none after 15 fake minutes; `/btw` → `selectedMessageGuid`.
- **Places:** a group without her name → not answered; "Sara, …" → answered as `room`; a stranger's DM →
  one hello, then nothing; a partner handle with `others` on → partner turn, no tools.
- **Media:** a JPEG attachment → the model sees it; a HEIC one the stand-in doesn't convert → filed as a
  document with the HEIC line once; her PDF out → one multipart `message/attachment`.
- **Commands:** `/link` from his iPhone fixture links; smart quotes and `—` normalised before
  `parseCommand`; `yes` resolves the open approval in his DM only.
- **B3:** BlueBubbles on 192.168.x with the switch off → `NETWORK_SWITCH`; on → allowed.
- **Pace:** 10 sends queued → ≤ 4 at once, then ≤ 1 every 2 s; over 150 an hour → held with one notice.
- **Private local mode** → sockets closed, chip paused; off → catch-up delivers.

### 11.3 `test/phase122d.test.ts`: SMS through AgentText (2.55.3)

**Stand-in AgentText** (`test/fixtures/sms/agenttext.mjs`, HTTPS, test CA): `GET|POST /v0/inboxes`,
`GET /v0/inboxes/<id>`, `POST /v0/inboxes/<id>/messages` (returns `segments` computed the GSM-7/UCS-2
way), `GET /v0/inboxes/<id>/messages?direction=inbound&limit=`, `POST /v0/inboxes/<id>/wait` (holds up to
`timeout`, `408` on timeout), a credit counter that answers `402` at zero, `403` for a second inbox on
the free plan, `429` on demand, and a *Railway* mode that answers `404 {"message":"Application not
found"}` to everything. A **Standard Webhooks sender** signs fixtures with a `whsec_` secret.

- **Setup:** the key → `GET /v0/inboxes` ✓; *Get her a number* → one `POST /v0/inboxes` after the
  $1.15 confirmation; Railway mode → `SERVICE_DOWN` and no *Start*.
- **Long-poll:** `wait` loops with `timeout: 50`; a burst of 3 messages → all 3 taken once (list call
  after each hit, dedupe by `message_id`), in order.
- **Weak identity (B7):** his linked number → an owner turn marked `meta.untrusted` (a tool set to run on
  its own **asks**); `/model` by text → "Do that from the app; texts can be faked."; with *Trust texts
  from my number* on → normal owner turn.
- **Strangers and partners:** a stranger → no send at all, `stranger` counted; a listed partner with
  *Partners' texts may cost money* off → the one note, then nothing; on → a partner turn, AI notice in
  the same message.
- **STOP:** `STOP` alone from a partner → no `/stop`, number muted, nothing sent to it again; `stop` from
  him → the opted-out banner, nothing sent; `/stop` from him mid-turn → the turn stops; `HELP` alone →
  the fixed answer without a model call; the name form never fires on SMS.
- **Short replies:** a 2,000-character model reply → one send ≤ `textBudget` segments ending "(more in
  the app)"; curly quotes and `—` normalised; an emoji with *Allow emoji* off → removed, segments stay
  GSM-7; the crisis text with a tiny budget → **sent whole**.
- **Money (B6):** `bridge_spend` counts the stand-in's `segments`; at the $2 cap → the next reply is
  **not sent**, kept in the app with the note, `CAP_REACHED` once; a crisis reply over the cap → sent and
  counted; `402` → `NO_CREDIT`, no retry loop; the cap can't be changed by the plugin (a hostile plugin
  fixture writing `spendCap` gets `403`).
- **Webhook mode (if built, §12):** a `standard` bridge hook verifies `webhook-signature` on raw bytes;
  wrong signature → `401`, nothing reaches the plugin; a timestamp 10 minutes old → refused.
- **Pace:** 5 replies queued → ≤ 1 every 3 s; over 60 an hour → held with one notice.

### 11.4 Every release

- v1, v1.1 and v1.2 plugins without the new fields (LINE example, Signal, Email, WhatsApp) behave exactly
  as before; GitHub, Stripe, Standard, header, URL and Meta hooks answer exactly as before.
- Members get `403` on every route of §8.2; switching a plugin on for a second companion is refused;
  the demo refuses all three.
- Safety unchanged on each app: a crisis line gets the resources; a minors-block line (text, caption or
  transcript) → `MINOR_BLOCK_REPLY`; the disclosure comes first in a new partner chat.
- The release's docs ship in the same commit (§15).

---

## 12. Owner to-dos

1. **Answer §14 Q1** (ship SMS through AgentText at all, given its state). Then:
2. **Matrix (before 2.55.1):** make a bot account on matrix.org (or his server) and do §7.3 exactly as a
   beginner would, timing it; note every place the card's words don't match Element's screens (web,
   desktop, Element X on the phone: does *New room* offer the encryption switch?); check whether
   Element sends `/link` after *Send as message*. Screenshots for the guide come from this run.
3. **iMessage (before 2.55.2):** on a Mac that can stay on: a new Apple ID for her, a macOS user, Messages
   signed in, BlueBubbles installed (§7.1), timing it. Record: whether BlueBubbles' *Notifications* step
   lets him continue without Firebase; what *Proxy service* must be set to for local-only use; whether
   `attachment/<guid>/download` turns HEIC into JPEG; the CAF voice format; one real `server/info`,
   `icloud/account` and `new-message` webhook body (ids blurred) for the fixtures. Then talk to her from
   his iPhone: a photo, a PDF, a long job, "use pnpm" mid-job, a group chat where he says "Sara, …".
4. **Decide where Sara runs relative to the Mac** for his own setup: same Mac (simplest), same home
   network, or tailnet; open Tailscale on the Mac if it's the tailnet.
5. **SMS (before 2.55.3, only if Q1 = yes):** check that AgentText's API answers again; sign up, note
   the API-key screen, get a number, send and receive one text each way, and find out from AgentText's
   dashboard or support: (a) whether a "text" is billed per message or per segment; (b) how webhooks
   are registered and where the signing secret is; (c) whether MMS exists; (d) their terms of service
   and privacy policy. Record real answers for the fixtures.
6. **Decide §14 Q2–Q19** (each has a default the parent applies if he is away).

---

## 13. Risks

1. **AgentText may not be a going concern** (§2.7: the API host answered "Application not found", no
   published terms or privacy policy, an unpublished SDK). *Mitigation:* SMS ships last and gated (Q1);
   the plugin's `provider` setting keeps the door open for another provider; the card shows
   `SERVICE_DOWN` plainly; nothing else in Sara depends on it.
2. **The free tier is smaller than he thinks** (1 inbox, ~100 texts; 5 inboxes and 2,000 texts is the
   $29 plan) [G1, G3]. *Mitigation:* §1's correction box, the cost panel, the $2 default cap.
3. **Per-segment billing surprises** (one emoji halves a text's length). *Mitigation:* GSM-7
   normalisation, emoji off, `textBudget`, segments counted from AgentText's own answer.
4. **Apple's discretion** over her Apple ID and BlueBubbles' unofficial status (Apple disabled its
   developer account [B4]). *Mitigation:* her own Apple ID, his own Mac, owner-first, low pace, the
   terms box, never SIP advice, the plugin removable in one tap.
5. **macOS updates break BlueBubbles** (it reads Messages' private database and drives AppleScript;
   the Private API was tested only to macOS 13 [B9]). *Mitigation:* basic mode by default; `diagnose()`
   names "BlueBubbles needs an update" when `server/info` reports an update and calls start failing;
   BlueBubbles' own update check is linked.
6. **The Mac sleeps or BlueBubbles quits.** *Mitigation:* step 3 (never sleep), BlueBubbles'
   autostart guide, `MAC_ASLEEP`, catch-up on return; messages wait on the Mac.
7. **The BlueBubbles password in URLs** on a plain-HTTP home network. *Mitigation:* the recommendation
   (same Mac or tailnet), HTTPS support, the password only reaches her Apple ID.
8. **Carrier filtering of SMS** (A2P content rules apply whoever registers [T1]). *Mitigation:* no
   links to unknown sites or shorteners in texts she starts, short texts, no first messages by default.
9. **SMS spoofing.** *Mitigation:* weak identity, untrusted turns, no settings by text (B7).
10. **Matrix rooms are not end-to-end encrypted.** Users may assume they are. *Mitigation:* the terms
    box, the privacy line, the encrypted-room line, Signal pointed to for private chats.
11. **Element's defaults fight the setup** (encrypted DMs; `/` commands intercepted; Element X lacking
    the encryption switch). *Mitigation:* §7.3 step 3 on a computer, the name form on by default on
    Matrix, the owner's run checks each.
12. **matrix.org rate limits and terms for bots.** *Mitigation:* the pacer, `Retry-After`, a separate
    account, his own homeserver as the alternative; the build reads matrix.org's terms (Q not needed:
    the bot only talks with its owner).
13. **HEIC and CAF formats** may need decoders Sara doesn't have. *Mitigation:* conversion by
    BlueBubbles if it does it (checked), else plain-language fallbacks (§4.6).
14. **The doorbell is unauthenticated.** *Mitigation:* ids only, fetched with the password (B2); worst
    case a few wasted REST calls, counted.
15. **Three plugins, one phase.** More surface to maintain. *Mitigation:* the shared pieces (B1–B7) are
    small and generic; each app is its own release with its own test file; the order puts the
    lowest-risk app first (§15).

---

## 14. Blocking questions (with the defaults the parent applies if the owner is away)

1. **Ship SMS through AgentText at all,** given that its API host answered "Application not found" on
   2026-11-02, it has no published terms or privacy policy, and its free tier is 1 number and ~100
   texts. Default: **design it now, build it last (2.55.3), and only if the owner's own check (§12 step
   5) passes**; otherwise skip 2.55.3 and leave SMS for a later provider. Alternative: build it now
   behind the same gate, or drop SMS from Phase 122.
2. **Mac VMs, Hackintosh, Docker-OSX in the iMessage guide.** Default: **not covered**; the card says
   iMessage needs a Mac and points to SMS/Signal [A1]. Alternative: link BlueBubbles' own VM guides
   with a licence warning.
3. **The Private API.** Default: **supported if he already turned it on; never recommended; no SIP
   instructions in Sara**; the card explains the trade-off in facts. Alternative: a full guided step to
   turn SIP off (rejected: "similar to jailbreaking" [B12]).
4. **iMessage through the Sara Mac app** (ROADMAP "where possible"). Default: **a separate later slice
   with its own design note**, after 2.55.3 and once the Mac build machine is back (§4.13).
   Alternative: build it in 2.55.2 instead of BlueBubbles' basic mode (more permissions on an app that
   already has computer use).
5. **Running on the owner's own Apple ID.** Default: **refused** (`OWN_APPLE_ID`): she would read all his
   chats and answer as him. Alternative: allowed with a second tick ("I know she'll see all my
   messages"), answering only in chats with himself.
6. **BlueBubbles' Socket.IO events.** Default: **not used** (doorbell + REST + polling). Alternative:
   a from-scratch Socket.IO client for instant events when the doorbell can't reach Sara.
7. **Her messages first on iMessage** (`mirror`). Default: **built, off by default, only to him**
   (iMessage has no window and is where reminders are most wanted). Alternative: leave unbuilt as on
   Signal and email.
8. **Matrix end-to-end encryption.** Default: **out of scope**; unencrypted rooms only, said plainly.
   Alternative: a later phase that adds Olm/Megolm, either as a dependency (an owner exception to zero
   dependencies) or written from scratch with its own audit.
9. **Trusting SMS from his number.** Default: **untrusted** (tools ask in the app; no settings by
   text); *Trust texts from my number* off. Alternative: trusted like any linked chat.
10. **The SMS spending cap.** Default: **$2 a month** per companion, crisis help always sends.
    Alternative: $5 (the free credit), or no default (he must set one before *Start*).
11. **"Sign up for me"** (Sara calling AgentText's `POST /v0/signup` with his name and email).
    Default: **no**; he signs up on agenttext.dev (his account, his acceptance). Alternative: the
    one-call signup in the card (fewer screens; Sara would be signing him up to a service without
    published terms).
12. **Twilio (or Telnyx) as an SMS provider.** Default: **not built** (not in the ROADMAP line; A2P 10DLC
    registration, fees and an HMAC-SHA1 URL signature [T1–T3]); the `provider` setting leaves room.
    Alternative: add Twilio as a second provider in a later release for people who already have it.
13. **AgentText's MCP server.** Default: **not bundled**; the bridge covers chatting, and the existing MCP
    installer can add `agenttext-mcp` for other uses. Alternative: a Store entry (Phase 124).
14. **Reading one-time codes for her own sign-ups** (AgentText's OTP parsing). Default: **no**: her number
    is for talking with him; she doesn't sign up for services with it. Alternative: a tool that waits for
    a code, owner-only, asking each time.
15. **The hub ping.** Default: **no change** (all three count as `plugin_bridge`). Alternative: per-app ids
    in `BRIDGE_IDS` (a contract change).
16. **SMS strangers.** Default: **no reply at all**. Alternative: Telegram's one hello line (costs a text
    per stranger).
17. **The SMS `HELP` answer.** Default: "Sara, an AI companion run by <his first name>. Reply STOP to stop
    texts." Alternative: his own words.
18. **Matrix OAuth device login** (servers without passwords). Default: **built only if the owner's
    homeserver needs it**; password once and pasted tokens cover matrix.org and Synapse. Alternative:
    build it in 2.55.1 for every MAS server.
19. **Typing and read receipts on Matrix.** Default: **on in his room, off elsewhere**. Alternative: off
    by default like Signal's read receipts.

---

## 15. Suggested order and release split

Phase 122 keeps its ROADMAP version for WhatsApp (2.55.0, being built) and ships the rest as **patch
releases of the same phase**, so Phases 123–128 keep their numbers (2.56.0 = Phase 123, big tool sets).

| Release | Slice | Why this order | Shared pieces it lands | Test |
|---|---|---|---|---|
| 2.55.0 | WhatsApp (WHATSAPP.md) | in progress | W1 bridge hooks, W2 door, W3 `http1.mjs`, W5 buttons, W6 `diagnose()` + `web/setup-steps.js` + generic `/api/plugins/:id/{setup,check,fix,webhook}` | `phase122.test.ts` |
| **2.55.1** | **Matrix** | lowest risk: open protocol, free, no Mac, no money, no door, fully testable with a stand-in; the owner can try it in 15 minutes | B3 tailnet in the broker, B4 long-poll, `tls: optional`, `buttons: 'reactions'`, `auth.level` (strong) | `phase122b.test.ts` |
| **2.55.2** | **iMessage through BlueBubbles** | the highest value ("people text in iMessage", GAP_REVIEW G2), but it needs the owner's Mac run first (§12 step 3) | B1 `url` kind + B2 doorbell, `webhooks.bridge` list + `doorbell`, `mirror` for plugin bridges | `phase122c.test.ts` |
| **2.55.3** | **SMS through AgentText** (only if §14 Q1 passes) | paid, a young service, the most rules (STOP words, money) | B1 `standard` bridge hooks, B6 spend meter + cap, B7 weak senders | `phase122d.test.ts` |
| later, unnumbered | iMessage through the Sara Mac app (§4.13) | needs new macOS permissions, a Mac build, an owner decision (Q4) | the plugin's `source: 'mac-app'` | its own design note |

If the owner prefers a minor version per app (2.56.0 Matrix, 2.57.0 iMessage, 2.58.0 SMS), Phases
123–128 move up by three; that is a ROADMAP edit for the owner, not made here.

Each release ships its docs in the same commit (as WhatsApp's): a user guide per app
(`docs/MATRIX.md`, `docs/IMESSAGE.md`, `docs/SMS.md`) with the card's steps and pictures, docs/CHATS.md,
docs/PLUGINS.md (`webhooks.bridge` kinds, `doorbell`, `tls: optional`, `cost`, `auth.level`,
`buttons: 'reactions'`), docs/WEBHOOKS.md (bridge hooks of kind `url` and `standard`), docs/PRIVACY.md
(Matrix rooms unencrypted; SMS readable by carriers; iMessage through Apple), THREAT_MODEL, `web/help.html`,
i18n in six languages, the ? tips, CHANGELOG, ROADMAP, README "What's new".

---

## 16. Key choices in short

- **Three first-party plugins** on contract v1.2 (`plugins/matrix`, `plugins/imessage`, `plugins/sms`),
  installed through the normal review card; nothing installs, enables or updates itself.
- **No public address needed by default:** Matrix long-polls `/sync`, SMS long-polls AgentText's `wait`,
  iMessage is rung by BlueBubbles over his own network (or polls). WhatsApp's door is used only by
  SMS's optional signed webhook.
- **WhatsApp's pieces reused, grown a little:** bridge hooks take kinds `url` (BlueBubbles) and
  `standard` (AgentText); `http1.mjs` copied byte-equal with long-poll and plain-HTTP support; the
  stepper, `diagnose()` and the generic setup routes reused as data.
- **The doorbell rule:** an unsigned webhook may only wake a plugin with ids; the plugin fetches each
  message from the authenticated API before anything reaches her.
- **"My network" includes my tailnet** in the socket broker, under the existing switch.
- **iMessage:** BlueBubbles on **his own Mac**, **her own Apple ID** and macOS user (his own Apple ID is
  refused), **basic mode by default**, the Private API used only if he already has it, **never SIP
  advice**; no Mac → no iMessage, said plainly; the Sara Mac app route is a later slice.
- **SMS:** AgentText's figures, not the brief's (free = $5 credit, 1 number, ~100 texts); **built last
  and gated** on the service answering; text only; short replies counted in segments; a **monthly cap**
  ($2 default) that stops sending; STOP and friends always belong to the carrier; senders are **weak**,
  so his texts are untrusted turns unless he says otherwise; strangers get nothing.
- **Matrix:** her own account, password used once (token in the vault), **unencrypted rooms only**
  (encryption is out of scope and said plainly), full Telegram-like features: edits, typing, reactions,
  replies, rooms with keep-up; reactions stand in for buttons.
- **Twilio not built** (not in the ROADMAP line; A2P 10DLC registration and fees); the SMS plugin keeps a
  provider slot.
- **Safety and isolation unchanged:** disclosure, crisis help (never cut, never capped), the minors
  block, partners without tools, one companion per account, members see nothing, private local mode
  pauses all three without losing messages.

---

## 17. Sources

Read on 2026-11-02 unless marked.

**BlueBubbles**
- [B1] *Server Overview* (AppleScript + polling `chat.db`; macOS Sierra+ with iMessage; why macOS is
  required; VMs need hardware spoofing; the guides index: preventing sleep, multiple users on one Mac,
  autostart). https://docs.bluebubbles.app/server/ · index https://docs.bluebubbles.app/server/llms.txt
- [B2] *REST API & Webhooks* (auth by `guid`/`password`/`token` query parameter; response format;
  browser vs non-browser use; Postman collection).
  https://docs.bluebubbles.app/server/developer-guides/rest-api-and-webhooks · https://documenter.getpostman.com/view/765844/UV5RnfwM
- [B3] Same page, *Webhooks* (the event list, "Simply provide a URL and the server will POST to it"), and
  *Simple Web Server for Webhooks* (*API & Webhooks → Manage → Add Webhook*).
  https://docs.bluebubbles.app/server/developer-guides/simple-web-server-for-webhooks
- [B4] *Manual Setup* (download, unsigned app, permissions, Firebase files, *Connection*: server password
  and the floppy-disk icon, proxy choices). https://docs.bluebubbles.app/server/installation-guides/manual-setup
- [B5] *Licenses / Legal* ("in no way affiliated with or endorsed by Apple").
  https://docs.bluebubbles.app/server/licenses-legal
- [B6] Source: `packages/server/src/server/databases/server/constants.ts` (`DEFAULT_SOCKET_PORT = 1234`).
  https://github.com/BlueBubblesApp/bluebubbles-server
- [B7] Source: `packages/server/src/server/api/http/api/v1/httpRoutes.ts` (route table; Private API
  middleware on typing, react, notify, …).
- [B8] Source: `…/api/http/api/v1/validators/messageValidator.ts` (`method` `apple-script` | `private-api`,
  `tempGuid` required for AppleScript, reply/subject/effect force the Private API; edit fields).
- [B9] *Private API: Intro and Background* (the feature list incl. edits and unsend on macOS 13+; tested
  macOS 10.13–13). https://docs.bluebubbles.app/private-api/
- [B10] Source: `packages/server/src/server/events.ts` (`new-message`, `updated-message`,
  `message-send-error`, `typing-indicator`, `hello-world`, …).
- [B11] Source: `packages/server/src/server/services/webhookService/index.ts` (plain JSON POST, no
  signature, not awaited, 15 s timeout).
- [B12] *Private API: Installation* (SIP off, library validation, "similar to Jailbreaking", own risk,
  Apple Silicon loses iOS apps). https://docs.bluebubbles.app/private-api/installation
- [B13] *macOS Virtualization*, *Running BlueBubbles in Docker-OSX*.
  https://docs.bluebubbles.app/server/advanced/macos-virtualization

**Apple**
- [A1] *Software License Agreement for macOS* (Apple-branded computers only; VM copies on a Mac for
  personal non-commercial use; no relay/service bureau use; no spam, harassment, fraud).
  https://www.apple.com/legal/sla/docs/macOS27.pdf (read from the search excerpt; the build reads the
  current macOS licence in full)
- [A2] Apple, *Messages for Business* (official business messaging through registered providers).
  https://register.apple.com/resources/messages/messaging-documentation · **not re-read in this session**
- [A3] Apple Support, *Unsend and edit messages on iPhone* (edit a sent iMessage up to five times within
  15 minutes). https://support.apple.com/guide/iphone/unsend-and-edit-messages-iphe67195653/ios ·
  **from prior knowledge, not re-read in this session; the build re-checks**

**AgentText**
- [G1] *AgentText — Text messaging inboxes for AI agents* (features, "HMAC webhooks + retries",
  "Svix-compatible headers", "A2P compliance handled", the FAQ on A2P 10DLC, US numbers, pricing:
  free/Builder/Scale). https://www.agenttext.dev/
- [G2] *API Reference* (base URL, auth, signup, inboxes, messages, inbound parsing incl.
  `opt_out_detected`, conversations, `wait`, billing, MCP, error codes; "$1.15 deducted from free credit
  per number"). https://www.agenttext.dev/docs · **probe:** `curl` of the base URL, `/v0`,
  `/v0/openapi.json`, `/v0/webhooks`, `/health` → `404 {"message":"Application not found"}` (Railway
  edge), and `www.agenttext.dev/terms`, `/privacy` → 404, on 2026-11-02.
- [G3] *agenttext-mcp* README on npm (tools; pricing: "Free: $5 credit, 1 inbox, ~100 texts").
  https://www.npmjs.com/package/agenttext-mcp
- [G4] npm registry: `agenttext` (no versions published), `agenttext-mcp` 0.1.0.
  https://registry.npmjs.org/agenttext · https://registry.npmjs.org/agenttext-mcp

**Twilio**
- [T1] *Programmable Messaging and A2P 10DLC* (who must register, incl. hobbyists; Brand + Campaign;
  Sole Proprietor; unregistered traffic fees). https://www.twilio.com/docs/messaging/compliance/a2p-10dlc
- [T2] *Pricing and Fees for A2P 10DLC Service* (brand $4.50, vetting $15, monthly campaign fees, carrier
  fees). https://help.twilio.com/articles/1260803965530
- [T3] *Secure webhooks* (`X-Twilio-Signature`, HMAC-SHA1 over URL + parameters, use the SDK).
  https://www.twilio.com/docs/usage/webhooks/webhooks-security

**Matrix**
- [M1] *Matrix Specification v1.19, Client-Server API* (login and flows, access tokens, refresh, the
  OAuth 2.0 API and device authorisation flow (v1.15), `/sync` and `timeout`, sending, `m.replace`,
  `m.annotation`, replies, threads, mentions, typing, receipts, the content repository and authenticated
  media (v1.11), rate limiting and `Retry-After`, `M_UNKNOWN_TOKEN`, `m.room.encryption`).
  https://spec.matrix.org/latest/client-server-api/
- [M2] **Probe:** `GET https://matrix-client.matrix.org/_matrix/client/v3/login` → flows
  `m.login.password`, `m.login.sso` (`oauth_aware_preferred`), `m.login.token`; `/versions` → up to
  v1.17.
- [M9] matrix.org *Terms of Service* and *Code of Conduct*. https://matrix.org/legal/ · **not re-read in
  this session**; the build reads them.

**Sara code and docs read for §1:** `src/plugins/manager.ts` (bridge v1.2 messages), `src/plugins/net.ts`
(`addressAllowed`, `isHomeNetworkAddress`), `src/tools/builtin.ts` (`isPrivateAddress`),
`src/webhooks.ts` (in-progress `ensureBridgeHook`, `BRIDGE_LIMITS`, `owner_plugin`, `weakKind`),
`src/webhook-verify.ts` (`VERIFY_KINDS`, `verifyStandard`), `src/bridges/rooms.ts` (`PLUGIN_NAMES`),
`desktop/mac/Sources/*.swift` and `desktop/mac/Sara.entitlements`; docs `design/WHATSAPP.md`,
`design/BRIDGES3.md` (incl. *As built* A and B), `design/BRIDGES2.md`, `design/GAP_REVIEW.md` (G2),
`design/SSH_EASY.md`, `DECISIONS.md` (2026-10-31), `SOURCE_OF_TRUTH.md`, `ROADMAP.md` (Phase 122).
