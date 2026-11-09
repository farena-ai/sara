import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { contentFixture } from './helpers/business-content.ts';
import { DatabaseSync } from 'node:sqlite';
import { initializeAudit } from '../src/business/audit.ts';
import { createConnection } from 'node:net';

test('audit action migration preserves IDs and trigger targets in both control and content databases', () => {
  for (const kind of ['control', 'content']) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("CREATE TABLE business_audit(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,action TEXT CHECK(action IN ('identity.create')),actor_id TEXT,workspace_id TEXT,subject_id TEXT,revision INTEGER); INSERT INTO business_audit VALUES (41,1,'identity.create',NULL,NULL,NULL,NULL); CREATE TABLE source(id INTEGER); CREATE TRIGGER record_source AFTER INSERT ON source BEGIN INSERT INTO business_audit(at,action) VALUES(2,'identity.create'); END;");
      initializeAudit(db);
      assert.equal(db.prepare('SELECT id FROM business_audit').get()!.id, 41, kind);
      db.exec('INSERT INTO source VALUES(1)');
      assert.equal(db.prepare('SELECT MAX(id) AS id FROM business_audit').get()!.id, 42, kind);
      initializeAudit(db); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM business_audit').get()!.n, 2);
    } finally { db.close(); }
  }
});

test('business shell permits external entry but keeps APIs, host and private assets closed', async () => {
  const f = await contentFixture();
  try {
    const shell = await fetch(f.runtime.origin + '/', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(shell.status, 200); assert.match(await shell.text(), /business-app.js/);
    assert.match(shell.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    for (const path of ['/api/business/me', '/api/business/claim']) assert.equal((await fetch(f.runtime.origin + path, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    for (const path of ['/index.html', '/app.js', '/help.html', '/identity.js', '/.secrets/private-patterns.json', '/src/main.ts']) assert.equal((await fetch(f.runtime.origin + path)).status, 404);
    assert.equal(await new Promise<number>(resolve => { httpRequest(f.runtime.origin + '/', { headers: { host: 'wrong.invalid' } }, response => { response.resume(); resolve(response.statusCode!); }).end(); }), 403);
  } finally { await f.close(); }
});

test('current self has safe enrollment and organization metadata; label mutation is admin-only and audited', async () => {
  const f = await contentFixture();
  try {
    const self = await (await f.request('/api/business/me')).json();
    assert.equal(self.organization.role, 'orgadmin'); assert.equal(self.passkeyEnrolled, false); assert.equal(self.recovering, false);
    const user = f.add('Morgan');
    assert.equal((await f.request('/api/business/org', user, { name: 'Forged' })).status, 403);
    assert.equal((await f.request('/api/business/org', f.admin, { name: 'Example Studio' })).status, 200);
    assert.equal((await (await f.request('/api/business/me', user)).json()).organization.name, 'Example Studio');
    assert.equal((await f.request('/api/business/org', f.admin, { name: 'X'.repeat(121) })).status, 400);
    assert.equal((await f.request('/api/business/org/audit', user)).status, 403);
    assert.equal((await f.request('/api/business/org/audit')).status, 200);
    assert.ok(f.runtime.audit.organization(f.admin.principal).some(x => x.action === 'organization.settings' && x.subjectId === null));
  } finally { await f.close(); }
});

test('recent UI history includes newest messages after 200, bounded and scoped; viewer actions still deny', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Studio' });
    const ids = await f.seed(w.id, 'Oldest');
    f.runtime.workspaces.mutate(f.context(w.id), 'send', db => {
      for (let i = 0; i < 220; i++) db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(randomUUID(), ids.conversation, f.admin.principal.identityId, 'user', `Recent ${i}`, new Date(Date.now() + i * 1000).toISOString());
    });
    const viewer = f.add('Reader'); f.grant(w.id, viewer);
    const path = `/api/business/workspaces/${w.id}`;
    const result = await f.request(`${path}/conversations/${ids.conversation}/recent-messages`, viewer);
    assert.equal(result.status, 200); const rows = await result.json(); assert.equal(rows.length, 200); assert.equal(rows.at(-1).body, 'Recent 219');
    for (const [tail, body] of [['conversations', { title: 'No' }], ['documents', { title: 'No', mime: 'text/plain', body: 'No' }], ['uploads', {}], [`conversations/${ids.conversation}/messages`, {}], [`members/${f.admin.principal.identityId}`, { role: 'viewer', status: 'active' }], ['invites', { role: 'viewer', subject: viewer.principal.identityId }]] as const) assert.equal((await f.request(`${path}/${tail}`, viewer, body)).status, 404);
    const outsider = f.add('Outsider'); assert.equal((await f.request(`${path}/conversations/${ids.conversation}/recent-messages`, outsider)).status, 404);
  } finally { await f.close(); }
});

test('request status is readonly, actor and conversation scoped, and absent requests never enter admission', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Status desk' });
    const ids = await f.seed(w.id, 'Status conversation'); const requestId = randomUUID();
    const path = `/api/business/workspaces/${w.id}/conversations/${ids.conversation}/requests/${requestId}`;
    const absent = await f.request(path); assert.equal(absent.status, 200); assert.deepEqual(await absent.json(), { requestId, state: 'not-admitted' });
    assert.equal(f.runtime.control.database.prepare('SELECT COUNT(*) AS n FROM business_model_requests').get()!.n, 0);
    const context = f.runtime.policy.authorizeWorkspace(f.admin.principal, w.id, 'send');
    await f.runtime.chat.send(context, ids.conversation, { requestId, text: 'Explicit sexual content involving a 12-year-old', documentIds: [] });
    assert.equal((await (await f.request(path)).json()).state, 'blocked');
    const colleague = f.add('Another Reader'); f.grant(w.id, colleague);
    assert.equal((await f.request(path, colleague)).status, 404);
    assert.equal((await f.request(path.replace(ids.conversation, randomUUID()))).status, 404);
    assert.equal((await f.request(path, f.admin, {})).status, 404);
  } finally { await f.close(); }
});

test('UI expected-session guard refuses cookie swaps before any action under the replacement actor', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Two accounts' });
    const second = f.add('Second actor'); f.grant(w.id, second, 'contributor');
    const response = await f.request(`/api/business/workspaces/${w.id}/conversations`, second, { title: 'Wrong actor draft' }, { 'x-sara-business-session': f.admin.principal.sessionId });
    assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'Business session changed.' });
    assert.deepEqual(await f.runtime.workspaces.openWorkspace(f.context(w.id)).conversations(), []);
    assert.equal((await f.request('/api/business/me', second, undefined, { 'x-sara-business-session': second.principal.sessionId })).status, 200);
  } finally { await f.close(); }
});

test('business shutdown closes an unused browser preconnection after draining admitted work', async () => {
  const f = await contentFixture();
  const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(f.runtime.origin).port) });
  await new Promise<void>(resolve => socket.once('connect', resolve));
  try {
    const closed = f.runtime.close().then(() => true);
    assert.equal(await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve(false), 400))]), true);
  } finally { socket.destroy(); await f.close(); }
});
