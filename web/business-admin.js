import { t, attachTips } from './business-i18n.js';
const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
const roles = { manager: () => t('Manager'), contributor: () => t('Contributor'), viewer: () => t('View only'), orgadmin: () => t('Organization administrator'), user: () => t('User') };
export const roleName = role => roles[role]?.() || t('No access');
export async function renderManagement({ kind, api, workspace, workspaceName, organizationName, actorId, host, current, run, refresh, authorized }) {
  const base = `/workspaces/${workspace}`;
  const source = kind === 'org' ? '/org/users' : kind === 'members' ? `${base}/members` : `${base}/audit`;
  const rows = await api(source); if (!current()) return;
  const ownAccess = rows.find(row => (row.identityId || row.id) === actorId);
  authorized?.(ownAccess ? JSON.stringify([ownAccess.role, ownAccess.status, ownAccess.revision]) : '');
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
    const guidance = element('section'); guidance.className = 'step-guidance'; guidance.append(element('h3', t('Next steps for organization administrators')));
    const steps = element('ol');
    for (const step of [t('Name your organization and create its first shared workspace. Creating it makes you its first manager.'), t('Send a private organization invitation to each new colleague. This creates an account, not access to existing workspace content.'), t('After a colleague enrolls a passkey, a workspace manager sends a separate workspace invitation. The colleague reviews and accepts it while signed in.'), t('Ask the host operator to configure allowed models and spending, verify inference separately, and rehearse private backup recovery. These controls stay outside browser administration.')]) steps.append(element('li', step));
    guidance.append(steps); host.append(guidance);
    host.append(element('p', t('Organization administration does not grant access to existing workspace content.')));
    const form = element('form'); const name = control(t('Organization name'), t('A label for this business instance, visible only after sign-in.'), 'org-name'); name.input.maxLength = 120; name.input.required = true;
    const validName = input => { if (input.value.trim() && input.value.length <= 120 && input.value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(input.value)) { input.setCustomValidity(''); return true; } input.setCustomValidity(t('Enter a name of 1 to 120 characters without control characters.')); input.reportValidity(); return false; };
    name.input.oninput = () => name.input.setCustomValidity('');
    form.append(name.wrapper, submit(form, action(t('Save organization name'), async () => { if (!validName(name.input)) return; await api('/org', { name: name.input.value.trim() }); if (current()) await refresh(); }))); host.append(form);
    const create = element('form'); const title = control(t('New workspace name'), t('Creates an organization-owned shared workspace. You become its first manager.'), 'new-workspace'); title.input.maxLength = 120;
    title.input.required = true;
    title.input.oninput = () => title.input.setCustomValidity('');
    create.append(title.wrapper, submit(create, action(t('Create shared workspace'), async () => { if (!validName(title.input)) return; await api('/workspaces', { name: title.input.value.trim() }); if (current()) await refresh(); }))); host.append(create);
    host.append(element('p', t('Reapproving a disabled account requires a new passkey first. Its old workspace grants stay closed until a manager approves them separately.')));
  } else {
    const guidance = element('section'); guidance.className = 'step-guidance'; guidance.append(element('h3', t('Next steps for workspace managers')), element('p', t('First ask an organization administrator to invite new accounts. Then choose an active colleague below and send a private invitation for this workspace and role. The colleague accepts while signed in.')), element('p', t('Review the listed audience before sharing. Model configuration and backup recovery belong to the host operator; workspace management does not grant operator access.'))); host.append(guidance);
    host.append(element('p', t('Managers control only this workspace. Invite an existing active colleague or adjust a listed member.')));
  }
  const roster = element('div'); host.append(roster); const memberRows = new Map();
  const memberRow = initial => {
    let row = initial;
    const identity = row.identityId || row.id; const line = element('div'); line.className = 'row';
    const person = element('p'); line.append(person);
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
    line.append(role.wrapper, status.wrapper, apply);
    const update = value => {
      // Keep unsaved choices, while displaying the latest server state alongside them.
      const roleEdited = role.input.value !== row.role; const statusEdited = status.input.value !== row.status;
      row = value;
      if (!roleEdited) role.input.value = row.role;
      if (!statusEdited) status.input.value = row.status;
      const statusLabel = row.status === 'active' ? t('Active') : row.status === 'disabled' ? t('Disabled') : t('Removed');
      person.textContent = row.name + '\n' + t('Current access: {role} · {status}', { role: roleName(row.role), status: statusLabel });
    };
    update(row); return { line, update };
  };
  const updateRows = values => {
    const present = new Set(values.map(row => row.identityId || row.id));
    for (const [id, value] of memberRows) if (!present.has(id)) { value.line.remove(); memberRows.delete(id); }
    values.forEach((row, index) => {
      const id = row.identityId || row.id; let value = memberRows.get(id);
      if (!value) { value = memberRow(row); memberRows.set(id, value); } else value.update(row);
      if (roster.children[index] !== value.line) roster.insertBefore(value.line, roster.children[index] || null);
    });
    attachTips(roster);
  };
  updateRows(rows);
  const invite = element('form'); invite.append(element('h2', t('Invite a colleague')));
  const invitationRole = control(t('Invitation role'), t('The recipient sees the inviter and role before accepting this one-use invitation.'), 'invite-role', (kind === 'org' ? ['user', 'orgadmin'] : ['viewer', 'contributor', 'manager']).map(x => [x, roleName(x)])); invite.append(invitationRole.wrapper);
  let selected;
  if (kind === 'members') {
    const candidates = await api(`/workspaces/${workspace}/invite-candidates`); if (!current()) return;
    selected = control(t('Existing colleague'), t('Only active organization accounts can join. Ask an organization administrator to invite new people first.'), 'invite-person', candidates.map(x => [x.id, x.name])); selected.input.required = true; invite.append(selected.wrapper);
  }
  const result = element('div'); result.dataset.raw = '';
  const invitationPath = kind === 'org' ? '/org/invites' : `${base}/invites`;
  const issue = action(t('Create private invitation'), async () => {
    const value = await api(invitationPath, { role: invitationRole.input.value, subject: kind === 'org' ? 'new' : selected.input.value }); if (!current()) return;
    result.replaceChildren(element('p', t('Send this one-use code privately to the intended colleague. It is not a team sign-in token.')), element('code', value.code), action(t('Revoke this invitation'), async () => { await api(`/invites/${value.id}/revoke`, {}); if (!current()) return; result.replaceChildren(element('p', t('Invitation revoked.'))); await refreshInvitations(); }));
    await refreshInvitations();
  });
  const emptyCandidates = element('p', t('No eligible colleagues. Existing or removed members are managed above.'));
  emptyCandidates.hidden = !selected || !!selected.input.options.length;
  if (selected) {
    issue.disabled = !selected.input.value;
    selected.input.onchange = () => { issue.disabled = !selected.input.value; };
    invite.append(emptyCandidates);
  }
  invite.append(submit(invite, issue), result); host.append(invite); attachTips(host);
  const inventory = element('section'); const inventoryTitle = element('h2', t('Recent invitations')); inventoryTitle.id = 'invitation-list-title'; inventory.setAttribute('aria-labelledby', inventoryTitle.id);
  const feedback = element('p'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const listing = element('div'); const invitationRows = new Map(); let inventoryVersion = 0;
  const emptyInvitations = element('p', t('No invitations in this scope.'));
  const stateLabels = { pending: () => t('Pending'), accepted: () => t('Accepted'), revoked: () => t('Revoked'), expired: () => t('Expired'), invalidated: () => t('Invalidated') };
  inventory.append(inventoryTitle, element('p', t('Latest 100 invitations in this scope, newest first. Private codes are shown only when created and cannot be recovered here.')), element('p', t('Accepted means the code was used. Current access is managed separately above; revoking a used code does not remove membership.')), action(t('Refresh invitations'), () => refreshInvitations()), feedback, listing, emptyInvitations); host.append(inventory);
  const updateInvitations = values => {
    const present = new Set(values.map(row => row.id));
    for (const [id, item] of invitationRows) if (!present.has(id)) {
      const focused = item.line.contains(document.activeElement); item.line.remove(); invitationRows.delete(id);
      if (focused) { inventoryTitle.tabIndex = -1; inventoryTitle.focus(); }
    }
    values.forEach((row, index) => {
      let item = invitationRows.get(row.id);
      if (!item) {
        const line = element('div'); line.className = 'audit-entry'; line.dataset.invitation = row.id;
        const subject = element('p'), inviter = element('p'), status = element('p'), expiry = element('p'); status.tabIndex = -1;
        line.append(subject, inviter, status, expiry); item = { line, subject, inviter, status, expiry }; invitationRows.set(row.id, item);
      }
      item.subject.textContent = t('Invited account: {name} · {role}', { name: row.subject === 'new' ? t('New account') : row.subjectLabel || t('Unlisted account'), role: roleName(row.role) });
      item.inviter.textContent = t('Issued by: {name}', { name: row.inviterLabel || t('Unlisted account') });
      item.status.textContent = t('Invitation status: {status}', { status: stateLabels[row.state]?.() || t('Invalidated') });
      item.expiry.textContent = t('Expires: {time}', { time: new Date(row.expiresAt).toLocaleString() });
      if (row.state === 'pending' && !item.revoke) {
        item.revoke = action(t('Revoke this invitation'), async () => {
          await api(`/invites/${row.id}/revoke`, {}); if (!current()) return;
          await refreshInvitations(); if (!current()) return;
          feedback.textContent = t('Invitation revoked.');
          // Disabling the clicked button can blur it before the refreshed row removes it.
          if (!item.revoke && item.status.isConnected && document.activeElement === document.body) item.status.focus();
        }); item.line.append(item.revoke);
      } else if (row.state !== 'pending' && item.revoke) {
        const focused = document.activeElement === item.revoke; item.revoke.remove(); item.revoke = undefined;
        if (focused) item.status.focus();
      }
      if (listing.children[index] !== item.line) listing.insertBefore(item.line, listing.children[index] || null);
    });
    emptyInvitations.hidden = !!values.length;
  };
  async function refreshInvitations() {
    const version = ++inventoryVersion; const values = await api(invitationPath);
    if (current() && version === inventoryVersion) updateInvitations(values);
  }
  await refreshInvitations(); if (!current()) return;
  return async (values, active) => {
    const version = ++inventoryVersion;
    const [candidates, invitations] = await Promise.all([selected ? api(`/workspaces/${workspace}/invite-candidates`) : undefined, api(invitationPath)]);
    if (!current() || !active() || version !== inventoryVersion) return;
    updateRows(values);
    updateInvitations(invitations);
    if (selected) {
      const previous = selected.input.value;
      const options = candidates.map(row => [row.id, row.name]);
      const existing = [...selected.input.options].map(option => [option.value, option.textContent]);
      if (JSON.stringify(options) !== JSON.stringify(existing)) {
        selected.input.replaceChildren(...options.map(([value, label]) => { const option = element('option', label); option.value = value; return option; }));
        selected.input.value = candidates.some(row => row.id === previous) ? previous : '';
      }
      if (!selected.input.value) issue.disabled = true;
      else if (!previous) issue.disabled = false;
      emptyCandidates.hidden = !!candidates.length;
    }
  };
}
