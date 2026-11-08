# Chats in Telegram and Discord: commands

Sara answers you in Telegram and Discord the same way she does in the app (set up in **Settings →
Chat apps → Telegram / Discord**). Since 2.40.0 those chats have **commands**: a way to start fresh
when a chat is long or stuck, stop her, and see what she is using, without leaving the chat app.

## Owner-session continuity (in development, unreleased)

The development branch is adding ordered context between your own linked app and chat sessions.
A later eligible reply can use a previous committed reply and bounded historical context. The
session_context tool reads eligible history; session_handoff saves an internal context note for a
later model step. A saved note does not send a message, wake another model, grant permission or
prove that work was executed or checked.

Current-history edits while an eligible request is waiting stop that request before it reaches
the provider; refresh the conversation and send again. Private, off-record, other-person, shared
room, household and business audiences remain separate. Explicit shared roleplay scenes and
project coordination are later slices. The development candidate now has owner controls in
Settings → Chat apps → Session continuity and a saved-context inspector in This conversation.
See [Session continuity](SESSION_CONTINUITY.md) for disable/clear, retention and conflict handling.
Shared roleplay scenes across your own chats (development, unreleased): [Shared scenes](SCENES.md).
Complete qualification is pending; this feature is not in the current public or installed private release.

## The commands

