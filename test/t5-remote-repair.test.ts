// ROADMAP_T T5 (docs/REMOTE_REPAIR.md): remote repair between linked servers. The helped owner asks a
// linked friend to fix something; the friend accepts; a signed 'repair' pass (separate from the S9b
// 'support' pass) lets the friend's Sara look (the support report + this server's T1 problems) and send a
// plan made only of actions this server's own engines accept. The helped server checks every step itself
// and runs it through T1/T3 with its own approvals, snapshots and undo. Live status both ways, Stop on both.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { AuditTrail, auditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { Log } from '../src/log.ts';
import { Messenger } from '../src/messages.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { remoteRepairOf, REPAIR_SCOPES } from '../src/remote-repair.ts';
import { Repair, type RepairEnv } from '../src/repair.ts';
import { setSelfCode } from '../src/self-code.ts';
import { createSaraServer } from '../src/server.ts';
import { signSupport } from '../src/support.ts';
import { createRemoteRepairTools } from '../src/tools/remote-repair.ts';
import { makeApp, ROOT, tempDir, type TestApp } from './helpers.ts';

type Node = {
  app: TestApp;
  m: Messenger;
  base: string;
  req: (method: string, path: string, body?: unknown) => Promise<any>;
  raw: (method: string, path: string, body?: unknown) => Promise<Response>;
  dir: string;
  fx: ReturnType<typeof fakeRepair>;
  code: string[];
};
const clock = { now: new Date('2026-11-16T12:00:00Z') };
const tick = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));

/** A T1 engine over a fake world: one crashed add-on (fixable, undoable), one repeated tool failure (level 2). */
function fakeRepair(app: TestApp) {
  const st = { addons: [{ id: 'weather', name: 'Weather', version: '1.0.0', status: 'crashed', enabled: true }], gate: null as Promise<void> | null, skills: new Map<string, string>(), toolErrors: [1, 2, 3].map((i) => ({ at: new Date(clock.now.getTime() - i * 60_000).toISOString(), tool: 'web_fetch' })) };
  const env: RepairEnv = {
    now: () => clock.now,
    settings: { get: () => app.settings.get() as never, update: (p) => app.settings.update(p as never) },
    audit: () => {},
    health: () => [{ name: 'Memory', ok: true, detail: 'ok' }],
    history: () => ({ turns: 10, failed: 0 }),
    turnErrors: () => [],
    toolErrors: () => st.toolErrors,
    trouble: () => [],
    addons: {
      list: () => st.addons,
      restart: async () => {
        if (st.gate) await st.gate;
      },
      setEnabled: async (id, on) => {
        const a = st.addons.find((x) => x.id === id)!;
        a.enabled = on;
        a.status = on ? 'crashed' : 'stopped';
      },
    },
    grow: { skill: (d) => (st.skills.set(d.name, d.body), { name: d.name, scope: 'companion' }), removeSkill: (_s, n) => void st.skills.delete(n) },
  };
  return { env, st, rep: new Repair(env, new DatabaseSync(':memory:')) };
}

