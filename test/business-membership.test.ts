import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import { openBusinessProfile } from '../src/business/profile.ts';
import { createBusinessRuntime } from '../src/business/runtime.ts';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sara-b1-http-'));
  const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
  const runtime = createBusinessRuntime({ profile: openBusinessProfile(dir), origin: `http://127.0.0.1:${port}` });
  await new Promise<void>(r => runtime.server.listen(port, '127.0.0.1', r));
  const request = (path: string, data?: unknown, cookie?: string, extra: Record<string, string> = {}) => fetch(runtime.origin + path, {
    method: data === undefined ? 'GET' : 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const claimed = await request('/api/business/claim', { code: runtime.auth.claimCode, name: 'Alex', confirm18: true });
  const cookie = claimed.headers.get('set-cookie')!.split(';')[0];
  const admin = (await claimed.json()).principal;
  return { dir, runtime, request, cookie, admin, async close() { await runtime.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('actual HTTP management routes derive actors from cookies, refuse fields and hide nonmember resources', async () => {
  const f = await fixture();
  try {
    const create = await f.request('/api/business/workspaces', { name: 'Planning', visibility: 'shared' }, f.cookie);
    assert.equal(create.status, 201, 'The authenticated shared-workspace creation route must exist');
    const workspace = await create.json();
    assert.equal((await f.request('/api/business/org/users', undefined, f.cookie)).status, 200);
    assert.equal((await f.request('/api/business/workspaces', { name: 'Forged', actorId: f.admin.identityId }, f.cookie)).status, 400);
    assert.equal((await f.request('/api/business/workspaces', { name: 'Wrong origin' }, f.cookie, { origin: 'https://wrong.invalid' })).status, 403);
    assert.equal((await f.request('/api/business/workspaces')).status, 401);
    const outsider = f.runtime.auth.createIdentity('Taylor', true);
    const invite = await f.request('/api/business/org/invites', { role: 'orgadmin', subject: outsider.principal.identityId }, f.cookie);
    assert.equal(invite.status, 201); const issued = await invite.json();
    const outsiderCookie = `sara_business_session=${outsider.value}`;
    assert.equal((await f.request('/api/business/invites/join', { code: issued.code }, outsiderCookie)).status, 200);
    assert.equal((await f.request('/api/business/workspaces', undefined, outsiderCookie)).status, 200);
    assert.deepEqual(await (await f.request('/api/business/workspaces', undefined, outsiderCookie)).json(), []);
    for (const path of [`/api/business/workspaces/${workspace.id}`, `/api/business/workspaces/${workspace.id}/members`, '/api/business/workspaces/00000000-0000-4000-8000-000000000000']) {
      const response = await f.request(path, undefined, outsiderCookie); assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'Not found.' });
    }
    assert.equal((await f.request(`/api/business/workspaces/${workspace.id}/members/${outsider.principal.identityId}`, { role: 'manager', status: 'active' }, outsiderCookie)).status, 404);
    assert.equal((await f.request(`/api/business/workspaces/${workspace.id}/invites`, { role: 'viewer', subject: f.admin.identityId }, outsiderCookie)).status, 404);
    assert.equal((await f.request('/api/business/invites/join', { code: issued.code, identityId: f.admin.identityId }, outsiderCookie)).status, 400);
    const adminContext = f.runtime.control.policy.authorizeWorkspace(f.admin, workspace.id, 'read');
    await f.request('/api/business/logout', {}, f.cookie);
    assert.throws(() => f.runtime.control.policy.revalidateWorkspace(adminContext, 'read'));
  } finally { await f.close(); }
});

test('single-use invitations keep secrets hashed and enforce subject, adult confirmation, expiry and live issuer', async () => {
  const f = await fixture();
  try {
    const response = await f.request('/api/business/workspaces', { name: 'Shared' }, f.cookie); assert.equal(response.status, 201);
    const workspace = await response.json();
    const issue = async (data: unknown) => { const r = await f.request(`/api/business/workspaces/${workspace.id}/invites`, data, f.cookie); assert.equal(r.status, 201); return r.json(); };
    const issueOrg = async () => { const r = await f.request('/api/business/org/invites', { role: 'user', subject: 'new' }, f.cookie); assert.equal(r.status, 201); return r.json(); };
    const invite = await issueOrg();
    const row = f.runtime.identities.database.prepare('SELECT * FROM workspace_invites WHERE id=?').get(invite.id)!;
    assert.notEqual(row.secret_hash, invite.code); assert.equal(String(row.secret_hash).length, 64); assert.ok(!JSON.stringify(row).includes(invite.code));
    assert.equal((await f.request('/api/business/invites/preview', { code: invite.code })).status, 200);
    assert.equal((await f.request('/api/business/invites/join', { code: invite.code, name: 'Taylor' })).status, 400);
    const raced = await Promise.all([f.request('/api/business/invites/join', { code: invite.code, name: 'Taylor', confirm18: true }), f.request('/api/business/invites/join', { code: invite.code, name: 'Morgan', confirm18: true })]);
    assert.deepEqual(raced.map(r => r.status).sort(), [201, 404]);
    const joined = raced.find(r => r.status === 201)!; assert.ok(joined.headers.get('set-cookie'));
    assert.equal((await f.request('/api/business/invites/preview', { code: invite.code })).status, 404);
    const expired = await issueOrg();
    f.runtime.identities.database.prepare('UPDATE workspace_invites SET expires_at=0 WHERE id=?').run(expired.id);
    assert.equal((await f.request('/api/business/invites/join', { code: expired.code, name: 'Expired', confirm18: true })).status, 404);
    const revoked = await issueOrg();
    assert.equal((await f.request(`/api/business/invites/${revoked.id}/revoke`, {}, f.cookie)).status, 200);
    assert.equal((await f.request('/api/business/invites/preview', { code: revoked.code })).status, 404);
    const existing = f.runtime.auth.createIdentity('Casey', true); const wrong = f.runtime.auth.createIdentity('Jordan', true);
    const org = await (await f.request('/api/business/org/invites', { role: 'user', subject: existing.principal.identityId }, f.cookie)).json();
    assert.equal((await f.request('/api/business/invites/join', { code: org.code }, `sara_business_session=${wrong.value}`)).status, 404);
    assert.equal((await f.request('/api/business/invites/join', { code: org.code }, `sara_business_session=${existing.value}`)).status, 200);
    const suspended = await issue({ role: 'viewer', subject: existing.principal.identityId });
    assert.equal((await f.request(`/api/business/org/users/${existing.principal.identityId}`, { status: 'disabled' }, f.cookie)).status, 200);
    assert.equal((await f.request('/api/business/invites/join', { code: suspended.code }, `sara_business_session=${existing.value}`)).status, 404);
    const otherOrg = await (await f.request('/api/business/org/invites', { role: 'user', subject: wrong.principal.identityId }, f.cookie)).json();
    assert.equal((await f.request('/api/business/invites/join', { code: otherOrg.code }, `sara_business_session=${wrong.value}`)).status, 200);
    const outstanding = await issue({ role: 'viewer', subject: wrong.principal.identityId });
    f.runtime.identities.database.prepare("UPDATE workspace_members SET status='removed',revision=revision+1 WHERE workspace_id=? AND identity_id=?").run(workspace.id, f.admin.identityId);
    assert.equal((await f.request('/api/business/invites/join', { code: outstanding.code }, `sara_business_session=${wrong.value}`)).status, 404);
  } finally { await f.close(); }
});

test('workspace managers cannot create identities or implicit organization members through invitations', async () => {
  const f = await fixture();
  try {
    const response = await f.request('/api/business/workspaces', { name: 'Restricted enrollment' }, f.cookie); assert.equal(response.status, 201);
    const workspace = await response.json();
    const before = f.runtime.identities.database.prepare('SELECT COUNT(*) AS n FROM business_identities').get()!.n;
    const denied = await f.request(`/api/business/workspaces/${workspace.id}/invites`, { role: 'viewer', subject: 'new' }, f.cookie);
    assert.equal(denied.status, 400, 'Only organization-admin invites may create new identities');
    assert.equal(f.runtime.identities.database.prepare('SELECT COUNT(*) AS n FROM business_identities').get()!.n, before);
    assert.equal(f.runtime.identities.database.prepare('SELECT COUNT(*) AS n FROM organization_members').get()!.n, before);
    const unenrolled = f.runtime.auth.createIdentity('Unenrolled', true);
    assert.equal((await f.request(`/api/business/workspaces/${workspace.id}/invites`, { role: 'viewer', subject: unenrolled.principal.identityId }, f.cookie)).status, 404);
  } finally { await f.close(); }
});

test('two SQLite connections serialize last-manager removal and invite redemption', async () => {
  const f = await fixture();
  try {
    const response = await f.request('/api/business/workspaces', { name: 'Concurrent' }, f.cookie); assert.equal(response.status, 201);
    const workspace = await response.json(); const manager = f.runtime.auth.createIdentity('Taylor', true);
    const enroll = await (await f.request('/api/business/org/invites', { role: 'user', subject: manager.principal.identityId }, f.cookie)).json();
    await f.request('/api/business/invites/join', { code: enroll.code }, `sara_business_session=${manager.value}`);
    assert.equal((await f.request(`/api/business/workspaces/${workspace.id}/members/${manager.principal.identityId}`, { role: 'manager', status: 'active' }, f.cookie)).status, 200);
    const workerCode = `const {parentPort,workerData}=require('node:worker_threads'); (async()=>{const {BusinessIdentityDirectory,BusinessAuth}=await import(workerData.identity);const {BusinessControlStore}=await import(workerData.store);const identities=new BusinessIdentityDirectory(workerData.profile);const auth=new BusinessAuth(workerData.profile,identities);const store=new BusinessControlStore(identities,{principalActive:p=>auth.isPrincipalActive(p)});parentPort.postMessage('ready');parentPort.once('message',()=>{try { if(workerData.code) store.redeemInvite(workerData.code,{principal:workerData.actor}); else store.setWorkspaceMember(workerData.actor,workerData.workspaceId,workerData.actor.identityId,{role:'viewer',status:'active'}); parentPort.postMessage('ok'); }catch {parentPort.postMessage('denied');}finally{identities.close();}});})().catch(e=>{parentPort.postMessage(String(e));});`;
    const race = async (actors: unknown[], code?: string) => {
      const workers = actors.map(actor => new Worker(workerCode, { eval: true, workerData: { identity: new URL('../src/business/identity.ts', import.meta.url).href, store: new URL('../src/business/store.ts', import.meta.url).href, profile: f.runtime.identities ? openBusinessProfile(f.dir) : null, actor, workspaceId: workspace.id, code } }));
      try {
        await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => { worker.once('error', reject); worker.once('message', message => message === 'ready' ? resolve() : reject(new Error(String(message)))); })));
        const results = workers.map(worker => new Promise<string>((resolve, reject) => { worker.once('error', reject); worker.once('message', resolve); }));
        workers.forEach(worker => worker.postMessage('go')); return await Promise.all(results);
      } finally { await Promise.all(workers.map(worker => worker.terminate())); }
    };
    assert.deepEqual((await race([f.admin, manager.principal])).sort(), ['denied', 'ok']);
    const remaining = f.runtime.identities.database.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id=? AND role='manager' AND status='active'").get(workspace.id); assert.equal(remaining!.n, 1);
    const invite = await (await f.request('/api/business/org/invites', { role: 'user', subject: 'new' }, f.cookie)).json();
    // Existing identities use exact subjects, so race two submissions by the same invited identity.
    const target = f.runtime.auth.createIdentity('Casey', true);
    const bound = await (await f.request('/api/business/org/invites', { role: 'user', subject: target.principal.identityId }, f.cookie)).json();
    assert.ok(invite.code); assert.deepEqual((await race([target.principal, target.principal], bound.code)).sort(), ['denied', 'ok']);
  } finally { await f.close(); }
});

