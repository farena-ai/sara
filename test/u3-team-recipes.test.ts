// U3.16 (docs/AGENT_TEAMS.md "Team recipes"): after a finished team run, "Save as a team recipe"
// keeps the plan's shape (roles, models = Auto unless pinned, tools, budgets, dependencies, the
// checker's rules, the result type) with {job} where the job text was. Recipes never keep secrets
// or results; they list on the Team runs page (run, edit, duplicate, delete), export/import as JSON,
// and the team_run tool starts from one by name. A scripted model plays the lead and the helpers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import type { ChatRequest, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { RunStore } from '../src/runs.ts';
import { createSaraServer } from '../src/server.ts';
import { RECIPE_KIND, TeamRecipeError } from '../src/team-recipes.ts';
import { createTeamRunTools, TeamRuns } from '../src/team-runs.ts';
import { listDir, readFileTool, writeFileTool } from '../src/tools/builtin.ts';
import type { Tool } from '../src/tools/types.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const say = (s: string): StreamEvent[] => [{ type: 'text', text: s }];
// Built at run time: nothing that looks like a real key sits in the source.
const fakeKey = () => ['sk', 'Q'.repeat(28)].join('-');
const GOAL = 'Compare three e-bikes under $2,000 for city commuting';

function rig(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-16T15:00:00Z') };
  const app = makeApp(dir, clock);
  for (const tool of [listDir, readFileTool, writeFileTool]) app.tools.add(tool);
  const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({ spec: { name, description: name, parameters: { type: 'object', properties: {} } }, defaultPermission: 'ask', summarize: () => name, run: async () => `${name} done`, ...extra });
  app.tools.add(tool('web_fetch', { interruptible: true }));
  app.tools.add(tool('shell', { runsCommands: true }));
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }, { id: 'here', label: 'Here', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString(), toolPermissions: { list_dir: 'auto', read_file: 'auto', write_file: 'ask' } });
  let leads = 0;
  app.providerFactory = (config: ProviderConfig) => ({
    config,
    listModels: async () => ['m'],
    async *stream(req: ChatRequest) {
      const all = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      if (all.includes('You plan a team run')) {
        leads++;
        yield* say(JSON.stringify(PLAN));
      } else if (all.includes('the checker on a team run')) yield* say('All fine.\nVERDICT: OK');
      else yield* say('Done: the draft.');
    },
  });
  app.runs = new RunStore(app.store.db, () => clock.now);
  const runs = new TeamRuns(app, app.store.db);
  app.teamRuns = runs;
  const conv = app.store.createConversation({ title: 'Big job' });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, runs, conv, dir, leads: () => leads };
}

const PLAN = {
  roles: [
    { id: 'r', name: 'Researcher', kind: 'researcher', tools: ['web_fetch', 'read_file', 'shell'], instructions: `Look only at shops that ship. Token ${'{KEY}'}` },
    { id: 'd', name: 'Drafter', kind: 'drafter', tools: ['write_file'] },
    { id: 'c', name: 'Checker', kind: 'checker', tools: ['read_file'], instructions: 'Every price needs a shop link.' },
  ],
  steps: [
    { id: 's1', role: 'r', title: 'Prices', instructions: `Find prices for: ${GOAL}` },
    { id: 's2', role: 'r', title: 'Reviews', instructions: 'Find reviews.' },
    { id: 's3', role: 'd', title: 'Write it', instructions: 'Write the comparison.', after: ['s1', 's2'] },
    { id: 's4', role: 'c', title: 'Check it', instructions: 'Check every claim.', after: ['s3'] },
  ],
  deliver: { kind: 'document', format: 'docx', title: GOAL },
};

/** A finished run whose plan pins the drafter to a model and holds a secret in an instruction. */
async function finishedRun(r: ReturnType<typeof rig>) {
  const run = await r.runs.propose(r.conv.id, GOAL, { deliver: 'document', format: 'docx' });
  const plan = structuredClone(run.plan);
  plan.roles[0].instructions = `Look only at shops that ship. Token ${fakeKey()}`;
  plan.roles[1].model = { providerId: 'here', model: 'qwen-local' };
  plan.roles[1].budget = { tokens: 12_000, minutes: 7, usd: 0.5 };
  r.runs.edit(run.id, plan);
  r.runs.approve(run.id);
  return r.runs.finished(run.id);
}

