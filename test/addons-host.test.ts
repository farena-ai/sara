import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanCard, type PluginCard } from '../src/hooks.ts';
import { fromFolder, hashFiles, type PackageFile } from '../src/packages.ts';
import { PluginManager } from '../src/plugins/manager.ts';
import { pluginToolName } from '../src/plugins/manifest.ts';
import { splitListing } from '../src/store/checks.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

// Real host/process/SQLite qualification; direct registered invocation is NOT chat approval proof.
const IDS = ['daily-briefing', 'meeting-assistant', 'document-desk', 'research-notebook', 'project-handoff', 'weekly-review', 'inbox-triage', 'content-studio', 'image-workshop', 'spreadsheet-assistant', 'travel-planner', 'home-dashboard'] as const;
type NativeId = typeof IDS[number];
type Report = Record<string, any>;
const NAMES: Record<NativeId, string> = {
  'daily-briefing': 'brief', 'meeting-assistant': 'extract', 'document-desk': 'inspect',
  'research-notebook': 'notebook', 'project-handoff': 'snapshot', 'weekly-review': 'review',
  'inbox-triage': 'workflow', 'content-studio': 'workflow', 'image-workshop': 'workflow',
  'spreadsheet-assistant': 'workflow', 'travel-planner': 'workflow', 'home-dashboard': 'workflow',
};
const ITEM = { id: 'source-1', kind: 'source', title: 'Synthetic memo', text: 'Invented evidence for host qualification only.' };
const ARGS: Record<NativeId, Record<string, unknown>> = {
  'daily-briefing': { sources: [{ id: 'agenda', label: 'Synthetic agenda', text: '09:00 Design review\n11:00 Write draft' }] },
  'meeting-assistant': { transcript: 'Decision: Ship a draft\nAction: Review copy | owner=Alex | due=2026-11-09\nQuestion: Who approves?' },
  'document-desk': { mode: 'compare', sources: [{ id: 'old', label: 'Old draft', text: 'Shared\nOld clause' }, { id: 'new', label: 'New draft', text: 'Shared\nNew clause' }] },
  'research-notebook': { operation: 'put', item: ITEM },
  'project-handoff': { sources: [{ id: 'tests', label: 'Synthetic test claim', role: 'tested', text: '2 tests passed (invented supplied log, not proof)' }] },
  'weekly-review': { accomplishments: 'Wrote the brief', commitments: [{ id: 'c1', text: 'Publish draft', status: 'pending' }, { id: 'c2', text: 'Write brief', status: 'done' }, { id: 'c3', text: 'Review', status: 'blocked' }] },
  'inbox-triage': { messages: [{ id: 'm1', subject: 'Urgent invoice', body: 'Please review today.' }, { id: 'm2', subject: 'Newsletter', body: 'News only.' }] },
  'content-studio': { brief: 'Launch a community garden', audience: 'Neighbors', tone: 'warm', channel: 'newsletter', useModel: false },
  'image-workshop': { action: 'prepare', brief: 'A ceramic vase', style: 'product', aspect: '1:1', avoid: 'logos', seed: 42 },
  'spreadsheet-assistant': { csv: 'name,amount,note\r\n"Alex, A",2.5,"line one\nline two"\r\nBea,-1,=SUM(A1)\r\n', filter: { column: 'name', equals: 'Bea' } },
  'travel-planner': { start: '2026-12-01', end: '2026-12-03', currency: 'USD', budget: 300, preferences: 'Museums and walking', options: [{ id: 'o1', date: '2026-12-02', title: 'Museum', amount: 25, source: 'Synthetic supplied price list', checked: '2026-11-01', confirmed: true }] },
  'home-dashboard': { observedAt: '2026-11-05T12:00:00Z', devices: [{ id: 'light.desk', name: 'Desk lamp', state: 'on', approved: true }], scenes: [{ id: 'scene.evening', name: 'Evening', approved: true }] },
};
async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: exceeded 10000 ms`)), 10_000); })]); }
  finally { clearTimeout(timer); }
}
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) { assert.ok(Date.now() < deadline, `${label}: not satisfied within 10000 ms`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
type CompanionView = { id: string; on: boolean; state: string; tools: string[] };
function companions(pm: PluginManager, id: string): CompanionView[] {
  const row = pm.store.get(id); assert.ok(row, `installed row: ${id}`);
  return pm.view(row).companions as CompanionView[];
}
function pluginTools(app: TestApp): string[] { return app.tools.list().filter(tool => tool.source?.startsWith('Plugin: ')).map(tool => tool.spec.name).sort(); }
function noExternal(pm: PluginManager, apps: TestApp[]): void {
  assert.deepEqual(pm.waiting(), [], 'no pending plugin-to-host external-tool approvals');
  for (const app of apps) {
    assert.equal(app.providerCalls, 0); assert.deepEqual(app.requests, []);
    assert.deepEqual(app.approvals.pendingFor('synthetic-host-turn'), []);
  }
  assert.deepEqual(pm.opts.db.prepare("SELECT * FROM budget_ledger WHERE source LIKE 'plugin:%'").all(), [], 'no model budget usage');
  for (const row of pm.store.all()) assert.deepEqual(pm.store.logs(row.id).filter(log => ['call', 'denied', 'crash', 'timeout'].includes(log.kind)), [], 'no external broker calls or runtime errors');
}
async function withHost(t: TestContext, body: (pm: PluginManager, main: TestApp, other: TestApp) => Promise<void>): Promise<void> {
  const { dir, cleanup } = tempDir(); const apps: TestApp[] = []; let pm: PluginManager | undefined;
  try {
    for (const id of ['main', 'other']) {
      const dataDir = id === 'main' ? dir : join(dir, 'other-app'); mkdirSync(dataDir, { recursive: true });
      const app = makeApp(dataDir, { now: new Date('2026-11-05T12:00:00Z') }); app.companionId = id;
      app.providerFactory = () => { app.providerCalls++; throw new Error('Providers forbidden in host qualification'); }; apps.push(app);
    }
    pm = new PluginManager({ db: apps[0].store.db, dataDir: dir, vault: apps[0].vault, sandbox: apps[0].sandbox, events: apps[0].events, scrub: s => s, fence: 'node-only', lookup: async () => { throw new Error('DNS forbidden'); }, httpGet: async () => { throw new Error('HTTP forbidden'); } });
    for (const app of apps) { app.pluginManager = pm; pm.attach(app.companionId!, app); }
    await body(pm, apps[0], apps[1]); noExternal(pm, apps);
  } finally {
    try {
      if (pm) {
        for (const row of pm.store.all()) t.diagnostic(JSON.stringify({ plugin: row.id, approvedSha: row.approved_sha, fence: pm.fence, companions: companions(pm, row.id), logs: pm.store.logs(row.id).reverse().map(({ kind, companion, detail }) => ({ kind, companion, detail })) }));
        await pm.stopAll();
        for (const row of pm.store.all()) assert.ok(companions(pm, row.id).every(c => c.state === 'stopped' && c.tools.length === 0));
        for (const app of apps) assert.deepEqual(pluginTools(app), [], 'shutdown unregistered own tools');
      }
    } finally {
      try { for (const app of apps) app.store.close(); }
      finally { cleanup(); await until(() => { cleanup(); return !existsSync(dir); }, 'synthetic temp directory removed'); t.diagnostic('cleanup: manager stopped; databases closed; synthetic temp directory removed'); }
    }
  }
}
function packageFor(id: NativeId): PackageFile[] { return splitListing(fromFolder(join(ROOT, 'store', 'plugins', id))).pkg; }
async function install(pm: PluginManager, files: PackageFile[], id: string, candidate = false): Promise<void> {
  const review = candidate ? pm.stageCandidate(id) : pm.stage(files, { kind: 'zip', where: `synthetic-${id}.zip` });
  if (candidate) assert.deepEqual(review.origin, { kind: 'candidate', where: id });
  assert.equal(review.manifest.id, id); assert.equal(review.fence, 'node-only');
  assert.equal(review.needsTrust, true, 'node-only is not an OS sandbox');
  assert.equal(review.firstParty, undefined, 'fixture does not impersonate signed store provenance');
  assert.deepEqual(review.unknownCallTools, []); assert.equal(pm.store.get(id), undefined);
  await assert.rejects(pm.approve(review.id), /trust this plugin.s author/i);
  const row = await pm.approve(review.id, { trust: true }); const stored = pm.store.get(id)!;
  assert.equal(stored.approved_sha, hashFiles(files)); assert.equal(stored.dir, row.dir);
  assert.equal(hashFiles(fromFolder(stored.dir)), stored.approved_sha, 'installed bytes read back exactly'); assert.equal(pm.verify(id), true);
  for (const c of companions(pm, id)) assert.deepEqual({ on: c.on, state: c.state, tools: c.tools }, { on: false, state: 'stopped', tools: [] });
  assert.equal(existsSync(pm.dataDirFor(id, 'main')), false, 'no process data directory before explicit enable');
}
async function enable(pm: PluginManager, app: TestApp, id: string, localName: string): Promise<Tool> {
  await pm.setEnabled(id, app.companionId!, true); const full = pluginToolName(id, localName);
  await until(() => companions(pm, id).some(c => c.id === app.companionId && c.state === 'ready') && app.tools.get(full)?.isAvailable?.() === true, `${id}/${app.companionId} ready`);
  const tool = app.tools.get(full)!; assert.equal(tool.spec.name, full); assert.equal(tool.defaultPermission, 'ask');
  assert.equal(app.tools.permission(full, {}), 'ask'); assert.equal(tool.isAvailable?.(), true); assert.ok(app.tools.enabled({}).includes(tool)); return tool;
}
async function invoke(t: TestContext, app: TestApp, tool: Tool, args: Record<string, unknown>, json = true): Promise<{ content: string; report: Report; cards: PluginCard[] }> {
  const cards: PluginCard[] = [];
  const ctx: ToolContext = { workspaceDir: app.dataDir, sandbox: app.sandbox, signal: AbortSignal.timeout(10_000), conversationId: 'synthetic-host-turn', attachCard: card => cards.push(card) };
  const content = await bounded(tool.run(structuredClone(args), ctx), `${tool.spec.name} run`);
  assert.ok(content.trim() && content !== '(no output)'); assert.ok(content.length <= 64 * 1024);
  const report = json ? JSON.parse(content) as Report : {};
  if (json) assert.ok(report && typeof report === 'object' && Object.keys(report).length > 0, 'nonempty JSON, not silently cut');
  // All twelve native workflows now expose bounded, localized result cards.
  const returnsCard = IDS.some(id => tool.spec.name === pluginToolName(id, NAMES[id])) || tool.spec.name === pluginToolName('host-boundary-fixture', 'probe');
  assert.equal(cards.length, returnsCard ? 1 : 0, 'package result contract reaches the host unchanged');
  for (const card of cards) {
    assert.equal(card.kind, 'plugin'); assert.ok(card.title.length <= 120 && card.title.trim()); assert.ok(card.lines.length > 0 && card.lines.length <= 8);
    assert.ok(card.lines.every(line => line.length <= 200 && !/[\u0000-\u001f]/.test(line)));
    assert.deepEqual(card, cleanCard(card, { id: card.plugin, name: card.name, tools: [tool.spec.name] }));
  }
  t.diagnostic(JSON.stringify({ tool: tool.spec.name, characters: content.length, report, cards })); return { content, report, cards };
}
async function disable(pm: PluginManager, app: TestApp, id: string, tool: Tool): Promise<void> {
  await pm.setEnabled(id, app.companionId!, false); assert.equal(pm.enabledFor(id, app.companionId!), false); assert.equal(app.tools.get(tool.spec.name), undefined);
  assert.equal(tool.isAvailable?.(), false, 'retained reference unavailable after disable'); assert.ok(!app.tools.enabled({}).some(t => t.spec.name === tool.spec.name));
  await assert.rejects(tool.run({}, { workspaceDir: app.dataDir, sandbox: app.sandbox, signal: AbortSignal.timeout(10_000) }), /no longer available/i);
  const c = companions(pm, id).find(c => c.id === app.companionId)!; assert.deepEqual({ state: c.state, tools: c.tools }, { state: 'stopped', tools: [] });
}
function honest(id: NativeId, r: Report): void {
  switch (id) {
    case 'daily-briefing': assert.equal(r.sections.agenda[0].quote, '09:00 Design review'); assert.equal(r.sections.agenda[0].source, 'agenda'); assert.match(r.unknowns.join(' '), /not checked/); break;
    case 'meeting-assistant': assert.equal(r.actions[0].owner, 'Alex'); assert.equal(r.actions[0].ref, 'transcript:L2'); assert.equal(r.recorded, false); assert.equal(r.tasksCreated, false); break;
    case 'document-desk': assert.equal(r.onlyLeft[0].quote, 'Old clause'); assert.equal(r.onlyRight[0].source, 'new'); assert.match(r.method, /Exact line/); break;
    case 'research-notebook': assert.equal(r.saved, true); assert.equal(r.id, ITEM.id); assert.equal(r.status, 'saved-locally'); break;
    case 'project-handoff': assert.equal(r.independentlyVerified, false); assert.equal(r.sections.tested[0].verification, 'user-supplied; not independently verified'); break;
    case 'weekly-review': assert.deepEqual(r.proposedPlan.map((x: Report) => x.id), ['c1']); assert.equal(r.done[0].id, 'c2'); assert.equal(r.blocked[0].id, 'c3'); assert.equal(r.tasksChanged, false); break;
    case 'inbox-triage': assert.equal(r.items[0].id, 'm1'); assert.equal(r.items[0].priority, 'high'); assert.equal(r.items[0].actionRequest, 'Please review today.'); assert.equal(r.sent, false); break;
    case 'content-studio': assert.match(r.draft, /community garden/); assert.equal(r.export.text, r.draft); assert.equal(r.published, false); break;
    case 'image-workshop': assert.match(r.prompt, /ceramic vase/); assert.equal(r.generated, false); assert.equal(r.status, 'preparation only'); assert.match(r.prerequisite, /exact MCP tool name/); break;
    case 'spreadsheet-assistant': assert.equal(r.rows, 2); assert.equal(r.selectedRows, 1); assert.equal(r.columns[1].sum, 1.5); assert.match(r.export.text, /'=SUM\(A1\)/); assert.equal(r.formulaEscapes, 2); break;
    case 'travel-planner': assert.equal(r.itinerary[0].sourceId, 'o1'); assert.equal(r.suppliedTotal, 25); assert.equal(r.remainingBudget, 275); assert.equal(r.booked, false); assert.match(r.priceStatus, /not live quotes/); break;
    case 'home-dashboard': assert.equal(r.devices[0].id, 'light.desk'); assert.equal(r.devices[0].suppliedState, 'on'); assert.equal(r.live, false); assert.equal(r.controlled, false); assert.match(r.prerequisite, /home_status/); break;
  }
}

test('host qualification covers exactly twelve distinct native packages and tool names', () => {
  assert.equal(IDS.length, 12); assert.equal(new Set(IDS).size, 12); assert.deepEqual(Object.keys(ARGS).sort(), [...IDS].sort()); assert.deepEqual(Object.keys(NAMES).sort(), [...IDS].sort());
  for (const id of IDS) { const m = JSON.parse(readFileSync(join(ROOT, 'store/plugins', id, 'sara-plugin.json'), 'utf8')); assert.equal(m.id, id); assert.deepEqual(m.permissions.tools, [NAMES[id]]); }
});
test('host tracer regression: missing package manifest marker rejected without installation', async t => {
  await withHost(t, async (pm, main, other) => {
    assert.throws(() => pm.stage(packageFor('daily-briefing').filter(f => f.path !== 'sara-plugin.json'), { kind: 'zip', where: 'synthetic-missing-marker.zip' }), /There is no sara-plugin.json/);
    assert.deepEqual(pm.store.all(), []); assert.deepEqual(pluginTools(main), []); assert.deepEqual(pluginTools(other), []);
  });
});
for (const candidate of [false, true]) for (const id of IDS) {
  test(`${id}: real ${candidate ? 'stageCandidate' : 'stage'} → approve → explicit enable → registered run → disable`, { timeout: 45_000 }, async t => {
    await withHost(t, async (pm, main, other) => {
      await install(pm, candidate ? fromFolder(join(ROOT, 'store/plugins', id)) : packageFor(id), id, candidate); assert.deepEqual(pluginTools(main), []); assert.deepEqual(pluginTools(other), []);
      const tool = await enable(pm, main, id, NAMES[id]); const exact = [pluginToolName(id, NAMES[id])];
      assert.deepEqual(pluginTools(main), exact); assert.deepEqual(companions(pm, id).find(c => c.id === 'main')!.tools, exact);
      assert.deepEqual(pluginTools(other), []); assert.equal(pm.enabledFor(id, 'other'), false); assert.equal(companions(pm, id).find(c => c.id === 'other')!.state, 'stopped'); assert.equal(existsSync(pm.dataDirFor(id, 'other')), false);
      const { report, cards } = await invoke(t, main, tool, ARGS[id]); for (const card of cards) { assert.equal(card.plugin, id); assert.equal(card.name, pm.manifestOf(pm.store.get(id)!).name); }
      honest(id, report); noExternal(pm, [main, other]);
      if (id === 'research-notebook') { assert.equal((await invoke(t, main, tool, { operation: 'get', id: ITEM.id })).report.item.text, ITEM.text); assert.equal(JSON.parse(pm.store.kvGet(id, 'main', 'notebook-v1')!).items[0].text, ITEM.text); }
      await disable(pm, main, id, tool); assert.deepEqual(pluginTools(main), []); assert.ok(pm.store.logs(id).some(log => log.kind === 'tool' && log.detail === `${NAMES[id]} ran`));
    });
  });
}
for (const candidate of [false, true]) test(`research notebook${candidate ? ' candidate' : ''}: actual host SQLite survives restart and isolates two synthetic companions`, { timeout: 45_000 }, async t => {
  await withHost(t, async (pm, main, other) => {
    const id = 'research-notebook'; await install(pm, candidate ? fromFolder(join(ROOT, 'store/plugins', id)) : packageFor(id), id, candidate); let tool = await enable(pm, main, id, 'notebook');
    assert.equal((await invoke(t, main, tool, { operation: 'put', item: ITEM })).report.saved, true);
    const before = pm.opts.db.prepare('SELECT plugin, companion, key, value FROM plugin_kv').all(); assert.equal(before.length, 1); assert.equal(before[0].companion, 'main'); assert.equal(before[0].key, 'notebook-v1');
    const otherTool = await enable(pm, other, id, 'notebook'); assert.deepEqual((await invoke(t, other, otherTool, { operation: 'list' })).report.items, []);
    const otherItem = { ...ITEM, text: 'Different synthetic companion evidence.' }; assert.equal((await invoke(t, other, otherTool, { operation: 'put', item: otherItem })).report.saved, true);
    const rows = pm.opts.db.prepare('SELECT companion, value FROM plugin_kv WHERE plugin = ? AND key = ? ORDER BY companion').all(id, 'notebook-v1');
    assert.equal(rows.length, 2); assert.deepEqual(rows.map(row => row.companion), ['main', 'other']); assert.equal(JSON.parse(rows[0].value as string).items[0].text, ITEM.text); assert.equal(JSON.parse(rows[1].value as string).items[0].text, otherItem.text);
    await disable(pm, main, id, tool); tool = await enable(pm, main, id, 'notebook');
    assert.equal((await invoke(t, main, tool, { operation: 'get', id: ITEM.id })).report.item.text, ITEM.text); assert.equal((await invoke(t, other, otherTool, { operation: 'get', id: ITEM.id })).report.item.text, otherItem.text);
    assert.equal((await invoke(t, main, tool, { operation: 'export' })).report.savedFile, false); assert.equal((await invoke(t, main, tool, { operation: 'delete', id: ITEM.id })).report.deleted, ITEM.id);
    assert.deepEqual((await invoke(t, main, tool, { operation: 'list' })).report.items, []); assert.equal((await invoke(t, other, otherTool, { operation: 'get', id: ITEM.id })).report.item.text, otherItem.text);
    await disable(pm, main, id, tool); await disable(pm, other, id, otherTool);
  });
});
test('daily briefing: large valid evidence is explicitly refused or returned as complete bounded JSON', { timeout: 45_000 }, async t => {
  await withHost(t, async (pm, main) => {
    const id = 'daily-briefing';
    await install(pm, packageFor(id), id);
    const tool = await enable(pm, main, id, 'brief');
    const sources = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, label: 'L'.repeat(80), text: Array(80).fill('a').join('\n') }));
    let content: string | undefined;
    try {
      content = await bounded(tool.run({ sources }, { workspaceDir: main.dataDir, sandbox: main.sandbox, signal: AbortSignal.timeout(10_000) }), 'large daily briefing');
    } catch (error) {
      // Refusal must be deliberate, not a timeout/parser/infrastructure error.
      assert.equal((error as Error).name, 'ToolError');
      assert.match((error as Error).message, /result|output|response|limit|bound|large|short|split|exceed/i);
      t.diagnostic(JSON.stringify({ largeBriefing: 'explicit-refusal', error: (error as Error).message }));
    }
    if (content !== undefined) {
      assert.ok(content.length <= 64 * 1024);
      let report: Report = {};
      assert.doesNotThrow(() => { report = JSON.parse(content!); }, 'successful large output must not be silently truncated by the host');
      assert.equal(report.sources.length, sources.length);
      for (const source of sources) {
        assert.equal(report.sources.find((s: Report) => s.id === source.id)?.label, source.label);
        assert.equal(report.sections[source.id].length, 80, 'successful output preserves all evidence lines');
        assert.ok(report.sections[source.id].every((line: Report) => line.quote === 'a' && line.source === source.id));
      }
      t.diagnostic(JSON.stringify({ largeBriefing: 'complete-bounded-json', characters: content.length }));
    }
    await disable(pm, main, id, tool);
  });
});

test('travel planner: exact decimal money does not invent over-budget status', { timeout: 45_000 }, async t => {
  await withHost(t, async (pm, main) => {
    const id = 'travel-planner';
    await install(pm, packageFor(id), id);
    const tool = await enable(pm, main, id, 'workflow');
    const args = { start: '2026-12-01', end: '2026-12-02', currency: 'USD', budget: 0.3, preferences: 'Two synthetic options', options: [
      { id: 'o1', date: '2026-12-01', title: 'First option', amount: 0.1, source: 'Synthetic confirmed estimate', checked: '2026-11-01', confirmed: true },
      { id: 'o2', date: '2026-12-02', title: 'Second option', amount: 0.2, source: 'Synthetic confirmed estimate', checked: '2026-11-01', confirmed: true },
    ] };
    const { report } = await invoke(t, main, tool, args);
    assert.equal(report.overBudget, false, '0.10 + 0.20 must not exceed a 0.30 budget');
    assert.equal(report.suppliedTotal, 0.3); assert.equal(report.remainingBudget, 0); assert.equal(report.booked, false);
    await disable(pm, main, id, tool);
  });
});

test('host boundary fixture: registered tool content cap and untrusted card sanitization', { timeout: 45_000 }, async t => {
  await withHost(t, async (pm, main) => {
    const id = 'host-boundary-fixture';
    const manifest = { manifest: 1, id, name: 'Host boundary fixture', description: 'Synthetic host boundary probe only.', version: '1.0.0', sara: '>=2.65.0', main: 'main.mjs', permissions: { tools: ['probe'] } };
    const files = [{ path: 'sara-plugin.json', data: Buffer.from(JSON.stringify(manifest)) }, { path: 'main.mjs', data: Buffer.from(`import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify({v:1,...m})+'\\n');
createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if (m.type === 'init') send({type:'ready',tools:[{name:'probe',permission:'auto',parameters:{type:'object',properties:{}}}]});
 if (m.type === 'tool') send({type:'result',id:m.id,content:'x'.repeat(70000),card:{title:'T'.repeat(150),lines:Array(10).fill('L\\u0000'.repeat(240)),link:'javascript:alert(1)',image:'../escape.png',buttons:[{label:'go',tool:'not-declared',args:{}}],html:'<script>never</script>'}});
});`) }];
    await install(pm, files, id); const tool = await enable(pm, main, id, 'probe'); assert.equal(tool.defaultPermission, 'ask', 'host caps plugin auto request to ask');
    const { content, cards } = await invoke(t, main, tool, {}, false); assert.equal(content.length, 64 * 1024); assert.equal(content, 'x'.repeat(64 * 1024 - 1) + '…');
    assert.equal(cards[0].title.length, 120); assert.equal(cards[0].lines.length, 8); assert.ok(cards[0].lines.every(line => line.length === 200)); assert.equal(cards[0].link, undefined); assert.equal(cards[0].image, undefined); assert.equal(cards[0].buttons, undefined); assert.equal('html' in cards[0], false);
    await disable(pm, main, id, tool);
  });
});
