import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

async function fixture(extra: Record<string, unknown> = {}) {
  const temp = tempDir(); const app = makeApp(temp.dir, { now: new Date('2026-11-05T12:00:00Z') });
  app.settings.update({ ownerName: 'Alex' } as never);
  const web = app.store.createConversation({ title: 'Web story' });
  const dm = app.store.createConversation({ channel: 'discord', channelKey: 'alex-dm', title: 'DM story' });
  const auth = new OwnerAuth(temp.dir); const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...extra });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, method = 'GET', body?: unknown, authed = true) => {
    const r = await fetch(origin + '/api' + path, { method, headers: { ...(authed ? { authorization: `Bearer ${auth.newToken}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : undefined };
  };
  return { app, web, dm, call, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); app.store.close(); temp.cleanup(); } };
}

test('owner creates, links with audience confirmation, writes canon, retires, resets and deletes', async () => {
  const f = await fixture();
  try {
    const created = await f.call('/scenes', 'POST', { title: 'The Ember Road', premise: 'Caravan.' });
    assert.equal(created.status, 201); assert.equal(created.headers.get('cache-control'), 'no-store');
    const id = created.body.scene.id; let rev = created.body.scene.revision;
    const options = await f.call(`/scenes/${id}/seat-options`);
    assert.equal(options.status, 200);
    const webOption = options.body.options.find((o: any) => o.conversationId === f.web.id);
    assert.match(webOption.audience, /only you/i);
    assert.equal((await f.call(`/scenes/${id}/seats`, 'POST', { conversationId: f.web.id, expectedRevision: rev })).status, 400, 'confirmAudience is required');
    assert.equal((await f.call(`/scenes/${id}/seats`, 'POST', { conversationId: f.web.id, expectedRevision: rev, confirmAudience: false })).status, 400);
    const linked = await f.call(`/scenes/${id}/seats`, 'POST', { conversationId: f.web.id, expectedRevision: rev, confirmAudience: true });
    assert.equal(linked.status, 200); rev = linked.body.scene.revision;
    const typed = await f.call(`/scenes/${id}/canon`, 'POST', { expectedRevision: rev, key: 'inn', text: '<img src=x onerror=alert(1)>' });
    assert.equal(typed.status, 200); rev = typed.body.scene.revision;
    const stale = await f.call(`/scenes/${id}/canon`, 'POST', { expectedRevision: rev - 1, key: 'inn', text: 'Other' });
    assert.equal(stale.status, 409);
    const line = f.app.store.addMessage(f.web.id, 'user', 'The bridge is out.');
    const fromLine = await f.call(`/scenes/${id}/canon`, 'POST', { expectedRevision: rev, key: 'bridge', fromMessageId: line.id });
    assert.equal(fromLine.status, 200); assert.equal(fromLine.body.entry.text, 'The bridge is out.'); rev = fromLine.body.scene.revision;
    const detail = await f.call(`/scenes/${id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.canon.map((c: any) => c.key).sort(), ['bridge', 'inn']);
    assert.equal(detail.body.canon.find((c: any) => c.key === 'bridge').source.conversationId, f.web.id);
    assert.equal(detail.body.seats[0].conversationId, f.web.id);
    const list = await f.call('/scenes');
    assert.equal(list.body.enabled, true); assert.equal(list.body.scenes[0].seatCount, 1); assert.equal(list.body.scenes[0].canonCount, 2);
    const retired = await f.call(`/scenes/${id}/canon/inn`, 'DELETE', { expectedRevision: rev });
    assert.equal(retired.status, 200); rev = retired.body.scene.revision;
    const patched = await f.call(`/scenes/${id}`, 'PATCH', { expectedRevision: rev, status: 'paused' });
    assert.equal(patched.body.scene.status, 'paused'); rev = patched.body.scene.revision;
    const reset = await f.call(`/scenes/${id}/reset`, 'POST', { expectedRevision: rev });
    assert.equal(reset.status, 200); rev = reset.body.scene.revision;
    const unlinked = await f.call(`/scenes/${id}/seats/${f.web.id}`, 'DELETE', { expectedRevision: rev });
    assert.equal(unlinked.status, 200); rev = unlinked.body.scene.revision;
    assert.deepEqual((await f.call(`/scenes/${id}`, 'DELETE', { expectedRevision: rev })).body, { deleted: true });
    assert.equal((await f.call(`/scenes/${id}`)).status, 404);
    assert.equal(f.app.providerCalls, 0);
  } finally { await f.close(); }
});

test('strict bodies: unknown fields, wrong types and missing revisions are 400', async () => {
  const f = await fixture();
  try {
    for (const body of [{}, [], { title: 'x', extra: 1 }, { title: 5 }, { title: 'x', adult: 'yes' }]) assert.equal((await f.call('/scenes', 'POST', body)).status, 400, JSON.stringify(body));
    const id = (await f.call('/scenes', 'POST', { title: 'Strict' })).body.scene.id;
    for (const body of [{}, { expectedRevision: '1' }, { expectedRevision: 1, title: 'x', bogus: true }, { expectedRevision: 0 }]) assert.equal((await f.call(`/scenes/${id}`, 'PATCH', body)).status, 400, JSON.stringify(body));
    for (const body of [{ expectedRevision: 1, key: 'a' }, { expectedRevision: 1, key: 'a', text: 'b', fromMessageId: 1 }, { expectedRevision: 1, key: 'a', text: 'b', author: 'owner-turn' }, { expectedRevision: 1, key: 'a', text: 'b', source: {} }]) assert.equal((await f.call(`/scenes/${id}/canon`, 'POST', body)).status, 400, JSON.stringify(body));
    assert.equal((await f.call(`/scenes/${id}`, 'DELETE', { expectedRevision: 1, more: 1 })).status, 400);
    assert.equal((await f.call(`/scenes/${id}/reset`, 'POST', {})).status, 400);
  } finally { await f.close(); }
});

test('fromMessageId from a non-seat conversation, a denied-meta row or an oversized line is refused', async () => {
  const f = await fixture();
  try {
    const created = (await f.call('/scenes', 'POST', { title: 'Sources' })).body.scene;
    let rev = (await f.call(`/scenes/${created.id}/seats`, 'POST', { conversationId: f.web.id, expectedRevision: created.revision, confirmAudience: true })).body.scene.revision;
    const outside = f.app.store.addMessage(f.dm.id, 'user', 'Not a seat line.');
    assert.equal((await f.call(`/scenes/${created.id}/canon`, 'POST', { expectedRevision: rev, key: 'x', fromMessageId: outside.id })).status, 404);
    const long = f.app.store.addMessage(f.web.id, 'user', 'y'.repeat(401));
    assert.equal((await f.call(`/scenes/${created.id}/canon`, 'POST', { expectedRevision: rev, key: 'x', fromMessageId: long.id })).status, 413);
    // Forgotten goes last: a seat holding forgotten dialogue is no longer eligible at all.
    for (const meta of [{ importedFrom: 'chatgpt' }, { untrusted: true }, { forgotten: true }, { groupFrom: { name: 'Mira' } }]) {
      const row = f.app.store.addMessage(f.web.id, 'assistant', 'Derived row.', meta);
      const r = await f.call(`/scenes/${created.id}/canon`, 'POST', { expectedRevision: rev, key: 'x', fromMessageId: row.id });
      assert.ok([400, 404, 409].includes(r.status), JSON.stringify(meta));
      rev = (await f.call(`/scenes/${created.id}`)).body.scene.revision;
    }
    const notice = f.app.store.addMessage(f.web.id, 'notice', 'crisis:fixture');
    assert.equal((await f.call(`/scenes/${created.id}/canon`, 'POST', { expectedRevision: rev, key: 'x', fromMessageId: notice.id })).status, 404);
    assert.deepEqual((await f.call(`/scenes/${created.id}`)).body.canon, []);
  } finally { await f.close(); }
});

test('unsigned callers get 401; missing ids and forbidden ids share one 404; disabled setting keeps owner controls', async () => {
  const f = await fixture();
  try {
    for (const [path, method] of [['/scenes', 'GET'], ['/scenes', 'POST'], ['/scenes/1', 'GET'], ['/scenes/1', 'PATCH'], ['/scenes/1', 'DELETE'], ['/scenes/1/seat-options', 'GET'], ['/scenes/1/seats', 'POST'], ['/scenes/1/seats/x', 'DELETE'], ['/scenes/1/canon', 'POST'], ['/scenes/1/canon/a', 'DELETE'], ['/scenes/1/reset', 'POST']]) {
      assert.equal((await f.call(path, method, method === 'GET' ? undefined : {}, false)).status, 401, `${method} ${path}`);
    }
    const missing = await f.call('/scenes/999');
    const bogus = await f.call('/scenes/abc');
    assert.equal(missing.status, 404); assert.equal(bogus.status, 404); assert.deepEqual(missing.body, bogus.body);
    const created = (await f.call('/scenes', 'POST', { title: 'Disabled' })).body.scene;
    const linked = (await f.call(`/scenes/${created.id}/seats`, 'POST', { conversationId: f.web.id, expectedRevision: created.revision, confirmAudience: true })).body.scene;
    f.app.settings.update({ chats: { scenes: { enabled: false } } } as never);
    assert.equal((await f.call('/scenes')).body.enabled, false);
    assert.equal((await f.call(`/scenes/${created.id}`)).status, 200);
    const reset = await f.call(`/scenes/${created.id}/reset`, 'POST', { expectedRevision: linked.revision });
    assert.equal(reset.status, 200);
    const unlinked = await f.call(`/scenes/${created.id}/seats/${f.web.id}`, 'DELETE', { expectedRevision: reset.body.scene.revision });
    assert.equal(unlinked.status, 200);
    assert.equal((await f.call(`/scenes/${created.id}`, 'DELETE', { expectedRevision: unlinked.body.scene.revision })).status, 200);
  } finally { await f.close(); }
});

test('member, demo, off-record and non-personal contexts are refused before store access', async () => {
  const module = await import('../src/routes/scenes.ts').catch(() => undefined);
  assert.ok(module?.createSceneRoutes, 'scene routes are missing');
  for (const variant of ['unsigned', 'member', 'demo', 'offRecord', 'space', 'optsMember', 'optsDemo']) {
    const app = Object.create(null);
    for (const name of ['store', 'settings']) Object.defineProperty(app, name, { get() { throw Error('forbidden inherited store access'); } });
    if (['member', 'demo', 'offRecord'].includes(variant)) app[variant] = true;
    const opts = variant === 'optsMember' ? { member: {} } : variant === 'optsDemo' ? { demo: true } : {};
    const ctx = { app, opts, spaceId: variant === 'space' ? 'business' : 'owner', isAuthed: () => variant !== 'unsigned', ctxOf: () => app };
    const route = module.createSceneRoutes(ctx as never);
    for (const [method, parts] of [['GET', ['scenes']], ['POST', ['scenes']], ['GET', ['scenes', '1']], ['DELETE', ['scenes', '1']]] as const) {
      await assert.rejects(route({ headers: {} } as IncomingMessage, { setHeader() {} } as unknown as ServerResponse, method, [...parts]), (error: any) => error.status === (variant === 'unsigned' ? 401 : 403), `${variant} ${method}`);
    }
  }
});

test('actual demo and household member servers deny every scene path', async () => {
  for (const role of ['member', 'demo']) {
    const temp = tempDir(); const app = makeApp(temp.dir, { now: new Date('2026-11-05T12:00:00Z') });
    const member = { record: () => ({ id: 'synthetic-member', name: 'Example', createdAt: app.now().toISOString(), status: 'active' as const, ownerConfirmed18At: 'fixture', memberConfirmed18At: 'fixture', limits: { models: [], messagesPerDay: 0, costPerDay: 0, voice: false, pictures: false } }), apps: () => [app], deleteSelf: async () => {} };
    const auth = new OwnerAuth(temp.dir);
    const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(role === 'demo' ? { demo: true } : { member }) } as never);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const [path, method] of [['/api/scenes', 'GET'], ['/api/scenes', 'POST']]) {
        const r = await fetch(origin + path, { method, headers: { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify({ title: 'Nope' }) } : {}) });
        assert.ok([401, 403, 404].includes(r.status), `${role} ${method} ${path} -> ${r.status}`);
      }
      assert.equal(app.store.db.prepare("SELECT count(*) AS n FROM scenes").get()!.n, 0);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); app.store.close(); temp.cleanup(); }
  }
});

test('the scenes switch saves only chats.scenes.enabled, keeps continuity, and the list reports adult availability', async () => {
  const f = await fixture();
  try {
    f.app.settings.update({ chats: { continuity: { enabled: false } } } as never);
    for (const body of [{}, { enabled: 'no' }, { enabled: false, extra: 1 }]) assert.equal((await f.call('/scenes/settings', 'PUT', body)).status, 400, JSON.stringify(body));
    const off = await f.call('/scenes/settings', 'PUT', { enabled: false });
    assert.equal(off.status, 200); assert.equal(off.body.enabled, false);
    assert.deepEqual((f.app.settings.get() as any).chats, { continuity: { enabled: false }, scenes: { enabled: false } });
    assert.equal((await f.call('/scenes/settings', 'PUT', { enabled: true })).body.enabled, true);
    assert.equal((await f.call('/scenes')).body.adultAvailable, false);
    f.app.settings.update({ adultMode: { on: true, confirmedAt: '2026-11-05T12:00:00Z' } } as never);
    assert.equal((await f.call('/scenes')).body.adultAvailable, true);
    assert.equal((await f.call('/scenes/settings', 'PUT', { enabled: true }, false)).status, 401);
  } finally { await f.close(); }
});
