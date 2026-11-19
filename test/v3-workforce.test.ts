// V3.3 (docs/design/V3WORKFORCE.md): a weekly workforce report per worker (jobs, cost, failures,
// outputs) sent where the "Workforce report" feed points, and "Hire" from a marketplace listing
// straight into Workers with its budget preset, arriving paused.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { setFeedDest } from '../src/destinations.ts';
import { checkListing, hashListing, marketOf, type Listing } from '../src/market.ts';
import { createSaraServer } from '../src/server.ts';
import { TeamManager } from '../src/team.ts';
import { UsageStore } from '../src/usage.ts';
import { Workers, type WorkerOutcome } from '../src/workers.ts';
import { workforcePrefs, workforceReport, workforceText, workforceTick } from '../src/workforce.ts';
import { clock, linkPair, pairNode } from './helpers-repair-pair.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const idle = () => ({
  runner: () => {
    let end!: (o: WorkerOutcome) => void;
    return { done: new Promise<WorkerOutcome>((r) => (end = r)), stop: () => end({ status: 'stopped', result: '', tokens: 0 }), waiting: () => false };
  },
  alert: async () => true,
  quiet: () => false,
});

function rig(t: TestContext, start = '2026-11-16T12:00:00Z') {
  const { dir, cleanup } = tempDir();
  const c = { now: new Date(start) };
  const app = makeApp(dir, c);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', needsKey: false }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'America/Chicago', disclosureAcceptedAt: c.now.toISOString() } as never);
  app.team = new TeamManager(app, app.store.db);
  app.usage = new UsageStore(app.store.db, () => c.now);
  const workers = new Workers(app, app.store.db, idle());
  app.workers = workers;
  t.after(() => {
    try {
      app.store.close();
    } catch {}
    cleanup();
  });
  return { app, dir, clock: c, workers };
}

/** Fake job rows straight into the queue table, plus usage rows for their team tasks. */
function seed(r: ReturnType<typeof rig>) {
  const db = r.app.store.db;
  const dana = r.workers.create({ name: 'Docs Dana', character: 'Precise.', helper: 'writer', toolGroups: ['read', 'write'], dailyTokens: 50_000, timeLimitMin: 10 });
  const sam = r.workers.create({ name: 'Scout Sam', character: 'Curious.', helper: 'writer', toolGroups: ['web'], dailyTokens: 80_000, timeLimitMin: 20 });
  const ago = (d: number) => new Date(r.clock.now.getTime() - d * 86_400_000).toISOString();
  const job = (w: number, title: string, status: string, ended: string | null, tokens: number, task: number | null, o: { result?: string; error?: string } = {}) =>
    db.prepare('INSERT INTO worker_jobs (worker_id, title, input, status, attempts, error, result, tokens, team_task_id, ended_at, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)').run(w, title, '', status, o.error ?? null, o.result ?? null, tokens, task, ended, ended ?? ago(0.1));
  const use = (task: number, usd: number | null) =>
    db.prepare("INSERT INTO usage (at, provider_id, provider_label, model, billing, purpose, conversation_id, job_id, team_task_id, input, output, cached, usd) VALUES (?, 'p', 'P', 'm', 'api', 'team', NULL, NULL, ?, 100, 50, 0, ?)").run(ago(1), task, usd);
  job(dana.id, 'Release notes', 'done', ago(1), 1200, 101, { result: 'Wrote the notes for 3.31: five fixes and two new pages.' });
  job(dana.id, 'Docs index', 'done', ago(2), 800, 102, { result: 'Updated the index.' });
  job(dana.id, 'FAQ pass', 'done', ago(6.5), 1000, 103, { result: 'Shortened the FAQ.' });
  job(dana.id, 'Old thing', 'done', ago(10), 5000, 104, { result: 'Long ago.' });
  job(dana.id, 'Broken links', 'failed', ago(3), 300, 105, { error: 'it reached its budget for the job' });
  job(dana.id, 'Translate page', 'failed', ago(4), 200, null, { error: 'stopped by you' });
  job(dana.id, 'Next up', 'queued', null, 0, null);
  job(dana.id, 'Dropped one', 'dropped', ago(1), 999, 106);
  use(101, 0.02);
  use(101, 0.01);
  use(102, 0.005);
  use(103, null);
  use(104, 9);
  use(105, 0.004);
  use(106, 7);
  return { dana, sam };
}

