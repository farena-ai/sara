import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentFixture } from './helpers/business-content.ts';
import { BusinessAccessError } from '../src/business/policy.ts';

test('actual document and upload POSTs are scoped, attributed and deny viewers before mutation', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Documents' }); const base = `/api/business/workspaces/${w.id}`;
    const contributor = f.add('Morgan'); const viewer = f.add('Reader'); f.grant(w.id, contributor, 'contributor'); f.grant(w.id, viewer);
    const payload = { title: 'Guide', mime: 'text/markdown', body: '# HELLO_CANARY' };
    assert.equal((await f.request(base + '/documents', viewer, payload)).status, 404);
    assert.deepEqual(await (await f.request(base + '/documents', viewer)).json(), []);
    const created = await f.request(base + '/documents', contributor, payload); assert.equal(created.status, 201);
    const doc = await created.json(); assert.equal(doc.actorId, contributor.principal.identityId); assert.equal(doc.body, payload.body);
    const uploaded = await f.request(base + '/uploads', contributor, { name: 'guide.md', mime: 'text/markdown', contentBase64: Buffer.from('UNTRUSTED_DOCUMENT').toString('base64') });
    assert.equal(uploaded.status, 201); const upload = await uploaded.json(); assert.equal(upload.body, 'UNTRUSTED_DOCUMENT');
    const other = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Other' });
    assert.equal((await f.request(`/api/business/workspaces/${other.id}/documents/${doc.id}`)).status, 404);
    for (const invalid of [
      { ...payload, mime: 'application/pdf' }, { ...payload, body: '\ud800' }, { ...payload, body: 'x'.repeat(32769) }, { ...payload, workspaceId: other.id },
    ]) assert.equal((await f.request(base + '/documents', contributor, invalid)).status, 400);
    for (const name of ['../outside.txt', 'C:\\outside.txt', 'https://example.invalid/x.txt', 'a\u0000.txt', 'report.pdf', '.hidden']) {
      assert.equal((await f.request(base + '/uploads', contributor, { name, mime: 'text/plain', contentBase64: 'eA==' })).status, 400, name);
    }
    for (const contentBase64 of ['/w==', 'eA', '!!!!', Buffer.alloc(32769).toString('base64')]) assert.equal((await f.request(base + '/uploads', contributor, { name: 'a.txt', mime: 'text/plain', contentBase64 })).status, 400);
  } finally { await f.close(); }
});

test('awaited document staging rechecks access, and the final live guard can still roll back the write', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Staging' }); const actor = f.add('Writer'); f.grant(w.id, actor, 'contributor');
    const context = f.context(w.id, actor);
    const pending = f.runtime.documents.upload(context, { name: 'scoped.txt', mime: 'text/plain', contentBase64: Buffer.from('NOT_COMMITTED').toString('base64') });
    f.runtime.control.setWorkspaceMember(f.admin.principal, w.id, actor.principal.identityId, { role: 'viewer', status: 'active' }); await assert.rejects(pending);
    assert.equal((await f.runtime.workspaces.openWorkspace(f.context(w.id)).documents()).length, 0);
    let guards = 0;
    await assert.rejects(f.runtime.documents.create(f.context(w.id), { title: 'Rollback', mime: 'text/plain', body: 'MUST_ROLL_BACK' }, () => { if (++guards === 4) throw new BusinessAccessError(404); }));
    assert.equal((await f.runtime.workspaces.openWorkspace(f.context(w.id)).documents()).length, 0);
  } finally { await f.close(); }
});
