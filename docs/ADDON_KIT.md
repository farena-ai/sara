# The add-on kit: make, test and pack a Sara add-on (W3.1)

The add-on kit is part of the SDK package `@farena-ai/sara-sdk` (in this repository at
`packages/sara-sdk`). It gives you:

- **Typed helpers**: `defineTool`, `defineSetting`, `definePage` and `defineAddon`. You describe the
  add-on in code and the kit writes the manifest (`sara-plugin.json`) that Sara reads. The helpers
  refuse anything Sara would refuse, in the same words, while you write.
- **A template**: `sara-addon create my-addon` makes a working add-on folder with tests.
- **A test harness**: `sara-addon test` runs your add-on in its own permission-limited process and runs
  your tests against it. `sara-addon test --sara <checkout>` runs the same tests in a throwaway Sara
  with your add-on installed the way an owner installs it.
- **Pack**: `sara-addon pack` checks the folder against the store's rules and writes the store bundle
  and a listing file. It sends nothing. Submitting to the Sara Store is your own step, later, on your Sara.

An add-on is a Sara plugin, so everything in [PLUGINS.md](PLUGINS.md) still applies: the folder, the
manifest fields, the JSON channel, the fence, the review card. The kit is just an easier way to write one.

## The 10-minute tutorial

You need Node 22.18 or later (Node 24 is what Sara uses), and for steps 5 and 6 a Sara source folder
(a clone of this repository with `npm ci` done). Until the package is on npm, run the CLI from the
source folder. These are the commands we ran, in this order, on Windows (Node 24.20), on 2026-11-19.

```bash
# Until the package is published (afterwards: npx @farena-ai/sara-sdk create my-addon, then npx sara-addon …)
alias sara-addon='node ~/sara/packages/sara-sdk/src/cli.ts'
```

**1. Make the add-on (1 minute).**

```bash
sara-addon create my-addon --author "Ada Example"
cd my-addon
```

You get `main.mjs` (the add-on), `sara-plugin.json` (made from it), `tests/`, `shots/`, `CHANGES.md`,
`README.md` and the kit's runtime: `sara-addon.mjs`, `sara-addon.d.mts` (types for your editor) and
`sara-plugin.mjs` (the channel helper). The folder is complete as it is: Sara reads an add-on only
from its own folder and never runs `npm install` for it.

**2. Run its tests (1 minute).**

```bash
sara-addon test
```

```
Quick host (the add-on in its own process, Node permission flags, no network): my-addon 0.1.0
  ready: greet
ok 1 - greet says hello and shows the hello page as a card
ok 2 - Sara checks the arguments before the add-on sees them
ok 3 - the card's button calls the add-on's own tool again
# pass 3
```

**3. Add a tool (3 minutes).** Open `main.mjs`. Add a choice setting and a second tool above
`export default defineAddon({`, and list them in `defineAddon`:

```js
const style = defineSetting({
  key: 'style',
  type: 'choice',
  label: 'Goodbye style',
  tip: 'How the goodbye sounds: short is one word, warm adds a wish.',
  choices: ['short', 'warm'],
  default: 'warm',
});

const goodbye = defineTool({
  name: 'goodbye',
  description: 'Say goodbye to someone by name.',
  parameters: { type: 'object', properties: { name: { type: 'string', description: 'Who is leaving' } }, required: ['name'] },
  run: async (args, sara) => (sara.settings.style === 'short' ? `Bye, ${args.name}.` : `Goodbye, ${args.name}. Have a lovely evening!`),
});

// …and in defineAddon: tools: [greet, goodbye], settings: [greeting, style],
```

Add a test to `tests/my-addon.test.mjs`:

```js
test('goodbye is warm by default', async () => {
  const r = await callTool('goodbye', { name: 'Ada' });
  assert.equal(r.content, 'Goodbye, Ada. Have a lovely evening!');
});
```

**4. Test again (1 minute).** `sara-addon test` rebuilds `sara-plugin.json` from your code first
(`sara-addon build` does only that), then runs the tests: `# pass 4`.

**5. Test it inside Sara (1 minute).**

```bash
sara-addon test --sara ~/sara
```

```
Sara 3.31.0 (throwaway, in this process): installed my-addon 0.1.0 through the review card, switched on for main; Node permission flags, no OS sandbox here
  tools: my_addon__greet (asks first), my_addon__goodbye (asks first)
# pass 4
```

This boots a throwaway Sara from that source folder in the test process: a fresh data folder, the
real PluginManager staging your folder, the review, the install, your `tests/fakes.json` settings,
switching it on for the companion, and your tools running as registered Sara tools. It never touches
a running Sara or its data, and it makes no network calls.

