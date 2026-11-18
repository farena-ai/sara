// U4.26 (docs/SHARED_PROJECTS.md): shared projects between linked friends. Two in-process servers linked
// over S9a: invite/accept, sync both ways, roles enforced on the RECEIVING side, offline catch-up, revoke
// and leave stop sync, file conflict copies, nothing outside the shared items ever leaves, the agent
// tool reads only inside the shared project, quiet notices by default, owner only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { sharedProjectsOf } from '../src/shared-projects.ts';
import { createSharedProjectTools } from '../src/tools/shared-projects.ts';
import { signSupport } from '../src/support.ts';
import { clock, linkPair, pairNode, until, type PairNode } from './helpers-repair-pair.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const sp = (n: PairNode) => sharedProjectsOf(n.app)!;
const b64 = (s: string) => Buffer.from(s).toString('base64');

async function world(t: import('node:test').TestContext, o: { role?: string; kinds?: string[] } = {}) {
  const hank = await pairNode(t, 'Hank');
  const sam = await pairNode(t, 'Sam');
  const { aLink, bLink } = await linkPair(hank, sam);
  const pl = hank.app.planner!;
  const pid = pl.projectId('Garden shed')!;
  pl.saveNote({ title: 'Wood list', body: 'Six planks', project: 'Garden shed' });
  pl.saveNote({ title: 'Hank private', body: 'not in the project' });
  pl.addTask({ title: 'Buy screws', project: 'Garden shed' });
  const { share } = await hank.req('POST', '/api/shared-projects', { project: pid, link: aLink, role: o.role ?? 'contributor', kinds: o.kinds ?? ['notes', 'tasks', 'files'] });
  const inv = await until(async () => (await sam.req('GET', '/api/shared-projects')).shares.find((s: any) => s.status === 'invited'), 'invite arrives');
  return { hank, sam, aLink, bLink, pid, share: share.id as string, inv };
}
async function accept(w: Awaited<ReturnType<typeof world>>) {
  const r = await w.sam.req('POST', `/api/shared-projects/${w.inv.id}/accept`, { accept: true });
  await sp(w.hank).flush();
  await sp(w.sam).flush();
  return r.share;
}
const items = async (n: PairNode, id: string) => (await n.req('GET', `/api/shared-projects/${id}`)).items as any[];

test('invite, accept, the chosen kinds sync to the friend; their own project appears', async (t) => {
  const w = await world(t);
  assert.equal(w.inv.name, 'Garden shed');
  assert.equal(w.inv.role, 'contributor');
  assert.equal(w.inv.from, 'Hank');
  const s = await accept(w);
  assert.equal(s.status, 'active');
  assert.ok(s.projectId, 'a project of her own on the guest side');
  assert.ok(w.sam.app.planner!.projects().some((p) => p.id === s.projectId && p.name === 'Garden shed'));
  const got = await until(async () => { const l = await items(w.sam, s.id); return l.length >= 2 && l; }, 'items arrive');
  assert.deepEqual(got.map((i) => `${i.kind}:${i.title}`).sort(), ['note:Wood list', 'task:Buy screws']);
  // Shared items stay in the shared space: Sam's own notes and tasks are untouched.
  assert.equal(w.sam.app.planner!.notes().length, 0);
  const host = (await w.hank.req('GET', '/api/shared-projects')).shares[0];
  assert.equal(host.members[0].status, 'active');
  assert.equal(host.members[0].name, 'Sam');
});

test('changes sync both ways (contributor) and the activity feed shows who did what', async (t) => {
  const w = await world(t);
  const s = await accept(w);
  const note = (await until(async () => (await items(w.sam, s.id)).find((i) => i.kind === 'note'), 'note')) as any;
  await w.sam.req('PATCH', `/api/shared-projects/${s.id}/items/${note.id}`, { body: 'Eight planks' });
  await sp(w.sam).flush();
  await until(async () => (await items(w.hank, w.share)).find((i) => i.id === note.id && i.body === 'Eight planks'), 'guest edit reaches host');
  await w.hank.req('POST', `/api/shared-projects/${w.share}/items`, { kind: 'task', title: 'Paint door' });
  await sp(w.hank).flush();
  await until(async () => (await items(w.sam, s.id)).find((i) => i.title === 'Paint door'), 'host edit reaches guest');
  const feed = (await w.hank.req('GET', `/api/shared-projects/${w.share}`)).activity as any[];
  assert.ok(feed.some((a) => a.who === 'Sam' && a.what === 'changed' && a.title === 'Wood list'), JSON.stringify(feed));
  assert.ok(feed.some((a) => a.who === 'Hank' && a.what === 'added' && a.title === 'Paint door'));
});

