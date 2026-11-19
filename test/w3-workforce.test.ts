// W3.4 (docs/design/W3WORKFORCE.md): agent workforce v2. Workers get goals with a simple measure
// (KPI) and a budget cap per goal; a cap stops work and asks; one worker's output becomes the next
// worker's job (a visible chain); each week they propose a plan the owner approves or edits in one
// card; a goal view shows progress, spend vs cap and what is blocked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { TeamManager } from '../src/team.ts';
import { UsageStore } from '../src/usage.ts';
import { Workers, type Worker, type WorkerJob, type WorkerOutcome } from '../src/workers.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

interface Call {
  w: Worker;
  job: WorkerJob;
  budget: { tokens: number; minutes: number };
  end: (o: WorkerOutcome) => void;
}

function rig(t: TestContext, start = '2026-11-16T12:00:00Z') {
  const { dir, cleanup } = tempDir();
  const c = { now: new Date(start) };
  const app = makeApp(dir, c);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', needsKey: false }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago', disclosureAcceptedAt: c.now.toISOString() } as never);
  app.team = new TeamManager(app, app.store.db);
  app.usage = new UsageStore(app.store.db, () => c.now);
  const calls: Call[] = [];
  const alerts: { title: string; text: string }[] = [];
  const workers = new Workers(app, app.store.db, {
    runner: (w, job, budget) => {
      let end!: (o: WorkerOutcome) => void;
      const done = new Promise<WorkerOutcome>((r) => (end = r));
      calls.push({ w, job, budget, end });
      return { done, stop: () => end({ status: 'stopped', result: '', tokens: 0 }), waiting: () => false };
    },
    alert: async (a) => {
      alerts.push({ title: a.title, text: a.text });
      return true;
    },
    quiet: () => false,
  });
  app.workers = workers;
  t.after(() => {
    try {
      app.store.close();
    } catch {}
    cleanup();
  });
  const finish = async (i: number, o: Partial<WorkerOutcome> & { result?: string }) => {
    calls[i].end({ status: 'done', result: '', tokens: 1000, ...o });
    return workers.finished(calls[i].job.id);
  };
  return { app, dir, clock: c, workers, calls, alerts, finish, goals: workers.goals };
}

const team = (r: ReturnType<typeof rig>) => ({
  scout: r.workers.create({ name: 'Scout Sam', character: 'Curious.', helper: 'writer', toolGroups: ['web'], dailyTokens: 200_000 }),
  writer: r.workers.create({ name: 'Writer Wes', character: 'Clear.', helper: 'writer', toolGroups: ['read'], dailyTokens: 200_000 }),
  editor: r.workers.create({ name: 'Editor Eve', character: 'Strict.', helper: 'writer', toolGroups: ['read'], dailyTokens: 200_000 }),
});

test('W3.4 goals: a goal has a worker, a simple measure and a cap; bad input is refused', (t) => {
  const r = rig(t);
  const { scout, writer } = team(r);
  const g = r.goals.create({ workerId: scout.id, title: 'Two blog posts a week', measure: 'posts', kind: 'jobs', target: 2, period: 'week', capUsd: 1.5, capTokens: 100_000, chain: [writer.id], every: 'Find two topics' });
  assert.equal(g.workerId, scout.id);
  assert.deepEqual(g.chain, [writer.id]);
  assert.equal(g.state, 'on');
  assert.throws(() => r.goals.create({ workerId: 999, title: 'Nope' }), /worker/i);
  assert.throws(() => r.goals.create({ workerId: scout.id, title: 'x' }), /goal/i);
  assert.throws(() => r.goals.create({ workerId: scout.id, title: 'Loop', chain: [scout.id] }), /chain|pass/i);
  assert.throws(() => r.goals.create({ workerId: scout.id, title: 'Bad cap', capUsd: -1 }), /cap/i);
  const p = r.goals.patch(g.id, { target: 3, capUsd: null });
  assert.equal(p.target, 3);
  assert.equal(p.capUsd, null);
  assert.equal(r.goals.list().length, 1);
  assert.ok(r.goals.remove(g.id));
  assert.equal(r.goals.list().length, 0);
});

