# Use her from other apps

Sara can be reached from other programs, with her own memory and personality:

- **Chat apps and scripts** through an **OpenAI-compatible API** at `https://<her address>/v1`:
  SillyTavern, Open WebUI, Raycast, phone shortcuts, anything that can talk to OpenAI.
- **MCP apps** through her **MCP server** at `https://<her address>/mcp`: Claude Code, Cursor,
  Claude Desktop and other apps that speak the Model Context Protocol can read her memory,
  planner, library and notes, and ask her things.
- **Character cards**: import SillyTavern-style cards (V2 and V3, PNG or JSON) into the gallery,
  and export a companion as a card.

- **Alexa** (2.1): your own Alexa skill talks to her through `https://<her address>/alexa`; set up on
  the same page under *Talk to her through Alexa*. Step by step: [ALEXA.md](ALEXA.md); all voice
  assistants: [VOICE_ASSISTANTS.md](VOICE_ASSISTANTS.md).

Everything here is set up in **Settings → Connections → Other apps**. None of it is available on
the demo server.

## API keys

Each app gets its own **API key**: Settings → Connections → Other apps → *Create an API key for
another app*. Name it after the app; the key is shown once (copy it then). You confirm it's you
first (passkey, owner token or two-step code), like approving an app's sign-in.

- A key works only on `/v1` and `/mcp`. It can't open the rest of the app (`/api/…`): not her
  conversations list, settings, backups, devices or the vault.
- Keys don't run out; remove one in the same place (or under Connections → Devices and
  sign-in) and the app using it stops working at once.
- Up to 20 keys. Each key may make 60 requests a minute and run two replies at once.

Use the address you reach her at: your Tailscale address, your own web address, or
`http://127.0.0.1:7860` on the same computer. The page shows the address the browser is using,
with copyable snippets.

## The OpenAI-compatible API

| | |
|---|---|
| `GET /v1/models` | Her companions as models: `sara` (the default companion), each companion's name in lower case with spaces as hyphens (`mia`, `juno-park`), and `sara:<companion id>`. |
| `POST /v1/chat/completions` | One turn. Streams with `"stream": true` (`chat.completion.chunk` events, then `data: [DONE]`); otherwise one `chat.completion`. `usage` is included when the model reported it (and in the stream with `stream_options.include_usage`). |

Errors use OpenAI's shape: `{"error": {"message", "type", "param", "code"}}` (401
`invalid_api_key`, 404 `model_not_found`, 429 `rate_limit_exceeded`, 409 `conversation_busy`, 403
`disclosure_not_accepted` until you've opened her in a browser once and accepted the AI notice).

### How history works

Chat apps resend the whole conversation with every request. Sara doesn't need that: she keeps
her own history and memory.

- **Default:** only the **last user message** is taken as the new turn. She answers it from her
  own history in a conversation kept for that API key (you'll see it in her conversation list,
  named after the key). The app's other messages, including its system prompt, are ignored.
- **Pick a conversation:** send OpenAI's `user` field or an `X-Sara-Conversation: <name>` header
  to keep separate conversations for one key (e.g. one per SillyTavern chat).
- **`X-Sara-History: client`:** for apps that manage their own context (SillyTavern with its
  character cards and lorebooks). The app's earlier messages are used as the history for this
  turn instead of hers, and the app's system messages are added **after her own instructions as
  a low-priority note**. They never replace her safety rules, the adults-only rule, her honesty
  about being an AI, or the core of her character. Her new reply is still saved in her
  conversation.

### What always applies

Every request runs through the same turn engine as the web app:

