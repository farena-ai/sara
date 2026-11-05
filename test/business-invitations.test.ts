import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentFixture } from './helpers/business-content.ts';

test('HTTP invitation inventories authorize their exact scope and disclose only scoped metadata', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Listed workspace' });
    const other = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Hidden workspace' });
    const manager = f.add('Manager'), contributor = f.add('Contributor'), viewer = f.add('Viewer'), outsider = f.add('Outside'), recipient = f.add('Recipient');
    f.grant(w.id, manager, 'manager'); f.grant(w.id, contributor, 'contributor'); f.grant(w.id, viewer);
    const org = f.runtime.control.createInvite(f.admin.principal, { scope: 'organization', role: 'user', subject: 'new' });
    const invite = f.runtime.control.createInvite(manager.principal, { scope: 'workspace', workspaceId: w.id, role: 'viewer', subject: recipient.principal.identityId });
    const secret = f.runtime.control.createInvite(f.admin.principal, { scope: 'workspace', workspaceId: other.id, role: 'viewer', subject: outsider.principal.identityId });
    const inventory = `/api/business/workspaces/${w.id}/invites`;
    assert.equal((await f.request('/api/business/org/invites')).status, 200);
    for (const session of [manager, contributor, viewer, outsider]) {
      assert.equal((await f.request('/api/business/org/invites', session)).status, 403);
      assert.equal((await f.request(inventory, session)).status, session === manager ? 200 : 404);
    }
    assert.equal((await fetch(f.runtime.origin + inventory, { headers: { origin: f.runtime.origin } })).status, 401);
    assert.equal((await f.request(inventory, f.admin, undefined, { origin: 'https://wrong.invalid' })).status, 403);
    assert.equal((await f.request(`/api/business/workspaces/${other.id}/invites`, manager)).status, 404);
    const rows = await (await f.request(inventory, manager)).json();
    assert.deepEqual(rows, [{ id: invite.id, scope: 'workspace', role: 'viewer', subject: 'existing', subjectLabel: 'Recipient', inviterLabel: 'Manager', expiresAt: invite.expiresAt, state: 'pending' }]);
    const body = JSON.stringify(rows);
    for (const value of [invite.code, org.id, secret.id, secret.code, other.id, recipient.principal.identityId, manager.principal.identityId, 'secret_hash', 'issuerEpoch', 'sessionId']) assert.ok(!body.includes(value), value);
    // Organization administration alone never grants workspace management.
    f.runtime.control.setWorkspaceMember(f.admin.principal, w.id, f.admin.principal.identityId, { role: 'manager', status: 'removed' });
    assert.equal((await f.request(inventory)).status, 404);
    assert.equal((await f.request('/api/business/org/invites')).status, 200);
    // Any current manager can revoke another manager's invitation.
    assert.equal((await f.request(`/api/business/invites/${invite.id}/revoke`, manager, {})).status, 200);
    assert.equal((await (await f.request(inventory, manager)).json())[0].state, 'revoked');
  } finally { await f.close(); }
});

test('inventory uses insertion order and scope filtering before the latest 100 limit without mutations', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Scoped latest' }); const target = f.add('Target');
    const expected: string[] = [];
    for (let i = 0; i < 105; i++) {
      const invite = f.runtime.control.createInvite(f.admin.principal, { scope: 'workspace', workspaceId: w.id, role: 'viewer', subject: target.principal.identityId });
      expected.unshift(invite.id);
      f.runtime.control.database.prepare('UPDATE workspace_invites SET expires_at=? WHERE id=?').run(i % 2 ? 1 : Date.now() + 99999999, invite.id);
    }
    for (let i = 0; i < 110; i++) f.runtime.control.createInvite(f.admin.principal, { scope: 'organization', role: 'user', subject: 'new' });
    const snapshot = () => JSON.stringify(['workspace_invites', 'organization_members', 'workspace_members', 'business_identities', 'business_audit'].map(table => f.runtime.control.database.prepare(`SELECT * FROM ${table}`).all()));
    const before = snapshot();
    const response = await f.request(`/api/business/workspaces/${w.id}/invites`); assert.equal(response.status, 200);
    const rows = await response.json(); assert.equal(rows.length, 100); assert.deepEqual(rows.map((row: { id: string }) => row.id), expected.slice(0, 100));
    assert.equal((await (await f.request('/api/business/org/invites')).json()).length, 100);
    assert.equal(snapshot(), before, 'GET must not consume invitations, grant access or append audit');
  } finally { await f.close(); }
});

