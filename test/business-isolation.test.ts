import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';
import { contentFixture } from './helpers/business-content.ts';

test('HTTP workspace reads isolate four membership sets and personal data across 100 interleaved actors', async () => {
  const f = await contentFixture();
  try {
    const spaces = Array.from({ length: 4 }, (_, i) => f.runtime.control.createWorkspace(f.admin.principal, { name: `Workspace ${i}` }));
    const ids = await Promise.all(spaces.map((w, i) => f.seed(w.id, `CANARY_SPACE_${i}`)));
    const personal = join(f.dir, 'personal-fixture'); mkdirSync(personal);
    const personalStore = new Store(join(personal, 'sara.db'));
    const privateChat = personalStore.createConversation({ title: 'PERSONAL_SECRET_CANARY' }); personalStore.addMessage(privateChat.id, 'user', 'PERSONAL_SECRET_CANARY'); personalStore.close();
    const actors = Array.from({ length: 100 }, (_, i) => { const s = f.add(`Reader ${i}`); f.grant(spaces[i % 4].id, s, i % 2 ? 'contributor' : 'viewer'); return s; });
    await Promise.all(actors.map(async (s, i) => {
      const n = i % 4; const base = `/api/business/workspaces/${spaces[n].id}`;
      for (const tail of ['/conversations', `/conversations/${ids[n].conversation}/messages`, `/messages/${ids[n].message}`, '/documents', `/documents/${ids[n].document}`, '/search?q=CANARY', '/memories', `/citations/${ids[n].citation}`, `/uploads/${ids[n].upload}`]) {
        const response = await f.request(base + tail, s); assert.equal(response.status, 200, tail);
        const value = JSON.stringify(await response.json()); assert.ok(value.includes(`CANARY_SPACE_${n}`), tail);
        for (let k = 0; k < 4; k++) if (k !== n) assert.ok(!value.includes(`CANARY_SPACE_${k}`));
        assert.ok(!value.includes('PERSONAL_SECRET_CANARY'));
      }
      const notifications = await f.request(base + '/notifications', s); assert.equal(notifications.status, 200);
      assert.ok(!(await notifications.text()).includes('CANARY'));
      for (const tail of [`/messages/${ids[(n + 1) % 4].message}`, `/documents/${ids[(n + 1) % 4].document}`, `/citations/${ids[(n + 1) % 4].citation}`, `/uploads/${ids[(n + 1) % 4].upload}`, `/messages/${randomUUID()}`]) {
        const denied = await f.request(base + tail, s); assert.equal(denied.status, 404); assert.deepEqual(await denied.json(), { error: 'Not found.' });
      }
      assert.equal((await f.request(`/api/business/workspaces/${spaces[(n + 1) % 4].id}/search?q=CANARY`, s)).status, 404);
    }));
    const viewer = actors[0]; const base = `/api/business/workspaces/${spaces[0].id}`;
    for (const path of ['/conversations', '/documents', '/messages', '/chat', '/search', '/model', '/uploads', '/memories', '/notifications', '/events']) assert.equal((await f.request(base + path, viewer, { body: 'must not write' })).status, 404);
    for (const path of ['/api/chat', '/v1/chat/completions', '/api/search', '/api/library', '/api/business/search']) assert.equal((await f.request(path, viewer)).status, 404);
    assert.equal((await f.request(base + '/documents', viewer, undefined, { cookie: '' })).status, 401);
    assert.equal((await f.request(base + '/documents', viewer, undefined, { origin: 'https://foreign.invalid' })).status, 403);
    assert.equal((await f.request(base + '/documents', viewer, undefined, { authorization: `Bearer ${viewer.value}`, cookie: '' })).status, 401);
  } finally { await f.close(); }
});

test('guarded internal retrieval refuses copied contexts, revocation, logout, expiry and stale previews after await', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Awaited' }); const ids = await f.seed(w.id, 'AWAIT_CANARY');
    const user = f.add('Taylor'); f.grant(w.id, user, 'contributor');
    assert.throws(() => f.runtime.workspaces.openWorkspace({ ...f.context(w.id, user) }));
    for (const change of ['role', 'logout', 'policy', 'expiry'] as const) {
      const actor = f.add(`Await ${change}`); f.grant(w.id, actor, 'contributor');
      const ctx = f.context(w.id, actor); const reader = f.runtime.workspaces.openWorkspace(ctx);
      let release!: () => void; const gate = new Promise<void>(r => { release = r; });
      let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
      const pending = f.runtime.retrieval.retrieve(ctx, async scope => { const value = await scope.document(ids.document); entered(); await gate; return value; });
      await started;
      if (change === 'role') f.grant(w.id, actor, 'viewer');
      if (change === 'logout') f.runtime.auth.logout(actor.principal);
      if (change === 'policy') f.runtime.identities.database.prepare('UPDATE workspaces SET policy_revision=policy_revision+1 WHERE id=?').run(w.id);
      if (change === 'expiry') { const now = Date.now; Date.now = () => actor.principal.expiresAt + 1; try { await assert.rejects(reader.document(ids.document)); release(); await assert.rejects(pending); } finally { Date.now = now; } continue; }
      release(); await assert.rejects(pending); await assert.rejects(reader.document(ids.document));
    }
    assert.equal((await f.runtime.workspaces.openWorkspace(f.context(w.id)).document(ids.document)).body, 'AWAIT_CANARY');
  } finally { await f.close(); }
});

