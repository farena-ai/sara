// W3.3 team workspace for business mode (docs/design/W3_TEAM.md): team roles owner/admin/member/guest
// with one permission matrix, SSO groups mapped to those roles, a shared team inbox per workspace
// (assign, reply as the team with approval by role), approvals routed by role (spend over the
// organization's limit needs an administrator) and the audit export filtered by who and what.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TEAM_MATRIX, TEAM_ROLES, teamCan, ssoGroupRole } from '../src/business/team.ts';
import { contentFixture } from './helpers/business-content.ts';

type Fixture = Awaited<ReturnType<typeof contentFixture>>;
const json = async (r: Response) => { const text = await r.text(); try { return JSON.parse(text); } catch { return text; } };

async function team(f: Fixture) {
  const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Support' });
  const other = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Finance' });
  const lead = f.add('Morgan Lead'); const agent = f.add('Blake Agent'); const reader = f.add('Casey Reader');
  const guest = f.add('Gale Guest'); const outsider = f.add('Drew Outside'); const boss = f.add('Riley Admin');
  f.grant(w.id, lead, 'manager'); f.grant(w.id, agent, 'contributor'); f.grant(w.id, reader, 'viewer');
  f.grant(w.id, guest, 'contributor'); f.grant(w.id, boss, 'contributor'); f.grant(other.id, outsider, 'manager');
  const setRole = (s: { principal: { identityId: string } }, role: string, by = f.admin) => f.request(`/api/business/team/people/${s.principal.identityId}`, by, { role });
  assert.equal((await setRole(guest, 'guest')).status, 200);
  assert.equal((await setRole(boss, 'admin')).status, 200);
  return { w, other, lead, agent, reader, guest, outsider, boss, setRole, base: `/api/business/workspaces/${w.id}` };
}

test('team matrix: four roles, every action names who may do it, and guests can never manage', () => {
  assert.deepEqual([...TEAM_ROLES], ['owner', 'admin', 'member', 'guest']);
  const ids = TEAM_MATRIX.map(row => row.id);
  for (const id of ['team.roles', 'team.settings', 'audit.export', 'inbox.read', 'inbox.work', 'inbox.reply.direct', 'approval.request', 'approval.decide', 'approval.decide.over', 'workspace.read', 'workspace.write']) assert.ok(ids.includes(id), id);
  for (const row of TEAM_MATRIX) {
    assert.ok(row.label.length > 3 && row.roles.every(r => (TEAM_ROLES as readonly string[]).includes(r)), row.id);
    if (row.id !== 'workspace.read' && row.id !== 'team.view') assert.ok(!row.roles.includes('guest'), `guest must not ${row.id}`);
  }
  assert.equal(teamCan('owner', 'team.roles'), true);
  assert.equal(teamCan('admin', 'approval.decide.over'), true);
  assert.equal(teamCan('member', 'approval.decide.over'), false);
  assert.equal(teamCan('guest', 'inbox.read'), false);
  assert.equal(teamCan('guest', 'workspace.read'), true);
});

test('SSO groups map to team roles: admin beats member beats guest, nobody listed is refused', () => {
  const config = { adminGroups: ['A'], memberGroups: ['M'], guestGroups: ['G'] };
  assert.deepEqual(ssoGroupRole(config, ['G', 'M']), { role: 'user', guest: false });
  assert.deepEqual(ssoGroupRole(config, ['G', 'A']), { role: 'orgadmin', guest: false });
  assert.deepEqual(ssoGroupRole(config, ['G']), { role: 'user', guest: true });
  assert.equal(ssoGroupRole(config, ['other']), undefined);
  assert.equal(ssoGroupRole({ adminGroups: [], memberGroups: [], guestGroups: [] }, ['x']), null);
});

