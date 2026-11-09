// C10 (docs/ops/C10_DESIGN.md): workers that stay. A named worker with its own thread, a durable
// job queue (one job at a time, retries with backoff, a time limit), a failed-jobs list (replay a
// copy, drop), one "needs you" alert per blocker (deduped, quiet hours), a lead that hands jobs to
// the workers under it, and a bundle that round-trips without secrets.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Crews } from '../src/crews.ts';
import { PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { Store } from '../src/store.ts';
import { TeamManager, teamHelpers } from '../src/team.ts';
import { listDir, readFileTool, writeFileTool } from '../src/tools/builtin.ts';
import { WORKER, WorkerError, Workers, type WorkerOutcome, type WorkerRunner } from '../src/workers.ts';
import { call, makeApp, tempDir, text } from './helpers.ts';
import { join } from 'node:path';

type Script = { outcome?: WorkerOutcome; hang?: boolean; waiting?: boolean; throws?: string };

function rig(t: TestContext, start = '2026-11-04T12:00:00Z') {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(start) };
  const app = makeApp(dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', apiKey: 'sk-live-SECRETKEY1234567890' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString(), proactive: { quietStart: 22, quietEnd: 7 } } as never);
  const plans: Script[] = [];
  const started: { worker: string; title: string; input: string }[] = [];
  const stopped: number[] = [];
  const runner: WorkerRunner = (w, job) => {
    const p = plans.shift() ?? { outcome: { status: 'done', result: `did ${job.title}`, tokens: 1000 } };
    if (p.throws) throw new Error(p.throws);
    started.push({ worker: w.name, title: job.title, input: job.input });
    let resolve!: (o: WorkerOutcome) => void;
    const done = new Promise<WorkerOutcome>((r) => (resolve = r));
    if (!p.hang && p.outcome) queueMicrotask(() => resolve(p.outcome!));
    return { done, stop: () => (stopped.push(job.id), resolve({ status: 'stopped', result: '', tokens: 0 })), waiting: () => Boolean(p.waiting) };
  };
  const alerts: { channel: string; title: string; text: string }[] = [];
  let quiet = false;
  const opts = { runner, alert: async (a: { channel: string; title: string; text: string }) => (alerts.push(a), true), quiet: () => quiet };
  const workers = new Workers(app, app.store.db, opts);
  app.workers = workers;
  t.after(() => {
    setPolicy(new PolicyStore());
    try {
      app.store.close();
    } catch {}
    cleanup();
  });
  return { app, dir, clock, workers, plans, started, stopped, alerts, opts, setQuiet: (q: boolean) => (quiet = q) };
}

const settle = () => new Promise((r) => setTimeout(r, 5));
const DANA = { name: 'Docs Dana', character: 'Cheerful, precise, writes in short sentences.', helper: 'writer', toolGroups: ['read', 'write'], dailyTokens: 50_000, timeLimitMin: 10 };

test('workers: a worker has its own thread, tool groups and budget; results land in its thread', async (t) => {
  const r = rig(t);
  const before = r.app.store.listConversations().length;
  const w = r.workers.create(DANA);
  assert.equal(r.app.store.listConversations().length, before + 1);
  assert.equal(r.app.store.getConversation(w.conversationId)!.title, 'Worker: Docs Dana');
  // Its helper: the writer's role, only the tools in its groups, its character in the instructions.
  const def = teamHelpers(r.app).find((h) => h.id === `worker-${w.id}`)!;
  assert.ok(def, 'the worker is a helper the team can run');
  assert.deepEqual([...def.tools].sort(), ['edit_file', 'list_dir', 'read_file', 'search', 'write_file']);
  assert.match(def.instructions, /Cheerful, precise/);
  const w2 = r.workers.create({ ...DANA, name: 'Reader Rae', toolGroups: ['read'] });
  assert.deepEqual([...teamHelpers(r.app).find((h) => h.id === `worker-${w2.id}`)!.tools].sort(), ['list_dir', 'read_file', 'search']);
  const job = r.workers.enqueue(w.id, { title: 'Tidy the README', input: 'Make it shorter.' });
  assert.equal(job.status, 'queued');
  assert.equal(r.workers.tick(), 1);
  const done = await r.workers.finished(job.id);
  assert.equal(done.status, 'done');
  assert.equal(done.result, 'did Tidy the README');
  const msgs = r.app.store.messages(w.conversationId);
  assert.ok(msgs.some((m) => m.content.includes('did Tidy the README')), 'the result is in the worker thread');
  assert.equal(r.workers.usedToday(w.id), 1000);
  assert.throws(() => r.workers.create({ ...DANA, helper: 'nobody' }), WorkerError);
});

test('workers: one job at a time per worker, and the queue survives a restart', async (t) => {
  const r = rig(t);
  const w = r.workers.create(DANA);
  r.plans.push({ hang: true });
  const a = r.workers.enqueue(w.id, { title: 'First job', input: '' });
  const b = r.workers.enqueue(w.id, { title: 'Second job', input: '' });
  assert.equal(r.workers.tick(), 1);
  assert.equal(r.workers.tick(), 0, 'the second waits while the first runs');
  assert.equal(r.workers.job(a.id)!.status, 'running');
  assert.equal(r.workers.job(b.id)!.status, 'queued');
  // Restart: a fresh store and manager on the same database file.
  r.app.store.close();
  r.app.store = new Store(join(r.dir, 'sara.db'), () => r.clock.now);
  const again = new Workers(r.app, r.app.store.db, r.opts);
  r.app.workers = again;
  const ia = again.job(a.id)!;
  assert.equal(ia.status, 'queued', 'the interrupted job goes back in the queue');
  assert.equal(ia.attempts, 1, 'its try counted');
  assert.match(ia.error ?? '', /restart/);
  assert.equal(again.job(b.id)!.status, 'queued');
  assert.equal(again.tick(), 1);
  assert.equal((await again.finished(a.id)).status, 'done');
  assert.equal(again.tick(), 1);
  assert.equal((await again.finished(b.id)).status, 'done');
  assert.deepEqual(r.started.map((s) => s.title), ['First job', 'First job', 'Second job']);
});

test('workers: a failure retries with backoff, then lands in Failed jobs; replay is a copy, drop hides it', async (t) => {
  const r = rig(t);
  const w = r.workers.create({ ...DANA, maxAttempts: 3 });
  const fail = { outcome: { status: 'failed' as const, result: '', tokens: 10, error: 'the file was locked' } };
  r.plans.push(fail, fail, fail);
  const job = r.workers.enqueue(w.id, { title: 'Fix the docs', input: 'all of them' });
  r.workers.tick();
  let j = await r.workers.finished(job.id);
  assert.equal(j.status, 'queued');
  assert.equal(j.attempts, 1);
  assert.equal(Date.parse(j.nextAt!) - r.clock.now.getTime(), WORKER.backoffMs[0]);
  assert.equal(r.workers.tick(), 0, 'not before its backoff');
  r.clock.now = new Date(r.clock.now.getTime() + WORKER.backoffMs[0]);
  assert.equal(r.workers.tick(), 1);
  j = await r.workers.finished(job.id);
  assert.equal(Date.parse(j.nextAt!) - r.clock.now.getTime(), WORKER.backoffMs[1], 'the wait grows');
  r.clock.now = new Date(r.clock.now.getTime() + WORKER.backoffMs[1]);
  r.workers.tick();
  j = await r.workers.finished(job.id);
  assert.equal(j.status, 'failed');
  assert.equal(j.attempts, 3);
  assert.match(j.error!, /locked/);
  assert.deepEqual(r.workers.failed().map((x) => x.id), [job.id]);
  // Replay: a new queued copy; the failed one stays for the record (non-destructive).
  const copy = r.workers.replay(job.id);
  assert.notEqual(copy.id, job.id);
  assert.equal(copy.status, 'queued');
  assert.equal(copy.attempts, 0);
  assert.equal(copy.replayOf, job.id);
  assert.equal(copy.input, 'all of them');
  assert.equal(r.workers.job(job.id)!.status, 'failed');
  assert.equal(r.workers.job(job.id)!.replayedBy, copy.id);
  r.workers.tick();
  assert.equal((await r.workers.finished(copy.id)).status, 'done');
  assert.equal(r.workers.drop(job.id), true);
  assert.equal(r.workers.job(job.id)!.status, 'dropped');
  assert.deepEqual(r.workers.failed(), []);
  assert.throws(() => r.workers.replay(copy.id), WorkerError, 'only failed jobs replay');
});

test('workers: a job over its time limit is stopped and counted as a failed try', async (t) => {
  const r = rig(t);
  const w = r.workers.create({ ...DANA, timeLimitMin: 5, maxAttempts: 1 });
  r.plans.push({ hang: true });
  const job = r.workers.enqueue(w.id, { title: 'Slow job', input: '' });
  r.workers.tick();
  r.clock.now = new Date(r.clock.now.getTime() + 4 * 60_000);
  r.workers.tick();
  assert.equal(r.workers.job(job.id)!.status, 'running');
  r.clock.now = new Date(r.clock.now.getTime() + 2 * 60_000);
  r.workers.tick();
  const j = await r.workers.finished(job.id);
  assert.deepEqual(r.stopped, [job.id]);
  assert.equal(j.status, 'failed');
  assert.match(j.error!, /time limit/);
});

test('workers: needs you: one alert per blocker, deduped, held in quiet hours', async (t) => {
  const r = rig(t);
  const w = r.workers.create(DANA);
  r.plans.push({ hang: true, waiting: true });
  const job = r.workers.enqueue(w.id, { title: 'Needs an approval', input: '' });
  r.workers.tick();
  r.workers.tick();
  r.workers.tick();
  await settle();
  assert.equal(r.alerts.length, 1, 'an approval waiting: one alert, not one per tick');
  assert.match(r.alerts[0].text, /approval/i);
  assert.equal(r.alerts[0].channel, 'push', 'no linked chat app: the app push');
  assert.equal(r.workers.alerts().filter((a) => a.sentAt).length, 1);
  r.workers.stop(w.id);
  await r.workers.finished(job.id);
  // Repeated failure at night: held, then sent once when quiet hours end.
  r.setQuiet(true);
  const w2 = r.workers.create({ ...DANA, name: 'Night Nell', maxAttempts: 1 });
  r.plans.push({ outcome: { status: 'failed', result: '', tokens: 0, error: 'broken' } });
  const j2 = r.workers.enqueue(w2.id, { title: 'Night job', input: '' });
  r.workers.tick();
  await r.workers.finished(j2.id);
  r.workers.tick();
  await settle();
  assert.equal(r.alerts.length, 1, 'quiet hours: held');
  assert.ok(r.workers.alerts().some((a) => a.reason === 'failing' && !a.sentAt));
  r.setQuiet(false);
  r.workers.tick();
  r.workers.tick();
  await settle();
  assert.equal(r.alerts.length, 2);
  assert.match(r.alerts[1].text, /Night job/);
  // Budget reached: the job waits in the queue and one alert says so.
  const w3 = r.workers.create({ ...DANA, name: 'Thrifty Tess', dailyTokens: 20_000 });
  r.plans.push({ outcome: { status: 'done', result: 'ok', tokens: 15_000 } });
  const j3 = r.workers.enqueue(w3.id, { title: 'Big job', input: '' });
  r.workers.tick();
  await r.workers.finished(j3.id);
  const j4 = r.workers.enqueue(w3.id, { title: 'Another job', input: '' });
  r.workers.tick();
  r.workers.tick();
  await settle();
  assert.equal(r.workers.job(j4.id)!.status, 'queued');
  assert.equal(r.alerts.filter((a) => /budget/i.test(a.text)).length, 1);
  // A new day: the budget is back and the job runs.
  r.clock.now = new Date('2026-11-05T12:00:00Z');
  assert.equal(r.workers.tick(), 1);
  assert.equal((await r.workers.finished(j4.id)).status, 'done');
});

test('workers: the alert goes to the chat app he used last when it is linked', async (t) => {
  const r = rig(t);
  const sent: string[] = [];
  r.app.bridges = { telegram: { ownerLinked: () => true, toOwner: async (s: string) => (sent.push(s), true) } } as never;
  const tg = r.app.store.createConversation({ title: 'Telegram', channel: 'telegram', channelKey: '42' } as never);
  r.app.store.addMessage(tg.id, 'user', 'hi');
  const plain = new Workers(r.app, r.app.store.db, { runner: r.opts.runner, quiet: () => false });
  const w = plain.create({ ...DANA, name: 'Tele Tom', maxAttempts: 1 });
  r.plans.push({ outcome: { status: 'failed', result: '', tokens: 0, error: 'nope' } });
  const j = plain.enqueue(w.id, { title: 'Ping job', input: '' });
  plain.tick();
  await plain.finished(j.id);
  await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Tele Tom/);
});