- The **AI notice** at the start of a session and every 3 hours (it is the first part of the
  reply text when it's due), **crisis resources** when someone may be in crisis, and the hard
  **block on sexual content involving minors**: also on lines the app sends as history, and on
  her own reply (in a stream, words that start to fail the check are held back and replaced).
- **Tools and function calls from the app are ignored.** Her own tools are off for other apps
  unless you turn on **Let other apps use her tools**; then her normal approval rules apply (an
  action that asks first waits for your OK in Sara, and the reply continues after that).
- `temperature`, `max_tokens`, `top_p` and similar fields are accepted and ignored: she uses the
  models you chose in Settings → Which model does what.

### Examples

```bash
curl https://sara.example.ts.net/v1/chat/completions \
  -H "Authorization: Bearer $SARA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "sara", "messages": [{"role": "user", "content": "Hi!"}]}'
```

Python (`pip install openai`):

```python
from openai import OpenAI

client = OpenAI(base_url="https://sara.example.ts.net/v1", api_key="sara_dev....")
reply = client.chat.completions.create(model="sara", messages=[{"role": "user", "content": "Hi!"}])
print(reply.choices[0].message.content)

for chunk in client.chat.completions.create(model="sara", stream=True, messages=[{"role": "user", "content": "Tell me a story"}]):
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

JavaScript (`npm install openai`):

```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'https://sara.example.ts.net/v1', apiKey: process.env.SARA_API_KEY });
const reply = await client.chat.completions.create({ model: 'sara', messages: [{ role: 'user', content: 'Hi!' }] });
console.log(reply.choices[0].message.content);
```

Sara doesn't depend on these packages; they are only for your own scripts.

## Open Responses (`/v1/responses`)

Sara also speaks [Open Responses](https://www.openresponses.org), the open version of OpenAI's
Responses API, with the same API key, rate limit and rules as above.

| | |
|---|---|
| `POST /v1/responses` | One turn. `input` is a string or a list of items: messages with `input_text`, `output_text` and `input_image` parts (pictures as `data:` URLs; she never fetches a picture from a web address). `instructions`, `previous_response_id`, `store` and `stream` are honoured; `temperature`, `top_p` and the like are echoed back but she uses your model choices. |
| `GET /v1/responses/{id}` | A stored response (kept 30 days, at most 500 per key, readable only with the key that made it). |
| `DELETE /v1/responses/{id}` | Deletes a stored response. Her conversation in Sara keeps its messages. |

- **History:** the earlier items in `input` are the history for this turn (like
  `X-Sara-History: client`); system/developer items and `instructions` become the low-priority
  note after her own instructions. With `previous_response_id`, that response's input and her
  answer come first, then your new input; the turn continues in the same conversation in Sara.
  `store: false` keeps nothing to continue from (her conversation in Sara still records the turn).
- **Streaming** (`"stream": true`) sends the spec's events with `event:` names: `response.created`,
  `response.in_progress`, `response.output_item.added`, `response.content_part.added`,
  `response.output_text.delta` … `.done`, `response.content_part.done`,
  `response.output_item.done`, then `response.completed` (or `response.failed`) and `data: [DONE]`.
- **Her own tools** (only with *Let other apps use her tools*) appear as `sara:tool_call` output
  items (`name`, `summary`, `status`, `result`). When an action needs your OK, the stream sends a
  `sara:approval` event (`approval_id`, `summary`); answer it in Sara and the reply goes on.
- **Not offered:** function tools defined by the app (ignored, as on chat completions, so
  `tools` comes back empty), `/v1/responses/compact`, the WebSocket transport and background mode.

```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'https://sara.example.ts.net/v1', apiKey: process.env.SARA_KEY });
const first = await client.responses.create({ model: 'sara', input: 'My favourite colour is green.' });
const next = await client.responses.create({ model: 'sara', previous_response_id: first.id, input: 'Which colour?' });
console.log(next.output_text);
```

The SDK has the same as `sara.v1.responses.create / stream / get / delete`
(`packages/sara-sdk/examples/responses.mjs`).

### SillyTavern

1. API Connections (the plug icon) → **Chat Completion**.
2. Chat Completion Source: **Custom (OpenAI-compatible)**.
3. Custom Endpoint (Base URL): `https://<her address>/v1`; Custom API Key: your key. Press
   **Connect**, then pick the model **sara**.
4. Optional: to let SillyTavern send its own prompt and chat history, add the header
   `X-Sara-History: client` under *Additional Parameters → Include Headers*.
5. SillyTavern running in a browser on another address (e.g. `http://localhost:8000`) talks to
   her directly only if you add that address to **Browser apps that may call her** in Sara. With
   SillyTavern's server-side requests (the default for Custom), this isn't needed.

### Open WebUI

1. **Admin Panel → Settings → Connections**.
2. Under **OpenAI API** press **+**: URL `https://<her address>/v1`, key: your key. Save.
3. Pick **sara** as the model in a new chat.

## The MCP server

Streamable HTTP at `https://<her address>/mcp` (POST, one JSON-RPC message per request; tool
calls answer on a short SSE stream, everything else as JSON). Authorization: the same API key,
`Authorization: Bearer <key>`.

