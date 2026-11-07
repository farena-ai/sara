// M01-M30 developer MCP batch: every READY recipe is pinned, reviewable and never starts without
// approval; every held entry has no install action; every blocked entry states its reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkRecipe, recipeProblems } from '../src/store/checks.ts';
import { parseRecipe } from '../src/store/format.ts';
import { DEVELOPER_READY, DEVELOPER_HELD, DEVELOPER_BLOCKED, PUBLIC_DEVELOPER_CONNECTIONS, validateDeveloperConnections } from '../src/addons/developer-connections.ts';
import { developerConnectionsData } from '../src/addons/developer-connections-data.ts';
import { PUBLIC_MCP_INVESTIGATIONS, PUBLIC_NATIVE_CANDIDATES } from '../src/addons/discovery.ts';
import { McpManager } from '../src/tools/mcp.ts';
import { ToolRegistry } from '../src/tools/registry.ts';

const root = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const json = (p: string): any => JSON.parse(read(p));
const ledger = json('tools/developer-mcp-batch/qualification.json');
const STATE: Record<string, string> = { READY: 'tested', 'NEEDS ACCOUNT': 'needs-account', BLOCKED: 'blocked' };

test('ledger covers M01-M30 exactly once, matching the approved target names, with a state per target', () => {
  const expected = [['M01', 'Local Git'], ['M02', 'Postman'], ['M03', 'Storybook'], ['M04', 'AWS'], ['M05', 'Azure'], ['M06', 'Google Cloud'], ['M07', 'Terraform'], ['M08', 'Pulumi'], ['M09', 'Kubernetes'], ['M10', 'Argo CD'], ['M11', 'Vercel'], ['M12', 'Netlify'], ['M13', 'MongoDB'], ['M14', 'Redis'], ['M15', 'Elasticsearch and OpenSearch'], ['M16', 'ClickHouse'], ['M17', 'Snowflake'], ['M18', 'Neon'], ['M19', 'Qdrant'], ['M20', 'Pinecone'], ['M21', 'Datadog'], ['M22', 'Grafana'], ['M23', 'New Relic'], ['M24', 'PostHog'], ['M25', 'LaunchDarkly'], ['M26', 'Stripe'], ['M27', 'Auth0'], ['M28', 'Jenkins'], ['M29', 'Buildkite'], ['M30', 'CircleCI']];
  // The private matrix is the authority; the exported source keeps the same frozen list.
  const matrixPath = new URL('docs/ops/DEVELOPER_ADDONS_TARGET_MATRIX.md', root);
  if (existsSync(matrixPath)) assert.deepEqual([...read('docs/ops/DEVELOPER_ADDONS_TARGET_MATRIX.md').matchAll(/^## (M\d\d) — (.+)$/gm)].map(m => [m[1], m[2].trim()]), expected);
  assert.equal(expected.length, 30);
  assert.deepEqual(ledger.targets.map((t: any) => [t.id, t.name]), expected);
  for (const t of ledger.targets) {
    assert.ok(['READY', 'NEEDS ACCOUNT', 'BLOCKED'].includes(t.state), t.id);
    for (const k of ['license', 'auth', 'cost', 'reason']) assert.ok(typeof t[k] === 'string' && t[k].trim().length >= 3, `${t.id}.${k}`);
    const u = t.upstream; assert.ok(u && typeof u.package === 'string', `${t.id}: upstream named`);
    // A registry package always carries its exact version and the registry's own integrity value.
    if (['npm', 'pypi', 'docker'].includes(u.registry)) {
      assert.match(u.version, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/, `${t.id}: exact version`);
      assert.match(u.integrity, /^(?:sha512-[A-Za-z0-9+/]{86}==|sha256:[0-9a-f]{64})$/, `${t.id}: integrity`);
    }
    if (t.state === 'READY') assert.match(t.fixtureProof, /developer-mcp-batch-host\.test\.ts/);
    else assert.equal(t.fixtureProof, null, `${t.id}: only READY entries claim fixture proof`);
    if (t.state === 'NEEDS ACCOUNT') assert.ok(t.ownerStep && t.ownerStep.length > 20, `${t.id}: exact owner step`);
    if (t.state === 'BLOCKED') assert.equal(t.ownerStep, null);
  }
  const by = (s: string) => ledger.targets.filter((t: any) => t.state === s).map((t: any) => t.slug).sort();
  assert.deepEqual(by('READY'), [...DEVELOPER_READY].sort());
  assert.deepEqual(by('NEEDS ACCOUNT'), [...DEVELOPER_HELD].sort());
  assert.deepEqual(by('BLOCKED'), [...DEVELOPER_BLOCKED].sort());
});

test('every READY recipe is pinned to the ledger, passes the Store recipe checks and grants no automatic tool', () => {
  for (const id of DEVELOPER_READY) {
    const t = ledger.targets.find((x: any) => x.slug === id);
    const text = read(`store/mcp/${id}.json`); const r = JSON.parse(text);
    assert.equal(r.id, id); assert.deepEqual(recipeProblems(r.mcp), []);
    const png = readFileSync(new URL(`store/mcp/shots/${id}-1.png`, root));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const rep = checkRecipe({ ...r, bytes: Buffer.byteLength(text) }, [{ path: `shots/${id}-1.png`, data: png }], { firstParty: true });
    assert.ok(rep.ready, `${id}: ${JSON.stringify(rep.results.filter(x => !x.ok))}`);
    const p = parseRecipe(r.mcp);
    assert.deepEqual(p.tools.readOnly, [], 'no recipe-level automatic approval');
    assert.ok(p.tools.ask.length > 0);
    assert.deepEqual(p.secrets, []); assert.deepEqual(r.tested, []);
    assert.match(r.reviewNotes, /preview/i);
    const guide = p.guide.join(' ');
    assert.match(guide, /Ask me first/); assert.match(guide, /read back/i);
    if (p.transport === 'stdio') {
      assert.ok(p.args!.includes(`${t.upstream.package}==${t.upstream.version}`) || p.args!.includes(`${t.upstream.package}@${t.upstream.version}`), `${id}: exact ledger pin in the launch`);
    } else {
      assert.equal(new URL(p.url!).hostname, '127.0.0.1', 'only a loopback app on this computer');
      assert.match(guide, new RegExp(`${t.upstream.package.replace('/', '\\/')}@${t.upstream.version.replaceAll('.', '\\.')}`), `${id}: guide names the exact pinned addon`);
    }
  }
  assert.equal(parseRecipe(json('store/mcp/qdrant.json').mcp).fields.find(f => f.key === 'QDRANT_READ_ONLY')!.default, 'true');
});

test('held and blocked targets have no Store recipe and no install action', () => {
  const recipes = readdirSync(new URL('store/mcp/', root)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
  for (const id of [...DEVELOPER_HELD, ...DEVELOPER_BLOCKED]) assert.equal(recipes.includes(id), false, `${id}: no installable recipe`);
  for (const item of PUBLIC_DEVELOPER_CONNECTIONS) {
    const ready = (DEVELOPER_READY as readonly string[]).includes(item.id);
    assert.equal(Object.hasOwn(item, 'recipePreview'), ready, `${item.id}: recipe preview only when READY`);
    const t = ledger.targets.find((x: any) => x.slug === item.id);
    assert.equal(item.status, STATE[t.state]);
    if (item.status === 'needs-account') assert.match(item.prerequisites[0], /^Owner step: /);
    if (item.status === 'blocked') assert.ok(item.limitations[0].length > 30, `${item.id}: plain reason`);
  }
});

test('developer connections project the READY recipes exactly and never collide with A1 identities', () => {
  const ids = PUBLIC_DEVELOPER_CONNECTIONS.map(x => x.id);
  assert.equal(new Set(ids).size, 30);
  for (const other of [...PUBLIC_MCP_INVESTIGATIONS, ...PUBLIC_NATIVE_CANDIDATES]) assert.equal(ids.includes(other.id), false, other.id);
  for (const id of DEVELOPER_READY) {
    const source = json(`store/mcp/${id}.json`).mcp; const recipe: any = PUBLIC_DEVELOPER_CONNECTIONS.find(x => x.id === id)!.recipePreview;
    assert.equal(recipe.transport, source.transport); assert.deepEqual(recipe.guide, source.guide); assert.deepEqual(recipe.secrets, []);
    if (source.transport === 'http') assert.equal(recipe.url, source.url);
    else {
      assert.equal(recipe.command, source.command); assert.deepEqual(recipe.args, source.args);
      assert.deepEqual(recipe.environment, source.fields.map((f: any) => ({ name: f.key, publicValue: f.default, purpose: f.tip })));
    }
  }
});

test('the validator refuses a held install action, a changed pin, a remote URL, a secret or a state flip', () => {
  const base = () => structuredClone(developerConnectionsData) as unknown as any[];
  const find = (x: any[], id: string) => x.find(e => e.id === id);
  const cases: [string, (x: any[]) => void][] = [
    ['held recipe', x => { find(x, 'redis').recipePreview = find(x, 'qdrant').recipePreview; }],
    ['blocked recipe', x => { find(x, 'local-git').recipePreview = find(x, 'qdrant').recipePreview; }],
    ['missing READY preview', x => { delete find(x, 'qdrant').recipePreview; }],
    ['changed pin', x => { find(x, 'qdrant').recipePreview.args = ['mcp-server-qdrant==0.8.2']; }],
    ['unpinned', x => { find(x, 'qdrant').recipePreview.args = ['--python=3.12', 'mcp-server-qdrant']; }],
    ['remote url', x => { find(x, 'storybook').recipePreview.url = 'https://storybook.example.com/mcp'; }],
    ['secret', x => { find(x, 'qdrant').recipePreview.secrets = [{ key: 'QDRANT_API_KEY', purpose: 'x' }]; }],
    ['state flip', x => { find(x, 'redis').status = 'tested'; }],
    ['blocked to held', x => { find(x, 'mongodb').status = 'needs-account'; }],
    ['missing entry', x => { x.pop(); }],
    ['duplicate', x => { x[1] = structuredClone(x[0]); }],
    ['private path', x => { find(x, 'redis').limitations = ['see docs/ops/notes.md']; }],
    ['env with a template', x => { find(x, 'qdrant').recipePreview.environment[0].publicValue = '${home}/x'; }],
  ];
  assert.doesNotThrow(() => validateDeveloperConnections(base()));
  for (const [name, mutate] of cases) { const x = base(); mutate(x); assert.throws(() => validateDeveloperConnections(x), /developer connection/i, name); }
});

test('a copied READY recipe saved switched off starts nothing and reads no secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-batch-off-'));
  try {
    for (const item of PUBLIC_DEVELOPER_CONNECTIONS.filter(x => x.recipePreview)) {
      const r: any = item.recipePreview; const registry = new ToolRegistry([]);
      let reached = false;
      const manager = new McpManager(registry, { dataDir: dir, sandbox: { mode: 'none', network: false, detail: 'test' }, secrets: () => { reached = true; throw new Error('secrets must not be read for a disabled server'); } });
      const config = r.transport === 'http' ? { name: item.id, transport: 'http' as const, url: r.url, enabled: false } : { name: item.id, transport: 'stdio' as const, command: r.command, args: r.args, enabled: false };
      const conn = await manager.start(config);
      assert.notEqual(conn.status, 'ready'); assert.equal(registry.list().length, 0); assert.equal(reached, false, item.id);
      manager.stopAll();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Settings copies only fixture-tested recipes into the normal add form, switched off, without saving', () => {
  const web = read('web/addons-discovery.js');
  const copy = web.slice(web.indexOf('function copyToAddForm'), web.indexOf('function developerCard'));
  assert.match(copy, /#mcp-enabled[\s\S]*checked = false/);
  assert.doesNotMatch(copy, /fetch\(|api\(|#mcp-save|\.click\(|dispatchEvent\(new Event\('click/);
  const card = web.slice(web.indexOf('function developerCard'), web.indexOf('async function load('));
  assert.match(card, /item\.status === 'tested' && item\.recipePreview/);
  assert.match(read('src/routes/admin.ts'), /developer: PUBLIC_DEVELOPER_CONNECTIONS/);
});

test('every developer connection display string is listed for translation and translated in five languages', () => {
  const extra = new Set(json('web/i18n/_extra.json').keys as string[]);
  const strings = new Set<string>();
  for (const item of PUBLIC_DEVELOPER_CONNECTIONS) {
    for (const s of [item.summary, item.description, item.qualification, item.cost, ...item.prerequisites, ...item.permissions, ...item.limitations]) strings.add(s);
    const r: any = item.recipePreview; if (r) for (const s of [...r.guide, ...(r.environment ?? []).map((e: any) => e.purpose)]) strings.add(s);
  }
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const dict = json(`web/i18n/${lang}.json`);
    for (const s of strings) {
      assert.ok(extra.has(s), `_extra.json lists: ${s}`);
      assert.ok(typeof dict[s] === 'string' && dict[s].trim() && dict[s] !== s, `${lang}: ${s}`);
      assert.deepEqual(dict[s].match(/\d+(?:\.\d+)*/g) ?? [], s.match(/\d+(?:\.\d+)*/g) ?? [], `${lang} keeps numbers in order: ${s}`);
    }
  }
});

test('opt-in host acceptance exists and is never run by default', () => {
  const host = read('test/developer-mcp-batch-host.test.ts');
  assert.match(host, /skip: !QUALIFY/);
  assert.match(host, /process\.env\.MCP_BATCH_QUALIFY === '1'/);
  for (const id of DEVELOPER_READY) assert.ok(existsSync(new URL(`store/mcp/${id}.json`, root)));
});
