// Q-ADDONS: end-to-end acceptance of Sara's native plugins on a RUNNING throwaway Sara, through the
// same HTTP routes the Settings page uses (no in-process harness): Workflow candidates review →
// approve, or the signed Store install (download + hash check by Sara's StoreClient), settings saved
// and read back, enable for one companion, the main tool through the owner's card-action route
// (the same plugin `tool` request the chat path sends), one approved job/write where the plugin has
// one, disable, remove, and the data folder gone afterwards.
//
//   SARA_TOKEN=… node scripts/qualify-addons-native.mjs --base http://127.0.0.1:7882 \
//     --data <SARA_DATA> --out <results.json> [--only id,id] [--os windows|linux]
//
// Fixture inputs are the ones the add-ons' host tests use (test/fixtures/developer, tools/*/fixtures).
// The operator staging some plugins need ("with the plugin switched off, stage a copy under its data
// folder") is done here as the operator would: files written into <SARA_DATA>/plugin-data/<id>/main.
// Never point this at a live Sara: it installs and removes plugins.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const BASE = opt('base', 'http://127.0.0.1:7882');
const DATA = resolve(opt('data', ''));
const OUT = opt('out', 'qualify-addons-native.json');
const OS = opt('os', process.platform === 'win32' ? 'windows' : 'linux');
const ROOT = resolve(opt('root', join(dirname(fileURLToPath(import.meta.url)), '..')));
const ONLY = (opt('only', '') || '').split(',').filter(Boolean);
const TOKEN = process.env.SARA_TOKEN ?? '';
const CO = 'main';
if (!TOKEN || !existsSync(join(DATA, 'sara.db'))) throw new Error('Set SARA_TOKEN and --data to the throwaway Sara data folder.');
if (/:(7860|7861)\b/.test(BASE)) throw new Error('Refusing a live Sara port.');

const fx = (...p) => join(ROOT, 'test/fixtures/developer', ...p);
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) { const e = new Error(`${method} ${path} → ${res.status}: ${typeof data === 'string' ? data.slice(0, 300) : (data.error ?? JSON.stringify(data).slice(0, 300))}`); e.status = res.status; throw e; }
  return data;
}
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const check = (ok, what) => { if (!ok) throw new Error(`expected ${what}`); return what; };
const parsed = (r) => { try { return JSON.parse(r.content); } catch { return null; } };

// ---- the entries ------------------------------------------------------------------------------
// steps: { tool, args, expect(r, j) → evidence string, job?: true (approve the job card it raises) }
const security = await imp('tools/developer-security/fixtures.mjs');
const data = await imp('tools/developer-data/fixtures.mjs');
const evidence = await imp('tools/developer-evidence/fixtures.mjs');
const graph = (f) => json(fx('code-graph', f));
const png = (v, k) => readFileSync(fx('visual-regression', `${v}-${k}.png`)).toString('base64');
const supplied = [{ id: 'agenda', label: 'Supplied agenda', text: '09:00 Design review\n11:00 Write draft' }];
const ok = (re) => (r) => check(re.test(r.content + JSON.stringify(r.card ?? {})), String(re));
const card = (r) => check(r.card && r.card.title && r.card.lines?.length, 'a result card') && `card "${r.card.title}": ${String(r.card.lines[0]).slice(0, 90)}`;

