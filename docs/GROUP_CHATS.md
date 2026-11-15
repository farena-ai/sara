# Group chats

Since 1.6 (Phase 66) two to four of your companions can talk with you in one conversation, each in
her own voice and personality, taking turns sensibly. The safety layer works per companion and per
message, exactly as in a one-to-one chat.

## Starting one

With two companions or more, press **👥 Group** above your conversations. Give the chat a title,
pick who's in it (2 to 4, as cards), and choose:

| Setting | What it does |
|---|---|
| **Who answers** | **Whoever fits** (default): a cheap router step (your *Quick helpers* model, else the default) reads the last few lines and the members' one-line descriptions and picks one or two. **Everyone answers**: each member, in order. **Take turns**: one per message, round-robin. **@mention only**: who you name (`@Mia`, accents and capitals don't matter, names with spaces work); without a name, the router. In every style, naming someone with @ asks her. |
| **Banter** (0–2, default 0) | How many extra companion-to-companion replies may follow without you. A banter reply that has nothing to add answers `(pass)`, is taken back and ends the banter. |
| **Private** | Every member's copy is a private conversation: models on your own hardware only, no web or add-on tools. Set at creation. |

Who answers, banter and the title can be changed later (the ⋯ menu or the line under the title:
*Group chat settings*); they save as you change them. The members are fixed: start a new group chat
for a different line-up. If you make one from a companion who isn't in it, the app switches to the
first member.

Hard limits, whatever the settings: at most 4 direct replies plus 2 banter replies per owner
message (6 in all), one round at a time per room, and **Stop** ends the whole round.

## How each reply is made

Each reply is a normal turn of that companion (`runTurn` with the `group` option): **her own** model
and provider (her *companion model*, or your routes), personality, speech style, memories, mood and
the full safety block (`SAFETY_BOUNDARIES` is always in her instructions). She also gets a short
room line: who is in the chat, that the others are separate AI characters, how their lines are
labelled, and to write only her own reply.

The shared transcript reaches her with speaker labels: your lines as `[Alex]: …`, another
companion's as `[Mia, another AI companion]: …` (never as you, never as her own), her own lines as
her own. A reply that starts writing lines for others (`\nMia: …`) is cut there, and her own name
tag in front is removed.

Each bubble shows the companion's face (`/api/companions/<id>/face`: her own picture or look), name
and colour (1–4, by her place in the room). Replies stream one after the other; each starts with a
`speaker` event. With *Read her replies aloud* (🔈) on, each line is spoken in that companion's own voice (her Settings → Voice); this wasn't tried with a real voice engine on the dev PC (no local voice on Windows).

## Safety

- **AI notice**: shown once per companion when the room starts, and again for each after 3 hours,
  in your language. A new companion's own first-use notice still applies in her one-to-one chats.
- **Honesty**: each companion's instructions keep the rule to say she's an AI when sincerely asked.
- **Crisis**: a message from you that sounds like a crisis shows the crisis resources at once (988
  marked US-only, like everywhere); then every member answers, supportively, with no banter, whatever
  the turn style.
- **Minors**: a message that fails the minors check gets no replies at all (one refusal for the room,
  no model is asked). A companion's reply that fails it is replaced in every copy and ends the round.
- **Adult content** is allowed only when **every** companion in the room has Adult mode on (strictest
  wins); otherwise each gets the "Adult mode is off" note. Never in the demo.

## Tools

Group chats have **no write tools**. Only read-only tools are offered, and only when they run without
asking: `recall` (her past chats), `web_search` (not in private rooms) and `library`. Tools that need
your OK are left out, so no approval card appears in the middle of a round. Coding mode and the
coding agent stay in one-to-one chats.

## Memory: what each companion remembers

Every member keeps **her own copy** of the room in her own database (channel `group`, channelKey =
the room id), so each remembers only what was said in her presence, with her own memory pipeline:

- your lines are yours (facts about you come only from your own lines, quoted);
- her own lines are hers (things about herself come only from her own lines);
- the other companions' lines are stored as theirs (`meta.groupFrom`) and are never a fact about you
  or her; the summary starts with *In the group chat "…"*, so the note is tagged with the room.

Companions who aren't in the room have no copy and learn nothing from it. Her look-back (`recall`)
and "last time" lines name the other companion when quoting her. Deleting the chat deletes every
member's copy (and, if you tick it, what each learned there).

## Usage and cost

Every model call in a group chat (each reply and the router step) is recorded in that companion's
meter with purpose **group** (Settings → Privacy & system → Usage shows *Group chats*). Private rooms
use each companion's Private route.

## Other apps, phones, bridges

- **Other apps (MCP, the OpenAI-compatible `/v1`)**: group chats are excluded like private chats
  (`sharedWithApps` is false for channel `group`); their messages and the notes learned there never
  reach another app.
- **Phone apps**: the API returns group messages with speaker info: `GET /api/conversations/:id`
  has `group` (`id`, `title`, `turnStyle`, `banter`, `private`, `members[]` with `id`, `name`,
  `color`) and every reply's `meta.speaker` (`id`, `name`, `color`); another companion's line also has
  `meta.groupFrom`. Sending: `POST /api/conversations/:id/messages` streams the round (`speaker`,
  `token`, `notice`, `done`, `retract`, `group_done` events). The Android app doesn't show group chats
  yet.
- **Telegram and Discord**: group chats are web-only for this release.
- **Not in group chats yet**: photos and documents, regenerate / edit / continue, calls, background
  replies from a notification.

## The demo

The demo has no group chats (like companions and the other server features it leaves out): `/api/groups`
is refused there.

## API

| Route | |
|---|---|
| `GET /api/groups` | rooms with their members (`id`, `name`, `color`) and the turn styles |
| `POST /api/groups` | `{ title, members: [ids], turnStyle, banter, private }` → `{ room, conversationId, companion }` (`companion` set when the app should switch to that member) |
| `PATCH /api/groups/:id` | `{ title?, turnStyle?, banter? }` (renames every copy) |
| `GET /api/companions/:id/face` | that companion's picture, for bubbles |
| `POST /api/conversations/:id/stop` | stops the whole round (from any member's copy) |
| `DELETE /api/conversations/:id` | deletes every member's copy and the room (`?forget=1` also what each learned there) |
