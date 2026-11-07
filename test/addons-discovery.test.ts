import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { fromFolder, hashFiles, stripTop } from '../src/packages.ts';

const moduleUrl = new URL('../src/addons/discovery.ts', import.meta.url);
// A2 adds the developer add-ons through the same candidate path (host-tested, pinned versions).
const devIds = ['secret-scanner', 'license-auditor', 'sbom-builder', 'artifact-provenance-verifier', 'coverage-explorer', 'log-explorer', 'incident-workbench', 'environment-config-doctor', 'database-fixture-studio', 'data-contract-validator', 'change-impact-analyzer', 'architecture-guard', 'sql-migration-reviewer', 'visual-regression', 'localization-qa', 'accessibility-auditor', 'build-cache-inspector', 'api-contract-guard', 'http-webhook-workbench',
  'performance-regression-lab', 'code-migration-studio', 'build-reproducibility-inspector', 'test-doctor', 'flaky-test-lab'];
const nativeIds = ['daily-briefing', 'meeting-assistant', 'document-desk', 'research-notebook', 'project-handoff', 'weekly-review', 'inbox-triage', 'content-studio', 'image-workshop', 'spreadsheet-assistant', 'travel-planner', 'home-dashboard', ...devIds];
const previewIds = ['markitdown', 'tavily', 'firecrawl', 'chrome-devtools', 'dbhub', 'drawio', 'linear'];
const blockedIds = ['notion', 'serena', 'supabase', 'figma', 'google-workspace', 'microsoft-365', 'slack', 'atlassian', 'home-assistant', 'obsidian', 'sentry', 'cloudflare', 'docker', 'gitlab'];
const guideIds = ['everyday-assistant', 'research-documents', 'developer', 'creator', 'small-business', 'private-local'];
const sorted = (v: readonly string[]) => [...v].sort();
async function api(): Promise<any> {
  assert.ok(existsSync(moduleUrl), 'Public discovery must exist without private authoring data.');
  return import(moduleUrl.href);
}
function input(a: any): any {
  return structuredClone({ candidates: a.PUBLIC_NATIVE_CANDIDATES, investigations: a.PUBLIC_MCP_INVESTIGATIONS, packs: a.PUBLIC_GUIDED_PACKS });
}

test('discovery has exact native, preview, blocked and guide identity sets', async () => {
  const a = await api();
  assert.deepEqual(sorted(a.NATIVE_CANDIDATE_IDS), sorted(nativeIds));
  assert.deepEqual(sorted(a.PUBLIC_NATIVE_CANDIDATES.map((x: any) => x.id)), sorted(nativeIds));
  assert.deepEqual(sorted(a.PUBLIC_MCP_INVESTIGATIONS.map((x: any) => x.id)), sorted([...previewIds, ...blockedIds]));
  assert.deepEqual(sorted(a.PUBLIC_MCP_INVESTIGATIONS.filter((x: any) => x.recipePreview).map((x: any) => x.id)), sorted(previewIds));
  assert.deepEqual(sorted(a.PUBLIC_MCP_INVESTIGATIONS.filter((x: any) => x.status === 'blocked').map((x: any) => x.id)), sorted(blockedIds));
  assert.deepEqual(sorted(a.PUBLIC_MCP_INVESTIGATIONS.filter((x: any) => x.status === 'needs-account').map((x: any) => x.id)), ['firecrawl', 'linear', 'tavily']);
  assert.deepEqual(sorted(a.PUBLIC_GUIDED_PACKS.map((x: any) => x.id)), sorted(guideIds));
  for (const x of a.PUBLIC_NATIVE_CANDIDATES) {
    assert.equal(x.kind, 'plugin'); assert.equal(x.status, devIds.includes(x.id) ? 'tested' : 'in-testing'); assert.equal(x.version, x.id === 'api-contract-guard' ? '0.1.0' : '1.0.0');
    assert.equal(a.getNativeCandidate(x.id), x);
    for (const key of ['installable', 'available', 'signed', 'firstParty', 'origin', 'packageUrl']) assert.equal(Object.hasOwn(x, key), false);
  }
  for (const id of ['', '../focus', 'C:\\invalid', 'focus', '__proto__', 'constructor', null, 1, {}]) assert.equal(a.getNativeCandidate(id), undefined);
});

test('all literal candidate identities match real complete native packages and manifest tools', async () => {
  const a = await api();
  const limits = { maxZipBytes: 10485760, maxFiles: 500, maxTotalBytes: 31457280, maxFileBytes: 5242880, maxDepth: 10 };
  for (const candidate of a.PUBLIC_NATIVE_CANDIDATES) {
    const folder = new URL(`../store/plugins/${candidate.id}/`, import.meta.url);
    const { files } = stripTop(fromFolder(fileURLToPath(folder), limits));
    assert.equal(candidate.contentSha, hashFiles(files), candidate.id);
    const manifest = JSON.parse(readFileSync(new URL('sara-plugin.json', folder), 'utf8'));
    assert.equal(candidate.version, manifest.version); assert.equal(candidate.tool, manifest.permissions.tools[0]);
  }
});

