# Extending Sara

Sara is meant to be changed. This guide shows the six ways to add to her, each with a small,
working example in [`examples/`](../examples/). Every example is checked by
[`test/examples.test.ts`](../test/examples.test.ts), so they keep compiling and passing with
`npm run check`.

| You want to… | Add a… | Example |
|---|---|---|
| Give her a new ability she can call | [Tool](#add-a-tool) | [`examples/tools/weather-tool.ts`](../examples/tools/weather-tool.ts) |
| Reach her from another chat service | [Bridge](#add-a-bridge) | [`examples/bridges/line-bridge.ts`](../examples/bridges/line-bridge.ts) |
| Ship a ready-made personality | [Character](#add-a-character) | [`examples/characters/ada-pair-programmer.json`](../examples/characters/ada-pair-programmer.json) |
| Plug in tools from another program | [MCP server](#connect-an-mcp-server) | [`examples/mcp/hello-mcp-server.mjs`](../examples/mcp/hello-mcp-server.mjs) |
| Make the app speak your language | [Language](#add-a-language) | [docs/TRANSLATING.md](TRANSLATING.md) |
| Give her a tested project to start from | [Starter template](#add-a-starter-template) | [`examples/starters/word-counter/`](../examples/starters/word-counter/) |

Ground rules for everything here (the same as for the rest of the code, see
[CONTRIBUTING.md](../CONTRIBUTING.md)): Node built-ins only (no npm packages at run time), plain
TypeScript that Node runs directly (no enums, namespaces or constructor parameter properties;
`.ts` in import paths), a test for each new piece, and **nothing you add may weaken the safety
layer** (`src/safety.ts`: AI disclosure, honest answers when sincerely asked, crisis resources,
the block on sexual content involving minors).

## How the pieces fit

```
 web app · phone apps · desktop apps · sara-chat · VS Code · Telegram · Discord · your bridge
                                 │
                          src/server.ts  (HTTP API, sign-in, events)
                                 │
                           src/chat.ts   runTurn(): one turn of conversation
     safety notes → memory/library/codemap context → model → tool calls → approvals → reply
                │                         │                        │
   src/providers/* (models)    src/tools/* (tools, sandbox)    src/safety.ts (always on)
```

Every way of talking to her goes through `runTurn()` in `src/chat.ts`. That is where the safety
layer, the permission checks and the receipts (did she really do what she says she did?) live, so
anything you add on the outside gets them for free.

## Add a tool

A tool is a plain object that implements `Tool` from
[`src/tools/types.ts`](../src/tools/types.ts):

| Field | What it's for |
|---|---|
| `spec` | `name`, `description` and JSON-schema `parameters`: what the model sees. Write the description for the model: when to use it, what it returns. |
| `defaultPermission` | `'auto'` (runs without asking), `'ask'` (an Allow/Deny card first) or `'never'` (shipped switched off). The owner can change it per tool in Settings → Coding → Tools and approvals. |
| `isAvailable?()` | Return `false` to hide the tool (e.g. not configured yet). Hidden tools are not offered to the model. |
| `runsCommands?` | `true` for tools that run commands the model wrote. On a computer with no sandbox (Windows) these always ask first, unless the owner explicitly chose otherwise. |
| `summarize(args)` | One short line for the activity log and the approval card ("weather in Austin"). |
| `run(args, ctx)` | Does the work and returns text for the model. Throw `ToolError` for a problem the model should see and handle. `ctx` has the workspace folder, an abort signal and the sandbox info. |

**Picking the tier.** Reading public information or the workspace: `'auto'`. Anything that sends a
message, changes or deletes something outside the workspace, spends money or reaches a private
service: `'ask'`. Anything experimental: `'never'`, so the owner opts in.

The example, [`examples/tools/weather-tool.ts`](../examples/tools/weather-tool.ts), looks up the
current weather from the free Open-Meteo API. The core of it:

The example describes every weather condition currently documented by Open-Meteo. Its test uses an
injected fake fetch, so the checks do not call a live service.

```ts
import { str, ToolError } from '../../src/tools/types.ts';
import type { Tool } from '../../src/tools/types.ts';

export function createWeatherTool(opts: { fetch?: typeof fetch; enabled?: () => boolean } = {}): Tool {
  const get = opts.fetch ?? fetch; // injected in tests
  return {
    defaultPermission: 'auto',               // read-only public data
    isAvailable: () => opts.enabled?.() ?? true,
    spec: {
      name: 'weather_now',
      description: 'Current weather for a city or place …',
      parameters: { type: 'object', properties: { place: { type: 'string' } }, required: ['place'], additionalProperties: false },
    },
    summarize: (a) => `weather in ${String(a.place ?? '?')}`,
    async run(args, ctx) {
      const place = str(args, 'place');      // throws a ToolError the model sees if missing
      // … fetch with ctx.signal, then return a short, factual sentence
    },
  };
}
```

**Register it** with one line next to the other tools in [`src/main.ts`](../src/main.ts):

```ts
tools.add(createWeatherTool({ enabled: () => true }));
```

**Test it** without the network by injecting a fake `fetch`; see the first test in
[`test/examples.test.ts`](../test/examples.test.ts). Also check that the registry offers it only
while it's available: `new ToolRegistry([]).enabled(undefined)`.

Tips:

- Keep results short; they go into the model's context. `clip()` in `types.ts` keeps the start and
  the end of long output.
- Tools that touch files must stay inside the workspace: use `resolveInside()` from
  [`src/tools/workspace.ts`](../src/tools/workspace.ts) (it refuses `..` and links that lead out).
- Tools that fetch URLs the model chose must refuse private addresses. Reuse the checks in
  `webFetchTool` in [`src/tools/builtin.ts`](../src/tools/builtin.ts).
- Secrets (API keys) go in the vault (`app.vault`), never in settings or in tool output. Tool
  output and arguments are scrubbed by `src/redact.ts`, but don't rely on it.
- Add a tip for any new setting to `web/tips.json`, and its English strings to the translation
  files (`node scripts/i18n-extract.ts` lists what's missing).

## Add a bridge

A bridge carries messages between a chat service and her. The real ones are
[`src/bridges/telegram.ts`](../src/bridges/telegram.ts) (long polling) and
[`src/bridges/discord.ts`](../src/bridges/discord.ts) (gateway WebSocket). The example
[`examples/bridges/line-bridge.ts`](../examples/bridges/line-bridge.ts) shows the same shape with
the chat service left out: a `Transport` with `send(chatId, text)`, and `receive(message)` for
each incoming message.

What every bridge does:

1. **Decide who is talking.** Owners are recognised by a stable user ID the owner typed in (or a
   one-time link code), never by a display name. Shared helpers for IDs and "was she called?" are
   in [`src/bridges/rules.ts`](../src/bridges/rules.ts).
2. **Pick the conversation.** The owner gets their own conversation (`partner: null`). Anyone else
   gets a **partner** conversation: `store.createConversation({ channel, channelKey, partner: name })`.
   Look them up with `store.findChannelConversation(channel, key, 'owner' | 'partner')` so the
   owner's and other people's conversations for the same chat never mix.
3. **Run one turn** with `runTurn(app, conversationId, text)` and collect the events: `notice`
   (the AI disclosure: send it), `token` (her reply), `replace` (a safety check replaced her
   reply), `approval` (only owners can approve tools), `error`.
4. **One turn per conversation at a time.** Queue messages per conversation.
5. **Send the reply** in pieces the service accepts (see `splitMessage()` in the Telegram bridge),
   paced like typing if you like (`src/bridges/pace.ts`).

**The partner rules are enforced in `runTurn`, not in the bridge:** in a partner conversation she
gets no tools (a tool call the model makes anyway is refused), no memory of the owner's life, no
adult content, and her own AI disclosure schedule for that person. That's why a bridge must never
call a model directly: the safety layer lives in `runTurn` and has no off switch.

Other things the real bridges do that a new one should consider: owner-only commands, an off-by-
default switch for answering people other than the owner, groups (answer only when mentioned),
voice notes (`speech.hearNote`), mirroring reminders to the owner's chat (subscribe to
`app.events`), and showing its status in Settings → Connections. Bot tokens go in the vault.

The second test in [`test/examples.test.ts`](../test/examples.test.ts) drives the example bridge
with the scripted fake model from `test/helpers.ts` and checks the owner/partner split.

## Add a character

A character is a JSON file (`"format": "sara-character"`, `"version": 1`) with a `persona`:
name, pronouns (`she`, `he` or `they`), age (**18 or older: the loader refuses anything else**),
summary, background, personality, speech and boundaries, plus optional dials (`traits`, 0–10),
`humour`, `life` details, `talk` style and `relationship`. The owner can export and import these
in Settings → Her → Name and personality (Save / Load a character file), so a character file is also the way to share one.

The example is [`examples/characters/ada-pair-programmer.json`](../examples/characters/ada-pair-programmer.json).
The dials and their meanings are listed in the in-app guide and in
[`src/traits.ts`](../src/traits.ts); unknown fields and dials are dropped on import.

**To add one to the built-in gallery** (the "Start from a character" cards), put the file in
[`persona/gallery/`](../persona/gallery/) with a `gallery` block:

```json
"gallery": { "pitch": "One line, at most 140 characters.", "tags": ["three", "short", "tags"] }
```

Gallery characters must be original (not based on a real person or someone else's character),
adults, not romantic or sexual by default, and ship without pictures (the owner's current look is
kept). `checkGalleryFile()` in [`src/gallery.ts`](../src/gallery.ts) enforces the format, and
`test/gallery-workmode.test.ts` checks every gallery file.

## Connect an MCP server

Sara has a built-in [Model Context Protocol](https://modelcontextprotocol.io) client
([`src/tools/mcp.ts`](../src/tools/mcp.ts)) for both stdio servers (a program she starts, inside
the sandbox where there is one) and streamable HTTP servers. Each tool the server lists becomes a
Sara tool called `mcp_<server>_<tool>`. Tools the server marks read-only
(`annotations.readOnlyHint`) run without asking; everything else asks first. The owner can change
either in Settings.

Add one in **Settings → Add-ons → Other programs (MCP)**: a name, stdio (command + arguments) or
HTTP (address), and any secret environment variables or headers (kept in the encrypted vault).

The example [`examples/mcp/hello-mcp-server.mjs`](../examples/mcp/hello-mcp-server.mjs) is a
complete stdio server in about 50 lines of plain Node (no SDK): it answers `initialize`,
`tools/list` and `tools/call` with JSON-RPC, one message per line. Try it with:

```
name: hello   transport: stdio   command: node   arguments: /path/to/sara/examples/mcp/hello-mcp-server.mjs
```

Any MCP server works the same way (for example the official GitHub or filesystem servers), as long
as its program is installed on the server.

The other way round, Sara is an MCP server herself (`/mcp`, for Claude Code, Cursor, Claude
Desktop) and speaks the OpenAI chat API (`/v1`, for SillyTavern, Open WebUI and scripts); she also
imports and exports character cards. See [OTHER_APPS.md](OTHER_APPS.md).

## Add a language

The app is translated with one JSON file per language in `web/i18n/`, keyed by the English text.
[docs/TRANSLATING.md](TRANSLATING.md) explains the rules (keep placeholders, use the name instead
of pronouns), how to find missing strings with `node scripts/i18n-extract.ts`, and how to add a new
language. `test/i18n.test.ts` fails on any gap, so a language stays complete. The AI disclosure is
legally required and is translated in [`src/i18n.ts`](../src/i18n.ts).

## Add a starter template

When the owner says "build me a Telegram bot / landing page / API / command-line tool / Python CLI", she starts
from a small tested template in [`templates/starters/`](../templates/starters/), copies it into the
workspace with the `starter_create` tool, and runs its tests as a background job before she
changes anything. A starter is a folder with:

| File | Purpose |
|---|---|
| `starter.json` | `title`, `description` (she reads it to pick one), `language`, `test` (command), `run` (command) |
| `README.md`, the code, `test/` | A small project that works and whose tests pass. `__PROJECT_NAME__` anywhere in a text file is replaced with the folder name. Python starters can use `unittest` from the standard library. |
| `CUSTOMISE.md` | Short notes for her: where the real work goes, which commands to run after a change |

The example [`examples/starters/word-counter/`](../examples/starters/word-counter/) is a complete
one. Copy the folder into `templates/starters/` to offer it; `test/examples.test.ts` shows how it is
listed, copied and tested (`listStarters()` and `copyStarter()` in [`src/starters.ts`](../src/starters.ts)).
Keep starters dependency-free where you can, so their tests run without a network.

The built-in Python command-line starter in [`templates/starters/python-cli/`](../templates/starters/python-cli/)
uses `argparse`, keeps pure work in `lib.py`, and tests it with `python3 -m unittest`.

## Add a model provider

Most model servers speak the OpenAI chat-completions API: add them in Settings → Models → Model
providers → Add or update a provider, Type **OpenAI-compatible**, with their address, no code needed. A truly different API needs an adapter in
[`src/providers/`](../src/providers/) implementing `Provider` from `src/providers/types.ts`
(`listModels()` and `stream(request)` yielding `text`, `tool_call` and `usage` events); see
`anthropic.ts` for a compact one and `test/providers.test.ts` for how adapters are tested against a
local mock server.

## Checking your work

```sh
npm run check                               # typecheck + every test, including the examples
node --test test/examples.test.ts           # just the examples
node scripts/public-export.ts --check-only  # no secrets or private details in what you added
```

Then open a pull request (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
