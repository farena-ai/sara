# Plugins: writing one for Sara

A **plugin** is a folder with a manifest (`sara-plugin.json`) and JavaScript code. The owner adds it
in **Settings → Abilities → Plugins** from a .zip, a git address or a folder on the server, reads its
review card, and switches it on per companion. It runs **in its own process**, with only the
permissions its manifest declares and the owner approved, and talks to Sara over **a small JSON
channel** on stdin/stdout. It can hook into turns, run on a schedule or on an event, and add tools,
cards, settings (each with a **?** tip) and chat bridges.

MCP servers stay as they are (tools from other programs). Plugins are the Sara-native path: they
also get hooks, cards, settings, schedules and bridges, without forking Sara.

**The promise to the owner:** she still follows her rules. A plugin can add a labelled note or a
card, or make a step ask the owner; it can never change her rules, her persona, her safety notes, her
replies, a tool result or a decision. Plugins never see private, partner, group, imported,
adult-channel (`-nsfw`) or other apps' conversations.

Examples: [`examples/plugins/hello-hooks`](../examples/plugins/hello-hooks) (a note before each turn,
a word filter on steps, a footer after replies) and
[`examples/plugins/weather-alerts`](../examples/plugins/weather-alerts) (a tool with a card, a note,
a morning schedule, a planner event, a secret setting; its host is a placeholder, so it answers with
demo forecasts). The design is `docs/design/STAPLES.md` §6.

---

## 1. The folder

```
weather-alerts/
  sara-plugin.json    the manifest (required, at the top)
  main.mjs            the code (ESM, run by Sara's own Node 24)
  sara-plugin.mjs     the optional helper (copy it from examples/plugins/)
  icon.png …          anything else it needs (pictures for its cards)
```

Limits on intake: a .zip up to 10 MB, 500 files, 30 MB unpacked, 5 MB per file, 10 folders deep. No
links of any kind, no `..`, no absolute paths. A content hash (sha256 over the sorted paths and bytes)
pins exactly what the owner reviewed; if the installed files change on disk, the plugin is switched
off until it is added and reviewed again.

The plugin may only read its own folder (and its data folder): put every file it imports inside it.
There is no `npm install`; use no dependencies or vendor them into the folder.

## 2. The manifest (`sara-plugin.json`)

```json
{
  "manifest": 1,
  "id": "weather-alerts",
  "name": "Weather alerts",
  "version": "1.2.0",
  "description": "Warns you about storms on days you have plans outside.",
  "author": "Ada Example", "license": "MIT", "homepage": "https://example.com/weather-alerts",
  "sara": ">=2.31.0",
  "main": "main.mjs",
  "permissions": {
    "hooks": ["turn.before", "reply.after", "schedule", "event:planner"],
    "tools": ["check"],
    "callTools": ["todo"],
    "network": ["api.weather.example"],
    "files": { "read": ["plugin-data"], "write": ["plugin-data"] },
    "settings": true,
    "cards": true,
    "bridges": [],
    "model": { "callsPerDay": 20, "tokensPerDay": 40000 },
    "memory": "none"
  },
  "schedules": [{ "id": "morning", "every": "1d", "at": "07:00" }],
  "settings": [
    { "key": "city", "type": "text", "label": "Your city", "tip": "Used to look up the forecast.", "default": "" },
    { "key": "apiKey", "type": "secret", "label": "Weather API key", "tip": "Stored encrypted; the plugin gets it at start." }
  ],
  "i18n": { "de": { "Your city": "Deine Stadt" } }
}
```