test('U3.16: Save as a team recipe keeps the plan shape with {job}, never results or secrets', async (t) => {
  const r = rig(t);
  const proposed = await r.runs.propose(r.conv.id, 'Find me a cheap flight to Lisbon', {});
  assert.throws(() => r.runs.recipes.saveFromRun(proposed.id, { name: 'Too soon' }), (e: unknown) => e instanceof TeamRecipeError && e.status === 409, 'only a finished run');
  const run = await finishedRun(r);
  assert.equal(run.status, 'done');
  assert.ok(run.steps.every((s) => s.report), 'the run has reports (results)');
  const rec = r.runs.recipes.saveFromRun(run.id, { name: 'Product comparison', description: 'Three products, a Word file' });
  assert.equal(rec.name, 'Product comparison');
  assert.equal(rec.plan.roles.length, 3);
  assert.deepEqual(rec.plan.roles.map((x) => x.kind), ['researcher', 'drafter', 'checker']);
  assert.equal(rec.plan.roles[0].model, 'auto', 'Auto unless pinned');
  assert.deepEqual(rec.plan.roles[1].model, { providerId: 'here', model: 'qwen-local' }, 'a pinned model is kept');
  assert.deepEqual(rec.plan.roles[1].budget, { tokens: 12_000, minutes: 7, usd: 0.5 });
  assert.deepEqual(rec.plan.roles[0].tools, ['web_fetch', 'read_file'], 'tool lists, never a hard-limit tool');
  assert.deepEqual(rec.plan.steps.find((s) => s.id === 's3')?.after, ['s1', 's2'], 'dependencies');
  assert.equal(rec.plan.roles[2].instructions, 'Every price needs a shop link.', "the checker's rules");
  assert.deepEqual(rec.plan.deliver, { kind: 'document', format: 'docx', title: '{job}' });
  assert.equal(rec.plan.steps[0].instructions, 'Find prices for: {job}', 'the job text became a placeholder');
  const blob = JSON.stringify(rec);
  assert.ok(!blob.includes(fakeKey()), 'no secret');
  assert.ok(!blob.includes('Done: the draft') && !blob.includes('VERDICT'), 'no results');
  assert.ok(!/"(notes|actions|receipts|report|result|log)"/.test(blob), 'no run state');
  assert.ok(!blob.includes('e-bikes'), 'no job text');
  assert.throws(() => r.runs.recipes.saveFromRun(run.id, { name: 'product COMPARISON' }), /already/, 'names are unique');
});

test('U3.16: recipes list, edit, duplicate and delete', async (t) => {
  const r = rig(t);
  const run = await finishedRun(r);
  const a = r.runs.recipes.saveFromRun(run.id, { name: 'Product comparison' });
  const copy = r.runs.recipes.duplicate(a.id);
  assert.equal(copy.name, 'Product comparison (copy)');
  assert.notEqual(copy.id, a.id);
  const plan = structuredClone(copy.plan);
  plan.roles[2].budget.tokens = 5_000;
  plan.roles[0].tools = ['web_fetch', 'shell'];
  const edited = r.runs.recipes.update(copy.id, { name: 'Quick comparison', description: 'Fast', plan });
  assert.equal(edited.name, 'Quick comparison');
  assert.equal(edited.plan.roles[2].budget.tokens, 5_000);
  assert.deepEqual(edited.plan.roles[0].tools, ['web_fetch'], 'an edit never adds a hard-limit tool');
  assert.throws(() => r.runs.recipes.update(copy.id, { name: 'product comparison' }), /already/);
  assert.deepEqual(r.runs.recipes.list().map((x) => x.name).sort(), ['Product comparison', 'Quick comparison']);
  assert.equal(r.runs.recipes.remove(a.id), true);
  assert.equal(r.runs.recipes.remove(a.id), false);
  assert.deepEqual(r.runs.recipes.list().map((x) => x.name), ['Quick comparison']);
});

