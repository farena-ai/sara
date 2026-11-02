# WhatsApp as a chat app: the official Cloud API, her own business number, a guided setup (design, Phase 122, version 2.55.0)

Status: design study, 2026-11-02. Nothing here is built. It is a read-only study of the code at
2.54.0 (Phases 115–121 released: BR1 files and progress, BR2 steer/queue/`/btw`, the Signal and email
plugins with the socket broker and contract v1.2, `/goal`, `/when` and `/continue`, the routines
gallery and the safety check-up), plus Meta's official WhatsApp Business Platform documentation, the
WhatsApp terms and Tailscale's Funnel reference listed in §14. It is a ground-up design: no code,
schema, protocol detail or wording is taken from Hermes Agent, OpenClaw or any other agent, and no
code from whatsapp-web.js or Baileys. Zero new npm runtime dependencies. WhatsApp is a
**first-party plugin** (`plugins/whatsapp`), like Signal and email; the only core code is what the
plugin contract and the webhook layer need to carry it.

This document covers **WhatsApp only**. Phase 122's other bridges in the ROADMAP line (iMessage
through BlueBubbles and the Sara Mac app, SMS through AgentText, Matrix) get their own design; they
reuse the same building blocks (§3.1 W1 and W3 in particular) and nothing here depends on them.

**The owner's words.** 2026-10-25, when Phases 26–33 were planned: "WhatsApp is out: Meta's WhatsApp
Business terms (since 2026-01-15) ban general-purpose AI assistants, and unofficial clients risk the
owner's number." 2026-10-31, approving the gap review: "We can have Whatsapp as an option for
people." The ROADMAP line he approved:

- *Phase 122 (2.55.0):* "More chat apps: **WhatsApp** (the official Cloud API, the user's own business
  number; unofficial WhatsApp Web libraries are not used: Meta bans those numbers), … Each a
  first-party plugin bridge with the same rules as Telegram/Discord (owner, partners, rooms, commands,
  keep-up where the platform allows) (#3 part 2)."

And the gap review's simple-UI line (GAP_REVIEW §2, #3): "Settings → Chat apps shows a card per app
with *Connect*, a three-step guide with pictures, and a *Test* button; nothing appears until it's
connected." He called the old SSH setup "a brick wall" (SSH_EASY.md). WhatsApp's setup is longer
than any other chat app's (a Meta developer app, a business portfolio, a token, a public HTTPS
address), so the guide is the feature: **every Meta screen named exactly, every value pasted once,
every failure explained in plain words with the fix.**

