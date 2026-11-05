import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { continuityForTurn } from '../src/session-continuity.ts';
import { noteRoom } from '../src/bridges/rooms.ts';
import { SettingsStore } from '../src/settings.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

async function fixture() {
  const temp = tempDir(); const app = makeApp(temp.dir, { now: new Date('2026-11-05T12:00:00Z') });
  const source = app.store.createConversation({ title: '<b>Synthetic source</b>' });
  const target = app.store.createConversation({ title: 'Synthetic target' });
  const other = app.store.createConversation({ title: 'Other target' });
  app.store.addMessage(source.id, 'user', 'Invented context');
  const service = continuityForTurn(app, source.id)!;
  const record = service.handoff({ targetId: target.id, text: '<img src=x onerror="window.__continuityPwned=1">', expectedId: 0 }).record;
  const otherRecord = service.handoff({ targetId: other.id, text: 'Keep this other context', expectedId: 0 }).record;
  const auth = new OwnerAuth(temp.dir); const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, method = 'GET', body?: unknown, authed = true) => fetch(origin + '/api' + path, { method, headers: { ...(authed ? { authorization: `Bearer ${auth.newToken}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, source, target, other, service, record, otherRecord, call, dir: temp.dir, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); app.store.close(); temp.cleanup(); } };
}

test('owner inspects literal context with bounded source labels while disabled; read is nonmutating', async () => {
  const f = await fixture();
  try {
    f.app.settings.update({ chats: { continuity: { enabled: false } } });
    const before = f.app.store.db.prepare('SELECT * FROM session_handoffs ORDER BY id').all();
    const response = await f.call(`/conversations/${f.target.id}/continuity`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.currentId, f.record.id); assert.equal(body.handoffs[0].text, f.record.text);
    assert.equal(body.handoffs[0].sourceTitle, '<b>Synthetic source</b>');
    assert.equal(body.handoffs[0].sourceConversationId, f.source.id);
    assert.deepEqual(f.app.store.db.prepare('SELECT * FROM session_handoffs ORDER BY id').all(), before);
    assert.equal(continuityForTurn(f.app, f.source.id), undefined); assert.equal(f.app.providerCalls, 0);
  } finally { await f.close(); }
});
test('clear requires strict expectedId, conflicts on concurrent revision, and clears only selected target while disabled', async () => {
  const f = await fixture();
  try {
    const path = `/conversations/${f.target.id}/continuity`;
    for (const body of [{}, [], null, { expectedId: '1' }, { expectedId: -1 }, { expectedId: 1.2 }, { expectedId: 0, targetId: f.other.id }]) assert.equal((await f.call(path, 'DELETE', body)).status, 400, JSON.stringify(body));
    const second = f.service.handoff({ targetId: f.target.id, text: 'Newer synthetic context', expectedId: f.record.id }).record;
    assert.equal((await f.call(path, 'DELETE', { expectedId: f.record.id })).status, 409);
    assert.equal((await (await f.call(path)).json()).currentId, second.id);
    f.app.settings.update({ chats: { continuity: { enabled: false } } });
    assert.equal((await f.call(path, 'DELETE', { expectedId: second.id })).status, 200);
    assert.deepEqual((await (await f.call(path)).json()).handoffs, []);
    assert.equal((await (await f.call(`/conversations/${f.other.id}/continuity`)).json()).currentId, f.otherRecord.id);
    assert.equal(f.app.store.messages(f.source.id).length, 1);
  } finally { await f.close(); }
});
test('missing and forbidden targets have the same response; unsigned callers cannot inspect or clear', async () => {
  const f = await fixture();
  try {
    const forbidden = [{ private: true }, { partner: 'Invented partner' }, { channel: 'import-chatgpt' }, { channel: 'api' }, { channel: 'mcp' }, { channel: 'group' }, { channel: 'discord', channelKey: 'room:fixture' }].map(options => f.app.store.createConversation(options).id);
    const archived = f.app.store.createConversation(); f.app.store.db.prepare('UPDATE conversations SET archived_at=? WHERE id=?').run(f.app.now().toISOString(), archived.id);
    const ended = f.app.store.createConversation(); f.app.store.db.prepare('UPDATE conversations SET ended_at=? WHERE id=?').run(f.app.now().toISOString(), ended.id);
    const room = f.app.store.createConversation({ channel: 'discord', channelKey: 'actually-room' }); noteRoom(f.app, { bridge: 'discord', key: 'actually-room', kind: 'room', title: 'Invented room' });
    const ids = ['00000000-0000-4000-8000-000000000000', ...forbidden, archived.id, ended.id, room.id];
    for (const method of ['GET', 'DELETE']) {
      let denied: unknown;
      for (const id of ids) {
        const response = await f.call(`/conversations/${id}/continuity`, method, method === 'DELETE' ? { expectedId: 0 } : undefined);
        assert.equal(response.status, 403, id); const body = await response.json(); if (!denied) denied = body; else assert.deepEqual(body, denied);
      }
      for (const id of [f.target.id, ids[0]]) assert.equal((await f.call(`/conversations/${id}/continuity`, method, method === 'DELETE' ? { expectedId: 0 } : undefined, false)).status, 401);
    }
    assert.equal(f.app.providerCalls, 0);
  } finally { await f.close(); }
});
test('continuity toggle persists and preserves all existing chats settings; malformed writes rejected', async () => {
  const f = await fixture();
  try {
    const chats = { whileBusy: 'queue', queueMax: 10, pickup: { mode: 'off', lines: 6 }, btw: { model: 'local', dailyCap: 20 }, continuity: { enabled: true } };
    f.app.settings.update({ chats } as never);
    for (const body of [{}, { enabled: 'false' }, { enabled: false, pickup: {} }, [], null]) assert.equal((await f.call('/chats/continuity', 'PUT', body)).status, 400);
    assert.equal((await f.call('/chats/continuity', 'PUT', { enabled: false })).status, 200);
    assert.deepEqual(f.app.settings.get().chats, { ...chats, continuity: { enabled: false } });
    assert.deepEqual(new SettingsStore(f.dir).get().chats, f.app.settings.get().chats);
    assert.equal((await (await f.call('/chats/continuity')).json()).enabled, false);
    assert.equal((await f.call('/chats/continuity', 'PUT', { enabled: true })).status, 200);
    assert.deepEqual(f.app.settings.get().chats, chats);
  } finally { await f.close(); }
});
test('route rejects unauthenticated/member/demo/offRecord/nonpersonal/current-context mismatch before inherited store access', async () => {
  const module = await import('../src/routes/session-continuity.ts').catch(() => undefined);
  assert.ok(module?.createSessionContinuityRoutes, 'owner continuity route is missing');
  for (const variant of ['unsigned', 'member', 'demo', 'offRecord', 'space', 'mismatch']) {
    const app = Object.create(null);
    Object.defineProperty(app, 'store', { get() { throw Error('forbidden inherited store access'); } });
    if (['member', 'demo', 'offRecord'].includes(variant)) app[variant] = true;
    const ctx = { app, opts: {}, spaceId: variant === 'space' ? 'business' : 'owner', isAuthed: () => variant !== 'unsigned', ctxOf: () => variant === 'mismatch' ? {} : app };
    const route = module.createSessionContinuityRoutes(ctx as never);
    for (const method of ['GET', 'DELETE']) await assert.rejects(route({ headers: {} } as IncomingMessage, { setHeader() {} } as unknown as ServerResponse, method, ['conversations', 'synthetic', 'continuity']), (error: any) => error.status === (variant === 'unsigned' ? 401 : 403));
  }
});


test('delayed request bodies cannot retain revoked auth, owner, personal space or resolved app authority', async () => {
  const module = await import('../src/routes/session-continuity.ts');
  for (const method of ['PUT', 'DELETE']) for (const change of ['auth', 'member', 'demo', 'offRecord', 'space', 'app', ...(method === 'DELETE' ? ['target'] : [])]) {
    const f = await fixture();
    try {
      let authorized = true; let resolved = f.app;
      const ctx = { app: f.app, opts: {}, spaceId: 'owner', isAuthed: () => authorized, ctxOf: () => resolved };
      let entered!: () => void; let release!: () => void;
      const reading = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      const body = method === 'PUT' ? { enabled: false } : { expectedId: f.record.id };
      const req = { headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { entered(); await held; yield Buffer.from(JSON.stringify(body)); } } as unknown as IncomingMessage;
      const res = { setHeader() {}, writeHead() {}, end() {} } as unknown as ServerResponse;
      const effect = module.createSessionContinuityRoutes(ctx as never)(req, res, method, method === 'PUT' ? ['chats', 'continuity'] : ['conversations', f.target.id, 'continuity']);
      const rejection = assert.rejects(effect, (error: any) => error.status === (change === 'auth' ? 401 : 403), `${method}/${change}`);
      await reading;
      if (change === 'auth') authorized = false;
      else if (change === 'space') ctx.spaceId = 'business';
      else if (change === 'app') ctx.app = {} as never;
      else if (change === 'target') resolved = {} as never;
      else Object.assign(f.app, { [change]: true });
      const chats = structuredClone(f.app.settings.get().chats);
      const records = f.app.store.db.prepare('SELECT * FROM session_handoffs ORDER BY id').all();
      release(); await rejection;
      assert.deepEqual(f.app.settings.get().chats, chats, `${method}/${change}: settings unchanged`);
      assert.deepEqual(f.app.store.db.prepare('SELECT * FROM session_handoffs ORDER BY id').all(), records, `${method}/${change}: context unchanged`);
    } finally { await f.close(); }
  }
});

test('actual household and demo HTTP routing deny every new owner path without touching saved context', async () => {
  for (const role of ['member', 'demo']) {
    const temp = tempDir(); const app = makeApp(temp.dir, { now: new Date('2026-11-05T12:00:00Z') }); const auth = new OwnerAuth(temp.dir);
    const source = app.store.createConversation(); const target = app.store.createConversation(); app.store.addMessage(source.id, 'user', 'Synthetic');
    continuityForTurn(app, source.id)!.handoff({ targetId: target.id, text: 'Keep context', expectedId: 0 });
    const before = app.store.db.prepare('SELECT * FROM session_handoffs').all(); const settings = structuredClone(app.settings.get());
    const member = { record: () => ({ id: 'synthetic-member', name: 'Example', createdAt: app.now().toISOString(), status: 'active' as const, ownerConfirmed18At: 'fixture', memberConfirmed18At: 'fixture', limits: { models: [], messagesPerDay: 0, costPerDay: 0, voice: false, pictures: false } }), apps: () => [app], deleteSelf: async () => {} };
    const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(role === 'demo' ? { demo: true } : { member }) });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const [path, method, body] of [[`/conversations/${target.id}/continuity`, 'GET'], [`/conversations/${target.id}/continuity`, 'DELETE', { expectedId: 1 }], ['/chats/continuity', 'GET'], ['/chats/continuity', 'PUT', { enabled: false }]] as const) {
        const response = await fetch(origin + '/api' + path, { method, headers: { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
        assert.ok([401, 403, 404].includes(response.status), `${role}/${method}/${path}`);
      }
      assert.deepEqual(app.store.db.prepare('SELECT * FROM session_handoffs').all(), before); assert.deepEqual(app.settings.get(), settings); assert.equal(app.providerCalls, 0);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); app.store.close(); temp.cleanup(); }
  }
});
test('actual business administrator and member routing denies new personal paths and creates no personal store', async () => {
  const { contentFixture } = await import('./helpers/business-content.ts');
  const { existsSync } = await import('node:fs');
  const f = await contentFixture();
  try {
    const member = f.add('Synthetic business member');
    for (const session of [f.admin, member]) for (const id of ['00000000-0000-4000-8000-000000000000', 'missing']) {
      for (const [path, method, body] of [[`/api/conversations/${id}/continuity`, 'GET'], [`/api/conversations/${id}/continuity`, 'DELETE', { expectedId: 0 }], ['/api/chats/continuity', 'GET'], ['/api/chats/continuity', 'PUT', { enabled: false }]] as const) {
        const response = await fetch(f.runtime.origin + path, { method, headers: { origin: f.runtime.origin, cookie: `sara_business_session=${session.value}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
        assert.equal(response.status, 404, `${method}/${path}`); assert.deepEqual(await response.json(), { error: 'Not found.' });
      }
    }
    for (const path of ['settings.json', 'sara.db', 'owner.json', 'companions']) assert.equal(existsSync(join(f.dir, path)), false, `No personal owner context: ${path}`);
  } finally { await f.close(); }
});

