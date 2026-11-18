# Messages between linked servers (S9a)

Roadmap: [ROADMAP_S.md § S9](design/ROADMAP_S.md). Private instant messages between the **people** who
own two or more Sara servers: one-to-one chats and communities (small groups). **The agents are not
involved**: Sara never reads them, and they never reach her memory, her chats, a model, a tool, search,
memory exports or logs. Owner only (household members and kid mode never; not on the demo).

## Using it

- **Messages** in the sidebar (under More until pinned). An unread count shows there for one-to-one
  messages and for community messages that @mention you (More shows a dot while Messages is inside it),
  and the tab title starts with "(n) "; phones get a push notification, the installed app's badge counts
  them, and the desktop app a toast (muted chats stay quiet).
- **New message notice (MSGPOP, replaces the T4 corner popup)**: a card at the top centre of the window,
  in front of whatever is open (Today, Settings, a chat): the friend's initial, "New message from Hank",
  two lines of the message, **Open** and **Later**. It stays until you press one of them or open that
  chat, never takes the keyboard focus and is read out politely by screen readers. Several people: one
  card, "New messages from Hank and 2 others", with the unread count; Open then shows the Messages list.
  It also appears for unread messages that came while the page was closed, the window was minimized or
  the connection dropped (on load, when the window comes back, after a reconnect). Later is remembered
  per message on this browser, so it doesn't nag; a newer message from the same person shows it again.
  A soft sound can play with it (off by default). Both are in *Messages settings*.
- **Communities are quieter (T4)**: no push and no popup by default. Their new messages show as a small
  grey count next to **Communities** in the chat list (never the sidebar dot). A message that mentions
  you (`@YourName` or `@FirstName`) notifies like a one-to-one message. Per community, *Options →
  Notify me*: **Everything**, **When I'm mentioned** (the default) or **Nothing**; the default for all
  communities is *Messages settings → Communities notify me*.
- **Link a server**: makes a one-time code (`sara-msg:…`). The code works once, for 30 minutes. Once
  you're linked, you stay linked until either of you unlinks (*Options → Unlink*); each one-to-one chat shows
  *Linked since* and the date. Send the code to the other owner; they press **Paste a code**.
- **New community**: your server hosts it. Its code (in *Options*) lets anyone who has it join. You,
  and the moderators you name, can remove or ban a member and make a new code (the old one stops
  working for newcomers). **Message privately** on a member asks them for a one-to-one chat; it starts
  when they accept.
- In a chat: pictures (JPEG, PNG, WebP, GIF), PDF and text files up to 5 MB; **Edit** and **Delete**
  your own messages (the change reaches the other side); **Report** a community message to its creator;
  **Mute**, **Block** (one-to-one), **Leave**; *Keep messages* per chat.
- **Ask Sara about this** under a message is the only way one reaches her: a new chat opens with the
  quoted text in the box, and nothing is sent until you send it.
- *Messages settings*: keep messages for N days (30 by default, 0 = always), read receipts and typing
  (on by default; off means you send none), your name for others, this server's address.
- Unlinking or leaving asks whether to keep the history on this server; an ended chat can be removed
  later.

## Design (one page)

