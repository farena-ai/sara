import { t, initializeLanguage, attachTips } from './business-i18n.js';
import { passkey } from './business-auth.js';
import { BusinessDrafts } from './business-state.js';
import { renderManagement, roleName } from './business-admin.js';
import { createPages } from './business-pages.js';

const $ = id => document.getElementById(id);
let self, drafts, spaces = [], workspace = '', conversation = '', policy = {}, audience, epoch = 0, stream, expiry, screen = 'content';
const posts = new Map();
const authentication = new BroadcastChannel('sara-business-auth');
let acknowledgedAt = 0, acknowledgementTimer;
let managementEpoch = 0;
let managementAuthority = '';
let refreshManagement;
let previewNonce = 0, reviewedInvite;
let selectionNonce = 0, mountedEditor = '';
let refreshNonce = 0;
let ssoEnabled = false;
let backgroundRefresh = true;
// C16: a team page handed to the composer as context ("Ask Sara about this page").
let contextPages = [];
let pages;
const text = (id, value) => { $(id).textContent = value; };
const notice = value => text('notice', value);
function composerNotice(value) {
  notice(value); text('composer-notice', value);
  if (value) $('composer-notice').scrollIntoView({ block: 'nearest' });
}
const scope = () => `${self?.principal.identityId}/${self?.principal.sessionId}/${workspace}/${conversation}`;
const role = () => spaces.find(x => x.id === workspace)?.role;
const writable = () => !!workspace && role() !== 'viewer';
function clearProtected(clearDrafts = false, preserveRequests = false) {
  refreshManagement = undefined;
  previewNonce++; reviewedInvite = undefined; text('invite-preview', '');
  epoch++; selectionNonce++; mountedEditor = ''; stream?.close(); stream = undefined;
  if (!preserveRequests) { clearTimeout(expiry); for (const controller of posts.values()) controller.abort(); posts.clear(); }
  if (clearDrafts) drafts?.clear();
  workspace = ''; conversation = ''; spaces = []; policy = {}; audience = undefined; contextPages = []; pages?.clear(); renderPageContext();
  for (const id of ['messages', 'audience', 'conversations', 'document-list', 'document-body', 'management-body', 'workspace-name', 'organization', 'actor', 'conversation-name', 'file-preview', 'model-destination', 'request-state', 'composer-notice', 'next-step']) $(id).replaceChildren();
  for (const id of ['workspace', 'selected-documents']) $(id).replaceChildren();
  $('draft').value = ''; $('file').value = ''; $('conversation-title').value = ''; $('person-name').value = ''; $('code').value = ''; $('acknowledge').checked = false;
  text('document-selection-count', t('Selected documents: {count}/8', { count: 0 }));
  for (const id of ['desk', 'enroll', 'recovery']) $(id).hidden = true;
}
function unavailable(error) {
  // Only authoritative access checks use this path; model/input refusals do not revoke an account.
  const denied = [401, 403, 404].includes(error.status) || error.message === 'Business session changed.';
  clearProtected(denied, !denied); notice(denied ? t('Access or connection was lost. Protected content has been cleared. Check access again.') : errorText(error));
  if (denied && !self) { $('auth').hidden = false; return; }
  $('recovery').querySelector('h1').textContent = t('Check access again');
  $('recovery').querySelector('p').textContent = errorText(error);
  $('recovery').hidden = false;
}
async function api(path, data, signal) {
  let response; const expectedSession = self?.principal.sessionId;
  try { response = await fetch('/api/business' + path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...(self ? { 'x-sara-business-session': self.principal.sessionId } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal }); }
  catch (error) { if (error.name === 'AbortError') throw error; throw Object.assign(new Error('connection'), { status: 0 }); }
  const value = await response.json();
  if (!response.ok) {
    if (value.error === 'Business session changed.' && self?.principal.sessionId === expectedSession) { backgroundRefresh = false; clearProtected(true); self = undefined; $('auth').hidden = false; $('logout').hidden = true; $('sso-link').hidden = true; $('join-team').hidden = true; updateAuthMode(); }
    if (response.status === 401 && self && self.principal.sessionId === expectedSession) { backgroundRefresh = false; clearProtected(true); self = undefined; $('auth').hidden = false; $('logout').hidden = true; $('sso-link').hidden = true; $('join-team').hidden = true; updateAuthMode(); }
    throw Object.assign(new Error(value.error || value.state), { status: response.status, value });
  }
  // Successful delayed responses still belong to the session that requested them.
  if (expectedSession && self?.principal.sessionId !== expectedSession) throw new DOMException('Session changed', 'AbortError');
  return value;
}
function errorText(error) {
  if (error.message === 'Claim denied.') return t('Setup was refused. Check the private setup code and exact address with the host operator; the code may have expired or already been used.');
  if (error.message === 'Re-enrollment denied.') return t('Recovery was refused. Ask the host operator for a new private re-enrollment code and confirm that you are 18 or older.');
  if (error.message === 'Adult confirmation (18+) is required.') return t('Enter your name and confirm that you are 18 or older before creating an account.');
  if (error.message === 'Business session changed.') return t('Your active account changed. Reload this page before continuing.');
  if (error.status === 0) return t('Connection lost. Your draft and original request are retained. Check the original request before sending again.');
  if (error.status === 401) return t('Your sign-in expired. Sign in again with your passkey.');
  if (error.status === 503) return t('Archive recovery is holding access. The host operator must reconcile access and spending.');
  if (error.status === 404) return t('This item or invitation is unavailable, expired, or no longer accessible. Ask the appropriate administrator for access.');
  if (error.message.includes('fresh authentication')) return t('Fresh passkey enrollment is required before organization reapproval. Ask the host operator for re-enrollment.');
  if (error.message === 'A workspace needs an active manager.') return t('Keep another active manager in this workspace before removing or demoting its last manager.');
  if (error.message === 'An organization needs another active administrator.') return t('Keep another active organization administrator before removing or demoting the last administrator.');
  if (error.message === 'Another model request is in progress.') return t('Another request is still running. Wait for it to finish, then choose Send.');
  if (error.message.startsWith('Conversation context exceeds')) return t('This request exceeds the model context limit. Select fewer documents or start a new shared conversation, then choose Send.');
  if (/allowance|budget/i.test(error.message)) return t('The spending allowance is exhausted. Ask the host operator to review the configured budget.');
  if (/paused|held|uncertain/i.test(error.message)) return t('Spending is held because usage is uncertain. The host operator must reconcile it; retrying cannot clear the hold.');
  if (error.value?.state === 'disclosure-required') return t('Read the AI disclosure and selected provider destination, then confirm before sending.');
  if (/model|provider|configuration/i.test(error.message)) return t('The model is unavailable or its policy changed. Ask the host operator to check configuration and refresh this workspace.');
  if (error.name === 'SecurityError') return t('Passkeys require the configured HTTPS hostname, or localhost for a local installation. Open the address supplied by your host operator.');
  if (error.name === 'NotAllowedError' || error.name === 'InvalidStateError') return t('Passkey verification was cancelled or unavailable. Try again on a device with your passkey.');
  if (error.status === 429) return t('Too many requests. Wait a moment before trying again.');
  return t('The change was refused. Check the fields and your current access, then try again.');
}
async function run(task, button, composer = false) {
  const originalScope = scope();
  if (button) button.disabled = true;
  try { notice(''); if (composer) text('composer-notice', ''); await task(); } catch (error) { if (error.name !== 'AbortError') { if (composer && originalScope === scope() && screen === 'content') composerNotice(errorText(error)); else notice(errorText(error)); } }
  finally { if (button?.isConnected) button.disabled = false; updateComposer(); }
}
function saveDraft() { if (self && workspace && conversation && drafts?.active && mountedEditor === scope()) drafts.save(workspace, conversation, { text: $('draft').value, documentIds: [...$('selected-documents').querySelectorAll('input:checked')].map(x => x.value) }); }
function restoreDraft() {
  if (mountedEditor !== scope()) return;
  const draft = drafts?.read(workspace, conversation) || { text: '', documentIds: [] }; $('draft').value = draft.text;
  for (const option of $('selected-documents').querySelectorAll('input')) option.checked = draft.documentIds.includes(option.value);
  text('document-selection-count', t('Selected documents: {count}/8', { count: draft.documentIds.length }));
  updateComposer();
}
function updateComposer() {
  $('desk').classList.toggle('is-viewer', role() === 'viewer');
  if (acknowledgedAt && Date.now() - acknowledgedAt >= 3 * 60 * 60 * 1000) $('acknowledge').checked = false;
  const allowed = writable() && !!audience; const loaded = mountedEditor === scope(); const pending = drafts?.pending(workspace, conversation); const active = posts.has(scope());
  $('draft').disabled = !allowed || !loaded || !conversation || !!pending;
  for (const input of $('selected-documents').querySelectorAll('input')) input.disabled = !allowed || !loaded || !conversation || !!pending;
  $('acknowledge').disabled = !allowed;
  $('send').disabled = !allowed || !loaded || !conversation || !policy.configured || (!!pending && !drafts.ready(workspace, conversation)) || active || !$('acknowledge').checked;
  $('retry').hidden = !pending; $('retry').disabled = !allowed || !loaded || active;
  $('upload').disabled = !allowed; $('file').disabled = !allowed; $('new-conversation').disabled = !allowed; $('conversation-title').disabled = !allowed;
  $('view-only').hidden = role() !== 'viewer';
  if (pending) text('request-state', active ? t('Request in progress in its original workspace. You can switch without cancelling it.') : drafts.ready(workspace, conversation) ? t('The original request was not admitted. Choose Send to submit the same request explicitly.') : t('An original request is retained. Check its status; do not create a duplicate.'));
  else text('request-state', '');
}
async function boot(preserveView = false) {
  const version = epoch; const refresh = ++refreshNonce;
  const previousSelf = JSON.stringify(self); const authWasVisible = !$('auth').hidden; const deskWasVisible = !$('desk').hidden;
  const previousScreen = screen; const previousManagement = $('tab-org').hasAttribute('aria-current') ? 'org' : $('tab-audit').hasAttribute('aria-current') ? 'audit' : 'members';
  const oldIdentity = self?.principal.identityId; const oldSession = self?.principal.sessionId; const oldOrganizationRole = self?.organization?.role;
  let current;
  try { current = await api('/me'); } catch (error) {
    if (version !== epoch || refresh !== refreshNonce) return;
    if (error.status === 401 && !oldIdentity) {
      $('auth').hidden = false; $('logout').hidden = true; $('sso-link').hidden = true; $('join-team').hidden = true; notice('');
    } else unavailable(error);
    return;
  }
  if (version !== epoch || refresh !== refreshNonce) return;
  self = current;
  if (oldOrganizationRole === 'orgadmin' && self?.organization?.role !== 'orgadmin') {
    managementEpoch++; managementAuthority = ''; $('management-body').replaceChildren();
    if (previousScreen === 'management' && previousManagement === 'org') showPanel('content');
  }
  if (!self) { clearProtected(); $('auth').hidden = false; $('logout').hidden = true; $('sso-link').hidden = true; return; }
  if (oldIdentity && (oldIdentity !== self.principal.identityId || oldSession !== self.principal.sessionId)) clearProtected(true);
  const draftKey = `business-drafts:${self.principal.identityId}:${self.principal.sessionId}`;
  if (!drafts?.active || drafts.key !== draftKey) drafts = new BusinessDrafts(sessionStorage, self.principal.identityId, self.principal.sessionId);
  $('auth').hidden = !(preserveView && authWasVisible && oldIdentity === self.principal.identityId && oldSession === self.principal.sessionId); $('logout').hidden = false; $('join-team').hidden = false; updateAuthMode();
  $('sso-link').hidden = !ssoEnabled || self.signIn === 'sso';
  clearTimeout(expiry);
  const expire = () => {
    if (!self) return;
    if (self.principal.expiresAt > Date.now()) { expiry = setTimeout(expire, Math.min(self.principal.expiresAt - Date.now(), 2_147_483_647)); return; }
    backgroundRefresh = false; clearProtected(true); self = undefined; $('auth').hidden = false; $('logout').hidden = true; $('sso-link').hidden = true; $('join-team').hidden = true; updateAuthMode(); notice(t('Your sign-in expired. Sign in again with your passkey.'));
  };
  expire();
  if (!self.passkeyEnrolled && self.signIn !== 'sso') { clearProtected(!!oldIdentity && oldSession === self.principal.sessionId); $('enroll').hidden = false; return; }
  $('enroll').hidden = true;
  if (!self.organization || self.recovering) {
    clearProtected(true);
    $('recovery').querySelector('h1').textContent = t('Access is being reconciled');
    $('recovery').querySelector('p').textContent = t('Your new passkey is ready. The host operator must complete archive recovery, or an organization administrator must reapprove your account. Workspace managers separately approve workspace access.');
    $('recovery').hidden = false; return;
  }
  $('recovery').hidden = true; $('desk').hidden = false;
  text('organization', self.organization.name || t('Team workspace'));
  text('actor', t('Signed in as {name} · {role}', { name: self.identity.name, role: roleName(self.organization.role) }));
  $('tab-org').hidden = self.organization.role !== 'orgadmin';
  let authorizedSpaces;
  try { authorizedSpaces = await api('/workspaces'); } catch (error) { if (version === epoch && refresh === refreshNonce) unavailable(error); return; }
  if (version !== epoch || refresh !== refreshNonce) return;
  const link = new URLSearchParams(location.hash.slice(1));
  const sameView = preserveView && deskWasVisible && previousSelf === JSON.stringify(self) && JSON.stringify(spaces) === JSON.stringify(authorizedSpaces) && (!link.get('workspace') || link.get('workspace') === workspace) && (!link.get('conversation') || link.get('conversation') === conversation);
  if (sameView) {
    try {
      let sameAuthority = previousScreen !== 'management';
      if (previousScreen === 'management' && managementAuthority && refreshManagement) {
        const update = refreshManagement; const view = managementEpoch;
        const rows = await api(previousManagement === 'org' ? '/org/users' : `/workspaces/${workspace}/members`);
        if (version !== epoch || refresh !== refreshNonce || view !== managementEpoch) return;
        const own = rows.find(row => (row.identityId || row.id) === self.principal.identityId);
        sameAuthority = !!own && managementAuthority === JSON.stringify([own.role, own.status, own.revision]);
        if (sameAuthority) await update(rows, () => version === epoch && refresh === refreshNonce && view === managementEpoch);
      }
      if (sameAuthority && workspace) {
        const [people, destination] = await Promise.all([api(`/workspaces/${workspace}/audience`), api(`/workspaces/${workspace}/model-policy`)]);
        if (version !== epoch || refresh !== refreshNonce) return;
        // A changed destination requires a fresh disclosure acknowledgement and full view refresh.
        sameAuthority = JSON.stringify(destination) === JSON.stringify(policy);
        if (sameAuthority) { audience = people; renderAudience(people); }
      }
      if (version !== epoch || refresh !== refreshNonce) return;
      if (sameAuthority) { updateComposer(); return; }
    } catch (error) { if (version === epoch && refresh === refreshNonce) unavailable(error); return; }
  }
  spaces = authorizedSpaces;
  $('workspace').replaceChildren(...spaces.map(w => { const option = document.createElement('option'); option.value = w.id; option.textContent = w.name; return option; }));
  const desired = link.get('workspace') || workspace || spaces[0]?.id;
  if (desired && !spaces.some(w => w.id === desired)) { await switchWorkspace(''); notice(t('This workspace is unavailable to your account. Choose an authorized workspace.')); return; }
  const switching = switchWorkspace(desired || '', link.get('conversation') || ''); const selectedEpoch = epoch;
  await switching;
  if (epoch !== selectedEpoch || refresh !== refreshNonce || oldIdentity !== self?.principal.identityId || oldSession !== self?.principal.sessionId) return;
  if (previousScreen === 'documents') showPanel('documents');
  if (previousScreen === 'management' && ((previousManagement === 'org' && self.organization?.role === 'orgadmin') || (previousManagement !== 'org' && role() === 'manager'))) await manage(previousManagement);
}
function renderAudience(people) {
  text('audience', t('Shared workspace · {role} · {count} people', { role: roleName(role()), count: people.count }) + '\n' + people.members.map(p => `${p.name} · ${roleName(p.role)}`).join(' / '));
}
async function switchWorkspace(id, targetConversation = '') {
  saveDraft(); const version = ++epoch; selectionNonce++; mountedEditor = ''; stream?.close(); stream = undefined;
  workspace = id; conversation = ''; screen = 'content'; policy = {}; audience = undefined; contextPages = []; renderPageContext();
  for (const key of ['messages', 'conversations', 'audience', 'document-list', 'document-body', 'management-body', 'selected-documents', 'conversation-name', 'file-preview', 'model-destination', 'composer-notice']) $(key).replaceChildren();
  $('draft').value = ''; $('file').value = ''; $('conversation-title').value = ''; $('acknowledge').checked = false; $('workspace').value = id;
  text('document-selection-count', t('Selected documents: {count}/8', { count: 0 }));
  $('tab-members').hidden = role() !== 'manager'; $('tab-audit').hidden = role() !== 'manager';
  text('workspace-name', spaces.find(w => w.id === id)?.name || t('Choose your next workspace'));
  text('next-step', !id ? t('An organization account is the first step. A workspace manager must separately invite you to shared content.') : role() === 'manager' ? t('Next: invite active colleagues in Workspace members, then start a shared conversation. Ask the host operator to configure a model and rehearse backup recovery.') : role() === 'viewer' ? t('Read shared conversations and documents. Ask this workspace manager if you need permission to contribute.') : t('Choose or start a shared conversation. Review the audience and model destination before sending.'));
  showPanel('content'); updateComposer();
  if (!id) { if (self.organization.role === 'orgadmin') await manage('org'); else notice(t('No workspace access yet. Ask a manager for an invitation.')); return; }
  history.replaceState(null, '', `#workspace=${id}${targetConversation ? '&conversation=' + targetConversation : ''}`);
  try {
    const [people, destination, conversations, documents] = await Promise.all([api(`/workspaces/${id}/audience`), api(`/workspaces/${id}/model-policy`), api(`/workspaces/${id}/conversations`), api(`/workspaces/${id}/documents`)]);
    if (version !== epoch) return;
    audience = people; policy = destination;
    renderAudience(people);
    text('model-destination', destination.configured ? t('Selected destination: {provider} · {model} · {destination} · {egress}. Selected shared content is sent there.', { ...destination, egress: destination.egress === 'cloud' ? t('Cloud provider') : t('Local provider') }) : t('No allowed model is configured. Ask the host operator to configure a provider and budget.'));
    if (self.spendingPaused) notice(t('Spending is held because usage is uncertain. The host operator must reconcile it; retrying cannot clear the hold.'));
    for (const item of conversations) { const button = document.createElement('button'); button.textContent = item.title; button.type = 'button'; button.onclick = () => run(() => selectConversation(item.id)); $('conversations').append(button); }
    for (const doc of documents) {
      const label = document.createElement('label'); label.className = 'check'; const option = document.createElement('input'); option.type = 'checkbox'; option.value = doc.id; option.id = 'document-' + doc.id; option.dataset.tip = t('Include this shared document in the model request.'); label.append(option, document.createTextNode(doc.title)); $('selected-documents').append(label);
      const button = document.createElement('button'); button.type = 'button'; button.textContent = doc.title; button.onclick = () => run(async () => { const result = await api(`/workspaces/${id}/documents/${doc.id}`); if (version === epoch) text('document-body', result.body); }); $('document-list').append(button);
    }
    attachTips($('selected-documents'));
    if (targetConversation || conversations[0]) await selectConversation(targetConversation || conversations[0].id);
    if (version !== epoch) return;
    stream = new EventSource(`/api/business/workspaces/${id}/events`);
    stream.addEventListener('workspace', event => {
      if (version !== epoch) return; const data = JSON.parse(event.data);
      if (data.kind === 'content.changed') { void run(() => loadMessages()); if (screen === 'pages') pages.refresh(); }
      else {
        audience = undefined; updateComposer();
        void run(async () => {
          const people = await api(`/workspaces/${id}/audience`); if (version !== epoch) return;
          audience = people;
          renderAudience(people);
          updateComposer();
        });
      }
    });
    stream.onerror = () => {
      if (version !== epoch) return;
      // Hide immediately, but an unverified disconnect cannot erase an unknown request or abort admission.
      saveDraft(); clearProtected(false, true); const revalidation = epoch;
      void run(async () => {
        try { await api(`/workspaces/${id}`); if (revalidation === epoch) await boot(); }
        catch (error) { if (revalidation === epoch) unavailable(error); }
      });
    };
    $('desk').hidden = false; $('recovery').hidden = true;
  } catch (error) { if (version === epoch) { unavailable(error); throw error; } }
}
async function selectConversation(id) {
  saveDraft(); mountedEditor = ''; conversation = id; const key = scope(); const selection = ++selectionNonce;
  $('messages').replaceChildren(); $('draft').value = ''; text('conversation-name', ''); text('composer-notice', '');
  for (const input of $('selected-documents').querySelectorAll('input')) input.checked = false;
  text('document-selection-count', t('Selected documents: {count}/8', { count: 0 })); updateComposer();
  const value = await api(`/workspaces/${workspace}/conversations/${id}`); if (key !== scope() || selection !== selectionNonce) return;
  mountedEditor = key;
  text('conversation-name', value.title); history.replaceState(null, '', `#workspace=${workspace}&conversation=${id}`); restoreDraft(); await loadMessages(true);
}
async function loadMessages(toLatest = false) {
  if (!conversation || mountedEditor !== scope()) return; const key = scope(); const selection = selectionNonce; const rows = await api(`/workspaces/${workspace}/conversations/${conversation}/recent-messages`); if (key !== scope() || selection !== selectionNonce) return;
  const messages = $('messages'); const top = messages.getBoundingClientRect().top;
  const atEnd = messages.scrollHeight - messages.clientHeight - messages.scrollTop < 48;
  const anchor = [...messages.children].find(node => node.getBoundingClientRect().bottom > top);
  const anchorId = anchor?.dataset.messageId; const offset = anchor ? anchor.getBoundingClientRect().top - top : 0; const position = messages.scrollTop;
  messages.replaceChildren(...rows.map(row => { const article = document.createElement('article'); article.className = 'message'; article.dataset.messageId = row.id; const heading = document.createElement('strong'); heading.textContent = row.role === 'assistant' ? t('Sara · AI assistant') : row.actorId === self.principal.identityId ? self.identity.name : t('Colleague'); const body = document.createElement('p'); body.textContent = row.body; article.append(heading, body); if (row.role === 'assistant' && writable()) { const save = document.createElement('button'); save.type = 'button'; save.textContent = t('Save as a page'); save.onclick = () => run(async () => { await openPages(); pages.openDraft(row.body); }); article.append(save); } return article; }));
  if (toLatest || atEnd) messages.scrollTop = messages.scrollHeight;
  else { messages.scrollTop = position; const retained = [...messages.children].find(node => node.dataset.messageId === anchorId); if (retained) messages.scrollTop += retained.getBoundingClientRect().top - top - offset; }
}
function showPanel(name) {
  managementEpoch++;
  screen = name; for (const id of ['content', 'documents', 'pages', 'management']) $(id).hidden = id !== name;
  for (const id of ['content', 'documents', 'pages', 'members', 'org', 'audit']) $(`tab-${id}`).removeAttribute('aria-current');
  $(`tab-${name === 'management' ? 'members' : name}`).setAttribute('aria-current', 'page');
}
async function manage(kind) {
  saveDraft(); showPanel('management'); const version = epoch; const id = workspace;
  const view = managementEpoch;
  managementAuthority = ''; refreshManagement = undefined;
  text('management-title', kind === 'org' ? t('Organization administration') : kind === 'members' ? t('Workspace members') : t('Workspace audit'));
  $('management-body').replaceChildren(); $('tab-members').removeAttribute('aria-current'); $(`tab-${kind}`).setAttribute('aria-current', 'page');
  const update = await renderManagement({ kind, api, workspace: id, workspaceName: spaces.find(item => item.id === id)?.name, organizationName: self.organization.name, actorId: self.principal.identityId, host: $('management-body'), current: () => version === epoch && view === managementEpoch && screen === 'management', authorized: value => { managementAuthority = value; }, run, refresh: async () => { await boot(); if (self?.organization) await manage(kind); } });
  if (version === epoch && view === managementEpoch && screen === 'management') refreshManagement = update;
}
async function checkOriginal() {
  const id = workspace; const cid = conversation; const key = scope(); const currentDrafts = drafts;
  const payload = drafts?.pending(id, cid); if (!payload) return;
  const result = await api(`/workspaces/${id}/conversations/${cid}/requests/${payload.requestId}`);
  if (!currentDrafts.active || currentDrafts.pending(id, cid)?.requestId !== payload.requestId) return;
  if (result.state === 'not-admitted') currentDrafts.markReady(id, cid, true, payload.requestId);
  else if (['completed', 'blocked'].includes(result.state)) currentDrafts.finish(id, cid, payload.requestId);
  if (key !== scope()) return;
  restoreDraft(); await loadMessages();
  if (result.state === 'held' && screen === 'content') composerNotice(t('Spending is held because usage is uncertain. The host operator must reconcile it; retrying cannot clear the hold.'));
}
async function send() {
  if (!writable() || !conversation || mountedEditor !== scope() || posts.has(scope())) return;
  updateComposer();
  if (!$('acknowledge').checked || !$('draft').value.trim()) return;
  const message = $('draft').value;
  if (!message.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(message) || new TextEncoder().encode(message).length > 8192) { composerNotice(t('Shorten your message to 8 KB of text and remove unsupported control characters. Your draft is still editable.')); return; }
  saveDraft(); const id = workspace; const cid = conversation; const key = scope(); const currentDrafts = drafts; const controller = new AbortController();
  if (drafts.pending(id, cid) && !drafts.ready(id, cid)) return;
  const payload = drafts.begin(id, cid, { text: $('draft').value, documentIds: [...$('selected-documents').querySelectorAll('input:checked')].map(x => x.value), modelPolicy: policy.policyHash, acknowledgeDisclosure: true, ...(contextPages.length ? { pageIds: contextPages.map(page => page.id) } : {}) });
  const attempt = drafts.dispatch(id, cid, payload.requestId);
  drafts.markReady(id, cid, false, payload.requestId); posts.set(key, controller); updateComposer();
  try {
    const result = await api(`/workspaces/${id}/conversations/${cid}/messages`, payload, controller.signal);
    if (['completed', 'blocked'].includes(result.state)) { currentDrafts.finish(id, cid, payload.requestId); if (key === scope()) { contextPages = []; renderPageContext(); } }
    if (key === scope()) {
      restoreDraft(); await loadMessages();
      if (result.answer && result.state === 'blocked') notice(result.answer);
      if (result.state === 'held') notice(t('Spending is held because usage is uncertain. The host operator must reconcile it; retrying cannot clear the hold.'));
    }
  } catch (error) {
    if (error.value?.admission !== 'not-admitted') currentDrafts.uncertain(id, cid, payload.requestId);
    // A previous lost transport may still arrive; only a definitively refused first submission is editable.
    if (error.value?.admission === 'not-admitted') currentDrafts.unsubmitted(id, cid, payload.requestId, attempt);
    throw error;
  } finally { if (posts.get(key) === controller) posts.delete(key); if (key === scope()) updateComposer(); }
}
await initializeLanguage();
document.documentElement.dataset.theme = sessionStorage.getItem('business-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
$('theme').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; sessionStorage.setItem('business-theme', theme); };
$('signin').onclick = event => run(async () => { const version = epoch; await passkey(api, 'login'); if (version !== epoch) return; clearProtected(true); self = undefined; backgroundRefresh = true; authentication.postMessage('changed'); await boot(); }, event.currentTarget);
$('register').onclick = event => run(async () => { const session = self?.principal.sessionId; await passkey(api, 'register'); if (session !== self?.principal.sessionId) return; authentication.postMessage('changed'); await boot(); }, event.currentTarget);
$('logout').onclick = () => run(async () => { const session = self?.principal.sessionId; const signingOut = fetch('/api/business/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(session ? { 'x-sara-business-session': session } : {}) }, body: '{}' }).then(response => response.ok ? response.json() : {}); backgroundRefresh = false; clearProtected(true); self = undefined; refreshNonce++; $('auth').hidden = false; $('logout').hidden = true; $('sso-link').hidden = true; $('join-team').hidden = true; updateAuthMode(); history.replaceState(null, '', '/'); let result; try { result = await signingOut; } finally { authentication.postMessage('changed'); } if (result?.endSession && /^https?:\/\//.test(result.endSession)) location.assign(result.endSession); });
$('refresh').onclick = () => run(boot);
function updateAuthMode() {
  const mode = $('auth-mode').value; const needsName = mode !== 'reenroll' && !(mode === 'join' && self); const needsAdult = !(mode === 'join' && self);
  for (const [id, needed] of [['person-name', needsName], ['adult', needsAdult]]) { const control = $(id); control.closest('label').hidden = !needed; control.disabled = !needed; control.required = needed; }
  $('preview-invite').hidden = mode !== 'join';
  $('sso-join').hidden = !ssoEnabled || mode !== 'join' || !!self;
  text('auth-guidance', mode === 'claim' ? t('First setup: use the host operator’s short setup code, confirm your name and age, then create your individual passkey.') : mode === 'reenroll' ? t('Recover your existing account with the host operator’s private re-enrollment code, confirm your age, then create a fresh passkey. Your name stays unchanged.') : self ? t('Accept while signed in as the intended account. An organization invitation and a workspace invitation grant different access; review the scope before accepting.') : t('New colleague: first accept an organization invitation and create your passkey. A manager then invites your active account to a specific workspace.'));
}
function validCode(mode, code) {
  const valid = mode === 'claim' ? /^[A-Za-z0-9\s-]+$/.test(code) && code.replace(/[^A-Za-z0-9]/g, '').length === 8 : /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(code);
  if (valid) return true;
  notice(mode === 'claim' ? t('Paste the complete 8-character setup code supplied by the host operator. Spaces and dashes are allowed.') : t('Paste the complete private invitation or recovery code, including its dot. Ask the issuer for a new code if it is unavailable.'));
  $('code').focus(); return false;
}
async function previewInvitation() {
  const code = $('code').value.trim(); const actor = self?.principal.identityId || ''; const nonce = ++previewNonce;
  reviewedInvite = undefined; text('invite-preview', '');
  if ($('auth-mode').value !== 'join' || !validCode('join', code)) return false;
  const preview = await api('/invites/preview', { code });
  if (nonce !== previewNonce || code !== $('code').value.trim() || actor !== (self?.principal.identityId || '')) return false;
  reviewedInvite = { code, actor };
  text('invite-preview', t('Invited by {name} · {workspace} · {role}. Shared content is visible to listed workspace members and the host operator.', { name: preview.inviter, workspace: preview.workspace || t('Organization account'), role: roleName(preview.role) }));
  return true;
}
$('preview-invite').onclick = () => run(previewInvitation);
$('auth-form').onsubmit = event => { event.preventDefault(); void run(async () => {
  const mode = $('auth-mode').value; const code = $('code').value.trim(); const version = epoch;
  if (!['join', 'claim', 'reenroll'].includes(mode)) return;
  if (!validCode(mode, code)) return;
  if (!$('person-name').disabled && (!$('person-name').value.trim() || $('person-name').value.length > 80 || !$('person-name').value.isWellFormed() || /[\u0000-\u001f\u007f]/u.test($('person-name').value))) { notice(t('Enter a name of 1 to 80 characters without control characters so colleagues can identify you.')); $('person-name').focus(); return; }
  if (!(mode === 'join' && self) && !$('adult').checked) { notice(t('Confirm that you are 18 or older to continue.')); return; }
  if (mode === 'join' && (reviewedInvite?.code !== code || reviewedInvite?.actor !== (self?.principal.identityId || ''))) { if (await previewInvitation()) notice(t('Review the invitation above, then continue to accept.')); return; }
  const joined = await api(mode === 'join' ? '/invites/join' : '/' + mode, mode === 'join' && self ? { code } : { code, ...(mode !== 'reenroll' ? { name: $('person-name').value.trim() } : {}), confirm18: true });
  if (version !== epoch) return;
  backgroundRefresh = true;
  $('code').value = ''; text('invite-preview', ''); if (mode !== 'join' || !self) { clearProtected(true); self = undefined; authentication.postMessage('changed'); } if (joined.workspaceId) history.replaceState(null, '', '#workspace=' + joined.workspaceId); await boot();
}); };
$('code').oninput = () => { previewNonce++; reviewedInvite = undefined; text('invite-preview', ''); };
$('auth-mode').onchange = () => { previewNonce++; reviewedInvite = undefined; text('invite-preview', ''); updateAuthMode(); };
$('workspace').onchange = () => run(() => { history.pushState(null, '', '#workspace=' + $('workspace').value); return switchWorkspace($('workspace').value); });
$('join-team').onclick = () => { $('auth').hidden = false; $('auth').querySelector('details').open = true; $('auth-mode').value = 'join'; updateAuthMode(); $('code').focus(); };
for (const kind of ['content', 'documents']) $(`tab-${kind}`).onclick = () => showPanel(kind);
function renderPageContext() {
  $('page-context').hidden = $('page-context-clear').hidden = !contextPages.length;
  text('page-context', contextPages.length ? t('Sara will read this team page and its open comments: {title}', { title: contextPages.map(page => page.title).join(', ') }) : '');
}
async function openPages() {
  saveDraft(); showPanel('pages');
  pages ||= createPages({ api, run, host: $('pages'), ask: askAboutPage });
  await pages.show(workspace, role(), self.principal.identityId);
}
function askAboutPage(page, prompt) {
  showPanel('content');
  if (!conversation) { notice(t('Start or choose a shared conversation first, then ask Sara again.')); return; }
  contextPages = page ? [{ id: page.id, title: page.title }] : []; renderPageContext();
  if (!$('draft').disabled) { $('draft').value = prompt; saveDraft(); $('draft').focus(); }
}
$('tab-pages').onclick = () => run(openPages);
$('page-context-clear').onclick = () => { contextPages = []; renderPageContext(); };
for (const kind of ['members', 'org', 'audit']) $(`tab-${kind}`).onclick = () => run(() => manage(kind));
$('draft').oninput = saveDraft; $('selected-documents').onchange = event => { let count = $('selected-documents').querySelectorAll('input:checked').length; if (count > 8) { event.target.checked = false; count--; notice(t('Choose up to 8 documents.')); } text('document-selection-count', t('Selected documents: {count}/8', { count })); saveDraft(); }; $('acknowledge').onchange = () => { acknowledgedAt = $('acknowledge').checked ? Date.now() : 0; clearTimeout(acknowledgementTimer); if (acknowledgedAt) acknowledgementTimer = setTimeout(updateComposer, 3 * 60 * 60 * 1000); updateComposer(); };
$('composer').onsubmit = event => { event.preventDefault(); void run(() => send(), undefined, true); }; $('retry').onclick = () => run(checkOriginal, undefined, true);
$('conversation-form').onsubmit = event => { event.preventDefault(); void run(async () => { const id = workspace; const result = await api(`/workspaces/${id}/conversations`, { title: $('conversation-title').value }); if (id === workspace) { $('conversation-title').value = ''; await switchWorkspace(id, result.id); } }); };
$('file').onchange = () => { const file = $('file').files[0]; text('file-preview', file ? t('Ready to share: {name} · {bytes} bytes', { name: file.name, bytes: file.size }) : ''); };
$('upload-form').onsubmit = event => { event.preventDefault(); void run(async () => {
  const id = workspace; const version = epoch; const file = $('file').files[0]; if (!file || !writable()) return;
  if (file.size > 32768 || !/\.(txt|md|markdown)$/i.test(file.name)) { notice(t('Choose a UTF-8 text or Markdown file no larger than 32 KiB.')); return; }
  const bytes = new Uint8Array(await file.arrayBuffer()); new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (version !== epoch) return;
  await api(`/workspaces/${id}/uploads`, { name: file.name, mime: /\.txt$/i.test(file.name) ? 'text/plain' : 'text/markdown', contentBase64: btoa(String.fromCharCode(...bytes)) });
  if (version === epoch) { await switchWorkspace(id, conversation); showPanel('documents'); notice(t('Document shared with the listed workspace audience.')); }
}); };
addEventListener('hashchange', () => { if (backgroundRefresh) void run(boot); });
// Hints can revalidate an active session, but cannot reopen a session already closed here.
authentication.onmessage = () => { if (backgroundRefresh) void run(() => boot(true)); };
addEventListener('focus', () => { if (backgroundRefresh && self) void run(() => boot(true)); });
// EC2: company sign-in (OpenID Connect). The provider sends the browser back with ?sso=<reason> on refusal.
const SSO_REASONS = {
  denied: () => t('Your organization’s sign-in service refused or cancelled the sign-in. Try again, or ask your IT administrator whether you are assigned to Sara.'),
  state: () => t('That sign-in took too long or was started in another browser or tab. Start again from this page.'),
  failed: () => t('Sara could not verify the answer from your organization’s sign-in service, so nobody was signed in. Ask an administrator to use Test connection under Company sign-in.'),
  domain: () => t('The email domain of this account is not allowed here. Use your work account, or ask an organization administrator.'),
  group: () => t('This account is not in a group allowed to use Sara. Ask your IT administrator to add you.'),
  no_account: () => t('No Sara account is linked to this company account yet. Ask an administrator for an invitation, then choose Join with your company account.'),
  adult: () => t('Your first company sign-in creates an account. Confirm that you are 18 or older under Set up, join or recover access, then sign in again.'),
  disabled: () => t('This account is disabled here. Ask an organization administrator.'),
  invite: () => t('This invitation is unavailable, expired or already used. Ask for a new one.'),
  unavailable: () => t('Company sign-in is unavailable right now. Try again later, or sign in with your passkey.'),
  linked: () => t('That company account belongs to another Sara account, or yours is already linked to a different one.'),
};
async function companySignIn(body) { const { url } = await api('/sso/start', body); location.assign(url); }
$('sso-signin').onclick = event => run(() => companySignIn({ confirm18: $('adult').checked }), event.currentTarget);
$('sso-join').onclick = event => run(async () => {
  const code = $('code').value.trim(); if (!validCode('join', code)) return;
  if (!$('adult').checked) { notice(t('Confirm that you are 18 or older to continue.')); return; }
  await companySignIn({ code, confirm18: true });
}, event.currentTarget);
$('sso-link').onclick = event => run(() => companySignIn({ link: true }), event.currentTarget);
async function loadCompanySignIn() {
  try { const response = await fetch('/api/business/sso/status', { credentials: 'same-origin' }); ssoEnabled = response.ok && (await response.json()).enabled === true; } catch { ssoEnabled = false; }
  for (const id of ['sso-signin', 'sso-hint']) $(id).hidden = !ssoEnabled;
  updateAuthMode();
  const reason = new URLSearchParams(location.search).get('sso');
  if (reason) {
    history.replaceState(null, '', location.pathname + location.hash);
    notice((SSO_REASONS[reason] || SSO_REASONS.failed)());
    if (reason === 'adult' || reason === 'no_account') { $('auth').querySelector('details').open = true; $('auth-mode').value = 'join'; updateAuthMode(); }
  }
}
await loadCompanySignIn();
updateAuthMode();
await run(boot);
if (/^(?:[0-9.]+|\[.*\])$/.test(location.hostname)) {
  notice(t('Passkeys require a hostname. Ask the host operator to configure a matching HTTPS hostname and business origin, or localhost for local use, then restart this business instance before setup.'));
  // C1: company sign-in needs no passkey, so a LAN/loopback instance with a local IdP keeps it usable.
  const SSO_CONTROLS = ['sso-signin', 'sso-join', 'auth-mode', 'code', 'adult'];
  const passkeyOnly = control => !ssoEnabled || !SSO_CONTROLS.includes(control.id);
  for (const control of $('auth').querySelectorAll('input,select,button')) if (passkeyOnly(control)) control.disabled = true;
}