async function node(t: TestContext, name: string, opts: { member?: boolean; child?: boolean } = {}): Promise<Node> {
  const tmp = tempDir();
  const app = makeApp(tmp.dir, clock);
  app.settings.update({ providers: [{ id: 'fake', kind: 'openai-compatible', label: 'Fake', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'small-1', needsKey: false }] as never, defaultProviderId: 'fake', defaultModel: 'small-1', fallbackAfterSec: 60 });
  const m = new Messenger({ dataDir: tmp.dir, vault: app.vault, now: () => clock.now, fetch: (u, i) => fetch(u, i), name: () => name });
  if (!opts.member) app.messages = m;
  const fx = fakeRepair(app);
  if (!opts.member) app.repair = fx.rep;
  // T3: a fake self-code that records what it was asked to prepare (the helped server's own model would run).
  const code: string[] = [];
  if (!opts.member) setSelfCode(app, { status: () => ({ available: true }), start: (request: string) => (code.push(request), { id: code.length, status: 'working', request }) } as never);
  const auth = new OwnerAuth(tmp.dir, () => clock.now);
  const tok = auth.newToken!;
  const record = () => ({ id: 'mem0000001', name: 'Mo', status: 'active', child: Boolean(opts.child), limits: { voice: false, pictures: false } });
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(opts.member ? { spaceId: 'mem0000001', member: { record: () => record() as never, apps: () => [app], deleteSelf: async () => {} } } : {}) });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const raw = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, origin: base, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const req = async (method: string, path: string, body?: unknown) => {
    const r = await raw(method, path, body);
    const j = (await r.json()) as Record<string, unknown>;
    if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${String(j.error)}`);
    return j;
  };
  t.after(async () => {
    await remoteRepairOf(app)?.idle();
    await new Promise<void>((ok) => srv.close(() => ok()));
    m.close();
    app.store.close();
    tmp.cleanup();
  });
  return { app, m, base, req, raw, dir: tmp.dir, fx, code };
}

async function link(a: Node, b: Node): Promise<{ aLink: string; bLink: string }> {
  const { code } = await a.req('POST', '/api/messages/invite', { url: a.base });
  const joined = await b.req('POST', '/api/messages/join', { code, url: b.base });
  return { aLink: a.m.links()[0]!.id, bLink: joined.chat.linkId };
}

/** Hank asks Sam; Sam accepts. Returns the pass ids on both sides. */
async function fixPass(a: Node, b: Node, aLink: string, scope: string, hours = 24) {
  const r = await a.req('POST', '/api/remote-repair/requests', { link: aLink, problem: "I can't get the weather add-on working", hours, scope });
  const held = (await b.req('GET', '/api/remote-repair')).held.find((p: any) => p.status === 'asked');
  assert.ok(held, 'the helper sees the request');
  await b.req('POST', `/api/remote-repair/passes/${held.id}/accept`, { accept: true });
  return { given: r.pass.id as string, held: held.id as string };
}

async function until<T>(f: () => Promise<T | undefined | false>, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = await f();
    if (v) return v;
    await new Promise((ok) => setTimeout(ok, 15));
  }
  throw new Error(`timed out: ${what}`);
}
const helpedPlan = async (a: Node) => (await a.req('GET', '/api/remote-repair')).plans.find((p: any) => p.side === 'in');
const settled = (p: any) => p && ['done', 'stopped', 'failed'].includes(p.status);

test('T5: request → approval card → helper notice → accept → a repair pass listed on both sides; decline and revoke', async (t) => {
  assert.deepEqual([...REPAIR_SCOPES], ['look', 'each', 'pass']);
  const a = await node(t, 'Hank');
  const b = await node(t, 'Sam');
  const { aLink, bLink } = await link(a, b);
  const notices: string[] = [];
  b.m.onNotify = (title, body) => notices.push(`${title}: ${body}`);
  // Only the three durations and the three scopes.
  assert.equal((await a.raw('POST', '/api/remote-repair/requests', { link: aLink, problem: 'x', hours: 5, scope: 'each' })).status, 400);
  assert.equal((await a.raw('POST', '/api/remote-repair/requests', { link: aLink, problem: 'x', hours: 1, scope: 'root' })).status, 400);
  // The chat tool only drafts the card: nothing is sent until the owner picks the length and scope.
  const [ask] = createRemoteRepairTools(() => a.app);
  assert.equal(ask!.spec.name, 'remote_help_request');
  const said = await ask!.run({ name: 'Sam', problem: "I can't get the weather add-on working" }, { signal: new AbortController().signal } as never);
  assert.match(said, /card/i);
  const draft = (await a.req('GET', '/api/remote-repair')).given.find((p: any) => p.status === 'draft');
  assert.ok(draft, 'a draft card on the helped side');
  assert.equal((await b.req('GET', '/api/remote-repair')).held.length, 0, 'the helper sees nothing yet');
  const sent = await a.req('POST', '/api/remote-repair/requests', { draft: draft.id, link: aLink, problem: draft.problem, hours: 1, scope: 'each' });
  assert.equal(sent.pass.status, 'asked');
  const bv = await b.req('GET', '/api/remote-repair');
  assert.equal(bv.held[0].status, 'asked');
  assert.equal(bv.held[0].scope, 'each');
  assert.match(bv.held[0].problem, /weather/);
  assert.ok(notices.some((n) => /Hank/.test(n) && /fix/i.test(n)), 'the helper gets a prominent notice (popup + push)');
  // Not usable before it is accepted.
  assert.equal((await b.raw('POST', '/api/remote-repair/look', { link: bLink })).status, 403);
  // Decline: the helped side sees it.
  await b.req('POST', `/api/remote-repair/passes/${bv.held[0].id}/accept`, { accept: false });
  assert.equal((await a.req('GET', '/api/remote-repair')).given.find((p: any) => p.id === sent.pass.id).status, 'declined');
  // A new request, accepted: active on both sides with the same expiry.
  const { given } = await fixPass(a, b, aLink, 'each', 168);
  const av = (await a.req('GET', '/api/remote-repair')).given.find((p: any) => p.id === given);
  const hv = (await b.req('GET', '/api/remote-repair')).held.find((p: any) => p.active);
  assert.equal(av.status, 'active');
  assert.equal(av.active, true);
  assert.equal(hv.expiresAt, av.expiresAt);
  assert.equal(Date.parse(av.expiresAt) - clock.now.getTime(), 168 * 3_600_000);
  // The S9b support pass is separate: none was given.
  assert.equal((await a.req('GET', '/api/support')).given.length, 0);
  // Revoke: the helper is told; looks are refused.
  await a.req('DELETE', `/api/remote-repair/passes/${given}`);
  assert.equal((await b.req('GET', '/api/remote-repair')).held.filter((p: any) => p.active).length, 0);
  assert.equal((await b.raw('POST', '/api/remote-repair/look', { link: bLink })).status, 403);
  // Help log and audit rows on both sides.
  for (const v of [await a.req('GET', '/api/support'), await b.req('GET', '/api/support')]) assert.ok(v.log.some((r: any) => r.kind === 'repair-request') && v.log.some((r: any) => r.kind === 'repair-accept'));
  const rows = auditTrail()?.list({ limit: 500 }) ?? [];
  assert.ok(rows.some((r) => r.action === 'remote-repair.request'));
  assert.ok(rows.some((r) => r.action === 'remote-repair.accept'));
});

test('T5: the repair scope is separate from support (signatures and passes), and the look adds the T1 problems with the S9b redaction unchanged', async (t) => {
  const a = await node(t, 'Hank');
  const b = await node(t, 'Sam');
  const { aLink, bLink } = await link(a, b);
  const key = b.m.privateKeyFor(bLink)!;
  const post = (path: string, body: string, headers: Record<string, string>) => fetch(a.base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  // A support pass does not open repair looks, and a repair pass does not open support looks.
  await a.req('POST', '/api/support/passes', { link: aLink, hours: 1 });
  assert.equal((await b.raw('POST', '/api/remote-repair/look', { link: bLink })).status, 403);
  const sp = (await a.req('GET', '/api/support')).given[0];
  await a.req('DELETE', `/api/support/passes/${sp.id}`);
  await fixPass(a, b, aLink, 'pass');
  assert.equal((await b.raw('POST', '/api/support/look', { link: bLink })).status, 403);
  // Signatures: the scope word is signed. A support signature never passes on /msg/v1/repair and back.
  const b1 = JSON.stringify({ v: 1, id: randomUUID() });
  assert.equal((await post('/msg/v1/repair/look', b1, signSupport(bLink, 'look', b1, key, clock.now))).status, 401);
  const b2 = JSON.stringify({ v: 1, id: randomUUID() });
  assert.equal((await post('/msg/v1/repair/look', b2, signSupport(bLink, 'look', b2, key, clock.now, 'repair'))).status, 200);
  const b3 = JSON.stringify({ v: 1, id: randomUUID() });
  assert.equal((await post('/msg/v1/support/look', b3, signSupport(bLink, 'look', b3, key, clock.now, 'repair'))).status, 401);
  assert.equal((await post('/msg/v1/repair/look', b2, signSupport(bLink, 'look', b2, key, clock.now, 'repair'))).status, 409, 'replay');
  // Redaction: the same seeds as S9b never leave.
  const email = `hank.${randomUUID().slice(0, 6)}@example.org`;
  const words = ['violet', 'otter', 'pineapple', 'lantern', String(Date.now() % 10_000)];
  const conv = a.app.store.createConversation({ title: 'Chat' });
  a.app.store.addMessage(conv.id, 'user', `remember ${words.join(' ')} please`);
  const log = new Log(a.dir, (s) => a.app.redactor.redact(s), () => clock.now);
  a.app.log = log;
  log.write('warn', `mail sync failed for ${email}`);
  log.write('info', `user said ${words.join(' ')}`);
  log.write('warn', 'my insulin dosage is 12 mg');
  const look = await b.req('POST', '/api/remote-repair/look', { link: bLink });
  const out = JSON.stringify(look);
  for (const bad of [email, words.slice(0, 4).join(' '), 'insulin', a.dir, a.dir.replace(/\\/g, '/')]) assert.ok(!out.includes(bad), `leaked: ${bad}`);
  for (const k of ['version', 'health', 'log', 'settings']) assert.ok(k in look.report, `report has ${k}`);
  const ids = look.problems.map((p: any) => p.id).sort();
  assert.deepEqual(ids, ['addon:weather', 'grow:tool:web_fetch']);
  assert.equal(look.can.code, true);
  assert.ok(look.can.settings.includes('fallbackAfterSec'));
});

test('T5: plan validation rejects anything the helped engines do not accept (whole plan, nothing stored)', async (t) => {
  const a = await node(t, 'Hank');
  const b = await node(t, 'Sam');
  const { aLink, bLink } = await link(a, b);
  await fixPass(a, b, aLink, 'pass');
  const bad = [
    [{ kind: 'shell', command: 'rm -rf /' }],
    [{ kind: 'file', path: 'C:/x', text: 'y' }],
    [{ kind: 'computer', action: 'click' }],
    [{ kind: 'vault', key: 'x' }],
    [{ kind: 'setting', path: 'toolPermissions', value: {} }],
    [{ kind: 'setting', path: 'safety.on', value: false }],
    [{ kind: 'setting', path: 'fallbackAfterSec', value: 5 }],
    [{ kind: 'fix', problem: 'addon:nope' }],
    [{ kind: 'fix', problem: 'setting:repair.permission' }],
    [{ kind: 'fix', problem: 'addon:weather' }, { kind: 'code', request: '' }],
    [],
  ];
  for (const steps of bad) {
    const r = await b.raw('POST', '/api/remote-repair/plans', { link: bLink, steps });
    assert.equal(r.status, 400, JSON.stringify(steps));
  }
  assert.equal((await a.req('GET', '/api/remote-repair')).plans.length, 0, 'nothing reached the helped owner');
  // Without T3 on the helped install, a code step is refused too.
  setSelfCode(a.app, undefined);
  assert.equal((await b.raw('POST', '/api/remote-repair/plans', { link: bLink, steps: [{ kind: 'code', request: 'make the weather add-on retry' }] })).status, 400);
  // A look-only pass can't carry a plan.
  const g = (await a.req('GET', '/api/remote-repair')).given.find((p: any) => p.active);
  await a.req('DELETE', `/api/remote-repair/passes/${g.id}`);
  await fixPass(a, b, aLink, 'look');
  assert.equal((await b.raw('POST', '/api/remote-repair/look', { link: bLink })).status, 200);
  assert.equal((await b.raw('POST', '/api/remote-repair/plans', { link: bLink, steps: [{ kind: 'fix', problem: 'addon:weather' }] })).status, 403);
});

test('T5: "fix with my approval each time" asks per step; runs through T1 with snapshots, rows by the helper, undo; status reaches the helper', async (t) => {
  const a = await node(t, 'Hank');
  const b = await node(t, 'Sam');
  const { aLink, bLink } = await link(a, b);
  const aNotices: string[] = [];
  a.m.onNotify = (title, body) => aNotices.push(`${title}: ${body}`);
  const bNotices: string[] = [];
  b.m.onNotify = (title, body) => bNotices.push(`${title}: ${body}`);
  await fixPass(a, b, aLink, 'each');
  const sent = await b.req('POST', '/api/remote-repair/plans', { link: bLink, note: 'restart the add-on, then wait longer', steps: [{ kind: 'fix', problem: 'addon:weather' }, { kind: 'setting', path: 'fallbackAfterSec', value: 120 }] });
  assert.ok(aNotices.some((n) => /Sam/.test(n)), 'the helped owner is told about the plan');
  let p = await helpedPlan(a);
  assert.equal(p.status, 'waiting');
  assert.deepEqual(p.steps.map((s: any) => s.status), ['waiting', 'waiting']);
  // Plan-level approval is not how this scope works.
  assert.equal((await a.raw('POST', `/api/remote-repair/plans/${p.id}/approve`, { approve: true })).status, 409);
  // Step 1 OK: it runs, step 2 still waits.
  await a.req('POST', `/api/remote-repair/plans/${p.id}/steps/0`, { approve: true });
  p = await until(async () => {
    const x = await helpedPlan(a);
    return x.steps[0].status === 'done' && x;
  }, 'step 1');
  assert.equal(p.steps[1].status, 'waiting');
  assert.equal(a.app.settings.get().fallbackAfterSec, 60, 'nothing changed without its own OK');
  // Step 2 declined: the plan ends; the setting never changed.
  await a.req('POST', `/api/remote-repair/plans/${p.id}/steps/1`, { approve: false });
  p = await until(async () => settled(await helpedPlan(a)) && helpedPlan(a), 'plan end');
  assert.equal(p.status, 'done');
  assert.equal(p.steps[1].status, 'declined');
  assert.equal(a.app.settings.get().fallbackAfterSec, 60);
  assert.ok(p.report && /Sam/.test(p.report), 'a final report in plain words');
  // The T1 log row is marked with the helper's name; Undo puts it back.
  const run = a.fx.rep.runs().find((r) => r.problem === 'addon:weather')!;
  assert.equal(run.by, 'link:Sam');
  assert.equal(run.undoable, true);
  await a.req('POST', `/api/remote-repair/plans/${p.id}/steps/0/undo`);
  assert.equal(a.fx.st.addons[0]!.enabled, true, 'undo turned the add-on back on');
  // The helper saw the progress and the report (signed status events) and got a notice.
  const out = await until(async () => {
    const x = (await b.req('GET', '/api/remote-repair')).plans.find((q: any) => q.id === sent.plan.id);
    return settled(x) && x;
  }, 'helper status');
  assert.deepEqual(out.steps.map((s: any) => s.status), ['done', 'declined']);
  assert.ok(out.report);
  assert.ok(bNotices.some((n) => /Hank/.test(n)), 'the helper is told the plan finished');
  const rows = auditTrail()?.list({ limit: 1000 }) ?? [];
  assert.ok(rows.some((r) => r.action === 'remote-repair.plan'));
  assert.ok(rows.some((r) => r.action === 'remote-repair.step'));
});

test('T5: "within this pass" needs one plan OK, but a code change (level 3) always asks; the helped server prepares it itself', async (t) => {
  const a = await node(t, 'Hank');
  const b = await node(t, 'Sam');
  const { aLink, bLink } = await link(a, b);
  await fixPass(a, b, aLink, 'pass');
  const text = 'make the weather add-on retry twice before it gives up';
  await b.req('POST', '/api/remote-repair/plans', { link: bLink, steps: [{ kind: 'setting', path: 'fallbackAfterSec', value: 90 }, { kind: 'fix', problem: 'grow:tool:web_fetch' }, { kind: 'code', request: text }] });
  let p = await helpedPlan(a);
  assert.equal(p.status, 'waiting');
  assert.deepEqual(p.steps.map((s: any) => s.status), ['ready', 'ready', 'waiting']);
  assert.equal(a.app.settings.get().fallbackAfterSec, 60, 'nothing runs before the plan OK');
  await a.req('POST', `/api/remote-repair/plans/${p.id}/approve`, { approve: true });
  p = await until(async () => {
    const x = await helpedPlan(a);
    return x.steps[1].status === 'done' && x.status === 'waiting' && x;
  }, 'two steps');
  assert.equal(a.app.settings.get().fallbackAfterSec, 90);
  assert.equal(p.steps[2].status, 'waiting', 'the code change waits for its own OK');
  assert.equal(p.status, 'waiting');
  assert.equal(a.code.length, 0);
  assert.ok(a.fx.st.skills.size === 1, 'level 2: a skill on trial');
  await a.req('POST', `/api/remote-repair/plans/${p.id}/steps/2`, { approve: true });
  p = await until(async () => settled(await helpedPlan(a)) && helpedPlan(a), 'done');
  assert.deepEqual(a.code, [text], 'only the request text crossed; the helped server prepares it');
  assert.equal(p.steps[2].status, 'done');
  // The setting step is a T1 row by the helper with an undo.
  const run = a.fx.rep.runs().find((r) => r.problem === 'setting:fallbackAfterSec')!;
  assert.equal(run.by, 'link:Sam');
  await a.req('POST', `/api/remote-repair/plans/${p.id}/steps/0/undo`);
  assert.equal(a.app.settings.get().fallbackAfterSec, 60);
});

test('T5: Stop (either side) ends after the current step and undoes nothing; expiry and revoke mid-plan stop it too', async (t) => {
  const a = await node(t, 'Hank');
  const b = await node(t, 'Sam');
  const { aLink, bLink } = await link(a, b);
  await fixPass(a, b, aLink, 'pass');
  // Step 1 hangs until we let it go; Stop from the helper side meanwhile.
  let release!: () => void;
  a.fx.st.gate = new Promise<void>((ok) => (release = ok));
  const sent = await b.req('POST', '/api/remote-repair/plans', { link: bLink, steps: [{ kind: 'fix', problem: 'addon:weather' }, { kind: 'setting', path: 'fallbackAfterSec', value: 300 }] });
  const p0 = await helpedPlan(a);
  await a.req('POST', `/api/remote-repair/plans/${p0.id}/approve`, { approve: true });
  await until(async () => (await helpedPlan(a)).steps[0].status === 'running', 'running');
  await b.req('POST', `/api/remote-repair/plans/${sent.plan.id}/stop`);
  release();
  let p = await until(async () => settled(await helpedPlan(a)) && helpedPlan(a), 'stopped');
  assert.equal(p.status, 'stopped');
  assert.equal(p.steps[0].status, 'done', 'the current step finished');
  assert.equal(p.steps[1].status, 'skipped');
  assert.equal(a.app.settings.get().fallbackAfterSec, 60);
  assert.equal(a.fx.st.addons[0]!.enabled, false, 'nothing undone silently');
  assert.equal(p.steps[0].undoable, true, 'Undo is offered');
  // Revoke mid-plan ("each" scope): the next step is refused.
  a.fx.st.gate = null;
  a.fx.st.addons[0]!.status = 'crashed';
  a.fx.st.addons[0]!.enabled = true;
  let g = (await a.req('GET', '/api/remote-repair')).given.find((x: any) => x.active);
  await a.req('DELETE', `/api/remote-repair/passes/${g.id}`);
  await fixPass(a, b, aLink, 'each', 1);
  await b.req('POST', '/api/remote-repair/plans', { link: bLink, steps: [{ kind: 'setting', path: 'fallbackAfterSec', value: 200 }, { kind: 'setting', path: 'memoryTidy.on', value: true }] });
  const pl = (await a.req('GET', '/api/remote-repair')).plans.find((x: any) => x.side === 'in' && x.status === 'waiting');
  await a.req('POST', `/api/remote-repair/plans/${pl.id}/steps/0`, { approve: true });
  await until(async () => (await a.req('GET', '/api/remote-repair')).plans.find((x: any) => x.id === pl.id).steps[0].status === 'done', 'first');
  // The 1-hour pass runs out before the next OK.
  tick(3_600_000 + 1000);
  const r = await a.raw('POST', `/api/remote-repair/plans/${pl.id}/steps/1`, { approve: true });
  assert.equal(r.status, 409);
  p = (await a.req('GET', '/api/remote-repair')).plans.find((x: any) => x.id === pl.id);
  assert.equal(p.status, 'stopped');
  assert.equal(p.steps[1].status, 'skipped');
  assert.notEqual(a.app.settings.get().memoryTidy?.on, true);
  assert.equal(a.app.settings.get().fallbackAfterSec, 200);
  // Stop from the helped side, before anything ran.
  g = (await a.req('GET', '/api/remote-repair')).given.find((x: any) => x.active);
  assert.equal(g, undefined);
  await fixPass(a, b, aLink, 'each');
  await b.req('POST', '/api/remote-repair/plans', { link: bLink, steps: [{ kind: 'setting', path: 'memoryTidy.on', value: true }] });
  const p3 = (await a.req('GET', '/api/remote-repair')).plans.find((x: any) => x.side === 'in' && x.status === 'waiting');
  await a.req('POST', `/api/remote-repair/plans/${p3.id}/stop`);
  assert.equal((await a.raw('POST', `/api/remote-repair/plans/${p3.id}/steps/0`, { approve: true })).status, 409);
  assert.notEqual(a.app.settings.get().memoryTidy?.on, true);
});

test('T5: household members and kid mode are refused both sides; private local mode refuses repair passes', async (t) => {
  for (const child of [false, true]) {
    const mem = await node(t, 'Mo', { member: true, child });
    for (const [method, path] of [['GET', '/api/remote-repair'], ['POST', '/api/remote-repair/requests'], ['POST', '/api/remote-repair/look'], ['POST', '/api/remote-repair/plans']] as const) {
      const r = await mem.raw(method, path, method === 'GET' ? undefined : { link: 'x', hours: 1, scope: 'each', problem: 'x' });
      assert.equal(r.status, 403, `${method} ${path}`);
    }
    const peer = await fetch(`${mem.base}/msg/v1/repair/look`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(peer.status, 404);
    assert.equal(createRemoteRepairTools(() => mem.app).every((x) => x.isAvailable!() === false), true);
    assert.equal(remoteRepairOf(mem.app), undefined);
  }
  const a = await node(t, 'Hank');
  const b = await node(t, 'Sam');
  const { aLink, bLink } = await link(a, b);
  await fixPass(a, b, aLink, 'each');
  setPrivateLocal(true);
  try {
    const r = await a.raw('POST', '/api/remote-repair/requests', { link: aLink, problem: 'x', hours: 1, scope: 'each' });
    assert.equal(r.status, 409);
    assert.match(String(((await r.json()) as any).error), /private local/i);
    // An existing pass is not honored while private local mode is on.
    assert.equal((await b.raw('POST', '/api/remote-repair/look', { link: bLink })).status, 403);
  } finally {
    setPrivateLocal(false);
  }
});

test('T5: the helper tools: remote_look asks once per pass, remote_fix_plan always asks and checks the step kinds', async (t) => {
  const a = await node(t, 'Hank');
  const b = await node(t, 'Sam');
  const { aLink } = await link(a, b);
  const tools = createRemoteRepairTools(() => b.app);
  const look = tools.find((x) => x.spec.name === 'remote_look')!;
  const plan = tools.find((x) => x.spec.name === 'remote_fix_plan')!;
  assert.equal(look.isAvailable!(), false);
  await fixPass(a, b, aLink, 'each');
  assert.equal(look.isAvailable!(), true);
  const signal = new AbortController().signal;
  assert.notEqual((await look.prepare!({ name: 'Hank' }, { signal })).auto, true);
  const text = await look.run({ name: 'Hank' }, { signal } as never);
  assert.match(text, /addon:weather/);
  assert.equal((await look.prepare!({ name: 'Hank' }, { signal })).auto, true);
  assert.equal(plan.defaultPermission, 'ask');
  assert.ok((await plan.prepare!({ name: 'Hank', steps: [{ kind: 'shell', command: 'ls' }] }, { signal })).refuse);
  const pp = await plan.prepare!({ name: 'Hank', steps: [{ kind: 'fix', problem: 'addon:weather' }] }, { signal });
  assert.equal(pp.ask, true);
  const res = await plan.run({ name: 'Hank', steps: [{ kind: 'fix', problem: 'addon:weather' }] }, { signal } as never);
  assert.match(res, /Hank/);
  assert.ok(await helpedPlan(a));
});

test.before(() => {
  const d = tempDir();
  setAuditTrail(new AuditTrail(d.dir, { key: () => 'k', policyRev: () => 0 }));
});
