# When it comes up (2.52.0)

Reminders that wait for a person or a topic instead of a time: "when Dan comes up, remind me he owes
me $20". The next time **you** mention Dan in one of **your own chats**, she brings it up once, in her
reply. Design: [design/RECALL.md](design/RECALL.md) §4.

## Setting one

- **In any of your own chats**, in your own words: "when Dan comes up, remind me he owes me $20",
  "next time I mention the Henderson project, ask me about the rollback plan", "every time the
  release comes up, ask about the rollback plan". She sets it with her `remind` tool and a card under
  her reply shows it, with **Undo** (or **Keep it / No** if you choose *Ask first*).
- **Typed:** `/when Dan: he owes me $20`, `/when the release: ask about rollback, every time`.
  A single capitalised word is a person on your People cards; anything else is words to watch for.
- **Planner → Reminders → When it comes up:** a row with *Remind me…*, *When these words come up…*
  or *Or a person…*, and *Once / Every time*. It shows how often it would have come up in the last
  30 days before you add it.

## How it matches (code only, no model call)

- **A person:** the People card's name, full name and nicknames. With two cards of the same name
  ("Dan" your friend and "Dan" from work) she never guesses: "Dan from work" or "my friend Dan"
  decides, and in a chat where she asked "which Dan?" your answer does.
- **Words:** every word must be in one message (word stems, any case, accents ignored; "the wedding"
  as a phrase). A word you use all the time ("work", or anything in more than 20 of your last 200
  messages) is refused: "Too common: try something more specific."
- Never the message that set it, and not again in the same session within 30 minutes.

## Where it never fires

Only **your own messages** in **your own chats** (the app, your Telegram and Discord DMs, your calls
with her in the app if you allow it). Never: shared rooms or work channels (unless you choose *Tell me
in my own chat*: then one line comes to your own DM, never into the room), other people's chats
(including Dan's own chat with her), private or off-the-record chats, other apps (API, MCP, A2A,
plugins), goals and repeats running on their own, other companions, household members' chats (their
reminders live in their own planner). A crisis message holds every reminder.

The reminder text is private: it is never in her agenda, the briefing, Today, MCP `get_today`, or a
reminder list asked for outside your own chats. Anything she would send to someone else (an email,
a message, an agent) that contains it asks you first: *This mentions your reminder: "…". Send it
anyway?*

## When it comes up

She says it in her reply ("Also, Dan still owes you $20"). If she leaves it out, the app adds one
line: *⏰ You asked me to remind you: he owes me $20.* Under her reply a ⏰ chip has **Done**,
**Again next time** and **Forget** (buttons in Telegram and Discord; only you can press them).

## Limits (Settings → Abilities → When it comes up)

| Setting | Default |
|---|---|
| In one reply | 1 (the oldest first; the rest wait) |
| In one day | 5 |
| Ends after | 180 days nobody mentioned it (then a month under *Done*) |
| Every time: at most once in / how many times | 24 hours / 3 |
| Active at once | 200 |
| Your lines in shared rooms | Off (or *Tell me in my own chat*) |

People cards follow: rename keeps it, merging moves it, forgetting a person ends their reminders
(the Forget confirmation counts them). A word reminder for "Sam" becomes a person reminder when you
make Sam's card.

## Commands

`/when` (list, numbered) · `/when forget 1` · `/when again 1` · `/when off` · `/when on`. Owner only,
in your own chats; it never reaches a model. See [CHATS.md](CHATS.md).
