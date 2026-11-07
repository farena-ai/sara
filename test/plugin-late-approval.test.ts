// A plugin's sara.tool approval lives only as long as the plugin invocation that asked for it.
// When that invocation ends (host timeout, completion, error, plugin stop), every approval it is
// still waiting on is cancelled at once; a late Allow answers "expired" and runs nothing.
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fromFolder } from '../src/packages.ts';
import { PLUGIN_LIMITS, PluginManager } from '../src/plugins/manager.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { writeFileTool } from '../src/tools/builtin.ts';
import { ApprovalBroker } from '../src/tools/registry.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const V = '2.31.0';
const SDK = join(ROOT, 'examples', 'plugins', 'hello-hooks', 'sara-plugin.mjs');

const MAIN = `import { plugin } from './sara-plugin.mjs';
plugin({
  init: async (sara) => {
    if (sara.settings.initCall === true) {
      const r = await sara.tool('write_file', { path: 'init.txt', content: 'init' }).catch((e) => ({ ok: false, content: e.message }));
      sara.log('INIT ' + JSON.stringify(r));
    }
  },
  tools: [
    { name: 'slow', description: 'Waits for its write.', parameters: { type: 'object', properties: { path: { type: 'string' } } }, run: async (a, sara) => { const r = await sara.tool('write_file', { path: a.path ?? 'late.txt', content: 'late' }); return JSON.stringify(r); } },
    { name: 'fire', description: 'Asks and returns.', parameters: { type: 'object', properties: {} }, run: async (a, sara) => { void sara.tool('write_file', { path: 'fired.txt', content: 'fired' }).catch(() => undefined); await new Promise((r) => setTimeout(r, 150)); return 'returned'; } },
  ],
});
`;

async function until(f: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((res) => setTimeout(res, 20));
  }
}

async function rig(t: { after: (fn: () => Promise<void> | void) => void }, settings: Record<string, unknown> = {}) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  app.companionId = 'main';
  app.tools.add(writeFileTool);
  app.settings.update({ ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: new Date().toISOString() });
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, events: app.events, scrub: (s) => app.redactor.redact(s), fence: 'node-only', saraVersion: V, toolMs: 600 });
  app.pluginManager = pm;
  pm.attach('main', app);
  t.after(async () => {
    await pm.stopAll();
    cleanup();
  });
  const src = join(dir, 'src-plugin');
  cpSync(join(ROOT, 'examples', 'plugins', 'hello-hooks'), src, { recursive: true });
  cpSync(SDK, join(src, 'sara-plugin.mjs'));
  const man = JSON.parse(readFileSync(join(src, 'sara-plugin.json'), 'utf8'));
  writeFileSync(join(src, 'sara-plugin.json'), JSON.stringify({ manifest: 1, version: man.version, description: 'A test plugin.', sara: man.sara, main: 'main.mjs', id: 'late-asker', name: 'Late asker', permissions: { tools: ['slow', 'fire'], callTools: ['write_file'], settings: true }, settings: [{ key: 'initCall', type: 'switch', label: 'Init call', tip: 'Calls a Sara tool during init (test only).' }] }));
  writeFileSync(join(src, 'main.mjs'), MAIN);
  const review = pm.stage(fromFolder(src, PLUGIN_LIMITS), { kind: 'folder', where: src });
  await pm.approve(review.id, { trust: true });
  if (Object.keys(settings).length) await pm.putSettings('late-asker', 'main', settings);
  await pm.setEnabled('late-asker', 'main', true);
  await until(() => pm.processOf('late-asker', 'main')?.state === 'ready');
  const ws = workspaceDir(dir, 'main');
  return { app, pm, dir, ws };
}