test('registry paths reject symlink escapes, swapped content databases and unscoped imports without leaking paths', async () => {
  const f = await contentFixture();
  try {
    const a = f.runtime.control.createWorkspace(f.admin.principal, { name: 'A' }); const b = f.runtime.control.createWorkspace(f.admin.principal, { name: 'B' });
    await f.seed(a.id, 'A_SECRET'); await f.seed(b.id, 'B_SECRET');
    copyFileSync(join(f.profile.businessDir, 'workspaces', a.id, 'content.db'), join(f.profile.businessDir, 'workspaces', b.id, 'content.db'));
    const response = await f.request(`/api/business/workspaces/${b.id}/documents`); assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'Not found.' });
    const c = f.runtime.control.createWorkspace(f.admin.principal, { name: 'C' });
    symlinkSync(join(f.profile.businessDir, 'workspaces', a.id), join(f.profile.businessDir, 'workspaces', c.id), 'junction');
    assert.equal((await f.request(`/api/business/workspaces/${c.id}/documents`)).status, 404);
    const d = f.runtime.control.createWorkspace(f.admin.principal, { name: 'D' }); mkdirSync(join(f.profile.businessDir, 'workspaces', d.id));
    const personalStore = new Store(join(f.profile.businessDir, 'workspaces', d.id, 'content.db'));
    const conversation = personalStore.createConversation({ title: 'IMPORTED_PERSONAL_CANARY' }); personalStore.addMessage(conversation.id, 'user', 'IMPORTED_PERSONAL_CANARY'); personalStore.close();
    assert.equal((await f.request(`/api/business/workspaces/${d.id}/documents`)).status, 404);
    assert.throws(() => f.runtime.workspaces.openWorkspace({ ...f.context(a.id), workspaceId: '../personal-fixture' }));
  } finally { await f.close(); }
});

test('same resource UUIDs and updated content remain workspace-scoped without a global search/model cache', async () => {
  const f = await contentFixture();
  try {
    const a = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Cache A' }); const b = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Cache B' });
    const ids = await f.seed(a.id, 'CANARY_ALPHA'); await f.seed(b.id, 'CANARY_BETA');
    const db = new DatabaseSync(join(f.profile.businessDir, 'workspaces', b.id, 'content.db'));
    try { db.prepare("INSERT INTO documents(id,title,mime,body,created_at) VALUES (?,?,'text/plain',?,?)").run(ids.document, 'Same ID', 'CANARY_BETA_SAME_ID', new Date().toISOString()); } finally { db.close(); }
    for (let i = 0; i < 20; i++) {
      const w = i % 2 ? a : b; const ctx = f.context(w.id); const scope = f.runtime.workspaces.openWorkspace(ctx);
      assert.equal((await scope.document(ids.document)).body, i % 2 ? 'CANARY_ALPHA' : 'CANARY_BETA_SAME_ID');
      const model = await f.runtime.retrieval.modelContext(ctx, 'CANARY'); assert.equal(model.workspaceId, w.id); assert.ok(Object.isFrozen(model));
      assert.ok(!JSON.stringify(model).includes(i % 2 ? 'BETA' : 'ALPHA'));
      assert.deepEqual(Object.keys(model).sort(), ['hits', 'policyRevision', 'profile', 'workspaceId']);
    }
    const update = new DatabaseSync(join(f.profile.businessDir, 'workspaces', a.id, 'content.db'));
    try { update.prepare('UPDATE documents SET body=? WHERE id=?').run('FRESH_CANARY', ids.document); } finally { update.close(); }
    assert.equal((await f.runtime.workspaces.openWorkspace(f.context(a.id)).document(ids.document)).body, 'FRESH_CANARY');
  } finally { await f.close(); }
});