test('accepted status precedes later revocation; pending, expired and invalidated agree with preview and redemption', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Invitation states' });
    const target = f.add('Target');
    const issue = () => f.runtime.control.createInvite(f.admin.principal, { scope: 'workspace', workspaceId: w.id, role: 'viewer', subject: target.principal.identityId });
    const accepted = issue(); f.runtime.control.redeemInvite(accepted.code, { principal: target.principal }); f.runtime.control.revokeInvite(f.admin.principal, accepted.id);
    const conflict = issue(); const removed = issue();
    const expired = f.runtime.control.createInvite(f.admin.principal, { scope: 'organization', role: 'user', subject: 'new' });
    f.runtime.control.database.prepare('UPDATE workspace_invites SET expires_at=0 WHERE id=?').run(expired.id);
    const revoked = f.runtime.control.createInvite(f.admin.principal, { scope: 'organization', role: 'user', subject: 'new' }); f.runtime.control.revokeInvite(f.admin.principal, revoked.id);
    const state = async (id: string, path: string) => { const response = await f.request(path); assert.equal(response.status, 200); return (await response.json()).find((row: { id: string }) => row.id === id).state; };
    assert.equal(await state(accepted.id, `/api/business/workspaces/${w.id}/invites`), 'accepted');
    assert.equal(await state(conflict.id, `/api/business/workspaces/${w.id}/invites`), 'invalidated');
    for (const invite of [conflict, expired, revoked]) {
      assert.equal((await f.request('/api/business/invites/preview', f.admin, { code: invite.code })).status, 404);
      assert.equal((await f.request('/api/business/invites/join', target, { code: invite.code })).status, 404);
    }
    f.runtime.control.setWorkspaceMember(f.admin.principal, w.id, target.principal.identityId, { role: 'viewer', status: 'removed' });
    assert.equal(await state(removed.id, `/api/business/workspaces/${w.id}/invites`), 'invalidated');
    assert.equal((await f.request('/api/business/invites/preview', target, { code: removed.code })).status, 404);
    assert.equal(await state(expired.id, '/api/business/org/invites'), 'expired');
    assert.equal(await state(revoked.id, '/api/business/org/invites'), 'revoked');
    const waiting = f.runtime.auth.createIdentity('Waiting', true);
    const bound = f.runtime.control.createInvite(f.admin.principal, { scope: 'organization', role: 'user', subject: waiting.principal.identityId });
    const later = f.runtime.control.createInvite(f.admin.principal, { scope: 'organization', role: 'user', subject: waiting.principal.identityId });
    f.runtime.control.redeemInvite(later.code, { principal: waiting.principal });
    assert.equal(await state(bound.id, '/api/business/org/invites'), 'invalidated');
    assert.equal((await f.request('/api/business/invites/preview', waiting, { code: bound.code })).status, 404);
  } finally { await f.close(); }
});