test('V3.3 report: counts, tokens and dollars match the fake job rows; outside-window and dropped rows never count', (t) => {
  const r = rig(t);
  const { dana, sam } = seed(r);
  const rep = workforceReport(r.app, { days: 7 });
  const d = rep.workers.find((w) => w.id === dana.id)!;
  assert.deepEqual({ done: d.done, failed: d.failed, waiting: d.waiting, tokens: d.tokens }, { done: 3, failed: 2, waiting: 1, tokens: 1200 + 800 + 1000 + 300 + 200 });
  assert.equal(Math.round(d.usd * 1000), 39, 'dollars = usage rows of those jobs’ team tasks');
  assert.equal(d.unpriced, 1);
  assert.deepEqual(d.failures.map((f) => f.title), ['Broken links', 'Translate page'], 'newest first');
  assert.match(d.failures[0].error, /budget/);
  assert.deepEqual(d.outputs.map((o) => o.title), ['Release notes', 'Docs index', 'FAQ pass']);
  assert.match(d.outputs[0].text, /^Wrote the notes/);
  const s = rep.workers.find((w) => w.id === sam.id)!;
  assert.deepEqual({ done: s.done, failed: s.failed, waiting: s.waiting, tokens: s.tokens, usd: s.usd }, { done: 0, failed: 0, waiting: 0, tokens: 0, usd: 0 });
  assert.deepEqual({ done: rep.total.done, failed: rep.total.failed, tokens: rep.total.tokens }, { done: 3, failed: 2, tokens: 3500 });
  const text = workforceText(r.app, rep);
  assert.match(text, /Docs Dana/);
  assert.match(text, /3 done, 2 failed/);
  assert.match(text, /Broken links/);
  assert.match(text, /Release notes/);
  assert.match(text, /Scout Sam: nothing this week/);
});

test('V3.3 weekly tick: once a week from the chosen day and hour, never when off or idle, where the feed points', async (t) => {
  // 2026-11-15 is a Sunday; Chicago is UTC-6 in November.
  const r = rig(t, '2026-11-15T20:00:00Z');
  seed(r);
  assert.deepEqual(workforcePrefs(r.app), { on: true, day: 1, hour: 9 });
  const chats = () => r.app.store.listConversations().filter((c) => c.title === 'Workforce report');
  r.workers.tick(r.clock.now);
  assert.equal(chats().length, 0, 'Sunday: not yet');
  r.clock.now = new Date('2026-11-16T14:59:00Z'); // Monday 8:59 AM
  assert.equal(workforceTick(r.app, r.clock.now), false);
  r.clock.now = new Date('2026-11-16T15:05:00Z'); // Monday 9:05 AM
  r.workers.tick(r.clock.now);
  assert.equal(chats().length, 1, 'its own chat, named after the feed');
  const msgs = r.app.store.messages(chats()[0].id);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].content, /Docs Dana/);
  r.clock.now = new Date('2026-11-18T15:05:00Z');
  assert.equal(workforceTick(r.app, r.clock.now), false, 'once a week');
  // Next week, sent to Telegram only (the existing feed picker).
  const sent: string[] = [];
  r.app.bridges = { telegram: { status: () => ({ running: true, linked: true }), sendOwnText: async (x: string) => void sent.push(x) } } as never;
  setFeedDest(r.app, 'workforce' as never, { where: 'apps', telegram: true }, true);
  r.clock.now = new Date('2026-11-23T15:30:00Z');
  const dana = r.workers.list().find((w) => w.name === 'Docs Dana')!;
  r.app.store.db.prepare("INSERT INTO worker_jobs (worker_id, title, input, status, result, tokens, ended_at, created_at) VALUES (?, 'Weekly digest', '', 'done', 'Sent it.', 400, ?, ?)").run(dana.id, '2026-11-22T12:00:00Z', '2026-11-22T11:00:00Z');
  assert.equal(workforceTick(r.app, r.clock.now), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Docs Dana/);
  // Off: nothing. Idle week: nothing either.
  const off = rig(t, '2026-11-16T15:05:00Z');
  seed(off);
  const { setWorkforcePrefs } = await import('../src/workforce.ts');
  setWorkforcePrefs(off.app, { on: false });
  assert.equal(workforceTick(off.app, off.clock.now), false);
  const empty = rig(t, '2026-11-16T15:05:00Z');
  empty.workers.create({ name: 'Quiet Q', character: '', helper: 'writer', toolGroups: ['read'] });
  assert.equal(workforceTick(empty.app, empty.clock.now), false);
});

