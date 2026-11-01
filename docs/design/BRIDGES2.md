# Chat apps catch up, and talking to her while she works: photos and files both ways, one live progress message, steer / queue / `/btw`, the tool-loop guard (design, Phases 115–116, versions 2.48.0–2.49.0)

Status: design study, 2026-11-01. Nothing here is built. It is a read-only study of the code at
2.47.3 (Phase 114 released, CH1–CH4 built), plus the official Telegram and Discord developer
documentation (sources in §13). It is a ground-up design: no code, schema, protocol detail or
wording is taken from Hermes Agent, OpenClaw or any other agent; GAP_REVIEW names only their
**features**. Zero new npm runtime dependencies. Every outgoing request goes through
`src/net-guard.ts` (`netFetch`, `openWebSocket`), as the bridges already do.

**The owner's words (2026-10-31, approving the gap review's suggestions as Phases 115–128):** "I like
the top 10 as well as the lower down ones." The ROADMAP lines he approved:

- *Phase 115 (2.48.0):* "Chat apps catch up: photos and files both ways in Telegram/Discord (and later
  bridges), one live progress message that updates while she works (GAP #1, #4)."
- *Phase 116 (2.49.0):* "Talk while she works: steer, queue, `/btw`; the tool-loop guard (#2, #10)."

And the gap review's pitches he said yes to (GAP_REVIEW §2):

- **#1** "send her a photo and she sees it; ask for a chart, a PDF or a picture of her and it arrives
  as a picture or a file, like any other contact." In groups, "off unless the owner turns it on per
  room."
- **#4** "during a long job you see one message that updates with what she's doing, then turns into
  the answer." "On for long turns only (over ~10 seconds), in private chats; a switch per chat app."
- **#2** "while she's busy, type 'use pnpm, not npm' and she takes it into account at the next step;
  or queue the next thing; or ask 'what does that error mean?' without adding it to the session." "A
  steer is a normal owner message: it can't approve anything or loosen a rule; only the owner can
  steer an owner turn."
- **#10** "if she tries the same thing three times and it fails the same way, Sara blocks that exact
  call and makes her change course or ask you." "Purely protective; it can only stop a call."

**The brief for this design (from the parent, on the owner's behalf):** the live progress message is
**one message edited in place, throttled, with a final state and a toggle**. Steer = a message sent
while she works is added to the running turn **at the next safe point**; queue = it runs **after the
current one**; `/btw` = a side question answered **without disturbing the work**; a default behaviour
and a UI for choosing; **the same in Telegram and Discord**; the loop guard blocks a call **after 3
identical failing tool calls, for the turn**, and she must change approach, **with a test that uses a
fake model**.

**Goal:** on a phone, Telegram and Discord feel like the app. You can send her a photo and she sees
it, she can send you a picture or a file, you can see that she's working on a long job, you can tell
her something without stopping her, and she doesn't burn twenty steps on the same broken command.

**The rule of this track: build on what is there.** Photos from a chat app enter the turn the same
way a photo from the web composer does (`meta.images` → `buildHistory`'s `loadImage` → the vision
route). Pictures she makes leave through the same `image` event the web app already receives. The
progress message is drawn from the same `ChatEvent`s as the web app's step line, with the same verbs.
Steer reuses the turn loop's own between-steps point (where Stop and the plan check already act);
queue lifts the bridges' per-conversation queue into one server-side queue; `/btw` is one small model
call like CH3's titles; the loop guard is one more refusal in the tool loop's existing chain, keyed by
the M10 failure signatures. The mandatory safety layer (`src/safety.ts`: AI disclosure at the start and
every 3 hours, honesty when sincerely asked, crisis resources, the hard block on sexual content
involving minors) is untouched and runs on every new path, including steers, side questions and
picture captions.

Contents: 1 what exists today · 2 platform facts (Telegram, Discord, plugin bridges) · 3 the shape and
shared building blocks · 4 BR1 Phase 115 (photos and files, the live progress message) · 5 BR2 Phase
116 (steer, queue, `/btw`, the loop guard) · 6 safety and privacy across the track · 7 household
isolation · 8 reuse vs build · 9 risks · 10 phases at a glance · 11 blocking questions with defaults ·
12 key choices in short · 13 sources.

---

## 1. What exists today (mapped from the code)

| Piece | Where | What it does today | Matters here because |
|---|---|---|---|
| Telegram bridge | `src/bridges/telegram.ts` (719 lines) | Long polling; owner DM → channel `telegram`, partner DMs with `allowOthers`, groups on @mention/reply/name, owner work in groups → `telegram-work[-nsfw]`. Commands first (CH1, before the queue). Voice notes: `#hear` → `speechOf(app).hearNote` (≤ 20 MB, `MAX_NOTE_BYTES`). Documents **from the owner only** → `#download` (`getFile`, ≤ 20 MB) → `takeChatDocument`. A photo with no caption gets "I can only read text and voice notes here for now. Tell me about it?" (l. 447); **a photo with a caption is answered as text only: the picture is dropped silently.** One queue per conversation (`#queues` promise chain + `#waiting` count + `#cleared` generation, l. 457–468). `#turn` waits up to 600 s while `app.isBusy` (a web turn), sends `typing` every 4.5 s, collects tokens, sends approvals as their own messages with Allow/Deny buttons, and sends the reply after the turn (`paceLikeTyping`, `splitMessage` at 4000). `sendVoice` uploads multipart `FormData` through `netFetch`. | The photo path is a gap, not a refusal by rule. `#turn`'s `onEvent` ignores `image` and `proof` events, so **a selfie asked for in Telegram is made and never arrives**. The upload code (`FormData`, `netFetch`) already exists for voice. `typing` is the only sign of life during a long turn. |
| Discord bridge | `src/bridges/discord.ts` (980 lines) | Gateway v10 + REST v10 (`#rest`: JSON only, 30 s, **no 429 handling**). Voice/audio attachments transcribed; non-audio, non-image, non-video attachments from the owner (≤ `MAX_DOC_BYTES`, 5 per message) → `takeChatDocument`. **Images are filtered out** (l. 748) and a message with only a picture is ignored (l. 749). Same queue shape as Telegram (but `handle` awaits the turn). `#turn`: `typing` every 8 s, approvals with button components, reply split at 1900. `sendVoice`: multipart with `payload_json` + `files[0]`. Bot loop guard (Phase 47: `botTurnLimit`, `botHourlyCap`). | The multipart send is the pattern for photos and files out. Editing a progress message needs `PATCH /channels/{id}/messages/{id}` and real rate-limit handling, which `#rest` doesn't have yet. |
| Command layer (CH1) | `src/bridges/commands.ts` (527 lines): `MENU_COMMANDS`, `commandAllowed(place, who, name)`, `parseCommand`, `runCommand`, `BridgeAdapter {currentSession, startSession, roomSession?, stopTurn, clearQueue, resetGuard?}`, `nextSession` | `/stop` → `adapter.stopTurn` (in a work room also the room's turn); `/reset` stops, clears the queue, denies waiting approvals. Commands run **before** the queue. | `/steer`, `/queue`, `/btw` and `/progress` join this one table; `BridgeAdapter` grows `steer` and `queue`. Same permission rule: owner only, server-checked every time. |
| Shared room and keep-up | `src/bridges/room.ts` (75 lines), `src/bridges/keepup.ts` (1,121 lines) | Owner work-room turns are copied to the room conversation; with keep-up on, every room line is logged passively as text with `[photo]` / `[file: x.pdf]` / `[voice message]` marks (`#logText`). | Pictures in rooms stay marks in the log: keep-up never downloads or looks at them (§6). |
| Uploads (images) | `src/uploads.ts` (74 lines): `UploadStore.save(dataUrl)`, `MAX_IMAGE_BYTES = 8 MB`, `MAX_IMAGES_PER_MESSAGE = 4`, magic-byte check (JPEG, PNG, WebP, GIF), id = sha256 prefix + ext, `load(id)` → base64, `prune(inUse)` | The web composer's photos; her own photos and moments; screenshots. Pruned when a conversation is deleted (`server.ts` l. 1841, `store.imagesInUse()`). | Chat-app photos are stored here too (one store, one prune). It needs a `saveBytes(buf)` beside `save(dataUrl)`. |
| Library intake | `src/library/intake.ts` (57 lines): `takeChatDocument` (owner only: `conv.partner` → refused), `readOnceAsked(caption)`, `docsNote` | Kept in the library, or read once for that conversation. | Reused as is for documents. One small bug to fix on the way: `origin` is `'discord'` or else `'telegram'`, so a plugin bridge's document is labelled Telegram. |
| The web send route | `src/server.ts` `savePhotos` (l. 278: ≤ 4 photos, `UploadError` → 400), `POST /api/conversations/:id/messages` (l. ~1868: photos refused in group chats and off the record) | `meta.images` on the user message; the turn does the rest. | The bridges call the same path: `runTracked(conv.id, content, onEvent, { images })`. |
| Seeing pictures | `src/chat.ts`: `buildHistory(…, loadImage)` gives pictures to the model for the **last 2** user messages that have them (l. 724–752), older ones become "[n photo(s) shared earlier]"; `photosNow && visionSet` → job `vision` (l. 1445); `sees(p, m)` gives other models a note instead of the picture (l. 1455); `describeImage` (the vision model describes a screenshot for a talking model that can't see, l. 1459); private conversations use local models only (`resolveChain`, l. 429/454: a non-local route **throws**); private local mode keeps only models on this computer (l. 406) | | A chat-app photo needs no new model code. Two facts matter: a private conversation with a non-local vision route errors instead of falling back (§4.5), and `describeImage` is the ready-made "describe first" step for pictures from other people (§4.6). |
| Pictures she makes | Tools call `ctx.attachImage(uploadId)` (`photos.ts` `take_photo` l. 166/197, `moments.ts` l. 763) → `pendingImages` → `{type:'image', id}` events and `meta.images` on her reply (`chat.ts` l. 2453, 2465). Screenshots: `attachProof` → `{type:'proof'}`. | Shown in the web app under her reply. | The bridges only need to listen for `image` (and, for the owner, `proof`). |
| Files she makes | Workspace tools write files (`tools/workspace.ts`); the library holds documents; **no tool shares a file into the chat.** | The web app shows file names and previews in tool results (`previewCard`). | A small `send_file` tool is the only new tool (§4.4). |
| The step line | `web/steps.js` (`stepWords(name, args, named)`: everyday verbs per tool, "Running the tests…" / "Ran the tests"; `stepLine`, `addStep`, `finishStep`, `waitStep`); `server.ts` `trackActivity(turn, ev)` keeps `status`/`detail` for the activity bar | One quiet line under each reply, live while she works. | The progress message uses **the same verbs**: the pure word table moves into a module both sides import (§3.1 B3). |
| Busy, Stop, queue | `server.ts`: `active` map; `runTracked` throws **409 "Sara is still working on this conversation. Wait for her or press Stop."** (l. 450; `streamChat` l. 571); `app.stopTurn` aborts the turn's controller (l. 490); `requestApproval` (MCP writes) throws "Sara is busy in that conversation" (l. 508). `web/app.js`: `setComposerBusy` hides Send and shows Stop (l. 1149); the composer's submit **silently ignores** a message while `state.streaming` (l. 2487). Plugin bridges: `isBusy` → `{ok:false, reason:'busy'}`, **the message is dropped** (`plugins/manager.ts` l. 907). | Telegram and Discord queue; the web app refuses; plugin bridges drop. | Three different answers to the same situation: BR2 gives them one (§5). |
| The turn loop | `runTurn` (`src/chat.ts`, 2,503 lines): `for (let step = 0; step < maxSteps; step++)` (l. 1885) builds the system prompt and **rebuilds the history from the store every step** (`buildHistory(store.messages(conv.id), …)`, l. 1938), adds transient notes (`contradictNotes`, `pluginNotes`, `correction`), asks `hooks.beforeModelCall` (budget ladder), streams the model, then runs each call through a chain of refusals (unknown tool → not offered → private → private local → `never` → …, l. 2224–2239) before approvals and `tool.run`; stores each result as a `tool` message; checks `signal.aborted` after every call (l. 2455). | | **The steer point is already there:** anything stored as a user message after a step's last tool result is in the next step's history. The loop guard is one more `else if` in the refusal chain. |
| Loop and budget limits | `MAX_STEPS = 25`, `MAX_STEPS_CODING = 80` (`chat.ts` l. 341); turn budgets `DEFAULT_TURN_BUDGETS` coding on (200k tokens / 40 steps), chat off (100k / 20); `HARD_STEP_CAP = 200` (`budget.ts` l. 152–158); "Stopped after N steps. Say \"continue\"…" (l. 2462); the Discord **bot** loop guard (a different thing: bots talking to bots). | | None of these notices *repetition*: a failing command can run 40 times inside the budget. |
| Failure signatures (M10) | `src/triggers.ts`: `stepFailed(tool, status, output)` (error status, or a shell exit ≠ 0 / time-out), `errorLine(output)` (the most telling error line + class), `normalizeMessage` (paths, ids, times, numbers out), `normalizeCommand`, `sigOf(kind, key)`, `signaturesOf(ToolEvent)` → `{kind:'failure', key: tool\|class\|message}` | Used for recall of past failures and lessons. | "Fails the same way" is already defined in code. The guard reuses it, so recall and the guard never disagree. |
| Voice notes | `src/voice.ts` `noteReplies: 'voice' \| 'always' \| 'never'`, `speechOf(app).hearNote/speak/canSendNotes/replyWithVoice` | In and out on both bridges. | The model for files: download with a size cap, hand to an existing service, reply in the native format. |
| Plugin bridges | `src/plugins/manager.ts` `#bridgeInbound` (l. 860): `{bridge, chatId, from, text}` (text ≤ 8000) → commands (CH1) or one turn via `runTracked`, reply collected and sent as `bridge.send {bridge, chatId, text}` after the turn (or after `BRIDGE_TURN_MS` = 5 min); 1 MB line cap, 100 calls/min (docs/PLUGINS.md §6, §8) | Text only, one message out per turn, no edits. | The contract grows by **opt-in** fields so v1 plugins keep working (§2.3). |
| Household | `src/main.ts` l. 611–644 (`isMember` → no tools), bridges only for the owner's main companion (CHATS §1) | | Everything bridge-side lives in the owner's main companion. Steer, queue and `/btw` work in the web app for every companion and member, each in its own data (§7). |
| Safety | `src/safety.ts`: `detectCrisis`, `minorSexualMatch`, `MINOR_BLOCK_REPLY`, `CRISIS_SYSTEM_NOTE`, `detectExplicit`, `partnerNote` (no tools, may be a minor), `disclosureDue`; `src/redact.ts` `Redactor`, `KEY_SHAPED`, `vaultSecretValues` | Runs inside `runTurn` for every turn. **There is no image classifier**: pictures are checked only through their captions and through her reply. | Steers and side questions don't start a turn, so §6 says exactly which checks run on them. Pictures from other people go through a describe-first step (§4.6). |

What does **not** exist: reading photos in either bridge, sending her pictures or files to a chat
app, a "share this file" tool, editing a message in place on either platform, any 429 handling in the
Discord REST helper, files in the plugin bridge contract, a way to add to a running turn, a queue in
the web app, side questions, and any check for a tool call that keeps failing the same way.

Four code facts change the design:
1. **The history is rebuilt from the store at every step.** A steer needs no new channel into the
   model: it is stored as a user message at the safe point and the next step sees it. The flip side:
   a *queued* message must **not** be stored early, or it would act as a steer (§5.3).
2. **Bridges drop events the web app relies on.** `image` and `proof` never reach Telegram or Discord.
   BR1 adds them to the bridges' `onEvent` rather than inventing a send path.
3. **A private conversation with a cloud vision route throws** (`resolveChain` l. 429). A chat-app
   photo in a conversation the owner marked private must route to the talking model with a note, not
   fail the turn (§4.5).
4. **Three surfaces, three busy rules.** Telegram/Discord queue (and wait up to 10 minutes for a web
   turn), the web app refuses with a 409 and silently drops what you typed, plugin bridges drop the
   message. BR2 makes one rule with one queue.

---

## 2. Platform facts (from the official documentation, read 2026-11-01)

### 2.1 Telegram: files, edits, reactions and limits [T1, T2]

- **Downloading:** `getFile` gives a link valid for at least an hour; "the maximum file size to
  download is 20 MB". A photo arrives as an **array of `PhotoSize`** (the same picture at several
  sizes, each with `file_id`, `file_size`, `width`, `height`); a picture sent "as a file" arrives as a
  `document` with its mime type. An album arrives as **separate updates** sharing a `media_group_id`.
  [T1]
- **Uploading** (multipart, the way `sendVoice` already does it): "10 MB max size for photos, 50 MB
  for other files". `sendPhoto`: at most 10 MB, width + height ≤ 10000, ratio ≤ 20. `sendDocument`:
  "files of any type of up to 50 MB". `sendMediaGroup`: an album of **2–10** items; documents only
  group with documents. Captions: **0–1024 characters**; message text: **1–4096 characters**. [T1]
- **Editing:** `editMessageText(chat_id, message_id, text, reply_markup?)` edits a message the bot
  sent (the 48-hour limit in the docs applies only to *business* messages not sent by the bot).
  `editMessageReplyMarkup` already removes Allow/Deny buttons today. Editing to the same text is an
  error ("message is not modified"), so the bridge skips unchanged edits. An edit doesn't notify the
  user; a new message does. [T1]
- **Reactions:** `setMessageReaction(chat_id, message_id, reaction)` sets the bot's reaction on a
  message (some service messages can't take one; bots can't use paid reactions). [T1]
- **Drafts (considered, not used in v1):** `sendMessageDraft` streams "a partial message to a user
  while the message is being generated", **private chats only**, and "the streamed draft is ephemeral
  and acts as a temporary 30-second preview – once the output is finalized, you must call
  `sendMessage`". Bot API 10.3 (2026-08-24) added `can_stop` / `keep_on_stop` and a
  `stopped_message_generation` update when the user presses its stop button. It is good for
  streaming words, but it can't be a lasting message with a final state, and it doesn't exist in
  groups. §11 Q11 keeps it as a later option. [T1]
- **Rate limits** (Bots FAQ): "In a single chat, avoid sending more than one message per second. We
  may allow short bursts that go over this limit, but eventually you'll begin receiving 429 errors.
  In a group, bots are not able to send more than 20 messages per minute." About 30 messages a
  second overall. Edits count against the same budget (our reading: they are requests to the same
  chat). A 429 carries `parameters.retry_after` in seconds. [T2]
- **`sendChatAction`** (typing) lasts about 5 seconds, which is why the bridge repeats it every 4.5 s
  today. [T1]

### 2.2 Discord: attachments, edits, reactions and rate limits [D1–D3]

- **Uploading:** multipart with `payload_json` and `files[n]`, the way `sendVoice` already does it;
  `attachments[]` in the JSON matches each `n` (with `filename` and an optional `description`, the alt
  text, ≤ 1024 characters). "The file upload size limit applies to each file in a request. The
  default limit is **20 MiB** for all users, but may be higher" with Nitro or the server's boost tier.
  Images can also be shown in embeds through `attachment://filename`. Message `content`: up to **2000
  characters** (Sara splits at 1900). Discord's clients allow 10 files per message (not on the pages
  read; §9 risk 2 says how Sara copes if a send is refused). [D1, D2]
- **Downloading:** an attachment's `url` points at the CDN with `ex`/`is`/`hm` signature parameters;
  signed URLs expire, so the bridge downloads at once (it already does for documents and voice). The
  attachment has `content_type`, `size`, `filename`. [D1]
- **Editing:** `PATCH /channels/{channel.id}/messages/{message.id}` with `content` and `components`;
  "the original message author" may edit them. On a `PATCH` with files, "only files listed in the
  `attachments` parameter will be appended … any previously-added files that aren't included will be
  removed", which is why the progress message never carries files (§4.8). [D2]
- **Rate limits:** per-route limits shown in `X-RateLimit-Limit/Remaining/Reset-After/Bucket`
  headers; a **429** has `retry_after` (seconds, a float) and `global`; "all bots can make up to **50
  requests per second**"; IPs making "10,000 [invalid requests] per 10 minutes" (401/403/429) are
  temporarily restricted. "Your application should rely on the `Retry-After` header or `retry_after`
  field." [D3]
- **Reactions:** `PUT /channels/{id}/messages/{id}/reactions/{emoji}/@me` (bot's own reaction).
  Interactions: a deferred reply (type 5) can be edited for 15 minutes (CHATS §2.1), and flag 64 makes
  it visible only to the asker, which is how `/btw` answers privately in a server (§5.6).

### 2.3 Plugin bridges (STAPLES §6.8, docs/PLUGINS.md §8)

Today: `bridge.inbound {bridge, chatId, from, text}` in, `bridge.send {bridge, chatId, text}` out, one
message after the turn; **1 MB per line**, 100 calls a minute, 8 in flight. There is no file, no edit
and no message id in the contract, and a message that arrives while she's busy is dropped. A plugin
can't be assumed to support anything new, so everything in this track is **opt-in by the plugin**,
announced in `init` and answered in `ready` (§4.9). A v1 plugin keeps working exactly as today, except
that busy messages now queue instead of being dropped (§5.7).

---

## 3. The shape

```
 incoming line (Telegram update / Discord MESSAGE_CREATE / INTERACTION_CREATE / plugin bridge.inbound)
   │
   ├─► CH4 room log (passive; photos stay "[photo]" marks, never downloaded)
   ├─► CH1 command? (/new /stop /status … + BR2 /steer /queue /btw, BR1 /progress) ─► reply, no turn
   │
   └─► called? ─► photos/files in (BR1 B1: caps, quotas, magic check, who sent it) ─► meta.images / docs
                    │
                    ├─ she's busy? (BR2 B5) ── steer ─► pending box ─► taken at the next safe point
                    │                        ├ queue ─► one server queue ─► its own turn afterwards
                    │                        └ /btw  ─► side call (B6), nothing stored, work untouched
                    │
                    └─ runTurn ─► events ─► progress message (B4, one message, edited, throttled by B2)
                                    │            └─ final state: "✅ Done · 6 steps · 1:12"
                                    ├─ loop guard (B7) refuses the 4th identical failing call
                                    └─ image / proof / file events ─► native photos and files (B1, B2)
```

### 3.1 Shared building blocks (built once, used by both phases)

1. **B1 · Bridge media** (`src/bridges/media.ts`, new; BR1). One place for files crossing a bridge in
   either direction.
   - *In:* `takeIncoming(app, conv, who, files[])` → `{images: uploadIds[], docs: SharedDoc[], refused:
     string[]}`. Images go through `UploadStore.saveBytes(buf)` (new, beside `save(dataUrl)`, with the
     same magic-byte check and `MAX_IMAGE_BYTES`); documents go to `takeChatDocument` as today. It
     checks the place's rule (§4.6), the quotas (§4.7) and records a `shared_files` row.
   - *Out:* `collectOutgoing()` gathers a turn's `image`, `proof` and `file` events; `deliver(port,
     chat, items, caption)` sends them through a small per-bridge `MediaPort {sendPhotos, sendFile,
     maxBytes}`. Telegram and Discord implement the port with the multipart code they already use for
     voice; a plugin bridge implements it through `bridge.file` (§4.9).
2. **B2 · The send pacer** (`src/bridges/sendq.ts`, new; BR1, used by every bridge send). One outgoing
   queue per bridge and chat with three priorities: **her reply and approvals first, then files, then
   progress edits**. It keeps Telegram under 1 message a second per chat and 20 a minute in groups,
   honours 429 `retry_after` on both platforms and Discord's `X-RateLimit-*` headers per bucket, and
   **coalesces** progress edits (only the newest text is sent; an unchanged text isn't sent at all).
   `#call` (Telegram) and `#rest` (Discord) go through it, so a burst of progress edits can never
   delay her answer or earn the bot a 10-minute block.
3. **B3 · Step words, shared** (`web/step-words.js`, new; BR1). The pure part of `stepWords` (tool name
   + arguments → "Running the tests…" / "Ran the tests" / icon key) moves out of `web/steps.js` into a
   module with no DOM, taking the translate function as an argument. `web/steps.js` imports it; the
   server imports the same file (Node runs plain ES modules), translating with `src/i18n.ts` `tr` and
   the same `web/i18n/*.json` keys. One table of verbs, six languages, no copy.
4. **B4 · The progress message** (`src/bridges/progress.ts`, new; BR1, BR2 adds steer lines). A small
   state machine fed by a turn's `ChatEvent`s: `idle → shown → final`. It renders the text (§4.8),
   asks a `ProgressPort {create, edit}` to post and edit **one** message through B2, and writes its
   final line. It never sees tool output, only event types, tool names and the B3 verbs.
5. **B5 · Pending inputs** (`src/pending.ts`, new; BR2). One store and one API for what arrives while
   she works: `steer(convId, input)`, `enqueue(convId, input, runner)`, `takeSteers(convId)` (called by
   the turn loop at the safe point), `list`, `cancel`, `promote` (queue → steer), `clear` (for `/reset`
   and `/new`). The queue lifts the bridges' `#queues` / `#waiting` / `#cleared` pattern into the
   server, so web, Telegram, Discord and plugin bridges share it. Rows live in `store.db` so the app
   can show them and a restart doesn't lose them silently (§5.3).
6. **B6 · Side question** (`src/btw.ts`, new; BR2). `answerAside(app, conv, question, opts)`: one model
   call through CH3's `cheapCall` (`src/cheap.ts`: local first, the per-source daily ledger, usage
   purpose), with a read-only slice of the conversation, the running turn's step lines, no tools, the
   safety checks of §6.3, and nothing written to the conversation.
7. **B7 · The loop guard** (`src/loop-guard.ts`, new; BR2). Per turn: `LoopGuard.check(call)` before a
   call runs, `LoopGuard.record(call, status, output)` after. It uses `stepFailed`, `errorLine` and
   `normalizeMessage` from `src/triggers.ts` for "fails the same way" and a canonical form of the
   arguments for "the same call" (§5.8).

### 3.2 Where data lives

Bridge data lives in the **owner's main companion's** data (bridges exist only there). Pending inputs
and side-question usage live in **each companion's and member's own** `store.db`, because the web
features work for everyone (§7). Everything is additive (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE …
ADD COLUMN` behind a column check, as `store.ts` `migrate()` does), so 2.47.x opens a 2.49.0 database
and ignores the new tables.

| Data | Database | Phase |
|---|---|---|
| `shared_files` (what crossed a bridge, quotas, cleanup) | `store.db` (owner's main companion) | BR1 |
| `bridge_progress` (open progress messages, so a restart can close them) | `store.db` (owner's main companion) | BR1 |
| Photos that arrived in a chat app | the existing upload folder (`UploadStore`) | BR1 |
| Copies of files she sent | `<dataDir>/shared/<sha256>` (new folder, in backups) | BR1 |
| `pending_inputs` (steers and queued messages) | `store.db` (every companion and member) | BR2 |
| `/btw` usage | `usage` rows with purpose `btw`; the shared daily ledger, source `btw` | BR2 |
| Loop-guard blocks | the run record's step (`runs.ts`, `guard` field on the tool step) and the `tool` message's meta | BR2 |

### 3.3 Settings shape (owner-only; added to `OWNER_SETTINGS` where new)

```ts
chats: {
  // …CH1–CH4 keys unchanged…
  media: {
    send: boolean,                 // "Send me pictures and files here" (default true; owner chats)
    photosFromOthers: 'off' | 'describe',   // partner chats and rooms (default 'off'; per room on `rooms`)
    proof: boolean,                // her screenshots of her work to the chat app (default false)
    keepOthersDays: number,        // pictures from other people: bytes kept 7 days (pick-list 1 / 7 / 30)
    sentKeepDays: number,          // copies of files she sent: 30 days (pick-list 7 / 30 / 90)
  },
  progress: {
    on: boolean,                   // "Show her progress while she works" (default true)
    where: 'private' | 'work',     // private chats only (default) / also rooms where you work with her
    afterSeconds: number,          // shown once a turn passes 10 s (pick-list 5 / 10 / 20 / 30)
    final: 'summary' | 'delete',   // the message becomes one summary line (default) or is removed
  },
  whileBusy: 'steer' | 'queue',    // what a plain message does while she works (default 'steer')
  queueMax: number,                // waiting messages per conversation (default 5)
  btw: { model: 'local' | 'quick', dailyCap: number /* 60 */ },
  loopGuard: { repeats: 3 /* fixed in v1, shown read-only */ },
}
```
Per room, on CH2's `rooms` row: `photos_from_others` (null = the global value) and `progress` (null =
the global value). Per conversation: `meta.progress` set by `/progress on|off`.

---

## 4. BR1 · Phase 115 · 2.48.0: chat apps catch up

> **As built (2.48.0).** Built as designed, with the §11 defaults (others' pictures off, proof off,
> progress in private chats only after 10 s with a summary line, 7 / 30 day / 1 year retention).
> Notes: the progress settings carry a per-app switch (`apps.telegram|discord|plugins`, all on);
> an app error line is never used as a photo caption (found in the live run: the selfie arrived with
> "(Something went wrong …)" as its caption when the local model returned an empty reply); a turn with
> zero steps ends as `✅ Done · 0:12`. The test picture is drawn in code (`src/bridges/test-picture.ts`).

### 4.1 Scope

1. **Photos in:** a photo (or up to 4, or a Telegram album) sent to her on Telegram or Discord is seen
   the way a photo from the web composer is, with its caption as the message.
2. **Pictures out:** a picture she makes in a chat-app turn (her photo, a moment, a generated image)
   arrives as a native photo, with her words as the caption when they fit.
3. **Files out:** she can share a file she made or found (a PDF, a chart, a CSV, a library document)
   into the chat with a new `send_file` tool.
4. **Plugin bridges:** the same, for plugins that opt in, through a versioned contract.
5. **One live progress message** in long turns: posted once, edited in place, throttled, ending in a
   final state, with a switch per chat app and `/progress on|off` per chat.

Not in BR1: videos and stickers (they stay marks), reading pictures in rooms she only keeps up with,
documents from people other than the owner (unchanged: "I only keep documents for the person who runs
me."), and voice (already built).

### 4.2 Photos in

**Telegram.** In `handle()`, after the command check and the "called?" check, before the voice step:
- `msg.photo`: take the **largest `PhotoSize` whose `file_size` ≤ 8 MB** (`MAX_IMAGE_BYTES`); if even
  the smallest is bigger, refuse with the size line. `msg.document` with an image mime (sent "as a
  file") is treated as a photo when it's ≤ 8 MB and passes the magic check, else as a document (today's
  path).
- **Albums:** updates with the same `media_group_id` are held for **1.5 s** after the last one, then
  become one message with up to `MAX_IMAGES_PER_MESSAGE` (4) pictures; the caption is the one
  Telegram puts on the first item. More than 4: the first 4, and one line "I looked at the first 4."
- Download through the existing `#download` (`getFile`, 20 MB cap, `netFetch`, 120 s), then B1
  `takeIncoming` → upload ids.
- The turn: `runTracked(conv.id, content, onEvent, { images })`, exactly what the web send route does.
  `content` is the caption, or `(photo)` with no caption (the web's own placeholder), with the room's
  `[name]:` prefix in groups as today. The "I can only read text and voice notes here for now" line
  goes away; it stays only when photos are off for that place (§4.6), reworded as "I can't look at
  pictures here."

**Discord.** In `#onMessage`, the `image/*` attachments that today are filtered out (l. 748) go to B1:
≤ 8 MB each (refused above, with the size line), up to 4, downloaded at once (signed CDN URLs
expire), then the same `{ images }` turn. A message with only pictures is no longer ignored (l. 749).
Alt text (`description`) on an attachment is appended to the caption as `[image description: …]`
(fenced like any text from the sender).

**Both.** The user message stores `meta.images` (upload ids) and `meta.via` (`telegram` / `discord`),
so the web view shows the pictures in the conversation like any other photo. `buildHistory` already
sends pictures only for the last two messages that have them, so a long photo chat doesn't grow the
prompt. Captions run through the same turn-start checks as text (they are the message).

### 4.3 Pictures out

- The bridges' `onEvent` handles `{type:'image', id}` (and `proof`, §4.6) by adding the upload id to
  the turn's outgoing list (B1 `collectOutgoing`). Nothing is sent mid-turn except approvals, as today.
- After the turn, **pictures go first, then text**:
  - Telegram: one picture → `sendPhoto` with the reply as `caption` when the reply is ≤ 1024
    characters and has no code block; otherwise the photo without a caption, then the text as today.
    2–4 pictures → `sendMediaGroup` (an album), then the text.
  - Discord: one message with `files[0..3]` and the reply as `content` when it is ≤ 1900 characters;
    otherwise the files, then the split text. `attachments[n].description` = a short alt text ("A
    photo from Sara") so screen readers say something.
- If a send fails (too big, refused, a network error) the text still goes, with one line for the
  owner: "I couldn't send the picture here ({reason}). It's in the app." Partners get "I couldn't send
  the picture." with no reason.
- The upload ids stay on her reply's `meta.images` (as today), so the web view shows the same
  pictures. A Telegram `file_id` that comes back is kept on the `shared_files` row so the same picture
  can be sent again without uploading it.

### 4.4 Files out: the `send_file` tool

A new built-in tool, the only new tool in the track:

| | |
|---|---|
| Name | `send_file` ("Share a file in this chat") |
| Arguments | `path` (inside the conversation's workspace) **or** `libraryId` (a library document), and an optional `caption` (≤ 300 characters) |
| What it does | Checks the file (below), copies it to `<dataDir>/shared/<sha256>`, records a `shared_files` row (`direction: 'out'`), and emits `{type:'file', id, name, mime, bytes}`. The bridge sends it after the turn with `sendDocument` (Telegram, ≤ 50 MB) or `files[n]` (Discord, ≤ 20 MiB). In the web app the reply gets a file chip that downloads it (§4.11). |
| Offered when | The owner's own conversations only: never partner chats, groups of companions, `/v1`, MCP, A2A, webhooks or outside requests (the same list as plugin tools, docs/PLUGINS.md §7). It counts as an **off-server tool** (`OFFSERVER_TOOL`), so it is off in private conversations and in private local mode, like web fetch. |
| Permission | `auto` by default in the owner's own chats (he asked for the file; it goes to him). `asksFirst` is true **in a room** (a work room is shared: Allow/Deny before anything is posted where others can see it), when the file is over 5 MB, and when the secret check (below) finds something. The owner can set it to *ask* or *never* in Settings → Tools like any tool. |
| Checks | The path guard of the workspace tools (no `..`, no links out of the workspace, no `.secrets/`, `.env*`, `id_*`, `*.pem`, `*.key`, the vault file or the data folder). The platform's size cap for this bridge. **Secrets:** text-like files (by `detectKind` or a UTF-8 sniff of the first 64 KB) are scanned with the vault's exact values (`vaultSecretValues`) and the key-shaped patterns (`KEY_SHAPED`). A vault value is a hard refusal ("That file contains one of your saved secrets, so I won't send it."). A key-shaped match makes it ask with the line number shown (redacted). **Minors:** the file name and caption run through `minorSexualMatch`; text-like files through it too (first 1 MB). |
| Output to the model | "Shared report.pdf (120 KB) in this chat." / the refusal. Never the content. |

Pictures she makes don't need `send_file`: they already ride on her reply (§4.3).

### 4.5 When a picture goes to a model

The turn already chooses the model (`chat.ts` l. 1435–1457). BR1 adds one rule and fixes one fact:

| Situation | What she gets |
|---|---|
| Owner's chat, a vision route set (`routes.vision`) | The `vision` job runs with the picture (today's web rule). |
| Owner's chat, no vision route, the talking model can see | The talking model gets the picture (today's rule: `sees()` is true when no vision route is set). |
| The model can't take pictures (a provider error that mentions images) | Today's error ("this model can't look at pictures") is replaced on bridges by a line: "I can't see pictures with the model I'm using. Set a picture model in Settings → Which model does what." |
| **A conversation marked private** | Only local models. If the vision route isn't local, the turn runs on the local chain and, when that model can't see, a note "[a photo was shared; the picture model isn't on this computer, so you can't see it]" goes with the message. This replaces the throw in `resolveChain` for this one case (code fact 3). |
| **Private local mode** | Telegram and Discord are paused already (`privateLocalOn()`); plugin bridges that are still running follow the same chain filter (on this computer only). |
| A picture from someone else (partner chat, room) | Only when the place allows it (§4.6), and only through **describe-first** (below). |

**Describe-first** (pictures from other people). The talking model never gets someone else's picture
directly. The vision model (or the talking model, if it can see and no vision route is set) is asked,
through the existing `describeImage` helper, for a short plain description plus a one-word label from
a fixed list (`ok`, `explicit`, `minor`, `violent`, `document`), with no persona and no tools. The
talking model then gets the description as **untrusted text**, fenced like room lines
(`fenceLines(…, 'PHOTO')`): "[Photo from {name}, described by the picture model: …]".
- `minor` → the picture is deleted at once, the message gets `MINOR_BLOCK_REPLY`, nothing is passed on,
  and a count (no content) is kept on the `shared_files` row.
- `explicit` in a room that isn't marked adult, or in any partner chat with Adult mode off → she says
  she won't look at that here; the picture is deleted.
- `document` (a photo of a page, a screenshot of text): fine to describe; any text in it is still
  untrusted (it can't instruct her: partner turns have no tools anyway).
- The description call is a `cheapCall` with source `photos:<room|chat>` and its own daily cap (50
  pictures from others per day across all chats), so a flood of pictures can't run up a bill.

### 4.6 Who may send what, where

"Files from others are treated like their messages": a picture is part of the message of whoever sent
it, with that person's rules.

| Place | Pictures in | Documents in | Her pictures out | `send_file` | Her screenshots (`proof`) |
|---|---|---|---|---|---|
| Owner DM | yes (`media.send` doesn't gate input) | yes (today) | yes (`media.send`, default on) | yes, `auto` | only with `media.proof` on (default **off**) |
| Owner work room | yes, his own pictures | yes, his own (today) | yes | yes, **asks first** | never (a shared room) |
| Partner DM | only with `photosFromOthers: 'describe'`; else "I can't look at pictures here." | no (today) | none: partner turns have no tools, so she makes no pictures there (`take_photo` and moments are tools) | no (no tools) | never |
| Room (others) | only when the room's `photos_from_others` is on; describe-first | no | none (as partner DM); a picture from the owner's own chats is never re-posted into a room | no | never |
| Plugin bridge | as the place it maps to (owner chat ids vs others), only with the `bridgeFiles` permission (§4.9) | owner only | yes, if the plugin opted in | yes, owner chats | as owner DM |

Her own photos of herself (`take_photo`) are already shaped by the persona's look and the minors
block; nothing new is generated for chat apps. A picture she sent once is never re-sent to a different
chat by itself.

### 4.7 Per-platform limits and quotas

| Limit | Telegram | Discord | Plugin bridge | Sara's own cap |
|---|---|---|---|---|
| Download (a file to her) | 20 MB (`getFile`) | per file, as uploaded (≤ 20 MiB default) | chunked, ≤ 20 MB | pictures ≤ 8 MB, 4 per message; documents ≤ 20 MB on Telegram, ≤ `MAX_DOC_BYTES` elsewhere |
| Upload a picture | 10 MB (`sendPhoto`), album 2–10 | 20 MiB per file | ≤ 8 MB | 4 per reply |
| Upload a file | 50 MB (`sendDocument`) | 20 MiB per file (default; more with boosts) | the plugin's `maxBytes` (≤ 20 MB) | `send_file` asks over 5 MB |
| Caption / text | 1024 / 4096 | content 2000 (Sara splits at 1900) | 8000 in, plugin decides out | caption ≤ 300 from `send_file` |
| Sends and edits | 1 per second per chat, 20 per minute in a group, 429 `retry_after` | per-route buckets (headers), 50 req/s global, 429 `retry_after`, 10,000 invalid per 10 min | 100 calls a minute | progress: one edit at most every 3 s (Telegram DM), 6 s (Telegram group), 2.5 s (Discord); B2 priorities |
| Daily quota (new) | | | | Owner: 200 pictures in, 100 files out, 500 MB a day across bridges. Each partner chat: 20 pictures in. Each room: 30 pictures in. Over a quota: one line ("That's my picture limit for today here.") and nothing more until the next day. Settings shows the counts. |

Quotas are counted from `shared_files` by `(bridge, chat key, local day)`. They protect the disk, the
vision bill and the platform limits; the owner can raise his own (pick-list), not remove them.

### 4.8 The live progress message

**One message per turn, edited in place.** B4 follows the turn's events; the bridge gives it a
`ProgressPort` (Telegram: `sendMessage` + `editMessageText` + `editMessageReplyMarkup`; Discord: `POST`
+ `PATCH /channels/{id}/messages/{id}`; plugin: `bridge.send` with a `ref` + `bridge.edit`, §4.9).

*When it appears.* Only when progress is on for this place (below) **and** the turn is still running
after `afterSeconds` (10 s). Quick chats never see it. If an approval is the first thing she needs, the
approval message goes out as today and the progress message appears under it at the 10-second mark.

*What it says* (rebuilt from state on every change, never appended to):
```
⏳ Working on it · 0:42                 ← header: state + elapsed (shown in whole seconds, edited only with a change)
✅ Read 3 files
✅ Ran the tests (2 failed)
▸ Editing src/app.ts…                   ← the current step: the B3 "while running" verb
🔁 Stopped repeating a step that kept failing   ← BR2 loop guard, when it fires
📝 Got your note                         ← BR2 steer taken, when it happens
[ ⏹ Stop ]                               ← one button (owner only), removed in the final state
```
- At most **6 step lines**: the newest 5 plus "…and 7 earlier steps". Same-verb runs fold ("✅ Read 3
  files", not three lines). Verbs come from B3 (`stepWords`) in the reader's language: the owner's
  app language (`ownerLanguage`). The words "(2 failed)" come from the tool's **status**, not its
  output. A file name appears only when B3's verb already names it for the web step line, and every
  rendered line passes `app.redactor.redact` and `minorSexualMatch` (a line that trips it is dropped).
- **Never in the message:** tool output, arguments, commands, URLs, model text, approval details,
  memory or people names. The approval itself stays its own message with Allow/Deny (today's path), and
  the progress line just says "⏸ Waiting for your OK (above)".
- The header shows states from the existing activity tracking (`trackActivity` statuses: thinking,
  running, waiting, writing).

*Throttle.* Each change marks the message dirty; B2 sends **the latest text only**, no more than one
edit every 3 s in a Telegram private chat, 6 s in a Telegram group (its 20-a-minute cap is shared with
her replies), 2.5 s on Discord, and never when the text hasn't changed. Her reply and approvals always
jump ahead of edits. A 429 pauses edits for `retry_after` (the final edit is retried once after it);
three failed edits in a row turn progress off for the rest of the turn (the reply still comes).

*The Stop button.* Telegram inline button `st:<convId>`, Discord button `custom_id st:<convId>`.
Pressing it is the same as `/stop`: checked on the server (owner only, the same `isTelegramOwner` /
`isDiscordOwner` test as approvals), then `adapter.stopTurn`. Anyone else gets "Only the person who
runs me can stop this."

*The final state.* When the turn ends, one last edit, and the button is removed:
- done: `✅ Done · 6 steps · 1:12` (and "· 1 note from you" when BR2 steered)
- stopped: `⏹ Stopped after 3 steps`
- an error: `⚠️ Couldn't finish: {short reason}` for the owner (the reason as the reply already words
  it), `⚠️ Couldn't finish` elsewhere
- the budget ladder: `💰 Budget reached after 40 steps` (the reply carries the *Continue* card's words)
- a restart: `⏹ Interrupted (Sara restarted)` (written at start-up from `bridge_progress`, below)

Her answer is then sent **as new messages**, not as an edit of the progress message. Edits don't notify
on either platform, a long answer has to be split anyway, voice replies are a separate kind of
message, and pictures go first (§4.3). This is the one deliberate difference from the pitch ("then
turns into the answer"): the progress message turns into the summary line *above* the answer. With
`final: 'delete'` it is deleted instead (Telegram `deleteMessage`, Discord `DELETE`), §11 Q2.

*The toggle.*
- Settings → Telegram / Discord → **Progress while she works** (switch, default on) and *Where*
  (*Private chats only*, default / *Also rooms where I work with her*). Partner chats and rooms she
  only talks in never get one (partner turns have no tools: there are no steps to show).
- `/progress on|off` (owner only, a new CH1 command) sets it for this chat (`meta.progress` on the
  session, carried by `/new`), and `/progress` alone says the current state.
- `typing` keeps running under the progress message while she works (it shows "typing…" in the chat
  list on phones).

*Restarts.* Each open progress message has a `bridge_progress` row; it is deleted with the final edit.
At start-up, rows left over get the "Interrupted" final edit (best effort, once) and are removed.

### 4.9 The plugin bridge contract (v1.1, opt-in)

All additions are **opt-in by the plugin**; a plugin that says nothing gets today's text-only bridge.

| Step | Message | Notes |
|---|---|---|
| Sara says what she supports | `init {…, bridgeApi: 2, bridgeFeatures: ['files', 'edit']}` | New fields; v1 plugins ignore them. |
| The plugin opts in | `ready {…, bridge: {files: true, edit: true, maxBytes: 8000000}}` | Only what the manifest's permissions allow. |
| Permission | manifest `permissions.bridgeFiles: true` | Shown on the plugin's review card in plain words: "Can send and receive pictures and files in its chats". Without it `files` is ignored. |
| A file to Sara | `call op:'bridge.file' {bridge, chatId, fileId, name, mime, size, seq, last, data}` (base64 chunks ≤ 512 KB, so a line stays under the 1 MB cap), then `bridge.inbound {…, files: [{fileId}]}` | Sara assembles chunks per `fileId` for 60 s, checks the total against the caps (§4.7), runs B1 `takeIncoming`. Chunks count toward the 100 calls a minute. |
| A file from Sara | `bridge.send {bridge, chatId, text?, files: [{fileId, name, mime, size, caption?}]}` followed by `bridge.file` chunks from Sara | The plugin uploads it to its service. |
| Progress | `bridge.send {…, ref: 'p-<n>', text}` then `bridge.edit {bridge, chatId, ref, text}` | Only with `edit: true`. The plugin keeps the map from `ref` to its own message id. Without it: no progress message on that bridge. |
| Stop | `bridge.inbound {…, action: 'stop', ref}` | A plugin that can show a button sends this when it's pressed; Sara checks the chat is an owner chat. |

`examples/plugins/sara-plugin.mjs` gets `files` and `edit` in its `bridges` handler; the LINE example
bridge shows both. docs/PLUGINS.md §6/§8 is updated in the release.

### 4.10 Storage and cleanup

- **Pictures that arrived** live in the upload folder like web photos and are deleted with their
  conversation (`prune(imagesInUse)`). Pictures **from other people** keep their bytes for
  `keepOthersDays` (7): a daily sweep (the existing hourly housekeeping timer) deletes the bytes and
  sets the message's `meta.images` to a `[photo]` mark (the description stays, if there was one).
  Pictures refused by describe-first are deleted at once.
- **Copies of files she sent** live in `<dataDir>/shared/` for `sentKeepDays` (30), then the bytes go
  and the row stays (`expired`), so the chip says "no longer kept".
- Both folders are inside the data folder, so backups include them (and the backup size line in
  Settings → Data & health counts them).
- `shared_files` rows older than a year are removed by the same sweep. *Forget this room* (CH4) and
  deleting a conversation also delete its `shared_files` rows and files.

### 4.11 Tables (additive, `store.db` of the owner's main companion)

```sql
CREATE TABLE IF NOT EXISTS shared_files (
  id TEXT PRIMARY KEY,                -- random
  conversation_id TEXT NOT NULL,
  message_id INTEGER,                 -- the user message (in) or her reply (out)
  direction TEXT NOT NULL,            -- 'in' | 'out'
  bridge TEXT NOT NULL,               -- 'telegram' | 'discord' | 'plugin-<name>' | 'web'
  chat_key TEXT NOT NULL,             -- for quotas
  sender TEXT NOT NULL,               -- 'owner' | 'person' | 'her'
  kind TEXT NOT NULL,                 -- 'photo' | 'file' | 'proof'
  name TEXT, mime TEXT, bytes INTEGER, sha256 TEXT,
  upload_id TEXT, path TEXT,          -- where the bytes are (uploads, or data/shared)
  platform_ref TEXT,                  -- Telegram file_id / Discord attachment id
  status TEXT NOT NULL,               -- 'ok' | 'refused' | 'failed' | 'expired'
  reason TEXT,                        -- e.g. 'size', 'quota', 'minor', 'explicit', 'secret'
  created_at TEXT NOT NULL, expires_at TEXT
);
CREATE INDEX IF NOT EXISTS shared_files_quota ON shared_files(bridge, chat_key, created_at);
CREATE TABLE IF NOT EXISTS bridge_progress (
  conversation_id TEXT PRIMARY KEY, bridge TEXT NOT NULL, chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL, started_at TEXT NOT NULL
);
ALTER TABLE rooms ADD COLUMN photos_from_others INTEGER;   -- null = global
ALTER TABLE rooms ADD COLUMN progress INTEGER;             -- null = global
```

### 4.12 Routes (owner-only; members' own conversations where noted)

- `GET /api/files/:id` (owner; members for their own conversations' files): downloads a file she
  shared (`content-disposition: attachment`, `x-content-type-options: nosniff`, never inline HTML).
- `GET /api/conversations/:id/files`: the files in and out of a conversation (the info panel list).
- `DELETE /api/files/:id`: removes the bytes now (the row becomes `expired`).
- `GET /api/chats/media`: today's counts against the quotas, per bridge (the Settings card).
- `POST /api/bridges/:bridge/test-picture`: sends a small test picture to the owner's chat (the
  *Send me a test picture* button), so the owner can check the setup without a model.

### 4.13 UI

- **Settings → Telegram** and **→ Discord** get a **Pictures and files** card: *Send me pictures and
  files here* (switch), *Look at pictures other people send* (pick-list: *No* / *Yes, described first*),
  *Send screenshots of her work* (switch), *Keep other people's pictures for* (1 / 7 / 30 days),
  today's counts, and *Send me a test picture*. And a **Progress while she works** card: the switch,
  *Where*, *Show it after* (5 / 10 / 20 / 30 s), *When she's done* (*Keep one summary line* / *Remove
  it*), with a static preview of the message.
- **Rooms** (CH4's room cards): *Look at pictures here* and *Progress here* per room.
- **The conversation info panel**: *Files in this chat* (in and out, with size and *Remove*).
- **Her reply in the web app**: a file chip for each `send_file` result (name, size, download);
  pictures that came from a chat app show a small "from Telegram" badge.
- **? tips** (each ≤ 260 characters):
  - *Send me pictures and files here*: "When she makes a picture or shares a file in Telegram, it arrives
    as a real photo or file. Off: she says it's in the app instead."
  - *Look at pictures other people send*: "Off by default. When on, a picture from someone else is
    first described by your picture model, checked, and only the description reaches her. Their
    pictures are kept 7 days."
  - *Send screenshots of her work*: "Screenshots she takes while using the computer or a browser can
    show private things. Off by default; when on, they go only to your private chat."
  - *Progress while she works*: "On long jobs, one message shows what she's doing and is updated in
    place, then becomes a short summary above her answer. Never shows commands, output or secrets."
  - *Show it after*: "Quick replies don't need it. She only posts the progress message when a reply
    takes longer than this."
  - *When she's done*: "Keep a one-line summary (steps and time) above her answer, or remove the
    progress message completely."

### 4.14 Done when (`test/phase115.test.ts`, plus the existing suites green)

Using the stand-in Telegram and Discord servers from CH1 (`SARA_TELEGRAM_API`, `SARA_DISCORD_API`,
`SARA_DISCORD_GATEWAY`) and a fake model that records what it was sent:
- **Telegram photo in:** an update with a 3-size `photo` and a caption → the largest ≤ 8 MB is fetched
  with `getFile`, saved through `UploadStore` (magic check), stored on the user message's
  `meta.images`, and the fake model's last user message carries the image. No caption → `(photo)`.
  A 9 MB-only photo → the size line, no turn.
- **Album:** three updates with one `media_group_id` → one turn with 3 images; five → 4 images and
  the "first 4" line.
- **Discord photo in:** an `image/png` attachment → one turn with the image; a picture-only message is
  answered (no longer ignored); a 25 MB image → refused with the size line.
- **Vision routing:** with a vision route set, the job is `vision`; in a conversation marked private
  with a cloud vision route, the turn runs on the local chain with the "can't see it" note (no throw).
- **Others:** a partner's photo with `photosFromOthers: 'off'` → "I can't look at pictures here.",
  nothing downloaded. With `'describe'`: the describe call runs, the talking model gets only the fenced
  description, never the image; a fake label `minor` → `MINOR_BLOCK_REPLY`, the upload deleted, the
  count kept; `explicit` in a non-adult room → refused and deleted.
- **Pictures out:** a turn where the fake model calls `take_photo` → Telegram `sendPhoto` multipart
  with the reply as the caption (≤ 1024), then nothing else; a 2,000-character reply → photo, then the
  split text; Discord → one `files[0]` message with `content`.
- **`send_file`:** a workspace PDF → `sendDocument` after the turn, a `shared_files` row, a file chip
  event; `../outside` and `.env` → refused; a file containing a vault value → hard refusal; a
  key-shaped string → an approval; in a work room → an approval first; not offered in a partner or
  private conversation or in private local mode.
- **Progress message:** a fake turn of 12 s with 4 tool steps (fake clock) → exactly **one**
  `sendMessage` at 10 s, then `editMessageText` calls no closer than 3 s apart, unchanged text never
  sent, a final edit `✅ Done · 4 steps · 0:12` without the Stop button, and the answer as a new
  message. A 6 s turn → no progress message. A 429 with `retry_after: 2` → edits pause 2 s and the
  final edit is still made. A partner chat → never. `/progress off` → none in that chat.
- **No leaks:** a tool whose output and arguments contain a vault secret and a URL → the progress
  texts contain neither (only the B3 verb).
- **Stop button:** the owner's press stops the turn (`⏹ Stopped after n steps`); a partner's press is
  refused and changes nothing.
- **Pacing:** while progress edits are queued, her reply is sent first (B2 priority).
- **Restart:** a leftover `bridge_progress` row gets the "Interrupted" edit at start-up and is removed.
- **Plugin bridge:** a plugin that opts in (`files`, `edit`) receives a progress `ref` and edits, and a
  chunked picture reaches the turn; a v1 plugin (no `ready.bridge`) gets exactly today's text-only
  messages; a plugin without `bridgeFiles` that sends `bridge.file` is denied and logged.
- **Quotas:** the 21st partner picture of the day → the quota line, nothing downloaded.
- **Cleanup:** the sweep removes other people's picture bytes after 7 days (fake clock) and marks the
  message; `sentKeepDays` expires copies; deleting a conversation removes its files.
- **Safety:** captions are checked like messages (a crisis caption gets the crisis resources); the
  disclosure still comes first in a new partner chat that starts with a photo; keep-up's passive log
  still writes `[photo]` and never downloads.

### 4.15 Owner to-dos

From his phone: send her a photo and an album of three in Telegram and in Discord; ask for a selfie
and for a chart as a PDF in both; run a long coding job from Telegram and watch the progress message,
press its Stop once; in a test group, check that a friend's photo gets "I can't look at pictures
here" until he turns it on for that room. Set a picture model (the `vision` job in Settings → Which
model does what) if he wants photos read by a different model than the talking one. Decide §11 Q1–Q6.

---

## 5. BR2 · Phase 116 · 2.49.0: talk while she works

### 5.1 Scope

1. **Steer** (*Tell her now*): a message sent while she works is added to the running turn **at the
   next safe point**, and she takes it into account from the next step.
2. **Queue** (*After this*): a message sent while she works runs as **its own turn after the current
   one** (and after any queued before it).
3. **`/btw`** (*Just asking*): a side question answered at once **without disturbing the work**:
   nothing added to the conversation, no tools, the running turn untouched.
4. **One default and one way to choose**, the same in the web app, Telegram, Discord and plugin
   bridges.
5. **The tool-loop guard:** after **3 identical failing tool calls** in a turn, that exact call is
   blocked for the rest of the turn and she has to change approach or ask.

Not in BR2: steering group chats of several companions (Phase 66 rooms keep their 409, "The group is
still answering"), steering other apps' turns (`/v1`, MCP, A2A keep today's busy answers), and goals
that keep going on their own (Phase 118).

### 5.2 The three ways, side by side

| | Steer | Queue | `/btw` |
|---|---|---|---|
| What happens | Added to **this** turn at the next safe point (§5.4) | Its own turn, after this one | One side answer now, in parallel |
| Stored in the conversation | Yes, as a user message, **when it is taken** (not before) | Yes, as a user message, **when its turn starts** | **No** (a usage row only) |
| Tools, approvals, memory | It is a normal owner message: it can't approve, deny, change the model, the permissions or the budget | A normal turn | None; she can't act |
| Who | The owner in his own conversations (web, DM, work room); a member in their own conversations (web) | Everyone who can talk to her there (partners too) | The owner (and members in the web app) |
| When she isn't busy | Same as a normal message | Same as a normal message | Still a side answer, still not stored |
| Chat apps | `/steer …`, or a plain message when the default is *steer* | `/queue …`, or a plain message when the default is *queue*; partners always queue | `/btw …` |
| Answer you see | A reaction (👀) on your message, and "📝 Got your note" in the progress message when she takes it | "I'll do this next (1 waiting)." | Her short answer, marked as a side note |

**The default** (`chats.whileBusy`) is **steer** for the owner and members: it is the one that saves a
wasted run ("use pnpm, not npm"), and when a turn is about to end anyway a steer simply becomes the
next turn (§5.4), so nothing is lost by choosing it. Partners always queue (they have no tools, so
their turns are one short reply; steering means nothing there). §11 Q7.

### 5.3 Pending inputs (B5): one queue, one steer box

A message that arrives while the conversation is busy (`active.has(conv.id)` in `server.ts`, the same
test the 409 uses) becomes a `pending_inputs` row and **is not written to the conversation yet**.
That matters: the turn rebuilds its history from the store at every step (§1, code fact 1), so a
queued message stored early would quietly act as a steer.

Lifecycle:
```
 arrives while busy ─► pending (kind: steer | queue)
     steer ─► taken at the next safe point ─► stored as a user message (meta.steer) ─► state 'taken'
          └─ the turn ended before a safe point ─► becomes the first queued item ('moved')
     queue ─► its turn starts ─► stored as the user message of that turn ─► state 'taken'
     ×      ─► cancelled by the sender (web ×, /reset, /new) ─► state 'dropped'
```
- **One server queue.** `pending.enqueue(convId, input, runner)` keeps a FIFO per conversation and
  starts the next runner when `runTracked` ends (its `finally`). Telegram and Discord pass their own
  `#turn` closure as the runner, so their reply path (pictures, progress, voice, pacing) is unchanged;
  their `#queues`, `#waiting` and `#cleared` move into B5, and `clearQueue` in `BridgeAdapter` becomes
  `pending.clear`. Telegram's 10-minute wait for a web turn (`#turn` l. 627) goes away: a web turn and
  a Telegram turn in the same conversation now share one queue. The web app's runner is the server's
  own `runBackground`-style runner, which the open page follows through its existing watch path
  (`watchConversation`).
- **Caps:** `queueMax` (5) waiting items per conversation; 5 steers per turn, each ≤ 4000 characters
  and up to 4 pictures (the web's `savePhotos` rules). Over a cap: one line ("I already have 5
  waiting here. I'll take more when I've done some.") and nothing stored.
- **Restarts.** Rows hold the input and, for bridges, where to answer (`where` JSON: chat id, place,
  language, message id). The runner is a closure, so it dies with the process. At start-up, rows still
  `waiting` become `stale`: the web app shows them with *Send now* / *Remove*; on a bridge the owner
  gets one line, "I restarted before I got to your message: \"{first 60 characters}\". Send it again
  if you still want it." **Nothing runs by itself after a restart** (no surprise spend). §11 Q9.
- **Order.** Items keep their arrival order. *Now* on a queued item (web) or `/steer` re-sent turns it
  into a steer (`promote`). Two steers taken at the same safe point go in as two user messages, in
  order.

### 5.4 The safe point

A steer is taken **only between steps**: after every tool call of the previous step has its result
stored, before the next model call. Concretely, at the top of `runTurn`'s step loop (`step > 0`),
before the history is built (l. 1885–1938):

1. `pending.takeSteers(conv.id)` returns the waiting steers (and marks them `taken`).
2. Each runs the **turn-start checks** (§6.3) on its text and caption: the minors block, crisis
   detection, the plan check's owner-decision scan stays as it is for the next calls.
3. Each is stored as a `user` message with `meta.steer: {afterStep, runId}` (and `meta.images` if it
   had pictures). The next `buildHistory` includes it, in order, after the tool results.
4. A transient app note goes into this step's messages (like `contradictNotes`, never stored): "[Note
   from the app: {owner} sent this while you were working, after step {n}. Take it into account from
   here. Don't redo finished work unless it asks you to. It doesn't answer any approval.]"
5. An event `{type:'steer', messageId, afterStep}`: the web app draws the message inside the running
   turn ("You, while she worked: …"); the progress message shows "📝 Got your note"; the run record
   adds a `steer` step (Phase 78 recorder) so time-travel and replays see it.
6. **An owner steer clears the loop guard's blocks** for this turn (§5.8): what he says may have
   changed the situation ("I started the database, try again").

What is **not** a safe point, and why:
- *Inside a tool call* (a 10-minute test run): the steer waits; the web chip says "She'll read it after
  this step (running the tests)". Stop is still there for "stop now".
- *While an approval waits*: the steer waits. The card stays the only way to answer it; text like "yes,
  go ahead" sent as a steer approves nothing, and the chip says "Answer the card first: Allow or
  Deny." (GAP #2: "it can't approve anything".)
- *While the model writes its final answer* (no tool calls): there is no next step. When the turn ends
  with steers still waiting, they become the **first queued turn** (state `moved`), with the line
  "She'd already finished; she'll answer your note now." Nothing is dropped.

Steering never extends the step cap, the token budget or the time limit (`TurnMeter` keeps counting),
and the M4 ladder treats the steer's tokens like any other history. Stop wins over everything: a Stop
(or `/stop`, or the progress message's button) aborts the turn, and waiting steers become queued
items the sender can cancel.

### 5.5 Choosing (web app)

- **The composer stays open while she works.** Today Send is hidden and Stop shown (`setComposerBusy`,
  `web/app.js` l. 1149) and Enter is ignored (l. 2487). In BR2, while she works, Stop stays and Send
  becomes a **split button**: the main part does the default, labelled by it (**Tell her now** or
  **After this**); the small ▾ opens three choices, each with a one-line hint:
  - *Tell her now*: "She reads it before her next step."
  - *After this*: "She does it when she's finished."
  - *Just asking*: "A quick answer on the side. Not added to the chat."
- **Keyboard:** Enter = the default; Alt+Enter = the other one; typing `/btw …` (or `/steer`, `/queue`)
  picks explicitly. These join CH1's typed web commands.
- **Pending chips** above the composer, one per waiting item: "📝 Tell her now: \"use pnpm…\" · waiting
  for the next step [×]" and "⏭ After this: \"then update the docs\" [Now] [×]". A stale item (after a
  restart) shows *Send now* / *Remove*.
- **The side answer** appears in a small card above the composer, "💬 Side question", with the question,
  her answer and *Close*; it is gone after a reload (it was never stored).
- **Phone and desktop apps** (Android, iPhone, Windows, Mac) get the same split button when they update
  to 2.49.0; until then they keep today's behaviour (§5.7). The CLI (`sara-chat`) gets `/steer`,
  `/queue` and `/btw` as typed commands.
- **Settings → Chats → While she's working** (new card): *When you send a message while she's working*
  (pick-list *Tell her now* / *Queue it for after*), *Messages that can wait* (3 / 5 / 10), *Side
  questions use* (*Quick model* / *This computer's model*), *Side questions per day* (20 / 60 / 200).

### 5.6 `/btw`: the side question (B6)

- **Input:** `/btw <question>` in a chat app (owner only), *Just asking* in the web app, `POST
  /api/conversations/:id/btw`. Works whether or not she's busy.
- **What she sees:** a short system prompt built by `buildSystemPrompt` with the persona and the
  safety notes (the same base as a turn, without memory injection, tools, agenda or people) plus one
  rule: "This is a quick side question while you work on something else. Answer briefly from what you
  can see here. You can't use tools or change anything, and your work carries on separately." Then a
  read-only slice of the conversation: the last 20 messages within 16,000 characters through
  `buildHistory` (no pictures: they cost and slow it down), which includes the running turn's stored
  steps and their (already scrubbed) tool results, so "what does that error mean?" can see the error.
  Then "What you're doing right now:" with the progress lines (B3 verbs). Then the question.
- **The model:** `cheapCall` with source `btw`, purpose `btw`, `maxTokens` 600, 60 s timeout, today's
  cap `btw.dailyCap` (60 calls). `btw.model` = `quick` by default (the owner's quick-replies route; he
  asked, so it isn't unasked spend under Rule 7) or `local`. A private conversation and private local
  mode use only local models, as `cheapCall` already does. Members: their own routes and limits
  (`member` policy is checked before the call).
- **Nothing is stored:** no message, no memory note, no mood, no title change, no run record, no keep-up
  summary input. One usage row and the ledger entry, so Settings → Usage shows *Side questions*.
- **Where the answer goes:** web: the side card. Telegram: a reply to the `/btw` message, starting
  "💬". Discord: a slash command answers ephemerally (deferred type 5, flag 64); a typed `/btw` in a DM
  gets a normal reply. In a work room the answer goes to the owner privately (like `/status` today), and
  the room sees only "Sent you the answer privately."
- **It doesn't disturb the work:** it doesn't touch `active`, the turn's controller, the store, the
  pending queue or the progress message. On a local model that serves one request at a time it will
  wait for the turn's current model call; the ? tip says so, and after 60 s it answers "I'm busy with
  the big job on this model; ask again in a moment, or set a quick model for side questions."
- **Safety:** the question gets the turn-start checks (§6.3); a crisis question is answered with the
  crisis resources (`CRISIS_SYSTEM_NOTE` in the side call, `CRISIS_RESOURCES` appended), never as a
  quick aside; the answer is redacted and checked with `minorSexualMatch` (→ `MINOR_BLOCK_REPLY`) and,
  in places that aren't adult, `detectExplicit` (→ a plain refusal).

### 5.7 The same in Telegram, Discord and plugin bridges

| | Telegram | Discord | Plugin bridge |
|---|---|---|---|
| Plain message while busy, owner | the default (`whileBusy`) | the default | the default |
| Plain message while busy, someone else | queued (as today) | queued (as today) | **queued** (today: dropped) |
| Explicit | `/steer <text>`, `/queue <text>`, `/btw <text>` (typed; in the `setMyCommands` lists for the owner's scopes) | the same three as `CHAT_INPUT` commands with a required `text` option, localised names (`DISCORD_NAMES`), in the one bulk overwrite | typed |
| Steer acknowledged | `setMessageReaction` 👀 on his message; if that fails, a short "Got it, I'll use that at the next step." | reaction 👀 (`PUT …/reactions/👀/@me`); a slash command answers "Got it." ephemerally | "Got it, I'll use that at the next step." |
| Queue acknowledged | "I'll do this next ({n} waiting)." | the same | the same |
| Taken | "📝 Got your note" in the progress message (if shown) | the same | the same, with `edit` |
| Pictures with a steer | yes (owner, §4.2) | yes | with `files` |

`/steer`, `/queue` and `/btw` join CH1's command table with `commandAllowed`: owner only everywhere
(`/queue` is also open to a partner in their own DM, where it means the same as a plain message);
bots run none. The name form (`Sara new`) doesn't apply: they take text. `/reset` and `/new` clear the
conversation's pending items (and say how many: "Cleared. 2 waiting messages were dropped.").

**The web route.** `POST /api/conversations/:id/messages` while she's busy:
- with `whileBusy: 'steer' | 'queue'` in the body (the 2.49 web app always sends it) → **202** with
  the pending item;
- without it (older phone and desktop apps, scripts) → today's **409**, unchanged, so nothing breaks
  for clients that don't know about steering (§9 risk 6). `/v1`, MCP and A2A keep their busy answers.

### 5.8 The tool-loop guard (B7)

**What counts.** Three words, each defined in code:
- *The same call*: the same tool name and the same arguments, compared as **canonical JSON** of the
  scrubbed arguments (`app.redactor.redactValue`, keys sorted, strings trimmed, runs of whitespace in
  a `shell` command collapsed). Exact, not "similar": `npm run build` and `npm run build -- --verbose`
  are different calls. The key is `sigOf('command', name + '\n' + canonical)` from `src/triggers.ts`.
- *Failing*: `stepFailed(name, status, output)`: an `error` status, or a shell command with a non-zero
  exit or a time-out (the M10 rule, so recall and the guard agree).
- *The same way*: the failure key M10 already builds, `name|class|normalizeMessage(errorLine(output))`
  (paths, ids, times and numbers taken out), so "line 12" vs "line 13" of the same error still counts.

**The rule.** Per turn, per call key: a failure the same way as the last one adds 1; a failure a
different way starts again at 1; a success removes the key. **At 3, the key is blocked for the rest of
the turn.** A blocked call:
- is refused in the tool loop's refusal chain (right after "not offered here", before permissions,
  plugins' `tool.before`, the sandbox gate and approvals), so **it never runs and no card is shown**;
- gets status `denied` and the output: "Blocked by Sara's loop guard: this exact call has failed 3
  times in this turn with the same error: \"{error line, scrubbed, ≤ 200 characters}\". It won't run
  again in this turn. Change your approach (a different command, different arguments or another tool),
  or ask {owner} what to do.";
- adds a one-time app note to the next step (transient, like the plan check's notes): "[Note from the
  app: the loop guard blocked a call that kept failing. Don't try it again. Say in one line what you'll
  try instead, then do that.]";
- emits `{type:'loop_guard', id, name, quote, count}` → the web step line draws "🔁 Blocked a repeat
  (failed 3 times)", the progress message adds "🔁 Stopped repeating a step that kept failing", and the
  run record's tool step gets `guard: {kind: 'loop', key, quote}` (Settings → Runs shows it).

**Two smaller rules in the same guard** (both only stop calls):
- *Declined twice:* the same call the owner declined twice in a turn isn't asked a third time; it is
  refused with "The owner declined this twice in this turn." (No more cards for the same thing.)
- *Ignoring the block:* if she tries blocked calls 3 more times in the same turn, tools are switched
  off for the rest of the turn (as the budget ladder's *fewer tools* rung does, `plan.noTools`) with
  the note "Tools are paused for this turn. Tell {owner} what went wrong and what you'd try next." and
  the reply ends the turn normally.

**What doesn't count:** calls refused by a rule (not offered, private, private local mode, *never*),
calls cancelled by Stop, sandbox tries the owner discarded, and calls that time out because the turn
was stopped. Those are already refusals or the owner's choice.

**Resets:** a new turn starts clean (the owner's words: "for the turn"); an owner **steer** clears the
blocks and counts (§5.4); *Continue* after a budget stop is a new turn. §11 Q10 asks whether a
"continue" right after a guard block should carry the block over.

**Everywhere a turn runs:** web, bridges, board cards working in the background (ST4), helper teams,
`/v1` and MCP turns that have tools, replays (the guard decides again from the recorded outputs, so a
replay is deterministic). Partner chats have no tools, so it never fires there. No setting turns it
off; the number 3 is fixed in v1 and shown read-only in Settings → Abilities → Coding with a ? tip.

### 5.9 Tables (additive, `store.db` of every companion and member)

```sql
CREATE TABLE IF NOT EXISTS pending_inputs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- 'steer' | 'queue'
  content TEXT NOT NULL,              -- ≤ 4000 characters
  meta TEXT NOT NULL DEFAULT '{}',    -- images (upload ids), docs, source ('web' | 'telegram' | 'discord' | 'plugin-<x>'), where
  sender TEXT NOT NULL,               -- 'owner' | 'member' | 'person'
  state TEXT NOT NULL,                -- 'waiting' | 'taken' | 'moved' | 'dropped' | 'stale'
  message_id INTEGER,                 -- the user message it became
  created_at TEXT NOT NULL, taken_at TEXT
);
CREATE INDEX IF NOT EXISTS pending_inputs_conv ON pending_inputs(conversation_id, state, created_at);
```
Rows in `taken`, `dropped` or `moved` are kept 7 days (for the run view and support), then removed by
the hourly housekeeping. Off-the-record conversations keep their pending items in the in-memory store,
like everything else of theirs. No table for `/btw` (by design) and none for the guard (it lives in the
turn and the run record).

### 5.10 Routes

- `POST /api/conversations/:id/messages` with `whileBusy` (above): 202 + `{pending: {id, kind,
  state}}` while busy; the normal stream otherwise.
- `GET /api/conversations/:id/pending`: the waiting and stale items (owner; members for their own).
- `DELETE /api/conversations/:id/pending/:pid`: cancel a waiting item.
- `POST /api/conversations/:id/pending/:pid/now`: a queued item becomes a steer; a stale one is sent.
- `POST /api/conversations/:id/btw` `{question}` → `{text, model, local}` (owner; members for their
  own conversations; 429 with "That's the side-question limit for today" when the cap is reached).
- `GET /api/chats/commands` (CH1) lists the new commands.
- Events on the hub: `{type:'pending', conversationId, item}` so another device showing the
  conversation sees the chips, and the turn's `steer` and `loop_guard` events in the stream.

### 5.11 ? tips (each ≤ 260 characters)

- *When you send a message while she's working*: "Tell her now: she reads it before her next step and
  adjusts. Queue it: she does it when she's finished. Either way you can change it per message with the
  ▾ next to Send."
- *Messages that can wait*: "How many messages can wait their turn in one conversation. More than this
  and she asks you to wait a moment."
- *Side questions use*: "Side questions (/btw) are answered by a small model so the big job isn't
  disturbed. On a computer that runs one model at a time, they may wait for her current step."
- *Side questions per day*: "A cap on side questions so a stuck script can't run up a bill. Private
  chats always use a model on your own computer."
- *Loop guard (read-only)*: "If the exact same step fails the same way 3 times in one reply, Sara
  blocks it and makes her try something else or ask you. It can only stop a step, never run one."
- *Tell her now* (the menu item): "She reads it before her next step. It can't answer an approval card:
  use Allow or Deny for that."
- *Just asking* (the menu item): "A quick answer on the side from what's in this chat. It isn't saved
  and she doesn't stop working."

### 5.12 Done when (`test/phase116.test.ts`, plus the existing suites green)

With a **fake model** (a provider that plays a script of steps and records every `messages` array it
is given) and fake tools registered in a test registry:
- **Loop guard, the main test:** the fake model calls `shell {command: "npm run buidl"}` at steps 1–4;
  the fake shell returns `[exit code 1]\nnpm ERR! Missing script: "buidl"` with a different timestamp
  each time. The tool runs **exactly 3 times**; the 4th call gets status `denied` with "Blocked by
  Sara's loop guard" and the error line; **no approval event** is emitted for it; one `loop_guard`
  event; the messages sent at step 5 contain the app note once. The script then calls `shell
  {command: "npm run build"}` (ok) and answers: the turn ends `done`, and the run record's step 4 has
  `guard.kind = 'loop'`.
- **Not identical:** three failures with three different commands → none blocked. Same command, three
  *different* errors → not blocked. Fail, fail, succeed, fail, fail → not blocked (success resets).
- **Declined twice:** the same `ask` call denied twice → the third attempt is refused without a card.
- **Ignoring the block:** three more blocked attempts → tools are off for the rest of the turn and the
  fake model's next call is offered no tools.
- **Owner steer resets:** after a block, an owner steer clears it; the same call may run again.
- **Replay:** replaying the recorded run blocks at the same step.
- **Steer at the safe point:** a fake tool that waits on a latch; a steer is posted while it runs →
  the step-1 model call doesn't contain it, the step-2 call does (after the tool result, before the
  next model call), with the app note; it is stored with `meta.steer`; a `steer` event is emitted.
- **Steer can't approve:** with an approval waiting, a steer "yes do it" changes nothing about the
  approval (still waiting), and is taken only after Allow/Deny.
- **Steer after the last step:** a steer sent while the final answer streams becomes the next queued
  turn (`moved`) and is answered after it.
- **Steer safety:** a steer that trips `minorSexualMatch` stops the work at the safe point and the
  reply is `MINOR_BLOCK_REPLY`; a crisis steer turns tools off for the rest of the turn and the next
  call carries `CRISIS_SYSTEM_NOTE`.
- **Queue:** two messages posted while busy run as two turns in order after the current one; neither
  appears in the running turn's model calls; `queueMax` + 1 is refused with the line; `/reset` drops
  waiting items and says how many.
- **Who:** a partner's message while busy is always queued (never steered); `/steer` from a partner is
  refused; a bot runs none of the commands.
- **Restart:** waiting rows become `stale` at start-up and **don't run**; the bridge owner gets the one
  line.
- **`/btw`:** answered while a turn runs (the turn's latch still holds); the conversation's message
  count, memory and title are unchanged afterwards; one usage row with purpose `btw`; the cap returns
  429; in a private conversation only a local route is used; a crisis question gets the resources.
- **Bridges:** fake Telegram: a plain owner message during a turn → steer + `setMessageReaction`; a
  partner's → queued with "I'll do this next"; `/btw` → a reply starting "💬"; fake Discord: the slash
  command `/btw` → type 5 then an ephemeral edit; `/steer` registered with a `text` option in the bulk
  overwrite. Plugin bridge: a message while busy is **queued and answered** (no longer
  `{reason:'busy'}`).
- **Old clients:** `POST /messages` without `whileBusy` while busy → 409, unchanged.
- **Safety unchanged:** the disclosure still comes first in a new partner chat; a steer never counts as
  "the owner spoke" for the bot guard or for `lastOwnerMessageAt` twice; commands still never reach a
  model.

### 5.13 Owner to-dos

On a real coding task from the web app: start a long job, then type "use pnpm, not npm" and check
she picks it up at the next step; queue "then update the README"; ask `/btw what does that error
mean?` mid-run. Do the same from Telegram and Discord on the phone (the 👀 reaction, the `/btw` reply).
On a local-model setup, check how long a side question waits while she works and pick *Side questions
use* accordingly. Decide §11 Q7–Q10.

---

## 6. Safety and privacy across the track

### 6.1 The mandatory layer is untouched

No setting in this track can turn off the disclosure, honesty, crisis resources or the minors block.
New inputs (pictures, captions, steers, side questions, plugin files) get the same checks as a
message; new outputs (captions, side answers, progress lines, files she shares) are scrubbed and
checked before they leave. The tool registry's approvals stay mandatory: nothing in BR2 can approve,
deny or skip a card, and the loop guard can only refuse a call.

### 6.2 Partners and groups

- **Files from others are treated like their messages.** A picture from a partner or a room member
  goes into *their* conversation with *their* rules: no tools, no memory, nothing private, no adult
  content unless the channel is an adult one, the AI notice first. Their documents are still refused.
- **No tools from partner chats**, still: `send_file`, `take_photo` and moments are tools, so she
  sends no pictures or files there; a partner can't steer (always queued) or use `/btw`.
- **Pictures from others reach a model only when the owner allowed it for that place**, and then only
  as a fenced description from describe-first (§4.5). The talking model never gets their picture.
- **Nothing private goes into rooms:** her screenshots never; `send_file` asks first in a work room;
  the progress message is off in rooms unless the owner turns on *Also rooms where I work with her*,
  and even then it shows only verbs.
- **Keep-up (CH4) is unchanged:** room pictures stay `[photo]` marks in the room log; they are never
  downloaded, described or summarised.

### 6.3 The turn-start checks on paths that don't start a turn

Steers and side questions are not turns, so `runTurn`'s first checks are factored into one function
(`preflight(app, conv, text, who)`, in `src/chat.ts` next to where they run today) and called on:
a steer at the safe point, a `/btw` question, and a picture caption (which is already the message, so
it gets them anyway). It runs `minorSexualMatch` (a hit: the work stops at the safe point and the reply
is `MINOR_BLOCK_REPLY`; for `/btw`, the answer is that line), `detectCrisis` (a hit: tools off for the
rest of the turn and `CRISIS_SYSTEM_NOTE`, so she answers the person now; for `/btw`, the crisis
resources), and the explicit-content rule of the place (`detectExplicit` with `adultOn` and the
channel). Queued messages are normal turns and get the normal checks when they start.

### 6.4 Pictures go to a model only when it's allowed

- The vision route and `sees()` decide which model gets a picture (today's rule); the ? tips on
  *Pictures and files* name the model that will see them.
- **Private conversations: local models only** (and a note instead of a cloud vision model, §4.5).
  Her pictures and files are **never sent out** of a private conversation to a chat app: B1 refuses
  them and says "This chat is private, so I kept that in the app."
- **Private local mode** pauses Telegram and Discord (today) and limits plugin bridges and describe-first
  to models on this computer.
- Describe-first calls and `/btw` go through `cheapCall`, which already enforces both rules.

### 6.5 Minors and secrets checks on files

- **No image classifier exists** in Sara (§1) and BR1 doesn't add a dependency for one. Pictures from
  others pass describe-first with its label check; the owner's own pictures are treated as in the web
  app (his choice, his model); every reply is checked as today. Captions, file names and text-like
  files she shares run through `minorSexualMatch`.
- **Secrets:** a file containing a vault secret is never sent; key-shaped text makes `send_file` ask,
  with the redacted line; files under `.secrets/`, `.env*`, keys and the data folder are refused by
  path. Incoming documents are unchanged (the library reads them; tool output that quotes them is
  scrubbed as today).

### 6.6 Quotas and money

New model calls: describe-first (50 pictures from others a day, `cheapCall`, its own ledger source)
and `/btw` (60 a day by default). Nothing scheduled is added, nothing runs after a restart by itself,
and the progress message and the loop guard cost nothing (code only). The daily picture and file
quotas (§4.7) protect the disk and the platforms. Settings → Usage shows *Side questions* and
*Picture descriptions* as their own purposes.

### 6.7 Storage and cleanup

Pictures in the upload folder (deleted with their conversation; other people's after 7 days), copies
of shared files 30 days, `shared_files` rows a year, `pending_inputs` 7 days after they're done, and
no storage at all for side answers. *Forget this room* and deleting a conversation remove its pictures,
files and pending items. Everything is in the data folder and so in backups.

### 6.8 Threat model additions (`docs/THREAT_MODEL.md` in each release)

A picture with instructions written in it (others: only a fenced description, no tools; owner: as in
the web app today); a flood of pictures or `/btw` to burn the budget (quotas and daily caps); someone
posing as the owner to steer (owner = platform user id, as today; partners can't steer); a steer that
tries to approve ("yes, allow it": approvals are button presses only); a plugin sending huge or fake
files (chunk caps, magic check, the `bridgeFiles` permission, its log); a progress message leaking a
secret (verbs only, redacted, tested); a model stuck retrying a destructive command (the guard refuses
the 4th try before any approval card).

---

## 7. Household isolation

- **Bridges stay the owner's.** Telegram, Discord and plugin bridges run only for the owner's main
  companion (`src/main.ts`), so `shared_files`, `bridge_progress`, pictures from chat apps and her
  shared files live only in its data. Members, other companions, the demo, `/v1`, MCP, A2A and
  webhooks never see them; `GET /api/files/:id` checks the conversation belongs to the caller's
  companion and person.
- **Steer, queue and `/btw` work for everyone in the web app**, each in their own `store.db`
  (`pending_inputs` is per companion data folder, like conversations). A member's steer can only reach
  that member's own turn; the server checks the conversation's owner on every route. A member's `/btw`
  uses the member's routes and is counted against the member's limits (`member` policy, checked before
  the call, as for any model call); the owner sees only the usage totals, as today.
- **The loop guard** runs inside every turn of every companion and member; its blocks live in the turn
  and the turn's own run record.
- **Plugins** are enabled per companion (`enabledFor`), so a plugin bridge's files go to that
  companion's own upload folder and library.

---

## 8. Reuse vs build

| Reused as is | Grown | New |
|---|---|---|
| `runTracked`, `{ images }` turn option, `buildHistory` image window, vision route, `sees`, `describeImage`, `resolveChain` local rules | `UploadStore.saveBytes`; `resolveChain`'s private + cloud vision case returns a note, not a throw | `src/bridges/media.ts` (B1) |
| `#download` (Telegram), multipart `FormData` sends (`sendVoice` on both) | Telegram `photo`/albums; Discord image attachments; `onEvent` handles `image`/`proof`/`file` | `send_file` tool |
| `#call`, `#rest`, `netFetch` | both go through a pacer with 429 / `retry_after` / buckets | `src/bridges/sendq.ts` (B2) |
| `web/steps.js` verbs, `web/i18n/*.json`, `src/i18n.ts` `tr`, `trackActivity` statuses | the pure verb table moves to `web/step-words.js` | `src/bridges/progress.ts` (B4), `bridge_progress` |
| CH1 command layer, `commandAllowed`, `BridgeAdapter`, Discord bulk overwrite, `setMyCommands` | `/steer`, `/queue`, `/btw`, `/progress`; adapter `steer`/`queue` | — |
| Bridges' `#queues`/`#waiting`/`#cleared` pattern, `app.stopTurn`, `active` map | lifted into one server queue; the 409 becomes 202 for clients that send `whileBusy` | `src/pending.ts` (B5), `pending_inputs` |
| The step loop's between-steps point, transient notes (`contradictNotes`), the run recorder | a `steer` step; `preflight` factored out of `runTurn`'s start | — |
| CH3 `cheapCall`, the daily ledger, `fenceLines`, usage purposes | sources `btw`, `photos:<chat>` | `src/btw.ts` (B6) |
| M10 `stepFailed`, `errorLine`, `normalizeMessage`, `sigOf`; the refusal chain; `plan.noTools` | the run record's tool step gets `guard` | `src/loop-guard.ts` (B7) |
| `takeChatDocument`, `KEY_SHAPED`, `vaultSecretValues`, `minorSexualMatch`, `MINOR_BLOCK_REPLY`, `CRISIS_SYSTEM_NOTE` | intake `origin` for plugin bridges fixed | — |
| Plugin `bridge.inbound`/`bridge.send`, the review card, the plugin log | `init.bridgeFeatures`, `ready.bridge`, `bridge.file`, `bridge.edit`, `permissions.bridgeFiles`; busy → queued | — |

Nothing in this track needs an npm package. Every Telegram and Discord call is plain JSON or
multipart over `netFetch`, like the bridges' current calls.

---

## 9. Risks

1. **Provider message shapes.** A steer puts a user line right after tool results. OpenAI-style APIs
   accept that; Anthropic-style APIs want tool results and the next user text in one user turn.
   *Mitigation:* each provider adapter's message builder gets a test with the steer shape, and the
   Anthropic adapter merges the steer into the tool-results turn.
2. **Platform limits drift.** Discord's default upload limit has changed over the years (the docs read
   say 20 MiB), servers with boosts allow more, and the files-per-message number wasn't on the pages
   read. *Mitigation:* caps are constants in B1, a refused upload (413 / "entity too large") gives the
   owner a plain line and the text still goes, and the sources are listed (§13).
3. **Rate limits in busy groups.** Progress edits and replies share Telegram's 20-a-minute group cap.
   *Mitigation:* progress is off in rooms by default, B2 puts replies first, the 6-second group
   interval, and progress switches itself off after three failed edits.
4. **Other people's pictures.** Describe-first still sends their picture to the owner's picture model,
   which may be a cloud service. *Mitigation:* off by default, the tip names the model, a local
   vision model works too, bytes deleted after 7 days.
5. **Pictures as prompt injection** (text in a screenshot). *Mitigation:* other people's pictures are
   fenced descriptions with no tools; the owner's own pictures behave as in the web app today (the
   approval system still guards every action).
6. **Old clients and the 409.** The phone and desktop apps get the new behaviour only when they update.
   *Mitigation:* the server keeps the 409 for clients that don't send `whileBusy`, so nothing breaks;
   the store releases follow 2.49.0.
7. **Steer timing surprises.** Someone types "stop, wrong folder" as a steer during a 5-minute test run.
   *Mitigation:* the chip says when she'll read it; Stop stays next to Send; the tip says to use Stop
   for "stop now".
8. **Side questions on one-slot local models** wait for the turn's model call. *Mitigation:* a quick
   model choice, a 60 s timeout with a plain line, the tip.
9. **Loop-guard false positives.** A legitimate "run it again" (waiting for a server to come up) is
   blocked on the third identical failure. *Mitigation:* she can change the call (add a wait), she is
   told to ask; an owner steer clears the block; the next turn starts clean.
10. **Queued messages lost on restart.** *Mitigation:* rows survive as `stale`, are shown, and the
    bridge owner is told; nothing auto-runs.
11. **No image classifier for the minors block on pictures.** *Mitigation:* describe-first's label for
    other people's pictures, the reply checks, caption checks; listed as a known limit in
    THREAT_MODEL, not hidden.

---

## 10. Phases at a glance (one release each, in order, after Phase 114)

Each release ships its docs in the same commit: the bridge sections of the user guides (docs/CHATS.md,
docs/PLUGINS.md for BR1), `web/help.html`, CHANGELOG, ROADMAP / ROADMAP.public, i18n in six languages,
? tips, THREAT_MODEL, and the README "What's new" row.

| Phase | Version | Slice | Main new code | Test |
|---|---|---|---|---|
| 115 BR1 | 2.48.0 | photos in (both bridges, albums, describe-first for others), pictures and files out (`send_file`), quotas and cleanup, the live progress message with Stop and a final state, plugin contract v1.1 | B1 `media.ts`, B2 `sendq.ts`, B3 `web/step-words.js`, B4 `progress.ts`, `shared_files`, `bridge_progress` | `test/phase115.test.ts` |
| 116 BR2 | 2.49.0 | steer at the safe point, one queue everywhere, `/btw`, the split Send button and chips, the commands on both bridges and plugins, the tool-loop guard | B5 `pending.ts`, B6 `btw.ts`, B7 `loop-guard.ts`, `pending_inputs`, `preflight` | `test/phase116.test.ts` |

BR2 uses BR1's progress message (for "📝 Got your note" and "🔁") and pacer, but works without them
(the web app and plugin bridges without `edit`). Each phase can be built and tested in one helper run.

---

## 11. Blocking questions (with the defaults the parent applies if the owner is away)

1. **Pictures from other people** (partner DMs, rooms). Default: **off**; when the owner turns it on
   (globally or per room), **describe-first** through the picture model, only the fenced description
   reaches her, their picture bytes kept **7 days**. Alternative: the talking model sees their pictures
   directly, like his own (simpler, but their pictures and any text in them reach her unfiltered).
2. **The progress message when she's done.** Default: **it becomes one summary line** ("✅ Done · 6
   steps · 1:12") **above her answer, which is sent as new messages** (so the phone notifies).
   Alternative: delete it when the answer arrives; or edit it into the answer itself (the pitch's
   wording, but no notification and no room for pictures or long replies).
3. **Progress in rooms where he works with her.** Default: **private chats only**; rooms are an opt-in
   (*Also rooms where I work with her*). Partner chats and rooms she only talks in: never.
4. **When the progress message appears.** Default: **after 10 seconds** of a turn (pick-list 5 / 10 /
   20 / 30).
5. **`send_file` permission.** Default: **runs on its own in his private chats**, **asks first** in a
   work room, over 5 MB, or when the secret check finds a key-shaped string; a vault secret is always
   refused. Alternative: always ask.
6. **Her screenshots (`proof`) to chat apps.** Default: **off**; when on, only to his private chat.
7. **What a plain message does while she works.** Default: **steer** (*Tell her now*), for the owner
   and members; partners always queue. Alternative: queue by default (the bridges' behaviour today).
8. **The model for `/btw`.** Default: **the quick-replies route** (he asked, so it isn't unasked
   spend), local only in private chats and private local mode, 60 a day. Alternative: local first, as
   CH3's titles (cheaper, but slower and weaker on "what does this error mean").
9. **Queued messages after a restart.** Default: **don't run them**; show them as *stale* with *Send
   now* / *Remove* and tell the bridge owner once. Alternative: run them in order after start-up.
10. **The loop guard's reach.** Default: **3 identical failures the same way, per turn**; an owner steer
    clears it; a new turn (including *Continue*) starts clean; not configurable. Alternative: carry a
    block into a *Continue* turn started within 30 minutes (stricter; the model often retries the same
    command after "continue").
11. **Telegram's streaming drafts** (`sendMessageDraft`, private chats, 30-second previews, a stop
    button since Bot API 10.3). Default: **not used in v1** (the progress message must last and must
    work in groups); a later option for streaming her words in private chats.
12. **Files in the plugin contract.** Default: **chunked `bridge.file` messages (≤ 512 KB) behind a
    `bridgeFiles` permission and the plugin's opt-in in `ready`**, so the 1 MB line cap stays.
    Alternative: raise the line cap for bridge plugins (simpler, but every plugin gets the bigger cap).
13. **Older phone and desktop apps.** Default: **keep the 409 for clients that don't send `whileBusy`**
    until they update. Alternative: apply the default (steer) for every client at once (they would see
    an unknown 202 and may show an error).

---

## 12. Key choices in short

- **One path for pictures:** chat-app photos become `meta.images` on the user message and ride the
  web app's existing vision path; her pictures leave through the `image` event the bridges now listen
  to. The only new tool is `send_file`.
- **Other people's pictures are off by default** and, when on, reach her only as a fenced description
  (describe-first); partners still get no tools, no documents and no pictures from her.
- **The progress message is one message, edited in place** through a pacer that puts her answer first,
  shows only the web step line's verbs (no output, no arguments, no secrets), has a Stop button, ends
  in a one-line final state, and is switched per chat app, per room and per chat (`/progress`).
- **Steer = stored at the next safe point** (between steps, never inside a tool call or over an
  approval); it can't approve anything; if she has already finished it becomes the next turn.
- **One server queue** for web, Telegram, Discord and plugin bridges (no more 409 for new clients, no
  more dropped plugin messages); queued messages are not stored until their turn, and nothing runs by
  itself after a restart.
- **`/btw` stores nothing**, has no tools, runs beside the work through `cheapCall` with a daily cap.
- **The loop guard** reuses M10's failure signatures: 3 identical calls failing the same way → blocked
  for the turn before any card, a note to change approach, tools off if she keeps trying.
- **Additive tables only** (`shared_files`, `bridge_progress`, `pending_inputs`), zero npm runtime
  dependencies, the mandatory safety layer on every new path.

---

## 13. Sources

Official documentation read on 2026-11-01:

- [T1] Telegram, *Bot API*: `getFile` ("the maximum file size to download is 20 MB"), *Sending files*
  ("10 MB max size for photos, 50 MB for other files"), `sendPhoto` (≤ 10 MB, width + height ≤ 10000,
  ratio ≤ 20), `sendDocument` (≤ 50 MB), `sendMediaGroup` (2–10 items), `PhotoSize`, captions 0–1024
  and text 1–4096 characters, `editMessageText`, `setMessageReaction`, `sendMessageDraft` ("a
  temporary 30-second preview", private chats, `can_stop`/`keep_on_stop`), `MessageGenerationStopped`
  / `stopped_message_generation` (Bot API 10.3, 2026-08-24). https://core.telegram.org/bots/api
- [T2] Telegram, *Bots FAQ*, "My bot is hitting limits": "more than one message per second" in a
  chat, "20 messages per minute" in a group, about 30 messages a second overall, 429 errors.
  https://core.telegram.org/bots/faq
- [D1] Discord Developer Documentation, *Reference*, *Uploading Files* ("the default limit is 20 MiB
  for all users, but may be higher" with Nitro or boosts; `files[n]`, `payload_json`, `attachments`,
  `attachment://`), *Editing Message Attachments*, signed CDN URLs (`ex`, `is`, `hm`).
  https://docs.discord.com/developers/reference
- [D2] Discord Developer Documentation, *Message Resource*: Create Message (`content` up to 2000
  characters, `files[n]`, attachment `description` ≤ 1024), Edit Message (author edits `content`,
  `components`), reactions. https://docs.discord.com/developers/resources/message
- [D3] Discord Developer Documentation, *Rate Limits*: per-route limits and `X-RateLimit-*` headers,
  `X-RateLimit-Bucket`, 429 with `retry_after` and `global`, "50 requests per second", the invalid
  request limit (10,000 per 10 minutes). https://docs.discord.com/developers/topics/rate-limits
- Discord interactions (3-second first response, 15-minute token, type 5, flag 64): as read for CHATS
  §2.1 [D2 there].

Sara code read for §1: `src/bridges/telegram.ts`, `discord.ts`, `commands.ts`, `room.ts`, `keepup.ts`;
`src/chat.ts` (`ChatEvent`, `MAX_STEPS`, `buildHistory`, the vision job and `sees`, `describeImage`,
`resolveChain`, the step loop, the refusal chain, `tool.run` context, the step cap), `src/server.ts`
(`savePhotos`, `runTracked`, `app.stopTurn`, `requestApproval`, `streamChat`, the send route),
`src/uploads.ts`, `src/library/intake.ts`, `src/photos.ts`, `src/moments.ts` (`attachImage`),
`src/triggers.ts` (`stepFailed`, `errorLine`, `normalizeMessage`, `sigOf`, `signaturesOf`),
`src/budget.ts` (turn budgets, `HARD_STEP_CAP`), `src/cheap.ts`, `src/safety.ts`, `src/redact.ts`,
`src/plugins/manager.ts` (`#bridgeInbound`), `src/main.ts` (members, housekeeping timers),
`web/app.js` (`setComposerBusy`, the composer submit, `runStream`), `web/steps.js` (`stepWords`); docs
`ROADMAP.md` (Phases 115–116), `design/GAP_REVIEW.md` (#1, #2, #4, #10), `design/CHATS.md`,
`PLUGINS.md` (§6, §8).