test('validated discovery is deeply frozen and independent of the caller input', async () => {
  const a = await api(); const source = input(a); const value = a.validateDiscovery(source);
  const frozen = (x: any): void => { if (x && typeof x === 'object') { assert.ok(Object.isFrozen(x)); for (const v of Object.values(x)) frozen(v); } };
  frozen(value); frozen(a.PUBLIC_NATIVE_CANDIDATES); frozen(a.PUBLIC_MCP_INVESTIGATIONS); frozen(a.PUBLIC_GUIDED_PACKS); frozen(a.NATIVE_CANDIDATE_IDS);
  source.candidates[0].name = 'Changed'; assert.notEqual(value.candidates[0].name, 'Changed');
  assert.throws(() => { a.PUBLIC_NATIVE_CANDIDATES[0].prerequisites.push('Changed'); }, TypeError);
  assert.equal(a.costTierFor('unknown'), 'unconfirmed'); assert.equal(a.costTierFor(undefined), 'unconfirmed');
  for (const tier of ['local-only', 'mixed', 'provider', 'unconfirmed']) assert.equal(a.costTierFor(tier), tier);
});

const malformed: [string, (x: any) => void][] = [
  ['duplicate native', x => { x.candidates[1].id = x.candidates[0].id; }],
  ['cross-kind collision', x => { x.investigations[0].id = x.candidates[0].id; }],
  ['unknown ID', x => { x.candidates[0].id = 'unlisted'; }],
  ['missing record', x => { x.candidates.pop(); }],
  ['unknown kind', x => { x.candidates[0].kind = 'store'; }],
  ['native blocked', x => { x.candidates[0].status = 'blocked'; }],
  ['account qualification mismatch', x => { x.investigations.find((i: any) => i.id === 'linear').status = 'in-testing'; }],
  ['blocked recipe', x => { x.investigations.find((i: any) => i.id === 'notion').recipePreview = x.investigations[0].recipePreview; }],
  ['missing preview', x => { delete x.investigations.find((i: any) => i.id === 'markitdown').recipePreview; }],
  ['malformed cost', x => { x.candidates[0].costTier = 'free'; }],
  ['non-string', x => { x.candidates[0].name = { text: 'name' }; }],
  ['private field', x => { x.candidates[0].evidence = ['synthetic']; }],
  ['nested secret value', x => { x.investigations.find((i: any) => i.id === 'linear').recipePreview.secrets[0].value = 'synthetic'; }],
  ['source path in prose', x => { x.candidates[0].qualification = 'Read outputs/private/log.txt'; }],
  ['ops path in guide', x => { x.packs[0].setup[0] = 'Read docs/ops/private.md'; }],
  ['absolute Windows path', x => { x.candidates[0].privacy = 'Read C:\\synthetic\\private.txt'; }],
  ['native version', x => { x.candidates[0].version = '2.0.0'; }],
  ['native tool', x => { x.candidates[0].tool = 'unknown'; }],
  ['bad hash', x => { x.candidates[0].contentSha = 'a'.repeat(63); }],
  ['unknown guide ref', x => { x.packs[0].items.push('unlisted'); }],
  ['duplicate guide ref', x => { x.packs[0].items.push(x.packs[0].items[0]); }],
  ['unknown top-level field', x => { x.rawCatalog = []; }],
  ['recipe transport mismatch', x => { x.investigations.find((i: any) => i.id === 'linear').recipePreview.transport = 'stdio'; }],
  ['script command', x => { x.investigations.find((i: any) => i.id === 'markitdown').recipePreview.command = 'sh'; }],
  ['private recipe field', x => { x.investigations[0].recipePreview.tested = []; }],
  ['changed executable pin', x => { x.investigations.find((i: any) => i.id === 'markitdown').recipePreview.args = ['markitdown-mcp@latest']; }],
  ['changed preview environment', x => { x.investigations.find((i: any) => i.id === 'drawio').recipePreview.environment[0].publicValue = 'on'; }],
  ['changed secret key', x => { x.investigations.find((i: any) => i.id === 'dbhub').recipePreview.secrets[0].key = 'ADMIN_DSN'; }],
  ['actual substitution path', x => { x.investigations.find((i: any) => i.id === 'chrome-devtools').recipePreview.substitutions[0].key = '/home/synthetic'; }],
  ['missing manual guidance', x => { x.investigations.find((i: any) => i.id === 'markitdown').recipePreview.guide = []; }],
];
for (const [name, mutate] of malformed) test(`discovery refuses ${name}`, async () => {
  const a = await api(); const value = input(a); mutate(value); assert.throws(() => a.validateDiscovery(value), /discovery/i);
});

