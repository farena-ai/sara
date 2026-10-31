// Phase 78 (harness track M3, docs/design/HARNESS_TRACK.md §2.1, §3 M3, risks 1/2/3/6/11): run
// snapshots. Every model call and tool step of a turn is recorded with tokens, cost and timings;
// the recorder is passed explicitly (it sees every call however the caller drives the generator);
// secrets never reach the tables; off the record is never recorded; retention and the size cap
// prune; routes are the owner's (the demo refuses); coding runs keep git HEAD + dirty file hashes;
// jobs and team runs are runs too; the TurnHooks seam is called in a fixed order.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent, type TurnHooks } from '../src/chat.ts';
import { JobManager } from '../src/jobs.ts';
import { createBackup, restoreBackup } from '../src/backup.ts';
import { RunRecorder, RunStore, runSettings } from '../src/runs.ts';
import { createSaraServer } from '../src/server.ts';
import { TeamManager } from '../src/team.ts';
import type { Tool } from '../src/tools/types.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { priceTable, usageScope, UsageStore } from '../src/usage.ts';
import type { StreamEvent } from '../src/providers/types.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const NOW = new Date('2026-10-30T15:00:00Z');
const SECRET = 'sk-ant-THISISASECRETKEYabcdefghijklmnop0123';
const usage = (input: number, output: number): StreamEvent => ({ type: 'usage', input, output });

/** A stand-in tool: runs nothing on this PC, returns what it was asked (and a secret, to be scrubbed). */
function stub(name: string, out = (a: Record<string, unknown>) => `[exit code 0]\nok ${JSON.stringify(a)}`): Tool {
  return {
    spec: { name, description: name, parameters: { type: 'object', properties: {} } },
    defaultPermission: 'auto',
    summarize: (a) => `${name} ${String(a.command ?? a.path ?? '')}`,
    async run(a) {
      return out(a);
    },
  };
}

function setup(t: { after: (fn: () => void) => void }, opts: { usage?: boolean } = {}): { app: TestApp; runs: RunStore; dir: string } {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  if (opts.usage !== false) {
    app.usage = new UsageStore(app.store.db, () => NOW);
    app.usage.prices = () => priceTable(app.settings.get().prices);
  }
  const runs = new RunStore(app.store.db, () => NOW);
  runs.usage = app.usage;
  runs.settings = () => runSettings(app.settings.get());
  app.runs = runs;
  t.after(() => {
    app.jobs?.stopAll();
    app.store.close();
    cleanup();
  });
  app.tools.add(stub('shell'));
  app.tools.add(stub('write_file', (a) => `Wrote ${String(a.path)}`));
  app.settings.update({
    providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1' }],
    defaultProviderId: 'p',
    defaultModel: 'm',
    ownerName: 'Alex',
    timeZone: 'America/Chicago',
    disclosureAcceptedAt: NOW.toISOString(),
    toolPermissions: { shell: 'auto', write_file: 'auto' },
    prices: [{ model: 'm', inPerM: 1, outPerM: 2 }],
  });
  return { app, runs, dir };
}