| Command | What it does | Who may use it |
|---|---|---|
| `/new` | Starts a fresh session of this chat. The last one is kept (in the app's list, marked *ended*) and, for your own chats, summarised into her memory within a few minutes, so she still knows what you talked about. | You everywhere. Others in their own private chat with her (a clean start: their chats have no memory). |
| `/new room` | In a group or server channel where you work with her: also starts a fresh conversation for everyone else in the room. | Only you. |
| `/reset` | Clears a stuck reply without starting over: stops what she is doing, drops messages waiting for her, cancels her waiting Allow/Deny requests and makes her listen again. Nothing is deleted. | You. Others in their own private chat. |
| `/stop` | Stops her current reply (what she wrote so far is kept). Says nothing when she wasn't writing. | You. Others in their own private chat. |
| `/status` | For you: the model, how full this chat is, this session's age and messages, the last 24 hours of model use and the budget. For others: only "I'm Sara, an AI companion. This chat is N% full." | Everyone (others get the short one). |
| `/help` | The commands this person may use here, in their language. | Everyone. |
| `/model` | Shows the models you can pick (buttons in Telegram, a list in Discord); `/model name` picks one, `/model default` goes back to your default. Only this session changes. | Only you. |
| `/remember text` | Saves a note in her memory, in your own words. It follows the permission for her `remember_fact` tool (allowed by default; set it to *ask* and you get Allow/Deny first). | Only you. Never in other people's chats ("I don't keep memories in this chat."). |
| `/start` | Telegram: `/start CODE` links you (as before); a plain `/start` from you is `/help`. | — |
| `/settings` | Telegram: where her settings are. | Only you. |
| `/when` | (2.52.0) "When it comes up" reminders. `/when Dan: he owes me $20` sets one (a single capitalised word is a person on your People cards; anything else is words to watch for; `, every time` at the end makes it repeat). `/when` lists them with numbers; `/when forget 1`, `/when again 1`, `/when off`, `/when on`. Typed only (not in the `/` menu). In a work room the answer comes privately. Full guide: [WHEN.md](WHEN.md). | Only you, in your own chats. For anyone else it stays a normal message. Never reaches a model. |
| `/continue` | (2.52.0) Picks up your latest conversation from another of your own chats (the app, Telegram, Discord): `/continue` takes the newest (or lists them when there are several), `/continue 2` takes one from the list, `/continue telegram` / `/continue app` by app, `/continue off` undoes it. Nothing is copied: she is given that chat's summary and last few exchanges for each reply here. In the `/` menu. | Only you, in your own private chats. Never in shared rooms or other people's chats. Never reaches a model. |
| `/problems` | (2.53.0) The latest type errors in this chat's project, from Sara's checks after her edits (≤ 10 lines). `/problems check` runs a check now; `/problems off` / `/problems on` sets the project's choice. `/help refs` lists the `@file:` / `@diff` / `@url:` forms you can type. Full guide: [CHECKS.md](CHECKS.md). | Only you, in your own chats and work rooms. Never reaches a model. |
| `/compact` | (2.56.0) Tidies the older part of this chat: it is folded into a short summary she reads instead, and your last turns stay word for word. The summary is written by a model on this computer first (private chats: only there, or a plain list made by the app). `/compact keep the API part` says what to keep in particular; `/compact show` sends the summary; `/compact undo` (or *Undo* under the reply in Telegram and Discord) puts everything back. In the menus, next to `/new`. Full guide: [TOOLS_AND_COMPACT.md](TOOLS_AND_COMPACT.md). | Only you, in your own chats and work sessions. Never in other people's chats or shared rooms. |
| `/tools` | (2.56.0) Which tools she is sent in this chat and what she can look up (no model call). `/tools all` sends every tool here until `/tools lean`; `/tools +github` always offers a tool, group or MCP server here, `/tools -github` stops. Typed only. | Only you, in your own chats and work sessions. |

**Ways to write them**

- From the `/` menu in Telegram and Discord (see *Menus* below).
- Typed: `/new`, `!new`, and in a Telegram group `/new@HerBot`. A command for another bot
  (`/new@otherbot`) is left alone. In a Discord server channel, typed commands need an @mention
  (`@Sara /status`); in a DM they work as they are. Unknown words like `/shrug` stay normal messages.
- **Her name and one word** (switch *Her name works as a command*, on by default): `Sara new`,
  `Sara, stop`, `@Sara status`. Only a message with nothing else in it counts, so "Sara, new idea for
  the garden…" is a normal message, and "Sara, status?" (a question) too. The words work in her six
  languages (`neu`, `nouveau`, `nuevo`, `novo`, `nuovo`, …). `/remember` and `/model` need the slash.
- In the **app** you can type them in the message box too; they never go to her as a message. Since
  2.61.1 typing `/` at the start of the box opens the **`/` menu** (see *The `/` menu in the app* below). On a Telegram or Discord session, the
  conversation's settings (⚙) also have *Start a new session from here*, *Context used* and
  *Earlier sessions of this chat*.

## The `/` menu in the app (2.61.1)

Type `/` as the first character of the message box: a small list opens above it with every command you
may use in that chat and one line on what it does. ↑ ↓ move, Enter or Tab puts the command in the box
(with a space when it takes words), Enter again sends it, Escape closes the list; on a phone, tap a row.
Group chats, chats with someone else and off-the-record chats only list what works there; a household
member sees their own short list. `/goal` and `/loop` open the same cards as **+ → Keep going until it's
done…** and **+ → Repeat this…**. The table is generated from the same list the menu uses
(`APP_MENU` in `src/bridges/commands.ts`), so it can't drift:

<!-- appmenu:start -->
| Command | What it does | Who sees it in the app |
|---|---|---|
| `/goal` | Keep going until it’s done: a goal for this chat that only a check you pick can end | You, in your own chats |
| `/loop` | Repeat something in this chat on a timer, until a time or a condition | You, in your own chats |
| `/compact` | Tidy the older part of this chat into a summary (undo, show) | You, in your own chats |
| `/tools` | Which tools she has in this chat (all, lean, +name, -name) | You, in your own chats |
| `/when` | Reminders for when a person or topic comes up (list, add, forget) | You, in your own chats |
| `/continue` | Pick up our chat from your other app here | You, in your own chats |
| `/btw` | A quick side question while she works (not saved) | You and household members |
| `/queue` | Queue a message for when she has finished | You and household members |
| `/steer` | Tell her something now: she reads it before her next step | You and household members |
| `/stop` | Stop her current reply | You and household members |
| `/new` | Start a fresh session (the last one is kept) | You and household members |
| `/reset` | Clear a stuck reply and listen again | You and household members |
| `/status` | Model, how full this chat is, and budget | You and household members |
| `/model` | Pick the model for this session | You, in your own chats |
| `/remember` | Save a note in her memory | You, in your own chats |
| `/problems` | The latest type errors in this chat’s project (check, on, off) | You, in your own chats |
| `/help` | What you can do here | You and household members |
| `/bug` | Report a problem to the people who make Sara | You and household members |
| `/idea` | Suggest something to the people who make Sara | You and household members |
<!-- appmenu:end -->

**Who is who is checked by Sara every time.** The menus only decide what people see: Telegram and
Discord let anyone send any command, so Sara refuses owner-only commands from anyone who isn't you
(one short line, in their own language) and does nothing else. Bots never run commands.

## Picking a chat up in another app (2.52.0)

Start on Telegram on the bus, open the app at home, and she knows what you were just talking about.
Nothing is copied or merged: a small pointer says "this chat continues that one", and for each reply
she is given that chat's summary and its last exchanges (10 by default), rebuilt from the real
messages every turn. It ends by itself after 12 messages here or 24 hours.

- **In the app:** a new chat (or opening one) right after a conversation elsewhere shows a banner:
  *On Telegram 12 min ago: "…"* with **Continue here** / **Not now**. After you continue, a chip
  *↪ Continued from Telegram* sits at the top with **Show** (exactly what she is given) and **Undo**.
- **In Telegram and Discord:** under her first reply after you switch, a row asks *↪ Pick up our chat
  from the app?* with **Continue here** / **No**. Or type `/continue`.
- **Settings → Chat apps → Pick up across apps:** *Offer to pick up* (default), *Pick up on her own,
  with Undo* (a first line "↪ continued from Telegram · /continue off to undo"), or *Only when I type
  /continue*; how recent (3 h); how many exchanges; whether a fresh coding chat takes the folder along;
  which of your chats take part.
- Only between your own chats, checked at both ends every turn: never shared rooms, work channels,
  other people's chats, private or off-the-record chats, other apps (API, MCP, A2A) or household
  members. Forgetting a message or deleting the other chat wins at once.

## When a chat gets long

When a chat is almost too long for her to keep in mind (85 % of her history budget, or once older
parts already have to be left out), she **tidies the older part on her own** (2.56.0) before your next
message is answered: in Telegram and Discord you see *"(I tidied the older part of this chat to keep it
in view. /compact undo to put it back.)"* once. Your messages are never deleted; `/compact undo` puts
them back. With *Tidy long chats on their own* off (Settings → Models → Default model → Long
conversations), or after two failed tries, she says once per session instead: *"This chat is getting
long. Send /compact to tidy the older part, or /new for a fresh start."* Switch that note off with
*Offer a new session when a chat is long*. The number is the same as `/status` and the ring in the
app's header.