test('U3.16: a run from a recipe skips the planning model, fills {job}, and is approved once as usual', async (t) => {
  const r = rig(t);
  const run = await finishedRun(r);
  const rec = r.runs.recipes.saveFromRun(run.id, { name: 'Product comparison' });
  const before = r.leads();
  const next = await r.runs.propose(r.conv.id, 'Compare three robot vacuums for a small flat', { recipe: rec.id });
  assert.equal(r.leads(), before, 'no planning call');
  assert.equal(next.status, 'proposed', 'still the one plan approval');
  assert.equal(next.plan.steps[0].instructions, 'Find prices for: Compare three robot vacuums for a small flat');
  assert.equal(next.plan.deliver.title, 'Compare three robot vacuums for a small flat');
  assert.deepEqual(next.plan.roles[1].model, { providerId: 'here', model: 'qwen-local' });
  assert.equal(r.runs.recipes.get(rec.id)?.uses, 1);
  // In a private chat the recipe still follows the private rules: local models, no outside tools.
  const priv = r.app.store.createConversation({ title: 'Private', private: true } as never);
  r.app.store.db.prepare('UPDATE conversations SET private = 1 WHERE id = ?').run(priv.id);
  const plan2 = structuredClone(rec.plan);
  plan2.roles[0].model = { providerId: 'p', model: 'm' };
  r.runs.recipes.update(rec.id, { plan: plan2 });
  const p = await r.runs.propose(priv.id, 'Compare three kettles for my kitchen', { recipe: rec.id });
  assert.equal(p.plan.roles[0].model, 'auto', 'a cloud model falls back to Auto in private');
  assert.ok(!p.plan.roles[0].tools.includes('web_fetch'), 'outside tools left out in private');
  await assert.rejects(r.runs.propose(r.conv.id, 'Compare three kettles', { recipe: 999 }), /No such team recipe/);
});

test('U3.16: export and import a recipe as JSON (unknown tools and models dropped, never the computer)', async (t) => {
  const r = rig(t);
  const run = await finishedRun(r);
  const rec = r.runs.recipes.saveFromRun(run.id, { name: 'Product comparison' });
  const json = r.runs.recipes.exportJson(rec.id);
  assert.equal(json.kind, RECIPE_KIND);
  assert.equal(json.version, 1);
  assert.equal(json.name, 'Product comparison');
  assert.ok(!('id' in json) && !('uses' in json), 'no local ids or counts');
  // Someone else's recipe: a tool this server lacks, a hard-limit tool, the computer ticked, a model from elsewhere, a secret.
  const shared = structuredClone(json) as typeof json;
  shared.name = 'Shared comparison';
  shared.plan.roles[0].tools = ['web_fetch', 'their_tool', 'shell', 'pc_click'];
  shared.plan.roles[0].computer = true;
  shared.plan.roles[0].instructions = `Use key ${fakeKey()}`;
  shared.plan.roles[1].model = { providerId: 'elsewhere', model: 'big' };
  const got = r.runs.recipes.importJson(shared);
  assert.equal(got.name, 'Shared comparison');
  assert.deepEqual(got.plan.roles[0].tools, ['web_fetch']);
  assert.equal(got.plan.roles[0].computer, false);
  assert.equal(got.plan.roles[1].model, 'auto');
  assert.ok(!JSON.stringify(got).includes(fakeKey()));
  const again = r.runs.recipes.importJson(shared);
  assert.equal(again.name, 'Shared comparison (2)', 'a clashing name gets a number');
  assert.throws(() => r.runs.recipes.importJson({ kind: 'something-else' }), (e: unknown) => e instanceof TeamRecipeError && e.status === 400);
  assert.throws(() => r.runs.recipes.importJson({ ...json, plan: { roles: [], steps: [] } }), /helper/);
});