for (const url of ['http://example.test/docs', 'file:///private', 'javascript:alert(1)', 'https://user:pass@example.test/docs', 'https://localhost/docs', 'https://127.0.0.1/docs', 'https://[::1]/docs', 'https://example.test/pkg.sarapack.zip', 'https://example.test/?token=synthetic', ' https://example.test/docs', 'https://example.test/\nprivate']) test(`discovery refuses unsafe documentation URL ${JSON.stringify(url)}`, async () => {
  const a = await api(); const value = input(a); value.candidates[0].documentation = url;
  assert.throws(() => a.validateDiscovery(value), /discovery/i);
});

test('discovery enforces scalar/list/URL bounds and rejects executable accessors', async () => {
  const a = await api();
  for (const [field, max] of [['name', 100], ['summary', 240], ['description', 2000], ['qualification', 2000], ['cost', 2000], ['privacy', 2000]] as const) {
    const value = input(a); value.candidates[0][field] = 'x'.repeat(max); assert.doesNotThrow(() => a.validateDiscovery(value));
    value.candidates[0][field] += 'x'; assert.throws(() => a.validateDiscovery(value));
  }
  for (const field of ['prerequisites', 'permissions', 'limitations']) {
    const value = input(a); value.candidates[0][field] = Array(16).fill('x'.repeat(2000)); assert.doesNotThrow(() => a.validateDiscovery(value));
    value.candidates[0][field].push('x'); assert.throws(() => a.validateDiscovery(value));
    value.candidates[0][field] = ['x'.repeat(2001)]; assert.throws(() => a.validateDiscovery(value));
  }
  const value = input(a); value.candidates[0].source = `https://example.test/${'x'.repeat(2048)}`; assert.throws(() => a.validateDiscovery(value));
  const access = input(a); let called = false; Object.defineProperty(access.candidates[0], 'name', { enumerable: true, get() { called = true; return 'Name'; } });
  assert.throws(() => a.validateDiscovery(access)); assert.equal(called, false);
});

test('MCP safety instructions and capability limits remain informational and accurate', async () => {
  const a = await api();
  for (const x of a.PUBLIC_MCP_INVESTIGATIONS.filter((i: any) => i.recipePreview)) {
    const text = x.recipePreview.guide.join(' ');
    assert.match(text, /Ask me first or Off/); assert.match(text, /Save, leave and reopen/); assert.match(text, /read back every tool setting/);
    assert.match(x.permissions.join(' '), /auto-allow/);
    assert.equal(Object.hasOwn(x.recipePreview, 'tools'), false);
  }
  assert.match(a.getNativeCandidate('image-workshop').summary, /brief|prompt/i);
  assert.match(a.getNativeCandidate('home-dashboard').summary, /supplied|snapshot/i);
  const dashboard = JSON.stringify(a.getNativeCandidate('home-dashboard')); assert.match(dashboard, /no live|non-live/i); assert.match(dashboard, /no device control|never controls|no .*control/i);
  assert.match(a.getNativeCandidate('content-studio').cost, /4 calls\/day.*12000 tokens\/day/);
  for (const id of ['daily-briefing', 'meeting-assistant', 'document-desk', 'research-notebook', 'project-handoff', 'weekly-review', 'content-studio']) {
    const limits = a.getNativeCandidate(id).limitations.join(' ');
    assert.match(limits, /8000 prompt characters and 1000 output tokens/);
    assert.match(limits, /stricter workflow limits/);
  }
  const local = a.PUBLIC_GUIDED_PACKS.find((x: any) => x.id === 'private-local'); assert.match(local.description, /configuration you verify/);
  for (const item of [...a.PUBLIC_NATIVE_CANDIDATES, ...a.PUBLIC_MCP_INVESTIGATIONS]) assert.match(item.qualification, /^Pinned source scope: /);
});

test('public modules load without native payloads or private authoring data and have no effectful imports', async () => {
  const a = await api(); const root = mkdtempSync(join(tmpdir(), 'sara-discovery-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    for (const name of ['discovery.ts', 'discovery-data.ts']) {
      const source = new URL(`../src/addons/${name}`, import.meta.url); const text = readFileSync(source, 'utf8');
      assert.doesNotMatch(text, /(?:node:|require\s*\(|import\s*\(|store\/addons|docs\/ops|outputs\/|build-addons-site)/);
      const deps = [...text.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
      for (const dep of deps) assert.ok(['./discovery.ts', './discovery-data.ts'].includes(dep), dep);
      cpSync(source, join(root, name));
    }
    const copy = await import(pathToFileURL(join(root, 'discovery.ts')).href);
    assert.deepEqual(copy.PUBLIC_NATIVE_CANDIDATES, a.PUBLIC_NATIVE_CANDIDATES);
    assert.equal(existsSync(join(root, 'store')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
