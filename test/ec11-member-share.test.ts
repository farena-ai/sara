// EC11 follow-up (docs/ops/EC1115_DESIGN.md, "Household members"): members share their own chats
// with the same scrubbing, expiry and revoke rules; the owner can turn it off for members.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { AuditTrail, auditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { memberRouteCheck } from '../src/household.ts';
import { policy, PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { createSaraServer } from '../src/server.ts';
import { setShares, shares, ShareStore } from '../src/share.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
for (const d of ['owner', 'm1']) mkdirSync(join(dir, d), { recursive: true });
const clock = { now: new Date('2026-11-07T12:00:00Z') };
const app = makeApp(join(dir, 'owner'), clock);
const mApp = makeApp(join(dir, 'm1'), clock);
const auth = new OwnerAuth(join(dir, 'owner'), () => clock.now);
const mAuth = new OwnerAuth(join(dir, 'm1'), () => clock.now);
const token = auth.newToken!;
const mToken = mAuth.newToken!;
const record = { id: 'm1', name: 'Sam', status: 'active', createdAt: '', limits: { models: [], messagesPerDay: 0, costPerDay: 0, voice: true, pictures: true } };
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
const msrv = createSaraServer({ app: mApp, auth: mAuth, webDir: join(ROOT, 'web'), spaceId: 'm1', member: { record: () => record as never, apps: () => [mApp], deleteSelf: async () => {} } });
setAuditTrail(new AuditTrail(join(dir, 'owner'), { key: () => 'k', policyRev: () => 0 }));
setPolicy(new PolicyStore(join(dir, 'owner')));
setShares(new ShareStore(join(dir, 'owner'), () => clock.now));
let base = '';
let mbase = '';
let ownConv = '';
let memberConv = '';
let memberPrivate = '';
before(async () => {
  for (const a of [app, mApp]) a.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
  const o = app.store.createConversation({ title: 'Owner trip' });
  app.store.addMessage(o.id, 'user', 'owner text');
  ownConv = o.id;
  const m = mApp.store.createConversation({ title: 'Sam recipes' });
  mApp.store.addMessage(m.id, 'user', 'Soup please, write to sam@example.com');
  mApp.store.addMessage(m.id, 'assistant', 'Tomato soup it is.');
  memberConv = m.id;
  const p = mApp.store.createConversation({ title: 'Sam diary', private: true } as never);
  mApp.store.addMessage(p.id, 'user', 'secret diary');
  memberPrivate = p.id;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => msrv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mbase = `http://127.0.0.1:${(msrv.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  msrv.close();
  shares()?.close();
  setShares(undefined);
  app.store.close();
  mApp.store.close();
  cleanup();
});
const call = (b: string, tok: string, path: string, o: { method?: string; body?: unknown } = {}) =>
  fetch(b + path, { method: o.method ?? 'GET', headers: { authorization: `Bearer ${tok}`, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
const owner = (path: string, o: { method?: string; body?: unknown } = {}) => call(base, token, path, o);
const member = (path: string, o: { method?: string; body?: unknown } = {}) => call(mbase, mToken, path, o);
const memberCreate = async (body: Record<string, unknown> = {}) => {
  const r = await member('/api/shares', { method: 'POST', body: { conversationId: memberConv, expires: '1d', ...body } });
  return { status: r.status, body: await r.json() };
};
// Visitors open links on the owner's address (the one public front door).
const visit = (link: string) => fetch(base + '/s/' + link.split('/s/')[1]);

test('EC11 members: the household route check lets an active member reach their own links', () => {
  assert.equal(memberRouteCheck(record as never, 'GET', ['shares']), undefined);
  assert.equal(memberRouteCheck(record as never, 'POST', ['shares']), undefined);
  assert.equal(memberRouteCheck({ ...record, status: 'suspended' } as never, 'GET', ['shares'])?.status, 403);
});

test('EC11 members: a member previews and shares their own chat, scrubbed like the owner, and the link opens', async () => {
  const p = await (await member(`/api/conversations/${memberConv}/share/preview`, { method: 'POST', body: {} })).json();
  assert.ok(p.snapshot.messages[0].text.includes('[email]'));
  const n = auditTrail()!.list().length;
  const made = await memberCreate();
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const page = await visit(made.body.link);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Tomato soup it is\./);
  assert.doesNotMatch(html, /sam@example\.com/);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  const rows = auditTrail()!.list().slice(0, auditTrail()!.list().length - n);
  const row = rows.find((r) => r.action === 'share.create')!;
  assert.equal(row.who, 'member:m1');
  assert.ok(!JSON.stringify(rows).includes('Tomato'));
  // The same refusals: a private chat needs the owner's "Allow sharing private chats".
  assert.equal((await memberCreate({ conversationId: memberPrivate })).status, 409);
  assert.equal((await memberCreate({ expires: 'never' })).status, 400);
});

test('EC11 members: each side lists and revokes only its own links', async () => {
  const mine = await memberCreate();
  const o = await owner('/api/shares', { method: 'POST', body: { conversationId: ownConv, expires: '1d' } });
  assert.equal(o.status, 201);
  const ownerLink = await o.json();
  const mList = await (await member('/api/shares')).json();
  assert.ok(mList.shares.length >= 1);
  assert.ok(mList.shares.every((s: { space: string }) => s.space === 'm1'));
  const oList = await (await owner('/api/shares')).json();
  assert.ok(oList.shares.every((s: { space: string }) => s.space === 'owner'));
  assert.equal((await owner(`/api/shares/${mine.body.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await member(`/api/shares/${ownerLink.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await member(`/api/shares/${mine.body.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await visit(mine.body.link)).status, 404);
  // The owner sees how many links members have live (never their titles).
  const st = await (await owner('/api/shares/settings')).json();
  assert.equal(st.members, true);
  assert.equal(typeof st.memberLinks, 'number');
  assert.ok(st.memberLinks >= 1);
});

test('EC11 members: the owner turns member links off: no new links and existing ones stop; on again, they come back', async () => {
  const made = await memberCreate();
  const o = await (await owner('/api/shares', { method: 'POST', body: { conversationId: ownConv, expires: '1d' } })).json();
  assert.equal((await member('/api/shares/settings', { method: 'PUT', body: { members: false } })).status, 403);
  const n = auditTrail()!.list().length;
  assert.equal((await owner('/api/shares/settings', { method: 'PUT', body: { allowPrivate: false, members: false } })).status, 200);
  assert.ok(auditTrail()!.list().slice(0, auditTrail()!.list().length - n).some((r) => r.action === 'share.settings' && (r.keys ?? []).includes('members')));
  const refused = await memberCreate();
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /turned off/);
  assert.equal((await member(`/api/conversations/${memberConv}/share/preview`, { method: 'POST', body: {} })).status, 403);
  assert.equal((await member('/api/shares/settings')).status, 200);
  assert.equal((await visit(made.body.link)).status, 404);
  assert.equal((await visit(o.link)).status, 200, "the owner's links keep working");
  await owner('/api/shares/settings', { method: 'PUT', body: { allowPrivate: false, members: true } });
  assert.equal((await visit(made.body.link)).status, 200);
});

test('EC11 members: the policy pin stops member links too; deleting the member revokes all of them', async () => {
  const made = await memberCreate();
  policy().set({ name: 'Office', pins: { sharing: false } });
  assert.equal((await memberCreate()).status, 409);
  assert.equal((await visit(made.body.link)).status, 404);
  policy().set({ name: 'Office', pins: {} });
  assert.equal((await visit(made.body.link)).status, 200);
  assert.ok(shares()!.revokeSpace('m1') >= 1);
  assert.equal((await visit(made.body.link)).status, 404);
  assert.equal(shares()!.list('m1').length, 0);
});