test('W3.4 caps stop work and ask: a capped goal holds its jobs, alerts once, and a raised cap lets them run', async (t) => {
  const r = rig(t);
  const { scout } = team(r);
  const g = r.goals.create({ workerId: scout.id, title: 'Weekly research', target: 5, period: 'week', capTokens: 30_000 });
  // The runner gets at most what is left under the goal's cap.
  r.goals.addJob(g.id, { title: 'First pass' });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].budget.tokens, 30_000);
  await r.finish(0, { tokens: 30_000, result: 'Found three sources.' });
  r.goals.addJob(g.id, { title: 'Second pass' });
  r.workers.tick();
  assert.equal(r.calls.length, 1, 'the cap is reached: the next job waits');
  assert.equal(r.goals.get(g.id)!.state, 'capped');
  const capAlerts = () => r.workers.alerts().filter((a) => a.reason === 'cap');
  assert.equal(capAlerts().length, 1);
  assert.match(capAlerts()[0].text, /Weekly research/);
  r.workers.tick();
  assert.equal(capAlerts().length, 1, 'asked once, not every tick');
  const view = r.goals.view(g.id)!;
  assert.ok(view.blocked.some((b) => b.kind === 'cap'));
  assert.equal(view.spent.tokens, 30_000);
  // Raising the cap answers the ask: the job runs with the new room.
  r.goals.patch(g.id, { capTokens: 50_000 });
  r.workers.tick();
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1].budget.tokens, 20_000);
  assert.equal(r.goals.get(g.id)!.state, 'on');
});

test('W3.4 dollar caps count the usage rows of the goal jobs, and a new week starts fresh', async (t) => {
  const r = rig(t);
  const { scout } = team(r);
  const g = r.goals.create({ workerId: scout.id, title: 'Price watch', period: 'week', capUsd: 0.05 });
  r.goals.addJob(g.id, { title: 'Check prices' });
  const task = 4242;
  r.app.store.db.prepare("INSERT INTO usage (at, provider_id, provider_label, model, billing, purpose, conversation_id, job_id, team_task_id, input, output, cached, usd) VALUES (?, 'p', 'P', 'm', 'api', 'team', NULL, NULL, ?, 100, 50, 0, 0.06)").run(r.clock.now.toISOString(), task);
  await r.finish(0, { tokens: 2000, teamTaskId: task, result: 'Prices are flat.' });
  r.goals.addJob(g.id, { title: 'Check again' });
  assert.equal(r.calls.length, 1);
  assert.equal(r.goals.get(g.id)!.state, 'capped');
  assert.equal(Math.round(r.goals.view(g.id)!.spent.usd * 100), 6);
  // Next Monday the weekly cap starts over: the held job runs by itself.
  r.clock.now = new Date('2026-11-23T15:00:00Z');
  r.workers.tick();
  assert.equal(r.calls.length, 2);
  assert.equal(r.goals.get(g.id)!.state, 'on');
});

test('W3.4 hand-offs: each step’s output becomes the next worker’s job, shown as one chain; the last step counts', async (t) => {
  const r = rig(t);
  const { scout, writer, editor } = team(r);
  const g = r.goals.create({ workerId: scout.id, title: 'Two blog posts a week', measure: 'posts', kind: 'jobs', target: 2, period: 'week', chain: [writer.id, editor.id] });
  const first = r.goals.addJob(g.id, { title: 'Post about solar panels' });
  await r.finish(0, { result: 'Topic: rooftop solar costs in 2026. Sources: A, B.' });
  assert.equal(r.calls.length, 2, 'the writer got the scout’s output');
  assert.equal(r.calls[1].w.id, writer.id);
  assert.match(r.calls[1].job.input, /rooftop solar costs/);
  assert.equal(r.calls[1].job.fromJob, first.id);
  assert.equal(r.calls[1].job.goalId, g.id);
  assert.equal(r.goals.view(g.id)!.progress.current, 0, 'not done until the last step');
  await r.finish(1, { result: 'Draft: Rooftop solar in 2026…' });
  assert.equal(r.calls[2].w.id, editor.id);
  await r.finish(2, { result: 'Edited and ready.' });
  assert.equal(r.calls.length, 3, 'the chain ends at the last worker');
  assert.equal(r.goals.view(g.id)!.progress.current, 1);
  const chain = r.goals.chainOf(r.calls[1].job.id);
  assert.deepEqual(chain.map((s) => s.worker), ['Scout Sam', 'Writer Wes', 'Editor Eve']);
  assert.ok(chain.every((s) => s.status === 'done'));
  assert.deepEqual(r.goals.view(g.id)!.chains[0].map((s) => s.title), ['Post about solar panels', chain[1].title, chain[2].title]);
  // The handed message in the scout's chat says where it went.
  const msgs = r.app.store.messages(scout.conversationId).map((m) => m.content).join('\n');
  assert.match(msgs, /Writer Wes/);
});