test('continuity setting changes preserve unknown and malformed neighboring settings', async () => {
  const f = await fixture();
  try {
    const chats = { pickup: 'legacy malformed value', whileBusy: null, queueMax: 'legacy', custom: { value: 7 }, continuity: { enabled: true, futureOption: 'preserve' } };
    f.app.settings.update({ chats } as never);
    assert.equal((await f.call('/chats/continuity', 'PUT', { enabled: false })).status, 200);
    assert.deepEqual(f.app.settings.get().chats, { ...chats, continuity: { ...chats.continuity, enabled: false } });
  } finally { await f.close(); }
});

test('clear cannot cross a replaced store while reading its request body even when ids and revisions match', async () => {
  const { Store } = await import('../src/store.ts');
  const { createSessionContinuityRoutes } = await import('../src/routes/session-continuity.ts');
  const f = await fixture(); const original = f.app.store; const replacement = new Store(':memory:', () => f.app.now());
  try {
    const target = replacement.createConversation(); replacement.db.prepare('UPDATE conversations SET id=? WHERE id=?').run(f.target.id, target.id);
    const source = replacement.createConversation(); replacement.addMessage(source.id, 'user', 'Separate-store context');
    const replacementApp = Object.create(f.app); replacementApp.store = replacement;
    const note = continuityForTurn(replacementApp, source.id)!.handoff({ targetId: f.target.id, text: 'Must not clear this separate store', expectedId: 0 }).record;
    assert.equal(note.id, f.record.id, 'Deliberate matching ids and revisions exercise store identity');
    let entered!: () => void; let release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
    const req = { headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { entered(); await held; yield Buffer.from(JSON.stringify({ expectedId: note.id })); } } as unknown as IncomingMessage;
    const ctx = { app: f.app, opts: {}, spaceId: 'owner', isAuthed: () => true, ctxOf: () => f.app };
    const effect = createSessionContinuityRoutes(ctx as never)(req, { setHeader() {}, writeHead() {}, end() {} } as unknown as ServerResponse, 'DELETE', ['conversations', f.target.id, 'continuity']);
    const rejected = assert.rejects(effect, (error: any) => error.status === 403);
    await reading; f.app.store = replacement;
    const before = replacement.db.prepare('SELECT * FROM session_handoffs').all(); release(); await rejected;
    assert.deepEqual(replacement.db.prepare('SELECT * FROM session_handoffs').all(), before);
  } finally { f.app.store = original; replacement.close(); await f.close(); }
});