test('roles are enforced on the receiving side: a viewer’s signed edits are refused there', async (t) => {
  const w = await world(t, { role: 'viewer' });
  const s = await accept(w);
  // Their own page refuses first …
  const r = await w.sam.raw('POST', `/api/shared-projects/${s.id}/items`, { kind: 'note', title: 'Sneaky' });
  assert.equal(r.status, 403);
  // … and a hand-signed event straight to the host is refused by the host itself.
  const body = JSON.stringify({ v: 1, id: `ev-${Date.now()}`, share: w.share, events: [{ item: 'x1', kind: 'note', title: 'Sneaky', body: '', done: false, version: 1, base: 0, at: clock.now.toISOString(), by: 'Sam', deleted: false }] });
  const key = w.sam.m.privateKeyFor(w.bLink)!;
  const res = await fetch(`${w.hank.base}/msg/v1/sproj/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...signSupport(w.bLink, 'events', body, key, clock.now, 'sproj') }, body });
  assert.equal(res.status, 403);
  assert.ok(!(await items(w.hank, w.share)).some((i) => i.title === 'Sneaky'));
  // A contributor still can't add a kind the host did not share (chats are off by default).
  await w.hank.req('PATCH', `/api/shared-projects/${w.share}/members/${w.aLink}`, { role: 'contributor' });
  await sp(w.hank).flush();
  await until(async () => (await w.sam.req('GET', `/api/shared-projects/${s.id}`)).share.role === 'contributor', 'role reaches guest');
  const c = await w.sam.raw('POST', `/api/shared-projects/${s.id}/items`, { kind: 'chat', conversation: 'x' });
  assert.equal(c.status, 403);
});

test('offline catch-up: edits made while the friend is away arrive in order later', async (t) => {
  const w = await world(t);
  const s = await accept(w);
  sp(w.hank).hold = true; // the link is down
  for (const n of [1, 2, 3]) await w.hank.req('POST', `/api/shared-projects/${w.share}/items`, { kind: 'note', title: `Day ${n}`, body: String(n) });
  await sp(w.hank).flush();
  assert.ok(!(await items(w.sam, s.id)).some((i) => i.title.startsWith('Day')));
  sp(w.hank).hold = false;
  await sp(w.hank).due(clock.now); // the reminder tick retries
  const got = await until(async () => { const l = (await items(w.sam, s.id)).filter((i) => i.title.startsWith('Day')); return l.length === 3 && l; }, 'catch-up');
  assert.equal(got.length, 3);
});

test('files: last writer wins and the losing edit is kept as one conflict copy on both sides', async (t) => {
  const w = await world(t);
  const s = await accept(w);
  const f = await w.hank.req('POST', `/api/shared-projects/${w.share}/items`, { kind: 'file', title: 'plan.txt', file: { name: 'plan.txt', data: b64('v1') } });
  await sp(w.hank).flush();
  await until(async () => (await items(w.sam, s.id)).find((i) => i.id === f.item.id), 'file arrives');
  const got = await w.sam.raw('GET', `/api/shared-projects/${s.id}/items/${f.item.id}/file`);
  assert.equal(await got.text(), 'v1');
  // Both edit the same file while apart.
  sp(w.hank).hold = true;
  sp(w.sam).hold = true;
  await w.hank.req('PATCH', `/api/shared-projects/${w.share}/items/${f.item.id}`, { file: { name: 'plan.txt', data: b64('hank edit') } });
  await w.sam.req('PATCH', `/api/shared-projects/${s.id}/items/${f.item.id}`, { file: { name: 'plan.txt', data: b64('sam edit') } });
  sp(w.hank).hold = false;
  sp(w.sam).hold = false;
  for (let i = 0; i < 3; i++) {
    await sp(w.sam).flush();
    await sp(w.hank).flush();
  }
  const files = async (n: PairNode, id: string) => (await items(n, id)).filter((i) => i.kind === 'file').sort((a, b) => a.title.localeCompare(b.title));
  const hf = await until(async () => { const l = await files(w.hank, w.share); return l.length === 2 && l; }, 'host has 2 files');
  const sf = await until(async () => { const l = await files(w.sam, s.id); return l.length === 2 && l; }, 'guest has 2 files');
  assert.deepEqual(hf.map((i) => i.sha), sf.map((i) => i.sha), 'both sides agree');
  const shaOf = (x: string) => createHash('sha256').update(x).digest('hex');
  const main = hf.find((i) => i.id === f.item.id)!;
  const copy = hf.find((i) => i.id !== f.item.id)!;
  assert.match(copy.title, /conflict/);
  assert.deepEqual(new Set([main.sha, copy.sha]), new Set([shaOf('hank edit'), shaOf('sam edit')]));
});

test('remove stops sync; the friend keeps a read-only copy and their pushes are refused', async (t) => {
  const w = await world(t);
  const s = await accept(w);
  await w.hank.req('DELETE', `/api/shared-projects/${w.share}/members/${w.aLink}`);
  await until(async () => (await w.sam.req('GET', `/api/shared-projects/${s.id}`)).share.status === 'ended', 'guest told');
  await w.hank.req('POST', `/api/shared-projects/${w.share}/items`, { kind: 'note', title: 'After removal' });
  await sp(w.hank).flush();
  assert.ok(!(await items(w.sam, s.id)).some((i) => i.title === 'After removal'));
  assert.equal((await w.sam.raw('POST', `/api/shared-projects/${s.id}/items`, { kind: 'note', title: 'x' })).status, 409);
});

test('leave: the host stops sending and marks the friend as left', async (t) => {
  const w = await world(t);
  const s = await accept(w);
  await w.sam.req('POST', `/api/shared-projects/${s.id}/leave`, {});
  const m = await until(async () => (await w.hank.req('GET', '/api/shared-projects')).shares[0].members.find((x: any) => x.status === 'left'), 'left');
  assert.equal(m.name, 'Sam');
  await w.hank.req('POST', `/api/shared-projects/${w.share}/items`, { kind: 'note', title: 'After leaving' });
  await sp(w.hank).flush();
  assert.ok(!(await items(w.sam, s.id)).some((i) => i.title === 'After leaving'));
});

test('privacy: only shared items travel; private chats never; no peer op reads anything else', async (t) => {
  const w = await world(t, { kinds: ['notes', 'tasks', 'files', 'chats'] });
  const s = await accept(w);
  const priv = w.hank.app.store.createConversation({ title: 'Secret', private: true, projectId: w.pid });
  const r = await w.hank.raw('POST', `/api/shared-projects/${w.share}/items`, { kind: 'chat', conversation: priv.id });
  assert.equal(r.status, 400);
  const other = w.hank.app.store.createConversation({ title: 'Elsewhere' });
  assert.equal((await w.hank.raw('POST', `/api/shared-projects/${w.share}/items`, { kind: 'chat', conversation: other.id })).status, 400);
  const ok = w.hank.app.store.createConversation({ title: 'Shed chat', projectId: w.pid });
  w.hank.app.store.addMessage(ok.id, 'user', 'How many planks?');
  w.hank.app.store.addMessage(ok.id, 'assistant', 'Eight.');
  await w.hank.req('POST', `/api/shared-projects/${w.share}/items`, { kind: 'chat', conversation: ok.id });
  await sp(w.hank).flush();
  const got = await until(async () => (await items(w.sam, s.id)).find((i) => i.kind === 'chat'), 'chat arrives');
  assert.match(got.body, /Eight\./);
  // Everything that ever left Hank's server is in its outgoing log: nothing private is there.
  const log = JSON.stringify(sp(w.hank).outgoing(w.share));
  assert.ok(!log.includes('Hank private') && !log.includes('Secret'), 'no private note or chat');
  // There is no read/look op: the other side (or its agent) can only send data events.
  const body = JSON.stringify({ v: 1, id: 'look-1', share: w.share });
  const key = w.sam.m.privateKeyFor(w.bLink)!;
  for (const op of ['look', 'read', 'run']) {
    const res = await fetch(`${w.hank.base}/msg/v1/sproj/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signSupport(w.bLink, op, body, key, clock.now, 'sproj') }, body });
    assert.equal(res.status, 404, op);
  }
  // A message-scope or support-scope signature never passes here.
  const res = await fetch(`${w.hank.base}/msg/v1/sproj/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...signSupport(w.bLink, 'events', body, key, clock.now, 'support') }, body });
  assert.equal(res.status, 401);
});

test('her tool reads shared items only inside the shared project, never in private chats', async (t) => {
  const w = await world(t);
  const s = await accept(w);
  await until(async () => (await items(w.sam, s.id)).length >= 2, 'items');
  for (const x of createSharedProjectTools(() => w.sam.app)) w.sam.app.tools.add(x);
  const tool = w.sam.app.tools.get('shared_project_read');
  assert.ok(tool, 'tool registered');
  assert.ok(tool!.isAvailable?.() !== false);
  const ctx = (conversationId: string) => ({ conversationId, workspaceDir: w.sam.dir, signal: new AbortController().signal, sandbox: { kind: 'none' } }) as never;
  const inside = w.sam.app.store.createConversation({ title: 'Shed', projectId: s.projectId });
  const out = await tool!.run({}, ctx(inside.id));
  assert.match(out, /Wood list/);
  assert.match(out, /Buy screws/);
  const outside = w.sam.app.store.createConversation({ title: 'Other' });
  assert.match(await tool!.run({}, ctx(outside.id)), /only inside/i);
  const priv = w.sam.app.store.createConversation({ title: 'P', private: true, projectId: s.projectId });
  assert.match(await tool!.run({}, ctx(priv.id)), /only inside/i);
});

test('notices are quiet by default; "all" tells the owner once per batch', async (t) => {
  const w = await world(t);
  const s = await accept(w);
  const told: string[] = [];
  sp(w.sam).onNotice = (title, body) => told.push(`${title}: ${body}`);
  await w.hank.req('POST', `/api/shared-projects/${w.share}/items`, { kind: 'note', title: 'Quiet one' });
  await sp(w.hank).flush();
  await until(async () => (await items(w.sam, s.id)).find((i) => i.title === 'Quiet one'), 'arrives');
  assert.equal(told.length, 0);
  const list = (await w.sam.req('GET', '/api/shared-projects')).shares[0];
  assert.ok(list.unseen >= 1, 'counted, not shown');
  await w.sam.req('PATCH', `/api/shared-projects/${s.id}`, { notify: 'all' });
  await w.hank.req('POST', `/api/shared-projects/${w.share}/items`, { kind: 'note', title: 'Loud one' });
  await sp(w.hank).flush();
  await until(async () => told.length > 0 && told, 'told');
  assert.match(told[0]!, /Garden shed/);
  await w.sam.req('POST', `/api/shared-projects/${s.id}/seen`, {});
  assert.equal((await w.sam.req('GET', '/api/shared-projects')).shares[0].unseen, 0);
});

test('turning a kind off removes those items on both sides', async (t) => {
  const w = await world(t);
  const s = await accept(w);
  await until(async () => (await items(w.sam, s.id)).some((i) => i.kind === 'task'), 'task');
  await w.hank.req('PATCH', `/api/shared-projects/${w.share}`, { kinds: ['notes'] });
  await sp(w.hank).flush();
  await until(async () => !(await items(w.sam, s.id)).some((i) => i.kind === 'task'), 'tasks gone');
});

test('owner only: no Messenger (members, kid mode, demo) → 403 and no engine', async (t) => {
  const tmp = tempDir();
  const app = makeApp(tmp.dir, clock);
  t.after(() => (app.store.close(), tmp.cleanup()));
  assert.equal(sharedProjectsOf(app), undefined);
  const auth = new OwnerAuth(tmp.dir, () => clock.now);
  const tok = auth.newToken!;
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise<void>((ok) => srv.close(() => ok())));
  const base = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}`;
  const r = await fetch(`${base}/api/shared-projects`, { headers: { authorization: ['Bearer', tok].join(' ') } });
  assert.equal(r.status, 403);
});

test('wiring: peer endpoint mounted before /msg/v1/, tick, tool, docs', () => {
  const server = readFileSync(join(ROOT, 'src', 'server.ts'), 'utf8');
  assert.ok(server.indexOf("'/msg/v1/sproj/'") > 0 && server.indexOf("'/msg/v1/sproj/'") < server.indexOf("startsWith('/msg/v1/')) {"));
  assert.match(readFileSync(join(ROOT, 'src', 'reminders.ts'), 'utf8'), /sharedProjects/);
  assert.match(readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8'), /createSharedProjectTools/);
  assert.match(readFileSync(join(ROOT, 'docs', 'SHARED_PROJECTS.md'), 'utf8'), /last writer wins/i);
  // The project page (and every place after Money) must not sit inside another dialog: the U4-A merge
  // dropped Money's closing tags and hid them all.
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.equal((html.match(/<dialog\b/g) ?? []).length, (html.match(/<\/dialog>/g) ?? []).length, 'every <dialog> is closed');
  const money = html.slice(html.indexOf('<dialog id="money"'), html.indexOf('<dialog id="money"') + 20000);
  assert.ok(money.indexOf('</dialog>') < money.indexOf('<dialog', 10), 'Money closes before the next dialog');
});