test('actual HTTP refuses materialized output after logout or membership loss during its awaited retrieval', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'HTTP await' }); const ids = await f.seed(w.id, 'NEVER_RELEASE_CANARY');
    for (const logout of [false, true]) {
      const actor = f.add(`Paused ${logout}`); f.grant(w.id, actor);
      let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
      const original = f.runtime.retrieval.retrieve.bind(f.runtime.retrieval);
      f.runtime.retrieval.retrieve = async (ctx, operation) => { const value = await original(ctx, operation); entered(); await gate; return value; };
      const pending = f.request(`/api/business/workspaces/${w.id}/documents/${ids.document}`, actor); await started;
      if (logout) f.runtime.auth.logout(actor.principal);
      else f.runtime.control.setWorkspaceMember(f.admin.principal, w.id, actor.principal.identityId, { role: 'viewer', status: 'removed' });
      release(); const response = await pending; assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'Not found.' });
      f.runtime.retrieval.retrieve = original;
    }
  } finally { await f.close(); }
});

test('reader audience and manager invite candidates expose only purpose-specific active DTOs', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Audience' }); const contributor = f.add('Taylor'); const manager = f.add('Morgan'); const candidate = f.add('Casey'); const outsider = f.add('Jordan');
    f.grant(w.id, contributor, 'contributor'); f.grant(w.id, manager, 'manager');
    const base = `/api/business/workspaces/${w.id}`;
    const a = await f.request(base + '/audience', contributor); assert.equal(a.status, 200); const audience = await a.json();
    assert.equal(audience.count, 3); assert.deepEqual(audience.members.map((m: object) => Object.keys(m).sort()), Array(3).fill(['name', 'role']));
    assert.equal((await f.request(base + '/members', contributor)).status, 404);
    assert.equal((await f.request('/api/business/org/users', manager)).status, 403);
    const c = await f.request(base + '/invite-candidates?q=Case', manager); assert.equal(c.status, 200);
    assert.deepEqual(await c.json(), [{ id: candidate.principal.identityId, name: 'Casey' }]);
    assert.equal((await f.request(base + '/invite-candidates', contributor)).status, 404);
    assert.equal((await f.request(base + '/audience', outsider)).status, 404);
    assert.equal((await f.request(base + '/invite-candidates?q=' + 'x'.repeat(81), manager)).status, 400);
  } finally { await f.close(); }
});

test('audience and candidate pick-lists exclude inactive identities, inactive organizations and removed grants', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Filtered audience' });
    const contributor = f.add('Taylor'); const manager = f.add('Morgan'); const viewer = f.add('Quinn');
    f.grant(w.id, contributor, 'contributor'); f.grant(w.id, manager, 'manager'); f.grant(w.id, viewer);
    const candidate = f.add('Casey');
    const removed = f.add('Removed grant'); f.grant(w.id, removed);
    f.runtime.control.setWorkspaceMember(f.admin.principal, w.id, removed.principal.identityId, { role: 'viewer', status: 'removed' });
    const offboarded = f.add('Offboarded member'); f.grant(w.id, offboarded);
    f.runtime.control.setOrganizationMember(f.admin.principal, offboarded.principal.identityId, { status: 'disabled' });
    const disabledIdentity = f.add('Disabled identity'); f.grant(w.id, disabledIdentity);
    f.runtime.identities.database.prepare("UPDATE business_identities SET status='disabled' WHERE id=?").run(disabledIdentity.principal.identityId);
    const inactiveOrg = f.add('Inactive organization'); f.grant(w.id, inactiveOrg);
    f.runtime.identities.database.prepare("UPDATE organization_members SET status='disabled',revision=revision+1 WHERE identity_id=?").run(inactiveOrg.principal.identityId);
    const disabledCandidate = f.add('Disabled candidate');
    f.runtime.control.setOrganizationMember(f.admin.principal, disabledCandidate.principal.identityId, { status: 'disabled' });
    const removedOrg = f.add('Removed organization');
    f.runtime.control.setOrganizationMember(f.admin.principal, removedOrg.principal.identityId, { status: 'removed' });
    f.runtime.auth.createIdentity('Unenrolled identity', true);
    const base = `/api/business/workspaces/${w.id}`;
    const response = await f.request(base + '/audience', contributor); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { count: 4, members: [
      { name: 'Alex', role: 'manager' }, { name: 'Morgan', role: 'manager' },
      { name: 'Quinn', role: 'viewer' }, { name: 'Taylor', role: 'contributor' },
    ] });
    const candidates = await f.request(base + '/invite-candidates', manager); assert.equal(candidates.status, 200);
    assert.deepEqual(await candidates.json(), [{ id: candidate.principal.identityId, name: 'Casey' }]);
    for (const actor of [contributor, viewer]) {
      const denied = await f.request(base + '/invite-candidates', actor); assert.equal(denied.status, 404);
      assert.deepEqual(await denied.json(), { error: 'Not found.' });
    }
    assert.equal(f.runtime.control.workspaceMembership(w.id, removed.principal.identityId)?.status, 'removed');
    assert.equal(f.runtime.control.organizationMembership(removed.principal.identityId)?.status, 'active');
    assert.equal(f.runtime.identities.get(removed.principal.identityId)?.status, 'active');
  } finally { await f.close(); }
});