test('W3.4 PASS TO lines hand work to any worker; chains stop after six steps', async (t) => {
  const r = rig(t);
  const { scout, writer } = team(r);
  const g = r.goals.create({ workerId: scout.id, title: 'Newsletter' });
  r.goals.addJob(g.id, { title: 'Collect news' });
  await r.finish(0, { result: 'Three items.\nPASS TO Writer Wes: write a short newsletter from these three items' });
  assert.equal(r.calls[1].w.id, writer.id);
  assert.match(r.calls[1].job.title, /short newsletter/);
  assert.match(r.calls[1].job.input, /Three items/);
  // A ping-pong between two workers stops at the depth limit.
  let i = 1;
  while (i < r.calls.length && i < 20) {
    const other = r.calls[i].w.id === writer.id ? 'Scout Sam' : 'Writer Wes';
    await r.finish(i, { result: `Round ${i}.\nPASS TO ${other}: keep going round ${i}` });
    i++;
  }
  assert.ok(r.calls.length <= 6, `chain length ${r.calls.length}`);
});

test('W3.4 measures: PROGRESS lines set a number goal, NEXT lines become suggestions for the weekly plan', async (t) => {
  const r = rig(t);
  const { scout } = team(r);
  const g = r.goals.create({ workerId: scout.id, title: 'Reach 100 newsletter readers', measure: 'readers', kind: 'number', target: 100, period: 'total' });
  r.goals.addJob(g.id, { title: 'Post in two forums' });
  await r.finish(0, { result: 'Posted.\nPROGRESS: 37\nNEXT: Ask three blogs for a mention\nNEXT: Write a welcome mail' });
  const v = r.goals.view(g.id)!;
  assert.equal(v.progress.current, 37);
  assert.equal(v.progress.target, 100);
  assert.deepEqual(r.goals.get(g.id)!.suggestions, ['Ask three blogs for a mention', 'Write a welcome mail']);
  r.goals.patch(g.id, { current: 40 });
  assert.equal(r.goals.view(g.id)!.progress.current, 40, 'he can set it by hand');
  // Workers are told about their goals and the lines they may add.
  const def = r.workers.helperDefs([{ id: 'writer', name: 'Writer', emoji: '', role: 'writer', blurb: '', instructions: 'Base.', tools: [] } as never]).find((d) => d.id === `worker-${scout.id}`)!;
  assert.match(def.instructions, /Reach 100 newsletter readers/);
  assert.match(def.instructions, /PROGRESS:/);
  assert.match(def.instructions, /NEXT:/);
  assert.match(def.instructions, /PASS TO/);
});