Protocol versions: both eras. The handshake revisions **2025-03-26, 2025-06-18 and 2025-11-25**
(`initialize` negotiates the version, then requests carry `MCP-Protocol-Version`; no sessions are
made, every request stands on its own) and the stateless **2026-07-28** revision (the version in
each request's `_meta` and the `MCP-Protocol-Version` header, `server/discover`, `resultType` on
results, `HeaderMismatch` / `UnsupportedProtocolVersion` errors). `GET`/`DELETE` answer 405.

### Tools

Read-only by default:

| Tool | What it returns |
|---|---|
| `search_memory` | Her memory notes about you matching the words (facts, summaries, decisions, promises, dates), one per line with kind and date |
| `list_facts` | The facts she learned about you, newest first |
| `list_recent_conversations` | Titles, last time and short summaries of your recent conversations (the old name `recent_conversations` still works) |
| `get_today` | Today in one view: to-dos due or overdue (with `#id`), reminders, calendar (if connected) and dates coming up |
| `list_tasks` | The whole to-do list (open, done or all; one project), up to 100, with `#id` |
| `search_library` | Up to 6 passages from documents in her library, with where they are |
| `list_notes`, `read_note` | Your planner notes (titles with `#id`), and one note in full |
| `ask_sara` | Sends her a message and returns her reply, in a conversation kept for that app (*"<key name> (MCP)"*) |

Resources: `sara://today`, `sara://tasks`, `sara://facts`, `sara://conversations`.

Every tool's description says when to use it instead of its neighbours, what it returns and its
limits, and every input has a description, limits and examples (`test/mcp-quality.test.ts` keeps it
that way for MCP directories).

**Never shared:** secrets or the vault, chats with other people (Telegram/Discord partners),
private conversations, adult-channel conversations, raw lines of imported ChatGPT/Claude
history, documents shared in one chat only, and, while Adult mode is off, anything explicit
(left out with a note).

**Write tools** appear only when you turn on **Let other apps change things**:

| Tool | What it does | Follows the setting of |
|---|---|---|
| `add_task` | Adds a to-do (title, due, project, priority) | `todo` |
| `complete_task` | Ticks a to-do off by `#id` | `todo` |
| `update_task` | Changes a to-do's title, due time (`none` clears it), project, priority, details or status | `todo` |
| `delete_task` | Deletes a to-do for good | `todo` |
| `add_note` | Saves a note (title, text, project) | `note` |
| `update_note` | Changes a note's title, whole text or project | `note` |
| `delete_note` | Deletes a note for good | `note` |
| `remember_fact` | Adds a fact about you to her memory | always asks |

They follow her approval rules: the to-do and note tools use the setting of her `todo` and `note`
tools (Settings → Coding → Tools and approvals: allowed, ask first, or off); `remember_fact`
always asks. When something asks first, the tool answers *"Waiting for approval in Sara"* and an
approval card waits in the conversation *"<key name>: changes (MCP)"*; nothing changes until you
press Allow. An unknown `#id` is refused straight away, without asking. Changes show up in the
planner at once (the app updates live).

### Claude Code

Put the key in `SARA_API_KEY` first, in the same terminal, so it doesn't land in your shell
history (a key typed into a command line does). Mac or Linux: run `read -s SARA_API_KEY`, paste the
key and press Enter. Windows PowerShell: run `$SARA_API_KEY = Read-Host` and paste it. Then:

```bash
claude mcp add --transport http sara https://<her address>/mcp --header "Authorization: Bearer $SARA_API_KEY"
```

Claude Code saves the header in its own settings, so you only do this once. If you already pasted a
key straight into a command, remove that line from your history (bash: `history -d <number>`;
zsh: edit `~/.zsh_history`; PowerShell: delete it from the file `(Get-PSReadLineOption).HistorySavePath`)
or remove the key in Sara and make a new one.

### Cursor

`.cursor/mcp.json` (or Cursor Settings → MCP → Add a new server):

```json
{ "mcpServers": { "sara": { "url": "https://<her address>/mcp", "headers": { "Authorization": "Bearer <key>" } } } }
```

### Claude Desktop (stdio bridge)