const ENTRIES = [
  // A1 everyday candidates (supplied-content tools; no model call unless asked to refine)
  { id: 'daily-briefing', steps: [{ tool: 'brief', args: { sources: supplied }, expect: (r, j) => `${check(/Design review/.test(r.content), 'briefing quotes the supplied agenda')}; ${card(r)}` }] },
  { id: 'meeting-assistant', steps: [{ tool: 'extract', args: { transcript: 'Decision: Ship a draft\nAction: Review copy | owner=Alex | due=2026-11-09\nQuestion: Who approves?' }, expect: (r) => `${check(/Review copy/.test(r.content) && /Alex/.test(r.content), 'the action with owner Alex')}; ${card(r)}` }] },
  { id: 'document-desk', steps: [{ tool: 'inspect', args: { mode: 'compare', sources: [{ id: 'old', label: 'Old draft', text: 'Shared\nOld clause' }, { id: 'new', label: 'New draft', text: 'Shared\nNew clause' }] }, expect: (r) => `${check(/Old clause/.test(r.content) && /New clause/.test(r.content), 'both changed clauses')}; ${card(r)}` }] },
  { id: 'research-notebook', steps: [
    { tool: 'notebook', write: true, args: { operation: 'put', item: { id: 'src-1', kind: 'source', title: 'Synthetic source', text: 'Synthetic fact for qualification.' } }, expect: ok(/src-1/) },
    { tool: 'notebook', args: { operation: 'list' }, expect: (r) => `${check(/src-1/.test(r.content), 'the saved source listed')}; ${card(r)}` }] },
  { id: 'project-handoff', steps: [{ tool: 'snapshot', args: { sources: [{ id: 'tests', label: 'Supplied test log', role: 'tested', text: '2 tests passed (user-supplied log)' }] }, expect: (r) => `${check(/2 tests passed/.test(r.content), 'the supplied test log quoted')}; ${card(r)}` }] },
  { id: 'weekly-review', steps: [{ tool: 'review', args: { accomplishments: 'Wrote the brief', commitments: [{ id: 'c1', text: 'Publish draft', status: 'pending' }, { id: 'c2', text: 'Write brief', status: 'done' }] }, expect: (r) => `${check(/Publish draft/.test(r.content), 'the pending commitment')}; ${card(r)}` }] },
  { id: 'inbox-triage', steps: [{ tool: 'workflow', args: { messages: [{ id: 'm1', subject: 'Invoice due', body: 'Please pay the invoice by Friday.' }] }, expect: (r, j) => `${check(j?.items?.[0]?.id === 'm1' && j.items[0].priority, 'item m1 with a priority')} (${j.items[0].priority}); ${card(r)}` }] },
  { id: 'content-studio', steps: [{ tool: 'workflow', args: { brief: 'Garden opening', audience: 'Neighbors', tone: 'warm', channel: 'newsletter' }, expect: (r, j) => `${check(j?.draft?.includes('Garden opening') && j.tone === 'warm', 'a warm draft about the brief')}; ${card(r)}` }] },
  { id: 'image-workshop', steps: [{ tool: 'workflow', write: true, args: { action: 'prepare', brief: 'Lighthouse at dusk', style: 'product', aspect: '1:1', avoid: 'text' }, expect: (r, j) => `${check(j?.prompt?.includes('Lighthouse at dusk') && j.generated === false, 'a prepared prompt, nothing generated')}; ${card(r)}` }] },
  { id: 'spreadsheet-assistant', steps: [{ tool: 'workflow', args: { csv: 'item,amount\ntea,3\ncake,5' }, expect: (r, j) => `${check(j?.columns?.[0]?.name === 'item', 'column "item" found')}; ${card(r)}` }] },
  { id: 'travel-planner', steps: [{ tool: 'workflow', args: json(join(ROOT, 'store/plugins/travel-planner/fixture.json')), expect: (r, j) => `${check(j?.booked === false && j.currency === 'USD', 'an unbooked USD plan')}; ${card(r)}` }] },
  { id: 'home-dashboard', steps: [{ tool: 'workflow', args: { observedAt: '2026-11-05T12:00:00Z', devices: [{ id: 'light.desk', name: 'Desk lamp', state: 'on', approved: true }], scenes: [{ id: 'scene.evening', name: 'Evening', approved: true }] }, expect: (r, j) => `${check(j?.devices?.[0]?.suppliedState === 'on' && j.live === false, 'the supplied state, not live')}; ${card(r)}` }] },
  // A2 developer candidates
  ...security.ids.map((id) => ({ id, steps: [{ tool: 'analyze', args: security.fixtureArgs(id), expect: (r, j) => {
    if (id === 'secret-scanner') check(/github-token/.test(r.content) && !/small-synthetic/.test(r.content + JSON.stringify(r.card)), 'github-token found, secrets not echoed');
    if (id === 'license-auditor') check(j ? j.packages.find((p) => p.name === 'b')?.decision === 'denied' : /denied/.test(r.content), 'package b denied');
    if (id === 'sbom-builder') check(j ? j.bom.components.length === 4 : /components/.test(r.content), '4 SBOM components');
    if (id === 'artifact-provenance-verifier') check(j ? j.verified === true : /"verified":true/.test(r.content), 'verified: true');
    return card(r); } }] })),
  ...evidence.ids.map((id) => ({ id, steps: [{ tool: 'analyze', args: evidence.fixtureArgs(id), expect: (r, j) => {
    if (j && id === 'coverage-explorer') check(j.branches.some((b) => b.count === 0 && b.changed), 'an uncovered changed branch');
    if (j && id === 'log-explorer') check(j.matches.length === 1, 'one INC42 match');
    if (j && id === 'incident-workbench') check(j.timeline[0].kind === 'deployment', 'deployment first in the timeline');
    if (j && id === 'environment-config-doctor') check(j.findings[0].status === 'invalid', 'an invalid setting');
    if (!j) check(r.content.length > 0, 'a (cut) report');
    return `${j ? 'report checked' : 'report cut at 4000 chars: card only'}; ${card(r)}`; } }] })),
  ...data.ids.map((id) => ({ id, steps: [{ tool: 'analyze', args: data.fixtureArgs(id), expect: (r, j) => {
    if (j && id === 'database-fixture-studio') check(j.tables.child.length === 5, '5 child rows');
    if (j && id === 'data-contract-validator') check(JSON.stringify(j.payloads.map((p) => p.valid)) === '[false,true]', 'payload validity [false,true]');
    return `${j ? 'report checked' : 'report cut at 4000 chars: card only'}; ${card(r)}`; } }] })),
  { id: 'change-impact-analyzer', steps: [{ tool: 'analyze', args: graph('impact.json'), expect: (r, j) => `${check(j ? JSON.stringify(j.callers.map((s) => s.symbol)) === '["caller","testValue"]' : /testValue/.test(r.content), 'callers caller, testValue')}; ${card(r)}` }] },
  { id: 'architecture-guard', steps: [{ tool: 'analyze', args: graph('architecture.json'), expect: (r, j) => `${check(j ? JSON.stringify(j.findings.map((f) => f.code)) === '["forbidden-import","layer-violation"]' : /layer-violation/.test(r.content), 'forbidden-import + layer-violation')}; ${card(r)}` }] },
  { id: 'sql-migration-reviewer', steps: [{ tool: 'rehearse', args: { baseline: { tables: [{ name: 'items', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'label', type: 'TEXT' }], rows: 3 }] }, sql: 'CREATE TABLE archive (id INTEGER NOT NULL, label TEXT); CREATE INDEX items_id ON items (id);' }, expect: (r, j) => `${check(j?.status === 'rehearsed' && j.rollbackVerified === true, 'rehearsed, rollback verified')}; ${card(r)}` }] },
  { id: 'visual-regression', steps: [{ tool: 'compare', args: { pairs: ['desktop', 'phone'].map((viewport) => ({ viewport, baseline: png(viewport, 'baseline'), candidate: png(viewport, 'candidate') })) }, expect: (r, j) => `${check(j?.pairs?.every((p) => p.changedPixels === 960), '960 changed pixels per viewport')}; ${card(r)}` }] },
  { id: 'localization-qa', steps: [{ tool: 'check', args: json(fx('localization-qa/captured-input.json')), expect: (r, j) => `${check(j ? j.layout === 'measured' && j.findings.some((f) => f.kind === 'rendered-overflow' && f.ref === 'k002') : /rendered-overflow/.test(r.content), 'k002 rendered overflow')}; ${card(r)}` }] },
  { id: 'accessibility-auditor', steps: [{ tool: 'audit', args: { html: readFileSync(fx('accessibility-auditor/candidate.html'), 'utf8') }, expect: (r, j) => `${check(j ? j.findings.length === 4 : /findings/.test(r.content), '4 findings')}; ${card(r)}` }] },
  { id: 'build-cache-inspector', stage: (home) => { for (const g of ['build-a', 'build-b']) { const d = join(home, 'owned-caches-v1/typescript', g); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'source.js'), `export const generation = '${g}';\n`); writeFileSync(join(d, 'source.d.ts'), 'export declare const generation: string;\n'); } },
    steps: [{ tool: 'inspect', args: { operation: 'inspect', cacheId: 'typescript' }, expect: (r, j) => `${check(j?.complete === true && j.files.length === 4, 'complete, 4 staged files measured')}; ${card(r)}` }] },
  { id: 'api-contract-guard', steps: [{ tool: 'compare', args: { before: { openapi: '3.0.3', info: { title: 'Synthetic', version: '1' }, paths: { '/pets': { get: { responses: { 200: { description: 'OK' } } } } } }, after: { openapi: '3.0.3', info: { title: 'Synthetic', version: '1' }, paths: {} } }, expect: (r, j) => `${check(j?.compatible === false && j.findings[0].before === '/paths/~1pets/get', 'removed GET /pets is breaking')}; ${card(r)}` }] },
  { id: 'http-webhook-workbench', listener: true, settings: (port) => ({ endpoint: `127.0.0.1:${port}` }),
    steps: [
      { tool: 'request', args: { method: 'GET', path: '/' }, expect: (r, j) => `${check(j?.ok === true && /200/.test(JSON.stringify(j)), 'GET / answered 200 by the owned listener')}; ${card(r)}` },
      { tool: 'request', write: true, args: { method: 'POST', path: '/hook', body: '{"event":"synthetic"}' }, expect: (r, j) => `${check(j?.ok === true, 'POST delivered')}; ${card(r)}` }] },
  // Lab add-ons: staged snapshot in the plugin's own data folder
  { id: 'performance-regression-lab', stage: (home) => { const b = join(home, 'perf-lab-v1/injected'); mkdirSync(b, { recursive: true }); cpSync(fx('performance-regression-lab/baseline.js'), join(b, 'baseline.js')); cpSync(fx('performance-regression-lab/candidate-injected.js'), join(b, 'candidate.js')); },
    steps: [{ tool: 'compare', plan: { operation: 'plan', benchmark: 'injected', samples: 30, warmup: 4, minEffectPercent: 20, sampleTimeoutMs: 250 }, args: { operation: 'run', benchmark: 'injected', samples: 30, warmup: 4, minEffectPercent: 20, sampleTimeoutMs: 250 }, expect: (r, j) => `${check(j?.status === 'regression', 'status regression')}; ${card(r)}` }] },
  { id: 'code-migration-studio', stage: (home) => cpSync(fx('code-migration-studio/workspace'), join(home, 'migration-v1/workspace'), { recursive: true }),
    steps: [{ tool: 'migrate', write: true, plan: { operation: 'preview', codemod: 'rename-named-import', version: 1, module: 'lib/math.mjs', from: 'add', to: 'sum', files: ['src/report.mjs', 'src/alias.mjs', 'src/shadow.mjs', 'main.mjs'] }, args: { operation: 'apply', codemod: 'rename-named-import', version: 1, module: 'lib/math.mjs', from: 'add', to: 'sum', files: ['src/report.mjs', 'src/alias.mjs', 'src/shadow.mjs', 'main.mjs'] }, expect: (r, j) => `${check(j?.applied === true && j.verified === true, 'applied and verified')}; ${card(r)}` }] },
  { id: 'build-reproducibility-inspector', stage: (home) => { const p = join(home, 'repro-v1/seeded'); mkdirSync(p, { recursive: true }); cpSync(fx('build-reproducibility-inspector/source'), join(p, 'source'), { recursive: true }); cpSync(fx('build-reproducibility-inspector/nondeterministic.js'), join(p, 'build.js')); },
    steps: [{ tool: 'inspect', plan: { operation: 'plan', profile: 'seeded' }, args: { operation: 'compare', profile: 'seeded' }, expect: (r, j) => `${check(j?.reproducible === false && j.unexplained === 0, 'not reproducible, all differences explained')}; ${card(r)}` }] },
  // H_EXEC add-ons: every run is an owner-approved job in a disposable copy
  { id: 'test-doctor', stage: (home) => cpSync(fx('test-doctor/repo'), join(home, 'projects/shop'), { recursive: true }),
    steps: [{ tool: 'diagnose', job: true, plan: { operation: 'plan', project: 'shop', file: 'test/price.test.mjs', test: 'total applies the discount once' }, args: { operation: 'run', project: 'shop', file: 'test/price.test.mjs', test: 'total applies the discount once' }, expect: (r, j) => `${check(j?.status === 'assertion-failed' && j.assertion?.line === 12 && j.copyDeleted === true, 'assertion-failed at line 12, copy deleted')}; ${card(r)}` }] },
  { id: 'flaky-test-lab', stage: (home) => cpSync(fx('flaky-test-lab/repo'), join(home, 'projects/cart'), { recursive: true }),
    steps: [{ tool: 'repeat', job: true, plan: { operation: 'plan', project: 'cart', file: 'test/cart.test.mjs', test: 'intermittent stock check', runs: 10 }, args: { operation: 'run', project: 'cart', file: 'test/cart.test.mjs', test: 'intermittent stock check', runs: 10 }, expect: (r, j) => `${check(j?.verdict === 'flaky' && j.copyDeleted === true, 'verdict flaky, copy deleted')}; ${card(r)}` }] },
  { id: 'documentation-doctor', stage: (home) => cpSync(fx('documentation-doctor/repo'), join(home, 'projects/recipes'), { recursive: true }),
    steps: [{ tool: 'docs', job: true, plan: { operation: 'check', project: 'recipes' }, pick: (p) => p.commands.find((x) => x.command === 'node scripts/build-docs.mjs'), planCheck: (p) => check(p.links.broken.length === 2, '2 broken links'), args: (doc) => ({ operation: 'run', project: 'recipes', command: doc.command, planSha: doc.planSha }), expect: (r, j) => `${check(j?.status === 'failed' && j.exitCode === 1 && j.copyDeleted === true, 'documented command failed with exit 1, copy deleted')}; ${card(r)}` },
      // The documented npm command: only under bubblewrap (Linux); Windows must hold it, never run it.
      { tool: 'docs', job: OS === 'linux', plan: { operation: 'check', project: 'recipes' }, pick: (p) => p.commands.find((x) => x.program === 'npm'), args: (doc) => ({ operation: 'run', project: 'recipes', command: doc.command, planSha: doc.planSha }),
        expect: (r, j) => OS === 'linux' ? `${check(j && ['passed', 'failed'].includes(j.status) && Number.isInteger(j.exitCode) && j.copyDeleted === true, 'the npm command ran under bubblewrap')} (${j.status}, exit ${j.exitCode}); ${card(r)}` : `${check(j?.status === 'held', 'npm held on Windows (no OS sandbox), nothing ran')}; ${card(r)}` }] },
  { id: 'release-readiness', stage: (home) => cpSync(fx('release-readiness/repo'), join(home, 'projects/cart'), { recursive: true }),
    steps: [{ tool: 'gates', job: 'all', plan: { operation: 'plan', project: 'cart' }, args: { operation: 'run', project: 'cart' }, expect: (r, j) => `${check(j?.verdict === 'blocked', 'verdict blocked')}; ${card(r)}` }] },
  { id: 'repository-onboarding', stage: (home) => cpSync(fx('repository-onboarding/repo'), join(home, 'projects/cards'), { recursive: true }),
    steps: [{ tool: 'onboard', job: true, plan: { operation: 'map', project: 'cards' }, pick: (p) => p.build.commands[0], args: (doc) => ({ operation: 'build', project: 'cards', command: doc.command, planSha: doc.planSha }), expect: (r, j) => `${check(j?.status === 'built' && j.exitCode === 0 && j.copyDeleted === true, 'built with exit 0, copy deleted')}; ${card(r)}` }] },
  // Signed Store shelf (native plugins; the MCP recipes are qualified separately)
  { id: 'weather-alerts', store: true, settings: () => ({ city: 'Kansas City' }), steps: [{ tool: 'check', args: {}, expect: (r) => `${check(r.content.length > 0 && !/didn.t answer/.test(r.content), 'an answer from Open-Meteo')}: ${r.content.slice(0, 140)}` }] },
  { id: 'focus', store: true, settings: () => ({ work: 25, rest: 5 }), steps: [{ tool: 'start', write: true, args: {}, expect: (r) => `${check(/25/.test(r.content + JSON.stringify(r.card ?? {})), 'a 25-minute session')}: ${r.content.slice(0, 120)}` }, { tool: 'stop', args: {}, expect: (r) => `stopped: ${r.content.slice(0, 120)}` }] },
  { id: 'reading-list', store: true, steps: [{ tool: 'add', write: true, args: { url: 'https://example.com/', title: 'Example page' }, expect: (r) => `added: ${r.content.slice(0, 120)}` }, { tool: 'list', args: {}, expect: (r) => `${check(/example\.com|Example page/.test(r.content + JSON.stringify(r.card ?? {})), 'the saved page listed')}: ${r.content.slice(0, 120)}` }] },
  { id: 'home-scenes', store: true, steps: [{ tool: 'scene', write: true, args: { action: 'save', name: 'movie night', steps: [{ entity_id: 'light.living_room', action: 'set_brightness', brightness: 20 }] }, expect: ok(/Saved/) }, { tool: 'scene', args: { action: 'list' }, expect: (r) => `${check(/movie night/.test(r.content), 'the saved scene listed')}: ${r.content}` },
    // Running a scene needs Sara's Home Assistant connection (home_control); without one it must say so, not claim it.
    { tool: 'scene', job: true, args: { action: 'run', name: 'movie night' }, expect: (r) => `${check(/not done/.test(r.content), 'an honest "not done" without Home Assistant')}: ${r.content.slice(0, 160)}` }] },
  { id: 'github-digest', store: true, settings: () => ({ repos: 'nodejs/node', user: '' }), steps: [] },
  { id: 'webhook-notes', store: true, settings: () => ({ matters: 'deploy.failed' }), steps: [{ webhook: { type: 'deploy.failed' } }] },
];