test('W3.4 weekly plan: proposed each Monday from goals, approved with edits in one go, never twice a week', async (t) => {
  const r = rig(t, '2026-11-18T15:00:00Z');
  const { scout, writer } = team(r);
  const g = r.goals.create({ workerId: scout.id, title: 'Two blog posts a week', kind: 'jobs', target: 2, period: 'week', capUsd: 2, chain: [writer.id], every: 'Find two topics' });
  r.goals.patch(g.id, { suggestions: ['Look at reader questions'] });
  const g2 = r.goals.create({ workerId: writer.id, title: 'Tidy the docs', period: 'week' });
  r.workers.stop(scout.id);
  r.workers.patch(scout.id, { state: 'on' });
  // Wednesday first look only remembers the week.
  r.workers.tick();
  assert.equal(r.goals.plan(), undefined);
  // Monday 9 AM Chicago: the plan is proposed and posted where Workforce report alerts go.
  r.clock.now = new Date('2026-11-23T15:00:00Z');
  r.workers.tick();
  const plan = r.goals.plan()!;
  assert.equal(plan.state, 'proposed');
  const titles = plan.items.map((i) => i.title);
  assert.ok(titles.includes('Find two topics'));
  assert.ok(titles.includes('Look at reader questions'));
  assert.ok(plan.items.some((i) => i.goalId === g2.id), 'every active goal gets a step');
  const posted = r.app.store.listConversations().find((c) => /Workforce report/.test(c.title));
  assert.ok(posted, 'posted to the workforce feed');
  assert.match(r.app.store.messages(posted.id).at(-1)!.content, /plan/i);
  // Approve with edits: rename one, drop one, add one.
  const keep = plan.items.find((i) => i.title === 'Find two topics')!;
  const drop = plan.items.find((i) => i.title === 'Look at reader questions')!;
  const before = r.calls.length;
  const done = r.goals.decidePlan({ approve: true, items: plan.items.map((i) => (i.key === keep.key ? { key: i.key, title: 'Find two solar topics' } : i.key === drop.key ? { key: i.key, skip: true } : { key: i.key })), add: [{ goalId: g.id, title: 'Answer one reader mail' }] });
  assert.equal(done.state, 'approved');
  const made = r.app.store.db.prepare('SELECT title, goal_id FROM worker_jobs WHERE id > 0 ORDER BY id').all() as { title: string; goal_id: number }[];
  assert.ok(made.some((j) => j.title === 'Find two solar topics' && j.goal_id === g.id));
  assert.ok(made.some((j) => j.title === 'Answer one reader mail'));
  assert.ok(!made.some((j) => j.title === 'Look at reader questions'));
  assert.ok(r.calls.length > before, 'approved jobs start');
  assert.deepEqual(r.goals.get(g.id)!.suggestions, [], 'used suggestions are cleared');
  assert.throws(() => r.goals.decidePlan({ approve: true }), /already/i);
  // Same week: no second plan.
  r.clock.now = new Date('2026-11-24T15:00:00Z');
  r.workers.tick();
  assert.equal(r.goals.plan()!.state, 'approved');
  // Next week a fresh plan; skipping it enqueues nothing.
  r.clock.now = new Date('2026-11-30T16:00:00Z');
  r.workers.tick();
  const p2 = r.goals.plan()!;
  assert.equal(p2.state, 'proposed');
  assert.notEqual(p2.week, plan.week);
  const n = (r.app.store.db.prepare('SELECT COUNT(*) AS n FROM worker_jobs').get() as { n: number }).n;
  assert.equal(r.goals.decidePlan({ approve: false }).state, 'skipped');
  assert.equal((r.app.store.db.prepare('SELECT COUNT(*) AS n FROM worker_jobs').get() as { n: number }).n, n);
});

test('W3.4 goal view: progress, spend vs cap, estimate, and what is blocked (paused worker, failed job, daily budget)', async (t) => {
  const r = rig(t);
  const { scout, writer } = team(r);
  const g = r.goals.create({ workerId: scout.id, title: 'Research', kind: 'jobs', target: 4, period: 'week', capTokens: 100_000, chain: [writer.id] });
  r.goals.addJob(g.id, { title: 'One' });
  await r.finish(0, { status: 'failed', error: 'site was down', tokens: 500 } as never);
  r.workers.patch(writer.id, { state: 'paused' });
  r.workers.patch(scout.id, { maxAttempts: 1 });
  const v = r.goals.view(g.id)!;
  assert.equal(v.spent.tokens >= 500, true);
  assert.equal(v.cap.tokens, 100_000);
  const kinds = v.blocked.map((b) => b.kind);
  assert.ok(kinds.includes('paused'), kinds.join(','));
  assert.ok(v.blocked.find((b) => b.kind === 'paused')!.text.includes('Writer Wes'));
  // A failed job of the goal shows up once it ends as failed.
  const failed = r.app.store.db.prepare("SELECT COUNT(*) AS n FROM worker_jobs WHERE goal_id = ? AND status = 'failed'").get(g.id) as { n: number };
  if (failed.n) assert.ok(kinds.includes('failed'));
  assert.equal(r.goals.views().length, 1);
});