test('team roles: owner/admin/member/guest per person, admins change them, the owner stays', async () => {
  const f = await contentFixture();
  try {
    const { agent, guest, boss, lead, setRole } = await team(f);
    const mine = async (s = f.admin) => json(await f.request('/api/business/team', s));
    assert.equal((await mine()).role, 'owner');
    assert.equal((await mine(boss)).role, 'admin');
    assert.equal((await mine(agent)).role, 'member');
    assert.equal((await mine(guest)).role, 'guest');
    const view = await mine();
    assert.ok(Array.isArray(view.people) && view.people.some((p: { name: string; role: string }) => p.name === 'Gale Guest' && p.role === 'guest'));
    assert.deepEqual(view.matrix.map((r: { id: string }) => r.id), TEAM_MATRIX.map(r => r.id));
    assert.equal((await mine(agent)).people, undefined, 'members do not get the roster');
    // Members cannot change roles; nobody changes the owner; an admin may.
    assert.equal((await setRole(lead, 'admin', agent)).status, 403);
    assert.equal((await setRole(f.admin, 'member', boss)).status, 409);
    assert.equal((await setRole(lead, 'guest', boss)).status, 200);
    assert.equal((await mine(lead)).role, 'guest');
    assert.equal((await setRole(lead, 'member', boss)).status, 200);
    assert.equal((await setRole(lead, 'owner')).status, 400);
    assert.equal((await f.request(`/api/business/team/people/${lead.principal.identityId}`, f.admin, { role: 'member', extra: 1 })).status, 400);
  } finally { await f.close(); }
});

test('guests only read: a guest with a contributor grant cannot write, see the inbox or approvals', async () => {
  const f = await contentFixture();
  try {
    const { guest, agent, base } = await team(f);
    assert.equal((await f.request(`${base}/conversations`, guest)).status, 200, 'guests still read shared conversations');
    assert.equal((await f.request(`${base}/pages`, guest, { title: 'x', body: 'y' })).status, 404);
    assert.equal((await f.request(`${base}/inbox`, guest)).status, 404);
    assert.equal((await f.request(`${base}/approvals`, guest)).status, 404);
    assert.equal((await f.request(`${base}/pages`, agent, { title: 'ok', body: 'y' })).status, 201);
  } finally { await f.close(); }
});

test('team inbox: add, assign, reply as the team with approval by role, mark sent; isolated per workspace', async () => {
  const f = await contentFixture();
  try {
    const { agent, reader, lead, outsider, guest, other, base } = await team(f);
    assert.equal((await f.request(`${base}/inbox`, reader, { subject: 'x', sender: 'a@b.example', body: 'y' })).status, 404, 'viewers cannot add');
    const added = await f.request(`${base}/inbox`, agent, { subject: 'Refund for order 1182', sender: 'pat@customer.example', body: 'The parcel arrived broken.' });
    assert.equal(added.status, 201);
    const item = await added.json();
    assert.equal(item.status, 'open'); assert.equal(item.assigneeId, null);
    assert.equal((await json(await f.request(`${base}/inbox`, reader)))[0].subject, 'Refund for order 1182', 'viewers read the inbox');
    // Assign only to an active non-guest member of this workspace.
    assert.equal((await f.request(`${base}/inbox/${item.id}/assign`, agent, { assigneeId: outsider.principal.identityId })).status, 400);
    assert.equal((await f.request(`${base}/inbox/${item.id}/assign`, agent, { assigneeId: guest.principal.identityId })).status, 400);
    const assigned = await json(await f.request(`${base}/inbox/${item.id}/assign`, agent, { assigneeId: agent.principal.identityId }));
    assert.equal(assigned.assignee, 'Blake Agent');
    const people = (await json(await f.request(`${base}/team-people`, agent))).map((p: { name: string }) => p.name);
    assert.ok(people.includes('Morgan Lead') && !people.includes('Gale Guest') && !people.includes('Drew Outside'));
    // A contributor's reply waits for a manager; the manager's own reply is ready at once.
    const reply = await json(await f.request(`${base}/inbox/${item.id}/reply`, agent, { body: 'Sorry! A refund is on its way.' }));
    assert.equal(reply.status, 'pending'); assert.ok(reply.approvalId);
    const approvals = await json(await f.request(`${base}/approvals`, agent));
    assert.equal(approvals[0].kind, 'reply'); assert.equal(approvals[0].needs, 'manager');
    assert.equal((await f.request(`${base}/approvals/${reply.approvalId}/decide`, agent, { approve: true })).status, 403, 'no approving your own request');
    assert.equal((await f.request(`${base}/inbox/${item.id}/replies/${reply.id}/sent`, agent, {})).status, 409, 'not before approval');
    assert.equal((await f.request(`${base}/approvals/${reply.approvalId}/decide`, lead, { approve: true })).status, 200);
    const thread = await json(await f.request(`${base}/inbox/${item.id}`, reader));
    assert.equal(thread.replies[0].status, 'approved'); assert.equal(thread.replies[0].decidedBy, 'Morgan Lead');
    assert.equal((await f.request(`${base}/inbox/${item.id}/replies/${reply.id}/sent`, agent, {})).status, 200);
    const direct = await json(await f.request(`${base}/inbox/${item.id}/reply`, lead, { body: 'Following up.' }));
    assert.equal(direct.status, 'approved'); assert.equal(direct.approvalId, null);
    assert.equal((await f.request(`${base}/inbox/${item.id}/done`, agent, {})).status, 200);
    // Isolation: another workspace's manager sees nothing, and ids do not cross workspaces.
    assert.equal((await f.request(`${base}/inbox`, outsider)).status, 404);
    assert.equal((await f.request(`/api/business/workspaces/${other.id}/inbox/${item.id}`, outsider)).status, 404);
    assert.deepEqual(await json(await f.request(`/api/business/workspaces/${other.id}/inbox`, outsider)), []);
  } finally { await f.close(); }
});