test('V3.3 routes: report, settings and send now are the owner’s, inside the workers family', async (t) => {
  const r = rig(t);
  seed(r);
  const auth = new OwnerAuth(r.dir);
  const server = createSaraServer({ app: r.app, auth, webDir: join(ROOT, 'web') } as never);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  });
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { Origin: base, authorization: ['Bearer', auth.newToken].join(' '), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const g = await api('/api/workers/report');
  assert.equal(g.status, 200);
  assert.equal(g.body.report.total.done, 3);
  assert.deepEqual(g.body.prefs, { on: true, day: 1, hour: 9 });
  assert.equal(typeof g.body.postsTo, 'string');
  const p = await api('/api/workers/report/settings', 'PUT', { on: false, day: 5, hour: 17 });
  assert.deepEqual(p.body.prefs, { on: false, day: 5, hour: 17 });
  assert.equal((await api('/api/workers/report/settings', 'PUT', { day: 9 })).status, 400);
  const s = await api('/api/workers/report/send', 'POST', {});
  assert.equal(s.status, 200);
  assert.ok(r.app.store.listConversations().some((c) => c.title === 'Workforce report'));
});

test('V3.3 hire: a worker listing is checked by the receiver and arrives paused with its budget preset; memories and command groups never cross', async (t) => {
  const bo = await pairNode(t, 'Bo');
  const cy = await pairNode(t, 'Cy');
  for (const n of [bo, cy]) {
    n.app.team = new TeamManager(n.app, n.app.store.db);
    n.app.workers = new Workers(n.app, n.app.store.db, idle());
    const mk = marketOf(n.app);
    t.after(async () => mk?.idle());
  }
  const { aLink: boLink, bLink: cyLink } = await linkPair(bo, cy);
  const dana = bo.app.workers!.create({ name: 'Docs Dana', character: 'Precise; short sentences.', helper: 'writer', toolGroups: ['read', 'web'], dailyTokens: 60_000, timeLimitMin: 15, maxAttempts: 2 });
  bo.app.workers!.create({ name: 'Proof Pat', character: 'Checks spelling.', helper: 'writer', toolGroups: ['read'], leadId: dana.id, dailyTokens: 20_000 });
  bo.app.store.db.prepare("INSERT INTO worker_jobs (worker_id, title, input, status, result, created_at) VALUES (?, 'x', '', 'done', 'PRIVATE-RESULT-TEXT', ?)").run(dana.id, clock.now.toISOString());
  const items = await bo.req('GET', '/api/market/items');
  assert.ok((items.worker as { ref: string }[]).some((w) => w.ref === String(dana.id)));
  await bo.req('POST', '/api/market/publish', { place: `f:${boLink}`, kind: 'worker', ref: String(dana.id), version: '1.0.0', description: 'Writes docs.' });
  // A worker that may run commands is never shared.
  const shell = bo.app.workers!.create({ name: 'Shell Sid', character: '', helper: 'writer', toolGroups: ['read', 'shell'] });
  assert.equal((await bo.raw('POST', '/api/market/publish', { place: `f:${boLink}`, kind: 'worker', ref: String(shell.id), version: '1.0.0', description: 'x' })).status, 400);
  const list = (await cy.req('GET', `/api/market/places/${encodeURIComponent(`f:${cyLink}`)}`)).listings as any[];
  const l = list.find((x) => x.kind === 'worker');
  assert.ok(l);
  assert.doesNotMatch(JSON.stringify(l), /PRIVATE-RESULT-TEXT/);
  const rv = (await cy.req('POST', '/api/market/review', { place: `f:${cyLink}`, listing: l.id })) as any;
  assert.equal(rv.check.ok, true, rv.check.problems.join(' '));
  assert.match(rv.check.does.join(' '), /paused/);
  assert.match(rv.check.does.join(' '), /60,000 tokens a day/);
  const before = cy.app.workers!.list().length;
  const inst = (await cy.req('POST', '/api/market/install', { place: `f:${cyLink}`, listing: l.id, hash: rv.listing.hash })) as any;
  assert.equal(inst.installed.kind, 'worker');
  const hired = cy.app.workers!.list();
  assert.equal(hired.length, before + 2, 'the worker and the one it leads');
  const d = hired.find((w) => w.name === 'Docs Dana')!;
  assert.equal(d.state, 'paused');
  assert.deepEqual({ dailyTokens: d.dailyTokens, timeLimitMin: d.timeLimitMin, maxAttempts: d.maxAttempts, toolGroups: d.toolGroups }, { dailyTokens: 60_000, timeLimitMin: 15, maxAttempts: 2, toolGroups: ['read', 'web'] });
  assert.ok(hired.every((w) => w.state === 'paused'));
  assert.equal(hired.find((w) => w.name === 'Proof Pat')!.leadId, d.id);
  assert.equal(inst.installed.ref, String(d.id));
  // Installing again (an update) re-uses the hired worker instead of adding copies.
  await cy.req('PATCH', `/api/workers/${d.id}`, { state: 'on' });
  await cy.req('POST', '/api/market/install', { place: `f:${cyLink}`, listing: l.id, hash: rv.listing.hash });
  assert.equal(cy.app.workers!.list().length, before + 2);
  assert.equal(cy.app.workers!.get(d.id)!.state, 'paused');
});