## Menus

With *Show commands in the app menu* on (default), Sara puts her commands in each app's `/` menu
whenever the bot connects, and only when the list changed:

- **Telegram:** your private chat (and each owner ID's) gets the full list; other people's private
  chats get `new reset stop status help` (or only `help` when others may not talk to her); groups get
  `help status`, and in each group where you work with her you see the full list. Each list is set in
  English (yours in your app language) and in Spanish, French, German, Portuguese and Italian, so
  people see it in their app's language.
- **Discord:** one list of seven commands for every server she is in and her DMs, with names and
  descriptions in the six languages. Everyone sees the menu; Sara refuses what isn't theirs.

The *Commands* card in Settings → Telegram and → Discord shows when the menu was last set (or why it
couldn't be), the list of commands with who may use each, and **Register menus now**.

### Owner to-do: register the menus on your real bots

1. Update Sara, then open **Settings → Chat apps → Telegram** and **→ Discord** and check that
   each card says *Menu set … ago*. If it says *Couldn't set the command menu*, press **Register
   menus now** and read the reason (usually the bot isn't connected).
2. **Telegram:** open the chat with your bot on your phone and type `/`: the list should appear.
   If it doesn't, close and reopen the chat (Telegram caches menus). In a group with privacy mode on,
   check that `/status@YourBot` and a plain `@YourBot hi` both reach her.
3. **Discord:** no new invite is needed (the `bot` scope already includes commands). New global
   commands can take a while to show in the apps; restart the Discord app if `/` doesn't list
   `new`, `status`… under her name yet.
4. Try `/new`, `/status` and `/model` once from your phone in both apps.

## Sessions

A chat app conversation used to be one endless conversation. Now each `/new` closes the current
session and opens the next one in the same project (your filing sticks). Messages from the chat app
always go to the newest open session. You can still read and write in an ended session from the app;
that doesn't reopen it for the chat app.

## A tidy list (2.41.0)

Each chat service gets its **own project** in the sidebar, with its icon: **Telegram**, **Discord**,
and one for each chat plugin (**WhatsApp**, **Signal**, **LINE**…: one project per plugin). Sara
creates it on the first message from that service and files every session from there into it by
herself. Your chats in the app (browser, desktop app, phone apps) stay in your own projects, and so
do the API, MCP, Home Assistant, Alexa, other agents, webhooks, group chats and imported history.

- **Name clash:** if you already have a project called *Telegram*, yours is left alone and hers is
  called *Telegram chats* (*Discord chats*, …).
- **Chats from before 2.41.0** are filed once, when Sara starts after the update: only chat app
  conversations that weren't in a project move; the ones you had filed yourself stay where they
  are. To undo it, open the project's page (▤) and press **Put back the N chats filed here**: exactly
  those go back to *No project* (chats that arrived later, and ones you moved since, stay put). It
  works once per project.
- **Your filing sticks:** move a session to another project and new messages keep landing in it;
  `/new` starts the next session of that chat in the same project.
- **Rename** a channel project from ⋯ next to its name or with *Edit* on its page. **Hide** it
  (⋯ → *Hide from the sidebar*, or *Show in the sidebar* off on its page): **Hidden projects (n)**
  at the bottom of the list brings it back, and search and the command palette still find its
  sessions. A channel project **can't be archived** (new sessions would disappear with it), and it
  **can be deleted only while that channel is off** (Settings → Connections, or the plugin);
  then its sessions move to *No project*.
- **Rows:** each session shows where it happens: *DM*, *#general · My Server*, *Book club (group)*,
  and *your work* for your own session in a group. Discord channels get their real names (asked
  from Discord at most once a day); old placeholder titles like *Discord channel 1234* are renamed
  to the room's name the next time someone writes there.
- **Group by room** (⋯ menu or the project's page, off by default): a heading for each server
  channel, group or direct chat, each with its own *See more*.

### See more

Every project, *No project* and *Archived* show the **newest 8 sessions**, then **See more (n)**;
each press adds 20, and **Show less** goes back. Pick 5, 8 or 10 in **Settings → You → About you →
Appearance → Sessions shown** (per device). The app only fetches the newest 200 of each list at
first, so a phone never draws thousands of rows; *See more* past that asks the server for the next
page. Search always looks through everything.

**Ended sessions sit under their chat:** after `/new`, the chat shows once (its open session), with a
small number next to it; press it to see the earlier sessions with their dates.

## Titles that grow (2.42.0)

A session starts with a placeholder: your first message in the app, or the chat's own name in
Telegram and Discord (*Telegram*, *Discord: #general · My Server*; a session opened with `/new` adds the
day, *Telegram · Oct 31*). Then she names it from what it actually covered:

- after 3 exchanges (6 messages) or about 1,500 characters, whichever comes first;
- when the talk clearly moves on: at most every 20 new messages a word check (no model, six
  languages) compares the title with the last 20 messages, and only when under 15 % of its words are
  still in use does she ask the model, which may answer that the title still fits;
- at `/new`, for the session being closed, when it had 6 new messages since its last title.

Each title is one short call to a model on this computer (*Settings → You → About you → Session
titles → Model for titles*: *This computer* or *Quick helpers*), at most 60 a day (*Titles a day*,
10–200). Private chats only ever use this computer; with no model there, the placeholder stays.
With no model at all, a Telegram or Discord placeholder gets a few plain topic words once.

A title you type is never changed. *This conversation* (the ⚙ in the chat's header) shows the title,
who named it and its earlier titles with their dates: *Use this title* or *Keep this title* makes it
yours, *Let her name it again* hands it back, *Name it now* asks her straight away. Titles stay
neutral: no names of other people in shared chats, nothing intimate, no health details, no secrets;
a title that fails these checks is dropped and the old one kept (a first message that itself says too
much becomes *A personal conversation*). Off-the-record, imported, group, webhook, A2A and other apps'
chats keep their titles.

Owner to-do: run `node scripts/eval-titles.ts --model <your local model>` (and on your quick model,
with `--route quick --ollama <its address>`), then pick the model for titles; after a week, say if the
titles are too long or too formal.

### Owner to-do

After updating, look at the sidebar on your phone and on the desktop: check the Telegram and
Discord projects hold what you expect, and use *Put back* if you'd rather have the old list. Pick the
page size you like (5 / 8 / 10). When WhatsApp or Signal plugins arrive, say if you'd rather have
one shared *Chats* project instead of one each.

## Talking to her while she works (2.49.0)

You don't have to wait for her to finish. Whatever you send while she's working goes one of three ways:

| Choice | What happens | In the app | In Telegram / Discord |
|---|---|---|---|
| **Tell her now** (the default for you) | She reads it before her next step and changes course. It never approves anything and never interrupts a tool that's running or a card that's waiting. | Send (or Enter) | Just send it; she reacts 👀 and says she got your note |
| **After this** | It waits and runs as its own turn when she's done. Remove it or send it now from its chip. | Send ▾ → *After this* (or Alt+Enter) | `/queue <text>` |
| **Just asking** | A quick answer on the side from a small model. Nothing is saved, she uses no tools, and the work carries on. | Send ▾ → *Just asking* | `/btw <question>` |

- People you chat with in rooms or partner chats always wait their turn; only you can steer her.
- After a restart, waiting messages don't run by themselves; she tells you they were dropped.
- `/reset` and *New* drop anything still waiting.
- Change the default in Settings → You → *While she's working*. Side questions have a daily cap (60 by default); in private chats they use only a model on this computer.

### She stops repeating herself

If the same tool call fails the same way three times in one turn, she's blocked from trying it again and told to change approach. If she keeps trying, her tools switch off for the rest of that turn. A note from you clears it; a new turn starts fresh. You'll see "Stopped repeating…" in her steps and in the progress message.

## Pictures, files and progress (2.48.0)

**Pictures and files both ways.** Send her a photo (with or without a caption), an album or a file in
Telegram or Discord and she looks at it the way she would in the app. Selfies, pictures she makes and
files she shares with the new `send_file` tool arrive as real photos and files. Albums are read as one
message (up to 4 pictures; she says if she looked at the first 4 only). Pictures up to 8 MB.

- *Settings → Telegram* (or *Discord*) → **Pictures and files**: *Send me pictures and files here*
  (on), *Look at pictures other people send* (off), *Send screenshots of her work* (off; only ever to
  your private chat), *Keep other people's pictures for* (7 days), *Send me a test picture* and
  today's counts.
- **Other people's pictures** (partners, people in rooms) are off by default. When you switch them on
  (here, or per room under *Rooms*), each picture is first described by your picture model and
  checked; she only gets the description, fenced as untrusted text. A picture that may show a minor
  is deleted at once; explicit pictures are refused outside an adult place. Daily quotas apply.
- **Private conversations** never send anything out. If your picture model isn't on this computer,
  photos in a private conversation get a short note instead of being read.
- `send_file` works only in your own conversations (never with partners, in rooms she only talks
  in, private conversations, or for other apps). She asks first in a shared work room or above 5 MB,
  refuses saved secrets and asks about key-shaped files.
- **Files in this chat** (in a conversation's settings) lists what came in or went out, with
  *Remove*. Other people's picture bytes go after 7 days, copies of sent files after 30 days, the
  lines after a year.

**Progress while she works.** On long jobs one message shows what she's doing, updated in place at
most every few seconds, with a **⏹ Stop** button (only you can press it). When she's done it becomes
one summary line (*✅ Done · 6 steps · 1:12*), or is removed if you prefer. It never shows commands,
output, arguments or secrets. Settings → Telegram/Discord → **Progress while she works** (private
chats only by default, after 10 seconds); per room under *Rooms*; per chat with `/progress on` or
`/progress off`.

### Owner to-do

- Set a picture model (`vision` in *Settings → Which model does what*) if you want photos read by a
  different model than the talking one.
- From your phone: send a photo and an album of three in Telegram and Discord; ask for a selfie and a
  chart as a file; run a long job and press Stop once; in a test group check that a friend's photo
  gets *I can't look at pictures here* until you turn it on for that room.

## Keeping up with a room (2.43.0)

Per room and only when you switch it on: open a group or server channel under *Rooms* (*Settings →
Telegram* or *Discord*, or the channel's project page) and turn on *Keep up with this room*. A plan
card shows the summary model, how often it runs, the estimated tokens a day and the cost (free on
this computer); nothing starts until you confirm it.

- She reads every message there, not only the ones that call her, so when she's called she joins
  the current topic, knows who is active and what changed since she last spoke, and notices when her
  old topic has moved on. Reading never starts a turn, a tool or a handoff, and nothing is posted in
  the room.
- *What she knows right now* on the card shows exactly the block she'd get if called now.
- Lines are kept 7 days. Each night after 04:00 older weeks become a read-only weekly transcript in
  her Library (*Archive: <room>*, searchable by you, and by her only in your own chats when you ask),
  a room memory (topics, short notes about the people there, with the week as source) and proposed
  People cards; then the raw lines are deleted.
- Room people are used only in that room unless you switch on *Use what she learned in rooms* or
  *Share between rooms* on their People card.
- Safety: lines that trip the minors check are stored as `[removed]`; if someone in the room writes
  about being in crisis, her next reply there within 2 hours brings the help resources. She never
  posts on her own.
- *Forget this room* deletes the log, summaries, room memory, the people notes and proposed cards
  from it, and its archive (and her sessions there, if you tick that).
- Never for household members or in the demo.

### Owner to-do

- **Discord:** keep-up needs the *Message Content Intent* (Developer Portal → your app → Bot →
  Privileged Gateway Intents). Bots in fewer than 100 servers just switch it on.
- **Telegram:** turn privacy mode off (@BotFather → /setprivacy → Disable), then remove her from the
  group and add her again, or make her a group admin. The card shows *Sees every message* when it
  works. Telegram doesn't tell bots about deleted messages.
- Try it in one busy channel and read *What she knows right now* after an hour; after day 8 open the
  room's archive in the Library and look at the proposed People cards.

## Signal, and long jobs on chat plugins (2.50.0)

Signal comes with Sara as a plugin (Settings → Chat apps → Signal): see [SIGNAL.md](SIGNAL.md). It
uses the same commands, sessions, channel project (*Signal*), keep-up, pictures and files, steer and
queue as Telegram, with these differences: you link your chat with `/link` and a code from the
plugin's settings, your safety number is remembered (a changed one pauses her tools there until you
press *It's me*), steers get a 👀, and the progress message is edited at most 7 times.

On every chat plugin (Signal, the LINE example, any other) a job longer than 5 minutes now sends one
*Still working on it* line and then **the whole answer** when it ends; 2.49 sent a partial answer at
5 minutes and dropped the rest. Plugin authors: [PLUGINS.md](PLUGINS.md) §8 (contract v1.2).

## Email (2.50.0)

She can have **an email address of her own** (the Email plugin, Settings → Chat apps → Email;
the full guide is [EMAIL_BRIDGE.md](EMAIL_BRIDGE.md)). Email her and she answers **in the same
thread**; every email thread is one session in the *Email* project, and a reply in an older thread
goes back to that thread's session. Commands work in the subject or the first line (`/status`,
`/new`, `/stop`, `/btw …`). She sends **one plain-text mail per turn** (the AI notice, her reply and
her files together), never progress mails; a steer or queued reply gets no "Got it" mail. Your mail
counts as you only from your linked address **and** when it passes your provider's sender check;
forwarded mail is fenced and makes every tool ask first; strangers are never answered and never
reach her.

## WhatsApp (2.55.0)

WhatsApp comes with Sara as a plugin (Settings → Chat apps → WhatsApp), off until you add it: see
[WHATSAPP.md](WHATSAPP.md). It uses Meta's official WhatsApp Business service with your own Meta
account and number, through a guided ten-step setup that checks each step. It uses the same
commands, sessions and `/link` as Signal, with these differences: Meta only lets her write first
within 24 hours of your last message (otherwise it stays in the app); WhatsApp can't edit messages,
so a long job gets typing and one *Working on it* line with ⏹ Stop; only you can reach her unless
you list other numbers; no groups or voice replies.

## Matrix (2.55.1)

Matrix comes with Sara as a plugin (Settings → Chat apps → Matrix), off until you add it: see
[MATRIX.md](MATRIX.md). She has a Matrix account of her own and talks with you in a room **without
end-to-end encryption** from Element or any Matrix app; in an encrypted room she says once that she
can't read it. Her password is used once to log her in and never kept. Commands work typed or with her
name first (`Sara new`, because Element eats unknown `/commands`); long jobs get one progress message
she edits (react ⏹ to stop her); she joins only your invites, and in rooms with other people answers
when mentioned. Sessions file into the *Matrix* project.

## Slack (unreleased, EC1)

Slack comes with Sara as a plugin (Settings → Chat apps → Slack), off until you add it: see
[SLACK.md](SLACK.md). You create a small Slack app of your own from a manifest the card shows; it uses
Socket Mode, so Sara needs no public address. Her DM is your own chat (tools, files both ways, a progress
message with ⏹); her requests for your OK come as **Allow / Deny** buttons only you can answer. A thread in
her DM is its own session. In channels you switch on (*Answer here*) she answers mentions in a thread,
without tools unless *Owners can use her tools in groups* is on. `/sara help`, `/sara new` and the other
commands work. Sessions file into the *Slack* project.

## Microsoft Teams (unreleased, EC7)

Microsoft Teams comes with Sara as a plugin (Settings → Chat apps → Microsoft Teams), off until you add
it: see [TEAMS.md](TEAMS.md). You make a free Azure Bot and upload a Teams app package the card builds.
Teams must reach Sara at a public https address (your domain, or the Tailscale Funnel door or a tunnel;
the card says which); Sara checks Microsoft's signature on every call. Her personal chat is your own chat
(tools, files both ways, a progress card with ⏹); her requests for your OK come as an Adaptive Card with
**Allow / Deny** only you can answer. In channels and group chats you switch on (*Answer here*) she
answers mentions in their thread, without tools unless *Owners can use her tools in groups* is on.
Sessions file into the *Teams* project.

## iMessage (2.55.2)

iMessage comes with Sara as a plugin (Settings → Chat apps → iMessage), off until you add it: see
[IMESSAGE.md](IMESSAGE.md). It needs **a Mac of yours** running BlueBubbles, signed in to Messages with
**an Apple ID of her own** (Sara refuses to run on your own Apple ID). BlueBubbles rings Sara when a
message comes (an unsigned "doorbell" that only carries ids; the plugin fetches each message itself),
or she checks every few seconds; after downtime she catches up. Basic mode answers with text, pictures
and files and one *Working on it* line on long jobs; the Private API's typing, tapbacks and edits are
used only if you already turned it on (Sara never asks you to turn SIP off). Strangers get one line;
groups are answered when a message starts with her name. Sessions file into the *iMessage* project.