test('actual contributor/viewer requests cannot reach management and concurrent HTTP demotions preserve a manager', async () => {
  const f = await fixture();
  try {
    const workspace = await (await f.request('/api/business/workspaces', { name: 'Roles' }, f.cookie)).json();
    const sessions = [];
    for (const role of ['contributor', 'viewer', 'manager']) {
      const session = f.runtime.auth.createIdentity(role, true); const cookie = `sara_business_session=${session.value}`;
      const invite = await (await f.request('/api/business/org/invites', { role: 'user', subject: session.principal.identityId }, f.cookie)).json();
      assert.equal((await f.request('/api/business/invites/join', { code: invite.code }, cookie)).status, 200);
      assert.equal((await f.request(`/api/business/workspaces/${workspace.id}/members/${session.principal.identityId}`, { role, status: 'active' }, f.cookie)).status, 200);
      sessions.push({ ...session, cookie, role });
      assert.equal((await f.request(`/api/business/workspaces/${workspace.id}`, undefined, cookie)).status, 200);
      assert.equal((await f.request('/api/business/org/users', undefined, cookie)).status, 403);
      assert.equal((await f.request('/api/business/workspaces', { name: 'Unauthorized' }, cookie)).status, 403);
      assert.equal((await f.request('/api/business/org/invites', { role: 'user', subject: 'new' }, cookie)).status, 403);
      if (role !== 'manager') {
        assert.equal((await f.request(`/api/business/workspaces/${workspace.id}/members`, undefined, cookie)).status, 404);
        assert.equal((await f.request(`/api/business/workspaces/${workspace.id}/members/${session.principal.identityId}`, { role: 'manager', status: 'active' }, cookie)).status, 404);
        assert.equal((await f.request(`/api/business/workspaces/${workspace.id}/invites`, { role: 'viewer', subject: f.admin.identityId }, cookie)).status, 404);
      }
    }
    const manager = sessions.find(session => session.role === 'manager')!;
    const demotions = await Promise.all([
      f.request(`/api/business/workspaces/${workspace.id}/members/${f.admin.identityId}`, { role: 'viewer', status: 'active' }, f.cookie),
      f.request(`/api/business/workspaces/${workspace.id}/members/${manager.principal.identityId}`, { role: 'viewer', status: 'active' }, manager.cookie),
    ]);
    assert.deepEqual(demotions.map(response => response.status).sort(), [200, 409]);
    const retained = f.runtime.identities.database.prepare("SELECT COUNT(*) AS n FROM workspace_members m JOIN organization_members o ON o.identity_id=m.identity_id JOIN business_identities i ON i.id=m.identity_id WHERE workspace_id=? AND m.role='manager' AND m.status='active' AND o.status='active' AND i.status='active'").get(workspace.id);
    assert.equal(retained!.n, 1);
  } finally { await f.close(); }
});