**The brief (from the parent, on the owner's behalf):** "Read the repo before you design anything. Do
not invent a parallel architecture." Use the existing bridges, contract v1.2 and its socket broker,
the partner rules, Phase 116's progress and steer/queue/`/btw`, Phase 119's `/continue`, the
webhooks layer and the way Sara is reached today (`sara access`, Tailscale, her own domain), the
vault, private local mode and the network guard. Research Meta's official docs for the verify
token and `X-Hub-Signature-256`, text/images/documents/audio and media download, the 24-hour window
and templates, statuses, read receipts and typing, rate limits, the test number versus a real one,
business verification, pricing, and what a beginner does in Meta's console. Explain the unofficial
libraries and why Sara doesn't build them in.

**Goal:** the owner texts her on WhatsApp the way he does on Telegram: words, photos, PDFs, voice
notes, `/new`, "use pnpm" while she works, *Stop*. Setting it up takes a beginner about 30 minutes
with the guide open beside Meta's console, and every red line in it says what to click next. It
costs nothing for chats he starts (§2.4), adds no way for a stranger to reach her tools, and is off
until he installs it.

**The rule of this track: build on what is there.** WhatsApp is a plugin bridge (`plugin-whatsapp`),
so every turn goes through `#bridgeInbound` → `#bridgeTake` → `#bridgeTurn` (`src/plugins/manager.ts`)
and so through the CH1 commands, the CH2 channel project ("WhatsApp" is already in `PLUGIN_NAMES`),
BR1 media, BR2's one queue and the safety layer, unchanged. Outgoing calls to Meta use **the socket
broker** (P1) exactly as the email plugin uses it for SMTP. Incoming messages arrive as **webhooks**,
through the ST7 webhook layer (`src/webhooks.ts`, `src/webhook-verify.ts`), grown by one verify kind and
one delivery mode; there is no second HTTP server and no second signature checker. What the plugin
contract can't carry yet it gets as opt-in v1.2 fields (buttons, the reply window), the way BR1 and
Phase 117 grew it.

> **Read this first: Meta's terms.** Since 2026-01-15 the WhatsApp Business Solution Terms say that
> providers of "general-purpose artificial intelligence assistants … are strictly prohibited from
> accessing or using the WhatsApp Business Solution, whether directly or indirectly, for the purposes
> of providing … such technologies when such technologies are the primary (rather than incidental or
> ancillary) functionality being made available" [W1]. A self-hosted companion that a person runs
> for himself on his own business account is not a vendor selling an assistant, but Meta decides
> "in its sole discretion", and the account (and its number) can be restricted (error `368`,
> `131031` [W14]). This design therefore keeps WhatsApp **off, owner-first, plainly labelled and his
> own choice** (§4.1, §7.6), never advertises Sara as "an AI on WhatsApp", and puts the decision to
> ship at all to the owner as **§12 Q1**. Everything below assumes the answer is "ship it as an
> option", which is his 2026-10-31 wording.

Contents: 1 what exists today · 2 platform facts (Meta, the terms, public HTTPS) · 3 the shape and
building blocks · 4 WA the WhatsApp plugin · 5 the guided setup (the exact Meta screens) and the
plain-language diagnostics · 6 tables, routes, UI at 1440 and 390, ? tips · 7 security, safety,
household · 8 unofficial libraries: why not · 9 reuse vs build · 10 done when (`test/phase122.test.ts`)
· 11 owner to-dos · 12 risks · 13 blocking questions with defaults · 14 key choices · 15 sources.

---

## 1. What exists today (mapped from the code)

| Piece | Where | What it does today | Matters here because |
|---|---|---|---|
| Plugin bridges v1.2 | `src/plugins/manager.ts` (2,228 lines): `#bridgeInbound`, `#bridgeTake`, `#bridgeTurn`, `bridge.who`, `bridge.file`, `bridge.send {ref, files, replyTo, thread}`, `bridge.sent`, `bridge.status`, `bridge.typing`, `bridge.react`, `bridge.log`, `bridge.skip`; `ready.bridge {places, typing, react, log, threads, oneMessage, edit, editLimit, editEveryMs, textMax, ack, link}` | Signal and email run on it; CH1 commands, BR2 steer/queue, P4 link codes, P6 long turns (no partial reply at 5 minutes). | WhatsApp is one more v1.2 plugin. It needs two small additions: reply **buttons** (Stop, *Continue here*) and the **reply window** (§3.1 W4, W5). |
| Socket broker (P1) | `src/plugins/net.ts` (445 lines), `permissions.connect` | Hosts only from the owner's settings (`setting:<key>`), `where: public` = public addresses only, `tls: required` with certificates checked, pinned, 4 sockets, 600 writes and 16 MB a minute, every open logged, private local mode refuses. The test-only loopback override (`SARA_TEST_ALLOW_LOOPBACK_MAIL`, `netTestLoopback`). | The Graph API is HTTPS on 443: one `public` + `tls: required` endpoint. The plugin speaks HTTP/1.1 over it (§3.1 W3), as the email plugin speaks SMTP. The stand-in Graph server in the tests uses the same override (§10). |
| `sara.fetch` | `manager.ts` `#fetch` (l. 1108) | GET only ("only GET requests in channel version 1"), 1 MB, 30 a minute, no headers. | Not enough for Meta (POST with a bearer token, uploads up to 16 MB). Not grown; the broker carries it (§13 Q18). |
| Webhooks (ST7) | `src/webhooks.ts` (1,159 lines), `src/webhook-verify.ts` (453 lines), `src/routes/hooks.ts`, `web/hooks.js`; route `POST /hook/<id>.<url secret>` in `src/server.ts` (l. 2076) | Per hook: a hashed URL secret (404 for unknown or wrong), 256 KB cap, content types, rate limits (30 a minute, 500 a day, 120 a minute across hooks), the signature on the raw bytes **before** parsing, delivery ids kept 24 h, filters, then `tell` / `task` / `skill` / `plugin` (`event:webhook`). `verifyGithub` checks `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 of the raw body. Answers `202`. Only `POST` (else `405`). Bodies logged 14 days with secrets hidden. | Meta signs webhooks **exactly the GitHub way** with the App Secret [W3]. Meta also needs a **GET verify handshake** (`hub.challenge`) on the same URL and expects `200`, and a chat bridge must not keep message bodies in a delivery log. One new verify kind (`meta`) and one delivery mode (`bridge`) cover it (§3.1 W1). |
| Reaching her | `src/platform.ts` `accessInfo()` (`SARA_ACCESS` = `local \| tailscale \| domain \| lan`, `SARA_PUBLIC_URL`), `deploy/lib-access.sh` (`sara access`: Caddy for `domain`, `tailscale serve --bg --https=<port>` for `tailscale`, per-instance HTTPS ports), `src/tailscale.ts` (finds the CLI, reads status), `web/hooks.js` `reachText()` | Only `domain` has a public HTTPS address today. Tailscale is tailnet-only (`serve`). Funnel is only *mentioned* (docs/WEBHOOKS.md, ALEXA.md: "your own domain …, Tailscale Funnel, or Cloudflare Tunnel"); nothing sets it up. | Meta calls a public HTTPS URL with a trusted certificate [W3]. The one new piece of plumbing is **a public door for `/hook/` only** (§3.1 W2), so the app itself stays private. |
| Alexa | `src/alexa.ts`, docs/ALEXA.md | Already needs a public HTTPS address and documents the choices. | The same door serves `/alexa` if he wants (not by default). |
| Commands (CH1) | `src/bridges/commands.ts` (958 lines): `parseCommand`, `runCommand`, `commandAllowed(place, …)`, the name form; `/when`, `/continue`, `/goal`, `/loop` (Phases 118–119) | Typed commands on every bridge, owner-only ones refused elsewhere. | WhatsApp has no bot command menu; typed commands and the name form, plus up to 3 reply buttons where a choice is offered. |
| One queue, `/btw` (BR2) | `src/pending.ts`, `src/btw.ts`, `src/loop-guard.ts` | Steer at the safe point, queue after, `/btw` aside; plugins acknowledge with a line or a reaction (`ack`). | WhatsApp can react (👀) [W9]. |
| Progress (BR1, P5) | `src/bridges/progress.ts` (`ProgressMessage`, edit budget), `media.ts` `progressOn` | One message, edited. | The Cloud API has **no message edit**. WhatsApp gets the typing indicator and one *Working on it* line with a Stop button instead (§4.8). |
| Pick up across apps (Phase 119) | `src/pickup.ts`, `/continue` in `commands.ts`, the offer as "a button under her reply in chat apps" | | The offer becomes a WhatsApp reply button (*Continue here*), inside the 24-hour window only. |
| Partners | `src/safety.ts` `partnerNote` (no tools, nothing private, nothing sexual, may be a minor, AI when sincerely asked), `disclosureDue` | Every bridge's non-owner chats. | Same here; plus Meta's own opt-in rule (§4.5). |
| Vault | `src/vault.ts` (AES-256-GCM), `plugin:<id>:<key>` for `secret` settings, `webhook:<id>` for hook sender secrets | | The access token → `plugin:whatsapp:token`; the App Secret → the hook's `webhook:<id>` secret (Sara checks signatures; the plugin never sees it); the verify token → `webhook:<id>:verify`. |
| Private local mode, network guard | `src/net-guard.ts` (`checkOutbound`, `PrivateLocalError`), `src/private-local.ts` | Nothing leaves the computer; every way out goes through the guard. | WhatsApp pauses; webhooks answer `503` so Meta **keeps the messages and retries for up to 7 days** [W4] (§4.3). |
| Hub ping | `src/hub.ts` `BRIDGE_IDS` (`plugin_bridge` covers every plugin bridge) | Anonymous daily facts. | No change: WhatsApp counts as `plugin_bridge` (§13 Q15). |
| Tables | `src/plugins/bridge-db.ts`: `bridge_threads`, `bridge_identities`, `bridge_skips` | Signal pins the owner's safety number in `bridge_identities`. | WhatsApp pins the owner's **identity key hash** the same way (§4.4) and counts skips there. One new table: the reply window (§6.1). |

What does **not** exist: any WhatsApp code; a webhook that answers a GET handshake or `200`; a
webhook that hands its body to a bridge instead of an event hook; a way to expose only `/hook/` to
the internet; an HTTP client inside a plugin; reply buttons in the plugin contract; any notion of a
"reply window" (a platform that refuses her messages after 24 hours); a setup wizard that walks
through someone else's console.

---

## 2. Platform facts (from the official documentation, read 2026-11-02)

### 2.1 The Cloud API in one paragraph [W2, W5]

The Cloud API is Meta's hosted WhatsApp Business API, part of the Graph API: HTTPS calls to
`https://graph.facebook.com/<version>/…` with `Authorization: Bearer <token>`, JSON in and out
(current examples use `v26.0`). The pieces a beginner meets: a **Meta developer account**; a **Meta
app** made with the use case *Connect with customers through WhatsApp*; a **business portfolio**
(Meta Business Suite); a **WhatsApp Business Account (WABA)**, which the newer dashboard calls a
*Messaging account*; and one or more **business phone numbers**, each with a **Phone number ID**.
Sending is `POST /<PHONE_NUMBER_ID>/messages`; receiving is a webhook. Meta hosts the number; nothing
runs on a phone.

### 2.2 Webhooks: the verify handshake, the signature, retries [W3, W4]

- **Verify (GET).** Whenever the owner saves the *Callback URL* or *Verify token* in the dashboard,
  Meta sends `GET <callback>?hub.mode=subscribe&hub.challenge=<int>&hub.verify_token=<his string>`.
  The endpoint must check that the token equals the one he typed and answer **`200` with the
  `hub.challenge` value** as the body; anything else fails the setup.
- **Events (POST).** `Content-Type: application/json` and `X-Hub-Signature-256: sha256=<hex>`, the
  HMAC-SHA256 of the payload with the **App Secret** [W3] (the same construction as GitHub's, which
  `verifyGithub` already checks on the raw bytes). Meta: "You don't have to validate the payload, but
  you should." Sara always does.
- **Answer `200`.** Failed deliveries are retried at once and then "a few more times with
  decreasing frequency over the next 7 days"; unacknowledged ones are dropped after 7 days [W4].
  Duplicates are possible, so the receiver dedupes. Batches carry up to 1000 updates [W3].
- **TLS.** "A valid TLS or SSL certificate … Self-signed certificates are not supported" [W3, W4].
  mTLS is optional [W4] (not used; §13 Q12).
- **Fields.** The app subscribes to webhook fields; **`messages`** carries both incoming messages
  and the statuses of hers [W2]. Other fields (account alerts, template status, quality) are useful
  for diagnostics but not needed (§13 Q11).
- **Payload shape.** `object: "whatsapp_business_account"`, `entry[].changes[].value` with
  `metadata.phone_number_id`, `contacts[]` (`profile.name`, `wa_id`, and since April 2026 `user_id`,
  the business-scoped user id, §2.8) and either `messages[]` or `statuses[]` [W2, W8].

### 2.3 Sending and receiving: text, pictures, documents, voice [W6, W7, W10]

| Kind | In (webhook `messages[].type`) | Out (`POST …/messages`) | Limits |
|---|---|---|---|
| Text | `text.body`; `context.id` when it replies to a message; `context.forwarded` / `frequently_forwarded` | `type: text`, `text.body`, `preview_url`; `context.message_id` to quote | **4096 characters** a message [W10] |
| Image | `image {id, mime_type, sha256, caption?}` | by uploaded media id or link | JPEG/PNG, 8-bit RGB(A), **5 MB** [W7] |
| Document | `document {id, filename, mime_type, caption?}` | as image | PDF, Office, plain text; **100 MB** [W7] |
| Audio / voice | `audio {id, mime_type, voice: true\|false}` [W11] | as image | AAC, MP4, MPEG, AMR, OGG (Opus only); **16 MB** [W7] |
| Video, sticker | `video`, `sticker` | not sent by Sara in v1 | MP4/3GP 16 MB; WebP 100/500 KB |
| Reaction | `reaction {message_id, emoji}` | `type: reaction` on a message he sent, within 30 days [W9] | only a `sent` status comes back |
| Button reply | `interactive.button_reply {id, title}` | `type: interactive`, reply buttons | **up to 3 buttons, 20 characters a label**, body 1024 [W12] |
| Unsupported, location, contacts | marks (`[location]`, `[contact card]`) | — | |

**Media in** is two calls: `GET /<MEDIA_ID>` returns a `url` (valid **5 minutes**), then a `GET` of
that URL **with the same bearer token** returns the bytes (`404` → ask for a fresh URL) [W7]. Newer
webhooks also carry the URL directly [W11]; it still needs the token. **Media out** is either `POST
/<PHONE_NUMBER_ID>/media` (multipart: `file`, `type`, `messaging_product=whatsapp`) → `{id}`, kept 30
days, or a public link [W7]; Sara uploads (she has no public file links).

### 2.4 The 24-hour customer service window, templates and pricing [W5, W13]

- When a WhatsApp user messages (or calls) the business, a **24-hour customer service window**
  opens; each new message from him resets it. While it is open the business may send **any**
  message type ("service messages"). When it closes, only **pre-approved template messages** can be
  sent [W5]. Sending a free-form message outside it fails with **`131047`** ("More than 24 hours have
  passed since the recipient last replied") [W14].
- **Pricing (since 2025-07-01, per message):** "You are only charged when a template message is
  delivered." "All non-template messages are free", and they can only be sent within an open window;
  utility templates inside an open window are free too. Rates vary by template category (marketing,
  utility, authentication) and the recipient's country code [W13]. Meta's service-messages page says
  they are "billed under the SERVICE pricing category" [W5]; the pricing page puts that category at
  free. For Sara: **chats the owner starts cost nothing**; anything she starts after 24 hours of
  silence needs a template and costs a few cents each (§4.10).
- **Templates** are made in WhatsApp Manager, reviewed by Meta, and categorised by Meta; "whenever a
  template is used, a business accepts the charges associated with the category" [W13]. Opt-in is
  required before sending templates [W5].

### 2.5 Status, read receipts, typing, reactions, no edits [W6, W8, W9, W15]

- **Statuses** of her messages arrive on the same webhook: `sent`, `delivered`, `read`, `failed`
  (with `errors[{code, title, message, error_data.details}]`), and `played` for voice [W8]. A `read`
  can arrive without a `delivered` [W8].
- **Read receipts:** `POST …/messages {status: "read", message_id}` shows his message as read (two
  blue ticks) and marks earlier ones read too [W15].
- **Typing indicator:** the same call with `typing_indicator: {type: "text"}`; it **also marks the
  message read**, lasts until she replies **or 25 seconds**, and Meta asks to show it "only … if you
  are going to respond" [W6].
- **Reactions:** her emoji on one of his messages (≤ 30 days old) [W9]. BR2's 👀 fits.
- **No editing and no deleting** of a sent message exists in the Cloud API's message types [W5];
  this is the one large difference from Telegram, Discord and Signal (§4.8).

### 2.6 Rate limits [W2, W16]

| Limit | Value | What Sara does |
|---|---|---|
| Throughput per number | 80 messages a second (in + out), up to 1,000 by automatic upgrade; `130429` above it [W16] | Far above one person's chat; never reached. |
| **Pair rate** (one business number → one person) | **1 message every 6 s** (~10 a minute, 600 an hour); bursts up to 45 in 6 s "borrow" from the future; `131056` above it; retry after 4^X seconds [W2] | The pacer (§4.11): her reply split into ≤ 3 messages, files after, reactions sparingly. |
| Graph API calls (management endpoints) | 200 an hour per app per WABA, 5,000 for an active WABA [W2] | The *Test* button and setup checks use a few; never polled. |
| Messaging limit (business-initiated, outside a window) | 250 unique people in 24 h for a new portfolio, 2,000 after business verification, then automatic [W17] | Only templates count; Sara's templates go to the owner only. |
| Registration calls | 10 per number in 72 h (`133016`) [W18] | The *Register my number* button allows one press at a time and says why. |

### 2.7 Numbers: the test number, a real number, verification [W5, W18, W19]

- **The test number.** Finishing *Get started* creates a **test WABA and a test business phone
  number**, registered automatically [W19]. It can only message numbers on its recipient list (API
  Setup → *To* → *Manage phone number list*; each recipient confirms with a code in WhatsApp) [W5]; that
  list holds **at most five** numbers (Meta's recipient-list limit as documented by integrators [W20];
  the build re-checks the dashboard). It costs nothing, needs no SIM, and shows as a test account.
  For a person who only wants to talk to her himself, **this is enough** (§13 Q2).
- **A real number.** Must be owned by him, have a country and area code, receive an SMS or voice
  call, and **not be in use** on WhatsApp or the WhatsApp Business app (or be moved over) [W18, W21].
  It is added in WhatsApp Manager, verified by SMS/voice code, given a **display name** (reviewed by
  Meta), and then **registered through the API only** (`POST /<PHONE_NUMBER_ID>/register` with a
  6-digit **two-step verification PIN**) [W18].
- **Business verification** (Meta Business Suite → Security Centre) is **not needed to start**. An
  unverified portfolio may register **two** numbers and reach 250 people a day with templates; it
  matters for the display name showing in chat headers, more numbers (20) and higher limits [W17,
  W18]. Sara never needs it for one owner and a few partners.
- **Tokens.** The dashboard's *Generate access token* gives a short-lived user token ("expire
  quickly … every few hours"). A direct developer uses a **System User access token** (Business
  Settings → Users → System users), generated for the app with `whatsapp_business_messaging`,
  `whatsapp_business_management` (and `business_management`) and an expiry choice that includes
  *Never* [W22]. Expired → error `190` [W14].
- **App Secret:** App Dashboard → *App settings* → *Basic* → *App secret* → *Show* (asks for his
  Facebook password).

### 2.8 Who is who: phone numbers, BSUIDs, identity changes [W8, W11, W18]

- Incoming messages name the sender by `wa_id` (his WhatsApp number in digits) and, since April 2026,
  by a **business-scoped user id** (`user_id` in `contacts`, `from_user_id` in messages). Usernames
  roll out during 2026: a person who adopts one may **hide his phone number** from businesses, and
  the BSUID stays stable [W11]. Sending accepts `to` (a number) or `recipient` (a BSUID).
- **Identity change check** (`POST /<PHONE_NUMBER_ID>/settings {user_identity_change:
  {enable_identity_key_check: true}}`): every incoming message then carries `identity_key_hash`;
  sending with the stored hash is refused with **`137000`** if the person's identity changed since
  (a new phone or a taken-over number), and Meta says to "assume the customer's phone number can no
  longer be trusted" until re-verified elsewhere [W18]. This is Signal's safety number, done by Meta.

### 2.9 Terms and policies [W1, W23, W24]

- **AI Providers clause** (Business Solution Terms, last modified 2026-01-15): quoted at the top. It
  targets providers making an assistant available as the primary functionality; it also says that a
  business may use an AI provider as a *Third Party Service Provider* and then may not let Business
  Solution Data train others' models [W1]. Sara sends nothing to train anyone's models; her model
  providers are the owner's own (their terms apply as for every chat).
- **WhatsApp Business Messaging Policy** [W23]: opt-in before business-initiated messages, honour
  opt-outs, and (for automated service) a way to reach a human. Not re-read in this session in full;
  the build checks it before coding (§15).
- **Consumer Terms of Service** [W24]: no "bulk messaging, auto-messaging, auto-dialing" and no
  "non-personal use" of the consumer app unless authorised; unofficial clients are banned (§8).

### 2.10 A public HTTPS address: what Sara has and what Meta needs [W3, T1, T2]

| How he reaches her (`sara access`) | Can Meta call it? | What the guide offers |
|---|---|---|
| `domain` (Caddy, Let's Encrypt) | **Yes**: `https://<domain>/hook/…` | Nothing more to do. |
| `tailscale` (`tailscale serve`, tailnet only) | No (private address) | **Open the public door**: Tailscale Funnel for `/hook/` only on a second port (§3.1 W2). |
| `lan` (plain HTTP at home) | No | The door (if Tailscale is installed), Cloudflare Tunnel, or switch to `domain`. |
| `local` (this computer only) | No | Same as `lan`; desktop apps usually land here. |
| Demo server | Never | WhatsApp is not offered on the demo. |

Tailscale Funnel publishes a local service on the node's public `*.ts.net` name, **only on ports
443, 8443 and 10000**, with `--set-path` to publish just a path [T1, T2]; Funnel must be allowed in
the tailnet policy (the CLI prints the admin link when it isn't). Sara's own HTTPS port on Tailscale
is 443 for the default instance (other instances use other ports, `deploy/lib-access.sh`), so the
door uses **8443** (or 10000 when 8443 is taken).

---

## 3. The shape

```
 His WhatsApp ──► Meta (Cloud API) ──POST /hook/<id>.<secret> (X-Hub-Signature-256)──┐
                     ▲                                                               ▼
                     │                          public door: domain (Caddy) or Funnel :8443 /hook/ only
                     │                                                               │
                     │                 ┌─ Sara: ST7 webhooks, kind `meta` (W1) ──────┘
                     │                 │   GET  hub.challenge ◄─ verify token (vault)   → 200 challenge
                     │                 │   POST raw-bytes HMAC (App Secret, vault) → 200 → mode `bridge`
                     │                 ▼        (no body in the delivery log; dedupe by wamid)
                     │        plugins/whatsapp (fenced process): `bridge.webhook` → parse entries
                     │                 │   messages → bridge.inbound {messageId, fromId, …, window}
                     │                 │   statuses → bridge.status / failed-send diagnostics
                     │                 ▼
                     │        #bridgeInbound: P4 link code / owner = BSUID + identity hash ─► CH1 commands
                     │          ─► place (owner-dm · partner-dm) ─► BR1 media in ─► BR2 #bridgeTake
                     │          ─► #bridgeTurn ─► runTurn ─► reply (≤ 4096 a message) + notices + files
                     │                 │          └─► typing (marks read) · 👀 · Working-on-it + [Stop]
                     │                 ▼
                     └── HTTPS POST graph.facebook.com/<v>/<PHONE_NUMBER_ID>/messages|media ◄── P1 socket
                         broker (`connect: graph`, public, TLS checked, pinned) ◄── W3 HTTP/1.1 in the plugin
```

### 3.1 Shared building blocks

1. **W1 · Bridge webhooks: kind `meta`, the GET handshake, delivery mode `bridge`**
   (`src/webhook-verify.ts`, `src/webhooks.ts`, the `/hook/` route in `server.ts`). The webhook layer
   grows; no second receiver.
   - *Verify kind `meta`:* `verifyMeta(raw, headers, appSecret)` = `verifyGithub`'s check
     (`X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 of the raw bytes, `safeEqual`) with Meta's
     wording in `why` ("no X-Hub-Signature-256 header: is the App Secret right?"). Meta sends no
     delivery-id header, so the 24-hour dedupe uses the body's message and status ids, done by Sara
     after the signature passes (`deliveryIds(raw)` reads only `entry[].changes[].value.messages[].id`
     and `statuses[].id + status`).
   - *The handshake:* for a `meta` hook **only**, `GET /hook/<id>.<secret>?hub.mode=subscribe&
     hub.verify_token=…&hub.challenge=…` is answered: URL secret right (else the usual `404`), mode
     `subscribe`, the token equal (constant time) to the hook's verify token in the vault
     (`webhook:<id>:verify`), the challenge 1–64 digits → **`200 text/plain <challenge>`**; anything
     else `403` and a log line ("Meta tried to verify with a different verify token"). Each success
     records `verifiedAt`, which the setup card shows live ("Meta reached Sara ✓ 14:02"). Every other
     hook kind still answers `405` to GET.
   - *Answers:* `meta` hooks answer **`200 {"ok":true}`** where other kinds answer `202` (Meta asks for
     `200` [W3]); `401`, `404`, `413`, `429` as today.
   - *Delivery mode `bridge`:* a hook made by a plugin bridge (`owner_plugin = 'whatsapp'`, §6.1)
     hands the **raw body** (≤ 256 KB, the existing cap; Meta's message payloads are a few KB) to that
     plugin as one `{type: 'bridge.webhook', hook, body}` line, instead of the `event:webhook` hook
     (which gets a redacted, 16 KB copy for automations). It is answered `200` once the plugin has
     accepted the line (≤ 5 s), `503` when the plugin isn't running, private local mode is on, or the
     plugin didn't accept in time: **Meta then keeps the delivery and retries for up to 7 days** [W4],
     so nothing is lost while Sara is down. The delivery log keeps time, verdict, size and the ids'
     count **but no body** for bridge hooks (they are someone's private messages), and the filters,
     templates and "signed copy" options are hidden for them.
   - *Limits for bridge hooks:* 300 deliveries a minute and 20,000 a day per hook (each of her
     messages brings up to three statuses), the global 120 a minute raised to count bridge hooks
     separately; five bad signatures a minute from one address pause **that address** as today
     (§12 risk 6 for addresses behind Funnel).
   - *Who makes it:* the plugin's setup (route `POST /api/plugins/whatsapp/webhook`, §6.2), never the
     Webhooks page. It shows in Settings → Webhooks as a locked row *WhatsApp (made by the WhatsApp
     plugin)* with its log and *New address (rotate)*; removing the plugin removes it.
2. **W2 · The public door (`/hook/` only)** (`deploy/lib-access.sh` + `src/tailscale.ts` +
   `src/routes/admin.ts`). For `SARA_ACCESS=tailscale`: `sara access door on` runs
   `tailscale funnel --bg --https=8443 --set-path=/hook http://127.0.0.1:<port>/hook` (10000 when 8443
   is used by another instance), writes `SARA_HOOK_URL=https://<name>.ts.net:8443` to `sara.env`, and
   `sara access door off` removes it. Only `/hook/…` is public (plus the static `/privacy` page if he
   publishes his Meta app, §13 Q19); the app, `/api`, `/alexa` and everything else stay tailnet-only. Desktop apps (Windows, macOS) find the Tailscale CLI with
   `src/tailscale.ts` and offer **Open the door for me** (the same command, run once after a tap, with
   the output shown); without the CLI the card shows the command and a *Copy* button.
   `accessInfo()` grows `hookUrl` (`SARA_HOOK_URL`, else `SARA_PUBLIC_URL` when it is https and the
   mode is `domain`), which the Webhooks page and the WhatsApp card both use. **Cloudflare Tunnel or
   any other HTTPS proxy** is the *Something else* choice: he pastes its public address and Sara
   checks it the same way. When Meta refuses a `:8443` callback URL (§12 risk 3), the door moves to
   443 and the tailnet app to 8443 (`sara access door on --swap`), a choice the card explains.
3. **W3 · HTTPS to Meta through the socket broker** (`plugins/whatsapp/http1.mjs`, plain JavaScript in
   the plugin). One `connect` endpoint, `{id: 'graph', host: 'setting:graphHost', ports: [443], where:
   'public', tls: 'required'}`, and one for media downloads, `{id: 'media', host: 'setting:mediaHost',
   ports: [443], where: 'public', tls: 'required'}` (defaults `graph.facebook.com` and
   `lookaside.fbsbx.com`, under *Advanced*). The plugin writes HTTP/1.1 requests (`Host`,
   `Authorization: Bearer`, `Content-Length` or `multipart/form-data`) and reads responses
   (`Content-Length` and `chunked`, keep-alive, 30 s timeout, 25 MB cap): about 250 lines, shared by
   later plugins that call an HTTPS API with a token. A media URL whose host isn't the `mediaHost`
   setting is **not fetched** and reported (`bridge.status` + Test: "Meta now serves media from
   <host>; update *Media host* under Advanced"). The token reaches the plugin in `init.secrets` (the
   email password's path) and is only ever written to these verified TLS sockets. Private local mode
   closes them (P1).
4. **W4 · The reply window** (`manager.ts`, contract v1.2 field). `ready.bridge.window: {hours: 24}`
   tells Sara this platform refuses free-form messages after 24 hours of silence. Sara keeps
   `bridge_windows` (§6.1): every `bridge.inbound` from a chat moves `open_until` to its timestamp + 24
   h. Before Sara sends anything **she starts** (a reminder mirror, a `/continue` offer, a finished
   background job, a goal's end), it asks `windowOpen(chat)`; closed → it stays in the app (and, only
   with the owner's template switch, a paid nudge template, §4.10). Replies to his messages are
   always inside the window. A failed send with `131047` closes the window at once.
5. **W5 · Reply buttons** (contract v1.2 field). `bridge.send {buttons: [{id, label}]}` (≤ 3, labels ≤
   20 characters after translation, Sara cuts with an ellipsis) when `ready.bridge.buttons: 3`; a tap
   comes back as `bridge.inbound {action: <id>}`, the field Telegram-style plugin actions already use.
   Sara uses them for **Stop** on the working line (`st:<conv>`, the Telegram `callback_data` shape),
   **Continue here** / **Not now** (Phase 119's offer), **Allow** / **Deny** for an approval asked in
   this chat (BR1's `send_file` asks first in partner places; owner approvals as on Telegram), and
   `/model`'s first three choices. Older plugins never get `buttons`; the text form is sent instead.
6. **W6 · The setup checker and plain-language diagnostics** (`plugins/whatsapp/checks.mjs` +
   `diagnose()` in the plugin, the SSH_EASY §4.1 pattern). One function turns every Graph answer and
   every webhook state into `{code, title, fix, actions[]}` (§5.3). The setup card, *Test*, the status
   chip, failed-send notices and the check-up (Phase 121) all show the same words.

### 3.2 Where data lives

Everything lives in the data of **the one companion the plugin is switched on for** (§7.4). Tables
are additive (`CREATE TABLE IF NOT EXISTS`), so 2.54.x opens a 2.55.0 database and ignores them.

| Data | Where | Who writes it |
|---|---|---|
| Conversations `plugin-whatsapp` (sessions in the CH2 channel project "WhatsApp") | `store.db` | Sara (as today) |
| `bridge_windows` (each chat's reply window) | `store.db` (new, §6.1) | Sara, from `bridge.inbound` |
| `bridge_identities` (the owner's pinned identity key hash) | `store.db` (existing) | Sara |
| `bridge_skips` (strangers, duplicates, unknown numbers, statuses of unknown messages) | `store.db` (existing) | Sara, from the plugin's `skip` reports |
| The bridge hook (kind `meta`, mode `bridge`, `owner_plugin`) and its log (no bodies) | owner's `hooks` tables (ST7) + `owner_plugin` column | Sara |
| `ownerChats`, `ownerIds`, `others`, `allow` | companion settings `plugins.whatsapp.bridge` | the owner |
| The access token | vault `plugin:whatsapp:token` | the owner (write-only) |
| The App Secret | vault `webhook:<id>` (the hook's sender secret, as for GitHub hooks) | the owner (write-only) |
| The verify token | vault `webhook:<id>:verify` (Sara makes it; shown with *Copy* until the handshake passes) | Sara |
| Phone number id, WABA id, display number, Graph version, sent-message ids (24 h, for statuses and replies), the media upload cache (30 days, by file hash) | the plugin's own data folder and `kv` | the plugin |
| The two-step PIN | **nowhere**: typed for *Register my number*, sent once, forgotten | — |

### 3.3 Settings shape

Core (owner-only, `OWNER_SETTINGS`), the existing bridge block, nothing new except `templates`:
```ts
chats.progress.apps: { …, 'plugin-whatsapp'?: boolean }  // the working line + typing (default true)
plugins.whatsapp.bridge: {
  ownerChats: string[],    // his chat ids (BSUID)
  ownerIds: string[],      // BSUID and wa_id of him (both recorded at linking)
  others: boolean,         // let other people talk to her there (default false)
  allow: string[],         // numbers or BSUIDs that "others" means (empty = nobody; §13 Q6)
}
```
Manifest settings of the plugin (§4.13), shown on its settings window with their ? tips: *Phone
number ID*, *WhatsApp account ID*, *Access token* (secret), *Show typing (also shows blue ticks)*,
*Send read receipts*, *Send reminders and messages she starts to my WhatsApp too*, *Nudge me with a
paid template when the 24 hours are over*, *Template name*, and under *Advanced*: *Graph API
version*, *Graph host*, *Media host*. The App Secret is typed on the setup card and goes to the hook
(the plugin never holds it).

---

## 4. WA · WhatsApp (`plugins/whatsapp`, bridge `whatsapp`, channel `plugin-whatsapp`)

### 4.1 Scope

1. Text her on WhatsApp from his own phone: a 1:1 chat with **her** business number (Meta's test
   number to start, a real number later).
2. Pictures, documents and voice notes in (BR1 rules; voice transcribed like Telegram's); pictures and
   files out (`send_file`, BR1).
3. CH1 commands typed (and the name form), BR2 steer / queue / `/btw`, `/stop` and a **Stop** button,
   `/goal`, `/loop`, `/when`, `/continue` (owner only, as on every bridge).
4. Typing while she works (which also shows blue ticks), 👀 on a steer, one *Working on it* line with
   Stop on long turns; no edited progress (WhatsApp has no edits).
5. Partners: off by default, then only numbers on his list, as partners (no tools, the AI notice first).
6. The guided setup card (§5), *Test*, a status chip; nothing appears until he connects it.

Not in Phase 122: **groups** (the Cloud API's groups support has its own eligibility rules this study
did not verify; plugin rooms and keep-up stay off for WhatsApp, `places: false`; §13 Q9), calls ("I
can't take calls here." once a day), her **voice** out (voice notes in are transcribed; her spoken
replies stay in the app; §13 Q10), video and stickers out, location and contact cards (marks),
WhatsApp Flows, catalogue and payment messages, marketing templates (never), Embedded Signup or any
Sara-hosted onboarding (Sara is not a Meta Tech Provider; §13 Q3), the On-Premises API, and a
second number per companion.

### 4.2 Setup

The exact screens are §5. In short: install the plugin (review card) → make a Meta app with the
WhatsApp use case → paste *Phone number ID* and *WhatsApp account ID* → add his own number as a
test recipient → make a permanent token and paste it → paste the App Secret → open the public door →
paste Sara's callback URL and verify token into Meta and subscribe to `messages` → *Link my
WhatsApp* and send the code → *Test*. Later, optionally, *Use a real number* (§5.2).

### 4.3 The connection

- **In:** Meta → the door → `/hook/<id>.<secret>` (W1) → `bridge.webhook` → the plugin splits the
  batch into its `messages[]` and `statuses[]` (an `entry` for another `phone_number_id` than the
  setting → skipped and counted `not-to-her`, §7.5) → one `bridge.inbound` per message (oldest first).
- **Out:** `POST /<v>/<PHONE_NUMBER_ID>/messages` over W3. One keep-alive connection to the Graph host,
  a second only for media downloads; closed after 5 minutes idle (P1 closes at 35).
- **Down and back:** while the plugin is stopped, restarting or paused, the hook answers `503` and
  Meta retries for up to 7 days [W4]. Messages older than **6 hours** when they finally arrive are not
  answered as if live: she gets them as one block ("While I was away you wrote: …") and the reply
  starts with "Sorry, I was offline." (§13 Q13). Messages older than 24 hours are filed in the
  conversation with a note and **not** answered (the window is closed; §2.4).
- **Dedupe:** a `wamid` seen in the last 24 hours is dropped (Sara's hook dedupe + the plugin's own
  set, for retries that arrive after a restart).
- **Order:** WhatsApp doesn't promise order across deliveries; the plugin sorts each batch by
  `timestamp` and Sara's BR2 queue keeps per-chat order from there.
- **Status chip:** *Connected* means the token works (one `GET /<PHONE_NUMBER_ID>` at start and every 6
  hours, well under 200 calls an hour) **and** the last handshake or delivery was signed correctly.

### 4.4 Who is who: owner identity

- **The owner is a BSUID** (`from_user_id`), recorded by linking together with his `wa_id`; the phone
  number is a second key only (usernames may hide it, §2.8). `ownerChats` holds his BSUID; replies go
  to `recipient: <BSUID>` when the account supports it, else `to: <wa_id>`.
- **Linking:** *Link my WhatsApp* → a 6-digit code (10 minutes, 5 wrong tries, P4) → he sends `/link
  123456` to her number → "Linked. It's me, Sara." plus the AI notice. Before linking, his first
  message also **opens the 24-hour window**, which is why the code is sent from his side.
- **His identity is pinned.** The setup turns on Meta's identity change check (one `POST
  …/settings`, shown as a line in *Test*). At linking Sara stores his `identity_key_hash` in
  `bridge_identities` (as Signal's fingerprint). A message from him with **another hash**, or a send
  refused with `137000`, **pauses his owner powers on WhatsApp**: "Your WhatsApp identity changed (a
  new phone, or someone else using your number). Confirm it's you in Settings → WhatsApp before I use
  my tools here again." The turn runs as a partner turn (no tools, no memory) and the app shows
  *It's me* (store the new hash) / *Unlink*. The web app, Telegram and Signal are not affected.
- **Partners:** `others` on + `allow` (numbers in + form, or BSUIDs). Their identity changes are logged,
  not blocked (they have no powers to take over).
- **Strangers** (anyone else who finds the number): with `others` off they get Telegram's line once per
  number ("Hi! I'm Sara, an AI companion. I only chat with the person who runs me here."), free because
  their message opened a window, then nothing; counted in `bridge_skips` (`stranger`). On the test
  number strangers can't write at all (only listed recipients can).

### 4.5 Places: private chats only

| Place | Who | What she does |
|---|---|---|
| Owner 1:1 (`owner-dm`) | him (BSUID matches, identity hash confirmed) | Everything an owner chat does: tools, memory, files, commands, steer/queue/`/btw`, `/goal`, `/continue`, the working line. |
| Partner 1:1 (`partner-dm`) | numbers on his list | `partnerNote` rules: no tools, no memory, nothing private, nothing sexual, may be a minor, the AI notice first and every 3 hours; their language from the text (WhatsApp sends no locale), else his app language. |

- **Meta's opt-in rule** [W5, W23]: she only ever writes to someone who wrote to her (inside the
  window). Partners are people he chose; the first reply to a partner carries the AI notice; *stop*
  or *STOP* from a partner (any case, alone in a message) is honoured: "OK, I won't write again." and
  that number is muted for her until he unmutes it in Settings (§13 Q7).
- **No groups in v1** (§4.1). A group message, if Meta ever delivers one, is skipped (`group`).

### 4.6 Pictures, files and voice

- **In:** `image`, `document`, `audio` → the plugin asks Sara first (`bridge.who` → owner/partner;
  BR1's rules: owner pictures ≤ 8 MB, up to 4 a message; partners' pictures only with *Look at
  pictures other people send*; documents from the owner only, ≤ 20 MB; Meta's own caps are 5/100/16 MB)
  → `GET /<MEDIA_ID>` → download within the 5-minute URL life with the bearer token (`404` → one fresh
  URL) → checks the `sha256` Meta gave → `bridge.file` chunks → `takeIncoming` / `takeChatDocument`.
  The caption becomes the message text. **Voice notes** (`voice: true`, OGG/Opus) go to
  `speechOf(app).hearNote` like Telegram's; an audio *file* (`voice: false`) is a document.
- **Out:** BR1's `deliverOutgoing` → `bridge.send {files}` → the plugin uploads (`POST …/media`,
  multipart), caches the media id by the file's hash for 30 days (Meta keeps uploads 30 days [W7]),
  sends `image` or `document` with the caption when the reply text is short (≤ 1024), else the text
  first. A picture over 5 MB or not JPEG/PNG (a WebP, a 16-bit PNG) is **sent as a document** (Sara has
  a JPEG decoder, `src/jpeg.ts`, but no encoder, and none is added for this). PDFs and Office files go
  as documents with their file name.
- **Formatting:** WhatsApp shows `*bold*`, `_italic_`, `~strike~`, ```` ``` ```` monospace and `` ` ``
  inline code itself; the plugin turns Markdown's `**bold**` into `*bold*`, `*italic*` into `_italic_`,
  headings into bold lines, tables into aligned monospace blocks, and links into `text (url)`.
- **Long replies:** split at paragraph or sentence ends under 4096 characters; at most **3 messages**
  per reply (the pair rate), the rest kept in the app with "The rest is in the app: <link>" when a
  link exists (`accessInfo().url`), else "…(continued in the app)".

### 4.7 Typing, read receipts, reactions

- **Typing** (`typing_indicator` [W6]) is sent on his message when a turn starts and every **20 s**
  until the reply (it lasts 25 s). It **also marks the message read**, so the switch says so: *Show
  typing (also shows blue ticks)*, on by default in his chat, off for partners (they see her reply
  instead; §13 Q8).
- **Read receipts alone** (`status: read`): *Send read receipts*, default **off**, as on Signal. When
  typing is on, his messages are read-marked anyway by the typing call.
- **Reactions:** BR2's steer acknowledgement is 👀 on his message (`ack: 'react'`), never more than one
  reaction a turn (each counts toward the pair rate). A failed reaction falls back to no
  acknowledgement (the typing dots already show she is working), not a line.

### 4.8 Progress without edits: the working line and Stop

The Cloud API can't edit a message, so BR1's live progress message is not possible (`edit: false`).
Instead, for his chat (`chats.progress.apps['plugin-whatsapp']`, default on):

1. Typing dots from the start (§4.7).
2. At **20 s**, one **working line** as a reply-button message: "Working on it: checking the repo…"
   (the current BR1 step words, ≤ 200 characters) with **[⏹ Stop]**. Tapping Stop is `/stop` for that
   conversation (W5).
3. No further messages until the reply (the pair rate and the chat stay calm). A turn that passes
   5 minutes follows P6: no partial reply, and because the working line already said it, nothing
   more until the end.
4. The reply, then the files. The *Done · 6 steps · 1:12* summary is added to the reply's last line
   only when the turn took more than a minute.

`/progress off` turns the working line off (typing stays). Partners never get a working line.
(§13 Q5.)

### 4.9 Commands, steer, queue, `/btw`, `/continue`

- Typed: `/new`, `/reset`, `/stop`, `/status`, `/help`, `/model` (a numbered list; the first three as
  buttons; `/model 2` picks), `/remember`, `/progress on|off`, `/steer`, `/queue`, `/btw`, `/goal`,
  `/loop`, `/when`, `/continue`, `/link`, and the name form ("Sara new") when *Her name works as a
  command* is on. `commandAllowed` decides per place, as everywhere; partners get the partner set.
- While she works, his plain message steers or queues (`chats.whileBusy`); 👀 marks a steer. `/btw`
  answers with a quoted reply (`context.message_id`) starting "💬". Partners always queue.
- **`/continue` (Phase 119):** the offer "Pick up where you left off in the app?" comes as a button
  message **[Continue here] [Not now]**, only while his window is open (W4); `/continue` typed always
  works because typing it opens the window.
- **Approvals** asked in his WhatsApp chat (BR1's `send_file` in a partner place never applies here;
  his own tool approvals when *Ask me in the chat app too* is on, as on Telegram) are **[Allow]
  [Deny]** buttons with the same ids Telegram uses (`ap:<id>:1|0`).

### 4.10 The 24-hour window: when she may write first

| What | Window open (he wrote < 24 h ago) | Window closed |
|---|---|---|
| Her reply to his message | sent | — (a reply is always inside) |
| Reminders, briefing, a finished background job, a goal's end, a `/continue` offer, "Sara calls you" not answered | sent **only with** *Send reminders and messages she starts to my WhatsApp too* (default off); free | kept in the app as today; with *Nudge me with a paid template* on, one template "You have a new message from Sara in the app." at most **once a day** (§13 Q4) |
| Anything to a partner that she starts | never | never |

- The template is **his own**: Sara's guide gives him the exact text to submit as a **utility**
  template ("You have a new message waiting in your app."), and the setting holds its name. Sara
  never creates or submits templates for him and never sends marketing ones.
- The card shows the window in words: "You can get messages from her for 17 more hours. Write to her
  any time to reopen it." and the cost line: "Chats you start are free. A nudge after 24 hours costs
  what Meta charges for a utility template in your country (a few cents)." [W13]

### 4.11 Pace, caps and the rules Sara keeps

| Rule | Value | Why |
|---|---|---|
| Pace to one person | ≤ 1 message every **6 s** on average, bursts of ≤ 5 (the reply's parts and files), reactions and the working line count; reads and typing are not paced | Meta's pair rate [W2]; `131056` never seen in normal use |
| `131056` / `130429` | back off 4^X s (1, 4, 16, 64…) up to 5 minutes [W2], the queue keeps order; the owner sees the reply late, never lost | Meta's own advice |
| Total sends | ≤ 200 an hour and 1,000 a day across WhatsApp (constants; Settings shows today's count) | a stuck loop stops itself |
| Who she writes to first | only him, only inside his window, only with the switch (§4.10) | opt-in [W5, W23] |
| Templates | utility only, his own, to him only, ≤ 1 a day, off by default | money, policy |
| Accounts | Sara never creates apps, portfolios or numbers; *Register my number* is one API call he presses (§5.2) | his account, his terms |

### 4.12 When things go wrong

Every failure goes through `diagnose()` (§5.3): one plain sentence, the fix, a button. A failed send
of a reply is retried per §4.11, then kept in the app with a notice in the conversation ("WhatsApp
didn't deliver this: <title>. It's here instead."). Failures that need him (token expired, number
restricted, webhook gone quiet) also go to Today's *Needs you* once, and to the safety check-up's
list (Phase 121) as *WhatsApp needs attention*.

### 4.13 The manifest (`plugins/whatsapp/sara-plugin.json`, abridged)

```json
{
  "manifest": 1, "id": "whatsapp", "name": "WhatsApp", "version": "1.0.0",
  "description": "Talk to her on WhatsApp through your own WhatsApp Business account (Meta's Cloud API).",
  "author": "The Sara team", "license": "same as Sara", "sara": ">=2.55.0", "main": "main.mjs",
  "permissions": {
    "bridges": ["whatsapp"], "bridgeFiles": true, "settings": true, "webhooks": "bridge",
    "connect": [
      { "id": "graph", "host": "setting:graphHost", "ports": [443], "where": "public", "tls": "required" },
      { "id": "media", "host": "setting:mediaHost", "ports": [443], "where": "public", "tls": "required" }
    ],
    "files": { "read": ["plugin-data"], "write": ["plugin-data"] }
  },
  "settings": [
    { "key": "phoneNumberId", "type": "text", "label": "Phone number ID", "tip": "…" },
    { "key": "wabaId", "type": "text", "label": "WhatsApp account ID", "tip": "…" },
    { "key": "token", "type": "secret", "label": "Access token", "tip": "…" },
    { "key": "typing", "type": "switch", "label": "Show typing (also shows blue ticks)", "default": true, "tip": "…" },
    { "key": "readReceipts", "type": "switch", "label": "Send read receipts", "default": false, "tip": "…" },
    { "key": "mirror", "type": "switch", "label": "Send reminders and messages she starts to my WhatsApp too", "default": false, "tip": "…" },
    { "key": "nudge", "type": "switch", "label": "Nudge me with a paid template when the 24 hours are over", "default": false, "tip": "…" },
    { "key": "nudgeTemplate", "type": "text", "label": "Template name", "tip": "…" },
    { "key": "graphVersion", "type": "text", "label": "Graph API version", "default": "v26.0", "advanced": true, "tip": "…" },
    { "key": "graphHost", "type": "text", "label": "Graph host", "default": "graph.facebook.com", "advanced": true, "tip": "…" },
    { "key": "mediaHost", "type": "text", "label": "Media host", "default": "lookaside.fbsbx.com", "advanced": true, "tip": "…" }
  ]
}
```
New in the manifest: `permissions.webhooks: "bridge"` (the plugin may own one bridge hook; review
card line "Receives messages from Meta at a public web address Sara gives it") and the settings flag
`advanced` (folded under *Advanced* in the settings window; any plugin may use it). The tips are in
§6.4.

---

## 5. The guided setup (the exact Meta screens) and plain-language diagnostics

### 5.1 The guide card: one step at a time, checked as he goes

Settings → Connections → **WhatsApp** (`co-whatsapp`). Before the plugin is installed the page is one
card: what it is ("Text her on WhatsApp. Uses Meta's official WhatsApp Business service with an
account you own. About 30 minutes, once."), what he needs, the terms box, and **Start**. After
that the card is a **stepper**: one step open at a time, each with the Meta screen's exact path in
bold, a picture of that screen with the spot to click circled, the value to copy or paste, and a
check that runs as soon as he pastes. A step turns ✓ only when Sara has *checked* it, never on "I
did it". He can leave and come back; the card resumes at the first unchecked step. Each step has
*This screen looks different* (opens Report a problem with the step id, Phase 113), because Meta
renames its dashboard often; the steps live in `plugins/whatsapp/guide.json` (labels, paths,
pictures, per language) so a label change is a data fix, not code (§13 Q14).

**Before you start (what he needs, in the card):** a Facebook account (a personal one is fine; Meta
calls this "developer registration") · his phone with WhatsApp · about 30 minutes at a computer ·
a public HTTPS door for Sara (step 7 says whether he has one) · optional: a spare phone number that
is **not** on WhatsApp, only if he wants a real number later. And the **terms box** (§7.6), with the
tick *I understand this uses my own WhatsApp Business account under Meta's terms*.

| # | Step (card title) | Exactly where in Meta | What he copies / does | Sara's check (✓ when) |
|---|---|---|---|---|
| 1 | **Add WhatsApp to Sara** | — | *Add WhatsApp* → the review card (*Comes with Sara*; "Carries chats with her for whatsapp", "Can send and receive pictures and files", "Connects to graph.facebook.com and lookaside.fbsbx.com (port 443, always encrypted)", "Receives messages from Meta at a public web address Sara gives it", "Keeps its own files in its own folder") → *Install* → switch on for her. | the plugin runs |
| 2 | **Make a Meta app** | **developers.facebook.com/apps** → **Create app** → app name *Sara* (any name) + his email → use case **Connect with customers through WhatsApp** → **Next** → *Select a business portfolio* (or **Create a business portfolio**: a name, his name, his email) → **Next** → **Create app** [W19] | nothing to copy yet; the dashboard lands on **Customize use case → Connect on WhatsApp → Quickstart** | the next step's IDs check out |
| 3 | **Copy two numbers** | **Quickstart → Start using the API** → **API Setup**: under *Send and receive messages*, the **From** field shows the test number; below it **Phone number ID** and **WhatsApp Business Account ID** (the newer screen says *Messaging account ID*) | paste **Phone number ID** and **WhatsApp account ID** into the card | format only now (digits, 10–20); the token step checks they belong together |
| 4 | **Let your phone talk to the test number** | same **API Setup** page → **To** → **Manage phone number list** → **Add phone number** → his own number → the code WhatsApp sends him → **Verify** | nothing; then he may press **Send message** there once to see the *hello_world* template arrive | after step 9: his first message arrives |
| 5 | **Make a key that doesn't expire** | **business.facebook.com/settings** (Business Settings) → **Users → System users** → **Add** → name *sara*, role **Admin** → **Create system user** → **Assign assets**: *Apps* → his app → **Full control**; *WhatsApp accounts* → his account → **Full control** → **Save** → **Generate token** → choose the app → expiry **Never** → permissions **whatsapp_business_messaging**, **whatsapp_business_management** (and **business_management**) → **Generate token** → **Copy** [W22] | paste the **access token** (`EAA…`) into the card (it goes to the vault; never shown again) | `GET /<PHONE_NUMBER_ID>?fields=display_phone_number,verified_name,quality_rating,platform_type` answers, and `GET /<WABA_ID>/phone_numbers` lists that id: "✓ Token works for +1 555 0100 (Test Number)" |
| 6 | **Copy the app's secret** | **developers.facebook.com/apps** → his app → **App settings → Basic** → **App secret** → **Show** (Facebook asks for his password) | paste the **App secret** (32 hex characters) into the card (vault, as the hook's secret) | format; the first signed delivery confirms it (step 8) |
| 7 | **Give Meta a way in** | — (Sara's side) | the card says which applies (§2.10): *Your own web address ✓* · *Tailscale: Open the public door* (button or command, §3.1 W2; Funnel may first need **Allow Funnel** in the Tailscale admin console, the CLI's link is shown) · *Something else*: paste a Cloudflare Tunnel or proxy address | Sara fetches `https://<door>/hook/ping` **from the outside** only if he presses *Check from outside* (the ST7 rule), else the next step proves it |
| 8 | **Connect Meta to Sara** | **developers.facebook.com/apps** → his app → **Use cases → Customize → Configuration** (older apps: **WhatsApp → Configuration**) → **Webhook** → **Edit** → **Callback URL** = Sara's (Copy) → **Verify token** = Sara's (Copy) → **Verify and save** → then **Webhook fields → Manage** → **messages** → **Subscribe** [W4] | two *Copy* buttons; the callback is `https://<door>/hook/<id>.<secret>` | the handshake arrives: "✓ Meta reached Sara at 14:02"; then `GET /<WABA_ID>/subscribed_apps` lists his app (if not: **Fix it** = `POST …/subscribed_apps`, one tap) |
| 9 | **Say hello** | his phone → WhatsApp → a new chat with the test number (the card shows it, with a *wa.me* link and a QR code) | *Link my WhatsApp* gives a code; he sends `/link 123456` | the signed webhook arrives, the link is made, the identity check is switched on: "✓ Linked. Say hi to her." |
| 10 | **Test** | — | *Test* (§5.4) | all lines ✓ |

The card ends with what happens now ("Message her any time. Chats you start are free. She can only
write first within 24 hours of your last message.") and two optional cards: **Use a real number**
(§5.2) and **Let other people talk to her** (partners).

### 5.2 Use a real number (optional, later)

For a number of her own instead of the test number (a display name, partners beyond the test list):

1. **A number that isn't on WhatsApp** (a spare SIM, a landline that can take a voice call, a VoIP
   number he owns). A number on WhatsApp must be deleted from the WhatsApp app first; the card says
   so in bold, because that removes its chats from that phone [W21].
2. **WhatsApp Manager** (**business.facebook.com/latest/whatsapp_manager** → **Account tools → Phone
   numbers**) → **Add phone number** → display name ("Sara"; Meta reviews it against its display-name
   rules; the card suggests his own name or his business's, §13 Q16) → category → the number → **SMS**
   or **Voice call** → the code → **Next** [W18].
3. **Two-step PIN:** WhatsApp Manager → that number → **Two-step verification** → set a 6-digit PIN.
4. **Register it from Sara:** *Register my number* asks for the new **Phone number ID** (shown in API
   Setup's *From* list) and the PIN, sends `POST /<id>/register {messaging_product, pin}` once, and
   **forgets the PIN** [W18]. It explains the 10-tries-in-72-hours limit before he presses.
5. Sara switches `phoneNumberId`, re-runs steps 8–10 for the new number (the app's webhook stays
   the same), and asks him to send `/link` again from his phone to the new number.

**Business verification** is not asked for. The card mentions it once, in the *Use a real number*
card: "Only needed if you want your display name shown in chat headers or more than two numbers."

### 5.3 Plain-language diagnostics (`diagnose()`)

Every Graph error, webhook verdict and setup state maps to one line. Codes are Meta's error-code
page [W14] unless marked; `137000` is from the identity change check [W18]. The card shows **title** and
**fix** with buttons; *Details* shows the code and Meta's own message (scrubbed of the token).

| Code | How Sara knows | What she says (title, then fix) | Buttons |
|---|---|---|---|
| `TOKEN_EXPIRED` | Graph `190` [W14] | **Your WhatsApp key has expired.** Make one that never expires: step 5, *expiry: Never*. | Show step 5 · Paste a new key |
| `TOKEN_WRONG_APP` | `190`/`200`, or the phone id isn't in `GET /<WABA>/phone_numbers` | **This key can't see that phone number.** In Business Settings → System users → sara → *Assign assets*, give it your WhatsApp account, then make a new key. | Show step 5 |
| `PERMISSION` | `10` ("Permission is either not granted or has been removed") or `200` [W14] | **The key is missing a permission.** Tick *whatsapp_business_messaging* and *whatsapp_business_management* when you make it. | Show step 5 |
| `IDS_SWAPPED` | the WABA id answers as a phone number or the other way round | **Those two numbers are swapped.** *Phone number ID* is the one next to the phone number. | Swap them |
| `NOT_REGISTERED` | `133010` ("Phone number not registered") [W14] or platform type not `CLOUD_API` | **This number isn't switched on for the Cloud API yet.** Press *Register my number*. | Register my number |
| `NO_DOOR` | `accessInfo().hookUrl` empty | **Meta can't reach Sara yet.** It needs a public https address; choose one in step 7. | Open the public door · Something else |
| `DOOR_CLOSED` | *Check from outside* fails, or Meta's dashboard says it couldn't verify and no GET arrived | **Meta couldn't reach Sara at <door>.** Is Tailscale running and Funnel allowed? (Admin console → Access controls → *Funnel*.) | Check again · Show the command |
| `VERIFY_TOKEN` | a handshake GET with another token | **Meta knocked, but with a different verify token.** Copy Sara's verify token again into Meta's *Verify token* box. | Copy verify token |
| `BAD_SIGNATURE` | `meta` verify fails (5 in a row) | **Messages from Meta aren't signed with the secret Sara has.** Copy the *App secret* again (App settings → Basic → Show). | Paste the App secret |
| `NOT_SUBSCRIBED` | no delivery 2 minutes after a test message, `subscribed_apps` empty, or field `messages` off | **Meta isn't sending her your messages.** In Configuration → Webhook fields, subscribe to *messages*. | Fix it (subscribe the app) · Show step 8 |
| `DEV_MODE` | everything above ✓ and still no delivery for his messages | **Your Meta app may still be in development mode.** Meta only delivers some messages to live apps: App Dashboard → *Publish* (it asks for a privacy policy address; Sara's help page has one you can use). | Show me |
| `NOT_RECIPIENT` | a send from the test number to a number not on its list (the code is taken from a recorded real answer at build time; it is not on Meta's error page today) | **The test number can only write to numbers on its list.** Add yours in API Setup → To → *Manage phone number list*. | Show step 4 |
| `WINDOW_CLOSED` | `131047` [W14] | **It's been more than 24 hours since you wrote to her on WhatsApp, so Meta won't deliver her message.** Write to her and she'll answer. It's in the app meanwhile. | Open in the app |
| `PAIR_RATE` | `131056` | **Too many messages to you too quickly.** She'll send the rest in a minute. | — |
| `THROUGHPUT` | `130429`, `131057` | **Meta is busy with this number.** She'll retry. | — |
| `NOT_DELIVERED` | `131026`, `131049` | **WhatsApp couldn't deliver this** (the phone may be offline or on an old WhatsApp). It's in the app. | Open in the app |
| `MEDIA_FAILED` | `131052`, a media `404` twice, a hash mismatch | **She couldn't download that file from WhatsApp.** Send it again, or use the app. | — |
| `IDENTITY_CHANGED` | another `identity_key_hash`, or `137000` | the §4.4 lines | It's me · Unlink |
| `RESTRICTED` | `368`, `131031`, `130497`, `131048` [W14] | **Meta has restricted this WhatsApp account or number.** Sara can't fix this; open WhatsApp Manager → *Account quality* to see why and appeal. | Open WhatsApp Manager |
| `PRIVATE_LOCAL` | private local mode on | **Paused: "Nothing leaves this computer" is on.** Meta keeps your messages for up to 7 days and sends them when it's off. | Settings |
| `MEDIA_HOST` | a media URL on another host than *Media host* | **Meta now sends files from <host>.** Update *Media host* under Advanced. | Use <host> |
| `UNKNOWN` | anything else | **WhatsApp said: <title>.** + the code | Details · Try again |

### 5.4 What *Test* does

One press, a checklist of about a dozen lines, the first failing one opened with its diagnosis, the
rest grey (SSH_EASY §4.2's component): plugin running → token valid → phone number belongs to the
account → number is on the Cloud API (`platform_type`, `code_verification_status`) and Meta sends its
webhooks to this Sara (`webhook_configuration`) → the door has an
https address → Meta's handshake happened (time shown) → the app is subscribed to the account →
signature checked on the last delivery → identity check on → his chat linked and the window state.
It **sends nothing to anyone**; *Send me a test message* is a separate button (a reply only, so only
when his window is open). The quality rating (`GREEN/YELLOW/RED`) is shown as a word, with a link to
WhatsApp Manager when it isn't green.

---

## 6. Tables, routes, UI and ? tips

### 6.1 Tables (additive)

`store.db` of the companion the plugin runs for:
```sql
CREATE TABLE IF NOT EXISTS bridge_windows (
  bridge TEXT NOT NULL,               -- 'plugin-whatsapp' (any plugin with ready.bridge.window)
  chat_key TEXT NOT NULL,             -- the BSUID (or wa_id) of the chat
  last_in_at TEXT NOT NULL,           -- his last message's own timestamp (Meta's), not arrival time
  open_until TEXT NOT NULL,           -- last_in_at + window hours
  closed_by TEXT,                     -- '131047' when a send proved it closed early
  PRIMARY KEY (bridge, chat_key)
);
```
`bridge_identities` (Phase 117) takes `bridge = 'plugin-whatsapp'`, `chat_key` = his BSUID,
`fingerprint` = the identity key hash. `bridge_skips` takes the reasons `stranger`, `duplicate`,
`not-to-her` (another phone number id), `group`, `old` (> 24 h late), `muted` (a partner who said
stop), `status-unknown` (a status for a message Sara doesn't know).

The owner's database, ST7's hooks table (from `src/webhooks.ts`), two columns:
```sql
ALTER TABLE hooks ADD COLUMN owner_plugin TEXT;     -- 'whatsapp': made and locked by that plugin; mode 'bridge'
ALTER TABLE hooks ADD COLUMN verified_at TEXT;      -- the last successful GET handshake (kind 'meta')
```
(added through `EXTRA_COLUMNS` in `src/webhooks.ts`, the existing guard; `verify` accepts `'meta'`). Removing the plugin removes
its hook and vault entries; deleting a conversation removes nothing here; `bridge_skips` rows older
than 30 days go with the hourly housekeeping (as today).

### 6.2 Routes (owner only; `plugins` and `hooks` are not member route families, as today)

- `POST /api/plugins/install {builtin: 'whatsapp'}` → the review card (origin `builtin`, Phase 117).
- `GET /api/plugins/whatsapp/setup?companion=` → the stepper state: `{steps: [{id, ok, checkedAt,
  diagnosis?}], door: {mode, hookUrl, canOpen, command}, window: {openUntil}, number: {display,
  verifiedName, quality, test: boolean}}`.
- `POST /api/plugins/whatsapp/webhook {companion, appSecret}` → creates (or returns) the plugin's
  bridge hook: `{callbackUrl, verifyToken}` (the verify token is shown until the first handshake,
  then only *Make a new one*). A second call with `appSecret` replaces the secret only.
- `POST /api/plugins/whatsapp/check {companion, step}` → runs one step's check (§5.1) through the
  plugin (`{type: 'bridge.check', step}`), returns `{ok, diagnosis?}`; 20 s; read-only Graph calls
  only, except `subscribe` and `identity` below.
- `POST /api/plugins/whatsapp/fix {companion, fix: 'subscribe' | 'identity-check'}` → the two one-tap
  fixes (`POST /<WABA>/subscribed_apps`; `POST /<PHONE>/settings {user_identity_change}`), each shown
  and confirmed first.
- `POST /api/plugins/whatsapp/register {companion, phoneNumberId, pin}` → §5.2 step 4; the PIN is
  never stored or logged (the request body is excluded from the access log like a password).
- `POST /api/access/door {action: 'open' | 'close' | 'check'}` → W2 on desktop apps and Linux installs
  where Sara may run the Tailscale CLI; elsewhere `{command}` to copy. `check` is *Check from outside*.
- Existing, reused: `POST /api/plugins/:id/link`, `DELETE /api/plugins/:id/link/:chat`, `POST
  /api/plugins/:id/test`, `GET /api/plugins/:id/bridge`, `POST /api/plugins/:id/identity`.
- Public: `GET` and `POST /hook/<id>.<secret>` (W1). Nothing else is public.

### 6.3 UI at 1440 and 390

**1440 × 900, before it's connected (Settings → Connections → WhatsApp).** The settings frame as on
`co-signal`: the section list on the left, the page on the right with a head (*WhatsApp* + the status
chip *Not set up*). The page body is two columns:

```
┌ WhatsApp ··········································· [Not set up] ┐
│ ┌ Set up WhatsApp ─────────────── 3 of 10 ┐ ┌ The screen you need ─────────────┐ │
│ │ ✓ 1 Add WhatsApp to Sara                │ │ [picture: API Setup, the two IDs  │ │
│ │ ✓ 2 Make a Meta app                     │ │  circled]                         │ │
│ │ ● 3 Copy two numbers                    │ │ developers.facebook.com/apps →    │ │
│ │   Quickstart → Start using the API →    │ │ your app → API Setup              │ │
│ │   API Setup                             │ │ [Open Meta ↗]                     │ │
│ │   Phone number ID   [1065403522429__] ? │ │                                   │ │
│ │   WhatsApp account ID [10229012934___] ?│ │ This screen looks different?      │ │
│ │   ✓ looks right                         │ └───────────────────────────────────┘ │
│ │   [Next]                                │ ┌ Good to know ─────────────────────┐ │
│ │ ○ 4 Let your phone talk to the test no. │ │ Chats you start are free.         │ │
│ │ ○ 5 Make a key that doesn't expire      │ │ She can only write first within   │ │
│ │ ○ … 10 Test                             │ │ 24 hours of your last message.    │ │
│ └─────────────────────────────────────────┘ │ Meta's terms: [read the box]      │ │
│                                             └───────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────┘
```
Left (≈ 560 px): the stepper; done steps are one line with ✓ and *Change*; the open step shows its
path in bold, the fields with ? tips, the live check line (✓ green / the diagnosis title in amber
with its fix and buttons), and *Next* (enabled when checked; *Skip for now* only on steps 4 and 7,
which a later check proves). Right (≈ 420 px): the picture of the Meta screen for the open step
(click to enlarge, `web/lightbox.js`), *Open Meta ↗* (a new tab at the exact page), *This screen
looks different?*; below it *Good to know* (cost, window, terms). Keyboard: Enter = *Next*, all
fields labelled, the check line is a live region.

**1440 × 900, connected.** The stepper folds into a summary card: chip *Connected*, "+1 555 0100
(Test Number) · linked to you · window open 17 h · quality: good", *Test*, *Send me a test message*,
*Use a real number*, *Unlink*. Then the cards shared with every v1.2 chat plugin (as built for
Signal): **Who can reach her** (*Let other people talk to her*, the numbers list), **Commands**,
**Pictures and files** (BR1, with Meta's limits named), **While she works** (*Show typing (also shows
blue ticks)*, the working line preview "Working on it: … [⏹ Stop]"), **Her messages first** (*Send
reminders … too*, *Nudge me with a paid template*, the template name and the exact text to submit),
**Today** (received, sent, ignored by reason), **Advanced** (folded: Graph version and hosts, the
webhook address with *New address*, *Open the public door* / *Close*).

**390 × 844 (phone).** One column. The head keeps the chip. The stepper is a vertical list; the open
step expands in place with its picture **above** the fields (full width, tap to zoom), the Meta path
as a bold breadcrumb that wraps, the fields full width with ? tips as tap-to-open popovers, and a
sticky bottom bar *Back · Next* above the safe area. *Open Meta ↗* opens the Meta page in the phone's
browser; the card says "Easier on a computer: Meta's console is hard to use on a phone." with *Send
these steps to my email* (a `mailto:` with the step list, nothing sent by Sara). Copy buttons are
44 px targets; the callback URL and verify token show as two-line monospace with *Copy* each.
Connected: the summary card first, the shared cards stacked, *Advanced* folded.

**The chat itself** (web and phone apps): sessions file into the *WhatsApp* channel project (CH2);
the session's info panel shows "From WhatsApp · window open 17 h" and failed deliveries as a quiet
line under her message ("Not delivered on WhatsApp: more than 24 h since you wrote. It's here.").

### 6.4 ? tips (every setting; each ≤ 260 characters)

Manifest settings:
- *Phone number ID*: "A long number from Meta's API Setup page, next to her phone number (not the phone number itself).
  Sara uses it to send as that number."
- *WhatsApp account ID*: "Also on API Setup (Meta may call it Messaging account ID or WhatsApp Business Account ID).
  Sara uses it to check the setup."
- *Access token*: "The key from Business Settings → System users → Generate token, with expiry Never. Kept
  encrypted in Sara's vault and never shown again. Anyone with it can send as this number."
- *Show typing (also shows blue ticks)*: "Shows the typing dots while she works. WhatsApp only allows this
  together with marking your message as read, so you'll see blue ticks too."
- *Send read receipts*: "Blue ticks as soon as she has your message, even when typing is off. Off by
  default."
- *Send reminders and messages she starts to my WhatsApp too*: "Her reminders and messages she starts also
  come here, but only within 24 hours of your last WhatsApp message (Meta's rule). Free."
- *Nudge me with a paid template when the 24 hours are over*: "After 24 hours of quiet, Meta only allows
  pre-approved templates, which cost a few cents. At most one a day, only to you. Off by default."
- *Template name*: "The name of the utility template you made in WhatsApp Manager for the nudge. Sara
  shows the exact text to submit."
- *Graph API version*: "The version of Meta's API Sara talks to. Leave it unless a Sara update or the
  Test button tells you to change it."
- *Graph host* / *Media host*: "Where Meta's API and its files live. Leave these as they are; Sara only
  connects there, encrypted, and checks the certificate."

Core and card settings:
- *App secret* (setup step 6): "From App settings → Basic. Sara uses it to check that each message
  really comes from Meta. Kept in the vault; the WhatsApp plugin never sees it."
- *Callback URL* / *Verify token* (step 8): "Paste both into Meta's Webhook settings. The address is
  secret: keep it to yourself. The verify token only proves to Meta that this is your Sara."
- *Open the public door*: "Lets Meta reach Sara's message address on the internet through Tailscale
  Funnel. Only that address is public; the app itself stays private. Close it any time."
- *Link my WhatsApp*: "Gives a code for 10 minutes. Send it to her number from your own WhatsApp.
  That's how she knows which chat is you, and it opens the 24-hour window."
- *Let other people talk to her*: "Off by default. When on, only numbers you list can chat with her,
  as an AI: no tools, nothing private, nothing sexual, the AI notice first."
- *Numbers who may talk to her*: "One number per line in + form (+44 7700 900123). They must write to
  her first; she never starts a chat with anyone but you."
- *Register my number*: "Switches your new number on for Meta's Cloud API. Needs the 6-digit PIN you
  set in WhatsApp Manager. Meta allows 10 tries in 3 days. The PIN isn't kept."
- *While she works* (WhatsApp): "WhatsApp can't edit messages, so long jobs get one 'Working on it'
  line with a Stop button, and then her answer."
- *Test*: "Checks each step (the key, the number, Meta reaching Sara, the link) and says what to fix.
  Sends nothing to anyone."

---

## 7. Security, safety and household isolation

### 7.1 Credentials

- **Access token** → vault `plugin:whatsapp:token` (a `secret` manifest setting), write-only, never in
  settings, logs, the review card, exports or backups in clear (backups carry the vault encrypted, as
  today). It reaches the plugin in `init.secrets` and is only ever written to the two verified TLS
  sockets of W3. Scrubbed from the plugin log, `bridge.status`, diagnostics' *Details* and the
  delivery log (`opts.scrub` + the vault's values + an `EAA[A-Za-z0-9]{20,}` shape added to
  `KEY_SHAPED`).
- **App Secret** → the hook's vault entry (`webhook:<id>`), used only by Sara's signature check. The
  plugin never has it, so a broken plugin can't forge deliveries to itself.
- **Verify token** → made by Sara (128 bits, base64url), `webhook:<id>:verify`; it only proves to Meta
  that the URL is his; *Make a new one* replaces it.
- **The callback URL's secret** is the ST7 URL secret (hashed); a wrong one is a plain `404`.
- **The PIN** for *Register my number* is never stored or logged.
- **Settings never hold a credential:** a token pasted into *Phone number ID* is refused ("That looks
  like a key; put it in *Access token*.").

### 7.2 Strangers, partners and prompt injection

- **No tools from strangers, ever.** Unlisted numbers get one hello line (only with a window, which
  their message opened) and nothing more; with *others* on, listed numbers are partners
  (`partnerNote`, no tools, no memory, nothing private, nothing sexual, the AI notice first and every
  3 hours).
- **Owner powers need proof:** his BSUID **and** his pinned identity key hash (§4.4); a mismatch never
  falls back to owner powers.
- **Forwarded messages** (`context.forwarded` / `frequently_forwarded`) are someone else's words: the
  text is fenced as `FORWARDED` and the turn is marked `meta.untrusted` (Phase 117's rule: every
  automatic tool asks first in that turn).
- **Webhook bodies are data.** The signature is checked on the raw bytes before parsing; the plugin
  validates the shape (unknown types become marks); a payload for another phone number id is skipped.

### 7.3 The mandatory safety layer

Untouched and on every new path: the AI disclosure first in a new partner chat and every 3 hours, and
honesty when sincerely asked; crisis resources (a crisis line from him or a partner gets them, as on
every bridge); the minors block (`minorSexualMatch` on every incoming text, caption, voice-note
transcript and outgoing reply; `MINOR_BLOCK_REPLY`); no adult content on WhatsApp (`adult: false`, as
for every plugin bridge); BR1's describe-first for partners' pictures. Her business profile's *About*
line is set during setup (with his OK) to "An AI companion, not a person." so anyone who opens the
profile sees it too. Nothing in this phase can turn any of it off.

### 7.4 Household isolation

- **One companion per number.** The plugin can be switched on for one companion at a time (Phase
  117's `connect` rule: "WhatsApp is already on for Mia. Switch it off there first."), and the
  bridge hook belongs to that companion. A second companion needs her own number (and Phone number
  ID) and her own hook; the same Meta app can serve both (one app, several numbers; the plugin skips
  entries for the other number).
- **Each companion's own data:** conversations, `bridge_windows`, `bridge_identities`, `bridge_skips`
  in that companion's `store.db`; the plugin's folder `plugin-data/whatsapp/<companion>/`.
- **Members** never see plugins or hooks (owner-only routes, `household.ts`); a member's number on the
  allow-list is just a partner; a member can't link as owner.
- **Other apps** (`/v1`, MCP, A2A, the Webhooks page's automations) never see `plugin-whatsapp`
  conversations; the bridge hook's deliveries never reach `event:webhook` hooks.

### 7.5 Private local mode and the network guard

- **Private local mode on** → P1 refuses and closes the Graph sockets; the bridge hook answers `503`
  so Meta holds deliveries for up to 7 days [W4]; the chip says *Paused (Nothing leaves this
  computer)*; the door stays as it is (closing it is his choice; an open door with a `503` behind it
  leaks nothing). Turning the mode off delivers the backlog through §4.3's "while I was away" rule.
- **The network guard** (`checkOutbound`) sees every Graph connection (P1 calls it). If his guard
  rules block Meta's hosts, *Test* says "Your network rules block graph.facebook.com" with a link to
  them.
- **The demo** refuses the plugin and the door (as for Alexa and Signal).

### 7.6 The terms box (shown before *Start*, and in the connected card's footer)

> **About Meta's rules.** This uses the WhatsApp Business service with a Meta account and number that
> **you** own, under Meta's WhatsApp Business terms. Since January 2026 those terms forbid offering a
> general-purpose AI assistant on WhatsApp as a product. Sara is your own companion on your own
> account, but Meta decides how its terms apply and can restrict an account or number. Use a number
> you can afford to lose, keep her to you and people you choose, and read the terms:
> *WhatsApp Business Solution Terms ↗*. ☐ *I understand and want to continue.*

The tick is stored with its date and the terms' *Last modified* date the box was written for; when a
Sara update ships a new box (Meta changed its terms), the card asks again.

### 7.7 Threat model additions (`docs/THREAT_MODEL.md` in the release)

| Threat | Defence |
|---|---|
| A forged webhook (someone found the URL) | URL secret (`404`), `X-Hub-Signature-256` with the App Secret on the raw bytes before parsing, sender pause after 5 failures |
| A replayed webhook | `wamid` / status id dedupe for 24 h; messages older than 24 h are filed, not answered |
| A stolen or leaked access token sends as her | vault only, TLS-only, scrubbed; *Paste a new key* revokes nothing at Meta, so the card says how to revoke (Business Settings → System users → *Revoke tokens*) |
| Someone takes over his number or moves his WhatsApp to a new phone | identity key hash changes → owner powers paused until he confirms in the app (§4.4) |
| A stranger messages her number | one hello, no tools, counted; on the test number strangers can't write at all |
| A partner tries to get her tools or his data | partner rules; no tools offered |
| A forwarded message carries instructions | fenced, `meta.untrusted`, tools ask |
| The public door exposes the app | Funnel serves `/hook/` only on its own port; the app stays tailnet-only; `/hook/` has no cookie, session or app key |
| A flood of messages burns money or model budget | Meta's own pair rate on the sender side, ST7 hook limits, BR1 quotas, turn budgets, the daily send caps |
| Meta restricts the account | not preventable by Sara; owner-first defaults, no first messages, no templates by default, the terms box |
| Her messages kept at Meta | Meta stores media 30 days and handles messages under its terms; the card's privacy line says WhatsApp chats pass through Meta (unlike Signal's end-to-end path) |

---

## 8. The unofficial libraries (whatsapp-web.js, Baileys): why Sara doesn't build them in

**What they are.** whatsapp-web.js drives the WhatsApp Web page in a headless Chrome (Puppeteer) and
calls its internal functions [U1]; Baileys speaks WhatsApp Web's own WebSocket protocol directly
[U2]. Both link to a **personal** WhatsApp account as a "linked device" by scanning a QR code: no
Meta app, no business account, no public URL, no 24-hour window, groups included. For a beginner
that is a much shorter setup, which is why other agents offer it.

**Why not in Sara:**

1. **The number can be banned.** WhatsApp: "Using an unauthorized application and/or unsupported
   device violates our Terms of Service and can result in your account being banned" [U3]; its terms
   forbid automated and "non-personal" use of the consumer service [W24, U4]. Both projects say they
   are not affiliated with or endorsed by WhatsApp and are used at your own risk [U1, U2]. The account
   at risk is usually the owner's **own** number, with years of his family's chats.
2. **It breaks without warning.** They follow WhatsApp Web's internals, which change; a Sara release
   could stop working on a Tuesday because of a change Sara can't see.
3. **It breaks Sara's rules.** Zero npm runtime dependencies (Baileys and whatsapp-web.js are large
   dependency trees; whatsapp-web.js needs a bundled Chrome), the plugin fence (a QR-linked client
   needs its own long-lived sockets to WhatsApp's servers), and "written from scratch" (reimplementing
   the WhatsApp Web protocol ourselves would be the same ban risk with more work).
4. **The owner decided** (2026-10-25, the ROADMAP line): "unofficial WhatsApp Web libraries are not
   used: Meta bans those numbers."

**At most, a plugin.** Sara's plugin system lets anyone package such a bridge as a third-party plugin;
it would get the normal review card (and on fenced hosts couldn't open sockets except through the
broker to hosts the owner types). Sara doesn't ship one, the Store (Phases 124–125) lists none by
the Sara team, and §13 Q17 asks whether the Store should **refuse** them or list them with a red
warning.

---

## 9. Reuse vs build

| Reused as is | Grown | New |
|---|---|---|
| `#bridgeInbound` / `#bridgeTake` / `#bridgeTurn`, CH1 `parseCommand`/`runCommand`/`commandAllowed`, CH2 channel project ("WhatsApp" in `PLUGIN_NAMES`), BR2 `pendingFor`, `btw.ts`, loop guard, Phase 118–119 commands | `webhook-verify.ts`: kind `meta` (`verifyMeta` = `verifyGithub`'s HMAC) | `plugins/whatsapp/` (`main.mjs`, `http1.mjs`, `graph.mjs`, `webhook.mjs` parser, `media.mjs`, `format.mjs`, `checks.mjs`, `diagnose.mjs`, `guide.json`, the shared `sara-plugin.mjs`) |
| P1 socket broker (`net.ts`) incl. the loopback test override, P2 v1.2 fields, P3 `builtin`, P4 link codes, P6 long turns | `webhooks.ts`: GET handshake, `200` answers, delivery mode `bridge` (raw body to the plugin, no body in the log), `owner_plugin`, `verified_at`, bridge-hook limits | `bridge_windows` table + `windowOpen()` |
| BR1 `takeIncoming`, `deliverOutgoing`, quotas, `bridge.file` chunks, `takeChatDocument`, describe-first, `hearNote` | contract v1.2: `ready.bridge.window`, `ready.bridge.buttons`, `bridge.send.buttons`, `bridge.webhook`, `bridge.check`; manifest `permissions.webhooks: 'bridge'` + `advanced` settings | `co-whatsapp` page + the stepper component (`web/setup-steps.js`, reusable for later guided setups) |
| `bridge_identities`, `bridge_skips`, the plugin settings window (v1.2) | `accessInfo().hookUrl`; `lib-access.sh` `door on/off`; `tailscale.ts` runs `funnel` on a tap | `/api/plugins/whatsapp/{setup,webhook,check,fix,register}`, `/api/access/door` |
| `partnerNote`, `disclosureDue`, `minorSexualMatch`, `fenceLines`, `meta.untrusted`, `KEY_SHAPED`, `opts.scrub`, vault | `KEY_SHAPED` + Meta token shape | the guide's pictures (`docs/screenshots/whatsapp/`, ours, ids blurred) |
| `ProgressMessage` (not used: `edit: false`), Telegram's `st:` / `ap:` button ids | `#bridgeTurn`: the working line with a Stop button when `edit: false` and `buttons` | |

Nothing needs an npm package: `node:crypto` for the HMAC (already there), plain JavaScript in the
plugin, HTTP/1.1 over the broker's TLS sockets, multipart written by hand (~60 lines).

---

## 10. Done when (`test/phase122.test.ts`, plus the existing suites green)

Fakes, all on `127.0.0.1` and started by the test:
- **A stand-in Graph API server** (`test/fixtures/whatsapp/graph-server.mjs`): HTTPS with a test CA
  (reached through P1's existing test-only loopback override, `netTestLoopback` under `node --test`,
  never an environment switch in production), answering `GET /<v>/<phone id>`, `GET
  /<v>/<waba>/phone_numbers`, `GET|POST /<v>/<waba>/subscribed_apps`, `POST /<v>/<phone>/messages`
  (text, image, document, reaction, interactive, `status: read`, typing), `POST /<v>/<phone>/media`
  (multipart), `GET /<v>/<media id>`, the media download on the *Media host* (bearer required, the URL
  dies after 5 fake minutes), `POST /<v>/<phone>/settings`, `POST /<v>/<phone>/register`. It records
  every request (method, path, headers minus the token's value, body) and can be told to answer with
  any error code from §5.3 (recorded real error bodies in `test/fixtures/whatsapp/errors/`), to
  enforce the pair rate (1 per 6 s, bursts to 45) and to close the 24-hour window.
- **A fake Meta sender**: signs fixture payloads (`test/fixtures/whatsapp/webhooks/*.json`: text,
  image, document, voice, audio file, reaction, button reply, forwarded, statuses incl. `failed`, a
  batch of 3, another phone number id, an identity-hash change, a BSUID-only sender) with the App
  Secret and POSTs them to the hook, and runs the GET handshake.
- The real plugin process from `plugins/whatsapp`, a fake model that records what it was sent, and a
  fake clock.

**Webhooks (W1)**
- The handshake: right URL secret + `hub.mode=subscribe` + the right verify token → `200` with exactly
  the challenge as `text/plain`; a wrong token → `403` and the `VERIFY_TOKEN` diagnosis; a wrong URL
  secret → the same `404` as an unknown hook; a GET to a non-`meta` hook → `405`; `verified_at` set.
- A signed POST → `200 {"ok":true}` and one `bridge.webhook` line to the plugin with the raw body; an
  unsigned or wrongly signed one → `401`, nothing reaches the plugin, nothing is parsed (a fixture that
  would throw if parsed proves it); 5 bad signatures → the sender's address paused.
- The delivery log of the bridge hook has verdict, size and counts, and **no body text** (grep for the
  fixture's words in the hooks tables finds nothing).
- The same `wamid` delivered twice → one turn. A status for an unknown message → `status-unknown` skip.
- Plugin stopped → `503`; private local mode on → `503` and the Graph sockets closed; back on → the
  retried delivery is taken (§4.3).
- The hook shows in the Webhooks list as locked (`owner_plugin`), can rotate its address, and is gone
  when the plugin is removed (with its vault entries).

**Setup and diagnostics**
- `GET …/setup` walks the ten steps; each `check` returns ✓ or the §5.3 diagnosis: a token answered
  with `190` → `TOKEN_EXPIRED`; a phone id not in `phone_numbers` → `TOKEN_WRONG_APP`; the two ids
  swapped → `IDS_SWAPPED`; `subscribed_apps` empty → `NOT_SUBSCRIBED`, and `fix subscribe` posts it;
  `133010` → `NOT_REGISTERED`; no `hookUrl` → `NO_DOOR`. The words match `diagnose()`'s table.
- *Register my number* sends one `register` with the PIN; the PIN appears in no log, table or
  settings file; an 11th try in 72 h (fake) shows the limit line without calling.
- *Test* sends no message (the fake records only GETs and none to `/messages`).
- Saving a token-shaped value in *Phone number ID* is refused; the token is in the vault only.

**Messages**
- Linking: `/link 123456` from an unpaired chat → `ownerChats`/`ownerIds` get the BSUID and wa_id, the
  identity hash is pinned, the identity check setting was posted; five wrong codes → the code is gone.
- An owner text → one turn on channel `plugin-whatsapp`, filed in the *WhatsApp* project; the reply is a
  `POST /messages` to his BSUID (or wa_id) with `type: text`; a typing call (`status: read` +
  `typing_indicator`) came first, repeated every 20 s of a 70-s turn.
- A 9,000-character reply → three messages, each ≤ 4096, split at paragraphs; a 20,000-character one
  → three messages ending "(continued in the app)".
- Markdown `**bold**`, a table and a link come out as `*bold*`, a monospace block and `text (url)`.
- A partner with `others` off → the hello line once, then nothing; listed with `others` on → a partner
  turn with `partnerNote`, **no tools offered**, the AI notice first; "STOP" from a partner → the
  confirmation and the number muted.
- A BSUID-only sender (no `wa_id`) who is the owner → recognised by BSUID.
- A picture from him → `GET /<media id>` → download with the bearer → hash checked → the fake model's
  message carries the image; a 6 MB fixture (over Meta's 5 MB in) still respects BR1's 8 MB cap; a hash
  mismatch → `MEDIA_FAILED`, no turn content from it.
- A voice note (`voice: true`) → `hearNote` called, the transcript is the message; an audio file
  (`voice: false`) → a document.
- Her picture out → one multipart upload, then `type: image` with the media id; the same file again
  within 30 days → no second upload; a WebP → sent as a document.
- A forwarded owner message telling her to run a tool → fenced `FORWARDED`, `meta.untrusted`, a tool
  set to run on its own **asks**.
- Steer: his plain message while she works → a 👀 reaction on it, taken at the safe point; `/btw` →
  a quoted reply starting "💬".
- Working line: a 3-minute fake turn → exactly one interactive message at 20 s with a Stop button, no
  other message until the reply; tapping Stop (a `button_reply` fixture with `st:<conv>`) stops the
  turn. A 7-minute turn → no partial reply at 5 minutes, the full reply at the end (P6).
- `/continue` offer → a button message only while the window is open; tapping *Continue here* moves
  the session (Phase 119 behaviour).
- An approval in his chat → [Allow] [Deny] buttons; a tap resolves it.

**The window (W4)**
- His message at T → `bridge_windows.open_until = T + 24 h`. A reminder at T + 2 h with *Send
  reminders … too* on → sent; at T + 25 h → not sent, kept in the app; with *Nudge* on and a template
  name → one `type: template` message, and a second reminder the same day → no second template.
- A reply send answered `131047` → the window closes, the reply stays in the app with the
  `WINDOW_CLOSED` note.
- Nothing she starts ever goes to a partner (a reminder mirror never targets a partner chat).

**Pace and failures**
- 10 messages to him queued at once → the fake sees ≤ 5 in the first 6 s and then ≤ 1 every 6 s, and
  never a `131056`; told to answer `131056` once → retried after 1 s, then 4 s, order kept.
- `368` on a send → `RESTRICTED` on the chip, one Today *Needs you*, no retries loop.
- The owner's identity hash changes (fixture) → his next message runs **without tools** with the
  §4.4 line; *It's me* → the new hash pinned, tools back; a `137000` on send → the same pause.
- More than 200 sends in an hour (fake) → the next is held with one owner notice.

**Door and isolation**
- `accessInfo().hookUrl` reads `SARA_HOOK_URL`, falls back to an https `SARA_PUBLIC_URL` with mode
  `domain`, and is empty for `tailscale` without the door, `lan`, `local`.
- `lib-access.sh door on` (shellcheck + a fake `tailscale` on PATH) runs `funnel --bg --https=8443
  --set-path=/hook http://127.0.0.1:<port>/hook` and nothing that exposes `/`; `door off` removes only
  that handler; a second instance gets 10000.
- Switching the plugin on for a second companion → refused with the line. Members get `403` on every
  route of §6.2. The demo refuses the plugin and the door.
- The hostile-plugin fixture with `permissions.webhooks: 'bridge'` can't read the App Secret (it isn't
  in `init`) and can't create a hook for another plugin.
- v1, v1.1 and v1.2 plugins without `window` / `buttons` (LINE example, Signal, Email) behave exactly
  as in 2.54.0; GitHub, Stripe, Standard and header hooks answer exactly as before (`202`, `405` on GET).
- Safety unchanged: a crisis line on WhatsApp gets the resources; a minors-block line (text, caption or
  voice transcript) → `MINOR_BLOCK_REPLY`; the disclosure comes first in a new partner chat.

---

## 11. Owner to-dos

1. **Decide §13 Q1 first** (ship WhatsApp at all, given Meta's AI Providers clause). If no: stop here;
   nothing else in this list applies.
2. **Make the test setup** on your own Facebook account, following the card exactly as a beginner
   would (time it; note every place the card's words don't match Meta's screens, with screenshots).
   Our guide pictures come from this run (ids blurred).
3. **Choose the door:** your own domain already works; otherwise allow **Funnel** in the Tailscale
   admin console (Access controls → nodeAttrs `funnel`) and press *Open the public door*; check that
   Meta accepts the `:8443` callback (§12 risk 3).
4. Make the **System User token** with expiry *Never*, paste it, paste the **App secret**, connect the
   webhook, subscribe to **messages**, link, and *Test*.
5. Try it from your phone: chat; a photo; a PDF; a voice note; a long coding job (watch the working
   line and press **Stop** once); "use pnpm" while it works (👀); `/continue` after chatting in the
   app; wait 25 hours without writing and check a reminder stays in the app.
6. If you want a real number: a spare SIM or VoIP number **not on WhatsApp**, *Use a real number*,
   the PIN, *Register my number*, `/link` again.
7. If the app doesn't receive your messages while everything is ✓: publish the Meta app (*DEV_MODE*;
   it needs a privacy policy URL; decide which one, §13 Q19).
8. Decide §13 Q2–Q21.

---

## 12. Risks

1. **Meta's terms (the big one).** The AI Providers clause [W1] could be read to cover a person running
   an AI companion on his own business account; Meta decides alone and can restrict the account
   (`368`/`131031`) or the number. *Mitigation:* §13 Q1 to the owner; off by default; the terms box
   with a recorded tick; owner-first, partners off, strangers one line, no first messages outside the
   window, no marketing templates; the profile says "An AI companion"; the docs never pitch Sara as "an
   AI on WhatsApp"; the test number (nothing of his at stake) is the default start.
2. **The setup is long and Meta's console changes.** Labels and paths move several times a year.
   *Mitigation:* the guide is data (`guide.json`), every step is *checked*, *This screen looks
   different* reports it, and §11's timed owner run before release.
3. **Meta may refuse a callback on port 8443.** The webhook docs only require HTTPS with a valid
   certificate; ports aren't stated. *Mitigation:* the owner checks it in §11; the `--swap` door (public
   443 for `/hook/`, tailnet app on 8443) and Cloudflare Tunnel / own domain as alternatives.
4. **Funnel's own limits** (bandwidth caps, Funnel off in the tailnet policy, the 1.104.x TLS issue
   reported upstream [T3]). *Mitigation:* `DOOR_CLOSED` names the admin setting; Meta retries 7 days.
5. **Development-mode apps** may not get real users' webhooks. *Mitigation:* `DEV_MODE` diagnosis and the
   publish step; the privacy-policy URL question (§13 Q19).
6. **Everyone behind Funnel or a tunnel shares one address**, so ST7's per-address pause after bad
   signatures could pause Meta too. *Mitigation:* for bridge hooks the pause applies only when the
   request has no `X-Forwarded-For` from a trusted proxy; otherwise bad signatures are counted and
   dropped without pausing (the signature check is cheap); verified at build against what Funnel sends.
7. **No edits, a strict pair rate.** WhatsApp can't show live progress and punishes chatty output.
   *Mitigation:* typing, one working line, ≤ 3 messages per reply, the pacer.
8. **The 24-hour window surprises people** ("why didn't she remind me?"). *Mitigation:* the window in
   words on the card and in the session info, the reminder kept in the app, the optional nudge.
9. **Token handling.** A System User token with *Never* expiry is powerful. *Mitigation:* vault,
   TLS-only, scrubbed, the revoke steps; the card recommends an **employee** system user with only
   this app and account when he's comfortable (Admin is the beginner default because it needs fewer
   clicks; §13 Q20).
10. **BSUIDs and usernames are new** (April 2026 onward, an October 2026 change log [W11]).
    *Mitigation:* owner by BSUID with wa_id as a second key; fixtures for BSUID-only senders; the
    Graph version is a setting.
11. **Privacy is weaker than Signal.** WhatsApp Business messages go through Meta's servers (Cloud
    API), and media sits there up to 30 days. *Mitigation:* the card's privacy line and docs/PRIVACY.md
    say it plainly; private local mode pauses it.
12. **Costs.** Only templates cost money; Sara sends none by default and at most one a day to him when
    he opts in. *Mitigation:* the cost line in words; no marketing templates ever.
13. **Two Sara servers on one app** (a test server left running): Meta sends to the one callback URL
    saved last. *Mitigation:* *Test* reads the number's `webhook_configuration.application` [W2] and
    says "Meta is sending this number's messages to another address (<host>)" when it isn't this
    Sara's door.

---

## 13. Blocking questions (with the defaults the parent applies if the owner is away)

1. **Ship WhatsApp at all, given Meta's AI Providers clause.** Default: **yes, as an option**, built
   as designed: off until installed, the terms box with a tick (§7.6), owner-first, the test number as
   the default start, no marketing, never pitched as "an AI on WhatsApp". Alternatives: hold the
   phase until a lawyer reads the clause (the 1.0 lawyer review, Phase 34, could take it); or build it
   but keep it out of the docs site and the Store shelf (*Comes with Sara* only).
2. **Where a beginner starts.** Default: **Meta's test number** (no SIM, free, only his listed numbers
   can write, enough for him alone); *Use a real number* is an optional card. Alternative: require a
   real number from the start (a display name, partners beyond five numbers, more steps).
3. **Sara-hosted onboarding.** Default: **none**: he makes his own Meta app; Sara (and the Sara team)
   is never a Meta Tech Provider, never hosts Embedded Signup, and never relays webhooks through the
   hub (her words would pass through our server, and we would become the "AI Provider" the terms
   name). Alternative: a hub relay for people without a public address (rejected for privacy and terms).
4. **Her messages after 24 hours.** Default: **kept in the app**; the paid *nudge* template is off,
   his own utility template, at most one a day, only to him. Alternative: no template support at all
   in v1 (simpler; reminders on WhatsApp only inside the window).
5. **Progress on WhatsApp.** Default: **typing + one working line at 20 s with a Stop button**, then
   the reply; partners get typing only (if on). Alternative: typing only (no working line), or a
   working line every 60 s (more messages; pair rate and noise).
6. **Who may talk to her besides him.** Default: **nobody** until *Let other people talk to her* is on,
   then **only listed numbers**; an empty list means nobody. Alternative: anyone who writes, as partners
   (the Signal default), which on a real number means strangers can use her as a chatbot.
7. **A partner's "STOP".** Default: **honoured** (confirmation, muted until he unmutes). Alternative:
   ignore it (partners are people he chose).
8. **Typing marks his messages read.** Default: **typing on in his chat** (blue ticks are fine for
   him), off for partners; *Send read receipts* off. Alternative: typing off by default.
9. **Groups.** Default: **not in Phase 122** (1:1 only; the Cloud API's groups eligibility to be
   studied separately). Alternative: study and add WhatsApp groups as rooms with keep-up later.
10. **Her voice out.** Default: **not in Phase 122** (voice notes in are transcribed; her spoken replies
    stay in the app). Alternative: send her TTS as an OGG/Opus voice note (needs an Opus encoder Sara
    doesn't have without a dependency, or the local voice stack's output format).
11. **Extra webhook fields** (account alerts, quality, template status). Default: **only `messages`**;
    *Test* reads quality on demand. Alternative: subscribe to `account_alerts` and show them on Today.
12. **mTLS for webhooks.** Default: **off** (the signature already proves Meta; Funnel and Caddy
    terminate TLS, so mTLS would need proxy work). Alternative: support it for `domain` installs.
13. **Messages that arrive late** (Sara was down). Default: **< 6 h: answered with "Sorry, I was
    offline"; 6–24 h: one combined "while I was away" turn; > 24 h: filed, not answered**.
    Alternative: answer everything inside 24 h as if live.
14. **The guide's pictures.** Default: **our own screenshots** from the owner's test run, ids blurred,
    stored in `docs/screenshots/whatsapp/`, steps as data (`guide.json`). Alternative: drawn
    illustrations (no Meta UI in our repo; less exact).
15. **The hub ping.** Default: **no change** (WhatsApp counts as `plugin_bridge`; the ping's keys are a
    fixed contract). Alternative: add `whatsapp` to `BRIDGE_IDS` (a contract change, test/phase113).
16. **Her display name on a real number.** Default: the card suggests **his own name or business name**
    with "Sara" in the profile's *About* ("An AI companion, not a person"), because Meta reviews
    display names against its rules. Alternative: "Sara" as the display name (may be rejected).
17. **Unofficial WhatsApp plugins in the Store** (Phases 124–125). Default: **refused** by the Store's
    review (they put the user's number at risk). Alternative: listed with a red warning.
18. **How the plugin reaches Meta.** Default: **the socket broker (P1) + HTTP/1.1 in the plugin**,
    token held by the plugin like the email password. Alternative: grow `sara.fetch` to POST with Sara
    adding the token (the plugin never sees it, but `sara.fetch`'s 1 MB/30-a-minute contract and the
    channel's 1 MB lines would need a streaming upload path).
19. **The privacy-policy address Meta asks for when the app is published.** Default: Sara serves a
    plain page at `/privacy` (it exists: `web/privacy.html`); *Publish help* adds that one static path
    to the door (`--set-path=/privacy`) and offers `<door>/privacy`. Alternative: the owner writes his own.
20. **The system user's role.** Default: **Admin** in the beginner steps (fewest clicks), with an
    *Advanced: use an employee system user* note. Alternative: employee only (two more asset steps).
21. **The door's default.** Default: **Funnel on 8443 for `/hook/` only**, run by Sara on a tap where
    it can (desktop apps, Linux installs with the CLI), else the command to copy. Alternative: only
    show the command (Sara never runs `tailscale funnel` itself).

---

## 14. Key choices in short

- **WhatsApp is a first-party plugin** (`plugins/whatsapp`, bridge `plugin-whatsapp`) on contract
  v1.2, installed through the normal review card; nothing is installed, enabled or updated by itself.
- **Official Cloud API only, his own account:** his Meta app, his business portfolio, his number (the
  test number to start); Sara is never a Tech Provider and hosts no onboarding; unofficial WhatsApp
  Web libraries are not built in and not shipped as plugins by us.
- **In through the webhooks Sara already has:** ST7 grows a `meta` verify kind (Meta signs like
  GitHub), the GET handshake, `200` answers and a `bridge` delivery mode that hands the raw body to the
  plugin and logs no message text; `503` while paused, so Meta keeps messages for 7 days.
- **Out through the socket broker:** HTTPS to `graph.facebook.com` over P1, HTTP/1.1 in the plugin; the
  access token in the vault and only on verified TLS; the App Secret never leaves Sara's core.
- **A public door for `/hook/` only** (Funnel on its own port, or his domain, or a tunnel he pastes);
  the app stays private.
- **The 24-hour window is a first-class idea** (`bridge_windows`): replies always, her own messages
  only inside it and only with his switch; a paid nudge template is his opt-in, once a day, to him.
- **Owner = BSUID + Meta's identity hash**, pinned at linking; a change pauses owner powers.
- **No edits on WhatsApp:** typing (with blue ticks), one working line with a **Stop** button, ≤ 3
  messages a reply, the 6-second pair rate respected by a pacer.
- **Reply buttons** (Stop, Continue here, Allow/Deny) as a small v1.2 addition any plugin may use.
- **A guided card that checks every step** against Meta's API and explains every failure in one plain
  sentence with the fix (`diagnose()`, the SSH_EASY pattern), at 1440 and 390.
- **Safety and isolation unchanged:** disclosure, crisis help, the minors block, partners without
  tools, one companion per number, members see nothing, private local mode pauses.

| Phase | Version | Slice | Main new code | Test |
|---|---|---|---|---|
| 122 (WhatsApp part) | 2.55.0 | `meta` hooks + handshake + `bridge` mode, the door, `bridge_windows`, reply buttons, the WhatsApp plugin, the guided card | `src/webhook-verify.ts`/`webhooks.ts` growth, `deploy/lib-access.sh` door, `plugins/whatsapp/`, `web/setup-steps.js`, `co-whatsapp` | `test/phase122.test.ts` |

The release ships its docs in the same commit (a new `docs/WHATSAPP.md` user guide with the same
steps and pictures, docs/CHATS.md *WhatsApp*, docs/WEBHOOKS.md for `meta` hooks and the door,
docs/PLUGINS.md for `webhooks: 'bridge'`, `buttons`, `window` and `advanced`, docs/PRIVACY.md (WhatsApp
passes through Meta), THREAT_MODEL, `web/help.html`, i18n in six languages, the ? tips, CHANGELOG,
ROADMAP, README "What's new"). iMessage, SMS and Matrix in the same phase reuse W1 (bridge hooks, for
BlueBubbles' and AgentText's webhooks), W3 (HTTPS through the broker) and W5.

---

## 15. Sources

Official documentation read on 2026-11-02 (Meta moved its WhatsApp docs to
`developers.facebook.com/documentation/business-messaging/whatsapp/…`; older `/docs/whatsapp/…`
links redirect or mirror them):

- [W1] WhatsApp, *WhatsApp Business Solution Terms*, last modified January 15, 2026: the **AI
  Providers** clause, Third Party Service Providers and AI Models, restrictions.
  https://www.whatsapp.com/legal/business-solution-terms (read via the `/preview?lang=en` page)
- [W2] Meta, *About the platform*: Graph API, rate limits (200 / 5,000 requests an hour), message rate
  limits, **pair rate limits** (1 message every 6 s, bursts to 45, `131056`, retry 4^X s), user opt-in,
  `webhook_configuration`. …/whatsapp/about-the-platform
- [W3] Meta, *Graph API: Getting started with webhooks*: HTTPS with a valid certificate (no
  self-signed), verification requests (`hub.mode`, `hub.challenge`, `hub.verify_token`), `X-Hub-
  Signature-256` with the App Secret, respond `200`, batches up to 1000.
  https://developers.facebook.com/docs/graph-api/webhooks/getting-started
- [W4] Meta, *Create a webhook endpoint* (WhatsApp): GET verification answered `200` + challenge,
  POST with `X-Hub-Signature-256`, TLS, optional mTLS, retries over **7 days**, *Configuration* →
  Callback URL / Verify token. …/whatsapp/webhooks/create-webhook-endpoint
- [W5] Meta, *Service messages* (send messages): the 24-hour customer service window, message types,
  contextual replies, reactions, typing and read receipts, opt-in, SERVICE pricing category.
  …/whatsapp/messages/send-messages · and *Get started*: test number, *Manage phone number list*.
  …/whatsapp/get-started
- [W6] Meta, *Typing indicators*: `status: read` + `typing_indicator`, dismissed on reply or after 25
  s, only if you will respond. https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
- [W7] Meta, *Media* reference: upload (`/PHONE_NUMBER_ID/media`, kept 30 days), retrieve URL (valid
  5 minutes), download with the token, supported types and sizes (image 5 MB, audio 16 MB, document
  100 MB). https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
- [W8] Meta, *Status messages webhook reference*: sent, delivered, read, failed, played; `errors`;
  identity key hash; pricing block. …/whatsapp/webhooks/reference/messages/status · and *messages
  webhook reference* (incoming vs outgoing). …/whatsapp/webhooks/reference/messages
- [W9] Meta, *Reaction messages*: emoji on a received message, 30 days, only a `sent` status.
  …/whatsapp/messages/reaction-messages
- [W10] Meta, *Text messages*: body up to 4096 characters, `preview_url`. …/whatsapp/messages/text-messages
- [W11] Meta, *Business-scoped user IDs*: BSUIDs (`user_id`, `from_user_id`) since April 2026,
  usernames rolling out in 2026, sending by `recipient`, the October 23, 2026 change. Also *Audio
  messages webhook reference* (`voice`). …/whatsapp/business-scoped-user-ids ·
  …/whatsapp/webhooks/reference/messages/audio · …/webhooks/reference/messages/text (`context.forwarded`)
- [W12] Meta, *Interactive reply buttons messages*: up to 3 buttons, labels ≤ 20 characters, body ≤
  1024. …/whatsapp/messages/interactive-reply-buttons-messages
- [W13] Meta, *Pricing on the WhatsApp Business Platform* (updated Mar 30, 2026): per-message pricing
  since July 1, 2025, only delivered templates charged, non-template messages free inside a window,
  categories. https://developers.facebook.com/docs/whatsapp/pricing
- [W14] Meta, *Error codes*: `190`, `10`, `200`, `130429`, `131026`, `131031`, `131047`, `131048`,
  `131049`, `131052`, `131056`, `131057`, `133010`, `133016`, `368`, `130497`. …/whatsapp/support/error-codes
- [W15] Meta, *Mark messages as read*: `status: read`, earlier messages marked too, within 30 days.
  …/whatsapp/messages/mark-message-as-read
- [W16] Meta, *Throughput*: 80 mps default, 1,000 by upgrade, `130429`, `131057`. …/whatsapp/throughput
- [W17] Meta, *Messaging limits*: 250 → 2,000 (verify your business) → automatic scaling; business
  portfolio level. https://developers.facebook.com/docs/whatsapp/messaging-limits
- [W18] Meta, *Business phone numbers*: eligibility, test number created by Get started, display names,
  two-step verification, registered number cap (2, then 20), verify by SMS/voice, **identity change
  check** (`user_identity_change`, `137000`). …/whatsapp/business-phone-numbers/phone-numbers · and
  *Register a business phone number*: API only, PIN, 10 requests in 72 h (`133016`).
  …/whatsapp/business-phone-numbers/registration
- [W19] Meta, *WhatsApp Cloud API Get Started* (updated Jun 16, 2026): Create App → *Connect with
  customers through WhatsApp* → business portfolio → Quickstart → *Start using the API* → API Setup;
  system user and permanent token. …/whatsapp/get-started
- [W20] Odoo documentation, *WhatsApp* (an integrator's guide): "This test phone number can send
  unlimited messages to a maximum of five recipients." Not Meta's own page; the build re-checks the
  dashboard. https://github.com/Nepritariel08/documentation-odoo20/blob/20.0/content/applications/productivity/whatsapp.rst
- [W21] Meta / integrators, a number already on WhatsApp must be removed from the app before it can
  be registered (Meta's *phone numbers* eligibility "be owned by you … able to receive voice calls or
  SMS" and the migration notes). …/whatsapp/business-phone-numbers/phone-numbers
- [W22] Meta, *Access Tokens Guide* (updated Sep 19, 2026): user tokens expire within hours; system
  user tokens (admin / employee), *Generate token* with `business_management`,
  `whatsapp_business_management`, `whatsapp_business_messaging`, asset access. …/whatsapp/access-tokens
- [W23] WhatsApp, *WhatsApp Business Messaging Policy* (opt-in, opt-out, human escalation, allowed
  countries). https://business.whatsapp.com/policy · **not re-read in full in this session**; the build
  reads it before coding.
- [W24] WhatsApp, *Terms of Service*, acceptable use: no "bulk messaging, auto-messaging,
  auto-dialing" and no "non-personal use … unless otherwise authorized".
  https://www.whatsapp.com/legal/terms-of-service
- [T1] Tailscale, *tailscale funnel* command: `--bg`, `--https=<port>`, `--set-path=<path>`.
  https://tailscale.com/docs/reference/tailscale-cli/funnel
- [T2] Funnel ports 443, 8443 and 10000 (the node's `funnel-ports` capability; Tailscale's Funnel docs).
  https://tailscale.com/kb/1223/funnel
- [T3] tailscale/tailscale issue #21879, *Funnel on Linux 1.104.2: … public clients fail at the TLS
  handshake*. https://github.com/tailscale/tailscale/issues/21879
- [U1] whatsapp-web.js, *DISCLAIMER* (unofficial, not affiliated, "WhatsApp prohibits the use of
  unofficial clients", own risk) and its docs (Puppeteer, WhatsApp Web).
  https://github.com/wwebjs/whatsapp-web.js/blob/main/.github/DISCLAIMER.md · https://docs.wwebjs.dev/
- [U2] WhiskeySockets/Baileys, *README* (WebSocket client for WhatsApp Web; disclaimer: not
  affiliated, "not condoning or endorsing businesses to use the library").
  https://github.com/WhiskeySockets/Baileys
- [U3] WhatsApp Help Center, *About account bans for unofficial apps*.
  https://faq.whatsapp.com/1064395290901991/
- [U4] WhatsApp Help Center, *Unauthorized use of automated or bulk messaging on WhatsApp*.
  https://faq.whatsapp.com/5957850900902049

Sara code and docs read for §1: `src/plugins/manager.ts` (`#fetch`, `#bridgeInbound`, `event:webhook`
delivery, the v1.2 message switch), `src/plugins/net.ts`, `src/plugins/manifest.ts`,
`src/plugins/bridge-db.ts`, `plugins/signal/` and `plugins/email/` (file list, `sara-plugin.mjs`),
`src/webhooks.ts`, `src/webhook-verify.ts` (`verifyGithub`, `safeEqual`), `src/server.ts` (`/hook/`,
`/alexa`), `src/platform.ts` (`accessInfo`), `deploy/lib-access.sh`, `src/tailscale.ts`, `src/hub.ts`,
`src/net-guard.ts`, `src/private-local.ts`, `src/vault.ts`, `src/safety.ts` (`partnerNote`),
`src/bridges/rooms.ts` (`PLUGIN_NAMES`), `src/bridges/telegram.ts` (buttons, `st:` / `ap:`),
`src/jpeg.ts`, `web/hooks.js` (`reachText`); docs `design/BRIDGES2.md`, `design/BRIDGES3.md`,
`design/PERSIST.md`, `design/RECALL.md`, `design/BEGIN.md`, `design/SSH_EASY.md`, `design/STAPLES.md`
§10, `WEBHOOKS.md`, `ALEXA.md`, `SIGNAL.md`, `EMAIL_BRIDGE.md`, `ROADMAP.md` (owner decisions
2026-10-25 and 2026-10-31, Phase 122).

## As built (2.55.0)

Phase 122 part 1 shipped as designed, with the §13 defaults: WhatsApp is a built-in plugin
(`plugins/whatsapp/`) that stays off until installed, behind a terms box; Meta's free test number
first; no hosted onboarding or hub relay; the paid nudge off; typing plus one *Working on it* line
with ⏹ Stop at 20 s; only the owner unless he lists numbers (an empty list on a reply-window platform
means nobody, and a `+`-form number matches the sender's phone); no groups or voice replies;
unofficial plugins refused; all Graph traffic over the socket broker (HTTP/1.1 in `http1.mjs`);
Funnel for `/hook` only on 8443 (10000 for a second instance) with the tunnel/domain fallback.

Notes against the text above:
- The `meta` verify kind reuses the GitHub-style HMAC check with Meta-worded errors; delivery ids
  come from the body (`metaDeliveryIds`) because Meta sends no id header.
- Bridge hooks get their own limits (300/min, 20,000/day per hook, 600/min server-wide) and a 5 s
  accept deadline (503 when the plugin is not ready, so Meta retries); automations' budgets are
  untouched. The plugin never sees the App Secret or the hook secret.
- The reply window (`bridge_windows`) opens from Meta's own message timestamp, clamped to now, and
  closes early on error 131047; error 137000 pauses owner powers like an identity change.
- The template language for the optional nudge is fixed to `en` in this part.
- The setup page (`web/whatsapp.js`) runs each check from `src/plugins/whatsapp-setup.ts`; the door
  routes are `POST /api/access/door` (`open`/`close`/`check`, refused in demo).
- Tests: `test/phase122.test.ts` with the stand-in Graph API and fake Meta sender in
  `test/whatsapp-fake.ts`; user guide [../WHATSAPP.md](../WHATSAPP.md).
