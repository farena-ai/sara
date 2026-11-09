// EC11: the share routes and the public read-only page (docs/ops/EC1115_DESIGN.md).
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { AuditTrail, auditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { memberRouteCheck } from '../src/household.ts';
import { policy, PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { createSaraServer } from '../src/server.ts';
import { setShares, shares, ShareStore } from '../src/share.ts';
import { makeApp, PNG, ROOT, tempDir } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-07T12:00:00Z') };
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
setAuditTrail(new AuditTrail(dir, { key: () => 'k', policyRev: () => policy().get().rev }));
setPolicy(new PolicyStore(dir));
setShares(new ShareStore(dir, () => clock.now));
let base = '';
let convId = '';
const KEY = `sk-proj-${'k'.repeat(30)}`;
before(async () => {
  app.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
  const c = app.store.createConversation({ title: 'Trip plans' });
  convId = c.id;
  const pic = app.uploads!.save(`data:image/png;base64,${PNG}`);
  app.store.addMessage(c.id, 'user', 'Plan a trip, my mail is alex@example.com <script>alert(1)</script>', { images: [pic.id] });
  app.store.addMessage(c.id, 'assistant', '', { toolCalls: [{ id: 't1', name: 'web_search', arguments: { q: 'x' } }] });
  app.store.addMessage(c.id, 'tool', `found it, key ${KEY}`, { name: 'web_search', toolCallId: 't1' });
  app.store.addMessage(c.id, 'assistant', 'Lisbon in May looks good.');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  shares()?.close();
  setShares(undefined);
  app.store.close();
  cleanup();
});
const req = (path: string, o: { method?: string; body?: unknown } = {}) =>
  fetch(base + path, { method: o.method ?? 'GET', headers: { authorization: `Bearer ${token}`, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
const settle = () => new Promise((r) => setTimeout(r, 30));
const create = async (body: Record<string, unknown> = {}) => {
  const r = await req('/api/shares', { method: 'POST', body: { conversationId: convId, expires: '1d', ...body } });
  return { status: r.status, body: await r.json() };
};
const tokenOf = (link: string) => link.split('/s/')[1];

test('EC11 routes: the preview is exactly what the link shows; tool output and pictures only when chosen', async () => {
  const p = await (await req(`/api/conversations/${convId}/share/preview`, { method: 'POST', body: {} })).json();
  assert.deepEqual(p.snapshot.messages.map((m: { role: string }) => m.role), ['user', 'assistant']);
  assert.equal(p.snapshot.hidden.tools, 1);
  assert.equal(p.snapshot.hidden.pictures, 1);
  assert.ok(p.snapshot.messages[0].text.includes('[email]'));
  const made = await create();
  assert.equal(made.status, 201);
  assert.match(made.body.link, new RegExp(`^${base}/s/[A-Za-z0-9_-]{43}$`));
  const page = await fetch(made.body.link);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('Lisbon in May looks good.'));
  assert.ok(html.includes('[email]') && !html.includes('alex@example.com'));
  assert.ok(!html.includes('<script>alert(1)'), 'escaped');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('found it'), 'no tool output unless chosen');
  assert.match(html, /written by an AI/i, 'the AI disclosure is on the page');
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.match(html, /<meta name="robots" content="noindex/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const full = await create({ tools: true, pictures: true });
  const fullHtml = await (await fetch(full.body.link)).text();
  assert.ok(fullHtml.includes('found it') && !fullHtml.includes(KEY), 'tool output scrubbed');
  const img = await fetch(`${full.body.link}/p/0`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${made.body.link}/p/0`)).status, 404, 'no pictures unless chosen');
});

test('EC11 routes: revoke ends access at once; list shows views; audit rows for create, first view and revoke', async () => {
  const n = auditTrail()!.list().length;
  const made = await create({ expires: '7d' });
  await fetch(made.body.link);
  await fetch(made.body.link);
  const list = (await (await req('/api/shares')).json()).shares;
  const row = list.find((s: { id: string }) => s.id === made.body.id);
  assert.equal(row.views, 2);
  assert.ok(!JSON.stringify(list).includes(tokenOf(made.body.link)), 'the list never holds the token');
  assert.equal((await req(`/api/shares/${made.body.id}`, { method: 'DELETE' })).status, 200);
  const gone = await fetch(made.body.link);
  assert.equal(gone.status, 404);
  assert.match(gone.headers.get('x-robots-tag') ?? '', /noindex/);
  await settle();
  const rows = auditTrail()!.list().slice(0, auditTrail()!.list().length - n).reverse();
  assert.deepEqual(rows.map((r) => r.action), ['share.create', 'share.view', 'share.revoke']);
  assert.equal(rows[2].target, `share:${made.body.id} views:2`);
  assert.ok(!JSON.stringify(rows).includes(tokenOf(made.body.link)), 'never the token');
});

test('EC11 routes: off-the-record, partner and private chats are refused; private only once allowed', async () => {
  const off = await (await req('/api/conversations', { method: 'POST', body: { offRecord: true } })).json();
  assert.equal((await create({ conversationId: off.id })).status, 409);
  const partner = app.store.createConversation({ title: 'Sam', partner: 'Sam', channel: 'telegram', channelKey: '9' });
  assert.equal((await create({ conversationId: partner.id })).status, 409);
  const priv = app.store.createConversation({ title: 'Mine', private: true });
  app.store.addMessage(priv.id, 'user', 'private words');
  const refused = await create({ conversationId: priv.id });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /private/i);
  assert.equal((await req('/api/shares/settings', { method: 'PUT', body: { allowPrivate: true } })).status, 200);
  assert.equal((await create({ conversationId: priv.id })).status, 201);
  await req('/api/shares/settings', { method: 'PUT', body: { allowPrivate: false } });
  assert.equal((await create({ expires: 'never' })).status, 400);
});

test('EC11 routes: deleting the conversation revokes its links; members reach their own links', async () => {
  const c = app.store.createConversation({ title: 'Short' });
  app.store.addMessage(c.id, 'user', 'hello');
  const made = await create({ conversationId: c.id });
  assert.equal((await fetch(made.body.link)).status, 200);
  assert.equal((await req(`/api/conversations/${c.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(made.body.link)).status, 404);
  assert.equal(memberRouteCheck({ status: 'active', limits: { voice: true, pictures: true } } as never, 'GET', ['shares']), undefined);
});

test('EC11 routes: the policy pin refuses new links and stops existing ones', async () => {
  const made = await create();
  policy().set({ name: 'Office', pins: { sharing: false } });
  assert.equal((await create()).status, 409);
  assert.equal((await fetch(made.body.link)).status, 404);
  policy().set({ name: 'Office', pins: {} });
  assert.equal((await fetch(made.body.link)).status, 200, 'back once the pin is gone (not expired)');
});

test('EC11 routes: wrong tokens are rate-limited per address', async () => {
  let last = 0;
  for (let i = 0; i < 22; i++) last = (await fetch(`${base}/s/${'A'.repeat(42)}${i % 10}`)).status;
  assert.equal(last, 429);
});