test('issuer revision, authentication epoch and subject access invalidation share one eligibility rule', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Live eligibility' }); const manager = f.add('Issuer'); f.grant(w.id, manager, 'manager');
    const targets = ['Role change', 'Epoch change', 'Subject change', 'Organization revision'].map(name => f.add(name));
    const issue = (n: number) => f.runtime.control.createInvite(manager.principal, { scope: 'workspace', workspaceId: w.id, role: 'viewer', subject: targets[n].principal.identityId });
    const role = issue(0);
    f.grant(w.id, manager, 'contributor'); f.grant(w.id, manager, 'manager');
    const epoch = issue(1); f.runtime.control.database.prepare('UPDATE business_identities SET auth_epoch=auth_epoch+1 WHERE id=?').run(manager.principal.identityId);
    const freshManager = f.runtime.auth.createIdentity('Current issuer', true); const org = f.runtime.control.createInvite(f.admin.principal, { scope: 'organization', role: 'user', subject: freshManager.principal.identityId }); f.runtime.control.redeemInvite(org.code, { principal: freshManager.principal }); f.grant(w.id, freshManager, 'manager');
    const subject = f.runtime.control.createInvite(freshManager.principal, { scope: 'workspace', workspaceId: w.id, role: 'viewer', subject: targets[2].principal.identityId });
    f.runtime.control.setOrganizationMember(f.admin.principal, targets[2].principal.identityId, { status: 'disabled' });
    const revision = f.runtime.control.createInvite(freshManager.principal, { scope: 'workspace', workspaceId: w.id, role: 'viewer', subject: targets[3].principal.identityId });
    f.runtime.control.setOrganizationMember(f.admin.principal, freshManager.principal.identityId, { role: 'user' });
    const response = await f.request(`/api/business/workspaces/${w.id}/invites`); assert.equal(response.status, 200); const rows = await response.json();
    for (const invite of [role, epoch, subject, revision]) {
      assert.equal(rows.find((row: { id: string }) => row.id === invite.id).state, 'invalidated');
      assert.equal((await f.request('/api/business/invites/preview', f.admin, { code: invite.code })).status, 404);
      assert.equal((await f.request('/api/business/invites/join', targets[3], { code: invite.code })).status, 404);
    }
    assert.throws(() => f.runtime.control.listInvites(manager.principal, w.id), /Not found/);
  } finally { await f.close(); }
});

test('labels reveal only accounts already visible in the authorized roster or current candidate pick-list', async () => {
  const f = await contentFixture();
  try {
    const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Label boundaries' }); const manager = f.add('Current manager'); f.grant(w.id, manager, 'manager');
    const hidden = f.add('Hidden disabled recipient'); const visible = f.add('Visible removed member'); const issuer = f.add('Hidden historical issuer'); f.grant(w.id, issuer, 'manager');
    const invite = f.runtime.control.createInvite(issuer.principal, { scope: 'workspace', workspaceId: w.id, role: 'viewer', subject: hidden.principal.identityId });
    const retained = f.runtime.control.createInvite(f.admin.principal, { scope: 'workspace', workspaceId: w.id, role: 'viewer', subject: visible.principal.identityId });
    f.grant(w.id, visible); f.runtime.control.setWorkspaceMember(f.admin.principal, w.id, visible.principal.identityId, { role: 'viewer', status: 'removed' });
    f.runtime.control.setOrganizationMember(f.admin.principal, hidden.principal.identityId, { status: 'disabled' });
    // A historical inviter may no longer appear in this workspace roster or eligible directory.
    f.runtime.control.database.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND identity_id=?').run(w.id, issuer.principal.identityId);
    f.runtime.control.setOrganizationMember(f.admin.principal, issuer.principal.identityId, { status: 'disabled' });
    const response = await f.request(`/api/business/workspaces/${w.id}/invites`, manager); assert.equal(response.status, 200); const rows = await response.json();
    const historical = rows.find((row: { id: string }) => row.id === invite.id);
    assert.equal(historical.subjectLabel, null); assert.equal(historical.inviterLabel, null);
    assert.equal(rows.find((row: { id: string }) => row.id === retained.id).subjectLabel, 'Visible removed member');
    assert.ok(!JSON.stringify(rows).includes('Hidden'));
    const organization = await (await f.request('/api/business/org/invites')).json();
    assert.ok(organization.some((row: { subjectLabel: string }) => row.subjectLabel === 'Hidden historical issuer'), 'organization administrators already see disabled accounts in their roster');
  } finally { await f.close(); }
});