test('approvals by role: spend up to the limit needs a manager, over it an administrator in the workspace', async () => {
  const f = await contentFixture();
  try {
    const { agent, lead, boss, base } = await team(f);
    assert.equal((await f.request('/api/business/team/settings', agent, { spendLimitCents: 100 })).status, 403);
    assert.equal((await f.request('/api/business/team/settings', boss, { spendLimitCents: -5 })).status, 400);
    assert.equal((await json(await f.request('/api/business/team/settings', boss, { spendLimitCents: 50_000 }))).spendLimitCents, 50_000);
    const small = await json(await f.request(`${base}/approvals`, agent, { kind: 'spend', title: 'Label printer', amountCents: 20_000 }));
    assert.equal(small.needs, 'manager');
    const big = await json(await f.request(`${base}/approvals`, agent, { kind: 'spend', title: 'New laptops', amountCents: 90_000 }));
    assert.equal(big.needs, 'admin');
    assert.equal((await f.request(`${base}/approvals`, agent, { kind: 'reply', title: 'x', amountCents: 1 })).status, 400, 'replies are requested through the inbox');
    assert.equal((await f.request(`${base}/approvals/${small.id}/decide`, lead, { approve: true })).status, 200);
    assert.equal((await f.request(`${base}/approvals/${big.id}/decide`, lead, { approve: true })).status, 403, 'a manager cannot approve over the limit');
    const decided = await json(await f.request(`${base}/approvals/${big.id}/decide`, boss, { approve: false }));
    assert.equal(decided.status, 'refused'); assert.equal(decided.decidedBy, 'Riley Admin');
    assert.equal((await f.request(`${base}/approvals/${big.id}/decide`, boss, { approve: true })).status, 409, 'decided once');
  } finally { await f.close(); }
});

test('audit export: who and what filters, team rows recorded, workspace activity on request, admins only', async () => {
  const f = await contentFixture();
  try {
    const { agent, boss, base } = await team(f);
    await f.request(`${base}/inbox`, agent, { subject: 'Hello', sender: 'x@y.example', body: 'z' });
    const roles = await json(await f.request(`/api/business/org/audit.json?action=team.role`, f.admin));
    assert.ok(roles.entries.length >= 2 && roles.entries.every((e: { action: string }) => e.action === 'team.role'));
    const byBoss = await json(await f.request(`/api/business/org/audit.json?actor=${boss.principal.identityId}`, f.admin));
    assert.ok(byBoss.entries.every((e: { actorId: string }) => e.actorId === boss.principal.identityId));
    const plain = await json(await f.request(`/api/business/org/audit.json`, f.admin));
    assert.ok(!plain.entries.some((e: { action: string }) => e.action === 'inbox.add'), 'workspace rows only on request');
    const all = await json(await f.request(`/api/business/org/audit.json?workspaces=1&action=inbox`, f.admin));
    assert.equal(all.entries.length, 1); assert.equal(all.entries[0].action, 'inbox.add'); assert.equal(all.entries[0].actorName, 'Blake Agent');
    assert.ok(!JSON.stringify(all).includes('Hello'), 'no content in the export');
    const csv = await (await f.request(`/api/business/org/audit.csv?workspaces=1&action=inbox`, boss)).text();
    assert.match(csv, /inbox\.add/);
    assert.equal((await f.request(`/api/business/org/audit.json?actor=nope`, f.admin)).status, 400);
    assert.equal((await f.request(`/api/business/org/audit.json?action=team.role`, agent)).status, 403);
  } finally { await f.close(); }
});

test('team workspace never touches household (family) features', () => {
  for (const file of ['src/business/team.ts', 'src/business/team-routes.ts', 'web/business-team.js']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(household|family|kids?|child(ren)?)\b/i, file);
  }
});
