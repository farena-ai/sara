// W3.1 (docs/ADDON_KIT.md): the add-on kit in packages/sara-sdk. Typed defineTool / defineSetting /
// definePage / defineAddon that build a manifest Sara's own reader accepts, the `create` template,
// the local test harness (a quick channel host, and a throwaway in-process Sara with the add-on
// installed through the real PluginManager) and `pack` (the store bundle and a listing file; the
// host's own `sara pack` checks accept the bundle). Nothing here publishes or submits anything.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { buildManifest, checkManifest, defineAddon, definePage, defineSetting, defineTool, KitError } from '../packages/sara-sdk/src/addon/kit.ts';
import { PLUGIN_HELPER } from '../packages/sara-sdk/src/addon/plugin-helper.ts';
import { runtimeSource, RUNTIME_DTS } from '../packages/sara-sdk/src/addon/runtime-source.ts';
import { hashFiles as kitHash, readAddonFiles, zipStored as kitZip } from '../packages/sara-sdk/src/addon/files.ts';
import { fromZip, hashFiles } from '../src/packages.ts';
import { parseManifest } from '../src/plugins/manifest.ts';
import { PLUGIN_LIMITS } from '../src/plugins/manager.ts';
import { packPath } from '../src/store/pack.ts';
import { splitListing } from '../src/store/checks.ts';
import { ROOT, tempDir } from './helpers.ts';

const SARA_VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const CLI = join(ROOT, 'packages', 'sara-sdk', 'src', 'cli.ts');
const NODE = process.execPath;
const { dir, cleanup } = tempDir();
after(cleanup);