**6. Look at it, and take a screenshot (2 minutes).**

```bash
sara-addon dev --sara ~/sara
```

It prints an address on 127.0.0.1 and the throwaway's owner token. Open it, sign in with the token,
start a chat and type `/try greet {"name": "Ada"}`. The scripted model calls your tool; Sara asks you
first (**Allow**); then the card shows under the step. Settings → Skills & tools → Plugins shows the
add-on, switched on. Save a screenshot of the card as `shots/card.png` (PNG, JPEG or WebP, up to 1 MB,
1 to 5 pictures). Ctrl+C stops it and deletes its data.

**7. Pack it (1 minute).**

```bash
sara-addon pack --sara ~/sara
```

```
✓ limits  ✓ manifest  ✓ secrets  ✓ shots  ✓ listing  ✓ kit
✓ Sara 3.31.0's own store checks (sara pack, fenced smoke test)
Wrote out/my-addon-0.1.0.sarapack.zip and out/my-addon-0.1.0.listing.json.
Ready for the store. Nothing was sent.
```

Without a screenshot, pack says *Add at least one screenshot* and is not ready. `--sara` adds Sara's
own `sara pack` checks (with the fenced smoke test) to the listing; without it the kit runs its own
copy of the store rules.

**8. Offer it (the owner's step, later).** Nothing in the kit sends anything. To offer the add-on on
the Sara Store, run `sara submit <folder> --name "Your name"` on your own Sara (or Get more → Submit
yours). The Sara team reviews it before anything is listed ([STORE.md](STORE.md)).

## Reference

### `defineTool({ name, description, parameters, permission, cost, run })`

A tool she can use, registered in Sara as `<id>__<name>` (`my_addon__greet`). `parameters` is a small
JSON schema (`type`, `properties`, `required`, `enum`); Sara checks the arguments before your code
sees them. `permission` is `ask` (the default; the owner approves each call) or `auto` (capped at ask
until the owner changes it in Settings → Tools). `run(args, sara)` returns text or
`{ content, card }`. `cost` is US dollars per call (or `null`: it costs money, the amount is unknown).

### `defineSetting({ key, type, label, tip, default, choices, min, max, advanced })`

A setting on the add-on's settings window: `text`, `number`, `switch`, `choice` or `secret`. Every
setting needs a `tip` (10 to 260 characters) that says what it does. Secrets are stored in the vault,
given to the add-on at start and never shown again. The values reach your code as `sara.settings`
(secrets as `sara.secrets`).

### `definePage({ id, title, render })`

A page is a card the add-on shows: under the tool's step (return it as `card`) or posted with
`sara.card(...)`. `render(data)` returns `{ lines, title?, image?, link?, buttons? }`; `page.card(data)`
clips it to Sara's card limits (title 120, 8 lines of 200, one https link, one picture from the folder,
up to 3 buttons). A button calls one of the add-on's own tools with `args`. Cards are shown as text:
no HTML or script from an add-on ever runs in Sara's page.

### `defineAddon({ id, name, version, description, … })`

The whole add-on: `tools`, `settings`, `pages`, `hooks` (`turn.before`, `tool.before`, `tool.after`,
`reply.after`), `schedules` (`{ id, every, at, run }`), `events` (`planner`, `job`, `webhook`, `board`),
`network`, `callTools`, `files`, `model`, `memory`, `i18n`, `init`, plus `author`, `license`,
`homepage`, `sara` (default `>=2.68.0`) and `main` (default `main.mjs`). The permissions in the
manifest come from what you use: tools add `tools`, pages add `cards`, settings add `settings`,
schedules add the `schedule` hook. Inside Sara, `defineAddon` starts the add-on; during
`sara-addon build` it hands over the manifest instead.

In TypeScript projects the same helpers and types come from `@farena-ai/sara-sdk/addon`.

### The `sara` object

`settings`, `secrets`, `lang`, `plugin`, `companion`, `fetch(url)`, `tool(name, args)`, `notify(text)`,
`card(card)`, `model(prompt, { maxTokens })`, `kv.get/set`, `notes()`, `log(text)`. The rules are in
[PLUGINS.md](PLUGINS.md) §6.

### Tests and fakes

`tests/harness.mjs` (written by `create`) has `callTool(name, args)` → `{ content, card, error }`,
`runHook(hook, data)`, `runSchedule(id)` and `sent()` (what the add-on asked Sara for). The quick host
answers the add-on's own calls from `tests/fakes.json`:

