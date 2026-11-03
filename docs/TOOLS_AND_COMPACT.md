# A short tool list, and tidying long chats (2.56.0)

Two things for big setups and long sessions. Design: [design/LEAN.md](design/LEAN.md).

## The short tool list

With several MCP servers or plugins, sending every tool's description with every message fills a small
model's memory before you have said anything. Measured on this PC (2.56.0, fresh data folder, a
recording stand-in model, `o200k_base` tokens of the exact request):

| Setup | Chat | Before (every tool) | After (short list) |
|---|---|---|---|
| Fresh install | everyday | 67 tools · 9,603 tokens of tools + 2,268 system = 11,871 | 18 tools · 2,778 + 2,693 = 5,471 (−54 %) |
| Fresh install | coding | 67 · 9,603 + 3,282 = 12,885 | 23 · 2,839 + 3,516 = 6,355 (−51 %) |
| + GitHub, Playwright, files, memory MCP servers | everyday | 141 · 20,640 + 2,836 = 23,476 | 18 · 2,778 + 2,660 = 5,438 (−77 %) |
| + the four servers | coding | 141 · 20,640 + 3,850 = 24,490 | 23 · 2,839 + 3,486 = 6,325 (−74 %) |
| + the four servers, "open an issue on the Sara repo" | everyday | 141 · 20,640 + 3,077 = 23,717 | 30 · 4,489 + 2,751 = 7,240 (−69 %) |

On a model on this computer the everyday list starts even smaller (14 tools, ≈ 4,900 tokens in all),
with *Smaller list on models on this computer* on.

**What she gets each message:** the tools for the kind of chat (everyday or coding), six safety tools
that let her stop or take back things (stop a job, job status, stop a preview, revoke an SSH key,
forget an SSH password, the safety report), anything you pinned, anything your message names ("issue",
"repo" → GitHub; "click", "browser" → the browser tools; in six languages), what an `@url:` or `@file:`
needs, what she used in this chat in your last 10 messages, what a loaded skill names, and what a goal's
earlier rounds used. For anything else she calls **find_tools** with a few words; it loads up to five
tools for her next step. Nothing is switched off: a tool she calls without having it still goes through
your approval card, and a tool that isn't allowed in this chat (an MCP tool in a private chat) can't be
found or run.

- Settings → Coding → Tools and approvals → *Short tool list*: Automatic (above 6,000 tokens of
  tools), Always or Off; the size; how long a looked-up tool stays; the smaller list for local models.
- In a chat: `/tools`, `/tools all`, `/tools lean`, `/tools +github`, `/tools -github`. The ring's sheet
  in the header shows "Tools: 23 of 142 offered · ≈ 2.9k tokens a step" and *What she has*.
- The run view records, per step, which tools were offered, which were looked up and why.
- Other apps (`/v1`, Sara as an MCP server) and group chats keep their full lists.

## Tidying a long chat (`/compact`)

*Tidy this chat* (the ring's sheet) or `/compact` folds the older part of the chat into a summary she
reads instead. Your last turns (6 by default) stay word for word, the folded messages stay in the thread
(dimmed, under a divider with *Show summary* and *Undo*), and nothing is deleted. Measured live on this
PC with gemma4:12b: a coding chat at 91 % (14,621 of 16,000 characters) went to 40 % (6,342), 12
messages folded into a 1,611-character summary written on this computer.

- **Who writes it:** a model on this computer first, else the quick model (Settings → Models → Default
  model → Long conversations → *Tidy long chats*). **Private chats only ever use a model on this
  computer**, or a plain list the app makes from your asks and her receipts. A daily limit (40 tidies,
  500k tokens) applies; past it she makes the plain list.
- **On her own:** at 85 % full, before your next message is answered (and between goal rounds), at most
  once every 10 of your messages; two failed tries switch it off for that chat until you `/compact`.
- **Safety stays:** a crisis exchange from the last 24 hours is never folded (after that, the note tells
  her it happened); refused requests never reach the summary; the summary and your focus words are
  checked like every message; the AI notice keeps its own clock. Having her forget something inside a
  tidied part removes that summary at once.
- **Where:** your own chats, work sessions and coding chats, in the app and every chat app. Not in
  other people's chats, rooms' own conversations, off-the-record chats, or other apps.
