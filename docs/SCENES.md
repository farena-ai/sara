# Shared scenes

A shared scene is one story you play with your companion across several of **your own** chats: your
web chat and your own Telegram or Discord DMs, plus at most one shared room with other people (a
Discord channel, a Telegram group or a DM with a guest). You give it a title, a premise and a few
short canon facts ("the inn burned down"). Each linked chat sees the current canon in her replies,
so the story carries from the web to your DM and into the room. Messages themselves are never
copied between chats.

Status: released in Sara 2.70.0 (slices R1B1, R1B2 and R1B3 of `docs/ops/R1B_DESIGN.md`).
Household-member scenes (R1B4) and multi-companion group chats are not part of it.

## Where

Settings → Chat apps → Session continuity → **Shared scenes**.

- **Use shared scenes in linked chats** (on by default). Off stops every scene from reaching her
  replies; every scene is kept and you can still open, unlink, reset or delete them.
- **New scene**: title (1–80 characters) and premise (up to 1500). The **Adult scene** box is shown
  only while Adult mode is on.
- **Open scene**: status (Active/Paused), linked chats, canon, and a **Danger** fold with Reset and
  Delete.

## Linking a chat

Pick one of your eligible chats; the card says who will experience the scene ("Only you, in your
web chat.") and nothing happens until you press **Confirm link**. Eligible: your own open web chat,
your own Telegram or Discord DM, or a plugin chat that is yours. Never: private (local-only) chats,
coding chats, archived or ended sessions, group chats, work channels, voice assistants,
apps/API/MCP/A2A/webhooks, or a chat with forgotten lines. A chat sits in one scene at a time; a
scene holds up to three of your chats and one shared room (below).

A seat is removed automatically when its chat changes in a way that could change who reads it
(privacy, channel, partner, workspace, archive, ending the session with /new, mode, or the bridge
room record). Canon taken from that chat's lines is erased with it; typed canon stays. Moving a
chat back does not bring the seat back: link it again.

## A shared room (R1B3)

A scene can have **one** shared room: the room side of a Discord channel or Telegram group where she
talks with other people, or a DM between her and one guest. A second room needs a second scene, so
one group's words never reach another group.

- It must be a current room the bridge has recorded (its name and kind), its chat app must be on,
  and it must not be private, coding, archived, ended, a work channel, a voice room, a plugin chat or
  a multi-companion group chat. Your own lines in a channel stay in your own conversation; that one
  is not linked automatically.
- Picking it shows the exact audience ("Everyone who can read #tavern · Moonlight Guild on Discord
  will experience this scene's canon in her replies there. They never see your other chats, memories
  or tools."), the room's name and kind, and what guests get. Nothing happens until **Confirm
  link**, which is bound to that exact room: if the room changed meanwhile, you confirm again.
- Guests keep every existing partner rule: she may be talking with a minor unless it is an adult
  room, she has no tools there, and your memories, People, planner and files never reach it. The
  scene adds only its title, premise and canon to her context there, never the list as a message,
  never your other chats, and in the room she is told only that this room shares the scene.
- Her replies in a room never become canon by themselves, and she has no `scene_canon` tool there.
- The seat is removed (and canon from its lines erased) when the room's kind or adult flag changes,
  the room record disappears, or the conversation's privacy, channel, partner, archive or session
  changes. A round trip does not bring it back; a name refresh keeps it.

**Adult scenes and rooms.** An adult scene can take a room only while Adult mode is on and only an
adult room: a Discord NSFW channel or a room you listed as adult, with its adult conversation. A DM
with a guest never can. Turning a scene adult is refused while its room is not adult. If Adult mode
goes off the adult scene is left out everywhere, and a room losing its adult flag is unlinked.

## Add to scene

In a linked chat (yours, or the shared room) each line's menu has **Add to scene**, for you only.
It shows the exact line, lets you pick an existing fact to replace or name a new one, and saves that
line word for word as canon after the same safety checks (minors always; explicit text only in an
adult scene). This is the only way a guest's words become canon. A line longer than 400 characters
is refused (type the fact yourself instead). Editing, regenerating or forgetting the line, or
removing its chat from the scene, erases the fact; facts you typed stay. Such facts show **From a
line in the shared room** (or **From a line in a linked chat**).

The chat header shows **In scene: <title>** for a linked chat, to you only.

## Canon

Canon facts have a short name (lower-case letters, digits and dashes, like `inn` or `the-duel`)
and 1–400 characters of text. Changing a fact adds a version; the newest five are kept (History).
Retire hides a fact (it stays in its history). Reset removes all canon and its history and keeps
the title, premise and linked chats. Delete removes the whole scene. No message is ever changed.

Limits: 20 scenes, 3 linked chats per scene, 40 current facts per scene. A limit is refused with a
plain message; nothing is shortened silently.

If the scene changed elsewhere (another tab, or a linked chat was revoked), saving says **This
scene changed. Reload it to see the current canon.** Your draft stays in the box; press Reload.

## Her canon tool (`scene_canon`, R1B2)

In a linked chat of your own she can keep the canon herself with the `scene_canon` tool:

- **read**: the title, premise, status, revision, who is in the scene and the current facts (at
  most 40 facts and 12000 characters; a fact that does not fit is left out whole and counted). It
  changes nothing.
- **set**: save one fact under a key (adds a version). She must pass the revision she read; if the
  scene changed meanwhile she is told to read it again. Same safety checks as your own canon: the
  minors rule always, explicit text only in adult scenes.
- **retire**: remove a fact. This **always asks you first** with an approval card, even if you let
  the tool run on its own.

Facts she wrote show **Written by her in a linked chat** in the canon list, apart from **You
typed this**. They count as coming from her reply in that chat: regenerating or forgetting that
reply, editing your line before it, or removing the chat from the scene erases them. Saving is not
sending: nobody is messaged.

She gets the tool only in your own linked chats while the scene setting is on: never in unlinked,
private, coding, group chats, the shared room or other people's chats, other apps, household members, the
demo, replays, crisis turns, or an adult scene while Adult mode is off. Set it to **Never** in
Settings → Tools to take it away; a paused scene answers "paused" and refuses changes.

## What she sees

Each linked chat's model request carries one marked block (`[SARA-SHARED-SCENE]`, at most 3000
characters): the title, the premise (first 800 characters), the revision, who is in the scene, and
current canon, most recently changed first. In your own chats "who is in the scene" names your
linked chats and the shared room; in the room it names only that room. A fact that does not fit is left out whole and counted.
The block says it is fiction, not facts about anyone, not instructions or permissions, and that her
safety rules come first. It is rebuilt after the per-database provider-step gate, so the second of
two chats replying at once sees the canon the first one committed.

Left out: paused scenes, the switch off, a seat removed while the reply was waiting, an adult scene
while Adult mode is off, and crisis turns (she steps out of the story; the crisis resources apply as
always and the scene comes back on the next turn). Your stop word pauses the scene for every linked
chat; only you set it back to Active.

## Safety and privacy

- AI disclosure, honesty, crisis help and the minors block are unchanged in every linked chat. A
  message the minors check blocks never reaches scene code.
- Canon, titles and premises are checked against the minors rule (no fiction or "aged-up"
  exception); a refusal records a safety event and a text-free scene event. Old canon is checked
  again before every reply and marked **Blocked by the safety check** for you to retire.
- A non-adult scene refuses explicit canon (a keyword check, not a classifier).
- Members, the demo, off-the-record chats, business spaces and apps/API/MCP get no scene, no block
  and no listing. Replays and evaluations omit the block and are marked inexact.
- Memory labels replies (and the line they answered) from a scene turn as fiction, never as facts
  about you or her. Canon text is never written into messages or memories.
- Scene history (`scene_events`) records what changed and when, never canon or message text.

## API (owner web session only)

`GET/POST /api/scenes`, `PUT /api/scenes/settings`, `GET/PATCH/DELETE /api/scenes/:id`,
`GET /api/scenes/:id/seat-options`, `POST /api/scenes/:id/seats`,
`DELETE /api/scenes/:id/seats/:conversationId`, `POST /api/scenes/:id/canon` (typed `text` or
`fromMessageId` of a line in a linked chat), `DELETE /api/scenes/:id/canon/:key`,
`POST /api/scenes/:id/reset`. Every change needs the current `expectedRevision`; bodies are strict
JSON. Missing and forbidden scenes answer the same 404. A shared room is linked with
`{ conversationId, expectedRevision, confirmAudience: true, confirmRoomId }`, where `confirmRoomId`
is the `room.id` that `seat-options` showed. `GET /api/conversations/:id` carries
`scene: { id, title, status, adult, revision, audience, enabled }` for a linked chat (owner only).