// ---- helpers over the real routes ------------------------------------------------------------
const pluginsView = () => api('GET', '/api/plugins');
async function state(id) { const v = await pluginsView(); return v.plugins.find((p) => p.id === id)?.companions.find((c) => c.id === CO); }
async function until(fn, ms = 30_000, what = 'condition') { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(150); } }
async function storeHash(id) {
  const index = json(join(DATA, 'store/index.json'));
  const item = index.items.find((x) => x.id === id); const v = item.versions.at(-1);
  const base = (await api('GET', '/api/store')).url ?? 'https://backstagecoding.com/sara/store';
  const zip = Buffer.from(await (await fetch(`${base.replace(/\/+$/, '')}/v1/${v.package}`)).arrayBuffer());
  const sha = createHash('sha256').update(zip).digest('hex');
  return { version: v.version, indexSha256: v.sha256, downloadedSha256: sha, size: zip.length, indexSize: v.size, match: sha === v.sha256 && (v.size === undefined || v.size === zip.length), contentSha: v.contentSha };
}
async function runTool(id, tool, args, job) {
  const full = (await state(id))?.tools.find((t) => t.endsWith(`__${tool}`));
  if (!full) throw new Error(`the plugin registered no ${tool} tool`);
  const call = api('POST', `/api/plugins/${id}/action`, { companion: CO, tool: full, args });
  if (!job) return { result: await call, approvals: [] };
  const approvals = []; let settled = false; call.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) {
    const w = (await pluginsView()).waiting.filter((x) => x.plugin === id && !approvals.some((a) => a.id === x.id));
    for (const x of w) { approvals.push({ id: x.id, command: x.job?.command ?? x.summary, fence: x.job?.fence }); await api('POST', `/api/plugins/${id}/calls/${x.id}`, { approved: true }); }
    if (job !== 'all' && approvals.length) break;
    await sleep(150);
  }
  return { result: await call, approvals };
}

