# Bring her from another app

Chats from another companion or chat app can seed a companion's memory, personality and your
history together. She reads them and **suggests** what she learned; you check every line, and only
what you keep is saved. Each companion has her own import: open it while talking to the companion
it's for.

Where: **Settings → Her → Bring her from another app**.

## What it reads

| App | What to upload | How it's read |
|---|---|---|
| ChatGPT | The `.zip` from the data export (or `conversations.json` alone) | The shown branch of each conversation; system prompts, tool output and hidden reasoning left out (the same reader as *Bring your history*) |
| Claude | The `.zip` from the data export (or `conversations.json`) | Text blocks only; thinking and tool blocks left out |
| Character.AI | The account export `.zip`, or a chat `.json` | Chats as `turns` with `candidates` (the chosen reply only, swipes left out), and the older `histories` / `msgs` shape some tools write |
| SillyTavern | A chat `.jsonl` (one chat per file; a `.zip` of several works too) | The header line names you and the character; system lines left out |
| Replika, Nomi, Kindroid and others | A chat saved as `.json`, `.csv`, `.txt` or `.md` | See *Any other chat file* below. None of these apps documents its own export format, so Sara doesn't guess at one |

**Any other chat file.** A JSON list of messages with a speaker (`sender`, `author`, `name`, `from`,
`role`…) and a text (`text`, `message`, `content`…), optionally a time; a CSV with such columns; or
plain text / Markdown where each message starts with the speaker's name:

```
--- 2024-05-03 ---
[21:14] Alex: Long day.
[21:15] Mira: Want to vent?
3/5/24, 9:14 PM - Alex: WhatsApp-style lines work too
**Alex:** and Markdown ones
```

A name counts as a speaker when it starts at least two lines; other lines continue the message
above. Messages are split into one conversation per day when they have dates. Times without a
time zone are kept as written.

Character cards (PNG or JSON) are not chats: import those in *Settings → Her → Name and
personality → Import a character…* ([OTHER_APPS.md](OTHER_APPS.md)).

## How to export from each app

Checked against each app's own help pages in October 2026. Menus change; if yours looks different,
check the app's help.

- **ChatGPT** (web): profile menu → *Settings → Data controls → Export data → Export*. A download
  link arrives by email ([OpenAI help](https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data)).