test('workers: a lead hands jobs to the workers under it and their results bubble up', async (t) => {
  const r = rig(t);
  const lead = r.workers.create({ ...DANA, name: 'Lead Lou', helper: 'researcher', toolGroups: ['read'] });
  const a = r.workers.create({ ...DANA, name: 'Ann', leadId: lead.id });
  const b = r.workers.create({ ...DANA, name: 'Ben', leadId: lead.id });
  const other = r.workers.create({ ...DANA, name: 'Olga' });
  assert.match(teamHelpers(r.app).find((h) => h.id === `worker-${lead.id}`)!.instructions, /HAND TO/);
  assert.throws(() => r.workers.patch(lead.id, { leadId: a.id }), WorkerError, 'no loops');
  r.plans.push({ outcome: { status: 'done', result: 'Plan made.\nHAND TO Ann: write the intro\nHAND TO ben: write the outro\nHAND TO Olga: not mine', tokens: 100 } });
  const job = r.workers.enqueue(lead.id, { title: 'Write the guide', input: '' });
  r.workers.tick();
  await r.workers.finished(job.id);
  const kids = r.workers.children(job.id);
  assert.deepEqual(kids.map((k) => [k.workerId, k.title]), [[a.id, 'write the intro'], [b.id, 'write the outro']]);
  assert.equal(r.workers.jobs(other.id).length, 0, 'only workers under the lead');
  assert.equal(r.workers.tick(), 2, 'each child worker runs its own');
  await Promise.all(kids.map((k) => r.workers.finished(k.id)));
  await settle();
  const leadMsgs = r.app.store.messages(lead.conversationId).map((m) => m.content).join('\n');
  assert.match(leadMsgs, /did write the intro/);
  assert.match(leadMsgs, /did write the outro/);
  assert.match(r.workers.job(job.id)!.result!, /Ann[\s\S]*did write the intro[\s\S]*Ben[\s\S]*did write the outro/);
});