test('invites survive ordinary issuer logout but fail after issuer grant revocation or recipient removal', async () => {
  const f = await fixture();
  try {
    const workspace = await (await f.request('/api/business/workspaces', { name: 'Issuer authority' }, f.cookie)).json();
    const member = async (name: string, role = 'user') => {
      const session = f.runtime.auth.createIdentity(name, true); const cookie = `sara_business_session=${session.value}`;
      const invite = await (await f.request('/api/business/org/invites', { role, subject: session.principal.identityId }, f.cookie)).json();
      assert.equal((await f.request('/api/business/invites/join', { code: invite.code }, cookie)).status, 200);
      return { ...session, cookie };
    };
    const manager = await member('Taylor'); const recipient = await member('Morgan'); const recipient2 = await member('Casey'); const otherAdmin = await member('Jordan', 'orgadmin');
    assert.equal((await f.request(`/api/business/workspaces/${workspace.id}/members/${manager.principal.identityId}`, { role: 'manager', status: 'active' }, f.cookie)).status, 200);
    const invite = async (subject: string) => { const r = await f.request(`/api/business/workspaces/${workspace.id}/invites`, { role: 'viewer', subject }, manager.cookie); assert.equal(r.status, 201); return r.json(); };
    const usable = await invite(recipient.principal.identityId); const revoked = await invite(recipient2.principal.identityId);
    assert.equal((await f.request('/api/business/logout', {}, manager.cookie)).status, 200);
    assert.equal((await f.request('/api/business/invites/preview', { code: usable.code }, recipient.cookie)).status, 200);
    assert.equal((await f.request('/api/business/invites/join', { code: usable.code }, recipient.cookie)).status, 200);
    assert.equal((await f.request(`/api/business/workspaces/${workspace.id}/members/${manager.principal.identityId}`, { role: 'contributor', status: 'active' }, f.cookie)).status, 200);
    assert.equal((await f.request('/api/business/invites/join', { code: revoked.code }, recipient2.cookie)).status, 404);
    const removedSubject = await (await f.request(`/api/business/workspaces/${workspace.id}/invites`, { role: 'viewer', subject: recipient2.principal.identityId }, f.cookie)).json();
    // Regranting the same role cannot resurrect an older invitation.
    assert.equal((await f.request(`/api/business/workspaces/${workspace.id}/members/${manager.principal.identityId}`, { role: 'manager', status: 'active' }, f.cookie)).status, 200);
    assert.equal((await f.request('/api/business/invites/join', { code: revoked.code }, recipient2.cookie)).status, 404);
    const outstanding = await (await f.request('/api/business/org/invites', { role: 'user', subject: 'new' }, f.cookie)).json();
    const afterLogout = await (await f.request('/api/business/org/invites', { role: 'user', subject: 'new' }, f.cookie)).json();
    await f.request('/api/business/logout', {}, f.cookie);
    assert.equal((await f.request('/api/business/invites/join', { code: afterLogout.code, name: 'New colleague', confirm18: true })).status, 201);
    assert.equal((await f.request(`/api/business/org/users/${f.admin.identityId}`, { role: 'user' }, otherAdmin.cookie)).status, 200);
    assert.equal((await f.request('/api/business/invites/join', { code: outstanding.code, name: 'Denied', confirm18: true })).status, 404);
    assert.equal((await f.request(`/api/business/org/users/${recipient2.principal.identityId}`, { status: 'removed' }, otherAdmin.cookie)).status, 200);
    assert.equal((await f.request('/api/business/invites/join', { code: removedSubject.code }, recipient2.cookie)).status, 404);
    const targetInvite = await (await f.request('/api/business/org/invites', { role: 'user', subject: 'new' }, otherAdmin.cookie)).json();
    assert.equal((await f.request(`/api/business/org/users/${otherAdmin.principal.identityId}`, { status: 'disabled' }, otherAdmin.cookie)).status, 200);
    assert.equal((await f.request('/api/business/invites/join', { code: targetInvite.code, name: 'Denied', confirm18: true })).status, 404);
  } finally { await f.close(); }
});