const cli = (args: string[], cwd = dir, env: Record<string, string> = {}) => {
  const r = spawnSync(NODE, ['--disable-warning=ExperimentalWarning', CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000, env: { ...process.env, NODE_TEST_CONTEXT: '', ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

/** A real 2x2 PNG made here (a screenshot stand-in for the listing checks). */
function png(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------ typed helpers → manifest
test('defineTool / defineSetting / definePage / defineAddon build a manifest Sara itself accepts', () => {
  const units = defineSetting({ key: 'units', type: 'choice', label: 'Units', tip: 'Celsius or Fahrenheit in every answer.', choices: ['C', 'F'], default: 'C' });
  const key = defineSetting({ key: 'apiKey', type: 'secret', label: 'API key', tip: 'Stored encrypted; the add-on gets it at start.' });
  const page = definePage({ id: 'forecast', title: 'Forecast', render: (d: { city: string; temp: number }) => ({ lines: [`${d.city}: ${d.temp}°`], buttons: [{ label: 'Again', tool: 'check', args: { city: d.city } }] }) });
  const check = defineTool({
    name: 'check',
    description: 'The forecast for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string', description: 'A city' } }, required: ['city'] },
    run: async (a: { city: string }) => ({ content: `${a.city} is fine`, card: page.card({ city: a.city, temp: 20 }) }),
  });
  const addon = defineAddon({
    id: 'weather-kit',
    name: 'Weather kit',
    version: '1.0.0',
    description: 'Checks the forecast for a city and shows it as a card.',
    author: 'Ada Example',
    license: 'MIT',
    sara: '>=2.68.0',
    tools: [check],
    settings: [units, key],
    pages: [page],
    network: ['api.weather.example'],
    hooks: { 'turn.before': async () => ({ note: 'It may rain.' }) },
    schedules: [{ id: 'morning', every: '1d', at: '07:00', run: async () => {} }],
    events: { planner: async () => {} },
    i18n: { de: { Units: 'Einheiten' } },
  });
  const m = buildManifest(addon);
  assert.deepEqual(checkManifest(m), []);
  const parsed = parseManifest(JSON.stringify(m), { saraVersion: SARA_VERSION, files: ['main.mjs'] });
  assert.equal(parsed.id, 'weather-kit');
  assert.deepEqual(parsed.permissions.tools, ['check']);
  assert.deepEqual([...parsed.permissions.hooks].sort(), ['event:planner', 'schedule', 'turn.before']);
  assert.equal(parsed.permissions.settings, true);
  assert.equal(parsed.permissions.cards, true, 'pages are cards: it declares cards');
  assert.deepEqual(parsed.permissions.network, ['api.weather.example']);
  assert.deepEqual(parsed.schedules, [{ id: 'morning', every: '1d', at: '07:00' }]);
  assert.equal(parsed.settings.length, 2);
  // A page renders a bounded card; its buttons may only call the add-on's own tools.
  const card = page.card({ city: 'Lyon', temp: 9 });
  assert.deepEqual(card, { title: 'Forecast', lines: ['Lyon: 9°'], buttons: [{ label: 'Again', tool: 'check', args: { city: 'Lyon' } }] });
  const long = definePage({ id: 'long', title: 'x'.repeat(200), render: () => ({ lines: ['y'.repeat(500)] }) }).card({});
  assert.equal(long.title.length, 120);
  assert.equal(long.lines[0].length, 200);
});

test('the helpers refuse what Sara would refuse, in plain words', () => {
  assert.throws(() => defineSetting({ key: 'city', type: 'text', label: 'City', tip: 'short' }), (e: unknown) => e instanceof KitError && /needs a \? tip/.test((e as Error).message));
  assert.throws(() => defineSetting({ key: 'k', type: 'secret', label: 'Key', tip: 'Stored encrypted for you.', default: 'x' } as never), /can't have a default/);
  assert.throws(() => defineTool({ name: 'Bad-Name', description: 'x', run: () => 'x' }), /lower-case letters, digits and _/);
  assert.throws(() => definePage({ id: 'p', title: 'P', render: () => ({ lines: Array(9).fill('a') }) }).card({}), /at most 8 lines/);
  const t = defineTool({ name: 'one', description: 'One.', run: () => 'ok' });
  const p = definePage({ id: 'p', title: 'P', render: () => ({ lines: ['a'], buttons: [{ label: 'Go', tool: 'other' }] }) });
  const a = defineAddon({ id: 'p-test', name: 'P', version: '1.0.0', description: 'A page whose button calls a tool it lacks.', tools: [t], pages: [p] });
  assert.ok(a);
  assert.throws(() => p.card({}), /isn't one of this add-on's tools/);
  assert.throws(() => defineAddon({ id: 'Bad Id', name: 'x', version: '1.0.0', description: 'x', tools: [] }), /lower-case letters, digits and hyphens/);
  assert.throws(() => defineAddon({ id: 'two', name: 'x', version: '1.0', description: 'x', tools: [] }), /semantic version/);
  assert.throws(() => defineAddon({ id: 'two', name: 'x', version: '1.0.0', description: 'x', tools: [t, t] }), /listed twice/);
  assert.throws(() => defineAddon({ id: 'two', name: 'x', version: '1.0.0', description: 'x', network: ['api.example.local'] }), /private or local name/);
});

test('checkManifest agrees with the host reader on good and bad manifests', () => {
  const base = { manifest: 1, id: 'demo', name: 'Demo', version: '1.0.0', description: 'A demo add-on for the parity test.', main: 'main.mjs', permissions: { tools: ['go'] } };
  const cases: Record<string, unknown>[] = [
    base,
    { ...base, extra: 1 },
    { ...base, manifest: 2 },
    { ...base, id: 'Demo' },
    { ...base, version: 'v1' },
    { ...base, main: '../x.mjs' },
    { ...base, main: 'main.py' },
    { ...base, permissions: { tools: ['go'], hooks: ['turn.after'] } },
    { ...base, permissions: { tools: ['Go'] } },
    { ...base, permissions: { network: ['*'] } },
    { ...base, permissions: { network: ['10.0.0.1'] } },
    { ...base, permissions: { network: ['api.example.lan'] } },
    { ...base, permissions: { network: ['*.example.com'] } },
    { ...base, permissions: { nope: true } },
    { ...base, settings: [{ key: 'a', type: 'text', label: 'A', tip: 'A tip that is long enough.' }] },
    { ...base, permissions: { settings: true }, settings: [{ key: 'a', type: 'text', label: 'A', tip: 'short' }] },
    { ...base, permissions: { settings: true }, settings: [{ key: 'a', type: 'colour', label: 'A', tip: 'A tip that is long enough.' }] },
    { ...base, permissions: { settings: true }, settings: [{ key: 'a', type: 'choice', label: 'A', tip: 'A tip that is long enough.', choices: ['x'], default: 'y' }] },
    { ...base, permissions: { hooks: ['schedule'] }, schedules: [{ id: 'often', every: '5m' }] },
    { ...base, schedules: [{ id: 'day', every: '1d' }] },
    { ...base, permissions: { hooks: ['schedule'] }, schedules: [{ id: 'day', every: '1d', at: '25:00' }] },
    { ...base, i18n: { nl: {} } },
    { ...base, homepage: 'http://example.com' },
  ];
  for (const c of cases) {
    let host = true;
    try {
      parseManifest(JSON.stringify(c), { saraVersion: SARA_VERSION, files: ['main.mjs'] });
    } catch {
      host = false;
    }
    const kit = checkManifest(c, { files: ['main.mjs'] }).length === 0;
    assert.equal(kit, host, `kit and host disagree on ${JSON.stringify(c)}`);
  }
});

// ------------------------------------------------------------------ the vendored runtime
test('the embedded plugin helper is byte-equal to examples/plugins/sara-plugin.mjs (node scripts/sdk-sync.ts)', () => {
  assert.equal(PLUGIN_HELPER, readFileSync(join(ROOT, 'examples', 'plugins', 'sara-plugin.mjs'), 'utf8'));
  const sync = spawnSync(NODE, [join(ROOT, 'scripts', 'sdk-sync.ts'), '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(sync.status, 0, sync.stdout + sync.stderr);
  assert.match(sync.stdout, /sara-sdk embedded helper: same/);
});

test('the vendored runtime is the kit itself (one source) and its types cover every helper', () => {
  const src = runtimeSource();
  for (const name of ['defineTool', 'defineSetting', 'definePage', 'defineAddon', 'buildManifest', 'checkManifest']) {
    assert.match(src, new RegExp(`export (async )?function ${name}\\b`), name);
    assert.match(RUNTIME_DTS, new RegExp(`export declare function ${name}\\b`), `d.ts ${name}`);
  }
  assert.match(src, /import \{ plugin \} from '\.\/sara-plugin\.mjs'/);
  assert.doesNotMatch(src, /: string\b|interface |import type/, 'no TypeScript left in the runtime');
});

// ------------------------------------------------------------------ create → test → pack
const ADDON = () => join(dir, 'my-addon');

test('create: a self-contained add-on folder that Sara reads as it is', () => {
  const r = cli(['create', 'my-addon', '--author', 'Ada Example']);
  assert.equal(r.code, 0, r.out);
  const files = readdirSync(ADDON()).sort();
  for (const f of ['CHANGES.md', 'README.md', 'jsconfig.json', 'main.mjs', 'sara-addon.d.mts', 'sara-addon.mjs', 'sara-plugin.json', 'sara-plugin.mjs', 'shots', 'tests']) assert.ok(files.includes(f), `${f} in ${files.join(', ')}`);
  assert.deepEqual(readdirSync(join(ADDON(), 'tests')).sort(), ['fakes.json', 'harness.mjs', 'my-addon.test.mjs']);
  assert.equal(readFileSync(join(ADDON(), 'sara-plugin.mjs'), 'utf8'), PLUGIN_HELPER);
  const m = JSON.parse(readFileSync(join(ADDON(), 'sara-plugin.json'), 'utf8'));
  const parsed = parseManifest(JSON.stringify(m), { saraVersion: SARA_VERSION, files: ['main.mjs'] });
  assert.equal(parsed.id, 'my-addon');
  assert.equal(parsed.author, 'Ada Example');
  assert.deepEqual(parsed.permissions.tools, ['greet']);
  assert.ok(parsed.settings.every((s) => s.tip.length >= 10));
  assert.match(r.out, /sara-addon test/);
  // A second create into the same folder refuses (nothing is overwritten).
  const again = cli(['create', 'my-addon']);
  assert.equal(again.code, 2);
  assert.match(again.out, /already exists/);
  assert.equal(cli(['create', 'Bad Name']).code, 2);
});

test('create: the template type-checks against its vendored types (checkJs)', { skip: existsSync(join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')) ? false : 'needs the typescript dev dependency' }, () => {
  const r = spawnSync(NODE, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(ADDON(), 'jsconfig.json'), '--noEmit'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('build: sara-plugin.json comes from the code; --check finds a stale one', () => {
  const main = join(ADDON(), 'main.mjs');
  const before = readFileSync(main, 'utf8');
  writeFileSync(main, before.replace("version: '0.1.0'", "version: '0.1.1'"));
  const stale = cli(['build', ADDON(), '--check']);
  assert.equal(stale.code, 1, stale.out);
  assert.match(stale.out, /out of date/);
  writeFileSync(main, before);
  const ok = cli(['build', ADDON(), '--check']);
  assert.equal(ok.code, 0, ok.out);
});

test('test (quick host): the add-on runs in its own permission-limited process and its tests pass', () => {
  const r = cli(['test', ADDON()]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ready: greet/);
  assert.match(r.out, /# pass 3/);
  assert.match(r.out, /# fail 0/);
});

test('test (quick host): a failing add-on test fails the run', () => {
  const t = join(ADDON(), 'tests', 'broken.test.mjs');
  writeFileSync(t, "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { callTool } from './harness.mjs';\ntest('wrong on purpose', async () => { const r = await callTool('greet', { name: 'Bo' }); assert.equal(r.content, 'nope'); });\n");
  try {
    const r = cli(['test', ADDON()]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /# fail 1/);
  } finally {
    rmSync(t);
  }
});

test('test --sara: a throwaway in-process Sara installs it through the real PluginManager and runs the same tests', () => {
  const r = cli(['test', ADDON(), '--sara', ROOT]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Sara \d+\.\d+\.\d+ \(throwaway, in this process\): installed my-addon/);
  assert.match(r.out, /my_addon__greet \(asks first\)/);
  assert.match(r.out, /# pass 3/);
});

test('pack: refuses to call it ready without a screenshot, then writes the bundle and the listing', () => {
  const first = cli(['pack', ADDON()]);
  assert.equal(first.code, 1, first.out);
  assert.match(first.out, /Add at least one screenshot/);
  mkdirSync(join(ADDON(), 'shots'), { recursive: true });
  writeFileSync(join(ADDON(), 'shots', 'card.png'), png());
  const r = cli(['pack', ADDON()]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Ready for the store/);
  assert.match(r.out, /sara submit/);
  const out = join(ADDON(), 'out');
  const zipPath = join(out, 'my-addon-0.1.0.sarapack.zip');
  const listing = JSON.parse(readFileSync(join(out, 'my-addon-0.1.0.listing.json'), 'utf8'));
  assert.equal(listing.format, 'sara-addon-listing/1');
  assert.equal(listing.id, 'my-addon');
  assert.equal(listing.ready, true);
  assert.deepEqual(listing.tools.map((t: { name: string }) => t.name), ['greet']);
  assert.ok(listing.permissions.some((l: string) => /greet/.test(l)));
  assert.equal(listing.screenshots.length, 1);
  assert.match(listing.changes, /First version/);
  assert.match(listing.submit, /owner/i);
  // The bundle: what Sara's own reader sees, with no tests, out/ or editor files inside.
  const files = fromZip(readFileSync(zipPath), PLUGIN_LIMITS);
  const paths = files.map((f) => f.path).sort();
  assert.ok(paths.includes('sara-plugin.json') && paths.includes('main.mjs') && paths.includes('shots/card.png'));
  assert.ok(!paths.some((p) => p.startsWith('tests/') || p.startsWith('out/') || p === 'jsconfig.json'), paths.join(', '));
  assert.equal(listing.bundle.sha256.length, 64);
  // The listing's content hash is the host's hash of the runtime files (what an install pins).
  const runtime = splitListing(files).pkg.filter((f) => f.path !== 'CHANGES.md' && f.path !== 'icon.png');
  assert.equal(listing.contentSha, hashFiles(runtime));
});

test("pack: Sara's own store checks (sara pack, with the fenced smoke test) accept the bundle", async () => {
  const zipPath = join(ADDON(), 'out', 'my-addon-0.1.0.sarapack.zip');
  const report = await packPath(zipPath, { saraVersion: SARA_VERSION, smoke: 'node-only' });
  assert.equal(report.report.ready, true, JSON.stringify(report.report.results, null, 1));
  const listing = JSON.parse(readFileSync(join(ADDON(), 'out', 'my-addon-0.1.0.listing.json'), 'utf8'));
  assert.equal(report.report.contentSha, listing.contentSha);
  // --sara adds the host's report to the listing.
  const r = cli(['pack', ADDON(), '--sara', ROOT]);
  assert.equal(r.code, 0, r.out);
  const withHost = JSON.parse(readFileSync(join(ADDON(), 'out', 'my-addon-0.1.0.listing.json'), 'utf8'));
  assert.equal(withHost.host.ready, true);
  assert.equal(withHost.host.sara, SARA_VERSION);
});

test('files: the kit zip and hash match the host (one bundle format)', () => {
  const files = readAddonFiles(ADDON());
  assert.ok(!files.some((f) => f.path.startsWith('tests/') || f.path.startsWith('out/')));
  const zip = kitZip(files);
  const back = fromZip(zip, PLUGIN_LIMITS);
  assert.equal(kitHash(files), hashFiles(back));
});

// ------------------------------------------------------------------ the package and the docs
test('the SDK package ships the kit: a bin, the addon entry, no dependencies, nothing private', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'packages', 'sara-sdk', 'package.json'), 'utf8'));
  assert.equal(pkg.bin['sara-addon'], './dist/cli.js');
  assert.equal(pkg.exports['./addon'].types, './dist/addon/kit.d.ts');
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.match(readFileSync(CLI, 'utf8'), /^#!\/usr\/bin\/env node/);
  const readme = readFileSync(join(ROOT, 'packages', 'sara-sdk', 'README.md'), 'utf8');
  assert.match(readme, /npx @farena-ai\/sara-sdk create my-addon/);
  assert.match(readme, /ADDON_KIT\.md/);
});

test('docs/ADDON_KIT.md: the 10-minute tutorial uses the real commands and says submitting is the owner step', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'ADDON_KIT.md'), 'utf8');
  for (const w of ['create my-addon', 'sara-addon test', '--sara', 'sara-addon pack', 'sara-addon dev', 'defineTool', 'defineSetting', 'definePage', 'defineAddon', 'listing.json', 'sara submit', 'no HTML']) assert.ok(doc.includes(w), w);
  assert.match(readFileSync(join(ROOT, 'docs', 'PLUGINS.md'), 'utf8'), /ADDON_KIT\.md/);
});

test('the CLI explains itself', () => {
  const r = cli(['help']);
  assert.equal(r.code, 0);
  for (const c of ['create', 'build', 'test', 'pack', 'dev']) assert.match(r.out, new RegExp(`sara-addon ${c}`));
  assert.equal(cli(['nope']).code, 2);
  // The CLI also runs from the published shape (tsc output) — covered by ec22's build; here the source.
  assert.ok(execFileSync(NODE, ['--disable-warning=ExperimentalWarning', CLI, '--version'], { encoding: 'utf8' }).trim().match(/^\d+\.\d+\.\d+$/));
});
