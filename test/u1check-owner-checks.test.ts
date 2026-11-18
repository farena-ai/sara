// U1.5 (docs/TRY_THESE.md): the guided owner checklist ("Try these"): the curated list, the
// results file, progress and new items, the report preview that is exactly what is sent through the
// existing hub ticket path (scrubbed, owner presses, off by default), the Markdown export and the
// owner-only routes.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OwnerAuth } from '../src/auth.ts';
import { HubState, pingBlocked, scrubText, TicketStore, type HubFacts, type HubSpace } from '../src/hub.ts';
import { CHECKS, CHECK_RELEASES, OwnerChecks, checksView, resultsMarkdown, resultsTicket } from '../src/owner-checks.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, readBody, ROOT, tempDir } from './helpers.ts';

const FACTS: HubFacts = { version: '3.18.2', channel: 'source', os: 'windows', arch: 'x64', lang: 'en', companions: 1, members: 0, bridges: [], features: [], model: 'local' };
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
const appJs = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');

test('U1.5.1 the curated list: ~30 short items from 3.15-3.18.2, 1-3 steps, a working deep link, what you should see', () => {
  assert.ok(CHECKS.length >= 28 && CHECKS.length <= 34, `${CHECKS.length} items`);
  assert.equal(new Set(CHECKS.map((c) => c.id)).size, CHECKS.length, 'unique ids');
  const views = /const VIEWS = \{([^\n]+)\};/.exec(appJs)?.[1] ?? '';
  for (const c of CHECKS) {
    assert.match(c.id, /^[a-z0-9-]+$/);
    assert.ok(CHECK_RELEASES.includes(c.release), `${c.id}: release ${c.release}`);
    assert.ok(c.title.length > 3 && c.title.length <= 60, `${c.id}: title length`);
    assert.ok(c.steps.length >= 1 && c.steps.length <= 3, `${c.id}: steps`);
    for (const s of c.steps) assert.ok(s.length <= 160, `${c.id}: step too long`);
    assert.ok(c.expect.length > 10 && c.expect.length <= 200, `${c.id}: expect`);
    assert.ok(Boolean(c.view) !== Boolean(c.ask), `${c.id}: exactly one of view/ask`);
    if (c.view) {
      const m = /^#view=(?:settings:([\w-]+)|([\w-]+))$/.exec(c.view);
      assert.ok(m, `${c.id}: view ${c.view}`);
      if (m[1]) assert.ok(html.includes(`data-page="${m[1]}"`), `${c.id}: no Settings page ${m[1]}`);
      else assert.match(views, new RegExp(`\\b${m[2]}: `), `${c.id}: no view ${m[2]}`);
    }
  }
  for (const r of CHECK_RELEASES) assert.ok(CHECKS.some((c) => c.release === r), `nothing from ${r}`);
  // The areas the roadmap names.
  const all = JSON.stringify(CHECKS).toLowerCase();
  for (const w of ['pick-an-answer', 'goal', 'research', 'anything in your life', 'community', 'sound human', 'record', 'needs attention', 'trip', 'template', 'tracked', 'sign', 'team', 'help pass', 'check now', 'alerts', 'adult mode', 'google', 'listed once', 'undo']) assert.ok(all.includes(w), `missing: ${w}`);
});

test('U1.5.2 results: saved per item, notes capped, progress "12 of 30", newest release first, new items after an update', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const s = new OwnerChecks(dir);
  assert.equal(s.get().sendOn, false, 'sending is off by default');
  s.mark(CHECKS[0].id, 'worked');
  s.mark(CHECKS[1].id, 'failed', 'x'.repeat(900));
  s.mark(CHECKS[2].id, 'skipped');
  assert.throws(() => s.mark('nope', 'worked'));
  assert.throws(() => s.mark(CHECKS[0].id, 'maybe' as never));
  const again = new OwnerChecks(dir);
  assert.equal(again.get().results[CHECKS[1].id].note.length, 500);
  let v = checksView(again);
  assert.equal(v.total, CHECKS.length);
  assert.equal(v.done, 3);
  assert.deepEqual(v.counts, { worked: 1, failed: 1, skipped: 1 });
  assert.deepEqual(v.groups.map((g) => g.release), [...CHECK_RELEASES].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })));
  assert.ok(v.items.every((i) => i.new), 'never seen: all new');
  again.seen(CHECKS.map((c) => c.id).slice(1));
  v = checksView(again);
  assert.deepEqual(v.items.filter((i) => i.new).map((i) => i.id), [CHECKS[0].id], 'an item added by an update shows as new');
  again.mark(CHECKS[0].id, null);
  assert.equal(checksView(again).done, 2, 'clearing a result');
});