test('late approval: an Allow given after the plugin invocation timed out is expired and writes nothing', async (t) => {
  const r = await rig(t);
  const tool = r.app.tools.get('late_asker__slow')!;
  const p = tool.run({ path: 'late.txt' }, { workspaceDir: r.ws, signal: AbortSignal.timeout(20_000), sandbox: r.app.sandbox });
  await until(() => r.pm.waiting().length === 1);
  const w = r.pm.waiting()[0];
  assert.equal(w.tool, 'write_file');
  await assert.rejects(p, /didn't answer in time/);
  // The invocation ended: its approval is gone at once, not after the 10-minute wait.
  assert.deepEqual(r.pm.waiting(), [], 'the approval was cancelled with its invocation');
  assert.equal(r.pm.callDecision(w.id, true), 'expired');
  assert.equal(r.pm.decideCall(w.id, true), false);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(existsSync(join(r.ws, 'late.txt')), false, 'nothing was written after the late Allow');
  assert.match(r.pm.store.logs('late-asker').map((l) => l.detail).join('\n'), /write_file: the request ended before the owner answered/);
});

test('late approval control: an Allow inside the invocation still runs the tool once', async (t) => {
  const r = await rig(t);
  const tool = r.app.tools.get('late_asker__slow')!;
  const p = tool.run({ path: 'ok.txt' }, { workspaceDir: r.ws, signal: AbortSignal.timeout(20_000), sandbox: r.app.sandbox });
  await until(() => r.pm.waiting().length === 1);
  assert.equal(r.pm.callDecision(r.pm.waiting()[0].id, true), 'decided');
  assert.match(await p, /"ok":true/);
  assert.equal(readFileSync(join(r.ws, 'ok.txt'), 'utf8'), 'late');
});

test('late approval: an invocation that completes cancels the approvals it left waiting', async (t) => {
  const r = await rig(t);
  const tool = r.app.tools.get('late_asker__fire')!;
  const p = tool.run({}, { workspaceDir: r.ws, signal: AbortSignal.timeout(20_000), sandbox: r.app.sandbox });
  await until(() => r.pm.waiting().length === 1);
  const w = r.pm.waiting()[0];
  assert.equal(await p, 'returned');
  assert.deepEqual(r.pm.waiting(), []);
  assert.equal(r.pm.callDecision(w.id, true), 'expired');
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(existsSync(join(r.ws, 'fired.txt')), false);
});

test('late approval: a call outside any invocation (init) is refused without an approval card', async (t) => {
  const r = await rig(t, { initCall: true });
  await until(() => /INIT /.test(r.pm.store.logs('late-asker').map((l) => l.detail).join('\n')));
  assert.deepEqual(r.pm.waiting(), []);
  assert.match(r.pm.store.logs('late-asker').map((l) => l.detail).join('\n'), /INIT .*no request from Sara is running/);
  assert.equal(existsSync(join(r.ws, 'init.txt')), false);
});

test('late approval: switching the plugin off expires its waiting approval', async (t) => {
  const r = await rig(t);
  const tool = r.app.tools.get('late_asker__slow')!;
  const p = tool.run({ path: 'off.txt' }, { workspaceDir: r.ws, signal: AbortSignal.timeout(20_000), sandbox: r.app.sandbox }).catch((e: Error) => e.message);
  await until(() => r.pm.waiting().length === 1);
  const w = r.pm.waiting()[0];
  await r.pm.setEnabled('late-asker', 'main', false);
  assert.deepEqual(r.pm.waiting(), []);
  assert.equal(r.pm.callDecision(w.id, true), 'expired');
  await p;
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(existsSync(join(r.ws, 'off.txt')), false);
});

test('sibling: chat, team, board and live approvals end with their caller; a late or pre-ended answer is expired', async () => {
  const b = new ApprovalBroker(60_000);
  // The caller (a turn, a team step, a live call) ends while the card waits.
  const ctl = new AbortController();
  const r1 = b.request('c1', ctl.signal);
  assert.equal(b.state(r1.id), 'waiting');
  ctl.abort();
  assert.equal(await r1.decision, false);
  assert.deepEqual(b.pendingFor('c1'), []);
  assert.equal(b.state(r1.id), 'expired');
  assert.equal(b.decide(r1.id, true), false, 'a late Allow runs nothing');
  // A caller that had already ended never leaves a card waiting for 10 minutes.
  const gone = new AbortController();
  gone.abort();
  const r2 = b.request('c1', gone.signal);
  assert.equal(await r2.decision, false);
  assert.deepEqual(b.pendingFor('c1'), []);
  assert.equal(b.decide(r2.id, true), false);
  assert.equal(b.state(r2.id), 'expired');
  // Control: an answer inside the caller's lifetime decides it.
  const r3 = b.request('c1', new AbortController().signal);
  assert.equal(b.decide(r3.id, true), true);
  assert.equal(await r3.decision, true);
  assert.equal(b.state('nope'), 'unknown');
});