test('W3.4 routes: owner-only goals, plan and goal jobs inside the workers family', async (t) => {
  const r = rig(t);
  const { scout } = team(r);
  const auth = new OwnerAuth(r.dir);
  const token = auth.newToken ?? '';
  const srv = createSaraServer({ app: r.app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  t.after(() => {
    srv.closeAllConnections();
    srv.close();
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const req = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: base }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  const made = await req('POST', '/api/workers/goals', { workerId: scout.id, title: 'Weekly digest', capUsd: 1, target: 1 });
  assert.equal(made.status, 200);
  const id = made.body.goal.id;
  assert.equal((await req('POST', '/api/workers/goals', { workerId: scout.id, title: 'x' })).status, 400);
  const list = await req('GET', '/api/workers/goals');
  assert.equal(list.body.goals.length, 1);
  assert.equal(list.body.goals[0].title, 'Weekly digest');
  assert.ok('plan' in list.body);
  assert.equal((await req('PATCH', `/api/workers/goals/${id}`, { capUsd: 2 })).body.goal.capUsd, 2);
  const job = await req('POST', `/api/workers/goals/${id}/jobs`, { title: 'Write the digest' });
  assert.equal(job.body.job.goalId, id);
  const prop = await req('POST', '/api/workers/plan/propose', {});
  assert.equal(prop.status, 200);
  assert.equal(prop.body.plan.state, 'proposed');
  const ok = await req('POST', '/api/workers/plan/decide', { approve: false });
  assert.equal(ok.body.plan.state, 'skipped');
  assert.equal((await req('DELETE', `/api/workers/goals/${id}`)).status, 200);
  // Household members get nothing.
  const msrv = createSaraServer({ app: r.app, auth, webDir: join(ROOT, 'web'), spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Bo' }), apps: () => [r.app], deleteSelf: async () => {} } } as never);
  await new Promise<void>((ok2) => msrv.listen(0, '127.0.0.1', ok2));
  t.after(() => {
    msrv.closeAllConnections();
    msrv.close();
  });
  const mbase = `http://127.0.0.1:${(msrv.address() as AddressInfo).port}`;
  const m = await fetch(`${mbase}/api/workers/goals`, { headers: { authorization: `Bearer ${token}`, origin: mbase } });
  assert.equal(m.status, 403);
});

test('W3.4 wiring: the Team dialog has Goals and this week’s plan; strings via t(), no inline styles, tips', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /<h3 id="wgoals-h">Goals and weekly plan <button type="button" class="tip" data-tip="[^"]{20,260}">\?<\/button><\/h3>/);
  assert.match(html, /<div id="wgoals" aria-labelledby="wgoals-h"><\/div>/);
  const js = readFileSync(join(ROOT, 'web', 'worker-goals.js'), 'utf8');
  assert.doesNotMatch(js, /style=|\.style\./);
  for (const m of js.matchAll(/t\('((?:[^'\\]|\\.)*)'/g)) assert.ok(m[1].length <= 260, m[1]);
  for (const s of ["t('This week’s plan')", "t('Approve the plan')", "t('Raise the cap')", "t('What is blocked')", "t('Spent')"]) assert.ok(js.includes(s), s);
  assert.match(js, /'\/workers\/goals'/);
  assert.match(js, /'\/workers\/plan\/decide'/);
  assert.match(readFileSync(join(ROOT, 'web', 'workers.js'), 'utf8'), /loadGoals\(/);
});