| Field | Rule |
|---|---|
| `manifest` | `1` |
| `id` | `a-z0-9-`, up to 48 characters, unique on the server |
| `version` | semantic version (`1.2.0`, `1.2.0-beta.1`); an update must raise it |
| `sara` | a range this server must satisfy: `>=2.31.0`, `^2.31.0`, `~2.31.1`, `2.31`, `>=2.31 <3`, `a \|\| b` |
| `main` | a `.mjs`/`.js` file inside the folder |
| `permissions.hooks` | `turn.before`, `tool.before`, `tool.after`, `reply.after`, `schedule`, `event:planner`, `event:job`, `event:webhook`, `event:board` |
| `permissions.tools` | tools it **adds** (`[a-z][a-z0-9_]*`, up to 20); registered as `<id>__<name>` with hyphens as underscores (`weather_alerts__check`) |
| `permissions.callTools` | Sara tools it may **call** (each call asks the owner) |
| `permissions.network` | exact public host names (port 443 implied), or `*.example.com` (one level). No IP literals, no private names (`localhost`, `.local`, `.lan`, `.internal`, `.home.arpa` …), no bare `*` |
| `permissions.files` | `read`: `plugin-data`, `workspace` (the main workspace, read only) or `none`; `write`: `plugin-data` or `none` |
| `permissions.settings` / `cards` | `true` to declare settings / show cards |
| `permissions.bridges` | chat channel names it carries (`["line"]`) |
| `permissions.model` | daily caps for model calls on the owner's *background* route (billed to the owner) |
| `permissions.memory` | `none` or `shared-notes` (non-private facts, read only) |
| `schedules` | up to 5; `every` like `15m`, `6h`, `1d` (never under 15 minutes), `at` `HH:MM` local time for day schedules; needs the `schedule` hook |
| `settings` | up to 20: `text`, `number` (`min`/`max`), `switch`, `choice` (`choices`), `secret`; **every setting needs a `tip`** (10–260 characters) |
| `i18n` | `es`, `fr`, `de`, `pt-BR`, `it`: English text → translation (labels, tips, the description) |

Install refuses an unknown field or permission, a hook outside the list, a setting without a tip,
a bad host, bad semver or a `sara` range this server doesn't satisfy, each with a plain reason.

## 3. Install and review (owner only)

1. *Add a plugin* → a .zip, an https git address (latest commit only, hardened clone: no hooks, no
   credential helper, no submodules, no LFS), or a folder on the server.
2. The **review card** lists every permission in plain words, riskiest first ("Can reach
   api.weather.example", "Sees what you write before each reply (it can add a note for her, it
   can't change her rules)", "Runs every day at 07:00", "Adds a tool: check (asks you first)"…),
   the author, version, license, the scan's findings (prompt-injection tells, data sent elsewhere,
   key-shaped strings), the files, the size and the fingerprint. Where the server can't fence the
   plugin in, it says **"This computer can't fence the plugin in. Only add plugins you trust."** and
   *Install* needs the tick **I trust this plugin's author**.
3. Installing switches nothing on. The owner switches it on per companion on its card.
4. **Updates** only come from *Check for updates* (the same git address or folder) or a new .zip:
   the same permissions → a short card; **more** permissions → the full card with the new lines
   marked. The previous version is kept for *Go back to …*.

Household members never see plugins: every `/api/plugins` route is owner-only. The demo server has
plugins off.

**From the Sara Store (2.57).** When a .zip's files are exactly the ones of a version in the Sara
Store's signed list, the review card adds one line: *From the Sara Store · Made by the Sara team* (or
*Reviewed by the Sara team* / *Not reviewed by people yet*). Any other file gets no line. If the store
later pulls that version, the plugin is switched off on every companion with the chip *Pulled from the
Sara Store: …* and nothing is deleted. See [STORE.md](STORE.md).

## 4. Hook points