| | |
|---|---|
| Code | `src/messages.ts` (Messenger), `src/routes/messages.ts` (owner API), `web/messages.js` (page). Mounted in `src/server.ts` (`/msg/v1/*`, never for members or the demo), made in `src/main.ts` for the owner's companions only. |
| Storage | Its own database `<data>/messages.db` (never `sara.db`, so no search index, memory or export reads it). Bodies, files (`<data>/messages-files/`), queued envelopes, community codes and intro codes are sealed with the vault key (AES-256-GCM, `vault.seal`). Link private keys are vault entries `pm:link:<id>`. |
| Link | A one-time code carries the server address and a random token (stored as its SHA-256, single use, 30 min). The joiner makes an Ed25519 key pair and POSTs `{token, url, key, name}` to `/msg/v1/link`; the other side checks the token, makes its own pair and answers `{link, key, name}`. Each link has its own keys. |
| Wire | `POST /msg/v1/inbox`, JSON, headers `sara-msg-link`, `sara-msg-time`, `sara-msg-sig` = Ed25519 over `link \n time \n sha256(body)` (node:crypto). Refused: unknown link, bad signature, a time more than 5 min off (401); a replayed event id (409); more than 240 events a minute per link (429). |
| Addresses | https, or http only on loopback, the home network or Tailscale (already encrypted). Through `netFetch`, so private local mode blocks it like any outbound call. No third-party relay, no redirects. |
| Delivery | Every event goes through an outbox (sealed): sent at once, then retried on the reminder tick after 1 min, 5 min, 30 min, 2 h and every 6 h, in order per link, for 7 days (then *not sent*). Typing and read receipts are sent once, never retried. |
| Events | One-to-one: `dm`, `edit`, `del`, `read`, `typing`, `unlink`. Community member → host: `c.post`, `c.edit`, `c.del`, `c.typing`, `c.leave`, `c.report`, `c.mod` (kick, ban, code), `c.intro`. Host → member: `c.msg`, `c.edit`, `c.del`, `c.typing`, `c.roster`, `c.code`, `c.intro`, `c.removed`, `c.closed`. Edits and deletes apply only to the author's own messages. |
| Communities | Hosted by the creator's server, which fans each post out to every member over its link with them (up to 50 members). Roles: host, mod, member. A moderator's kick/ban/new code is checked by the host. A ban stores the member server's address: the host refuses its joins with any code, and its link is deleted. |
| Retention | Per person (setting) and per chat (*Keep messages*), 30 days by default; purged on the reminder tick, files too. Each side keeps its own copy for its own time. |
| Unlink | The other side is told (`unlink`, `c.leave`, `c.removed`, `c.closed`), then both delete the link's keys; the history stays or goes as each person chooses. |
| Notifications | `notifyRoute` (T4) decides per new message: `full` (one-to-one; a community set to *Everything*; a community @mention of the owner's Messages name or its first word, `isMention`), `quiet` (other community messages: only the count inside Messages) or `none` (muted, blocked, *Nothing*). `full` → `onNotify` → web push to the owner's devices (the body only when *previews* are on) and the SSE event `{type:'pm', chat, notice:true}` (ids only) → the page's notice card (MSGPOP: `web/msg-notice.js` decides from the chat list's `lastIn`, the newest incoming message id, and a `sara.msgs.shown` localStorage list of shown `chat:message` keys; swept on load, `visibilitychange`, the event stream's `open` and every `pm` change) and desktop toast. The app badge (`/api/phone/badge`, push) adds `Messenger.unread()`. Mentions are flagged on the stored row (`pm_messages.mention`); `GET /api/messages` returns `unread` (sidebar badge = one-to-one unread + unread mentions) and `community` (the quiet count; communities on *Nothing* excluded). Settings `popup` (on), `sound` (off), `communityNotify` (`mentions`); per chat `pm_chats.notify` (null = the default). |
| Isolation | No model tool, no memory write, no conversation row, no log line with content. `test/s9a-messages.test.ts` proves it: a turn after messaging has none of the words in the model request, memory, `sara.db` or console, there is no message tool, and only `main.ts` and `routes/messages.ts` import the module. |

## Support link (S9b)

The same link can carry a time-limited **help pass**: the other owner's Sara may then read a redacted
support report and suggest fixes that you approve one by one. See [SUPPORT_LINK.md](SUPPORT_LINK.md).
A **fix pass** (T5) goes further: the other owner's Sara sends a plan your Sara checks and runs herself,
with your OK. See [REMOTE_REPAIR.md](REMOTE_REPAIR.md).

## Find a time with a friend (V2.10)
- Open a one-to-one chat with a linked friend and press **Find a time with {name}**: say what it is,
  how long (15 min to 2 hours), when in the day (daytime 9–5, evening 5–9, any time 9–9) and how
  many days ahead. Or ask her in chat: "find a time with Sam for coffee next week".
- Your friend gets a card: **Share my free/busy** or **Not now**. Nothing is read from their calendar
  before they say yes.
- Only busy blocks cross (rounded to 15 minutes, all-day events left out): never titles, places or who
  else is there. Your own busy times never leave your server; your Sara works out the 3 times.
  Each person's part of the day is on their own clock, so a friend in another time zone is never
  offered a time in their night.
- Both of you tap the time that suits you. When you both picked the same one it is agreed and goes in
  both planners as a to-do at that time ("Coffee with Sam"). Either of you can call it off.
- If the other server is offline, the button says so: try again later (there is no queue yet).
- Design: docs/design/V2SCHEDULE.md.

## Limits and gaps

- The hub is not used for discovery (optional in the roadmap): people exchange codes themselves.
- The joiner trusts the code's address over TLS; there is no key fingerprint in the code.
- A banned server could come back from a different address with a new code from someone else.
- Messages are end-to-end between servers, not between devices: each server can read its own copy
  (sealed at rest with its vault key).
- Read receipts are one-to-one only (communities show no receipts).
- A private-chat request from a community member carries their server's address; accepting it makes
  your server contact that address (a fixed link request, nothing else). Accept only people you know.
- S5 (*Ask your whole life*) must not index `messages.db`; it is outside `sara.db` on purpose.