test('U1.5.3 the report: a Markdown export and a ticket body, scrubbed, only answered items', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const s = new OwnerChecks(dir);
  const home = homedir();
  const fakeKey = ['sk', 'test', 'Q'.repeat(30)].join('-');
  s.mark(CHECKS[0].id, 'worked');
  s.mark(CHECKS[1].id, 'failed', `It said ${fakeKey} in ${join(home, 'secret-folder')}`);
  const md = resultsMarkdown(s, { version: '3.18.2' });
  assert.match(md, /^# Try these: results/m);
  assert.match(md, /2 of \d+ tried/);
  assert.ok(md.includes(CHECKS[1].title));
  assert.match(md, /Didn't work/);
  const scrub = (x: string) => scrubText(x, (y) => y.split(fakeKey).join('[REDACTED]'), { homes: [home] });
  const tk = resultsTicket(s, { version: '3.18.2', scrub });
  assert.equal(tk.kind, 'bug');
  assert.match(tk.title, /^Try these: 1 worked, 1 didn't work/);
  assert.ok(!tk.body.includes(fakeKey), 'keys scrubbed');
  assert.ok(!tk.body.includes(home), 'home folder scrubbed');
  assert.ok(!tk.body.includes(CHECKS[5].title), 'untried items are not sent');
});

async function fakeHub(t: TestContext) {
  const seen: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    if (req.url?.endsWith('/v1/tickets')) seen.push(JSON.parse(raw) as Record<string, unknown>);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ticket: 'SARA-15', token: 'c'.repeat(32) }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return { seen, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/sara/hub` };
}

async function serve(t: TestContext, o: { member?: boolean } = {}) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-17T12:00:00Z') });
  const hubSrv = await fakeHub(t);
  const state = new HubState(dir);
  state.update({ noticeShownAt: '2026-11-17T11:00:00Z' });
  const db = new DatabaseSync(join(dir, 'hub-test.db'));
  const hub: HubSpace = {
    state,
    base: hubSrv.base,
    member: o.member === true,
    demo: false,
    tickets: new TicketStore(db),
    facts: () => FACTS,
    blocked: () => pingBlocked({ on: false, noticeShown: true, base: hubSrv.base }),
    scrub: (s) => scrubText(s, (x) => app.redactor.redact(x), { homes: [homedir()], dirs: [dir] }),
  };
  app.hub = hub;
  const auth = new OwnerAuth(dir);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(o.member ? { member: { record: () => ({ id: 'm1', name: 'Kim', status: 'active', limits: { voice: false, pictures: false } }) } } : {}) } as never);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    app.store.close();
    cleanup();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, type, json: (type.includes('json') ? await res.json() : { text: await res.text() }) as Record<string, any> };
  };
  return { call, hubSrv, app };
}

test('U1.5.4 routes: list, mark, seen, preview = exactly what is sent, off by default, export', async (t) => {
  const { call, hubSrv } = await serve(t);
  let r = await call('GET', '/owner-checks');
  assert.equal(r.status, 200);
  assert.equal(r.json.total, CHECKS.length);
  assert.equal(r.json.sendOn, false);
  r = await call('PUT', `/owner-checks/${CHECKS[3].id}`, { result: 'failed', note: 'The card never showed' });
  assert.equal(r.status, 200);
  assert.equal(r.json.done, 1);
  assert.equal((await call('PUT', `/owner-checks/${CHECKS[3].id}`, { result: 'meh' })).status, 400);
  assert.equal((await call('PUT', '/owner-checks/not-a-check', { result: 'worked' })).status, 404);
  r = await call('POST', '/owner-checks/seen', { ids: [CHECKS[0].id] });
  assert.equal(r.json.items.find((i: { id: string }) => i.id === CHECKS[0].id).new, false);
  // Off by default: nothing goes until the owner turns it on and presses Send.
  assert.equal((await call('POST', '/owner-checks/send', {})).status, 409);
  assert.equal(hubSrv.seen.length, 0);
  assert.equal((await call('PUT', '/owner-checks', { sendOn: true })).json.sendOn, true);
  const preview = (await call('GET', '/owner-checks/preview')).json;
  assert.match(preview.title, /^Try these: 0 worked, 1 didn't work/);
  assert.match(preview.body, /The card never showed/);
  r = await call('POST', '/owner-checks/send', {});
  assert.equal(r.status, 201);
  assert.equal(r.json.ticket, 'SARA-15');
  assert.equal(hubSrv.seen.length, 1);
  assert.equal(hubSrv.seen[0].title, preview.title);
  assert.equal(hubSrv.seen[0].body, preview.body, 'the preview is exactly what was sent');
  assert.equal(hubSrv.seen[0].kind, 'bug');
  r = await call('GET', '/owner-checks');
  assert.ok(r.json.sentAt, 'when it was last sent');
  r = await call('GET', '/owner-checks/export');
  assert.match(r.type, /text\/markdown/);
  assert.match(r.json.text, /# Try these: results/);
});

test('U1.5.5 owner only: household members get 403; the page wiring is in place', async (t) => {
  const { call } = await serve(t, { member: true });
  assert.equal((await call('GET', '/owner-checks')).status, 403);
  assert.match(html, /<button id="help-try" type="button" class="pick-card" data-owner-only>/);
  assert.match(html, /<dialog id="try-these"/);
  assert.match(appJs, /\btry: \(\) => /, '#view=try opens it');
  const js = readFileSync(join(ROOT, 'web', 'owner-checks.js'), 'utf8');
  assert.match(js, /Ask \{name\} to fix it/);
  assert.match(js, /repair/i);
  // The one setting (sending results, off by default) has its ? tip before it.
  assert.match(html, /class="tip" data-tip="[^"]+">\?<\/button>\s*<input id="try-send-on" type="checkbox">/);
});