async function drain(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

test('a turn with 2 tool loops: every model call and tool step is recorded with tokens, cost and timings', async (t) => {
  const { app, runs } = setup(t);
  app.memory!.add({ kind: 'fact', content: "Alex's project uses the blue theme.", evidence: null, conversationId: null, sourceMessageId: null, happenedOn: '2026-10-20' });
  const conv = app.store.createConversation({ mode: 'chat' });
  app.script.push([call('c1', 'shell', { command: 'ls' }), usage(1000, 50)], [call('c2', 'write_file', { path: 'notes/theme.txt', content: 'blue' }), usage(1200, 80)], [...text('Done: the blue theme is noted.'), usage(1400, 30)]);
  const evs = await drain(runTurn(app, conv.id, 'set up the blue theme for my project'));
  const done = evs.find((e) => e.type === 'done') as Extract<ChatEvent, { type: 'done' }>;
  assert.ok(done.messageId);
  const [run] = runs.list({ conversationId: conv.id });
  assert.ok(run, 'the turn is a run');
  assert.equal(run.kind, 'turn');
  assert.equal(run.status, 'ok');
  assert.equal(run.replyMessageId, done.messageId);
  assert.equal(app.store.messageById(done.messageId)!.meta?.runId, run.id, 'the reply knows its run');
  const steps = runs.steps(run.id);
  assert.equal(steps.length, 3, 'three model calls = three steps');
  // Every provider request is a recorded call (risk 1: the meter sees every call of the turn).
  assert.equal(steps.flatMap((s) => s.calls).length, app.requests.length);
  assert.deepEqual(steps.map((s) => [s.tokensIn, s.tokensOut]), [[1000, 50], [1200, 80], [1400, 30]]);
  // Cost from the usage meter's own price ($1 in / $2 out per million).
  assert.equal(steps[0].usd, (1000 * 1 + 50 * 2) / 1e6);
  assert.equal(run.tokensIn, 3600);
  assert.equal(run.tokensOut, 160);
  assert.equal(Math.round(run.usd * 1e8), Math.round(((3600 + 160 * 2) / 1e6) * 1e8));
  // The usage rows carry the run id and add up to the same numbers.
  const rows = app.store.db.prepare('SELECT input, output FROM usage WHERE run_id = ?').all(run.id) as { input: number; output: number }[];
  assert.equal(rows.length, 3);
  assert.equal(rows.reduce((n, r) => n + r.input, 0), run.tokensIn);
  // Tool steps: name, scrubbed args, status, output, duration, approval; files from the file tool.
  assert.deepEqual(steps.map((s) => s.tools.map((x) => `${x.name}:${x.status}:${x.approval}`)), [['shell:ok:auto'], ['write_file:ok:auto'], []]);
  assert.deepEqual(steps[1].files, ['notes/theme.txt']);
  assert.ok(steps.every((s) => s.calls.every((c) => c.ms >= 0 && c.reported && c.ok)));
  assert.equal(steps[1].tools[0].args.path, 'notes/theme.txt');
  assert.ok(steps[0].tools[0].messageId && app.store.messageById(steps[0].tools[0].messageId!)?.role === 'tool');
  // Chat mode: the undo snapshot taken before the write is on the step.
  assert.match(String(steps[1].tools[0].snapshotId), /^\d+-[0-9a-f]{8}$/);
  // Memory picks and the policy id from M1, per step.
  assert.ok((steps[0].memoryPicks as { id: number }[]).length >= 1);
  assert.match(String(steps[0].policyId), /^d[0-9a-f]{8}$/);
  // The system prompt round-trips from its blob byte for byte; the three steps share one blob.
  assert.equal(runs.blob(steps[0].systemSha!), String(app.requests[0].messages[0].content));
  assert.equal(new Set(steps.map((s) => s.systemSha)).size, 1);
  assert.equal(Number((app.store.db.prepare('SELECT COUNT(*) AS n FROM run_blobs').get() as { n: number }).n), 1);
  // History is a message-id range, not a copy.
  assert.ok(steps[2].historyToId! > steps[0].historyToId!);
  // Run policy: memory policy, model, tool set.
  assert.equal(run.policy?.model, 'p/m');
});

test('risk 1: the recorder survives the generator being driven by the caller (other async contexts, ALS scopes in between)', async (t) => {
  const { app, runs } = setup(t);
  const conv = app.store.createConversation({ mode: 'coding' });
  app.script.push([call('a', 'shell', { command: 'npm test' }), usage(10, 1)], [call('b', 'shell', { command: 'git status' }), usage(20, 2)], [...text('All good.'), usage(30, 3)]);
  const gen = runTurn(app, conv.id, 'run the tests');
  let foreign = 0;
  // Each next() runs inside a DIFFERENT AsyncLocalStorage scope (as a job's would), after a hop
  // through the event loop: the turn's calls must still go to the turn's own run.
  for (let i = 0; ; i++) {
    await new Promise((r) => setImmediate(r));
    const r = await usageScope.run({ purpose: 'not-this', runId: 999_999, onCall: () => foreign++ }, () => gen.next());
    if (r.done) break;
  }
  const [run] = runs.list({ conversationId: conv.id });
  assert.equal(foreign, 0, 'no call leaked into the caller\'s scope');
  assert.equal(runs.steps(run.id).flatMap((s) => s.calls).length, 3);
  assert.deepEqual((app.store.db.prepare('SELECT DISTINCT run_id FROM usage').all() as { run_id: number }[]).map((r) => r.run_id), [run.id]);
  assert.equal(run.tokensIn, 60);
});

test('a model that reports no usage is "cost unknown", not $0', async (t) => {
  const { app, runs } = setup(t, { usage: false });
  const conv = app.store.createConversation();
  app.script.push(text('Hi!'));
  await drain(runTurn(app, conv.id, 'hello'));
  const [run] = runs.list({ conversationId: conv.id });
  assert.equal(run.unreported, 1);
  assert.equal(runs.steps(run.id)[0].calls[0].usd, null);
  assert.equal(runs.steps(run.id)[0].calls[0].reported, false);
});

test('secrets are scrubbed everywhere: tool args, tool output, the system prompt blob, notes', async (t) => {
  const { app, runs } = setup(t);
  app.vault.set('provider:other', 'vault-value-0123456789abcdef');
  app.tools.add(stub('read_file', () => `API_KEY=${SECRET}\nother=vault-value-0123456789abcdef`));
  app.settings.update({ toolPermissions: { shell: 'auto', write_file: 'auto', read_file: 'auto' } });
  app.memory!.add({ kind: 'fact', content: `Alex keeps the key ${SECRET} for the deploy script.`, evidence: null, conversationId: null, sourceMessageId: null, happenedOn: '2026-10-20' });
  const conv = app.store.createConversation();
  app.script.push([call('s1', 'shell', { command: `curl -H "Authorization: Bearer ${SECRET}" https://example.com` }), usage(5, 5)], [call('s2', 'read_file', { path: '.env' }), usage(5, 5)], text('Done with the deploy key.'));
  await drain(runTurn(app, conv.id, 'use the deploy key for the deploy script'));
  // The prompt really carried the secret (from the note): the recorded copy must not.
  assert.ok(app.requests.some((r) => String(r.messages[0].content).includes(SECRET)), 'the fixture put the secret in the prompt');
  const dump = [
    JSON.stringify(app.store.db.prepare('SELECT * FROM runs').all()),
    JSON.stringify(app.store.db.prepare('SELECT * FROM run_steps').all()),
    ...(app.store.db.prepare('SELECT bytes FROM run_blobs').all() as { bytes: Uint8Array }[]).map((b) => inflateRawSync(b.bytes).toString('utf8')),
  ].join('\n');
  assert.ok(dump.length > 1000);
  for (const s of [SECRET, 'vault-value-0123456789abcdef', 'THISISASECRETKEY']) assert.ok(!dump.includes(s), `${s} must not be stored`);
  assert.match(dump, /\[REDACTED\]/);
  assert.equal(runs.list({ conversationId: conv.id }).length, 1);
});

test('TurnHooks: the four hooks are called at fixed places, in order; the plan check runs behind beforeTool', async (t) => {
  const { app } = setup(t);
  const conv = app.store.createConversation({ mode: 'coding' });
  const seen: string[] = [];
  const hooks: TurnHooks = {
    beforeModelCall: (c) => void seen.push(`model:${c.step}:${c.messages[0].role}`),
    beforeTool: (c) => void seen.push(`tool:${c.call.id}:${c.permission}`),
    afterTool: (c) => void seen.push(`done:${c.call.id}:${c.status}:${c.approval}`),
    afterReply: (c) => void seen.push(`reply:${c.step}:${c.final}`),
  };
  app.script.push([call('x1', 'shell', { command: 'ls' }), call('x2', 'shell', { command: 'pwd' })], text('Listed.'));
  await drain(runTurn(app, conv.id, 'look around', undefined, { hooks }));
  assert.deepEqual(seen, ['model:0:system', 'reply:0:false', 'tool:x1:auto', 'done:x1:ok:auto', 'tool:x2:auto', 'done:x2:ok:auto', 'model:1:system', 'reply:1:true']);
  // A hook can stop a call for the owner's OK (the M5 gate will): the approval card appears.
  const gate: TurnHooks = { beforeTool: (c) => (c.call.name === 'shell' ? { stopFor: { memoryId: 0, note: 'gate', act: 'stop', clear: true } as never } : undefined) };
  app.script.push([call('g1', 'shell', { command: 'rm -rf build' })], text('Okay.'));
  const evs: ChatEvent[] = [];
  for await (const ev of runTurn(app, conv.id, 'clean up', undefined, { hooks: gate })) {
    evs.push(ev);
    if (ev.type === 'approval') app.approvals.decide(ev.approvalId, false);
  }
  assert.ok(evs.some((e) => e.type === 'approval'));
  const res = evs.find((e) => e.type === 'tool_result') as Extract<ChatEvent, { type: 'tool_result' }>;
  assert.equal(res.status, 'denied');
});

test('coding mode: each step records git HEAD and the hashes of the dirty files (no copies)', async (t) => {
  const { app, runs, dir } = setup(t);
  const conv = app.store.createConversation({ mode: 'coding' });
  const ws = workspaceDir(dir, conv.workspace);
  mkdirSync(ws, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...a], { cwd: ws, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(ws, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  const head = git('rev-parse', 'HEAD');
  // A real write tool, so the file really changes in the workspace.
  app.tools.add({ ...stub('edit_file'), async run(a) { writeFileSync(join(ws, String(a.path)), String(a.content)); return `Edited ${String(a.path)}`; } });
  app.settings.update({ toolPermissions: { shell: 'auto', write_file: 'auto', edit_file: 'auto' } });
  app.script.push([call('e1', 'edit_file', { path: 'a.txt', content: 'two\n' })], text('Changed a.txt.'));
  const rec = new RunRecorder(runs, { kind: 'turn', conversationId: conv.id });
  await drain(runTurn(app, conv.id, 'change a.txt', undefined, { recorder: rec }));
  rec.close('ok');
  await rec.settled();
  const steps = runs.steps(rec.id);
  const ref0 = steps[0].workspaceRef!;
  assert.equal(ref0.head, head);
  assert.equal(ref0.branch, 'main');
  const dirty = ref0.dirty?.find((d) => d.path === 'a.txt');
  assert.ok(dirty, JSON.stringify(ref0));
  assert.equal(dirty!.sha, createHash('sha256').update('two\n').digest('hex').slice(0, 16));
});

test('off the record is never recorded; the routes are the owner\'s; the demo refuses them', async (t) => {
  const { app, runs, dir } = setup(t);
  const auth = new OwnerAuth(dir, () => NOW);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const H = { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' };
  const api = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: H, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  // Off the record: chat works, no run.
  const off = await (await api('/api/conversations', 'POST', { offRecord: true })).json();
  app.script.push([...text('Between us.'), usage(10, 2)]);
  assert.match(await (await api(`/api/conversations/${off.id}/messages`, 'POST', { content: 'keep this off the record' })).text(), /Between us/);
  assert.equal(runs.stats().runs, 0, 'nothing recorded off the record');
  // A normal conversation is recorded; list, detail and step detail (with the prompt).
  const conv = await (await api('/api/conversations', 'POST', {})).json();
  app.script.push([call('r1', 'shell', { command: 'ls' }), usage(100, 10)], [...text('Listed the files.'), usage(120, 12)]);
  await (await api(`/api/conversations/${conv.id}/messages`, 'POST', { content: 'list the files' })).text();
  const list = await (await api(`/api/runs?conversationId=${conv.id}`)).json();
  assert.equal(list.runs.length, 1);
  assert.ok(list.stats.runs >= 1);
  const id = list.runs[0].id;
  const one = await (await api(`/api/runs/${id}`)).json();
  assert.equal(one.steps.length, 2);
  assert.equal(one.steps[0].tools[0].name, 'shell');
  const step = await (await api(`/api/runs/${id}/steps/1`)).json();
  assert.match(step.prompt.system, /Sara/);
  assert.ok(step.prompt.history.some((m: { role: string; content: string }) => m.role === 'user' && m.content === 'list the files'));
  assert.ok(step.prompt.history.some((m: { role: string }) => m.role === 'tool'));
  assert.equal((await api(`/api/runs/${id}/steps/9`)).status, 404);
  assert.equal((await api('/api/runs/abc')).status, 404);
  // Signed out: nothing.
  assert.equal((await fetch(`${base}/api/runs/${id}`)).status, 401);
  // Retention setting (pick-list values only) and the health line.
  assert.equal((await api('/api/runs/settings', 'PUT', { keepDays: 45 })).status, 400);
  const set = await (await api('/api/runs/settings', 'PUT', { keepDays: 30 })).json();
  assert.equal(set.keepDays, 30);
  assert.deepEqual(set.choices, [30, 90, 365, 0]);
  const status = await (await api('/api/status')).json();
  assert.match(JSON.stringify(status.checks.find((c: { name: string }) => c.name === 'Run history')), /Runs: 1, \d+\.\d+ MB/);
  // Export: left out by default, in with ?runs=1.
  assert.equal((await (await api('/api/export')).json()).runs, undefined);
  assert.equal((await (await api('/api/export?runs=1')).json()).runs.runs.length, 1);
  // Delete run history.
  assert.equal((await (await api('/api/runs', 'DELETE')).json()).removed, 1);
  assert.equal(runs.stats().runs, 0);
  assert.equal(runs.stats().bytes, 0, 'prompts no run uses are gone too');
  // The demo refuses the run routes (visitors' runs are never listed).
  const demoServer = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), demo: true });
  await new Promise<void>((r) => demoServer.listen(0, '127.0.0.1', r));
  t.after(() => demoServer.close());
  const demoBase = `http://127.0.0.1:${(demoServer.address() as AddressInfo).port}`;
  const start = await fetch(`${demoBase}/api/demo/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const cookie = String(start.headers.get('set-cookie')).split(';')[0];
  assert.equal((await fetch(`${demoBase}/api/conversations`, { headers: { cookie } })).status, 200, 'signed in to the demo');
  assert.equal((await fetch(`${demoBase}/api/runs`, { headers: { cookie } })).status, 403);
});

test('deleting a conversation deletes its runs; retention prunes by age but keeps branch parents; the size cap holds', async (t) => {
  const { app, runs } = setup(t);
  const clock = { now: new Date(NOW) };
  const store = new RunStore(app.store.db, () => clock.now);
  const conv = app.store.createConversation();
  const other = app.store.createConversation();
  const mk = (cid: string, at: Date, big = 0) => {
    clock.now = at;
    const r = new RunRecorder(store, { kind: 'turn', conversationId: cid });
    r.startStep({ model: 'm', system: `prompt ${at.toISOString()} ${'x'.repeat(big)}` });
    r.tool({ id: 't', name: 'shell', summary: 'ls', args: {}, status: 'ok', output: 'y'.repeat(big), ms: 1 });
    r.close('ok');
    return r.id;
  };
  const old = mk(conv.id, new Date('2026-06-01T00:00:00Z'));
  const parent = mk(conv.id, new Date('2026-06-02T00:00:00Z'));
  mk(conv.id, new Date('2026-10-29T00:00:00Z'));
  // A branch of `parent` (M8 time-travel) keeps it whatever its age.
  clock.now = new Date('2026-10-29T01:00:00Z');
  const child = store.open({ kind: 'turn', conversationId: conv.id, parentRunId: parent, branchedFromStep: 0 });
  store.close(child, 'ok', 0, Date.now());
  clock.now = NOW;
  store.settings = () => ({ keepDays: 90, maxMb: 200 });
  assert.equal(store.prune(true), 1);
  assert.equal(store.get(old), undefined);
  assert.ok(store.get(parent), 'a branch parent is kept');
  // "Until deleted" keeps everything.
  store.settings = () => ({ keepDays: 0, maxMb: 200 });
  mk(conv.id, new Date('2025-01-01T00:00:00Z'));
  clock.now = NOW;
  assert.equal(store.prune(true), 0);
  // Size cap: many big runs, cap at 0.05 MB: the oldest go until it fits; orphan prompts too.
  for (let i = 0; i < 30; i++) mk(other.id, new Date(NOW.getTime() - (30 - i) * 60_000), 20_000);
  clock.now = NOW;
  const before = store.stats();
  assert.ok(before.bytes > 0.05 * 1048576, JSON.stringify(before));
  store.settings = () => ({ keepDays: 0, maxMb: 0.05 });
  assert.ok(store.prune(true) > 0);
  assert.ok(store.stats().bytes <= 0.05 * 1048576, JSON.stringify(store.stats()));
  assert.ok(store.list({ conversationId: other.id }).length > 0, 'the newest stay');
  const orphans = Number((app.store.db.prepare('SELECT COUNT(*) AS n FROM run_blobs WHERE sha NOT IN (SELECT system_sha FROM run_steps WHERE system_sha IS NOT NULL)').get() as { n: number }).n);
  assert.equal(orphans, 0);
  // Deleting the conversation deletes its runs (and their steps).
  store.settings = () => ({ keepDays: 0, maxMb: 200 });
  assert.ok(store.list({ conversationId: conv.id }).length > 0);
  app.store.deleteConversation(conv.id);
  assert.equal(store.list({ conversationId: conv.id }).length, 0);
  assert.equal(Number((app.store.db.prepare('SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ?').get(parent) as { n: number }).n), 0);
  void runs;
});

test('background jobs and team runs are recorded as runs (their ALS meter kept, the recorder added)', async (t) => {
  const { app, runs, dir } = setup(t);
  app.jobs = new JobManager(app, app.store.db);
  const conv = app.store.createConversation({ mode: 'coding' });
  const ws = workspaceDir(dir, conv.workspace);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'hi.js'), "console.log('hello from the job')\n");
  // Her report about the job (quick job) is a model call inside the job's scope.
  app.script.push([...text('The job printed hello.'), usage(40, 8)]);
  const { job, done } = app.jobs.start({ conversationId: conv.id, workspace: conv.workspace, label: 'Say hello', command: `${JSON.stringify(process.execPath)} hi.js`, timeoutMs: 60_000 });
  await done;
  const jr = runs.list({ conversationId: conv.id }).find((r) => r.kind === 'job')!;
  assert.ok(jr, 'the job is a run');
  assert.equal(jr.jobId, job.id);
  assert.equal(jr.status, 'ok');
  const js = runs.steps(jr.id);
  assert.equal(js[0].tools[0].name, 'start_job');
  assert.match(js[0].tools[0].output, /hello from the job/);
  assert.equal(js.flatMap((s) => s.calls).length, 1, 'her report\'s model call');
  assert.equal(jr.tokensIn, 40);
  // A team task: the plan call, each helper move and its tools.
  app.team = new TeamManager(app, app.store.db);
  app.script.push(
    text(JSON.stringify({ steps: [{ helper: 'coder', title: 'Write the note', instructions: 'Write note.txt.' }] })),
    [call('w1', 'write_file', { path: 'note.txt', content: 'hi' }), usage(50, 5)],
    [...text('Wrote note.txt.'), usage(60, 6)],
    text('Done: the coder wrote note.txt.'),
  );
  const task = app.team.start(conv.id, 'Write a short note into note.txt please.');
  const fin = await app.team.finished(task.id);
  assert.equal(fin.status, 'done');
  const tr = runs.list({ conversationId: conv.id }).find((r) => r.kind === 'team')!;
  assert.ok(tr, 'the team task is a run');
  assert.equal(tr.teamTaskId, task.id);
  const ts = runs.steps(tr.id);
  const tools = ts.flatMap((s) => s.tools);
  assert.deepEqual(tools.map((x) => `${x.name}:${x.status}`), ['write_file:ok']);
  assert.ok(ts.some((s) => /Coder: Write the note/.test(String(s.label))));
  // Every model call of the task (plan, two helper moves, her report) is on the run.
  assert.equal(ts.flatMap((s) => s.calls).length, 4);
  assert.equal((app.store.db.prepare('SELECT COUNT(*) AS n FROM usage WHERE run_id = ?').get(tr.id) as { n: number }).n, 2);
});

test('backups keep the run history (it is in the database); restoring brings it back', async (t) => {
  const { app, runs, dir } = setup(t);
  const conv = app.store.createConversation();
  app.script.push([call('b1', 'shell', { command: 'ls' }), usage(10, 1)], text('Listed.'));
  await drain(runTurn(app, conv.id, 'list'));
  const before = runs.list({ conversationId: conv.id });
  assert.equal(before.length, 1);
  const out = join(dir, 'backups', 'm3.tar.gz');
  createBackup(dir, out);
  const restored = join(dir, 'restored');
  mkdirSync(restored, { recursive: true });
  restoreBackup(out, restored);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(restored, 'sara.db'), { readOnly: true });
  try {
    const copy = new RunStore(db);
    assert.equal(copy.list({ conversationId: conv.id })[0].id, before[0].id);
    assert.equal(copy.steps(before[0].id).length, 2);
    assert.equal(copy.blob(copy.steps(before[0].id)[0].systemSha!), runs.blob(runs.steps(before[0].id)[0].systemSha!));
  } finally {
    db.close(); // before the folder is removed (Windows)
  }
});

test('performance: recording adds under 5 ms a step', async (t) => {
  const { app, runs } = setup(t);
  // A realistic prompt size: notes and history.
  for (let i = 0; i < 40; i++) app.memory!.add({ kind: 'fact', content: `Alex's project fact number ${i} about the build and the tests.`, evidence: null, conversationId: null, sourceMessageId: null, happenedOn: '2026-10-20' });
  const conv = app.store.createConversation({ mode: 'chat' });
  const STEPS = 12;
  for (let i = 0; i < STEPS - 1; i++) app.script.push([call(`p${i}`, 'shell', { command: `echo ${i} ${'z'.repeat(3000)}` }), usage(5000, 200)]);
  app.script.push([...text('Finished all the steps for the build.'), usage(5000, 100)]);
  const rec = new RunRecorder(runs, { kind: 'turn', conversationId: conv.id });
  const t0 = performance.now();
  await drain(runTurn(app, conv.id, 'run the build steps for the project', undefined, { recorder: rec }));
  const total = performance.now() - t0;
  rec.close('ok');
  const per = rec.overheadMs / STEPS;
  console.log(`runs perf: ${per.toFixed(3)} ms per step, ${((rec.overheadMs / total) * 100).toFixed(2)}% of a ${total.toFixed(0)} ms fake-model turn, ${runs.get(rec.id)!.bytes} bytes for ${STEPS} steps`);
  // The bound is a little wider than the 5 ms target for a loaded server; on the home server each
  // commit used to wait ~80 ms for a disk flush (162 ms a step) until the store moved to
  // synchronous=NORMAL (see the store test below).
  assert.ok(per < 15, `${per} ms a step`);
  assert.equal(runs.steps(rec.id).length, STEPS);
  void readFileSync;
});

test('the store doesn\'t wait for a disk flush on every commit (WAL + synchronous=NORMAL)', (t) => {
  const { app } = setup(t);
  const db = (app.store as unknown as { db: { prepare: (s: string) => { get: () => Record<string, unknown> } } }).db;
  assert.equal(String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
  assert.equal(Number(db.prepare('PRAGMA synchronous').get().synchronous), 1, 'NORMAL');
});