Sara's own hooks (budget, plan check, sandbox gate, security, recall, the run recorder) run first;
plugins run after them, all at once, each with its own time limit. A plugin that is too slow,
crashes or answers bad JSON is skipped and the turn goes on; the step line says so ("Weather alerts
didn't answer in time (skipped)") and the plugin's log keeps it.

| Hook | When | The plugin gets | It may answer | Time limit |
|---|---|---|---|---|
| `turn.before` | once per turn, after the safety checks, before the first model call | `{ text, channel, companion, time }` (the text scrubbed of secrets) | `{ note }` (≤ 1,000 characters), shown to the model inside `<untrusted source="plugin <id>">` as data, not instructions | 1.5 s |
| `tool.before` | before each step that may run | `{ tool, args, permission }` (`auto` or `ask`: what Sara already decided) | `{ decision: "deny", reason }` or `{ decision: "ask", reason }` (turn an automatic step into a card). **Never** allow | 1 s |
| `tool.after` | after each step | `{ tool, status, result }` (scrubbed, ≤ 16 KB) | `{ card }` shown under the step | 3 s |
| `reply.after` | once, after the final reply (past the safety checks) | `{ reply, channel }` | `{ card }` and/or `{ note }` posted as *From Weather alerts* (never as her) | 5 s |
| `schedule` | at the manifest's times | `{ schedule }` | calls over the channel | 60 s |
| `event:planner` / `event:job` | when the owner's planner changes / a job changes | `{ event, data }`, ids only (`{ what }`, `{ id, status }`) | calls over the channel | 30 s |

Anything else in an answer (`reply`, `system`, `allow`, …) is dropped and logged. A note that trips
the minors check is dropped. Hooks never fire in private, partner, group, imported, `-nsfw`,
other apps' (`/v1`, MCP, Home Assistant, Alexa), replayed or eval turns, and never after the budget
stopped a turn.

## 5. The process and its fence

Each enabled plugin runs as one process per companion:

```
node --permission --allow-fs-read=<plugin dir> --allow-fs-read=<its data dir> --allow-fs-read=<plugin-host.mjs>
     --allow-fs-write=<its data dir> --max-old-space-size=128 --no-addons src/plugins/plugin-host.mjs <main>
```

No `--allow-child-process`, no `--allow-worker`, no `--allow-addons`; a minimal environment (no Sara
variables, no tokens); the working folder is its data folder (`<data>/plugin-data/<id>/<companion>/`).
`plugin-host.mjs` turns `console.*` into log messages and removes the global `fetch`, then loads
`main`.

**Node's permission model is a seat belt, not a sandbox** (the Node docs say it "does not protect
against malicious code", symbolic links are followed outside granted paths, and Node 24 has no
network permission). So the fence is layered:

- **Linux with bubblewrap**: inside the same kind of bubblewrap profile as commands, with no network
  namespace to the outside (`--unshare-all`, no `--share-net`), only its folders bound; Sara's data
  folder isn't there.
- **macOS**: inside a generated Seatbelt profile that denies the network and every file but its own.
- **Windows, or Linux without bubblewrap**: Node permissions only, so the plugin is not fenced in. The review card and the Plugins
  page say **Not fenced in**, and installing needs the *I trust this plugin's author* tick. (A real
  Windows fence is a BACKLOG research item.)
- **Network only through Sara**: `sara.fetch(url)` goes over the channel; Sara checks the manifest's
  host list (exact match or one `*.` level), https on port 443 only, public addresses only (the
  name is resolved once and the connection pinned to it), every redirect re-checked, a 1 MB answer
  cap, 30 requests a minute, and private local mode ("Nothing leaves this computer") refuses all.