test('invitation attempts are bounded independently of authenticated logout and code-bearing URLs are unsupported', async () => {
  const f = await fixture();
  try {
    const issued = await (await f.request('/api/business/org/invites', { role: 'user', subject: 'new' }, f.cookie)).json();
    assert.equal((await f.request(`/api/business/invites/preview?code=${encodeURIComponent(issued.code)}`)).status, 404);
    for (let i = 0; i < 30; i++) assert.equal((await f.request('/api/business/invites/preview', { code: 'invalid' })).status, 404);
    assert.equal((await f.request('/api/business/invites/preview', { code: issued.code })).status, 429);
    assert.equal((await f.request('/api/business/logout', {}, f.cookie)).status, 200);
  } finally { await f.close(); }
});

test('organization removal revokes the sole workspace manager and retains workspace records without administrator content access', async () => {
  const f = await fixture();
  try {
    const created = await f.request('/api/business/workspaces', { name: 'Retained shared records' }, f.cookie);
    assert.equal(created.status, 201); const workspace = await created.json();
    const members = [];
    for (const role of ['manager', 'viewer']) {
      const session = f.runtime.auth.createIdentity(role, true); const cookie = `sara_business_session=${session.value}`;
      const invitation = await (await f.request('/api/business/org/invites', { role: 'user', subject: session.principal.identityId }, f.cookie)).json();
      assert.equal((await f.request('/api/business/invites/join', { code: invitation.code }, cookie)).status, 200);
      assert.equal((await f.request(`/api/business/workspaces/${workspace.id}/members/${session.principal.identityId}`, { role, status: 'active' }, f.cookie)).status, 200);
      members.push({ ...session, cookie, role });
    }
    const manager = members.find(member => member.role === 'manager')!;
    const viewer = members.find(member => member.role === 'viewer')!;
    // Organization administration and content membership remain separate after the administrator leaves.
    assert.equal((await f.request(`/api/business/workspaces/${workspace.id}/members/${f.admin.identityId}`, { role: 'manager', status: 'removed' }, f.cookie)).status, 200);
    assert.equal((await f.request(`/api/business/workspaces/${workspace.id}`, undefined, f.cookie)).status, 404);
    const managerContext = f.runtime.policy.authorizeWorkspace(manager.principal, workspace.id, 'read');
    const viewerContext = f.runtime.policy.authorizeWorkspace(viewer.principal, workspace.id, 'read');
    const managerGrant = f.runtime.control.workspaceMembership(workspace.id, manager.principal.identityId);
    const viewerGrant = f.runtime.control.workspaceMembership(workspace.id, viewer.principal.identityId);
    const registry = f.runtime.control.workspace(workspace.id);
    const removed = await f.request(`/api/business/org/users/${manager.principal.identityId}`, { status: 'removed' }, f.cookie);
    assert.equal(removed.status, 200, 'Organization offboarding must not be held hostage by the last-workspace-manager guard');
    assert.equal(f.runtime.auth.principal(manager.value), undefined);
    assert.throws(() => f.runtime.policy.revalidateWorkspace(managerContext, 'read'));
    assert.equal((await f.request(`/api/business/workspaces/${workspace.id}`, undefined, manager.cookie)).status, 401);
    assert.equal(f.runtime.control.organizationMembership(manager.principal.identityId)!.status, 'removed');
    assert.equal(f.runtime.identities.get(manager.principal.identityId)!.authEpoch, manager.principal.authEpoch + 1);
    assert.deepEqual(f.runtime.control.workspaceMembership(workspace.id, manager.principal.identityId), managerGrant);
    assert.deepEqual(f.runtime.control.workspaceMembership(workspace.id, viewer.principal.identityId), viewerGrant);
    assert.deepEqual(f.runtime.control.workspace(workspace.id), registry);
    f.runtime.policy.revalidateWorkspace(viewerContext, 'read');
    assert.equal((await f.request(`/api/business/workspaces/${workspace.id}`, undefined, viewer.cookie)).status, 200);
    assert.equal((await f.request(`/api/business/workspaces/${workspace.id}`, undefined, f.cookie)).status, 404);
    assert.equal((await f.request(`/api/business/workspaces/${workspace.id}/members/${f.admin.identityId}`, { role: 'manager', status: 'active' }, f.cookie)).status, 404);
  } finally { await f.close(); }
});