test('workers: bundle round-trip; secrets and memories never leave unless ticked', async (t) => {
  const r = rig(t);
  r.app.vault.set('github_token', 'ghp_VAULTSECRET0987654321');
  const lead = r.workers.create({ ...DANA, name: 'Lead Lou', character: 'Calm. Never paste ghp_VAULTSECRET0987654321 or sk-live-SECRETKEY1234567890.', skills: ['weekly-report'] });
  r.workers.create({ ...DANA, name: 'Ann', helper: 'coder', toolGroups: ['read', 'shell'], leadId: lead.id });
  r.plans.push({ outcome: { status: 'done', result: 'Remembered: the owner likes short docs.', tokens: 10 } });
  const job = r.workers.enqueue(lead.id, { title: 'Learn', input: '' });
  r.workers.tick();
  await r.workers.finished(job.id);
  const bundle = r.workers.exportBundle(lead.id);
  const raw = JSON.stringify(bundle);
  assert.equal(bundle.kind, 'sara-worker-bundle');
  assert.equal(bundle.manifest.workers, 2, 'a lead exports with the workers under it');
  assert.ok(!raw.includes('ghp_VAULTSECRET'), 'no vault secret');
  assert.ok(!raw.includes('SECRETKEY'), 'no API key');
  assert.ok(!raw.includes('owner likes short docs'), 'no memories by default');
  assert.ok(!raw.includes(lead.conversationId), 'no thread ids');
  assert.deepEqual(bundle.workers[0].skills, ['weekly-report']);
  const withMem = r.workers.exportBundle(lead.id, { memories: true });
  assert.match(JSON.stringify(withMem), /owner likes short docs/);
  // Import on another server: a preview with the permission review first.
  const s = rig(t);
  const preview = s.workers.previewImport(JSON.parse(raw));
  assert.equal(preview.workers.length, 2);
  const ann = preview.workers.find((w) => w.name === 'Ann')!;
  assert.ok(ann.tools.includes('shell'));
  assert.ok(ann.risky.includes('shell'), 'shell is flagged for review');
  assert.equal(ann.lead, 'Lead Lou');
  assert.deepEqual(preview.missingSkills, ['weekly-report']);
  assert.throws(() => s.workers.importBundle(JSON.parse(raw), {}), WorkerError, 'needs his confirmation');
  const made = s.workers.importBundle(JSON.parse(raw), { confirm: true });
  assert.equal(made.length, 2);
  assert.ok(made.every((w) => w.state === 'paused'), 'imported workers start paused');
  const sAnn = made.find((w) => w.name === 'Ann')!;
  const sLead = made.find((w) => w.name === 'Lead Lou')!;
  assert.equal(sAnn.leadId, sLead.id);
  assert.deepEqual(sAnn.toolGroups, ['read', 'shell']);
  assert.equal(sAnn.helper, 'coder');
  assert.throws(() => s.workers.previewImport({ kind: 'nope' }), WorkerError);
});