test('U3.16: the team_run tool starts from a recipe by name', async (t) => {
  const r = rig(t);
  const run = await finishedRun(r);
  r.runs.recipes.saveFromRun(run.id, { name: 'Product comparison team' });
  r.runs.recipes.saveFromRun(run.id, { name: 'Trip planner' });
  assert.equal(r.runs.recipes.find('use my product comparison team')?.name, 'Product comparison team');
  assert.equal(r.runs.recipes.find('product comparison')?.name, 'Product comparison team');
  assert.equal(r.runs.recipes.find('the trip planner')?.name, 'Trip planner');
  assert.equal(r.runs.recipes.find('gardening'), undefined);
  const [tool] = createTeamRunTools(() => r.app);
  assert.ok((tool.spec.parameters as { properties: Record<string, unknown> }).properties.recipe, 'the tool takes a recipe');
  const before = r.leads();
  const out = await tool.run({ goal: 'Compare three standing desks', recipe: 'my product comparison team' }, { conversationId: r.conv.id } as never);
  assert.match(out, /from your recipe “Product comparison team”/);
  assert.equal(r.leads(), before, 'no planning call');
  await assert.rejects(tool.run({ goal: 'Compare three standing desks', recipe: 'gardening crew' }, { conversationId: r.conv.id } as never), /Product comparison team.*Trip planner|Trip planner.*Product comparison team/);
});

test('U3.16 routes: save, list, edit, duplicate, export, import, run, delete; owner only; UI wired', async (t) => {
  const r = rig(t);
  const run = await finishedRun(r);
  const auth = new OwnerAuth(r.dir);
  const token = auth.newToken!;
  const srv = createSaraServer({ app: r.app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));
  t.after(async () => {
    srv.closeAllConnections();
    await new Promise<void>((res) => srv.close(() => res()));
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/team-runs`;
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: base.replace(/\/api.*$/, '') }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  const saved = await call(`/${run.id}/recipe`, 'POST', { name: 'Product comparison' });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const rid = saved.json.recipe.id;
  const list = await call('');
  assert.deepEqual(list.json.recipes.map((x: { name: string }) => x.name), ['Product comparison']);
  assert.equal((await call(`/recipes/${rid}`, 'PUT', { name: 'Comparison', description: 'd' })).json.recipe.name, 'Comparison');
  const dup = await call(`/recipes/${rid}/duplicate`, 'POST', {});
  assert.equal(dup.json.recipe.name, 'Comparison (copy)');
  const exp = await call(`/recipes/${rid}/export`);
  assert.equal(exp.json.kind, RECIPE_KIND);
  const imp = await call('/recipes/import', 'POST', { recipe: { ...exp.json, name: 'Imported' } });
  assert.equal(imp.json.recipe.name, 'Imported');
  const started = await call(`/recipes/${rid}/run`, 'POST', { goal: 'Compare three office chairs' });
  assert.equal(started.json.run.status, 'proposed');
  assert.equal(started.json.run.plan.deliver.title, 'Compare three office chairs');
  assert.equal((await call(`/recipes/${dup.json.recipe.id}`, 'DELETE')).status, 200);
  assert.equal((await call(`/recipes/${dup.json.recipe.id}`, 'DELETE')).status, 404);
  assert.equal((await call('/recipes/import', 'POST', { recipe: { kind: 'nope' } })).status, 400);
  // UI: the Team runs page has the recipes and the Save button.
  const js = readFileSync(join(ROOT, 'web/team-runs.js'), 'utf8');
  for (const s of ["t('Save as a team recipe')", "t('Team recipes')", "t('Duplicate')", "t('Export')", "t('Import a recipe')", '/recipes/']) assert.ok(js.includes(s), s);
  const es = readFileSync(join(ROOT, 'web/i18n/es.json'), 'utf8');
  assert.ok(es.includes('"Save as a team recipe"'));
});

test('U3.16 routes: household members never reach recipes', async (t) => {
  const r = rig(t);
  const auth = new OwnerAuth(r.dir);
  const srv = createSaraServer({ app: r.app, auth, webDir: join(ROOT, 'web'), spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Bo' }), apps: () => [r.app], deleteSelf: async () => {} } } as never);
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));
  t.after(async () => {
    srv.closeAllConnections();
    await new Promise<void>((res) => srv.close(() => res()));
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const res = await fetch(`${base}/api/team-runs/recipes/import`, { method: 'POST', headers: { authorization: `Bearer ${auth.newToken!}`, 'content-type': 'application/json', origin: base }, body: '{}' });
  assert.equal(res.status, 403);
});