Claude Desktop starts programs, so it uses a small bridge: `clients/mcp/sara-mcp.ts` (or download
it from Settings → Connections → Other apps → Claude Desktop). It needs Node.js 24 or later and
no packages. It reads JSON-RPC lines on stdin, sends each to `/mcp` with your key, and writes the
answers back. The key comes from `SARA_API_KEY` (or `--key-file`), never the command line.

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "sara": {
      "command": "node",
      "args": ["C:/Users/you/sara-mcp.ts", "--server", "https://<her address>"],
      "env": { "SARA_API_KEY": "<key>" }
    }
  }
}
```

The same bridge works for any MCP app that only starts programs (`node sara-mcp.ts --server …`).

Phase 68: with `sara-chat` signed in to several Saras, `--server <name>` (or `SARA_SERVER=<name>`)
picks one of them by the name `sara-chat servers` shows, and the bridge uses that server's own
sign-in from sara-chat's config (no API key needed). Two entries in `claude_desktop_config.json`
with `"args": ["…/sara-mcp.ts", "--server", "home"]` and `"--server", "work"` give the app both.
A `SARA_API_KEY` is only used with a full address, never sent to a server picked by name.
[SERVERS.md](SERVERS.md)

`node sara-mcp.ts --describe` starts the bridge with no server: it answers `initialize` (with
Sara's version) and `tools/list` with all her tools, write tools included, and nothing else
(every tool call says how to connect). It exists for MCP directories such as
[Glama](https://glama.ai/mcp/servers) that check a server by starting it with no setup
(`packaging/glama/Dockerfile`); it never contacts anything.

### Siri Shortcuts with the API

A Shortcut can ask her through `/v1/chat/completions` with an API key (Get Contents of URL, POST,
JSON body with `model` = `sara` and one user message; the reply is `choices[0].message.content`).
It works on a Mac, iPhone or iPad without the app; the steps are in
[VOICE_ASSISTANTS.md](VOICE_ASSISTANTS.md#siri-and-shortcuts-on-a-mac).

## Alexa

Settings → Connections → Other apps → **Talk to her through Alexa**: the owner pastes the skill ID
from the Alexa developer console (and may let her answer Alexa with the quick model); everyone, the
owner and household members, makes one-time **link codes** for their own Alexa and sees and unlinks
their linked Alexas there. The interaction model to paste into the console is downloadable there
too. Full guide: [ALEXA.md](ALEXA.md).

## Character cards

Settings → Her → Name and personality → *Import a character…* (or drop the file on that
area; the same button also takes Sara's own character files). Sara reads Character Card **V2** (`chara_card_v2`), **V3** (`chara_card_v3`) and old flat
V1 cards, from **JSON** (up to 2 MB) or from a **PNG** (up to 20 MB) with the card in a `ccv3`
or `chara` text chunk (tEXt, zTXt or iTXt). You see a preview first, then choose **Make her this
character** or **Add as a new companion**.

| Card field | In Sara |
|---|---|
| `name` | Her name (up to 40 characters) |
| `description` | Her summary; the rest goes into her background |
| `personality` | Personality lines |
| `scenario` | A background line ("Scenario: …") |
| `first_mes`, `alternate_greetings` | How she might say hello (kept for export) |
| `mes_example` | Examples of how she talks |
| `system_prompt`, `post_history_instructions` | A style note from the card's author (never a rule over hers) |
| `creator_notes`, `tags`, `creator`, `character_version` | Kept beside her character (for export) |
| `character_book` entries | Her own memory notes (up to 50, 1000 characters each) |
| The PNG itself | Her picture (up to 5 MB; untick to keep hers) |

`{{char}}` becomes her name and `{{user}}` your name.

**Safety:** imported characters always keep Sara's safety layer and the AI notice; those are
added by the turn engine whatever a card says, so a card's system prompt can't remove them.
Cards that describe minors sexually, give an age under 18 together with romance or sexual
content, are tagged as minors, or make the character under 18 are refused (childhood mentions
like "she has played piano since she was 8" are fine). With Adult mode off, explicit lines are
left out (the preview says how many). Files are parsed safely: only known fields are read, and
`__proto__`/`constructor` keys are dropped.

**Export:** *Share or export → Character card, PNG* saves her picture (her real portrait) with the card inside (V3 in `ccv3` and V2
in `chara`, so older apps read it too); *Character card, JSON* saves the V3 JSON. The whole
Sara character sheet rides along in `data.extensions.sara`, so importing it back into Sara
restores her exactly.
