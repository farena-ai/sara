import { t, initializeLanguage, attachTips } from './business-i18n.js';
import { passkey } from './business-auth.js';
import { BusinessDrafts } from './business-state.js';
import { renderManagement, roleName } from './business-admin.js';

const $ = id => document.getElementById(id);
let self, drafts, spaces = [], workspace = '', conversation = '', policy = {}, audience, epoch = 0, stream, expiry, screen = 'content';
const posts = new Map();
const authentication = new BroadcastChannel('sara-business-auth');
let acknowledgedAt = 0, acknowledgementTimer;
let managementEpoch = 0;
let previewNonce = 0, reviewedInvite;
let selectionNonce = 0, mountedEditor = '';
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
  previewNonce++; reviewedInvite = undefined; text('invite-preview', '');
  epoch++; selectionNonce++; mountedEditor = ''; stream?.close(); stream = undefined;
  if (!preserveRequests) { clearTimeout(expiry); for (const controller of posts.values()) controller.abort(); posts.clear(); }
  if (clearDrafts) drafts?.clear();
  workspace = ''; conversation = ''; spaces = []; policy = {}; audience = undefined;
  for (const id of ['messages', 'audience', 'conversations', 'document-list', 'document-body', 'management-body', 'workspace-name', 'organization', 'actor', 'conversation-name', 'file-preview', 'model-destination', 'request-state', 'composer-notice']) $(id).replaceChildren();
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
    if (value.error === 'Business session changed.' && self?.principal.sessionId === expectedSession) { clearProtected(true); self = undefined; $('auth').hidden = false; $('logout').hidden = true; $('join-team').hidden = true; }
    if (response.status === 401 && self && self.principal.sessionId === expectedSession) { clearProtected(true); self = undefined; $('auth').hidden = false; $('logout').hidden = true; }
    throw Object.assign(new Error(value.error || value.state), { status: response.status, value });
  }
  return value;
}
function errorText(error) {
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
async function boot() {
  const version = epoch;
  const oldIdentity = self?.principal.identityId; const oldSession = self?.principal.sessionId;
  let current;
  try { current = await api('/me'); } catch (error) {
    if (version !== epoch) return;
    if (error.status === 401 && !oldIdentity) {
      $('auth').hidden = false; $('logout').hidden = true; $('join-team').hidden = true; notice('');
    } else unavailable(error);
    return;
  }
  if (version !== epoch) return;
  self = current;
  if (!self) { clearProtected(); $('auth').hidden = false; $('logout').hidden = true; return; }
  if (oldIdentity && (oldIdentity !== self.principal.identityId || oldSession !== self.principal.sessionId)) clearProtected(true);
  const draftKey = `business-drafts:${self.principal.identityId}:${self.principal.sessionId}`;
  if (!drafts?.active || drafts.key !== draftKey) drafts = new BusinessDrafts(sessionStorage, self.principal.identityId, self.principal.sessionId);
  $('auth').hidden = true; $('logout').hidden = false; $('join-team').hidden = false;
  clearTimeout(expiry);
  const expire = () => {
    if (!self) return;
    if (self.principal.expiresAt > Date.now()) { expiry = setTimeout(expire, Math.min(self.principal.expiresAt - Date.now(), 2_147_483_647)); return; }
    clearProtected(true); self = undefined; $('auth').hidden = false; $('logout').hidden = true; notice(t('Your sign-in expired. Sign in again with your passkey.'));
  };
  expire();
  if (!self.passkeyEnrolled) { $('enroll').hidden = false; return; }
  $('enroll').hidden = true;
  if (!self.organization || self.recovering) {
    $('recovery').querySelector('h1').textContent = t('Access is being reconciled');
    $('recovery').querySelector('p').textContent = t('Your new passkey is ready. The host operator must complete archive recovery, or an organization administrator must reapprove your account. Workspace managers separately approve workspace access.');
    $('recovery').hidden = false; return;
  }
  $('recovery').hidden = true; $('desk').hidden = false;
  text('organization', self.organization.name || t('Team workspace'));
  text('actor', t('Signed in as {name} · {role}', { name: self.identity.name, role: roleName(self.organization.role) }));
  $('tab-org').hidden = self.organization.role !== 'orgadmin';
  let authorizedSpaces;
  try { authorizedSpaces = await api('/workspaces'); } catch (error) { if (version === epoch) unavailable(error); return; }
  if (version !== epoch) return; spaces = authorizedSpaces;
  $('workspace').replaceChildren(...spaces.map(w => { const option = document.createElement('option'); option.value = w.id; option.textContent = w.name; return option; }));
  const link = new URLSearchParams(location.hash.slice(1)); const desired = link.get('workspace') || workspace || spaces[0]?.id;
  if (desired && !spaces.some(w => w.id === desired)) { await switchWorkspace(''); notice(t('This workspace is unavailable to your account. Choose an authorized workspace.')); return; }
  await switchWorkspace(desired || '', link.get('conversation') || '');
}
async function switchWorkspace(id, targetConversation = '') {
  saveDraft(); const version = ++epoch; selectionNonce++; mountedEditor = ''; stream?.close(); stream = undefined;
  workspace = id; conversation = ''; screen = 'content'; policy = {}; audience = undefined;
  for (const key of ['messages', 'conversations', 'audience', 'document-list', 'document-body', 'management-body', 'selected-documents', 'conversation-name', 'file-preview', 'model-destination', 'composer-notice']) $(key).replaceChildren();
  $('draft').value = ''; $('file').value = ''; $('conversation-title').value = ''; $('acknowledge').checked = false; $('workspace').value = id;
  text('document-selection-count', t('Selected documents: {count}/8', { count: 0 }));
  $('tab-members').hidden = role() !== 'manager'; $('tab-audit').hidden = role() !== 'manager';
  text('workspace-name', spaces.find(w => w.id === id)?.name || t('Choose your next workspace'));
  showPanel('content'); updateComposer();
  if (!id) { if (self.organization.role === 'orgadmin') await manage('org'); else notice(t('No workspace access yet. Ask a manager for an invitation.')); return; }
  history.replaceState(null, '', `#workspace=${id}${targetConversation ? '&conversation=' + targetConversation : ''}`);
  try {
    const [people, destination, conversations, documents] = await Promise.all([api(`/workspaces/${id}/audience`), api(`/workspaces/${id}/model-policy`), api(`/workspaces/${id}/conversations`), api(`/workspaces/${id}/documents`)]);
    if (version !== epoch) return;
    audience = people; policy = destination;
    text('audience', t('Shared workspace · {role} · {count} people', { role: roleName(role()), count: people.count }) + '\n' + people.members.map(p => `${p.name} · ${roleName(p.role)}`).join(' / '));
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
      if (data.kind === 'content.changed') void run(() => loadMessages());
      else {
        audience = undefined; updateComposer();
        void run(async () => {
          const people = await api(`/workspaces/${id}/audience`); if (version !== epoch) return;
          audience = people;
          text('audience', t('Shared workspace · {role} · {count} people', { role: roleName(role()), count: people.count }) + '\n' + people.members.map(p => `${p.name} · ${roleName(p.role)}`).join(' / '));
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
  messages.replaceChildren(...rows.map(row => { const article = document.createElement('article'); article.className = 'message'; article.dataset.messageId = row.id; const heading = document.createElement('strong'); heading.textContent = row.role === 'assistant' ? t('Sara · AI assistant') : row.actorId === self.principal.identityId ? self.identity.name : t('Colleague'); const body = document.createElement('p'); body.textContent = row.body; article.append(heading, body); return article; }));
  if (toLatest || atEnd) messages.scrollTop = messages.scrollHeight;
  else { messages.scrollTop = position; const retained = [...messages.children].find(node => node.dataset.messageId === anchorId); if (retained) messages.scrollTop += retained.getBoundingClientRect().top - top - offset; }
}
function showPanel(name) {
  managementEpoch++;
  screen = name; for (const id of ['content', 'documents', 'management']) $(id).hidden = id !== name;
  for (const id of ['content', 'documents', 'members', 'org', 'audit']) $(`tab-${id}`).removeAttribute('aria-current');
  $(`tab-${name === 'management' ? 'members' : name}`).setAttribute('aria-current', 'page');
}
async function manage(kind) {
  saveDraft(); showPanel('management'); const version = epoch; const id = workspace;
  const view = managementEpoch;
  text('management-title', kind === 'org' ? t('Organization administration') : kind === 'members' ? t('Workspace members') : t('Workspace audit'));
  $('management-body').replaceChildren(); $('tab-members').removeAttribute('aria-current'); $(`tab-${kind}`).setAttribute('aria-current', 'page');
  await renderManagement({ kind, api, workspace: id, workspaceName: spaces.find(item => item.id === id)?.name, organizationName: self.organization.name, actorId: self.principal.identityId, host: $('management-body'), current: () => version === epoch && view === managementEpoch && screen === 'management', run, refresh: async () => { await boot(); if (self?.organization) await manage(kind); } });
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
  const payload = drafts.begin(id, cid, { text: $('draft').value, documentIds: [...$('selected-documents').querySelectorAll('input:checked')].map(x => x.value), modelPolicy: policy.policyHash, acknowledgeDisclosure: true });
  const attempt = drafts.dispatch(id, cid, payload.requestId);
  drafts.markReady(id, cid, false, payload.requestId); posts.set(key, controller); updateComposer();
  try {
    const result = await api(`/workspaces/${id}/conversations/${cid}/messages`, payload, controller.signal);
    if (['completed', 'blocked'].includes(result.state)) currentDrafts.finish(id, cid, payload.requestId);
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
$('signin').onclick = event => run(async () => { await passkey(api, 'login'); clearProtected(true); self = undefined; authentication.postMessage('changed'); await boot(); }, event.currentTarget);
$('register').onclick = event => run(async () => { await passkey(api, 'register'); await boot(); }, event.currentTarget);
$('logout').onclick = () => run(async () => { clearProtected(true); await api('/logout', {}); self = undefined; authentication.postMessage('changed'); $('auth').hidden = false; $('logout').hidden = true; $('join-team').hidden = true; history.replaceState(null, '', '/'); });
$('refresh').onclick = () => run(boot);
async function previewInvitation() {
  const code = $('code').value.trim(); const actor = self?.principal.identityId || ''; const nonce = ++previewNonce;
  reviewedInvite = undefined; text('invite-preview', '');
  const preview = await api('/invites/preview', { code });
  if (nonce !== previewNonce || code !== $('code').value.trim() || actor !== (self?.principal.identityId || '')) return false;
  reviewedInvite = { code, actor };
  text('invite-preview', t('Invited by {name} · {workspace} · {role}. Shared content is visible to listed workspace members and the host operator.', { name: preview.inviter, workspace: preview.workspace || t('Organization account'), role: roleName(preview.role) }));
  return true;
}
$('preview-invite').onclick = () => run(previewInvitation);
$('auth-form').onsubmit = event => { event.preventDefault(); void run(async () => {
  const mode = $('auth-mode').value; const code = $('code').value.trim();
  if (!(mode === 'join' && self) && !$('adult').checked) { notice(t('Confirm that you are 18 or older to continue.')); return; }
  if (mode === 'join' && (reviewedInvite?.code !== code || reviewedInvite?.actor !== (self?.principal.identityId || ''))) { if (await previewInvitation()) notice(t('Review the invitation above, then continue to accept.')); return; }
  const joined = await api(mode === 'join' ? '/invites/join' : '/' + mode, mode === 'join' && self ? { code } : { code, ...(mode !== 'reenroll' ? { name: $('person-name').value.trim() } : {}), confirm18: true });
  $('code').value = ''; text('invite-preview', ''); if (mode !== 'join' || !self) { clearProtected(true); self = undefined; authentication.postMessage('changed'); } if (joined.workspaceId) history.replaceState(null, '', '#workspace=' + joined.workspaceId); await boot();
}); };
$('code').oninput = () => { previewNonce++; reviewedInvite = undefined; text('invite-preview', ''); };
$('auth-mode').onchange = () => { previewNonce++; reviewedInvite = undefined; text('invite-preview', ''); };
$('workspace').onchange = () => run(() => { history.pushState(null, '', '#workspace=' + $('workspace').value); return switchWorkspace($('workspace').value); });
$('join-team').onclick = () => { $('auth').hidden = false; $('auth').querySelector('details').open = true; $('auth-mode').value = 'join'; $('code').focus(); };
for (const kind of ['content', 'documents']) $(`tab-${kind}`).onclick = () => showPanel(kind);
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
addEventListener('hashchange', () => run(boot));
authentication.onmessage = () => { clearProtected(true); self = undefined; void run(boot); };
addEventListener('focus', () => { if (self) void run(async () => { await api('/me'); }); });
await run(boot);
if (/^(?:[0-9.]+|\[.*\])$/.test(location.hostname)) {
  notice(t('Passkeys require a hostname. Ask the host operator to configure a matching HTTPS hostname and business origin, or localhost for local use, then restart this business instance before setup.'));
  for (const control of $('auth').querySelectorAll('input,select,button')) control.disabled = true;
}