test('V3.3 hire: static checks refuse memories, command groups and things that are not worker bundles', () => {
  const w = { key: 'w1', name: 'Docs Dana', character: 'Precise.', helper: 'writer', role: 'writer', toolGroups: ['read'], skills: [], dailyTokens: 50_000, timeLimitMin: 10, maxAttempts: 3, lead: null };
  const mk = (payload: Record<string, unknown>): Listing => {
    const base = { id: 'l9', kind: 'worker', title: 'Docs Dana', description: 'Writes docs.', version: '1.0.0', author: 'Bo', permissions: { tools: [], settings: [] }, payload, at: new Date().toISOString() } as unknown as Listing;
    return { ...base, hash: hashListing(base) };
  };
  const bundle = (ws: unknown[]) => ({ kind: 'sara-worker-bundle', version: 1, manifest: { name: 'Docs Dana', workers: ws.length, memories: false }, workers: ws });
  assert.equal(checkListing(mk(bundle([w]))).ok, true);
  assert.equal(checkListing(mk(bundle([{ ...w, memories: ['hello'] }]))).ok, false);
  assert.equal(checkListing(mk(bundle([{ ...w, toolGroups: ['read', 'shell'] }]))).ok, false);
  assert.equal(checkListing(mk(bundle([{ ...w, toolGroups: ['agent'] }]))).ok, false);
  assert.equal(checkListing(mk(bundle([{ ...w, toolGroups: ['launch_rockets'] }]))).ok, false);
  assert.equal(checkListing(mk({ kind: 'something-else', workers: [w] })).ok, false);
  assert.equal(checkListing(mk(bundle([]))).ok, false);
});

test('V3.3 wiring: Get more offers Worker and Hire; Workers that stay has the weekly report card', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /<option value="worker">Worker<\/option>/);
  const market = readFileSync(join(ROOT, 'web', 'market.js'), 'utf8');
  assert.match(market, /t\('Review and hire'\)/);
  assert.match(market, /t\('Hire'\)/);
  const workers = readFileSync(join(ROOT, 'web', 'workers.js'), 'utf8');
  assert.match(workers, /'\/workers\/report'/);
  assert.match(workers, /t\('Weekly report'\)/);
  assert.match(workers, /t\('Find workers to hire'\)/);
  assert.match(readFileSync(join(ROOT, 'src', 'destinations.ts'), 'utf8'), /id: 'workforce'/);
});