Crashes restart after 1 s, 5 s, 30 s; **3 crashes in 10 minutes** and the plugin is switched off with
a notification. On Linux it is also killed above 256 MB of memory or 30 s of busy CPU in a minute.
Switching it off stops the process (it can't start children of its own).

A plugin can't read Sara's data folder (`owner.json`, the vault, the databases) or other people's
data; it gets only its own settings and its own secrets.

## 6. The JSON channel (version 1)

Newline-delimited JSON over stdin (Sara → plugin) and stdout (plugin → Sara). Every message has
`"v": 1` and a `type`; requests carry an `id`, unique per direction, and are answered with
`{"type": "result", "id": …}` or `{"type": "error", "id": …, "error": "…"}`.

```
→ {"v":1,"type":"init","plugin":"weather-alerts","companion":"main","lang":"en","settings":{…},"secrets":{"apiKey":"…"},"bridges":[]}
← {"v":1,"type":"ready","tools":[{"name":"check","description":"…","parameters":{…},"permission":"ask"}]}
→ {"v":1,"id":"h17","type":"hook","hook":"turn.before","data":{"text":"…","channel":"web"}}
← {"v":1,"id":"h17","type":"result","note":"Storm warning for Saturday afternoon."}
→ {"v":1,"id":"t3","type":"tool","name":"check","args":{"day":"2026-11-01"}}
← {"v":1,"id":"t3","type":"result","content":"…","card":{"title":"…","lines":["…"],"link":"https://…"}}
→ {"v":1,"id":"s4","type":"schedule","schedule":"morning"}
→ {"v":1,"id":"e5","type":"event","event":"planner","data":{"what":"tasks"}}
→ {"v":1,"type":"bridge.send","bridge":"line","chatId":"U123","text":"…"}
← {"v":1,"id":"c9","type":"call","op":"fetch","url":"https://api.weather.example/…"}
→ {"v":1,"id":"c9","type":"result","status":200,"contentType":"application/json","body":"…","truncated":false}
← {"v":1,"id":"c10","type":"call","op":"tool","name":"todo","args":{…}}
← {"v":1,"type":"log","level":"info","text":"…"}
```

Calls a plugin may make (`op`):

| op | Fields → answer | Rules |
|---|---|---|
| `fetch` | `url` → `status`, `contentType`, `body`, `truncated` | GET only in v1; the network rules above |
| `tool` | `name`, `args` → `ok`, `content` | only names in `callTools`; **every call asks the owner** on the Plugins page (*Allow once* / *Don't*, 10 minutes); a tool set to *never* is refused |
| `notify` | `text` (≤ 300) → `ok` | a notification and a labelled note in the owner's latest chat |
| `card` | `card` → `ok` | needs `cards`; posted labelled in the owner's latest chat |
| `model` | `prompt`, `maxTokens` → `text` | needs `model`; counted against `callsPerDay`/`tokensPerDay` (the budget ledger, `plugin:<id>`) |
| `kv.get` / `kv.set` | `key`, `value` | its own small store: 200 keys, 64 KB a value |
| `memory.notes` | → `notes` | needs `memory: "shared-notes"`: facts that other apps may see, read only |
| `bridge.inbound` | `bridge`, `chatId`, `from`, `text` → `ok`, `conversation` | needs the bridge in `bridges` (§8) |

Caps: **1 MB per line** (longer lines are dropped whole), **100 calls a minute**, **8 calls in
flight**; unknown types are dropped; a line that isn't JSON is dropped and logged.

### The helper (`sara-plugin.mjs`)

[`examples/plugins/sara-plugin.mjs`](../examples/plugins/sara-plugin.mjs) is one file with no
dependencies that wraps the channel. Copy it into your folder:

```js
import { plugin } from './sara-plugin.mjs';

plugin({
  tools: [{
    name: 'check',
    description: 'Weather alerts for a day.',
    parameters: { type: 'object', properties: { day: { type: 'string' } } },
    run: async (args, sara) => ({ content: 'No alerts.', card: { title: 'Weather', lines: ['No alerts'] } }),
  }],
  hooks: {
    'turn.before': async (data, sara) => ({ note: 'It may rain later.' }),
    'tool.before': async (data, sara) => (/prod/.test(JSON.stringify(data.args)) ? { decision: 'deny', reason: 'mentions prod' } : {}),
    'reply.after': async (data, sara) => ({ note: `${data.reply.split(/\s+/).length} words.` }),
  },
  schedules: { morning: async (sara) => { await sara.notify('Good morning.'); } },
  events: { planner: async (data, sara) => {} },
  bridges: { line: { send: async ({ chatId, text }, sara) => { /* deliver it */ } } },
  init: async (sara) => {},
});
```

`sara` has `settings`, `secrets`, `lang`, `plugin`, `companion`, `fetch(url)`, `tool(name, args)`,
`notify(text)`, `card(card)`, `model(prompt, { maxTokens })`, `kv.get(key)`, `kv.set(key, value)`,
`notes()`, `bridgeInbound({ bridge, chatId, from, text })` and `log(text, level)`.

## 7. Tools, cards and settings

- **Tools** are registered as `<id>__<name>` with the source *Plugin: <name>* in Settings → Tools.
  Their permission is the manifest's **capped at ask** until the owner changes it there. Arguments
  are checked against the tool's schema (`type`, `required`, property types, `enum`) before the call
  reaches the plugin. Plugin tools are only offered in the owner's own conversations: never to
  other apps (`/v1`, MCP), peers, webhooks, partner or private conversations.
- **Cards** are data in Sara's card schema: `title` (≤ 120), up to 8 `lines` (≤ 200 each), one
  `image` from the plugin's own folder (png, jpg, gif, webp; served by Sara), one https `link`, up to
  3 `buttons` (`{ label, tool, args }`, each calling one of the plugin's own tools when the owner
  clicks). Everything is shown as text: **no plugin HTML or script ever runs in the page.**
- **Settings** show on the plugin's *Settings and log* window per companion, each with its **?** tip
  (translated through the manifest's `i18n`, English fallback). `secret` settings are stored in the
  vault as `plugin:<id>:<key>`, write-only in the app, given to the plugin in `init`, and never
  returned by the API. Changing settings restarts the plugin with them.

## 8. Chat bridges

A plugin that declares `"bridges": ["line"]` can carry a chat service. Inbound messages arrive with
`bridge.inbound { bridge, chatId, from, text }` and run as a normal bridge turn: the owner lists his
own chat ids on the plugin's settings (those chats are him); *Let other people talk to her there*
(off by default) gives everyone else her partner chat (no tools, no memory, no adult content, the AI
notice first). Messages from chats that aren't paired are ignored and logged. Her reply (and the AI
notice or crisis help, first) is sent back as `{"type": "bridge.send"}`. The conversation channel is
`plugin-<bridge>`; the plugin never sees other channels.

### Pictures and files (contract v1.1, 2.48.0)

v1 plugins stay text-only and keep working unchanged. A plugin that wants pictures and files needs
both:

- `"bridgeFiles": true` in `permissions` (only with at least one entry in `bridges`; the add card says
  *Can send and receive pictures and files in its chats*), and
- the opt-in in its `ready` message: `"bridge": {"files": true, "edit": true, "maxBytes": 20000000}`
  (`edit` lets Sara edit her progress message in place; `maxBytes` is capped at 20 MB).

Files travel in chunks: `{"type": "bridge.file", "bridge", "chatId", "fileId", "seq", "last", "data"}`
with `data` base64 and at most 512 KB per chunk, in order, complete within 60 s. The first chunk
also carries `name`, `mime` and `size`. Then `bridge.inbound` names them:
`{"files": [{"fileId": "…"}], "text": "caption"}` (up to 5). Pictures are checked like any other
upload (type by magic bytes, the minors check); pictures from other people follow *Look at pictures
other people send* (off by default). Outbound, Sara sends `bridge.send` with
`files: [{fileId, name, mime, size}]` followed by the `bridge.file` chunks. Without the permission or
the opt-in she sends one text line instead (*I kept that in the app …*). The SDK's
`sara.sendFile({ bridge, chatId, from, text, name, mime, data })` does the chunking for you.

### Long turns (2.50.0, every plugin bridge)

A turn is no longer cut at 5 minutes. At 5 minutes a chat app gets one line (*Still working on it.
I'll send the answer when it's done.*) unless the progress message is showing, and the **whole**
reply is sent when the turn ends (its budget and `/stop` still end it). One-message bridges get
nothing at 5 minutes. 2.49 sent a partial answer there and dropped the rest.

### Contract v1.2 (2.50.0, opt-in)

v1 and v1.1 plugins keep working exactly as before (apart from the long-turn fix above). `init`
now says `bridgeApi: 3` and `bridgeFeatures` (`files`, `edit`, `places`, `typing`, `react`, `log`,
`threads`, `oneMessage`, `link`, and `net` when the plugin has `connect`). A plugin opts in with
more fields in `ready.bridge`:

| Field | Meaning |
|---|---|
| `places: true` | `bridge.inbound` may say `chat: {kind: 'group', title, members?, ownerIn?}`: a group is a room. She answers there only when called (`addressed`, `replyToHer`, or her name with *Answer when her name is said*), only in groups he is in or switched on by hand; with *Owners can use her tools in groups* his calls are `work-room`. Group lines go in as `[name]: text`. |
| `link: true` | Owner linking with a code (below). |
| `typing: true` | Sara sends `{type:'bridge.typing', chatId, on}` around a turn. |
| `react: true`, `ack: 'react' \| 'line' \| 'none'` | A steer or queued message is acknowledged with `{type:'bridge.react', chatId, messageId, emoji:'👀'}` instead of a line. |
| `log: true` | The plugin may send group lines one way as `{type:'bridge.log', chatId, messageId, fromId, from, who, text, replyTo?, at?, edited?, deleted?}`; Sara keeps them only where *Keep up with this room* reads. |
| `oneMessage: true` | Notices, lines, the reply and her files go out as **one** `bridge.send` (for email). |
| `threads: true` | Reserved for email threads (part B). |
| `editLimit`, `editEveryMs` | The progress message's budget: at most `editLimit − 2` live edits (the last says *… and more steps*), one spare, then the final line; edits at least `editEveryMs` apart (≥ 3 s). Signal says 9 and 15000. |
| `textMax` | The longest message the platform takes (the plugin splits). |

`bridge.inbound` grows: `messageId` (≤ 120), `fromId` (a stable sender id: Signal's ACI, a
lower-cased address), `chat`, `addressed`, `replyToHer`, `replyTo`, `lang` (the sender's language),
`identity` (the sender's safety number or key fingerprint, compared with the pinned one) and, for
email, `auth: {result: 'aligned' | 'unaligned' | 'none', authserv}`. `bridge.send` grows `replyTo`
(quote it), `thread` and `subject`. Other one-way plugin → Sara lines (their own budget, 600 a
minute, no answer): `bridge.sent {ref?, messageId}`, `bridge.status {state: connecting | ok | paused
| error, detail}` (the status chip) and `bridge.skip {reason, from}` (the *Ignored today* counts,
ids only). Sara → plugin: `bridge.trust {chatId}` (the owner pressed *It's me*), `bridge.leave
{chatId}` (*Leave this group*) and the request `bridge.test` (answer `{steps: [{label, ok, fix?}]}`,
≤ 10, 30 s; *Test* on the settings page).

**Owner linking.** *Link my …* on the plugin's settings gives a 6-digit code for 10 minutes (5 wrong
tries and it's gone). The owner sends `/link 123456` (an email subject `Link 123456`) from his own
account; Sara takes it before the pairing check, adds the chat to `ownerChats` and the sender to
`ownerIds`, and pins `identity` when the plugin gave one. A later message from him with another
identity pauses his owner powers on that bridge (partner turn, no tools, one line) until he presses
*It's me* (or *Unlink*). With `auth` present the link and every owner turn need `aligned`. Typing
chat ids by hand still works.

**Strangers.** With *Let other people talk to her* off, a v1.2 plugin's stranger gets one line per
private chat (*I only chat with the person who runs me here.*), then nothing; skips are counted.

**Sender checks and threads (email, 2.50.0 part B).** A bridge whose messages carry `auth` is a
sender-check bridge: `auth: {headers: [{authserv, result: 'aligned'|'unaligned'|'none', method}]}`
lists every Authentication-Results reading, top first. Sara uses the topmost one carrying the
provider id learned at linking (`bridge.authserv`; *Check my sender* re-learns it), so a header a
sender wrote into the mail is ignored. On such a bridge the allow-list (`bridge.allow`: addresses
and `@domains`) means nobody when empty, and partners must pass the check too. Before reading a
message a plugin may ask `call op:'bridge.who' {bridge, chatId, fromId, auth, subject}` → `{who:
'owner'|'partner'|'link'|'none', reason?}`; Sara counts the skip itself (the helper:
`sara.bridgeWho(…)`). With `threads` in `ready`, `thread: {id, subject?}` on `bridge.inbound` makes
one session per thread (`bridge_threads`), and her one-message reply carries `thread` and
`replyTo` (the message she answers). `forwarded: '<text>'` on `bridge.inbound` is someone else's
text: Sara fences it (`FORWARDED`), saves the message with `meta.untrusted`, and every tool that
would run on its own asks first in that turn. An `email` bridge also refuses the owner's own
mailbox in its settings (`address`/`username` equal to a linked address, the Google account or the
email MCP server's address).

### Sockets (`permissions.connect`, 2.50.0)

A plugin never opens a socket (on a fenced host it can't). Sara holds it:

```json
"connect": [{ "id": "daemon", "host": "setting:daemon", "ports": "setting", "where": "local", "tls": "none" }]
```

- `host` is always `setting:<key>`, one of its own text settings: the owner types the address and
  Sara reads it when the socket opens. A host the plugin names in `net.open` is ignored (logged).
- `where: "local"`: loopback only; private addresses (RFC 1918, fc00::/7, a Docker network) only
  when its `onOtherMachine` switch (which must start off) is on; public addresses never.
  `where: "public"`: public addresses only. `tls: "none"` only with `local`.
- `ports`: a list (≤ 6), or `"setting"` (local only: the port comes from the same setting).
- `tls: "required"`: implicit TLS, or on 143 and 587 Sara does STARTTLS herself (IMAP `a0 STARTTLS`,
  SMTP `EHLO` + `STARTTLS`) and hands over only the encrypted socket (`tls.starttls`, `greeting`).
  Certificates are always checked against the host; nothing turns that off.
- The name is resolved once and the socket pinned to the first address; every address must pass.
- Calls: `net.open {endpoint, port?}` → `{socket, tls?, greeting?}`; `net.write {socket, data}`
  (base64, ≤ 256 KB; its own budget of 600 writes and 16 MB a minute); `net.close {socket}`. Sara
  sends `{type:'net.data', socket, data}` and `{type:'net.closed', socket, reason}`.
- Caps: 4 sockets; reads pause while the plugin is more than 4 MB behind; idle sockets close after
  35 minutes; every open and close is in its log. Private local mode refuses `net.open` and closes
  open sockets. A plugin with `connect` runs for one companion at a time.
- The card says *Connects to a program on this computer at the address (and port) you give it in …*
  or *Connects to the server you give it in … (ports …, always encrypted)*; a new endpoint or port is
  an addition (the full card).
- The helper: `const s = await sara.net.open('daemon'); s.onData(fn); s.onClose(fn); await
  s.write(bytes); await s.close()`.
- Tests only: a loopback stand-in for a `public` mail endpoint needs `SARA_TEST_ALLOW_LOOPBACK_MAIL=1`
  (or `netTestLoopback` under `node --test`); see docs/EMAIL_BRIDGE.md. Never on by default.

### Plugins that come with Sara (origin `builtin`)

`plugins/` at the top of Sara holds the first-party plugins (Signal and Email). `GET
/api/plugins/builtin` lists them; `POST /api/plugins/install {builtin: 'signal'}` stages one and
shows **the same review card** with *Comes with Sara · made by the Sara team*. Nothing installs or
switches on by itself; on an unfenced host the trust tick is still required. When Sara ships a newer
version, the shelf shows *Update available* and *Check for updates* re-reads the bundled folder.
Their `sara-plugin.mjs` is the same file as `examples/plugins/sara-plugin.mjs`.

## 9. Testing your plugin

- Run Sara with a scratch data folder, add your plugin from *A folder on this server*, read the
  card, switch it on and watch *Settings and log*.
- The log shows every hook, tool, call, refusal, crash and timeout, scrubbed of secrets.
- `test/phase98.test.ts` has the patterns (a fake model, a real plugin process) and the hostile
  fixture (`test/fixtures/plugins/hostile/`) that tries everything a plugin must not do.
