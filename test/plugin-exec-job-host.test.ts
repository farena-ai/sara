// H_EXEC through the real PluginManager: install (the review lists the run permission), enable, a
// plugin tool asks for a job over the channel (sara-job.mjs), the owner's card shows the exact
// command, and a real `node --test` runs in a disposable copy of the plugin's staged files.
// Refusals, late approval, owner Stop, plugin disable and the time limit are exercised the same way.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fromFolder } from '../src/packages.ts';
import { permissionLines } from '../src/plugins/manifest.ts';
import { PLUGIN_LIMITS, PluginManager } from '../src/plugins/manager.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const V = '2.31.0';
const MAIN = `import { plugin } from './sara-plugin.mjs';
import { runJob } from './sara-job.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const stage = (broken) => {
  mkdirSync('repo/test', { recursive: true });
  writeFileSync('repo/sum.mjs', 'export const sum = (a, b) => a + b;\\n');
  writeFileSync('repo/test/sum.test.mjs', "import test from 'node:test';\\nimport assert from 'node:assert/strict';\\nimport { writeFileSync } from 'node:fs';\\nimport { sum } from '../sum.mjs';\\ntest('adds', () => assert.equal(sum(2, 2), " + (broken ? 5 : 4) + "));\\ntest('report', () => writeFileSync('report.txt', 'r'));\\n");
  writeFileSync('repo/spin.mjs', 'setInterval(() => {}, 1000);\\n');
};
const run = async (plan) => { try { return JSON.stringify(await runJob(plan)); } catch (e) { return 'REFUSED ' + e.message; } };
plugin({
  tools: [
    { name: 'stage', description: 'Stages a fixture.', parameters: { type: 'object', properties: { broken: { type: 'boolean' } } }, run: async (a) => { stage(a.broken === true); return 'staged'; } },
    { name: 'test', description: 'Runs the staged tests.', parameters: { type: 'object', properties: {} }, run: async () => run({ program: 'node', args: ['--test', '--test-reporter=tap'], from: 'repo', timeoutS: 60 }) },
    { name: 'spin', description: 'A job that never ends.', parameters: { type: 'object', properties: { t: { type: 'integer' } } }, run: async (a) => run({ program: 'node', args: ['spin.mjs'], from: 'repo', timeoutS: a.t ?? 120 }) },
    { name: 'npm', description: 'Asks for npm.', parameters: { type: 'object', properties: {} }, run: async () => run({ program: 'npm', args: ['test'], from: 'repo' }) },
    { name: 'escape', description: 'Asks for an outside folder.', parameters: { type: 'object', properties: {} }, run: async () => run({ program: 'node', args: ['--test'], from: '../../..' }) },
  ],
});
`;

async function until(f: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((res) => setTimeout(res, 20));
  }
}

async function rig(t: { after: (fn: () => Promise<void> | void) => void }, over: Partial<ConstructorParameters<typeof PluginManager>[0]> = {}) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  app.companionId = 'main';
  app.settings.update({ ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: new Date().toISOString() });
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, events: app.events, scrub: (s) => app.redactor.redact(s), fence: 'node-only', jobFence: 'node-only', saraVersion: V, toolMs: 5000, ...over });
  app.pluginManager = pm;
  pm.attach('main', app);
  t.after(async () => {
    await pm.stopAll();
    cleanup();
  });
  const src = join(dir, 'src-plugin');
  mkdirSync(src, { recursive: true });
  cpSync(join(ROOT, 'examples', 'plugins', 'hello-hooks', 'sara-plugin.mjs'), join(src, 'sara-plugin.mjs'));
  cpSync(join(ROOT, 'src', 'plugins', 'sara-job.mjs'), join(src, 'sara-job.mjs'));
  writeFileSync(join(src, 'sara-plugin.json'), JSON.stringify({ manifest: 1, id: 'job-runner', name: 'Job runner', version: '1.0.0', description: 'A test plugin that runs jobs.', sara: '>=2.30.0', main: 'main.mjs', permissions: { tools: ['stage', 'test', 'spin', 'npm', 'escape'], run: { programs: ['node'], sources: ['data'] } } }));
  writeFileSync(join(src, 'main.mjs'), MAIN);
  const review = pm.stage(fromFolder(src, PLUGIN_LIMITS), { kind: 'folder', where: src });
  await pm.approve(review.id, { trust: true });
  await pm.setEnabled('job-runner', 'main', true);
  await until(() => pm.processOf('job-runner', 'main')?.state === 'ready');
  const call = (name: string, args: Record<string, unknown> = {}) => app.tools.get(`job_runner__${name}`)!.run(args, { workspaceDir: workspaceDir(dir, 'main'), signal: AbortSignal.timeout(120_000), sandbox: app.sandbox });
  return { app, pm, dir, call, data: pm.dataDirFor('job-runner', 'main'), ws: workspaceDir(dir, 'main'), review };
}

const listing = (d: string) => (existsSync(d) ? readdirSync(d).sort() : []);

