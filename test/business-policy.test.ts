import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBusinessProfile } from '../src/business/profile.ts';
import { BusinessAuth, BusinessIdentityDirectory } from '../src/business/identity.ts';

async function fixture() {
  const module = await import('../src/business/store.ts').catch(() => undefined);
  assert.ok(module, 'The independent business control store must exist');
  const dir = mkdtempSync(join(tmpdir(), 'sara-b1-policy-'));
  const profile = openBusinessProfile(dir);
  const identities = new BusinessIdentityDirectory(profile);
  const auth = new BusinessAuth(profile, identities);
  const admin = auth.claim('127.0.0.1', auth.claimCode, 'Alex', true)!;
  const store = new module.BusinessControlStore(identities, { principalActive: principal => auth.isPrincipalActive(principal) });
  const add = (name: string) => {
    const session = auth.createIdentity(name, true);
    const invite = store.createInvite(admin.principal, { scope: 'organization', role: 'user', subject: session.principal.identityId });
    store.redeemInvite(invite.code, { principal: session.principal });
    return session;
  };
  return { dir, profile, identities, auth, admin, store, add, close() { identities.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('every workspace permission matrix cell defaults to deny outside explicit membership', async () => {
  const f = await fixture();
  try {
    const workspace = f.store.createWorkspace(f.admin.principal, { name: 'Shared records', visibility: 'shared' });
    const other = f.store.createWorkspace(f.admin.principal, { name: 'Other shared records' });
    const contributor = f.add('Taylor'); const viewer = f.add('Morgan'); const outsider = f.add('Jordan');
    f.store.setWorkspaceMember(f.admin.principal, workspace.id, contributor.principal.identityId, { role: 'contributor', status: 'active' });
    f.store.setWorkspaceMember(f.admin.principal, workspace.id, viewer.principal.identityId, { role: 'viewer', status: 'active' });
    f.store.setOrganizationMember(f.admin.principal, outsider.principal.identityId, { role: 'orgadmin', status: 'active' });
    for (const [session, permitted] of [[f.admin, ['read', 'send', 'document', 'manage', 'audit']], [contributor, ['read', 'send', 'document']], [viewer, ['read']], [outsider, []]] as const) {
      for (const action of ['read', 'send', 'document', 'manage', 'audit', 'export', 'delete', 'shell', 'search-everything', '', 'constructor']) {
        if ((permitted as readonly string[]).includes(action)) assert.equal(f.store.policy.authorizeWorkspace(session.principal, workspace.id, action).workspaceId, workspace.id);
        else assert.throws(() => f.store.policy.authorizeWorkspace(session.principal, workspace.id, action));
      }
    }
    assert.throws(() => f.store.setWorkspaceMember(outsider.principal, workspace.id, outsider.principal.identityId, { role: 'manager', status: 'active' }));
    assert.throws(() => f.store.createInvite(outsider.principal, { scope: 'workspace', workspaceId: workspace.id, role: 'manager', subject: 'new' }));
    assert.throws(() => f.store.policy.authorizeWorkspace(viewer.principal, other.id, 'read'));
    const forged = { ...viewer.principal, role: 'manager' };
    assert.throws(() => f.store.policy.authorizeWorkspace(forged, workspace.id, 'read'));
    assert.throws(() => f.store.createWorkspace(f.admin.principal, { name: 'Hidden', visibility: 'private' }));
    for (const role of ['guest', 'owner', 'manager,viewer', ['manager', 'viewer']]) assert.throws(() => f.store.setWorkspaceMember(f.admin.principal, workspace.id, viewer.principal.identityId, { role, status: 'active' }));
    assert.throws(() => f.store.setWorkspaceMember(f.admin.principal, workspace.id, viewer.principal.identityId, { role: 'viewer', status: 'active', identityId: f.admin.principal.identityId }));
    assert.throws(() => f.identities.database.prepare('INSERT INTO workspace_members(workspace_id,identity_id,role,status,revision) VALUES (?,?,?,?,?)').run(workspace.id, viewer.principal.identityId, 'manager', 'active', 1));
  } finally { f.close(); }
});

test('contexts are immutable, policy-owned and live-revalidated with independent workspace revisions', async () => {
  const f = await fixture();
  try {
    const user = f.add('Taylor'); const a = f.store.createWorkspace(f.admin.principal, { name: 'A' }); const b = f.store.createWorkspace(f.admin.principal, { name: 'B' });
    for (const w of [a, b]) f.store.setWorkspaceMember(f.admin.principal, w.id, user.principal.identityId, { role: 'contributor', status: 'active' });
    const context = f.store.policy.authorizeWorkspace(user.principal, a.id, 'send');
    const other = f.store.policy.authorizeWorkspace(user.principal, b.id, 'send');
    assert.ok(Object.isFrozen(context)); assert.ok(Object.isFrozen(context.principal));
    assert.throws(() => f.store.policy.revalidateWorkspace({ ...context }, 'read'));
    f.store.setWorkspaceMember(f.admin.principal, a.id, user.principal.identityId, { role: 'viewer', status: 'active' });
    assert.throws(() => f.store.policy.revalidateWorkspace(context, 'read'));
    f.store.policy.revalidateWorkspace(other, 'send');
    f.store.setOrganizationMember(f.admin.principal, user.principal.identityId, { status: 'disabled' });
    assert.equal(f.auth.principal(user.value), undefined);
    assert.equal(f.identities.get(user.principal.identityId)!.authEpoch, 1);
    assert.throws(() => f.store.policy.revalidateWorkspace(other, 'read'));
    assert.throws(() => f.store.setOrganizationMember(f.admin.principal, user.principal.identityId, { status: 'active' }));
    assert.throws(() => f.store.setOrganizationMember(f.admin.principal, f.admin.principal.identityId, { role: 'user' }));
    // Suspension still wins over the final-workspace-manager invariant.
    f.store.setOrganizationMember(f.admin.principal, f.admin.principal.identityId, { status: 'disabled' });
    assert.throws(() => f.store.policy.authorizeWorkspace(f.admin.principal, a.id, 'read'));
    f.identities.database.prepare("UPDATE business_identities SET status='active' WHERE id=?").run(f.admin.principal.identityId);
    f.identities.database.prepare("UPDATE organization_members SET role='user',status='active' WHERE identity_id=?").run(f.admin.principal.identityId);
    const { BusinessControlStore } = await import('../src/business/store.ts'); new BusinessControlStore(f.identities, { principalActive: principal => f.auth.isPrincipalActive(principal) });
    assert.equal(f.store.organizationMembership(f.admin.principal.identityId)!.role, 'user', 'Bootstrap may never resurrect admin authority');
  } finally { f.close(); }
});

test('malformed role/status values and unknown organization fields never become grants', async () => {
  const f = await fixture();
  try {
    const user = f.add('Taylor'); const workspace = f.store.createWorkspace(f.admin.principal, { name: 'Shared' });
    for (const input of [{ role: ['orgadmin'] }, { status: ['active'] }, { role: 'user', status: 'active', actorId: f.admin.principal.identityId }, { role: null }, { status: null }, {}]) {
      assert.throws(() => f.store.setOrganizationMember(f.admin.principal, user.principal.identityId, input), 'Malformed organization authority must be refused');
    }
    assert.equal(f.store.organizationMembership(user.principal.identityId)!.role, 'user');
    assert.throws(() => f.store.setWorkspaceMember(f.admin.principal, workspace.id, user.principal.identityId, { role: 'viewer', status: ['active'] }));
    assert.throws(() => f.store.createInvite(f.admin.principal, { scope: ['organization'], role: 'user', subject: 'new' }));
    for (const input of [{ scope: 'organization', role: 'user', subject: 'new', expiresInSeconds: null }, { scope: 'organization', role: 'user', subject: 'new', expiresInSeconds: '60' }]) assert.throws(() => f.store.createInvite(f.admin.principal, input));
  } finally { f.close(); }
});

test('removal, session revocation, unknown stored roles and policy revisions invalidate context without other workspace revocation', async () => {
  const f = await fixture();
  try {
    const user = f.add('Taylor'); const a = f.store.createWorkspace(f.admin.principal, { name: 'A' }); const b = f.store.createWorkspace(f.admin.principal, { name: 'B' });
    for (const w of [a, b]) f.store.setWorkspaceMember(f.admin.principal, w.id, user.principal.identityId, { role: 'contributor', status: 'active' });
    const aContext = f.store.policy.authorizeWorkspace(user.principal, a.id, 'read'); const bContext = f.store.policy.authorizeWorkspace(user.principal, b.id, 'read');
    f.store.setWorkspaceMember(f.admin.principal, a.id, user.principal.identityId, { role: 'contributor', status: 'removed' });
    assert.throws(() => f.store.policy.revalidateWorkspace(aContext, 'read')); f.store.policy.revalidateWorkspace(bContext, 'read');
    assert.equal(f.auth.principal(user.value)?.authEpoch, 0);
    f.identities.database.prepare('UPDATE workspaces SET policy_revision=policy_revision+1 WHERE id=?').run(b.id);
    assert.throws(() => f.store.policy.revalidateWorkspace(bContext, 'read'));
    const newContext = f.store.policy.authorizeWorkspace(user.principal, b.id, 'read');
    f.identities.database.exec('PRAGMA ignore_check_constraints=ON');
    f.identities.database.prepare("UPDATE workspace_members SET role='constructor' WHERE workspace_id=? AND identity_id=?").run(b.id, user.principal.identityId);
    assert.throws(() => f.store.policy.revalidateWorkspace(newContext, 'read'));
    f.identities.database.prepare("UPDATE workspace_members SET role='viewer' WHERE workspace_id=? AND identity_id=?").run(b.id, user.principal.identityId);
    f.identities.database.exec('PRAGMA ignore_check_constraints=OFF');
    const afterRole = f.store.policy.authorizeWorkspace(user.principal, b.id, 'read');
    f.auth.logout(user.principal); assert.throws(() => f.store.policy.revalidateWorkspace(afterRole, 'read'));
    assert.throws(() => f.store.policy.authorizeWorkspace({ ...f.admin.principal, credentialKind: 'api' } as never, b.id, 'read'));
  } finally { f.close(); }
});

test('principal expiry comes from the verified session and post-await policy rejects elapsed expiry', async () => {
  const f = await fixture();
  try {
    const principal = f.auth.principal(f.admin.value)!;
    assert.equal(typeof (principal as unknown as Record<string, unknown>).expiresAt, 'number');
    assert.equal((principal as unknown as Record<string, unknown>).expiresAt, Number(f.admin.value.split('.')[2]));
    assert.equal(f.auth.isPrincipalActive({ ...principal, expiresAt: Date.now() - 1 } as never), false);
  } finally { f.close(); }
});

test('invitation authority rejects unrecognized stored organization roles for issuer and subject', async () => {
  const f = await fixture();
  try {
    const user = f.add('Taylor'); const workspace = f.store.createWorkspace(f.admin.principal, { name: 'Shared' });
    const invite = f.store.createInvite(f.admin.principal, { scope: 'workspace', workspaceId: workspace.id, role: 'viewer', subject: user.principal.identityId });
    f.identities.database.exec('PRAGMA ignore_check_constraints=ON');
    f.identities.database.prepare("UPDATE organization_members SET role='unknown' WHERE identity_id=?").run(f.admin.principal.identityId);
    assert.throws(() => f.store.previewInvite(invite.code), 'Unknown issuer role must not confer invitation authority');
    f.identities.database.prepare("UPDATE organization_members SET role='orgadmin' WHERE identity_id=?").run(f.admin.principal.identityId);
    f.identities.database.prepare("UPDATE organization_members SET role='unknown' WHERE identity_id=?").run(user.principal.identityId);
    assert.throws(() => f.store.previewInvite(invite.code), 'Unknown subject role must not receive workspace membership');
  } finally { f.close(); }
});