let listener; let port = 0; const received = [];
async function startListener() {
  listener = createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { received.push({ method: req.method, url: req.url, body: b }); res.writeHead(200, { 'content-type': 'application/json', 'content-length': '11' }); res.end('{"ok":true}'); /* the workbench refuses chunked responses by design */ }); });
  await new Promise((r) => listener.listen(0, '127.0.0.1', r)); port = listener.address().port;
}

async function qualify(e) {
  const out = { id: e.id, os: OS, source: e.store ? 'signed-store' : 'local-candidate', steps: {} };
  const step = async (name, fn) => { try { out.steps[name] = { ok: true, evidence: await fn() }; } catch (err) { out.steps[name] = { ok: false, error: String(err.message ?? err).slice(0, 500) }; throw err; } };
  try {
    const cand = !e.store && (await api('GET', '/api/plugins/candidates')).candidates.find((c) => c.id === e.id);
    if (!e.store) await step('listed', () => check(cand && cand.availability === 'local-candidate' && !cand.installed, 'listed as an installable local candidate') && `${cand.availability} ${cand.version} contentSha ${cand.contentSha.slice(0, 12)}`);
    let review;
    await step('install', async () => {
      if (e.store) {
        const h = await storeHash(e.id); out.hash = h; check(h.match, `downloaded sha256 ${h.downloadedSha256} = signed index ${h.indexSha256}`);
        review = (await api('POST', '/api/store/install', { id: e.id })).review;
      } else review = await api('POST', '/api/plugins/install', { candidate: e.id });
      const row = await api('POST', `/api/plugins/${e.id}/approve`, { review: review.id, trust: review.needsTrust === true, consent: review.firstParty === true });
      check(row.companions.every((c) => !c.on), 'Off until enabled');
      if (e.store) check(row.sha === out.hash.contentSha, `installed content ${row.sha} = signed contentSha`);
      else check(row.sha === cand.contentSha, 'installed content = pinned candidate contentSha');
      return `${row.origin} ${row.version} fence=${review.fence} needsTrust=${review.needsTrust} sha=${row.sha.slice(0, 16)}${e.store ? ` download sha256 ${out.hash.downloadedSha256.slice(0, 16)} = index` : ''}`;
    });
    if (e.listener && !listener) await startListener();
    const values = e.settings?.(port);
    if (values) await step('settings', async () => {
      await api('PUT', `/api/plugins/${e.id}/settings`, { companion: CO, values });
      const back = await api('GET', `/api/plugins/${e.id}/settings?companion=${CO}`);
      const shown = Object.fromEntries((back.fields ?? back.settings ?? []).map((f) => [f.key, f.value]));
      const vals = back.values ?? shown;
      for (const [k, v] of Object.entries(values)) check(String(vals[k] ?? '') === String(v), `${k} shown again as ${v} (got ${JSON.stringify(vals[k])})`);
      return `saved and shown: ${JSON.stringify(values)}`;
    });
    if (e.stage) await step('stage', () => { const home = join(DATA, 'plugin-data', e.id, CO); mkdirSync(home, { recursive: true }); e.stage(home); return 'operator staged fixture in its data folder while Off'; });
    await step('enable', async () => {
      await api('POST', `/api/plugins/${e.id}/enable`, { companion: CO, on: true });
      const s = await until(async () => { const x = await state(e.id); return x?.on && x.state === 'ready' && x; }, 30_000, 'ready');
      return `on for ${CO}, ready, tools ${s.tools.join(',') || '(none)'}`;
    });
    let i = 0;
    for (const s of e.steps) {
      i++;
      if (s.webhook) {
        // Settings → Connections → Webhooks: a hook set to "Send to a plugin", then one real delivery.
        await step(`read${i}:webhook`, async () => {
          const made = await api('POST', '/api/hooks', { name: 'Q-ADDONS synthetic', verify: 'url', allowRuns: true, action: { kind: 'plugin', plugin: e.id } });
          try {
            const res = await fetch(new URL(new URL(made.url).pathname, BASE), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s.webhook) });
            check(res.status === 202, `the delivery accepted (got ${res.status})`);
            const line = await until(async () => (await api('GET', `/api/plugins/${e.id}/log`)).log.find((l) => /webhook/.test(l.detail) && l.kind !== 'log'), 15_000, 'the plugin event');
            const told = await until(async () => (await api('GET', `/api/plugins/${e.id}/log`)).log.find((l) => /notify|told|deploy\.failed/.test(l.detail)), 5_000, 'the notice').catch(() => undefined);
            return `delivery 202 → plugin: ${line.kind} "${line.detail.slice(0, 100)}"${told ? `; ${told.detail.slice(0, 100)}` : ''}`;
          } finally { await api('DELETE', `/api/hooks/${made.hook.id}`); }
        });
        continue;
      }
      await step(`${s.write ? 'write' : 'read'}${i}:${s.tool}`, async () => {
        let args = s.args; let planNote = '';
        if (s.plan) {
          const p = (await runTool(e.id, s.tool, s.plan, false)).result; const pj = parsed(p);
          check(pj, 'a plan'); s.planCheck?.(pj);
          const picked = s.pick ? s.pick(pj) : pj; check(picked, 'a planned command');
          args = typeof s.args === 'function' ? s.args(picked) : { ...s.args, planSha: pj.planSha };
          planNote = `plan ${String(picked.planSha ?? pj.planSha).slice(0, 12)}${picked.command ? ` "${picked.command}"` : ''}; `;
        }
        const { result, approvals } = await runTool(e.id, s.tool, args, s.job);
        if (s.job) check(approvals.length > 0, 'an owner approval card was approved');
        let ev;
        try { ev = s.expect(result, parsed(result)); } catch (err) { throw new Error(`${err.message}; got: ${String(result.content).slice(0, 400)}`); }
        return `${planNote}${approvals.length ? `approved ${approvals.length} job(s): ${approvals.map((a) => `"${a.command}" [${a.fence}]`).join(', ')}; ` : ''}${ev}`;
      });
    }
    if (e.listener) out.listenerReceived = received.map((r) => `${r.method} ${r.url}`);
    await step('disable', async () => {
      await api('POST', `/api/plugins/${e.id}/enable`, { companion: CO, on: false });
      const s = await until(async () => { const x = await state(e.id); return x && !x.on && x.state === 'stopped' && x; }, 15_000, 'stopped');
      return `off, ${s.state}, tools ${s.tools.length}`;
    });
    await step('remove', async () => {
      await api('DELETE', `/api/plugins/${e.id}`);
      const gone = !(await pluginsView()).plugins.some((p) => p.id === e.id);
      const dirs = [join(DATA, 'plugins', e.id), join(DATA, 'plugin-data', e.id)].filter((d) => existsSync(d));
      check(gone && !dirs.length, `plugin row and folders gone (left: ${dirs.join(', ') || 'none'})`);
      if (!e.store) check(!(await api('GET', '/api/plugins/candidates')).candidates.find((c) => c.id === e.id).installed, 'candidate shows not installed');
      if (e.store) check(!(await api('GET', '/api/store')).items.find((x) => x.id === e.id)?.installed, 'Store shows not installed');
      return 'row, plugins/<id> and plugin-data/<id> removed; listed as installable again';
    });
    out.result = e.steps.length ? 'pass' : 'pass-lifecycle-only';
  } catch {
    out.result = 'fail';
    try { if ((await pluginsView()).plugins.some((p) => p.id === e.id)) await api('DELETE', `/api/plugins/${e.id}`); } catch { /* recorded above */ }
  }
  return out;
}