test('host job: review line, exact command on the card, a real node --test in a disposable copy, nothing written back', async (t) => {
  const r = await rig(t);
  assert.ok(permissionLines(r.review.manifest).some((l) => l.id === 'run:node:data' && /disposable copy of its own files/.test(l.key) && l.risk === 'high'));
  assert.equal(await r.call('stage'), 'staged');
  const wsBefore = listing(r.ws);
  const p = r.call('test');
  await until(() => r.pm.waiting().length === 1);
  const w = r.pm.waiting()[0];
  assert.equal(w.tool, 'job');
  assert.equal(w.job?.command, 'node --test --test-reporter=tap');
  assert.equal(w.job?.fence, 'node-only');
  assert.match(w.summary, /run node --test --test-reporter=tap in a disposable copy of its own files, without network, up to 60 s; not OS-sandboxed/);
  assert.deepEqual(r.pm.jobs(), [], 'nothing runs before the owner answers');
  assert.equal(r.pm.callDecision(w.id, true), 'decided');
  const res = JSON.parse(await p);
  assert.equal(res.ok, true);
  assert.equal(res.exitCode, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /# pass 2/);
  assert.deepEqual(res.changed, { added: ['report.txt'], changed: [], removed: [] });
  assert.equal(res.deleted, true);
  assert.equal(res.isolated, false);
  assert.equal(existsSync(join(r.data, 'repo', 'report.txt')), false, 'the staged files are not changed');
  assert.deepEqual(listing(r.ws), wsBefore, 'the real workspace is untouched');
  assert.deepEqual(listing(join(r.dir, 'cache', 'plugin-jobs')), []);
  // A broken test is a real failing exit, reported as such.
  await r.call('stage', { broken: true });
  const p2 = r.call('test');
  await until(() => r.pm.waiting().length === 1);
  r.pm.callDecision(r.pm.waiting()[0].id, true);
  const res2 = JSON.parse(await p2);
  assert.equal(res2.exitCode, 1);
  assert.match(res2.stdout, /not ok 1 - adds/);
  // A declined job runs nothing.
  const p3 = r.call('test');
  await until(() => r.pm.waiting().length === 1);
  r.pm.callDecision(r.pm.waiting()[0].id, false);
  assert.match(await p3, /declined this\. Nothing ran/);
  assert.match(r.pm.store.logs('job-runner').map((l) => l.detail).join('\n'), /job: node --test --test-reporter=tap: exit 0 \(node-only; copy deleted\)/);
});

test('host job: undeclared programs and folders outside its data are refused without a card', async (t) => {
  const r = await rig(t);
  await r.call('stage');
  assert.match(await r.call('npm'), /REFUSED job: The plugin doesn't declare "npm"/);
  assert.match(await r.call('escape'), /REFUSED job: from must be a relative path/);
  assert.deepEqual(r.pm.waiting(), []);
});

test('host job: an approval that comes after the approval window or the invocation is expired and runs nothing', async (t) => {
  const r = await rig(t, { jobApprovalMs: 400 });
  await r.call('stage');
  const p = r.call('test');
  await until(() => r.pm.waiting().length === 1);
  const w = r.pm.waiting()[0];
  assert.match(await p, /declined this\. Nothing ran/);
  assert.deepEqual(r.pm.waiting(), []);
  assert.equal(r.pm.callDecision(w.id, true), 'expired');
  await new Promise((res) => setTimeout(res, 300));
  assert.deepEqual(r.pm.jobs(), []);
  assert.deepEqual(listing(join(r.dir, 'cache', 'plugin-jobs')), [], 'no copy was ever made');
});

test('host job: the owner\'s Stop, the time limit and switching the plugin off each kill a running job', async (t) => {
  const r = await rig(t);
  await r.call('stage');
  const approve = async () => {
    await until(() => r.pm.waiting().length === 1);
    r.pm.callDecision(r.pm.waiting()[0].id, true);
    await until(() => r.pm.jobs().length === 1);
  };
  const p = r.call('spin');
  await approve();
  assert.equal(r.pm.stopJob(r.pm.jobs()[0].id), true);
  const res = JSON.parse(await p);
  assert.equal(res.cancelled, true);
  assert.equal(res.deleted, true);
  const p2 = r.call('spin', { t: 1 });
  await approve();
  const res2 = JSON.parse(await p2);
  assert.equal(res2.timedOut, true);
  const p3 = r.call('spin').catch((e: Error) => e.message);
  await approve();
  await r.pm.setEnabled('job-runner', 'main', false);
  await p3;
  await until(() => r.pm.jobs().length === 0);
  await until(() => listing(join(r.dir, 'cache', 'plugin-jobs')).length === 0);
  assert.match(r.pm.store.logs('job-runner').map((l) => l.detail).join('\n'), /job: node spin\.mjs: stopped \(node-only; copy deleted\)[\s\S]*stopped after 1 s/);
});