test('workers: the crews pin covers workers; a crew member can stay', (t) => {
  const r = rig(t);
  r.app.team = new TeamManager(r.app, r.app.store.db);
  r.app.crews = new Crews(r.app, r.app.store.db);
  const crew = r.app.crews.create({ name: 'Weekly', brief: 'Write a short weekly report for Alex.', members: [{ helper: 'writer', task: 'Write the weekly report' }] });
  const w = r.workers.create({ fromCrew: { crewId: crew.id, member: 0 }, toolGroups: ['read', 'write'] });
  assert.equal(w.helper, 'writer');
  assert.equal(w.crewId, crew.id);
  assert.match(w.character, /weekly report/);
  const pol = new PolicyStore(r.dir);
  setPolicy(pol);
  pol.set({ name: 'House', pins: { crews: 'off' } });
  assert.throws(() => r.workers.create(DANA), WorkerError);
  assert.throws(() => r.workers.enqueue(w.id, { title: 'x job', input: '' }), WorkerError);
  assert.equal(r.workers.tick(), 0);
});

test('workers: the default runner uses the team (approvals, tools, its own thread)', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-04T12:00:00Z') };
  const app = makeApp(dir, clock);
  for (const tool of [listDir, readFileTool, writeFileTool]) app.tools.add(tool);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString(), toolPermissions: { list_dir: 'auto', read_file: 'auto', write_file: 'auto' } });
  app.team = new TeamManager(app, app.store.db);
  app.workers = new Workers(app, app.store.db, { alert: async () => true, quiet: () => false });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const w = app.workers.create({ ...DANA, toolGroups: ['read'] });
  app.script.push([call('r1', 'list_dir', { path: '.' })], text('Dana looked: the workspace is empty.'), text('Summary: Dana looked at the workspace.'));
  const job = app.workers.enqueue(w.id, { title: 'Look at the workspace', input: 'List what is there.' });
  app.workers.tick();
  const done = await app.workers.finished(job.id);
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.match(done.result!, /workspace is empty/);
  const task = app.team.get(done.teamTaskId!)!;
  assert.equal(task.conversationId, w.conversationId, 'the work happens in its own thread');
  assert.deepEqual(task.steps.map((s) => s.helper), [`worker-${w.id}`]);
});
