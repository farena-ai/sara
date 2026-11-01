# Chats in Telegram and Discord: commands

Sara answers you in Telegram and Discord the same way she does in the app (set up in **Settings →
Connections → Telegram / Discord**). Since 2.40.0 those chats have **commands**: a way to start fresh
when a chat is long or stuck, stop her, and see what she is using, without leaving the chat app.

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

**Ways to write them**

- From the `/` menu in Telegram and Discord (see *Menus* below).
- Typed: `/new`, `!new`, and in a Telegram group `/new@HerBot`. A command for another bot
  (`/new@otherbot`) is left alone. In a Discord server channel, typed commands need an @mention
  (`@Sara /status`); in a DM they work as they are. Unknown words like `/shrug` stay normal messages.
- **Her name and one word** (switch *Her name works as a command*, on by default): `Sara new`,
  `Sara, stop`, `@Sara status`. Only a message with nothing else in it counts, so "Sara, new idea for
  the garden…" is a normal message, and "Sara, status?" (a question) too. The words work in her six
  languages (`neu`, `nouveau`, `nuevo`, `novo`, `nuovo`, …). `/remember` and `/model` need the slash.
- In the **app** you can type `/new`, `/status`, `/help`, `/stop`, `/reset`, `/model` and `/remember`
  in the message box too; they never go to her as a message. On a Telegram or Discord session, the
  conversation's settings (⚙) also have *Start a new session from here*, *Context used* and
  *Earlier sessions of this chat*.

**Who is who is checked by Sara every time.** The menus only decide what people see: Telegram and
Discord let anyone send any command, so Sara refuses owner-only commands from anyone who isn't you
(one short line, in their own language) and does nothing else. Bots never run commands.

## When a chat gets long

When a chat is almost too long for her to keep in mind (85 % of her history budget, or once older
parts already have to be left out), she says once per session: *"This chat is getting long. Send
/new for a fresh start; I'll keep a summary of this one."* In a room where you work with her, that
note goes to you privately. Switch it off with *Offer a new session when a chat is long*. The
number is the same as `/status` and the ring in the app's header.

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

1. Update Sara, then open **Settings → Connections → Telegram** and **→ Discord** and check that
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