| Field | Answers |
|---|---|
| `settings`, `secrets`, `lang` | what `init` gives the add-on (settings start from their defaults) |
| `fetch` | `{ "https://api.example.com/x": { "status": 200, "body": "…" } }`; any other address fails: there is no network |
| `tools` | `{ "todo": "Added." }` for her tools in `callTools` (the owner's OK is assumed) |
| `model` | the text `sara.model()` answers (`null`: refused) |
| `notes` | what `sara.notes()` returns |

The quick host enforces the same limits as Sara where it can: Node's permission flags (only the
add-on folder and a scratch data folder), no global `fetch`, the network list, https only, the
argument check, the 30-second tool limit and the hook time limits. Hooks and schedules run only in
the quick host; `--sara` runs tools.

### Commands

| Command | What it does |
|---|---|
| `sara-addon create <name> [--dir <parent>] [--author "…"]` | a new add-on folder (refuses an existing one) |
| `sara-addon build [folder] [--check]` | `sara-plugin.json` from the code (`--check`: exit 1 when it is out of date) |
| `sara-addon test [folder] [--sara <checkout>]` | the tests against the quick host or a throwaway Sara |
| `sara-addon dev [folder] --sara <checkout> [--port <n>]` | the throwaway Sara in your browser until Ctrl+C |
| `sara-addon pack [folder] [--sara <checkout>] [--out <folder>]` | the store bundle and the listing file |
| `sara-addon update [folder]` | refreshes the kit's runtime files in the folder |

`SARA_SOURCE` can stand in for `--sara`.

### What pack writes

- `out/<id>-<version>.sarapack.zip`: the add-on as Sara's store reads it (everything except `tests/`,
  `out/`, `node_modules/` and editor files). `sara pack` and `sara submit` take it as it is.
- `out/<id>-<version>.listing.json` (`format: sara-addon-listing/1`): id, name, version, description,
  author, licence, homepage, the Sara range, the tools (with their registered names), the settings with
  their tips, the permissions in plain words, this version's lines from `CHANGES.md`, the screenshots
  (size, sha256), the bundle (size, sha256), `contentSha` (the fingerprint Sara pins at install), every
  check, `ready`, and with `--sara` the host's own report.

## Design (one page)

- **Extends what exists.** Add-ons are plugins (docs/PLUGINS.md, src/plugins/). The kit adds no host
  feature: its manifest is read by `parseManifest`, its runtime speaks through the existing channel
  helper `examples/plugins/sara-plugin.mjs` (embedded byte-equal; `node scripts/sdk-sync.ts` keeps it
  in sync and `--check` fails when it drifts), its bundle is the store's zip and hash format, and
  `pack --sara` calls the existing `sara pack` checks (src/store/pack.ts). Submitting stays
  `sara submit` (src/store/pack-cli.ts).
- **One source for the helpers.** `packages/sara-sdk/src/addon/kit.ts` holds the types and the
  functions. `create` writes those same functions into the add-on as `sara-addon.mjs`
  (runtime-source.ts serializes them with `Function#toString`), so what you test is what runs.
  `checkManifest` mirrors the host reader; a test compares the two on good and bad manifests.
- **Pages are cards.** Plugins have no pages of their own and no plugin HTML runs in Sara, so a page is
  a named card renderer with the card limits and own-tool buttons checked.
- **Two hosts, one test API.** The add-on's tests talk to a loopback bridge (bearer token, 127.0.0.1)
  with `callTool`/`runHook`/`runSchedule`/`sent`. Behind it is either the quick host (the JSON channel in
  the SDK, Node permission flags) or `src/addons/kit-host.ts`, which builds a throwaway app (fresh data
  folder, real PluginManager, real ToolRegistry, no network, no release lookups) and, for `dev`, serves
  the real web app with a scripted model (`/try <tool> {json}`).
- **No publishing.** No command uploads, signs or submits. The npm package itself is published by the
  owner (docs/NPM_PUBLISH.md); until then everything runs from the source folder by node path.
- **Code**: packages/sara-sdk/src/addon/{kit,runtime-source,plugin-helper,template,harness,pack,files}.ts,
  packages/sara-sdk/src/cli.ts, src/addons/kit-host.ts; tests in test/w3-addon-kit.test.ts.

## Limits

- The quick host's fence is Node's permission model, not a sandbox; Sara on Windows is the same (see
  PLUGINS.md §5). On Linux with bubblewrap, Sara fences add-ons more tightly than the quick host does.
- `--sara` and `dev` need a Sara source folder with `src/addons/kit-host.ts` (this version and later).
  Bridges, sockets (`connect`), webhooks and jobs (`permissions.run`) are not simulated by either host
  (`--sara` runs tools only); test those on a real install.
- The Plugins page of the `dev` server shows *Not available* under the store shelf: the throwaway has
  no Store connection.
