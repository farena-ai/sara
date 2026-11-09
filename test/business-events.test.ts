import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { OwnerAuth } from '../src/auth.ts';
import { contentFixture } from './helpers/business-content.ts';

test('workspace SSE reauthorizes fixed metadata and closes on logout, role loss, policy change and shutdown', async () => {
  const f = await contentFixture();
  try {
    assert.ok(f.runtime.events, 'Authorized business workspace event hub must exist');
    const a = f.runtime.control.createWorkspace(f.admin.principal, { name: 'A' }); const b = f.runtime.control.createWorkspace(f.admin.principal, { name: 'B' });
    const user = f.add('Taylor'); f.grant(a.id, user, 'contributor');
    assert.equal((await f.request(`/api/business/workspaces/${b.id}/events`, user)).status, 404);
    const open = async () => {
      const response = await f.request(`/api/business/workspaces/${a.id}/events`, user); assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-type')!.startsWith('text/event-stream')); const reader = response.body!.getReader();
      assert.ok(new TextDecoder().decode((await reader.read()).value).includes('connected')); return reader;
    };
    let reader = await open(); assert.equal(f.runtime.events.size, 1);
    f.runtime.events.publish(b.id, { kind: 'content.changed' });
    f.runtime.events.publish(a.id, { kind: 'content.changed', body: 'SECRET_RAW', title: 'SECRET_TITLE', snippet: 'SECRET_SNIPPET' } as never);
    const event = new TextDecoder().decode((await reader.read()).value); assert.ok(event.includes('content.changed')); assert.ok(!event.includes('SECRET')); assert.ok(!event.includes(b.id));
    assert.equal((await f.request('/api/business/logout', user, {})).status, 200);
    assert.equal((await reader.read()).done, true); assert.equal(f.runtime.events.size, 0);
    const s = f.add('Morgan'); f.grant(a.id, s);
    const r = await f.request(`/api/business/workspaces/${a.id}/events`, s); reader = r.body!.getReader(); await reader.read();
    f.runtime.control.setWorkspaceMember(f.admin.principal, a.id, s.principal.identityId, { role: 'viewer', status: 'removed' });
    assert.equal((await reader.read()).done, true); assert.equal(f.runtime.events.size, 0);
    const t = f.add('Casey'); f.grant(a.id, t);
    const response = await f.request(`/api/business/workspaces/${a.id}/events`, t); reader = response.body!.getReader(); await reader.read();
    f.runtime.identities.database.prepare('UPDATE workspaces SET policy_revision=policy_revision+1 WHERE id=?').run(a.id);
    f.runtime.events.publish(a.id, { kind: 'content.changed' }); assert.equal((await reader.read()).done, true);
    const shutdown = await f.request(`/api/business/workspaces/${a.id}/events`); reader = shutdown.body!.getReader(); await reader.read();
    await f.runtime.close(); assert.equal((await reader.read()).done, true); assert.equal(f.runtime.events.size, 0);
  } finally { await f.close(); }
});

test('event subscriptions bound actor connections and remove disconnect listeners', async () => {
  const f = await contentFixture();
  try {
    assert.ok(f.runtime.events, 'Authorized business workspace event hub must exist');
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Bounded' });
    const readers = [];
    for (let i = 0; i < 4; i++) { const r = await f.request(`/api/business/workspaces/${w.id}/events`); assert.equal(r.status, 200); const reader = r.body!.getReader(); await reader.read(); readers.push(reader); }
    assert.equal((await f.request(`/api/business/workspaces/${w.id}/events`)).status, 429);
    assert.equal(f.runtime.events.size, 4);
    await Promise.all(readers.map(r => r.cancel()));
    for (let i = 0; i < 30 && f.runtime.events.size; i++) await new Promise<void>(r => setImmediate(r));
    assert.equal(f.runtime.events.size, 0);
  } finally { await f.close(); }
});

test('direct HTTP server.close completes with an open SSE transport', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Direct close' });
    const response = await f.request(`/api/business/workspaces/${w.id}/events`); assert.equal(response.status, 200);
    const reader = response.body!.getReader(); await reader.read();
    const closed = new Promise<void>((resolve, reject) => f.runtime.server.close(error => error ? reject(error) : resolve()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Open SSE blocked server.close')), 500); })]); }
    finally { clearTimeout(timer); }
    assert.equal((await reader.read()).done, true); assert.equal(f.runtime.events.size, 0);
  } finally { await f.close(); }
});

test('organization disable and actual signed-session expiry close existing SSE connections', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Session lifetime' }); const user = f.add('Taylor'); f.grant(w.id, user);
    const response = await f.request(`/api/business/workspaces/${w.id}/events`, user); const reader = response.body!.getReader(); await reader.read();
    f.runtime.control.setOrganizationMember(f.admin.principal, user.principal.identityId, { status: 'disabled' });
    assert.equal((await reader.read()).done, true); assert.equal(f.runtime.events.size, 0);
    const expiring = f.add('Morgan'); f.grant(w.id, expiring);
    // Real HMAC-signed, short-lived synthetic browser session using the existing auth primitive.
    const clock = Date.now() - 30 * 24 * 60 * 60 * 1000 + 1500;
    const ownerAuth = new OwnerAuth(join(f.profile.businessDir, 'auth', expiring.principal.identityId, '0'), () => new Date(clock), { tokenPrefix: `sara_business.${expiring.principal.identityId}.` });
    const short = ownerAuth.createSession(); const value = `${expiring.principal.identityId}.0.${short.value}`;
    const r = await f.request(`/api/business/workspaces/${w.id}/events`, expiring, undefined, { cookie: `sara_business_session=${value}` }); assert.equal(r.status, 200);
    const stream = r.body!.getReader(); await stream.read(); assert.equal((await stream.read()).done, true); assert.equal(f.runtime.events.size, 0);
  } finally { await f.close(); }
});

test('server-wide subscription bound applies across distinct authorized actors', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Server bound' });
    const actors = Array.from({ length: 65 }, (_, i) => { const actor = f.add(`Subscriber ${i}`); f.grant(w.id, actor); return actor; });
    const readers = [];
    for (let i = 0; i < 256; i++) {
      const r = await f.request(`/api/business/workspaces/${w.id}/events`, actors[Math.floor(i / 4)]); assert.equal(r.status, 200);
      const reader = r.body!.getReader(); await reader.read(); readers.push(reader);
    }
    assert.equal(f.runtime.events.size, 256);
    assert.equal((await f.request(`/api/business/workspaces/${w.id}/events`, actors[64])).status, 429);
    await f.runtime.close(); assert.equal(f.runtime.events.size, 0);
    assert.ok((await Promise.all(readers.map(reader => reader.read()))).every(value => value.done));
  } finally { await f.close(); }
});