const results = existsSync(OUT) ? json(OUT) : [];
const fresh = await api('POST', '/api/store/check', {}); // Get more: the signed list, verified by Sara
console.log(`store: seq ${fresh.store?.seq} ${fresh.store?.freshness}; fence ${(await pluginsView()).fence}`);
for (const e of ENTRIES) {
  if (ONLY.length && !ONLY.includes(e.id)) continue;
  const r = await qualify(e);
  const i = results.findIndex((x) => x.id === r.id && x.os === r.os);
  if (i >= 0) results[i] = r; else results.push(r);
  writeFileSync(OUT, JSON.stringify(results, null, 1) + '\n');
  console.log(`${r.result.padEnd(20)} ${r.id}${r.result === 'fail' ? ' :: ' + Object.entries(r.steps).filter(([, s]) => !s.ok).map(([k, s]) => `${k}: ${s.error}`).join(' | ') : ''}`);
}
listener?.close();

// Companion packs (every folder in store/companions): the real "Add her" route from the pack file, and,
// when the signed index lists her, Get more's own path (POST /api/store/install → the pack card →
// Add her → Retire her), checking the card carries the signed content hash. Each is added and retired
// twice in a row (the retire-within-20-s crash regression).
if (!ONLY.length || ONLY.includes('companions')) {
  const { zipStored } = await imp('src/zip-write.ts');
  const { readdirSync, statSync } = await import('node:fs');
  const walk = (d, rel = '') => readdirSync(d).flatMap((n) => statSync(join(d, n)).isDirectory() ? walk(join(d, n), `${rel}${n}/`) : [{ path: `${rel}${n}`, data: readFileSync(join(d, n)) }]);
  // The Store client's verified copy of the signed index (fetched at start; asked for if not there yet).
  for (let i = 0; i < 30 && !existsSync(join(DATA, 'store/index.json')); i++) { await api('POST', '/api/store/check', {}).catch(() => {}); await sleep(2000); }
  const signed = json(join(DATA, 'store/index.json')).items.filter((x) => x.kind === 'companion').map((x) => x.id);
  const signedItems = json(join(DATA, 'store/index.json')).items;
  for (const id of readdirSync(join(ROOT, 'store/companions')).filter((n) => statSync(join(ROOT, 'store/companions', n)).isDirectory()).sort()) {
    const out = { id, os: OS, source: 'companion-pack-file', steps: {}, inSignedIndex: signed.includes(id) };
    const step = async (name, fn) => { try { out.steps[name] = { ok: true, evidence: await fn() }; } catch (err) { out.steps[name] = { ok: false, error: String(err.message).slice(0, 400) }; throw err; } };
    let made;
    try {
      const pack = zipStored(walk(join(ROOT, 'store/companions', id)));
      let token;
      await step('preview', async () => {
        const res = await fetch(`${BASE}/api/packs/preview`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/octet-stream' }, body: pack });
        const j = await res.json(); if (!res.ok) throw new Error(`preview ${res.status}: ${j.error}`);
        token = j.token; return `card "${j.card.name}" ${j.card.version ?? ''} from file (${pack.length} bytes)`;
      });
      await step('add-her', async () => {
        const before = (await api('GET', '/api/companions')).companions.map((c) => c.id);
        const r = await api('POST', `/api/packs/${token}/install`, {});
        const after = (await api('GET', '/api/companions')).companions;
        made = after.find((c) => !before.includes(c.id)); check(made, 'a new companion');
        return `added companion ${made.id} "${made.name}"; others unchanged (${before.length} → ${after.length}); follow-ups ${JSON.stringify(r.followUps ?? []).slice(0, 120)}`;
      });
      await step('retire', async () => {
        await api('DELETE', `/api/companions/${made.id}`);
        check(!(await api('GET', '/api/companions')).companions.some((c) => c.id === made.id), 'she is gone from the list');
        made = undefined;
        return 'retired; no longer listed'; });
      if (out.inSignedIndex) {
        const item = signedItems.find((x) => x.id === id && x.kind === 'companion');
        const v = item.versions.find((x) => x.version === item.latest);
        for (const round of [1, 2]) {
          let card;
          await step(`store-card-${round}`, async () => {
            const r = await api('POST', '/api/store/install', { id });
            check(r.kind === 'companion' && r.token, 'a companion card from the Store');
            card = r;
            check(r.card.fingerprint === v.contentSha, `the card's fingerprint is the signed contentSha (${String(r.card.fingerprint).slice(0, 12)})`);
            return `Store card "${r.card.name}" ${item.latest} (signed sha256 ${v.sha256.slice(0, 12)}, content ${v.contentSha.slice(0, 12)})`;
          });
          await step(`store-add-${round}`, async () => {
            const before = (await api('GET', '/api/companions')).companions.map((c) => c.id);
            const r = await api('POST', `/api/packs/${card.token}/install`, {});
            const after = (await api('GET', '/api/companions')).companions;
            made = after.find((c) => !before.includes(c.id)); check(made, 'a new companion from the Store');
            const mine = await api('GET', '/api/packs/installed');
            const row = mine.installs.find((x) => x.companion_id === made.id);
            check(row && row.origin === 'store' && row.content_sha === v.contentSha, `pack_installs row origin store, content ${v.contentSha.slice(0, 12)}: ${JSON.stringify(row).slice(0, 200)}`);
            return `added ${made.id} "${made.name}" from the Store; ${before.length} → ${after.length}; installed content = signed contentSha; follow-ups ${(r.followUps ?? []).length}`;
          });
          await step(`store-retire-${round}`, async () => {
            await api('DELETE', `/api/companions/${made.id}`);
            check(!(await api('GET', '/api/companions')).companions.some((c) => c.id === made.id), 'she is gone from the list');
            made = undefined;
            return 'retired; no longer listed';
          });
        }
      }
      out.result = out.inSignedIndex ? 'pass' : 'held-unpublished (file path passes)';
    } catch (err) { out.result = "fail"; out.error ??= String(err.message).slice(0, 300); if (made) await api('DELETE', `/api/companions/${made.id}`).catch(() => {}); }
    const i = results.findIndex((x) => x.id === out.id && x.os === OS);
    if (i >= 0) results[i] = out; else results.push(out);
    writeFileSync(OUT, JSON.stringify(results, null, 1) + '\n');
    console.log(`${out.result.padEnd(20)} ${id}${out.result === 'fail' ? ' :: ' + JSON.stringify(out.steps).slice(0, 400) : ''}`);
  }
}

// Held and not-yet-published entries must not be installable from Settings (Workflow candidates or Get more).
if (!ONLY.length || ONLY.includes('held')) {
  const inv = json(join(ROOT, 'docs/ops/A2_INVENTORY.json'));
  const candidates = (await api('GET', '/api/plugins/candidates')).candidates;
  const shelf = (await api('GET', '/api/store')).items;
  const notInstallable = inv.entries.filter((x) => /^no/.test(x.installable)).map((x) => x.id);
  const offered = notInstallable.filter((id) => candidates.some((c) => c.id === id && c.availability === 'local-candidate') || shelf.some((s) => s.id === id && s.canRun));
  const held = { id: 'held-entries', os: OS, checked: notInstallable, candidateCount: candidates.length, shelfIds: shelf.map((s) => s.id), offered, result: offered.length ? 'fail' : 'pass' };
  const i = results.findIndex((x) => x.id === held.id && x.os === OS);
  if (i >= 0) results[i] = held; else results.push(held);
  writeFileSync(OUT, JSON.stringify(results, null, 1) + '\n');
  console.log(`${held.result.padEnd(20)} held/unpublished entries not offered (${notInstallable.length} checked; offered: ${offered.join(',') || 'none'})`);
}
