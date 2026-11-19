// W3.1: the files `sara-addon create <name>` writes. A working add-on (a tool, a setting with its
// ? tip, a page shown as a card), its tests, and the vendored runtime, so the folder is complete
// as it is: Sara reads an add-on only from its own folder and never runs npm install for it.
import { PLUGIN_HELPER } from './plugin-helper.ts';
import { runtimeSource, RUNTIME_DTS } from './runtime-source.ts';
import { DEFAULT_SARA } from './kit.ts';

export interface TemplateOptions {
  id: string;
  author?: string;
  sdkVersion?: string;
}

/** "my-addon" → "My addon". */
export const titleOf = (id: string): string => {
  const words = id.replace(/-/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The runtime files (`create` and `update` write these). */
export function runtimeFiles(sdkVersion = ''): Record<string, string> {
  return { 'sara-addon.mjs': runtimeSource(sdkVersion), 'sara-addon.d.mts': RUNTIME_DTS, 'sara-plugin.mjs': PLUGIN_HELPER };
}

export function templateFiles(o: TemplateOptions): Record<string, string> {
  const name = titleOf(o.id);
  const author = (o.author ?? '').replace(/[\\'\n\r]/g, '').trim();
  const main = `// @ts-check
// ${name}: a Sara add-on made with the add-on kit (docs/ADDON_KIT.md in the Sara repository).
// Change the code, then: sara-addon test (it runs tests/), sara-addon pack (the store bundle).
import { defineAddon, definePage, defineSetting, defineTool } from './sara-addon.mjs';

// A setting the owner fills in on the add-on's settings window. Every setting needs a ? tip.
const greeting = defineSetting({
  key: 'greeting',
  type: 'text',
  label: 'Greeting',
  tip: 'The word she starts each hello with, for example Hi or Good morning.',
  default: 'Hello',
});

// A page is a card Sara shows under the step (text only: no HTML or script ever runs).
// Its buttons may only call this add-on's own tools.
const helloPage = definePage({
  id: 'hello',
  title: 'Hello',
  render: (/** @type {{ name: string, text: string }} */ d) => ({
    lines: [d.text],
    buttons: [{ label: 'Say it again', tool: 'greet', args: { name: d.name } }],
  }),
});

// A tool she can use. Sara checks the arguments against \`parameters\` and asks the owner first.
const greet = defineTool({
  name: 'greet',
  description: 'Say hello to someone by name.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Who to greet' } },
    required: ['name'],
  },
  run: async (args, sara) => {
    const who = String(args.name);
    const text = \`\${sara.settings.greeting || 'Hello'}, \${who}!\`;
    return { content: text, card: helloPage.card({ name: who, text }) };
  },
});

export default defineAddon({
  id: '${o.id}',
  name: '${name}',
  version: '0.1.0',
  description: 'Says hello to someone by name and shows it as a card.',
${author ? `  author: '${author}',\n` : ''}  license: 'MIT',
  sara: '${DEFAULT_SARA}',
  tools: [greet],
  settings: [greeting],
  pages: [helloPage],
});
`;
  const harness = `// The add-on's side of \`sara-addon test\` (no dependencies). The test host starts your add-on in
// its own permission-limited process, exactly as Sara does, and answers these calls. With
// \`--sara <folder>\` the host is a throwaway Sara with your add-on installed. Fakes: fakes.json.
const url = process.env.SARA_ADDON_URL;
const token = process.env.SARA_ADDON_TOKEN ?? '';
/** 'quick' (the channel host) or 'sara' (a throwaway Sara in the test process). */
export const host = process.env.SARA_ADDON_HOST ?? '';

async function ask(path, body) {
  if (!url) throw new Error('Run these tests with \`sara-addon test\`: it starts your add-on and a test host.');
  const r = await fetch(\`\${url}\${path}\`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: \`Bearer \${token}\` }, body: JSON.stringify(body ?? {}) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? \`HTTP \${r.status}\`);
  return j;
}

/** Calls one of your tools as Sara would → { content, card?, error?, warnings? }. */
export const callTool = (name, args = {}) => ask('/tool', { name, args });
/** Runs a hook (turn.before, tool.before, tool.after, reply.after) → its answer. Quick host only. */
export const runHook = (hook, data = {}) => ask('/hook', { hook, data });
/** Runs a schedule now. Quick host only. */
export const runSchedule = (id) => ask('/schedule', { id });
/** What the add-on asked Sara for so far: notify, card, fetch, tool, model, kv, log. */
export const sent = () => ask('/sent', {});
`;
  const test = `import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool } from './harness.mjs';

test('greet says hello and shows the hello page as a card', async () => {
  const r = await callTool('greet', { name: 'Ada' });
  assert.equal(r.content, 'Hello, Ada!');
  assert.equal(r.card.title, 'Hello');
  assert.deepEqual(r.card.lines, ['Hello, Ada!']);
});

test('Sara checks the arguments before the add-on sees them', async () => {
  const r = await callTool('greet', {});
  assert.match(r.error, /name/);
});

test("the card's button calls the add-on's own tool again", async () => {
  const first = await callTool('greet', { name: 'Bo' });
  const [button] = first.card.buttons;
  const again = await callTool(button.tool, button.args);
  assert.equal(again.content, 'Hello, Bo!');
});
`;
  const fakes = `${JSON.stringify({ lang: 'en', settings: {}, secrets: {}, fetch: {}, tools: {}, model: null, notes: [] }, null, 2)}\n`;
  const readme = `# ${name}

A Sara add-on made with the add-on kit (\`@farena-ai/sara-sdk\`). The tutorial and the reference are
docs/ADDON_KIT.md in the Sara repository.

| File | What it is |
|---|---|
| \`main.mjs\` | the add-on: tools, settings and pages, written with the kit's helpers |
| \`sara-plugin.json\` | the manifest Sara reads, made from main.mjs by \`sara-addon build\` (do not edit by hand) |
| \`sara-addon.mjs\`, \`sara-addon.d.mts\`, \`sara-plugin.mjs\` | the kit's runtime and types (refresh with \`sara-addon update\`) |
| \`tests/\` | your tests, run by \`sara-addon test\` (not packed) |
| \`shots/\` | 1 to 5 screenshots (PNG, JPEG or WebP, up to 1 MB) for the store listing |
| \`CHANGES.md\` | what's new in each version (the store shows it) |

    sara-addon test            # the quick host: your add-on in its own permission-limited process
    sara-addon test --sara ~/sara   # a throwaway Sara (a checkout) with your add-on installed
    sara-addon dev --sara ~/sara    # the same Sara in your browser until you press Ctrl+C
    sara-addon pack            # out/<id>-<version>.sarapack.zip and out/<id>-<version>.listing.json

Packing sends nothing. Offering it on the Sara Store is a separate step on your own Sara:
\`sara submit <folder> --name "Your name"\` (or Get more → Submit yours).
`;
  const changes = `# Changes\n\n## 0.1.0\n\nFirst version: the greet tool, the Greeting setting and the hello card.\n`;
  const jsconfig = `${JSON.stringify({ compilerOptions: { checkJs: true, allowJs: true, noEmit: true, strict: true, target: 'es2022', lib: ['es2022'], module: 'nodenext', moduleResolution: 'nodenext', types: [] }, include: ['main.mjs'] }, null, 2)}\n`;
  return {
    'main.mjs': main,
    ...runtimeFiles(o.sdkVersion),
    'tests/harness.mjs': harness,
    [`tests/${o.id}.test.mjs`]: test,
    'tests/fakes.json': fakes,
    'README.md': readme,
    'CHANGES.md': changes,
    'jsconfig.json': jsconfig,
    '.gitignore': 'out/\nnode_modules/\n',
  };
}