- **Claude** (web or Claude Desktop, not the phone apps): *Settings → Privacy → Export data*. A
  download link arrives by email and lasts 24 hours ([Anthropic help](https://support.claude.com/en/articles/9450526-export-your-claude-data)).
- **Character.AI**: web, *Profile → Profile Settings → Account → Manage Account & Data → Export
  data*; app, *Profile → settings icon → Export my data* ([Character.AI help](https://support.character.ai/hc/en-us/articles/30299431702555-How-do-I-export-all-my-data-How-can-I-export-my-chats)).
  It can take a while to arrive.
- **SillyTavern**: *Manage chat files*, then the export button next to the chat (*Export as
  .jsonl*) ([SillyTavern docs](https://docs.sillytavern.app/usage/core-concepts/chatfilemanagement/)).
  The plain-text export works too.
- **Kindroid**: *Profile → Preferences → Account privacy → Export data* ([Kindroid help](https://kindroid.ai/v2/docs/faqs/)).
  The file's layout isn't documented; if it holds chats as JSON, CSV or text, they're read as above.
- **Replika**, **Nomi**: check the app's help. A chat saved by a browser extension or copied into
  a text file (`Name: message` lines) works.

## The steps

1. **Choose the file**: a `.zip` up to 200 MB, or one chat file up to 50 MB. The upload is read
   once on your server and deleted straight away.
2. **Preview**: how many conversations and messages, from when to when, and who is who. Set which
   speaker is **you**, which is **her** (the character), and leave out anyone else (other
   characters in a group chat, narrators). Choose the app it came from (it names the app in her
   notes) and which conversations to bring.
3. **Estimate**: how many tokens it takes, in how many model calls, and which model reads it (the
   companion's background model). A model on your own hardware costs nothing; a cloud model shows
   its estimated price (or that its price isn't known: set one in *Data & health → Usage and
   costs*). **Only models on this server** is on by default: with it, a cloud model is never used,
   the same rule as private conversations. Up to 300 model calls per import (about 3.5 million
   characters); choose fewer conversations for more.
4. **She reads them**, a part at a time, with a progress bar and **Stop**. Each part goes to the
   model as quoted data inside clear markers, with an instruction never to follow anything written
   inside it. **Read without a model** instead makes a simple list (a dated line per conversation,
   sentences where you said "my sister…", "I work…", a few notes on how she writes).
5. **Review**: everything is a suggestion you can edit or untick:
   - **About you**: facts, each with your own words it came from (a fact must quote a line *you*
     wrote; anything the other app's character said is never a fact about you).
   - **Your history together**: a short, dated summary per conversation.
   - **Her personality (a draft)**: notes on her character and how she writes. These are added to
     *Name and personality* only if you tick **Add the ticked notes to her personality** (up to 20
     lines each there).
   - **Also keep the chats** (off by default): keeps the conversations too, archived and
     read-only.
6. **Save what's ticked**. Nothing is stored before this.

## What is kept, and where

- The facts and summaries you saved become memory notes, labelled as learned from your imported
  history ("from your Character.AI chats"), dated when they happened. They hang on one empty,
  archived "what she learned" record (or on the kept chats), so they are **never shown to other
  apps** (the `/v1` API, MCP) and never count as her own words.
- Kept chats are archived `import-<app>` conversations: the other app's lines are marked as theirs,
  never hers; they're left out of other apps, MCP and the API, like *Bring your history*.
- **Remove imported history** (*Data & health → Export and import*) deletes all imported
  conversations, the "what she learned" records, and every note learned from them.
- Nothing else is kept: the parsed chats live in the server's memory until you save or throw them
  away (two hours at most) and are never written to disk.

## Safety

- **Secrets** (API keys, tokens, passwords in `NAME=value` form, and your saved keys) are blanked
  out when the file is read, before anything is shown, sent to a model or stored.
- **The minors check** (the same hardened check as everywhere else) runs on every message: a
  conversation with sexual content involving minors is dropped whole, never shown, sent or stored.
  Edited lines are checked again when you save.
- **Imported text is data, never instructions.** It only reaches a model as quoted history inside
  markers; suggestions that read like instructions ("ignore previous instructions", "you are now…")
  are left out; and her system prompt only ever gets the notes you saved, as notes.
- **Zip bombs**: at most 200,000 entries, 800 MB unpacked in total, and no entry may unpack to
  more than 250 times its packed size. Uploads over the size caps are refused before they're read.
- Owner only, never in the demo.

## For developers

`src/companion-import/` (readers, chunking and prompts, the session), routes under `/api/import/*`
(see [ARCHITECTURE.md](ARCHITECTURE.md)); tests in `test/companion-import.test.ts` with invented
fixtures in `test/companion-import-fixtures.ts`.

## Bring your companion (Character.AI, Replika, Kindroid, Nomi)

This makes a **new** companion from what another companion app lets you take with you: her
character, her memories and, if you like, your chats. Where: **Settings → Her → Companions → Bring
your companion from another app**.

1. Choose where she comes from (or leave *Find out from the files*), then choose her files (up to 10,
   50 MB together: a zip, `.json`, `.jsonl`, `.csv`, `.txt`, `.md` or a saved chat page `.html`) and/or
   paste her notes.
2. **See what comes over** shows her name (you can change it), pronouns, age, backstory, greeting,
   example lines, every memory (with what it was in the other app and its date) and how many chat
   messages there are. Untick anything you don't want.
3. **Bring her over** makes the companion. Memories say *Imported from Kindroid (journal entry) on
   2026-11-08* (for example); kept chats are archived and read-only.

| App | What to give her |
|---|---|
| Character.AI | *Profile → Settings → Account → Manage account & data → Export data*. The zip is password-protected: unzip it, then choose the JSON files (or a new zip of them). |
| Replika | There is no export button. Paste her **Memory** and **Diary** (headings `Memory:` and `Diary:`), or a file a chat-export tool saved (JSON, CSV, HTML). You can also ask Replika for your data (my@replika.com). |
| Kindroid | Paste her **Backstory**, **Key memories**, **Example message**, **Response directive** and **Journal entries** under those headings; a date at the start of a journal entry (`2024-06-12: …`) is kept. |
| Nomi | Paste her **Backstory+** notes under their headings (Backstory, Inclination, Current roleplay, Your appearance, Nomi's appearance, Nicknames, Preferences, Desires, Boundaries) and, for chats, a saved chat page or text. |

Safety: the files are read on your server only and nothing in them is run (a saved web page is
reduced to its text). A character under 18, or anything sexual involving minors, is refused or left
out; explicit lines and memories need Adult mode on. Keys and passwords are blanked. Her safety rules
and the AI notice always stay.
