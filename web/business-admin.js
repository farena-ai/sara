import { t, attachTips } from './business-i18n.js';
const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
const roles = { manager: () => t('Manager'), contributor: () => t('Contributor'), viewer: () => t('View only'), orgadmin: () => t('Organization administrator'), user: () => t('User') };
export const roleName = role => roles[role]?.() || t('No access');
export async function renderManagement({ kind, api, workspace, workspaceName, organizationName, actorId, host, current, run, refresh }) {
  const base = `/workspaces/${workspace}`;
  const source = kind === 'org' ? '/org/users' : kind === 'members' ? `${base}/members` : `${base}/audit`;
  const rows = await api(source); if (!current()) return;
  host.replaceChildren();
  const control = (label, tip, id, options) => {
    const wrapper = element('label', label); const input = element(options ? 'select' : 'input'); input.id = id; input.dataset.tip = tip;
    if (options) for (const [value, label] of options) { const option = element('option', label); option.value = value; input.append(option); }
    wrapper.append(input); return { wrapper, input };
  };
  const actions = new WeakMap();
  const action = (text, callback) => { const b = element('button', text); b.type = 'button'; b.onclick = () => run(callback, b); actions.set(b, callback); return b; };
  const submit = (form, button) => {
    button.type = 'submit'; button.onclick = null;
    form.onsubmit = event => { event.preventDefault(); if (!button.disabled) void run(actions.get(button), button); };
    return button;
  };
  if (kind === 'audit') {
    const members = await api(`/workspaces/${workspace}/members`); if (!current()) return;
    const names = new Map(members.map(member => [member.identityId, member.name]));
    const labels = {
      'organization.settings': t('Organization settings changed'), 'organization.bootstrap': t('Organization administration established'),
      'organization.member': t('Organization access changed'), 'workspace.create': t('Shared workspace created'), 'workspace.member': t('Workspace access changed'),
      'invite.create': t('Invitation created'), 'invite.revoke': t('Invitation revoked'), 'invite.redeem': t('Invitation accepted'),
      'identity.create': t('Individual account created'), 'identity.epoch': t('Sign-in credentials invalidated'), 'identity.credential': t('Passkey enrolled'),
      'identity.reenroll': t('Re-enrollment prepared'), 'identity.signin': t('Account signed in'), 'identity.signin.attempt': t('Sign-in recorded'),
      'identity.logout.attempt': t('Sign-out recorded'), 'content.send': t('Shared message recorded'), 'content.document': t('Shared document created'),
      'model.resume': t('Spending resumed by operator'), 'model.reserve': t('Model spending reserved'), 'model.state': t('Model request state changed'),
      'operator.configure.attempt': t('Operator configuration recorded'), 'recovery.restore': t('Archive restored with access closed'),
      'recovery.reconcile': t('Recovery grants reconciled'), 'recovery.complete': t('Recovery access reopened'), 'backup.stage': t('Backup generation prepared'),
    };
    host.append(element('p', t('Latest 100 metadata events. Message and document contents are not included.')));
    for (const row of rows) {
      const block = element('div'); block.className = 'audit-entry';
      block.append(element('p', `${new Date(row.at).toLocaleString()} · ${labels[row.action] || t('Administrative event')}`));
      block.append(element('p', t('Recorded actor: {name}', { name: row.actorId ? names.get(row.actorId) || t('Unlisted account') : t('System or operator') })));
      if (row.subjectId) block.append(element('p', t('Affected account: {name}', { name: names.get(row.subjectId) || t('Unlisted account') })));
      const details = element('details'); details.append(element('summary', t('Technical record')));
      details.append(element('code', JSON.stringify({ action: row.action, actorId: row.actorId, subjectId: row.subjectId, revision: row.revision })));
      block.append(details); host.append(block);
    }
    if (!rows.length) host.append(element('p', t('No events yet.')));
    return;
  }
  if (kind === 'org') {
    host.append(element('p', t('Organization administration does not grant access to existing workspace content.')));
    const form = element('form'); const name = control(t('Organization name'), t('A label for this business instance, visible only after sign-in.'), 'org-name'); name.input.maxLength = 120; name.input.required = true;
    form.append(name.wrapper, submit(form, action(t('Save organization name'), async () => { await api('/org', { name: name.input.value }); if (current()) await refresh(); }))); host.append(form);
    const create = element('form'); const title = control(t('New workspace name'), t('Creates an organization-owned shared workspace. You become its first manager.'), 'new-workspace'); title.input.maxLength = 120;
    title.input.required = true;
    create.append(title.wrapper, submit(create, action(t('Create shared workspace'), async () => { await api('/workspaces', { name: title.input.value }); if (current()) await refresh(); }))); host.append(create);
    host.append(element('p', t('Reapproving a disabled account requires a new passkey first. Its old workspace grants stay closed until a manager approves them separately.')));
  } else host.append(element('p', t('Managers control only this workspace. Invite an existing active colleague or adjust a listed member.')));
  for (const row of rows) {
    const identity = row.identityId || row.id; const line = element('div'); line.className = 'row';
    line.append(element('p', row.name));
    const choices = kind === 'org' ? ['user', 'orgadmin'] : ['viewer', 'contributor', 'manager'];
    const role = control(t('Role'), t('The role determines what this person can do in this scope.'), `role-${identity}`, choices.map(x => [x, roleName(x)])); role.input.value = row.role;
    const status = control(t('Access'), t('Removing access preserves records. Reapproval must be explicit.'), `status-${identity}`, [['active', t('Active')], ...(kind === 'org' ? [['disabled', t('Disabled')]] : []), ['removed', t('Removed')]]); status.input.value = row.status;
    const apply = action(t('Apply access change'), async () => {
      if (identity !== actorId && status.input.value !== 'active' && status.input.value !== row.status && !confirm(t('Remove access for {name} in {scope}? Records are kept. This person will lose access immediately.', { name: row.name, scope: kind === 'org' ? organizationName || t('Organization administration') : workspaceName }))) return;
      await api(`/${kind === 'org' ? 'org/users' : 'workspaces/' + workspace + '/members'}/${identity}`, { role: role.input.value, status: status.input.value }); if (current()) await refresh();
    });
    if (kind === 'org' && identity === actorId) {
      role.input.disabled = true; status.input.disabled = true; apply.disabled = true;
      line.append(element('p', t('Ask another organization administrator to change your own access. Self-offboarding is unavailable here to avoid locking out administration.')));
    }
    line.append(role.wrapper, status.wrapper, apply); host.append(line);
  }
  const invite = element('form'); invite.append(element('h2', t('Invite a colleague')));
  const invitationRole = control(t('Invitation role'), t('The recipient sees the inviter and role before accepting this one-use invitation.'), 'invite-role', (kind === 'org' ? ['user', 'orgadmin'] : ['viewer', 'contributor', 'manager']).map(x => [x, roleName(x)])); invite.append(invitationRole.wrapper);
  let selected;
  if (kind === 'members') {
    const candidates = await api(`/workspaces/${workspace}/invite-candidates`); if (!current()) return;
    selected = control(t('Existing colleague'), t('Only active organization accounts can join. Ask an organization administrator to invite new people first.'), 'invite-person', candidates.map(x => [x.id, x.name])); invite.append(selected.wrapper);
  }
  const result = element('div'); result.dataset.raw = '';
  const issue = action(t('Create private invitation'), async () => {
    const value = await api(kind === 'org' ? '/org/invites' : `${base}/invites`, { role: invitationRole.input.value, subject: kind === 'org' ? 'new' : selected.input.value }); if (!current()) return;
    result.replaceChildren(element('p', t('Send this one-use code privately to the intended colleague. It is not a team sign-in token.')), element('code', value.code), action(t('Revoke this invitation'), async () => { await api(`/invites/${value.id}/revoke`, {}); if (current()) result.replaceChildren(element('p', t('Invitation revoked.'))); }));
  });
  if (selected && !selected.input.options.length) { issue.disabled = true; invite.append(element('p', t('No eligible colleagues. Existing or removed members are managed above.'))); }
  invite.append(submit(invite, issue), result); host.append(invite); attachTips(host);
}
